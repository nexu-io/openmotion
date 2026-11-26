import crypto from 'node:crypto';
import { TracertNode, type FlushResult as TracertFlushResult } from '@powerformer/tracert/node';
import { isEntitlementHookId, type EntitlementHookId } from '../shared/entitlement-hooks.ts';
import {
  CLOUD_ALLOWED_STUDIO_EVENTS,
  CLOUD_BLOCKED_SURFACE_AREAS,
  buildBrowserTracertConfig,
  buildBrowserTrackingRuntimeConfig,
  isCloudBrowserEventAllowed as isCloudBrowserEventAllowedShared,
  isCloudFullTrackingEnabled,
  normalizeTracertEnvironment,
  type BrowserTracertConfig,
  type BrowserTrackingRuntimeConfig,
} from '../shared/tracking-runtime-config.ts';
import { createTracker, deviceContext, uuid, validProperties } from '../tracking/core.ts';
import { mcpToolNames, omEvents, studioEvents } from '../tracking/events.ts';
import { createPosthogSender, type PosthogEventIdentity } from '../tracking/node.ts';
import { exportFailureCodes, exportFailureStages, toolFailureFields, toolInputFields } from '../tracking/tool-fields.ts';

export { CLOUD_ALLOWED_STUDIO_EVENTS, CLOUD_BLOCKED_SURFACE_AREAS, isCloudFullTrackingEnabled };

const MAX_BROWSER_BATCH_SIZE = 25;
// Cloud pods aggregate browser telemetry from many concurrent users through one shared tracker;
// size the buffer above the single-user desktop default (64) so bursts of legitimate events do not
// drop conversion events while keeping each PostHog /batch/ request within its 16-event / 64 KB cap.
const STUDIO_TRACKER_MAX_QUEUE = 1024;
const SERVER_TRACKER_MAX_QUEUE = 512;
const STUDIO_TRACKER_FLUSH_INTERVAL_MS = 500;
const MAX_IDENTITY_LENGTH = 256;
const MAX_IDENTITY_CACHE = 8192;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MCP_TOOL_NAME_SET: ReadonlySet<string> = new Set(mcpToolNames);
const EXPORT_FAILURE_STAGE_SET: ReadonlySet<string> = new Set(exportFailureStages);
const EXPORT_FAILURE_CODE_SET: ReadonlySet<string> = new Set(exportFailureCodes);

export interface CloudTrackingOptions {
  readonly tracertFetch?: typeof fetch;
  readonly posthogFetch?: typeof fetch;
  readonly serviceEntrypoint?: 'api' | 'worker-media' | 'worker-render';
}

export interface BrowserBatchActor {
  readonly userId?: string | null;
  readonly deviceId?: string | null;
}

export function isCloudBrowserEventAllowed(raw: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return isCloudBrowserEventAllowedShared(raw, env);
}

export interface CloudTrackingHandle {
  isEnabled(): boolean;
  isPosthogEnabled(): boolean;
  isTracertEnabled(): boolean;
  lockReason(): 'environment' | null;
  browserConfig(): BrowserTrackingRuntimeConfig;
  acceptBrowserBatch(payload: unknown, actor?: BrowserBatchActor): number;
  trackWebSignInResult(params: {
    outcome: 'success' | 'failure' | 'cancelled';
    hookId?: string | null;
    entryId?: string | null;
    userId?: string | null;
    durationMs?: number;
  }): void;
  trackWorkGenerationStage(params: {
    workId: string;
    projectId: string;
    stage: 'started' | 'generated' | 'edited' | 'exported';
    taskType: 'create' | 'modify';
    versionId?: string | null;
    revision?: string | null;
    exportRoute?: 'mcp' | 'studio';
    userId?: string | null;
    entrypoint?: 'mcp' | 'worker';
  }): void;
  trackMediaGenerationRequested(params: {
    modality: 'image' | 'video' | 'audio';
    userId?: string | null;
  }): void;
  trackMediaGenerationSubmitted(params: {
    modality: 'image' | 'video' | 'audio';
    jobId: string;
    userId?: string | null;
  }): void;
  trackMediaGenerationResult(params: {
    modality: 'image' | 'video' | 'audio';
    jobId: string;
    jobState: 'completed' | 'failed' | 'cancelled';
    assetCount: number;
    userId?: string | null;
  }): void;
  trackTaskAccepted(params: {
    taskId: string;
    taskType: 'asset_import' | 'edit' | 'export';
    projectId?: string | null;
    acceptedAt: Date | string;
    deadlineAt: Date | string;
    runId?: string | null;
    operationId?: string | null;
    userId?: string | null;
    entrypoint?: 'mcp' | 'worker';
  }): void;
  trackTaskTerminal(params: {
    taskId: string;
    taskType: 'asset_import' | 'edit' | 'export';
    projectId?: string | null;
    outcome: 'success' | 'failure' | 'unknown' | 'cancelled';
    applied: 'true' | 'false' | 'unknown';
    terminalAt: Date | string;
    errorCode?: string | null;
    runId?: string | null;
    operationId?: string | null;
    userId?: string | null;
    entrypoint?: 'mcp' | 'worker';
  }): void;
  trackExportResult(params: {
    jobId: string;
    jobState: 'completed' | 'failed' | 'cancelled';
    durationMs: number;
    technicalCheck: 'passed' | 'failed' | 'unknown';
    failureStage?: string | null;
    errorCode?: string | null;
    userId?: string | null;
  }): void;
  trackMcpToolFinished(params: {
    canonicalToolName: string;
    publicToolName?: string;
    args?: unknown;
    callId?: string;
    operationId?: string | null;
    accepted: boolean;
    outcome: 'success' | 'failure' | 'partial' | 'cancelled' | 'unknown';
    durationMs: number;
    replayed?: boolean;
    error?: unknown;
    userId?: string | null;
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
    allowlistEnabled: false,
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
    trackWorkGenerationStage: () => {},
    trackMediaGenerationRequested: () => {},
    trackMediaGenerationSubmitted: () => {},
    trackMediaGenerationResult: () => {},
    trackTaskAccepted: () => {},
    trackTaskTerminal: () => {},
    trackExportResult: () => {},
    trackMcpToolFinished: () => {},
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

function sanitizeIdentity(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_IDENTITY_LENGTH ? trimmed : undefined;
}

function sanitizeBrowserDeviceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return DEVICE_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

function sanitizeCode(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return CODE_PATTERN.test(trimmed) ? trimmed : undefined;
}

function toIsoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function clampDurationMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(86_400_000, Math.round(value)));
}

function deterministicEventUuid(seed: string): string {
  const bytes = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeExportFailureStage(
  raw: string | null | undefined,
): (typeof exportFailureStages)[number] {
  if (!raw) return 'unknown';
  const normalized = raw.trim().toLowerCase();
  if (EXPORT_FAILURE_STAGE_SET.has(normalized)) {
    return normalized as (typeof exportFailureStages)[number];
  }
  if (normalized === 'hydrating' || normalized === 'enqueue') return 'queued';
  if (normalized === 'uploading') return 'finalize';
  return 'unknown';
}

function normalizeExportFailureCode(
  raw: string | null | undefined,
): (typeof exportFailureCodes)[number] {
  if (!raw) return 'EXPORT_FAILED';
  const normalized = raw.trim().toUpperCase();
  if (EXPORT_FAILURE_CODE_SET.has(normalized)) {
    return normalized as (typeof exportFailureCodes)[number];
  }
  if (normalized === 'EXPORT_UPLOAD_FAILED') return 'EXPORT_FINALIZE_FAILED';
  return 'EXPORT_FAILED';
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
 * Env-controlled PostHog + Tracert web/server/worker runtime configuration for OpenMotion Cloud.
 *
 * - PostHog stays disabled unless `OPENMOTION_TRACKING_ENABLED=1/true` and a valid
 *   public PostHog token (`OPENMOTION_POSTHOG_TOKEN` or `OPENMOTION_POSTHOG_KEY=phc_...`) are set.
 * - Tracert web/server reporting stays disabled unless `OPENMOTION_TRACERT_SPM_A` is set.
 * - Self-hosted deployments with neither configured emit zero telemetry.
 * - Both channels honor `OPENMOTION_TELEMETRY=0`, `DO_NOT_TRACK=1`, test-context
 *   suppression (unless `OPENMOTION_TRACKING_TEST_RUN_ID` is set), strict shared browser allowlist
 *   (unless `OPENMOTION_CLOUD_TRACKING_FULL=1`), and fail-closed validation.
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
  const eventIdentities = new Map<string, PosthogEventIdentity>();
  const rememberEventIdentity = (eventId: string, identity: PosthogEventIdentity): void => {
    eventIdentities.set(eventId, identity);
    if (eventIdentities.size > MAX_IDENTITY_CACHE) {
      const oldest = eventIdentities.keys().next().value;
      if (oldest !== undefined) eventIdentities.delete(oldest);
    }
  };

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
        channel: 'cloud_web',
        testRunId: (env.OPENMOTION_TRACKING_TEST_RUN_ID ?? '').trim() || undefined,
        resolveEventIdentity: (event) => eventIdentities.get(event.event_id),
        ...(options.posthogFetch ? { fetch: options.posthogFetch } : {}),
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
            entrypoint: options.serviceEntrypoint ?? 'api',
            env: tracertConfig.environment,
            channel: 'cloud_web',
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
  const tracertServerSeen = new Set<string>();

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
        maxQueue: SERVER_TRACKER_MAX_QUEUE,
        flushIntervalMs: STUDIO_TRACKER_FLUSH_INTERVAL_MS,
        isEnabled: isPosthogActive,
        send: sender,
      })
    : null;

  const workerTracker = sender
    ? createTracker({
        registry: omEvents,
        entrypoint: 'worker',
        enabled: true,
        maxQueue: SERVER_TRACKER_MAX_QUEUE,
        flushIntervalMs: STUDIO_TRACKER_FLUSH_INTERVAL_MS,
        isEnabled: isPosthogActive,
        send: sender,
      })
    : null;

  function emitServerEvent(params: {
    event: keyof typeof omEvents & string;
    entrypoint: 'mcp' | 'worker';
    properties: Record<string, unknown>;
    userId?: string | null;
    anonymousId?: string | null;
    eventId?: string;
    occurredAt?: Date;
    tracertEntrypoint?: string;
  }): void {
    if (!isActive()) return;
    const targetTracker = params.entrypoint === 'worker' ? workerTracker : serverTracker;
    const posthogOn = Boolean(targetTracker && isPosthogActive());
    const tracertOn = Boolean(tracertNode && isTracertActive());
    if (!posthogOn && !tracertOn) return;

    const cleanProps: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(params.properties)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        cleanProps[key] = value;
      }
    }
    if (!validProperties(omEvents, params.event, cleanProps)) return;

    const eventId =
      params.eventId && uuid.test(params.eventId) ? params.eventId : crypto.randomUUID();
    const occurredAt = params.occurredAt ?? new Date();
    const trimmedUserId = sanitizeIdentity(params.userId);
    const trimmedAnonId = sanitizeIdentity(params.anonymousId) ?? eventId;

    if (posthogOn && targetTracker) {
      rememberEventIdentity(eventId, {
        distinct_id: trimmedUserId ?? trimmedAnonId,
        ...(trimmedUserId ? { user_id: trimmedUserId } : {}),
      });
      const status = targetTracker.ingest({
        event: params.event,
        event_id: eventId,
        occurred_at: occurredAt.toISOString(),
        entrypoint: params.entrypoint,
        ...deviceContext(),
        properties: cleanProps,
      });
      if (status === 'duplicate') return;
    } else if (tracertServerSeen.has(eventId)) {
      return;
    }

    tracertServerSeen.add(eventId);
    if (tracertServerSeen.size > 2048) {
      const oldest = tracertServerSeen.values().next().value;
      if (oldest !== undefined) tracertServerSeen.delete(oldest);
    }

    if (tracertOn && tracertNode) {
      try {
        tracertNode.capture({
          event: params.event,
          uuid: eventId,
          timestamp: occurredAt,
          identity: trimmedUserId
            ? { userId: trimmedUserId }
            : { anonymousId: trimmedAnonId },
          properties: {
            ...cleanProps,
            ...(params.tracertEntrypoint ? { entrypoint: params.tracertEntrypoint } : {}),
          },
        });
      } catch {
        // Server telemetry must never disrupt request or worker execution.
      }
    }
  }

  async function drainPosthogTracker(
    tracker: { flush(): Promise<string>; pending(): number } | null,
    timeoutMs: number,
  ): Promise<void> {
    if (!tracker) return;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (tracker.pending() > 0 && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const receipt = await Promise.race([
        tracker.flush(),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (
        receipt === 'timeout' ||
        receipt === 'disabled' ||
        receipt === 'empty' ||
        receipt === 'retry'
      ) {
        break;
      }
    }
  }

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
          allowlistEnabled: false,
          locked: true,
          reason: currentLock,
          tracert: null,
        });
      }
      return buildBrowserTrackingRuntimeConfig({
        posthogEnabled: posthogReady,
        allowlistEnabled: !isCloudFullTrackingEnabled(env),
        locked: true,
        reason: 'cloud',
        tracert: tracertConfig,
      });
    },
    acceptBrowserBatch(payload: unknown, actor?: BrowserBatchActor): number {
      if (!studioTracker || !isPosthogActive()) return 0;
      const payloadObj =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as { events?: unknown; device_id?: unknown })
          : null;
      const items = Array.isArray(payload)
        ? payload
        : payloadObj && Array.isArray(payloadObj.events)
          ? payloadObj.events
          : [];

      const safeUserId = sanitizeIdentity(actor?.userId);
      const safeDeviceId = sanitizeBrowserDeviceId(actor?.deviceId ?? payloadObj?.device_id);
      const identityOverride: PosthogEventIdentity | null =
        safeUserId || safeDeviceId
          ? {
              distinct_id: safeUserId ?? safeDeviceId,
              ...(safeDeviceId ? { device_id: safeDeviceId, device_id_source: 'browser' as const } : {}),
              ...(safeUserId ? { user_id: safeUserId } : {}),
            }
          : null;

      let accepted = 0;
      for (const raw of items.slice(0, MAX_BROWSER_BATCH_SIZE)) {
        if (!raw || typeof raw !== 'object') continue;
        const record = raw as { entrypoint?: unknown; event_id?: unknown };
        if (record.entrypoint !== 'studio') continue;
        if (!isCloudBrowserEventAllowed(raw, env)) continue;
        const status = studioTracker.ingest(raw);
        if (status === 'queued') {
          if (identityOverride && typeof record.event_id === 'string') {
            rememberEventIdentity(record.event_id, identityOverride);
          }
          accepted++;
        }
      }
      return accepted;
    },
    trackWebSignInResult({ outcome, hookId, entryId, userId, durationMs }) {
      const attemptId = crypto.randomUUID();
      const safeHook: EntitlementHookId | 'openmotion_editor_login' =
        sanitizeHookId(hookId) ?? 'openmotion_editor_login';
      const safeEntry = sanitizeEntryId(entryId);
      const trimmedUserId = sanitizeIdentity(userId);
      const safeAmrUserId = trimmedUserId && CODE_PATTERN.test(trimmedUserId) ? trimmedUserId : undefined;

      emitServerEvent({
        event: 'account_sign_in_result',
        entrypoint: 'mcp',
        userId: trimmedUserId,
        anonymousId: safeEntry ?? attemptId,
        tracertEntrypoint: 'api',
        properties: {
          attempt_id: attemptId,
          outcome,
          source_product: 'openmotion',
          source_detail: safeHook,
          ...(safeEntry ? { entry_id: safeEntry } : {}),
          ...(safeAmrUserId ? { amr_user_id: safeAmrUserId } : {}),
          connector_version: 'web-oidc',
          resumed: false,
          duration_ms: clampDurationMs(durationMs ?? 0),
        },
      });
    },
    trackWorkGenerationStage({
      workId,
      projectId,
      stage,
      taskType,
      versionId,
      revision,
      exportRoute,
      userId,
      entrypoint = 'mcp',
    }) {
      if (!uuid.test(workId)) return;
      const safeProjectId = sanitizeCode(projectId);
      if (!safeProjectId) return;
      const safeVersionId = sanitizeCode(versionId);
      const safeRevision = sanitizeCode(revision);

      emitServerEvent({
        event: 'work_generation_stage',
        entrypoint,
        eventId: deterministicEventUuid(`openmotion:work_generation_stage:${workId}:${stage}`),
        userId,
        anonymousId: workId,
        properties: {
          work_id: workId,
          project_id: safeProjectId,
          stage,
          task_type: taskType,
          ...(safeVersionId ? { version_id: safeVersionId } : {}),
          ...(safeRevision ? { revision: safeRevision } : {}),
          ...(stage === 'exported' && exportRoute ? { export_route: exportRoute } : {}),
        },
      });
    },
    trackMediaGenerationRequested({ modality, userId }) {
      emitServerEvent({
        event: 'media_generation_requested',
        entrypoint: 'worker',
        userId,
        properties: { modality },
      });
    },
    trackMediaGenerationSubmitted({ modality, jobId, userId }) {
      if (!uuid.test(jobId)) return;
      emitServerEvent({
        event: 'media_generation_submitted',
        entrypoint: 'worker',
        userId,
        anonymousId: jobId,
        properties: { modality, job_id: jobId },
      });
    },
    trackMediaGenerationResult({ modality, jobId, jobState, assetCount, userId }) {
      if (!uuid.test(jobId)) return;
      emitServerEvent({
        event: 'media_generation_result',
        entrypoint: 'worker',
        userId,
        anonymousId: jobId,
        properties: {
          modality,
          job_id: jobId,
          job_state: jobState,
          asset_count: Math.max(0, Math.min(86_400_000, Math.round(assetCount))),
        },
      });
    },
    trackTaskAccepted({
      taskId,
      taskType,
      projectId,
      acceptedAt,
      deadlineAt,
      runId,
      operationId,
      userId,
      entrypoint = 'worker',
    }) {
      if (!uuid.test(taskId)) return;
      const safeProjectId = sanitizeCode(projectId);
      const safeRunId = runId && uuid.test(runId) ? runId : undefined;
      const safeOpId = operationId && uuid.test(operationId) ? operationId : undefined;

      emitServerEvent({
        event: 'task_accepted',
        entrypoint,
        userId,
        anonymousId: taskId,
        properties: {
          task_id: taskId,
          task_type: taskType,
          ...(safeProjectId ? { project_id: safeProjectId } : {}),
          ...(safeRunId ? { run_id: safeRunId } : {}),
          ...(safeOpId ? { operation_id: safeOpId } : {}),
          accepted_at: toIsoTimestamp(acceptedAt),
          deadline_at: toIsoTimestamp(deadlineAt),
        },
      });
    },
    trackTaskTerminal({
      taskId,
      taskType,
      projectId,
      outcome,
      applied,
      terminalAt,
      errorCode,
      runId,
      operationId,
      userId,
      entrypoint = 'worker',
    }) {
      if (!uuid.test(taskId)) return;
      const safeProjectId = sanitizeCode(projectId);
      const safeErrorCode = outcome === 'failure' ? sanitizeCode(errorCode) : undefined;
      const safeRunId = runId && uuid.test(runId) ? runId : undefined;
      const safeOpId = operationId && uuid.test(operationId) ? operationId : undefined;

      emitServerEvent({
        event: 'task_terminal',
        entrypoint,
        userId,
        anonymousId: taskId,
        properties: {
          task_id: taskId,
          task_type: taskType,
          ...(safeProjectId ? { project_id: safeProjectId } : {}),
          ...(safeRunId ? { run_id: safeRunId } : {}),
          ...(safeOpId ? { operation_id: safeOpId } : {}),
          outcome,
          applied,
          terminal_at: toIsoTimestamp(terminalAt),
          ...(safeErrorCode ? { error_code: safeErrorCode } : {}),
        },
      });
    },
    trackExportResult({
      jobId,
      jobState,
      durationMs,
      technicalCheck,
      failureStage,
      errorCode,
      userId,
    }) {
      if (!uuid.test(jobId)) return;
      emitServerEvent({
        event: 'export_result',
        entrypoint: 'worker',
        userId,
        anonymousId: jobId,
        properties: {
          job_id: jobId,
          job_state: jobState,
          duration_ms: clampDurationMs(durationMs),
          technical_check: technicalCheck,
          ...(jobState === 'failed'
            ? {
                failure_stage: normalizeExportFailureStage(failureStage),
                error_code: normalizeExportFailureCode(errorCode),
              }
            : {}),
        },
      });
    },
    trackMcpToolFinished({
      canonicalToolName,
      publicToolName,
      args,
      callId,
      operationId,
      accepted,
      outcome,
      durationMs,
      replayed,
      error,
      userId,
    }) {
      if (!MCP_TOOL_NAME_SET.has(canonicalToolName)) return;
      const safeCallId = callId && uuid.test(callId) ? callId : crypto.randomUUID();
      const safeOpId = operationId && uuid.test(operationId) ? operationId : undefined;
      const inputDimensions = publicToolName ? toolInputFields(publicToolName, args) : {};
      const failureDimensions = outcome === 'failure' ? toolFailureFields(error) : {};

      emitServerEvent({
        event: 'mcp_tool_finished',
        entrypoint: 'mcp',
        userId,
        anonymousId: safeCallId,
        tracertEntrypoint: 'mcp',
        properties: {
          tool_name: canonicalToolName,
          ...inputDimensions,
          call_id: safeCallId,
          ...(safeOpId ? { operation_id: safeOpId } : {}),
          accepted,
          outcome,
          duration_ms: clampDurationMs(durationMs),
          ...(replayed !== undefined ? { replayed } : {}),
          ...failureDimensions,
        },
      });
    },
    async flush(flushOptions) {
      const timeoutMs = flushOptions?.timeoutMs ?? 3000;
      await Promise.allSettled([
        drainPosthogTracker(studioTracker, timeoutMs),
        drainPosthogTracker(serverTracker, timeoutMs),
        drainPosthogTracker(workerTracker, timeoutMs),
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
        drainPosthogTracker(studioTracker, timeoutMs),
        drainPosthogTracker(serverTracker, timeoutMs),
        drainPosthogTracker(workerTracker, timeoutMs),
        tracertNode ? tracertNode.shutdown({ timeoutMs }) : Promise.resolve(),
      ]);
      studioTracker?.close();
      serverTracker?.close();
      workerTracker?.close();
    },
  };
}
