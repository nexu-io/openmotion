import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  TRACKING_RUNTIME_CONFIG_ELEMENT_ID,
  TRACKING_RUNTIME_CONFIG_PLACEHOLDER,
  buildBrowserTracertConfig,
  injectTrackingRuntimeConfigIntoHtml,
  normalizeTracertEnvironment,
  parseTracertEndpoint,
  parseTracertSpmA,
  parseTrackingRuntimeConfigResponse,
  serializeTrackingRuntimeConfigTag,
} from '../../shared/tracking-runtime-config.ts';
import { createAppTracking } from '../../shared/tracking.ts';
import { createCloudTracking, sanitizeHookId } from '../../src/cloud-tracking.ts';
import { createApiApp, type ApiEventBusPort, type ApiQueuesPort } from '../../src/entrypoints/api.ts';
import type { StoragePort } from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import { parseConfig } from '../../src/infra/config.ts';

const VALID_TOKEN = 'phc_testToken1234567890';
const TEST_RUN_UUID = '33333333-3333-4333-8333-333333333333';
const BASE_ENV: NodeJS.ProcessEnv = {
  OPENMOTION_TRACKING_ENABLED: '1',
  OPENMOTION_POSTHOG_TOKEN: VALID_TOKEN,
  OPENMOTION_POSTHOG_HOST: 'https://us.i.posthog.com',
  OPENMOTION_TRACKING_ENV: 'test',
  OPENMOTION_TRACKING_TEST_RUN_ID: TEST_RUN_UUID,
};

test('createCloudTracking honors OPENMOTION_TELEMETRY=0 and DO_NOT_TRACK=1 opt-outs', () => {
  const telemetryOff = createCloudTracking('1.0.0', { ...BASE_ENV, OPENMOTION_TELEMETRY: '0' });
  assert.equal(telemetryOff.isEnabled(), false);
  assert.equal(telemetryOff.lockReason(), 'environment');
  assert.equal(telemetryOff.acceptBrowserBatch([]), 0);

  const dntOn = createCloudTracking('1.0.0', { ...BASE_ENV, DO_NOT_TRACK: '1' });
  assert.equal(dntOn.isEnabled(), false);
  assert.equal(dntOn.lockReason(), 'environment');
});

test('createCloudTracking suppresses telemetry in test contexts without OPENMOTION_TRACKING_TEST_RUN_ID', () => {
  const withoutRunId = createCloudTracking('1.0.0', {
    OPENMOTION_TRACKING_ENABLED: '1',
    OPENMOTION_POSTHOG_TOKEN: VALID_TOKEN,
    OPENMOTION_POSTHOG_HOST: 'https://us.i.posthog.com',
    NODE_TEST_CONTEXT: 'child-v8',
  });
  assert.equal(withoutRunId.isEnabled(), false);

  const withRunId = createCloudTracking('1.0.0', {
    ...BASE_ENV,
    NODE_TEST_CONTEXT: 'child-v8',
  });
  assert.equal(withRunId.isEnabled(), true);
});

test('createCloudTracking fails closed instead of throwing when OPENMOTION_POSTHOG_HOST is malformed', () => {
  for (const badHost of ['', 'not-a-url', 'http://example.com', 'https://us.i.posthog.com/subpath']) {
    const tracker = createCloudTracking('1.0.0', { ...BASE_ENV, OPENMOTION_POSTHOG_HOST: badHost });
    assert.equal(tracker.isEnabled(), false, `expected disabled handle for host=${JSON.stringify(badHost)}`);
    assert.equal(tracker.acceptBrowserBatch([]), 0);
  }
});

test('acceptBrowserBatch preserves event identity, deduplicates event_id, and rejects non-studio entrypoints', () => {
  const tracker = createCloudTracking('1.0.0', BASE_ENV);
  assert.equal(tracker.isEnabled(), true);

  const validStudioEvent = {
    event: 'surface_view',
    event_id: '11111111-1111-4111-8111-111111111111',
    occurred_at: new Date().toISOString(),
    entrypoint: 'studio',
    device_timezone: 'Asia/Shanghai',
    utc_offset_minutes: 480,
    properties: {
      page_name: 'studio',
      area: 'entitlement_modal',
      element: 'modal',
      hook_id: 'header_signin',
    },
  };
  const wrongEntrypointEvent = {
    ...validStudioEvent,
    event_id: '22222222-2222-4222-8222-222222222222',
    entrypoint: 'mcp',
  };

  // First submission queues the studio event and rejects the non-studio entrypoint.
  assert.equal(tracker.acceptBrowserBatch({ events: [validStudioEvent, wrongEntrypointEvent] }), 1);
  // Retrying the exact same event_id is deduplicated by tracker.ingest().
  assert.equal(tracker.acceptBrowserBatch({ events: [validStudioEvent] }), 0);
});

test('createCloudTracking falls back to OPENMOTION_POSTHOG_KEY when OPENMOTION_POSTHOG_TOKEN is empty or whitespace', () => {
  const fromComposeEmpty = createCloudTracking('1.0.0', {
    ...BASE_ENV,
    OPENMOTION_POSTHOG_TOKEN: '',
    OPENMOTION_POSTHOG_KEY: VALID_TOKEN,
  });
  assert.equal(fromComposeEmpty.isEnabled(), true);

  const fromWhitespace = createCloudTracking('1.0.0', {
    ...BASE_ENV,
    OPENMOTION_POSTHOG_TOKEN: '   ',
    OPENMOTION_POSTHOG_KEY: VALID_TOKEN,
  });
  assert.equal(fromWhitespace.isEnabled(), true);
});

test('sanitizeHookId only accepts registered ENTITLEMENT_HOOK_IDS', () => {
  assert.equal(sanitizeHookId('header_signin'), 'header_signin');
  assert.equal(sanitizeHookId(' studio_res_gate '), 'studio_res_gate');
  assert.equal(sanitizeHookId('bf_hero'), 'bf_hero');
  assert.equal(sanitizeHookId('bf_hub'), 'bf_hub');
  assert.equal(sanitizeHookId('unregistered_custom_hook'), undefined);
  assert.equal(sanitizeHookId(''), undefined);
  assert.equal(sanitizeHookId(null), undefined);
});

test('acceptBrowserBatch buffers bursts above the 64-event desktop default without dropping events', () => {
  const tracker = createCloudTracking('1.0.0', BASE_ENV);
  assert.equal(tracker.isEnabled(), true);

  let acceptedTotal = 0;
  for (let batchIdx = 0; batchIdx < 4; batchIdx++) {
    const events = Array.from({ length: 25 }, (_, i) => ({
      event: 'surface_view',
      event_id: crypto.randomUUID(),
      occurred_at: new Date().toISOString(),
      entrypoint: 'studio',
      device_timezone: 'Asia/Shanghai',
      utc_offset_minutes: 480,
      properties: {
        page_name: 'model_hub',
        area: 'hub_videos',
        element: 'card',
        hub_id: 'seedance-2-5',
        template_id: `sd-${batchIdx * 25 + i + 1}`,
        position: i,
        signed_in: true,
        filter_value: 'all',
      },
    }));
    acceptedTotal += tracker.acceptBrowserBatch({ events });
  }
  assert.equal(acceptedTotal, 100);
});

test('Tracert runtime config helpers validate spmA, optional endpoint, environment mapping, and CSP-safe HTML injection', () => {
  assert.equal(parseTracertSpmA('42'), 42);
  assert.equal(parseTracertSpmA(7), 7);
  assert.equal(parseTracertSpmA('openmotion-web'), 'openmotion-web');
  assert.equal(parseTracertSpmA(''), null);
  assert.equal(parseTracertSpmA(0), null);
  assert.equal(parseTracertSpmA(-5), null);
  assert.equal(parseTracertSpmA('x'.repeat(257)), null);

  assert.equal(parseTracertEndpoint(undefined), undefined);
  assert.equal(parseTracertEndpoint('   '), undefined);
  assert.equal(parseTracertEndpoint('/t/events'), '/t/events');
  assert.equal(parseTracertEndpoint('https://collector.example.com/t/events'), 'https://collector.example.com/t/events');
  assert.equal(parseTracertEndpoint('http://127.0.0.1:4173/t/events'), 'http://127.0.0.1:4173/t/events');
  assert.equal(parseTracertEndpoint('http://collector.example.com/t/events'), null);
  assert.equal(parseTracertEndpoint('//evil.example.com/t/events'), null);
  assert.equal(parseTracertEndpoint('https://collector.example.com/t/events?debug=1'), null);
  assert.equal(parseTracertEndpoint('https://user:pass@collector.example.com/t/events'), null);

  assert.equal(normalizeTracertEnvironment('production'), 'prod');
  assert.equal(normalizeTracertEnvironment('prod'), 'prod');
  assert.equal(normalizeTracertEnvironment('development'), 'test');
  assert.equal(normalizeTracertEnvironment('test'), 'test');
  assert.equal(normalizeTracertEnvironment('staging'), 'test');

  const tracert = buildBrowserTracertConfig({
    spmA: 'openmotion</script><img src=x>',
    environment: 'development',
    appVersion: '0.1.0',
  });
  assert.ok(tracert);
  assert.equal(tracert.environment, 'test');
  assert.equal(tracert.endpoint, undefined);

  const disabledTag = serializeTrackingRuntimeConfigTag({
    enabled: false,
    posthogEnabled: false,
    locked: true,
    reason: 'cloud',
    tracert: null,
  });
  assert.equal(disabledTag, '');

  const html = `<!doctype html><html><head>${TRACKING_RUNTIME_CONFIG_PLACEHOLDER}</head><body></body></html>`;
  const rendered = injectTrackingRuntimeConfigIntoHtml(html, {
    enabled: true,
    posthogEnabled: true,
    locked: true,
    reason: 'cloud',
    tracert,
  });
  assert.ok(rendered.includes(`<script type="application/json" id="${TRACKING_RUNTIME_CONFIG_ELEMENT_ID}">`));
  assert.ok(!rendered.includes('</script><img'));
  assert.ok(rendered.includes('\\u003c/script\\u003e'));
  assert.ok(!rendered.includes(TRACKING_RUNTIME_CONFIG_PLACEHOLDER));

  // Backwards-compatible parsing of legacy `{ enabled: true }` response.
  assert.deepEqual(parseTrackingRuntimeConfigResponse({ enabled: true }), {
    enabled: true,
    posthogEnabled: true,
    locked: true,
    reason: null,
    tracert: null,
  });
});

test('createCloudTracking supports self-hosted default-off, Tracert-only, and Scheme A dual-write modes', () => {
  // Self-hosted default (neither PostHog nor Tracert configured) -> fully disabled.
  const selfHosted = createCloudTracking('1.0.0', {});
  assert.equal(selfHosted.isEnabled(), false);
  assert.equal(selfHosted.isPosthogEnabled(), false);
  assert.deepEqual(selfHosted.browserConfig(), {
    enabled: false,
    posthogEnabled: false,
    locked: true,
    reason: 'cloud',
    tracert: null,
  });

  // Dual-write (PostHog + Tracert with default SDK endpoint omitted; `development` maps to Tracert `test`).
  const { OPENMOTION_TRACKING_TEST_RUN_ID: _omitRunId, ...nonTestBaseEnv } = BASE_ENV;
  const dual = createCloudTracking('1.2.3', {
    ...nonTestBaseEnv,
    OPENMOTION_TRACERT_SPM_A: '12',
    OPENMOTION_TRACKING_ENV: 'development',
  });
  assert.equal(dual.isEnabled(), true);
  assert.equal(dual.isPosthogEnabled(), true);
  assert.deepEqual(dual.browserConfig(), {
    enabled: true,
    posthogEnabled: true,
    locked: true,
    reason: 'cloud',
    tracert: {
      spmA: 12,
      environment: 'test',
      appVersion: '1.2.3',
    },
  });

  // Tracert-only mode (no PostHog token, only OPENMOTION_TRACERT_SPM_A).
  const tracertOnly = createCloudTracking('1.2.3', {
    OPENMOTION_TRACERT_SPM_A: 'openmotion-web',
    OPENMOTION_TRACERT_ENDPOINT: '/t/events',
    OPENMOTION_TRACKING_ENV: 'production',
    OPENMOTION_TRACKING_TEST_RUN_ID: TEST_RUN_UUID,
  });
  assert.equal(tracertOnly.isEnabled(), true);
  assert.equal(tracertOnly.isPosthogEnabled(), false);
  assert.equal(tracertOnly.acceptBrowserBatch({ events: [] }), 0);
  assert.deepEqual(tracertOnly.browserConfig(), {
    enabled: true,
    posthogEnabled: false,
    locked: true,
    reason: 'cloud',
    tracert: {
      spmA: 'openmotion-web',
      endpoint: '/t/events',
      environment: 'prod',
      appVersion: '1.2.3',
    },
  });

  // Global opt-out locks BOTH PostHog and Tracert.
  const optedOut = createCloudTracking('1.2.3', {
    ...BASE_ENV,
    OPENMOTION_TRACERT_SPM_A: '12',
    OPENMOTION_TELEMETRY: '0',
  });
  assert.equal(optedOut.isEnabled(), false);
  assert.equal(optedOut.browserConfig().tracert, null);
  assert.equal(optedOut.browserConfig().reason, 'environment');
});

test('parseConfig validates OPENMOTION_TRACERT_* env vars and API injects tracking config only when enabled', async (t) => {
  const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    WORKER_ROLE: 'api',
    AUTH_MODE: 'dev',
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_BUCKET: 'openmotion',
  };

  const defaultCfg = parseConfig(baseEnv);
  assert.equal(defaultCfg.OPENMOTION_TRACERT_SPM_A, undefined);
  assert.equal(defaultCfg.OPENMOTION_TRACERT_ENDPOINT, undefined);

  const validCfg = parseConfig({
    ...baseEnv,
    OPENMOTION_TRACERT_SPM_A: '15',
    OPENMOTION_TRACERT_ENDPOINT: '/t/events',
  });
  assert.equal(validCfg.OPENMOTION_TRACERT_SPM_A, '15');
  assert.equal(validCfg.OPENMOTION_TRACERT_ENDPOINT, '/t/events');

  assert.throws(
    () => parseConfig({ ...baseEnv, OPENMOTION_TRACERT_ENDPOINT: 'http://collector.example.com/t/events' }),
    /INVALID_CONFIG/,
  );

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'om-tracert-api-'));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await mkdir(path.join(runtimeRoot, 'studio/build'), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, 'studio/build/index.html'),
    `<!doctype html><html><head>${TRACKING_RUNTIME_CONFIG_PLACEHOLDER}</head><body><div id="root"></div></body></html>`,
    'utf8',
  );

  const makeApi = (envOverrides: NodeJS.ProcessEnv, trackingEnv: NodeJS.ProcessEnv) =>
    createApiApp({
      config: parseConfig({ ...baseEnv, ...envOverrides }),
      db: {} as unknown as Database,
      storage: {} as unknown as StoragePort,
      queues: {} as unknown as ApiQueuesPort,
      eventBus: {
        publish: async () => {},
        subscribe: () => () => {},
        checkHealth: async () => true,
      } as unknown as ApiEventBusPort,
      runtimeRoot,
      trackingEnv,
      disableWelcomeBootstrap: true,
    });

  // Unconfigured self-hosted deployment -> strips placeholder, injects no tag, returns disabled config.
  const disabledApi = makeApi({}, {});
  const disabledHtml = await (await disabledApi.app.request('/')).text();
  assert.ok(!disabledHtml.includes(TRACKING_RUNTIME_CONFIG_PLACEHOLDER));
  assert.ok(!disabledHtml.includes(TRACKING_RUNTIME_CONFIG_ELEMENT_ID));
  const disabledJson = (await (await disabledApi.app.request('/motion-api/tracking')).json()) as {
    enabled: boolean;
    tracert: unknown;
  };
  assert.equal(disabledJson.enabled, false);
  assert.equal(disabledJson.tracert, null);

  // Configured dual-write deployment -> injects CSP-safe JSON tag into Studio HTML & returns matching JSON.
  const enabledApi = makeApi(
    { OPENMOTION_TRACERT_SPM_A: '88' },
    { ...BASE_ENV, OPENMOTION_TRACERT_SPM_A: '88' },
  );
  const enabledHtml = await (await enabledApi.app.request('/')).text();
  assert.ok(enabledHtml.includes(`<script type="application/json" id="${TRACKING_RUNTIME_CONFIG_ELEMENT_ID}">`));
  assert.ok(enabledHtml.includes('"spmA":88'));
  assert.ok(enabledHtml.includes('"posthogEnabled":true'));
  const enabledJson = (await (await enabledApi.app.request('/motion-api/tracking')).json()) as {
    enabled: boolean;
    posthogEnabled: boolean;
    tracert: { spmA: number; environment: string } | null;
  };
  assert.equal(enabledJson.enabled, true);
  assert.equal(enabledJson.posthogEnabled, true);
  assert.equal(enabledJson.tracert?.spmA, 88);
  assert.equal(enabledJson.tracert?.environment, 'test');
  await enabledApi.cloudTracking.shutdown({ timeoutMs: 200 });
});

test('createCloudTracking reports account_sign_in_result via TracertNode with canonical identity, fallback anonymousId, flush, and shutdown', async () => {
  const capturedRequests: Array<{ url: string; body: { schema_version: number; spmA: number | string; batch: Array<Record<string, unknown>> } }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(raw) as {
      schema_version: number;
      spmA: number | string;
      batch: Array<{ id: string } & Record<string, unknown>>;
    };
    capturedRequests.push({ url, body: parsed });
    return new Response(
      JSON.stringify({
        schema_version: 1,
        request_id: `req-${capturedRequests.length}`,
        results: parsed.batch.map((ev, index) => ({ index, id: ev.id, status: 'accepted' })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const tracker = createCloudTracking(
    '1.4.0',
    {
      OPENMOTION_TRACERT_SPM_A: '3',
      OPENMOTION_TRACKING_ENV: 'test',
      OPENMOTION_TRACKING_TEST_RUN_ID: TEST_RUN_UUID,
    },
    { tracertFetch: mockFetch },
  );
  assert.equal(tracker.isEnabled(), true);
  assert.equal(tracker.isPosthogEnabled(), false);
  assert.equal(tracker.isTracertEnabled(), true);

  const entryId = '44444444-4444-4444-8444-444444444444';
  tracker.trackWebSignInResult({
    outcome: 'success',
    hookId: 'header_signin',
    entryId,
    userId: 'amr_user_42',
    durationMs: 320,
  });
  tracker.trackWebSignInResult({
    outcome: 'failure',
    hookId: 'header_signin',
    entryId,
    durationMs: 120,
  });
  tracker.trackWebSignInResult({
    outcome: 'cancelled',
    durationMs: 50,
  });

  const flushResult = await tracker.flush({ timeoutMs: 2000 });
  assert.ok(flushResult);
  assert.equal(flushResult.status, 'confirmed');
  assert.equal(flushResult.accepted, 3);

  const allEvents = capturedRequests.flatMap((req) => req.body.batch);
  assert.equal(allEvents.length, 3);
  assert.equal(capturedRequests[0]?.body.schema_version, 1);
  assert.equal(capturedRequests[0]?.body.spmA, 3);

  const [successEv, failureEv, cancelledEv] = allEvents as Array<{
    id: string;
    event: string;
    identity: { user_id: string | null; anonymous_id: string | null };
    context: { environment: string; app_version: string };
    properties: Record<string, unknown>;
  }>;

  assert.match(successEv.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(successEv.event, 'account_sign_in_result');
  assert.equal(successEv.identity.user_id, 'amr_user_42');
  assert.equal(successEv.context.environment, 'test');
  assert.equal(successEv.context.app_version, '1.4.0');
  assert.equal(successEv.properties.product, 'openmotion');
  assert.equal(successEv.properties.entrypoint, 'api');
  assert.equal(successEv.properties.amr_user_id, 'amr_user_42');
  assert.equal(successEv.properties.outcome, 'success');

  assert.equal(failureEv.identity.user_id, null);
  assert.equal(failureEv.identity.anonymous_id, entryId);
  assert.equal(failureEv.properties.outcome, 'failure');

  assert.equal(cancelledEv.identity.user_id, null);
  assert.equal(cancelledEv.identity.anonymous_id, cancelledEv.properties.attempt_id);
  assert.equal(cancelledEv.properties.outcome, 'cancelled');

  // After shutdown(), further events are rejected cleanly without throwing or issuing new requests.
  await tracker.shutdown({ timeoutMs: 1000 });
  const beforeCount = capturedRequests.length;
  tracker.trackWebSignInResult({ outcome: 'success', userId: 'amr_after_shutdown', durationMs: 10 });
  await tracker.flush({ timeoutMs: 200 });
  assert.equal(capturedRequests.length, beforeCount);
});

test('createCloudTracking handles relative OPENMOTION_TRACERT_ENDPOINT safely for Node TracertNode', async () => {
  const seenUrls: string[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seenUrls.push(url);
    const parsed = JSON.parse(String(init?.body ?? '{}')) as { batch: Array<{ id: string }> };
    return new Response(
      JSON.stringify({
        schema_version: 1,
        request_id: `req-${seenUrls.length}`,
        results: parsed.batch.map((ev, index) => ({ index, id: ev.id, status: 'accepted' })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  // Without APP_PUBLIC_ORIGIN, browser still gets `/t/events`, while Node fails closed instead of hitting default host.
  const withoutOrigin = createCloudTracking(
    '1.4.0',
    {
      OPENMOTION_TRACERT_SPM_A: '3',
      OPENMOTION_TRACERT_ENDPOINT: '/t/events',
      OPENMOTION_TRACKING_ENV: 'test',
      OPENMOTION_TRACKING_TEST_RUN_ID: TEST_RUN_UUID,
    },
    { tracertFetch: mockFetch },
  );
  assert.equal(withoutOrigin.browserConfig().tracert?.endpoint, '/t/events');
  withoutOrigin.trackWebSignInResult({ outcome: 'success', userId: 'amr_1', durationMs: 10 });
  assert.equal(await withoutOrigin.flush({ timeoutMs: 200 }), null);
  assert.equal(seenUrls.length, 0);

  // With APP_PUBLIC_ORIGIN, Node resolves the relative path against that origin.
  const withOrigin = createCloudTracking(
    '1.4.0',
    {
      APP_PUBLIC_ORIGIN: 'https://motion.open-design.ai',
      OPENMOTION_TRACERT_SPM_A: '3',
      OPENMOTION_TRACERT_ENDPOINT: '/t/events',
      OPENMOTION_TRACKING_ENV: 'test',
      OPENMOTION_TRACKING_TEST_RUN_ID: TEST_RUN_UUID,
    },
    { tracertFetch: mockFetch },
  );
  withOrigin.trackWebSignInResult({ outcome: 'success', userId: 'amr_2', durationMs: 10 });
  const flushed = await withOrigin.flush({ timeoutMs: 2000 });
  assert.equal(flushed?.status, 'confirmed');
  assert.deepEqual(seenUrls, ['https://motion.open-design.ai/t/events']);
  await withOrigin.shutdown({ timeoutMs: 200 });
});

test('createCloudTracking shutdown drains all queued PostHog batches (> 16 events) before closing trackers', async () => {
  const deliveredBatchSizes: number[] = [];
  const deliveredEventIds: string[] = [];
  const mockPosthogFetch: typeof fetch = async (_input, init) => {
    const parsed = JSON.parse(String(init?.body ?? '{}')) as {
      batch?: Array<{ uuid?: string }>;
    };
    const batch = parsed.batch ?? [];
    deliveredBatchSizes.push(batch.length);
    for (const item of batch) {
      if (item.uuid) deliveredEventIds.push(item.uuid);
    }
    return new Response(JSON.stringify({ status: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const tracker = createCloudTracking('1.4.0', BASE_ENV, { posthogFetch: mockPosthogFetch });
  const browserEvents = Array.from({ length: 25 }, (_, i) => ({
    event: 'surface_view',
    event_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(),
    entrypoint: 'studio',
    device_timezone: 'Asia/Shanghai',
    utc_offset_minutes: 480,
    properties: {
      page_name: 'model_hub',
      area: 'hub_videos',
      element: 'card',
      hub_id: 'seedance-2-5',
      template_id: `drain-${i + 1}`,
      position: i,
      signed_in: true,
      filter_value: 'all',
    },
  }));

  assert.equal(tracker.acceptBrowserBatch({ events: browserEvents }), 25);
  tracker.trackWebSignInResult({ outcome: 'success', userId: 'amr_drain_user', durationMs: 40 });

  await tracker.shutdown({ timeoutMs: 3000 });

  // 25 browser events exceed the 16-event PostHog transport chunk (16 + 9), plus 1 server event.
  assert.equal(deliveredEventIds.length, 26);
  assert.ok(deliveredBatchSizes.includes(16));
  assert.ok(deliveredBatchSizes.includes(9));
  for (const ev of browserEvents) {
    assert.ok(deliveredEventIds.includes(ev.event_id), `missing browser event ${ev.event_id}`);
  }
});

test('shared/tracking createAppTracking stays disabled without explicit PostHog env vars (no hardcoded token)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'om-shared-tracking-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const prevHost = process.env.OPENMOTION_POSTHOG_HOST;
  const prevKey = process.env.OPENMOTION_POSTHOG_KEY;
  const prevToken = process.env.OPENMOTION_POSTHOG_TOKEN;
  const prevRunId = process.env.OPENMOTION_TRACKING_TEST_RUN_ID;
  const prevEnv = process.env.OPENMOTION_TRACKING_ENV;
  delete process.env.OPENMOTION_POSTHOG_HOST;
  delete process.env.OPENMOTION_POSTHOG_KEY;
  delete process.env.OPENMOTION_POSTHOG_TOKEN;
  process.env.OPENMOTION_TRACKING_ENV = 'test';
  process.env.OPENMOTION_TRACKING_TEST_RUN_ID = TEST_RUN_UUID;
  try {
    const tracker = await createAppTracking(dir, 'mcp');
    assert.equal(tracker.enabled(), false);
    tracker.close();
  } finally {
    if (prevHost === undefined) delete process.env.OPENMOTION_POSTHOG_HOST; else process.env.OPENMOTION_POSTHOG_HOST = prevHost;
    if (prevKey === undefined) delete process.env.OPENMOTION_POSTHOG_KEY; else process.env.OPENMOTION_POSTHOG_KEY = prevKey;
    if (prevToken === undefined) delete process.env.OPENMOTION_POSTHOG_TOKEN; else process.env.OPENMOTION_POSTHOG_TOKEN = prevToken;
    if (prevRunId === undefined) delete process.env.OPENMOTION_TRACKING_TEST_RUN_ID; else process.env.OPENMOTION_TRACKING_TEST_RUN_ID = prevRunId;
    if (prevEnv === undefined) delete process.env.OPENMOTION_TRACKING_ENV; else process.env.OPENMOTION_TRACKING_ENV = prevEnv;
  }
});
