import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { BlobScope, HeadObjectResult, StoragePort } from '../contracts/storage.ts';
import type { Database } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import { idempotencyReceipts } from '../db/schema/jobs.ts';
import { projects } from '../db/schema/projects.ts';
import { archiveKey, assertTenantScopedKey } from '../infra/storage.ts';
import { PROJECT_ARCHIVE_LIMITS } from '../../shared/project-archive.ts';
import { firstFoldedDuplicate, unsafePortableSegment } from '../../shared/project-name.ts';
import {
  assertWritableProjectPath,
  isTextProjectPath,
  projectPath,
  validateProjectTitle,
  validateStableRequestId,
} from '../../shared/project-validation.ts';
import { readProjectZip } from '../../shared/project-zip.ts';
import { buildContentDisposition, getMimeType, sha256Hex } from '../studio/etag.ts';
import { lintProjectInMemory } from '../studio/engine/lint-project.ts';
import { InMemoryVirtualProject, type VirtualFileRecord } from '../studio/virtual-project-store.ts';
import {
  assertAgentProjectAccess,
  assertValidUuid,
  canonicalInputHash,
  isBinaryBuffer,
  loadProjectOrThrow,
  type ProjectFilesService,
} from './project-files-service.ts';
import type { InitialProjectFile, WorkspaceService } from './workspace-service.ts';

const ARCHIVE_MANIFEST_NAME = 'openmotion-projects.json';
const ARCHIVE_SCHEMA_VERSION = 1;

export interface ProjectArchiveServiceDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly workspace: WorkspaceService;
  readonly files: ProjectFilesService;
}

export interface ArchiveExportInput {
  readonly requestId: string;
  readonly projectIds?: readonly string[];
  readonly all?: boolean;
  readonly expectedRevisions?: Readonly<Record<string, string>>;
}

export interface ArchiveExportedProjectEntry {
  readonly projectId: string;
  readonly title: string;
  readonly folder: string;
  readonly revision: string;
  readonly fileCount: number;
  readonly bytes: number;
}

export interface ArchiveExportResult {
  readonly archiveId: string;
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly downloadUrl: string;
  readonly projects: ArchiveExportedProjectEntry[];
  readonly skippedProjectIds: string[];
  readonly replayed: boolean;
}

export interface ArchiveImportInput {
  readonly requestId: string;
  readonly zipBytes: Buffer;
  readonly filename?: string;
}

export interface ArchiveImportedProjectEntry {
  readonly projectId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly revision: string;
  readonly versionId: string;
  readonly fileCount: number;
}

export interface ArchiveImportResult {
  readonly imported: ArchiveImportedProjectEntry[];
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly replayed: boolean;
}

interface ArchiveManifest {
  version: number;
  exportedAt: string;
  projects: Array<{
    folder: string;
    title: string;
    sourceProjectId?: string;
    templateId?: string | null;
    namingLanguage?: string | null;
    revision?: string;
  }>;
}

/**
 * Pure in-memory ZIP writer (STORE method 0, UTF-8 filenames flag 0x0800, exact CRC-32)
 * compatible with `shared/project-zip.ts#readProjectZip` and standard OS/browser unzippers.
 */
export function buildProjectZip(entries: ReadonlyMap<string, Buffer>): Buffer {
  const sortedNames = [...entries.keys()].sort((a, b) => a.localeCompare(b));
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const name of sortedNames) {
    const data = entries.get(name)!;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const size = data.byteLength;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(0, 8); // method 0 (STORE)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5421, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBytes, data);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // UNIX + version 2.0
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBytes.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file mode
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBytes);
    offset += 30 + nameBytes.byteLength + size;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sortedNames.length, 8);
  eocd.writeUInt16LE(sortedNames.length, 10);
  eocd.writeUInt32LE(centralBuf.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function sanitizeFolderSegment(raw: string, used: Set<string>): string {
  const base =
    raw
      .normalize('NFC')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/[. ]+$/g, '')
      .slice(0, 60) || 'project';
  const safeBase = unsafePortableSegment(base) ? `p-${base}` : base;
  let candidate = safeBase;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${safeBase}-${suffix++}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function validateZipProjectInMemory(projectTitle: string, files: ReadonlyMap<string, Buffer>): Promise<void> {
  if (!files.has('index.html')) {
    throw new CloudError('INVALID_ARGUMENT', `Project "${projectTitle}" is missing required index.html.`, {
      status: 400,
      applied: false,
    });
  }
  const now = new Date();
  const records: VirtualFileRecord[] = [];
  const textContents = new Map<string, string>();

  for (const [filePath, buf] of files) {
    const isText = isTextProjectPath(filePath) && !isBinaryBuffer(buf);
    if (isText) textContents.set(filePath, buf.toString('utf8'));
    records.push({
      path: filePath,
      blobScope: 'workspace',
      sha256: sha256Hex(buf),
      sizeBytes: buf.byteLength,
      mimeType: getMimeType(filePath),
      isText,
      updatedAt: now,
    });
  }

  const virtual = new InMemoryVirtualProject({
    projectId: 'archive-validation',
    projectName: projectTitle,
    revision: '0'.repeat(64),
    files: records,
    textContents,
  });

  // Verify HTML/composition parsing works cleanly without local disk.
  await lintProjectInMemory(virtual);
}

export class ProjectArchiveService {
  private readonly db: Database;
  private readonly storage: StoragePort;
  private readonly workspace: WorkspaceService;
  private readonly files: ProjectFilesService;

  constructor(deps: ProjectArchiveServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.workspace = deps.workspace;
    this.files = deps.files;
  }

  /**
   * Export one or more workspace projects into a validated ZIP archive uploaded to S3
   * (`workspaces/{wid}/archives/{archiveId}.zip`), strictly in memory without local disk state.
   */
  async exportProjects(ctx: AuthContext, input: ArchiveExportInput): Promise<ArchiveExportResult> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    let requestId: string;
    try {
      requestId = validateStableRequestId(input.requestId);
    } catch (error) {
      throw new CloudError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid requestId.', {
        status: 400,
        applied: false,
      });
    }

    const scope = 'archive:export';
    const inputHash = canonicalInputHash({
      projectIds: input.projectIds ? [...input.projectIds] : null,
      all: Boolean(input.all),
      expectedRevisions: input.expectedRevisions ?? null,
    });

    const existingReceipt = await this.db
      .select()
      .from(idempotencyReceipts)
      .where(
        and(
          eq(idempotencyReceipts.workspaceId, ctx.workspaceId),
          eq(idempotencyReceipts.scope, scope),
          eq(idempotencyReceipts.requestId, requestId),
        ),
      );
    if (existingReceipt[0]) {
      if (existingReceipt[0].inputHash.trim() !== inputHash) {
        throw new CloudError('REQUEST_ID_CONFLICT', `requestId "${requestId}" was used for a different export.`, {
          status: 409,
          applied: false,
        });
      }
      if (existingReceipt[0].state === 'completed' && existingReceipt[0].responsePayload) {
        return {
          ...(existingReceipt[0].responsePayload as unknown as ArchiveExportResult),
          replayed: true,
        };
      }
    }

    // Resolve target projects within workspace tenant boundary.
    const workspaceProjects = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.trashed, false)));

    let targets: Array<typeof projects.$inferSelect>;
    const skippedProjectIds: string[] = [];

    if (input.all) {
      if (ctx.authMethod === 'oauth_bearer') {
        targets = [];
        for (const project of workspaceProjects) {
          try {
            await assertAgentProjectAccess(this.db, ctx, project);
            targets.push(project);
          } catch {
            // Omit ungranted projects when exporting all accessible projects.
          }
        }
      } else {
        targets = workspaceProjects;
      }
    } else if (input.projectIds && input.projectIds.length > 0) {
      const byId = new Map(workspaceProjects.map((p) => [p.id, p]));
      targets = [];
      for (const pid of input.projectIds) {
        const match = byId.get(pid);
        if (match) {
          await assertAgentProjectAccess(this.db, ctx, match);
          targets.push(match);
        } else {
          skippedProjectIds.push(pid);
        }
      }
    } else {
      throw new CloudError('INVALID_ARGUMENT', 'Specify either projectIds or all=true to export.', {
        status: 400,
        applied: false,
      });
    }

    if (targets.length === 0) {
      throw new CloudError('PROJECT_NOT_FOUND', 'No exportable projects were found.', {
        status: 404,
        applied: false,
      });
    }
    if (targets.length > PROJECT_ARCHIVE_LIMITS.projects) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        `Cannot export more than ${PROJECT_ARCHIVE_LIMITS.projects} projects in one archive.`,
        { status: 400, applied: false },
      );
    }

    // Check expectedRevisions before reading blobs.
    if (input.expectedRevisions) {
      for (const target of targets) {
        const expected = input.expectedRevisions[target.id];
        if (expected !== undefined && target.revision.trim() !== expected.trim()) {
          throw new CloudError(
            'VERSION_CONFLICT',
            `Project "${target.title}" (${target.id}) changed since revision ${expected}.`,
            {
              status: 409,
              applied: false,
              details: { projectId: target.id, expectedRevision: expected, currentRevision: target.revision.trim() },
            },
          );
        }
      }
    }

    const zipEntries = new Map<string, Buffer>();
    const manifestProjects: ArchiveManifest['projects'] = [];
    const exportedEntries: ArchiveExportedProjectEntry[] = [];
    const usedFolders = new Set<string>();
    let totalFiles = 0;
    let totalBytes = 0;

    for (const target of targets) {
      const folder = sanitizeFolderSegment(target.title, usedFolders);
      const fileRows = await this.files.listFiles(ctx, target.id, { allowTrashed: false });
      const projectBuffers = new Map<string, Buffer>();
      let projectBytes = 0;

      for (const row of fileRows) {
        totalFiles++;
        if (totalFiles > PROJECT_ARCHIVE_LIMITS.files) {
          throw new CloudError(
            'INVALID_ARGUMENT',
            `Archive exceeds maximum ${PROJECT_ARCHIVE_LIMITS.files} files.`,
            { status: 413, applied: false },
          );
        }
        const buf = await this.files.readBinaryBlob(
          ctx.workspaceId,
          row.blobScope,
          row.sha256,
          PROJECT_ARCHIVE_LIMITS.bytes,
        );
        totalBytes += buf.byteLength;
        projectBytes += buf.byteLength;
        if (totalBytes > PROJECT_ARCHIVE_LIMITS.bytes) {
          throw new CloudError(
            'INVALID_ARGUMENT',
            `Archive exceeds maximum ${PROJECT_ARCHIVE_LIMITS.bytes} bytes.`,
            { status: 413, applied: false },
          );
        }
        projectBuffers.set(row.path, buf);
        zipEntries.set(`${folder}/${row.path}`, buf);
      }

      await validateZipProjectInMemory(target.title, projectBuffers);

      manifestProjects.push({
        folder,
        title: target.title,
        sourceProjectId: target.id,
        templateId: target.templateId,
        namingLanguage: target.namingLanguage,
        revision: target.revision.trim(),
      });
      exportedEntries.push({
        projectId: target.id,
        title: target.title,
        folder,
        revision: target.revision.trim(),
        fileCount: fileRows.length,
        bytes: projectBytes,
      });
    }

    const manifest: ArchiveManifest = {
      version: ARCHIVE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      projects: manifestProjects,
    };
    zipEntries.set(ARCHIVE_MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));

    const zipBytes = buildProjectZip(zipEntries);
    if (zipBytes.byteLength > PROJECT_ARCHIVE_LIMITS.bytes) {
      throw new CloudError('INVALID_ARGUMENT', 'Finished archive exceeds 500 MB limit.', {
        status: 413,
        applied: false,
      });
    }

    // Self-validate finished ZIP with exact same reader as import!
    readProjectZip(zipBytes);

    const archiveId = randomUUID();
    const s3Key = assertTenantScopedKey(ctx.workspaceId, archiveKey(ctx.workspaceId, archiveId));
    await this.storage.putObject(s3Key, zipBytes, 'application/zip', zipBytes.byteLength);

    const filename =
      exportedEntries.length === 1
        ? `${sanitizeFolderSegment(exportedEntries[0].title, new Set())}.zip`
        : `openmotion-projects-${archiveId.slice(0, 8)}.zip`;

    const result: ArchiveExportResult = {
      archiveId,
      filename,
      bytes: zipBytes.byteLength,
      sha256: sha256Hex(zipBytes),
      downloadUrl: `/motion-api/project-archives/${archiveId}/file`,
      projects: exportedEntries,
      skippedProjectIds,
      replayed: false,
    };

    await this.db
      .insert(idempotencyReceipts)
      .values(
        asInsert(idempotencyReceipts, {
          workspaceId: ctx.workspaceId,
          scope,
          requestId,
          inputHash,
          state: 'completed',
          resourceId: archiveId,
          responsePayload: result as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        }),
      )
      .onConflictDoUpdate({
        target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
        set: asUpdate(idempotencyReceipts, {
          state: 'completed',
          resourceId: archiveId,
          responsePayload: result as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        }),
      });

    return result;
  }

  /**
   * Import an OpenMotion project archive OR standalone Hyperframes composition ZIP purely
   * from memory into S3 CAS + PostgreSQL as independent new projects (never overwriting existing ones).
   */
  async importProjects(ctx: AuthContext, input: ArchiveImportInput): Promise<ArchiveImportResult> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    let requestId: string;
    try {
      requestId = validateStableRequestId(input.requestId);
    } catch (error) {
      throw new CloudError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid requestId.', {
        status: 400,
        applied: false,
      });
    }

    const zipSha = sha256Hex(input.zipBytes);
    const scope = 'archive:import';
    const inputHash = canonicalInputHash({ zipSha, bytes: input.zipBytes.byteLength });

    const existingReceipt = await this.db
      .select()
      .from(idempotencyReceipts)
      .where(
        and(
          eq(idempotencyReceipts.workspaceId, ctx.workspaceId),
          eq(idempotencyReceipts.scope, scope),
          eq(idempotencyReceipts.requestId, requestId),
        ),
      );
    if (existingReceipt[0]) {
      if (existingReceipt[0].inputHash.trim() !== inputHash) {
        throw new CloudError('REQUEST_ID_CONFLICT', `requestId "${requestId}" was used for a different import.`, {
          status: 409,
          applied: false,
        });
      }
      if (existingReceipt[0].state === 'completed' && existingReceipt[0].responsePayload) {
        return {
          ...(existingReceipt[0].responsePayload as unknown as ArchiveImportResult),
          replayed: true,
        };
      }
    }

    let rawFiles: Map<string, Buffer>;
    try {
      rawFiles = readProjectZip(input.zipBytes);
    } catch (error) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        error instanceof Error ? error.message : 'Invalid or unsupported project archive ZIP.',
        { status: 400, applied: false },
      );
    }

    const extractedProjects = this.extractProjectsFromZip(rawFiles, input.filename);
    if (extractedProjects.length === 0) {
      throw new CloudError('INVALID_ARGUMENT', 'Archive does not contain any valid project with index.html.', {
        status: 400,
        applied: false,
      });
    }
    if (extractedProjects.length > PROJECT_ARCHIVE_LIMITS.projects) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        `Archive contains more than ${PROJECT_ARCHIVE_LIMITS.projects} projects.`,
        { status: 400, applied: false },
      );
    }

    // Validate every project before writing anything to S3/PG.
    let totalFiles = 0;
    let totalBytes = 0;
    for (const proj of extractedProjects) {
      const names = [...proj.files.keys()];
      const dup = firstFoldedDuplicate(names, true);
      if (dup) {
        throw new CloudError('INVALID_PATH', `Duplicate case/Unicode folded path "${dup}" in "${proj.title}".`, {
          status: 400,
          applied: false,
        });
      }
      for (const [filePath, buf] of proj.files) {
        try {
          const checked = projectPath(filePath, true);
          assertWritableProjectPath(checked);
        } catch (error) {
          throw new CloudError(
            'INVALID_PATH',
            error instanceof Error ? error.message : `Invalid path "${filePath}" in archive.`,
            { status: 400, applied: false },
          );
        }
        totalFiles++;
        totalBytes += buf.byteLength;
      }
      await validateZipProjectInMemory(proj.title, proj.files);
    }

    // Create each project independently (never overwriting or auto-switching active project).
    const imported: ArchiveImportedProjectEntry[] = [];
    for (const proj of extractedProjects) {
      const initialFiles: InitialProjectFile[] = [...proj.files.entries()].map(([filePath, buf]) => {
        const isText = isTextProjectPath(filePath) && !isBinaryBuffer(buf);
        return {
          path: filePath,
          data: buf,
          mimeType: getMimeType(filePath),
          isText,
        };
      });

      const created = await this.workspace.createProject(ctx, {
        title: proj.title,
        templateId: proj.templateId,
        namingLanguage: proj.namingLanguage,
        initialFiles,
        selectActive: false,
      });

      imported.push({
        projectId: created.projectId,
        sessionId: created.sessionId,
        title: created.title,
        revision: created.revision,
        versionId: created.versionId,
        fileCount: initialFiles.length,
      });
    }

    const result: ArchiveImportResult = {
      imported,
      totalFiles,
      totalBytes,
      replayed: false,
    };

    await this.db
      .insert(idempotencyReceipts)
      .values(
        asInsert(idempotencyReceipts, {
          workspaceId: ctx.workspaceId,
          scope,
          requestId,
          inputHash,
          state: 'completed',
          resourceId: imported[0]?.projectId ?? null,
          responsePayload: result as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        }),
      )
      .onConflictDoUpdate({
        target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
        set: asUpdate(idempotencyReceipts, {
          state: 'completed',
          resourceId: imported[0]?.projectId ?? null,
          responsePayload: result as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        }),
      });

    return result;
  }

  /**
   * Duplicate an existing project inside the same workspace by referencing its existing S3 CAS blobs
   * (zero blob re-upload; increments `workspace_blobs.ref_count` cleanly in PG).
   */
  async duplicateProject(
    ctx: AuthContext,
    projectId: string,
    input: { requestId?: string; title?: string; selectActive?: boolean } = {},
  ) {
    const source = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: false, auth: ctx });
    const sourceFiles = await this.files.listFiles(ctx, source.id, { allowTrashed: false });

    const copyTitle = input.title?.trim()
      ? validateProjectTitle(input.title)
      : `${source.title.slice(0, 90)} Copy`;

    const initialFiles: InitialProjectFile[] = sourceFiles.map((f) => ({
      path: f.path,
      blobScope: f.blobScope as BlobScope,
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
      mimeType: f.mimeType,
      isText: f.isText,
      metadata: f.metadata,
    }));

    return this.workspace.createProject(ctx, {
      title: copyTitle,
      projectType: source.projectType,
      templateId: source.templateId,
      namingLanguage: source.namingLanguage,
      requirements: source.requirements,
      initialFiles,
      requestId: input.requestId,
      selectActive: input.selectActive ?? false,
    });
  }

  /** Answer `HEAD /motion-api/project-archives/:archiveId/file` directly without redirecting HEAD. */
  async headArchive(ctx: AuthContext, archiveId: string): Promise<HeadObjectResult | null> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(archiveId, 'archiveId');
    const s3Key = assertTenantScopedKey(ctx.workspaceId, archiveKey(ctx.workspaceId, archiveId));
    return this.storage.headObject(s3Key);
  }

  /** Generate a short-lived tenant-scoped Presigned GET URL for downloading a ZIP archive. */
  async presignArchiveDownload(
    ctx: AuthContext,
    archiveId: string,
    filename?: string,
  ): Promise<{ url: string; contentLength: number; filename: string } | null> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(archiveId, 'archiveId');
    const s3Key = assertTenantScopedKey(ctx.workspaceId, archiveKey(ctx.workspaceId, archiveId));
    const head = await this.storage.headObject(s3Key);
    if (!head) return null;

    const downloadName = filename || `openmotion-archive-${archiveId.slice(0, 8)}.zip`;
    const url = await this.storage.presignGet(s3Key, {
      expiresInSec: 300,
      responseContentType: 'application/zip',
      responseContentDisposition: buildContentDisposition('attachment', downloadName),
    });
    return {
      url,
      contentLength: head.contentLength,
      filename: downloadName,
    };
  }

  private extractProjectsFromZip(
    rawFiles: ReadonlyMap<string, Buffer>,
    fallbackFilename?: string,
  ): Array<{
    title: string;
    templateId?: string | null;
    namingLanguage?: string | null;
    files: Map<string, Buffer>;
  }> {
    const manifestBuf = rawFiles.get(ARCHIVE_MANIFEST_NAME);
    if (manifestBuf) {
      let manifest: ArchiveManifest;
      try {
        manifest = JSON.parse(manifestBuf.toString('utf8')) as ArchiveManifest;
      } catch {
        throw new CloudError('INVALID_ARGUMENT', 'Malformed openmotion-projects.json manifest in archive.', {
          status: 400,
          applied: false,
        });
      }
      if (!manifest || !Array.isArray(manifest.projects)) {
        throw new CloudError('INVALID_ARGUMENT', 'openmotion-projects.json missing projects array.', {
          status: 400,
          applied: false,
        });
      }

      return manifest.projects.map((entry) => {
        const prefix = `${entry.folder.replace(/^\/+|\/+$/g, '')}/`;
        const files = new Map<string, Buffer>();
        for (const [zipPath, buf] of rawFiles) {
          if (zipPath.startsWith(prefix)) {
            files.set(zipPath.slice(prefix.length), buf);
          }
        }
        const cleanTitle = this.safeImportedTitle(entry.title, entry.folder);
        return {
          title: cleanTitle,
          templateId: entry.templateId ?? null,
          namingLanguage: entry.namingLanguage ?? null,
          files,
        };
      });
    }

    // Standalone Hyperframes composition ZIP (root index.html or single top-level directory).
    if (rawFiles.has('index.html')) {
      const files = new Map<string, Buffer>(rawFiles);
      const title = this.inferStandaloneTitle(files, fallbackFilename);
      return [{ title, files }];
    }

    const topDirs = new Set<string>();
    for (const key of rawFiles.keys()) {
      const slash = key.indexOf('/');
      if (slash > 0) topDirs.add(key.slice(0, slash));
    }

    if (topDirs.size === 1) {
      const [singleDir] = topDirs;
      const prefix = `${singleDir}/`;
      const files = new Map<string, Buffer>();
      for (const [key, buf] of rawFiles) {
        if (key.startsWith(prefix)) files.set(key.slice(prefix.length), buf);
      }
      if (files.has('index.html')) {
        const title = this.inferStandaloneTitle(files, singleDir);
        return [{ title, files }];
      }
    }

    return [];
  }

  private inferStandaloneTitle(files: ReadonlyMap<string, Buffer>, fallback?: string): string {
    for (const marker of ['motion-project.json', 'hyperframes.json', 'project.json', 'meta.json']) {
      const buf = files.get(marker);
      if (!buf) continue;
      try {
        const parsed = JSON.parse(buf.toString('utf8')) as { title?: unknown; name?: unknown };
        const candidate = typeof parsed.title === 'string' ? parsed.title : typeof parsed.name === 'string' ? parsed.name : null;
        if (candidate && candidate.trim()) {
          return this.safeImportedTitle(candidate, fallback);
        }
      } catch {
        // Continue checking fallback markers.
      }
    }
    const stem = fallback?.replace(/\.zip$/i, '').trim() || 'Imported Project';
    return this.safeImportedTitle(stem, 'Imported Project');
  }

  private safeImportedTitle(candidate: string, fallback = 'Imported Project'): string {
    const cleaned = candidate.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 100);
    if (!cleaned) return fallback;
    try {
      return validateProjectTitle(cleaned);
    } catch {
      return fallback;
    }
  }
}
