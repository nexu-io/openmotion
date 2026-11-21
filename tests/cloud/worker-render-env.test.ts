import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { executeIsolated } from '../../hyperframes.ts';
import type { RenderWorkerHealth } from '../../src/contracts/events.ts';
import type { StoragePort } from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import { jobs } from '../../src/db/schema/jobs.ts';
import { createLogger } from '../../src/infra/logger.ts';
import { cancelChannel, jobChannel } from '../../src/infra/redis.ts';
import {
  catalogBlobKey,
  compThumbnailKey,
  exportKey,
  workspaceBlobKey,
} from '../../src/infra/storage.ts';
import {
  STUDIO_MANUAL_EDITS_PATH,
  STUDIO_MOTION_PATH,
  assertRenderSubprocessEnvClean,
  buildRenderSubprocessEnv,
  injectStudioRenderParityScripts,
} from '../../src/workers/render-env.ts';
import {
  buildRenderExportArgs,
  buildThumbnailSnapshotArgs,
  hydrateSnapshotFilesToDir,
  processExportRenderJob,
  processRenderThumbnailJob,
  startRenderHealthHeartbeat,
} from '../../src/workers/render-export.ts';

const WID_A = '11111111-1111-4111-8111-111111111111';
const PID_A = '22222222-2222-4222-8222-222222222222';
const VID_A = '33333333-3333-4333-8333-333333333333';
const JID_OK = '44444444-4444-4444-8444-444444444444';
const JID_FAIL = '55555555-5555-4555-8555-555555555555';
const JID_CANCEL = '66666666-6666-4666-8666-666666666666';
const REV_1 = 'a'.repeat(64);
const SILENT_LOGGER = createLogger({ level: 'error', sink: () => {} });

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

class MemoryStorage implements StoragePort {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async putObject(
    key: string,
    body: Buffer | Uint8Array | Readable | string,
    contentType: string,
  ): Promise<void> {
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
    return { stream: Readable.from([Buffer.from(entry.bytes)]), contentLength: entry.bytes.byteLength };
  }

  async headObject(key: string) {
    const entry = this.objects.get(key);
    return entry ? { contentLength: entry.bytes.byteLength, contentType: entry.contentType } : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(prefix)) {
        this.objects.delete(k);
        n += 1;
      }
    }
    return n;
  }

  async presignPut(key: string): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async presignGet(key: string): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

class MemoryEventBus {
  readonly published: Array<{ channel: string; payload: unknown }> = [];
  readonly healthPulses: RenderWorkerHealth[] = [];
  private readonly listeners = new Map<string, Set<(payload: unknown, channel: string) => void>>();

  async publish(channel: string, payload: unknown): Promise<number> {
    this.published.push({ channel, payload });
    const bucket = this.listeners.get(channel);
    if (!bucket) return 0;
    for (const fn of bucket) fn(payload, channel);
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
    };
  }

  async publishRenderWorkerHealth(health: RenderWorkerHealth): Promise<void> {
    this.healthPulses.push(health);
  }
}

function createFakeRenderDb(snapshotFiles: unknown[], onUpdate?: (values: Record<string, unknown>) => unknown[]) {
  const exec: Record<string, unknown> = {
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
          Promise.resolve(snapshotFiles).then(ok, err),
      };
      return chain;
    },
    update: (table: unknown) => ({
      set(values: Record<string, unknown>) {
        const run = () => {
          if (table === jobs && onUpdate) return Promise.resolve(onUpdate(values));
          return Promise.resolve([{ id: JID_OK }]);
        };
        const chain: Record<string, unknown> = {
          where: () => chain,
          returning: () => run(),
          then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
        };
        return chain;
      },
    }),
  };
  return exec as unknown as Database;
}

describe('worker-render Security Boundary: buildRenderSubprocessEnv & Isolated Spawn', () => {
  it('explicitly strips ALL secrets and injects every required HYPERFRAMES_* & runtime flag', () => {
    const pollutedSourceEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HYPERFRAMES_BROWSER_PATH: '/usr/bin/chromium',
      HYPERFRAMES_FFMPEG_PATH: '/usr/bin/ffmpeg',
      HYPERFRAMES_FFPROBE_PATH: '/usr/bin/ffprobe',
      // Sensitive secrets that MUST NEVER survive into Chromium / Hyperframes subprocesses:
      DATABASE_URL: 'postgres://user:placeholder@postgres:5432/openmotion',
      REDIS_URL: 'redis://:placeholder@redis:6379',
      REDIS_CACHE_URL: 'redis://:placeholder@redis-cache:6379',
      S3_ENDPOINT: 'http://s3:9000',
      S3_BUCKET: 'openmotion',
      S3_ACCESS_KEY_ID: 'synthetic-s3-access-id',
      S3_SECRET_ACCESS_KEY: 'test-s3-secret-00000000',
      AWS_ACCESS_KEY_ID: 'synthetic-aws-access-id',
      AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret-val',
      AWS_SESSION_TOKEN: 'synthetic-aws-session',
      OPENDESIGN_S2S_API_KEY: 'synthetic-opendesign-key',
      OPENDESIGN_API_URL: 'https://amr-api.open-design.ai',
      OIDC_CLIENT_ID: 'openmotion-cloud',
      OIDC_CLIENT_SECRET: 'synthetic-oidc-secret',
      OIDC_ISSUER: 'https://auth.example.test',
      SESSION_SECRET: 'synthetic-session-secret-0123456789abcdef',
      DEV_PAT: 'synthetic-dev-pat-value',
      DEV_AUTH_TOKEN: 'synthetic-dev-auth-value',
      MCP_JWT_SIGNING_KEY: 'synthetic-mcp-signing-val',
      OPENAI_API_KEY: 'synthetic-openai-val',
      GEMINI_API_KEY: 'synthetic-gemini-val',
      CUSTOM_PRIVATE_TOKEN: 'synthetic-custom-val',
    };

    const env = buildRenderSubprocessEnv({
      ephemeralHomeDir: '/tmp/om-render-test/home',
      ephemeralTmpDir: '/tmp/om-render-test/tmp',
      sourceEnv: pollutedSourceEnv,
    });

    // Every single secret key MUST be absent.
    const forbiddenKeys = [
      'DATABASE_URL',
      'REDIS_URL',
      'REDIS_CACHE_URL',
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'OPENDESIGN_S2S_API_KEY',
      'OPENDESIGN_API_URL',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_ISSUER',
      'SESSION_SECRET',
      'DEV_PAT',
      'DEV_AUTH_TOKEN',
      'MCP_JWT_SIGNING_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'CUSTOM_PRIVATE_TOKEN',
    ];
    for (const key of forbiddenKeys) {
      assert.equal(env[key], undefined, `Secret env var "${key}" leaked into render subprocess env!`);
    }

    // All required safe flags & binary paths MUST be set.
    assert.equal(env.HYPERFRAMES_NO_TELEMETRY, '1');
    assert.equal(env.HYPERFRAMES_NO_UPDATE_CHECK, '1');
    assert.equal(env.HYPERFRAMES_NO_AUTO_INSTALL, '1');
    assert.equal(env.HYPERFRAMES_GSAP_WRITER, 'acorn');
    assert.equal(env.HYPERFRAMES_PREVIEW_HOST, '127.0.0.1');
    assert.equal(env.HYPERFRAMES_RENDER_DETACHED, '1');
    assert.equal(env.HYPERFRAMES_FONT_CACHE_DIR, '/tmp/hf-font-cache');
    assert.equal(env.HYPERFRAMES_CACHE_DIR, '/tmp/om-render-test/home/.cache');
    assert.equal(env.HYPERFRAMES_CONFIG_DIR, '/tmp/om-render-test/home/.config');
    assert.equal(env.CONTAINER, 'true');
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin');
    assert.equal(env.HOME, '/tmp/om-render-test/home');
    assert.equal(env.TMPDIR, '/tmp/om-render-test/tmp');
    assert.equal(env.HYPERFRAMES_BROWSER_PATH, '/usr/bin/chromium');
    assert.equal(env.HYPERFRAMES_FFMPEG_PATH, '/usr/bin/ffmpeg');
    assert.equal(env.HYPERFRAMES_FFPROBE_PATH, '/usr/bin/ffprobe');
    assert.match(env.NODE_OPTIONS, /--import=.*hyperframes-capture-fix\.mjs/);

    // Defense-in-depth assertion rejects injected secrets or non-allowlisted keys.
    assert.throws(
      () => assertRenderSubprocessEnvClean({ ...env, DATABASE_URL: 'postgres://leak' }),
      /RENDER_ENV_SECURITY_VIOLATION/,
    );
    assert.throws(
      () => assertRenderSubprocessEnvClean({ ...env, UNEXPECTED_VAR: '1' }),
      /RENDER_ENV_SECURITY_VIOLATION/,
    );
  });

  it('spawns real subprocess via executeIsolated with zero inherited parent secrets', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'om-test-exec-iso-'));
    const prevDbUrl = process.env.DATABASE_URL;
    const prevSessionSecret = process.env.SESSION_SECRET;
    process.env.DATABASE_URL = 'postgres://parent:placeholder@db:5432/om';
    process.env.SESSION_SECRET = 'synthetic-parent-session-secret-value';

    try {
      const env = buildRenderSubprocessEnv({
        ephemeralHomeDir: path.join(tmpDir, 'home'),
        ephemeralTmpDir: path.join(tmpDir, 'tmp'),
      });
      const res = await executeIsolated(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        tmpDir,
        { env, timeoutMs: 10_000 },
      );
      assert.equal(res.code, 0);
      const childEnv = JSON.parse(res.stdout) as Record<string, string | undefined>;
      assert.equal(childEnv.DATABASE_URL, undefined);
      assert.equal(childEnv.SESSION_SECRET, undefined);
      assert.equal(childEnv.S3_SECRET_ACCESS_KEY, undefined);
      assert.equal(childEnv.OPENDESIGN_S2S_API_KEY, undefined);
      assert.equal(childEnv.HYPERFRAMES_GSAP_WRITER, 'acorn');
      assert.equal(childEnv.HYPERFRAMES_NO_UPDATE_CHECK, '1');
      assert.equal(childEnv.CONTAINER, 'true');
    } finally {
      if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDbUrl;
      if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSessionSecret;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Studio Manual Edits & Studio Motion Render Parity Injection (#9 §6.3 / #11 §5)', () => {
  it('injects both studio-manual-edits.json and studio-motion.json render body scripts into hydrated ephemeral HTML without mutating S3', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'om-test-hydrate-'));
    try {
      const storage = new MemoryStorage();
      const entryHtml = `<!DOCTYPE html>
<html>
  <body>
    <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="5">
      <h1 data-hf-id="title-1">Hello Cloud</h1>
    </div>
  </body>
</html>`;
      const manualEditsJson = JSON.stringify({
        version: 1,
        edits: [{ id: 'title-1', dx: 42, dy: -16 }],
      });
      const studioMotionJson = JSON.stringify({
        version: 1,
        motions: [
          {
            kind: 'gsap-motion',
            target: { hfId: 'title-1' },
            start: 0,
            duration: 1.5,
            from: { opacity: 0, y: 24 },
            to: { opacity: 1, y: 0 },
          },
        ],
      });
      const catalogAssetCss = 'body { margin: 0; }';

      const htmlSha = sha256(entryHtml);
      const editsSha = sha256(manualEditsJson);
      const motionSha = sha256(studioMotionJson);
      const cssSha = sha256(catalogAssetCss);

      await storage.putObject(workspaceBlobKey(WID_A, htmlSha), entryHtml, 'text/html');
      await storage.putObject(workspaceBlobKey(WID_A, editsSha), manualEditsJson, 'application/json');
      await storage.putObject(workspaceBlobKey(WID_A, motionSha), studioMotionJson, 'application/json');
      await storage.putObject(catalogBlobKey(cssSha), catalogAssetCss, 'text/css');

      const hydrated = await hydrateSnapshotFilesToDir({
        storage,
        workspaceId: WID_A,
        projectDir: tmpDir,
        compositionPath: 'index.html',
        files: [
          { path: 'index.html', blobScope: 'workspace', sha256: htmlSha, sizeBytes: entryHtml.length, mimeType: 'text/html' },
          { path: STUDIO_MANUAL_EDITS_PATH, blobScope: 'workspace', sha256: editsSha, sizeBytes: manualEditsJson.length, mimeType: 'application/json' },
          { path: STUDIO_MOTION_PATH, blobScope: 'workspace', sha256: motionSha, sizeBytes: studioMotionJson.length, mimeType: 'application/json' },
          { path: 'styles/theme.css', blobScope: 'catalog', sha256: cssSha, sizeBytes: catalogAssetCss.length, mimeType: 'text/css' },
        ],
      });

      assert.equal(hydrated.fileCount, 4);
      assert.equal(hydrated.injectedManualEdits, true);
      assert.equal(hydrated.injectedStudioMotion, true);

      const patchedHtml = await readFile(path.join(tmpDir, 'index.html'), 'utf8');
      assert.match(patchedHtml, /data-om-render-parity="studio-manual-edits"/);
      assert.match(patchedHtml, /studioManualEditsRenderRuntime/);
      assert.match(patchedHtml, /data-om-render-parity="studio-motion"/);
      assert.match(patchedHtml, /studioMotionRenderRuntime/);
      assert.ok(patchedHtml.indexOf('studioManualEditsRenderRuntime') < patchedHtml.lastIndexOf('</body>'));

      // Immutable S3 blob MUST remain untouched!
      const originalFromS3 = (await storage.getObjectBuffer(workspaceBlobKey(WID_A, htmlSha))).toString('utf8');
      assert.equal(originalFromS3, entryHtml);

      // Pure helper returns unchanged HTML when manifests are absent.
      const noop = injectStudioRenderParityScripts(entryHtml, {});
      assert.equal(noop.html, entryHtml);
      assert.equal(noop.injectedManualEdits, false);
      assert.equal(noop.injectedStudioMotion, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects path traversal and SHA-256 digest tampering during hydration', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'om-test-hydrate-bad-'));
    try {
      const storage = new MemoryStorage();
      await storage.putObject(workspaceBlobKey(WID_A, REV_1), 'tampered-bytes', 'text/html');

      await assert.rejects(() =>
        hydrateSnapshotFilesToDir({
          storage,
          workspaceId: WID_A,
          projectDir: tmpDir,
          compositionPath: 'index.html',
          files: [{ path: '../escape.html', blobScope: 'workspace', sha256: REV_1, sizeBytes: 10, mimeType: 'text/html' }],
        }),
      );

      await assert.rejects(
        () =>
          hydrateSnapshotFilesToDir({
            storage,
            workspaceId: WID_A,
            projectDir: tmpDir,
            compositionPath: 'index.html',
            files: [{ path: 'index.html', blobScope: 'workspace', sha256: REV_1, sizeBytes: 14, mimeType: 'text/html' }],
          }),
        { code: 'STORAGE_ERROR' },
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('worker-render: CLI Argument Builders (hyperframes@0.9.7 snapshot & render settings)', () => {
  it('builds valid hyperframes@0.9.7 snapshot args for composition thumbnails (never --format png or --start/--end)', () => {
    const rootArgs = buildThumbnailSnapshotArgs({ framesDir: '/tmp/frames', timeSec: 2.5 });
    assert.deepEqual(rootArgs, ['snapshot', '.', '--output', '/tmp/frames', '--at', '2.5', '--no-end', '--json']);
    assert.equal(rootArgs.includes('--format'), false);
    assert.equal(rootArgs.includes('--start'), false);
    assert.equal(rootArgs.includes('--end'), false);

    const subCompArgs = buildThumbnailSnapshotArgs({
      framesDir: '/tmp/frames',
      timeSec: 0,
      compositionId: 'intro-scene',
    });
    assert.deepEqual(subCompArgs, [
      'snapshot',
      '.',
      '--output',
      '/tmp/frames',
      '--at',
      '0',
      '--no-end',
      '--composition',
      'intro-scene',
      '--json',
    ]);
  });

  it('forwards allowlisted payload.settings onto hyperframes render CLI args cleanly', () => {
    const mp4Args = buildRenderExportArgs({
      compositionPath: 'compositions/hero.html',
      outputFilePath: '/tmp/out/final.mp4',
      format: 'mp4',
      settings: {
        fps: 60,
        quality: 'delivery',
        resolution: '1080p',
        crf: 18,
        variables: { title: 'Hello' },
        ignoredUnsafeFlag: '--evil',
      },
    });
    assert.deepEqual(mp4Args, [
      'render',
      '.',
      '--composition',
      'compositions/hero.html',
      '--output',
      '/tmp/out/final.mp4',
      '--format',
      'mp4',
      '--fps',
      '60',
      '--quality',
      'delivery',
      '--resolution',
      '1080p',
      '--crf',
      '18',
      '--variables',
      '{"title":"Hello"}',
      '--json',
    ]);

    const gifArgs = buildRenderExportArgs({
      compositionPath: 'index.html',
      outputFilePath: '/tmp/out/loop.gif',
      format: 'gif',
      settings: { fps: '24000/1001', gifLoop: 0, videoBitrate: '8M' },
    });
    assert.deepEqual(gifArgs, [
      'render',
      '.',
      '--output',
      '/tmp/out/loop.gif',
      '--format',
      'gif',
      '--fps',
      '24000/1001',
      '--video-bitrate',
      '8M',
      '--gif-loop',
      '0',
      '--json',
    ]);
  });
});

describe('worker-render: End-to-End Export Lifecycle, Failure & Cancel /tmp Cleanup, Thumbnail & Heartbeat', () => {
  it('completes verified export, uploads MP4 + render.log, and ALWAYS wipes /tmp on success, failure, and cancellation', async () => {
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'om-test-render-root-'));
    try {
      const storage = new MemoryStorage();
      const eventBus = new MemoryEventBus();
      const html = '<html><body><div data-composition-id="main">Hi</div></body></html>';
      const htmlSha = sha256(html);
      await storage.putObject(workspaceBlobKey(WID_A, htmlSha), html, 'text/html');

      const snapshotRows = [
        { path: 'index.html', blobScope: 'workspace', sha256: htmlSha, sizeBytes: html.length, mimeType: 'text/html' },
      ];

      // 1. Happy path: completes, passes verifyExportFn, uploads MP4 + render.log, wipes /tmp.
      const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]);
      const statusUpdates: Array<Record<string, unknown>> = [];
      const dbOk = createFakeRenderDb(snapshotRows, (vals) => {
        statusUpdates.push(vals);
        return [{ id: JID_OK }];
      });

      const okRes = await processExportRenderJob(
        {
          db: dbOk,
          storage,
          eventBus,
          logger: SILENT_LOGGER,
          workerId: 'render-test-1',
          tmpBaseDir: tmpBase,
          sourceEnv: {
            PATH: '/usr/bin:/bin',
            DATABASE_URL: 'postgres://secret@db/om',
            OPENDESIGN_S2S_API_KEY: 'synthetic-key',
          },
          runRenderCommand: async (_rt, _dir, args, opts) => {
            // Confirm render command received strictly stripped env.
            assert.equal(opts.env.DATABASE_URL, undefined);
            assert.equal(opts.env.OPENDESIGN_S2S_API_KEY, undefined);
            assert.equal(opts.env.HYPERFRAMES_GSAP_WRITER, 'acorn');
            const outIdx = args.indexOf('--output');
            await writeFile(args[outIdx + 1], fakeMp4);
            opts.onStdoutLine?.('{"progress":0.5,"stage":"capturing"}');
            return { code: 0, stdout: '{"ok":true}\n', stderr: '' };
          },
          extractExpectationFn: async () => ({
            width: 1920,
            height: 1080,
            fps: 30,
            duration: 5,
            audio: 'optional',
          }),
          verifyExportFn: async (outFile, expected) => ({
            scope: 'technical',
            status: 'passed',
            file: outFile,
            sha256: sha256(fakeMp4),
            expected,
            checks: [{ name: 'probe', status: 'passed', details: 'ok' }],
            remainingChecks: [],
          }),
        },
        {
          jobId: JID_OK,
          workspaceId: WID_A,
          projectId: PID_A,
          versionId: VID_A,
          revision: REV_1,
          outputName: 'final-cut.mp4',
          format: 'mp4',
          phase1: true,
        },
      );

      assert.equal(okRes.state, 'completed');
      assert.ok(storage.objects.has(exportKey(WID_A, JID_OK, 'final-cut.mp4')));
      assert.ok(storage.objects.has(exportKey(WID_A, JID_OK, 'render.log')));
      assert.ok(statusUpdates.some((u) => u.state === 'completed'));
      assert.ok(eventBus.published.some((e) => e.channel === jobChannel(JID_OK)));
      // /tmp/om-render-<jobId> MUST be completely removed!
      await assert.rejects(() => access(path.join(tmpBase, `om-render-${JID_OK}`)));

      // 2. Failure path (render throws): marks failed, uploads NO MP4, and STILL wipes /tmp!
      const failUpdates: Array<Record<string, unknown>> = [];
      const dbFail = createFakeRenderDb(snapshotRows, (vals) => {
        failUpdates.push(vals);
        return [{ id: JID_FAIL }];
      });
      await assert.rejects(() =>
        processExportRenderJob(
          {
            db: dbFail,
            storage,
            eventBus,
            logger: SILENT_LOGGER,
            workerId: 'render-test-1',
            tmpBaseDir: tmpBase,
            runRenderCommand: async () => ({ code: 1, stdout: '', stderr: 'Chromium crashed' }),
          },
          {
            jobId: JID_FAIL,
            workspaceId: WID_A,
            projectId: PID_A,
            versionId: VID_A,
            revision: REV_1,
            outputName: 'broken.mp4',
            format: 'mp4',
            phase1: true,
          },
        ),
      );
      assert.equal(storage.objects.has(exportKey(WID_A, JID_FAIL, 'broken.mp4')), false);
      assert.ok(failUpdates.some((u) => u.state === 'failed' && u.errorCode === 'EXPORT_RENDER_FAILED'));
      await assert.rejects(() => access(path.join(tmpBase, `om-render-${JID_FAIL}`)));

      // 3. Cancellation path (om:cancel:{jobId} aborts active render & wipes /tmp).
      const cancelUpdates: Array<Record<string, unknown>> = [];
      const dbCancel = createFakeRenderDb(snapshotRows, (vals) => {
        cancelUpdates.push(vals);
        return [{ id: JID_CANCEL }];
      });
      await assert.rejects(() =>
        processExportRenderJob(
          {
            db: dbCancel,
            storage,
            eventBus,
            logger: SILENT_LOGGER,
            workerId: 'render-test-1',
            tmpBaseDir: tmpBase,
            runRenderCommand: async (_rt, _dir, _args, opts) => {
              setTimeout(() => {
                void eventBus.publish(cancelChannel(JID_CANCEL), {
                  jobId: JID_CANCEL,
                  workspaceId: WID_A,
                  requestedAt: Date.now(),
                });
              }, 10);
              return new Promise((_resolve, reject) => {
                opts.signal?.addEventListener('abort', () => reject(new Error('COMMAND_CANCELLED')), { once: true });
              });
            },
          },
          {
            jobId: JID_CANCEL,
            workspaceId: WID_A,
            projectId: PID_A,
            versionId: VID_A,
            revision: REV_1,
            outputName: 'cancelled.mp4',
            format: 'mp4',
            phase1: true,
          },
        ),
      );
      assert.ok(cancelUpdates.some((u) => u.state === 'cancelled'));
      await assert.rejects(() => access(path.join(tmpBase, `om-render-${JID_CANCEL}`)));

      // 4. render_thumbnail uploads PNG to compThumbnailKey and wipes /tmp.
      const fakePng = Buffer.from('89504e470d0a1a0a0000000d', 'hex');
      const thumbRes = await processRenderThumbnailJob(
        {
          db: dbOk,
          storage,
          eventBus,
          logger: SILENT_LOGGER,
          workerId: 'render-test-1',
          tmpBaseDir: tmpBase,
          sourceEnv: { DATABASE_URL: 'postgres://secret@db/om' },
          renderThumbnailFn: async ({ outputPngPath, env }) => {
            assert.equal(env.DATABASE_URL, undefined);
            assert.equal(env.HYPERFRAMES_NO_AUTO_INSTALL, '1');
            await writeFile(outputPngPath, fakePng);
          },
        },
        {
          workspaceId: WID_A,
          projectId: PID_A,
          versionId: VID_A,
          revision: REV_1,
          compositionPath: 'index.html',
          cacheKey: 'main-0s',
          timeSec: 0,
          width: 320,
          height: 180,
        },
      );
      assert.equal(thumbRes.key, compThumbnailKey(WID_A, PID_A, 'main-0s'));
      assert.ok(storage.objects.has(thumbRes.key));

      // 5. Render worker Redis health heartbeat publishes RenderWorkerHealth cleanly.
      const hb = startRenderHealthHeartbeat({
        eventBus,
        logger: SILENT_LOGGER,
        workerId: 'render-hb-1',
        concurrency: 1,
        intervalMs: 60_000,
      });
      hb.setActiveJobs(1);
      await hb.pulse();
      hb.stop();
      assert.ok(eventBus.healthPulses.length >= 1);
      assert.equal(eventBus.healthPulses.at(-1)?.workerId, 'render-hb-1');
      assert.equal(eventBus.healthPulses.at(-1)?.activeJobs, 1);
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  });
});
