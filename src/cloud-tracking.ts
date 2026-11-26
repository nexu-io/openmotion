import crypto from 'node:crypto';
import { isEntitlementHookId, type EntitlementHookId } from '../shared/entitlement-hooks.ts';
import { createTracker, uuid } from '../tracking/core.ts';
import { omEvents, studioEvents } from '../tracking/events.ts';
import { createPosthogSender } from '../tracking/node.ts';

const MAX_BROWSER_BATCH_SIZE = 25;
// Cloud pods aggregate browser telemetry from many concurrent users through one shared tracker;
// size the buffer above the single-user desktop default (64) so bursts of legitimate events do not
// drop conversion events while keeping each PostHog /batch/ request within its 16-event / 64 KB cap.
const STUDIO_TRACKER_MAX_QUEUE = 1024;
const STUDIO_TRACKER_FLUSH_INTERVAL_MS = 500;

/**
 * Cloud production allowlist for browser-originated Studio events.
 *
 * Cuts high-volume editor micro-interactions (playback, shortcuts, audio_fx_*), internal SDK/GSAP
 * shadow diagnostics, and card-level gallery impressions to control PostHog ingest cost while
 * keeping 100% of:
 *   1. Full monetization pre-funnel (touchpoint impression/click -> agent block -> login -> refresh)
 *   2. Core discovery, template/skill/MCP adoption, generation, editor save, and export outcomes
 *   3. Critical client reliability guardrails (crash, unhandled_error, save_failure)
 *
 * Set OPENMOTION_CLOUD_TRACKING_FULL=1 to temporarily bypass the allowlist during diagnostics.
 */
export const CLOUD_ALLOWED_STUDIO_EVENTS: ReadonlySet<string> = new Set([
  // Active baseline, navigation & monetization pre-funnel
  'page_view',
  'studio_load_result',
  'provider_setup_opened',
  'ui_click',
  'surface_view',
  'entitlement_refresh_result',
  // Template, Skill & MCP discovery/adoption
  'template_search_result',
  'template_search_handoff_result',
  'template_filter_result',
  'template_guide_interaction',
  'template_instruction_copy_result',
  'template_project_result',
  'resource_download_result',
  'skill_search_result',
  'skill_instruction_copy_result',
  'mcp_copy_result',
  // Media generation, assets, settings, projects & brand kits
  'asset_generation_submit_result',
  'asset_update_result',
  'provider_setting_result',
  'agent_setting_result',
  'project_manage_result',
  'version_history_result',
  'brand_kit_create_result',
  'brand_kit_import_result',
  'brand_kit_instruction_copy_result',
  'brand_kit_action_result',
  // Low-frequency editor & export outcomes + feedback
  'studio_edit_result',
  'studio_asset_import_result',
  'studio_export_request_result',
  'studio_export_result',
  'studio_io_result',
  'studio_feedback',
  'diagnostic_export_result',
  // Critical reliability guardrails
  'crash',
  'unhandled_error',
  'unhandled_promise_rejection',
  'save_failure',
  'commit_transaction_failed',
]);

/** High-volume card-level `surface_view` areas dropped in cloud production to curb PostHog volume. */
export const CLOUD_BLOCKED_SURFACE_AREAS: ReadonlySet<string> = new Set([
  'template_card',
  'template_series_card',
]);

export function isCloudBrowserEventAllowed(raw: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const fullFlag = (env.OPENMOTION_CLOUD_TRACKING_FULL ?? '').trim().toLowerCase();
  if (fullFlag === '1' || fullFlag === 'true') return true;
  if (!raw || typeof raw !== 'object') return false;
  const record = raw as { event?: unknown; properties?: unknown };
  if (typeof record.event !== 'string' || !CLOUD_ALLOWED_STUDIO_EVENTS.has(record.event)) {
    return false;
  }
  if (record.event === 'surface_view' && record.properties && typeof record.properties === 'object') {
    const area = (record.properties as { area?: unknown }).area;
    if (typeof area === 'string' && CLOUD_BLOCKED_SURFACE_AREAS.has(area)) {
      return false;
    }
  }
  return true;
}

export interface CloudTrackingHandle {
  isEnabled(): boolean;
  lockReason(): 'environment' | null;
  acceptBrowserBatch(payload: unknown): number;
  trackWebSignInResult(params: {
    outcome: 'success' | 'failure' | 'cancelled';
    hookId?: string | null;
    entryId?: string | null;
    userId?: string | null;
    durationMs?: number;
  }): void;
}

export function cloudTrackingLockReason(env: NodeJS.ProcessEnv = process.env): 'environment' | null {
  const telemetry = (env.OPENMOTION_TELEMETRY ?? '').trim().toLowerCase();
  const dnt = (env.DO_NOT_TRACK ?? '').trim();
  return ['0', 'false', 'off'].includes(telemetry) || dnt === '1' ? 'environment' : null;
}

function disabledCloudTracking(reason: 'environment' | null): CloudTrackingHandle {
  return {
    isEnabled: () => false,
    lockReason: () => reason,
    acceptBrowserBatch: () => 0,
    trackWebSignInResult: () => {},
  };
}

export function sanitizeHookId(value: string | null | undefined): EntitlementHookId | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return isEntitlementHookId(trimmed) ? trimmed : undefined;
}

export function sanitizeEntryId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return uuid.test(trimmed) ? trimmed : undefined;
}

function stableDeploymentInstallationId(env: NodeJS.ProcessEnv, host: string, token: string): string {
  const configured = (env.OPENMOTION_TRACKING_INSTALLATION_ID ?? '').trim();
  if (uuid.test(configured)) return configured;
  const seed = `${(env.APP_PUBLIC_ORIGIN ?? '').trim() || host}:${token.slice(0, 12)}`;
  const bytes = crypto.createHash('sha256').update(`openmotion-cloud-tracking:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Env-controlled PostHog tracker for the Web Cloud API server.
 * Stays safely disabled unless OPENMOTION_TRACKING_ENABLED=1/true and a valid
 * public PostHog token (OPENMOTION_POSTHOG_TOKEN or OPENMOTION_POSTHOG_KEY=phc_...)
 * are configured, and always honors OPENMOTION_TELEMETRY=0, DO_NOT_TRACK=1,
 * test-context suppression, and fail-closed host validation.
 */
export function createCloudTracking(appVersion: string, env: NodeJS.ProcessEnv = process.env): CloudTrackingHandle {
  const lockReason = cloudTrackingLockReason(env);
  if (lockReason !== null) {
    return disabledCloudTracking(lockReason);
  }
  const testing = Boolean(env.NODE_TEST_CONTEXT) || (env.NODE_ENV ?? '').trim().toLowerCase() === 'test';
  if (testing && !(env.OPENMOTION_TRACKING_TEST_RUN_ID ?? '').trim()) {
    return disabledCloudTracking(null);
  }

  const flag = (env.OPENMOTION_TRACKING_ENABLED ?? '').trim().toLowerCase();
  const token = (env.OPENMOTION_POSTHOG_TOKEN ?? '').trim() || (env.OPENMOTION_POSTHOG_KEY ?? '').trim();
  const host = (env.OPENMOTION_POSTHOG_HOST ?? 'https://us.i.posthog.com').trim();
  const rawEnv = (env.OPENMOTION_TRACKING_ENV ?? (testing ? 'test' : 'production')).trim().toLowerCase();
  const trackingEnv: 'development' | 'test' | 'production' =
    rawEnv === 'development' || rawEnv === 'test' ? rawEnv : 'production';

  const shouldEnable = (flag === '1' || flag === 'true') && /^phc_[A-Za-z0-9_]+$/.test(token);

  if (!shouldEnable || !host) {
    return disabledCloudTracking(null);
  }

  let sender: ReturnType<typeof createPosthogSender>;
  try {
    sender = createPosthogSender({
      host,
      token,
      identity: {
        installation_id: stableDeploymentInstallationId(env, host, token),
        utm_source: 'openmotion_web',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      appVersion,
      env: trackingEnv,
      channel: 'cloud_web',
      testRunId: (env.OPENMOTION_TRACKING_TEST_RUN_ID ?? '').trim() || undefined,
    });
  } catch {
    return disabledCloudTracking(null);
  }

  const isActive = () => cloudTrackingLockReason(env) === null;

  const studioTracker = createTracker({
    registry: studioEvents,
    entrypoint: 'studio',
    enabled: true,
    maxQueue: STUDIO_TRACKER_MAX_QUEUE,
    flushIntervalMs: STUDIO_TRACKER_FLUSH_INTERVAL_MS,
    isEnabled: isActive,
    send: sender,
  });

  const serverTracker = createTracker({
    registry: omEvents,
    entrypoint: 'mcp',
    enabled: true,
    isEnabled: isActive,
    send: sender,
  });

  return {
    isEnabled: isActive,
    lockReason: () => cloudTrackingLockReason(env),
    acceptBrowserBatch(payload: unknown): number {
      if (!isActive()) return 0;
      const items = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object' && Array.isArray((payload as { events?: unknown }).events)
          ? (payload as { events: unknown[] }).events
          : [];
      let accepted = 0;
      for (const raw of items.slice(0, MAX_BROWSER_BATCH_SIZE)) {
        if (!raw || typeof raw !== 'object') continue;
        const record = raw as { entrypoint?: unknown };
        if (record.entrypoint !== 'studio') continue;
        if (!isCloudBrowserEventAllowed(raw, env)) continue;
        const status = studioTracker.ingest(raw);
        if (status === 'queued') accepted++;
      }
      return accepted;
    },
    trackWebSignInResult({ outcome, hookId, entryId, userId, durationMs }) {
      if (!isActive()) return;
      const safeHook: EntitlementHookId | 'openmotion_editor_login' = sanitizeHookId(hookId) ?? 'openmotion_editor_login';
      const safeEntry = sanitizeEntryId(entryId);
      serverTracker.track('account_sign_in_result', {
        attempt_id: crypto.randomUUID(),
        outcome,
        source_product: 'openmotion',
        source_detail: safeHook,
        ...(safeEntry ? { entry_id: safeEntry } : {}),
        ...(userId ? { amr_user_id: userId } : {}),
        connector_version: 'web-oidc',
        resumed: false,
        duration_ms: Math.max(0, Math.round(durationMs ?? 0)),
      });
    },
  };
}
