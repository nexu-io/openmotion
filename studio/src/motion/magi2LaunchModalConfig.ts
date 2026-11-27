import type { Locale, Translate } from '../i18n/I18n';
import {
  BLACK_FRIDAY_CAMPAIGN,
  REGISTERED_ENTRY_SOURCE,
  blackFridayActive,
  readBlackFridayCountdownRemainingMs,
} from './campaignAttribution';

export const MAGI2_MODAL_CAMPAIGN_ID = BLACK_FRIDAY_CAMPAIGN;
export const MAGI2_MODAL_SEEN_COOKIE = 'od_bf_magi2_modal_seen';
export const MAGI2_MODAL_SEEN_PARAM = 'od_bf_seen';
export const MAGI2_MODAL_DISMISSED_STORAGE_NAME = MAGI2_MODAL_SEEN_COOKIE;
export const MAGI2_MODAL_OPEN_EVENT = 'om:magi2-modal-change';
export const DEFAULT_CONSOLE_PLAN_URL = 'https://open-design.ai/cloud/dashboard?billing=plan';
export const MAGI2_MODAL_VIDEO_URL = 'https://open-design.ai/black-friday-modal/magi2-planet-6s.mp4';

const CLOUD_QUERY_CONTROL_KEYS = new Set([
  'billing', 'checkout', 'plan', 'interval', 'workspaceId', 'cloud_console_base',
  'od_origin', 'od_entry_id', 'od_entry_source', 'od_entry_at', 'od_conversion_source',
  'od_device_id', 'od_placement_id', 'od_campaign_id',
  'auth_token', 'token', 'access_token', 'id_token', 'code', 'state', 'od_auth', 'od_flow', 'od_flow_at',
  'redirect', 'return_to', 'email',
  MAGI2_MODAL_SEEN_PARAM, 'bf_modal_preview',
]);

export const MAGI2_MODAL_COUNTDOWN_CONTEXT = 'magi2 launch modal';

export const MAGI2_MODAL_COPY_MESSAGES = {
  dialogLabel: 'MAGI-2 first launch 7 days unlimited Black Friday offer',
  eyebrow: '7 Days Unlimited!',
  headline: 'First Launch · MAGI-2',
  description:
    '1080p cinema video with native audio is live on OpenDesign. Unlock **7 days unlimited** on **any annual plan**, with Black Friday plans **up to 50% OFF**.',
  cta: 'Start Unlimited',
  countdownPrefix: 'Ends in',
  closeLabel: 'Close MAGI-2 launch popup',
} as const;

export type ModalScriptKind = 'zh' | 'cjk' | 'latin';

export interface Magi2ModalDescSegment {
  text: string;
  strong?: boolean;
}

export interface Magi2ModalCopy {
  script: ModalScriptKind;
  dialogLabel: string;
  eyebrow: string;
  headline: string;
  description: readonly Magi2ModalDescSegment[];
  cta: string;
  countdownPrefix: string;
  closeLabel: string;
}

export function parseMagi2ModalDescription(text: string): Magi2ModalDescSegment[] {
  const segments: Magi2ModalDescSegment[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start) });
    }
    segments.push({ text: match[1], strong: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }
  return segments;
}

export function resolveMagi2ModalCopy(locale: Locale, t: Translate): Magi2ModalCopy {
  const script: ModalScriptKind = locale.startsWith('zh')
    ? 'zh'
    : locale === 'ja' || locale === 'ko'
      ? 'cjk'
      : 'latin';
  return {
    script,
    dialogLabel: t(MAGI2_MODAL_COPY_MESSAGES.dialogLabel),
    eyebrow: t(MAGI2_MODAL_COPY_MESSAGES.eyebrow),
    headline: t(MAGI2_MODAL_COPY_MESSAGES.headline),
    description: parseMagi2ModalDescription(t(MAGI2_MODAL_COPY_MESSAGES.description)),
    cta: t(MAGI2_MODAL_COPY_MESSAGES.cta),
    countdownPrefix: t(MAGI2_MODAL_COPY_MESSAGES.countdownPrefix, undefined, MAGI2_MODAL_COUNTDOWN_CONTEXT),
    closeLabel: t(MAGI2_MODAL_COPY_MESSAGES.closeLabel),
  };
}

export function isMagi2PreviewForced(search?: string): boolean {
  try {
    const raw = search ?? (typeof window !== 'undefined' ? window.location.search : '');
    return new URLSearchParams(raw).get('bf_modal_preview') === '1';
  } catch {
    return false;
  }
}

export function readMagi2CountdownParts(
  nowMs = Date.now(),
  forcePreview = false,
): readonly [number, number, number, number] {
  const remMs = readBlackFridayCountdownRemainingMs(nowMs, forcePreview);
  const totalSec = Math.floor(remMs / 1000);
  return [
    Math.floor(totalSec / 3600),
    Math.floor((totalSec % 3600) / 60),
    totalSec % 60,
    Math.floor((remMs % 1000) / 10),
  ] as const;
}

export function readMagi2SeenCookie(cookieSource?: string): boolean {
  try {
    const raw = cookieSource ?? (typeof document !== 'undefined' ? document.cookie || '' : '');
    return new RegExp(`(?:^|;\\s*)${MAGI2_MODAL_SEEN_COOKIE}=1(?:;|$)`).test(raw);
  } catch {
    return false;
  }
}

export function writeMagi2SeenCookie(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  try {
    const host = window.location.hostname || '';
    const domainAttr = /(^|\.)open-design\.ai$/i.test(host) ? '; domain=.open-design.ai' : '';
    const secureAttr = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${MAGI2_MODAL_SEEN_COOKIE}=1; path=/${domainAttr}; SameSite=Lax${secureAttr}`;
  } catch {
    // Ignore cookie write errors in restricted browser contexts.
  }
}

export function isMagi2SuppressedByFatigue(): boolean {
  if (typeof window === 'undefined') return false;
  let fromParam = false;
  try {
    const here = new URL(window.location.href);
    if (here.searchParams.get(MAGI2_MODAL_SEEN_PARAM) === '1') {
      fromParam = true;
      here.searchParams.delete(MAGI2_MODAL_SEEN_PARAM);
      window.history.replaceState(window.history.state, '', here.pathname + here.search + here.hash);
    }
  } catch {
    // Ignore URL/history failures.
  }
  if (fromParam) {
    writeMagi2SeenCookie();
    try { window.sessionStorage.setItem(MAGI2_MODAL_DISMISSED_STORAGE_NAME, '1'); } catch { /* ignore */ }
    return true;
  }
  if (readMagi2SeenCookie()) return true;
  try {
    if (window.sessionStorage.getItem(MAGI2_MODAL_DISMISSED_STORAGE_NAME) === '1') return true;
  } catch {
    // Ignore storage unavailability.
  }
  return false;
}

export function markMagi2ModalSeen(): void {
  writeMagi2SeenCookie();
  try { window.sessionStorage.setItem(MAGI2_MODAL_DISMISSED_STORAGE_NAME, '1'); } catch { /* ignore */ }
}

export function isMagi2ModalOpen(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.magi2ModalOpen === 'true';
}

export function setMagi2ModalOpenSignal(open: boolean): void {
  if (typeof document !== 'undefined') {
    if (open) document.documentElement.dataset.magi2ModalOpen = 'true';
    else delete document.documentElement.dataset.magi2ModalOpen;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(MAGI2_MODAL_OPEN_EVENT, { detail: { open } }));
  }
}

/**
 * Pure read-only check used by ExploreBlackFridayHero to skip the full-screen-to-compact intro
 * only when the MAGI-2 launch modal is actively open. Visits where the modal is suppressed or
 * already seen keep the full Explore Hero intro.
 */
export function shouldSkipExploreHeroIntro(): boolean {
  return isMagi2ModalOpen();
}

function resolveConsolePlanBase(consoleUrl?: string | null): URL {
  if (consoleUrl) {
    try {
      const parsed = new URL(consoleUrl);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
        const cleanPath = parsed.pathname.replace(/\/+$/, '');
        const dashboardPath = cleanPath.endsWith('/dashboard')
          ? cleanPath
          : cleanPath.endsWith('/cloud')
            ? `${cleanPath}/dashboard`
            : `${cleanPath}/cloud/dashboard`;
        const out = new URL(dashboardPath, parsed.origin);
        out.searchParams.set('billing', 'plan');
        return out;
      }
    } catch {
      // Fall back to production console URL below.
    }
  }
  return new URL(DEFAULT_CONSOLE_PLAN_URL);
}

/**
 * Build the direct Cloud Console plan URL (`https://open-design.ai/cloud/dashboard?billing=plan`)
 * carrying OpenMotion attribution + incoming marketing query parameters while stripping protocol control keys.
 */
export function buildMagi2ConsolePlanUrl(
  entryId: string,
  options?: {
    consoleUrl?: string | null;
    at?: Date;
    locationHref?: string;
    campaign?: boolean;
  },
): string {
  const at = options?.at ?? new Date();
  const campaign = options?.campaign ?? blackFridayActive(at.getTime());
  const target = resolveConsolePlanBase(options?.consoleUrl);

  target.searchParams.set('billing', 'plan');
  target.searchParams.set('od_origin', 'openmotion');
  target.searchParams.set('od_entry_source', REGISTERED_ENTRY_SOURCE);
  target.searchParams.set('od_entry_id', entryId);
  target.searchParams.set('od_entry_at', at.toISOString());
  target.searchParams.set('utm_source', 'openmotion');
  target.searchParams.set('utm_medium', 'modal');
  if (campaign) {
    target.searchParams.set('utm_campaign', BLACK_FRIDAY_CAMPAIGN);
  }

  const rawHref = options?.locationHref ?? (typeof window !== 'undefined' ? window.location.href : undefined);
  if (rawHref) {
    try {
      const current = new URL(rawHref);
      const owned = new Set([...target.searchParams.keys(), ...CLOUD_QUERY_CONTROL_KEYS]);
      for (const [key, value] of current.searchParams) {
        if (!owned.has(key)) target.searchParams.append(key, value);
      }
      target.searchParams.set('od_bf_source_origin', current.origin);
      target.searchParams.set('od_bf_source_path', current.pathname);
      target.searchParams.set('od_bf_placement', 'black_friday_modal');
    } catch {
      // Ignore malformed locationHref.
    }
  }

  return target.toString();
}
