import { createBrowserTracking } from '../../../tracking/browser.ts';
import { deviceContext, validProperties } from '../../../tracking/core.ts';
import { studioEvents } from '../../../tracking/events.ts';
import type { StudioEvent } from '../../../tracking/events.ts';
import type { EventFields } from '../../../tracking/core.ts';
import {
  parseTrackingRuntimeConfigResponse,
  readTrackingRuntimeConfigFromDocument,
  type BrowserTrackingRuntimeConfig,
} from '../../../shared/tracking-runtime-config.ts';
import {
  captureTracertEvent,
  configureTracert,
  flushTracert,
  getTracertStatus,
  isTracertEnabled,
  resetTracertForTests,
  resetTracertIdentity,
  setTracertEnabled,
  syncTracertIdentity,
  type TrackingUserIdentity,
} from './tracertClient.ts';

export type { TrackingUserIdentity };

const tracking = createBrowserTracking({
  registry: studioEvents,
  endpoint: '/motion-api/tracking',
  enabled: false,
  isEnabled: () => navigator.doNotTrack !== '1',
});

let initialization: Promise<void> | undefined;
let configuration: 'uninitialized' | 'loading' | 'ready' | 'disabled' | 'unavailable' = 'uninitialized';
let controller: AbortController | undefined;
let retryAt = 0;
let posthogEnabled = true;
const tracertOnlySeen = new Set<string>();

function applyRuntimeConfig(runtimeConfig: BrowserTrackingRuntimeConfig): void {
  posthogEnabled = runtimeConfig.posthogEnabled;
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
  if (configuration === 'disabled' || configuration === 'ready' || navigator.doNotTrack === '1') return Promise.resolve();
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
  if (configuration === 'unavailable' && navigator.doNotTrack !== '1') return 'config_unavailable' as const;
  if (navigator.doNotTrack === '1') return 'disabled' as const;

  const usePosthog = posthogEnabled && tracking.enabled();
  const useTracert = isTracertEnabled();
  if (!usePosthog && !useTracert) return 'disabled' as const;

  if (!validProperties(studioEvents, event, properties)) return 'invalid' as const;

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

  if (tracertOnlySeen.has(eventId)) return 'duplicate' as const;
  tracertOnlySeen.add(eventId);
  if (tracertOnlySeen.size > 2048) {
    const oldest = tracertOnlySeen.values().next().value;
    if (oldest !== undefined) tracertOnlySeen.delete(oldest);
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

export function syncMotionTrackingIdentity(identity: TrackingUserIdentity) {
  if (configuration === 'uninitialized' && navigator.doNotTrack !== '1') {
    hydrateInjectedConfigIfPresent();
  }
  syncTracertIdentity(identity);
}

export function resetMotionTrackingIdentity() {
  resetTracertIdentity();
}

export function resetMotionTrackingForTests() {
  controller?.abort();
  controller = undefined;
  initialization = undefined;
  configuration = 'uninitialized';
  retryAt = 0;
  posthogEnabled = true;
  tracertOnlySeen.clear();
  tracking.setEnabled(false);
  resetTracertForTests();
}

window.addEventListener('pagehide', () => {
  void tracking.flush();
  void flushTracert();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void tracking.flush();
    void flushTracert();
  }
});
