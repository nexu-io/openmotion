import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  RUNTIME_CONFIG_GLOBAL_KEY,
  RUNTIME_CONFIG_PLACEHOLDER,
  buildBrowserObservabilityConfig,
  injectRuntimeConfigIntoHtml,
  parseSentryDsn,
  readBrowserObservabilityConfig,
  serializeRuntimeConfigScript,
} from '../../packages/observability/config.ts';
import {
  sanitizeHeaders,
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  sanitizeText,
  sanitizeUrl,
  shouldDropBrowserEvent,
} from '../../packages/observability/sanitize.ts';
import {
  createSentryVitePlugins,
  deriveDeterministicDebugId,
  resolveObservabilityBuildConfig,
  resolveStudioSourcemapOption,
} from '../../packages/observability/vite.ts';
import { createApiApp, serveStaticAsset, type ApiEventBusPort, type ApiQueuesPort } from '../../src/entrypoints/api.ts';
import type { StoragePort } from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import { parseConfig } from '../../src/infra/config.ts';

const TEST_DSN = 'https://publickey@sentry.example.invalid/42';
const LOOPBACK_DSN = 'http://publickey@127.0.0.1:9000/7';

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

function createStubApiDeps(runtimeRoot: string, envOverrides: Record<string, string | undefined> = {}) {
  const config = parseConfig(baseDevEnv(envOverrides));
  const db = {} as unknown as Database;
  const storage = {} as unknown as StoragePort;
  const queues = {} as unknown as ApiQueuesPort;
  const eventBus = {
    publish: async () => {},
    subscribe: () => () => {},
    checkHealth: async () => true,
  } as unknown as ApiEventBusPort;

  return createApiApp({
    config,
    db,
    storage,
    queues,
    eventBus,
    runtimeRoot,
    disableWelcomeBootstrap: true,
  });
}

describe('@openmotion/observability config & HTML runtime injection', () => {
  it('validates Sentry DSNs strictly and fails closed on invalid inputs', () => {
    assert.equal(parseSentryDsn(TEST_DSN), TEST_DSN);
    assert.equal(parseSentryDsn(LOOPBACK_DSN), LOOPBACK_DSN);
    assert.equal(parseSentryDsn(''), null);
    assert.equal(parseSentryDsn(undefined), null);
    assert.equal(parseSentryDsn('http://publickey@sentry.example.invalid/42'), null);
    assert.equal(parseSentryDsn('https://sentry.example.invalid/42'), null);
    assert.equal(parseSentryDsn('https://publickey@sentry.example.invalid/not-a-number'), null);
    assert.equal(parseSentryDsn('https://publickey@sentry.example.invalid/42?extra=1'), null);
  });

  it('builds normalized config and safely escapes inline HTML injection payloads', () => {
    const disabled = buildBrowserObservabilityConfig({ dsn: '' });
    assert.equal(disabled, null);
    assert.equal(serializeRuntimeConfigScript(null), '');

    const config = buildBrowserObservabilityConfig({
      dsn: TEST_DSN,
      environment: 'staging</script><img src=x>',
      release: "openmotion@1.2.3-$'-$$-$&",
      tracesSampleRate: 1.5,
      previewOrigin: 'https://preview.openmotion.example.com/extra/path',
      appVersion: '1.2.3',
    });
    assert.ok(config);
    assert.equal(config.tracesSampleRate, 1);
    assert.equal(config.previewOrigin, 'https://preview.openmotion.example.com');

    const html = `<!doctype html><html><head>${RUNTIME_CONFIG_PLACEHOLDER}</head><body><main>ok</main></body></html>`;
    const rendered = injectRuntimeConfigIntoHtml(html, config);
    assert.ok(!rendered.includes(RUNTIME_CONFIG_PLACEHOLDER));
    assert.ok(!rendered.includes('staging</script>'));
    assert.ok(rendered.includes('\\u003c/script\\u003e'));
    assert.ok(rendered.includes(`"release":"openmotion@1.2.3-$'-$$-$\\u0026"`));
    assert.equal(rendered.match(/<main>ok<\/main>/g)?.length, 1);
    assert.ok(rendered.includes(`window.${RUNTIME_CONFIG_GLOBAL_KEY}=Object.freeze(`));

    const strippedHtml = injectRuntimeConfigIntoHtml(html, null);
    assert.equal(strippedHtml, '<!doctype html><html><head></head><body><main>ok</main></body></html>');

    const roundTripped = readBrowserObservabilityConfig({
      [RUNTIME_CONFIG_GLOBAL_KEY]: config,
    });
    assert.deepEqual(roundTripped, config);
  });
});

describe('@openmotion/observability sanitization & noise filtering', () => {
  it('redacts sensitive query params, headers, cookies, tokens, and emails', () => {
    const previewUrl =
      'https://preview.openmotion.example.com/api/projects/p1/preview?preview_token=secret123&mode=live';
    const cleanedPreview = sanitizeUrl(previewUrl);
    assert.ok(!cleanedPreview.includes('secret123'));
    assert.ok(cleanedPreview.includes('mode=live'));

    const s3Url =
      'https://s3.example.com/bucket/blob?X-Amz-Signature=deadbeef&X-Amz-Credential=cred123&v=1';
    const cleanedS3 = sanitizeUrl(s3Url);
    assert.ok(!cleanedS3.includes('deadbeef'));
    assert.ok(!cleanedS3.includes('cred123'));
    assert.ok(cleanedS3.includes('v=1'));

    const syntheticPat = ['om', 'pat', 'synthetic12345'].join('_');
    const syntheticSentryToken = ['sntrys', 'synthetic12345'].join('_');
    const redactedText = sanitizeText(
      `Authorization: Bearer abc.def.ghi pat=${syntheticPat} sentry=${syntheticSentryToken} email=dev@example.com`,
    );
    assert.ok(!redactedText.includes('abc.def.ghi'));
    assert.ok(!redactedText.includes(syntheticPat));
    assert.ok(!redactedText.includes(syntheticSentryToken));
    assert.ok(!redactedText.includes('dev@example.com'));

    const headers = sanitizeHeaders({
      Authorization: 'Bearer secret-token',
      Cookie: 'om_session=secret',
      'X-Custom': 'safe-value',
    });
    assert.equal(headers?.Authorization, '[redacted]');
    assert.equal(headers?.Cookie, '[redacted]');
    assert.equal(headers?.['X-Custom'], 'safe-value');

    const event = sanitizeSentryEvent(
      {
        message: `Failed loading ${previewUrl}`,
        request: {
          url: `https://motion.example.com/auth/callback?code=oauth-code-1&state=oauth-state-2`,
          headers: { Cookie: 'om_session=abc', Accept: 'application/json' },
          cookies: { om_session: 'abc' },
          data: { prompt: 'private prompt content' },
        },
        breadcrumbs: [
          { category: 'fetch', data: { url: 'https://sentry.example.invalid/api/42/envelope/' } },
          { category: 'fetch', data: { url: s3Url } },
        ],
      },
      { dsnOrigin: 'https://sentry.example.invalid' },
    );
    assert.ok(!event.message?.includes('secret123'));
    assert.ok(!event.request?.url?.includes('oauth-code-1'));
    assert.ok(!event.request?.url?.includes('oauth-state-2'));
    assert.equal(event.request?.cookies, undefined);
    assert.equal(event.request?.data, undefined);
    assert.equal(event.breadcrumbs?.length, 1);
    assert.ok(!String(event.breadcrumbs?.[0]?.data?.url).includes('deadbeef'));

    assert.equal(
      sanitizeSentryBreadcrumb(
        { category: 'fetch', data: { url: 'https://sentry.example.invalid/api/42/envelope/' } },
        { dsnOrigin: 'https://sentry.example.invalid' },
      ),
      null,
    );
  });

  it('drops ResizeObserver, AbortError, composition asset errors, extension stacks, and preview-origin errors', () => {
    const previewOrigin = 'https://preview.openmotion.example.com';

    assert.equal(
      shouldDropBrowserEvent({ message: 'ResizeObserver loop completed with undelivered notifications.' }),
      true,
    );
    assert.equal(
      shouldDropBrowserEvent(
        { exception: { values: [{ type: 'AbortError', value: 'The user aborted a request.' }] } },
      ),
      true,
    );
    assert.equal(
      shouldDropBrowserEvent({
        exception: { values: [{ type: 'MediaError', value: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }] },
      }),
      true,
    );
    assert.equal(
      shouldDropBrowserEvent({
        exception: {
          values: [
            {
              type: 'Error',
              value: 'extension boom',
              stacktrace: {
                frames: [{ filename: 'chrome-extension://abcdef/content.js' }],
              },
            },
          ],
        },
      }),
      true,
    );
    assert.equal(
      shouldDropBrowserEvent(
        {
          exception: {
            values: [
              {
                type: 'TypeError',
                value: 'user script failed',
                stacktrace: {
                  frames: [
                    {
                      abs_path:
                        'https://preview.openmotion.example.com/api/projects/p1/preview/index.js',
                    },
                  ],
                },
              },
            ],
          },
        },
        undefined,
        { previewOrigin },
      ),
      true,
    );
    assert.equal(
      shouldDropBrowserEvent(
        {
          exception: {
            values: [
              {
                type: 'TypeError',
                value: 'timeline crash',
                stacktrace: {
                  frames: [{ abs_path: 'https://motion.example.com/editor-assets/index-abc.js' }],
                },
              },
            ],
          },
        },
        undefined,
        { previewOrigin },
      ),
      false,
    );
  });
});

describe('@openmotion/observability Vite sourcemap & zero-dependency Debug ID plugin', () => {
  it('resolves sourcemap modes and injects deterministic Debug IDs without external CLI deps', async (t) => {
    assert.equal(resolveStudioSourcemapOption({}), true);
    assert.equal(resolveObservabilityBuildConfig({}).injectDebugIds, false);
    assert.equal(createSentryVitePlugins({}).length, 0);

    assert.equal(resolveStudioSourcemapOption({ STUDIO_SOURCEMAP: 'false' }), false);
    assert.equal(resolveObservabilityBuildConfig({ STUDIO_SOURCEMAP: 'false' }).injectDebugIds, false);

    assert.equal(resolveStudioSourcemapOption({ STUDIO_SOURCEMAP: 'hidden' }), 'hidden');
    assert.equal(resolveObservabilityBuildConfig({ STUDIO_SOURCEMAP: 'hidden' }).injectDebugIds, true);
    assert.equal(
      resolveObservabilityBuildConfig({ STUDIO_SOURCEMAP: 'hidden', SENTRY_DEBUG_IDS: '' }).injectDebugIds,
      true,
    );

    assert.equal(resolveStudioSourcemapOption({ STUDIO_SOURCEMAP: 'false', SENTRY_DEBUG_IDS: 'true' }), 'hidden');
    assert.equal(
      resolveObservabilityBuildConfig({ STUDIO_SOURCEMAP: 'hidden', SENTRY_DEBUG_IDS: 'false' }).injectDebugIds,
      false,
    );

    const id1 = deriveDeterministicDebugId('editor-assets/app.js\0console.log(1);');
    const id2 = deriveDeterministicDebugId('editor-assets/app.js\0console.log(1);');
    assert.equal(id1, id2);
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const outDir = await mkdtemp(path.join(tmpdir(), 'om-obs-vite-'));
    t.after(() => rm(outDir, { recursive: true, force: true }));
    await mkdir(path.join(outDir, 'editor-assets'), { recursive: true });
    const jsPath = path.join(outDir, 'editor-assets/index-abc.js');
    const mapPath = `${jsPath}.map`;
    await writeFile(jsPath, 'console.log("studio");', 'utf8');
    await writeFile(
      mapPath,
      JSON.stringify({ version: 3, sources: ['src/main.tsx'], mappings: '' }),
      'utf8',
    );

    const plugins = createSentryVitePlugins({ STUDIO_SOURCEMAP: 'hidden' });
    assert.equal(plugins.length, 1);
    const plugin = plugins[0] as unknown as {
      enforce?: string;
      writeBundle: (
        options: { dir?: string },
        bundle: Record<string, Record<string, unknown>>,
      ) => Promise<void>;
    };
    assert.equal(plugin.enforce, 'post');
    const bundle: Record<string, Record<string, unknown>> = {
      'editor-assets/index-abc.js': {
        type: 'chunk',
        fileName: 'editor-assets/index-abc.js',
        code: 'console.log("studio");',
      },
      'editor-assets/index-abc.js.map': {
        type: 'asset',
        fileName: 'editor-assets/index-abc.js.map',
        source: JSON.stringify({ version: 3, sources: ['src/main.tsx'], mappings: '' }),
      },
    };
    await plugin.writeBundle({ dir: outDir }, bundle);

    const updatedCode = await readFile(jsPath, 'utf8');
    const updatedMap = JSON.parse(await readFile(mapPath, 'utf8')) as {
      debugId?: string;
    };
    assert.ok(updatedMap.debugId);
    assert.match(updatedMap.debugId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(updatedCode.includes(`//# debugId=${updatedMap.debugId}`));
    assert.ok(updatedCode.includes('_sentryDebugIds'));
    assert.ok(!updatedCode.includes('sourceMappingURL='));
  });
});

describe('Cloud infra config & API runtime injection + production sourcemap guard', () => {
  it('validates SENTRY_WEB_* env vars in parseConfig', () => {
    const defaultCfg = parseConfig(baseDevEnv());
    assert.equal(defaultCfg.SENTRY_WEB_DSN, undefined);
    assert.equal(defaultCfg.SENTRY_TRACES_SAMPLE_RATE, 0.1);

    const configured = parseConfig(
      baseDevEnv({
        SENTRY_WEB_DSN: TEST_DSN,
        SENTRY_ENVIRONMENT: 'staging',
        SENTRY_RELEASE: 'openmotion@2.0.0',
        SENTRY_TRACES_SAMPLE_RATE: '0.25',
      }),
    );
    assert.equal(configured.SENTRY_WEB_DSN, TEST_DSN);
    assert.equal(configured.SENTRY_ENVIRONMENT, 'staging');
    assert.equal(configured.SENTRY_RELEASE, 'openmotion@2.0.0');
    assert.equal(configured.SENTRY_TRACES_SAMPLE_RATE, 0.25);

    assert.throws(
      () => parseConfig(baseDevEnv({ SENTRY_WEB_DSN: 'https://example.com/not-a-dsn' })),
      /INVALID_CONFIG/,
    );
    assert.throws(
      () => parseConfig(baseDevEnv({ SENTRY_TRACES_SAMPLE_RATE: '1.5' })),
      /INVALID_CONFIG/,
    );
  });

  it('injects runtime Sentry config into SPA HTML only when configured and blocks .map in production', async (t) => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'om-obs-api-'));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));

    await mkdir(path.join(runtimeRoot, 'studio/build/editor-assets'), { recursive: true });
    await writeFile(
      path.join(runtimeRoot, 'studio/build/index.html'),
      `<!doctype html><html><head>${RUNTIME_CONFIG_PLACEHOLDER}</head><body><div id="root"></div></body></html>`,
      'utf8',
    );
    await writeFile(path.join(runtimeRoot, 'studio/build/editor-assets/index.js'), 'console.log("ok");', 'utf8');
    await writeFile(path.join(runtimeRoot, 'studio/build/editor-assets/index.js.map'), '{"version":3}', 'utf8');

    // 1. Disabled by default when SENTRY_WEB_DSN is unset
    const disabledApi = createStubApiDeps(runtimeRoot);
    const plainRes = await disabledApi.app.request('/');
    assert.equal(plainRes.status, 200);
    const plainHtml = await plainRes.text();
    assert.ok(!plainHtml.includes(RUNTIME_CONFIG_GLOBAL_KEY));
    assert.ok(!plainHtml.includes(RUNTIME_CONFIG_PLACEHOLDER));

    // Dev mode allows .map for local debugging
    const devMapRes = await disabledApi.app.request('/editor-assets/index.js.map');
    assert.equal(devMapRes.status, 200);

    // 2. Enabled when SENTRY_WEB_DSN is configured
    const enabledApi = createStubApiDeps(runtimeRoot, {
      SENTRY_WEB_DSN: TEST_DSN,
      SENTRY_ENVIRONMENT: 'staging',
      SENTRY_RELEASE: 'openmotion@test-rel',
      SENTRY_TRACES_SAMPLE_RATE: '0.2',
      PREVIEW_PUBLIC_ORIGIN: 'https://preview.openmotion.example.com',
    });
    const injectedRes = await enabledApi.app.request('/projects/test-route');
    assert.equal(injectedRes.status, 200);
    const injectedHtml = await injectedRes.text();
    assert.ok(injectedHtml.includes(`window.${RUNTIME_CONFIG_GLOBAL_KEY}=Object.freeze(`));
    assert.ok(injectedHtml.includes(TEST_DSN));
    assert.ok(injectedHtml.includes('"environment":"staging"'));
    assert.ok(injectedHtml.includes('"release":"openmotion@test-rel"'));
    assert.ok(injectedHtml.includes('"previewOrigin":"https://preview.openmotion.example.com"'));

    const headRes = await enabledApi.app.request('/', { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-length'), String(Buffer.byteLength(injectedHtml, 'utf8')));
    assert.equal(await headRes.text(), '');

    // 2B. Same-origin PREVIEW_PUBLIC_ORIGIN must NOT inject previewOrigin (would suppress Studio errors)
    const sameOriginApi = createStubApiDeps(runtimeRoot, {
      APP_PUBLIC_ORIGIN: 'https://motion.example.com',
      PREVIEW_PUBLIC_ORIGIN: 'https://motion.example.com',
      SENTRY_WEB_DSN: TEST_DSN,
    });
    const sameOriginHtml = await (await sameOriginApi.app.request('/')).text();
    assert.ok(sameOriginHtml.includes(TEST_DSN));
    assert.ok(!sameOriginHtml.includes('"previewOrigin"'));

    // 3. Production blocks `.map` static responses as defense-in-depth
    const blockedStatic = await serveStaticAsset('/editor-assets/index.js.map', runtimeRoot, false, {
      allowSourcemaps: false,
    });
    assert.equal(blockedStatic, null);

    const allowedJs = await serveStaticAsset('/editor-assets/index.js', runtimeRoot, false, {
      allowSourcemaps: false,
    });
    assert.ok(allowedJs);
    assert.equal(allowedJs.status, 200);

    const prodApi = createStubApiDeps(runtimeRoot, {
      NODE_ENV: 'production',
      ALLOW_INSECURE_DEV_AUTH: 'true',
      SENTRY_WEB_DSN: TEST_DSN,
    });
    const prodMapRes = await prodApi.app.request('/editor-assets/index.js.map');
    assert.equal(prodMapRes.status, 404);
    const prodJsRes = await prodApi.app.request('/editor-assets/index.js');
    assert.equal(prodJsRes.status, 200);
  });
});
