import { getCachedCloudDisklessMode, useCloudDisklessMode } from '../utils/cloudRuntime';
import { ENTITLEMENT_HOOK_IDS, type EntitlementHookId } from '../../../shared/entitlement-hooks';

export { ENTITLEMENT_HOOK_IDS, type EntitlementHookId };

export type EntitlementModalMode = 'guest' | 'upgrade';

export interface EntitlementModalRequest {
  mode: EntitlementModalMode;
  hookId: EntitlementHookId;
  triggerLabel?: string;
  returnTo?: string;
}

type ModalListener = (request: EntitlementModalRequest) => void;

const listeners = new Set<ModalListener>();
let pendingCheckout: { hookId?: EntitlementHookId; entryId?: string; at: number } | null = null;

export function hasEntitlementModalListeners(): boolean {
  return listeners.size > 0;
}

/** True when running in Cloud diskless web mode (never enables cloud-only monetization in local/self-hosted Studio). */
export function isCloudWebMode(): boolean {
  return getCachedCloudDisklessMode();
}

/** Reactive React hook returning whether Studio is running in Cloud diskless web mode. */
export function useCloudWebMode(): boolean {
  return useCloudDisklessMode();
}

export function openEntitlementModal(request: EntitlementModalRequest): void {
  for (const listener of listeners) {
    listener(request);
  }
}

export function subscribeEntitlementModal(listener: ModalListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Mark that the user opened an external pricing/checkout flow (e.g. header Pricing,
 * Black Friday banner, or Upgrade modal) so returning to this window automatically
 * triggers a fresh billing & provider sync.
 */
export function markExternalCheckoutPending(hookId?: EntitlementHookId, entryId?: string): void {
  pendingCheckout = { hookId, entryId, at: Date.now() };
}

export function consumeExternalCheckoutPending(): { hookId?: EntitlementHookId; entryId?: string } | null {
  if (!pendingCheckout) return null;
  const current = pendingCheckout;
  pendingCheckout = null;
  return { hookId: current.hookId, entryId: current.entryId };
}
