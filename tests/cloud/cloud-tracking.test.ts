import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';
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
import {
  CLOUD_ALLOWED_STUDIO_EVENTS,
  CLOUD_BLOCKED_SURFACE_AREAS,
  createCloudTracking,
  isCloudBrowserEventAllowed,
  sanitizeHookId,
} from '../../src/cloud-tracking.ts';
import { createApiApp, type ApiEventBusPort, type ApiQueuesPort } from '../../src/entrypoints/api.ts';
import { McpToolDispatcher } from '../../src/mcp/tool-dispatcher.ts';
import type { AuthContext } from '../../src/contracts/auth.ts';
import type { AuthStore } from '../../src/auth/store.ts';
import { createBrowserSession } from '../../src/auth/session.ts';
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

function makePacket(event: string, properties: Record<string, unknown> = {}) {
  return {
    event,
    event_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(),
    entrypoint: 'studio',
    device_timezone: 'Asia/Shanghai',
    utc_offset_minutes: 480,
    properties,
  };
}

function createMockSinks() {
  const posthogEvents: Array<{ event: string; uuid: string; timestamp: string; properties: Record<string, unknown> }> = [];
  const tracertEvents: Array<{
    id: string;
    event: string;
    timestamp?: string;
    identity: { user_id: string | null; anonymous_id: string | null };
    context: { environment: string; app_version: string };
    properties: Record<string, unknown>;
  }> = [];

  const posthogFetch: typeof fetch = async (_input, init) => {
    const parsed = JSON.parse(String(init?.body ?? '{}')) as {
      batch?: Array<{ event: string; uuid: string; timestamp: string; properties: Record<string, unknown> }>;
    };
    for (const item of parsed.batch ?? []) {
      posthogEvents.push(item);
    }
    return new Response(JSON.stringify({ status: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  let tracertSeq = 0;
  const tracertFetch: typeof fetch = async (_input, init) => {
    tracertSeq += 1;
    const parsed = JSON.parse(String(init?.body ?? '{}')) as {
      batch: Array<{
        id: string;
        event: string;
        timestamp?: string;
        identity: { user_id: string | null; anonymous_id: string | null };
        context: { environment: string; app_version: string };
        properties: Record<string, unknown>;
      }>;
    };
    for (const item of parsed.batch ?? []) {
      tracertEvents.push(item);
    }
    return new Response(
      JSON.stringify({
        schema_version: 1,
        request_id: `req-${tracertSeq}`,
        results: (parsed.batch ?? []).map((ev, index) => ({ index, id: ev.id, status: 'accepted' })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  return { posthogEvents, tracertEvents, posthogFetch, tracertFetch };
}

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

  assert.equal(tracker.acceptBrowserBatch({ events: [validStudioEvent, wrongEntrypointEvent] }), 1);
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
    allowlistEnabled: false,
    locked: true,
    reason: 'cloud',
    tracert: null,
  });
  assert.equal(disabledTag, '');

  const html = `<!doctype html><html><head>${TRACKING_RUNTIME_CONFIG_PLACEHOLDER}</head><body></body></html>`;
  const rendered = injectTrackingRuntimeConfigIntoHtml(html, {
    enabled: true,
    posthogEnabled: true,
    allowlistEnabled: true,
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
    allowlistEnabled: false,
    locked: true,
    reason: null,
    tracert: null,
  });
});

test('createCloudTracking supports self-hosted default-off, Tracert-only, Scheme A dual-write, and OPENMOTION_CLOUD_TRACKING_FULL', () => {
  const selfHosted = createCloudTracking('1.0.0', {});
  assert.equal(selfHosted.isEnabled(), false);
  assert.equal(selfHosted.isPosthogEnabled(), false);
  assert.deepEqual(selfHosted.browserConfig(), {
    enabled: false,
    posthogEnabled: false,
    allowlistEnabled: false,
    locked: true,
    reason: 'cloud',
    tracert: null,
  });

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
    allowlistEnabled: true,
    locked: true,
    reason: 'cloud',
    tracert: {
      spmA: 12,
      environment: 'test',
      appVersion: '1.2.3',
    },
  });

  const dualFull = createCloudTracking('1.2.3', {
    ...nonTestBaseEnv,
    OPENMOTION_TRACERT_SPM_A: '12',
    OPENMOTION_TRACKING_ENV: 'development',
    OPENMOTION_CLOUD_TRACKING_FULL: '1',
  });
  assert.equal(dualFull.browserConfig().allowlistEnabled, false);

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
    allowlistEnabled: true,
    locked: true,
    reason: 'cloud',
    tracert: {
      spmA: 'openmotion-web',
      endpoint: '/t/events',
      environment: 'prod',
      appVersion: '1.2.3',
    },
  });

  const optedOut = createCloudTracking('1.2.3', {
    ...BASE_ENV,
    OPENMOTION_TRACERT_SPM_A: '12',
    OPENMOTION_TELEMETRY: '0',
  });
  assert.equal(optedOut.isEnabled(), false);
  assert.equal(optedOut.browserConfig().tracert, null);
  assert.equal(optedOut.browserConfig().allowlistEnabled, false);
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

  const enabledApi = makeApi(
    { OPENMOTION_TRACERT_SPM_A: '88' },
    { ...BASE_ENV, OPENMOTION_TRACERT_SPM_A: '88' },
  );
  const enabledHtml = await (await enabledApi.app.request('/')).text();
  assert.ok(enabledHtml.includes(`<script type="application/json" id="${TRACKING_RUNTIME_CONFIG_ELEMENT_ID}">`));
  assert.ok(enabledHtml.includes('"spmA":88'));
  assert.ok(enabledHtml.includes('"posthogEnabled":true'));
  assert.ok(enabledHtml.includes('"allowlistEnabled":true'));
  const enabledJson = (await (await enabledApi.app.request('/motion-api/tracking')).json()) as {
    enabled: boolean;
    posthogEnabled: boolean;
    allowlistEnabled: boolean;
    tracert: { spmA: number; environment: string } | null;
  };
  assert.equal(enabledJson.enabled, true);
  assert.equal(enabledJson.posthogEnabled, true);
  assert.equal(enabledJson.allowlistEnabled, true);
  assert.equal(enabledJson.tracert?.spmA, 88);
  assert.equal(enabledJson.tracert?.environment, 'test');
  await enabledApi.cloudTracking.shutdown({ timeoutMs: 200 });
});

test('POST /motion-api/tracking stays guest-accessible and maps distinct PostHog distinct_id, device_id, amr_user_id, and channel=cloud_web', async () => {
  const sinks = createMockSinks();
  const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    WORKER_ROLE: 'api',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://auth.example.com',
    OIDC_CLIENT_ID: 'openmotion-web',
    SESSION_SECRET: 's'.repeat(40),
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_BUCKET: 'openmotion',
  };

  const sessionMap = new Map<string, { id: string; userId: string; workspaceId: string; csrfTokenHash: string; expiresAt: Date }>();
  const mockAuthStore = {
    async createSession(input: { userId: string; workspaceId: string; tokenHash: string; csrfTokenHash: string; expiresAt: Date }) {
      const row = { id: crypto.randomUUID(), ...input };
      sessionMap.set(input.tokenHash, row);
      return row;
    },
    async findActiveSessionByTokenHash(tokenHash: string) {
      return sessionMap.get(tokenHash) ?? null;
    },
    async touchSession() {},
    async findMembership(workspaceId: string, userId: string) {
      return {
        role: 'owner' as const,
        user: {
          id: userId,
          oidcSub: 'sub-alice',
          appUserId: 'amr_user_alice_00000001',
          email: 'alice@example.com',
          displayName: 'Alice',
          avatarUrl: null,
        },
        workspace: {
          id: workspaceId,
          externalWorkspaceId: 'ext-ws-alice',
          name: 'Alice WS',
        },
      };
    },
  } as unknown as AuthStore;

  const aliceSession = await createBrowserSession(mockAuthStore, {
    userId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
  });

  const api = createApiApp({
    config: parseConfig(baseEnv),
    db: {} as unknown as Database,
    storage: {} as unknown as StoragePort,
    queues: {} as unknown as ApiQueuesPort,
    eventBus: {
      publish: async () => {},
      subscribe: () => () => {},
      checkHealth: async () => true,
    } as unknown as ApiEventBusPort,
    authStore: mockAuthStore,
    trackingEnv: BASE_ENV,
    trackingOptions: { posthogFetch: sinks.posthogFetch },
    disableWelcomeBootstrap: true,
  });

  const guestEv = makePacket('ui_click', { page_name: 'explore', area: 'header', element: 'sign_in' });
  const guestRes = await api.app.request('/motion-api/tracking', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ events: [guestEv], device_id: 'browser-guest-device-001' }),
  });
  assert.equal(guestRes.status, 202);

  // Invalid/expired cookie must STILL succeed (never 401) and fall back to browser device_id.
  const expiredCookieEv = makePacket('ui_click', { page_name: 'explore', area: 'header', element: 'open_pricing' });
  const expiredRes = await api.app.request('/motion-api/tracking', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      cookie: 'om_session=revoked_or_expired_session_token_value',
    },
    body: JSON.stringify({ events: [expiredCookieEv], device_id: 'browser-guest-device-002' }),
  });
  assert.equal(expiredRes.status, 202);

  // Signed-in session cookie resolves canonical amr_user_id for distinct_id while keeping browser device_id.
  const signedInEv = makePacket('ui_click', { page_name: 'studio', area: 'header', element: 'export' });
  const signedInRes = await api.app.request('/motion-api/tracking', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      cookie: `om_session=${encodeURIComponent(aliceSession.token)}`,
    },
    body: JSON.stringify({ events: [signedInEv], device_id: 'browser-alice-device-003' }),
  });
  assert.equal(signedInRes.status, 202);

  await api.cloudTracking.shutdown({ timeoutMs: 2000 });
  assert.equal(sinks.posthogEvents.length, 3);

  const byId = new Map(sinks.posthogEvents.map((ev) => [ev.uuid, ev.properties]));
  const guestProps = byId.get(guestEv.event_id)!;
  const expiredProps = byId.get(expiredCookieEv.event_id)!;
  const signedInProps = byId.get(signedInEv.event_id)!;

  assert.equal(guestProps.channel, 'cloud_web');
  assert.equal(guestProps.distinct_id, 'browser-guest-device-001');
  assert.equal(guestProps.device_id, 'browser-guest-device-001');
  assert.equal(guestProps.device_id_source, 'browser');
  assert.equal(guestProps.amr_user_id, undefined);

  assert.equal(expiredProps.distinct_id, 'browser-guest-device-002');
  assert.equal(expiredProps.device_id, 'browser-guest-device-002');

  assert.equal(signedInProps.channel, 'cloud_web');
  assert.equal(signedInProps.distinct_id, 'amr_user_alice_00000001');
  assert.equal(signedInProps.user_id, 'amr_user_alice_00000001');
  assert.equal(signedInProps.amr_user_id, 'amr_user_alice_00000001');
  assert.equal(signedInProps.device_id, 'browser-alice-device-003');
  assert.equal(signedInProps.device_id_source, 'browser');
  assert.equal(new Set([guestProps.distinct_id, expiredProps.distinct_id, signedInProps.distinct_id]).size, 3);
});

test('createCloudTracking dual-writes all OPEND-5807 P0-2 server & worker result events to PostHog and TracertNode with 1:1 event_id parity', async () => {
  const sinks = createMockSinks();
  const tracker = createCloudTracking(
    '1.5.0',
    {
      ...BASE_ENV,
      OPENMOTION_TRACERT_SPM_A: '3',
    },
    {
      posthogFetch: sinks.posthogFetch,
      tracertFetch: sinks.tracertFetch,
      serviceEntrypoint: 'api',
    },
  );

  const workId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const revision = 'a'.repeat(64);
  const mediaJobId = crypto.randomUUID();
  const exportJobId = crypto.randomUUID();
  const now = new Date();
  const deadline = new Date(now.getTime() + 1_800_000);
  const userId = 'amr_user_p02_0000000001';

  // 1. work_generation_stage (started -> generated -> edited -> exported, plus duplicate exported retry)
  tracker.trackWorkGenerationStage({ workId, projectId, stage: 'started', taskType: 'create', versionId, revision, userId });
  tracker.trackWorkGenerationStage({ workId, projectId, stage: 'generated', taskType: 'create', versionId, revision, userId });
  tracker.trackWorkGenerationStage({ workId, projectId, stage: 'edited', taskType: 'create', versionId, revision, userId });
  tracker.trackWorkGenerationStage({ workId, projectId, stage: 'exported', taskType: 'create', versionId, revision, exportRoute: 'studio', userId });
  // Duplicate exported stage for the same workId must deduplicate on both sinks.
  tracker.trackWorkGenerationStage({ workId, projectId, stage: 'exported', taskType: 'create', versionId, revision, exportRoute: 'studio', userId, entrypoint: 'worker' });

  // 2. media_generation_*
  tracker.trackMediaGenerationRequested({ modality: 'video', userId });
  tracker.trackMediaGenerationSubmitted({ modality: 'video', jobId: mediaJobId, userId });
  tracker.trackMediaGenerationResult({ modality: 'video', jobId: mediaJobId, jobState: 'completed', assetCount: 2, userId });

  // 3. export_result + task_accepted + task_terminal (task_type='export')
  tracker.trackTaskAccepted({ taskId: exportJobId, taskType: 'export', projectId, acceptedAt: now, deadlineAt: deadline, userId, entrypoint: 'mcp' });
  tracker.trackExportResult({ jobId: exportJobId, jobState: 'completed', durationMs: 4200, technicalCheck: 'passed', userId });
  tracker.trackTaskTerminal({ taskId: exportJobId, taskType: 'export', projectId, outcome: 'success', applied: 'true', terminalAt: new Date(now.getTime() + 4200), userId, entrypoint: 'worker' });

  // 4. mcp_tool_finished (via McpToolDispatcher)
  const config = parseConfig({
    NODE_ENV: 'development',
    WORKER_ROLE: 'api',
    AUTH_MODE: 'dev',
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_BUCKET: 'openmotion',
  });
  const dispatcher = new McpToolDispatcher(
    config,
    {
      catalog: {
        listTemplates: async () => ({ templates: [] }),
        getTemplate: async () => ({}),
        listSkills: async () => ({}),
        getSkill: async () => ({}),
      },
    },
    { cloudTracking: tracker },
  );
  const mcpAuth: AuthContext = {
    workspaceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    appUserId: userId,
    role: 'owner',
    scopes: ['mcp:tools', 'projects:read'],
    authMode: 'oidc',
    authMethod: 'oauth_bearer',
    entry: 'mcp',
  };
  const mcpOk = await dispatcher.dispatch('openmotion_list_templates', {}, { auth: mcpAuth, supportsMcpAppsUi: false });
  assert.equal(mcpOk.isError, undefined);
  // Studio bridge calls with skipMcpToolTracking=true must not emit mcp_tool_finished.
  await dispatcher.dispatch('openmotion_list_templates', {}, { auth: mcpAuth, supportsMcpAppsUi: false, skipMcpToolTracking: true });

  await tracker.flush({ timeoutMs: 3000 });
  await tracker.shutdown({ timeoutMs: 3000 });

  // 4 work_generation_stage (with exported deduplicated? Note mcp vs worker tracker are separate instances in-memory,
  // so verify identical deterministic event_id on both exported entries; PostHog $insert_id & Tracert uuid deduplicate server-side!)
  const expectedNames = [
    'work_generation_stage',
    'media_generation_requested',
    'media_generation_submitted',
    'media_generation_result',
    'task_accepted',
    'export_result',
    'task_terminal',
    'mcp_tool_finished',
  ];
  for (const name of expectedNames) {
    const phMatches = sinks.posthogEvents.filter((ev) => ev.event === name);
    const trMatches = sinks.tracertEvents.filter((ev) => ev.event === name);
    assert.ok(phMatches.length >= 1, `expected PostHog to receive ${name}`);
    assert.ok(trMatches.length >= 1, `expected TracertNode to receive ${name}`);
    for (const ph of phMatches) {
      assert.equal(ph.properties.channel, 'cloud_web');
      assert.equal(ph.properties.distinct_id, userId);
      assert.equal(ph.properties.amr_user_id, userId);
      const matchingTr = trMatches.find((tr) => tr.id === ph.uuid);
      assert.ok(matchingTr, `expected TracertNode event matching PostHog event_id ${ph.uuid} for ${name}`);
      assert.equal(matchingTr.identity.user_id, userId);
    }
  }

  // Deterministic event_id on exported stage matches even across mcp/worker entrypoints.
  const exportedPosthogIds = new Set(
    sinks.posthogEvents
      .filter((ev) => ev.event === 'work_generation_stage' && ev.properties.stage === 'exported')
      .map((ev) => ev.uuid),
  );
  assert.equal(exportedPosthogIds.size, 1);

  const mcpEvents = sinks.posthogEvents.filter((ev) => ev.event === 'mcp_tool_finished');
  assert.equal(mcpEvents.length, 1);
  assert.equal(mcpEvents[0]?.properties.tool_name, 'motion_list_templates');
  assert.equal(mcpEvents[0]?.properties.accepted, true);
  assert.equal(mcpEvents[0]?.properties.outcome, 'success');
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

// --- Cloud production allowlist & monetization attribution tests ---
describe('cloud tracking allowlist (shared PostHog & Tracert strict filtering)', () => {
  it('keeps full monetization pre-funnel and core business events', () => {
    const mustKeep = [
      makePacket('page_view', { page_name: 'explore' }),
      makePacket('studio_load_result', { outcome: 'success', duration_ms: 120 }),
      makePacket('provider_setup_opened', { entry_from: 'agent_media_image' }),
      makePacket('ui_click', {
        page_name: 'explore',
        area: 'header',
        element: 'open_pricing',
        hook_id: 'header_pricing',
      }),
      makePacket('surface_view', {
        page_name: 'studio',
        area: 'entitlement_modal',
        element: 'modal',
        hook_id: 'studio_free_gate',
      }),
      makePacket('surface_view', {
        page_name: 'creative_studio',
        area: 'entitlement_gate',
        element: 'banner',
        hook_id: 'studio_free_gate',
      }),
      makePacket('surface_view', {
        page_name: 'explore',
        area: 'campaign_banner',
        element: 'banner',
        hook_id: 'bf_banner',
      }),
      makePacket('entitlement_refresh_result', {
        outcome: 'success',
        hook_id: 'header_pricing',
        plan_after: 'plus',
      }),
      makePacket('studio_edit_result', { outcome: 'success' }),
      makePacket('studio_export_result', { outcome: 'success' }),
      makePacket('crash', { error_name: 'Error' }),
      makePacket('save_failure', { status_code: 500 }),
    ];

    for (const pkt of mustKeep) {
      assert.equal(
        isCloudBrowserEventAllowed(pkt, {}),
        true,
        `Expected core event ${pkt.event} (${JSON.stringify(pkt.properties)}) to be allowed`,
      );
    }
  });

  it('blocks high-frequency editor micro-ops, audio_fx, SDK shadow diagnostics, and card impressions by default', () => {
    const mustDrop = [
      makePacket('playback', { action: 'play' }),
      makePacket('keyboard_shortcut', { key: 'Space' }),
      makePacket('toolbar_action', { action: 'split' }),
      makePacket('audio_fx_param_committed', { effect: 'gain', param: 'gain', surface: 'knob' }),
      makePacket('sdk_resolver_shadow', { mismatchCount: 0 }),
      makePacket('commit_transaction', { mutation_count: 1 }),
      makePacket('studio_timeline_performance', { fps: 60 }),
      makePacket('preview_first_frame', { duration_ms: 300 }),
      makePacket('surface_view', {
        page_name: 'explore',
        area: 'template_card',
        element: 'card',
      }),
      makePacket('surface_view', {
        page_name: 'explore',
        area: 'template_series_card',
        element: 'card',
      }),
    ];

    for (const pkt of mustDrop) {
      assert.equal(
        isCloudBrowserEventAllowed(pkt, {}),
        false,
        `Expected noisy event ${pkt.event} (${JSON.stringify(pkt.properties)}) to be dropped`,
      );
    }
  });

  it('allows full pass-through when OPENMOTION_CLOUD_TRACKING_FULL=1 is set', () => {
    const noisy = makePacket('playback', { action: 'play' });
    const card = makePacket('surface_view', { page_name: 'explore', area: 'template_card', element: 'card' });
    assert.equal(isCloudBrowserEventAllowed(noisy, { OPENMOTION_CLOUD_TRACKING_FULL: '1' }), true);
    assert.equal(isCloudBrowserEventAllowed(card, { OPENMOTION_CLOUD_TRACKING_FULL: 'true' }), true);
  });

  it('filters acceptBrowserBatch through the allowlist while queuing valid monetization events', () => {
    const tracker = createCloudTracking('0.0.1-test', {
      OPENMOTION_TRACKING_ENABLED: '1',
      OPENMOTION_POSTHOG_TOKEN: 'phc_test_token_1234567890',
      OPENMOTION_POSTHOG_HOST: 'https://us.i.posthog.com',
      OPENMOTION_TRACKING_ENV: 'test',
      OPENMOTION_TRACKING_TEST_RUN_ID: crypto.randomUUID(),
    });
    assert.equal(tracker.isEnabled(), true);

    const accepted = tracker.acceptBrowserBatch({
      events: [
        makePacket('ui_click', {
          page_name: 'creative_studio',
          area: 'entitlement_gate',
          element: 'view_plans',
          hook_id: 'studio_free_gate',
          model_id: 'seedance-2.5',
          model_provider: 'opendesign',
          modality: 'video',
          gate_reason: 'plan_locked',
          user_plan: 'free',
        }),
        makePacket('surface_view', {
          page_name: 'studio',
          area: 'entitlement_modal',
          element: 'modal',
          hook_id: 'studio_free_gate',
          model_id: 'seedance-2.5',
          model_provider: 'opendesign',
          modality: 'video',
          gate_reason: 'plan_locked',
          user_plan: 'free',
        }),
        makePacket('entitlement_refresh_result', {
          outcome: 'success',
          hook_id: 'studio_free_gate',
          plan_before: 'free',
          plan_after: 'plus',
          model_id: 'seedance-2.5',
          modality: 'video',
          gate_reason: 'plan_locked',
        }),
        makePacket('surface_view', { page_name: 'explore', area: 'template_card', element: 'card' }),
        makePacket('playback', { action: 'play' }),
        makePacket('sdk_resolver_shadow', { mismatchCount: 0 }),
      ],
    });
    assert.equal(accepted, 3);
    assert.ok(CLOUD_ALLOWED_STUDIO_EVENTS.size <= 40);
    assert.equal(CLOUD_BLOCKED_SURFACE_AREAS.has('template_card'), true);
  });

  it('emits browser device_id and device-based anonymous identity on trackWebSignInResult', async () => {
    const sent: Array<{ batch: Array<{ event: string; properties: Record<string, unknown> }> }> = [];
    const tracker = createCloudTracking(
      '0.0.1-test',
      {
        OPENMOTION_TRACKING_ENABLED: '1',
        OPENMOTION_POSTHOG_TOKEN: 'phc_test_token_1234567890',
        OPENMOTION_POSTHOG_HOST: 'https://us.i.posthog.com',
        OPENMOTION_TRACKING_ENV: 'test',
        OPENMOTION_TRACKING_TEST_RUN_ID: crypto.randomUUID(),
      },
      {
        posthogFetch: async (_url, init) => {
          sent.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response(JSON.stringify({ status: 1 }), { status: 200 });
        },
      },
    );

    const browserDeviceId = 'browser-dev-11111111-2222-4333-8444-555555555555';
    const entryId = '22222222-2222-4222-8222-222222222222';
    tracker.trackWebSignInResult({
      outcome: 'success',
      hookId: 'bf_banner',
      entryId,
      deviceId: browserDeviceId,
      userId: 'amr_user_99',
      durationMs: 420,
    });
    tracker.trackWebSignInResult({
      outcome: 'cancelled',
      deviceId: browserDeviceId,
      durationMs: 120,
    });
    await tracker.flush({ timeoutMs: 2000 });
    await tracker.shutdown({ timeoutMs: 1000 });

    const events = sent.flatMap((b) => b.batch);
    assert.equal(events.length, 2);

    const successEv = events.find((e) => e.properties.outcome === 'success');
    assert.ok(successEv);
    assert.equal(successEv.event, 'account_sign_in_result');
    assert.equal(successEv.properties.device_id, browserDeviceId);
    assert.equal(successEv.properties.device_id_source, 'browser');
    assert.equal(successEv.properties.amr_user_id, 'amr_user_99');
    assert.equal(successEv.properties.distinct_id, 'amr_user_99');
    assert.equal(successEv.properties.source_detail, 'bf_banner');
    assert.equal(successEv.properties.entry_id, entryId);

    const cancelEv = events.find((e) => e.properties.outcome === 'cancelled');
    assert.ok(cancelEv);
    assert.equal(cancelEv.properties.device_id, browserDeviceId);
    assert.equal(cancelEv.properties.device_id_source, 'browser');
    assert.equal(cancelEv.properties.distinct_id, browserDeviceId);
  });
});
