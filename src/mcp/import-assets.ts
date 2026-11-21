import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { brandWebsite } from '../../gateway/brand-network.ts';
import { isPublicAddress } from '../../gateway/network.ts';
import { MAX_ASSET_BYTES } from '../../shared/asset-limits.ts';
import {
  MAX_FONT_LICENSE_BYTES,
  type CloudImportAssetItem,
  type ImportAssetsCloudInput,
  type PrepareUploadInput,
  type PrepareUploadResult,
  type PrepareUploadTicketResult,
} from '../../shared/phase1-tools.ts';
import {
  computeProjectRevision,
  isSha256Hex,
  isUuid,
  projectPath,
  validateStableRequestId,
  type SourceFile,
} from '../../shared/project-validation.ts';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { ProjectEvent } from '../contracts/events.ts';
import type { StoragePort } from '../contracts/storage.ts';
import { applyWorkspaceBlobRefDeltas, type BlobRefDelta } from '../db/cas.ts';
import type { Database } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import {
  assetVersions,
  assets,
  uploadTickets,
  workspaceBlobs,
  type UploadTicketState,
} from '../db/schema/blobs-assets.ts';
import { idempotencyReceipts, jobs } from '../db/schema/jobs.ts';
import {
  projectFiles,
  projectVersionFiles,
  projectVersions,
} from '../db/schema/project-files.ts';
import { projects } from '../db/schema/projects.ts';
import type { AppConfig } from '../infra/config.ts';
import type { QueueService } from '../infra/queues.ts';
import { projectChannel, type RedisEventBus } from '../infra/redis.ts';
import { uploadLicenseStagingKey, uploadStagingKey } from '../infra/storage.ts';

// ---------------------------------------------------------------------------
// Hardened SSRF Pre-Validation (Public HTTPS URLs Only)
// ---------------------------------------------------------------------------

/**
 * Hardened public IP check extending `gateway/network.ts` with TEST-NET-2 (198.51.100.0/24),
 * TEST-NET-3 (203.0.113.0/24), and 6to4 relay (192.88.99.0/24) rejections per Spike 2 §1.1.
 */
export function isHardenedPublicAddress(address: string): boolean {
  if (!isPublicAddress(address)) return false;
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
    if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  }
  return true;
}

export interface UrlValidationOptions {
  resolveDns?: boolean;
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export async function validatePublicImportUrl(
  rawUrl: unknown,
  options: UrlValidationOptions = {},
): Promise<string> {
  if (typeof rawUrl !== 'string' || !rawUrl.trim().startsWith('https://')) {
    throw new CloudError('SSRF_BLOCKED', 'Import URL must be a public https:// URL', {
      status: 400,
      applied: false,
    });
  }

  let normalized: string;
  try {
    normalized = brandWebsite(rawUrl);
  } catch (error) {
    throw new CloudError(
      'SSRF_BLOCKED',
      error instanceof Error ? error.message : 'URL points to a disallowed or non-public destination',
      { status: 400, applied: false },
    );
  }

  const parsed = new URL(normalized);
  const rawHostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const hostname = rawHostname.replace(/\.+$/, '').toLowerCase();
  if (!hostname) {
    throw new CloudError('SSRF_BLOCKED', 'Import URL must include a valid public host', {
      status: 400,
      applied: false,
    });
  }
  if (isIP(hostname)) {
    if (!isHardenedPublicAddress(hostname)) {
      throw new CloudError('SSRF_BLOCKED', 'Import URL points to a private or reserved IP address', {
        status: 400,
        applied: false,
      });
    }
  } else if (
    hostname === 'localhost' ||
    /\.(?:localhost|local|internal|home\.arpa)$/.test(hostname) ||
    !hostname.includes('.')
  ) {
    throw new CloudError('SSRF_BLOCKED', 'Import URL points to a local or internal hostname', {
      status: 400,
      applied: false,
    });
  }

  if (options.resolveDns) {
    const dnsLookup = options.dnsLookup ?? ((name: string) => lookup(name, { all: true }));
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await dnsLookup(hostname);
    } catch {
      throw new CloudError('SSRF_BLOCKED', 'Could not resolve public DNS for import URL', {
        status: 400,
        applied: false,
      });
    }
    if (
      addresses.length === 0 ||
      addresses.some((entry) => !isHardenedPublicAddress(entry.address))
    ) {
      throw new CloudError('SSRF_BLOCKED', 'Import URL resolves to a private or reserved address', {
        status: 400,
        applied: false,
      });
    }
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Store Port & PG Implementation
// ---------------------------------------------------------------------------

export interface UploadTicketRecord {
  id: string;
  workspaceId: string;
  userId: string | null;
  targetProjectId: string | null;
  targetPath: string | null;
  filename: string;
  expectedMimeType: string | null;
  expectedSha256: string | null;
  maxBytes: number;
  s3StagingKey: string;
  licenseS3StagingKey: string | null;
  licenseFilename: string | null;
  licenseMaxBytes: number | null;
  state: UploadTicketState;
  expiresAt: Date;
}

export interface LibraryAssetZeroCopyResult {
  assetId: string;
  versionId: string;
  path: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  projectRevision: string;
  projectVersionId: string;
  projectVersionNumber: number;
}

export interface ImportAssetsStore {
  assertActiveProject(workspaceId: string, projectId: string): Promise<{ id: string }>;
  findReceipt(
    workspaceId: string,
    scope: string,
    requestId: string,
  ): Promise<{ inputHash: string; state: string; responsePayload: Record<string, unknown> | null } | null>;
  saveCompletedReceipt(input: {
    workspaceId: string;
    scope: string;
    requestId: string;
    inputHash: string;
    resourceId?: string;
    responsePayload: Record<string, unknown>;
  }): Promise<void>;
  insertUploadTicket(input: {
    id: string;
    workspaceId: string;
    userId: string;
    targetProjectId: string;
    targetPath: string;
    filename: string;
    expectedMimeType: string;
    expectedSha256: string | null;
    maxBytes: number;
    s3StagingKey: string;
    licenseS3StagingKey: string | null;
    licenseFilename: string | null;
    licenseMaxBytes: number | null;
    requestId: string;
    expiresAt: Date;
  }): Promise<UploadTicketRecord>;
  findUploadTicket(workspaceId: string, ticketId: string): Promise<UploadTicketRecord | null>;
  markUploadTicketProcessing(workspaceId: string, ticketId: string): Promise<boolean>;
  revertUploadTicketProcessing(
    workspaceId: string,
    ticketId: string,
    previousState: 'issued' | 'uploaded',
  ): Promise<void>;
  createMediaIngestJob(input: {
    id: string;
    workspaceId: string;
    projectId: string;
    requestId: string;
    inputPayload: Record<string, unknown>;
  }): Promise<void>;
  markMediaIngestJobFailed(
    workspaceId: string,
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
  commitLibraryAssetZeroCopy(input: {
    workspaceId: string;
    projectId: string;
    assetId: string;
    versionId: string;
    name?: string;
    requestId: string;
  }): Promise<LibraryAssetZeroCopyResult>;
}

function sanitizeFilename(raw: string): string {
  const base = path.posix.basename(raw.replaceAll('\\', '/')).trim();
  if (!base || base === '.' || base === '..' || /[\x00-\x1f]/.test(base) || base.length > 256) {
    throw new CloudError('INVALID_ARGUMENT', `Invalid filename: ${raw}`, {
      status: 400,
      applied: false,
    });
  }
  return base;
}

const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['.woff2', '.woff', '.ttf', '.otf', '.ttc']);

function extensionFromMimeOrFilename(filename: string, mimeType: string): string {
  const fromFile = path.posix.extname(filename).toLowerCase().replace(/^\./, '');
  if (/^[a-z0-9]{1,8}$/.test(fromFile)) return fromFile;
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'font/woff2': 'woff2',
    'font/woff': 'woff',
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    'font/collection': 'ttc',
    'application/font-woff': 'woff',
    'application/font-woff2': 'woff2',
    'application/x-font-ttf': 'ttf',
    'application/x-font-otf': 'otf',
  };
  return map[mimeType.toLowerCase()] ?? 'bin';
}

function sanitizeFontBasename(filename: string, fallbackId: string, ext: string): string {
  const rawBase = path.posix.basename(filename.replaceAll('\\', '/')).trim();
  const rawExt = path.posix.extname(rawBase);
  const rawStem = rawExt ? rawBase.slice(0, -rawExt.length) : rawBase;
  const cleanedStem = rawStem
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+/g, '-')
    .replace(/-+$/, '')
    .slice(0, 120);
  const safeStem = cleanedStem || fallbackId;
  return `${safeStem}.${ext}`;
}

/**
 * Compute a deterministic, `projectPath(...)`-validated target path inside a project:
 * - Font files (`.woff2`/`.woff`/`.ttf`/`.otf`/`.ttc` or `font/*` MIME) -> `fonts/<safe>`
 * - All other media assets -> `assets/imported/<ticketId-or-jobId>.<ext>`
 */
export function resolveProjectAssetTargetPath(
  id: string,
  filename: string,
  mimeType = '',
): string {
  const extFromName = path.posix.extname(filename).toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  const isFont =
    FONT_EXTENSIONS.has(extFromName) ||
    lowerMime.startsWith('font/') ||
    lowerMime === 'application/font-woff' ||
    lowerMime === 'application/font-woff2' ||
    lowerMime === 'application/x-font-ttf' ||
    lowerMime === 'application/x-font-otf';

  if (isFont) {
    const ext = extensionFromMimeOrFilename(filename, mimeType);
    const safeExt = FONT_EXTENSIONS.has(`.${ext}`) ? ext : 'woff2';
    return projectPath(`fonts/${sanitizeFontBasename(filename, id, safeExt)}`);
  }

  const ext = extensionFromMimeOrFilename(filename, mimeType);
  return projectPath(`assets/imported/${id}.${ext}`);
}

export function createPgImportAssetsStore(db: Database): ImportAssetsStore {
  return {
    async assertActiveProject(workspaceId, projectId) {
      const [project] = await db
        .select({ id: projects.id, trashed: projects.trashed })
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
        .limit(1);
      if (!project) {
        throw new CloudError('PROJECT_NOT_FOUND', `Project ${projectId} not found`, {
          status: 404,
          applied: false,
        });
      }
      if (project.trashed) {
        throw new CloudError('PROJECT_TRASHED', 'Cannot import assets into a trashed project', {
          status: 400,
          applied: false,
        });
      }
      return { id: project.id };
    },

    async findReceipt(workspaceId, scope, requestId) {
      const [row] = await db
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
      if (!row) return null;
      return {
        inputHash: row.inputHash,
        state: row.state,
        responsePayload: row.responsePayload,
      };
    },

    async saveCompletedReceipt(input) {
      await db
        .insert(idempotencyReceipts)
        .values(
          asInsert(idempotencyReceipts, {
            workspaceId: input.workspaceId,
            scope: input.scope,
            requestId: input.requestId,
            inputHash: input.inputHash,
            state: 'completed',
            resourceId: input.resourceId ?? null,
            responsePayload: input.responsePayload,
          }),
        )
        .onConflictDoUpdate({
          target: [
            idempotencyReceipts.workspaceId,
            idempotencyReceipts.scope,
            idempotencyReceipts.requestId,
          ],
          set: asUpdate(idempotencyReceipts, {
            state: 'completed',
            responsePayload: input.responsePayload,
            updatedAt: sql`now()`,
          }),
        });
    },

    async insertUploadTicket(input) {
      const [row] = await db
        .insert(uploadTickets)
        .values(
          asInsert(uploadTickets, {
            id: input.id,
            workspaceId: input.workspaceId,
            userId: input.userId,
            purpose: 'project_asset',
            targetProjectId: input.targetProjectId,
            targetPath: input.targetPath,
            filename: input.filename,
            expectedMimeType: input.expectedMimeType,
            expectedSha256: input.expectedSha256,
            maxBytes: input.maxBytes,
            s3StagingKey: input.s3StagingKey,
            licenseS3StagingKey: input.licenseS3StagingKey,
            licenseFilename: input.licenseFilename,
            licenseMaxBytes: input.licenseMaxBytes,
            state: 'issued',
            requestId: input.requestId,
            resultPayload: { source: 'mcp_upload' },
            expiresAt: input.expiresAt,
          }),
        )
        .returning();
      return row;
    },

    async findUploadTicket(workspaceId, ticketId) {
      const [row] = await db
        .select()
        .from(uploadTickets)
        .where(and(eq(uploadTickets.workspaceId, workspaceId), eq(uploadTickets.id, ticketId)))
        .limit(1);
      return row ?? null;
    },

    async markUploadTicketProcessing(workspaceId, ticketId) {
      const rows = await db
        .update(uploadTickets)
        .set(asUpdate(uploadTickets, { state: 'processing', updatedAt: sql`now()` }))
        .where(
          and(
            eq(uploadTickets.workspaceId, workspaceId),
            eq(uploadTickets.id, ticketId),
            sql`${uploadTickets.state} IN ('issued', 'uploaded')`,
          ),
        )
        .returning({ id: uploadTickets.id });
      return rows.length > 0;
    },

    async revertUploadTicketProcessing(workspaceId, ticketId, previousState) {
      await db
        .update(uploadTickets)
        .set(asUpdate(uploadTickets, { state: previousState, updatedAt: sql`now()` }))
        .where(
          and(
            eq(uploadTickets.workspaceId, workspaceId),
            eq(uploadTickets.id, ticketId),
            eq(uploadTickets.state, 'processing'),
          ),
        );
    },

    async createMediaIngestJob(input) {
      await db.insert(jobs).values(
        asInsert(jobs, {
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          kind: 'media_ingest',
          state: 'queued',
          stage: 'queued',
          requestId: input.requestId,
          inputPayload: input.inputPayload,
        }),
      );
    },

    async markMediaIngestJobFailed(workspaceId, jobId, errorCode, errorMessage) {
      await db
        .update(jobs)
        .set(
          asUpdate(jobs, {
            state: 'failed',
            stage: 'failed',
            failureStage: 'enqueue',
            errorCode: errorCode.slice(0, 128),
            errorMessage: errorMessage.slice(0, 1000),
            terminalAt: sql`now()`,
            updatedAt: sql`now()`,
          }),
        )
        .where(
          and(
            eq(jobs.workspaceId, workspaceId),
            eq(jobs.id, jobId),
            eq(jobs.state, 'queued'),
          ),
        );
    },

    async commitLibraryAssetZeroCopy(input) {
      return db.transaction(async (tx) => {
        // Lock target project row inside workspace boundary.
        const [project] = await tx
          .select()
          .from(projects)
          .where(and(eq(projects.workspaceId, input.workspaceId), eq(projects.id, input.projectId)))
          .for('update')
          .limit(1);

        if (!project) {
          throw new CloudError('PROJECT_NOT_FOUND', `Project ${input.projectId} not found`, {
            status: 404,
            applied: false,
          });
        }
        if (project.trashed) {
          throw new CloudError('PROJECT_TRASHED', 'Cannot import assets into a trashed project', {
            status: 400,
            applied: false,
          });
        }

        const [asset] = await tx
          .select()
          .from(assets)
          .where(and(eq(assets.workspaceId, input.workspaceId), eq(assets.id, input.assetId)))
          .limit(1);
        if (!asset || asset.trashed) {
          throw new CloudError('ASSET_NOT_FOUND', `Library asset ${input.assetId} not found`, {
            status: 404,
            applied: false,
          });
        }

        const [version] = await tx
          .select()
          .from(assetVersions)
          .where(
            and(
              eq(assetVersions.workspaceId, input.workspaceId),
              eq(assetVersions.assetId, input.assetId),
              eq(assetVersions.id, input.versionId),
            ),
          )
          .limit(1);
        if (!version) {
          throw new CloudError(
            'ASSET_VERSION_UNAVAILABLE',
            `Asset version ${input.versionId} not found for asset ${input.assetId}`,
            { status: 404, applied: false },
          );
        }

        const [blob] = await tx
          .select()
          .from(workspaceBlobs)
          .where(
            and(
              eq(workspaceBlobs.workspaceId, input.workspaceId),
              eq(workspaceBlobs.sha256, version.sha256),
            ),
          )
          .limit(1);
        if (!blob || blob.gcState !== 'active') {
          throw new CloudError(
            'ASSET_VERSION_UNAVAILABLE',
            'Referenced asset blob is unavailable in workspace CAS storage',
            { status: 404, applied: false },
          );
        }

        const ext = extensionFromMimeOrFilename(version.filename, version.mimeType);
        const targetPath = projectPath(`assets/imported/${asset.id}.${ext}`);

        const existingFiles = await tx
          .select()
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.workspaceId, input.workspaceId),
              eq(projectFiles.projectId, input.projectId),
            ),
          );

        const replaced = existingFiles.find((f) => f.path === targetPath);

        await tx
          .insert(projectFiles)
          .values(
            asInsert(projectFiles, {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              path: targetPath,
              blobScope: 'workspace',
              sha256: version.sha256,
              sizeBytes: version.sizeBytes,
              mimeType: version.mimeType,
              isText: false,
            }),
          )
          .onConflictDoUpdate({
            target: [projectFiles.projectId, projectFiles.path],
            set: asUpdate(projectFiles, {
              blobScope: 'workspace',
              sha256: version.sha256,
              sizeBytes: version.sizeBytes,
              mimeType: version.mimeType,
              isText: false,
              updatedAt: sql`now()`,
            }),
          });

        const nextFiles = [
          ...existingFiles.filter((f) => f.path !== targetPath),
          {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            path: targetPath,
            blobScope: 'workspace' as const,
            sha256: version.sha256,
            sizeBytes: version.sizeBytes,
            mimeType: version.mimeType,
            isText: false,
          },
        ];

        const sourceFiles: SourceFile[] = nextFiles.map((f) => ({
          path: f.path,
          size: f.sizeBytes,
          hash: f.sha256,
        }));
        const nextRevision = computeProjectRevision(sourceFiles);
        const nextVersionNumber = project.currentVersionNumber + 1;

        const [newVersion] = await tx
          .insert(projectVersions)
          .values(
            asInsert(projectVersions, {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              versionNumber: nextVersionNumber,
              revision: nextRevision,
              source: 'agent',
              summary: `Import library asset ${input.name || asset.name}`.slice(0, 256),
              requestId: `${input.requestId}:${asset.id}`.slice(0, 128),
            }),
          )
          .returning();

        for (const file of nextFiles) {
          await tx.insert(projectVersionFiles).values(
            asInsert(projectVersionFiles, {
              versionId: newVersion.id,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              path: file.path,
              blobScope: file.blobScope,
              sha256: file.sha256,
              sizeBytes: file.sizeBytes,
              mimeType: file.mimeType,
            }),
          );
        }

        // Exact CAS refcount accounting in sorted sha256 order:
        // - Live project_files: +1 for newly linked asset, -1 if an old workspace blob was replaced.
        // - New project_version_files snapshot: +1 for every workspace-scoped file in the snapshot.
        const deltas: BlobRefDelta[] = [
          {
            sha256: version.sha256,
            delta: 1,
            sizeBytes: version.sizeBytes,
            mimeType: version.mimeType,
          },
        ];
        if (replaced && replaced.blobScope === 'workspace') {
          deltas.push({ sha256: replaced.sha256, delta: -1 });
        }
        for (const file of nextFiles) {
          if (file.blobScope === 'workspace') {
            deltas.push({
              sha256: file.sha256,
              delta: 1,
              sizeBytes: file.sizeBytes,
              mimeType: file.mimeType,
            });
          }
        }
        await applyWorkspaceBlobRefDeltas(tx, input.workspaceId, deltas);

        await tx
          .update(projects)
          .set(
            asUpdate(projects, {
              revision: nextRevision,
              currentVersionId: newVersion.id,
              currentVersionNumber: nextVersionNumber,
              updatedAt: sql`now()`,
            }),
          )
          .where(and(eq(projects.workspaceId, input.workspaceId), eq(projects.id, input.projectId)));

        return {
          assetId: asset.id,
          versionId: version.id,
          path: targetPath,
          sha256: version.sha256,
          bytes: version.sizeBytes,
          mimeType: version.mimeType,
          projectRevision: nextRevision,
          projectVersionId: newVersion.id,
          projectVersionNumber: nextVersionNumber,
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 3-Way Cloud `openmotion_import_assets` Service
// ---------------------------------------------------------------------------

export interface ImportAssetsServiceDeps {
  store: ImportAssetsStore;
  storage: StoragePort;
  queues: Pick<QueueService, 'enqueueMediaIngest'>;
  eventBus?: Pick<RedisEventBus, 'publish'>;
  config: Pick<AppConfig, 'S3_PRESIGN_PUT_TTL_SEC' | 'ALLOW_DOH_FAKEIP_FALLBACK'>;
  urlValidation?: UrlValidationOptions;
}

export interface CloudImportItemResult {
  itemId: string;
  status: 'imported' | 'processing' | 'failed';
  kind?: 'upload_ticket' | 'url' | 'library_asset';
  ticketId?: string;
  url?: string;
  importJobId?: string;
  assetId?: string;
  versionId?: string;
  path?: string;
  sha256?: string;
  bytes?: number;
  mimeType?: string;
  zeroCopy?: boolean;
  error?: { code: string; message: string };
}

export interface CloudImportAssetsResult {
  projectId: string;
  status: 'completed' | 'processing' | 'partial' | 'failed';
  items: CloudImportItemResult[];
  revision?: string;
  versionId?: string;
  replayed?: boolean;
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class CloudImportAssetsService {
  private readonly deps: ImportAssetsServiceDeps;

  constructor(deps: ImportAssetsServiceDeps) {
    this.deps = deps;
  }

  /**
   * Detects legacy host `sourcePath` calls and rejects them with `LOCAL_PATH_UNSUPPORTED_IN_CLOUD`.
   */
  assertNoLegacySourcePath(rawArgs: Record<string, unknown>): void {
    const rawItems = rawArgs.items;
    if (!Array.isArray(rawItems)) return;
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.sourcePath === 'string' || rec.source === undefined) {
        throw new CloudError(
          'INVALID_ARGUMENT',
          'LOCAL_PATH_UNSUPPORTED_IN_CLOUD: Local host sourcePath is not supported in cloud deployments. Use openmotion_import_assets with source.kind = "upload_ticket" (via action="prepare_upload"), "url" (public HTTPS), or "library_asset" (assetId + versionId).',
          {
            status: 400,
            applied: false,
            details: {
              legacyCode: 'LOCAL_PATH_UNSUPPORTED_IN_CLOUD',
              supportedModes: ['upload_ticket', 'url', 'library_asset'],
            },
          },
        );
      }
    }
  }

  async execute(
    auth: AuthContext,
    rawArgs: Record<string, unknown>,
  ): Promise<PrepareUploadResult | CloudImportAssetsResult> {
    const action = rawArgs.action === 'prepare_upload' ? 'prepare_upload' : 'import';
    if (action === 'prepare_upload') {
      return this.prepareUpload(auth, rawArgs as unknown as PrepareUploadInput);
    }
    this.assertNoLegacySourcePath(rawArgs);
    return this.importItems(auth, rawArgs as unknown as ImportAssetsCloudInput);
  }

  async prepareUpload(
    auth: AuthContext,
    input: PrepareUploadInput,
  ): Promise<PrepareUploadResult> {
    if (!isUuid(input.projectId)) {
      throw new CloudError('INVALID_ARGUMENT', 'projectId must be a valid UUID', {
        status: 400,
        applied: false,
      });
    }
    const requestId = validateStableRequestId(input.requestId);
    if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 100) {
      throw new CloudError('INVALID_ARGUMENT', 'action=prepare_upload requires files (1..100 items)', {
        status: 400,
        applied: false,
      });
    }

    await this.deps.store.assertActiveProject(auth.workspaceId, input.projectId);

    const scope = 'phase1:import_assets:prepare';
    const inputHash = hashPayload({ projectId: input.projectId, files: input.files });
    const existing = await this.deps.store.findReceipt(auth.workspaceId, scope, requestId);
    if (existing) {
      if (existing.inputHash !== inputHash) {
        throw new CloudError(
          'REQUEST_ID_CONFLICT',
          'requestId was already used with different prepare_upload parameters',
          { status: 409, applied: false },
        );
      }
      if (existing.state === 'completed' && existing.responsePayload) {
        return {
          ...(existing.responsePayload as unknown as PrepareUploadResult),
          replayed: true,
        };
      }
    }

    const ttlSec = this.deps.config.S3_PRESIGN_PUT_TTL_SEC;
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const tickets: PrepareUploadTicketResult[] = [];

    for (const file of input.files) {
      const filename = sanitizeFilename(file.filename);
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_ASSET_BYTES) {
        throw new CloudError(
          'INVALID_ARGUMENT',
          `File '${filename}' bytes must be between 1 and ${MAX_ASSET_BYTES}`,
          { status: 400, applied: false },
        );
      }
      if (file.sha256 !== undefined && !isSha256Hex(file.sha256)) {
        throw new CloudError('INVALID_ARGUMENT', `Invalid sha256 for '${filename}'`, {
          status: 400,
          applied: false,
        });
      }

      const hasLicense = file.licenseFilename !== undefined || file.licenseBytes !== undefined;
      let licenseFilename: string | null = null;
      let licenseBytes: number | null = null;
      if (hasLicense) {
        if (!file.licenseFilename || !file.licenseBytes) {
          throw new CloudError(
            'INVALID_ARGUMENT',
            'Both licenseFilename and licenseBytes are required for companion font license upload',
            { status: 400, applied: false },
          );
        }
        licenseFilename = sanitizeFilename(file.licenseFilename);
        if (
          !Number.isSafeInteger(file.licenseBytes) ||
          file.licenseBytes < 1 ||
          file.licenseBytes > MAX_FONT_LICENSE_BYTES
        ) {
          throw new CloudError(
            'INVALID_ARGUMENT',
            `Font license bytes must be between 1 and ${MAX_FONT_LICENSE_BYTES}`,
            { status: 400, applied: false },
          );
        }
        licenseBytes = file.licenseBytes;
      }

      const ticketId = randomUUID();
      const targetPath = resolveProjectAssetTargetPath(ticketId, filename, file.mimeType);
      if (licenseFilename) {
        try {
          projectPath(path.posix.join(path.posix.dirname(targetPath), licenseFilename));
        } catch {
          throw new CloudError('INVALID_ARGUMENT', `Invalid licenseFilename: ${licenseFilename}`, {
            status: 400,
            applied: false,
          });
        }
      }
      const s3StagingKey = uploadStagingKey(auth.workspaceId, ticketId);
      const licenseS3StagingKey = hasLicense
        ? uploadLicenseStagingKey(auth.workspaceId, ticketId)
        : null;

      await this.deps.store.insertUploadTicket({
        id: ticketId,
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        targetProjectId: input.projectId,
        targetPath,
        filename,
        expectedMimeType: file.mimeType,
        expectedSha256: file.sha256 ?? null,
        maxBytes: file.bytes,
        s3StagingKey,
        licenseS3StagingKey,
        licenseFilename,
        licenseMaxBytes: licenseBytes,
        requestId,
        expiresAt,
      });

      const uploadUrl = await this.deps.storage.presignPut(s3StagingKey, {
        contentType: file.mimeType,
        contentLength: file.bytes,
        expiresInSec: ttlSec,
      });

      let licenseUpload: PrepareUploadTicketResult['licenseUpload'];
      if (licenseS3StagingKey && licenseBytes !== null) {
        const licenseUploadUrl = await this.deps.storage.presignPut(licenseS3StagingKey, {
          contentType: 'text/plain; charset=utf-8',
          contentLength: licenseBytes,
          expiresInSec: ttlSec,
        });
        licenseUpload = {
          uploadUrl: licenseUploadUrl,
          method: 'PUT',
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': String(licenseBytes),
          },
        };
      }

      tickets.push({
        itemId: file.itemId,
        ticketId,
        uploadUrl,
        method: 'PUT',
        headers: {
          'Content-Type': file.mimeType,
          'Content-Length': String(file.bytes),
        },
        expiresAt: expiresAt.toISOString(),
        ...(licenseUpload ? { licenseUpload } : {}),
      });

      if (this.deps.eventBus) {
        const ingestEvt: ProjectEvent = {
          type: 'media-ingest-status',
          workspaceId: auth.workspaceId,
          projectId: input.projectId,
          ticketId,
          filename,
          targetPath,
          bytes: file.bytes,
          source: 'mcp_upload',
          state: 'waiting_upload',
          stage: 'waiting_upload',
          expiresAt: expiresAt.toISOString(),
          ts: Date.now(),
        };
        await this.deps.eventBus
          .publish(projectChannel(auth.workspaceId, input.projectId), ingestEvt)
          .catch(() => {});
      }
    }

    const result: PrepareUploadResult = {
      projectId: input.projectId,
      tickets,
    };

    await this.deps.store.saveCompletedReceipt({
      workspaceId: auth.workspaceId,
      scope,
      requestId,
      inputHash,
      resourceId: input.projectId,
      responsePayload: result as unknown as Record<string, unknown>,
    });

    return result;
  }

  async importItems(
    auth: AuthContext,
    input: ImportAssetsCloudInput,
  ): Promise<CloudImportAssetsResult> {
    if (!isUuid(input.projectId)) {
      throw new CloudError('INVALID_ARGUMENT', 'projectId must be a valid UUID', {
        status: 400,
        applied: false,
      });
    }
    const requestId = validateStableRequestId(input.requestId);
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) {
      throw new CloudError('INVALID_ARGUMENT', 'items (1..100) is required for import', {
        status: 400,
        applied: false,
      });
    }

    await this.deps.store.assertActiveProject(auth.workspaceId, input.projectId);

    const scope = 'phase1:import_assets';
    const inputHash = hashPayload({ projectId: input.projectId, items: input.items });
    const existing = await this.deps.store.findReceipt(auth.workspaceId, scope, requestId);
    if (existing) {
      if (existing.inputHash !== inputHash) {
        throw new CloudError(
          'REQUEST_ID_CONFLICT',
          'requestId was already used with different import items',
          { status: 409, applied: false },
        );
      }
      if (existing.state === 'completed' && existing.responsePayload) {
        return {
          ...(existing.responsePayload as unknown as CloudImportAssetsResult),
          replayed: true,
        };
      }
    }

    const results: CloudImportItemResult[] = [];
    let latestRevision: string | undefined;
    let latestVersionId: string | undefined;
    let enqueueFailedCount = 0;

    for (const item of input.items) {
      const outcome = await this.processSingleItem(auth, input.projectId, requestId, item);
      if (outcome.projectRevision) latestRevision = outcome.projectRevision;
      if (outcome.projectVersionId) latestVersionId = outcome.projectVersionId;
      if (outcome.enqueueFailed) enqueueFailedCount += 1;
      results.push(outcome.result);
    }

    const failedCount = results.filter((r) => r.status === 'failed').length;
    const processingCount = results.filter((r) => r.status === 'processing').length;
    const importedCount = results.filter((r) => r.status === 'imported').length;

    const status: CloudImportAssetsResult['status'] =
      failedCount === results.length
        ? 'failed'
        : failedCount > 0
          ? 'partial'
          : processingCount > 0 && importedCount === 0
            ? 'processing'
            : processingCount > 0
              ? 'processing'
              : 'completed';

    const payload: CloudImportAssetsResult = {
      projectId: input.projectId,
      status,
      items: results,
      ...(latestRevision ? { revision: latestRevision } : {}),
      ...(latestVersionId ? { versionId: latestVersionId } : {}),
    };

    // Do not lock the requestId into a completed receipt when every item failed queue enqueue,
    // allowing the caller to safely retry with the same requestId once Redis/BullMQ recovers.
    const allFailedEnqueue = results.length > 0 && enqueueFailedCount === results.length;
    if (!allFailedEnqueue) {
      await this.deps.store.saveCompletedReceipt({
        workspaceId: auth.workspaceId,
        scope,
        requestId,
        inputHash,
        resourceId: input.projectId,
        responsePayload: payload as unknown as Record<string, unknown>,
      });
    }

    return payload;
  }

  private async processSingleItem(
    auth: AuthContext,
    projectId: string,
    requestId: string,
    item: CloudImportAssetItem,
  ): Promise<{
    result: CloudImportItemResult;
    projectRevision?: string;
    projectVersionId?: string;
    enqueueFailed?: boolean;
  }> {
    try {
      const source = item.source;
      if (!source || typeof source !== 'object') {
        throw new CloudError('INVALID_ARGUMENT', 'Missing import item source', { status: 400 });
      }

      if (source.kind === 'upload_ticket') {
        if (!isUuid(source.ticketId)) {
          throw new CloudError('INVALID_ARGUMENT', 'Invalid ticketId', { status: 400 });
        }
        const ticket = await this.deps.store.findUploadTicket(auth.workspaceId, source.ticketId);
        if (!ticket) {
          throw new CloudError('NOT_FOUND', `Upload ticket ${source.ticketId} not found`, {
            status: 404,
          });
        }
        if (ticket.targetProjectId && ticket.targetProjectId !== projectId) {
          throw new CloudError(
            'WORKSPACE_FORBIDDEN',
            'Upload ticket is bound to a different project',
            { status: 403 },
          );
        }
        if (ticket.expiresAt.getTime() <= Date.now()) {
          throw new CloudError('INVALID_ARGUMENT', 'Upload ticket has expired', { status: 400 });
        }
        if (ticket.state !== 'issued' && ticket.state !== 'uploaded') {
          throw new CloudError(
            'INVALID_ARGUMENT',
            `Upload ticket is already in state '${ticket.state}'`,
            { status: 409 },
          );
        }

        const head = await this.deps.storage.headObject(ticket.s3StagingKey);
        if (!head || head.contentLength <= 0) {
          throw new CloudError(
            'INVALID_ARGUMENT',
            'No uploaded bytes found at presigned staging URL; upload before committing ticket',
            { status: 400 },
          );
        }
        if (head.contentLength > MAX_ASSET_BYTES || head.contentLength > ticket.maxBytes) {
          throw new CloudError(
            'INVALID_ARGUMENT',
            `Staged upload exceeds maximum allowed size (${ticket.maxBytes} bytes)`,
            { status: 413 },
          );
        }

        const previousState: 'issued' | 'uploaded' = ticket.state;
        const transitioned = await this.deps.store.markUploadTicketProcessing(
          auth.workspaceId,
          ticket.id,
        );
        if (!transitioned) {
          throw new CloudError('INVALID_ARGUMENT', 'Upload ticket was already claimed', {
            status: 409,
          });
        }

        const jobId = randomUUID();
        const displayName = (item.name?.trim() || ticket.filename).slice(0, 200);
        const expectedSha256 = source.expectedSha256 ?? ticket.expectedSha256 ?? undefined;
        const targetPath = ticket.targetPath
          ? projectPath(ticket.targetPath)
          : resolveProjectAssetTargetPath(ticket.id, ticket.filename, ticket.expectedMimeType ?? '');
        let jobCreated = false;

        try {
          await this.deps.store.createMediaIngestJob({
            id: jobId,
            workspaceId: auth.workspaceId,
            projectId,
            requestId,
            inputPayload: {
              kind: 'upload_ticket',
              uploadId: ticket.id,
              itemId: item.itemId,
              targetPath,
              name: displayName,
              ...(expectedSha256 ? { expectedSha256 } : {}),
            },
          });
          jobCreated = true;

          await this.deps.queues.enqueueMediaIngest('upload_commit', {
            jobId,
            workspaceId: auth.workspaceId,
            uploadId: ticket.id,
            userId: auth.userId,
            purpose: 'project_asset',
            targetProjectId: projectId,
            targetPath,
            name: displayName,
            requestId,
            ...(expectedSha256 ? { expectedSha256 } : {}),
          });
        } catch (enqueueError) {
          const message =
            enqueueError instanceof Error ? enqueueError.message : 'Failed to enqueue upload commit job';
          await this.deps.store
            .revertUploadTicketProcessing(auth.workspaceId, ticket.id, previousState)
            .catch(() => {});
          if (jobCreated) {
            await this.deps.store
              .markMediaIngestJobFailed(auth.workspaceId, jobId, 'QUEUE_ENQUEUE_FAILED', message)
              .catch(() => {});
          }
          return {
            enqueueFailed: true,
            result: {
              itemId: item.itemId,
              status: 'failed',
              kind: 'upload_ticket',
              ticketId: ticket.id,
              ...(jobCreated ? { importJobId: jobId } : {}),
              error: { code: 'QUEUE_ENQUEUE_FAILED', message },
            },
          };
        }

        if (this.deps.eventBus) {
          const ingestEvt: ProjectEvent = {
            type: 'media-ingest-status',
            workspaceId: auth.workspaceId,
            projectId,
            ticketId: ticket.id,
            jobId,
            filename: displayName,
            targetPath,
            bytes: Number(ticket.maxBytes),
            source: 'mcp_upload',
            state: 'processing',
            stage: 'probing',
            progress: 15,
            ts: Date.now(),
          };
          await this.deps.eventBus
            .publish(projectChannel(auth.workspaceId, projectId), ingestEvt)
            .catch(() => {});
        }

        return {
          result: {
            itemId: item.itemId,
            status: 'processing',
            kind: 'upload_ticket',
            ticketId: ticket.id,
            importJobId: jobId,
            path: targetPath,
          },
        };
      }

      if (source.kind === 'url') {
        const validatedUrl = await validatePublicImportUrl(source.url, this.deps.urlValidation);
        if (source.licenseUrl) {
          await validatePublicImportUrl(source.licenseUrl, this.deps.urlValidation);
        }
        const jobId = randomUUID();
        const urlPathName = path.posix.basename(new URL(validatedUrl).pathname) || 'imported-asset';
        const displayName = (item.name?.trim() || urlPathName).slice(0, 200);
        const targetPath = resolveProjectAssetTargetPath(jobId, urlPathName);

        await this.deps.store.createMediaIngestJob({
          id: jobId,
          workspaceId: auth.workspaceId,
          projectId,
          requestId,
          inputPayload: {
            kind: 'url',
            url: validatedUrl,
            targetPath,
            ...(source.licenseUrl ? { licenseUrl: source.licenseUrl } : {}),
            ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
            itemId: item.itemId,
            name: displayName,
          },
        });

        try {
          await this.deps.queues.enqueueMediaIngest('url_fetch', {
            jobId,
            workspaceId: auth.workspaceId,
            url: validatedUrl,
            targetProjectId: projectId,
            targetPath,
            itemId: item.itemId,
            name: displayName,
            requestId,
            ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
          });
        } catch (enqueueError) {
          const message =
            enqueueError instanceof Error ? enqueueError.message : 'Failed to enqueue URL fetch job';
          await this.deps.store
            .markMediaIngestJobFailed(auth.workspaceId, jobId, 'QUEUE_ENQUEUE_FAILED', message)
            .catch(() => {});
          return {
            enqueueFailed: true,
            result: {
              itemId: item.itemId,
              status: 'failed',
              kind: 'url',
              url: validatedUrl,
              importJobId: jobId,
              error: { code: 'QUEUE_ENQUEUE_FAILED', message },
            },
          };
        }

        if (this.deps.eventBus) {
          const ingestEvt: ProjectEvent = {
            type: 'media-ingest-status',
            workspaceId: auth.workspaceId,
            projectId,
            jobId,
            filename: displayName,
            targetPath,
            source: 'mcp_url',
            state: 'processing',
            stage: 'downloading',
            progress: 5,
            ts: Date.now(),
          };
          await this.deps.eventBus
            .publish(projectChannel(auth.workspaceId, projectId), ingestEvt)
            .catch(() => {});
        }

        return {
          result: {
            itemId: item.itemId,
            status: 'processing',
            kind: 'url',
            url: validatedUrl,
            importJobId: jobId,
            path: targetPath,
          },
        };
      }

      if (source.kind === 'library_asset') {
        if (!isUuid(source.assetId) || !isUuid(source.versionId)) {
          throw new CloudError('INVALID_ARGUMENT', 'assetId and versionId must be valid UUIDs', {
            status: 400,
          });
        }
        const committed = await this.deps.store.commitLibraryAssetZeroCopy({
          workspaceId: auth.workspaceId,
          projectId,
          assetId: source.assetId,
          versionId: source.versionId,
          name: item.name,
          requestId,
        });
        if (this.deps.eventBus) {
          const fileEvt: ProjectEvent = {
            type: 'file-change',
            workspaceId: auth.workspaceId,
            projectId,
            revision: committed.projectRevision,
            versionId: committed.projectVersionId,
            paths: [committed.path],
            affectsPreview: true,
            ts: Date.now(),
          };
          await this.deps.eventBus
            .publish(projectChannel(auth.workspaceId, projectId), fileEvt)
            .catch(() => {});
        }
        return {
          result: {
            itemId: item.itemId,
            status: 'imported',
            kind: 'library_asset',
            assetId: committed.assetId,
            versionId: committed.versionId,
            path: committed.path,
            sha256: committed.sha256,
            bytes: committed.bytes,
            mimeType: committed.mimeType,
            zeroCopy: true,
          },
          projectRevision: committed.projectRevision,
          projectVersionId: committed.projectVersionId,
        };
      }

      throw new CloudError('INVALID_ARGUMENT', 'Unsupported cloud import source kind', {
        status: 400,
      });
    } catch (error) {
      const code = error instanceof CloudError ? error.code : 'IMPORT_FAILED';
      const message = error instanceof Error ? error.message : 'Asset import failed';
      return {
        result: {
          itemId: item.itemId,
          status: 'failed',
          kind: item.source?.kind,
          error: { code, message },
        },
      };
    }
  }
}
