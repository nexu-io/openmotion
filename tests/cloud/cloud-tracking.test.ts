import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudTracking } from '../../src/cloud-tracking.ts';

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
