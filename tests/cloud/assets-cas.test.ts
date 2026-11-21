import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { DEFAULT_PAT_SCOPES, type AuthContext } from '../../src/contracts/auth.ts';
import type { JobProgressEvent } from '../../src/contracts/events.ts';
import type { StoragePort } from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import {
  assets,
  assetVersions,
  uploadTickets,
  workspaceBlobs,
} from '../../src/db/schema/blobs-assets.ts';
import { idempotencyReceipts, jobs } from '../../src/db/schema/jobs.ts';
import {
  projectFiles,
  projectVersionFiles,
  projectVersions,
} from '../../src/db/schema/project-files.ts';
import { projects } from '../../src/db/schema/projects.ts';
import { cancelChannel, jobChannel, projectChannel } from '../../src/infra/redis.ts';
import {
  exportKey,
  thumbnailKey,
  uploadLicenseStagingKey,
  uploadStagingKey,
  workspaceBlobKey,
} from '../../src/infra/storage.ts';
import { createAssetRoutes } from '../../src/routes/assets.ts';
import { createExportRoutes } from '../../src/routes/exports.ts';
import {
  AssetLibraryService,
  isHardenedPublicIp,
  validatePublicImportUrl,
} from '../../src/services/asset-library-service.ts';
import { ExportService } from '../../src/services/export-service.ts';

const WID_A = '11111111-1111-4111-8111-111111111111';
const WID_B = '22222222-2222-4222-8222-222222222222';
const UID_A = '33333333-3333-4333-8333-333333333333';
const UID_B = '44444444-4444-4444-8444-444444444444';
const PID_A = '55555555-5555-4555-8555-555555555555';
const AID_A = '66666666-6666-4666-8666-666666666666';
const VID_A = '77777777-7777-4777-8777-777777777777';
const JID_A = '88888888-8888-4888-8888-888888888888';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const REV_1 = 'd'.repeat(64);
const REV_2 = 'e'.repeat(64);

function authFor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    workspaceId: WID_A,
    userId: UID_A,
    role: 'editor',
    scopes: [...DEFAULT_PAT_SCOPES],
    authMode: 'dev',
    authMethod: 'dev_bypass',
    ...overrides,
  };
}

class MemoryStorage implements StoragePort {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly presignedPuts: Array<{ key: string; contentType: string; contentLength?: number }> = [];
  readonly presignedGets: Array<{ key: string; disposition?: string }> = [];

  async putObject(
    key: string,
    body: Buffer | Uint8Array | Readable | string,
    contentType: string,
  ): Promise<void> {
    if (Buffer.isBuffer(body)) {
      this.objects.set(key, { bytes: Buffer.from(body), contentType });
    } else if (body instanceof Uint8Array) {
      this.objects.set(key, { bytes: Buffer.from(body), contentType });
    } else if (typeof body === 'string') {
      this.objects.set(key, { bytes: Buffer.from(body, 'utf8'), contentType });
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      this.objects.set(key, { bytes: Buffer.concat(chunks), contentType });
    }
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    if (this.objects.has(key)) return { uploaded: false };
    await this.putObject(key, body, contentType);
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const entry = this.objects.get(key);
    if (!entry) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(entry.bytes);
  }

  async getObjectStream(key: string) {
    const entry = this.objects.get(key);
    if (!entry) throw new Error(`NoSuchKey: ${key}`);
    return {
      stream: Readable.from([Buffer.from(entry.bytes)]),
      contentLength: entry.bytes.byteLength,
      contentType: entry.contentType,
      etag: `"${key}"`,
    };
  }

  async headObject(key: string) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      contentLength: entry.bytes.byteLength,
      contentType: entry.contentType,
      etag: `"${key}"`,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async presignPut(key: string, options: { contentType: string; contentLength?: number }): Promise<string> {
    this.presignedPuts.push({ key, contentType: options.contentType, contentLength: options.contentLength });
    return `https://s3.example.test/openmotion/${encodeURI(key)}?X-Amz-Signature=put-mock`;
  }

  async presignGet(
    key: string,
    options: { responseContentDisposition?: string; responseContentType?: string } = {},
  ): Promise<string> {
    this.presignedGets.push({ key, disposition: options.responseContentDisposition });
    const disp = options.responseContentDisposition
      ? `&response-content-disposition=${encodeURIComponent(options.responseContentDisposition)}`
      : '';
    return `https://s3.example.test/openmotion/${encodeURI(key)}?X-Amz-Signature=get-mock${disp}`;
  }

  readonly multiparts = new Map<
    string,
    { key: string; contentType: string; parts: Map<number, { etag: string; size: number }> }
  >();
  readonly abortedMultiparts: string[] = [];

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const uploadId = `mp-${this.multiparts.size + 1}`;
    this.multiparts.set(uploadId, { key, contentType, parts: new Map() });
    return { uploadId };
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return `https://s3.example.test/openmotion/${encodeURI(key)}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }

  async listMultipartParts(_key: string, uploadId: string) {
    const entry = this.multiparts.get(uploadId);
    if (!entry) return [];
    return Array.from(entry.parts.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([partNumber, info]) => ({ partNumber, etag: info.etag, size: info.size }));
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<void> {
    const entry = this.multiparts.get(uploadId);
    if (!entry) throw new Error(`Unknown multipart uploadId: ${uploadId}`);
    const payload = Buffer.from(`assembled:${parts.map((p) => `${p.partNumber}=${p.etag}`).join(',')}`);
    this.objects.set(key, { bytes: payload, contentType: entry.contentType });
    this.multiparts.delete(uploadId);
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.abortedMultiparts.push(uploadId);
    this.multiparts.delete(uploadId);
  }

  async ensureBucketAndCors(): Promise<void> {}
}

class MemoryEventBus {
  readonly published: Array<{ channel: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Set<(payload: unknown, channel: string) => void>>();

  async publish(channel: string, payload: unknown): Promise<number> {
    this.published.push({ channel, payload });
    const bucket = this.listeners.get(channel);
    if (!bucket) return 0;
    for (const fn of bucket) {
      fn(payload, channel);
    }
    return bucket.size;
  }

  async subscribe(
    channel: string,
    listener: (payload: unknown, channel: string) => void,
  ): Promise<() => Promise<void>> {
    let bucket = this.listeners.get(channel);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(channel, bucket);
    }
    bucket.add(listener);
    return async () => {
      bucket?.delete(listener);
      if (bucket?.size === 0) this.listeners.delete(channel);
    };
  }
}

/**
 * Lightweight deterministic Drizzle mock DB that records table operations and supports
 * sequential select/insert/update/delete handlers per test scenario.
 */
function createScriptedDb(handlers: {
  selectQueue?: unknown[][];
  insertImpl?: (table: unknown, values: unknown) => unknown[];
  updateImpl?: (table: unknown, values: unknown) => unknown[];
  deleteImpl?: (table: unknown) => unknown[];
}) {
  const selectQueue = [...(handlers.selectQueue ?? [])];
  const ops: Array<{ op: string; table: unknown; values?: unknown }> = [];

  const makeSelectChain = () => {
    let resolvedRows: unknown[] | null = null;
    const resolve = () => {
      if (resolvedRows === null) {
        resolvedRows = selectQueue.shift() ?? [];
      }
      return Promise.resolve(resolvedRows);
    };
    const chain: Record<string, unknown> = {
      from(table: unknown) {
        ops.push({ op: 'select', table });
        return chain;
      },
      innerJoin() {
        return chain;
      },
      leftJoin() {
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      for() {
        return chain;
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return resolve().then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  const executor: Record<string, unknown> = {
    select() {
      return makeSelectChain();
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          ops.push({ op: 'insert', table, values });
          const run = () => Promise.resolve(handlers.insertImpl ? handlers.insertImpl(table, values) : Array.isArray(values) ? values : [values]);
          const chain: Record<string, unknown> = {
            onConflictDoUpdate() {
              return chain;
            },
            returning() {
              return run();
            },
            then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
              return run().then(onFulfilled, onRejected);
            },
          };
          return chain;
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: unknown) {
          ops.push({ op: 'update', table, values });
          const run = () => Promise.resolve(handlers.updateImpl ? handlers.updateImpl(table, values) : [{ sha256: SHA_A }]);
          const chain: Record<string, unknown> = {
            where() {
              return chain;
            },
            returning() {
              return run();
            },
            then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
              return run().then(onFulfilled, onRejected);
            },
          };
          return chain;
        },
      };
    },
    delete(table: unknown) {
      ops.push({ op: 'delete', table });
      const run = () => Promise.resolve(handlers.deleteImpl ? handlers.deleteImpl(table) : []);
      const chain: Record<string, unknown> = {
        where() {
          return chain;
        },
        returning() {
          return run();
        },
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
          return run().then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      return fn(executor as unknown as Database);
    },
  };

  return { db: executor as unknown as Database, ops };
}

describe('SSRF URL & Hardened Public IP Validation', () => {
  it('blocks non-HTTPS schemes, credentials, non-443 ports, cluster hosts, and private/IMDS/IPv6 addresses', () => {
    const blockedUrls = [
      'http://example.com/video.mp4',
      'file:///etc/passwd',
      'ftp://example.com/file.mp4',
      'https://user:pass@example.com/a.png',
      'https://example.com:8443/a.png',
      'https://localhost/a.png',
      'https://sub.localhost/a.png',
      'https://service.local/a.png',
      'https://db.internal/a.png',
      'https://postgres.openmotion.svc.cluster.local/a.png',
      'https://redis/a.png',
      'https://127.0.0.1/a.png',
      'https://10.0.0.1/a.png',
      'https://172.16.0.1/a.png',
      'https://192.168.1.1/a.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/a.png',
      'https://198.18.0.1/a.png',
      'https://198.51.100.10/a.png',
      'https://203.0.113.5/a.png',
      'https://[::1]/a.png',
      'https://[fc00::1]/a.png',
      'https://[fe80::1]/a.png',
      'https://[::ffff:127.0.0.1]/a.png',
      'https://[::ffff:169.254.169.254]/a.png',
      // Trailing-dot FQDN SSRF bypass attempts:
      'https://localhost./secret',
      'https://sub.localhost./secret',
      'https://metadata.google.internal./computeMetadata/v1/',
      'https://postgres.openmotion.svc.cluster.local./a.png',
      'https://service.local./a.png',
      'https://redis./a.png',
    ];

    for (const candidate of blockedUrls) {
      assert.throws(
        () => validatePublicImportUrl(candidate),
        { code: 'SSRF_BLOCKED' },
        `Expected SSRF_BLOCKED for ${candidate}`,
      );
    }

    assert.equal(isHardenedPublicIp('::ffff:127.0.0.1'), false);
    assert.equal(isHardenedPublicIp('198.51.100.1'), false);
    assert.equal(isHardenedPublicIp('203.0.113.1'), false);
    assert.equal(isHardenedPublicIp('192.88.99.1'), false);
    assert.equal(isHardenedPublicIp('93.184.216.34'), true);
    assert.equal(
      validatePublicImportUrl('https://cdn.example.com/media/hero.png#frag'),
      'https://cdn.example.com/media/hero.png',
    );
  });
});

describe('AssetLibraryService: Presigned Tickets, Confirm Ownership, URL Import & Hard-Delete CAS Refcounts', () => {
  it('issues upload tickets with optional companion font license staging key and confirms into media-ingest', async () => {
    const storage = new MemoryStorage();
    const enqueued: Array<{ name: string; payload: unknown }> = [];
    const insertedTickets: Array<Record<string, unknown>> = [];

    const { db } = createScriptedDb({
      insertImpl(table, values) {
        if (table === uploadTickets) {
          insertedTickets.push(values as Record<string, unknown>);
        }
        return [values];
      },
    });

    const service = new AssetLibraryService({
      db,
      storage,
      queues: {
        enqueueMediaIngest: async (name, payload) => {
          enqueued.push({ name, payload });
          return {} as never;
        },
      },
    });

    const ticket = await service.createUploadTicket(authFor(), {
      purpose: 'project_asset',
      filename: 'Inter-Bold.woff2',
      mimeType: 'font/woff2',
      sizeBytes: 42_000,
      targetPath: 'assets/fonts/Inter-Bold.woff2',
      licenseFilename: 'OFL.txt',
      licenseBytes: 4096,
      requestId: 'req-font-1',
    });

    assert.equal(ticket.s3StagingKey, uploadStagingKey(WID_A, ticket.uploadId));
    assert.ok(ticket.licenseUpload);
    assert.equal(ticket.licenseUpload.s3StagingKey, uploadLicenseStagingKey(WID_A, ticket.uploadId));
    assert.equal(storage.presignedPuts.length, 2);
    assert.equal(insertedTickets.length, 1);
    assert.equal(insertedTickets[0].licenseS3StagingKey, uploadLicenseStagingKey(WID_A, ticket.uploadId));

    // Rejects oversized font license (> 128 KiB).
    await assert.rejects(
      () =>
        service.createUploadTicket(authFor(), {
          filename: 'Inter.woff2',
          mimeType: 'font/woff2',
          sizeBytes: 4096,
          licenseFilename: 'OFL.txt',
          licenseBytes: 200_000,
        }),
      { code: 'INVALID_ARGUMENT' },
    );

    // Stage bytes in S3 and test confirm ownership check + enqueue upload_commit.
    await storage.putObject(ticket.s3StagingKey, Buffer.alloc(1024, 1), 'font/woff2');
    await storage.putObject(ticket.licenseUpload.s3StagingKey, Buffer.from('SIL OFL 1.1'), 'text/plain; charset=utf-8');

    const storedTicketRow = {
      id: ticket.uploadId,
      workspaceId: WID_A,
      userId: UID_A,
      purpose: 'project_asset',
      targetProjectId: null,
      targetAssetId: null,
      targetPath: 'assets/fonts/Inter-Bold.woff2',
      filename: 'Inter-Bold.woff2',
      expectedMimeType: 'font/woff2',
      expectedModality: null,
      expectedSha256: null,
      maxBytes: 42_000,
      s3StagingKey: ticket.s3StagingKey,
      licenseS3StagingKey: ticket.licenseUpload.s3StagingKey,
      licenseFilename: 'OFL.txt',
      licenseMaxBytes: 4096,
      state: 'issued',
      requestId: 'req-font-1',
      resultPayload: null,
      error: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Another non-admin member cannot confirm UID_A's ticket.
    const { db: dbOtherUser } = createScriptedDb({ selectQueue: [[storedTicketRow]] });
    const otherUserService = new AssetLibraryService({
      db: dbOtherUser,
      storage,
      queues: { enqueueMediaIngest: async () => ({}) as never },
    });
    await assert.rejects(
      () => otherUserService.confirmUploadTicket(authFor({ userId: UID_B, role: 'editor' }), ticket.uploadId),
      { code: 'FORBIDDEN' },
    );

    // Ticket owner confirms -> enqueues media-ingest upload_commit.
    const { db: dbConfirm } = createScriptedDb({ selectQueue: [[storedTicketRow], [storedTicketRow]] });
    const confirmService = new AssetLibraryService({
      db: dbConfirm,
      storage,
      queues: {
        enqueueMediaIngest: async (name, payload) => {
          enqueued.push({ name, payload });
          return {} as never;
        },
      },
    });
    const confirmed = await confirmService.confirmUploadTicket(authFor(), ticket.uploadId, { name: 'Inter Bold' });
    assert.equal(confirmed.state, 'queued');
    assert.equal(confirmed.replayed, false);
    assert.ok(confirmed.jobId);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].name, 'upload_commit');
    assert.equal((enqueued[0].payload as Record<string, unknown>).uploadId, ticket.uploadId);
  });

  it('hard-deletes an asset and decrements workspace_blobs ref_count atomically in sorted sha256 order', async () => {
    const storage = new MemoryStorage();
    const { db, ops } = createScriptedDb({
      selectQueue: [
        [{ id: AID_A }], // locked asset row
        [{ sha256: SHA_C }, { sha256: SHA_A }, { sha256: SHA_C }], // unsorted version digests
      ],
      updateImpl(table) {
        if (table === workspaceBlobs) return [{ sha256: SHA_A }];
        return [];
      },
    });

    const service = new AssetLibraryService({
      db,
      storage,
      queues: { enqueueMediaIngest: async () => ({}) as never },
    });

    const deleted = await service.deleteAsset(authFor(), AID_A, { permanent: true });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.decrementedBlobs, 3);

    // Must delete asset row first, then perform exactly 2 aggregated workspace_blobs updates (SHA_A, SHA_C).
    const deleteIdx = ops.findIndex((o) => o.op === 'delete' && o.table === assets);
    const blobUpdates = ops
      .map((o, i) => ({ ...o, i }))
      .filter((o) => o.op === 'update' && o.table === workspaceBlobs);
    assert.ok(deleteIdx >= 0);
    assert.equal(blobUpdates.length, 2);
    assert.ok(blobUpdates[0].i > deleteIdx);
  });

  it('enqueues url_fetch after SSRF check and replays idempotently via idempotency_receipts', async () => {
    const storage = new MemoryStorage();
    const enqueued: Array<{ name: string; payload: unknown }> = [];
    const { db } = createScriptedDb({
      selectQueue: [[]], // no prior receipt
      insertImpl(_table, values) {
        return [values];
      },
    });
    const service = new AssetLibraryService({
      db,
      storage,
      queues: {
        enqueueMediaIngest: async (name, payload) => {
          enqueued.push({ name, payload });
          return {} as never;
        },
      },
    });

    const imported = await service.importFromPublicUrl(authFor(), {
      url: 'https://cdn.example.com/assets/intro.mp4',
      name: 'Intro Clip',
      requestId: 'req-url-1',
    });
    assert.equal(imported.replayed, false);
    assert.equal(imported.state, 'queued');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].name, 'url_fetch');

    // SSRF rejection never touches DB or queue.
    await assert.rejects(
      () =>
        service.importFromPublicUrl(authFor(), {
          url: 'https://169.254.169.254/latest/meta-data/',
          name: 'IMDS',
          requestId: 'req-ssrf',
        }),
      { code: 'SSRF_BLOCKED' },
    );
    assert.equal(enqueued.length, 1);

    // Enqueue failure marks job failed and deletes idempotency_receipts so requestId is never stranded.
    const { db: rollbackDb, ops: rollbackOps } = createScriptedDb({
      selectQueue: [[]],
      insertImpl(_table, values) {
        return [values];
      },
    });
    const failingQueueService = new AssetLibraryService({
      db: rollbackDb,
      storage,
      queues: {
        enqueueMediaIngest: async () => {
          throw new Error('Redis connection refused');
        },
      },
    });
    await assert.rejects(
      () =>
        failingQueueService.importFromPublicUrl(authFor(), {
          url: 'https://cdn.example.com/assets/retry-me.mp4',
          name: 'Retry Me',
          requestId: 'req-url-fail',
        }),
      /Redis connection refused/,
    );
    assert.ok(
      rollbackOps.some(
        (o) =>
          o.op === 'update' &&
          o.table === jobs &&
          (o.values as Record<string, unknown>)?.state === 'failed' &&
          (o.values as Record<string, unknown>)?.errorCode === 'QUEUE_ENQUEUE_FAILED',
      ),
    );
    assert.ok(rollbackOps.some((o) => o.op === 'delete' && o.table === idempotencyReceipts));
  });
});

describe('Asset & Export Hono Routes: Direct HEAD Metadata, 302 Presigned GET, Export Snapshots & SSE', () => {
  it('answers HEAD directly from PG metadata (no S3 redirect) and GET with 302 + Cache-Control/Vary headers', async () => {
    const storage = new MemoryStorage();
    const thumbKey = thumbnailKey(WID_A, SHA_A, 'w320');
    await storage.putObject(thumbKey, Buffer.from('jpeg-thumb'), 'image/jpeg');

    const versionMetaRow = {
      assetTrashed: false,
      versionId: VID_A,
      assetId: AID_A,
      filename: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 12_345,
      sha256: SHA_A,
      blobMetadata: { width: 1920, height: 1080 },
    };

    const { db } = createScriptedDb({
      selectQueue: [[versionMetaRow], [versionMetaRow], [versionMetaRow]],
    });
    const assetService = new AssetLibraryService({
      db,
      storage,
      queues: { enqueueMediaIngest: async () => ({}) as never },
    });
    const app = createAssetRoutes({
      assetService,
      getAuth: () => authFor(),
    });

    // HEAD responds 200 directly from PG metadata and NEVER calls presignGet.
    const headRes = await app.request(`http://localhost/${AID_A}/versions/${VID_A}/file`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-type'), 'image/png');
    assert.equal(headRes.headers.get('content-length'), '12345');
    assert.equal(headRes.headers.get('accept-ranges'), 'bytes');
    assert.equal(headRes.headers.get('etag'), `"sha256:${SHA_A}"`);
    assert.equal(storage.presignedGets.length, 0);

    // GET responds 302 to S3 presigned GET URL with attachment Content-Disposition & strict cache headers.
    const getRes = await app.request(`http://localhost/${AID_A}/versions/${VID_A}/file?download=1`);
    assert.equal(getRes.status, 302);
    assert.equal(getRes.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(getRes.headers.get('vary'), 'Origin, Cookie');
    assert.match(getRes.headers.get('location') ?? '', /^https:\/\/s3\.example\.test\/openmotion\/workspaces\//);
    assert.equal(storage.presignedGets.at(-1)?.key, workspaceBlobKey(WID_A, SHA_A));
    assert.match(storage.presignedGets.at(-1)?.disposition ?? '', /^attachment; filename="hero\.png"/);

    // Thumbnail GET returns 302 pointing to thumbnailKey.
    const thumbRes = await app.request(`http://localhost/${AID_A}/versions/${VID_A}/thumbnail`);
    assert.equal(thumbRes.status, 302);
    assert.equal(storage.presignedGets.at(-1)?.key, thumbKey);
  });

  it('enforces scope and viewer RBAC boundaries on asset routes', async () => {
    const storage = new MemoryStorage();
    const { db } = createScriptedDb({});
    const assetService = new AssetLibraryService({
      db,
      storage,
      queues: { enqueueMediaIngest: async () => ({}) as never },
    });

    const viewerApp = createAssetRoutes({
      assetService,
      getAuth: () => authFor({ role: 'viewer' }),
    });
    const viewerRes = await viewerApp.request('http://localhost/uploads/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', sizeBytes: 100 }),
    });
    assert.equal(viewerRes.status, 403);

    const restrictedPatApp = createAssetRoutes({
      assetService,
      getAuth: () => authFor({ role: 'owner', scopes: ['assets:read'] }),
    });
    const patRes = await restrictedPatApp.request('http://localhost/uploads/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', sizeBytes: 100 }),
    });
    assert.equal(patRes.status, 403);
  });

  it('startExport freezes studio-manual-edits.json + studio-motion.json, enforces expectedRevision & EXPORT_BUSY, streams SSE, and cancels', async () => {
    const storage = new MemoryStorage();
    const eventBus = new MemoryEventBus();
    const enqueuedRenders: Array<{ name: string; payload: unknown; options: unknown }> = [];
    const insertedVersionFiles: Array<Record<string, unknown>> = [];

    const projectRow = {
      id: PID_A,
      workspaceId: WID_A,
      sessionId: UID_A,
      artifactId: AID_A,
      title: 'Launch Film',
      revision: REV_1,
      currentVersionId: null,
      currentVersionNumber: 0,
      trashed: false,
      trashedAt: null,
      createdAt: new Date(),
      openedAt: new Date(),
      updatedAt: new Date(),
    };

    const liveProjectFiles = [
      {
        workspaceId: WID_A,
        projectId: PID_A,
        path: 'index.html',
        blobScope: 'workspace',
        sha256: SHA_A,
        sizeBytes: 512,
        mimeType: 'text/html',
        isText: true,
        updatedAt: new Date(),
      },
      {
        workspaceId: WID_A,
        projectId: PID_A,
        path: '.hyperframes/studio-manual-edits.json',
        blobScope: 'workspace',
        sha256: SHA_B,
        sizeBytes: 128,
        mimeType: 'application/json',
        isText: true,
        updatedAt: new Date(),
      },
      {
        workspaceId: WID_A,
        projectId: PID_A,
        path: '.hyperframes/studio-motion.json',
        blobScope: 'workspace',
        sha256: SHA_C,
        sizeBytes: 256,
        mimeType: 'application/json',
        isText: true,
        updatedAt: new Date(),
      },
    ];

    const { db } = createScriptedDb({
      selectQueue: [
        [projectRow], // lock project
        liveProjectFiles, // live project_files
      ],
      insertImpl(table, values) {
        if (table === projectVersionFiles) {
          insertedVersionFiles.push(...(values as Array<Record<string, unknown>>));
        }
        if (table === jobs) {
          return [{ ...(values as Record<string, unknown>), createdAt: new Date(), updatedAt: new Date() }];
        }
        return Array.isArray(values) ? values : [values];
      },
    });

    const exportService = new ExportService({
      db,
      storage,
      eventBus,
      queues: {
        enqueueRenderExport: async (name, payload, options) => {
          enqueuedRenders.push({ name, payload, options });
          return {} as never;
        },
        renderExport: {
          getJob: async () => null,
        } as never,
      },
    });

    const started = await exportService.startExport(authFor(), PID_A, {
      expectedRevision: REV_1,
      format: 'mp4',
    });

    assert.equal(started.replayed, false);
    assert.deepEqual(started.includedStudioManifests.sort(), [
      '.hyperframes/studio-manual-edits.json',
      '.hyperframes/studio-motion.json',
    ]);
    assert.equal(insertedVersionFiles.length, 3);
    assert.equal(enqueuedRenders.length, 1);
    assert.equal(enqueuedRenders[0].name, 'export_render');
    assert.deepEqual(enqueuedRenders[0].options, { attempts: 1 });

    // Stale expectedRevision rejects with 409 REVISION_CONFLICT.
    const { db: staleDb } = createScriptedDb({ selectQueue: [[projectRow]] });
    const staleExportSvc = new ExportService({
      db: staleDb,
      storage,
      eventBus,
      queues: { enqueueRenderExport: async () => ({}) as never, renderExport: { getJob: async () => null } as never },
    });
    await assert.rejects(
      () => staleExportSvc.startExport(authFor(), PID_A, { expectedRevision: REV_2 }),
      { code: 'REVISION_CONFLICT', status: 409 },
    );

    // Partial unique index violation maps cleanly to 409 EXPORT_BUSY.
    const { db: busyDb } = createScriptedDb({
      selectQueue: [[projectRow], liveProjectFiles],
      insertImpl(table, values) {
        if (table === jobs) {
          throw Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'uq_jobs_active_export_per_project',
          });
        }
        return Array.isArray(values) ? values : [values];
      },
    });
    const busyExportSvc = new ExportService({
      db: busyDb,
      storage,
      eventBus,
      queues: { enqueueRenderExport: async () => ({}) as never, renderExport: { getJob: async () => null } as never },
    });
    await assert.rejects(() => busyExportSvc.startExport(authFor(), PID_A), {
      code: 'EXPORT_BUSY',
      status: 409,
    });

    // Export routes: direct HEAD from PG metadata, 302 download, cancel publishing om:cancel:{jobId}, and SSE progress.
    const completedExportRow = {
      id: JID_A,
      workspaceId: WID_A,
      projectId: PID_A,
      kind: 'export_render',
      state: 'completed',
      stage: 'completed',
      progress: 100,
      versionId: VID_A,
      revision: REV_1,
      requestId: null,
      idempotencyKey: null,
      inputPayload: { outputName: 'launch-film.mp4', format: 'mp4', compositionPath: 'index.html' },
      resultJson: {
        s3Key: exportKey(WID_A, JID_A, 'launch-film.mp4'),
        outputName: 'launch-film.mp4',
        mimeType: 'video/mp4',
        bytes: 987_654,
        sha256: SHA_A,
      },
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: new Date(),
      terminalAt: new Date(),
      deletedAt: null,
      updatedAt: new Date(),
    };

    const runningExportRow = {
      ...completedExportRow,
      state: 'running',
      stage: 'rendering',
      progress: 40,
      resultJson: null,
      terminalAt: null,
    };

    const { db: routeDb } = createScriptedDb({
      selectQueue: [
        [completedExportRow], // HEAD download
        [completedExportRow], // GET download
        [runningExportRow], // cancel select
        [runningExportRow], // SSE initial getExport
        [runningExportRow], // SSE post-subscribe re-check
      ],
      updateImpl() {
        return [{ ...runningExportRow, state: 'cancelling', stage: 'cancelling' }];
      },
    });

    const routeExportSvc = new ExportService({
      db: routeDb,
      storage,
      eventBus,
      queues: { enqueueRenderExport: async () => ({}) as never, renderExport: { getJob: async () => null } as never },
    });
    const exportApp = createExportRoutes({
      exportService: routeExportSvc,
      getAuth: () => authFor(),
    });

    const headExportRes = await exportApp.request(`http://localhost/exports/${JID_A}/download`, { method: 'HEAD' });
    assert.equal(headExportRes.status, 200);
    assert.equal(headExportRes.headers.get('content-type'), 'video/mp4');
    assert.equal(headExportRes.headers.get('content-length'), '987654');
    assert.equal(headExportRes.headers.get('accept-ranges'), 'bytes');
    assert.equal(headExportRes.headers.get('etag'), `"sha256:${SHA_A}"`);

    const dlExportRes = await exportApp.request(`http://localhost/exports/${JID_A}/download`);
    assert.equal(dlExportRes.status, 302);
    assert.equal(dlExportRes.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(dlExportRes.headers.get('vary'), 'Origin, Cookie');
    assert.match(dlExportRes.headers.get('location') ?? '', /attachment%3B%20filename%3D%22launch-film\.mp4%22/);

    const cancelRes = await exportApp.request(`http://localhost/exports/${JID_A}/cancel`, { method: 'POST' });
    assert.equal(cancelRes.status, 200);
    assert.ok(eventBus.published.some((e) => e.channel === cancelChannel(JID_A)));

    // SSE stream replays initial state, delivers live Redis om:job:{jobId} terminal event, and closes cleanly.
    const sseRes = await exportApp.request(`http://localhost/exports/${JID_A}/progress`);
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') ?? '', /^text\/event-stream/);
    setTimeout(() => {
      void eventBus.publish(jobChannel(JID_A), {
        jobId: JID_A,
        workspaceId: WID_A,
        projectId: PID_A,
        kind: 'export_render',
        state: 'completed',
        stage: 'completed',
        progress: 100,
        resultJson: { outputName: 'launch-film.mp4', bytes: 987_654 },
        ts: Date.now(),
      } satisfies JobProgressEvent);
    }, 10);
    const sseText = await sseRes.text();
    assert.match(sseText, /"stage":"rendering"/);
    assert.match(sseText, /"status":"complete"/);
  });

  it('rejects cross-tenant export access cleanly (workspace_id scoping)', async () => {
    const storage = new MemoryStorage();
    const eventBus = new MemoryEventBus();
    const { db } = createScriptedDb({ selectQueue: [[]] });
    const exportService = new ExportService({
      db,
      storage,
      eventBus,
      queues: { enqueueRenderExport: async () => ({}) as never, renderExport: { getJob: async () => null } as never },
    });
    await assert.rejects(() => exportService.getExport(authFor({ workspaceId: WID_B }), JID_A), {
      code: 'EXPORT_NOT_FOUND',
      status: 404,
    });
  });
  it('supports same-workspace CAS instant commit, S3 multipart upload + resume + complete, and abort cleanup', async () => {
    const storage = new MemoryStorage();
    const eventBus = new MemoryEventBus();
    const sizeBytes = 12 * 1024 * 1024;
    const casKey = workspaceBlobKey(WID_A, SHA_A);
    storage.objects.set(casKey, { bytes: Buffer.alloc(sizeBytes, 0x11), contentType: 'video/mp4' });

    // 1. Same-workspace CAS instant commit ("秒传"): skips S3 presign PUT and publishes file-change SSE.
    const { db: instantDb } = createScriptedDb({
      selectQueue: [
        [{ id: PID_A, trashed: false }], // project exists check
        [{ workspaceId: WID_A, sha256: SHA_A, sizeBytes, mimeType: 'video/mp4', gcState: 'active' }], // workspaceBlobs lookup
        [{ id: PID_A, workspaceId: WID_A, trashed: false, currentVersionNumber: 2, revision: REV_1 }], // locked project FOR UPDATE
        [], // existing project_files
      ],
      insertImpl: (table) =>
        table === projectVersions
          ? [{ id: VID_A }]
          : table === workspaceBlobs
            ? [{ sha256: SHA_A }]
            : [],
    });
    const instantSvc = new AssetLibraryService({
      db: instantDb,
      storage,
      eventBus,
      queues: { enqueueMediaIngest: async () => ({}) as never },
    });
    const instantTicket = await instantSvc.createUploadTicket(authFor(), {
      purpose: 'project_asset',
      targetProjectId: PID_A,
      targetPath: 'assets/dup.mp4',
      filename: 'dup.mp4',
      mimeType: 'video/mp4',
      sizeBytes,
      expectedSha256: SHA_A,
      allowInstantCommit: true,
    });
    assert.equal(instantTicket.instantCommitted, true);
    assert.equal(instantTicket.projectPath, 'assets/dup.mp4');
    assert.equal(instantTicket.sha256, SHA_A);
    assert.equal(storage.presignedPuts.length, 0);
    assert.ok(
      eventBus.published.some(
        (e) =>
          e.channel === projectChannel(WID_A, PID_A) &&
          (e.payload as { type?: string }).type === 'file-change',
      ),
    );

    // 2. S3 Multipart Upload + Resume (ListParts) + Complete + Abort lifecycle
    const mpSize = 18 * 1024 * 1024; // 18 MiB -> 3 parts at 8 MiB
    let savedTicketRow: Record<string, unknown> | null = null;
    const { db: mpDb } = createScriptedDb({
      selectQueue: [
        [{ id: PID_A, trashed: false }], // createUploadTicket project check
      ],
      insertImpl: (table, values) => {
        if (table === uploadTickets && values && typeof values === 'object') {
          savedTicketRow = { ...(values as Record<string, unknown>), expiresAt: new Date(Date.now() + 600_000) };
        }
        return [];
      },
    });
    const mpSvc = new AssetLibraryService({
      db: mpDb,
      storage,
      eventBus,
      queues: { enqueueMediaIngest: async () => ({}) as never },
    });
    const mpTicket = await mpSvc.createUploadTicket(authFor(), {
      purpose: 'project_asset',
      targetProjectId: PID_A,
      targetPath: 'assets/big.mp4',
      filename: 'big.mp4',
      mimeType: 'video/mp4',
      sizeBytes: mpSize,
      multipart: true,
    });
    assert.equal(mpTicket.mode, 'multipart');
    assert.equal(mpTicket.partSize, 8 * 1024 * 1024);
    assert.equal(mpTicket.totalParts, 3);
    assert.ok(savedTicketRow);

    // Simulate part 1 already uploaded before disconnect -> prepareMultipartParts returns uploadedParts + only signs missing parts 2 & 3!
    const s3UploadId = (savedTicketRow as { resultPayload: { s3UploadId: string } }).resultPayload.s3UploadId;
    storage.multiparts.get(s3UploadId)!.parts.set(1, { etag: '"e1"', size: 8 * 1024 * 1024 });

    const { db: resumeDb } = createScriptedDb({
      selectQueue: [[savedTicketRow], [savedTicketRow]],
    });
    const resumeSvc = new AssetLibraryService({
      db: resumeDb,
      storage,
      eventBus,
      queues: { enqueueMediaIngest: async () => ({}) as never },
    });
    const partsRes = await resumeSvc.prepareMultipartParts(authFor(), mpTicket.uploadId);
    assert.deepEqual(partsRes.uploadedParts, [{ partNumber: 1, etag: '"e1"', size: 8 * 1024 * 1024 }]);
    assert.deepEqual(
      partsRes.urls.map((u) => u.partNumber),
      [2, 3],
    );
    assert.equal(partsRes.urls[1].sizeBytes, 2 * 1024 * 1024);

    // Complete multipart upload with all 3 parts -> staging object exists in S3!
    const completed = await resumeSvc.completeMultipartTicket(authFor(), mpTicket.uploadId, {
      parts: [
        { partNumber: 1, etag: '"e1"' },
        { partNumber: 2, etag: '"e2"' },
        { partNumber: 3, etag: '"e3"' },
      ],
    });
    assert.equal(completed.completed, true);
    assert.equal(completed.partsCount, 3);
    assert.ok(storage.objects.has(mpTicket.s3StagingKey));

    // Abort an active multipart upload cleans up S3 multipart state
    const mp2 = await storage.createMultipartUpload(uploadStagingKey(WID_A, JID_A), 'video/mp4');
    const { db: abortDb } = createScriptedDb({
      selectQueue: [
        [
          {
            id: JID_A,
            workspaceId: WID_A,
            userId: UID_A,
            s3StagingKey: uploadStagingKey(WID_A, JID_A),
            state: 'issued',
            resultPayload: { mode: 'multipart', s3UploadId: mp2.uploadId, partSize: 8 * 1024 * 1024, totalParts: 2 },
            expiresAt: new Date(Date.now() + 600_000),
          },
        ],
      ],
    });
    const abortSvc = new AssetLibraryService({
      db: abortDb,
      storage,
      eventBus,
      queues: { enqueueMediaIngest: async () => ({}) as never },
    });
    const aborted = await abortSvc.abortUploadTicket(authFor(), JID_A);
    assert.equal(aborted.aborted, true);
    assert.ok(storage.abortedMultiparts.includes(mp2.uploadId));
  });
});

// Keep schema imports exercised cleanly without unused-import warnings.
void idempotencyReceipts;
void projectFiles;
void projectVersions;
void projects;
void assetVersions;
