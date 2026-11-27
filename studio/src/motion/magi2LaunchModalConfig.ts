import type { Locale } from '../i18n/I18n';
import type { CloudAccountSummary } from './AccountSettings';
import {
  BLACK_FRIDAY_CAMPAIGN,
  BLACK_FRIDAY_ENDS_AT,
  BLACK_FRIDAY_STARTS_AT,
  COUNTDOWN_CYCLE_SECONDS,
  blackFridayActive,
} from './campaignAttribution';

export const MAGI2_MODAL_CAMPAIGN_ID = BLACK_FRIDAY_CAMPAIGN;
export const MAGI2_MODAL_SEEN_COOKIE = 'od_bf_magi2_modal_seen';
export const MAGI2_MODAL_SEEN_PARAM = 'od_bf_seen';
export const MAGI2_MODAL_DISMISSED_KEY = 'od_bf_magi2_modal_seen';
export const MAGI2_MODAL_OPEN_EVENT = 'om:magi2-modal-change';
export const MAGI2_MODAL_AUDIENCE_TIMEOUT_MS = 5000;
export const DEFAULT_CONSOLE_PLAN_URL = 'https://open-design.ai/cloud/dashboard?billing=plan';

const COUNTDOWN_CYCLE_MS = COUNTDOWN_CYCLE_SECONDS * 1000;
const PAID_PLAN_TIERS = new Set(['go', 'plus', 'pro', 'max', 'basic']);
const REGISTERED_ENTRY_SOURCE = 'openmotion_manage_subscription';

const CLOUD_QUERY_CONTROL_KEYS = new Set([
  'billing', 'checkout', 'plan', 'interval', 'workspaceId', 'cloud_console_base',
  'od_origin', 'od_entry_id', 'od_entry_source', 'od_entry_at', 'od_conversion_source',
  'od_device_id', 'od_placement_id', 'od_campaign_id',
  'auth_token', 'token', 'access_token', 'id_token', 'code', 'state', 'od_auth', 'od_flow', 'od_flow_at',
  'redirect', 'return_to', 'email',
  MAGI2_MODAL_SEEN_PARAM, 'bf_modal_preview',
]);

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

export const MAGI2_MODAL_COPY: Record<Locale, Magi2ModalCopy> = {
  en: {
    script: 'latin',
    dialogLabel: 'MAGI-2 first launch 7 days unlimited Black Friday offer',
    eyebrow: '7 Days Unlimited!',
    headline: 'First Launch · MAGI-2',
    description: [
      { text: '1080p cinema video with native audio is live on OpenDesign. Save ' },
      { text: 'up to 50% OFF', strong: true },
      { text: ' Pro & Max this Black Friday and unlock ' },
      { text: '7 days unlimited', strong: true },
      { text: '.' },
    ],
    cta: 'Claim 50% Off',
    countdownPrefix: 'Ends in',
    closeLabel: 'Close MAGI-2 launch popup',
  },
  'zh-CN': {
    script: 'zh',
    dialogLabel: 'MAGI-2 全网首发 7 天无限用活动弹窗',
    eyebrow: '7 天无限用！',
    headline: '全网首发 MAGI-2',
    description: [
      { text: '全新 1080p 电影级视频模型现已上线 OpenDesign，支持原生音画同步。黑五订阅 Pro / Max ' },
      { text: '低至 5 折', strong: true },
      { text: '，同步解锁 ' },
      { text: '7 天无限用', strong: true },
      { text: '。' },
    ],
    cta: '立享 5 折',
    countdownPrefix: '黑五限时',
    closeLabel: '关闭活动弹窗',
  },
  ja: {
    script: 'cjk',
    dialogLabel: 'MAGI-2 先行公開 7日間使い放題キャンペーン',
    eyebrow: '7日間使い放題！',
    headline: '先行公開 MAGI-2',
    description: [
      { text: 'ネイティブ音声対応の1080pシネマ動画モデルがOpenDesignに登場。ブラックフライデーで Pro / Max が' },
      { text: '最大50%オフ', strong: true },
      { text: '、さらに' },
      { text: '7日間無制限', strong: true },
      { text: 'を解放。' },
    ],
    cta: '50%オフを獲得',
    countdownPrefix: '期間限定',
    closeLabel: 'キャンペーンポップアップを閉じる',
  },
  ko: {
    script: 'cjk',
    dialogLabel: 'MAGI-2 최초 공개 7일 무제한 프로모션',
    eyebrow: '7일 무제한!',
    headline: '최초 공개 MAGI-2',
    description: [
      { text: '네이티브 사운드를 지원하는 1080p 시네마 영상 모델이 OpenDesign에 출시되었습니다. 블랙프라이데이 Pro / Max ' },
      { text: '최대 50% 할인', strong: true },
      { text: '과 ' },
      { text: '7일 무제한', strong: true },
      { text: ' 혜택을 누리세요.' },
    ],
    cta: '50% 할인 받기',
    countdownPrefix: '한정 특가',
    closeLabel: '프로모션 팝업 닫기',
  },
  de: {
    script: 'latin',
    dialogLabel: 'MAGI-2 Premiere 7 Tage unbegrenzt Black Friday Angebot',
    eyebrow: '7 Tage unbegrenzt!',
    headline: 'Premiere · MAGI-2',
    description: [
      { text: '1080p-Kinovideos mit nativem Audio sind live auf OpenDesign. Zum Black Friday ' },
      { text: 'bis zu 50 % Rabatt', strong: true },
      { text: ' auf Pro & Max und ' },
      { text: '7 Tage unbegrenzt', strong: true },
      { text: ' freischalten.' },
    ],
    cta: '50 % Rabatt sichern',
    countdownPrefix: 'Endet in',
    closeLabel: 'Aktions-Popup schließen',
  },
  fr: {
    script: 'latin',
    dialogLabel: 'Offre Black Friday MAGI-2 illimité pendant 7 jours',
    eyebrow: '7 jours illimités !',
    headline: 'Avant-première · MAGI-2',
    description: [
      { text: 'La vidéo cinéma 1080p avec audio natif arrive sur OpenDesign. Profitez de ' },
      { text: 'jusqu’à -50 %', strong: true },
      { text: ' sur Pro & Max au Black Friday et débloquez ' },
      { text: '7 jours illimités', strong: true },
      { text: '.' },
    ],
    cta: 'Profiter de -50 %',
    countdownPrefix: 'Offre limitée',
    closeLabel: 'Fermer la fenêtre Black Friday',
  },
  ru: {
    script: 'latin',
    dialogLabel: 'Премьера MAGI-2: 7 дней безлимита в Чёрную пятницу',
    eyebrow: '7 дней безлимита!',
    headline: 'Премьера · MAGI-2',
    description: [
      { text: 'Кинематографическое видео 1080p с нативным звуком уже в OpenDesign. В Чёрную пятницу ' },
      { text: 'скидка до 50%', strong: true },
      { text: ' на Pro и Max плюс ' },
      { text: '7 дней безлимита', strong: true },
      { text: '.' },
    ],
    cta: 'Забрать скидку 50%',
    countdownPrefix: 'До конца',
    closeLabel: 'Закрыть окно акции',
  },
  es: {
    script: 'latin',
    dialogLabel: 'Estreno MAGI-2: oferta Black Friday 7 días ilimitados',
    eyebrow: '¡7 días ilimitados!',
    headline: 'Estreno · MAGI-2',
    description: [
      { text: 'Vídeo cinematográfico 1080p con audio nativo ya en OpenDesign. Ahorra ' },
      { text: 'hasta 50 % dto.', strong: true },
      { text: ' en Pro y Max este Black Friday y desbloquea ' },
      { text: '7 días ilimitados', strong: true },
      { text: '.' },
    ],
    cta: 'Obtener 50 % dto.',
    countdownPrefix: 'Termina en',
    closeLabel: 'Cerrar ventana de Black Friday',
  },
  'pt-BR': {
    script: 'latin',
    dialogLabel: 'Estreia MAGI-2: oferta Black Friday 7 dias ilimitados',
    eyebrow: '7 dias ilimitados!',
    headline: 'Estreia · MAGI-2',
    description: [
      { text: 'Vídeo cinematográfico 1080p com áudio nativo chegou ao OpenDesign. Garanta ' },
      { text: 'até 50% OFF', strong: true },
      { text: ' no Pro e Max nesta Black Friday e libere ' },
      { text: '7 dias ilimitados', strong: true },
      { text: '.' },
    ],
    cta: 'Garantir 50% off',
    countdownPrefix: 'Termina em',
    closeLabel: 'Fechar janela da Black Friday',
  },
  it: {
    script: 'latin',
    dialogLabel: 'Anteprima MAGI-2: offerta Black Friday 7 giorni illimitati',
    eyebrow: '7 giorni illimitati!',
    headline: 'Anteprima · MAGI-2',
    description: [
      { text: 'Video cinema 1080p con audio nativo ora su OpenDesign. Risparmia ' },
      { text: 'fino al 50%', strong: true },
      { text: ' su Pro e Max per il Black Friday e sblocca ' },
      { text: '7 giorni illimitati', strong: true },
      { text: '.' },
    ],
    cta: 'Ottieni il 50% off',
    countdownPrefix: 'Scade tra',
    closeLabel: 'Chiudi finestra Black Friday',
  },
  tr: {
    script: 'latin',
    dialogLabel: 'MAGI-2 ilk çıkış 7 gün sınırsız Black Friday kampanyası',
    eyebrow: '7 Gün Sınırsız!',
    headline: 'İlk Çıkış · MAGI-2',
    description: [
      { text: 'Doğal sesli 1080p sinematik video artık OpenDesign’da. Black Friday’de Pro ve Max’te ' },
      { text: '%50’ye varan indirim', strong: true },
      { text: ' ile ' },
      { text: '7 gün sınırsız', strong: true },
      { text: ' erişimi aç.' },
    ],
    cta: '%50 İndirimi Al',
    countdownPrefix: 'Süre sonu',
    closeLabel: 'Kampanya penceresini kapat',
  },
};

export type Magi2AudienceStatus = 'guest' | 'free' | 'paid' | 'unknown';

function normalizePaidTier(plan: unknown): string | null {
  if (typeof plan !== 'string') return null;
  const normalized = plan
    .trim()
    .toLowerCase()
    .replace(/_(monthly|yearly)$/, '')
    .replace(/^team_/, '');
  return PAID_PLAN_TIERS.has(normalized) ? normalized : null;
}

/** Classify account eligibility: guests and confirmed free users are eligible; paid or unknown fail closed. */
export function classifyMagi2Audience(
  account: Pick<CloudAccountSummary, 'state' | 'plan' | 'billingUnavailable'> | null | undefined,
): Magi2AudienceStatus {
  if (!account) return 'unknown';
  if (account.state === 'signed-out') return 'guest';
  if (account.state !== 'signed-in') return 'unknown';
  if (account.billingUnavailable) return 'unknown';
  return normalizePaidTier(account.plan) ? 'paid' : 'free';
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
  const totalLeftMs = Math.max(0, BLACK_FRIDAY_ENDS_AT - nowMs);
  const elapsedMs = Math.max(0, nowMs - BLACK_FRIDAY_STARTS_AT);
  let remMs = COUNTDOWN_CYCLE_MS - (elapsedMs % COUNTDOWN_CYCLE_MS);
  if (remMs <= 0) remMs = COUNTDOWN_CYCLE_MS;
  if (!forcePreview && totalLeftMs > 0) {
    remMs = Math.min(remMs, totalLeftMs);
  }
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
    try { window.sessionStorage.setItem(MAGI2_MODAL_DISMISSED_KEY, '1'); } catch { /* ignore */ }
    return true;
  }
  if (readMagi2SeenCookie()) return true;
  try {
    if (window.sessionStorage.getItem(MAGI2_MODAL_DISMISSED_KEY) === '1') return true;
  } catch {
    // Ignore storage unavailability.
  }
  return false;
}

export function markMagi2ModalSeen(): void {
  writeMagi2SeenCookie();
  try { window.sessionStorage.setItem(MAGI2_MODAL_DISMISSED_KEY, '1'); } catch { /* ignore */ }
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
 * choreography whenever the MAGI-2 launch modal is open or expected on this page load, avoiding
 * simultaneous foreground + background motion.
 */
export function shouldSkipExploreHeroIntro(): boolean {
  if (isMagi2ModalOpen() || isMagi2PreviewForced()) return true;
  if (!blackFridayActive()) return false;
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get(MAGI2_MODAL_SEEN_PARAM) === '1') return false;
  } catch { /* ignore */ }
  if (readMagi2SeenCookie()) return false;
  try {
    if (window.sessionStorage.getItem(MAGI2_MODAL_DISMISSED_KEY) === '1') return false;
  } catch { /* ignore */ }
  return true;
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
