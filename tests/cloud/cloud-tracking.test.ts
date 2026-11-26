import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import {
  CLOUD_ALLOWED_STUDIO_EVENTS,
  CLOUD_BLOCKED_SURFACE_AREAS,
  createCloudTracking,
  isCloudBrowserEventAllowed,
} from '../../src/cloud-tracking.ts';

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
