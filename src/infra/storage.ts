import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CloudError } from '../contracts/errors.ts';
import {
  S3_CANONICAL_CORS_SPEC,
  type HeadObjectResult,
  type MultipartPartInfo,
  type ObjectStreamResult,
  type PresignGetOptions,
  type PresignPutOptions,
  type PresignUploadPartOptions,
  type StoragePort,
} from '../contracts/storage.ts';
import { isSha256Hex, isUuid } from '../../shared/project-validation.ts';

const SAFE_SPEC_REGEX = /^[a-z0-9_-]{1,64}$/;
const SAFE_SEGMENT_REGEX = /^[a-zA-Z0-9._-]{1,160}$/;
const HEAD_SKIP_THRESHOLD_BYTES = 256 * 1024;
const MAX_SIGV4_PRESIGN_EXPIRES_SEC = 604_800;

export const DEFAULT_PRESIGN_CACHE_WINDOW_SEC = 3600;
export const IMMUTABLE_PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const IMMUTABLE_PRIVATE_CACHE_CONTROL = 'private, max-age=31536000, immutable';

const CATALOG_CAS_KEY_REGEX = /^catalog\/blobs\/[a-f0-9]{64}$/;
const WORKSPACE_IMMUTABLE_CAS_KEY_REGEX =
  /^workspaces\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/(?:blobs\/[a-f0-9]{64}|(?:thumbnails|derived)\/[a-f0-9]{64}\/[^/]+)$/;

export function isCatalogCasKey(key: string): boolean {
  return CATALOG_CAS_KEY_REGEX.test(key);
}

/**
 * Returns true for content-addressed immutable object keys whose bytes never change at that key:
 * - `workspaces/{wid}/blobs/{sha256}`
 * - `catalog/blobs/{sha256}`
 * - `workspaces/{wid}/thumbnails/{sha256}/*`
 * - `workspaces/{wid}/derived/{sha256}/*`
 */
export function isImmutableCasKey(key: string): boolean {
  return CATALOG_CAS_KEY_REGEX.test(key) || WORKSPACE_IMMUTABLE_CAS_KEY_REGEX.test(key);
}

/** Floor an epoch timestamp (ms) down to the start of its fixed UTC window boundary. */
export function floorSigningDate(nowMs: number, windowSec: number): Date {
  const bucketMs = windowSec * 1000;
  return new Date(Math.floor(nowMs / bucketMs) * bucketMs);
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) {
    throw new CloudError('INVALID_PATH', `${label} must be a valid UUID`, { status: 400, applied: false });
  }
}

function assertSha256(value: string): void {
  if (!isSha256Hex(value)) {
    throw new CloudError('INVALID_PATH', 'sha256 must be a 64-character lowercase hex digest', {
      status: 400,
      applied: false,
    });
  }
}

function assertSafeSegment(value: string, label: string, pattern = SAFE_SEGMENT_REGEX): void {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..') ||
    !pattern.test(value)
  ) {
    throw new CloudError('INVALID_PATH', `Unsafe storage key segment for ${label}`, {
      status: 400,
      applied: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Canonical Tenant-Scoped Keyspace Builders (Frozen per #8 and #11)
// ---------------------------------------------------------------------------

export function workspaceBlobKey(workspaceId: string, sha256: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertSha256(sha256);
  return `workspaces/${workspaceId}/blobs/${sha256}`;
}

export function catalogBlobKey(sha256: string): string {
  assertSha256(sha256);
  return `catalog/blobs/${sha256}`;
}

export function uploadStagingKey(workspaceId: string, uploadId: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertUuid(uploadId, 'uploadId');
  return `workspaces/${workspaceId}/uploads/${uploadId}`;
}

export function uploadLicenseStagingKey(workspaceId: string, uploadId: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertUuid(uploadId, 'uploadId');
  return `workspaces/${workspaceId}/uploads/${uploadId}.license`;
}

export function thumbnailKey(workspaceId: string, sha256: string, spec: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertSha256(sha256);
  assertSafeSegment(spec, 'thumbnail spec', SAFE_SPEC_REGEX);
  return `workspaces/${workspaceId}/thumbnails/${sha256}/${spec}.jpg`;
}

export function derivedAssetKey(workspaceId: string, sha256: string, name: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertSha256(sha256);
  assertSafeSegment(name, 'derived asset name');
  return `workspaces/${workspaceId}/derived/${sha256}/${name}`;
}

export function compThumbnailKey(workspaceId: string, projectId: string, key: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertUuid(projectId, 'projectId');
  assertSafeSegment(key, 'composition thumbnail key');
  return `workspaces/${workspaceId}/comp-thumbs/${projectId}/${key}.png`;
}

export function exportKey(workspaceId: string, jobId: string, name: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertUuid(jobId, 'jobId');
  assertSafeSegment(name, 'export filename');
  return `workspaces/${workspaceId}/exports/${jobId}/${name}`;
}

export function archiveKey(workspaceId: string, archiveId: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertUuid(archiveId, 'archiveId');
  return `workspaces/${workspaceId}/archives/${archiveId}.zip`;
}

export function blobThumbnailsPrefix(workspaceId: string, sha256: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertSha256(sha256);
  return `workspaces/${workspaceId}/thumbnails/${sha256}/`;
}

export function blobDerivedPrefix(workspaceId: string, sha256: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertSha256(sha256);
  return `workspaces/${workspaceId}/derived/${sha256}/`;
}

/**
 * Defense-in-depth guard ensuring an object key belongs strictly to `workspaceId`
 * (or read-only `catalog/blobs/` when explicitly permitted) with zero path traversal.
 */
export function assertTenantScopedKey(
  workspaceId: string,
  key: string,
  options: { allowCatalog?: boolean } = {},
): string {
  assertUuid(workspaceId, 'workspaceId');
  if (
    !key ||
    key.startsWith('/') ||
    key.includes('\\') ||
    /[\x00-\x1f]/.test(key) ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new CloudError('INVALID_PATH', 'Storage key contains invalid segments or traversal', {
      status: 400,
      applied: false,
    });
  }
  const tenantPrefix = `workspaces/${workspaceId}/`;
  if (key.startsWith(tenantPrefix)) return key;
  if (options.allowCatalog && /^catalog\/blobs\/[a-f0-9]{64}$/.test(key)) return key;
  throw new CloudError('WORKSPACE_FORBIDDEN', 'Storage key escapes workspace tenant boundary', {
    status: 403,
    applied: false,
  });
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Compute S3 bucket CORS `AllowedOrigins`.
 * Loopback dev origins receive their matching `127.0.0.1`/`localhost` sibling on the same port,
 * while non-loopback (e.g. production `https://`) origins NEVER leak localhost entries.
 */
export function resolveCorsAllowedOrigins(
  publicOrigin?: string,
  extraOrigins: readonly string[] = [],
): string[] {
  const cleanedExtras = extraOrigins.map((origin) => origin.trim()).filter(Boolean);
  const trimmedPrimary = publicOrigin?.trim();
  if (!trimmedPrimary) {
    return [...new Set(['http://127.0.0.1:4173', 'http://localhost:4173', ...cleanedExtras])];
  }

  const parsed = new URL(trimmedPrimary);
  const normalizedOrigin = parsed.origin;
  if (LOOPBACK_HOSTS.has(parsed.hostname)) {
    const portSuffix = parsed.port ? `:${parsed.port}` : '';
    const siblingHost = parsed.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    const siblingOrigin = `${parsed.protocol}//${siblingHost}${portSuffix}`;
    return [...new Set([normalizedOrigin, siblingOrigin, ...cleanedExtras])];
  }

  return [...new Set([normalizedOrigin, ...cleanedExtras])];
}

// ---------------------------------------------------------------------------
// StorageService Implementation (Dual Internal + Public Presigner Clients)
// ---------------------------------------------------------------------------

export interface StorageServiceOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  publicEndpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  defaultPresignPutTtlSec?: number;
  defaultPresignGetTtlSec?: number;
  defaultPresignCacheWindowSec?: number;
  publicOrigin?: string;
}

export interface StoragePresignGetOptions extends PresignGetOptions {
  /** Fixed UTC signing window in seconds for cacheable presigned URLs. Pass `0` to opt out. */
  cacheWindowSec?: number;
  /** Explicitly mark the target key as immutable (auto-detected for CAS keys when omitted). */
  immutable?: boolean;
  /** Override `ResponseCacheControl` sent by S3 on GET responses. */
  responseCacheControl?: string;
  /** Optional epoch millisecond clock override for deterministic tests. */
  nowMs?: number;
}

function isNotFoundS3Error(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    err.name === 'NotFound' ||
    err.name === 'NoSuchKey' ||
    err.name === 'NoSuchBucket' ||
    err.Code === 'NoSuchKey' ||
    err.Code === 'NoSuchBucket' ||
    err.$metadata?.httpStatusCode === 404
  );
}

function buildS3Client(options: StorageServiceOptions, endpoint?: string): S3Client {
  return new S3Client({
    region: options.region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: options.forcePathStyle ?? true,
    // Avoid injecting unsigned/empty CRC32 query params on presigned PUT & UploadPart URLs for S3-compatible gateways.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
  });
}

export class StorageService implements StoragePort {
  readonly bucket: string;
  readonly internalClient: S3Client;
  readonly signerClient: S3Client;
  private readonly defaultPresignPutTtlSec: number;
  private readonly defaultPresignGetTtlSec: number;
  private readonly defaultPresignCacheWindowSec: number;
  private readonly publicOrigin?: string;

  constructor(options: StorageServiceOptions) {
    this.bucket = options.bucket;
    this.internalClient = buildS3Client(options, options.endpoint);
    const signerEndpoint = options.publicEndpoint ?? options.endpoint;
    this.signerClient =
      signerEndpoint === options.endpoint
        ? this.internalClient
        : buildS3Client(options, signerEndpoint);
    this.defaultPresignPutTtlSec = options.defaultPresignPutTtlSec ?? 900;
    this.defaultPresignGetTtlSec = options.defaultPresignGetTtlSec ?? 300;
    this.defaultPresignCacheWindowSec =
      options.defaultPresignCacheWindowSec ?? DEFAULT_PRESIGN_CACHE_WINDOW_SEC;
    this.publicOrigin = options.publicOrigin;
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | Readable | string,
    contentType: string,
    contentLength?: number,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
      }),
    );
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    if (body.byteLength >= HEAD_SKIP_THRESHOLD_BYTES) {
      const existing = await this.headObject(key);
      if (existing && existing.contentLength === body.byteLength) {
        return { uploaded: false };
      }
    }
    await this.putObject(key, body, contentType, body.byteLength);
    return { uploaded: true };
  }

  async putBlobIfAbsentStream(
    key: string,
    createStream: () => Readable,
    sizeBytes: number,
    contentType: string,
  ): Promise<{ uploaded: boolean }> {
    if (sizeBytes >= HEAD_SKIP_THRESHOLD_BYTES) {
      const existing = await this.headObject(key);
      if (existing && existing.contentLength === sizeBytes) {
        return { uploaded: false };
      }
    }
    await this.putObject(key, createStream(), contentType, sizeBytes);
    return { uploaded: true };
  }

  async copyObject(sourceKey: string, destinationKey: string, contentType?: string): Promise<void> {
    const encodedSource = `${encodeURIComponent(this.bucket)}/${sourceKey
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')}`;
    await this.internalClient.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: encodedSource,
        ...(contentType
          ? {
              MetadataDirective: 'REPLACE',
              ContentType: contentType,
            }
          : {}),
      }),
    );
  }

  async getObjectBuffer(key: string, maxBytes?: number): Promise<Buffer> {
    const response = await this.internalClient.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    if (!response.Body) {
      throw new CloudError('STORAGE_ERROR', `Empty S3 response body for ${key}`, { status: 502 });
    }
    if (maxBytes !== undefined && response.ContentLength !== undefined && response.ContentLength > maxBytes) {
      throw new CloudError('INVALID_ARGUMENT', `Object ${key} exceeds maximum size of ${maxBytes} bytes`, {
        status: 413,
      });
    }
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        stream.destroy();
        throw new CloudError('INVALID_ARGUMENT', `Object ${key} exceeds maximum size of ${maxBytes} bytes`, {
          status: 413,
        });
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  async getObjectStream(key: string, range?: string): Promise<ObjectStreamResult> {
    const response = await this.internalClient.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: range } : {}),
      }),
    );
    if (!response.Body) {
      throw new CloudError('STORAGE_ERROR', `Empty S3 stream body for ${key}`, { status: 502 });
    }
    return {
      stream: response.Body as Readable,
      contentLength: response.ContentLength,
      contentType: response.ContentType,
      etag: response.ETag,
      contentRange: response.ContentRange,
    };
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    try {
      const response = await this.internalClient.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return {
        contentLength: response.ContentLength ?? 0,
        contentType: response.ContentType,
        etag: response.ETag,
      };
    } catch (error) {
      if (isNotFoundS3Error(error)) return null;
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix || prefix === '/' || !prefix.endsWith('/')) {
      throw new CloudError('INVALID_PATH', 'deletePrefix requires a non-root trailing-slash prefix', {
        status: 400,
      });
    }
    let deleted = 0;
    let continuationToken: string | undefined;
    do {
      const listed = await this.internalClient.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (listed.Contents ?? []).map((item) => item.Key).filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        await this.internalClient.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += keys.length;
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
    return deleted;
  }

  async presignPut(key: string, options: PresignPutOptions): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options.contentType,
      ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
    });
    return getSignedUrl(this.signerClient, command, {
      expiresIn: options.expiresInSec ?? this.defaultPresignPutTtlSec,
    });
  }

  async presignGet(key: string, options: StoragePresignGetOptions = {}): Promise<string> {
    const immutable = options.immutable ?? isImmutableCasKey(key);
    const rawWindowSec =
      options.cacheWindowSec !== undefined
        ? options.cacheWindowSec
        : immutable
          ? this.defaultPresignCacheWindowSec
          : 0;
    const windowSec = Math.max(0, Math.floor(rawWindowSec));
    const requestedExpiresIn = options.expiresInSec ?? this.defaultPresignGetTtlSec;
    const useAlignedWindow = windowSec > 0 && (immutable || options.cacheWindowSec !== undefined);

    const signingDate = useAlignedWindow
      ? floorSigningDate(options.nowMs ?? Date.now(), windowSec)
      : undefined;
    const expiresIn = useAlignedWindow
      ? Math.min(MAX_SIGV4_PRESIGN_EXPIRES_SEC, Math.max(requestedExpiresIn, windowSec * 2))
      : requestedExpiresIn;

    const responseCacheControl =
      options.responseCacheControl ??
      (immutable
        ? isCatalogCasKey(key)
          ? IMMUTABLE_PUBLIC_CACHE_CONTROL
          : IMMUTABLE_PRIVATE_CACHE_CONTROL
        : undefined);

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.responseContentDisposition
        ? { ResponseContentDisposition: options.responseContentDisposition }
        : {}),
      ...(options.responseContentType ? { ResponseContentType: options.responseContentType } : {}),
      ...(responseCacheControl ? { ResponseCacheControl: responseCacheControl } : {}),
    });
    return getSignedUrl(this.signerClient, command, {
      expiresIn,
      ...(signingDate ? { signingDate } : {}),
    });
  }

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const res = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) {
      throw new CloudError('STORAGE_ERROR', 'S3 CreateMultipartUpload did not return UploadId', {
        status: 502,
      });
    }
    return { uploadId: res.UploadId };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: PresignUploadPartOptions = {},
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
    });
    return getSignedUrl(this.signerClient, command, {
      expiresIn: options.expiresInSec ?? this.defaultPresignPutTtlSec,
    });
  }

  async listMultipartParts(key: string, uploadId: string): Promise<MultipartPartInfo[]> {
    const parts: MultipartPartInfo[] = [];
    let partNumberMarker: string | undefined;
    do {
      const res = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          ...(partNumberMarker ? { PartNumberMarker: partNumberMarker } : {}),
        }),
      );
      for (const item of res.Parts ?? []) {
        if (typeof item.PartNumber === 'number' && typeof item.ETag === 'string' && item.ETag.length > 0) {
          parts.push({
            partNumber: item.PartNumber,
            etag: item.ETag,
            ...(typeof item.Size === 'number' ? { size: item.Size } : {}),
          });
        }
      }
      partNumberMarker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (partNumberMarker);
    parts.sort((a, b) => a.partNumber - b.partNumber);
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<void> {
    const sorted = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({
        PartNumber: p.partNumber,
        ETag: p.etag,
      }));
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sorted },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      const err = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
      if (
        err?.name === 'NoSuchUpload' ||
        err?.Code === 'NoSuchUpload' ||
        err?.$metadata?.httpStatusCode === 404
      ) {
        return;
      }
      throw error;
    }
  }

  /**
   * Configure S3 bucket lifecycle to automatically abort orphaned incomplete multipart uploads
   * so abandoned browser/MCP uploads cannot accumulate hidden storage billing.
   */
  async ensureBucketLifecycle(abortIncompleteMultipartDays = 1): Promise<void> {
    const days = Math.max(1, Math.floor(abortIncompleteMultipartDays));
    await this.internalClient.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'abort-incomplete-multipart-uploads',
              Status: 'Enabled',
              Filter: { Prefix: '' },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: days },
            },
          ],
        },
      }),
    );
  }

  /**
   * Ensure the configured S3 bucket exists and apply the canonical CORS rule + multipart
   * orphan lifecycle cleanup required by browser direct/multipart uploads and 302 presigned GET playback.
   */
  async ensureBucketAndCors(allowedOrigins?: readonly string[]): Promise<void> {
    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isNotFoundS3Error(error)) throw error;
      await this.internalClient.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }

    const origins = allowedOrigins?.length
      ? [...new Set(allowedOrigins.map((origin) => origin.trim()).filter(Boolean))]
      : resolveCorsAllowedOrigins(this.publicOrigin);

    await this.internalClient.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins,
              AllowedMethods: [...S3_CANONICAL_CORS_SPEC.AllowedMethods],
              AllowedHeaders: [...S3_CANONICAL_CORS_SPEC.AllowedHeaders],
              ExposeHeaders: [...S3_CANONICAL_CORS_SPEC.ExposeHeaders],
              MaxAgeSeconds: S3_CANONICAL_CORS_SPEC.MaxAgeSeconds,
            },
          ],
        },
      }),
    );

    // Best-effort lifecycle rule for incomplete multipart uploads (supported by AWS S3, RustFS, MinIO, R2, OSS).
    await this.ensureBucketLifecycle(1).catch(() => {});
  }

  close(): void {
    this.internalClient.destroy();
    if (this.signerClient !== this.internalClient) {
      this.signerClient.destroy();
    }
  }
}
