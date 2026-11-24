import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { DEFAULT_PAT_SCOPES, type AuthContext } from '../../src/contracts/auth.ts';
import type { RenderExportPayloadMap } from '../../src/contracts/jobs.ts';
import type {
  HeadObjectResult,
  ObjectStreamResult,
  PresignGetOptions,
  PresignPutOptions,
  StoragePort,
} from '../../src/contracts/storage.ts';
import { createLogger } from '../../src/infra/logger.ts';
import {
  buildCatalogFilmstripJobId,
  hasWaitingUserRenderWork,
  validateRenderExportPayload,
} from '../../src/infra/queues.ts';
import { catalogCompFilmstripKey } from '../../src/infra/storage.ts';
import {
  CatalogFilmstripAutoBakeDispatcher,
  InMemoryCatalogFilmstripBakeState,
  computeTemplateBakeHash,
} from '../../src/services/catalog-filmstrip-autobake.ts';
import {
  PrismMotionCatalog,
  type PreparedCatalogFile,
  type PreparedCatalogTemplate,
} from '../../src/services/prism-motion-catalog.ts';
import { handleStudioError, type DisklessStudioDeps } from '../../src/studio/context.ts';
import {
  COMPOSITION_FILMSTRIP_VERSION,
  computeCompositionFilmstripDepsDigest,
  embedFilmstripComment,
  extractIndexHeadMarkup,
  FILMSTRIP_HEADER_FRAMES,
  FILMSTRIP_HEADER_SOURCE,
} from '../../src/studio/engine/composition-filmstrip-sprite.ts';
import { createStudioCompositionFilmstripsRoutes } from '../../src/studio/routes/composition-filmstrips.ts';
import type { VirtualFileRecord } from '../../src/studio/virtual-project-store.ts';
import { processBakeCatalogFilmstripsJob } from '../../src/workers/catalog-filmstrip-bake.ts';
import {
  bakeVirtualCompositionsWithChromium,
  computeFilmstripSpriteDimensions,
  type CapturedFilmstripSprite,
} from '../../src/workers/filmstrip-renderer.ts';

const WID = '11111111-1111-4111-8111-111111111111';
const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RESOURCE_ID = '1500c9af-186b-457f-b74d-a58113f657d8';

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function makeValidSprite(frameCount = 8, frameWidth = 160, frameHeight = 90): Promise<CapturedFilmstripSprite> {
  const raw = await sharp({
    create: {
      width: frameCount * frameWidth,
      height: frameHeight,
      channels: 3,
      background: { r: 24, g: 80, b: 144 },
    },
  })
    .jpeg({ quality: 75 })
    .toBuffer();
  const aspect = Number((frameWidth / frameHeight).toFixed(4));
  const jpeg = embedFilmstripComment(raw, {
    version: 1,
    frameCount,
    frameWidth,
    frameHeight,
    aspect,
  });
  assert.ok(jpeg);
  return { jpeg, version: 1, frameCount, frameWidth, frameHeight, aspect };
}

class MemoryStorage implements StoragePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  headCalls: string[] = [];
  putCalls: string[] = [];

  async putObject(
    key: string,
    body: Buffer | Uint8Array | Readable | string,
    contentType: string,
  ): Promise<void> {
    this.putCalls.push(key);
    const buf = Buffer.isBuffer(body)
      ? Buffer.from(body)
      : typeof body === 'string'
        ? Buffer.from(body, 'utf8')
        : body instanceof Uint8Array
          ? Buffer.from(body)
          : Buffer.alloc(0);
    this.objects.set(key, { body: buf, contentType });
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    if (this.objects.has(key)) return { uploaded: false };
    await this.putObject(key, body, contentType);
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(found.body);
  }

  async getObjectStream(key: string): Promise<ObjectStreamResult> {
    const buf = await this.getObjectBuffer(key);
    return { stream: Readable.from([buf]), contentLength: buf.byteLength, contentType: 'image/jpeg' };
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    this.headCalls.push(key);
    const found = this.objects.get(key);
    if (!found) return null;
    return {
      contentLength: found.body.byteLength,
      contentType: found.contentType,
      etag: `"${sha256(found.body)}"`,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(): Promise<number> {
    return 0;
  }

  async presignPut(key: string, _options: PresignPutOptions): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async presignGet(key: string, _options?: PresignGetOptions): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

function makePrismFile(filePath: string, content: string | Buffer, mimeType: string): PreparedCatalogFile & { content: Buffer } {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const digest = sha256(buf);
  return {
    path: filePath,
    sha256: digest,
    sizeBytes: buf.byteLength,
    mimeType,
    metadata: null,
    isProjectFile: true,
    isAvailable: false,
    remoteUrl: `https://r.open-design.ai/files/${digest}`,
    bytes: null,
    content: buf,
  };
}

function makePrismTemplate(
  id: string,
  catalogVersion: string,
  files: readonly PreparedCatalogFile[],
  hasHtmlProject = true,
): PreparedCatalogTemplate {
  return {
    id,
    kind: 'prism',
    catalogVersion,
    sortOrder: 1,
    featuredOrder: null,
    hasHtmlProject,
    files: [...files],
    instructionsMd: null,
    motionMd: null,
    metadata: { entry: { templateId: id, original: { templateName: id } } },
  };
}

describe('Prism catalog filmstrip auto-bake', () => {
  it('validates bake_catalog_filmstrips queue contract, jobId format, and portrait/landscape sprite scaling', () => {
    const fileSha = 'a'.repeat(64);
    const bakeHash = computeTemplateBakeHash([{ path: 'index.html', sha256: fileSha }], 1);
    const payload = validateRenderExportPayload('bake_catalog_filmstrips', {
      templateId: 'motion-demo-1',
      catalogVersion: 'prism:prod:00000000-0000-4000-8000-000000000001',
      templateBakeHash: bakeHash,
      files: [
        {
          path: 'index.html',
          sha256: fileSha,
          sizeBytes: 128,
          mimeType: 'text/html; charset=utf-8',
          remoteUrl: `https://r.open-design.ai/files/${fileSha}`,
        },
      ],
    });
    assert.equal(payload.formatVersion, 1);
    const jobId = buildCatalogFilmstripJobId(1, bakeHash);
    assert.equal(jobId, `catfilm__v1__${bakeHash}`);
    assert.equal(jobId.includes(':'), false);

    // Landscape 16:9 stays 160x90; 9:16 portrait scales within 160x320; ultra-tall 1:3 caps height at 320.
    assert.deepEqual(computeFilmstripSpriteDimensions(1920, 1080), {
      frameWidth: 160,
      frameHeight: 90,
      aspect: 1920 / 1080,
    });
    const portrait = computeFilmstripSpriteDimensions(1080, 1920);
    assert.equal(portrait.frameWidth, 160);
    assert.equal(portrait.frameHeight, 284);
    const ultraTall = computeFilmstripSpriteDimensions(600, 1800);
    assert.equal(ultraTall.frameHeight, 320);
    assert.equal(ultraTall.frameWidth, 107);
  });

  it('triggers PrismMotionCatalog.onPublicationChanged only when publicationId changes and isolates callback errors', async () => {
    let now = 1_000;
    let publicationId = '11111111-1111-4111-8111-111111111111';
    let version = 'v1';
    let versionId = 'ver_11111111111111111111111111111111';
    const indexSha = sha256('<html></html>');
    const buildResponses = () => {
      const localeBody = Buffer.from(
        JSON.stringify({
          templates: [
            {
              templateId: 'motion-editable',
              original: { templateName: 'Editable' },
              sortOrder: 1,
              indexUrl: `https://r.open-design.ai/files/${indexSha}`,
              files: [
                {
                  path: 'index.html',
                  sha256: indexSha,
                  url: `https://r.open-design.ai/files/${indexSha}`,
                  bytes: 13,
                },
              ],
            },
          ],
          brands: [],
        }),
        'utf8',
      );
      const manifestBody = Buffer.from(
        JSON.stringify({
          manifestVersion: 'v4',
          resourceId: RESOURCE_ID,
          channel: 'default',
          environment: 'dev',
          publicationId,
          contentPublicationId: publicationId,
          versionId,
          version,
          generation: 1,
          defaultLocale: 'en',
          mainUrl: `/resources/${RESOURCE_ID}/channels/default/versions/${version}/main.json`,
          contents: [
            {
              locale: 'en',
              contentUrl: `/resources/${RESOURCE_ID}/channels/default/versions/${version}/en.json`,
              byteLength: localeBody.byteLength,
              sha256: sha256(localeBody),
            },
          ],
        }),
        'utf8',
      );
      return { manifestBody, localeBody };
    };

    const changedEvents: string[] = [];
    const errors: unknown[] = [];
    let failNextHook = false;
    const catalog = new PrismMotionCatalog('dev', {
      publicOrigin: 'https://dev.example.test',
      now: () => now,
      ttlMs: 60_000,
      fetchImpl: async (input) => {
        const url = String(input);
        const { manifestBody, localeBody } = buildResponses();
        if (url.endsWith('/manifest.json')) return new Response(new Uint8Array(manifestBody), { status: 200 });
        if (url.endsWith('/en.json')) return new Response(new Uint8Array(localeBody), { status: 200 });
        return new Response('not found', { status: 404 });
      },
      onPublicationChanged: async (_templates, catalogVersion) => {
        changedEvents.push(catalogVersion);
        if (failNextHook) {
          failNextHook = false;
          throw new Error('dispatcher transient failure');
        }
      },
      onRefreshError: (error) => {
        errors.push(error);
      },
    });

    // First load triggers refresh + onPublicationChanged.
    await catalog.getTemplates();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(changedEvents, [`prism:dev:${publicationId}`]);

    // TTL expires with unchanged publicationId -> onPublicationChanged must NOT fire again.
    now += 61_000;
    await catalog.getTemplates();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(changedEvents.length, 1);

    // New publicationId fires onPublicationChanged again, and a callback rejection is caught cleanly.
    publicationId = '22222222-2222-4222-8222-222222222222';
    version = 'v2';
    versionId = 'ver_22222222222222222222222222222222';
    failNextHook = true;
    now += 61_000;
    await catalog.getTemplates();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(changedEvents, [
      'prism:dev:11111111-1111-4111-8111-111111111111',
      'prism:dev:22222222-2222-4222-8222-222222222222',
    ]);
    assert.equal(errors.length, 1);
    const loaded = await catalog.getTemplates({ requirePublication: true });
    assert.equal(loaded.length, 1);
  });

  it('deduplicates across API replicas, skips unchanged/baked templates, honors failure cooldown, and re-enqueues immediately when template source changes', async () => {
    let now = 10_000;
    const sharedState = new InMemoryCatalogFilmstripBakeState(() => now);
    const enqueued: Array<{ name: string; payload: RenderExportPayloadMap['bake_catalog_filmstrips']; priority?: number; jobId?: string }> = [];
    let shouldFailEnqueue = false;
    const queues = {
      enqueueRenderExport: async (
        name: string,
        payload: unknown,
        options?: { priority?: number; jobId?: string },
      ) => {
        if (shouldFailEnqueue) throw new Error('Redis queue unavailable');
        enqueued.push({
          name,
          payload: payload as RenderExportPayloadMap['bake_catalog_filmstrips'],
          priority: options?.priority,
          jobId: options?.jobId,
        });
        return {} as never;
      },
    };

    const logger = createLogger({ level: 'error' });
    const replicaA = new CatalogFilmstripAutoBakeDispatcher({ queues: queues as never, state: sharedState, logger });
    const replicaB = new CatalogFilmstripAutoBakeDispatcher({ queues: queues as never, state: sharedState, logger });

    const fIndex = makePrismFile('index.html', '<html><head></head><body><div data-composition-src="compositions/s1.html"></div></body></html>', 'text/html');
    const fS1 = makePrismFile('compositions/s1.html', '<div>Scene 1</div>', 'text/html');
    const editableV1 = makePrismTemplate('motion-a', 'prism:prod:pub-1', [fIndex, fS1], true);
    const guideOnly = makePrismTemplate('motion-guide', 'prism:prod:pub-1', [], false);

    // Two API replicas observe the same publication simultaneously -> only 1 job enqueued at priority 10.
    const [sumA, sumB] = await Promise.all([
      replicaA.scheduleForPublication([editableV1, guideOnly], 'prism:prod:pub-1'),
      replicaB.scheduleForPublication([editableV1, guideOnly], 'prism:prod:pub-1'),
    ]);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.name, 'bake_catalog_filmstrips');
    assert.equal(enqueued[0]!.priority, 10);
    assert.equal(sumA.editableTemplates, 1);
    assert.equal(sumA.enqueued + sumB.enqueued, 1);
    assert.equal(sumA.skippedQueued + sumB.skippedQueued, 1);

    const hashV1 = enqueued[0]!.payload.templateBakeHash;

    // Once worker marks baked, a new publicationId with unchanged files skips via Redis/local without enqueueing.
    await sharedState.markBaked(1, hashV1);
    const sumBakedB = await replicaB.scheduleForPublication(
      [makePrismTemplate('motion-a', 'prism:prod:pub-2', [fIndex, fS1], true)],
      'prism:prod:pub-2',
    );
    assert.equal(sumBakedB.enqueued, 0);
    assert.equal(sumBakedB.skippedBaked, 1);
    // Subsequent call on replicaB hits process-local cache directly.
    const sumLocalB = await replicaB.scheduleForPublication(
      [makePrismTemplate('motion-a', 'prism:prod:pub-3', [fIndex, fS1], true)],
      'prism:prod:pub-3',
    );
    assert.equal(sumLocalB.skippedLocal, 1);

    // Enqueue error releases the queued claim immediately so the next refresh can retry.
    const fS1Broken = makePrismFile('compositions/s1.html', '<div>Broken v2</div>', 'text/html');
    const editableV2 = makePrismTemplate('motion-a', 'prism:prod:pub-4', [fIndex, fS1Broken], true);
    shouldFailEnqueue = true;
    const sumErr = await replicaA.scheduleForPublication([editableV2], 'prism:prod:pub-4');
    assert.equal(sumErr.enqueueErrors, 1);
    assert.equal(sumErr.enqueued, 0);
    shouldFailEnqueue = false;
    const sumRetry = await replicaA.scheduleForPublication([editableV2], 'prism:prod:pub-4');
    assert.equal(sumRetry.enqueued, 1);
    const hashV2 = enqueued[1]!.payload.templateBakeHash;
    assert.notEqual(hashV2, hashV1);

    // Worker marks failed -> 6h cooldown skips retries for same broken hash.
    await sharedState.markFailed(1, hashV2, 'Chromium timeout');
    const sumCooldown = await replicaA.scheduleForPublication([editableV2], 'prism:prod:pub-5');
    assert.equal(sumCooldown.enqueued, 0);
    assert.equal(sumCooldown.skippedCooldown, 1);

    // Fixing the template changes templateBakeHash -> immediately bypasses cooldown and enqueues.
    const fS1Fixed = makePrismFile('compositions/s1.html', '<div>Fixed v3</div>', 'text/html');
    const editableV3 = makePrismTemplate('motion-a', 'prism:prod:pub-6', [fIndex, fS1Fixed], true);
    const sumFixed = await replicaA.scheduleForPublication([editableV3], 'prism:prod:pub-6');
    assert.equal(sumFixed.enqueued, 1);

    // Format version upgrade (v1 -> v2) computes a distinct hash and re-bakes cleanly.
    const v2Dispatcher = new CatalogFilmstripAutoBakeDispatcher({
      queues: queues as never,
      state: sharedState,
      logger,
      formatVersion: 2,
    });
    const sumV2Format = await v2Dispatcher.scheduleForPublication([editableV1], 'prism:prod:pub-7');
    assert.equal(sumV2Format.enqueued, 1);
    assert.equal(enqueued.at(-1)!.payload.formatVersion, 2);
  });

  it('bakes missing compositions into deps-bound S3 keys, skips already-baked sprites without Chromium, handles single-scene invalidation, and serves GET catalog hits', async () => {
    const storage = new MemoryStorage();
    const bakeState = new InMemoryCatalogFilmstripBakeState();
    const logger = createLogger({ level: 'error' });

    const fIndex = makePrismFile(
      'index.html',
      '<!doctype html><html><head><link rel="stylesheet" href="assets/theme.css"></head><body><div data-composition-src="compositions/s1.html"></div><div data-composition-src="compositions/s2.html"></div></body></html>',
      'text/html; charset=utf-8',
    );
    const fS1 = makePrismFile('compositions/s1.html', '<div>Scene 1</div>', 'text/html; charset=utf-8');
    const fS2 = makePrismFile('compositions/s2.html', '<div>Scene 2</div>', 'text/html; charset=utf-8');
    const fCss = makePrismFile('assets/theme.css', 'body { color: #fff; }', 'text/css');
    const fBigVideo = makePrismFile('assets/unused-bg.mp4', Buffer.alloc(1024, 7), 'video/mp4');

    const fileContentsByUrl = new Map<string, Buffer>([
      [fIndex.remoteUrl!, fIndex.content],
      [fS1.remoteUrl!, fS1.content],
      [fS2.remoteUrl!, fS2.content],
      [fCss.remoteUrl!, fCss.content],
      [fBigVideo.remoteUrl!, fBigVideo.content],
    ]);
    const fetchedUrls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      const body = fileContentsByUrl.get(url);
      if (!body) return new Response('not found', { status: 404 });
      return new Response(new Uint8Array(body), { status: 200 });
    };

    const renderedBatches: string[][] = [];
    const sprite = await makeValidSprite(8, 160, 90);
    const renderCompositionsFn = async (input: { targetCompositions: readonly string[] }) => {
      renderedBatches.push([...input.targetCompositions]);
      return new Map(
        input.targetCompositions.map((comp) => [comp, { ok: true as const, sprite }]),
      );
    };

    const toPayload = (files: ReturnType<typeof makePrismFile>[]): RenderExportPayloadMap['bake_catalog_filmstrips'] => {
      const payloadFiles = files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        sizeBytes: f.sizeBytes,
        mimeType: f.mimeType,
        remoteUrl: f.remoteUrl!,
      }));
      return {
        templateId: 'motion-prism-demo',
        catalogVersion: 'prism:prod:pub-1',
        templateBakeHash: computeTemplateBakeHash(payloadFiles, 1),
        formatVersion: 1,
        files: payloadFiles,
      };
    };

    // Run 1: cold template bakes index.html + s1.html + s2.html without downloading unrequested video binary.
    const payloadV1 = toPayload([fIndex, fS1, fS2, fCss, fBigVideo]);
    const res1 = await processBakeCatalogFilmstripsJob(
      { storage, logger, bakeState, fetchImpl: fakeFetch, renderCompositionsFn },
      payloadV1,
    );
    assert.equal(res1.status, 'baked');
    assert.equal(res1.bakedCount, 3);
    assert.equal(res1.skippedExistingCount, 0);
    assert.deepEqual(renderedBatches, [['index.html', 'compositions/s1.html', 'compositions/s2.html']]);
    assert.equal(fetchedUrls.includes(fBigVideo.remoteUrl!), false, 'must not download unrequested video assets');
    assert.equal(await bakeState.getState(1, payloadV1.templateBakeHash), 'baked');

    // Verify GET /api/projects/:id/composition-filmstrip/compositions/s1.html on a cloned project hits the baked S3 sprite!
    const clonedFiles: VirtualFileRecord[] = [fIndex, fS1, fS2, fCss, fBigVideo].map((f) => ({
      path: f.path,
      blobScope: 'catalog',
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
      mimeType: f.mimeType,
      isText: f.path.endsWith('.html') || f.path.endsWith('.css'),
      updatedAt: new Date(0),
    }));
    const clonedTexts = new Map<string, string>([
      ['index.html', fIndex.content.toString('utf8')],
      ['compositions/s1.html', fS1.content.toString('utf8')],
      ['compositions/s2.html', fS2.content.toString('utf8')],
      ['assets/theme.css', fCss.content.toString('utf8')],
    ]);
    const auth: AuthContext = {
      workspaceId: WID,
      userId: UID,
      role: 'editor',
      scopes: [...DEFAULT_PAT_SCOPES],
      authMode: 'dev',
      authMethod: 'dev_bypass',
    };
    const routeApp = createStudioCompositionFilmstripsRoutes({
      storage,
      files: {
        listFiles: async () => clonedFiles,
        getFile: async (_a: AuthContext, _p: string, filePath: string) =>
          clonedFiles.find((f) => f.path === filePath) ?? null,
        readTextFile: async (_a: AuthContext, _p: string, filePath: string) => {
          const rec = clonedFiles.find((f) => f.path === filePath);
          const content = clonedTexts.get(filePath);
          if (!rec || content === undefined) return null;
          return { path: rec.path, content, version: `"catalog:${rec.sha256}"`, sha256: rec.sha256, blobScope: 'catalog' };
        },
      },
      resolveAuth: () => auth,
    } as unknown as DisklessStudioDeps);
    routeApp.onError((err, c) => handleStudioError(c, err));

    const getS1 = await routeApp.request(`http://studio.local/api/projects/${PID}/composition-filmstrip/compositions/s1.html`);
    assert.equal(getS1.status, 200);
    assert.equal(getS1.headers.get(FILMSTRIP_HEADER_SOURCE), 'catalog');
    assert.equal(getS1.headers.get(FILMSTRIP_HEADER_FRAMES), '8');

    // Run 2: wipe Redis state (simulate Redis restart / 7d expiry) -> S3 HEAD hits all 3, Chromium NEVER runs.
    const freshBakeState = new InMemoryCatalogFilmstripBakeState();
    const res2 = await processBakeCatalogFilmstripsJob(
      { storage, logger, bakeState: freshBakeState, fetchImpl: fakeFetch, renderCompositionsFn },
      payloadV1,
    );
    assert.equal(res2.status, 'already_baked');
    assert.equal(res2.bakedCount, 0);
    assert.equal(res2.skippedExistingCount, 3);
    assert.equal(renderedBatches.length, 1, 'must not invoke renderer when S3 already has every sprite');
    assert.equal(await freshBakeState.getState(1, payloadV1.templateBakeHash), 'baked');

    // Run 3: edit only s2.html -> s1.html is skipped via S3 HEAD; only index.html + s2.html are re-baked!
    const fS2Updated = makePrismFile('compositions/s2.html', '<div>Scene 2 v2</div>', 'text/html; charset=utf-8');
    fileContentsByUrl.set(fS2Updated.remoteUrl!, fS2Updated.content);
    const payloadS2Edited = toPayload([fIndex, fS1, fS2Updated, fCss, fBigVideo]);
    const res3 = await processBakeCatalogFilmstripsJob(
      { storage, logger, bakeState: freshBakeState, fetchImpl: fakeFetch, renderCompositionsFn },
      payloadS2Edited,
    );
    assert.equal(res3.status, 'baked');
    assert.equal(res3.skippedExistingCount, 1);
    assert.equal(res3.bakedCount, 2);
    assert.deepEqual(renderedBatches[1], ['index.html', 'compositions/s2.html']);

    // Run 4: edit shared CSS -> depsSha256 rotates for every composition, so all 3 re-bake under new S3 keys.
    const fCssUpdated = makePrismFile('assets/theme.css', 'body { color: #0ff; }', 'text/css');
    fileContentsByUrl.set(fCssUpdated.remoteUrl!, fCssUpdated.content);
    const payloadCssEdited = toPayload([fIndex, fS1, fS2Updated, fCssUpdated, fBigVideo]);
    const res4 = await processBakeCatalogFilmstripsJob(
      { storage, logger, bakeState: freshBakeState, fetchImpl: fakeFetch, renderCompositionsFn },
      payloadCssEdited,
    );
    assert.equal(res4.status, 'baked');
    assert.equal(res4.skippedExistingCount, 0);
    assert.equal(res4.bakedCount, 3);
    const { depsSha256: newS1Deps } = computeCompositionFilmstripDepsDigest({
      compPath: 'compositions/s1.html',
      files: clonedFiles.map((f) =>
        f.path === 'assets/theme.css' ? { ...f, sha256: fCssUpdated.sha256 } : f.path === 'compositions/s2.html' ? { ...f, sha256: fS2Updated.sha256 } : f,
      ),
      indexHead: extractIndexHeadMarkup(fIndex.content.toString('utf8')),
      readText: (p) => clonedTexts.get(p) ?? null,
    });
    assert.equal(storage.objects.has(catalogCompFilmstripKey(fS1.sha256, newS1Deps, 1)), true);
  });

  it('preserves partial S3 progress on single-scene render failure, enters cooldown, and rejects tampered remote bytes', async () => {
    const storage = new MemoryStorage();
    const bakeState = new InMemoryCatalogFilmstripBakeState();
    const logger = createLogger({ level: 'error' });

    const fIndex = makePrismFile('index.html', '<html><head></head><body><div data-composition-src="compositions/ok.html"></div><div data-composition-src="compositions/bad.html"></div></body></html>', 'text/html');
    const fOk = makePrismFile('compositions/ok.html', '<div>OK</div>', 'text/html');
    const fBad = makePrismFile('compositions/bad.html', '<div>BAD</div>', 'text/html');

    const contents = new Map<string, Buffer>([
      [fIndex.remoteUrl!, fIndex.content],
      [fOk.remoteUrl!, fOk.content],
      [fBad.remoteUrl!, fBad.content],
    ]);
    const fakeFetch: typeof fetch = async (input) => {
      const body = contents.get(String(input));
      return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response('404', { status: 404 });
    };

    const sprite = await makeValidSprite(8, 160, 90);
    const files = [fIndex, fOk, fBad].map((f) => ({
      path: f.path,
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
      mimeType: f.mimeType,
      remoteUrl: f.remoteUrl!,
    }));
    const payload: RenderExportPayloadMap['bake_catalog_filmstrips'] = {
      templateId: 'motion-partial',
      catalogVersion: 'prism:prod:pub-bad',
      templateBakeHash: computeTemplateBakeHash(files, 1),
      formatVersion: 1,
      files,
    };

    const resPartial = await processBakeCatalogFilmstripsJob(
      {
        storage,
        logger,
        bakeState,
        fetchImpl: fakeFetch,
        renderCompositionsFn: async ({ targetCompositions }) => {
          const map = new Map<
            string,
            { ok: true; sprite: CapturedFilmstripSprite } | { ok: false; error: string }
          >();
          for (const comp of targetCompositions) {
            map.set(
              comp,
              comp === 'compositions/bad.html'
                ? { ok: false, error: 'Timeline duration 0' }
                : { ok: true, sprite },
            );
          }
          return map;
        },
      },
      payload,
    );
    assert.equal(resPartial.status, 'partial_failure');
    assert.equal(resPartial.bakedCount, 2);
    assert.deepEqual(resPartial.failedCompositions, ['compositions/bad.html']);
    assert.equal(await bakeState.getState(1, payload.templateBakeHash), 'failed');
    assert.equal(storage.objects.size, 2, 'successful siblings remain cached in S3');

    // Tampered CDN payload fails SHA-256 verification before launching Chromium or writing S3.
    const storageTampered = new MemoryStorage();
    const bakeStateTampered = new InMemoryCatalogFilmstripBakeState();
    let renderCalled = false;
    const resTampered = await processBakeCatalogFilmstripsJob(
      {
        storage: storageTampered,
        logger,
        bakeState: bakeStateTampered,
        fetchImpl: async () => new Response(new Uint8Array(Buffer.from('X'.repeat(fIndex.sizeBytes))), { status: 200 }),
        renderCompositionsFn: async () => {
          renderCalled = true;
          return new Map();
        },
      },
      payload,
    );
    assert.equal(resTampered.status, 'failed');
    assert.equal(renderCalled, false);
    assert.equal(storageTampered.objects.size, 0);
    assert.equal(await bakeStateTampered.getState(1, payload.templateBakeHash), 'failed');
  });

  it('uses locale-independent codepoint byte ordering in computeTemplateBakeHash', () => {
    const shaA = '1'.repeat(64);
    const shaZ = '2'.repeat(64);
    const shaUtf8 = '3'.repeat(64);
    // In codepoint order: 'assets/Z.png' (0x5A) < 'assets/a.png' (0x61) < 'assets/é.png' (0xE9).
    const expected = createHash('sha256')
      .update(
        `omfs-template-bake-v${COMPOSITION_FILMSTRIP_VERSION}\n` +
          `assets/Z.png:${shaZ}\n` +
          `assets/a.png:${shaA}\n` +
          `assets/é.png:${shaUtf8}\n`,
      )
      .digest('hex');
    const hash1 = computeTemplateBakeHash(
      [
        { path: 'assets/a.png', sha256: shaA },
        { path: 'assets/é.png', sha256: shaUtf8 },
        { path: 'assets/Z.png', sha256: shaZ },
      ],
      COMPOSITION_FILMSTRIP_VERSION,
    );
    const hash2 = computeTemplateBakeHash(
      [
        { path: 'assets/Z.png', sha256: shaZ },
        { path: 'assets/a.png', sha256: shaA },
        { path: 'assets/é.png', sha256: shaUtf8 },
      ],
      COMPOSITION_FILMSTRIP_VERSION,
    );
    assert.equal(hash1, expected);
    assert.equal(hash2, expected);
  });

  it('closes the preview HTTP server and cleans ephemeral temp dir when Chromium launch fails', async () => {
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'om-test-bake-launch-fail-'));
    try {
      const indexHtml = '<!doctype html><html><body><div data-composition-id="main"></div></body></html>';
      const indexBuf = Buffer.from(indexHtml, 'utf8');
      const indexSha = sha256(indexBuf);
      let startedOrigin = '';
      let failedUserDataDir = '';

      await assert.rejects(
        () =>
          bakeVirtualCompositionsWithChromium({
            server: {
              projectId: 'launch-fail-test',
              revision: 'v1',
              files: [
                {
                  path: 'index.html',
                  blobScope: 'catalog',
                  sha256: indexSha,
                  sizeBytes: indexBuf.byteLength,
                  mimeType: 'text/html',
                  isText: true,
                  updatedAt: new Date(0),
                },
              ],
              textContents: new Map([['index.html', indexHtml]]),
              resolveAsset: () => null,
            },
            targetCompositions: ['index.html'],
            executablePath: '/fake/chromium',
            tmpBaseDir: tmpBase,
            onPreviewStarted: (origin) => {
              startedOrigin = origin;
            },
            launchFn: (async (opts: Record<string, unknown>) => {
              failedUserDataDir = String(opts.userDataDir ?? '');
              // Confirm the preview server was indeed listening right before launch failed.
              const probe = await fetch(`${startedOrigin}/api/runtime.js`);
              assert.equal(probe.status, 200);
              throw new Error('simulated browser launch crash');
            }) as unknown as Parameters<typeof bakeVirtualCompositionsWithChromium>[0]['launchFn'],
          }),
        /simulated browser launch crash/,
      );

      assert.ok(startedOrigin.startsWith('http://127.0.0.1:'));
      // Preview HTTP server MUST be closed after launch rejection.
      await assert.rejects(() => fetch(`${startedOrigin}/api/runtime.js`));
      assert.ok(failedUserDataDir.startsWith(tmpBase));
      await assert.rejects(() => access(path.dirname(failedUserDataDir)));
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  });

  it('rejects sprites whose requested catalog image fails with HTTP 503 while preserving healthy sibling compositions', async () => {
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'om-test-bake-503-'));
    try {
      const storage = new MemoryStorage();
      const bakeState = new InMemoryCatalogFilmstripBakeState();
      const logger = createLogger({ level: 'error' });

      const okPng = await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 180, b: 90 } },
      })
        .png()
        .toBuffer();
      const brokenPng = await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 220, g: 40, b: 40 } },
      })
        .png()
        .toBuffer();

      const fIndex = makePrismFile(
        'index.html',
        '<!doctype html><html><head></head><body><div data-composition-id="root" data-width="1920" data-height="1080" data-duration="4"><div data-composition-src="compositions/ok.html"></div><div data-composition-src="compositions/broken.html"></div></div></body></html>',
        'text/html; charset=utf-8',
      );
      const fOk = makePrismFile(
        'compositions/ok.html',
        '<div data-composition-id="ok" data-width="1920" data-height="1080" data-duration="4"><img src="assets/ok.png"></div>',
        'text/html; charset=utf-8',
      );
      const fBroken = makePrismFile(
        'compositions/broken.html',
        '<div data-composition-id="broken" data-width="1920" data-height="1080" data-duration="4"><img src="assets/broken.png"></div>',
        'text/html; charset=utf-8',
      );
      const fOkImg = makePrismFile('assets/ok.png', okPng, 'image/png');
      const fBrokenImg = makePrismFile('assets/broken.png', brokenPng, 'image/png');

      let brokenAssetHealthy = false;
      const contents = new Map<string, Buffer>([
        [fIndex.remoteUrl!, fIndex.content],
        [fOk.remoteUrl!, fOk.content],
        [fBroken.remoteUrl!, fBroken.content],
        [fOkImg.remoteUrl!, fOkImg.content],
        [fBrokenImg.remoteUrl!, fBrokenImg.content],
      ]);
      const fakeFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url === fBrokenImg.remoteUrl && !brokenAssetHealthy) {
          return new Response('Service Unavailable', { status: 503 });
        }
        const body = contents.get(url);
        return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response('404', { status: 404 });
      };

      const sampleFramePng = await sharp({
        create: { width: 160, height: 90, channels: 3, background: { r: 20, g: 50, b: 90 } },
      })
        .png()
        .toBuffer();

      // Deterministic lightweight browser stub that performs real HTTP fetches against the
      // local preview server for the scene HTML and every referenced <img> src.
      const createHttpDrivingLaunchFn = () =>
        (async () => ({
          newPage: async () => ({
            setViewport: async () => {},
            goto: async (targetUrl: string) => {
              if (targetUrl === 'about:blank') return;
              const pageRes = await fetch(targetUrl);
              assert.equal(pageRes.status, 200);
              const html = await pageRes.text();
              const origin = new URL(targetUrl).origin;
              // Request every referenced img src and a missing non-catalog favicon to verify
              // 404 unknown paths do not fail healthy scenes while 502 catalog failures do.
              await fetch(`${origin}/preview/favicon.ico`);
              for (const match of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
                const assetRes = await fetch(`${origin}/preview/${match[1]}`);
                await assetRes.arrayBuffer();
              }
            },
            waitForFunction: async () => {},
            evaluate: async (_fn: unknown, timeSec?: number) => {
              if (typeof timeSec === 'number') return undefined;
              return { width: 1920, height: 1080, duration: 4 };
            },
            $: async () => null,
            screenshot: async () => sampleFramePng,
            close: async () => {},
          }),
          close: async () => {},
        })) as unknown as Parameters<typeof bakeVirtualCompositionsWithChromium>[0]['launchFn'];

      const payloadFiles = [fIndex, fOk, fBroken, fOkImg, fBrokenImg].map((f) => ({
        path: f.path,
        sha256: f.sha256,
        sizeBytes: f.sizeBytes,
        mimeType: f.mimeType,
        remoteUrl: f.remoteUrl!,
      }));
      const payload: RenderExportPayloadMap['bake_catalog_filmstrips'] = {
        templateId: 'motion-asset-503',
        catalogVersion: 'prism:prod:pub-503',
        templateBakeHash: computeTemplateBakeHash(payloadFiles, 1),
        formatVersion: 1,
        files: payloadFiles,
      };

      const res1 = await processBakeCatalogFilmstripsJob(
        {
          storage,
          logger,
          bakeState,
          fetchImpl: fakeFetch,
          renderCompositionsFn: ({ server, targetCompositions, shouldYield }) =>
            bakeVirtualCompositionsWithChromium({
              server,
              targetCompositions,
              shouldYield,
              executablePath: '/fake/chromium',
              tmpBaseDir: tmpBase,
              launchFn: createHttpDrivingLaunchFn(),
            }),
        },
        payload,
      );

      assert.equal(res1.status, 'partial_failure');
      assert.equal(res1.bakedCount, 1, 'healthy sibling compositions/ok.html must still be baked');
      assert.deepEqual(res1.failedCompositions, ['index.html', 'compositions/broken.html']);
      assert.equal(storage.objects.size, 1, 'broken compositions MUST NOT write incomplete sprites to S3');
      assert.equal(await bakeState.getState(1, payload.templateBakeHash), 'failed');

      // Once the upstream CDN recovers (and cooldown clears), re-running skips ok.html via S3 HEAD
      // and cleanly bakes the previously failed compositions!
      brokenAssetHealthy = true;
      const recoveredState = new InMemoryCatalogFilmstripBakeState();
      const res2 = await processBakeCatalogFilmstripsJob(
        {
          storage,
          logger,
          bakeState: recoveredState,
          fetchImpl: fakeFetch,
          renderCompositionsFn: ({ server, targetCompositions, shouldYield }) =>
            bakeVirtualCompositionsWithChromium({
              server,
              targetCompositions,
              shouldYield,
              executablePath: '/fake/chromium',
              tmpBaseDir: tmpBase,
              launchFn: createHttpDrivingLaunchFn(),
            }),
        },
        payload,
      );
      assert.equal(res2.status, 'baked');
      assert.equal(res2.skippedExistingCount, 1);
      assert.equal(res2.bakedCount, 2);
      assert.equal(storage.objects.size, 3);
      assert.equal(await recoveredState.getState(1, payload.templateBakeHash), 'baked');
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  });

  it('cooperatively yields before launch and between compositions when user render jobs are waiting, preserving completed S3 sprites', async () => {
    // 1. Queue inspection helper detects waiting/prioritized export_render and render_thumbnail jobs only.
    assert.equal(
      await hasWaitingUserRenderWork({
        getWaiting: async () => [],
        getPrioritized: async () => [{ name: 'bake_catalog_filmstrips' } as never],
      }),
      false,
    );
    assert.equal(
      await hasWaitingUserRenderWork({
        getWaiting: async () => [],
        getPrioritized: async () => [{ name: 'export_render' } as never],
      }),
      true,
    );
    assert.equal(
      await hasWaitingUserRenderWork({
        getWaiting: async () => [{ name: 'render_thumbnail' } as never],
        getPrioritized: async () => [],
      }),
      true,
    );

    const storage = new MemoryStorage();
    const bakeState = new InMemoryCatalogFilmstripBakeState();
    const logger = createLogger({ level: 'error' });
    const sprite = await makeValidSprite(8, 160, 90);

    const fIndex = makePrismFile(
      'index.html',
      '<html><head></head><body><div data-composition-src="compositions/s1.html"></div><div data-composition-src="compositions/s2.html"></div></body></html>',
      'text/html',
    );
    const fS1 = makePrismFile('compositions/s1.html', '<div>S1</div>', 'text/html');
    const fS2 = makePrismFile('compositions/s2.html', '<div>S2</div>', 'text/html');
    const contents = new Map<string, Buffer>([
      [fIndex.remoteUrl!, fIndex.content],
      [fS1.remoteUrl!, fS1.content],
      [fS2.remoteUrl!, fS2.content],
    ]);
    const fakeFetch: typeof fetch = async (input) => {
      const body = contents.get(String(input));
      return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response('404', { status: 404 });
    };
    const files = [fIndex, fS1, fS2].map((f) => ({
      path: f.path,
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
      mimeType: f.mimeType,
      remoteUrl: f.remoteUrl!,
    }));
    const payload: RenderExportPayloadMap['bake_catalog_filmstrips'] = {
      templateId: 'motion-yield',
      catalogVersion: 'prism:prod:pub-yield',
      templateBakeHash: computeTemplateBakeHash(files, 1),
      formatVersion: 1,
      files,
    };

    // 2. Yield upfront before Chromium launch -> zero renders, neither baked nor failed cooldown.
    let renderCalls = 0;
    const resUpfront = await processBakeCatalogFilmstripsJob(
      {
        storage,
        logger,
        bakeState,
        fetchImpl: fakeFetch,
        shouldYield: async () => true,
        renderCompositionsFn: async () => {
          renderCalls += 1;
          return { results: new Map(), yielded: false };
        },
      },
      payload,
    );
    assert.equal(resUpfront.status, 'yielded');
    assert.equal(renderCalls, 0);
    assert.equal(await bakeState.getState(1, payload.templateBakeHash), null);

    // 3. Yield mid-template after baking the first composition -> persists 1st sprite, skips cooldown.
    let yieldCheckCount = 0;
    const renderedPasses: string[][] = [];
    const resMidYield = await processBakeCatalogFilmstripsJob(
      {
        storage,
        logger,
        bakeState,
        fetchImpl: fakeFetch,
        shouldYield: async () => {
          yieldCheckCount += 1;
          // 1st check (before launch) = false; 2nd check (after index.html) = true!
          return yieldCheckCount >= 2;
        },
        renderCompositionsFn: async ({ targetCompositions, shouldYield }) => {
          const results = new Map<
            string,
            { ok: true; sprite: CapturedFilmstripSprite } | { ok: false; error: string }
          >();
          const pass: string[] = [];
          let yielded = false;
          for (let i = 0; i < targetCompositions.length; i += 1) {
            if (i > 0 && shouldYield && (await shouldYield())) {
              yielded = true;
              break;
            }
            pass.push(targetCompositions[i]!);
            results.set(targetCompositions[i]!, { ok: true, sprite });
          }
          renderedPasses.push(pass);
          return { results, yielded };
        },
      },
      payload,
    );
    assert.equal(resMidYield.status, 'yielded');
    assert.equal(resMidYield.bakedCount, 1);
    assert.deepEqual(renderedPasses, [['index.html']]);
    assert.equal(storage.objects.size, 1);
    assert.equal(await bakeState.getState(1, payload.templateBakeHash), null);

    // 4. Resume when user export finishes -> S3 HEAD skips index.html, bakes only s1 + s2, marks baked!
    const resResume = await processBakeCatalogFilmstripsJob(
      {
        storage,
        logger,
        bakeState,
        fetchImpl: fakeFetch,
        shouldYield: async () => false,
        renderCompositionsFn: async ({ targetCompositions }) => {
          renderedPasses.push([...targetCompositions]);
          return {
            results: new Map(targetCompositions.map((c) => [c, { ok: true as const, sprite }])),
            yielded: false,
          };
        },
      },
      payload,
    );
    assert.equal(resResume.status, 'baked');
    assert.equal(resResume.skippedExistingCount, 1);
    assert.equal(resResume.bakedCount, 2);
    assert.deepEqual(renderedPasses[1], ['compositions/s1.html', 'compositions/s2.html']);
    assert.equal(storage.objects.size, 3);
    assert.equal(await bakeState.getState(1, payload.templateBakeHash), 'baked');
  });
});
