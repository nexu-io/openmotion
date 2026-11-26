import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { describe, it } from 'node:test';
import { CLOUD_ALLOWED_STUDIO_EVENTS,
  CLOUD_BLOCKED_SURFACE_AREAS,
  createCloudTracking,
  isCloudBrowserEventAllowed, sanitizeHookId } from '../../src/cloud-tracking.ts';

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

// --- Cloud production allowlist & monetization attribution tests ---
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

describe('cloud tracking allowlist (PostHog cost containment)', () => {
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
});
