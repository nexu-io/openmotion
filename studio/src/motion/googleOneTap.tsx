import { useEffect, useRef } from 'react';
import { isDesktopApp } from '../utils/platformHost';
import type { CloudAccountSummary } from './AccountSettings';
import { clearPrivateSwrCache } from './swrCache';
import { trackMotion } from './tracking';
import { setMotionTrackingUserId } from './trackingIdentity';

export const GOOGLE_GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client' as const;
export const GOOGLE_GIS_LOAD_TIMEOUT_MS = 5000;
export const MOTION_ONETAP_DELAY_MS = 2500;
export const ONETAP_SUPPRESSED_ONCE_KEY = 'od_onetap_suppressed_once' as const;
export const ONETAP_SUPPRESS_QUERY_PARAM = 'od_onetap_suppress' as const;
export const ONETAP_ANCHOR_ID = 'od-onetap-anchor' as const;
export const ONETAP_DESKTOP_MIN_WIDTH = 768;
export const ONETAP_ANCHOR_TOP_WITH_BANNER_PX = 112;
export const ONETAP_ANCHOR_TOP_WITHOUT_BANNER_PX = 64;

const CODE_RE = /^[A-Za-z0-9_.-]{1,128}$/;

const REGISTERED_LOGIN_ERROR_CODES = new Set([
  'INVALID_ID_TOKEN',
  'CHALLENGE_INVALID',
  'ORIGIN_NOT_ALLOWED',
  'ACCOUNT_BANNED',
  'ACCOUNT_FROZEN',
  'EMAIL_DOMAIN_BLOCKED',
  'LINK_CONFIRM_REQUIRED',
  'NETWORK_TIMEOUT',
  'AUTH_UNAVAILABLE',
  'ONE_TAP_UNAVAILABLE',
  'UNKNOWN',
] as const);

type RegisteredLoginErrorCode =
  | 'INVALID_ID_TOKEN'
  | 'CHALLENGE_INVALID'
  | 'ORIGIN_NOT_ALLOWED'
  | 'ACCOUNT_BANNED'
  | 'ACCOUNT_FROZEN'
  | 'EMAIL_DOMAIN_BLOCKED'
  | 'LINK_CONFIRM_REQUIRED'
  | 'NETWORK_TIMEOUT'
  | 'AUTH_UNAVAILABLE'
  | 'ONE_TAP_UNAVAILABLE'
  | 'UNKNOWN';

type OneTapPlanTier = 'free' | 'go' | 'plus' | 'pro' | 'max' | 'unknown';

export interface GooglePromptMomentNotification {
  isDisplayed?: () => boolean;
  isNotDisplayed?: () => boolean;
  isSkippedMoment?: () => boolean;
  isDismissedMoment?: () => boolean;
  getNotDisplayedReason?: () => string;
  getSkippedReason?: () => string;
  getDismissedReason?: () => string;
}

export interface GoogleCredentialResponse {
  credential?: string;
  select_by?: string;
}

export interface GoogleAccountsIdInitializeConfig {
  client_id: string;
  nonce?: string;
  callback: (response: GoogleCredentialResponse) => void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  prompt_parent_id?: string;
}

export interface GoogleAccountsIdApi {
  initialize: (config: GoogleAccountsIdInitializeConfig) => void;
  prompt: (momentListener?: (notification: GooglePromptMomentNotification) => void) => void;
  cancel?: () => void;
  disableAutoSelect?: () => void;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: GoogleAccountsIdApi;
      };
    };
  }
}

let oneTapGeneration = 0;
const activeCancelHooks = new Set<() => void>();

function sanitizeTelemetryCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return CODE_RE.test(trimmed) ? trimmed : undefined;
}

function normalizePlanTier(raw: unknown): OneTapPlanTier {
  if (typeof raw !== 'string') return 'unknown';
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'free' ||
    normalized === 'go' ||
    normalized === 'plus' ||
    normalized === 'pro' ||
    normalized === 'max'
  ) {
    return normalized;
  }
  return 'unknown';
}

function normalizeLoginErrorCode(raw: unknown): RegisteredLoginErrorCode {
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toUpperCase();
    if (REGISTERED_LOGIN_ERROR_CODES.has(trimmed as RegisteredLoginErrorCode)) {
      return trimmed as RegisteredLoginErrorCode;
    }
  }
  return 'UNKNOWN';
}

export function getOneTapGeneration(): number {
  return oneTapGeneration;
}

/**
 * Called ONLY after `/auth/logout` returns `response.ok`.
 * Suppresses One Tap on the next render, disables GIS auto-select, cancels any
 * queued prompt timer, and invalidates any late GIS credential callback.
 */
export function suppressOneTapAfterConfirmedLogout(): void {
  oneTapGeneration += 1;
  for (const cancel of [...activeCancelHooks]) {
    try {
      cancel();
    } catch {
      // Ignore cancel cleanup errors.
    }
  }
  activeCancelHooks.clear();

  try {
    window.sessionStorage.setItem(ONETAP_SUPPRESSED_ONCE_KEY, '1');
  } catch {
    // Ignore storage unavailability (private browsing, etc.).
  }

  try {
    window.google?.accounts?.id?.disableAutoSelect?.();
  } catch {
    // Ignore GIS unavailable errors.
  }

  try {
    window.google?.accounts?.id?.cancel?.();
  } catch {
    // Ignore GIS cancel errors.
  }

  removeOneTapAnchor();
}

/**
 * Checks and consumes the one-shot post-logout suppression flag from sessionStorage
 * or the optional `od_onetap_suppress=1` cross-origin query hint.
 */
export function consumeOneTapLogoutSuppression(): boolean {
  let suppressed = false;

  try {
    if (window.sessionStorage.getItem(ONETAP_SUPPRESSED_ONCE_KEY) === '1') {
      window.sessionStorage.removeItem(ONETAP_SUPPRESSED_ONCE_KEY);
      suppressed = true;
    }
  } catch {
    // Ignore storage read errors.
  }

  try {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get(ONETAP_SUPPRESS_QUERY_PARAM) === '1') {
      currentUrl.searchParams.delete(ONETAP_SUPPRESS_QUERY_PARAM);
      const nextRelative = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
      window.history.replaceState(window.history.state, '', nextRelative || '/');
      suppressed = true;
    }
  } catch {
    // Ignore history/URL manipulation errors.
  }

  return suppressed;
}

export function removeOneTapAnchor(): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById(ONETAP_ANCHOR_ID);
  if (existing) {
    existing.remove();
  }
}

export function syncOneTapAnchorPosition(bfBannerVisible: boolean): HTMLElement | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (window.innerWidth < ONETAP_DESKTOP_MIN_WIDTH) {
    removeOneTapAnchor();
    return null;
  }

  let anchor = document.getElementById(ONETAP_ANCHOR_ID);
  if (!anchor) {
    anchor = document.createElement('div');
    anchor.id = ONETAP_ANCHOR_ID;
    document.body.appendChild(anchor);
  }
  const topPx = bfBannerVisible
    ? ONETAP_ANCHOR_TOP_WITH_BANNER_PX
    : ONETAP_ANCHOR_TOP_WITHOUT_BANNER_PX;
  anchor.style.position = 'fixed';
  anchor.style.right = '16px';
  anchor.style.top = `${topPx}px`;
  anchor.style.zIndex = '900';
  return anchor;
}

export function loadGoogleGisScript(timeoutMs = GOOGLE_GIS_LOAD_TIMEOUT_MS): Promise<GoogleAccountsIdApi> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('script_load_failed'));
  }
  const existingApi = window.google?.accounts?.id;
  if (existingApi) {
    return Promise.resolve(existingApi);
  }

  return new Promise<GoogleAccountsIdApi>((resolve, reject) => {
    let settled = false;
    let scriptEl = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_GIS_SCRIPT_URL}"]`,
    );

    const cleanup = () => {
      window.clearTimeout(timer);
      scriptEl?.removeEventListener('load', onLoad);
      scriptEl?.removeEventListener('error', onError);
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('script_load_failed'));
    };

    const onLoad = () => {
      if (settled) return;
      const api = window.google?.accounts?.id;
      if (!api) {
        fail();
        return;
      }
      settled = true;
      cleanup();
      resolve(api);
    };

    const onError = () => {
      fail();
    };

    const timer = window.setTimeout(fail, timeoutMs);

    if (!scriptEl) {
      scriptEl = document.createElement('script');
      scriptEl.src = GOOGLE_GIS_SCRIPT_URL;
      scriptEl.async = true;
      scriptEl.defer = true;
      scriptEl.addEventListener('load', onLoad);
      scriptEl.addEventListener('error', onError);
      document.head.appendChild(scriptEl);
    } else {
      scriptEl.addEventListener('load', onLoad);
      scriptEl.addEventListener('error', onError);
      // Script may already have finished loading before listener attached.
      if (window.google?.accounts?.id) {
        onLoad();
      }
    }
  });
}

function collectOneTapAttribution() {
  const params = new URLSearchParams(window.location.search);
  const utmSource = params.get('utm_source')?.trim() || undefined;
  const utmMedium = params.get('utm_medium')?.trim() || undefined;
  const utmCampaign = params.get('utm_campaign')?.trim() || undefined;
  const utmContent = params.get('utm_content')?.trim() || undefined;
  const utmTerm = params.get('utm_term')?.trim() || undefined;
  const referralCode = params.get('ref')?.trim() || undefined;
  const landingPath = window.location.pathname || '/';

  const attribution = {
    ...(utmSource ? { utmSource } : {}),
    ...(utmMedium ? { utmMedium } : {}),
    ...(utmCampaign ? { utmCampaign } : {}),
    ...(utmContent ? { utmContent } : {}),
    ...(utmTerm ? { utmTerm } : {}),
    landingPath,
  };

  return { attribution, referralCode, utmSource, utmMedium, utmCampaign, utmContent, utmTerm };
}

export interface UseMotionGoogleOneTapOptions {
  account: CloudAccountSummary | null;
  accountError: boolean;
  bfBannerVisible: boolean;
  refreshAccount: () => Promise<void>;
  hostChrome?: boolean;
  onError?: (message: string) => void;
  delayMs?: number;
  loadTimeoutMs?: number;
}

export function useMotionGoogleOneTap({
  account,
  accountError,
  bfBannerVisible,
  refreshAccount,
  hostChrome = false,
  onError,
  delayMs = MOTION_ONETAP_DELAY_MS,
  loadTimeoutMs = GOOGLE_GIS_LOAD_TIMEOUT_MS,
}: UseMotionGoogleOneTapOptions): void {
  const bfBannerRef = useRef(bfBannerVisible);
  bfBannerRef.current = bfBannerVisible;
  const refreshRef = useRef(refreshAccount);
  refreshRef.current = refreshAccount;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const eligible =
    !hostChrome &&
    !isDesktopApp() &&
    typeof window !== 'undefined' &&
    window.parent === window &&
    !accountError &&
    account !== null &&
    account.state === 'signed-out' &&
    account.authMode !== 'dev';

  // Keep desktop anchor top offset synced with Black Friday banner state and viewport resizes.
  useEffect(() => {
    if (!eligible) {
      removeOneTapAnchor();
      return;
    }
    const existingAnchor = document.getElementById(ONETAP_ANCHOR_ID);
    if (existingAnchor) {
      syncOneTapAnchorPosition(bfBannerVisible);
    }
    const onResize = () => {
      if (document.getElementById(ONETAP_ANCHOR_ID) || window.innerWidth >= ONETAP_DESKTOP_MIN_WIDTH) {
        syncOneTapAnchorPosition(bfBannerRef.current);
      }
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [eligible, bfBannerVisible]);

  useEffect(() => {
    if (!eligible) return;

    const attemptId = crypto.randomUUID();
    const deviceType: 'desktop' | 'mobile' =
      window.innerWidth >= ONETAP_DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile';

    if (consumeOneTapLogoutSuppression()) {
      void trackMotion('onetap_prompt_attempt', {
        surface: 'motion_web',
        attempt_id: attemptId,
        device_type: deviceType,
        suppressed: true,
      });
      void trackMotion('onetap_prompt_observed', {
        surface: 'motion_web',
        attempt_id: attemptId,
        outcome: 'suppressed_after_logout',
        reason: 'suppressed_after_logout',
      });
      return;
    }

    const generationAtStart = oneTapGeneration;
    let disposed = false;
    let timerId: number | null = null;
    const abortController = new AbortController();

    const cancelRun = () => {
      disposed = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      abortController.abort();
    };
    activeCancelHooks.add(cancelRun);

    const isStale = () => disposed || generationAtStart !== oneTapGeneration;

    timerId = window.setTimeout(() => {
      timerId = null;
      if (isStale()) return;

      void (async () => {
        // 1. Acquire one-time anti-replay challenge bound to same-origin HttpOnly cookie.
        let challenge: { challengeId: string; nonce: string; clientId: string; expiresAt: string };
        try {
          const challengeRes = await fetch('/auth/one-tap/challenge', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ attemptId }),
            signal: abortController.signal,
          });
          if (!challengeRes.ok) return;
          const payload = (await challengeRes.json()) as Partial<typeof challenge>;
          if (!payload.challengeId || !payload.nonce || !payload.clientId) return;
          challenge = {
            challengeId: payload.challengeId,
            nonce: payload.nonce,
            clientId: payload.clientId,
            expiresAt: payload.expiresAt ?? '',
          };
        } catch {
          return;
        }

        if (isStale()) return;

        // 2. Dynamically load official Google GIS script with 5000ms timeout.
        let gis: GoogleAccountsIdApi;
        try {
          gis = await loadGoogleGisScript(loadTimeoutMs);
        } catch {
          if (!isStale()) {
            void trackMotion('onetap_prompt_observed', {
              surface: 'motion_web',
              attempt_id: attemptId,
              outcome: 'script_load_failed',
              reason: 'script_load_failed',
            });
          }
          return;
        }

        if (isStale()) return;

        const isDesktopViewport = window.innerWidth >= ONETAP_DESKTOP_MIN_WIDTH;
        const currentDeviceType: 'desktop' | 'mobile' = isDesktopViewport ? 'desktop' : 'mobile';
        if (isDesktopViewport) {
          syncOneTapAnchorPosition(bfBannerRef.current);
        } else {
          removeOneTapAnchor();
        }

        const observedOutcomes = new Set<string>();
        const reportObserved = (
          outcome: 'displayed' | 'dismissed' | 'skipped',
          rawReason?: string,
        ) => {
          if (observedOutcomes.has(outcome)) return;
          observedOutcomes.add(outcome);
          void trackMotion('onetap_prompt_observed', {
            surface: 'motion_web',
            attempt_id: attemptId,
            outcome,
            reason: sanitizeTelemetryCode(rawReason) ?? 'unknown',
          });
        };

        // 3. Initialize GIS (no deprecated use_fedcm_for_prompt; auto_select=false; cancel_on_tap_outside=false).
        gis.initialize({
          client_id: challenge.clientId,
          nonce: challenge.nonce,
          auto_select: false,
          cancel_on_tap_outside: false,
          ...(isDesktopViewport ? { prompt_parent_id: ONETAP_ANCHOR_ID } : {}),
          callback: (credentialResponse: GoogleCredentialResponse) => {
            if (isStale()) return;
            const idToken = credentialResponse.credential?.trim();
            if (!idToken) return;

            void trackMotion('onetap_credential_received', {
              surface: 'motion_web',
              attempt_id: attemptId,
              select_by: sanitizeTelemetryCode(credentialResponse.select_by) ?? 'unknown',
            });

            void (async () => {
              const { attribution, referralCode, utmSource, utmMedium, utmCampaign, utmContent, utmTerm } =
                collectOneTapAttribution();

              let exchangeRes: Response;
              try {
                exchangeRes = await fetch('/auth/one-tap', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    challengeId: challenge.challengeId,
                    idToken,
                    attribution,
                    ...(referralCode ? { referralCode } : {}),
                  }),
                  signal: abortController.signal,
                });
              } catch (err) {
                if (isStale()) return;
                const isTimeout = err instanceof Error && err.name === 'AbortError';
                void trackMotion('onetap_login_failed', {
                  surface: 'motion_web',
                  attempt_id: attemptId,
                  error_code: isTimeout ? 'NETWORK_TIMEOUT' : 'AUTH_UNAVAILABLE',
                });
                onErrorRef.current?.('Could not sign in right now. Please try again.');
                return;
              }

              if (isStale()) return;

              const data = (await exchangeRes.json().catch(() => null)) as {
                authenticated?: boolean;
                user?: { id?: string; appUserId?: string | null; email?: string | null; displayName?: string };
                activeWorkspaceId?: string;
                isNewUser?: boolean;
                planTier?: string;
                code?: string;
                message?: string;
                error?: string;
              } | null;

              if (!exchangeRes.ok || !data?.authenticated) {
                const errorCode = normalizeLoginErrorCode(data?.code);
                void trackMotion('onetap_login_failed', {
                  surface: 'motion_web',
                  attempt_id: attemptId,
                  error_code: errorCode,
                });
                onErrorRef.current?.(
                  data?.message || data?.error || 'Could not complete Google One Tap sign-in.',
                );
                return;
              }

              if (isStale()) return;

              const appUserId = data.user?.appUserId ?? null;
              if (appUserId) {
                setMotionTrackingUserId(appUserId);
              }

              const safeRef = sanitizeTelemetryCode(referralCode);
              const safeUtmSource = sanitizeTelemetryCode(utmSource);
              const safeUtmMedium = sanitizeTelemetryCode(utmMedium);
              const safeUtmCampaign = sanitizeTelemetryCode(utmCampaign);
              const safeUtmContent = sanitizeTelemetryCode(utmContent);
              const safeUtmTerm = sanitizeTelemetryCode(utmTerm);

              void trackMotion('onetap_login_success', {
                surface: 'motion_web',
                attempt_id: attemptId,
                is_new_user: Boolean(data.isNewUser),
                plan_tier: normalizePlanTier(data.planTier),
                post_login_action: 'in_place',
                ...(safeRef ? { ref: safeRef } : {}),
                ...(safeUtmSource ? { utm_source: safeUtmSource } : {}),
                ...(safeUtmMedium ? { utm_medium: safeUtmMedium } : {}),
                ...(safeUtmCampaign ? { utm_campaign: safeUtmCampaign } : {}),
                ...(safeUtmContent ? { utm_content: safeUtmContent } : {}),
                ...(safeUtmTerm ? { utm_term: safeUtmTerm } : {}),
              });

              removeOneTapAnchor();
              clearPrivateSwrCache();
              await refreshRef.current();
              window.dispatchEvent(new Event('motion:account-changed'));
            })();
          },
        });

        if (isStale()) return;

        void trackMotion('onetap_prompt_attempt', {
          surface: 'motion_web',
          attempt_id: attemptId,
          device_type: currentDeviceType,
          suppressed: false,
        });

        gis.prompt((notification: GooglePromptMomentNotification) => {
          if (isStale()) return;
          if (notification?.isDisplayed?.()) {
            reportObserved('displayed', 'displayed');
          } else if (notification?.isDismissedMoment?.()) {
            reportObserved('dismissed', notification.getDismissedReason?.());
          } else if (notification?.isNotDisplayed?.()) {
            reportObserved('skipped', notification.getNotDisplayedReason?.());
          } else if (notification?.isSkippedMoment?.()) {
            reportObserved('skipped', notification.getSkippedReason?.());
          }
        });
      })();
    }, delayMs);

    return () => {
      activeCancelHooks.delete(cancelRun);
      cancelRun();
    };
  }, [eligible, delayMs, loadTimeoutMs]);
}

export function MotionGoogleOneTap(props: UseMotionGoogleOneTapOptions) {
  useMotionGoogleOneTap(props);
  return null;
}

export function resetOneTapStateForTests(): void {
  oneTapGeneration = 0;
  for (const cancel of [...activeCancelHooks]) {
    try {
      cancel();
    } catch {
      // Ignore cleanup errors.
    }
  }
  activeCancelHooks.clear();
  removeOneTapAnchor();
}
