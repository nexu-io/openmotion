import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudTracking, sanitizeHookId } from '../../src/cloud-tracking.ts';
import { createLogger } from '../../src/infra/logger.ts';

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
  assert.deepEqual(telemetryOff.acceptBrowserBatch([]), { queued: 0, full: 0 });

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
    assert.deepEqual(tracker.acceptBrowserBatch([]), { queued: 0, full: 0 });
  }
});

test('acceptBrowserBatch preserves event identity, deduplicates event_id, and rejects non-studio entrypoints', () => {
  const tracker = createCloudTracking('1.0.0', { ...BASE_ENV, OPENMOTION_TRACKING_ENABLED: 'count-only' });
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
  const legacyClick = { ...validStudioEvent, event_id: crypto.randomUUID(), event: 'ui_click',
    properties: { page_name: 'studio', area: 'header', element: 'export', hook_id: 'header_pricing' } };
  assert.deepEqual(tracker.acceptBrowserBatch({ events: [validStudioEvent, wrongEntrypointEvent, legacyClick] }), { queued: 1, full: 0 });
  // Retrying the exact same event_id is deduplicated by tracker.ingest().
  assert.deepEqual(tracker.acceptBrowserBatch({ events: [validStudioEvent] }), { queued: 0, full: 0 });
});

test('hosted admission counts hookless settings funnel clicks and refreshes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lines: string[] = [];
  const tracker = createCloudTracking('1.0.0', { OPENMOTION_TRACKING_ENABLED: 'count-only', OPENMOTION_TRACKING_TEST_RUN_ID: TEST_RUN_UUID },
    createLogger({ sink: (_level, line) => lines.push(line) }));
  const packet = (event: string, properties: Record<string, string>) => ({ event, properties, entrypoint: 'studio',
    event_id: crypto.randomUUID(), occurred_at: new Date().toISOString(), device_timezone: null, utc_offset_minutes: 0 });
  const click = (area: string, element: string, page_name = 'settings') => packet('ui_click', { page_name, area, element });
  const accepted = [click('account', 'sign_in'), click('account', 'manage_subscription'), click('account', 'view_plans'),
    click('provider_detail', 'view_plans'), packet('entitlement_refresh_result', { outcome: 'failure' })];
  const rejected = [click('account', 'sign_out'), click('provider_detail', 'manage_subscription'), click('account', 'sign_in', 'home'),
    click('entitlement_modal', 'sign_in'), packet('entitlement_refresh_result', { outcome: 'success', hook_id: 'unregistered' }),
    packet('entitlement_refresh_result', { outcome: 'invalid' })];
  assert.deepEqual(tracker.acceptBrowserBatch(rejected), { queued: 0, full: 0 });
  assert.deepEqual(tracker.acceptBrowserBatch(accepted), { queued: accepted.length, full: 0 });
  t.mock.timers.tick(1000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(lines.map(line => JSON.parse(line).counts), [{ 'ui_click/account/sign_in': 1,
    'ui_click/account/manage_subscription': 1, 'ui_click/account/view_plans': 1, 'ui_click/provider_detail/view_plans': 1,
    entitlement_refresh_result: 1 }]);
});

test('count-only batches log bounded counts, preserve queue-pressure receipts and make no outgoing requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const network = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const lines: string[] = [];
  const tracker = createCloudTracking('1.0.0', { ...BASE_ENV, OPENMOTION_TRACKING_ENABLED: 'count-only' },
    createLogger({ sink: (_level, line) => lines.push(line) }));
  const events = Array.from({ length: 65 }, () => ({ event: 'entitlement_refresh_result', entrypoint: 'studio',
    event_id: crypto.randomUUID(), occurred_at: new Date().toISOString(), device_timezone: null, utc_offset_minutes: 0,
    properties: { hook_id: 'header_pricing', outcome: 'success', entry_id: crypto.randomUUID() } }));
  for (let i = 0; i < 64; i += 16) assert.deepEqual(tracker.acceptBrowserBatch(events.slice(i, i + 16)), { queued: 16, full: 0 });
  assert.deepEqual(tracker.acceptBrowserBatch(events.slice(63)), { queued: 0, full: 1 });
  tracker.trackWebSignInResult({ outcome: 'success', hookId: 'header_signin', userId: 'private-fixture' });
  t.mock.timers.tick(1000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(lines.map(line => JSON.parse(line).counts), [
    { 'entitlement_refresh_result/header_pricing': 16 }, { 'account_sign_in_result/header_signin': 1 },
  ]);
  assert.ok(lines.every(line => JSON.parse(line).outcome === 'counted'));
  assert.ok(!lines.join('').includes('private-fixture'));
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(tracker.acceptBrowserBatch(events.slice(63)), { queued: 1, full: 0 });
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
