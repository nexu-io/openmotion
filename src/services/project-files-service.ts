import { OrderedEditEvents } from './ordered-edit-events.ts';
import { prepareFullBaseline } from './text-patch-boundaries.ts';
import { appendTextRevisions, commitTextEdits, type PendingTextRevision, type TextEditIdentity } from './project-text-edits.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { ProjectEvent } from '../contracts/events.ts';
import { htmlFileVersions } from './event-file-versions.ts';
import type { BlobMetadata, BlobScope, PresignGetOptions, StoragePort } from '../contracts/storage.ts';
import { applyWorkspaceBlobRefDeltas, withBlobGcRetry, type BlobRefDelta } from '../db/cas.ts';
import type { Database, DbExecutor } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import { catalogTemplateFiles, workspaceBlobs } from '../db/schema/blobs-assets.ts';
import { idempotencyReceipts, jobs } from '../db/schema/jobs.ts';
import {
  projectFiles,
  projectTextRevisions,
  projectHistoryEntries,
  projectVersionFiles,
  projectVersions,
  type HistoryActorKind,
  type ProjectVersionSource,
} from '../db/schema/project-files.ts';
import { projectGrants, projects } from '../db/schema/projects.ts';
import { projectChannel, workspaceCatalogChannel } from '../infra/redis.ts';
import { assertTenantScopedKey, catalogBlobKey, textRevisionKey, workspaceBlobKey } from '../infra/storage.ts';
import {
  assertWritableProjectPath,
  computeProjectRevision,
  isTextProjectPath,
  isUuid,
  projectPath,
} from '../../shared/project-validation.ts';
import {
  computePreviewImpact,
  createWriteToken,
  DELETED_VERSION,
  formatFileVersion,
  getMimeType,
  hashIndexHeadMarkup,
  sha256Hex,
} from '../studio/etag.ts';
import {
  InMemoryVirtualProject,
  normalizeVirtualPath,
  type VirtualFileRecord,
} from '../studio/virtual-project-store.ts';

export const MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BATCH_FILE_OPS = 256;
export const DEFAULT_HISTORY_COALESCE_WINDOW_MS = 4000;

export interface HotTextCachePort {
  getText(sha256: string): Promise<string | null>;
  setText(sha256: string, content: string, ttlSec?: number): Promise<boolean>;
  getFontCss?(hash: string): Promise<string | null>;
  setFontCss?(hash: string, css: string, ttlSec?: number): Promise<boolean>;
}

export interface EventBusPort {
  publish(channel: string, payload: unknown): Promise<number>;
}

export interface ProjectFilesServiceDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly hotTextCache?: HotTextCachePort;
  readonly eventBus?: EventBusPort;
  /** Coalesce rapid interactive Studio edits within this window (ms). Set 0 to disable coalescing. Defaults to 4000ms. */
  readonly historyCoalesceWindowMs?: number;
  /** Optional clock provider for deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  readonly textPatchWrites?: boolean;
}

export type ProjectFileOp =
  | {
      readonly op: 'upsert_text';
      readonly path: string;
      readonly content: string;
      readonly mimeType?: string;
      readonly stampHfIds?: boolean;
    }
  | {
      readonly op: 'upsert_binary';
      readonly path: string;
      readonly data: Buffer;
      readonly mimeType?: string;
      readonly metadata?: BlobMetadata | null;
    }
  | {
      readonly op: 'upsert_ref';
      readonly path: string;
      readonly blobScope: BlobScope;
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly mimeType: string;
      readonly isText: boolean;
      readonly metadata?: BlobMetadata | null;
    }
  | {
      readonly op: 'delete';
      readonly path: string;
    };

export interface FilePrecondition {
  readonly path: string;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
}

export interface CommitProjectFilesInput {
  readonly orderedEvents?: OrderedEditEvents;
  readonly projectId: string;
  readonly ops: readonly ProjectFileOp[];
  readonly textRevisions?: readonly PendingTextRevision[];
  readonly expectedRevision?: string;
  readonly expectedVersionId?: string;
  readonly filePreconditions?: readonly FilePrecondition[];
  readonly requestId?: string;
  readonly idempotencyScope?: string;
  /** For derived edits the logical request is stable even when its generated HTML is not. */
  readonly commandReceipt?: { inputHash: string; result: Record<string, unknown> };
  readonly origin?: 'studio' | 'mcp' | 'agent' | 'import' | 'system';
  readonly source?: ProjectVersionSource;
  readonly summary?: string;
  readonly actorKind?: HistoryActorKind;
  readonly actorName?: string;
  readonly windowId?: string | null;
  /** Authenticated user's continuous Studio gesture. Its snapshots remain individually addressable. */
  readonly undoGroup?: string;
  readonly writeToken?: string | null;
  readonly skipVersion?: boolean;
  readonly forceVersion?: boolean;
  readonly projectUpdates?: {
    readonly namingLanguage?: string | null;
    readonly requirements?: string | null;
    readonly title?: string;
  };
}

export interface CommitProjectFilesResult {
  readonly previousRevision?: string;
  readonly projectId: string;
  readonly revision: string;
  readonly versionId: string | null;
  readonly versionNumber: number;
  readonly historySeq: number;
  readonly changedPaths: string[];
  readonly deletedPaths: string[];
  readonly versionsByPath: Record<string, string>;
  readonly writeToken: string;
  readonly affectsPreview: boolean;
  readonly fileTreeChanged?: boolean;
  readonly affectedCompositions: string[];
  readonly replayed: boolean;
  readonly commandResult?: Record<string, unknown>;
  readonly coalesced?: boolean;
}

export interface ReadTextFileResult {
  readonly file: VirtualFileRecord;
  readonly content: string;
  readonly version: string;
}

export interface ReadBinaryFileResult {
  readonly file: VirtualFileRecord;
  readonly buffer: Buffer;
  readonly version: string;
}

interface PreparedBlobUpload {
  readonly sha256: string;
  readonly s3Key: string;
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly textContent?: string;
  readonly metadata?: BlobMetadata | null;
}

type PreparedFileOp =
  | {
      readonly op: 'upsert';
      readonly path: string;
      readonly blobScope: BlobScope;
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly mimeType: string;
      readonly isText: boolean;
      readonly metadata?: BlobMetadata | null;
    }
  | {
      readonly op: 'delete';
      readonly path: string;
    };

export type ProjectRecord = typeof projects.$inferSelect;

export function assertValidUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new CloudError('INVALID_ARGUMENT', `${label} must be a valid UUID`, {
      status: 400,
      applied: false,
    });
  }
  return value;
}

export function normalizeSafeProjectPath(rawPath: string, writable = false): string {
  const cleaned = normalizeVirtualPath(rawPath);
  try {
    const validated = projectPath(cleaned, true);
    if (writable) assertWritableProjectPath(validated);
    return validated;
  } catch (error) {
    throw new CloudError(
      'INVALID_PATH',
      error instanceof Error ? error.message : `Invalid project path: ${rawPath}`,
      { status: 400, applied: false },
    );
  }
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  const inspectLen = Math.min(buffer.byteLength, 8000);
  for (let i = 0; i < inspectLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function resolveBlobStorageKey(workspaceId: string, blobScope: BlobScope, sha256: string): string {
  if (blobScope === 'patch') return textRevisionKey(workspaceId, sha256);
  const key = blobScope === 'catalog' ? catalogBlobKey(sha256) : workspaceBlobKey(workspaceId, sha256);
  return assertTenantScopedKey(workspaceId, key, { allowCatalog: blobScope === 'catalog' });
}

export function canonicalInputHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function readCommitReceipt(
  db: DbExecutor, workspaceId: string, scope: string, requestId: string, inputHash: string, lock = false,
): Promise<CommitProjectFilesResult | null> {
  const query = db
    .select()
    .from(idempotencyReceipts)
    .where(
      and(
        eq(idempotencyReceipts.workspaceId, workspaceId),
        eq(idempotencyReceipts.scope, scope),
        eq(idempotencyReceipts.requestId, requestId),
      ),
    )
    .limit(1);
  const [receipt] = lock ? await query.for('update') : await query;
  if (receipt) {
    if (receipt.inputHash.trim() !== inputHash) {
      throw new CloudError(
        'REQUEST_ID_CONFLICT',
        `requestId "${requestId}" was already used with a different payload.`,
        { status: 409, applied: false, details: { requestId, scope } },
      );
    }
    if (receipt.state === 'completed' && receipt.responsePayload) {
      return {
        ...(receipt.responsePayload as unknown as CommitProjectFilesResult),
        replayed: true,
      };
    }
  }
  return null;
}

export type AgentProjectFilter = (project: { id: string; ownerUserId: string | null }) => boolean;

/**
 * OAuth agents only see projects granted to their connection, matching `assertAgentProjectAccess`.
 * Returns null for callers that are not restricted by project grants.
 */
export async function agentProjectFilter(db: DbExecutor, auth: AuthContext): Promise<AgentProjectFilter | null> {
  if (auth.authMethod !== 'oauth_bearer') return null;
  if (!auth.clientId) return () => false;
  const rows = await db
    .select({ projectId: projectGrants.projectId })
    .from(projectGrants)
    .where(
      and(
        eq(projectGrants.userId, auth.userId),
        eq(projectGrants.clientId, auth.clientId),
        isNull(projectGrants.revokedAt),
      ),
    );
  const granted = new Set(rows.map((row) => row.projectId));
  return (project) =>
    granted.has(project.id) && (!project.ownerUserId || project.ownerUserId === auth.userId);
}

/**
 * A session's conversation belongs to its projects: an OAuth agent may address a session only when it
 * holds no project yet or at least one granted project. Other sessions look missing.
 */
export async function assertAgentSessionAccess(db: DbExecutor, auth: AuthContext, sessionId: string): Promise<void> {
  const visible = await agentProjectFilter(db, auth);
  if (!visible) return;
  const rows = await db
    .select({ id: projects.id, ownerUserId: projects.ownerUserId })
    .from(projects)
    .where(and(eq(projects.workspaceId, auth.workspaceId), eq(projects.sessionId, sessionId)));
  if (rows.length > 0 && !rows.some(visible)) {
    throw new CloudError('SESSION_NOT_FOUND', `Session ${sessionId} was not found.`, { status: 404, applied: false });
  }
}

export async function assertAgentProjectAccess(
  db: DbExecutor,
  auth: AuthContext,
  project: ProjectRecord,
): Promise<void> {
  if (auth.authMethod === 'preview_token') {
    if (auth.tokenId !== `om_preview:${project.id}`) {
      throw new CloudError('PROJECT_NOT_FOUND', `Project ${project.id} was not found in this workspace.`, {
        status: 404,
        applied: false,
      });
    }
    return;
  }
  if (auth.authMethod !== 'oauth_bearer') return;

  // Owner check: if the project records an ownerUserId, a different user gets the same 404
  // (`project_not_found`) so unauthorized callers cannot probe project existence.
  if (project.ownerUserId && project.ownerUserId !== auth.userId) {
    throw new CloudError('PROJECT_NOT_FOUND', `Project ${project.id} was not found in this workspace.`, {
      status: 404,
      applied: false,
    });
  }

  if (!auth.clientId) {
    throw new CloudError(
      'PROJECT_GRANT_REQUIRED',
      'This agent connection does not have project authorization. Grant access in OpenDesign project settings.',
      { status: 403, applied: false, details: { projectId: project.id } },
    );
  }

  const [grant] = await db
    .select({ id: projectGrants.id })
    .from(projectGrants)
    .where(
      and(
        eq(projectGrants.projectId, project.id),
        eq(projectGrants.userId, auth.userId),
        eq(projectGrants.clientId, auth.clientId),
        isNull(projectGrants.revokedAt),
      ),
    )
    .limit(1);

  if (!grant) {
    throw new CloudError(
      'PROJECT_GRANT_REQUIRED',
      'This agent connection is not authorized for this project. Open the project in OpenDesign and grant access.',
      { status: 403, applied: false, details: { projectId: project.id, clientId: auth.clientId } },
    );
  }
}

export async function loadProjectOrThrow(
  db: DbExecutor,
  workspaceId: string,
  projectId: string,
  options: { allowTrashed?: boolean; forUpdate?: boolean; auth?: AuthContext } = {},
): Promise<ProjectRecord> {
  assertValidUuid(workspaceId, 'workspaceId');
  assertValidUuid(projectId, 'projectId');

  const query = db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));

  const rows = options.forUpdate ? await query.for('update') : await query;
  const project = rows[0];
  if (!project) {
    throw new CloudError('PROJECT_NOT_FOUND', `Project ${projectId} was not found in this workspace.`, {
      status: 404,
      applied: false,
    });
  }
  if (options.auth) {
    await assertAgentProjectAccess(db, options.auth, project);
  }
  if (project.trashed && !options.allowTrashed) {
    throw new CloudError('PROJECT_TRASHED', `Project ${projectId} is in the trash and cannot be modified.`, {
      status: 400,
      applied: false,
    });
  }
  return project;
}

function actorDefaults(ctx: AuthContext, actorKind?: HistoryActorKind, actorName?: string): {
  actorKind: HistoryActorKind;
  actorName: string;
} {
  const kind: HistoryActorKind =
    actorKind ?? (ctx.authMethod === 'session_cookie' || ctx.authMethod === 'dev_bypass' ? 'user' : 'agent');
  const name = (actorName?.trim() || ctx.displayName?.trim() || ctx.email?.trim() || kind).slice(0, 128);
  return { actorKind: kind, actorName: name };
}

export class ProjectFilesService {
  private readonly db: Database;
  private readonly storage: StoragePort;
  private readonly hotTextCache?: HotTextCachePort;
  private readonly eventBus?: EventBusPort;
  private readonly historyCoalesceWindowMs: number;
  private readonly nowFn: () => Date;
  readonly textPatchWrites: boolean;

  constructor(deps: ProjectFilesServiceDeps) {
    this.db = deps.db;
    this.textPatchWrites = deps.textPatchWrites ?? false;
    this.storage = deps.storage;
    this.hotTextCache = deps.hotTextCache;
    this.eventBus = deps.eventBus;
    this.historyCoalesceWindowMs = Math.max(
      0,
      Math.floor(deps.historyCoalesceWindowMs ?? DEFAULT_HISTORY_COALESCE_WINDOW_MS),
    );
    this.nowFn = deps.now ?? (() => new Date());
  }

  /**
   * List all files in a project along with cached media metadata from `workspace_blobs`
   * and `catalog_template_files`. Never hits local disk.
   */
  async listFiles(ctx: AuthContext, projectId: string, options: { allowTrashed?: boolean } = {}): Promise<VirtualFileRecord[]> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, {
      allowTrashed: options.allowTrashed ?? true,
      auth: ctx,
    });
    return this.listFilesForProject(ctx, project.id);
  }

  private async listFilesForProject(ctx: AuthContext, projectId: string): Promise<VirtualFileRecord[]> {
    const rows = await this.db
      .select()
      .from(projectFiles)
      .where(and(eq(projectFiles.workspaceId, ctx.workspaceId), eq(projectFiles.projectId, projectId)))
      .orderBy(asc(projectFiles.path));

    if (rows.length === 0) return [];

    const workspaceShas = [...new Set(rows.filter((r) => r.blobScope === 'workspace').map((r) => r.sha256.trim()))];
    const catalogShas = [...new Set(rows.filter((r) => r.blobScope === 'catalog').map((r) => r.sha256.trim()))];

    const workspaceMetaMap = new Map<string, BlobMetadata | null>();
    const catalogMetaMap = new Map<string, BlobMetadata | null>();

    await Promise.all([
      workspaceShas.length > 0
        ? this.db
            .select({ sha256: workspaceBlobs.sha256, metadata: workspaceBlobs.metadata })
            .from(workspaceBlobs)
            .where(and(eq(workspaceBlobs.workspaceId, ctx.workspaceId), inArray(workspaceBlobs.sha256, workspaceShas)))
            .then((blobRows) => {
              for (const blob of blobRows) {
                workspaceMetaMap.set(blob.sha256.trim(), blob.metadata ?? null);
              }
            })
        : Promise.resolve(),
      catalogShas.length > 0
        ? this.db
            .select({ sha256: catalogTemplateFiles.sha256, metadata: catalogTemplateFiles.metadata })
            .from(catalogTemplateFiles)
            .where(inArray(catalogTemplateFiles.sha256, catalogShas))
            .then((catRows) => {
              for (const cat of catRows) {
                const key = cat.sha256.trim();
                if (!catalogMetaMap.has(key) || cat.metadata) {
                  catalogMetaMap.set(key, cat.metadata ?? null);
                }
              }
            })
        : Promise.resolve(),
    ]);

    return rows.map((row) => {
      const sha256 = row.sha256.trim();
      const metadata =
        row.blobScope === 'catalog'
          ? (catalogMetaMap.get(sha256) ?? null)
          : (workspaceMetaMap.get(sha256) ?? null);
      return {
        path: row.path,
        blobScope: row.blobScope,
        sha256,
        sizeBytes: Number(row.sizeBytes),
        mimeType: row.mimeType,
        isText: row.isText,
        updatedAt: row.updatedAt,
        metadata,
      };
    });
  }

  /** Lightweight existence check for a file in an already-authorized project. */
  async hasFile(ctx: AuthContext, projectId: string, filePath: string): Promise<boolean> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(projectId, 'projectId');
    const safePath = normalizeSafeProjectPath(filePath);
    const rows = await this.db
      .select({ path: projectFiles.path })
      .from(projectFiles)
      .where(
        and(
          eq(projectFiles.workspaceId, ctx.workspaceId),
          eq(projectFiles.projectId, projectId),
          eq(projectFiles.path, safePath),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Lookup metadata for a single project file (PG metadata only, zero S3 read). */
  async getFile(
    ctx: AuthContext,
    projectId: string,
    filePath: string,
    options: { allowTrashed?: boolean } = {},
  ): Promise<VirtualFileRecord | null> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(projectId, 'projectId');
    const safePath = normalizeSafeProjectPath(filePath);

    const rows = await this.db
      .select({
        project: projects,
        file: projectFiles,
        workspaceBlobMetadata: workspaceBlobs.metadata,
      })
      .from(projects)
      .leftJoin(
        projectFiles,
        and(
          eq(projectFiles.workspaceId, projects.workspaceId),
          eq(projectFiles.projectId, projects.id),
          eq(projectFiles.path, safePath),
        ),
      )
      .leftJoin(
        workspaceBlobs,
        and(
          eq(workspaceBlobs.workspaceId, projectFiles.workspaceId),
          eq(workspaceBlobs.sha256, projectFiles.sha256),
          eq(projectFiles.blobScope, 'workspace'),
        ),
      )
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, ctx.workspaceId)))
      .limit(1);

    const joined = rows[0];
    if (!joined) {
      throw new CloudError('PROJECT_NOT_FOUND', `Project ${projectId} was not found in this workspace.`, {
        status: 404,
        applied: false,
      });
    }
    await assertAgentProjectAccess(this.db, ctx, joined.project);
    if (joined.project.trashed && !(options.allowTrashed ?? true)) {
      throw new CloudError('PROJECT_TRASHED', `Project ${projectId} is in the trash and cannot be modified.`, {
        status: 400,
        applied: false,
      });
    }

    const row = joined.file;
    if (!row) return null;

    const sha256 = row.sha256.trim();
    let metadata: BlobMetadata | null =
      row.blobScope === 'workspace' ? (joined.workspaceBlobMetadata ?? null) : null;
    if (row.blobScope === 'catalog') {
      const catRows = await this.db
        .select({ metadata: catalogTemplateFiles.metadata })
        .from(catalogTemplateFiles)
        .where(eq(catalogTemplateFiles.sha256, sha256))
        .limit(1);
      metadata = catRows[0]?.metadata ?? null;
    }

    return {
      path: row.path,
      blobScope: row.blobScope,
      sha256,
      sizeBytes: Number(row.sizeBytes),
      mimeType: row.mimeType,
      isText: row.isText,
      updatedAt: row.updatedAt,
      metadata,
    };
  }

  /** Read a text blob via SHA-256 HotTextCache -> S3 CAS fallback + async cache warm. */
  async readTextBlob(workspaceId: string, blobScope: BlobScope, sha256: string): Promise<string> {
    if (this.hotTextCache && blobScope !== 'patch') {
      try {
        const cached = await this.hotTextCache.getText(sha256);
        if (cached !== null) return cached;
      } catch {
        // Fall through to authoritative S3 CAS.
      }
    }

    const key = resolveBlobStorageKey(workspaceId, blobScope, sha256);
    const buffer = await this.storage.getObjectBuffer(key, MAX_TEXT_FILE_BYTES);
    const content = buffer.toString('utf8');

    if (this.hotTextCache && blobScope !== 'patch') {
      void this.hotTextCache.setText(sha256, content).catch(() => {});
    }
    return content;
  }

  /** A command only needs the referenced files, even in a project with thousands of assets. */
  async readEditInputs(ctx: AuthContext, projectId: string, requested: ReadonlyMap<string, 'text' | 'asset' | 'optional-text'>,
    scope: string, requestId: string, inputHash: string, base?: { expectedRevision: string; expectedVersionId: string }) {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { auth: ctx, allowTrashed: false });
    const rows = await this.db.select().from(projectFiles).where(and(
      eq(projectFiles.workspaceId, ctx.workspaceId), eq(projectFiles.projectId, projectId),
      inArray(projectFiles.path, [...requested.keys()]),
    ));
    // Look up the receipt after observing the source rows so concurrent identical requests
    // either see the original input or replay the first commit.
    const replay = await readCommitReceipt(this.db, ctx.workspaceId, scope, requestId, inputHash);
    if (replay) return { kind: 'replay' as const, commit: replay };
    if (base && (project.revision.trim() !== base.expectedRevision || project.currentVersionId !== base.expectedVersionId)) {
      throw new CloudError('VERSION_CONFLICT', 'Project version changed before the edit', {
        status: 409, applied: false, details: { currentRevision: project.revision.trim(), currentVersionId: project.currentVersionId },
      });
    }
    const versions = new Map<string, string | null>();
    const sources = new Map<string, string>();
    for (const file of rows) {
      if (requested.get(file.path) !== 'asset' && !file.isText) {
        throw new CloudError('INVALID_ARGUMENT', 'A composition must be a text file', { status: 415 });
      }
      versions.set(file.path, formatFileVersion(file.blobScope, file.sha256.trim()));
    }
    for (const path of requested.keys()) {
      if (!versions.has(path) && requested.get(path) === 'optional-text') {
        versions.set(path, null);
        sources.set(path, '');
      }
      if (!versions.has(path)) throw new CloudError('NOT_FOUND', `Project file not found: ${path}`, { status: 404 });
    }
    await Promise.all(rows.filter(file => requested.get(file.path) !== 'asset').map(async file => {
      sources.set(file.path, await this.readTextBlob(ctx.workspaceId, file.blobScope, file.sha256.trim()));
    }));
    return { kind: 'inputs' as const, revision: project.revision.trim(), versionId: project.currentVersionId, versions, sources, filesByPath: new Map(rows.map(file => [file.path, file] as const)) };
  }

  /** MCP supplies a project snapshot. Only files actually used by an edit need to match. */
  async checkObservedFiles(ctx: AuthContext, projectId: string, expected: {expectedVersionId: string; expectedRevision: string},
    versions: ReadonlyMap<string, string | null>): Promise<void> {
    if (!isUuid(expected.expectedVersionId)) {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid project version ID', {status: 400, applied: false});
    }
    const [snapshot] = await this.db.select({revision: projectVersions.revision}).from(projectVersions).where(and(
      eq(projectVersions.workspaceId, ctx.workspaceId), eq(projectVersions.projectId, projectId), eq(projectVersions.id, expected.expectedVersionId)));
    if (!snapshot || snapshot.revision !== expected.expectedRevision) throw new CloudError('VERSION_CONFLICT',
      'The original project snapshot is unavailable', {status: 409, applied: false});
    const entries = await this.db.select().from(projectVersionFiles).where(and(eq(projectVersionFiles.versionId, expected.expectedVersionId),
      eq(projectVersionFiles.projectId, projectId), inArray(projectVersionFiles.path, [...versions.keys()])));
    const observed = new Map(entries.map(entry => [entry.path, formatFileVersion(entry.blobScope, entry.sha256)]));
    for (const [path, currentVersion] of versions) {
      if ((observed.get(path) ?? null) !== currentVersion) throw new CloudError('VERSION_CONFLICT', 'An input file was changed',
        {status: 409, applied: false, details: {path, currentVersion}});
    }
  }

  async readTextForCommand(ctx: AuthContext, projectId: string, path: string, scope: string, requestId: string, inputHash: string) {
    const snapshot = await this.readEditInputs(ctx, projectId, new Map([[path, 'text']]), scope, requestId, inputHash);
    return snapshot.kind === 'replay' ? snapshot : { kind: 'source' as const, content: snapshot.sources.get(path)! };
  }

  /** Read a binary blob directly from S3 CAS. */
  async readBinaryBlob(workspaceId: string, blobScope: BlobScope, sha256: string, maxBytes?: number): Promise<Buffer> {
    const key = resolveBlobStorageKey(workspaceId, blobScope, sha256);
    return this.storage.getObjectBuffer(key, maxBytes);
  }

  /** Read a single text file from a project. Throws `INVALID_ARGUMENT` (415) if binary. */
  async readTextFile(
    ctx: AuthContext,
    projectId: string,
    filePath: string,
  ): Promise<ReadTextFileResult | null> {
    const file = await this.getFile(ctx, projectId, filePath);
    if (!file) return null;
    if (!file.isText) {
      throw new CloudError('INVALID_ARGUMENT', `File "${file.path}" is binary and cannot be read as text.`, {
        status: 415,
        applied: false,
        details: { why: 'binary', path: file.path, version: formatFileVersion(file.blobScope, file.sha256) },
      });
    }
    const content = await this.readTextBlob(ctx.workspaceId, file.blobScope, file.sha256);
    return {
      file,
      content,
      version: formatFileVersion(file.blobScope, file.sha256),
    };
  }

  /** The caller resolves revisionId from the authorized project's file manifest. */
  async readParentPatch(workspaceId: string, projectId: string, revisionId: string, baseVersion: string) {
    const [row] = await this.db.select({
      parentScope: projectTextRevisions.parentScope, parentId: projectTextRevisions.parentId, patch: projectTextRevisions.patch,
    }).from(projectTextRevisions).where(and(eq(projectTextRevisions.workspaceId, workspaceId),
      eq(projectTextRevisions.projectId, projectId), eq(projectTextRevisions.id, revisionId)));
    return row && formatFileVersion(row.parentScope, row.parentId) === baseVersion ? row.patch : undefined;
  }

  /** Read a single file as raw Buffer from S3 CAS. */
  async readBinaryFile(
    ctx: AuthContext,
    projectId: string,
    filePath: string,
    maxBytes?: number,
  ): Promise<ReadBinaryFileResult | null> {
    const file = await this.getFile(ctx, projectId, filePath);
    if (!file) return null;
    const buffer = await this.readBinaryBlob(ctx.workspaceId, file.blobScope, file.sha256, maxBytes);
    return {
      file,
      buffer,
      version: formatFileVersion(file.blobScope, file.sha256),
    };
  }

  /** Generate a short-lived tenant-scoped Presigned GET URL for an already-loaded project file (0 DB queries). */
  async presignResolvedFileGet(
    workspaceId: string,
    file: VirtualFileRecord,
    options: PresignGetOptions = {},
  ): Promise<{ file: VirtualFileRecord; url: string; etag: string }> {
    const key = resolveBlobStorageKey(workspaceId, file.blobScope, file.sha256);
    const url = await this.storage.presignGet(key, {
      expiresInSec: options.expiresInSec ?? 300,
      responseContentType: options.responseContentType ?? file.mimeType,
      ...(options.responseContentDisposition
        ? { responseContentDisposition: options.responseContentDisposition }
        : {}),
    });
    return {
      file,
      url,
      etag: formatFileVersion(file.blobScope, file.sha256),
    };
  }

  /**
   * Load an immutable in-memory snapshot (`InMemoryVirtualProject`) of a project's files and
   * text contents for `bundlePreviewInMemory`, `lintProjectInMemory`, `infoInMemory`, and `timelineInMemory`.
   */
  async loadVirtualProject(
    ctx: AuthContext,
    projectId: string,
    includeText?: (path: string) => boolean,
  ): Promise<InMemoryVirtualProject> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, {
      allowTrashed: true,
      auth: ctx,
    });
    const files = await this.listFilesForProject(ctx, project.id);

    const textContents = new Map<string, string>();
    const textFiles = files.filter((f) => f.isText && (!includeText || includeText(f.path)));

    // Deduplicate blob fetches when multiple paths share the same SHA-256.
    const uniqueBlobs = new Map<string, { blobScope: BlobScope; sha256: string }>();
    for (const file of textFiles) {
      const cacheId = `${file.blobScope}:${file.sha256}`;
      if (!uniqueBlobs.has(cacheId)) {
        uniqueBlobs.set(cacheId, { blobScope: file.blobScope, sha256: file.sha256 });
      }
    }

    const loadedByBlob = new Map<string, string>();
    await Promise.all(
      [...uniqueBlobs.entries()].map(async ([cacheId, ref]) => {
        const text = await this.readTextBlob(ctx.workspaceId, ref.blobScope, ref.sha256);
        loadedByBlob.set(cacheId, text);
      }),
    );

    for (const file of textFiles) {
      const content = loadedByBlob.get(`${file.blobScope}:${file.sha256}`);
      if (content !== undefined) {
        textContents.set(file.path, content);
      }
    }

    return new InMemoryVirtualProject({
      projectId: project.id,
      projectName: project.title,
      templateId: project.templateId,
      // A commit may land between loading the project and listing its files.
      revision: computeProjectRevision(files.map(f => ({ path: f.path, size: f.sizeBytes, hash: f.sha256 }))),
      files,
      textContents,
    });
  }

  /**
   * Atomically commit one or more file edits/deletions to a project using:
   * 1. Pre-transaction S3 CAS upload (`putBlobIfAbsent`)
   * 2. `SELECT ... FOR UPDATE` row lock on `projects`
   * 3. `idempotency_receipts` deduplication & inputHash verification
   * 4. Optimistic concurrency check (`expectedRevision`, `expectedVersionId`, per-file `If-Match`/`If-None-Match`)
   * 5. Deadlock-free sorted-`sha256` `applyWorkspaceBlobRefDeltas`
   * 6. Canonical SHA-256 `revision` recomputation + unified PG version & history append
   * 7. Post-commit `HotTextCache` warm + `RedisEventBus` notification (`om:project:{wid}:{pid}`).
   */
  async withOrderedEditEvents<T>(ctx: AuthContext, projectId: string, run: (events: OrderedEditEvents) => Promise<T>): Promise<T> {
    const events = new OrderedEditEvents(ctx.workspaceId, projectId);
    try {
      return await run(events);
    } finally {
      const bus = this.eventBus;
      if (bus) {
        await events.publish(event => bus.publish(projectChannel(ctx.workspaceId, projectId), event)).catch(() => {});
      }
    }
  }

  async commitTextEdits(ctx: AuthContext, projectId: string, body: unknown, identity: TextEditIdentity) {
    return commitTextEdits(this, this.db, this.storage, ctx, projectId, body, identity);
  }

  async commitChanges(ctx: AuthContext, input: CommitProjectFilesInput): Promise<CommitProjectFilesResult> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(input.projectId, 'projectId');

    if (input.ops.length + (input.textRevisions?.length ?? 0) > MAX_BATCH_FILE_OPS) {
      throw new CloudError('INVALID_ARGUMENT', `Too many file operations in one commit (max ${MAX_BATCH_FILE_OPS}).`, {
        status: 400,
        applied: false,
      });
    }

    const writeToken = createWriteToken(input.writeToken);
    const { preparedOps, uploads } = this.prepareOperations(ctx.workspaceId, input.ops);

    // Build deterministic idempotency hash before hitting PG.
    const scope = input.idempotencyScope ?? 'project:files:commit';
    const inputHash = input.requestId
      ? input.commandReceipt?.inputHash ?? canonicalInputHash({
          projectId: input.projectId,
          ops: preparedOps.map((op) =>
            op.op === 'delete'
              ? { op: 'delete', path: op.path }
              : {
                  op: 'upsert',
                  path: op.path,
                  blobScope: op.blobScope,
                  sha256: op.sha256,
                  sizeBytes: op.sizeBytes,
                  mimeType: op.mimeType,
                },
          ),
          projectUpdates: input.projectUpdates ?? null,
        })
      : null;

    const result = await withBlobGcRetry(async () => {
      // A previous GC claim may have removed the object. Re-publish before retrying the transaction.
      for (const upload of uploads.values()) {
        await this.storage.putBlobIfAbsent(upload.s3Key, upload.buffer, upload.mimeType);
      }
      return this.executeCommitTransaction(ctx, input, preparedOps, uploads, writeToken, scope, inputHash);
    });

    // Post-commit ONLY: warm HotTextCache and publish to RedisEventBus.
    if (!result.replayed) {
      if (this.hotTextCache) {
        for (const upload of uploads.values()) {
          if (upload.textContent !== undefined) {
            void this.hotTextCache.setText(upload.sha256, upload.textContent).catch(() => {});
          }
        }
      }

      if (this.eventBus && input.projectUpdates?.title !== undefined) {
        void this.eventBus.publish(workspaceCatalogChannel(ctx.workspaceId), { type: 'catalog-changed' }).catch(() => {});
      }
      const eventPaths = [...new Set([...result.changedPaths, ...result.deletedPaths])];
      // Patch commits have no source bytes here. Computing thumbnail metadata must never
      // materialize a file or make saving depend on object storage.
      let indexHeadHash: string | undefined;
      if (this.eventBus && eventPaths.includes('index.html')) {
        const indexOp = preparedOps.find(op => op.path === 'index.html');
        const text = indexOp?.op === 'upsert' ? uploads.get(indexOp.sha256)?.textContent : undefined;
        if (text !== undefined) indexHeadHash = hashIndexHeadMarkup(text);
        else if (result.deletedPaths.includes('index.html')) indexHeadHash = hashIndexHeadMarkup('');
      }
      if (input.orderedEvents) {
        input.orderedEvents.record(result, input.textRevisions ?? [], indexHeadHash);
        return result;
      }
      if (this.eventBus && eventPaths.length > 0) {
        const event: ProjectEvent = {
          type: 'file-change',
          workspaceId: ctx.workspaceId,
          projectId: input.projectId,
          revision: result.revision,
          versionId: result.versionId ?? undefined,
          paths: eventPaths,
          fileVersions: htmlFileVersions(eventPaths, path => result.versionsByPath[path] ?? null),
          ...(indexHeadHash ? { indexHeadHash } : {}),
          ...(result.changedPaths.length === 0 && { version: DELETED_VERSION }),
          writeToken: result.writeToken,
          affectsPreview: result.affectsPreview,
          fileTreeChanged: result.fileTreeChanged,
          affectedCompositions: result.affectedCompositions,
          ts: Date.now(),
        };
        void this.eventBus.publish(projectChannel(ctx.workspaceId, input.projectId), event).catch(() => {});
      }
      if (this.eventBus && !input.skipVersion && (eventPaths.length || input.forceVersion)) {
        const historyEvent: ProjectEvent = {
          type: 'history-changed',
          workspaceId: ctx.workspaceId,
          projectId: input.projectId,
          revision: result.revision,
          versionId: result.versionId ?? undefined,
          historySeq: result.historySeq,
          ts: Date.now(),
        };
        void this.eventBus.publish(projectChannel(ctx.workspaceId, input.projectId), historyEvent).catch(() => {});
      }
    }

    return result;
  }

  private prepareOperations(
    workspaceId: string,
    ops: readonly ProjectFileOp[],
  ): {
    preparedOps: PreparedFileOp[];
    uploads: Map<string, PreparedBlobUpload>;
  } {
    const uploads = new Map<string, PreparedBlobUpload>();
    const preparedOps: PreparedFileOp[] = [];

    for (const op of ops) {
      if (op.op === 'delete') {
        const safePath = normalizeSafeProjectPath(op.path);
        preparedOps.push({ op: 'delete', path: safePath });
        continue;
      }

      const safePath = normalizeSafeProjectPath(op.path, true);
      if (op.op === 'upsert_text') {
        let text = op.content;
        if (op.stampHfIds && (safePath.endsWith('.html') || safePath.endsWith('.htm'))) {
          text = stampHfIdsInPlace(text);
        }
        const buffer = Buffer.from(text, 'utf8');
        if (buffer.byteLength > MAX_TEXT_FILE_BYTES) {
          throw new CloudError('INVALID_ARGUMENT', `Text file "${safePath}" exceeds 16 MB limit.`, {
            status: 413,
            applied: false,
          });
        }
        const sha256 = sha256Hex(buffer);
        const mimeType = op.mimeType ?? getMimeType(safePath);
        const s3Key = workspaceBlobKey(workspaceId, sha256);
        if (!uploads.has(sha256)) {
          uploads.set(sha256, {
            sha256,
            s3Key,
            buffer,
            mimeType,
            textContent: text,
          });
        }
        preparedOps.push({
          op: 'upsert',
          path: safePath,
          blobScope: 'workspace',
          sha256,
          sizeBytes: buffer.byteLength,
          mimeType,
          isText: true,
        });
      } else if (op.op === 'upsert_binary') {
        const buffer = op.data;
        const sha256 = sha256Hex(buffer);
        const mimeType = op.mimeType ?? getMimeType(safePath);
        const s3Key = workspaceBlobKey(workspaceId, sha256);
        const isText = isTextProjectPath(safePath) && !isBinaryBuffer(buffer);
        if (!uploads.has(sha256)) {
          uploads.set(sha256, {
            sha256,
            s3Key,
            buffer,
            mimeType,
            textContent: isText ? buffer.toString('utf8') : undefined,
            metadata: op.metadata,
          });
        }
        preparedOps.push({
          op: 'upsert',
          path: safePath,
          blobScope: 'workspace',
          sha256,
          sizeBytes: buffer.byteLength,
          mimeType,
          isText,
          metadata: op.metadata,
        });
      } else {
        preparedOps.push({
          op: 'upsert',
          path: safePath,
          blobScope: op.blobScope,
          sha256: op.sha256,
          sizeBytes: op.sizeBytes,
          mimeType: op.mimeType,
          isText: op.isText,
          metadata: op.metadata,
        });
      }
    }

    return { preparedOps, uploads };
  }

  private async executeCommitTransaction(
    ctx: AuthContext,
    input: CommitProjectFilesInput,
    stagedOps: readonly PreparedFileOp[],
    uploads: ReadonlyMap<string, PreparedBlobUpload>,
    writeToken: string,
    scope: string,
    inputHash: string | null,
  ): Promise<CommitProjectFilesResult> {
    return this.db.transaction(async (tx) => {
      const project = await loadProjectOrThrow(tx, ctx.workspaceId, input.projectId, {
        allowTrashed: false,
        forUpdate: true,
        auth: ctx,
      });

      if (input.requestId && inputHash) {
        const replay = await readCommitReceipt(tx, ctx.workspaceId, scope, input.requestId, inputHash, true);
        if (replay) return replay;
      }

      const currentRevision = project.revision.trim();
      const currentVersionId = project.currentVersionId ?? null;

      // 2. Enforce project-level optimistic concurrency locks.
      if (input.expectedRevision !== undefined && currentRevision !== input.expectedRevision.trim()) {
        throw new CloudError(
          'VERSION_CONFLICT',
          'Project revision mismatch; reload the latest revision before retrying.',
          {
            status: 409,
            applied: false,
            details: {
              expectedRevision: input.expectedRevision,
              currentRevision,
              currentVersionId,
              currentVersionNumber: project.currentVersionNumber,
            },
          },
        );
      }

      if (input.expectedVersionId !== undefined && currentVersionId !== input.expectedVersionId) {
        throw new CloudError(
          'VERSION_CONFLICT',
          'Project versionId mismatch; reload the latest version before retrying.',
          {
            status: 409,
            applied: false,
            details: {
              expectedVersionId: input.expectedVersionId,
              currentRevision,
              currentVersionId,
              currentVersionNumber: project.currentVersionNumber,
            },
          },
        );
      }

      // 3. Load current live project_files rows.
      const existingRows = await tx
        .select()
        .from(projectFiles)
        .where(and(eq(projectFiles.workspaceId, ctx.workspaceId), eq(projectFiles.projectId, project.id)));

      const currentByPath = new Map<
        string,
        {
          path: string;
          blobScope: BlobScope;
          sha256: string;
          sizeBytes: number;
          mimeType: string;
          isText: boolean;
        }
      >();
      for (const row of existingRows) {
        currentByPath.set(row.path, {
          path: row.path,
          blobScope: row.blobScope,
          sha256: row.sha256.trim(),
          sizeBytes: Number(row.sizeBytes),
          mimeType: row.mimeType,
          isText: row.isText,
        });
      }

      // 4. Enforce per-file Studio ETag preconditions (`If-Match` / `If-None-Match`).
      if (input.filePreconditions) {
        for (const pre of input.filePreconditions) {
          const safePath = normalizeSafeProjectPath(pre.path);
          const existing = currentByPath.get(safePath);
          const currentVersion = existing ? formatFileVersion(existing.blobScope, existing.sha256) : null;

          if (pre.ifNoneMatch === '*') {
            if (existing) {
              throw new CloudError('VERSION_CONFLICT', `File "${safePath}" already exists.`, {
                status: 409,
                applied: false,
                details: {
                  code: 'VERSION_MISMATCH',
                  path: safePath,
                  currentVersion,
                  currentSha256: existing.sha256,
                  currentBlobScope: existing.blobScope,
                  currentIsText: existing.isText,
                },
              });
            }
          } else if (pre.ifMatch !== undefined) {
            const expectedTag = pre.ifMatch.trim();
            if (expectedTag !== '*' && currentVersion !== expectedTag) {
              throw new CloudError('VERSION_CONFLICT', `File "${safePath}" has changed since last read.`, {
                status: 409,
                applied: false,
                details: {
                  code: 'VERSION_MISMATCH',
                  path: safePath,
                  expectedVersion: expectedTag,
                  currentVersion,
                  currentSha256: existing?.sha256 ?? null,
                  currentBlobScope: existing?.blobScope ?? null,
                  currentIsText: existing?.isText ?? false,
                },
              });
            }
          }
        }
      }

      if (this.textPatchWrites) {
        for (const upload of uploads.values()) {
          if (upload.textContent !== undefined && upload.buffer.length <= MAX_TEXT_FILE_BYTES &&
              isUtf8(upload.buffer)) {
            await prepareFullBaseline(tx, {workspaceId: ctx.workspaceId, projectId: project.id,
              scope: 'workspace', id: upload.sha256, bytes: upload.buffer});
          }
        }
      }
      const preparedOps: readonly PreparedFileOp[] = input.textRevisions?.length
        ? [...stagedOps, ...await appendTextRevisions(tx, ctx.workspaceId, project.id, input.textRevisions)] : stagedOps;

      // 5. Compute next live file map and diff.
      const nextByPath = new Map(currentByPath);
      const changedPaths = new Set<string>();
      const deletedPaths = new Set<string>();
      const metadataBySha = new Map<string, BlobMetadata>();

      for (const upload of uploads.values()) {
        if (upload.metadata) metadataBySha.set(upload.sha256, upload.metadata);
      }

      for (const op of preparedOps) {
        if (op.op === 'delete') {
          if (nextByPath.has(op.path)) {
            nextByPath.delete(op.path);
            deletedPaths.add(op.path);
            changedPaths.delete(op.path);
          }
        } else {
          if (op.metadata) metadataBySha.set(op.sha256, op.metadata);
          const prev = nextByPath.get(op.path);
          const unchanged =
            prev &&
            prev.blobScope === op.blobScope &&
            prev.sha256 === op.sha256 &&
            prev.sizeBytes === op.sizeBytes &&
            prev.mimeType === op.mimeType &&
            prev.isText === op.isText;
          if (!unchanged) {
            nextByPath.set(op.path, {
              path: op.path,
              blobScope: op.blobScope,
              sha256: op.sha256,
              sizeBytes: op.sizeBytes,
              mimeType: op.mimeType,
              isText: op.isText,
            });
            changedPaths.add(op.path);
            deletedPaths.delete(op.path);
          }
        }
      }

      const hasFileChanges = changedPaths.size > 0 || deletedPaths.size > 0;
      const hasProjectUpdates = Boolean(input.projectUpdates && Object.keys(input.projectUpdates).length > 0);
      const shouldCreateVersion = !input.skipVersion && (hasFileChanges || Boolean(input.forceVersion));
      const now = this.nowFn();
      const actor = actorDefaults(ctx, input.actorKind, input.actorName);
      // A completed semantic command is a distinct undo step, including against a subsequent raw save.
      const safeWindowId = !input.commandReceipt && input.windowId && isUuid(input.windowId) ? input.windowId : null;
      const effectiveSource: ProjectVersionSource = input.source ?? 'studio';
      const summary = (
        input.summary?.trim() ||
        buildAutoSummary([...changedPaths], [...deletedPaths])
      ).slice(0, 256);

      // 5b. High-frequency Studio edit-window coalescing check (c2):
      // Coalesce rapid interactive Studio edits into the unpinned, non-export-referenced head version
      // using delta project_version_files upserts/deletes instead of duplicating all N project files.
      let coalesceTarget: {
        versionId: string;
        historyEntryId: string;
        touchedVersionFiles: Map<string, { blobScope: BlobScope; sha256: string }>;
      } | null = null;

      const isInteractiveStudioEdit = !this.textPatchWrites &&
        effectiveSource === 'studio' &&
        (input.origin === undefined || input.origin === 'studio') &&
        input.actorKind !== 'agent' &&
        input.actorKind !== 'system' &&
        !input.forceVersion && !input.commandReceipt;

      if (
        shouldCreateVersion &&
        hasFileChanges &&
        safeWindowId !== null &&
        this.historyCoalesceWindowMs > 0 &&
        isInteractiveStudioEdit &&
        currentVersionId !== null &&
        project.currentHistorySeq > 0
      ) {
        const headVersionRows = await tx
          .select()
          .from(projectVersions)
          .where(
            and(
              eq(projectVersions.workspaceId, ctx.workspaceId),
              eq(projectVersions.projectId, project.id),
              eq(projectVersions.id, currentVersionId),
            ),
          )
          .limit(1);
        const headEntryRows = await tx
          .select()
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
              eq(projectHistoryEntries.seq, project.currentHistorySeq),
            ),
          )
          .limit(1);
        const maxSeqRows = await tx
          .select({ maxSeq: sql<number>`COALESCE(MAX(${projectHistoryEntries.seq}), 0)` })
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
            ),
          );

        const headVersion = headVersionRows[0];
        const headEntry = headEntryRows[0];
        const maxHistorySeq = Number(maxSeqRows[0]?.maxSeq ?? 0);

        if (
          headVersion &&
          headEntry &&
          headEntry.versionId === currentVersionId &&
          !headVersion.pinned &&
          !headEntry.pinned &&
          !headEntry.undone &&
          headVersion.source === 'studio' &&
          headVersion.revision.trim() === currentRevision &&
          project.currentHistorySeq === maxHistorySeq &&
          headEntry.actorKind === actor.actorKind &&
          headEntry.actorName === actor.actorName &&
          headEntry.windowId === safeWindowId
        ) {
          const headReferenceMs = Math.min(headEntry.startedAt.getTime(), headEntry.endedAt.getTime());
          const elapsedMs = now.getTime() - headReferenceMs;
          if (elapsedMs >= 0 && elapsedMs <= this.historyCoalesceWindowMs) {
            // Guarantee frozen export / worker snapshots are strictly immutable:
            // never mutate a version referenced by any `jobs` row (`version_id` or `input_payload.versionId`).
            const projectJobs = await tx
              .select({
                id: jobs.id,
                versionId: jobs.versionId,
                inputPayload: jobs.inputPayload,
              })
              .from(jobs)
              .where(and(eq(jobs.workspaceId, ctx.workspaceId), eq(jobs.projectId, project.id)));

            const referencedByJob = projectJobs.some((job) => {
              if (job.versionId === currentVersionId) return true;
              const payload = job.inputPayload as Record<string, unknown> | null | undefined;
              return typeof payload?.versionId === 'string' && payload.versionId === currentVersionId;
            });

            if (!referencedByJob) {
              const touchedPaths = [...new Set([...changedPaths, ...deletedPaths])];
              const existingVerFiles =
                touchedPaths.length > 0
                  ? await tx
                      .select({
                        path: projectVersionFiles.path,
                        blobScope: projectVersionFiles.blobScope,
                        sha256: projectVersionFiles.sha256,
                      })
                      .from(projectVersionFiles)
                      .where(
                        and(
                          eq(projectVersionFiles.workspaceId, ctx.workspaceId),
                          eq(projectVersionFiles.versionId, currentVersionId),
                          inArray(projectVersionFiles.path, touchedPaths),
                        ),
                      )
                  : [];

              const touchedVersionFiles = new Map<string, { blobScope: BlobScope; sha256: string }>();
              for (const row of existingVerFiles) {
                touchedVersionFiles.set(row.path, {
                  blobScope: row.blobScope,
                  sha256: row.sha256.trim(),
                });
              }

              coalesceTarget = {
                versionId: currentVersionId,
                historyEntryId: headEntry.id,
                touchedVersionFiles,
              };
            }
          }
        }
      }

      // 6. Compute net workspace CAS blob refcount deltas across live project_files + version snapshot (or coalesced delta).
      const deltas: BlobRefDelta[] = [];

      if (hasFileChanges) {
        for (const filePath of deletedPaths) {
          const oldFile = currentByPath.get(filePath);
          if (oldFile && oldFile.blobScope === 'workspace') {
            deltas.push({ sha256: oldFile.sha256, delta: -1 });
          }
        }
        for (const filePath of changedPaths) {
          const oldFile = currentByPath.get(filePath);
          if (oldFile && oldFile.blobScope === 'workspace') {
            deltas.push({ sha256: oldFile.sha256, delta: -1 });
          }
          const newFile = nextByPath.get(filePath);
          if (newFile && newFile.blobScope === 'workspace') {
            deltas.push({
              sha256: newFile.sha256,
              delta: 1,
              sizeBytes: newFile.sizeBytes,
              mimeType: newFile.mimeType,
              s3Key: workspaceBlobKey(ctx.workspaceId, newFile.sha256),
              metadata: metadataBySha.get(newFile.sha256),
            });
          }
        }
      }

      if (shouldCreateVersion) {
        if (coalesceTarget) {
          for (const filePath of deletedPaths) {
            const oldVer = coalesceTarget.touchedVersionFiles.get(filePath);
            if (oldVer && oldVer.blobScope === 'workspace') {
              deltas.push({ sha256: oldVer.sha256, delta: -1 });
            }
          }
          for (const filePath of changedPaths) {
            const oldVer = coalesceTarget.touchedVersionFiles.get(filePath);
            if (oldVer && oldVer.blobScope === 'workspace') {
              deltas.push({ sha256: oldVer.sha256, delta: -1 });
            }
            const newFile = nextByPath.get(filePath);
            if (newFile && newFile.blobScope === 'workspace') {
              deltas.push({
                sha256: newFile.sha256,
                delta: 1,
                sizeBytes: newFile.sizeBytes,
                mimeType: newFile.mimeType,
                s3Key: workspaceBlobKey(ctx.workspaceId, newFile.sha256),
                metadata: metadataBySha.get(newFile.sha256),
              });
            }
          }
        } else {
          for (const newFile of nextByPath.values()) {
            if (newFile.blobScope === 'workspace') {
              deltas.push({
                sha256: newFile.sha256,
                delta: 1,
                sizeBytes: newFile.sizeBytes,
                mimeType: newFile.mimeType,
                s3Key: workspaceBlobKey(ctx.workspaceId, newFile.sha256),
                metadata: metadataBySha.get(newFile.sha256),
              });
            }
          }
        }
      }

      if (deltas.length > 0) {
        await applyWorkspaceBlobRefDeltas(tx, ctx.workspaceId, deltas);
      }

      // 7. Persist live project_files diff.
      if (deletedPaths.size > 0) {
        await tx
          .delete(projectFiles)
          .where(
            and(
              eq(projectFiles.workspaceId, ctx.workspaceId),
              eq(projectFiles.projectId, project.id),
              inArray(projectFiles.path, [...deletedPaths]),
            ),
          );
      }

      for (const filePath of changedPaths) {
        const entry = nextByPath.get(filePath);
        if (!entry) continue;
        await tx
          .insert(projectFiles)
          .values(
            asInsert(projectFiles, {
              workspaceId: ctx.workspaceId,
              projectId: project.id,
              path: entry.path,
              blobScope: entry.blobScope,
              sha256: entry.sha256,
              sizeBytes: entry.sizeBytes,
              mimeType: entry.mimeType,
              isText: entry.isText,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [projectFiles.projectId, projectFiles.path],
            set: asUpdate(projectFiles, {
              blobScope: entry.blobScope,
              sha256: entry.sha256,
              sizeBytes: entry.sizeBytes,
              mimeType: entry.mimeType,
              isText: entry.isText,
              updatedAt: now,
            }),
          });
      }

      // 8. Recompute canonical revision matching WorkspaceStore.revision().
      const nextRevision = computeProjectRevision(
        [...nextByPath.values()].map((f) => ({
          path: f.path,
          size: f.sizeBytes,
          hash: f.sha256,
        })),
      );

      let nextVersionId = currentVersionId;
      let nextVersionNumber = project.currentVersionNumber;
      let nextHistorySeq = project.currentHistorySeq;
      let coalesced = false;

      // 9. Coalesce in-place (delta only) OR append brand-new immutable snapshot.
      if (shouldCreateVersion && coalesceTarget) {
        if (deletedPaths.size > 0) {
          await tx
            .delete(projectVersionFiles)
            .where(
              and(
                eq(projectVersionFiles.workspaceId, ctx.workspaceId),
                eq(projectVersionFiles.versionId, coalesceTarget.versionId),
                inArray(projectVersionFiles.path, [...deletedPaths]),
              ),
            );
        }

        for (const filePath of changedPaths) {
          const entry = nextByPath.get(filePath);
          if (!entry) continue;
          await tx
            .insert(projectVersionFiles)
            .values(
              asInsert(projectVersionFiles, {
                versionId: coalesceTarget.versionId,
                workspaceId: ctx.workspaceId,
                projectId: project.id,
                path: entry.path,
                blobScope: entry.blobScope,
                sha256: entry.sha256,
                sizeBytes: entry.sizeBytes,
                mimeType: entry.mimeType,
              }),
            )
            .onConflictDoUpdate({
              target: [projectVersionFiles.versionId, projectVersionFiles.path],
              set: asUpdate(projectVersionFiles, {
                blobScope: entry.blobScope,
                sha256: entry.sha256,
                sizeBytes: entry.sizeBytes,
                mimeType: entry.mimeType,
              }),
            });
        }

        await tx
          .update(projectVersions)
          .set(
            asUpdate(projectVersions, {
              revision: nextRevision,
              summary,
              createdAt: now,
            }),
          )
          .where(
            and(
              eq(projectVersions.workspaceId, ctx.workspaceId),
              eq(projectVersions.projectId, project.id),
              eq(projectVersions.id, coalesceTarget.versionId),
            ),
          );

        await tx
          .update(projectHistoryEntries)
          .set(
            asUpdate(projectHistoryEntries, {
              label: summary,
              endedAt: now,
              ...(safeWindowId ? { windowId: safeWindowId } : {}),
            }),
          )
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
              eq(projectHistoryEntries.id, coalesceTarget.historyEntryId),
            ),
          );

        nextVersionId = coalesceTarget.versionId;
        coalesced = true;
      } else if (shouldCreateVersion) {
        const maxVerRow = await tx
          .select({ maxVer: sql<number>`COALESCE(MAX(${projectVersions.versionNumber}), 0)` })
          .from(projectVersions)
          .where(
            and(
              eq(projectVersions.workspaceId, ctx.workspaceId),
              eq(projectVersions.projectId, project.id),
            ),
          );
        nextVersionNumber = Math.max(project.currentVersionNumber, Number(maxVerRow[0]?.maxVer ?? 0)) + 1;

        const maxSeqRow = await tx
          .select({ maxSeq: sql<number>`COALESCE(MAX(${projectHistoryEntries.seq}), 0)` })
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
            ),
          );
        const maxSeq = Number(maxSeqRow[0]?.maxSeq ?? project.currentHistorySeq);
        const parentRows =
          project.currentHistorySeq > 0
            ? await tx
                .select({ id: projectHistoryEntries.id, versionId: projectHistoryEntries.versionId, undoGroup: projectHistoryEntries.undoGroup,
                  pinned: projectHistoryEntries.pinned, undone: projectHistoryEntries.undone })
                .from(projectHistoryEntries)
                .where(
                  and(
                    eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
                    eq(projectHistoryEntries.projectId, project.id),
                    eq(projectHistoryEntries.seq, project.currentHistorySeq),
                  ),
                )
            : [];
        const parent = parentRows[0];
        const continueGesture = Boolean(input.undoGroup && parent?.undoGroup === input.undoGroup &&
          !parent.pinned && !parent.undone && parent.versionId === currentVersionId && maxSeq === project.currentHistorySeq);
        nextHistorySeq = continueGesture ? project.currentHistorySeq : Math.max(project.currentHistorySeq, maxSeq) + 1;

        const insertedVersions = await tx
          .insert(projectVersions)
          .values(
            asInsert(projectVersions, {
              workspaceId: ctx.workspaceId,
              projectId: project.id,
              versionNumber: nextVersionNumber,
              revision: nextRevision,
              source: effectiveSource,
              summary,
              requestId: input.requestId ?? null,
              pinned: false,
              createdAt: now,
            }),
          )
          .returning({ id: projectVersions.id });
        const createdVersion = insertedVersions[0];
        if (!createdVersion) {
          throw new CloudError('STORAGE_ERROR', 'Failed to insert project version row.', { status: 500 });
        }
        nextVersionId = createdVersion.id;

        const snapshotValues = [...nextByPath.values()].map((f) =>
          asInsert(projectVersionFiles, {
            versionId: createdVersion.id,
            workspaceId: ctx.workspaceId,
            projectId: project.id,
            path: f.path,
            blobScope: f.blobScope,
            sha256: f.sha256,
            sizeBytes: f.sizeBytes,
            mimeType: f.mimeType,
          }),
        );
        if (snapshotValues.length > 0) {
          await tx.insert(projectVersionFiles).values(snapshotValues);
        }

        if (continueGesture) {
          await tx.update(projectHistoryEntries).set(asUpdate(projectHistoryEntries, {
            versionId: createdVersion.id, endedAt: now,
          })).where(eq(projectHistoryEntries.id, parent.id));
          coalesced = true;
        } else {
          // Only the project undo stack changes here. Immutable version snapshots remain readable.
          if (maxSeq > project.currentHistorySeq) {
            await tx.delete(projectHistoryEntries).where(and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
              eq(projectHistoryEntries.undone, true),
              gt(projectHistoryEntries.seq, project.currentHistorySeq),
            ));
          }
          await tx.insert(projectHistoryEntries).values(asInsert(projectHistoryEntries, {
            workspaceId: ctx.workspaceId,
            projectId: project.id,
            seq: nextHistorySeq,
            versionId: createdVersion.id,
            parentEntryId: parent?.id ?? null,
            actorKind: actor.actorKind,
            actorName: actor.actorName,
            label: summary,
            windowId: safeWindowId,
            undoGroup: input.undoGroup ?? null,
            pinned: false,
            undone: false,
            startedAt: now,
            endedAt: now,
          }));
        }
      }

      // 10. Update project header row.
      if (hasFileChanges || shouldCreateVersion || hasProjectUpdates) {
        await tx
          .update(projects)
          .set(
            asUpdate(projects, {
              revision: nextRevision,
              currentVersionId: nextVersionId,
              currentVersionNumber: nextVersionNumber,
              currentHistorySeq: nextHistorySeq,
              ...(input.projectUpdates?.namingLanguage !== undefined
                ? { namingLanguage: input.projectUpdates.namingLanguage }
                : {}),
              ...(input.projectUpdates?.requirements !== undefined
                ? { requirements: input.projectUpdates.requirements }
                : {}),
              ...(input.projectUpdates?.title !== undefined ? { title: input.projectUpdates.title } : {}),
              updatedAt: now,
            }),
          )
          .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));
      }

      const sortedChanged = [...changedPaths].sort((a, b) => a.localeCompare(b));
      const sortedDeleted = [...deletedPaths].sort((a, b) => a.localeCompare(b));
      const impact = computePreviewImpact([...sortedChanged, ...sortedDeleted]);

      const versionsByPath: Record<string, string> = {};
      // Return the verified versions of unchanged command inputs too. A rebased
      // no-op must acknowledge the current file, including on receipt replay.
      const versionPaths = input.commandReceipt
        ? new Set([...sortedChanged, ...(input.filePreconditions ?? []).map(pre => pre.path)])
        : sortedChanged;
      for (const filePath of versionPaths) {
        const entry = nextByPath.get(filePath);
        if (entry) {
          versionsByPath[filePath] = formatFileVersion(entry.blobScope, entry.sha256);
        }
      }

      const commitResult: CommitProjectFilesResult = {
        ...(input.orderedEvents && { previousRevision: project.revision.trim() }),
        projectId: project.id,
        revision: nextRevision,
        versionId: nextVersionId,
        versionNumber: nextVersionNumber,
        historySeq: nextHistorySeq,
        changedPaths: sortedChanged,
        deletedPaths: sortedDeleted,
        versionsByPath,
        writeToken,
        affectsPreview: impact.affectsPreview,
        // The Studio file tree lists compositions by path. Editing existing HTML only changes its content.
        fileTreeChanged: sortedDeleted.length > 0 ||
          sortedChanged.some(path => !currentByPath.has(path) || !/\.html?$/i.test(path)),
        affectedCompositions: impact.affectedCompositions,
        replayed: false,
        ...(input.commandReceipt && { commandResult: input.commandReceipt.result }),
        coalesced,
      };

      // 11. Persist idempotency receipt on commit.
      if (input.requestId && inputHash) {
        await tx
          .insert(idempotencyReceipts)
          .values(
            asInsert(idempotencyReceipts, {
              workspaceId: ctx.workspaceId,
              scope,
              requestId: input.requestId,
              inputHash,
              state: 'completed',
              resourceId: nextVersionId,
              responsePayload: commitResult as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
            set: asUpdate(idempotencyReceipts, {
              state: 'completed',
              resourceId: nextVersionId,
              responsePayload: commitResult as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          });
      }

      return commitResult;
    });
  }
}

function buildAutoSummary(changedPaths: readonly string[], deletedPaths: readonly string[]): string {
  const total = changedPaths.length + deletedPaths.length;
  if (total === 0) return 'Checkpoint';
  if (changedPaths.length === 1 && deletedPaths.length === 0) {
    return `Edited ${changedPaths[0]}`;
  }
  if (deletedPaths.length === 1 && changedPaths.length === 0) {
    return `Deleted ${deletedPaths[0]}`;
  }
  return `Updated ${total} file${total === 1 ? '' : 's'}`;
}
