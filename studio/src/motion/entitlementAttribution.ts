import { useCallback, useEffect, useRef } from 'react';
import type { AccountSummary } from '../../../shared/provider-directory';
import type { EntitlementHookId } from '../../../tracking/events.ts';
import { gatewayRequest } from './gatewayClient';
import { newTrackingId, reportEntitlementRefresh } from './pageTracking';
import type { Fields } from './reporting';
import { notifyProvidersChanged } from './useProviderDirectory';

type AttributionKind = 'sign_in' | 'subscription';
type PendingAttribution = { hookId: EntitlementHookId; entryId: string; expiresAt: number };
const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingByKind = new Map<AttributionKind, PendingAttribution>();

/** Carries a touchpoint's hook_id + entry_id across in-app navigation into the Settings sign-in or subscription POST. */
export function setPendingAttribution(kind: AttributionKind, hookId: EntitlementHookId, entryId: string) {
  pendingByKind.set(kind, { hookId, entryId, expiresAt: Date.now() + PENDING_TTL_MS });
}

export function consumePendingAttribution(kind: AttributionKind, fallbackHookId: EntitlementHookId): { hookId: EntitlementHookId; entryId: string } {
  const entry = pendingByKind.get(kind);
  pendingByKind.delete(kind);
  if (entry && entry.expiresAt > Date.now()) return { hookId: entry.hookId, entryId: entry.entryId };
  return { hookId: fallbackHookId, entryId: newTrackingId() };
}

/** Normalized plan name only when the account is signed in and billing data is readable. */
export function readAccountPlan(summary: AccountSummary | null | undefined): string | undefined {
  return summary?.state === 'signed-in' && !summary.billingUnavailable
    ? summary.plan?.trim().toLowerCase() || undefined
    : undefined;
}

export function evaluateEntitlementRefresh(
  prevPlan: string | undefined,
  updated: AccountSummary | null | undefined,
): { billingOk: boolean; planChanged: boolean } {
  const billingOk = Boolean(updated && updated.state === 'signed-in' && !updated.billingUnavailable);
  const nextPlan = readAccountPlan(updated);
  const planChanged = Boolean(billingOk && prevPlan && nextPlan && nextPlan !== prevPlan);
  return { billingOk, planChanged };
}

/** Shared checkout-return listener for PricingEntry and BlackFridayTopBanner. */
export function useCheckoutReturnRefresh(
  trackingPage: NonNullable<Fields<'entitlement_refresh_result'>['page_name']>,
  hookId: EntitlementHookId,
) {
  const pendingRef = useRef<{ entryId: string; prevPlanPromise: Promise<string | undefined> } | undefined>(undefined);

  useEffect(() => {
    const onReturn = () => {
      const pending = pendingRef.current;
      if (!pending || document.visibilityState !== 'visible') return;
      pendingRef.current = undefined;
      void Promise.all([pending.prevPlanPromise, gatewayRequest<AccountSummary>('settings/account?refresh=true')])
        .then(([prevPlan, updated]) => {
          const { billingOk, planChanged } = evaluateEntitlementRefresh(prevPlan, updated);
          reportEntitlementRefresh(trackingPage, hookId, pending.entryId, billingOk ? 'success' : 'failure', planChanged);
          if (billingOk) {
            notifyProvidersChanged();
            window.dispatchEvent(new Event('motion:account-changed'));
          }
        })
        .catch(() => {
          reportEntitlementRefresh(trackingPage, hookId, pending.entryId, 'failure', false);
        });
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [trackingPage, hookId]);

  return useCallback((entryId: string) => {
    const prevPlanPromise = gatewayRequest<AccountSummary>('settings/account')
      .then(summary => readAccountPlan(summary))
      .catch(() => undefined);
    pendingRef.current = { entryId, prevPlanPromise };
  }, []);
}
