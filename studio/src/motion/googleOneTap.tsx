import { useEffect, useRef, useState } from 'react';
import { isDesktopApp } from '../utils/platformHost';
import type { CloudAccountSummary } from './AccountSettings';
import { clearPrivateSwrCache } from './swrCache';
import { trackMotion } from './tracking';
import { isMotionTrackingConsented, setMotionTrackingUserId } from './trackingIdentity';

export const GOOGLE_GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client' as const;
export const GOOGLE_GIS_LOAD_TIMEOUT_MS = 5000;
export const MOTION_ONETAP_DELAY_MS = 2000;
export const ONETAP_EXCHANGE_TIMEOUT_MS = 15_000;
export const ONETAP_SUPPRESSED_ONCE_KEY = 'od_onetap_suppressed_once' as const;
export const ONETAP_SUPPRESS_QUERY_PARAM = 'od_onetap_suppress' as const;
export const ONETAP_SYNC_STORAGE_KEY = 'om_onetap_logout_sync' as const;
export const ONETAP_SYNC_CHANNEL_NAME = 'om_onetap_sync' as const;
export const ONETAP_ATTRIBUTION_STORAGE_ENTRY = 'om_onetap_attribution_v1' as const;
export const ONETAP_RETRY_EVENT = 'motion:onetap-retry' as const;
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

export type RegisteredLoginErrorCode =
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

type StoredAttribution = {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  referralCode?: string;
  landingPath?: string;
  odOrigin?: string;
  odEntryId?: string;
  odEntrySource?: string;
  odEntryAt?: string;
  odCampaignId?: string;
  odPlacementId?: string;
  odConversionSource?: string;
  odDeviceId?: string;
};

let oneTapGeneration = 0;
let suppressedAfterLogoutInPage = false;
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

function createFetchSignal(parentSignal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return AbortSignal.any([parentSignal, timeoutSignal]);
}

export function getOneTapGeneration(): number {
  return oneTapGeneration;
}

function cancelLocalOneTapRuntime(): void {
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
 * Called ONLY after `/auth/logout` returns `response.ok`.
 * Suppresses One Tap on the next render, disables GIS auto-select, cancels any
 * queued prompt timer, invalidates any late GIS credential callback, and syncs
 * cancellation across sibling browser tabs.
 */
export function suppressOneTapAfterConfirmedLogout(): void {
  suppressedAfterLogoutInPage = true;
  cancelLocalOneTapRuntime();

  try {
    window.sessionStorage.setItem(ONETAP_SUPPRESSED_ONCE_KEY, '1');
  } catch {
    // Ignore storage unavailability (private browsing, etc.).
  }

  // Notify sibling tabs on the same origin so queued prompts and late callbacks are discarded there too.
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(ONETAP_SYNC_CHANNEL_NAME);
      channel.postMessage({ type: 'logout', at: Date.now() });
      channel.close();
    }
  } catch {
    // Ignore BroadcastChannel errors.
  }

  try {
    window.localStorage.setItem(ONETAP_SYNC_STORAGE_KEY, String(Date.now()));
  } catch {
    // Ignore localStorage unavailability.
  }
}

/**
 * Triggers a fresh in-place One Tap attempt (acquiring a new anti-replay challenge)
 * without reloading the page or losing local drafts/filters.
 */
export function retryMotionOneTap(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ONETAP_RETRY_EVENT));
}

/**
 * Checks and consumes the one-shot post-logout suppression flag from sessionStorage
 * or the optional `od_onetap_suppress=1` cross-origin query hint.
 */
export function consumeOneTapLogoutSuppression(): boolean {
  let suppressed = false;
  if (suppressedAfterLogoutInPage) {
    suppressedAfterLogoutInPage = false;
    suppressed = true;
  }

  try {
    if (window.sessionStorage.getItem(ONETAP_SUPPRESSED_ONCE_KEY) === '1') {
      let isManualReload = false;
      try {
        const navEntries =
          typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
            ? (performance.getEntriesByType('navigation') as Array<{ type?: string }>)
            : [];
        isManualReload = Boolean(navEntries[0] && navEntries[0].type === 'reload');
      } catch {
        isManualReload = false;
      }
      window.sessionStorage.removeItem(ONETAP_SUPPRESSED_ONCE_KEY);
      // On manual page reload after in-place logout, restore One Tap eligibility immediately (SHOW-04).
      if (!isManualReload) {
        suppressed = true;
      }
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
      if (window.google?.accounts?.id) {
        onLoad();
      }
    }
  });
}

function readCleanString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

function parseStoredAttribution(raw: string | null): StoredAttribution {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return {
      utmSource: readCleanString(parsed.utmSource ?? parsed.utm_source),
      utmMedium: readCleanString(parsed.utmMedium ?? parsed.utm_medium),
      utmCampaign: readCleanString(parsed.utmCampaign ?? parsed.utm_campaign),
      utmContent: readCleanString(parsed.utmContent ?? parsed.utm_content),
      utmTerm: readCleanString(parsed.utmTerm ?? parsed.utm_term),
      referralCode: readCleanString(parsed.referralCode ?? parsed.ref),
      landingPath: readCleanString(parsed.landingPath ?? parsed.landing_path),
      odOrigin: readCleanString(parsed.odOrigin ?? parsed.od_origin ?? parsed.sourceProduct),
      odEntryId: readCleanString(parsed.odEntryId ?? parsed.od_entry_id ?? parsed.entryId),
      odEntrySource: readCleanString(parsed.odEntrySource ?? parsed.od_entry_source ?? parsed.sourceDetail),
      odEntryAt: readCleanString(parsed.odEntryAt ?? parsed.od_entry_at ?? parsed.entryOccurredAt),
      odCampaignId: readCleanString(parsed.odCampaignId ?? parsed.od_campaign_id ?? parsed.campaignId),
      odPlacementId: readCleanString(parsed.odPlacementId ?? parsed.od_placement_id ?? parsed.placementId),
      odConversionSource: readCleanString(
        parsed.odConversionSource ?? parsed.od_conversion_source ?? parsed.conversionSource,
      ),
      odDeviceId: readCleanString(parsed.odDeviceId ?? parsed.od_device_id),
    };
  } catch {
    return {};
  }
}

function parseOdAttrCookie(raw: string | null): StoredAttribution {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // od-landing writes compact keys { s, m, c, ct, tm, lp, ref } where `ref` is the
    // organic referrer hostname (NOT an invite referralCode).
    let utmSource = readCleanString(parsed.utmSource ?? parsed.utm_source ?? parsed.s);
    let utmMedium = readCleanString(parsed.utmMedium ?? parsed.utm_medium ?? parsed.m);
    const utmCampaign = readCleanString(parsed.utmCampaign ?? parsed.utm_campaign ?? parsed.c);
    const utmContent = readCleanString(parsed.utmContent ?? parsed.utm_content ?? parsed.ct);
    const utmTerm = readCleanString(parsed.utmTerm ?? parsed.utm_term ?? parsed.tm);
    const landingPath = readCleanString(parsed.landingPath ?? parsed.landing_path ?? parsed.lp);
    if (!utmSource) {
      const refHost = readCleanString(parsed.ref);
      if (refHost) {
        utmSource = refHost;
        utmMedium = 'referrer';
      }
    }
    return {
      ...(utmSource ? { utmSource } : {}),
      ...(utmMedium ? { utmMedium } : {}),
      ...(utmCampaign ? { utmCampaign } : {}),
      ...(utmContent ? { utmContent } : {}),
      ...(utmTerm ? { utmTerm } : {}),
      ...(landingPath ? { landingPath } : {}),
      // Only honor explicit referralCode in cookie (never `ref`, which is organic referrer host).
      ...(readCleanString(parsed.referralCode) ? { referralCode: readCleanString(parsed.referralCode) } : {}),
      ...(readCleanString(parsed.odOrigin ?? parsed.od_origin ?? parsed.sourceProduct)
        ? { odOrigin: readCleanString(parsed.odOrigin ?? parsed.od_origin ?? parsed.sourceProduct) }
        : {}),
      ...(readCleanString(parsed.odEntryId ?? parsed.od_entry_id ?? parsed.entryId)
        ? { odEntryId: readCleanString(parsed.odEntryId ?? parsed.od_entry_id ?? parsed.entryId) }
        : {}),
      ...(readCleanString(parsed.odEntrySource ?? parsed.od_entry_source ?? parsed.sourceDetail)
        ? { odEntrySource: readCleanString(parsed.odEntrySource ?? parsed.od_entry_source ?? parsed.sourceDetail) }
        : {}),
      ...(readCleanString(parsed.odEntryAt ?? parsed.od_entry_at ?? parsed.entryOccurredAt)
        ? { odEntryAt: readCleanString(parsed.odEntryAt ?? parsed.od_entry_at ?? parsed.entryOccurredAt) }
        : {}),
      ...(readCleanString(parsed.odCampaignId ?? parsed.od_campaign_id ?? parsed.campaignId)
        ? { odCampaignId: readCleanString(parsed.odCampaignId ?? parsed.od_campaign_id ?? parsed.campaignId) }
        : {}),
      ...(readCleanString(parsed.odPlacementId ?? parsed.od_placement_id ?? parsed.placementId)
        ? { odPlacementId: readCleanString(parsed.odPlacementId ?? parsed.od_placement_id ?? parsed.placementId) }
        : {}),
      ...(readCleanString(parsed.odConversionSource ?? parsed.od_conversion_source ?? parsed.conversionSource)
        ? {
            odConversionSource: readCleanString(
              parsed.odConversionSource ?? parsed.od_conversion_source ?? parsed.conversionSource,
            ),
          }
        : {}),
      ...(readCleanString(parsed.odDeviceId ?? parsed.od_device_id)
        ? { odDeviceId: readCleanString(parsed.odDeviceId ?? parsed.od_device_id) }
        : {}),
    };
  } catch {
    return {};
  }
}

function readOdAttrCookie(): StoredAttribution {
  if (typeof document === 'undefined' || !document.cookie) return {};
  for (const part of document.cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== 'od_attr') continue;
    const value = part.slice(idx + 1).trim();
    try {
      return parseOdAttrCookie(decodeURIComponent(value));
    } catch {
      return parseOdAttrCookie(value);
    }
  }
  return {};
}

function readUrlAttribution(): StoredAttribution {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const utmSource = readCleanString(params.get('utm_source'));
  const utmMedium = readCleanString(params.get('utm_medium'));
  const utmCampaign = readCleanString(params.get('utm_campaign'));
  const utmContent = readCleanString(params.get('utm_content'));
  const utmTerm = readCleanString(params.get('utm_term'));
  const referralCode = readCleanString(params.get('ref'));
  const odOrigin = readCleanString(params.get('od_origin'));
  const odEntryId = readCleanString(params.get('od_entry_id'));
  const odEntrySource = readCleanString(params.get('od_entry_source'));
  const odEntryAt = readCleanString(params.get('od_entry_at'));
  const odCampaignId = readCleanString(params.get('od_campaign_id'));
  const odPlacementId = readCleanString(params.get('od_placement_id'));
  const odConversionSource = readCleanString(params.get('od_conversion_source'));
  const odDeviceId = readCleanString(params.get('od_device_id'));
  const hasAny = Boolean(
    utmSource ||
      utmMedium ||
      utmCampaign ||
      utmContent ||
      utmTerm ||
      referralCode ||
      odOrigin ||
      odEntryId ||
      odEntrySource ||
      odEntryAt ||
      odCampaignId ||
      odPlacementId ||
      odConversionSource ||
      odDeviceId,
  );
  return {
    ...(utmSource ? { utmSource } : {}),
    ...(utmMedium ? { utmMedium } : {}),
    ...(utmCampaign ? { utmCampaign } : {}),
    ...(utmContent ? { utmContent } : {}),
    ...(utmTerm ? { utmTerm } : {}),
    ...(referralCode ? { referralCode } : {}),
    ...(odOrigin ? { odOrigin } : {}),
    ...(odEntryId ? { odEntryId } : {}),
    ...(odEntrySource ? { odEntrySource } : {}),
    ...(odEntryAt ? { odEntryAt } : {}),
    ...(odCampaignId ? { odCampaignId } : {}),
    ...(odPlacementId ? { odPlacementId } : {}),
    ...(odConversionSource ? { odConversionSource } : {}),
    ...(odDeviceId ? { odDeviceId } : {}),
    ...(hasAny ? { landingPath: window.location.pathname || '/' } : {}),
  };
}

/**
 * Captures UTM / `ref` / `od_*` params from the current URL into localStorage so
 * subsequent in-app navigation before One Tap fires does not lose landing attribution.
 */
export function persistOneTapLandingAttribution(): void {
  if (typeof window === 'undefined') return;
  const fromUrl = readUrlAttribution();
  // Never persist odDeviceId to localStorage before explicit metrics consent is granted.
  const safeFromUrl: StoredAttribution = isMotionTrackingConsented()
    ? fromUrl
    : { ...fromUrl, odDeviceId: undefined };
  if (Object.values(safeFromUrl).every(v => v === undefined)) return;
  try {
    const existing = parseStoredAttribution(window.localStorage.getItem(ONETAP_ATTRIBUTION_STORAGE_ENTRY));
    const merged: StoredAttribution = {
      ...existing,
      ...safeFromUrl,
      ...(isMotionTrackingConsented() ? {} : { odDeviceId: undefined }),
    };
    window.localStorage.setItem(ONETAP_ATTRIBUTION_STORAGE_ENTRY, JSON.stringify(merged));
  } catch {
    // Ignore storage unavailability.
  }
}

/**
 * Resolves attribution using strict priority:
 * 1. Current URL query parameters
 * 2. Persisted localStorage (`om_onetap_attribution_v1` / `od_attr`)
 * 3. `od_attr` cookie
 * `odDeviceId` is included ONLY when analytics consent is active.
 */
export function collectOneTapAttribution() {
  const fromUrl = readUrlAttribution();
  let fromStorage: StoredAttribution = {};
  let fromOdAttrStorage: StoredAttribution = {};
  try {
    fromStorage = parseStoredAttribution(window.localStorage.getItem(ONETAP_ATTRIBUTION_STORAGE_ENTRY));
    fromOdAttrStorage = parseStoredAttribution(window.localStorage.getItem('od_attr'));
  } catch {
    // Ignore storage unavailability.
  }
  const fromOdAttrCookie = readOdAttrCookie();

  const pick = <K extends keyof StoredAttribution>(key: K): string | undefined =>
    fromUrl[key] ?? fromStorage[key] ?? fromOdAttrStorage[key] ?? fromOdAttrCookie[key];

  const utmSource = pick('utmSource');
  const utmMedium = pick('utmMedium');
  const utmCampaign = pick('utmCampaign');
  const utmContent = pick('utmContent');
  const utmTerm = pick('utmTerm');
  const referralCode = pick('referralCode');
  const landingPath =
    fromUrl.landingPath ??
    fromStorage.landingPath ??
    fromOdAttrStorage.landingPath ??
    fromOdAttrCookie.landingPath ??
    (typeof window !== 'undefined' ? window.location.pathname || '/' : '/');

  const sourceProduct = pick('odOrigin');
  const entryId = pick('odEntryId');
  const sourceDetail = pick('odEntrySource');
  const entryOccurredAt = pick('odEntryAt');
  const campaignId = pick('odCampaignId');
  const placementId = pick('odPlacementId');
  const conversionSource = pick('odConversionSource');
  const consented = isMotionTrackingConsented();
  const odDeviceId = consented ? pick('odDeviceId') : undefined;

  const odEntry =
    sourceProduct ||
    entryId ||
    sourceDetail ||
    entryOccurredAt ||
    campaignId ||
    placementId ||
    conversionSource ||
    odDeviceId
      ? {
          ...(sourceProduct ? { sourceProduct } : {}),
          ...(entryId ? { entryId } : {}),
          ...(sourceDetail ? { sourceDetail } : {}),
          ...(entryOccurredAt ? { entryOccurredAt } : {}),
          ...(campaignId ? { campaignId } : {}),
          ...(placementId ? { placementId } : {}),
          ...(conversionSource ? { conversionSource } : {}),
          ...(odDeviceId ? { odDeviceId, odDeviceIdConsent: true } : {}),
        }
      : undefined;

  const attribution = {
    ...(utmSource ? { utmSource } : {}),
    ...(utmMedium ? { utmMedium } : {}),
    ...(utmCampaign ? { utmCampaign } : {}),
    ...(utmContent ? { utmContent } : {}),
    ...(utmTerm ? { utmTerm } : {}),
    landingPath,
    ...(odEntry ? { odEntry } : {}),
  };

  return { attribution, referralCode, utmSource, utmMedium, utmCampaign, utmContent, utmTerm };
}

export interface UseMotionGoogleOneTapOptions {
  account: CloudAccountSummary | null;
  accountError: boolean;
  bfBannerVisible: boolean;
  refreshAccount: () => Promise<void>;
  hostChrome?: boolean;
  onError?: (message: string, errorCode?: RegisteredLoginErrorCode) => void;
  onSuccess?: () => void;
  delayMs?: number;
  loadTimeoutMs?: number;
  exchangeTimeoutMs?: number;
}

export function useMotionGoogleOneTap({
  account,
  accountError,
  bfBannerVisible,
  refreshAccount,
  hostChrome = false,
  onError,
  onSuccess,
  delayMs = MOTION_ONETAP_DELAY_MS,
  loadTimeoutMs = GOOGLE_GIS_LOAD_TIMEOUT_MS,
  exchangeTimeoutMs = ONETAP_EXCHANGE_TIMEOUT_MS,
}: UseMotionGoogleOneTapOptions): void {
  const bfBannerRef = useRef(bfBannerVisible);
  bfBannerRef.current = bfBannerVisible;
  const refreshRef = useRef(refreshAccount);
  refreshRef.current = refreshAccount;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const [retrySeq, setRetrySeq] = useState(0);

  // Capture landing attribution on initial mount before user navigates within Studio.
  useEffect(() => {
    persistOneTapLandingAttribution();
  }, []);

  // Listen for cross-tab logout broadcasts and in-place retry requests.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(ONETAP_SYNC_CHANNEL_NAME);
        channel.addEventListener('message', event => {
          if (event.data && typeof event.data === 'object' && (event.data as { type?: string }).type === 'logout') {
            cancelLocalOneTapRuntime();
          }
        });
      }
    } catch {
      channel = null;
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === ONETAP_SYNC_STORAGE_KEY && event.newValue) {
        cancelLocalOneTapRuntime();
      }
    };
    const onRetry = () => {
      setRetrySeq(prev => prev + 1);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(ONETAP_RETRY_EVENT, onRetry);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(ONETAP_RETRY_EVENT, onRetry);
      channel?.close();
    };
  }, []);

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

    const isExplicitRetry = retrySeq > 0;
    const attemptId = crypto.randomUUID();
    const deviceType: 'desktop' | 'mobile' =
      window.innerWidth >= ONETAP_DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile';

    if (!isExplicitRetry && consumeOneTapLogoutSuppression()) {
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
    const effectiveDelay = isExplicitRetry ? 0 : delayMs;

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
            signal: createFetchSignal(abortController.signal, exchangeTimeoutMs),
          });
          if (!challengeRes.ok) {
            if (challengeRes.status !== 404 && !isStale()) {
              const errData = (await challengeRes.json().catch(() => null)) as {
                code?: string;
                message?: string;
                error?: string;
              } | null;
              void trackMotion('onetap_login_failed', {
                surface: 'motion_web',
                attempt_id: attemptId,
                error_code: normalizeLoginErrorCode(errData?.code ?? 'AUTH_UNAVAILABLE'),
              });
              // Prompt was never shown and the user never clicked One Tap; degrade
              // silently without showing a failure alert (ERR-01/06).
            }
            return;
          }
          const payload = (await challengeRes.json()) as Partial<typeof challenge>;
          if (!payload.challengeId || !payload.nonce || !payload.clientId) {
            if (!isStale()) {
              void trackMotion('onetap_login_failed', {
                surface: 'motion_web',
                attempt_id: attemptId,
                error_code: 'ONE_TAP_UNAVAILABLE',
              });
            }
            return;
          }
          challenge = {
            challengeId: payload.challengeId,
            nonce: payload.nonce,
            clientId: payload.clientId,
            expiresAt: payload.expiresAt ?? '',
          };
        } catch (err) {
          if (!isStale()) {
            const isTimeout =
              err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
            void trackMotion('onetap_login_failed', {
              surface: 'motion_web',
              attempt_id: attemptId,
              error_code: isTimeout ? 'NETWORK_TIMEOUT' : 'AUTH_UNAVAILABLE',
            });
          }
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
                  signal: createFetchSignal(abortController.signal, exchangeTimeoutMs),
                });
              } catch (err) {
                if (isStale()) return;
                const isTimeout =
                  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
                const errorCode: RegisteredLoginErrorCode = isTimeout ? 'NETWORK_TIMEOUT' : 'AUTH_UNAVAILABLE';
                void trackMotion('onetap_login_failed', {
                  surface: 'motion_web',
                  attempt_id: attemptId,
                  error_code: errorCode,
                });
                onErrorRef.current?.(
                  'Sign-in failed. Please try again or choose another sign-in method.',
                  errorCode,
                );
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
                const fallbackMessage =
                  errorCode === 'ACCOUNT_BANNED'
                    ? data?.message || 'Account temporarily suspended. We detected abnormal payment risk on this account and have temporarily suspended account access. If you believe this is a mistake, please contact support@open-design.ai and we will help investigate.'
                    : 'Sign-in failed. Please try again or choose another sign-in method.';
                onErrorRef.current?.(fallbackMessage, errorCode);
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
              onSuccessRef.current?.();
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
    }, effectiveDelay);

    return () => {
      activeCancelHooks.delete(cancelRun);
      cancelRun();
    };
  }, [eligible, delayMs, loadTimeoutMs, exchangeTimeoutMs, retrySeq]);
}

export function MotionGoogleOneTap(props: UseMotionGoogleOneTapOptions) {
  useMotionGoogleOneTap(props);
  return null;
}

export function resetOneTapStateForTests(): void {
  oneTapGeneration = 0;
  suppressedAfterLogoutInPage = false;
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
