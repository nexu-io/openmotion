import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { classifyRenderFailure } from '../../shared/render-failure.ts';
import { bundleToSingleHtml } from '@hyperframes/core/compiler';
import {
  executeIsolated,
  pluginRoot,
  snapshotExportExpectation,
  snapshotExportExpectationIsolated,
} from '../../hyperframes.ts';
import type { RenderWorkerHealth } from '../../src/contracts/events.ts';
import type { StoragePort } from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import { jobs } from '../../src/db/schema/jobs.ts';
import { createLogger } from '../../src/infra/logger.ts';
import { cancelChannel, jobChannel } from '../../src/infra/redis.ts';
import { ShutdownCoordinator } from '../../src/infra/shutdown.ts';
import {
  catalogBlobKey,
  compThumbnailKey,
  exportKey,
  workspaceBlobKey,
} from '../../src/infra/storage.ts';
import { sanitizeExportFilename } from '../../src/services/export-service.ts';
import {
  STUDIO_MANUAL_EDITS_PATH,
  STUDIO_MOTION_PATH,
  assertRenderSubprocessEnvClean,
  buildRenderSubprocessEnv,
  injectStudioRenderParityScripts,
} from '../../src/workers/render-env.ts';
import {
  applyRenderSettingsToExpectation,
  buildRenderExportArgs,
  buildThumbnailSnapshotArgs,
  hydrateSnapshotFilesToDir,
  parseCgroupCpuLimit,
  parseCgroupMemoryLimitMb,
  parseRenderProgressLine,
  processExportRenderJob,
  processRenderThumbnailJob,
  resolveRenderCaptureTuning,
  selectReferencedMediaCandidates,
  startRenderHealthHeartbeat,
  sweepStaleRenderTempDirs,
} from '../../src/workers/render-export.ts';
import {
  launchFilmstripBrowser,
  type LaunchFilmstripBrowserOptions,
} from '../../src/workers/filmstrip-renderer.ts';
import { registerRenderWorkerShutdownHooks } from '../../src/workers/worker.ts';

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

it('classifies renderer output without retaining private log text', () => {
  const cases = [
    ['Failed to launch the browser: listen EACCES 127.0.0.1', 'local_port_denied'],
    ['Chrome cannot start', 'browser_start'],
    ['Error while opening encoder', 'encoder'],
    ['private process output', 'unclassified'],
  ] as const;
  for (const [log, expected] of cases) assert.equal(classifyRenderFailure(log), expected);
});

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

  it('launches catalog filmstrip Chromium with strictly allowlisted render env and cleans up ephemeral dirs on close and launch failure', async () => {
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'om-test-filmstrip-env-'));
    try {
      const pollutedSourceEnv: NodeJS.ProcessEnv = {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HYPERFRAMES_BROWSER_PATH: '/usr/bin/chromium',
        DATABASE_URL: 'postgres://user:placeholder@postgres:5432/openmotion',
        REDIS_URL: 'redis://:placeholder@redis:6379',
        S3_ACCESS_KEY_ID: 'synthetic-s3-access-id',
        S3_SECRET_ACCESS_KEY: 'test-s3-secret-00000000',
        AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret-val',
        OPENDESIGN_S2S_API_KEY: 'synthetic-opendesign-key',
        OIDC_CLIENT_SECRET: 'synthetic-oidc-secret',
        SESSION_SECRET: 'synthetic-session-secret-0123456789abcdef',
        DEV_PAT: 'synthetic-dev-pat-value',
        OPENAI_API_KEY: 'synthetic-openai-val',
      };

      const captured: Array<Record<string, unknown>> = [];
      let browserClosed = false;
      const session = await launchFilmstripBrowser({
        executablePath: '/usr/bin/chromium',
        sourceEnv: pollutedSourceEnv,
        tmpBaseDir: tmpBase,
        launchFn: (async (opts: Record<string, unknown>) => {
          captured.push(opts);
          return {
            close: async () => {
              browserClosed = true;
            },
          };
        }) as unknown as LaunchFilmstripBrowserOptions['launchFn'],
      });

      const capturedLaunchOptions = captured[0];
      assert.ok(capturedLaunchOptions);
      const launchEnv = capturedLaunchOptions.env as Record<string, string | undefined>;
      assert.ok(launchEnv, 'puppeteer.launch MUST receive an explicit sanitized env object');
      assert.doesNotThrow(() => assertRenderSubprocessEnvClean(launchEnv));
      for (const secretKey of [
        'DATABASE_URL',
        'REDIS_URL',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'OPENDESIGN_S2S_API_KEY',
        'OIDC_CLIENT_SECRET',
        'SESSION_SECRET',
        'DEV_PAT',
        'OPENAI_API_KEY',
      ]) {
        assert.equal(launchEnv[secretKey], undefined, `Secret "${secretKey}" leaked into filmstrip Chromium env!`);
      }
      assert.equal(launchEnv.HYPERFRAMES_NO_TELEMETRY, '1');
      assert.equal(launchEnv.HYPERFRAMES_NO_AUTO_INSTALL, '1');
      assert.equal(launchEnv.HOME, path.join(session.rootDir, 'home'));
      assert.equal(launchEnv.TMPDIR, path.join(session.rootDir, 'tmp'));
      assert.equal(capturedLaunchOptions.userDataDir, path.join(session.rootDir, 'profile'));
      await access(session.rootDir);

      await session.close();
      assert.equal(browserClosed, true);
      await assert.rejects(() => access(session.rootDir), 'session.close() must wipe ephemeral filmstrip dir');

      // Launch failure must also wipe the created ephemeral filmstrip dir immediately.
      let failedUserDataDir = '';
      await assert.rejects(
        () =>
          launchFilmstripBrowser({
            executablePath: '/usr/bin/chromium',
            sourceEnv: pollutedSourceEnv,
            tmpBaseDir: tmpBase,
            launchFn: (async (opts: Record<string, unknown>) => {
              failedUserDataDir = String(opts.userDataDir ?? '');
              throw new Error('simulated Chromium launch failure');
            }) as unknown as LaunchFilmstripBrowserOptions['launchFn'],
          }),
        /simulated Chromium launch failure/,
      );
      assert.ok(failedUserDataDir.startsWith(tmpBase));
      await assert.rejects(
        () => access(path.dirname(failedUserDataDir)),
        'failed browser launch must wipe ephemeral filmstrip dir',
      );

      // Stale om-filmstrip-* directories left by OOM kills are swept on worker startup.
      const staleFilmstripDir = path.join(tmpBase, 'om-filmstrip-stale-oom');
      await mkdir(staleFilmstripDir, { recursive: true });
      const sweptCount = await sweepStaleRenderTempDirs(tmpBase, SILENT_LOGGER);
      assert.equal(sweptCount, 1);
      await assert.rejects(() => access(staleFilmstripDir));
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
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
      '--composition',
      'intro-scene',
      '--frames',
      '1',
      '--no-end',
      '--json',
    ]);
  });

  it('forwards allowlisted payload.settings and capture tuning flags onto hyperframes render CLI args without --json', () => {
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
      workers: 2,
      disableLowMemoryMode: true,
      disableBrowserGpu: true,
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
      '--workers',
      '2',
      '--no-low-memory-mode',
      '--no-browser-gpu',
    ]);
    assert.equal(mp4Args.includes('--json'), false);

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
    ]);
    assert.equal(gifArgs.includes('--json'), false);
  });

  it('parses hyperframes @hf-progress lines, ANSI progress bars, and legacy JSON progress lines cleanly', () => {
    assert.deepEqual(
      parseRenderProgressLine('@hf-progress {"code":"start_browsers","done":1,"total":3,"pct":1}'),
      { progress: 1, stage: 'Starting browsers (1/3 ready)' },
    );
    assert.deepEqual(
      parseRenderProgressLine('@hf-progress {"code":"extract_video","done":20,"total":100,"pct":12}'),
      { progress: 12, stage: 'Extracting video frames' },
    );
    assert.deepEqual(
      parseRenderProgressLine('@hf-progress {"code":"capture","done":126,"total":300,"pct":42}'),
      { progress: 42, stage: 'Capturing frame 126/300' },
    );
    assert.deepEqual(
      parseRenderProgressLine('@hf-progress {"code":"encode","done":210,"total":300,"pct":78}'),
      { progress: 78, stage: 'Encoding frame 210/300' },
    );
    assert.deepEqual(
      parseRenderProgressLine('@hf-progress {"code":"assemble","done":5,"total":10,"pct":95}'),
      { progress: 95, stage: 'Assembling final video' },
    );
    assert.deepEqual(
      parseRenderProgressLine('\x1b[36m█████░░░░░░░░░░░░░░░░░░░░\x1b[0m  \x1b[1m20%\x1b[0m  \x1b[2mCompiling composition\x1b[0m'),
      { progress: 20, stage: 'Compiling composition' },
    );
    assert.deepEqual(
      parseRenderProgressLine('  ████████████░░░░░░░░░░░░░  50%  Capturing frame 150/300 (2 workers)'),
      { progress: 50, stage: 'Capturing frame 150/300 (2 workers)' },
    );
    assert.deepEqual(
      parseRenderProgressLine('{"progress":0.5,"stage":"capturing"}'),
      { progress: 50, stage: 'capturing' },
    );
    assert.deepEqual(
      parseRenderProgressLine('{"percent":65}'),
      { progress: 65, stage: undefined },
    );
    assert.equal(parseRenderProgressLine('Render complete in 12.3s'), null);
    assert.equal(parseRenderProgressLine('@hf-progress not-json'), null);
  });

  it('sizes parallel capture workers safely from cgroup CPU/memory budgets and respects explicit overrides', () => {
    assert.equal(parseCgroupCpuLimit('400000 100000\n', null, null), 4);
    assert.equal(parseCgroupCpuLimit('50000 100000\n', null, null), 0.5);
    assert.equal(parseCgroupCpuLimit('max 100000\n', null, null), null);
    assert.equal(parseCgroupCpuLimit(null, '200000\n', '100000\n'), 2);
    assert.equal(parseCgroupMemoryLimitMb('4294967296\n', null), 4096);
    assert.equal(parseCgroupMemoryLimitMb('max\n', null), null);
    assert.equal(parseCgroupMemoryLimitMb(null, '9223372036854771712\n'), null);

    // Sub-1-core cgroup quota keeps accurate cpuLimit while clamping workers to 1.
    const fractionalCpu = resolveRenderCaptureTuning({ cpuLimit: 0.5, memoryLimitMb: 4096, sourceEnv: {} });
    assert.equal(fractionalCpu.cpuLimit, 0.5);
    assert.equal(fractionalCpu.workers, 1);
    assert.equal(fractionalCpu.disableLowMemoryMode, false);

    // Default 2 GiB local Compose container stays at 1 worker with low-memory mode intact.
    assert.deepEqual(
      resolveRenderCaptureTuning({ cpuLimit: 4, memoryLimitMb: 2048, sourceEnv: {} }),
      {
        workers: 1,
        disableLowMemoryMode: false,
        disableBrowserGpu: true,
        cpuLimit: 4,
        memoryLimitMb: 2048,
        source: 'auto',
      },
    );

    // 4 CPU / 4 GiB pod runs 2 parallel capture workers and disables low-memory 1-worker pin.
    assert.deepEqual(
      resolveRenderCaptureTuning({ cpuLimit: 4, memoryLimitMb: 4096, sourceEnv: {} }),
      {
        workers: 2,
        disableLowMemoryMode: true,
        disableBrowserGpu: true,
        cpuLimit: 4,
        memoryLimitMb: 4096,
        source: 'auto',
      },
    );

    // 4 CPU / 8 GiB K8s manifest runs 3 parallel capture workers.
    assert.deepEqual(
      resolveRenderCaptureTuning({ cpuLimit: 4, memoryLimitMb: 8192, sourceEnv: {} }),
      {
        workers: 3,
        disableLowMemoryMode: true,
        disableBrowserGpu: true,
        cpuLimit: 4,
        memoryLimitMb: 8192,
        source: 'auto',
      },
    );

    // Concurrent render jobs divide effective memory/CPU budget per job.
    assert.equal(
      resolveRenderCaptureTuning({ cpuLimit: 4, memoryLimitMb: 4096, concurrency: 2, sourceEnv: {} }).workers,
      1,
    );

    // Explicit env/config override wins over auto sizing.
    assert.deepEqual(
      resolveRenderCaptureTuning({
        cpuLimit: 2,
        memoryLimitMb: 2048,
        sourceEnv: { RENDER_CAPTURE_WORKERS: '3', PRODUCER_BROWSER_GPU_MODE: 'hardware' },
      }),
      {
        workers: 3,
        disableLowMemoryMode: true,
        disableBrowserGpu: false,
        cpuLimit: 2,
        memoryLimitMb: 2048,
        source: 'env',
      },
    );
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
          captureWorkers: 2,
          sourceEnv: {
            PATH: '/usr/bin:/bin',
            DATABASE_URL: 'postgres://secret@db/om',
            OPENDESIGN_S2S_API_KEY: 'synthetic-key',
          },
          runRenderCommand: async (_rt, _dir, args, opts) => {
            // Confirm render command received strictly stripped env and non-quiet multi-worker CLI args.
            assert.equal(opts.env.DATABASE_URL, undefined);
            assert.equal(opts.env.OPENDESIGN_S2S_API_KEY, undefined);
            assert.equal(opts.env.HYPERFRAMES_GSAP_WRITER, 'acorn');
            assert.equal(args.includes('--json'), false);
            assert.equal(args[args.indexOf('--workers') + 1], '2');
            assert.equal(args.includes('--no-low-memory-mode'), true);
            assert.equal(args.includes('--no-browser-gpu'), true);
            const outIdx = args.indexOf('--output');
            await writeFile(args[outIdx + 1], fakeMp4);
            // Emit back-to-back bar + @hf-progress lines in the same phase (deduplicated/throttled),
            // followed immediately by a phase transition that MUST bypass the 500ms intra-phase throttle.
            opts.onStdoutLine?.('  ████████████░░░░░░░░░░░░░  50%  Capturing frame 150/300 (2 workers)');
            opts.onStdoutLine?.('@hf-progress {"code":"capture","done":150,"total":300,"pct":50}');
            opts.onStdoutLine?.('@hf-progress {"code":"assemble","done":5,"total":10,"pct":95}');
            return { code: 0, stdout: 'Render complete\n', stderr: '' };
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
      assert.ok(statusUpdates.some((u) => u.stage === 'Capturing frame 150/300 (2 workers)' && u.progress === 50));
      assert.ok(statusUpdates.some((u) => u.state === 'completed'));
      const renderProgressEvents = eventBus.published
        .filter((e) => e.channel === jobChannel(JID_OK))
        .map((e) => e.payload as { state?: string; stage?: string; progress?: number });
      const captureIdx = renderProgressEvents.findIndex(
        (e) => e.stage === 'Capturing frame 150/300 (2 workers)' && e.progress === 50,
      );
      const assembleIdx = renderProgressEvents.findIndex(
        (e) => e.stage === 'Assembling final video' && e.progress === 82,
      );
      const verifyingIdx = renderProgressEvents.findIndex((e) => e.stage === 'verifying' && e.progress === 88);
      assert.ok(captureIdx >= 0, 'job channel must receive capture progress');
      assert.ok(
        assembleIdx > captureIdx,
        'phase transition to Assembling final video must not be dropped by intra-phase 500ms throttle',
      );
      assert.ok(
        verifyingIdx > assembleIdx,
        'in-flight render progress publish must settle strictly before verifying checkpoint',
      );
      assert.equal(
        renderProgressEvents.filter((e) => e.stage === 'Capturing frame 150/300').length,
        0,
        'back-to-back @hf-progress line in same phase should be throttled after bar line',
      );
      // /tmp/om-render-<jobId> MUST be completely removed!
      await assert.rejects(() => access(path.join(tmpBase, `om-render-${JID_OK}`)));

      // 2. Failure path (render throws): marks failed, uploads NO MP4, and STILL wipes /tmp!
      const failUpdates: Array<Record<string, unknown>> = [];
      const failedRenderEvents: Array<{ renderReason?: string }> = [];
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
            cloudTracking: {
              isEnabled: () => true,
              trackExportResult: (event: { renderReason?: string }) => failedRenderEvents.push(event),
              trackTaskTerminal: () => {},
            } as never,
            runRenderCommand: async () => ({ code: 1, stdout: '', stderr: 'Chrome cannot start' }),
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
      assert.deepEqual(failedRenderEvents.map(event => event.renderReason), ['browser_start']);
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

  it('keeps render health heartbeat pulsing with draining=true until renderWorker.close() finishes', async () => {
    const eventBus = new MemoryEventBus();
    const shutdown = new ShutdownCoordinator({ logger: SILENT_LOGGER, timeoutMs: 5_000 });
    const heartbeat = startRenderHealthHeartbeat({
      eventBus,
      logger: SILENT_LOGGER,
      workerId: 'render-drain-1',
      concurrency: 1,
      intervalMs: 25,
    });
    heartbeat.setActiveJobs(1);

    const lifecycle: string[] = [];
    let resolveDrain!: () => void;
    const drainPromise = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const origStop = heartbeat.stop.bind(heartbeat);
    heartbeat.stop = () => {
      lifecycle.push('heartbeat-stop');
      origStop();
    };

    registerRenderWorkerShutdownHooks({
      shutdown,
      heartbeat,
      renderWorker: {
        close: async () => {
          lifecycle.push('worker-close-start');
          await drainPromise;
          lifecycle.push('worker-close-end');
        },
      },
      closeConnections: async () => {
        lifecycle.push('connections-quit');
      },
    });

    const shutdownDone = shutdown.shutdown('SIGTERM');

    // Wait for at least two draining pulses while renderWorker.close() is still in flight.
    const deadline = Date.now() + 2_000;
    while (
      eventBus.healthPulses.filter((p) => p.workerId === 'render-drain-1' && p.draining === true && p.activeJobs === 1)
        .length < 2
    ) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for draining heartbeat pulses (observed ${JSON.stringify(eventBus.healthPulses)})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    // Heartbeat must remain alive and connections open until renderWorker.close() resolves.
    assert.deepEqual(lifecycle, ['worker-close-start']);

    heartbeat.setActiveJobs(0);
    resolveDrain();
    assert.equal(await shutdownDone, true);

    assert.deepEqual(lifecycle, [
      'worker-close-start',
      'worker-close-end',
      'heartbeat-stop',
      'connections-quit',
    ]);

    const pulsesAtStop = eventBus.healthPulses.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(eventBus.healthPulses.length, pulsesAtStop);
  });

  it('skips unreferenced large media blobs during referenced-only hydration while keeping referenced & encoded-path media and dynamic template fallbacks', async () => {
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'om-render-ref-only-'));
    try {
      const storage = new MemoryStorage();
      const requestedKeys: string[] = [];
      const origStream = storage.getObjectStream.bind(storage);
      storage.getObjectStream = async (key: string) => {
        requestedKeys.push(key);
        return origStream(key);
      };

      const html = Buffer.from(
        '<!doctype html><html><body><video src="assets/used%20clip.mp4"></video><video src="成片_v1.mp4"></video></body></html>',
        'utf8',
      );
      const usedClip = Buffer.alloc(400 * 1024, 0x11);
      const usedCjk = Buffer.alloc(400 * 1024, 0x22);
      const unusedHuge = Buffer.alloc(600 * 1024, 0x33);
      const smallIcon = Buffer.alloc(1024, 0x44);

      const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
      const files = [
        { path: 'index.html', blobScope: 'workspace' as const, sha256: sha(html), sizeBytes: html.byteLength, mimeType: 'text/html' },
        { path: 'assets/used clip.mp4', blobScope: 'workspace' as const, sha256: sha(usedClip), sizeBytes: usedClip.byteLength, mimeType: 'video/mp4' },
        { path: '成片_v1.mp4', blobScope: 'workspace' as const, sha256: sha(usedCjk), sizeBytes: usedCjk.byteLength, mimeType: 'video/mp4' },
        { path: 'assets/unused-library.mp4', blobScope: 'workspace' as const, sha256: sha(unusedHuge), sizeBytes: unusedHuge.byteLength, mimeType: 'video/mp4' },
        { path: 'assets/small-icon.png', blobScope: 'workspace' as const, sha256: sha(smallIcon), sizeBytes: smallIcon.byteLength, mimeType: 'image/png' },
      ];
      await storage.putObject(workspaceBlobKey(WID_A, sha(html)), html, 'text/html');
      await storage.putObject(workspaceBlobKey(WID_A, sha(usedClip)), usedClip, 'video/mp4');
      await storage.putObject(workspaceBlobKey(WID_A, sha(usedCjk)), usedCjk, 'video/mp4');
      await storage.putObject(workspaceBlobKey(WID_A, sha(unusedHuge)), unusedHuge, 'video/mp4');
      await storage.putObject(workspaceBlobKey(WID_A, sha(smallIcon)), smallIcon, 'image/png');

      const projectDir = path.join(tmpBase, 'project');
      const result = await hydrateSnapshotFilesToDir({
        storage,
        workspaceId: WID_A,
        projectDir,
        compositionPath: 'index.html',
        files,
        onlyReferencedMedia: true,
      });

      assert.equal(result.fileCount, 4);
      assert.equal(result.skippedUnreferencedCount, 1);
      assert.equal(requestedKeys.includes(workspaceBlobKey(WID_A, sha(unusedHuge))), false);
      await access(path.join(projectDir, 'assets/used clip.mp4'));
      await access(path.join(projectDir, '成片_v1.mp4'));
      await access(path.join(projectDir, 'assets/small-icon.png'));
      await assert.rejects(() => access(path.join(projectDir, 'assets/unused-library.mp4')));

      // Dynamic template literal `${idx}.mp4` conservatively hydrates all candidates.
      const dynamicPicked = selectReferencedMediaCandidates(
        [files[3]],
        ['const url = `assets/clip-${idx}.mp4`;'],
      );
      assert.equal(dynamicPicked.length, 1);
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  });

  it('hydrates bundled vendor dist dependencies for built-in templates while rejecting top-level dist paths', async () => {
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'om-render-vendor-dist-'));
    try {
      const storage = new MemoryStorage();
      const html = Buffer.from(
        '<!doctype html><html><head><script src="./vendor/gsap-3.14.2/dist/gsap.min.js"></script></head><body><div data-composition-id="main"></div></body></html>',
        'utf8',
      );
      const gsap = Buffer.from('/* bundled gsap 3.14.2 */', 'utf8');
      const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

      await storage.putObject(catalogBlobKey(sha(html)), html, 'text/html');
      await storage.putObject(catalogBlobKey(sha(gsap)), gsap, 'text/javascript');

      const projectDir = path.join(tmpBase, 'project');
      const hydrated = await hydrateSnapshotFilesToDir({
        storage,
        workspaceId: WID_A,
        projectDir,
        compositionPath: 'index.html',
        files: [
          { path: 'index.html', blobScope: 'catalog', sha256: sha(html), sizeBytes: html.byteLength, mimeType: 'text/html' },
          { path: 'vendor/gsap-3.14.2/dist/gsap.min.js', blobScope: 'catalog', sha256: sha(gsap), sizeBytes: gsap.byteLength, mimeType: 'text/javascript' },
        ],
        onlyReferencedMedia: true,
      });

      assert.equal(hydrated.fileCount, 2);
      assert.equal(
        await readFile(path.join(projectDir, 'vendor/gsap-3.14.2/dist/gsap.min.js'), 'utf8'),
        gsap.toString('utf8'),
      );

      await assert.rejects(
        () =>
          hydrateSnapshotFilesToDir({
            storage,
            workspaceId: WID_A,
            projectDir: path.join(tmpBase, 'bad-project'),
            compositionPath: 'index.html',
            files: [
              { path: 'index.html', blobScope: 'catalog', sha256: sha(html), sizeBytes: html.byteLength, mimeType: 'text/html' },
              { path: 'dist/gsap.min.js', blobScope: 'catalog', sha256: sha(gsap), sizeBytes: gsap.byteLength, mimeType: 'text/javascript' },
            ],
            onlyReferencedMedia: true,
          }),
        /工程文件路径无效/,
      );
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  });
});

describe('Sub-scene (<template>) Export Expectation, Parity Injection & Settings Overrides (OPEND-5768)', () => {
  it('extracts export expectation from <template>-wrapped sub-scenes, inheriting index.html shell dimensions/duration when omitted', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'om-test-template-exp-'));
    try {
      await mkdir(path.join(tmpDir, 'compositions'), { recursive: true });
      const env = buildRenderSubprocessEnv({
        ephemeralHomeDir: path.join(tmpDir, 'home'),
        ephemeralTmpDir: path.join(tmpDir, 'tmp'),
      });

      await writeFile(
        path.join(tmpDir, 'index.html'),
        `<!doctype html><html><body>
          <div data-composition-id="root" data-width="1920" data-height="1080" data-fps="24" data-duration="20">
            <div data-composition-src="compositions/day.html" data-start="0" data-duration="6"></div>
            <div data-composition-src="compositions/inherited.html" data-start="6" data-duration="4"></div>
            <div data-composition-src="compositions/different-size.html" data-start="10" data-duration="2.5"></div>
            <div data-composition-src="compositions/broken.html" data-start="12.5" data-duration="2"></div>
          </div>
        </body></html>`,
      );

      // 1. Standard <template>-wrapped scene (like OPEND-5768 compositions/day.html).
      await writeFile(
        path.join(tmpDir, 'compositions/day.html'),
        `<template id="day-template">
          <div data-composition-id="day" data-width="1920" data-height="1080" data-duration="5" data-fps="30">
            <h1>Day Scene</h1>
          </div>
        </template>`,
      );
      const dayIso = await snapshotExportExpectationIsolated(pluginRoot, tmpDir, 'compositions/day.html', { env });
      const dayLocal = await snapshotExportExpectation(pluginRoot, tmpDir, 'compositions/day.html');
      assert.deepEqual(dayIso, { width: 1920, height: 1080, fps: 30, duration: 5, audio: 'optional' });
      assert.deepEqual(dayLocal, dayIso);

      // 2. <template> sub-scene omitting width/height/duration inherits canvas size & mount duration from index.html.
      await writeFile(
        path.join(tmpDir, 'compositions/inherited.html'),
        `<template><div data-composition-id="inherited"><h1>Inherited</h1></div></template>`,
      );
      const inherited = await snapshotExportExpectationIsolated(pluginRoot, tmpDir, 'compositions/inherited.html', { env });
      assert.deepEqual(inherited, { width: 1920, height: 1080, fps: 24, duration: 4, audio: 'optional' });

      // 3. Mounted <template> sub-scene matches hyperframes producer canvas size (index.html root 1920x1080, not 1280x720).
      await writeFile(
        path.join(tmpDir, 'compositions/different-size.html'),
        `<template><div data-composition-id="diff" data-width="1280" data-height="720" data-duration="2"></div></template>`,
      );
      const diffSize = await snapshotExportExpectationIsolated(pluginRoot, tmpDir, 'compositions/different-size.html', { env });
      assert.deepEqual(diffSize, { width: 1920, height: 1080, fps: 24, duration: 2, audio: 'optional' });

      // 4. Unmounted <template> sub-scene with nested compositions respects data-root="true".
      await writeFile(
        path.join(tmpDir, 'compositions/nested.html'),
        `<template>
          <div data-composition-id="child" data-width="640" data-height="360" data-duration="1"></div>
          <div data-composition-id="main-nested" data-root="true" data-width="1080" data-height="1920" data-duration="3.5" data-fps="60"></div>
        </template>`,
      );
      const nested = await snapshotExportExpectationIsolated(pluginRoot, tmpDir, 'compositions/nested.html', { env });
      assert.deepEqual(nested, { width: 1080, height: 1920, fps: 60, duration: 3.5, audio: 'optional' });

      // 5. Full document with an unrelated <template> before top-level composition still resolves top-level composition.
      await writeFile(
        path.join(tmpDir, 'compositions/standalone-with-tpl.html'),
        `<!doctype html><html><body>
          <template><div data-composition-id="ignored-tpl" data-width="100" data-height="100" data-duration="1"></div></template>
          <div data-composition-id="real-root" data-width="1280" data-height="720" data-duration="7"></div>
        </body></html>`,
      );
      const standalone = await snapshotExportExpectationIsolated(
        pluginRoot,
        tmpDir,
        'compositions/standalone-with-tpl.html',
        { env },
      );
      assert.deepEqual(standalone, { width: 1280, height: 720, fps: 30, duration: 7, audio: 'optional' });

      // 6. <template> without any data-composition-id still rejects as missing root composition even if mounted in index.html.
      await writeFile(
        path.join(tmpDir, 'compositions/broken.html'),
        `<template><div>No composition attribute</div></template>`,
      );
      await assert.rejects(
        () => snapshotExportExpectationIsolated(pluginRoot, tmpDir, 'compositions/broken.html', { env }),
        /Export snapshot is missing a root composition/,
      );
      await assert.rejects(
        () => snapshotExportExpectation(pluginRoot, tmpDir, 'compositions/broken.html'),
        /导出快照缺少根 composition/,
      );

      // 7. Real bundled template-library <template> sub-scenes resolve cleanly.
      const promoScene = await snapshotExportExpectationIsolated(
        pluginRoot,
        path.join(pluginRoot, 'template-library/product-promo'),
        'compositions/scene1-logo-intro.html',
        { env },
      );
      assert.deepEqual(promoScene, { width: 1920, height: 1080, fps: 30, duration: 1.5, audio: 'optional' });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('injects Studio parity scripts inside </template> for template sub-scenes so bundleToSingleHtml preserves them', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'om-test-template-parity-'));
    try {
      await mkdir(path.join(tmpDir, 'compositions'), { recursive: true });
      await writeFile(
        path.join(tmpDir, 'index.html'),
        `<!doctype html><html><body><div data-composition-id="root" data-width="1920" data-height="1080" data-duration="10"><div data-composition-src="compositions/day.html" data-start="0" data-duration="5"></div></div></body></html>`,
      );
      const dayHtml = `<template id="day-tpl"><div data-composition-id="day" data-width="1920" data-height="1080" data-duration="5"><h1 data-hf-id="day-h1">Day</h1></div></template>`;
      const manualEditsJson = JSON.stringify({ version: 1, edits: [{ id: 'day-h1', dx: 12, dy: -8 }] });
      const studioMotionJson = JSON.stringify({
        version: 1,
        motions: [
          {
            kind: 'gsap-motion',
            target: { hfId: 'day-h1' },
            start: 0,
            duration: 1,
            from: { opacity: 0 },
            to: { opacity: 1 },
          },
        ],
      });

      const injected = injectStudioRenderParityScripts(dayHtml, {
        manualEditsJson,
        studioMotionJson,
        activeCompositionPath: 'compositions/day.html',
      });
      assert.equal(injected.injectedManualEdits, true);
      assert.equal(injected.injectedStudioMotion, true);
      assert.ok(
        injected.html.indexOf('studioManualEditsRenderRuntime') < injected.html.lastIndexOf('</template>'),
        'parity scripts must be inserted before </template> so hyperframes does not discard them',
      );

      await writeFile(path.join(tmpDir, 'compositions/day.html'), injected.html);
      const bundled = await bundleToSingleHtml(tmpDir, { entryFile: 'compositions/day.html' });
      assert.match(bundled, /studioManualEditsRenderRuntime/);
      assert.match(bundled, /studioMotionRenderRuntime/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies explicit fps/resolution render settings onto export expectation and ignores resolution=auto in CLI args', () => {
    const autoArgs = buildRenderExportArgs({
      compositionPath: 'compositions/day.html',
      outputFilePath: '/tmp/out/day.mp4',
      format: 'mp4',
      settings: { fps: 30, quality: 'standard', resolution: 'auto' },
    });
    assert.equal(autoArgs.includes('--resolution'), false);

    const base = { width: 1920, height: 1080, fps: 30, duration: 5, audio: 'optional' as const };
    assert.deepEqual(
      applyRenderSettingsToExpectation(base, { fps: 60, resolution: 'landscape-4k' }),
      { width: 3840, height: 2160, fps: 60, duration: 5, audio: 'optional' },
    );
    assert.deepEqual(
      applyRenderSettingsToExpectation(base, { fps: '24000/1001', resolution: 'auto' }),
      { width: 1920, height: 1080, fps: 24000 / 1001, duration: 5, audio: 'optional' },
    );
    assert.deepEqual(
      applyRenderSettingsToExpectation(
        { width: 1080, height: 1920, fps: 60, duration: 4, audio: 'optional' },
        { fps: 30, resolution: '4k' },
      ),
      { width: 2160, height: 3840, fps: 30, duration: 4, audio: 'optional' },
    );

    // Project titles with trailing or consecutive dots (e.g. "Custom Agents.") must never produce ".." in S3 export keys.
    assert.equal(sanitizeExportFilename(undefined, 'Custom Agents.', 'mp4'), 'Custom-Agents.mp4');
    assert.equal(sanitizeExportFilename('foo..bar.mp4', 'Ignored', 'mp4'), 'foo-bar.mp4');
    assert.equal(sanitizeExportFilename('...', '...', 'mp4'), 'export.mp4');
  });

  it('completes end-to-end processExportRenderJob for a <template> sub-scene without mocked extractExpectationFn', async () => {
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'om-test-render-subscene-'));
    try {
      const storage = new MemoryStorage();
      const eventBus = new MemoryEventBus();
      const indexHtml = `<!doctype html><html><body>
        <div data-composition-id="root" data-width="1920" data-height="1080" data-duration="20">
          <div data-composition-src="compositions/day.html" data-start="0" data-duration="5"></div>
        </div>
      </body></html>`;
      const dayHtml = `<template id="day-template">
        <div data-composition-id="day" data-width="1920" data-height="1080" data-duration="5">
          <h1 data-hf-id="day-title">Day</h1>
        </div>
      </template>`;
      const manualEditsJson = JSON.stringify({ version: 1, edits: [{ id: 'day-title', dx: 16, dy: 0 }] });

      const indexSha = sha256(indexHtml);
      const daySha = sha256(dayHtml);
      const editsSha = sha256(manualEditsJson);
      await storage.putObject(workspaceBlobKey(WID_A, indexSha), indexHtml, 'text/html');
      await storage.putObject(workspaceBlobKey(WID_A, daySha), dayHtml, 'text/html');
      await storage.putObject(workspaceBlobKey(WID_A, editsSha), manualEditsJson, 'application/json');

      const snapshotRows = [
        { path: 'index.html', blobScope: 'workspace', sha256: indexSha, sizeBytes: indexHtml.length, mimeType: 'text/html' },
        { path: 'compositions/day.html', blobScope: 'workspace', sha256: daySha, sizeBytes: dayHtml.length, mimeType: 'text/html' },
        { path: STUDIO_MANUAL_EDITS_PATH, blobScope: 'workspace', sha256: editsSha, sizeBytes: manualEditsJson.length, mimeType: 'application/json' },
      ];

      const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(64, 9)]);
      const db = createFakeRenderDb(snapshotRows, () => [{ id: JID_OK }]);
      let verifiedExpected: unknown;
      let hydratedDayHtml = '';

      const res = await processExportRenderJob(
        {
          db,
          storage,
          eventBus,
          logger: SILENT_LOGGER,
          workerId: 'render-test-subscene',
          tmpBaseDir: tmpBase,
          runRenderCommand: async (_rt, projectDir, args) => {
            assert.equal(args[args.indexOf('--composition') + 1], 'compositions/day.html');
            assert.equal(args[args.indexOf('--fps') + 1], '30');
            assert.equal(args.includes('--resolution'), false);
            hydratedDayHtml = await readFile(path.join(projectDir, 'compositions/day.html'), 'utf8');
            await writeFile(args[args.indexOf('--output') + 1], fakeMp4);
            return { code: 0, stdout: 'Render complete\n', stderr: '' };
          },
          verifyExportFn: async (outFile, expected) => {
            verifiedExpected = expected;
            return {
              scope: 'technical',
              status: 'passed',
              file: outFile,
              sha256: sha256(fakeMp4),
              expected,
              checks: [{ name: 'probe', status: 'passed', details: 'ok' }],
              remainingChecks: [],
            };
          },
        },
        {
          jobId: JID_OK,
          workspaceId: WID_A,
          projectId: PID_A,
          versionId: VID_A,
          revision: REV_1,
          compositionPath: 'compositions/day.html',
          outputName: 'Custom Agents-day.mp4',
          format: 'mp4',
          phase1: true,
          settings: { format: 'mp4', quality: 'standard', fps: 30, resolution: 'auto' },
        },
      );

      assert.equal(res.state, 'completed');
      assert.deepEqual(verifiedExpected, {
        width: 1920,
        height: 1080,
        fps: 30,
        duration: 5,
        audio: 'optional',
      });
      assert.ok(
        hydratedDayHtml.indexOf('studioManualEditsRenderRuntime') > 0 &&
          hydratedDayHtml.indexOf('studioManualEditsRenderRuntime') < hydratedDayHtml.lastIndexOf('</template>'),
      );
      await assert.rejects(() => access(path.join(tmpBase, `om-render-${JID_OK}`)));
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  });

  it('forwards authored template/shell data-fps to hyperframes render when settings.fps is omitted so CLI and verification match', async () => {
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'om-test-render-template-fps-'));
    try {
      const storage = new MemoryStorage();
      const eventBus = new MemoryEventBus();
      const indexHtml = `<!doctype html><html><body>
        <div data-composition-id="root" data-width="1920" data-height="1080" data-fps="24" data-duration="20">
          <div data-composition-src="compositions/fps60.html" data-start="0" data-duration="3"></div>
          <div data-composition-src="compositions/inherit24.html" data-start="3" data-duration="4"></div>
        </div>
      </body></html>`;
      const fps60Html = `<template><div data-composition-id="fps60" data-width="1920" data-height="1080" data-duration="3" data-fps="60">60fps</div></template>`;
      const inherit24Html = `<template><div data-composition-id="inherit24" data-duration="4">24fps</div></template>`;

      const indexSha = sha256(indexHtml);
      const fps60Sha = sha256(fps60Html);
      const inherit24Sha = sha256(inherit24Html);
      await storage.putObject(workspaceBlobKey(WID_A, indexSha), indexHtml, 'text/html');
      await storage.putObject(workspaceBlobKey(WID_A, fps60Sha), fps60Html, 'text/html');
      await storage.putObject(workspaceBlobKey(WID_A, inherit24Sha), inherit24Html, 'text/html');

      const snapshotRows = [
        { path: 'index.html', blobScope: 'workspace', sha256: indexSha, sizeBytes: indexHtml.length, mimeType: 'text/html' },
        { path: 'compositions/fps60.html', blobScope: 'workspace', sha256: fps60Sha, sizeBytes: fps60Html.length, mimeType: 'text/html' },
        { path: 'compositions/inherit24.html', blobScope: 'workspace', sha256: inherit24Sha, sizeBytes: inherit24Html.length, mimeType: 'text/html' },
      ];

      const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(64, 5)]);

      for (const scenario of [
        { compositionPath: 'compositions/fps60.html', expectedFps: 60, expectedDuration: 3 },
        { compositionPath: 'compositions/inherit24.html', expectedFps: 24, expectedDuration: 4 },
      ]) {
        let passedArgs: string[] = [];
        let verifiedExpected: unknown;
        const db = createFakeRenderDb(snapshotRows, () => [{ id: JID_OK }]);
        const res = await processExportRenderJob(
          {
            db,
            storage,
            eventBus,
            logger: SILENT_LOGGER,
            workerId: 'render-test-fps',
            tmpBaseDir: tmpBase,
            runRenderCommand: async (_rt, _dir, args) => {
              passedArgs = args;
              await writeFile(args[args.indexOf('--output') + 1], fakeMp4);
              return { code: 0, stdout: 'Render complete\n', stderr: '' };
            },
            verifyExportFn: async (outFile, expected) => {
              verifiedExpected = expected;
              return {
                scope: 'technical',
                status: 'passed',
                file: outFile,
                sha256: sha256(fakeMp4),
                expected,
                checks: [{ name: 'probe', status: 'passed', details: 'ok' }],
                remainingChecks: [],
              };
            },
          },
          {
            jobId: JID_OK,
            workspaceId: WID_A,
            projectId: PID_A,
            versionId: VID_A,
            revision: REV_1,
            compositionPath: scenario.compositionPath,
            outputName: 'scene.mp4',
            format: 'mp4',
            phase1: true,
          },
        );
        assert.equal(res.state, 'completed');
        assert.equal(
          passedArgs[passedArgs.indexOf('--fps') + 1],
          String(scenario.expectedFps),
          `${scenario.compositionPath} must pass explicit --fps ${scenario.expectedFps} to hyperframes render`,
        );
        assert.deepEqual(verifiedExpected, {
          width: 1920,
          height: 1080,
          fps: scenario.expectedFps,
          duration: scenario.expectedDuration,
          audio: 'optional',
        });
      }
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  });

  it('suppresses worker export_result, task_terminal, and work_generation_stage telemetry on both success and failure when telemetryOptOut is true, while emitting them for normal renders', async () => {
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'om-test-render-telemetry-optout-'));
    try {
      const storage = new MemoryStorage();
      const eventBus = new MemoryEventBus();
      const indexHtml = `<!doctype html><html><body><div data-composition-id="root" data-width="1280" data-height="720" data-fps="30" data-duration="2">ok</div></body></html>`;
      const indexSha = sha256(indexHtml);
      await storage.putObject(workspaceBlobKey(WID_A, indexSha), indexHtml, 'text/html');
      const snapshotRows = [
        { path: 'index.html', blobScope: 'workspace', sha256: indexSha, sizeBytes: indexHtml.length, mimeType: 'text/html' },
      ];
      const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]);

      const recorded: Array<{ kind: string; payload: Record<string, unknown> }> = [];
      const mockCloudTracking = {
        isEnabled: () => true,
        trackExportResult: (input: Record<string, unknown>) => {
          recorded.push({ kind: 'export_result', payload: input });
        },
        trackTaskTerminal: (input: Record<string, unknown>) => {
          recorded.push({ kind: 'task_terminal', payload: input });
        },
        trackWorkGenerationStage: (input: Record<string, unknown>) => {
          recorded.push({ kind: 'work_generation_stage', payload: input });
        },
      };

      // 1. Opted-out render (success path via payload flag) emits zero worker telemetry.
      const optedOutOkDb = createFakeRenderDb(snapshotRows, () => [
        { id: JID_OK, inputPayload: { telemetryOptOut: true }, workId: null },
      ]);
      const optedOutOk = await processExportRenderJob(
        {
          db: optedOutOkDb,
          storage,
          eventBus,
          logger: SILENT_LOGGER,
          workerId: 'render-test-optout',
          tmpBaseDir: tmpBase,
          cloudTracking: mockCloudTracking as never,
          runRenderCommand: async (_rt, _dir, args) => {
            await writeFile(args[args.indexOf('--output') + 1], fakeMp4);
            return { code: 0, stdout: 'Render complete\n', stderr: '' };
          },
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
          outputName: 'opted-out-ok.mp4',
          format: 'mp4',
          phase1: true,
          telemetryOptOut: true,
          userId: 'amr_should_not_emit',
          exportRoute: 'studio',
        },
      );
      assert.equal(optedOutOk.state, 'completed');
      assert.equal(recorded.length, 0);

      // 2. Opted-out render (failure path via persisted inputPayload flag) throws without emitting worker telemetry.
      const optedOutFailDb = createFakeRenderDb(snapshotRows, () => [
        { id: JID_FAIL, inputPayload: { telemetryOptOut: true, userId: 'amr_should_not_emit' }, workId: '77777777-7777-4777-8777-777777777777' },
      ]);
      await assert.rejects(
        () =>
          processExportRenderJob(
            {
              db: optedOutFailDb,
              storage,
              eventBus,
              logger: SILENT_LOGGER,
              workerId: 'render-test-optout',
              tmpBaseDir: tmpBase,
              cloudTracking: mockCloudTracking as never,
              runRenderCommand: async () => ({ code: 1, stdout: '', stderr: 'render boom' }),
            },
            {
              jobId: JID_FAIL,
              workspaceId: WID_A,
              projectId: PID_A,
              versionId: VID_A,
              revision: REV_1,
              outputName: 'opted-out-fail.mp4',
              format: 'mp4',
              phase1: true,
              exportRoute: 'studio',
            },
          ),
        /Hyperframes render exited with code 1/,
      );
      assert.equal(recorded.length, 0);

      // 3. Normal non-opted-out render emits export_result, task_terminal, and work_generation_stage(exported).
      const workId = '88888888-8888-4888-8888-888888888888';
      const normalDb = createFakeRenderDb(snapshotRows, () => [
        { id: JID_OK, inputPayload: { userId: 'amr_normal_user', exportRoute: 'studio' }, workId },
      ]);
      const normalOk = await processExportRenderJob(
        {
          db: normalDb,
          storage,
          eventBus,
          logger: SILENT_LOGGER,
          workerId: 'render-test-optout',
          tmpBaseDir: tmpBase,
          cloudTracking: mockCloudTracking as never,
          runRenderCommand: async (_rt, _dir, args) => {
            await writeFile(args[args.indexOf('--output') + 1], fakeMp4);
            return { code: 0, stdout: 'Render complete\n', stderr: '' };
          },
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
          outputName: 'normal-ok.mp4',
          format: 'mp4',
          phase1: true,
          userId: 'amr_normal_user',
          workId,
          exportRoute: 'studio',
        },
      );
      assert.equal(normalOk.state, 'completed');
      assert.deepEqual(
        recorded.map((entry) => entry.kind),
        ['export_result', 'task_terminal', 'work_generation_stage'],
      );
      assert.equal(recorded[0].payload.userId, 'amr_normal_user');
      assert.equal(recorded[1].payload.userId, 'amr_normal_user');
      assert.equal(recorded[2].payload.stage, 'exported');
      assert.equal(recorded[2].payload.workId, workId);
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  });
});
