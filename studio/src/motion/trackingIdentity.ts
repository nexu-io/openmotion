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
