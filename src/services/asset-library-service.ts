import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { brandWebsite, publicBrandAddress } from '../../gateway/brand-network.ts';
import { MAX_ASSET_BYTES } from '../../shared/asset-limits.ts';
import type { AssetListInput, AssetReference, AssetVersion, LibraryAsset } from '../../shared/asset-library.ts';
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
import type { BlobMetadata, MultipartPartInfo, StoragePort } from '../contracts/storage.ts';
import { applyWorkspaceBlobRefDeltas, type BlobRefDelta } from '../db/cas.ts';
import type { Database } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import {
  assets,
  assetVersions,
  uploadTickets,
  workspaceBlobs,
  type AssetModality,
  type UploadTicketPurpose,
  type UploadTicketState,
} from '../db/schema/blobs-assets.ts';
import { idempotencyReceipts, jobs } from '../db/schema/jobs.ts';
import {
  projectFiles,
  projectVersionFiles,
  projectVersions,
} from '../db/schema/project-files.ts';
import { projects } from '../db/schema/projects.ts';
import type { QueueService } from '../infra/queues.ts';
import { projectChannel, type RedisEventBus } from '../infra/redis.ts';
import {
  assertTenantScopedKey,
  thumbnailKey,
  uploadLicenseStagingKey,
  uploadStagingKey,
  workspaceBlobKey,
} from '../infra/storage.ts';

export const MAX_FONT_LICENSE_BYTES = 131_072; // 128 KiB per Spike 2 §3.2.5
export const DEFAULT_UPLOAD_TICKET_TTL_SEC = 900;
export const DEFAULT_PRESIGN_GET_TTL_SEC = 300;
export const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024; // 5 MiB S3 protocol minimum
export const MULTIPART_DEFAULT_PART_BYTES = 8 * 1024 * 1024; // 8 MiB default chunk
export const MULTIPART_MAX_PART_BYTES = 64 * 1024 * 1024;
export const MULTIPART_MAX_PARTS_PER_SIGN_BATCH = 32;
const ASSET_MODALITY_SET: ReadonlySet<string> = new Set(['image', 'video', 'audio']);
const UPLOAD_PURPOSE_SET: ReadonlySet<string> = new Set(['library_asset', 'project_asset', 'project_archive']);

export interface AssetLibraryServiceDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly queues: Pick<QueueService, 'enqueueMediaIngest'>;
  readonly eventBus?: Pick<RedisEventBus, 'publish'>;
  readonly presignPutTtlSec?: number;
  readonly presignGetTtlSec?: number;
}

export interface CreateUploadTicketInput {
  purpose?: UploadTicketPurpose;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  expectedModality?: AssetModality;
  expectedSha256?: string;
  allowInstantCommit?: boolean;
  multipart?: boolean;
  partSize?: number;
  targetProjectId?: string;
  targetAssetId?: string;
  targetPath?: string;
  requestId?: string;
  licenseFilename?: string;
  licenseBytes?: number;
}

export interface UploadTicketResponse {
  ticketId: string;
  uploadId: string;
  purpose: UploadTicketPurpose;
  s3StagingKey: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
  mode?: 'single' | 'multipart';
  partSize?: number;
  totalParts?: number;
  instantCommitted?: boolean;
  projectPath?: string;
  sha256?: string;
  licenseUpload?: {
    s3StagingKey: string;
    filename: string;
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
    maxBytes: number;
  };
}

export interface PrepareMultipartPartsResponse {
  uploadId: string;
  partSize: number;
  totalParts: number;
  expiresAt: string;
  uploadedParts: MultipartPartInfo[];
  urls: Array<{
    partNumber: number;
    uploadUrl: string;
    sizeBytes: number;
  }>;
}

export interface CompleteMultipartTicketResponse {
  uploadId: string;
  completed: boolean;
  partsCount: number;
}

export interface ConfirmUploadTicketInput {
  name?: string;
  parentVersionId?: string;
  requestId?: string;
  expectedSha256?: string;
}

export interface ConfirmUploadTicketResponse {
  ticketId: string;
  jobId: string | null;
  state: UploadTicketState | 'queued';
  replayed: boolean;
  result?: Record<string, unknown> | null;
}

export interface ImportPublicUrlInput {
  url: string;
  name: string;
  requestId: string;
  targetProjectId?: string;
  targetAssetId?: string;
  parentVersionId?: string;
  itemId?: string;
  expectedModality?: AssetModality;
}

export interface ImportPublicUrlResponse {
  jobId: string;
  state: string;
  url: string;
  replayed: boolean;
}

export interface AssetUpdatePatch {
  name?: string;
  trashed?: boolean;
  currentVersionId?: string;
}

export interface AssetFileMetadata {
  assetId: string;
  versionId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  etag: string;
  s3Key: string;
  metadata: BlobMetadata | null;
}

export interface PresignedAssetUrlResult {
  url: string;
  metadata: AssetFileMetadata;
  expiresInSec: number;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateAssetName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\x00-\x1f]/.test(value)) {
    throw new CloudError('INVALID_ARGUMENT', 'Asset name must contain 1-200 printable characters', {
      status: 400,
      applied: false,
    });
  }
  return value.trim();
}

function validateSafeFilename(value: unknown, label = 'filename'): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    /[\x00-\x1f/\\]/.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new CloudError('INVALID_ARGUMENT', `Invalid ${label}`, { status: 400, applied: false });
  }
  return value.trim();
}

function validateMimeType(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+_-]{0,100}$/i.test(value.trim())) {
    throw new CloudError('INVALID_ARGUMENT', 'Invalid MIME type', { status: 400, applied: false });
  }
  return value.trim().toLowerCase();
}

function requireUuid(value: unknown, label: string, code: 'INVALID_ARGUMENT' | 'ASSET_NOT_FOUND' = 'INVALID_ARGUMENT'): string {
  if (!isUuid(value)) {
    throw new CloudError(code, `${label} must be a valid UUID`, {
      status: code === 'ASSET_NOT_FOUND' ? 404 : 400,
      applied: false,
    });
  }
  return value;
}

/**
 * Hardened public IPv4/IPv6 check layered atop `gateway/brand-network.ts` (`publicBrandAddress`),
 * additionally rejecting RFC 5737 TEST-NET-2/3, 6to4 relay (192.88.99.0/24), and IPv4-mapped IPv6.
 */
export function isHardenedPublicIp(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isHardenedPublicIp(mapped);
    return false;
  }
  if (!publicBrandAddress(normalized)) return false;
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split('.').map(Number);
    // Reject TEST-NET-2 (198.51.100.0/24), TEST-NET-3 (203.0.113.0/24), 6to4 relay (192.88.99.0/24).
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a === 192 && b === 88 && c === 99) return false;
  }
  return true;
}

/**
 * Validate a user-supplied public HTTPS URL using `gateway/brand-network.ts` SSRF checks
 * plus cloud cluster-internal hostname and RFC 5737 / IPv4-mapped IPv6 guards.
 */
export function validatePublicImportUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) {
    throw new CloudError('SSRF_BLOCKED', 'A public HTTPS URL is required', { status: 400, applied: false });
  }
  const trimmed = raw.trim();
  // Explicitly reject non-HTTPS schemes before brandWebsite could prepend https:// to bare strings.
  if (!trimmed.toLowerCase().startsWith('https://')) {
    throw new CloudError('SSRF_BLOCKED', 'Only public HTTPS URLs are permitted', { status: 400, applied: false });
  }
  let normalized: string;
  try {
    normalized = brandWebsite(trimmed);
  } catch (error) {
    throw new CloudError(
      'SSRF_BLOCKED',
      error instanceof Error ? error.message : 'URL rejected by SSRF guard',
      { status: 400, applied: false },
    );
  }

  const parsed = new URL(normalized);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.svc.cluster.local') ||
    hostname.endsWith('.cluster.local') ||
    !hostname.includes('.') ||
    (isIP(hostname) !== 0 && !isHardenedPublicIp(hostname))
  ) {
    throw new CloudError('SSRF_BLOCKED', 'URL targets a private, loopback, or internal host', {
      status: 400,
      applied: false,
    });
  }
  return normalized;
}

function toAssetVersionDto(row: typeof assetVersions.$inferSelect): AssetVersion {
  return {
    id: row.id,
    createdAt: row.createdAt.getTime(),
    source: row.source,
    filename: row.filename,
    ...(row.displayName ? { name: row.displayName } : {}),
    mimeType: row.mimeType,
    bytes: Number(row.sizeBytes),
    sha256: row.sha256,
    ...(row.width !== null && row.width !== undefined ? { width: row.width } : {}),
    ...(row.height !== null && row.height !== undefined ? { height: row.height } : {}),
    ...(row.durationSec !== null && row.durationSec !== undefined ? { duration: row.durationSec } : {}),
    ...(row.prompt !== null && row.prompt !== undefined ? { prompt: row.prompt } : {}),
    ...(row.model !== null && row.model !== undefined ? { model: row.model } : {}),
    ...(row.parameters ? { parameters: row.parameters } : {}),
    references: Array.isArray(row.references) ? row.references : [],
    ...(row.parentVersionId ? { parentVersionId: row.parentVersionId } : {}),
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(row.requestId ? { requestId: row.requestId } : {}),
    ...(row.requestHash ? { requestHash: row.requestHash } : {}),
    ...(row.providerResult ? { result: row.providerResult } : {}),
  };
}

function toLibraryAssetDto(
  assetRow: typeof assets.$inferSelect,
  versionRows: readonly (typeof assetVersions.$inferSelect)[],
): LibraryAsset {
  const sortedVersions = [...versionRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const currentVersionId = assetRow.currentVersionId ?? sortedVersions.at(-1)?.id ?? '';
  return {
    id: assetRow.id,
    name: assetRow.name,
    modality: assetRow.modality,
    createdAt: assetRow.createdAt.getTime(),
    updatedAt: assetRow.updatedAt.getTime(),
    currentVersionId,
    versions: sortedVersions.map(toAssetVersionDto),
    ...(assetRow.trashedAt ? { trashedAt: assetRow.trashedAt.getTime() } : {}),
  };
}

function contentDispositionFilename(filename: string): string {
  const clean = filename.replace(/["\\\r\n]/g, '_').slice(0, 180) || 'asset';
  return clean;
}

export class AssetLibraryService {
  private readonly db: Database;
  private readonly storage: StoragePort;
  private readonly queues: Pick<QueueService, 'enqueueMediaIngest'>;
  private readonly eventBus?: Pick<RedisEventBus, 'publish'>;
  private readonly presignPutTtlSec: number;
  private readonly presignGetTtlSec: number;

  constructor(deps: AssetLibraryServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.queues = deps.queues;
    this.eventBus = deps.eventBus;
    this.presignPutTtlSec = deps.presignPutTtlSec ?? DEFAULT_UPLOAD_TICKET_TTL_SEC;
    this.presignGetTtlSec = deps.presignGetTtlSec ?? DEFAULT_PRESIGN_GET_TTL_SEC;
  }

  /**
   * Issue a presigned S3 PUT upload ticket (including optional companion font license staging key).
   */
  async createUploadTicket(ctx: AuthContext, input: CreateUploadTicketInput): Promise<UploadTicketResponse> {
    const purpose: UploadTicketPurpose = input.purpose ?? 'library_asset';
    if (!UPLOAD_PURPOSE_SET.has(purpose)) {
      throw new CloudError('INVALID_ARGUMENT', `Invalid upload purpose: ${String(purpose)}`, { status: 400 });
    }
    const filename = validateSafeFilename(input.filename, 'filename');
    const mimeType = validateMimeType(input.mimeType);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_ASSET_BYTES) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        `Upload sizeBytes must be between 1 and ${MAX_ASSET_BYTES} bytes`,
        { status: 400 },
      );
    }
    if (input.expectedModality !== undefined && !ASSET_MODALITY_SET.has(input.expectedModality)) {
      throw new CloudError('INVALID_ARGUMENT', `Invalid expectedModality: ${String(input.expectedModality)}`, {
        status: 400,
      });
    }
    if (input.expectedSha256 !== undefined && !isSha256Hex(input.expectedSha256)) {
      throw new CloudError('INVALID_ARGUMENT', 'expectedSha256 must be a 64-character lowercase hex digest', {
        status: 400,
      });
    }
    if (input.requestId !== undefined) {
      validateStableRequestId(input.requestId);
    }

    let validatedTargetPath: string | null = null;
    if (input.targetPath !== undefined) {
      try {
        validatedTargetPath = projectPath(input.targetPath);
      } catch (error) {
        throw new CloudError(
          'INVALID_PATH',
          error instanceof Error ? error.message : 'Invalid targetPath',
          { status: 400 },
        );
      }
    }

    let targetProjectId: string | null = null;
    if (input.targetProjectId !== undefined) {
      targetProjectId = requireUuid(input.targetProjectId, 'targetProjectId');
      const projectRows = await this.db
        .select({ id: projects.id, trashed: projects.trashed })
        .from(projects)
        .where(and(eq(projects.id, targetProjectId), eq(projects.workspaceId, ctx.workspaceId)))
        .limit(1);
      if (projectRows.length === 0) {
        throw new CloudError('PROJECT_NOT_FOUND', 'Target project was not found in this workspace', { status: 404 });
      }
      if (projectRows[0].trashed) {
        throw new CloudError('PROJECT_TRASHED', 'Restore the project before uploading assets', { status: 400 });
      }
    }

    let targetAssetId: string | null = null;
    if (input.targetAssetId !== undefined) {
      targetAssetId = requireUuid(input.targetAssetId, 'targetAssetId', 'ASSET_NOT_FOUND');
      const assetRows = await this.db
        .select({ id: assets.id, trashed: assets.trashed })
        .from(assets)
        .where(and(eq(assets.id, targetAssetId), eq(assets.workspaceId, ctx.workspaceId)))
        .limit(1);
      if (assetRows.length === 0) {
        throw new CloudError('ASSET_NOT_FOUND', 'Target asset was not found in this workspace', { status: 404 });
      }
      if (assetRows[0].trashed) {
        throw new CloudError('ASSET_VERSION_UNAVAILABLE', 'Restore this asset before adding a new version', {
          status: 400,
        });
      }
    }

    let licenseFilename: string | null = null;
    let licenseMaxBytes: number | null = null;
    const hasLicense = input.licenseFilename !== undefined || input.licenseBytes !== undefined;
    if (hasLicense) {
      licenseFilename = validateSafeFilename(input.licenseFilename, 'licenseFilename');
      const bytes = input.licenseBytes;
      if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_FONT_LICENSE_BYTES) {
        throw new CloudError(
          'INVALID_ARGUMENT',
          `licenseBytes must be between 1 and ${MAX_FONT_LICENSE_BYTES} bytes`,
          { status: 400 },
        );
      }
      licenseMaxBytes = bytes;
    }

    const uploadId = randomUUID();
    const s3StagingKey = uploadStagingKey(ctx.workspaceId, uploadId);
    const licenseS3StagingKey = hasLicense ? uploadLicenseStagingKey(ctx.workspaceId, uploadId) : null;
    const expiresAt = new Date(Date.now() + this.presignPutTtlSec * 1000);

    // Same-workspace CAS instant commit ("秒传"): strictly tenant-scoped inside `ctx.workspaceId`
    // and verified against both PG `workspace_blobs(active)` and S3 `headObject` size match.
    if (
      input.allowInstantCommit === true &&
      input.expectedSha256 &&
      purpose === 'project_asset' &&
      targetProjectId &&
      validatedTargetPath &&
      !hasLicense
    ) {
      const existingBlobs = await this.db
        .select()
        .from(workspaceBlobs)
        .where(
          and(
            eq(workspaceBlobs.workspaceId, ctx.workspaceId),
            eq(workspaceBlobs.sha256, input.expectedSha256),
          ),
        )
        .limit(1);
      const blob = existingBlobs[0];
      if (blob && blob.gcState === 'active' && Number(blob.sizeBytes) === input.sizeBytes) {
        const casKey = workspaceBlobKey(ctx.workspaceId, blob.sha256);
        const head = await this.storage.headObject(casKey).catch(() => null);
        if (head && head.contentLength === input.sizeBytes) {
          const committed = await this.db.transaction(async (tx) => {
            const lockedProject = await tx
              .select()
              .from(projects)
              .where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.id, targetProjectId)))
              .for('update')
              .limit(1);
            const project = lockedProject[0];
            if (!project) {
              throw new CloudError('PROJECT_NOT_FOUND', 'Target project was not found in this workspace', {
                status: 404,
              });
            }
            if (project.trashed) {
              throw new CloudError('PROJECT_TRASHED', 'Restore the project before uploading assets', {
                status: 400,
              });
            }

            const existingFiles = await tx
              .select()
              .from(projectFiles)
              .where(
                and(
                  eq(projectFiles.workspaceId, ctx.workspaceId),
                  eq(projectFiles.projectId, targetProjectId),
                ),
              );
            const replaced = existingFiles.find((f) => f.path === validatedTargetPath);
            const resolvedMime = blob.mimeType || mimeType;

            await tx
              .insert(projectFiles)
              .values(
                asInsert(projectFiles, {
                  workspaceId: ctx.workspaceId,
                  projectId: targetProjectId,
                  path: validatedTargetPath,
                  blobScope: 'workspace',
                  sha256: blob.sha256,
                  sizeBytes: Number(blob.sizeBytes),
                  mimeType: resolvedMime,
                  isText: false,
                }),
              )
              .onConflictDoUpdate({
                target: [projectFiles.projectId, projectFiles.path],
                set: asUpdate(projectFiles, {
                  blobScope: 'workspace',
                  sha256: blob.sha256,
                  sizeBytes: Number(blob.sizeBytes),
                  mimeType: resolvedMime,
                  isText: false,
                  updatedAt: sql`now()`,
                }),
              });

            const nextFiles = [
              ...existingFiles.filter((f) => f.path !== validatedTargetPath),
              {
                workspaceId: ctx.workspaceId,
                projectId: targetProjectId,
                path: validatedTargetPath,
                blobScope: 'workspace' as const,
                sha256: blob.sha256,
                sizeBytes: Number(blob.sizeBytes),
                mimeType: resolvedMime,
                isText: false,
              },
            ];
            const sourceFiles: SourceFile[] = nextFiles.map((f) => ({
              path: f.path,
              size: Number(f.sizeBytes),
              hash: f.sha256,
            }));
            const nextRevision = computeProjectRevision(sourceFiles);
            const nextVersionNumber = project.currentVersionNumber + 1;

            const [newVersion] = await tx
              .insert(projectVersions)
              .values(
                asInsert(projectVersions, {
                  workspaceId: ctx.workspaceId,
                  projectId: targetProjectId,
                  versionNumber: nextVersionNumber,
                  revision: nextRevision,
                  source: 'studio',
                  summary: `Instant import ${filename}`.slice(0, 256),
                  requestId: input.requestId ? input.requestId.slice(0, 128) : null,
                }),
              )
              .returning();

            for (const file of nextFiles) {
              await tx.insert(projectVersionFiles).values(
                asInsert(projectVersionFiles, {
                  versionId: newVersion.id,
                  workspaceId: ctx.workspaceId,
                  projectId: targetProjectId,
                  path: file.path,
                  blobScope: file.blobScope,
                  sha256: file.sha256,
                  sizeBytes: Number(file.sizeBytes),
                  mimeType: file.mimeType,
                }),
              );
            }

            const deltas: BlobRefDelta[] = [
              {
                sha256: blob.sha256,
                delta: 1,
                sizeBytes: Number(blob.sizeBytes),
                mimeType: resolvedMime,
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
                  sizeBytes: Number(file.sizeBytes),
                  mimeType: file.mimeType,
                });
              }
            }
            await applyWorkspaceBlobRefDeltas(tx, ctx.workspaceId, deltas);

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
              .where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.id, targetProjectId)));

            const resultPayload = {
              instantCommitted: true,
              projectPath: validatedTargetPath,
              sha256: blob.sha256,
              projectRevision: nextRevision,
              projectVersionId: newVersion.id,
            };
            await tx.insert(uploadTickets).values(
              asInsert(uploadTickets, {
                id: uploadId,
                workspaceId: ctx.workspaceId,
                userId: ctx.userId,
                purpose,
                targetProjectId,
                targetAssetId,
                targetPath: validatedTargetPath,
                filename,
                expectedMimeType: resolvedMime,
                expectedModality: input.expectedModality ?? null,
                expectedSha256: blob.sha256,
                maxBytes: input.sizeBytes,
                s3StagingKey,
                state: 'committed',
                requestId: input.requestId ?? null,
                resultPayload,
                expiresAt,
              }),
            );

            return { nextRevision, versionId: newVersion.id };
          });

          if (this.eventBus) {
            const evt: ProjectEvent = {
              type: 'file-change',
              workspaceId: ctx.workspaceId,
              projectId: targetProjectId,
              revision: committed.nextRevision,
              versionId: committed.versionId,
              paths: [validatedTargetPath],
              affectsPreview: true,
              ts: Date.now(),
            };
            await this.eventBus.publish(projectChannel(ctx.workspaceId, targetProjectId), evt).catch(() => {});
          }

          return {
            ticketId: uploadId,
            uploadId,
            purpose,
            s3StagingKey,
            uploadUrl: '',
            method: 'PUT',
            headers: {},
            expiresAt: expiresAt.toISOString(),
            maxBytes: input.sizeBytes,
            mode: 'single',
            instantCommitted: true,
            projectPath: validatedTargetPath,
            sha256: blob.sha256,
          };
        }
      }
    }

    // S3 Multipart upload mode for large files (resumable via ListParts + concurrent chunk upload).
    const useMultipart =
      input.multipart === true &&
      !hasLicense &&
      typeof this.storage.createMultipartUpload === 'function' &&
      typeof this.storage.presignUploadPart === 'function' &&
      typeof this.storage.completeMultipartUpload === 'function';

    if (useMultipart) {
      const requestedPartSize =
        typeof input.partSize === 'number' && Number.isFinite(input.partSize)
          ? Math.floor(input.partSize)
          : MULTIPART_DEFAULT_PART_BYTES;
      const partSize = Math.max(
        MULTIPART_MIN_PART_BYTES,
        Math.min(MULTIPART_MAX_PART_BYTES, requestedPartSize),
      );
      const totalParts = Math.max(1, Math.ceil(input.sizeBytes / partSize));
      if (totalParts > 10_000) {
        throw new CloudError('INVALID_ARGUMENT', 'Multipart upload exceeds S3 10,000-part limit', {
          status: 400,
        });
      }
      const mp = await this.storage.createMultipartUpload!(s3StagingKey, mimeType);
      await this.db.insert(uploadTickets).values(
        asInsert(uploadTickets, {
          id: uploadId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          purpose,
          targetProjectId,
          targetAssetId,
          targetPath: validatedTargetPath,
          filename,
          expectedMimeType: mimeType,
          expectedModality: input.expectedModality ?? null,
          expectedSha256: input.expectedSha256 ?? null,
          maxBytes: input.sizeBytes,
          s3StagingKey,
          state: 'issued',
          requestId: input.requestId ?? null,
          resultPayload: {
            mode: 'multipart',
            s3UploadId: mp.uploadId,
            partSize,
            totalParts,
          },
          expiresAt,
        }),
      );
      return {
        ticketId: uploadId,
        uploadId,
        purpose,
        s3StagingKey,
        uploadUrl: '',
        method: 'PUT',
        headers: {
          'Content-Type': mimeType,
        },
        expiresAt: expiresAt.toISOString(),
        maxBytes: input.sizeBytes,
        mode: 'multipart',
        partSize,
        totalParts,
      };
    }

    const [uploadUrl, licenseUploadUrl] = await Promise.all([
      this.storage.presignPut(s3StagingKey, {
        contentType: mimeType,
        contentLength: input.sizeBytes,
        expiresInSec: this.presignPutTtlSec,
      }),
      licenseS3StagingKey && licenseMaxBytes !== null
        ? this.storage.presignPut(licenseS3StagingKey, {
            contentType: 'text/plain; charset=utf-8',
            contentLength: licenseMaxBytes,
            expiresInSec: this.presignPutTtlSec,
          })
        : Promise.resolve(null),
    ]);

    await this.db.insert(uploadTickets).values(
      asInsert(uploadTickets, {
        id: uploadId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        purpose,
        targetProjectId,
        targetAssetId,
        targetPath: validatedTargetPath,
        filename,
        expectedMimeType: mimeType,
        expectedModality: input.expectedModality ?? null,
        expectedSha256: input.expectedSha256 ?? null,
        maxBytes: input.sizeBytes,
        s3StagingKey,
        licenseS3StagingKey,
        licenseFilename,
        licenseMaxBytes,
        state: 'issued',
        requestId: input.requestId ?? null,
        expiresAt,
      }),
    );

    return {
      ticketId: uploadId,
      uploadId,
      purpose,
      s3StagingKey,
      uploadUrl,
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(input.sizeBytes),
      },
      expiresAt: expiresAt.toISOString(),
      maxBytes: input.sizeBytes,
      mode: 'single',
      ...(licenseS3StagingKey && licenseUploadUrl && licenseFilename && licenseMaxBytes !== null
        ? {
            licenseUpload: {
              s3StagingKey: licenseS3StagingKey,
              filename: licenseFilename,
              uploadUrl: licenseUploadUrl,
              method: 'PUT',
              headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': String(licenseMaxBytes),
              },
              maxBytes: licenseMaxBytes,
            },
          }
        : {}),
    };
  }

  /**
   * List already-uploaded parts (resumable upload state) and mint presigned S3 UploadPart URLs
   * for the next batch of missing parts.
   */
  async prepareMultipartParts(
    ctx: AuthContext,
    uploadId: string,
    input: { partNumbers?: readonly number[] } = {},
  ): Promise<PrepareMultipartPartsResponse> {
    requireUuid(uploadId, 'uploadId');
    if (
      typeof this.storage.presignUploadPart !== 'function' ||
      typeof this.storage.listMultipartParts !== 'function'
    ) {
      throw new CloudError('FEATURE_DEFERRED_P2', 'Multipart uploads are not enabled on this storage backend', {
        status: 501,
        applied: false,
      });
    }

    const rows = await this.db
      .select()
      .from(uploadTickets)
      .where(and(eq(uploadTickets.id, uploadId), eq(uploadTickets.workspaceId, ctx.workspaceId)))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) {
      throw new CloudError('NOT_FOUND', 'Upload ticket not found', { status: 404, applied: false });
    }
    if (
      ticket.userId &&
      ticket.userId !== ctx.userId &&
      ctx.role !== 'owner' &&
      ctx.role !== 'admin'
    ) {
      throw new CloudError('FORBIDDEN', 'Upload ticket belongs to another workspace member', {
        status: 403,
        applied: false,
      });
    }
    if (ticket.state !== 'issued' || ticket.expiresAt.getTime() <= Date.now()) {
      throw new CloudError('INVALID_ARGUMENT', 'Upload ticket is expired or no longer active', {
        status: 410,
        applied: false,
      });
    }

    const mp = ticket.resultPayload as {
      mode?: string;
      s3UploadId?: string;
      partSize?: number;
      totalParts?: number;
    } | null;
    if (
      !mp ||
      mp.mode !== 'multipart' ||
      typeof mp.s3UploadId !== 'string' ||
      typeof mp.partSize !== 'number' ||
      typeof mp.totalParts !== 'number'
    ) {
      throw new CloudError('INVALID_ARGUMENT', 'Upload ticket is not a multipart upload', {
        status: 400,
        applied: false,
      });
    }

    assertTenantScopedKey(ctx.workspaceId, ticket.s3StagingKey);
    const uploadedParts = await this.storage.listMultipartParts(ticket.s3StagingKey, mp.s3UploadId);
    const uploadedSet = new Set(uploadedParts.map((p) => p.partNumber));

    let requested: number[];
    if (Array.isArray(input.partNumbers) && input.partNumbers.length > 0) {
      requested = [...new Set(input.partNumbers)]
        .filter((n) => Number.isSafeInteger(n) && n >= 1 && n <= mp.totalParts!)
        .sort((a, b) => a - b)
        .slice(0, MULTIPART_MAX_PARTS_PER_SIGN_BATCH);
    } else {
      requested = [];
      for (let n = 1; n <= mp.totalParts && requested.length < MULTIPART_MAX_PARTS_PER_SIGN_BATCH; n += 1) {
        if (!uploadedSet.has(n)) requested.push(n);
      }
    }

    const totalBytes = Number(ticket.maxBytes);
    const remainingTtl = Math.max(
      60,
      Math.min(this.presignPutTtlSec, Math.floor((ticket.expiresAt.getTime() - Date.now()) / 1000)),
    );
    const urls = await Promise.all(
      requested.map(async (partNumber) => {
        const start = (partNumber - 1) * mp.partSize!;
        const sizeBytes = Math.min(mp.partSize!, Math.max(1, totalBytes - start));
        const uploadUrl = await this.storage.presignUploadPart!(
          ticket.s3StagingKey,
          mp.s3UploadId!,
          partNumber,
          { contentLength: sizeBytes, expiresInSec: remainingTtl },
        );
        return { partNumber, uploadUrl, sizeBytes };
      }),
    );

    return {
      uploadId: ticket.id,
      partSize: mp.partSize,
      totalParts: mp.totalParts,
      expiresAt: ticket.expiresAt.toISOString(),
      uploadedParts,
      urls,
    };
  }

  /**
   * Complete an S3 multipart upload into the ticket's staging key before calling `/confirm`.
   */
  async completeMultipartTicket(
    ctx: AuthContext,
    uploadId: string,
    input: { parts?: ReadonlyArray<{ partNumber: number; etag: string }> } = {},
  ): Promise<CompleteMultipartTicketResponse> {
    requireUuid(uploadId, 'uploadId');
    if (typeof this.storage.completeMultipartUpload !== 'function') {
      throw new CloudError('FEATURE_DEFERRED_P2', 'Multipart uploads are not enabled on this storage backend', {
        status: 501,
        applied: false,
      });
    }

    const rows = await this.db
      .select()
      .from(uploadTickets)
      .where(and(eq(uploadTickets.id, uploadId), eq(uploadTickets.workspaceId, ctx.workspaceId)))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) {
      throw new CloudError('NOT_FOUND', 'Upload ticket not found', { status: 404, applied: false });
    }
    if (
      ticket.userId &&
      ticket.userId !== ctx.userId &&
      ctx.role !== 'owner' &&
      ctx.role !== 'admin'
    ) {
      throw new CloudError('FORBIDDEN', 'Upload ticket belongs to another workspace member', {
        status: 403,
        applied: false,
      });
    }

    const mp = ticket.resultPayload as {
      mode?: string;
      s3UploadId?: string;
      partSize?: number;
      totalParts?: number;
      multipartCompleted?: boolean;
    } | null;
    if (mp?.multipartCompleted) {
      return { uploadId: ticket.id, completed: true, partsCount: mp.totalParts ?? 0 };
    }
    if (ticket.state !== 'issued' || ticket.expiresAt.getTime() <= Date.now()) {
      throw new CloudError('INVALID_ARGUMENT', 'Upload ticket is expired or no longer active', {
        status: 410,
        applied: false,
      });
    }
    if (!mp || mp.mode !== 'multipart' || typeof mp.s3UploadId !== 'string' || typeof mp.totalParts !== 'number') {
      throw new CloudError('INVALID_ARGUMENT', 'Upload ticket is not a multipart upload', {
        status: 400,
        applied: false,
      });
    }

    assertTenantScopedKey(ctx.workspaceId, ticket.s3StagingKey);

    let resolvedParts: Array<{ partNumber: number; etag: string }> = [];
    if (Array.isArray(input.parts) && input.parts.length > 0) {
      for (const item of input.parts) {
        if (
          !item ||
          !Number.isSafeInteger(item.partNumber) ||
          item.partNumber < 1 ||
          item.partNumber > mp.totalParts ||
          typeof item.etag !== 'string' ||
          item.etag.trim().length === 0
        ) {
          throw new CloudError('INVALID_ARGUMENT', 'Invalid multipart part entry', { status: 400 });
        }
        resolvedParts.push({ partNumber: item.partNumber, etag: item.etag.trim() });
      }
    } else if (typeof this.storage.listMultipartParts === 'function') {
      const listed = await this.storage.listMultipartParts(ticket.s3StagingKey, mp.s3UploadId);
      resolvedParts = listed.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
    }

    const byNumber = new Map<number, string>();
    for (const part of resolvedParts) {
      byNumber.set(part.partNumber, part.etag);
    }
    if (byNumber.size !== mp.totalParts) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        `Incomplete multipart upload: received ${byNumber.size} of ${mp.totalParts} parts`,
        { status: 400, applied: false },
      );
    }

    const ordered = Array.from(byNumber.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([partNumber, etag]) => ({ partNumber, etag }));

    await this.storage.completeMultipartUpload(ticket.s3StagingKey, mp.s3UploadId, ordered);

    await this.db
      .update(uploadTickets)
      .set(
        asUpdate(uploadTickets, {
          resultPayload: {
            ...mp,
            multipartCompleted: true,
          },
          updatedAt: new Date(),
        }),
      )
      .where(and(eq(uploadTickets.id, ticket.id), eq(uploadTickets.workspaceId, ctx.workspaceId)));

    return {
      uploadId: ticket.id,
      completed: true,
      partsCount: ordered.length,
    };
  }

  /**
   * Abort an active upload ticket (and clean up any incomplete S3 multipart upload / staging bytes).
   */
  async abortUploadTicket(ctx: AuthContext, uploadId: string): Promise<{ uploadId: string; aborted: boolean }> {
    requireUuid(uploadId, 'uploadId');
    const rows = await this.db
      .select()
      .from(uploadTickets)
      .where(and(eq(uploadTickets.id, uploadId), eq(uploadTickets.workspaceId, ctx.workspaceId)))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) {
      throw new CloudError('NOT_FOUND', 'Upload ticket not found', { status: 404, applied: false });
    }
    if (
      ticket.userId &&
      ticket.userId !== ctx.userId &&
      ctx.role !== 'owner' &&
      ctx.role !== 'admin'
    ) {
      throw new CloudError('FORBIDDEN', 'Upload ticket belongs to another workspace member', {
        status: 403,
        applied: false,
      });
    }
    if (ticket.state === 'committed') {
      return { uploadId: ticket.id, aborted: false };
    }

    assertTenantScopedKey(ctx.workspaceId, ticket.s3StagingKey);
    const mp = ticket.resultPayload as { mode?: string; s3UploadId?: string } | null;
    if (mp?.mode === 'multipart' && typeof mp.s3UploadId === 'string' && this.storage.abortMultipartUpload) {
      await this.storage.abortMultipartUpload(ticket.s3StagingKey, mp.s3UploadId).catch(() => {});
    }
    await this.storage.deleteObject(ticket.s3StagingKey).catch(() => {});

    await this.db
      .update(uploadTickets)
      .set(asUpdate(uploadTickets, { state: 'expired', updatedAt: new Date() }))
      .where(and(eq(uploadTickets.id, ticket.id), eq(uploadTickets.workspaceId, ctx.workspaceId)));

    return { uploadId: ticket.id, aborted: true };
  }

  /**
   * Confirm a completed presigned PUT upload, verify tenant ownership and staged S3 bytes,
   * record a durable `media_ingest` job, and enqueue `upload_commit` onto `worker-media`.
   */
  async confirmUploadTicket(
    ctx: AuthContext,
    uploadId: string,
    input: ConfirmUploadTicketInput = {},
  ): Promise<ConfirmUploadTicketResponse> {
    requireUuid(uploadId, 'uploadId');
    if (input.name !== undefined) validateAssetName(input.name);
    if (input.parentVersionId !== undefined) requireUuid(input.parentVersionId, 'parentVersionId');
    if (input.requestId !== undefined) validateStableRequestId(input.requestId);
    if (input.expectedSha256 !== undefined && !isSha256Hex(input.expectedSha256)) {
      throw new CloudError('INVALID_ARGUMENT', 'expectedSha256 must be a 64-character lowercase hex digest', {
        status: 400,
      });
    }

    // Read ticket outside tx first so S3 HEAD never holds a PostgreSQL row lock.
    const initialRows = await this.db
      .select()
      .from(uploadTickets)
      .where(and(eq(uploadTickets.id, uploadId), eq(uploadTickets.workspaceId, ctx.workspaceId)))
      .limit(1);

    if (initialRows.length === 0) {
      throw new CloudError('NOT_FOUND', 'Upload ticket not found', { status: 404, applied: false });
    }
    const ticket = initialRows[0];

    // Enforce ticket creator ownership unless caller is a workspace admin/owner.
    if (
      ticket.userId &&
      ticket.userId !== ctx.userId &&
      ctx.role !== 'owner' &&
      ctx.role !== 'admin'
    ) {
      throw new CloudError('FORBIDDEN', 'Upload ticket belongs to another workspace member', {
        status: 403,
        applied: false,
      });
    }

    if (ticket.state === 'committed') {
      return {
        ticketId: ticket.id,
        jobId: typeof ticket.resultPayload?.jobId === 'string' ? ticket.resultPayload.jobId : null,
        state: 'committed',
        replayed: true,
        result: ticket.resultPayload ?? null,
      };
    }

    if (ticket.state === 'uploaded' || ticket.state === 'processing') {
      return {
        ticketId: ticket.id,
        jobId: typeof ticket.resultPayload?.jobId === 'string' ? ticket.resultPayload.jobId : null,
        state: ticket.state,
        replayed: true,
        result: ticket.resultPayload ?? null,
      };
    }

    if (ticket.state === 'expired' || ticket.expiresAt.getTime() <= Date.now()) {
      await this.db
        .update(uploadTickets)
        .set(asUpdate(uploadTickets, { state: 'expired', updatedAt: new Date() }))
        .where(
          and(
            eq(uploadTickets.id, ticket.id),
            eq(uploadTickets.workspaceId, ctx.workspaceId),
            eq(uploadTickets.state, 'issued'),
          ),
        );
      throw new CloudError('INVALID_ARGUMENT', 'Upload ticket has expired', { status: 410, applied: false });
    }

    if (ticket.state === 'failed') {
      throw new CloudError('INVALID_ARGUMENT', ticket.error ?? 'Upload ticket has already failed', {
        status: 400,
        applied: false,
      });
    }

    assertTenantScopedKey(ctx.workspaceId, ticket.s3StagingKey);
    const stagedHead = await this.storage.headObject(ticket.s3StagingKey);
    if (!stagedHead || stagedHead.contentLength <= 0) {
      throw new CloudError('INVALID_ARGUMENT', 'Staged upload object was not found in storage', {
        status: 400,
        applied: false,
      });
    }
    if (stagedHead.contentLength > Number(ticket.maxBytes) || stagedHead.contentLength > MAX_ASSET_BYTES) {
      throw new CloudError('INVALID_ARGUMENT', 'Staged upload object exceeds declared byte limit', {
        status: 413,
        applied: false,
      });
    }

    if (ticket.licenseS3StagingKey) {
      assertTenantScopedKey(ctx.workspaceId, ticket.licenseS3StagingKey);
      const licenseHead = await this.storage.headObject(ticket.licenseS3StagingKey);
      if (!licenseHead || licenseHead.contentLength <= 0) {
        throw new CloudError('INVALID_ARGUMENT', 'Companion font license upload was not found in storage', {
          status: 400,
          applied: false,
        });
      }
      const maxLicense = Number(ticket.licenseMaxBytes ?? MAX_FONT_LICENSE_BYTES);
      if (licenseHead.contentLength > maxLicense) {
        throw new CloudError('INVALID_ARGUMENT', 'Companion font license exceeds maximum allowed size', {
          status: 413,
          applied: false,
        });
      }
    }

    const effectiveName = validateAssetName(input.name ?? ticket.filename);
    const effectiveRequestId = input.requestId ?? ticket.requestId ?? undefined;
    const effectiveExpectedSha256 = input.expectedSha256 ?? ticket.expectedSha256 ?? undefined;

    const txOutcome = await this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(uploadTickets)
        .where(and(eq(uploadTickets.id, uploadId), eq(uploadTickets.workspaceId, ctx.workspaceId)))
        .for('update')
        .limit(1);

      if (locked.length === 0) {
        throw new CloudError('NOT_FOUND', 'Upload ticket not found', { status: 404, applied: false });
      }
      const current = locked[0];
      if (current.state === 'committed' || current.state === 'uploaded' || current.state === 'processing') {
        return {
          replayed: true,
          state: current.state,
          jobId: typeof current.resultPayload?.jobId === 'string' ? current.resultPayload.jobId : null,
          result: current.resultPayload ?? null,
          ticket: current,
        };
      }
      if (current.state !== 'issued' || current.expiresAt.getTime() <= Date.now()) {
        throw new CloudError('INVALID_ARGUMENT', 'Upload ticket is no longer confirmable', {
          status: 410,
          applied: false,
        });
      }

      const jobId = randomUUID();
      const now = new Date();
      await tx.insert(jobs).values(
        asInsert(jobs, {
          id: jobId,
          workspaceId: ctx.workspaceId,
          projectId: current.targetProjectId ?? null,
          kind: 'media_ingest',
          state: 'queued',
          stage: 'queued',
          progress: 0,
          requestId: effectiveRequestId ?? null,
          inputPayload: {
            operation: 'upload_commit',
            uploadId: current.id,
            purpose: current.purpose,
            name: effectiveName,
            targetAssetId: current.targetAssetId,
            targetProjectId: current.targetProjectId,
            targetPath: current.targetPath,
          },
          createdAt: now,
          updatedAt: now,
        }),
      );

      await tx
        .update(uploadTickets)
        .set(
          asUpdate(uploadTickets, {
            state: 'uploaded',
            resultPayload: { jobId },
            updatedAt: now,
          }),
        )
        .where(and(eq(uploadTickets.id, current.id), eq(uploadTickets.workspaceId, ctx.workspaceId)));

      return {
        replayed: false,
        state: 'queued' as const,
        jobId,
        result: null,
        ticket: current,
      };
    });

    if (txOutcome.replayed || !txOutcome.jobId) {
      return {
        ticketId: uploadId,
        jobId: txOutcome.jobId,
        state: txOutcome.state,
        replayed: true,
        result: txOutcome.result,
      };
    }

    try {
      await this.queues.enqueueMediaIngest('upload_commit', {
        jobId: txOutcome.jobId,
        workspaceId: ctx.workspaceId,
        uploadId: txOutcome.ticket.id,
        userId: ctx.userId,
        purpose: txOutcome.ticket.purpose,
        ...(txOutcome.ticket.targetProjectId ? { targetProjectId: txOutcome.ticket.targetProjectId } : {}),
        ...(txOutcome.ticket.targetAssetId ? { targetAssetId: txOutcome.ticket.targetAssetId } : {}),
        ...(input.parentVersionId ? { parentVersionId: input.parentVersionId } : {}),
        ...(txOutcome.ticket.targetPath ? { targetPath: txOutcome.ticket.targetPath } : {}),
        name: effectiveName,
        ...(effectiveRequestId ? { requestId: effectiveRequestId } : {}),
        ...(txOutcome.ticket.expectedModality ? { expectedModality: txOutcome.ticket.expectedModality } : {}),
        ...(effectiveExpectedSha256 ? { expectedSha256: effectiveExpectedSha256 } : {}),
      });
    } catch (error) {
      // Revert ticket back to issued and mark job failed if queue dispatch fails.
      await this.db
        .update(jobs)
        .set(
          asUpdate(jobs, {
            state: 'failed',
            stage: 'failed',
            errorCode: 'QUEUE_ENQUEUE_FAILED',
            errorMessage: error instanceof Error ? error.message : 'Failed to enqueue upload_commit job',
            terminalAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        .where(and(eq(jobs.id, txOutcome.jobId), eq(jobs.workspaceId, ctx.workspaceId)));
      await this.db
        .update(uploadTickets)
        .set(asUpdate(uploadTickets, { state: 'issued', resultPayload: null, updatedAt: new Date() }))
        .where(and(eq(uploadTickets.id, uploadId), eq(uploadTickets.workspaceId, ctx.workspaceId)));
      throw error;
    }

    return {
      ticketId: uploadId,
      jobId: txOutcome.jobId,
      state: 'queued',
      replayed: false,
    };
  }

  /**
   * Validate a public HTTPS media URL against SSRF rules (`gateway/brand-network.ts`)
   * and enqueue an asynchronous `url_fetch` job onto `media-ingest`.
   */
  async importFromPublicUrl(ctx: AuthContext, input: ImportPublicUrlInput): Promise<ImportPublicUrlResponse> {
    const normalizedUrl = validatePublicImportUrl(input.url);
    const name = validateAssetName(input.name);
    const requestId = validateStableRequestId(input.requestId);
    if (input.expectedModality !== undefined && !ASSET_MODALITY_SET.has(input.expectedModality)) {
      throw new CloudError('INVALID_ARGUMENT', `Invalid expectedModality: ${String(input.expectedModality)}`, {
        status: 400,
      });
    }
    if (input.targetProjectId !== undefined) requireUuid(input.targetProjectId, 'targetProjectId');
    if (input.targetAssetId !== undefined) requireUuid(input.targetAssetId, 'targetAssetId', 'ASSET_NOT_FOUND');
    if (input.parentVersionId !== undefined) requireUuid(input.parentVersionId, 'parentVersionId');

    const inputHash = sha256Json({
      url: normalizedUrl,
      name,
      targetProjectId: input.targetProjectId ?? null,
      targetAssetId: input.targetAssetId ?? null,
      parentVersionId: input.parentVersionId ?? null,
      itemId: input.itemId ?? null,
      expectedModality: input.expectedModality ?? null,
    });

    const scope = 'asset:url_fetch';
    const txOutcome = await this.db.transaction(async (tx) => {
      if (input.targetAssetId) {
        const existingAsset = await tx
          .select({ id: assets.id, trashed: assets.trashed })
          .from(assets)
          .where(and(eq(assets.id, input.targetAssetId), eq(assets.workspaceId, ctx.workspaceId)))
          .limit(1);
        if (existingAsset.length === 0) {
          throw new CloudError('ASSET_NOT_FOUND', 'Target asset not found', { status: 404 });
        }
        if (existingAsset[0].trashed) {
          throw new CloudError('ASSET_VERSION_UNAVAILABLE', 'Restore asset before adding versions', { status: 400 });
        }
      }

      if (input.targetProjectId) {
        const existingProject = await tx
          .select({ id: projects.id, trashed: projects.trashed })
          .from(projects)
          .where(and(eq(projects.id, input.targetProjectId), eq(projects.workspaceId, ctx.workspaceId)))
          .limit(1);
        if (existingProject.length === 0) {
          throw new CloudError('PROJECT_NOT_FOUND', 'Target project not found', { status: 404 });
        }
        if (existingProject[0].trashed) {
          throw new CloudError('PROJECT_TRASHED', 'Target project is in trash', { status: 400 });
        }
      }

      const priorReceipt = await tx
        .select()
        .from(idempotencyReceipts)
        .where(
          and(
            eq(idempotencyReceipts.workspaceId, ctx.workspaceId),
            eq(idempotencyReceipts.scope, scope),
            eq(idempotencyReceipts.requestId, requestId),
          ),
        )
        .for('update')
        .limit(1);

      if (priorReceipt.length > 0) {
        const receipt = priorReceipt[0];
        if (receipt.inputHash !== inputHash) {
          throw new CloudError(
            'REQUEST_ID_CONFLICT',
            'requestId was already used with a different URL import payload',
            { status: 409, applied: false },
          );
        }
        const existingJobId = receipt.resourceId;
        if (existingJobId) {
          const jobRows = await tx
            .select({ state: jobs.state })
            .from(jobs)
            .where(and(eq(jobs.id, existingJobId), eq(jobs.workspaceId, ctx.workspaceId)))
            .limit(1);
          return {
            jobId: existingJobId,
            state: jobRows[0]?.state ?? 'queued',
            replayed: true,
          };
        }
      }

      const jobId = randomUUID();
      const now = new Date();
      await tx.insert(jobs).values(
        asInsert(jobs, {
          id: jobId,
          workspaceId: ctx.workspaceId,
          projectId: input.targetProjectId ?? null,
          kind: 'media_ingest',
          state: 'queued',
          stage: 'queued',
          progress: 0,
          requestId,
          requestHash: inputHash,
          inputPayload: {
            operation: 'url_fetch',
            url: normalizedUrl,
            name,
            targetProjectId: input.targetProjectId ?? null,
            targetAssetId: input.targetAssetId ?? null,
            itemId: input.itemId ?? null,
          },
          createdAt: now,
          updatedAt: now,
        }),
      );

      await tx.insert(idempotencyReceipts).values(
        asInsert(idempotencyReceipts, {
          workspaceId: ctx.workspaceId,
          scope,
          requestId,
          inputHash,
          state: 'completed',
          resourceId: jobId,
          responsePayload: { jobId, url: normalizedUrl },
          createdAt: now,
          updatedAt: now,
        }),
      );

      return { jobId, state: 'queued', replayed: false };
    });

    if (!txOutcome.replayed) {
      try {
        await this.queues.enqueueMediaIngest('url_fetch', {
          jobId: txOutcome.jobId,
          workspaceId: ctx.workspaceId,
          url: normalizedUrl,
          ...(input.targetProjectId ? { targetProjectId: input.targetProjectId } : {}),
          ...(input.targetAssetId ? { targetAssetId: input.targetAssetId } : {}),
          ...(input.parentVersionId ? { parentVersionId: input.parentVersionId } : {}),
          ...(input.itemId ? { itemId: input.itemId } : {}),
          name,
          requestId,
          ...(input.expectedModality ? { expectedModality: input.expectedModality } : {}),
        });
      } catch (error) {
        const failNow = new Date();
        await Promise.allSettled([
          this.db
            .update(jobs)
            .set(
              asUpdate(jobs, {
                state: 'failed',
                stage: 'failed',
                failureStage: 'enqueue',
                errorCode: 'QUEUE_ENQUEUE_FAILED',
                errorMessage: error instanceof Error ? error.message : 'Failed to enqueue url_fetch job',
                terminalAt: failNow,
                updatedAt: failNow,
              }),
            )
            .where(and(eq(jobs.id, txOutcome.jobId), eq(jobs.workspaceId, ctx.workspaceId))),
          this.db
            .delete(idempotencyReceipts)
            .where(
              and(
                eq(idempotencyReceipts.workspaceId, ctx.workspaceId),
                eq(idempotencyReceipts.scope, scope),
                eq(idempotencyReceipts.requestId, requestId),
              ),
            ),
        ]);
        throw error;
      }
    }

    return {
      jobId: txOutcome.jobId,
      state: txOutcome.state,
      url: normalizedUrl,
      replayed: txOutcome.replayed,
    };
  }

  /** List workspace assets with filtering, search, sorting, and pagination. */
  async listAssets(
    ctx: AuthContext,
    input: AssetListInput = {},
  ): Promise<{ assets: LibraryAsset[]; total: number; nextOffset: number | null }> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 60;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid asset pagination parameters', { status: 400 });
    }
    if (input.modality && !ASSET_MODALITY_SET.has(input.modality)) {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid modality filter', { status: 400 });
    }
    if (input.source && input.source !== 'upload' && input.source !== 'generated') {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid source filter', { status: 400 });
    }
    if (input.sort && !['newest', 'oldest', 'name'].includes(input.sort)) {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid sort order', { status: 400 });
    }
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 200)) {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid search query', { status: 400 });
    }

    const conditions = [
      eq(assets.workspaceId, ctx.workspaceId),
      eq(assets.trashed, Boolean(input.trash)),
    ];
    if (input.modality) {
      conditions.push(eq(assets.modality, input.modality));
    }

    const orderBy =
      input.sort === 'name'
        ? [asc(assets.name), desc(assets.updatedAt)]
        : input.sort === 'oldest'
          ? [asc(assets.updatedAt), asc(assets.id)]
          : [desc(assets.updatedAt), desc(assets.id)];

    const assetRows = await this.db
      .select()
      .from(assets)
      .where(and(...conditions))
      .orderBy(...orderBy);

    if (assetRows.length === 0) {
      return { assets: [], total: 0, nextOffset: null };
    }

    const assetIds = assetRows.map((row) => row.id);
    const versionRows = await this.db
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.workspaceId, ctx.workspaceId), inArray(assetVersions.assetId, assetIds)));

    const versionsByAsset = new Map<string, (typeof assetVersions.$inferSelect)[]>();
    for (const row of versionRows) {
      const bucket = versionsByAsset.get(row.assetId) ?? [];
      bucket.push(row);
      versionsByAsset.set(row.assetId, bucket);
    }

    const needle = input.query?.trim().toLowerCase() || '';
    const filtered = assetRows
      .map((row) => toLibraryAssetDto(row, versionsByAsset.get(row.id) ?? []))
      .filter((asset) => {
        if (input.source) {
          const current = asset.versions.find((v) => v.id === asset.currentVersionId) ?? asset.versions.at(-1);
          if (!current || current.source !== input.source) return false;
        }
        if (needle) {
          const haystack = `${asset.name} ${asset.versions.map((v) => `${v.prompt ?? ''} ${v.model ?? ''}`).join(' ')}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      });

    const page = filtered.slice(offset, offset + limit);
    return {
      assets: page,
      total: filtered.length,
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
    };
  }

  /** Fetch one workspace asset and all of its versions. */
  async getAsset(
    ctx: AuthContext,
    assetId: string,
    versionId?: string,
  ): Promise<{ asset: LibraryAsset; version?: AssetVersion }> {
    requireUuid(assetId, 'assetId', 'ASSET_NOT_FOUND');
    if (versionId !== undefined) requireUuid(versionId, 'versionId', 'ASSET_NOT_FOUND');

    const assetRows = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.workspaceId, ctx.workspaceId)))
      .limit(1);

    if (assetRows.length === 0) {
      throw new CloudError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
    }

    const versionRows = await this.db
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.assetId, assetId), eq(assetVersions.workspaceId, ctx.workspaceId)));

    const asset = toLibraryAssetDto(assetRows[0], versionRows);
    if (!versionId) {
      return { asset };
    }
    const version = asset.versions.find((v) => v.id === versionId);
    if (!version) {
      throw new CloudError('ASSET_VERSION_UNAVAILABLE', 'Asset version not found', { status: 404 });
    }
    return { asset, version };
  }

  /** Update asset name, soft-trash state, or active `currentVersionId`. */
  async updateAsset(ctx: AuthContext, assetId: string, patch: AssetUpdatePatch): Promise<LibraryAsset> {
    requireUuid(assetId, 'assetId', 'ASSET_NOT_FOUND');
    if (patch.name !== undefined) validateAssetName(patch.name);
    if (patch.trashed !== undefined && typeof patch.trashed !== 'boolean') {
      throw new CloudError('INVALID_ARGUMENT', 'trashed must be a boolean', { status: 400 });
    }
    if (patch.currentVersionId !== undefined) {
      requireUuid(patch.currentVersionId, 'currentVersionId');
    }

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, ctx.workspaceId)))
        .for('update')
        .limit(1);

      if (existing.length === 0) {
        throw new CloudError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
      }

      if (patch.currentVersionId !== undefined) {
        const versionMatch = await tx
          .select({ id: assetVersions.id })
          .from(assetVersions)
          .where(
            and(
              eq(assetVersions.id, patch.currentVersionId),
              eq(assetVersions.assetId, assetId),
              eq(assetVersions.workspaceId, ctx.workspaceId),
            ),
          )
          .limit(1);
        if (versionMatch.length === 0) {
          throw new CloudError('ASSET_VERSION_UNAVAILABLE', 'Selected version does not belong to this asset', {
            status: 404,
          });
        }
      }

      const now = new Date();
      const updates: Record<string, unknown> = { updatedAt: now };
      if (patch.name !== undefined) updates.name = patch.name.trim();
      if (patch.currentVersionId !== undefined) updates.currentVersionId = patch.currentVersionId;
      if (patch.trashed === true) {
        updates.trashed = true;
        updates.trashedAt = existing[0].trashedAt ?? now;
      } else if (patch.trashed === false) {
        updates.trashed = false;
        updates.trashedAt = null;
      }

      await tx
        .update(assets)
        .set(asUpdate(assets, updates))
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, ctx.workspaceId)));
    });

    const { asset } = await this.getAsset(ctx, assetId);
    return asset;
  }

  /**
   * Soft delete (move to trash) or hard delete an asset.
   * Hard delete removes all `asset_versions` rows and decrements `workspace_blobs.ref_count`
   * atomically in sorted `sha256` order via `applyWorkspaceBlobRefDeltas`.
   */
  async deleteAsset(
    ctx: AuthContext,
    assetId: string,
    options: { permanent?: boolean } = {},
  ): Promise<{ assetId: string; trashed?: boolean; deleted?: boolean; decrementedBlobs?: number }> {
    requireUuid(assetId, 'assetId', 'ASSET_NOT_FOUND');
    if (!options.permanent) {
      await this.updateAsset(ctx, assetId, { trashed: true });
      return { assetId, trashed: true };
    }

    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, ctx.workspaceId)))
        .for('update')
        .limit(1);

      if (existing.length === 0) {
        throw new CloudError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
      }

      const versionRows = await tx
        .select({ sha256: assetVersions.sha256 })
        .from(assetVersions)
        .where(and(eq(assetVersions.assetId, assetId), eq(assetVersions.workspaceId, ctx.workspaceId)));

      // Delete asset first (cascades asset_versions, freeing FK references before refcount decrement).
      await tx
        .delete(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, ctx.workspaceId)));

      if (versionRows.length > 0) {
        await applyWorkspaceBlobRefDeltas(
          tx,
          ctx.workspaceId,
          versionRows.map((row) => ({ sha256: row.sha256, delta: -1 })),
        );
      }

      return { assetId, deleted: true, decrementedBlobs: versionRows.length };
    });
  }

  /**
   * Hard-delete a single version from an asset and decrement its CAS `workspace_blobs.ref_count`
   * atomically via `src/db/cas.ts`.
   */
  async deleteAssetVersion(
    ctx: AuthContext,
    assetId: string,
    versionId: string,
  ): Promise<{ assetId: string; versionId: string; deleted: boolean; remainingVersions: number }> {
    requireUuid(assetId, 'assetId', 'ASSET_NOT_FOUND');
    requireUuid(versionId, 'versionId', 'ASSET_NOT_FOUND');

    return this.db.transaction(async (tx) => {
      const assetRows = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, ctx.workspaceId)))
        .for('update')
        .limit(1);

      if (assetRows.length === 0) {
        throw new CloudError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
      }

      const versions = await tx
        .select()
        .from(assetVersions)
        .where(and(eq(assetVersions.assetId, assetId), eq(assetVersions.workspaceId, ctx.workspaceId)))
        .orderBy(asc(assetVersions.createdAt));

      const target = versions.find((row) => row.id === versionId);
      if (!target) {
        throw new CloudError('ASSET_VERSION_UNAVAILABLE', 'Asset version not found', { status: 404 });
      }

      const remaining = versions.filter((row) => row.id !== versionId);
      if (remaining.length === 0) {
        // Delete the parent asset cleanly when removing its sole version.
        await tx
          .delete(assets)
          .where(and(eq(assets.id, assetId), eq(assets.workspaceId, ctx.workspaceId)));
      } else {
        await tx
          .delete(assetVersions)
          .where(and(eq(assetVersions.id, versionId), eq(assetVersions.workspaceId, ctx.workspaceId)));

        if (assetRows[0].currentVersionId === versionId) {
          const nextCurrent = remaining.at(-1)!;
          await tx
            .update(assets)
            .set(asUpdate(assets, { currentVersionId: nextCurrent.id, updatedAt: new Date() }))
            .where(and(eq(assets.id, assetId), eq(assets.workspaceId, ctx.workspaceId)));
        }
      }

      await applyWorkspaceBlobRefDeltas(tx, ctx.workspaceId, [{ sha256: target.sha256, delta: -1 }]);

      return {
        assetId,
        versionId,
        deleted: true,
        remainingVersions: remaining.length,
      };
    });
  }

  /**
   * Resolve PG + CAS metadata for an asset version (used directly for `HEAD` responses
   * without signing or redirecting to S3).
   */
  async getAssetVersionMetadata(
    ctx: AuthContext,
    reference: AssetReference,
    options: { allowTrash?: boolean } = {},
  ): Promise<AssetFileMetadata> {
    requireUuid(reference.assetId, 'assetId', 'ASSET_NOT_FOUND');
    requireUuid(reference.versionId, 'versionId', 'ASSET_NOT_FOUND');

    const rows = await this.db
      .select({
        assetTrashed: assets.trashed,
        versionId: assetVersions.id,
        assetId: assetVersions.assetId,
        filename: assetVersions.filename,
        mimeType: assetVersions.mimeType,
        sizeBytes: assetVersions.sizeBytes,
        sha256: assetVersions.sha256,
        blobMetadata: workspaceBlobs.metadata,
      })
      .from(assetVersions)
      .innerJoin(
        assets,
        and(eq(assets.id, assetVersions.assetId), eq(assets.workspaceId, assetVersions.workspaceId)),
      )
      .leftJoin(
        workspaceBlobs,
        and(
          eq(workspaceBlobs.workspaceId, assetVersions.workspaceId),
          eq(workspaceBlobs.sha256, assetVersions.sha256),
        ),
      )
      .where(
        and(
          eq(assetVersions.workspaceId, ctx.workspaceId),
          eq(assetVersions.assetId, reference.assetId),
          eq(assetVersions.id, reference.versionId),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      throw new CloudError('ASSET_VERSION_UNAVAILABLE', 'Asset version not found', { status: 404 });
    }
    const row = rows[0];
    if (row.assetTrashed && !options.allowTrash) {
      throw new CloudError('ASSET_VERSION_UNAVAILABLE', 'Asset is in trash', { status: 404 });
    }

    const s3Key = workspaceBlobKey(ctx.workspaceId, row.sha256);
    assertTenantScopedKey(ctx.workspaceId, s3Key);

    return {
      assetId: row.assetId,
      versionId: row.versionId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      sha256: row.sha256,
      etag: `"sha256:${row.sha256}"`,
      s3Key,
      metadata: row.blobMetadata ?? null,
    };
  }

  /** Mint a short-lived Presigned GET URL for an asset version (`302` download or inline media). */
  async presignAssetVersionGet(
    ctx: AuthContext,
    reference: AssetReference,
    options: { download?: boolean; allowTrash?: boolean; expiresInSec?: number } = {},
  ): Promise<PresignedAssetUrlResult> {
    const metadata = await this.getAssetVersionMetadata(ctx, reference, {
      allowTrash: options.allowTrash ?? true,
    });
    const expiresInSec = options.expiresInSec ?? this.presignGetTtlSec;
    const disposition = options.download
      ? `attachment; filename="${contentDispositionFilename(metadata.filename)}"`
      : `inline; filename="${contentDispositionFilename(metadata.filename)}"`;

    const url = await this.storage.presignGet(metadata.s3Key, {
      expiresInSec,
      responseContentType: metadata.mimeType,
      responseContentDisposition: disposition,
    });
    return { url, metadata, expiresInSec };
  }

  /**
   * Resolve thumbnail S3 metadata or Presigned GET URL for an asset version.
   * Falls back to original image blob when thumbnail is not yet generated.
   */
  async resolveAssetThumbnail(
    ctx: AuthContext,
    reference: AssetReference,
    options: { spec?: string; width?: number; enqueueOnMiss?: boolean; expiresInSec?: number; skipPresign?: boolean } = {},
  ): Promise<{
    url: string;
    contentType: string;
    contentLength: number;
    etag: string;
    cached: boolean;
    expiresInSec: number;
  }> {
    const spec = options.spec ?? 'w320';
    const metadata = await this.getAssetVersionMetadata(ctx, reference, { allowTrash: true });
    const thumbKey = thumbnailKey(ctx.workspaceId, metadata.sha256, spec);
    assertTenantScopedKey(ctx.workspaceId, thumbKey);
    const expiresInSec = options.expiresInSec ?? this.presignGetTtlSec;

    const thumbHead = await this.storage.headObject(thumbKey);
    if (thumbHead && thumbHead.contentLength > 0) {
      const url = options.skipPresign
        ? ''
        : await this.storage.presignGet(thumbKey, {
            expiresInSec,
            responseContentType: thumbHead.contentType ?? 'image/jpeg',
          });
      return {
        url,
        contentType: thumbHead.contentType ?? 'image/jpeg',
        contentLength: thumbHead.contentLength,
        etag: thumbHead.etag ?? metadata.etag,
        cached: true,
        expiresInSec,
      };
    }

    if (options.enqueueOnMiss !== false && (metadata.mimeType.startsWith('image/') || metadata.mimeType.startsWith('video/'))) {
      await this.queues
        .enqueueMediaIngest('image_thumbnail', {
          workspaceId: ctx.workspaceId,
          blobScope: 'workspace',
          sha256: metadata.sha256,
          spec,
          width: options.width ?? 320,
        })
        .catch(() => {});
    }

    if (metadata.mimeType.startsWith('image/')) {
      const url = options.skipPresign
        ? ''
        : await this.storage.presignGet(metadata.s3Key, {
            expiresInSec,
            responseContentType: metadata.mimeType,
          });
      return {
        url,
        contentType: metadata.mimeType,
        contentLength: metadata.sizeBytes,
        etag: metadata.etag,
        cached: false,
        expiresInSec,
      };
    }

    throw new CloudError('NOT_FOUND', 'Thumbnail is being generated and is not yet available', {
      status: 404,
      details: { spec, assetId: reference.assetId, versionId: reference.versionId },
    });
  }

  /** Helper query verifying workspace has active non-trashed asset versions for references. */
  async resolveReferences(
    ctx: AuthContext,
    references: readonly AssetReference[],
  ): Promise<Array<AssetFileMetadata & { modality: AssetModality }>> {
    const resolved: Array<AssetFileMetadata & { modality: AssetModality }> = [];
    for (const ref of references) {
      const meta = await this.getAssetVersionMetadata(ctx, ref, { allowTrash: false });
      const assetRows = await this.db
        .select({ modality: assets.modality })
        .from(assets)
        .where(and(eq(assets.id, ref.assetId), eq(assets.workspaceId, ctx.workspaceId)))
        .limit(1);
      if (assetRows.length === 0) {
        throw new CloudError('ASSET_NOT_FOUND', 'Referenced asset not found', { status: 404 });
      }
      resolved.push({ ...meta, modality: assetRows[0].modality });
    }
    return resolved;
  }
}

export function isSqlUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = err.code ?? err.cause?.code;
  const constraint = err.constraint ?? err.cause?.constraint;
  if (code !== '23505') return false;
  if (constraintName && constraint && constraint !== constraintName) return false;
  return true;
}

export function normalizeSqlCount(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function sqlNowExpr() {
  return sql`now()`;
}
