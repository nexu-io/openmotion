import crypto from 'node:crypto';
import { TracertNode, type FlushResult as TracertFlushResult } from '@powerformer/tracert/node';
import { isEntitlementHookId, type EntitlementHookId } from '../shared/entitlement-hooks.ts';
import {
  buildBrowserTracertConfig,
  buildBrowserTrackingRuntimeConfig,
  normalizeTracertEnvironment,
  type BrowserTracertConfig,
  type BrowserTrackingRuntimeConfig,
} from '../shared/tracking-runtime-config.ts';
import { createTracker, deviceContext, uuid } from '../tracking/core.ts';
import { omEvents, studioEvents } from '../tracking/events.ts';
import { createPosthogSender } from '../tracking/node.ts';

const MAX_BROWSER_BATCH_SIZE = 25;
// Cloud pods aggregate browser telemetry from many concurrent users through one shared tracker;
// size the buffer above the single-user desktop default (64) so bursts of card impressions do not
// drop conversion events while keeping each PostHog /batch/ request within its 16-event / 64 KB cap.
const STUDIO_TRACKER_MAX_QUEUE = 1024;
const STUDIO_TRACKER_FLUSH_INTERVAL_MS = 500;
const MAX_IDENTITY_LENGTH = 256;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface CloudTrackingOptions {
  readonly tracertFetch?: typeof fetch;
}

export interface CloudTrackingHandle {
  isEnabled(): boolean;
  isPosthogEnabled(): boolean;
  isTracertEnabled(): boolean;
  lockReason(): 'environment' | null;
  browserConfig(): BrowserTrackingRuntimeConfig;
  acceptBrowserBatch(payload: unknown): number;
  trackWebSignInResult(params: {
    outcome: 'success' | 'failure' | 'cancelled';
    hookId?: string | null;
    entryId?: string | null;
    userId?: string | null;
    durationMs?: number;
  }): void;
  flush(options?: { timeoutMs?: number }): Promise<TracertFlushResult | null>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

export function cloudTrackingLockReason(env: NodeJS.ProcessEnv = process.env): 'environment' | null {
  const telemetry = (env.OPENMOTION_TELEMETRY ?? '').trim().toLowerCase();
  const dnt = (env.DO_NOT_TRACK ?? '').trim();
  return ['0', 'false', 'off'].includes(telemetry) || dnt === '1' ? 'environment' : null;
}

function disabledCloudTracking(reason: 'environment' | null): CloudTrackingHandle {
  const browserRuntimeConfig = buildBrowserTrackingRuntimeConfig({
    posthogEnabled: false,
    locked: true,
    reason: reason ?? 'cloud',
    tracert: null,
  });
  return {
    isEnabled: () => false,
    isPosthogEnabled: () => false,
    isTracertEnabled: () => false,
    lockReason: () => reason,
    browserConfig: () => browserRuntimeConfig,
    acceptBrowserBatch: () => 0,
    trackWebSignInResult: () => {},
    flush: async () => null,
    shutdown: async () => {},
  };
}

function resolveNodeTracertEndpoint(
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined | null {
  if (!endpoint) return undefined;
  if (!endpoint.startsWith('/')) return endpoint;
  const rawOrigin = (env.APP_PUBLIC_ORIGIN ?? '').trim();
  if (!rawOrigin) return null;
  try {
    const origin = new URL(rawOrigin);
    const isHttps = origin.protocol === 'https:';
    const isLoopbackHttp =
      origin.protocol === 'http:' && LOOPBACK_HOSTS.has(origin.hostname.toLowerCase());
    if (!isHttps && !isLoopbackHttp) return null;
    return new URL(endpoint, origin.origin).toString();
  } catch {
    return null;
  }
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
 * Env-controlled PostHog + Tracert web runtime configuration for the Cloud API server.
 *
 * - PostHog stays disabled unless `OPENMOTION_TRACKING_ENABLED=1/true` and a valid
 *   public PostHog token (`OPENMOTION_POSTHOG_TOKEN` or `OPENMOTION_POSTHOG_KEY=phc_...`) are set.
 * - Tracert web reporting stays disabled unless `OPENMOTION_TRACERT_SPM_A` is set.
 * - Self-hosted deployments with neither configured emit zero telemetry.
 * - Both channels honor `OPENMOTION_TELEMETRY=0`, `DO_NOT_TRACK=1`, test-context
 *   suppression (unless `OPENMOTION_TRACKING_TEST_RUN_ID` is set), and fail-closed validation.
 */
export function createCloudTracking(
  appVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  options: CloudTrackingOptions = {},
): CloudTrackingHandle {
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
  const rawEnv = (env.OPENMOTION_TRACKING_ENV ?? (testing ? 'test' : (env.NODE_ENV ?? 'production'))).trim().toLowerCase();
  const trackingEnv: 'development' | 'test' | 'production' =
    rawEnv === 'development' || rawEnv === 'test' ? rawEnv : 'production';

  const tracertConfig: BrowserTracertConfig | null = buildBrowserTracertConfig({
    spmA: env.OPENMOTION_TRACERT_SPM_A,
    endpoint: env.OPENMOTION_TRACERT_ENDPOINT,
    environment: normalizeTracertEnvironment(rawEnv, trackingEnv === 'production' ? 'prod' : 'test'),
    appVersion,
  });

  const posthogRequested = (flag === '1' || flag === 'true') && /^phc_[A-Za-z0-9_]+$/.test(token) && Boolean(host);

  let sender: ReturnType<typeof createPosthogSender> | null = null;
  if (posthogRequested) {
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
      sender = null;
    }
  }

  let tracertNode: TracertNode | null = null;
  if (tracertConfig) {
    const nodeEndpoint = resolveNodeTracertEndpoint(tracertConfig.endpoint, env);
    if (nodeEndpoint !== null) {
      try {
        tracertNode = new TracertNode({
          spmA: tracertConfig.spmA,
          ...(nodeEndpoint ? { endpoint: nodeEndpoint } : {}),
          environment: tracertConfig.environment,
          appVersion: tracertConfig.appVersion ?? appVersion,
          defaultProperties: {
            product: 'openmotion',
            entrypoint: 'api',
            env: tracertConfig.environment,
          },
          ...(options.tracertFetch ? { fetch: options.tracertFetch } : {}),
        });
      } catch {
        tracertNode = null;
      }
    }
  }

  const posthogReady = sender !== null;
  if (!posthogReady && !tracertConfig) {
    return disabledCloudTracking(null);
  }

  const isActive = () => cloudTrackingLockReason(env) === null;
  const isPosthogActive = () => posthogReady && isActive();
  const isTracertActive = () => Boolean(tracertConfig) && isActive();

  const studioTracker = sender
    ? createTracker({
        registry: studioEvents,
        entrypoint: 'studio',
        enabled: true,
        maxQueue: STUDIO_TRACKER_MAX_QUEUE,
        flushIntervalMs: STUDIO_TRACKER_FLUSH_INTERVAL_MS,
        isEnabled: isPosthogActive,
        send: sender,
      })
    : null;

  const serverTracker = sender
    ? createTracker({
        registry: omEvents,
        entrypoint: 'mcp',
        enabled: true,
        isEnabled: isPosthogActive,
        send: sender,
      })
    : null;

  return {
    isEnabled: isActive,
    isPosthogEnabled: isPosthogActive,
    isTracertEnabled: isTracertActive,
    lockReason: () => cloudTrackingLockReason(env),
    browserConfig() {
      const currentLock = cloudTrackingLockReason(env);
      if (currentLock !== null) {
        return buildBrowserTrackingRuntimeConfig({
          posthogEnabled: false,
          locked: true,
          reason: currentLock,
          tracert: null,
        });
      }
      return buildBrowserTrackingRuntimeConfig({
        posthogEnabled: posthogReady,
        locked: true,
        reason: 'cloud',
        tracert: tracertConfig,
      });
    },
    acceptBrowserBatch(payload: unknown): number {
      if (!studioTracker || !isPosthogActive()) return 0;
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
      const posthogOn = Boolean(serverTracker && isPosthogActive());
      const tracertOn = Boolean(tracertNode && isTracertActive());
      if (!posthogOn && !tracertOn) return;

      const eventId = crypto.randomUUID();
      const occurredAt = new Date();
      const attemptId = crypto.randomUUID();
      const safeHook: EntitlementHookId | 'openmotion_editor_login' = sanitizeHookId(hookId) ?? 'openmotion_editor_login';
      const safeEntry = sanitizeEntryId(entryId);
      const trimmedUserId = typeof userId === 'string' && userId.trim().length > 0 && userId.trim().length <= MAX_IDENTITY_LENGTH
        ? userId.trim()
        : undefined;
      const properties = {
        attempt_id: attemptId,
        outcome,
        source_product: 'openmotion' as const,
        source_detail: safeHook,
        ...(safeEntry ? { entry_id: safeEntry } : {}),
        ...(trimmedUserId ? { amr_user_id: trimmedUserId } : {}),
        connector_version: 'web-oidc',
        resumed: false,
        duration_ms: Math.max(0, Math.round(durationMs ?? 0)),
      };

      if (posthogOn && serverTracker) {
        serverTracker.ingest({
          event: 'account_sign_in_result',
          event_id: eventId,
          occurred_at: occurredAt.toISOString(),
          entrypoint: 'mcp',
          ...deviceContext(),
          properties,
        });
      }

      if (tracertOn && tracertNode) {
        try {
          tracertNode.capture({
            event: 'account_sign_in_result',
            uuid: eventId,
            timestamp: occurredAt,
            identity: trimmedUserId
              ? { userId: trimmedUserId }
              : { anonymousId: safeEntry ?? attemptId },
            properties,
          });
        } catch {
          // Server telemetry must never disrupt auth callbacks.
        }
      }
    },
    async flush(flushOptions) {
      const timeoutMs = flushOptions?.timeoutMs ?? 3000;
      await Promise.allSettled([
        studioTracker ? studioTracker.flush() : Promise.resolve(),
        serverTracker ? serverTracker.flush() : Promise.resolve(),
      ]);
      if (!tracertNode || !isTracertActive()) return null;
      try {
        return await tracertNode.flush({ timeoutMs });
      } catch {
        return null;
      }
    },
    async shutdown(shutdownOptions) {
      const timeoutMs = shutdownOptions?.timeoutMs ?? 3000;
      await Promise.allSettled([
        studioTracker ? studioTracker.flush() : Promise.resolve(),
        serverTracker ? serverTracker.flush() : Promise.resolve(),
        tracertNode ? tracertNode.shutdown({ timeoutMs }) : Promise.resolve(),
      ]);
      studioTracker?.close();
      serverTracker?.close();
    },
  };
}
