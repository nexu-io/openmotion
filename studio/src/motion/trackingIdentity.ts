let currentAppUserId: string | null = null;

export function setMotionTrackingUserId(appUserId: string | null | undefined): void {
  const trimmed = typeof appUserId === 'string' ? appUserId.trim() : '';
  currentAppUserId = trimmed.length > 0 ? trimmed : null;
}

export function getMotionTrackingUserId(): string | null {
  return currentAppUserId;
}
