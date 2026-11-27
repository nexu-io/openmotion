// @vitest-environment happy-dom
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../i18n/I18n';
import campaignUi from '../i18n/campaign-ui.json';
import { languages, type Locale } from '../i18n/manifest';
import {
  MAGI2_MODAL_COPY_MESSAGES,
  MAGI2_MODAL_COUNTDOWN_CONTEXT,
  MAGI2_MODAL_DISMISSED_STORAGE_NAME,
  MAGI2_MODAL_SEEN_COOKIE,
  MAGI2_MODAL_VIDEO_URL,
  buildMagi2ConsolePlanUrl,
  isMagi2ModalOpen,
  readMagi2CountdownParts,
  resolveMagi2ModalCopy,
  shouldSkipExploreHeroIntro,
} from './magi2LaunchModalConfig';

const mockAccountState = vi.hoisted(() => ({
  account: null as {
    state: string;
    plan?: string;
    billingUnavailable?: boolean;
    mediaEntitlement?: 'included' | 'not-included' | 'unknown';
    consoleUrl?: string;
  } | null,
  error: false,
  locale: 'zh-CN' as Locale,
}));

vi.mock('./AccountSettings', () => ({
  useAccountSummary: () => ({
    account: mockAccountState.account,
    error: mockAccountState.error,
    refresh: vi.fn(),
    setAccount: vi.fn(),
  }),
}));
vi.mock('./tracking', () => ({ trackMotion: vi.fn() }));
vi.mock('./entitlementModalBus', () => ({ markExternalCheckoutPending: vi.fn() }));

import { ExploreBlackFridayHero, resetBlackFridayHeroImpression } from './ExploreBlackFridayHero';
import { MAGI2_MODAL_EXIT_MS, Magi2LaunchModal } from './Magi2LaunchModal';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function clearCookies() {
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

function renderWithI18n(node: React.ReactNode, locale: Locale = mockAccountState.locale) {
  act(() => {
    root.render(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T12:00:00+08:00'));
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16),
  );
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    window.clearTimeout(id);
  });
  clearCookies();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  delete document.documentElement.dataset.magi2ModalOpen;
  resetBlackFridayHeroImpression();
  mockAccountState.account = null;
  mockAccountState.error = false;
  mockAccountState.locale = 'zh-CN';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearCookies();
  window.sessionStorage.clear();
  window.localStorage.clear();
  delete document.documentElement.dataset.magi2ModalOpen;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Magi2LaunchModal logic & assets', () => {
  it('provides complete localized copy across all 11 supported locales via lazy campaign-ui i18n resources', () => {
    expect(languages).toHaveLength(11);
    const en = resolveMagi2ModalCopy('en', (msg, vals, ctx) => translate('en', msg, vals, ctx));
    expect(en.eyebrow).toBe('7 Days Unlimited!');
    expect(en.headline).toBe('First Launch · MAGI-2');
    expect(en.cta).toBe('Start Unlimited');
    expect(en.countdownPrefix).toBe('Ends in');
    expect(en.description.some(s => s.strong && s.text === 'any annual plan')).toBe(true);

    // Ensure the modal countdown context does not clobber BlackFridayTopBanner's "Ends in".
    expect(translate('zh-CN', 'Ends in')).toBe('距结束');
    expect(translate('zh-CN', 'Ends in', undefined, MAGI2_MODAL_COUNTDOWN_CONTEXT)).toBe('黑五限时');

    for (const { locale } of languages) {
      const copy = resolveMagi2ModalCopy(locale, (msg, vals, ctx) => translate(locale, msg, vals, ctx));
      expect(copy.eyebrow.trim().length, locale).toBeGreaterThan(0);
      expect(copy.headline, locale).toContain('MAGI-2');
      expect(copy.description.some(s => s.strong), locale).toBe(true);
      expect(copy.cta.trim().length, locale).toBeGreaterThan(0);
      expect(copy.countdownPrefix.trim().length, locale).toBeGreaterThan(0);
      expect(copy.closeLabel.trim().length, locale).toBeGreaterThan(0);
      if (locale !== 'en') {
        const dict = campaignUi[locale];
        expect(dict[MAGI2_MODAL_COPY_MESSAGES.dialogLabel], locale).toBeTruthy();
        expect(dict[MAGI2_MODAL_COPY_MESSAGES.eyebrow], locale).toBeTruthy();
        expect(dict[MAGI2_MODAL_COPY_MESSAGES.headline], locale).toBeTruthy();
        expect(dict[MAGI2_MODAL_COPY_MESSAGES.description], locale).toBeTruthy();
        expect(dict[MAGI2_MODAL_COPY_MESSAGES.cta], locale).toBeTruthy();
        expect(dict[`${MAGI2_MODAL_COPY_MESSAGES.countdownPrefix} (${MAGI2_MODAL_COUNTDOWN_CONTEXT})`], locale).toBeTruthy();
        expect(dict[MAGI2_MODAL_COPY_MESSAGES.closeLabel], locale).toBeTruthy();
        expect(copy.eyebrow, locale).not.toBe(en.eyebrow);
        expect(copy.headline, locale).not.toBe(en.headline);
        expect(copy.cta, locale).not.toBe(en.cta);
      }
    }
  });

  it('computes 12-hour rolling countdown with centiseconds', () => {
    expect(readMagi2CountdownParts(Date.parse('2026-11-21T18:00:00.250+08:00'), false)).toEqual([11, 59, 59, 75]);
    expect(readMagi2CountdownParts(Date.parse('2026-12-05T00:00:00+08:00'), false)).toEqual([0, 0, 0, 0]);
  });

  it('routes CTA directly to Cloud Console /cloud/dashboard?billing=plan while preserving UTMs and stripping control keys', () => {
    const url = new URL(
      buildMagi2ConsolePlanUrl('11111111-2222-3333-4444-555555555555', {
        locationHref: 'https://app.open-design.ai/explore?utm_campaign=custom&gclid=abc&token=secret&redirect=https://evil.test&billing=hijack&partner=p1',
        at: new Date('2026-11-27T04:00:00.000Z'),
      }),
    );
    expect(url.origin).toBe('https://open-design.ai');
    expect(url.pathname).toBe('/cloud/dashboard');
    expect(url.searchParams.get('billing')).toBe('plan');
    expect(url.searchParams.get('od_origin')).toBe('openmotion');
    expect(url.searchParams.get('od_entry_id')).toBe('11111111-2222-3333-4444-555555555555');
    expect(url.searchParams.get('gclid')).toBe('abc');
    expect(url.searchParams.get('partner')).toBe('p1');
    expect(url.searchParams.get('od_bf_placement')).toBe('black_friday_modal');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.has('redirect')).toBe(false);
  });

  it('loads the launch video remotely over HTTPS and keeps only the lightweight WebP poster locally', () => {
    expect(MAGI2_MODAL_VIDEO_URL).toBe('https://open-design.ai/black-friday-modal/magi2-planet-6s.mp4');
    expect(MAGI2_MODAL_VIDEO_URL.startsWith('https://')).toBe(true);
    expect(existsSync(resolve(import.meta.dirname, './black-friday-modal/magi2-planet-6s.mp4'))).toBe(false);
    const posterBytes = statSync(resolve(import.meta.dirname, './black-friday-modal/magi2-planet-poster.webp')).size;
    expect(posterBytes).toBeLessThan(80 * 1024);
  });
});

describe('Magi2LaunchModal runtime behavior', () => {
  it('opens for guests, writes shared od_bf_magi2_modal_seen cookie, uses remote video URL, and renders console plan CTA', () => {
    mockAccountState.account = { state: 'signed-out' };
    renderWithI18n(<Magi2LaunchModal trackingPage="explore" />);
    const modal = document.querySelector('[data-testid="magi2-launch-modal"]');
    expect(modal).toBeTruthy();
    expect(document.querySelector('[data-testid="magi2-launch-modal-headline"]')?.textContent).toBe('全网首发 MAGI-2');
    const video = document.querySelector<HTMLVideoElement>('[data-testid="magi2-launch-modal-video"]');
    expect(video?.getAttribute('src')).toBe(MAGI2_MODAL_VIDEO_URL);
    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="magi2-launch-modal-cta"]');
    expect(cta?.href).toContain('https://open-design.ai/cloud/dashboard?billing=plan');
    expect(cta?.textContent).toContain('立即无限使用');
    expect(document.cookie).toContain(`${MAGI2_MODAL_SEEN_COOKIE}=1`);
    expect(window.sessionStorage.getItem(MAGI2_MODAL_DISMISSED_STORAGE_NAME)).toBe('1');
  });

  it('opens for ALL user plans, entitlements, unavailable billing, and loading/unknown accounts without gating', () => {
    const scenarios: Array<{
      label: string;
      account: typeof mockAccountState.account;
      error?: boolean;
    }> = [
      { label: 'signed-out', account: { state: 'signed-out' } },
      { label: 'free', account: { state: 'signed-in', plan: 'free' } },
      { label: 'go', account: { state: 'signed-in', plan: 'go' } },
      { label: 'go_plus', account: { state: 'signed-in', plan: 'go_plus' } },
      { label: 'pro', account: { state: 'signed-in', plan: 'pro' } },
      { label: 'max', account: { state: 'signed-in', plan: 'max' } },
      { label: 'ultra', account: { state: 'signed-in', plan: 'ultra' } },
      { label: 'team', account: { state: 'signed-in', plan: 'team' } },
      { label: 'enterprise', account: { state: 'signed-in', plan: 'enterprise', consoleUrl: 'https://staging.open-design.ai/cloud' } },
      { label: 'mediaEntitlement included', account: { state: 'signed-in', plan: 'pro', mediaEntitlement: 'included' } },
      { label: 'billingUnavailable', account: { state: 'signed-in', plan: 'free', billingUnavailable: true } },
      { label: 'account null (loading)', account: null },
      { label: 'account null with lookup error', account: null, error: true },
    ];

    for (const scenario of scenarios) {
      clearCookies();
      window.sessionStorage.clear();
      act(() => root.unmount());
      root = createRoot(host);
      mockAccountState.account = scenario.account;
      mockAccountState.error = scenario.error ?? false;

      renderWithI18n(<Magi2LaunchModal trackingPage="explore" />);
      expect(document.querySelector('[data-testid="magi2-launch-modal"]'), scenario.label).toBeTruthy();

      if (scenario.account?.consoleUrl) {
        const cta = document.querySelector<HTMLAnchorElement>('[data-testid="magi2-launch-modal-cta"]');
        expect(cta?.href).toContain('https://staging.open-design.ai/cloud/dashboard?billing=plan');
      }
    }
  });

  it('respects the Black Friday campaign window unless bf_modal_preview=1 is set', () => {
    vi.setSystemTime(new Date('2026-12-06T12:00:00+08:00'));
    mockAccountState.account = { state: 'signed-out' };
    renderWithI18n(<Magi2LaunchModal trackingPage="explore" />);
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();

    // Preview mode bypasses both campaign window and session dedup cookie.
    document.cookie = `${MAGI2_MODAL_SEEN_COOKIE}=1; path=/`;
    window.history.replaceState({}, '', '/?bf_modal_preview=1');
    act(() => root.unmount());
    root = createRoot(host);
    renderWithI18n(<Magi2LaunchModal trackingPage="explore" />);
    act(() => vi.advanceTimersByTime(140));
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeTruthy();
  });

  it('suppresses duplicate popup when od_bf_magi2_modal_seen cookie exists, but ignores legacy od_bf_home_modal_seen', () => {
    document.cookie = 'od_bf_home_modal_seen=1; path=/';
    mockAccountState.account = { state: 'signed-in', plan: 'free' };
    renderWithI18n(<Magi2LaunchModal trackingPage="explore" />);
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(host);
    // od_bf_magi2_modal_seen cookie is now set, so a fresh mount is suppressed.
    renderWithI18n(<Magi2LaunchModal trackingPage="explore" />);
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();
  });

  it('plays the 280ms exit animation on user close before unmounting, while external suppression unmounts immediately', () => {
    mockAccountState.account = { state: 'signed-out' };
    renderWithI18n(<Magi2LaunchModal trackingPage="explore" />);
    act(() => vi.advanceTimersByTime(20));

    const backdrop = document.querySelector<HTMLElement>('[data-testid="magi2-launch-modal-backdrop"]')!;
    expect(backdrop.dataset.open).toBe('true');

    const closeBtn = document.querySelector<HTMLButtonElement>('[data-testid="magi2-launch-modal-close"]')!;
    act(() => closeBtn.click());

    // Immediately after click: data-open flips to false, but modal remains mounted for the 280ms exit transition.
    expect(document.querySelector<HTMLElement>('[data-testid="magi2-launch-modal-backdrop"]')?.dataset.open).toBe('false');
    act(() => vi.advanceTimersByTime(MAGI2_MODAL_EXIT_MS - 40));
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeTruthy();

    // Once 280ms elapses, the modal unmounts cleanly.
    act(() => vi.advanceTimersByTime(60));
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();

    // External suppression unmounts immediately without waiting 280ms.
    clearCookies();
    window.sessionStorage.clear();
    act(() => root.unmount());
    root = createRoot(host);
    renderWithI18n(<Magi2LaunchModal trackingPage="explore" suppressed={false} />);
    act(() => vi.advanceTimersByTime(20));
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeTruthy();

    renderWithI18n(<Magi2LaunchModal trackingPage="explore" suppressed={true} />);
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();
  });

  it('manages dialog focus on open, closes on Escape, and restores prior focus via useDialogBehavior', () => {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = 'Trigger';
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    try {
      mockAccountState.account = { state: 'signed-out' };
      renderWithI18n(<Magi2LaunchModal trackingPage="explore" />);
      const backdrop = document.querySelector<HTMLElement>('[data-testid="magi2-launch-modal-backdrop"]')!;
      expect(backdrop.contains(document.activeElement)).toBe(true);

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(backdrop.dataset.open).toBe('false');
      expect(document.activeElement).toBe(trigger);

      act(() => vi.advanceTimersByTime(MAGI2_MODAL_EXIT_MS + 20));
      expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();
    } finally {
      trigger.remove();
    }
  });

  it('keeps ExploreBlackFridayHero full intro when modal is already seen or suppressed, and collapses/pauses Hero while modal is open', () => {
    // 1. Already-seen visitor: modal does not open, Hero intro must NOT be suppressed or collapsed.
    document.cookie = `${MAGI2_MODAL_SEEN_COOKIE}=1; path=/`;
    mockAccountState.account = { state: 'signed-in', plan: 'pro' };
    expect(shouldSkipExploreHeroIntro()).toBe(false);
    renderWithI18n(
      <>
        <ExploreBlackFridayHero />
        <Magi2LaunchModal trackingPage="explore" />
      </>,
    );
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();
    let hero = document.querySelector<HTMLElement>('section[data-bf-hero]')!;
    expect(hero.dataset.collapsed).toBe('false');
    expect(hero.dataset.instant).toBeUndefined();
    expect(hero.dataset.playing).toBe('true');

    // 2. Externally suppressed modal: Hero intro must NOT start collapsed.
    clearCookies();
    window.sessionStorage.clear();
    act(() => root.unmount());
    root = createRoot(host);
    resetBlackFridayHeroImpression();
    mockAccountState.account = null;
    renderWithI18n(
      <>
        <ExploreBlackFridayHero />
        <Magi2LaunchModal trackingPage="explore" suppressed />
      </>,
    );
    hero = document.querySelector<HTMLElement>('section[data-bf-hero]')!;
    expect(hero.dataset.collapsed).toBe('false');
    expect(hero.dataset.instant).toBeUndefined();
    expect(hero.dataset.playing).toBe('true');
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();
    expect(isMagi2ModalOpen()).toBe(false);

    // 3. Eligible visit (including paid tiers): once modal opens, Hero collapses and pauses; after modal closes, Hero resumes playing.
    act(() => root.unmount());
    root = createRoot(host);
    resetBlackFridayHeroImpression();
    mockAccountState.account = { state: 'signed-in', plan: 'pro' };
    renderWithI18n(
      <>
        <ExploreBlackFridayHero />
        <Magi2LaunchModal trackingPage="explore" />
      </>,
    );
    expect(isMagi2ModalOpen()).toBe(true);
    expect(shouldSkipExploreHeroIntro()).toBe(true);
    hero = document.querySelector<HTMLElement>('section[data-bf-hero]')!;
    expect(hero.dataset.collapsed).toBe('true');
    expect(hero.dataset.playing).toBe('false');

    const closeBtn = document.querySelector<HTMLButtonElement>('[data-testid="magi2-launch-modal-close"]')!;
    act(() => closeBtn.click());
    act(() => vi.advanceTimersByTime(MAGI2_MODAL_EXIT_MS + 40));
    expect(isMagi2ModalOpen()).toBe(false);
    expect(shouldSkipExploreHeroIntro()).toBe(false);
    expect(hero.dataset.playing).toBe('true');
  });
});
