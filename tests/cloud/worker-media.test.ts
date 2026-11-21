import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import sharp from 'sharp';
import { verificationBinaries } from '../../scripts/verify-export.ts';
import { computeProjectRevision } from '../../shared/project-validation.ts';
import { PAT_SCOPES } from '../../src/contracts/auth.ts';
import {
  DEFAULT_BLOB_GC_GRACE_SECONDS,
  type MediaIngestJobName,
  type MediaIngestPayloadMap,
} from '../../src/contracts/jobs.ts';
import type { StoragePort } from '../../src/contracts/storage.ts';
import {
  finalizeBlobDeletion,
  markZeroRefForDeletion,
  normalizeBlobRefDeltas,
  reconcileDriftedBlobRefCounts,
  type PreviewProxyMetadata,
} from '../../src/db/cas.ts';
import type { Database } from '../../src/db/client.ts';
import { uploadTickets, workspaceBlobs } from '../../src/db/schema/blobs-assets.ts';
import { jobs } from '../../src/db/schema/jobs.ts';
import {
  projectFiles,
  projectHistoryEntries,
  projectVersionFiles,
  projectVersions,
} from '../../src/db/schema/project-files.ts';
import { projects } from '../../src/db/schema/projects.ts';
import { createLogger } from '../../src/infra/logger.ts';
import {
  buildImageThumbnailJobId,
  buildPreviewProxyJobId,
  buildVideoSpriteJobId,
  buildWaveformPeaksJobId,
  validateMediaIngestPayload,
} from '../../src/infra/queues.ts';
import { jobChannel, projectChannel } from '../../src/infra/redis.ts';
import {
  blobDerivedPrefix,
  blobThumbnailsPrefix,
  derivedAssetKey,
  thumbnailKey,
  uploadLicenseStagingKey,
  uploadStagingKey,
  workspaceBlobKey,
} from '../../src/infra/storage.ts';
import {
  CloudImportAssetsService,
  resolveProjectAssetTargetPath,
  type ImportAssetsStore,
  type UploadTicketRecord,
} from '../../src/mcp/import-assets.ts';
import {
  runBlobGcSweep,
  sweepExpiredUploads,
  sweepUnreferencedBlobs,
} from '../../src/workers/blob-gc.ts';
import {
  processMediaGenerateJob,
  type PlatformModelGateway,
} from '../../src/workers/media-generate.ts';
import {
  AsyncSemaphore,
  classifyPreviewProxyTarget,
  computeSpriteSamplingPlan,
  computeSpriteTileDimensions,
  handleExtractWaveformPeaksJob,
  handleFreezeFrameJob,
  handleGeneratePreviewProxyJob,
  handleGenerateVideoSpriteJob,
  handleImageThumbnailJob,
  handleLoudnessNormalizeJob,
  handleUploadCommitJob,
  handleUrlFetchJob,
  processMediaIngestJob,
  safePublicHttpsFetchToFile,
} from '../../src/workers/media-ingest.ts';

const execFileAsync = promisify(execFile);

const WID_A = '11111111-1111-4111-8111-111111111111';
const PID_A = '22222222-2222-4222-8222-222222222222';
const UID_A = '33333333-3333-4333-8333-333333333333';
const JID_A = '44444444-4444-4444-8444-444444444444';
const JID_B = '55555555-5555-4555-8555-555555555555';
const SHA_A = 'a'.repeat(64);

const SILENT_LOGGER = createLogger({ level: 'error', sink: () => {} });

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Build a valid PNG with an explicit SDR gAMA chunk so stripSdrPngColourTags actually transforms it. */
async function buildPngWithSdrGamaChunk(): Promise<Buffer> {
  const basePng = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 40, g: 120, b: 220, alpha: 1 } },
  })
    .png()
    .toBuffer();

  // Insert gAMA chunk right after PNG signature (8 bytes) + IHDR chunk (25 bytes = 4 len + 4 type + 13 data + 4 crc).
  const gamaData = Buffer.alloc(4);
  gamaData.writeUInt32BE(45455, 0); // standard sRGB gamma 1/2.2
  const gamaChunk = makePngChunk('gAMA', gamaData);
  const insertOffset = 8 + 25;
  return Buffer.concat([basePng.subarray(0, insertOffset), gamaChunk, basePng.subarray(insertOffset)]);
}

class InMemoryStorage implements StoragePort {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly trace: string[] = [];
  failDeleteKey?: string;
  copyObject?: (sourceKey: string, destinationKey: string, contentType?: string) => Promise<void>;

  async putObject(
    key: string,
    body: Buffer | Uint8Array | Readable | string,
    contentType: string,
  ): Promise<void> {
    this.trace.push(`put:${key}`);
    const bytes = Buffer.isBuffer(body)
      ? Buffer.from(body)
      : body instanceof Uint8Array
        ? Buffer.from(body)
        : typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : await (async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of body) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
              }
              return Buffer.concat(chunks);
            })();
    this.objects.set(key, { bytes, contentType });
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    this.trace.push(`putBlobIfAbsent:${key}`);
    if (this.objects.has(key)) return { uploaded: false };
    this.objects.set(key, { bytes: Buffer.from(body), contentType });
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const item = this.objects.get(key);
    if (!item) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(item.bytes);
  }

  async getObjectStream(key: string) {
    const item = this.objects.get(key);
    if (!item) throw new Error(`NoSuchKey: ${key}`);
    return {
      stream: Readable.from([Buffer.from(item.bytes)]),
      contentLength: item.bytes.byteLength,
      contentType: item.contentType,
    };
  }

  async headObject(key: string) {
    const item = this.objects.get(key);
    if (!item) return null;
    return { contentLength: item.bytes.byteLength, contentType: item.contentType };
  }

  async deleteObject(key: string): Promise<void> {
    this.trace.push(`deleteObject:${key}`);
    if (this.failDeleteKey === key) {
      throw new Error(`Simulated S3 delete error for ${key}`);
    }
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.trace.push(`deletePrefix:${prefix}`);
    let count = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        count += 1;
      }
    }
    return count;
  }

  async presignPut(key: string): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async presignGet(key: string): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

function createFakeDb(options: {
  selectQueue?: unknown[][];
  onUpdate?: (table: unknown, values: unknown) => unknown[];
  onInsert?: (table: unknown, values: unknown) => unknown[];
  trace?: string[];
}) {
  const queue = [...(options.selectQueue ?? [])];
  const trace = options.trace ?? [];
  const makeSelect = () => {
    let rows: unknown[] | null = null;
    const resolve = () => {
      if (rows === null) rows = queue.shift() ?? [];
      return Promise.resolve(rows);
    };
    const chain: Record<string, unknown> = {
      from() {
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
      then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) {
        return resolve().then(ok, err);
      },
    };
    return chain;
  };

  const exec: Record<string, unknown> = {
    select: () => makeSelect(),
    insert: (table: unknown) => ({
      values(values: unknown) {
        trace.push(`db:insert`);
        const run = () => Promise.resolve(options.onInsert ? options.onInsert(table, values) : [values]);
        const chain: Record<string, unknown> = {
          onConflictDoUpdate: () => chain,
          returning: () => run(),
          then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set(values: unknown) {
        trace.push(`db:update`);
        const run = () => Promise.resolve(options.onUpdate ? options.onUpdate(table, values) : [{ id: JID_A }]);
        const chain: Record<string, unknown> = {
          where: () => chain,
          returning: () => run(),
          then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
        };
        return chain;
      },
    }),
    delete: () => {
      const chain: Record<string, unknown> = {
        where: () => chain,
        returning: () => Promise.resolve([]),
        then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve([]).then(ok, err),
      };
      return chain;
    },
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      trace.push('db:tx:begin');
      const res = await fn(exec as unknown as Database);
      trace.push('db:tx:commit');
      return res;
    },
  };
  return exec as unknown as Database;
}

describe('worker-media: upload_commit, SDR PNG stripping, Upload-Before-Reference CAS & /tmp cleanup', () => {
  it('streams staged PNG, strips SDR gAMA tag, generates sharp thumbnail, uploads CAS BEFORE PG tx, deletes staging, and cleans /tmp', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-media-'));
    try {
      const storage = new InMemoryStorage();
      const rawPng = await buildPngWithSdrGamaChunk();
      assert.ok(rawPng.includes(Buffer.from('gAMA', 'ascii')), 'Test fixture must contain gAMA chunk');
      const rawSha = createHash('sha256').update(rawPng).digest('hex');

      const stagingKey = uploadStagingKey(WID_A, UID_A);
      await storage.putObject(stagingKey, rawPng, 'image/png');
      storage.trace.length = 0;

      const published: Array<{ channel: string; payload: unknown }> = [];
      const orderTrace: string[] = [];
      const recordedMetas: Array<Record<string, unknown>> = [];

      const ticketRow = {
        id: UID_A,
        workspaceId: WID_A,
        userId: UID_A,
        purpose: 'library_asset',
        targetProjectId: null,
        targetAssetId: null,
        targetPath: null,
        filename: 'photo.png',
        expectedMimeType: 'image/png',
        expectedModality: 'image',
        expectedSha256: rawSha,
        maxBytes: 1_000_000,
        s3StagingKey: stagingKey,
        licenseS3StagingKey: null,
        licenseFilename: null,
        licenseMaxBytes: null,
        state: 'uploaded',
        requestId: 'req-1',
        resultPayload: null,
        error: null,
        expiresAt: new Date(Date.now() + 60_000),
      };

      const db = createFakeDb({
        selectQueue: [[ticketRow]],
        trace: orderTrace,
      });

      const originalPutBlob = storage.putBlobIfAbsent.bind(storage);
      storage.putBlobIfAbsent = async (key, body, ct) => {
        orderTrace.push(`s3:putBlobIfAbsent:${key}`);
        return originalPutBlob(key, body, ct);
      };

      const result = await handleUploadCommitJob(
        {
          db,
          storage,
          eventBus: {
            publish: async (channel, payload) => {
              published.push({ channel, payload });
              return 1;
            },
          },
          logger: SILENT_LOGGER,
          workerId: 'media-test-1',
          tmpBaseDir: tmpRoot,
          probeMedia: async (filePath) => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: (await stat(filePath)).size,
            width: 32,
            height: 32,
          }),
          applyBlobDeltas: async (_tx, _wid, deltas) => {
            orderTrace.push(`cas:applyDeltas:${deltas[0].sha256}`);
            if (deltas[0].metadata) {
              recordedMetas.push(deltas[0].metadata as Record<string, unknown>);
            }
          },
        },
        {
          jobId: JID_A,
          workspaceId: WID_A,
          uploadId: UID_A,
          purpose: 'library_asset',
          name: 'Hero Photo',
        },
      );

      const finalSha = String(result.sha256);
      assert.notEqual(finalSha, rawSha, 'Stripping SDR gAMA chunk must change the stored CAS sha256');
      assert.equal(recordedMetas[0]?.sdrNormalized, true);

      // Verify stored CAS PNG no longer has the gAMA chunk.
      const storedCas = storage.objects.get(workspaceBlobKey(WID_A, finalSha));
      assert.ok(storedCas);
      assert.equal(storedCas.bytes.includes(Buffer.from('gAMA', 'ascii')), false);

      // Verify thumbnail was generated via sharp and uploaded.
      const thumb = storage.objects.get(thumbnailKey(WID_A, finalSha, 'w320'));
      assert.ok(thumb && thumb.bytes.byteLength > 0);
      assert.equal(thumb.contentType, 'image/jpeg');

      // Verify Upload-Before-Reference invariant: S3 putBlobIfAbsent happened BEFORE db:tx:begin & cas:applyDeltas!
      const s3UploadIdx = orderTrace.findIndex((entry) => entry.startsWith('s3:putBlobIfAbsent:'));
      const txBeginIdx = orderTrace.indexOf('db:tx:begin');
      const casDeltaIdx = orderTrace.findIndex((entry) => entry.startsWith('cas:applyDeltas:'));
      assert.ok(s3UploadIdx >= 0 && txBeginIdx > s3UploadIdx && casDeltaIdx > txBeginIdx);

      // Verify staging object was deleted after commit and Redis ready event was published.
      assert.equal(storage.objects.has(stagingKey), false);
      assert.ok(published.some((e) => e.channel === jobChannel(JID_A) && (e.payload as { state: string }).state === 'completed'));

      // Verify /tmp/om-ingest-<jobId> was wiped.
      await assert.rejects(() => access(path.join(tmpRoot, `om-ingest-${JID_A}`)));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('promotes project_asset WOFF2 font + companion license without ffprobe and rejects project_archive', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-font-'));
    try {
      const storage = new InMemoryStorage();
      const fontBytes = Buffer.concat([Buffer.from('wOF2', 'ascii'), Buffer.alloc(64, 0x2a)]);
      const licenseBytes = Buffer.from('SIL Open Font License 1.1\n', 'utf8');
      const fontSha = createHash('sha256').update(fontBytes).digest('hex');
      const licenseSha = createHash('sha256').update(licenseBytes).digest('hex');

      const mainStagingKey = uploadStagingKey(WID_A, UID_A);
      const licStagingKey = uploadLicenseStagingKey(WID_A, UID_A);
      await storage.putObject(mainStagingKey, fontBytes, 'font/woff2');
      await storage.putObject(licStagingKey, licenseBytes, 'text/plain; charset=utf-8');

      const ticketRow = {
        id: UID_A,
        workspaceId: WID_A,
        userId: UID_A,
        purpose: 'project_asset',
        targetProjectId: PID_A,
        targetAssetId: null,
        targetPath: 'assets/fonts/Inter-Bold.woff2',
        filename: 'Inter-Bold.woff2',
        expectedMimeType: 'font/woff2',
        expectedModality: null,
        expectedSha256: fontSha,
        maxBytes: 100_000,
        s3StagingKey: mainStagingKey,
        licenseS3StagingKey: licStagingKey,
        licenseFilename: 'OFL.txt',
        licenseMaxBytes: 10_000,
        state: 'uploaded',
        requestId: 'req-font-upload',
        resultPayload: null,
        error: null,
        expiresAt: new Date(Date.now() + 60_000),
      };

      const appliedDeltas: Array<{ sha256: string; delta: number }> = [];
      let ffprobeCalled = false;
      const db = createFakeDb({
        selectQueue: [
          [ticketRow], // load ticket
          [{ id: PID_A, trashed: false, currentVersionNumber: 1, currentHistorySeq: 1 }], // lock parent project row FOR UPDATE
          [], // existing project_files
          [{ maxVer: 1 }], // MAX(project_versions.version_number)
          [{ maxSeq: 1 }], // MAX(project_history_entries.seq)
          [{ id: '66666666-6666-4666-8666-666666666666' }], // parent history entry
        ],
      });

      const res = await handleUploadCommitJob(
        {
          db,
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-font-1',
          tmpBaseDir: tmpRoot,
          probeMedia: async () => {
            ffprobeCalled = true;
            throw new Error('ffprobe must not run for WOFF2 font uploads');
          },
          applyBlobDeltas: async (_tx, _wid, deltas) => {
            for (const d of deltas) appliedDeltas.push({ sha256: d.sha256, delta: d.delta });
          },
        },
        {
          jobId: JID_A,
          workspaceId: WID_A,
          uploadId: UID_A,
          purpose: 'project_asset',
          targetProjectId: PID_A,
          targetPath: 'assets/fonts/Inter-Bold.woff2',
          name: 'Inter-Bold.woff2',
        },
      );

      assert.equal(ffprobeCalled, false);
      assert.equal(res.modality, 'font');
      assert.equal(res.mimeType, 'font/woff2');
      assert.equal(res.projectPath, 'assets/fonts/Inter-Bold.woff2');
      assert.equal(res.licenseProjectPath, 'assets/fonts/OFL.txt');
      assert.equal(res.projectVersionNumber, 2);
      assert.equal(
        res.projectRevision,
        computeProjectRevision([
          { path: 'assets/fonts/Inter-Bold.woff2', size: fontBytes.byteLength, hash: fontSha },
          { path: 'assets/fonts/OFL.txt', size: licenseBytes.byteLength, hash: licenseSha },
        ]),
      );
      assert.ok(storage.objects.has(workspaceBlobKey(WID_A, fontSha)));
      assert.ok(storage.objects.has(workspaceBlobKey(WID_A, licenseSha)));
      assert.equal(storage.objects.has(mainStagingKey), false);
      assert.equal(storage.objects.has(licStagingKey), false);
      assert.equal(appliedDeltas.length, 2);
      assert.deepEqual(
        appliedDeltas,
        normalizeBlobRefDeltas([
          { sha256: fontSha, delta: 2 },
          { sha256: licenseSha, delta: 2 },
        ]).map(({ sha256, delta }) => ({ sha256, delta })),
      );

      // Explicit rejection of purpose === 'project_archive' (must never fall through into library_asset).
      const archiveTicket = { ...ticketRow, purpose: 'project_archive', licenseS3StagingKey: null, expectedSha256: null };
      await storage.putObject(mainStagingKey, Buffer.from('PK\x03\x04dummy-zip-content'), 'application/zip');
      const archiveDb = createFakeDb({ selectQueue: [[archiveTicket]] });
      await assert.rejects(
        () =>
          handleUploadCommitJob(
            {
              db: archiveDb,
              storage,
              eventBus: { publish: async () => 1 },
              logger: SILENT_LOGGER,
              workerId: 'media-font-1',
              tmpBaseDir: tmpRoot,
            },
            {
              jobId: JID_B,
              workspaceId: WID_A,
              uploadId: UID_A,
              purpose: 'project_archive',
              name: 'export.zip',
            },
          ),
        { code: 'INVALID_ARGUMENT' },
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: url_fetch SSRF & DNS-Pinning Checks', () => {
  it('blocks private IP and Fake-IP DNS answers when ALLOW_DOH_FAKEIP_FALLBACK=false', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-ssrf-'));
    try {
      const dest = path.join(tmpRoot, 'out.bin');
      await assert.rejects(
        () =>
          safePublicHttpsFetchToFile('https://public.example.com/clip.mp4', dest, {
            allowDohFakeIpFallback: false,
            resolveDns: async () => [{ address: '127.0.0.1', family: 4 }],
          }),
        { code: 'SSRF_BLOCKED' },
      );

      await assert.rejects(
        () =>
          safePublicHttpsFetchToFile('https://public.example.com/clip.mp4', dest, {
            allowDohFakeIpFallback: false,
            resolveDns: async () => [{ address: '169.254.169.254', family: 4 }],
          }),
        { code: 'SSRF_BLOCKED' },
      );

      await assert.rejects(
        () =>
          safePublicHttpsFetchToFile('https://public.example.com/clip.mp4', dest, {
            allowDohFakeIpFallback: false,
            resolveDns: async () => [{ address: '198.18.0.2', family: 4 }],
          }),
        { code: 'SSRF_BLOCKED' },
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('promotes validated url_fetch downloads into CAS identically to upload_commit', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-urlfetch-'));
    try {
      const storage = new InMemoryStorage();
      const pngBytes = await sharp({
        create: { width: 16, height: 16, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
      })
        .png()
        .toBuffer();

      const db = createFakeDb({});
      const published: Array<{ channel: string; payload: unknown }> = [];
      let appliedDeltaCount = 0;

      const promoted = await handleUrlFetchJob(
        {
          db,
          storage,
          eventBus: {
            publish: async (channel, payload) => {
              published.push({ channel, payload });
              return 1;
            },
          },
          logger: SILENT_LOGGER,
          workerId: 'media-test-1',
          tmpBaseDir: tmpRoot,
          fetchPublicUrlToFile: async (_url, destPath) => {
            await writeFile(destPath, pngBytes);
            return {
              finalUrl: 'https://cdn.example.com/image.png',
              bytes: pngBytes.byteLength,
              sha256: createHash('sha256').update(pngBytes).digest('hex'),
            };
          },
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 16,
            height: 16,
          }),
          applyBlobDeltas: async (_tx, _wid, deltas) => {
            appliedDeltaCount += deltas.length;
          },
        },
        {
          jobId: JID_B,
          workspaceId: WID_A,
          url: 'https://cdn.example.com/image.png',
          name: 'Remote Image',
          requestId: 'req-url-ok',
        },
      );

      assert.equal(appliedDeltaCount, 1);
      assert.ok(storage.objects.has(workspaceBlobKey(WID_A, String(promoted.sha256))));
      assert.ok(published.some((p) => p.channel === jobChannel(JID_B)));
      await assert.rejects(() => access(path.join(tmpRoot, `om-ingest-${JID_B}`)));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: Offloaded Studio Jobs (#11 §3)', () => {
  it('handles image_thumbnail, extract_waveform_peaks, loudness_normalize, and freeze_frame writing derived S3 keys', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-studio-media-'));
    try {
      const storage = new InMemoryStorage();
      const pngBytes = await sharp({
        create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } },
      })
        .png()
        .toBuffer();
      const pngSha = createHash('sha256').update(pngBytes).digest('hex');
      await storage.putObject(workspaceBlobKey(WID_A, pngSha), pngBytes, 'image/png');
      await storage.putObject(workspaceBlobKey(WID_A, SHA_A), Buffer.from('fake-av-stream'), 'video/mp4');

      const db = createFakeDb({});
      const published: Array<{ channel: string; payload: unknown }> = [];
      const baseDeps = {
        db,
        storage,
        eventBus: {
          publish: async (channel: string, payload: unknown) => {
            published.push({ channel, payload });
            return 1;
          },
        },
        logger: SILENT_LOGGER,
        workerId: 'media-test-1',
        tmpBaseDir: tmpRoot,
      };

      // 1. image_thumbnail
      const thumbRes = await handleImageThumbnailJob(
        {
          ...baseDeps,
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 64,
            height: 64,
          }),
        },
        {
          workspaceId: WID_A,
          blobScope: 'workspace',
          sha256: pngSha,
          spec: 'w32',
          width: 32,
        },
      );
      assert.equal(thumbRes.key, thumbnailKey(WID_A, pngSha, 'w32'));
      assert.ok(storage.objects.has(thumbRes.key));

      // 2. extract_waveform_peaks
      const peaksRes = await handleExtractWaveformPeaksJob(
        {
          ...baseDeps,
          probeMedia: async () => ({
            modality: 'audio',
            mimeType: 'audio/wav',
            extension: 'wav',
            sizeBytes: 100,
            durationSec: 2,
          }),
          runFfmpegCommand: async (_bin, args) => {
            const outFile = args.at(-1)!;
            const pcm = Buffer.alloc(64);
            pcm.writeInt16LE(16384, 0);
            pcm.writeInt16LE(-32768, 2);
            await writeFile(outFile, pcm);
            return { code: 0, stdout: '', stderr: '' };
          },
        },
        {
          workspaceId: WID_A,
          blobScope: 'workspace',
          sha256: SHA_A,
          samples: 16,
        },
      );
      assert.equal(peaksRes.key, derivedAssetKey(WID_A, SHA_A, 'waveform-peaks.json'));
      assert.equal(peaksRes.peaks.length, 16);
      assert.ok(peaksRes.peaks[0] >= 0.5);
      assert.ok(storage.objects.has(peaksRes.key));

      // 3. loudness_normalize
      const eburStderr = `
Summary:
  Integrated loudness:
    I:         -22.4 LUFS
    Threshold: -32.4 LUFS
  Loudness range:
    LRA:         4.2 LU
  True peak:
    Peak:       -4.1 dBFS
`;
      const loudRes = await handleLoudnessNormalizeJob(
        {
          ...baseDeps,
          runFfmpegCommand: async () => ({ code: 0, stdout: '', stderr: eburStderr }),
        },
        {
          jobId: JID_A,
          workspaceId: WID_A,
          projectId: PID_A,
          blobScope: 'workspace',
          sha256: SHA_A,
          targetPath: 'assets/voice.wav',
          targetLufs: -16,
        },
      );
      assert.equal(loudRes.measuredLufs, -22.4);
      assert.equal(loudRes.derivedKey, derivedAssetKey(WID_A, SHA_A, 'loudness.json'));
      assert.ok(storage.objects.has(String(loudRes.derivedKey)));

      // 4. freeze_frame (locks parent project row FOR UPDATE before checking existing project_files)
      const freezeDb = createFakeDb({
        selectQueue: [
          [{ id: PID_A, trashed: false }], // locked project row
          [], // existing project_files
        ],
      });
      const freezeRes = await handleFreezeFrameJob(
        {
          ...baseDeps,
          db: freezeDb,
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 64,
            height: 64,
          }),
          runFfmpegCommand: async (_bin, args) => {
            await writeFile(args.at(-1)!, pngBytes);
            return { code: 0, stdout: '', stderr: '' };
          },
          applyBlobDeltas: async () => {},
        },
        {
          jobId: JID_B,
          workspaceId: WID_A,
          projectId: PID_A,
          blobScope: 'workspace',
          sha256: SHA_A,
          timestampSec: 1.5,
          targetPath: 'assets/freeze-1500.png',
        },
      );
      assert.equal(freezeRes.path, 'assets/freeze-1500.png');
      assert.equal(freezeRes.derivedKey, derivedAssetKey(WID_A, SHA_A, 'freeze-1500ms.png'));
      assert.ok(storage.objects.has(workspaceBlobKey(WID_A, String(freezeRes.sha256))));
      assert.ok(storage.objects.has(String(freezeRes.derivedKey)));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: media-generate (remote_id persisted BEFORE polling + resume skips submit)', () => {
  it('persists remote_id in PG BEFORE polling PlatformModelGateway and never re-submits on resume', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-gen-'));
    try {
      const storage = new InMemoryStorage();
      const pngBytes = await sharp({
        create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 255, b: 0, alpha: 1 } },
      })
        .png()
        .toBuffer();

      const timeline: string[] = [];
      let persistedRemoteId: string | null = null;
      let submitCount = 0;

      const gateway: PlatformModelGateway = {
        providerId: 'opendesign',
        async listMediaModels() {
          return [];
        },
        async uploadReference() {
          return { remoteAssetId: 'ref_1' };
        },
        async submitTask() {
          submitCount += 1;
          timeline.push('gateway:submitTask');
          return { remoteTaskId: 'remote_task_42' };
        },
        async pollTask() {
          timeline.push(`gateway:pollTask(persistedRemoteId=${persistedRemoteId})`);
          return {
            remoteTaskId: 'remote_task_42',
            status: 'succeeded',
            outputs: [{ inlineBytes: pngBytes, mimeType: 'image/png', sizeBytes: pngBytes.byteLength }],
          };
        },
        async downloadOutput() {
          throw new Error('inlineBytes path used');
        },
      };

      let capturedClaimToken = '';
      const db = createFakeDb({
        selectQueue: [
          // Transaction fencing check: returns claimToken captured during claim update
          [{ state: 'running', get claimToken() { return capturedClaimToken; } }],
        ],
        onUpdate(table, values) {
          const v = values as Record<string, unknown>;
          if (table === jobs && typeof v.claimToken === 'string') {
            capturedClaimToken = v.claimToken;
            return [
              {
                id: JID_A,
                workspaceId: WID_A,
                projectId: null,
                state: 'running',
                claimToken: capturedClaimToken,
                remoteId: null,
                inputPayload: {
                  modality: 'image',
                  mode: 'text-to-image',
                  modelId: 'mock-image-1',
                  prompt: 'A sunrise over mountains',
                  parameters: {},
                  assetName: 'Sunrise',
                },
              },
            ];
          }
          if (table === jobs && typeof v.remoteId === 'string') {
            persistedRemoteId = v.remoteId;
            timeline.push(`db:persist_remote_id:${v.remoteId}`);
            return [{ id: JID_A }];
          }
          return [{ id: JID_A }];
        },
      });

      const published: Array<{ channel: string; payload: unknown }> = [];
      const res = await processMediaGenerateJob(
        {
          db,
          storage,
          eventBus: {
            publish: async (channel, payload) => {
              published.push({ channel, payload });
              return 1;
            },
            subscribe: async () => async () => {},
          },
          logger: SILENT_LOGGER,
          workerId: 'media-gen-1',
          gateway,
          pollIntervalMs: 1,
          tmpBaseDir: tmpRoot,
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 16,
            height: 16,
          }),
          applyBlobDeltas: async () => {},
        },
        'generate_media',
        { jobId: JID_A, workspaceId: WID_A },
      );

      assert.equal(res.state, 'completed');
      assert.equal(submitCount, 1);
      assert.equal(persistedRemoteId, 'remote_task_42');
      // Verify strict chronological order: submit -> db persist remote_id -> poll!
      assert.deepEqual(timeline, [
        'gateway:submitTask',
        'db:persist_remote_id:remote_task_42',
        'gateway:pollTask(persistedRemoteId=remote_task_42)',
      ]);
      assert.ok(published.some((e) => e.channel === jobChannel(JID_A)));

      // Resume with existing remote_id MUST NOT call submitTask again.
      let resumeClaimToken = '';
      const resumeDb = createFakeDb({
        selectQueue: [[{ state: 'running', get claimToken() { return resumeClaimToken; } }]],
        onUpdate(table, values) {
          const v = values as Record<string, unknown>;
          if (table === jobs && typeof v.claimToken === 'string') {
            resumeClaimToken = v.claimToken;
            return [
              {
                id: JID_B,
                workspaceId: WID_A,
                projectId: null,
                state: 'running',
                claimToken: resumeClaimToken,
                remoteId: 'remote_task_42',
                inputPayload: {
                  modality: 'image',
                  mode: 'text-to-image',
                  modelId: 'mock-image-1',
                  prompt: 'A sunrise over mountains',
                  parameters: {},
                  assetName: 'Sunrise',
                },
              },
            ];
          }
          return [{ id: JID_B }];
        },
      });
      await processMediaGenerateJob(
        {
          db: resumeDb,
          storage,
          eventBus: { publish: async () => 1, subscribe: async () => async () => {} },
          logger: SILENT_LOGGER,
          workerId: 'media-gen-1',
          gateway,
          pollIntervalMs: 1,
          tmpBaseDir: tmpRoot,
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 16,
            height: 16,
          }),
          applyBlobDeltas: async () => {},
        },
        'resume_generation',
        { jobId: JID_B, workspaceId: WID_A, remoteId: 'remote_task_42' },
      );
      assert.equal(submitCount, 1, 'resume_generation must NEVER re-submit paid upstream task');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('maps upstream cancelled status to cancelled and emits exactly one failed SSE event on upstream failure', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-gen-term-'));
    try {
      const storage = new InMemoryStorage();

      // 1. Upstream cancelled -> state: 'cancelled', single cancelled event.
      const cancelEvents: Array<Record<string, unknown>> = [];
      const cancelDbUpdates: Array<Record<string, unknown>> = [];
      const cancelDb = createFakeDb({
        onUpdate(table, values) {
          const v = values as Record<string, unknown>;
          if (table === jobs && typeof v.claimToken === 'string') {
            return [
              {
                id: JID_A,
                workspaceId: WID_A,
                projectId: null,
                state: 'running',
                claimToken: v.claimToken,
                remoteId: 'remote_cancel_1',
                inputPayload: {
                  modality: 'image',
                  mode: 'text-to-image',
                  modelId: 'mock-image-1',
                  prompt: 'Cancel test',
                  parameters: {},
                  assetName: 'Cancel Test',
                },
              },
            ];
          }
          cancelDbUpdates.push(v);
          return [{ id: JID_A }];
        },
      });
      const cancelGateway: PlatformModelGateway = {
        providerId: 'opendesign',
        async listMediaModels() { return []; },
        async uploadReference() { return { remoteAssetId: 'r' }; },
        async submitTask() { throw new Error('must not submit'); },
        async pollTask() {
          return {
            remoteTaskId: 'remote_cancel_1',
            status: 'cancelled',
            error: { code: 'USER_CANCELLED', message: 'Cancelled upstream' },
          };
        },
        async downloadOutput() { throw new Error('no output'); },
      };

      const cancelRes = await processMediaGenerateJob(
        {
          db: cancelDb,
          storage,
          eventBus: {
            publish: async (_ch, payload) => {
              cancelEvents.push(payload as Record<string, unknown>);
              return 1;
            },
            subscribe: async () => async () => {},
          },
          logger: SILENT_LOGGER,
          workerId: 'media-gen-2',
          gateway: cancelGateway,
          pollIntervalMs: 1,
          tmpBaseDir: tmpRoot,
        },
        'resume_generation',
        { jobId: JID_A, workspaceId: WID_A, remoteId: 'remote_cancel_1' },
      );
      assert.equal(cancelRes.state, 'cancelled');
      assert.ok(cancelDbUpdates.some((u) => u.state === 'cancelled'));
      assert.equal(cancelEvents.filter((e) => e.state === 'cancelled').length, 1);
      assert.equal(cancelEvents.filter((e) => e.state === 'failed').length, 0);

      // 2. Upstream failed -> exactly ONE failed SSE event carrying upstream errorCode (never duplicate STORAGE_ERROR).
      const failEvents: Array<Record<string, unknown>> = [];
      const failDb = createFakeDb({
        onUpdate(table, values) {
          const v = values as Record<string, unknown>;
          if (table === jobs && typeof v.claimToken === 'string') {
            return [
              {
                id: JID_B,
                workspaceId: WID_A,
                projectId: null,
                state: 'running',
                claimToken: v.claimToken,
                remoteId: 'remote_fail_1',
                inputPayload: {
                  modality: 'image',
                  mode: 'text-to-image',
                  modelId: 'mock-image-1',
                  prompt: 'Fail test',
                  parameters: {},
                  assetName: 'Fail Test',
                },
              },
            ];
          }
          return [{ id: JID_B }];
        },
      });
      const failGateway: PlatformModelGateway = {
        ...cancelGateway,
        async pollTask() {
          return {
            remoteTaskId: 'remote_fail_1',
            status: 'failed',
            error: { code: 'insufficient_balance', message: 'Insufficient balance' },
          };
        },
      };

      await assert.rejects(() =>
        processMediaGenerateJob(
          {
            db: failDb,
            storage,
            eventBus: {
              publish: async (_ch, payload) => {
                failEvents.push(payload as Record<string, unknown>);
                return 1;
              },
              subscribe: async () => async () => {},
            },
            logger: SILENT_LOGGER,
            workerId: 'media-gen-2',
            gateway: failGateway,
            pollIntervalMs: 1,
            tmpBaseDir: tmpRoot,
          },
          'resume_generation',
          { jobId: JID_B, workspaceId: WID_A, remoteId: 'remote_fail_1' },
        ),
      );
      const failedPublished = failEvents.filter((e) => e.state === 'failed');
      assert.equal(failedPublished.length, 1, 'Must emit exactly one failed event (no duplicate catch event)');
      assert.equal(failedPublished[0].errorCode, 'insufficient_balance');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: Two-Phase CAS blob-gc & Expired Upload Sweeper', () => {
  it('deletes blob + thumbnails/{sha256}/ + derived/{sha256}/ and resurrects on transient S3 failure', async () => {
    const storage = new InMemoryStorage();
    const shaOk = 'a'.repeat(64);
    const shaFail = 'b'.repeat(64);

    await storage.putObject(workspaceBlobKey(WID_A, shaOk), Buffer.from('blob-ok'), 'video/mp4');
    await storage.putObject(thumbnailKey(WID_A, shaOk, 'w320'), Buffer.from('thumb'), 'image/jpeg');
    await storage.putObject(derivedAssetKey(WID_A, shaOk, 'waveform-peaks.json'), Buffer.from('{}'), 'application/json');

    await storage.putObject(workspaceBlobKey(WID_A, shaFail), Buffer.from('blob-fail'), 'video/mp4');
    storage.failDeleteKey = workspaceBlobKey(WID_A, shaFail);

    const finalized: string[] = [];
    const resurrected: string[] = [];

    const result = await sweepUnreferencedBlobs(
      {
        db: createFakeDb({}),
        storage,
        logger: SILENT_LOGGER,
        casOps: {
          markZeroRefForDeletion: async () => [
            { workspaceId: WID_A, sha256: shaOk, s3Key: workspaceBlobKey(WID_A, shaOk) },
            { workspaceId: WID_A, sha256: shaFail, s3Key: workspaceBlobKey(WID_A, shaFail) },
          ],
          finalizeBlobDeletion: async (_db, _wid, sha) => {
            finalized.push(sha);
            return true;
          },
          resurrectBlobIfReferenced: async (_db, _wid, sha) => {
            resurrected.push(sha);
            return true;
          },
        },
      },
      { batchSize: 500, graceSeconds: 86_400 },
    );

    assert.equal(result.claimed, 2);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.thumbnailsDeleted, 1);
    assert.equal(result.derivedDeleted, 1);
    assert.deepEqual(finalized, [shaOk]);
    assert.deepEqual(resurrected, [shaFail]);

    // Verify all 3 keyspaces for shaOk were removed from S3.
    assert.equal(storage.objects.has(workspaceBlobKey(WID_A, shaOk)), false);
    assert.ok(storage.trace.includes(`deletePrefix:${blobThumbnailsPrefix(WID_A, shaOk)}`));
    assert.ok(storage.trace.includes(`deletePrefix:${blobDerivedPrefix(WID_A, shaOk)}`));
  });

  it('sweeps expired upload tickets and deletes both main and companion font license staging keys', async () => {
    const storage = new InMemoryStorage();
    const mainKey = uploadStagingKey(WID_A, UID_A);
    const licKey = uploadLicenseStagingKey(WID_A, UID_A);
    await storage.putObject(mainKey, Buffer.from('stale'), 'font/woff2');
    await storage.putObject(licKey, Buffer.from('license'), 'text/plain');

    let updatedToExpired = false;
    const db = createFakeDb({
      selectQueue: [
        [
          {
            id: UID_A,
            workspaceId: WID_A,
            s3StagingKey: mainKey,
            licenseS3StagingKey: licKey,
            state: 'issued',
            expiresAt: new Date(Date.now() - 10_000),
          },
        ],
      ],
      onUpdate(table, values) {
        if (table === uploadTickets && (values as Record<string, unknown>).state === 'expired') {
          updatedToExpired = true;
        }
        return [];
      },
    });

    const res = await sweepExpiredUploads({ db, storage, logger: SILENT_LOGGER }, { batchSize: 100 });
    assert.equal(res.swept, 1);
    assert.equal(res.failed, 0);
    assert.equal(updatedToExpired, true);
    assert.equal(storage.objects.has(mainKey), false);
    assert.equal(storage.objects.has(licKey), false);
  });

  it('heals drifted ref_count=0 live blobs, enforces 7-day grace window, and protects concurrent references on finalize (c3)', async () => {
    assert.equal(runBlobGcSweep, sweepUnreferencedBlobs);

    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const dayMs = 86_400_000;
    const shaProjectFile = '1'.repeat(64);
    const shaVersionFile = '2'.repeat(64);
    const shaAssetVersion = '3'.repeat(64);
    const shaUploadTicket = '4'.repeat(64);
    const shaDriftedHigh = '5'.repeat(64);
    const shaWithinGrace = '6'.repeat(64);
    const shaPastGrace = '7'.repeat(64);

    interface BlobRow {
      workspaceId: string;
      sha256: string;
      s3Key: string;
      refCount: number;
      zeroRefSince: Date | null;
      gcState: 'active' | 'deleting';
    }

    const blobs = new Map<string, BlobRow>([
      [
        shaProjectFile,
        {
          workspaceId: WID_A,
          sha256: shaProjectFile,
          s3Key: workspaceBlobKey(WID_A, shaProjectFile),
          refCount: 0,
          zeroRefSince: new Date(nowMs - 10 * dayMs),
          gcState: 'active',
        },
      ],
      [
        shaVersionFile,
        {
          workspaceId: WID_A,
          sha256: shaVersionFile,
          s3Key: workspaceBlobKey(WID_A, shaVersionFile),
          refCount: 0,
          zeroRefSince: new Date(nowMs - 10 * dayMs),
          gcState: 'deleting',
        },
      ],
      [
        shaAssetVersion,
        {
          workspaceId: WID_A,
          sha256: shaAssetVersion,
          s3Key: workspaceBlobKey(WID_A, shaAssetVersion),
          refCount: 0,
          zeroRefSince: new Date(nowMs - 10 * dayMs),
          gcState: 'active',
        },
      ],
      [
        shaUploadTicket,
        {
          workspaceId: WID_A,
          sha256: shaUploadTicket,
          s3Key: workspaceBlobKey(WID_A, shaUploadTicket),
          refCount: 0,
          zeroRefSince: new Date(nowMs - 10 * dayMs),
          gcState: 'active',
        },
      ],
      [
        shaDriftedHigh,
        {
          workspaceId: WID_A,
          sha256: shaDriftedHigh,
          s3Key: workspaceBlobKey(WID_A, shaDriftedHigh),
          refCount: 2,
          zeroRefSince: null,
          gcState: 'active',
        },
      ],
      [
        shaWithinGrace,
        {
          workspaceId: WID_A,
          sha256: shaWithinGrace,
          s3Key: workspaceBlobKey(WID_A, shaWithinGrace),
          refCount: 0,
          zeroRefSince: new Date(nowMs - 6 * dayMs),
          gcState: 'active',
        },
      ],
      [
        shaPastGrace,
        {
          workspaceId: WID_A,
          sha256: shaPastGrace,
          s3Key: workspaceBlobKey(WID_A, shaPastGrace),
          refCount: 0,
          zeroRefSince: new Date(nowMs - 8 * dayMs),
          gcState: 'active',
        },
      ],
    ]);

    const pfRefs = [{ workspaceId: WID_A, blobScope: 'workspace', sha256: shaProjectFile }];
    const pvfRefs = [
      { workspaceId: WID_A, blobScope: 'workspace', sha256: shaVersionFile },
      { workspaceId: WID_A, blobScope: 'workspace', sha256: shaVersionFile },
    ];
    const avRefs = [{ workspaceId: WID_A, sha256: shaAssetVersion }];
    const activeUploadTickets = [{ workspaceId: WID_A, expectedSha256: shaUploadTicket, state: 'processing' }];

    const liveRefCount = (wid: string, sha: string) =>
      pfRefs.filter((r) => r.workspaceId === wid && r.blobScope === 'workspace' && r.sha256 === sha).length +
      pvfRefs.filter((r) => r.workspaceId === wid && r.blobScope === 'workspace' && r.sha256 === sha).length +
      avRefs.filter((r) => r.workspaceId === wid && r.sha256 === sha).length;
    const hasActiveUpload = (wid: string, sha: string) =>
      activeUploadTickets.some(
        (ut) =>
          ut.workspaceId === wid &&
          ut.expectedSha256 === sha &&
          ['issued', 'uploaded', 'processing'].includes(ut.state),
      );

    const storage = new InMemoryStorage();
    for (const row of blobs.values()) {
      await storage.putObject(row.s3Key, Buffer.from(`bytes-${row.sha256.slice(0, 4)}`), 'video/mp4');
      await storage.putObject(thumbnailKey(WID_A, row.sha256, 'w320'), Buffer.from('thumb'), 'image/jpeg');
      await storage.putObject(derivedAssetKey(WID_A, row.sha256, 'proxy.mp4'), Buffer.from('proxy'), 'video/mp4');
    }

    const dialect = new PgDialect();
    const callOrder: string[] = [];

    const markAndSweepDb = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        if (compiled.sql.includes('WITH drifted_live AS')) {
          callOrder.push('reconcile:heal_live');
          const healed: Array<Record<string, unknown>> = [];
          for (const row of blobs.values()) {
            const count = liveRefCount(row.workspaceId, row.sha256);
            if (count > 0 && (row.refCount === 0 || row.zeroRefSince !== null || row.gcState === 'deleting')) {
              row.refCount = count;
              row.zeroRefSince = null;
              row.gcState = 'active';
              healed.push({ workspaceId: row.workspaceId, sha256: row.sha256, liveCount: count });
            }
          }
          return { rows: healed };
        }
        if (compiled.sql.includes('WITH drifted_unreferenced AS')) {
          callOrder.push('reconcile:mark_unref');
          const marked: Array<Record<string, unknown>> = [];
          for (const row of blobs.values()) {
            if (
              row.gcState === 'active' &&
              (row.refCount > 0 || row.zeroRefSince === null) &&
              liveRefCount(row.workspaceId, row.sha256) === 0 &&
              !hasActiveUpload(row.workspaceId, row.sha256)
            ) {
              row.refCount = 0;
              row.zeroRefSince = row.zeroRefSince ?? new Date(nowMs);
              marked.push({ workspaceId: row.workspaceId, sha256: row.sha256 });
            }
          }
          return { rows: marked };
        }
        if (compiled.sql.includes('WITH candidates AS')) {
          callOrder.push('mark_for_deletion');
          const graceSec = Number(compiled.params[0]);
          const cutoffMs = nowMs - graceSec * 1000;
          const claimed: Array<Record<string, unknown>> = [];
          for (const row of blobs.values()) {
            if (
              row.gcState === 'active' &&
              row.zeroRefSince !== null &&
              row.zeroRefSince.getTime() <= cutoffMs &&
              liveRefCount(row.workspaceId, row.sha256) === 0 &&
              !hasActiveUpload(row.workspaceId, row.sha256)
            ) {
              row.gcState = 'deleting';
              row.refCount = 0;
              claimed.push({ workspaceId: row.workspaceId, sha256: row.sha256, s3Key: row.s3Key });
            }
          }
          return { rows: claimed };
        }
        if (compiled.sql.includes('DELETE FROM workspace_blobs wb')) {
          callOrder.push('finalize_delete');
          const [wid, sha] = compiled.params as [string, string];
          const row = blobs.get(sha);
          if (
            row &&
            row.workspaceId === wid &&
            row.gcState === 'deleting' &&
            row.refCount === 0 &&
            liveRefCount(wid, sha) === 0 &&
            !hasActiveUpload(wid, sha)
          ) {
            blobs.delete(sha);
            return { rows: [{ sha256: sha }] };
          }
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in Mark-and-Sweep test: ${compiled.sql}`);
      },
    } as unknown as Database;

    const sweepRes = await runBlobGcSweep(
      {
        db: markAndSweepDb,
        storage,
        logger: SILENT_LOGGER,
      },
      { batchSize: 500, graceSeconds: DEFAULT_BLOB_GC_GRACE_SECONDS },
    );

    assert.deepEqual(callOrder, [
      'reconcile:heal_live',
      'reconcile:mark_unref',
      'mark_for_deletion',
      'finalize_delete',
    ]);
    assert.equal(sweepRes.reconciledLive, 3);
    assert.equal(sweepRes.markedUnreferenced, 1);
    assert.equal(sweepRes.claimed, 1);
    assert.equal(sweepRes.deleted, 1);
    assert.equal(sweepRes.failed, 0);

    // Drifted live blobs were healed and NEVER deleted.
    assert.equal(blobs.get(shaProjectFile)?.refCount, 1);
    assert.equal(blobs.get(shaProjectFile)?.zeroRefSince, null);
    assert.equal(blobs.get(shaProjectFile)?.gcState, 'active');
    assert.equal(blobs.get(shaVersionFile)?.refCount, 2);
    assert.equal(blobs.get(shaVersionFile)?.gcState, 'active');
    assert.equal(blobs.get(shaAssetVersion)?.refCount, 1);
    assert.equal(storage.objects.has(workspaceBlobKey(WID_A, shaProjectFile)), true);
    assert.equal(storage.objects.has(workspaceBlobKey(WID_A, shaVersionFile)), true);
    assert.equal(storage.objects.has(workspaceBlobKey(WID_A, shaAssetVersion)), true);

    // Active upload ticket, newly zeroed drifted-high blob, and within-grace blob all survived.
    assert.equal(blobs.has(shaUploadTicket), true);
    assert.equal(storage.objects.has(workspaceBlobKey(WID_A, shaUploadTicket)), true);
    assert.equal(blobs.get(shaDriftedHigh)?.refCount, 0);
    assert.equal(blobs.get(shaDriftedHigh)?.zeroRefSince?.getTime(), nowMs);
    assert.equal(blobs.has(shaWithinGrace), true);

    // Only the truly unreferenced 8-day-old blob (plus thumb + proxy) was deleted.
    assert.equal(blobs.has(shaPastGrace), false);
    assert.equal(storage.objects.has(workspaceBlobKey(WID_A, shaPastGrace)), false);
    assert.equal(storage.objects.has(thumbnailKey(WID_A, shaPastGrace, 'w320')), false);
    assert.equal(storage.objects.has(derivedAssetKey(WID_A, shaPastGrace, 'proxy.mp4')), false);

    // Concurrent live reference before finalize prevents PG deletion.
    const shaRace = '8'.repeat(64);
    blobs.set(shaRace, {
      workspaceId: WID_A,
      sha256: shaRace,
      s3Key: workspaceBlobKey(WID_A, shaRace),
      refCount: 0,
      zeroRefSince: new Date(nowMs - 9 * dayMs),
      gcState: 'deleting',
    });
    pfRefs.push({ workspaceId: WID_A, blobScope: 'workspace', sha256: shaRace });
    assert.equal(await finalizeBlobDeletion(markAndSweepDb, WID_A, shaRace), false);
    assert.equal(blobs.has(shaRace), true);

    // Direct markZeroRefForDeletion also guards NOT EXISTS without running reconcile first.
    const shaDirectLive = '9'.repeat(64);
    blobs.set(shaDirectLive, {
      workspaceId: WID_A,
      sha256: shaDirectLive,
      s3Key: workspaceBlobKey(WID_A, shaDirectLive),
      refCount: 0,
      zeroRefSince: new Date(nowMs - 10 * dayMs),
      gcState: 'active',
    });
    avRefs.push({ workspaceId: WID_A, sha256: shaDirectLive });
    const directClaimed = await markZeroRefForDeletion(markAndSweepDb, {
      graceSeconds: DEFAULT_BLOB_GC_GRACE_SECONDS,
      batchSize: 50,
    });
    assert.equal(directClaimed.some((b) => b.sha256 === shaDirectLive), false);
    const rec = await reconcileDriftedBlobRefCounts(markAndSweepDb);
    assert.equal(rec.healedLive >= 1, true);
    assert.equal(blobs.get(shaDirectLive)?.refCount, 1);
  });
});

describe('MCP CloudImportAssetsService -> worker-media end-to-end project_asset integration', () => {
  it('commits prepare_upload + upload_ticket (image + font/license) and url imports into project_files, revision, versions, snapshots, history, and exact CAS refcounts', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-mcp-ingest-e2e-'));
    try {
      const storage = new InMemoryStorage();
      const published: Array<{ channel: string; payload: unknown }> = [];

      // Seed an active project with 1 workspace-scoped file (refCount=2: live + v1 snapshot)
      // and 1 catalog-scoped file (not tracked in workspace_blobs).
      const indexHtmlBytes = Buffer.from('<div data-composition-id="main">Hello</div>', 'utf8');
      const indexHtmlSha = createHash('sha256').update(indexHtmlBytes).digest('hex');
      const catalogBgSha = 'c'.repeat(64);
      const v1Id = randomUUID();
      const h1Id = randomUUID();

      const projectFilesMap = new Map<
        string,
        {
          workspaceId: string;
          projectId: string;
          path: string;
          blobScope: 'workspace' | 'catalog';
          sha256: string;
          sizeBytes: number;
          mimeType: string;
          isText: boolean;
        }
      >([
        [
          'index.html',
          {
            workspaceId: WID_A,
            projectId: PID_A,
            path: 'index.html',
            blobScope: 'workspace',
            sha256: indexHtmlSha,
            sizeBytes: indexHtmlBytes.byteLength,
            mimeType: 'text/html',
            isText: true,
          },
        ],
        [
          'assets/bg.webp',
          {
            workspaceId: WID_A,
            projectId: PID_A,
            path: 'assets/bg.webp',
            blobScope: 'catalog',
            sha256: catalogBgSha,
            sizeBytes: 4096,
            mimeType: 'image/webp',
            isText: false,
          },
        ],
      ]);

      const initialRevision = computeProjectRevision(
        [...projectFilesMap.values()].map((f) => ({ path: f.path, size: f.sizeBytes, hash: f.sha256 })),
      );
      const projectRow = {
        id: PID_A,
        workspaceId: WID_A,
        trashed: false,
        revision: initialRevision,
        currentVersionId: v1Id,
        currentVersionNumber: 1,
        currentHistorySeq: 1,
      };
      const versionRows: Array<Record<string, unknown>> = [
        {
          id: v1Id,
          workspaceId: WID_A,
          projectId: PID_A,
          versionNumber: 1,
          revision: initialRevision,
          source: 'baseline',
          summary: 'Baseline',
          requestId: null,
        },
      ];
      const versionFileRows: Array<Record<string, unknown>> = [
        {
          versionId: v1Id,
          workspaceId: WID_A,
          projectId: PID_A,
          path: 'index.html',
          blobScope: 'workspace',
          sha256: indexHtmlSha,
          sizeBytes: indexHtmlBytes.byteLength,
          mimeType: 'text/html',
        },
        {
          versionId: v1Id,
          workspaceId: WID_A,
          projectId: PID_A,
          path: 'assets/bg.webp',
          blobScope: 'catalog',
          sha256: catalogBgSha,
          sizeBytes: 4096,
          mimeType: 'image/webp',
        },
      ];
      const historyRows: Array<Record<string, unknown>> = [
        {
          id: h1Id,
          workspaceId: WID_A,
          projectId: PID_A,
          seq: 1,
          versionId: v1Id,
          parentEntryId: null,
          actorKind: 'system',
          actorName: 'bootstrap',
          label: 'Baseline',
          undone: false,
        },
      ];

      // Workspace CAS refcounts (catalog blobs must never appear here).
      const blobRefCounts = new Map<string, number>([[indexHtmlSha, 2]]);
      const receipts = new Map<
        string,
        { inputHash: string; state: string; responsePayload: Record<string, unknown> | null }
      >();
      const ticketMap = new Map<string, UploadTicketRecord & { resultPayload?: Record<string, unknown> | null }>();
      const jobMap = new Map<string, Record<string, unknown>>();

      let activeTicketId: string | null = null;
      let activeJobId: string | null = null;

      // Stateful Drizzle-compatible fake DB enforcing unique constraints on versions & history.
      const statefulDb = {
        select(cols?: Record<string, unknown>) {
          let targetTable: unknown;
          const resolve = () => {
            if (targetTable === uploadTickets) {
              const row = activeTicketId ? ticketMap.get(activeTicketId) : undefined;
              return Promise.resolve(row ? [row] : []);
            }
            if (targetTable === projects) {
              return Promise.resolve([{ ...projectRow }]);
            }
            if (targetTable === projectFiles) {
              return Promise.resolve([...projectFilesMap.values()]);
            }
            if (targetTable === projectVersions) {
              const maxVer = versionRows.reduce((m, r) => Math.max(m, Number(r.versionNumber ?? 0)), 0);
              return Promise.resolve([{ maxVer }]);
            }
            if (targetTable === projectHistoryEntries) {
              if (cols && 'maxSeq' in cols) {
                const maxSeq = historyRows.reduce((m, r) => Math.max(m, Number(r.seq ?? 0)), 0);
                return Promise.resolve([{ maxSeq }]);
              }
              const parent = historyRows.find((h) => h.seq === projectRow.currentHistorySeq);
              return Promise.resolve(parent ? [{ id: parent.id }] : []);
            }
            return Promise.resolve([]);
          };
          const chain: Record<string, unknown> = {
            from(table: unknown) {
              targetTable = table;
              return chain;
            },
            where: () => chain,
            limit: () => chain,
            for: () => chain,
            then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => resolve().then(ok, err),
          };
          return chain;
        },
        insert(table: unknown) {
          return {
            values(rawValues: unknown) {
              const run = () => {
                const rows = Array.isArray(rawValues) ? rawValues : [rawValues];
                if (table === projectFiles) {
                  for (const row of rows as Array<Record<string, unknown>>) {
                    projectFilesMap.set(String(row.path), {
                      workspaceId: String(row.workspaceId),
                      projectId: String(row.projectId),
                      path: String(row.path),
                      blobScope: row.blobScope as 'workspace' | 'catalog',
                      sha256: String(row.sha256),
                      sizeBytes: Number(row.sizeBytes),
                      mimeType: String(row.mimeType),
                      isText: Boolean(row.isText),
                    });
                  }
                } else if (table === projectVersions) {
                  for (const row of rows as Array<Record<string, unknown>>) {
                    assert.equal(
                      versionRows.some((v) => v.versionNumber === row.versionNumber),
                      false,
                      `Duplicate project_versions.version_number ${String(row.versionNumber)}`,
                    );
                    if (row.requestId) {
                      assert.equal(
                        versionRows.some((v) => v.requestId === row.requestId),
                        false,
                        `Duplicate project_versions.request_id ${String(row.requestId)}`,
                      );
                    }
                    versionRows.push({ ...row });
                  }
                } else if (table === projectVersionFiles) {
                  for (const row of rows as Array<Record<string, unknown>>) {
                    versionFileRows.push({ ...row });
                  }
                } else if (table === projectHistoryEntries) {
                  for (const row of rows as Array<Record<string, unknown>>) {
                    assert.equal(
                      historyRows.some((h) => h.seq === row.seq),
                      false,
                      `Duplicate project_history_entries.seq ${String(row.seq)}`,
                    );
                    historyRows.push({ ...row });
                  }
                }
                return Promise.resolve(rows);
              };
              const chain: Record<string, unknown> = {
                onConflictDoUpdate: () => chain,
                returning: () => run(),
                then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
              };
              return chain;
            },
          };
        },
        update(table: unknown) {
          return {
            set(values: Record<string, unknown>) {
              const run = () => {
                if (table === projects) {
                  Object.assign(projectRow, values);
                } else if (table === uploadTickets && activeTicketId) {
                  const row = ticketMap.get(activeTicketId);
                  if (row) Object.assign(row, values);
                } else if (table === jobs && activeJobId) {
                  const row = jobMap.get(activeJobId);
                  if (row) Object.assign(row, values);
                }
                return Promise.resolve([]);
              };
              const chain: Record<string, unknown> = {
                where: () => chain,
                returning: () => run(),
                then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
              };
              return chain;
            },
          };
        },
        delete() {
          const chain: Record<string, unknown> = {
            where: () => chain,
            then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve([]).then(ok, err),
          };
          return chain;
        },
        transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(statefulDb as unknown as Database),
      } as unknown as Database;

      const store: ImportAssetsStore = {
        async assertActiveProject(workspaceId, projectId) {
          assert.equal(workspaceId, WID_A);
          assert.equal(projectId, PID_A);
          return { id: projectId };
        },
        async findReceipt(workspaceId, scope, requestId) {
          return receipts.get(`${workspaceId}:${scope}:${requestId}`) ?? null;
        },
        async saveCompletedReceipt(input) {
          receipts.set(`${input.workspaceId}:${input.scope}:${input.requestId}`, {
            inputHash: input.inputHash,
            state: 'completed',
            responsePayload: input.responsePayload,
          });
        },
        async insertUploadTicket(input) {
          const rec: UploadTicketRecord = { ...input, state: 'issued' };
          ticketMap.set(rec.id, rec);
          return rec;
        },
        async findUploadTicket(_workspaceId, ticketId) {
          return ticketMap.get(ticketId) ?? null;
        },
        async markUploadTicketProcessing(_workspaceId, ticketId) {
          const rec = ticketMap.get(ticketId);
          if (!rec || (rec.state !== 'issued' && rec.state !== 'uploaded')) return false;
          rec.state = 'processing';
          return true;
        },
        async revertUploadTicketProcessing(_workspaceId, ticketId, previousState) {
          const rec = ticketMap.get(ticketId);
          if (rec) rec.state = previousState;
        },
        async createMediaIngestJob(input) {
          jobMap.set(input.id, { ...input, state: 'queued' });
        },
        async markMediaIngestJobFailed(_workspaceId, jobId, errorCode, errorMessage) {
          const row = jobMap.get(jobId);
          if (row) Object.assign(row, { state: 'failed', errorCode, errorMessage });
        },
        async commitLibraryAssetZeroCopy() {
          throw new Error('not used');
        },
      };

      const enqueued: Array<{ name: MediaIngestJobName; payload: MediaIngestPayloadMap[MediaIngestJobName] }> = [];
      const importService = new CloudImportAssetsService({
        store,
        storage,
        queues: {
          async enqueueMediaIngest(name, payload) {
            // Run the REAL BullMQ Zod payload validator to prove targetPath survives queue validation!
            const validated = validateMediaIngestPayload(name, payload);
            enqueued.push({ name, payload: validated });
            return {} as never;
          },
        },
        config: {
          S3_PRESIGN_PUT_TTL_SEC: 900,
          ALLOW_DOH_FAKEIP_FALLBACK: false,
        },
        urlValidation: {
          resolveDns: true,
          dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        },
      });

      const auth = {
        workspaceId: WID_A,
        userId: UID_A,
        role: 'editor' as const,
        scopes: [...PAT_SCOPES],
        authMode: 'dev' as const,
        authMethod: 'pat' as const,
      };

      // Build deterministic PNG + WOFF2 + license + remote URL PNG fixtures.
      const uploadPngBytes = await sharp({
        create: { width: 24, height: 16, channels: 4, background: { r: 20, g: 160, b: 90, alpha: 1 } },
      })
        .png()
        .toBuffer();
      const uploadPngSha = createHash('sha256').update(uploadPngBytes).digest('hex');

      const fontBytes = Buffer.concat([Buffer.from('wOF2', 'ascii'), Buffer.alloc(48, 0x55)]);
      const fontSha = createHash('sha256').update(fontBytes).digest('hex');
      const licenseBytes = Buffer.from('SIL Open Font License 1.1\n', 'utf8');
      const licenseSha = createHash('sha256').update(licenseBytes).digest('hex');

      const remotePngBytes = await sharp({
        create: { width: 32, height: 20, channels: 4, background: { r: 180, g: 60, b: 220, alpha: 1 } },
      })
        .png()
        .toBuffer();
      const remotePngSha = createHash('sha256').update(remotePngBytes).digest('hex');

      // Step 1: prepare_upload for an image + a WOFF2 font with companion license.
      const prepared = await importService.prepareUpload(auth, {
        action: 'prepare_upload',
        projectId: PID_A,
        requestId: 'req-e2e-prep',
        files: [
          {
            itemId: 'img-1',
            filename: 'hero.png',
            mimeType: 'image/png',
            bytes: uploadPngBytes.byteLength,
            sha256: uploadPngSha,
          },
          {
            itemId: 'font-1',
            filename: 'Inter Bold:v2.woff2',
            mimeType: 'font/woff2',
            bytes: fontBytes.byteLength,
            sha256: fontSha,
            licenseFilename: 'OFL.txt',
            licenseBytes: licenseBytes.byteLength,
          },
        ],
      });

      const imgTicket = ticketMap.get(prepared.tickets[0].ticketId)!;
      const fontTicket = ticketMap.get(prepared.tickets[1].ticketId)!;
      assert.equal(imgTicket.targetPath, `assets/imported/${imgTicket.id}.png`);
      assert.equal(fontTicket.targetPath, 'fonts/Inter-Bold-v2.woff2');
      assert.equal(resolveProjectAssetTargetPath('abc', 'clip.mp4', 'video/mp4'), 'assets/imported/abc.mp4');

      // Simulate client presigned PUT uploads into S3 staging.
      await storage.putObject(imgTicket.s3StagingKey, uploadPngBytes, 'image/png');
      await storage.putObject(fontTicket.s3StagingKey, fontBytes, 'font/woff2');
      await storage.putObject(fontTicket.licenseS3StagingKey!, licenseBytes, 'text/plain; charset=utf-8');

      // Step 2: Commit both upload_tickets + a public HTTPS URL in a single batch (same requestId).
      const batchRes = await importService.importItems(auth, {
        projectId: PID_A,
        requestId: 'req-e2e-batch',
        items: [
          { itemId: 'img-1', source: { kind: 'upload_ticket', ticketId: imgTicket.id }, name: 'Hero PNG' },
          { itemId: 'font-1', source: { kind: 'upload_ticket', ticketId: fontTicket.id }, name: 'Inter Bold' },
          {
            itemId: 'url-1',
            source: { kind: 'url', url: 'https://cdn.example.com/banner.png', expectedSha256: remotePngSha },
            name: 'Remote Banner',
          },
        ],
      });

      assert.equal(batchRes.status, 'processing');
      assert.equal(enqueued.length, 3);
      assert.equal(enqueued[0].name, 'upload_commit');
      assert.equal(enqueued[1].name, 'upload_commit');
      assert.equal(enqueued[2].name, 'url_fetch');

      const workerDeps = {
        db: statefulDb,
        storage,
        eventBus: {
          publish: async (channel: string, payload: unknown) => {
            published.push({ channel, payload });
            return 1;
          },
        },
        logger: SILENT_LOGGER,
        workerId: 'media-e2e-1',
        tmpBaseDir: tmpRoot,
        probeMedia: async (filePath: string) => {
          const info = await stat(filePath);
          const meta = await sharp(filePath).metadata();
          return {
            modality: 'image' as const,
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: info.size,
            width: meta.width ?? 16,
            height: meta.height ?? 16,
          };
        },
        fetchPublicUrlToFile: async (_url: string, destPath: string) => {
          await writeFile(destPath, remotePngBytes);
          return {
            finalUrl: 'https://cdn.example.com/banner.png',
            bytes: remotePngBytes.byteLength,
            sha256: remotePngSha,
          };
        },
        applyBlobDeltas: async (_tx: unknown, _wid: string, deltas: Parameters<typeof normalizeBlobRefDeltas>[0]) => {
          // Verify deltas arrive already sorted ascending by sha256 to avoid PG deadlocks.
          const shas = deltas.map((d) => d.sha256);
          assert.deepEqual(shas, [...shas].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
          for (const d of normalizeBlobRefDeltas(deltas)) {
            const next = (blobRefCounts.get(d.sha256) ?? 0) + d.delta;
            assert.ok(next >= 0, `CAS refcount underflow for ${d.sha256}`);
            blobRefCounts.set(d.sha256, next);
          }
        },
      };

      // Step 3: Run worker-media handlers end-to-end on the exact enqueued payloads.
      const imgPayload = enqueued[0].payload as MediaIngestPayloadMap['upload_commit'];
      activeTicketId = imgPayload.uploadId;
      activeJobId = imgPayload.jobId;
      const imgCommitted = await handleUploadCommitJob(workerDeps, imgPayload);

      const fontPayload = enqueued[1].payload as MediaIngestPayloadMap['upload_commit'];
      activeTicketId = fontPayload.uploadId;
      activeJobId = fontPayload.jobId;
      const fontCommitted = await handleUploadCommitJob(workerDeps, fontPayload);

      const urlPayload = enqueued[2].payload as MediaIngestPayloadMap['url_fetch'];
      activeTicketId = null;
      activeJobId = urlPayload.jobId;
      const urlCommitted = await handleUrlFetchJob(workerDeps, urlPayload);

      // Step 4: Verify project_files, canonical projects.revision, versions, snapshots, history, events & CAS refcounts.
      const expectedPaths = [
        'index.html',
        'assets/bg.webp',
        `assets/imported/${imgTicket.id}.png`,
        'fonts/Inter-Bold-v2.woff2',
        'fonts/OFL.txt',
        `assets/imported/${urlPayload.jobId}.png`,
      ];
      assert.deepEqual([...projectFilesMap.keys()].sort(), [...expectedPaths].sort());

      const finalExpectedRevision = computeProjectRevision(
        [...projectFilesMap.values()].map((f) => ({ path: f.path, size: f.sizeBytes, hash: f.sha256 })),
      );
      assert.equal(projectRow.revision, finalExpectedRevision);
      assert.notEqual(projectRow.revision, initialRevision);
      assert.equal(projectRow.currentVersionNumber, 4);
      assert.equal(projectRow.currentHistorySeq, 4);
      assert.equal(versionRows.length, 4);
      assert.deepEqual(
        versionRows.map((v) => v.versionNumber),
        [1, 2, 3, 4],
      );
      assert.equal(versionRows[3].id, projectRow.currentVersionId);
      assert.equal(versionRows[3].revision, finalExpectedRevision);
      assert.equal(imgCommitted.projectVersionNumber, 2);
      assert.equal(fontCommitted.projectVersionNumber, 3);
      assert.equal(urlCommitted.projectVersionNumber, 4);
      assert.equal(urlCommitted.projectRevision, finalExpectedRevision);

      // Verify project_version_files snapshots match file counts per version (2 -> 3 -> 5 -> 6).
      const countForVersion = (versionId: unknown) =>
        versionFileRows.filter((row) => row.versionId === versionId).length;
      assert.equal(countForVersion(versionRows[0].id), 2);
      assert.equal(countForVersion(versionRows[1].id), 3);
      assert.equal(countForVersion(versionRows[2].id), 5);
      assert.equal(countForVersion(versionRows[3].id), 6);

      // Verify history chain links parentEntryId sequentially across v1 -> v2 -> v3 -> v4.
      assert.deepEqual(
        historyRows.map((h) => h.seq),
        [1, 2, 3, 4],
      );
      assert.equal(historyRows[1].parentEntryId, historyRows[0].id);
      assert.equal(historyRows[2].parentEntryId, historyRows[1].id);
      assert.equal(historyRows[3].parentEntryId, historyRows[2].id);

      // Verify exact CAS refcounts (live project_files + all project_version_files snapshots).
      const imgCasSha = String(imgCommitted.sha256);
      const urlCasSha = String(urlCommitted.sha256);
      assert.equal(blobRefCounts.get(indexHtmlSha), 5); // 1 live + 4 snapshots (v1..v4)
      assert.equal(blobRefCounts.get(imgCasSha), 4); // 1 live + 3 snapshots (v2..v4)
      assert.equal(blobRefCounts.get(fontSha), 3); // 1 live + 2 snapshots (v3..v4)
      assert.equal(blobRefCounts.get(licenseSha), 3); // 1 live + 2 snapshots (v3..v4)
      assert.equal(blobRefCounts.get(urlCasSha), 2); // 1 live + 1 snapshot (v4)
      assert.equal(blobRefCounts.has(catalogBgSha), false, 'Catalog blobs must never enter workspace_blobs');

      // Verify om:project:{wid}:{pid} file-change events carry the real updated projects.revision (not raw file sha256),
      // alongside independent media-ingest-status progress/completed events.
      const projEvents = published.filter(
        (e) =>
          e.channel === projectChannel(WID_A, PID_A) &&
          (e.payload as { type?: string }).type === 'file-change',
      );
      const ingestEvents = published.filter(
        (e) =>
          e.channel === projectChannel(WID_A, PID_A) &&
          (e.payload as { type?: string }).type === 'media-ingest-status',
      );
      assert.equal(projEvents.length, 3);
      assert.ok(ingestEvents.filter((e) => (e.payload as { state?: string }).state === 'completed').length === 3);
      assert.equal((projEvents[0].payload as { revision: string }).revision, imgCommitted.projectRevision);
      assert.equal((projEvents[1].payload as { revision: string }).revision, fontCommitted.projectRevision);
      assert.equal((projEvents[2].payload as { revision: string }).revision, finalExpectedRevision);
      assert.deepEqual((projEvents[1].payload as { paths: string[] }).paths, [
        'fonts/Inter-Bold-v2.woff2',
        'fonts/OFL.txt',
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: Dual-Track Preview Proxy Generation (c1)', () => {
  it('classifies eligible media vs skipped formats accurately', () => {
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'video/mp4', sizeBytes: 1024 })?.derivedName, 'proxy.mp4');
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'video/webm', sizeBytes: 1024 })?.derivedName, 'proxy.mp4');
    assert.equal(
      classifyPreviewProxyTarget({ mimeType: 'image/png', sizeBytes: 200 * 1024, width: 800 })?.derivedName,
      'proxy.webp',
    );
    assert.equal(
      classifyPreviewProxyTarget({ mimeType: 'image/jpeg', sizeBytes: 50 * 1024, width: 2560 })?.derivedName,
      'proxy.webp',
    );
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'image/png', sizeBytes: 50 * 1024, width: 800 }), null);
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'image/svg+xml', sizeBytes: 500 * 1024, width: 4000 }), null);
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'image/gif', sizeBytes: 500 * 1024, width: 4000 }), null);
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'image/webp', sizeBytes: 500 * 1024, width: 4000 }), null);
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'audio/wav', sizeBytes: 1024 })?.derivedName, 'proxy.m4a');
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'audio/x-wav', sizeBytes: 1024 })?.derivedName, 'proxy.m4a');
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'audio/wave', sizeBytes: 1024 })?.derivedName, 'proxy.m4a');
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'audio/flac', sizeBytes: 1024 })?.derivedName, 'proxy.m4a');
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'audio/mpeg', sizeBytes: 500 * 1024 }), null);
    assert.equal(classifyPreviewProxyTarget({ mimeType: 'font/woff2', sizeBytes: 500 * 1024 }), null);
  });

  it('generates valid proxy.mp4 (720p H.264 faststart), proxy.webp (<=1920px), and proxy.m4a (AAC), persists metadata, is idempotent, and cleans /tmp', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-proxy-'));
    try {
      const bins = verificationBinaries();
      const storage = new InMemoryStorage();
      const dialect = new PgDialect();
      const blobMetadataBySha = new Map<string, Record<string, unknown>>();

      const createProxyDb = (sha256: string) =>
        ({
          select: () => {
            const chain: Record<string, unknown> = {
              from: () => chain,
              where: () => chain,
              limit: () =>
                Promise.resolve([
                  {
                    metadata: blobMetadataBySha.get(sha256) ?? null,
                    gcState: 'active',
                  },
                ]),
            };
            return chain;
          },
          update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => {
              const run = () => {
                if (table === workspaceBlobs && values.metadata) {
                  const query = dialect.sqlToQuery(values.metadata as SQL);
                  const patchJson = query.params.find((p): p is string => typeof p === 'string');
                  if (patchJson) {
                    const patch = JSON.parse(patchJson) as Record<string, unknown>;
                    blobMetadataBySha.set(sha256, {
                      ...(blobMetadataBySha.get(sha256) ?? {}),
                      ...patch,
                    });
                  }
                }
                return Promise.resolve([{ sha256 }]);
              };
              const chain: Record<string, unknown> = {
                where: () => chain,
                returning: () => run(),
              };
              return chain;
            },
          }),
        }) as unknown as Database;

      // 1. Video -> 720p H.264 faststart proxy.mp4
      const synthVideoPath = path.join(tmpRoot, 'synth-source.mp4');
      await execFileAsync(bins.ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1600x900:rate=30:duration=0.4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=0.4',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        synthVideoPath,
      ]);
      const videoBytes = await readFile(synthVideoPath);
      const videoSha = createHash('sha256').update(videoBytes).digest('hex');
      await storage.putObject(workspaceBlobKey(WID_A, videoSha), videoBytes, 'video/mp4');

      const proxyTmpDir = path.join(tmpRoot, 'work');
      const videoRes = await handleGeneratePreviewProxyJob(
        {
          db: createProxyDb(videoSha),
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-proxy-1',
          tmpBaseDir: proxyTmpDir,
        },
        {
          kind: 'generate_preview_proxy',
          workspaceId: WID_A,
          sha256: videoSha,
          mimeType: 'video/mp4',
          sizeBytes: videoBytes.byteLength,
          width: 1600,
          height: 900,
        },
      );

      assert.equal(videoRes.status, 'ready');
      const videoProxyKey = derivedAssetKey(WID_A, videoSha, 'proxy.mp4');
      assert.equal(videoRes.previewProxy?.s3Key, videoProxyKey);
      assert.equal(videoRes.previewProxy?.mimeType, 'video/mp4');
      assert.equal(videoRes.previewProxy?.width, 1280);
      assert.equal(videoRes.previewProxy?.height, 720);
      assert.equal(videoRes.previewProxy?.codec, 'h264');
      assert.ok((videoRes.previewProxy?.sizeBytes ?? 0) > 0);

      const storedVideoProxy = storage.objects.get(videoProxyKey);
      assert.ok(storedVideoProxy && storedVideoProxy.bytes.byteLength > 0);
      const moovOffset = storedVideoProxy.bytes.indexOf(Buffer.from('moov', 'ascii'));
      const mdatOffset = storedVideoProxy.bytes.indexOf(Buffer.from('mdat', 'ascii'));
      assert.ok(moovOffset > 0 && mdatOffset > moovOffset, 'proxy.mp4 must have moov before mdat (+faststart)');

      const persistedVideoMeta = blobMetadataBySha.get(videoSha)?.previewProxy as PreviewProxyMetadata;
      assert.equal(persistedVideoMeta.status, 'ready');
      assert.equal(persistedVideoMeta.s3Key, videoProxyKey);

      // Idempotency: re-running skips S3 download & transcoding when status === 'ready'.
      let getStreamCalledOnRerun = false;
      const origGetStream = storage.getObjectStream.bind(storage);
      storage.getObjectStream = async (key) => {
        getStreamCalledOnRerun = true;
        return origGetStream(key);
      };
      const rerunRes = (await processMediaIngestJob(
        {
          db: createProxyDb(videoSha),
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-proxy-1',
          tmpBaseDir: proxyTmpDir,
        },
        'generate_preview_proxy',
        {
          kind: 'generate_preview_proxy',
          workspaceId: WID_A,
          sha256: videoSha,
          mimeType: 'video/mp4',
          sizeBytes: videoBytes.byteLength,
          width: 1600,
          height: 900,
        },
      )) as { status: string; reason?: string };
      assert.equal(rerunRes.status, 'skipped');
      assert.equal(rerunRes.reason, 'already_ready');
      assert.equal(getStreamCalledOnRerun, false);
      storage.getObjectStream = origGetStream;

      // 2. High-res PNG (2400x1200) -> <=1920px WebP proxy.webp
      const largePng = await sharp({
        create: { width: 2400, height: 1200, channels: 4, background: { r: 30, g: 140, b: 220, alpha: 1 } },
      })
        .png()
        .toBuffer();
      const pngSha = createHash('sha256').update(largePng).digest('hex');
      await storage.putObject(workspaceBlobKey(WID_A, pngSha), largePng, 'image/png');

      const imgRes = await handleGeneratePreviewProxyJob(
        {
          db: createProxyDb(pngSha),
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-proxy-1',
          tmpBaseDir: proxyTmpDir,
        },
        {
          kind: 'generate_preview_proxy',
          workspaceId: WID_A,
          sha256: pngSha,
          mimeType: 'image/png',
          sizeBytes: largePng.byteLength,
          width: 2400,
          height: 1200,
        },
      );
      assert.equal(imgRes.status, 'ready');
      const imgProxyKey = derivedAssetKey(WID_A, pngSha, 'proxy.webp');
      assert.equal(imgRes.previewProxy?.s3Key, imgProxyKey);
      assert.equal(imgRes.previewProxy?.mimeType, 'image/webp');
      assert.equal(imgRes.previewProxy?.width, 1920);
      assert.equal(imgRes.previewProxy?.height, 960);
      const storedWebp = storage.objects.get(imgProxyKey);
      assert.ok(storedWebp);
      const webpMeta = await sharp(storedWebp.bytes).metadata();
      assert.equal(webpMeta.format, 'webp');
      assert.equal(webpMeta.width, 1920);

      // 3. Uncompressed WAV -> AAC proxy.m4a
      const synthWavPath = path.join(tmpRoot, 'synth-source.wav');
      await execFileAsync(bins.ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=0.4',
        '-c:a',
        'pcm_s16le',
        '-y',
        synthWavPath,
      ]);
      const wavBytes = await readFile(synthWavPath);
      const wavSha = createHash('sha256').update(wavBytes).digest('hex');
      await storage.putObject(workspaceBlobKey(WID_A, wavSha), wavBytes, 'audio/wav');

      const audioRes = await handleGeneratePreviewProxyJob(
        {
          db: createProxyDb(wavSha),
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-proxy-1',
          tmpBaseDir: proxyTmpDir,
        },
        {
          kind: 'generate_preview_proxy',
          workspaceId: WID_A,
          sha256: wavSha,
          mimeType: 'audio/wav',
          sizeBytes: wavBytes.byteLength,
        },
      );
      assert.equal(audioRes.status, 'ready');
      const audioProxyKey = derivedAssetKey(WID_A, wavSha, 'proxy.m4a');
      assert.equal(audioRes.previewProxy?.s3Key, audioProxyKey);
      assert.equal(audioRes.previewProxy?.mimeType, 'audio/mp4');
      assert.equal(audioRes.previewProxy?.codec, 'aac');
      const storedAudioProxy = storage.objects.get(audioProxyKey);
      assert.ok(storedAudioProxy && storedAudioProxy.bytes.byteLength > 0);
      const verifyAudioPath = path.join(tmpRoot, 'verify-proxy.m4a');
      await writeFile(verifyAudioPath, storedAudioProxy.bytes);
      const probeAudio = await execFileAsync(bins.ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_name',
        '-of',
        'json',
        verifyAudioPath,
      ]);
      const audioStreams = (JSON.parse(probeAudio.stdout) as { streams?: Array<{ codec_name?: string }> }).streams;
      assert.equal(audioStreams?.[0]?.codec_name, 'aac');

      // Verify /tmp scratch dirs under proxyTmpDir were all cleaned up in finally.
      const leftovers = await readdir(proxyTmpDir);
      assert.deepEqual(leftovers, []);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('enqueues generate_preview_proxy non-blockingly on upload_commit & url_fetch without failing ingest on queue error', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-proxy-enq-'));
    try {
      const storage = new InMemoryStorage();
      const dummyVideo = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
      const videoSha = createHash('sha256').update(dummyVideo).digest('hex');
      const stagingKey = uploadStagingKey(WID_A, UID_A);
      await storage.putObject(stagingKey, dummyVideo, 'video/mp4');

      const enqueuedProxies: Array<{
        name: MediaIngestJobName;
        payload: MediaIngestPayloadMap[MediaIngestJobName];
        jobId?: string;
      }> = [];

      const ticketRow = {
        id: UID_A,
        workspaceId: WID_A,
        userId: UID_A,
        purpose: 'library_asset',
        targetProjectId: null,
        targetAssetId: null,
        targetPath: null,
        filename: 'clip.mp4',
        expectedMimeType: 'video/mp4',
        expectedModality: 'video',
        expectedSha256: videoSha,
        maxBytes: 1_000_000,
        s3StagingKey: stagingKey,
        licenseS3StagingKey: null,
        licenseFilename: null,
        licenseMaxBytes: null,
        state: 'uploaded',
        requestId: 'req-proxy-upload',
        resultPayload: null,
        error: null,
        expiresAt: new Date(Date.now() + 60_000),
      };

      const uploaded = await handleUploadCommitJob(
        {
          db: createFakeDb({ selectQueue: [[ticketRow]] }),
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-proxy-enq-1',
          tmpBaseDir: tmpRoot,
          queues: {
            enqueueMediaIngest: async (name, payload, opts) => {
              const validated = validateMediaIngestPayload(name, payload);
              enqueuedProxies.push({ name, payload: validated, jobId: opts?.jobId });
              return {} as never;
            },
          },
          probeMedia: async () => ({
            modality: 'video',
            mimeType: 'video/mp4',
            extension: 'mp4',
            sizeBytes: dummyVideo.byteLength,
            width: 1920,
            height: 1080,
            durationSec: 5,
          }),
          generateThumbnailBuffer: async () => Buffer.from('jpg'),
          applyBlobDeltas: async () => {},
        },
        {
          jobId: JID_A,
          workspaceId: WID_A,
          uploadId: UID_A,
          purpose: 'library_asset',
          name: 'Clip MP4',
        },
      );

      assert.equal(uploaded.sha256, videoSha);
      assert.equal(enqueuedProxies.length, 3);
      const byName = new Map(enqueuedProxies.map((entry) => [entry.name, entry]));
      assert.equal(byName.get('generate_video_sprite')?.jobId, buildVideoSpriteJobId(WID_A, videoSha));
      assert.equal(byName.get('extract_waveform_peaks')?.jobId, buildWaveformPeaksJobId(WID_A, videoSha));
      assert.equal(byName.get('generate_preview_proxy')?.jobId, buildPreviewProxyJobId(WID_A, videoSha));
      assert.ok(enqueuedProxies.every((entry) => entry.jobId && !entry.jobId.includes(':')));

      // url_fetch with a failing queue MUST still succeed (best-effort non-blocking enqueue).
      const fetched = await handleUrlFetchJob(
        {
          db: createFakeDb({}),
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-proxy-enq-1',
          tmpBaseDir: tmpRoot,
          queues: {
            enqueueMediaIngest: async () => {
              throw new Error('Simulated Redis queue unavailable');
            },
          },
          fetchPublicUrlToFile: async (_url, destPath) => {
            await writeFile(destPath, dummyVideo);
            return {
              finalUrl: 'https://cdn.example.com/audio.wav',
              bytes: dummyVideo.byteLength,
              sha256: videoSha,
            };
          },
          probeMedia: async () => ({
            modality: 'audio',
            mimeType: 'audio/wav',
            extension: 'wav',
            sizeBytes: dummyVideo.byteLength,
            durationSec: 3,
          }),
          applyBlobDeltas: async () => {},
        },
        {
          jobId: JID_B,
          workspaceId: WID_A,
          url: 'https://cdn.example.com/audio.wav',
          name: 'Remote WAV',
          requestId: 'req-proxy-url',
        },
      );

      assert.equal(fetched.sha256, videoSha);
      assert.equal(fetched.mimeType, 'audio/wav');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: Video Sprite Sheets, Silent Waveform, CopyObject Promotion & Concurrency Semaphore', () => {
  it('computes aspect-preserving sprite tile sizes and bounded sampling plans', () => {
    assert.deepEqual(computeSpriteTileDimensions(1920, 1080), { frameWidth: 160, frameHeight: 90 });
    assert.deepEqual(computeSpriteTileDimensions(1080, 1920), { frameWidth: 50, frameHeight: 90 });
    assert.deepEqual(computeSpriteTileDimensions(1080, 1080), { frameWidth: 90, frameHeight: 90 });

    const shortPlan = computeSpriteSamplingPlan(1.5);
    assert.equal(shortPlan.targetFrames, 3);
    const mediumPlan = computeSpriteSamplingPlan(30);
    assert.equal(mediumPlan.targetFrames, 30);
    const longPlan = computeSpriteSamplingPlan(600);
    assert.equal(longPlan.targetFrames, 120);
    assert.equal(longPlan.intervalSec, 5);
  });

  it('generates real WebP sprite sheets + manifest, handles silent-video waveforms, publishes media-derived-ready, and cleans /tmp', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-sprite-'));
    const spriteTmpDir = path.join(tmpRoot, 'work');
    await stat(tmpRoot);
    const bins = verificationBinaries();
    try {
      const storage = new InMemoryStorage();
      const published: Array<{ channel: string; payload: unknown }> = [];

      // 1. Real 2.5s 16:9 H.264 + AAC video -> WebP sprite + waveform with bins & binSeconds
      const videoPath = path.join(tmpRoot, 'clip.mp4');
      await execFileAsync(bins.ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2.5:size=320x180:rate=15',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=2.5',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        videoPath,
      ]);
      const videoBytes = await readFile(videoPath);
      const videoSha = createHash('sha256').update(videoBytes).digest('hex');
      await storage.putObject(workspaceBlobKey(WID_A, videoSha), videoBytes, 'video/mp4');

      const blobStore = new Map<string, { metadata: Record<string, unknown> | null; gcState: string }>();
      blobStore.set(videoSha, { metadata: null, gcState: 'active' });

      const makeSpriteDb = (sha: string) =>
        createFakeDb({
          selectQueue: [
            [blobStore.get(sha) ?? { metadata: null, gcState: 'active' }],
            [{ projectId: PID_A, path: 'assets/clip.mp4' }],
          ],
          onUpdate: (_table, values) => {
            const v = values as { metadata?: Record<string, unknown> };
            const cur = blobStore.get(sha);
            if (cur && v.metadata) cur.metadata = { ...(cur.metadata ?? {}), ...v.metadata };
            return [{ sha256: sha }];
          },
        });

      const spriteRes = await handleGenerateVideoSpriteJob(
        {
          db: makeSpriteDb(videoSha),
          storage,
          eventBus: {
            publish: async (channel, payload) => {
              published.push({ channel, payload });
              return 1;
            },
          },
          logger: SILENT_LOGGER,
          workerId: 'media-sprite-1',
          tmpBaseDir: spriteTmpDir,
        },
        {
          workspaceId: WID_A,
          blobScope: 'workspace',
          sha256: videoSha,
          projectId: PID_A,
        },
      );

      assert.equal(spriteRes.status, 'ready');
      assert.ok(spriteRes.sprite && spriteRes.sprite.frameCount >= 2);
      assert.equal(spriteRes.sprite.frameWidth, 160);
      assert.equal(spriteRes.sprite.frameHeight, 90);
      assert.equal(spriteRes.sprite.sheetCount, 1);

      const sheetObj = storage.objects.get(derivedAssetKey(WID_A, videoSha, 'sprite-0.webp'));
      assert.ok(sheetObj && sheetObj.contentType === 'image/webp');
      const webpInfo = await sharp(sheetObj.bytes).metadata();
      assert.equal(webpInfo.format, 'webp');
      assert.ok((webpInfo.width ?? 0) >= 160);

      const manifestObj = storage.objects.get(derivedAssetKey(WID_A, videoSha, 'sprite-manifest.json'));
      assert.ok(manifestObj);
      const manifest = JSON.parse(manifestObj.bytes.toString('utf8')) as {
        version: number;
        frameCount: number;
        sheets: Array<{ index: number; s3Key: string }>;
      };
      assert.equal(manifest.version, 1);
      assert.equal(manifest.sheets.length, 1);

      const derivedEvt = published.find(
        (p) => p.channel === projectChannel(WID_A, PID_A) && (p.payload as { type?: string }).type === 'media-derived-ready',
      );
      assert.ok(derivedEvt);
      assert.equal((derivedEvt.payload as { kind?: string }).kind, 'sprite');
      assert.equal((derivedEvt.payload as { status?: string }).status, 'ready');

      // Second run with sprite.status='ready' + existing manifest in S3 is idempotent.
      const idempotentRes = await handleGenerateVideoSpriteJob(
        {
          db: createFakeDb({
            selectQueue: [[{ metadata: { sprite: spriteRes.sprite }, gcState: 'active' }]],
          }),
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-sprite-1',
          tmpBaseDir: spriteTmpDir,
        },
        {
          workspaceId: WID_A,
          blobScope: 'workspace',
          sha256: videoSha,
          projectId: PID_A,
        },
      );
      assert.equal(idempotentRes.status, 'skipped');
      assert.equal(idempotentRes.reason, 'already_ready');

      // 2. Waveform on audio video emits BOTH peaks and bins + binSeconds + hasAudio: true
      const wfRes = await handleExtractWaveformPeaksJob(
        {
          db: createFakeDb({ selectQueue: [[{ projectId: PID_A, path: 'assets/clip.mp4' }]] }),
          storage,
          eventBus: {
            publish: async (channel, payload) => {
              published.push({ channel, payload });
              return 1;
            },
          },
          logger: SILENT_LOGGER,
          workerId: 'media-wf-1',
          tmpBaseDir: spriteTmpDir,
        },
        {
          workspaceId: WID_A,
          blobScope: 'workspace',
          sha256: videoSha,
          projectId: PID_A,
          samples: 64,
        },
      );
      assert.equal(wfRes.peaks.length, 64);
      const wfJson = JSON.parse(
        (await storage.getObjectBuffer(derivedAssetKey(WID_A, videoSha, 'waveform-peaks.json'))).toString('utf8'),
      ) as { peaks: number[]; bins: number[]; binSeconds: number; hasAudio: boolean };
      assert.deepEqual(wfJson.bins, wfJson.peaks);
      assert.ok(wfJson.binSeconds > 0);
      assert.equal(wfJson.hasAudio, true);

      // 3. Silent video (no audio track) succeeds with empty waveform instead of throwing FFmpeg 400
      const silentPath = path.join(tmpRoot, 'silent.mp4');
      await execFileAsync(bins.ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=160x90:d=1.2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-y',
        silentPath,
      ]);
      const silentBytes = await readFile(silentPath);
      const silentSha = createHash('sha256').update(silentBytes).digest('hex');
      await storage.putObject(workspaceBlobKey(WID_A, silentSha), silentBytes, 'video/mp4');

      const silentWf = await handleExtractWaveformPeaksJob(
        {
          db: createFakeDb({ selectQueue: [[{ projectId: PID_A, path: 'assets/silent.mp4' }]] }),
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-wf-1',
          tmpBaseDir: spriteTmpDir,
        },
        {
          workspaceId: WID_A,
          blobScope: 'workspace',
          sha256: silentSha,
          projectId: PID_A,
          samples: 2048,
        },
      );
      assert.deepEqual(silentWf.peaks, []);
      assert.equal(silentWf.samples, 0);
      const silentJson = JSON.parse(
        (await storage.getObjectBuffer(derivedAssetKey(WID_A, silentSha, 'waveform-peaks.json'))).toString('utf8'),
      ) as { hasAudio: boolean; bins: number[] };
      assert.equal(silentJson.hasAudio, false);
      assert.deepEqual(silentJson.bins, []);

      // 4. AsyncSemaphore strictly caps peak in-flight concurrency
      const sem = new AsyncSemaphore(2);
      let active = 0;
      let peak = 0;
      await Promise.all(
        Array.from({ length: 6 }, () =>
          sem.run(async () => {
            active += 1;
            if (active > peak) peak = active;
            await new Promise((r) => setTimeout(r, 10));
            active -= 1;
          }),
        ),
      );
      assert.equal(peak, 2);

      // Verify /tmp scratch dir cleaned up
      const leftovers = await readdir(spriteTmpDir);
      assert.deepEqual(leftovers, []);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('uses zero-RAM S3 copyObject on unmodified upload_commit instead of buffering file into putBlobIfAbsent', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-copy-'));
    try {
      const storage = new InMemoryStorage();
      const copiedCalls: Array<{ src: string; dst: string; contentType?: string }> = [];
      storage.copyObject = async (src: string, dst: string, contentType?: string) => {
        copiedCalls.push({ src, dst, contentType });
        const item = storage.objects.get(src);
        if (!item) throw new Error(`Missing source ${src}`);
        storage.objects.set(dst, { bytes: Buffer.from(item.bytes), contentType: contentType ?? item.contentType });
      };

      const dummyVideo = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
      const videoSha = createHash('sha256').update(dummyVideo).digest('hex');
      const stagingKey = uploadStagingKey(WID_A, UID_A);
      await storage.putObject(stagingKey, dummyVideo, 'video/mp4');
      storage.trace.length = 0;

      const ticketRow = {
        id: UID_A,
        workspaceId: WID_A,
        userId: UID_A,
        purpose: 'library_asset',
        targetProjectId: null,
        targetAssetId: null,
        targetPath: null,
        filename: 'big-clip.mp4',
        expectedMimeType: 'video/mp4',
        expectedModality: 'video',
        expectedSha256: videoSha,
        maxBytes: 1_000_000,
        s3StagingKey: stagingKey,
        licenseS3StagingKey: null,
        licenseFilename: null,
        licenseMaxBytes: null,
        state: 'uploaded',
        requestId: 'req-copy-zero-ram',
        resultPayload: null,
        error: null,
        expiresAt: new Date(Date.now() + 60_000),
      };

      await handleUploadCommitJob(
        {
          db: createFakeDb({ selectQueue: [[ticketRow]] }),
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-copy-1',
          tmpBaseDir: tmpRoot,
          probeMedia: async () => ({
            modality: 'video',
            mimeType: 'video/mp4',
            extension: 'mp4',
            sizeBytes: dummyVideo.byteLength,
            width: 1920,
            height: 1080,
            durationSec: 12,
          }),
          generateThumbnailBuffer: async () => Buffer.from('jpg'),
          applyBlobDeltas: async () => {},
        },
        {
          jobId: JID_A,
          workspaceId: WID_A,
          uploadId: UID_A,
          purpose: 'library_asset',
          name: 'Big Clip',
        },
      );

      assert.equal(copiedCalls.length, 1);
      assert.equal(copiedCalls[0].src, stagingKey);
      assert.equal(copiedCalls[0].dst, workspaceBlobKey(WID_A, videoSha));
      assert.equal(
        storage.trace.some((entry) => entry.startsWith('putBlobIfAbsent:')),
        false,
        'Unmodified video must promote via server-side copyObject instead of putBlobIfAbsent',
      );
      assert.ok(storage.objects.has(workspaceBlobKey(WID_A, videoSha)));
      assert.equal(storage.objects.has(stagingKey), false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
