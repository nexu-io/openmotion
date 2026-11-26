let currentAppUserId: string | null = null;
let trackingConsented = false;

export function setMotionTrackingUserId(appUserId: string | null | undefined): void {
  const trimmed = typeof appUserId === 'string' ? appUserId.trim() : '';
  currentAppUserId = trimmed.length > 0 ? trimmed : null;
}

export function getMotionTrackingUserId(): string | null {
  return currentAppUserId;
}

export function setMotionTrackingConsented(consented: boolean): void {
  trackingConsented = Boolean(consented);
}

export function isMotionTrackingConsented(): boolean {
  if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') {
    return false;
  }
  return trackingConsented;
}
