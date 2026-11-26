import { createBrowserTracking } from '../../../tracking/browser.ts';
import { deviceContext, validProperties } from '../../../tracking/core.ts';
import { studioEvents } from '../../../tracking/events.ts';
import type { StudioEvent } from '../../../tracking/events.ts';
import type { EventFields } from '../../../tracking/core.ts';
import {
  isCloudBrowserEventAllowed,
  parseTrackingRuntimeConfigResponse,
  readTrackingRuntimeConfigFromDocument,
  type BrowserTrackingRuntimeConfig,
} from '../../../shared/tracking-runtime-config.ts';
import {
  getBrowserTrackingDeviceId,
  resetBrowserTrackingDeviceIdForTests,
} from './trackingDeviceId.ts';
import {
  captureTracertEvent,
  configureTracert,
  flushTracert,
  getTracertStatus,
  isTracertEnabled,
  resetTracertForTests,
  setTracertEnabled,
  setTracertIdentityResetListener,
  type TrackingUserIdentity,
} from './tracertClient.ts';
import {
  registerTrackingIdentityHooks,
  resetMotionTrackingIdentity,
  resetMotionTrackingIdentityStateForTests,
  syncMotionTrackingIdentity,
} from './trackingIdentity.ts';

export type { TrackingUserIdentity };
export { resetMotionTrackingIdentity, syncMotionTrackingIdentity };

function isDoNotTrackEnabled(): boolean {
  return typeof navigator !== 'undefined' && navigator.doNotTrack === '1';
}

function createNoopBrowserTracker(): ReturnType<typeof createBrowserTracking<typeof studioEvents>> {
  let isEnabled = false;
  return {
    track: () => 'disabled',
    ingest: () => 'disabled',
    flush: async () => 'disabled',
    close: async () => 'disabled',
    pending: () => 0,
    enabled: () => isEnabled,
    setEnabled: (next: boolean) => {
      isEnabled = Boolean(next);
    },
    reset: () => {},
  };
}

const tracking =
  typeof window !== 'undefined'
    ? createBrowserTracking({
        registry: studioEvents,
        endpoint: '/motion-api/tracking',
        enabled: false,
        isEnabled: () => !isDoNotTrackEnabled(),
        getDeviceId: () => getBrowserTrackingDeviceId(),
      })
    : createNoopBrowserTracker();

// If Tracert clears a persisted authenticated identity discovered from storage
// after reload, discard any pre-hydration queued PostHog events before device_id rotates.
setTracertIdentityResetListener(() => {
  tracking.reset();
});

let initialization: Promise<void> | undefined;
let configuration: 'uninitialized' | 'loading' | 'ready' | 'disabled' | 'unavailable' = 'uninitialized';
let controller: AbortController | undefined;
let retryAt = 0;
let posthogEnabled = true;
let allowlistEnabled = false;

function applyRuntimeConfig(runtimeConfig: BrowserTrackingRuntimeConfig): void {
  posthogEnabled = runtimeConfig.posthogEnabled;
  allowlistEnabled = runtimeConfig.allowlistEnabled;
  tracking.setEnabled(runtimeConfig.enabled && runtimeConfig.posthogEnabled);
  configureTracert(runtimeConfig.tracert, runtimeConfig.enabled);
  configuration = runtimeConfig.enabled ? 'ready' : 'disabled';
  retryAt = 0;
}

function hydrateInjectedConfigIfPresent(): boolean {
  const injected = readTrackingRuntimeConfigFromDocument();
  if (!injected) return false;
  applyRuntimeConfig(injected);
  return true;
}

function retryDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function initializeTracking() {
  if (configuration === 'disabled' || configuration === 'ready' || isDoNotTrackEnabled()) return Promise.resolve();
  if (hydrateInjectedConfigIfPresent()) return Promise.resolve();
  if (initialization) return initialization;
  if (Date.now() < retryAt) return Promise.resolve();
  const request = new AbortController(); controller = request; configuration = 'loading';
  initialization = (async () => {
    for (let attempt = 0; attempt < 3 && !request.signal.aborted; attempt++) {
      try {
        const response = await fetch('/motion-api/tracking', {
          redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(1000)]),
        });
        if (!response.ok) throw new Error('CONFIG_UNAVAILABLE');
        const raw: unknown = await response.json();
        const parsed = parseTrackingRuntimeConfigResponse(raw);
        if (!parsed) throw new Error('INVALID_CONFIG');
        if (request.signal.aborted) return;
        applyRuntimeConfig(parsed);
        return;
      } catch {
        if (request.signal.aborted) return;
        if (attempt < 2) await retryDelay(1000 * 2 ** attempt, request.signal);
      }
    }
    if (!request.signal.aborted) { configuration = 'unavailable'; retryAt = Date.now() + 30_000; }
  })().finally(() => { initialization = undefined; if (controller === request) controller = undefined; });
  return initialization;
}

export async function trackMotion<E extends StudioEvent>(event: E, properties: EventFields<typeof studioEvents[E]>) {
  await initializeTracking();
  if (configuration === 'unavailable' && !isDoNotTrackEnabled()) return 'config_unavailable' as const;
  if (isDoNotTrackEnabled()) return 'disabled' as const;

  const usePosthog = posthogEnabled && tracking.enabled();
  const useTracert = isTracertEnabled();
  if (!usePosthog && !useTracert) return 'disabled' as const;

  if (!validProperties(studioEvents, event, properties)) return 'invalid' as const;
  if (allowlistEnabled && !isCloudBrowserEventAllowed({ event, properties })) return 'disabled' as const;

  const eventId = crypto.randomUUID();
  const occurredAt = new Date();

  if (usePosthog) {
    const status = tracking.ingest({
      event,
      properties,
      event_id: eventId,
      occurred_at: occurredAt.toISOString(),
      entrypoint: 'studio',
      ...deviceContext(),
    });
    if (useTracert && (status === 'queued' || status === 'full')) {
      captureTracertEvent(event, properties as Record<string, unknown>, { eventId, occurredAt });
    }
    return status;
  }

  captureTracertEvent(event, properties as Record<string, unknown>, { eventId, occurredAt });
  return 'queued' as const;
}

export function getMotionTrackingStatus() {
  return {
    configuration,
    enabled: tracking.enabled() || isTracertEnabled(),
    pending: tracking.pending(),
    retryAfterMs: Math.max(0, retryAt - Date.now()),
  };
}

export function getMotionTrackingDiagnostics() {
  return {
    ...getMotionTrackingStatus(),
    posthogEnabled,
    allowlistEnabled,
    tracert: getTracertStatus(),
  };
}

export async function flushMotionTracking() {
  const tracertPromise = flushTracert();
  if (!posthogEnabled && isTracertEnabled()) {
    await tracertPromise;
    return 'accepted' as const;
  }
  const [receipt] = await Promise.all([tracking.flush(), tracertPromise]);
  if (receipt === 'accepted' && posthogEnabled && !tracking.enabled()) {
    // Same-origin PostHog receipt returned `{ enabled: false }`; mirror disablement to Tracert.
    setTracertEnabled(false);
  }
  return receipt;
}

export function setMotionTrackingEnabled(enabled: boolean) {
  controller?.abort(); retryAt = 0;
  tracking.setEnabled(enabled && posthogEnabled);
  setTracertEnabled(enabled);
  configuration = enabled ? 'ready' : 'disabled';
}

registerTrackingIdentityHooks({
  onBeforeSync: () => {
    if (configuration === 'uninitialized' && !isDoNotTrackEnabled()) {
      hydrateInjectedConfigIfPresent();
    }
  },
  onReset: () => {
    tracking.reset();
  },
});

export function resetMotionTrackingForTests() {
  controller?.abort();
  controller = undefined;
  initialization = undefined;
  configuration = 'uninitialized';
  retryAt = 0;
  posthogEnabled = true;
  allowlistEnabled = false;
  resetMotionTrackingIdentityStateForTests();
  tracking.reset();
  tracking.setEnabled(false);
  resetTracertForTests();
  resetBrowserTrackingDeviceIdForTests();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void tracking.flush();
    void flushTracert();
  });
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void tracking.flush();
      void flushTracert();
    }
  });
}
