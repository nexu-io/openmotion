import { createBrowserTracking } from '../../../tracking/browser.ts';
import { studioEvents } from '../../../tracking/events.ts';
import type { StudioEvent } from '../../../tracking/events.ts';
import type { EventFields } from '../../../tracking/core.ts';
import {
  getMotionTrackingUserId,
  setMotionTrackingConsented,
  setMotionTrackingUserId,
} from './trackingIdentity';

export { getMotionTrackingUserId, setMotionTrackingUserId };

// Created on first use so importing this module (e.g. through AccountSettings -> googleOneTap) stays
// side-effect free outside a browser; nothing can be pending before the first use.
let browserTracking: ReturnType<typeof createBrowserTracking<typeof studioEvents>> | undefined;
function getTracking() {
  if (!browserTracking) {
    const created = createBrowserTracking({ registry: studioEvents, endpoint: '/motion-api/tracking', enabled: false,
      isEnabled: () => navigator.doNotTrack !== '1', getAppUserId: getMotionTrackingUserId });
    browserTracking = created;
    window.addEventListener('pagehide', () => { void created.flush(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void created.flush(); });
  }
  return browserTracking;
}
let initialization: Promise<void> | undefined;
let configuration: 'uninitialized' | 'loading' | 'ready' | 'disabled' | 'unavailable' = 'uninitialized';
let controller: AbortController | undefined;
let retryAt = 0;
let explicitDeviceIdConsented = false;

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
        const config: unknown = await response.json();
        if (!config || typeof config !== 'object' || !('enabled' in config) || typeof config.enabled !== 'boolean') throw new Error('INVALID_CONFIG');
        if (request.signal.aborted) return;
        getTracking().setEnabled(config.enabled);
        // Server availability (`config.enabled`) is NEVER user consent for device-ID transmission.
        // Reflect the explicit `deviceIdConsented` boolean returned by /motion-api/tracking.
        explicitDeviceIdConsented =
          'deviceIdConsented' in config &&
          (config as { deviceIdConsented?: unknown }).deviceIdConsented === true;
        setMotionTrackingConsented(config.enabled && explicitDeviceIdConsented);
        configuration = config.enabled ? 'ready' : 'disabled'; retryAt = 0;
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
  return getTracking().track(event, properties);
}
export function getMotionTrackingStatus() {
  return { configuration, enabled: getTracking().enabled(), pending: getTracking().pending(), retryAfterMs: Math.max(0, retryAt - Date.now()) };
}
export function flushMotionTracking() { return getTracking().flush(); }
export function setMotionTrackingEnabled(enabled: boolean) {
  controller?.abort(); retryAt = 0;
  getTracking().setEnabled(enabled);
  // Usage-data sharing preference is independent of explicit device-ID consent (`om_metrics_consent`).
  setMotionTrackingConsented(enabled && explicitDeviceIdConsented);
  configuration = enabled ? 'ready' : 'disabled';
}
export function setMotionDeviceIdConsented(consented: boolean) {
  explicitDeviceIdConsented = consented;
  setMotionTrackingConsented(consented && getTracking().enabled());
}

