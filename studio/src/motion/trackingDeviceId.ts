const STORAGE_KEY = 'openmotion:tracking:device_id';
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

let cachedDeviceId: string | null = null;

function sanitizeDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return DEVICE_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function readStoredDeviceId(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return sanitizeDeviceId(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredDeviceId(value: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, value);
    }
  } catch {
    // Ignore storage quota or restricted-mode errors.
  }
}

function removeStoredDeviceId(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage cleanup errors.
  }
}

/**
 * Returns a persistent browser-scoped anonymous `device_id` for cloud PostHog tracking.
 * Stays stable across anonymous reloads and rotates on sign-out or expired-session reset
 * so shared browsers never mix two users' anonymous identity.
 */
export function getBrowserTrackingDeviceId(): string {
  const stored = readStoredDeviceId();
  if (stored) {
    cachedDeviceId = stored;
    return stored;
  }
  if (cachedDeviceId) {
    writeStoredDeviceId(cachedDeviceId);
    return cachedDeviceId;
  }
  const generated = crypto.randomUUID();
  cachedDeviceId = generated;
  writeStoredDeviceId(generated);
  return generated;
}

/**
 * Adopts an externally persisted SDK device ID (e.g. Tracert `$device_id`) if no local ID exists yet,
 * keeping PostHog and Tracert anonymous browser IDs aligned when both sinks are active.
 */
export function syncBrowserTrackingDeviceId(candidate: unknown): void {
  const valid = sanitizeDeviceId(candidate);
  if (!valid) return;
  if (!readStoredDeviceId() && !cachedDeviceId) {
    cachedDeviceId = valid;
    writeStoredDeviceId(valid);
  }
}

/** Rotates the browser anonymous `device_id` (called on explicit sign-out or expired-session reset). */
export function rotateBrowserTrackingDeviceId(replacement?: unknown): string {
  const next = sanitizeDeviceId(replacement) ?? crypto.randomUUID();
  cachedDeviceId = next;
  writeStoredDeviceId(next);
  return next;
}

export function resetBrowserTrackingDeviceIdForTests(): void {
  cachedDeviceId = null;
  removeStoredDeviceId();
}
