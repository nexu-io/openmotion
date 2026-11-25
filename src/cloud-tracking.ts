import crypto from 'node:crypto';
import { createTracker, uuid } from '../tracking/core.ts';
import { omEvents, studioEvents } from '../tracking/events.ts';
import { createPosthogSender } from '../tracking/node.ts';

const MAX_BROWSER_BATCH_SIZE = 25;
const SAFE_HOOK_ID = /^[a-z0-9_]{1,40}$/;

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

export function sanitizeHookId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return SAFE_HOOK_ID.test(trimmed) ? trimmed : undefined;
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
  const token = (env.OPENMOTION_POSTHOG_TOKEN ?? env.OPENMOTION_POSTHOG_KEY ?? '').trim();
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
        const status = studioTracker.ingest(raw);
        if (status === 'queued') accepted++;
      }
      return accepted;
    },
    trackWebSignInResult({ outcome, hookId, entryId, userId, durationMs }) {
      if (!isActive()) return;
      const safeHook = sanitizeHookId(hookId) ?? 'openmotion_editor_login';
      const safeEntry = sanitizeEntryId(entryId);
      serverTracker.track('account_sign_in_result', {
        attempt_id: crypto.randomUUID(),
        outcome,
        source_product: 'openmotion',
        source_detail: safeHook as never,
        ...(safeEntry ? { entry_id: safeEntry } : {}),
        ...(userId ? { amr_user_id: userId } : {}),
        connector_version: 'web-oidc',
        resumed: false,
        duration_ms: Math.max(0, Math.round(durationMs ?? 0)),
      });
    },
  };
}
