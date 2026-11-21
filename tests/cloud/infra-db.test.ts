import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  DEFAULT_PAT_SCOPES,
  PAT_SCOPES,
  WORKSPACE_ROLES,
  hasMinRole,
  hasScope,
  type AuthContext,
} from '../../src/contracts/auth.ts';
import {
  CloudError,
  featureDeferredP2,
  isCloudError,
  quotaExceeded,
  revisionConflict,
  workspaceForbidden,
} from '../../src/contracts/errors.ts';
import { DEFAULT_BLOB_GC_GRACE_SECONDS, QUEUE_NAMES } from '../../src/contracts/jobs.ts';
import { S3_CANONICAL_CORS_SPEC } from '../../src/contracts/storage.ts';
import {
  finalizeBlobDeletion,
  markUnreferencedBlobsForDeletion,
  markZeroRefForDeletion,
  normalizeBlobRefDeltas,
  reconcileDriftedBlobRefCounts,
} from '../../src/db/cas.ts';
import type { Database } from '../../src/db/client.ts';
import { parseConfig } from '../../src/infra/config.ts';
import { createLogger, redactString, redactValue } from '../../src/infra/logger.ts';
import {
  QUEUE_DEFAULT_JOB_OPTIONS,
  buildPreviewProxyJobId,
  buildRenderThumbnailJobId,
  validateBlobGcPayload,
  validateMediaGeneratePayload,
  validateMediaIngestPayload,
  validateRenderExportPayload,
} from '../../src/infra/queues.ts';
import {
  RENDER_WORKER_HEALTH_KEY,
  buildRedisOptions,
  cancelChannel,
  fontCssCacheKey,
  jobChannel,
  mcpEventsChannel,
  mcpSessionKey,
  projectChannel,
  selectionChannel,
  textCacheKey,
} from '../../src/infra/redis.ts';
import { ShutdownCoordinator } from '../../src/infra/shutdown.ts';
import {
  DEFAULT_PRESIGN_CACHE_WINDOW_SEC,
  IMMUTABLE_PRIVATE_CACHE_CONTROL,
  IMMUTABLE_PUBLIC_CACHE_CONTROL,
  StorageService,
  archiveKey,
  assertTenantScopedKey,
  blobDerivedPrefix,
  blobThumbnailsPrefix,
  catalogBlobKey,
  compThumbnailKey,
  derivedAssetKey,
  exportKey,
  floorSigningDate,
  isCatalogCasKey,
  isImmutableCasKey,
  resolveCorsAllowedOrigins,
  thumbnailKey,
  uploadLicenseStagingKey,
  uploadStagingKey,
  workspaceBlobKey,
} from '../../src/infra/storage.ts';
import {
  Conflict,
  computeProjectRevision,
  isSha256Hex,
  isTextProjectPath,
  isUuid,
  projectPath,
  validateProjectTitle,
  validateStableRequestId,
} from '../../shared/project-validation.ts';
import { VERSION } from '../../shared/version.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WID_A = '11111111-1111-4111-8111-111111111111';
const WID_B = '22222222-2222-4222-8222-222222222222';
const PID_A = '33333333-3333-4333-8333-333333333333';
const JID_A = '44444444-4444-4444-8444-444444444444';
const VID_A = '55555555-5555-4555-8555-555555555555';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function baseDevEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    WORKER_ROLE: 'api',
    AUTH_MODE: 'dev',
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_BUCKET: 'openmotion',
    ...overrides,
  };
}

describe('P1 Infra Config Validation & Safety Latch', () => {
  it('parses valid dev config with canonical defaults', () => {
    const config = parseConfig(baseDevEnv());
    assert.equal(config.APP_PUBLIC_ORIGIN, 'http://127.0.0.1:4173');
    assert.equal(config.PORT, 4173);
    assert.equal(config.AUTH_MODE, 'dev');
    assert.equal(config.MCP_MAX_BODY_BYTES, 10_485_760);
    assert.equal(config.OPENDESIGN_BILLING_SYNC_ENABLED, false);
    assert.equal(config.ALLOW_DOH_FAKEIP_FALLBACK, false);
    assert.equal(config.S3_PRESIGN_PUT_TTL_SEC, 900);
    assert.equal(config.S3_PRESIGN_GET_TTL_SEC, 300);
  });

  it('refuses startup when NODE_ENV=production and AUTH_MODE=dev without explicit override', () => {
    assert.throws(
      () => parseConfig(baseDevEnv({ NODE_ENV: 'production', AUTH_MODE: 'dev' })),
      /INSECURE_CONFIG/,
    );
    const overridden = parseConfig(
      baseDevEnv({ NODE_ENV: 'production', AUTH_MODE: 'dev', ALLOW_INSECURE_DEV_AUTH: 'true' }),
    );
    assert.equal(overridden.ALLOW_INSECURE_DEV_AUTH, true);
  });

  it('requires OIDC env vars when AUTH_MODE=oidc on api role', () => {
    assert.throws(
      () => parseConfig(baseDevEnv({ AUTH_MODE: 'oidc' })),
      /AUTH_MODE=oidc requires OIDC_ISSUER, OIDC_CLIENT_ID, SESSION_SECRET/,
    );
    const validOidc = parseConfig(
      baseDevEnv({
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://id.open-design.ai',
        OIDC_CLIENT_ID: 'openmotion-cloud',
        SESSION_SECRET: '0'.repeat(32),
      }),
    );
    assert.equal(validOidc.AUTH_MODE, 'oidc');
    assert.equal(validOidc.OIDC_CLAIM_SUB, 'sub');
  });

  it('requires OPENDESIGN_S2S_API_KEY when MODEL_GATEWAY_MODE=opendesign on api or media worker', () => {
    assert.throws(
      () => parseConfig(baseDevEnv({ MODEL_GATEWAY_MODE: 'opendesign' })),
      /OPENDESIGN_S2S_API_KEY/,
    );
    // worker-render must NOT require OPENDESIGN_S2S_API_KEY (secret isolation #11 §5).
    const renderWorker = parseConfig(
      baseDevEnv({ WORKER_ROLE: 'render', MODEL_GATEWAY_MODE: 'opendesign', AUTH_MODE: 'oidc' }),
    );
    assert.equal(renderWorker.WORKER_ROLE, 'render');
  });
});

describe('S3 Tenant-Scoped Keyspace, Dual Clients & CORS Spec', () => {
  it('builds exact frozen tenant and catalog keys', () => {
    assert.equal(workspaceBlobKey(WID_A, SHA_A), `workspaces/${WID_A}/blobs/${SHA_A}`);
    assert.equal(catalogBlobKey(SHA_A), `catalog/blobs/${SHA_A}`);
    assert.equal(uploadStagingKey(WID_A, JID_A), `workspaces/${WID_A}/uploads/${JID_A}`);
    assert.equal(uploadLicenseStagingKey(WID_A, JID_A), `workspaces/${WID_A}/uploads/${JID_A}.license`);
    assert.equal(thumbnailKey(WID_A, SHA_A, 'w320_t0'), `workspaces/${WID_A}/thumbnails/${SHA_A}/w320_t0.jpg`);
    assert.equal(derivedAssetKey(WID_A, SHA_A, 'peaks.json'), `workspaces/${WID_A}/derived/${SHA_A}/peaks.json`);
    assert.equal(compThumbnailKey(WID_A, PID_A, 'main_0'), `workspaces/${WID_A}/comp-thumbs/${PID_A}/main_0.png`);
    assert.equal(exportKey(WID_A, JID_A, 'final.mp4'), `workspaces/${WID_A}/exports/${JID_A}/final.mp4`);
    assert.equal(archiveKey(WID_A, JID_A), `workspaces/${WID_A}/archives/${JID_A}.zip`);
    assert.equal(blobThumbnailsPrefix(WID_A, SHA_A), `workspaces/${WID_A}/thumbnails/${SHA_A}/`);
    assert.equal(blobDerivedPrefix(WID_A, SHA_A), `workspaces/${WID_A}/derived/${SHA_A}/`);
  });

  it('rejects path traversal, invalid identifiers, and cross-tenant key access', () => {
    assert.throws(() => workspaceBlobKey('not-a-uuid', SHA_A), { code: 'INVALID_PATH' });
    assert.throws(() => workspaceBlobKey(WID_A, 'deadbeef'), { code: 'INVALID_PATH' });
    assert.throws(() => derivedAssetKey(WID_A, SHA_A, '../escape.bin'), { code: 'INVALID_PATH' });
    assert.throws(() => compThumbnailKey(WID_A, PID_A, 'a/b'), { code: 'INVALID_PATH' });
    assert.throws(() => exportKey(WID_A, JID_A, '..'), { code: 'INVALID_PATH' });

    assert.equal(
      assertTenantScopedKey(WID_A, workspaceBlobKey(WID_A, SHA_A)),
      `workspaces/${WID_A}/blobs/${SHA_A}`,
    );
    assert.equal(
      assertTenantScopedKey(WID_A, catalogBlobKey(SHA_A), { allowCatalog: true }),
      `catalog/blobs/${SHA_A}`,
    );
    assert.throws(() => assertTenantScopedKey(WID_A, catalogBlobKey(SHA_A)), { code: 'WORKSPACE_FORBIDDEN' });
    assert.throws(() => assertTenantScopedKey(WID_A, workspaceBlobKey(WID_B, SHA_A)), { code: 'WORKSPACE_FORBIDDEN' });
    assert.throws(
      () => assertTenantScopedKey(WID_A, `workspaces/${WID_A}/../${WID_B}/blobs/${SHA_A}`),
      { code: 'INVALID_PATH' },
    );
  });

  it('uses separate internalClient and signerClient when S3_PUBLIC_ENDPOINT differs', async () => {
    const storage = new StorageService({
      bucket: 'openmotion',
      region: 'us-east-1',
      endpoint: 'http://s3:9000',
      publicEndpoint: 'http://127.0.0.1:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      forcePathStyle: true,
    });
    try {
      assert.notEqual(storage.internalClient, storage.signerClient);
      const signed = await storage.presignGet(workspaceBlobKey(WID_A, SHA_A));
      assert.ok(signed.startsWith('http://127.0.0.1:9000/openmotion/workspaces/'));
    } finally {
      storage.close();
    }
  });

  it('freezes canonical S3 CORS headers required by mediabunny and Studio playback', () => {
    assert.deepEqual([...S3_CANONICAL_CORS_SPEC.AllowedMethods], ['GET', 'HEAD', 'PUT']);
    assert.deepEqual([...S3_CANONICAL_CORS_SPEC.AllowedHeaders], [
      'Range',
      'If-None-Match',
      'If-Match',
      'Content-Type',
      'Content-Length',
    ]);
    assert.deepEqual([...S3_CANONICAL_CORS_SPEC.ExposeHeaders], [
      'Content-Range',
      'Content-Length',
      'Accept-Ranges',
      'ETag',
      'Content-Type',
    ]);
    assert.equal(S3_CANONICAL_CORS_SPEC.MaxAgeSeconds, 3600);
  });

  it('excludes loopback origins from S3 CORS when APP_PUBLIC_ORIGIN is a non-loopback production origin', () => {
    assert.deepEqual(resolveCorsAllowedOrigins('https://studio.open-design.ai'), [
      'https://studio.open-design.ai',
    ]);
    assert.deepEqual(
      resolveCorsAllowedOrigins('https://studio.open-design.ai/', ['https://cdn.open-design.ai']),
      ['https://studio.open-design.ai', 'https://cdn.open-design.ai'],
    );
    assert.deepEqual(resolveCorsAllowedOrigins('http://127.0.0.1:4173'), [
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    ]);
    assert.deepEqual(resolveCorsAllowedOrigins('http://localhost:5173'), [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('produces byte-for-byte identical window-aligned Presigned GET URLs with immutable Cache-Control for CAS keys (c4)', async () => {
    const blobKey = workspaceBlobKey(WID_A, SHA_A);
    const catalogKey = catalogBlobKey(SHA_A);
    const thumbKey = thumbnailKey(WID_A, SHA_A, 'w320');
    const derivedKey = derivedAssetKey(WID_A, SHA_A, 'proxy.mp4');
    const mutableExportKey = exportKey(WID_A, JID_A, 'final.mp4');

    assert.equal(isImmutableCasKey(blobKey), true);
    assert.equal(isImmutableCasKey(catalogKey), true);
    assert.equal(isImmutableCasKey(thumbKey), true);
    assert.equal(isImmutableCasKey(derivedKey), true);
    assert.equal(isImmutableCasKey(mutableExportKey), false);
    assert.equal(isImmutableCasKey(uploadStagingKey(WID_A, JID_A)), false);
    assert.equal(isCatalogCasKey(catalogKey), true);
    assert.equal(isCatalogCasKey(blobKey), false);

    assert.equal(DEFAULT_PRESIGN_CACHE_WINDOW_SEC, 3600);
    assert.equal(
      floorSigningDate(Date.UTC(2026, 10, 20, 14, 58, 59), 3600).toISOString(),
      '2026-11-20T14:00:00.000Z',
    );

    const storage = new StorageService({
      bucket: 'openmotion',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      forcePathStyle: true,
      defaultPresignGetTtlSec: 300,
    });

    try {
      const t1 = Date.UTC(2026, 10, 20, 14, 5, 12);
      const t2 = Date.UTC(2026, 10, 20, 14, 58, 59);
      const tNextWindow = Date.UTC(2026, 10, 20, 15, 0, 1);

      // Two calls at different times inside the same UTC hour MUST return byte-for-byte identical URLs.
      const url1 = await storage.presignGet(blobKey, { nowMs: t1 });
      const url2 = await storage.presignGet(blobKey, { nowMs: t2 });
      assert.equal(url1, url2);

      const parsed1 = new URL(url1);
      assert.equal(parsed1.searchParams.get('X-Amz-Date'), '20261120T140000Z');
      assert.equal(parsed1.searchParams.get('X-Amz-Expires'), '7200');
      assert.equal(parsed1.searchParams.get('response-cache-control'), IMMUTABLE_PRIVATE_CACHE_CONTROL);

      // Crossing into the next UTC hour cleanly rotates signingDate and signature.
      const urlNext = await storage.presignGet(blobKey, { nowMs: tNextWindow });
      assert.notEqual(urlNext, url1);
      const parsedNext = new URL(urlNext);
      assert.equal(parsedNext.searchParams.get('X-Amz-Date'), '20261120T150000Z');
      assert.equal(parsedNext.searchParams.get('X-Amz-Expires'), '7200');

      // Catalog CAS blobs receive public immutable Cache-Control; thumbnails & derived receive private immutable.
      const catalogUrl = await storage.presignGet(catalogKey, { nowMs: t1 });
      assert.equal(
        new URL(catalogUrl).searchParams.get('response-cache-control'),
        IMMUTABLE_PUBLIC_CACHE_CONTROL,
      );
      const derivedUrl1 = await storage.presignGet(derivedKey, { nowMs: t1 });
      const derivedUrl2 = await storage.presignGet(derivedKey, { nowMs: t2 });
      assert.equal(derivedUrl1, derivedUrl2);
      assert.equal(
        new URL(derivedUrl1).searchParams.get('response-cache-control'),
        IMMUTABLE_PRIVATE_CACHE_CONTROL,
      );
      const thumbUrl = await storage.presignGet(thumbKey, { nowMs: t1 });
      assert.equal(
        new URL(thumbUrl).searchParams.get('response-cache-control'),
        IMMUTABLE_PRIVATE_CACHE_CONTROL,
      );

      // Explicit opt-out (`cacheWindowSec: 0`) preserves caller's short TTL without window flooring.
      const unalignedUrl = await storage.presignGet(blobKey, {
        cacheWindowSec: 0,
        expiresInSec: 120,
        responseCacheControl: 'no-store',
      });
      const parsedUnaligned = new URL(unalignedUrl);
      assert.equal(parsedUnaligned.searchParams.get('X-Amz-Expires'), '120');
      assert.equal(parsedUnaligned.searchParams.get('response-cache-control'), 'no-store');

      // Non-CAS export URLs stay unaligned and do not attach `immutable` by default.
      const exportUrl = await storage.presignGet(mutableExportKey, { expiresInSec: 300 });
      const parsedExport = new URL(exportUrl);
      assert.equal(parsedExport.searchParams.get('X-Amz-Expires'), '300');
      assert.equal(parsedExport.searchParams.get('response-cache-control'), null);
    } finally {
      storage.close();
    }
  });
});

describe('Redis Key/Channel Builders & BullMQ Contracts', () => {
  it('builds canonical tenant-scoped Redis keys and channels', () => {
    assert.equal(textCacheKey(SHA_A), `om:text:${SHA_A}`);
    assert.equal(fontCssCacheKey('inter_400'), 'om:fonts:css:inter_400');
    assert.equal(projectChannel(WID_A, PID_A), `om:project:${WID_A}:${PID_A}`);
    assert.equal(jobChannel(JID_A), `om:job:${JID_A}`);
    assert.equal(cancelChannel(JID_A), `om:cancel:${JID_A}`);
    assert.equal(mcpSessionKey('sess-123'), 'om:mcp:session:sess-123');
    assert.equal(mcpEventsChannel(WID_A, 'sess-123'), `om:mcp:events:${WID_A}:sess-123`);
    assert.equal(selectionChannel(WID_A, PID_A), `om:selection:${WID_A}:${PID_A}`);
    assert.equal(RENDER_WORKER_HEALTH_KEY, 'om:workers:render:health');
    assert.throws(() => textCacheKey('invalid'), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => projectChannel('bad', PID_A), { code: 'INVALID_ARGUMENT' });
  });

  it('configures BullMQ Redis options safely and enforces attempts=1 on paid/render queues', () => {
    const bullOpts = buildRedisOptions('bullmq');
    assert.equal(bullOpts.maxRetriesPerRequest, null);
    assert.equal(bullOpts.enableReadyCheck, false);
    assert.equal(QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.mediaGenerate].attempts, 1);
    assert.equal(QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.renderExport].attempts, 1);
    assert.equal(QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.mediaIngest].attempts, 3);
    assert.equal(QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.blobGc].attempts, 3);
  });

  it('validates BullMQ job payloads across all four queues', () => {
    const ingest = validateMediaIngestPayload('upload_commit', {
      jobId: JID_A,
      workspaceId: WID_A,
      uploadId: VID_A,
      purpose: 'library_asset',
      name: 'intro.mp4',
    });
    assert.equal(ingest.purpose, 'library_asset');

    const peaks = validateMediaIngestPayload('extract_waveform_peaks', {
      workspaceId: WID_A,
      blobScope: 'workspace',
      sha256: SHA_A,
    });
    assert.equal(peaks.samples, 2048);

    const sprite = validateMediaIngestPayload('generate_video_sprite', {
      workspaceId: WID_A,
      blobScope: 'workspace',
      sha256: SHA_A,
      projectId: PID_A,
      durationSec: 30,
      width: 1920,
      height: 1080,
    });
    assert.equal(sprite.sha256, SHA_A);

    const gen = validateMediaGeneratePayload('generate_media', {
      jobId: JID_A,
      workspaceId: WID_A,
    });
    assert.equal(gen.jobId, JID_A);

    const render = validateRenderExportPayload('export_render', {
      jobId: JID_A,
      workspaceId: WID_A,
      projectId: PID_A,
      versionId: VID_A,
      revision: SHA_A,
      outputName: 'demo.mp4',
    });
    assert.equal(render.format, 'mp4');
    assert.equal(render.phase1, true);

    const thumb = validateRenderExportPayload('render_thumbnail', {
      workspaceId: WID_A,
      projectId: PID_A,
      revision: SHA_A,
      compositionPath: 'index.html',
      cacheKey: 'main-0',
    });
    assert.equal(thumb.width, 320);

    // BullMQ v5 rejects custom jobIds containing ':'.
    const thumbJobId = buildRenderThumbnailJobId(WID_A, PID_A, thumb.cacheKey);
    assert.equal(thumbJobId.includes(':'), false);
    assert.equal(thumbJobId, `thumb__${WID_A}__${PID_A}__main-0`);

    const proxyPayload = validateMediaIngestPayload('generate_preview_proxy', {
      kind: 'generate_preview_proxy',
      workspaceId: WID_A,
      sha256: SHA_A,
      mimeType: 'video/mp4',
      sizeBytes: 1_048_576,
      width: 1920,
      height: 1080,
    });
    assert.equal(proxyPayload.kind, 'generate_preview_proxy');
    const proxyJobId = buildPreviewProxyJobId(WID_A, SHA_A);
    assert.equal(proxyJobId.includes(':'), false);
    assert.equal(proxyJobId, `proxy__${WID_A}__${SHA_A}`);

    const gc = validateBlobGcPayload('sweep_unreferenced_blobs', {});
    assert.equal(gc.batchSize, 500);
    assert.equal(gc.graceSeconds, DEFAULT_BLOB_GC_GRACE_SECONDS);
    assert.equal(gc.graceSeconds, 604_800);

    assert.throws(() =>
      validateRenderExportPayload('export_render', {
        jobId: 'not-uuid',
        workspaceId: WID_A,
        projectId: PID_A,
        versionId: VID_A,
        revision: SHA_A,
        outputName: 'demo.mp4',
      }),
    );
  });
});

describe('CAS Refcount Lock-Sorting Invariant', () => {
  it('aggregates duplicate sha256 deltas, drops net-zero entries, and sorts lexicographically ascending', () => {
    const normalized = normalizeBlobRefDeltas([
      { sha256: SHA_C, delta: -1 },
      { sha256: SHA_A, delta: 2, sizeBytes: 128, mimeType: 'text/html' },
      { sha256: SHA_B, delta: 1, sizeBytes: 64 },
      { sha256: SHA_B, delta: -1 },
      { sha256: SHA_A, delta: -1 },
    ]);

    assert.equal(normalized.length, 2);
    assert.deepEqual(
      normalized.map((entry) => [entry.sha256, entry.delta]),
      [
        [SHA_A, 1],
        [SHA_C, -1],
      ],
    );
    assert.equal(normalized[0].sizeBytes, 128);
  });

  it('preserves existing metadata when a subsequent delta supplies metadata: null or merges non-null metadata', () => {
    const preserved = normalizeBlobRefDeltas([
      { sha256: SHA_A, delta: 1, sizeBytes: 1024, metadata: { width: 1920, height: 1080 } },
      { sha256: SHA_A, delta: 1, metadata: null },
    ]);
    assert.equal(preserved.length, 1);
    assert.deepEqual(preserved[0].metadata, { width: 1920, height: 1080 });

    const merged = normalizeBlobRefDeltas([
      { sha256: SHA_A, delta: 1, sizeBytes: 1024, metadata: { width: 1920 } },
      { sha256: SHA_A, delta: 1, metadata: { height: 1080, fps: 30 } },
    ]);
    assert.deepEqual(merged[0].metadata, { width: 1920, height: 1080, fps: 30 });

    const nullOnly = normalizeBlobRefDeltas([{ sha256: SHA_B, delta: 1, sizeBytes: 10, metadata: null }]);
    assert.equal(nullOnly[0].metadata, undefined);
  });

  it('rejects invalid sha256 digests and non-integer deltas', () => {
    assert.throws(() => normalizeBlobRefDeltas([{ sha256: 'bad', delta: 1 }]), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => normalizeBlobRefDeltas([{ sha256: SHA_A, delta: 1.5 }]), { code: 'INVALID_ARGUMENT' });
  });

  it('enforces authoritative Mark-and-Sweep SQL guards across all live reference tables with 7-day default grace (c3)', async () => {
    assert.equal(markUnreferencedBlobsForDeletion, markZeroRefForDeletion);

    const dialect = new PgDialect();
    const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
    const inspectDb = {
      execute: async (query: SQL) => {
        capturedQueries.push(dialect.sqlToQuery(query));
        return { rows: [] };
      },
    } as unknown as Database;

    // 1. Self-heal reconciliation queries both drifted live blobs and drifted unreferenced blobs.
    await reconcileDriftedBlobRefCounts(inspectDb, { batchSize: 250 });
    assert.equal(capturedQueries.length, 2);

    const healLiveSql = capturedQueries[0].sql;
    assert.match(healLiveSql, /FROM project_files pf/);
    assert.match(healLiveSql, /FROM project_version_files pvf/);
    assert.match(healLiveSql, /FROM asset_versions av/);
    assert.match(healLiveSql, /SET ref_count = d\.live_count,\s*zero_ref_since = NULL,\s*gc_state = 'active'/);
    assert.match(healLiveSql, /FOR UPDATE OF wb SKIP LOCKED/);

    const markUnrefSql = capturedQueries[1].sql;
    assert.match(markUnrefSql, /NOT EXISTS[\s\S]*FROM project_files pf/);
    assert.match(markUnrefSql, /NOT EXISTS[\s\S]*FROM project_version_files pvf/);
    assert.match(markUnrefSql, /NOT EXISTS[\s\S]*FROM asset_versions av/);
    assert.match(markUnrefSql, /NOT EXISTS[\s\S]*FROM upload_tickets ut[\s\S]*ut\.state IN \('issued', 'uploaded', 'processing'\)/);
    assert.match(markUnrefSql, /zero_ref_since = COALESCE\(wb\.zero_ref_since, now\(\)\)/);

    // 2. markZeroRefForDeletion defaults to 7 days (604800s) and NEVER deletes on ref_count = 0 alone.
    capturedQueries.length = 0;
    await markZeroRefForDeletion(inspectDb, { batchSize: 100 });
    assert.equal(capturedQueries.length, 1);
    const markSql = capturedQueries[0].sql;
    assert.deepEqual(capturedQueries[0].params, [604_800, 100]);
    assert.doesNotMatch(markSql, /WHERE\s+ref_count\s*=\s*0/i);
    assert.match(markSql, /NOT EXISTS[\s\S]*FROM project_files pf[\s\S]*pf\.blob_scope = 'workspace'/);
    assert.match(markSql, /NOT EXISTS[\s\S]*FROM project_version_files pvf[\s\S]*pvf\.blob_scope = 'workspace'/);
    assert.match(markSql, /NOT EXISTS[\s\S]*FROM asset_versions av/);
    assert.match(markSql, /NOT EXISTS[\s\S]*FROM upload_tickets ut[\s\S]*ut\.expected_sha256 = wb\.sha256[\s\S]*ut\.state IN \('issued', 'uploaded', 'processing'\)/);
    assert.match(markSql, /FOR UPDATE OF wb SKIP LOCKED/);

    // 3. finalizeBlobDeletion ALSO enforces NOT EXISTS across all 4 live tables before PG row delete.
    capturedQueries.length = 0;
    await finalizeBlobDeletion(inspectDb, WID_A, SHA_A);
    assert.equal(capturedQueries.length, 1);
    const finalizeSql = capturedQueries[0].sql;
    assert.deepEqual(capturedQueries[0].params, [WID_A, SHA_A]);
    assert.match(finalizeSql, /DELETE FROM workspace_blobs wb/);
    assert.match(finalizeSql, /wb\.gc_state = 'deleting'/);
    assert.match(finalizeSql, /NOT EXISTS[\s\S]*FROM project_files pf/);
    assert.match(finalizeSql, /NOT EXISTS[\s\S]*FROM project_version_files pvf/);
    assert.match(finalizeSql, /NOT EXISTS[\s\S]*FROM asset_versions av/);
    assert.match(finalizeSql, /NOT EXISTS[\s\S]*FROM upload_tickets ut[\s\S]*ut\.state IN \('issued', 'uploaded', 'processing'\)/);
  });
});

describe('Auth Scopes, Errors, Logger Redaction, Shutdown & Extracted Helpers', () => {
  it('matches frozen #11 PAT scope vocabulary and role hierarchy', () => {
    assert.deepEqual([...DEFAULT_PAT_SCOPES], [
      'projects:read',
      'projects:write',
      'assets:read',
      'assets:write',
      'exports:write',
      'media:generate',
      'mcp:tools',
    ]);
    assert.ok(PAT_SCOPES.includes('workspace:admin'));
    assert.deepEqual([...WORKSPACE_ROLES], ['owner', 'admin', 'editor', 'viewer']);

    const editor: AuthContext = {
      workspaceId: WID_A,
      userId: VID_A,
      role: 'editor',
      scopes: [...DEFAULT_PAT_SCOPES],
      authMode: 'oidc',
      authMethod: 'pat',
    };
    assert.equal(hasScope(editor, 'projects:write'), true);
    assert.equal(hasScope(editor, 'workspace:admin'), false);
    assert.equal(hasMinRole(editor, 'viewer'), true);
    assert.equal(hasMinRole(editor, 'admin'), false);

    // A restricted PAT owned by a workspace owner MUST NOT escalate to workspace:admin via role.
    const restrictedOwnerPat: AuthContext = {
      workspaceId: WID_A,
      userId: VID_A,
      role: 'owner',
      scopes: ['projects:read'],
      authMode: 'oidc',
      authMethod: 'pat',
    };
    assert.equal(hasMinRole(restrictedOwnerPat, 'owner'), true);
    assert.equal(hasScope(restrictedOwnerPat, 'projects:read'), true);
    assert.equal(hasScope(restrictedOwnerPat, 'projects:write'), false);
    assert.equal(hasScope(restrictedOwnerPat, 'workspace:admin'), false);

    const adminScopedPat: AuthContext = {
      ...restrictedOwnerPat,
      scopes: ['workspace:admin'],
    };
    assert.equal(hasScope(adminScopedPat, 'workspace:admin'), true);
    assert.equal(hasScope(adminScopedPat, 'exports:write'), true);
  });

  it('maps canonical CloudError codes and HTTP statuses', () => {
    const p2 = featureDeferredP2('brand_kit_capture');
    assert.equal(isCloudError(p2), true);
    assert.equal(p2.code, 'FEATURE_DEFERRED_P2');
    assert.equal(p2.status, 501);
    assert.equal(revisionConflict().status, 409);
    assert.equal(workspaceForbidden().status, 403);
    assert.equal(quotaExceeded('limit').status, 429);
    assert.equal(new CloudError('EXPORT_BUSY', 'busy').status, 409);
  });

  it('redacts secrets and database URL passwords in structured logs', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      bindings: { service: 'test' },
      sink: (_level, line) => lines.push(line),
    });
    logger.info('connect', {
      databaseUrl: 'postgres://admin:supersecret@db.internal:5432/openmotion',
      apiKey: 'sk-live-secret',
      nested: { authorization: 'Bearer abc', safe: 'ok' },
    });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.databaseUrl, 'postgres://admin:[REDACTED]@db.internal:5432/openmotion');
    assert.equal(parsed.apiKey, '[REDACTED]');
    assert.deepEqual(parsed.nested, { authorization: '[REDACTED]', safe: 'ok' });
    assert.equal(redactString('redis://:mysecret@redis:6379'), 'redis://:[REDACTED]@redis:6379');
    assert.deepEqual(redactValue({ token: 'x' }), { token: '[REDACTED]' });
  });

  it('executes ShutdownCoordinator hooks in LIFO order once', async () => {
    const order: string[] = [];
    const coordinator = new ShutdownCoordinator({ timeoutMs: 2000 });
    coordinator.register('db', () => {
      order.push('db');
    });
    coordinator.register('http', () => {
      order.push('http');
    });
    const [first, second] = await Promise.all([
      coordinator.shutdown('SIGTERM'),
      coordinator.shutdown('SIGINT'),
    ]);
    assert.equal(first, true);
    assert.equal(second, true);
    assert.deepEqual(order, ['http', 'db']);
  });

  it('preserves extracted shared/version.ts and shared/project-validation.ts behavior', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
    assert.equal(isUuid(WID_A), true);
    assert.equal(isSha256Hex(SHA_A), true);
    assert.equal(validateStableRequestId('req_123-abc'), 'req_123-abc');
    assert.equal(projectPath('.hyperframes/studio-manual-edits.json'), '.hyperframes/studio-manual-edits.json');
    assert.equal(isTextProjectPath('compositions/main.html'), true);
    assert.equal(isTextProjectPath('assets/video.mp4'), false);
    assert.equal(validateProjectTitle('  Demo Film  '), 'Demo Film');
    assert.throws(() => projectPath('../escape.html'));
    const rev1 = computeProjectRevision([
      { path: 'b.css', size: 10, hash: SHA_B },
      { path: 'a.html', size: 20, hash: SHA_A },
    ]);
    const rev2 = computeProjectRevision([
      { path: 'a.html', size: 20, hash: SHA_A },
      { path: 'b.css', size: 10, hash: SHA_B },
    ]);
    assert.equal(rev1, rev2);
    assert.equal(new Conflict().code, 'VERSION_CONFLICT');
  });
});

describe('Generated Drizzle SQL Migrations Integrity', () => {
  it('contains valid journal and initial SQL covering all 24 tables and #11 reconciliations', async () => {
    const migrationsDir = path.join(REPO_ROOT, 'src/db/migrations');
    const journal = JSON.parse(
      await readFile(path.join(migrationsDir, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    assert.ok(Array.isArray(journal.entries) && journal.entries.length >= 1, 'Expected at least 1 migration entry');

    const sqlText = await readFile(path.join(migrationsDir, `${journal.entries[0].tag}.sql`), 'utf8');

    const expectedTables = [
      'users',
      'workspaces',
      'workspace_members',
      'auth_sessions',
      'personal_access_tokens',
      'oauth_clients',
      'oauth_authorization_codes',
      'oauth_tokens',
      'sessions',
      'session_messages',
      'projects',
      'work_rounds',
      'project_files',
      'project_versions',
      'project_version_files',
      'project_history_entries',
      'workspace_blobs',
      'catalog_templates',
      'catalog_template_files',
      'assets',
      'asset_versions',
      'upload_tickets',
      'jobs',
      'idempotency_receipts',
    ];
    for (const table of expectedTables) {
      assert.match(sqlText, new RegExp(`CREATE TABLE "${table}"`), `Missing CREATE TABLE "${table}"`);
    }

    // Verify #11 reconciliations are present in generated DDL:
    assert.match(sqlText, /"current_history_seq" integer DEFAULT 0 NOT NULL/);
    assert.match(sqlText, /"license_s3_staging_key" text/);
    assert.match(sqlText, /"expected_sha256" char\(64\)/);
    assert.match(sqlText, /"result_json" jsonb/);
    assert.match(sqlText, /"error_code" varchar\(128\)/);
    assert.match(sqlText, /"error_message" text/);
    assert.match(sqlText, /"claim_token" uuid/);
    assert.match(sqlText, /"remote_id" varchar\(200\)/);
    assert.match(sqlText, /CREATE UNIQUE INDEX "uq_jobs_active_export_per_project"/);
    assert.match(sqlText, /CREATE INDEX "idx_workspace_blobs_gc"/);
    assert.match(sqlText, /CREATE INDEX "idx_projects_workspace_keyset"/);
    assert.match(sqlText, /projects:read.*projects:write.*assets:read.*assets:write.*exports:write.*media:generate.*mcp:tools/);

    // Verify forbidden inline text storage columns/tables are absent (#11 §1):
    assert.doesNotMatch(sqlText, /"content_text"/);
    assert.doesNotMatch(sqlText, /CREATE TABLE "history_text_blobs"/);
  });
});

// Optional live infrastructure smoke test (skipped by default in unit runs).
describe('Optional Live Infra Smoke (RUN_LIVE_CLOUD_SMOKE=1)', { skip: process.env.RUN_LIVE_CLOUD_SMOKE !== '1' }, () => {
  it('runs migrations and checks DB, Redis, and S3 connectivity', async () => {
    const { runMigrations } = await import('../../src/db/migrate.ts');
    const { createDbHandle } = await import('../../src/db/client.ts');
    const { RedisEventBus } = await import('../../src/infra/redis.ts');
    const config = parseConfig(process.env);

    await runMigrations({ connectionString: config.DATABASE_URL });
    const dbHandle = createDbHandle({ connectionString: config.DATABASE_URL, max: 2, allowExitOnIdle: true });
    const bus = new RedisEventBus(config.REDIS_URL);
    const storage = new StorageService({
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      publicOrigin: config.APP_PUBLIC_ORIGIN,
    });
    try {
      assert.equal(await dbHandle.checkHealth(), true);
      assert.equal(await bus.checkHealth(), true);
      await storage.ensureBucketAndCors();
    } finally {
      storage.close();
      await bus.close();
      await dbHandle.close();
    }
  });
});
