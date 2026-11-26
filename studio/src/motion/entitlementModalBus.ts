import { getCachedCloudDisklessMode, useCloudDisklessMode } from '../utils/cloudRuntime';
import { ENTITLEMENT_HOOK_IDS, type EntitlementHookId } from '../../../shared/entitlement-hooks';

export { ENTITLEMENT_HOOK_IDS, type EntitlementHookId };

export type EntitlementModalMode = 'guest' | 'upgrade';
export type EntitlementGateReason =
  | 'guest_signin'
  | 'plan_locked'
  | 'insufficient_credits'
  | 'quota_exhausted'
  | 'resolution_locked'
  | 'session_expired'
  | 'other';

export interface EntitlementAttributionContext {
  modelId?: string;
  modelProvider?: string;
  modality?: 'image' | 'video' | 'audio';
  studioId?: string;
  sceneId?: string;
  gateReason?: EntitlementGateReason;
  userPlan?: string;
}

export interface EntitlementModalRequest {
  mode: EntitlementModalMode;
  hookId: EntitlementHookId;
  triggerLabel?: string;
  returnTo?: string;
  entryId?: string;
  attribution?: EntitlementAttributionContext;
}

type ModalListener = (request: EntitlementModalRequest) => void;

const listeners = new Set<ModalListener>();
let pendingCheckout: {
  hookId?: EntitlementHookId;
  entryId?: string;
  attribution?: EntitlementAttributionContext;
  at: number;
} | null = null;

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

const SLUG_RE = /^(?=.{1,64}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const CODE_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function cleanSlug(value?: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return SLUG_RE.test(normalized) ? normalized : undefined;
}

function cleanCode(value?: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 128);
  return CODE_RE.test(normalized) ? normalized : undefined;
}

/** Convert optional attribution context into schema-safe tracking properties. */
export function entitlementAttributionFields(context?: EntitlementAttributionContext) {
  if (!context) return {};
  const modelId = cleanCode(context.modelId);
  const modelProvider = cleanSlug(context.modelProvider);
  const studioId = cleanSlug(context.studioId);
  const sceneId = cleanSlug(context.sceneId);
  const userPlan = cleanCode(context.userPlan?.toLowerCase());
  return {
    ...(context.gateReason ? { gate_reason: context.gateReason } : {}),
    ...(userPlan ? { user_plan: userPlan } : {}),
    ...(context.modality ? { modality: context.modality } : {}),
    ...(studioId ? { studio_id: studioId } : {}),
    ...(sceneId ? { scene_id: sceneId } : {}),
    ...(modelProvider ? { model_provider: modelProvider } : {}),
    ...(modelId ? { model_id: modelId } : {}),
  };
}

/**
 * Mark that the user opened an external pricing/checkout flow (e.g. header Pricing,
 * Black Friday banner, or Upgrade modal) so returning to this window automatically
 * triggers a fresh billing & provider sync.
 */
export function markExternalCheckoutPending(
  hookId?: EntitlementHookId,
  entryId?: string,
  attribution?: EntitlementAttributionContext,
): void {
  pendingCheckout = { hookId, entryId, attribution, at: Date.now() };
}

export function consumeExternalCheckoutPending(): {
  hookId?: EntitlementHookId;
  entryId?: string;
  attribution?: EntitlementAttributionContext;
} | null {
  if (!pendingCheckout) return null;
  const current = pendingCheckout;
  pendingCheckout = null;
  return { hookId: current.hookId, entryId: current.entryId, attribution: current.attribution };
}
