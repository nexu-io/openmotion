import { METRICS_CONSENT_COOKIE_NAME, METRICS_CONSENT_GRANTED } from '../../../shared/metrics-consent.ts';
import { rotateBrowserTrackingDeviceId } from './trackingDeviceId.ts';
import {
  isTracertEnabled,
  resetTracertIdentity,
  syncTracertIdentity,
  type TrackingUserIdentity,
} from './tracertClient.ts';

export type { TrackingUserIdentity };

interface TrackingIdentityHooks {
  readonly onBeforeSync?: () => void;
  readonly onReset?: () => void;
}

let lastSyncedIdentityKey: string | null = null;
let hooks: TrackingIdentityHooks = {};

export function registerTrackingIdentityHooks(nextHooks: TrackingIdentityHooks): void {
  hooks = nextHooks;
}

function identityKeyFor(identity: TrackingUserIdentity): string | null {
  if (!identity.signedIn) return null;
  const trimmed = typeof identity.userId === 'string' ? identity.userId.trim() : '';
  return trimmed || '__signed_in__';
}

export function syncMotionTrackingIdentity(identity: TrackingUserIdentity): void {
  hooks.onBeforeSync?.();
  const nextIdentityKey = identityKeyFor(identity);
  const signedOutAfterSignIn = nextIdentityKey === null && lastSyncedIdentityKey !== null;
  const switchedAccount =
    nextIdentityKey !== null &&
    lastSyncedIdentityKey !== null &&
    nextIdentityKey !== lastSyncedIdentityKey;
  lastSyncedIdentityKey = nextIdentityKey;

  if (signedOutAfterSignIn || switchedAccount) {
    // Discard pending browser batches and abort in-flight retries before
    // identity or device_id changes so queued events never cross accounts.
    hooks.onReset?.();
  }
  syncTracertIdentity(identity);
  if (signedOutAfterSignIn && !isTracertEnabled()) {
    rotateBrowserTrackingDeviceId();
  }
}

export function resetMotionTrackingIdentity(): void {
  lastSyncedIdentityKey = null;
  hooks.onReset?.();
  resetTracertIdentity();
}

export function resetMotionTrackingIdentityStateForTests(): void {
  lastSyncedIdentityKey = null;
}

// Google One Tap device-ID attribution. The OpenDesign device ID joins One Tap sign-in attribution only
// while usage tracking is active for this page and the visitor granted explicit device-ID consent
// (the `om_metrics_consent` cookie written by POST /motion-api/tracking/consent). Usage tracking alone
// is never device-ID consent; the server applies the same cookie check before forwarding it to AMR.
let usageTrackingActive = false;

export function setMotionUsageTrackingActive(active: boolean): void {
  usageTrackingActive = Boolean(active);
}

function hasExplicitDeviceIdConsent(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const granted = `${METRICS_CONSENT_COOKIE_NAME}=${METRICS_CONSENT_GRANTED}`;
    return document.cookie.split(';').some(part => part.trim() === granted);
  } catch {
    return false;
  }
}

export function isMotionDeviceIdConsented(): boolean {
  if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return false;
  return usageTrackingActive && hasExplicitDeviceIdConsent();
}
