/**
 * Helpers for reporting a failed Studio load from the shell.
 *
 * The retry page is the one place every load failure ends up, and it is shown
 * exactly when Studio (and its in-page reporting) is unavailable. These helpers
 * classify the failure, mint a short reference the user can read back to
 * support, and tell "this machine is offline" apart from "Studio is unreachable".
 */

import { randomBytes } from 'node:crypto';
import type { DesktopTelemetryOutcome } from '../../shared/desktop-telemetry.ts';

// No 0/O, 1/I/L: the reference is read aloud and copied from screenshots.
const INCIDENT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INCIDENT_LENGTH = 8;

export function createIncidentId(bytes: Uint8Array = randomBytes(INCIDENT_LENGTH)): string {
  let out = '';
  for (let index = 0; index < INCIDENT_LENGTH; index += 1) {
    if (index === INCIDENT_LENGTH / 2) out += '-';
    out += INCIDENT_ALPHABET[(bytes[index] ?? 0) % INCIDENT_ALPHABET.length];
  }
  return out;
}

export type LoadFailureClass = {
  outcome: Extract<DesktopTelemetryOutcome, 'timeout' | 'network_error' | 'error'>;
  /** Whether a reachability check can say anything useful about this failure. */
  network: boolean;
};

export function classifyLoadFailure(code: string | undefined): LoadFailureClass {
  if (code === 'NET_TIMEOUT') return { outcome: 'timeout', network: true };
  if (code === 'LOAD_FAILED' || code?.startsWith('NET_')) {
    return { outcome: 'network_error', network: true };
  }
  return { outcome: 'error', network: false };
}

export type ConnectivityVerdict = 'offline' | 'studio_unreachable' | 'not_checked';

type ProbeFetch = (
  url: string,
  init: { method: 'HEAD'; cache: 'no-store'; signal: AbortSignal },
) => Promise<unknown>;

/**
 * Probes a host the shell already depends on (the release bucket). Any HTTP
 * response proves the network path works, so the failure is on the Studio side;
 * a transport error means the machine itself is offline or blocked.
 */
export async function probeConnectivity(
  referenceUrl: string,
  fetchImpl: ProbeFetch,
  timeoutMs = 3_000,
): Promise<Exclude<ConnectivityVerdict, 'not_checked'>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(referenceUrl, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
    return 'studio_unreachable';
  } catch {
    return 'offline';
  } finally {
    clearTimeout(timer);
  }
}
