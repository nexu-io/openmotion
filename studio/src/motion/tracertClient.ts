import type {
  CaptureOptions,
  ConsentState,
  ContextScope,
  FlushResult,
  Properties,
  TracertConfig,
} from '@powerformer/tracert';
import {
  readTrackingRuntimeConfigFromDocument,
  type BrowserTracertConfig,
} from '../../../shared/tracking-runtime-config.ts';
import { deviceContext } from '../../../tracking/core.ts';

export interface TracertClientLike {
  init(config: TracertConfig): unknown;
  capture(event: string, props?: Properties, options?: CaptureOptions): unknown;
  identify(id: string, traits?: Properties): void;
  reset(): void;
  setContext(scope: ContextScope, props: Properties): void;
  clearContext(scope: ContextScope): void;
  setConsent(consent: ConsentState): void;
  flush(options?: { timeoutMs?: number }): Promise<FlushResult>;
  destroy(): void;
  toPosthog?: () => { get_property?: (key: string) => unknown };
}

export interface TracertModuleLike {
  Tracert: new () => TracertClientLike;
}

export type TracertSdkLoader = () => Promise<TracertModuleLike>;

export interface TrackingUserIdentity {
  readonly signedIn: boolean;
  readonly userId?: string | null;
  readonly workspaceId?: string | null;
  readonly workspaceRole?: string | null;
  readonly planTier?: string | null;
}

type QueuedTracertOp =
  | {
      readonly kind: 'capture';
      readonly event: string;
      readonly properties: Record<string, unknown>;
      readonly eventId: string;
      readonly occurredAt: Date;
    }
  | { readonly kind: 'identify'; readonly identity: TrackingUserIdentity }
  | { readonly kind: 'reset' };

const MAX_BOOT_QUEUE = 100;
const MAX_IDENTITY_LENGTH = 256;
const MAX_TAG_LENGTH = 128;

let activeConfig: BrowserTracertConfig | null = null;
let activeClient: TracertClientLike | null = null;
let loadPromise: Promise<boolean> | null = null;
let customLoader: TracertSdkLoader | null = null;
let enabled = false;
let bootEpoch = 0;
let queuedOps: QueuedTracertOp[] = [];
let pendingIdentity: TrackingUserIdentity | null = null;
let lastIdentifiedUserId: string | null = null;
let lastUserContextKey = '';

function isTestEnvironment(): boolean {
  try {
    return Boolean(
      (import.meta as { env?: { MODE?: string; VITEST?: unknown } }).env?.MODE === 'test' ||
        (import.meta as { env?: { VITEST?: unknown } }).env?.VITEST,
    );
  } catch {
    return false;
  }
}

function browserDntEnabled(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.doNotTrack === '1';
  } catch {
    return false;
  }
}

function detectClientType(): 'desktop' | 'web' {
  try {
    if (typeof window !== 'undefined' && '__OPENMOTION_DESKTOP__' in window) {
      return 'desktop';
    }
  } catch {
    // Ignore restricted global access.
  }
  return 'web';
}

function safeTrim(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return undefined;
  return trimmed;
}

/**
 * Strips `undefined`, non-finite numbers, and unsupported values before invoking
 * Tracert native `capture()` or `setContext()`. Defense-in-depth alongside
 * `@powerformer/tracert` 0.6+ (which omits `undefined` but still rejects NaN/Infinity/non-JSON values).
 */
export function sanitizeTracertProperties(
  props: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const cleaned: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!key || key.length > 128 || value === undefined) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      cleaned[key] = value;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function buildRuntimeContext(config: BrowserTracertConfig): Record<string, string | number | boolean | null> {
  let tz: string | null = null;
  let utcOffset = 0;
  let locale: string | undefined;
  try {
    const dev = deviceContext();
    tz = dev.device_timezone;
    utcOffset = dev.utc_offset_minutes;
    locale = Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    // Ignore restricted Intl implementations.
  }

  return sanitizeTracertProperties({
    product: 'openmotion',
    entrypoint: 'studio',
    runtime: 'browser',
    client_type: detectClientType(),
    capture_source: 'explicit',
    event_schema_version: 1,
    env: config.environment,
    ...(config.appVersion ? { app_version: config.appVersion } : {}),
    ...(tz ? { device_timezone: tz } : {}),
    utc_offset_minutes: utcOffset,
    ...(locale ? { locale } : {}),
  });
}

function buildUserContext(identity: TrackingUserIdentity): Record<string, string | number | boolean | null> {
  const workspaceId = safeTrim(identity.workspaceId, MAX_TAG_LENGTH);
  const workspaceRole = safeTrim(identity.workspaceRole, 64);
  const rawPlan = safeTrim(identity.planTier, 64)?.toLowerCase();
  const planTier = rawPlan && rawPlan !== 'unknown' && rawPlan !== 'cloud' ? rawPlan : undefined;

  return sanitizeTracertProperties({
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(workspaceRole ? { workspace_role: workspaceRole } : {}),
    ...(planTier ? { plan_tier: planTier } : {}),
  });
}

function readPersistedSdkUserId(client: TracertClientLike): string | null {
  try {
    const userId = client.toPosthog?.()?.get_property?.('$user_id');
    return typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
  } catch {
    return null;
  }
}

function applyIdentityToClient(client: TracertClientLike, identity: TrackingUserIdentity): void {
  if (!enabled || browserDntEnabled()) return;
  try {
    if (identity.signedIn) {
      const canonicalUserId = safeTrim(identity.userId, MAX_IDENTITY_LENGTH);
      if (canonicalUserId && canonicalUserId !== lastIdentifiedUserId) {
        client.identify(canonicalUserId);
        lastIdentifiedUserId = canonicalUserId;
      }
      const userContext = buildUserContext(identity);
      const serializedKey = JSON.stringify(userContext);
      if (serializedKey !== lastUserContextKey) {
        client.clearContext('user');
        if (Object.keys(userContext).length > 0) {
          client.setContext('user', userContext);
        }
        lastUserContextKey = serializedKey;
      }
    } else {
      // Clear previously authenticated SDK identity when a session expires or is revoked
      // (including identities restored from storage across reloads), while avoiding reset()
      // for genuinely anonymous visitors so anonymous device_id continuity is preserved.
      const hadAuthenticatedIdentity =
        lastIdentifiedUserId !== null || readPersistedSdkUserId(client) !== null;
      lastIdentifiedUserId = null;
      if (lastUserContextKey !== '') {
        client.clearContext('user');
        lastUserContextKey = '';
      }
      if (hadAuthenticatedIdentity) {
        client.clearContext('user');
        client.reset();
      }
    }
  } catch {
    // Identity sync must never break application UI.
  }
}

function applyCaptureToClient(
  client: TracertClientLike,
  event: string,
  properties: Record<string, unknown>,
  eventId: string,
  occurredAt: Date,
): void {
  if (!enabled || browserDntEnabled()) return;
  try {
    const cleanProps = sanitizeTracertProperties(properties);
    client.capture(event, cleanProps, {
      uuid: eventId,
      timestamp: occurredAt,
    });
  } catch {
    // Telemetry failures must never disrupt caller execution.
  }
}

function applyResetToClient(client: TracertClientLike): void {
  try {
    lastIdentifiedUserId = null;
    lastUserContextKey = '';
    client.clearContext('user');
    if (enabled && !browserDntEnabled()) {
      client.reset();
    }
  } catch {
    // Reset failures must never block sign-out.
  }
}

function enqueueBootOp(op: QueuedTracertOp): void {
  if (queuedOps.length >= MAX_BOOT_QUEUE) return;
  queuedOps.push(op);
}

function replayBootQueue(client: TracertClientLike): void {
  const ops = queuedOps;
  queuedOps = [];

  if (pendingIdentity) {
    const snapshot = pendingIdentity;
    pendingIdentity = null;
    applyIdentityToClient(client, snapshot);
  }

  for (const op of ops) {
    if (!enabled || browserDntEnabled()) return;
    if (op.kind === 'reset') {
      applyResetToClient(client);
    } else if (op.kind === 'identify') {
      applyIdentityToClient(client, op.identity);
    } else if (op.kind === 'capture') {
      applyCaptureToClient(client, op.event, op.properties, op.eventId, op.occurredAt);
    }
  }
}

function initializeClientInstance(
  sdkModule: TracertModuleLike,
  config: BrowserTracertConfig,
): boolean {
  try {
    const client = new sdkModule.Tracert();
    const initConfig: TracertConfig = {
      spmA: config.spmA,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      environment: config.environment,
      ...(config.appVersion ? { appVersion: config.appVersion } : {}),
      enabled: true,
      consent: { initial: 'granted' },
      // Explicit closed-schema events only; avoid duplicate page_view/surface_view plugins.
      plugins: [],
    };
    client.init(initConfig);
    // Explicitly force-sync consent after init() so stale localStorage consent state
    // cannot override the authoritative runtime/preference decision.
    client.setConsent('granted');
    client.setContext('runtime', buildRuntimeContext(config));
    activeClient = client;
    replayBootQueue(client);
    return true;
  } catch {
    activeClient = null;
    queuedOps = [];
    return false;
  }
}

function ensureClientLoading(): void {
  if (!enabled || !activeConfig || browserDntEnabled()) return;
  if (activeClient || loadPromise) return;
  if (isTestEnvironment() && !customLoader) return;

  const config = activeConfig;
  const epoch = ++bootEpoch;
  const loader: TracertSdkLoader =
    customLoader ?? (async () => (await import('@powerformer/tracert')) as unknown as TracertModuleLike);

  let promise: Promise<TracertModuleLike>;
  try {
    promise = Promise.resolve(loader());
  } catch (error) {
    promise = Promise.reject(error);
  }

  loadPromise = promise
    .then((mod) => {
      if (epoch !== bootEpoch || !enabled || browserDntEnabled() || activeConfig !== config) {
        return false;
      }
      return initializeClientInstance(mod, config);
    })
    .catch(() => {
      if (epoch === bootEpoch) {
        queuedOps = [];
      }
      return false;
    })
    .finally(() => {
      if (epoch === bootEpoch) {
        loadPromise = null;
      }
    });
}

function disableActiveClient(): void {
  bootEpoch += 1;
  queuedOps = [];
  pendingIdentity = null;
  lastIdentifiedUserId = null;
  lastUserContextKey = '';
  loadPromise = null;
  if (activeClient) {
    try {
      // `setConsent('denied')` clears both the in-memory queue and cross-page sessionStorage outbox.
      activeClient.setConsent('denied');
    } catch {
      // Ignore cleanup errors.
    }
  }
}

/**
 * Configures the optional Tracert sink from runtime config.
 * When `config` is `null` (e.g. self-hosted without `OPENMOTION_TRACERT_SPM_A`),
 * `@powerformer/tracert` is never imported and zero requests are emitted.
 */
export function configureTracert(
  config: BrowserTracertConfig | null,
  shouldEnable: boolean,
): void {
  const prevConfig = activeConfig;
  const configChanged =
    Boolean(prevConfig) !== Boolean(config) ||
    prevConfig?.spmA !== config?.spmA ||
    prevConfig?.endpoint !== config?.endpoint ||
    prevConfig?.environment !== config?.environment ||
    prevConfig?.appVersion !== config?.appVersion;

  if (configChanged) {
    bootEpoch += 1;
    loadPromise = null;
    if (activeClient) {
      try {
        activeClient.setConsent('denied');
        activeClient.destroy();
      } catch {
        // Ignore destroy errors.
      }
      activeClient = null;
      lastIdentifiedUserId = null;
      lastUserContextKey = '';
    }
    activeConfig = config;
  }

  setTracertEnabled(Boolean(activeConfig) && shouldEnable);
}

export function setTracertEnabled(nextEnabled: boolean): void {
  const effective = Boolean(nextEnabled) && Boolean(activeConfig) && !browserDntEnabled();
  enabled = effective;

  if (!effective) {
    disableActiveClient();
    return;
  }

  if (activeClient && activeConfig) {
    try {
      activeClient.setConsent('granted');
      activeClient.setContext('runtime', buildRuntimeContext(activeConfig));
      replayBootQueue(activeClient);
    } catch {
      // Ignore re-enable errors.
    }
    return;
  }

  ensureClientLoading();
}

export function captureTracertEvent(
  event: string,
  properties: Record<string, unknown>,
  options: { readonly eventId: string; readonly occurredAt: Date },
): void {
  if (!enabled || !activeConfig || browserDntEnabled()) return;
  if (activeClient) {
    applyCaptureToClient(activeClient, event, properties, options.eventId, options.occurredAt);
    return;
  }
  enqueueBootOp({
    kind: 'capture',
    event,
    properties: sanitizeTracertProperties(properties),
    eventId: options.eventId,
    occurredAt: options.occurredAt,
  });
  ensureClientLoading();
}

export function syncTracertIdentity(identity: TrackingUserIdentity): void {
  if (!activeConfig && !browserDntEnabled()) {
    const injected = readTrackingRuntimeConfigFromDocument();
    if (injected?.enabled && injected.tracert) {
      configureTracert(injected.tracert, true);
    }
  }
  if (!activeConfig) {
    // Remember latest identity so if tracking finishes initializing right after account
    // hydration, the user is still identified promptly.
    pendingIdentity = identity;
    return;
  }
  if (!enabled || browserDntEnabled()) {
    pendingIdentity = identity;
    return;
  }
  if (activeClient) {
    applyIdentityToClient(activeClient, identity);
    return;
  }
  pendingIdentity = identity;
  enqueueBootOp({ kind: 'identify', identity });
  ensureClientLoading();
}

export function resetTracertIdentity(): void {
  pendingIdentity = null;
  if (activeClient) {
    applyResetToClient(activeClient);
    return;
  }
  lastIdentifiedUserId = null;
  lastUserContextKey = '';
  if (enabled && activeConfig) {
    enqueueBootOp({ kind: 'reset' });
  }
}

export async function flushTracert(timeoutMs = 2000): Promise<void> {
  if (!enabled || !activeConfig || browserDntEnabled()) return;
  try {
    if (loadPromise && !activeClient) {
      await Promise.race([
        loadPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs);
        }),
      ]);
    }
    if (activeClient) {
      await activeClient.flush({ timeoutMs });
    }
  } catch {
    // Flush is best effort.
  }
}

export function isTracertConfigured(): boolean {
  return activeConfig !== null;
}

export function isTracertEnabled(): boolean {
  return enabled && activeConfig !== null && !browserDntEnabled();
}

export function getTracertStatus() {
  return {
    configured: activeConfig !== null,
    loaded: activeClient !== null,
    enabled: isTracertEnabled(),
    queued: queuedOps.length,
  };
}

/** Test-only hook to inject a deterministic fake or instrumented Tracert SDK module. */
export function setTracertSdkLoaderForTests(loader: TracertSdkLoader | null): void {
  customLoader = loader;
}

export function resetTracertForTests(): void {
  bootEpoch += 1;
  enabled = false;
  queuedOps = [];
  pendingIdentity = null;
  lastIdentifiedUserId = null;
  lastUserContextKey = '';
  loadPromise = null;
  if (activeClient) {
    try {
      activeClient.setConsent('denied');
      activeClient.destroy();
    } catch {
      // Ignore test teardown errors.
    }
    activeClient = null;
  }
  activeConfig = null;
  customLoader = null;
}
