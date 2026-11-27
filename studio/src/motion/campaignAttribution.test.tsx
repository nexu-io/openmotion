// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { studioEvents } from '../../../tracking/events.ts';
import { validProperties } from '../../../tracking/core.ts';
import { BlackFridayTopBanner, readBlackFridayCountdown, resetBlackFridayImpression } from './BlackFridayTopBanner';
import { ExploreBlackFridayHero, resetBlackFridayHeroImpression } from './ExploreBlackFridayHero';
import { consumeExternalCheckoutPending } from './entitlementModalBus';
import campaignUi from '../i18n/campaign-ui.json';
import {
  BLACK_FRIDAY_ENDS_AT,
  BLACK_FRIDAY_HERO_ENDS_AT,
  BLACK_FRIDAY_HERO_STARTS_AT,
  BLACK_FRIDAY_STARTS_AT,
  bannerDismissedToday,
  blackFridayActive,
  blackFridayHeroActive,
  campaignPricingUrl,
  dismissBannerToday,
  resetBannerDismissal,
} from './campaignAttribution';
import { PricingEntry } from './PricingEntry';
import { trackMotion } from './tracking';

vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
const accountSummaryHook = vi.hoisted(() => ({
  account: null as Record<string, unknown> | null,
  error: false,
}));
vi.mock('./AccountSettings', () => ({
  useAccountSummary: () => ({ account: accountSummaryHook.account, error: accountSummaryHook.error }),
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tracked = () => vi.mocked(trackMotion).mock.calls.map(([event, properties]) => ({ event, properties: properties as Record<string, unknown> }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  // Inside the campaign window unless a test moves the clock.
  accountSummaryHook.account = null;
  accountSummaryHook.error = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-25T12:00:00+08:00'));
  vi.mocked(trackMotion).mockClear();
  resetBlackFridayImpression();
  resetBlackFridayHeroImpression();
  consumeExternalCheckoutPending();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); localStorage.clear(); resetBannerDismissal(); });

const render = (node: React.ReactNode) => act(() => root.render(<I18nProvider initialLocale="zh-CN">{node}</I18nProvider>));
const params = (href: string) => new URL(href).searchParams;

it('builds a Pricing link that carries the OpenMotion entry the website keeps through checkout', () => {
  const url = new URL(campaignPricingUrl('zh-CN', 'openmotion_bf_banner', '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11', new Date('2026-11-22T00:00:00Z')));
  expect(url.origin + url.pathname).toBe('https://open-design.ai/zh/pricing/');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    od_origin: 'openmotion', od_entry_source: 'openmotion_manage_subscription', od_entry_id: '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11', od_entry_at: '2026-11-22T00:00:00.000Z',
    utm_source: 'openmotion', utm_medium: 'banner', utm_campaign: 'black_friday_2026',
  });
  expect(new URL(campaignPricingUrl('en', 'openmotion_header_pricing', 'x')).pathname).toBe('/pricing/');
  expect(params(campaignPricingUrl('en', 'openmotion_header_pricing', 'x')).get('utm_medium')).toBe('header');
  expect(params(campaignPricingUrl('en', 'openmotion_onetap', 'x')).get('utm_medium')).toBe('onetap');
  expect(params(campaignPricingUrl('en', 'openmotion_bf_hero', 'x')).get('utm_medium')).toBe('hero');
  expect(params(campaignPricingUrl('en', 'openmotion_bf_hero', 'x')).get('od_entry_source')).toBe('openmotion_manage_subscription');
  expect(params(campaignPricingUrl('en', 'openmotion_bf_hub', 'x')).get('utm_medium')).toBe('model_hub');
  expect(params(campaignPricingUrl('en', 'openmotion_bf_hub', 'x')).get('od_entry_source')).toBe('openmotion_manage_subscription');
});

it('reports one banner impression per page load and joins each claim click to its Pricing link', async () => {
  const onClose = vi.fn();
  render(<BlackFridayTopBanner trackingPage="explore" onClose={onClose} />);
  render(<BlackFridayTopBanner trackingPage="explore" onClose={onClose} />);
  expect(tracked().filter(row => row.event === 'surface_view')).toEqual([
    { event: 'surface_view', properties: { page_name: 'explore', area: 'campaign_banner', element: 'banner', campaign_id: 'black_friday_2026', hook_id: 'bf_banner' } },
  ]);

  const cta = container.querySelector<HTMLAnchorElement>('a[href*="pricing"]')!;
  cta.addEventListener('click', event => event.preventDefault());
  expect(cta.getAttribute('target')).toBeNull();
  expect(cta.getAttribute('rel')).toBeNull();
  const firstEntry = params(cta.href).get('od_entry_id');
  expect(params(cta.href).get('od_entry_source')).toBe('openmotion_manage_subscription');
  expect(params(cta.href).get('utm_medium')).toBe('banner');
  await act(async () => { cta.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const click = tracked().find(row => row.event === 'ui_click')!.properties;
  expect(click).toMatchObject({ page_name: 'explore', area: 'campaign_banner', element: 'claim_offer', campaign_id: 'black_friday_2026', entry_id: firstEntry });
  expect(params(cta.href).get('od_entry_id')).not.toBe(firstEntry);

  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="关闭活动 Banner"]')!.click());
  expect(tracked().at(-1)).toMatchObject({ event: 'ui_click', properties: { area: 'campaign_banner', element: 'close_banner' } });
  expect(onClose).toHaveBeenCalledOnce();
});

it('reports the header Pricing click with the entry id on its link', async () => {
  render(<PricingEntry trackingPage="studio" />);
  const link = container.querySelector<HTMLAnchorElement>('a')!;
  link.addEventListener('click', event => event.preventDefault());
  expect(link.getAttribute('target')).toBeNull();
  const entry = params(link.href).get('od_entry_id');
  expect(params(link.href).get('od_entry_source')).toBe('openmotion_manage_subscription');
  await act(async () => { link.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(tracked()).toEqual([{ event: 'ui_click', properties: expect.objectContaining({ page_name: 'studio', area: 'header', element: 'open_pricing', campaign_id: 'black_friday_2026', entry_id: entry }) }]);
});

it('always routes browser cloud OIDC Pricing clicks through /auth/upgrade-handoff (even when cached probe was signed-out) and keeps direct Pricing only in dev/desktop mode', async () => {
  // 1. Account probe still in-flight (account === null) -> MUST route through same-origin /auth/upgrade-handoff
  accountSummaryHook.account = null;
  accountSummaryHook.error = false;
  render(<PricingEntry trackingPage="studio" />);
  let url = new URL(container.querySelector<HTMLAnchorElement>('a')!.href);
  expect(url.pathname).toBe('/auth/upgrade-handoff');
  expect(url.searchParams.get('targetPath')).toBe('/zh/pricing');

  // 2. Account probe failed (error === true) -> MUST NOT bypass upgrade handoff
  accountSummaryHook.account = { state: 'signed-out', authMode: 'oidc', consoleUrl: 'https://open-design.ai/cloud' };
  accountSummaryHook.error = true;
  render(<PricingEntry trackingPage="studio" />);
  url = new URL(container.querySelector<HTMLAnchorElement>('a')!.href);
  expect(url.pathname).toBe('/auth/upgrade-handoff');
  expect(url.searchParams.get('targetPath')).toBe('/zh/pricing');

  // 3. Cached signed-out state in browser OIDC mode -> STILL routes through /auth/upgrade-handoff
  // so a stale guest tab cannot bypass billing handoff after another tab signed in.
  accountSummaryHook.account = { state: 'signed-out', authMode: 'oidc', consoleUrl: 'https://open-design.ai/cloud' };
  accountSummaryHook.error = false;
  render(<PricingEntry trackingPage="studio" />);
  url = new URL(container.querySelector<HTMLAnchorElement>('a')!.href);
  expect(url.pathname).toBe('/auth/upgrade-handoff');
  expect(url.searchParams.get('targetPath')).toBe('/zh/pricing');

  // 3b. Local dev auth mode keeps direct public Pricing URL
  accountSummaryHook.account = { state: 'signed-out', authMode: 'dev', consoleUrl: 'https://open-design.ai/cloud' };
  accountSummaryHook.error = false;
  render(<PricingEntry trackingPage="studio" />);
  url = new URL(container.querySelector<HTMLAnchorElement>('a')!.href);
  expect(url.origin + url.pathname).toBe('https://open-design.ai/zh/pricing/');

  // 4. Signed-in OIDC user -> /auth/upgrade-handoff with aligned /zh/pricing targetPath
  accountSummaryHook.account = {
    state: 'signed-in',
    authMode: 'oidc',
    userId: 'u-b',
    appUserId: 'usr_app_b',
    consoleUrl: 'https://open-design.ai/cloud',
  };
  accountSummaryHook.error = false;
  render(<PricingEntry trackingPage="studio" />);
  const link = container.querySelector<HTMLAnchorElement>('a')!;
  url = new URL(link.href);
  expect(url.pathname).toBe('/auth/upgrade-handoff');
  expect(url.searchParams.get('targetPath')).toBe('/zh/pricing');
  expect(url.searchParams.get('requireAuth')).toBe('1');
  expect(url.searchParams.get('expectedAppUserId')).toBe('usr_app_b');
  expect(url.searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');
  expect(url.searchParams.get('utm_medium')).toBe('header');
});

it('registers every reported campaign event in the closed schema', () => {
  const id = '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11';
  for (const [event, properties] of [
    ['surface_view', { page_name: 'explore', area: 'campaign_banner', element: 'banner', campaign_id: 'black_friday_2026' }],
    ['ui_click', { page_name: 'explore', area: 'campaign_banner', element: 'claim_offer', campaign_id: 'black_friday_2026', entry_id: id, interaction_method: 'pointer' }],
    ['ui_click', { page_name: 'studio', area: 'campaign_banner', element: 'close_banner', campaign_id: 'black_friday_2026', interaction_method: 'keyboard' }],
    ['ui_click', { page_name: 'studio', area: 'header', element: 'open_pricing', campaign_id: 'black_friday_2026', entry_id: id, interaction_method: 'pointer' }],
  ] as const) expect(validProperties(studioEvents, event, properties)).toBe(true);
  expect(validProperties(studioEvents, 'ui_click', { page_name: 'studio', area: 'header', element: 'open_pricing', campaign_id: 'cyber_monday' })).toBe(false);
});

it('shows the campaign only inside its window and drops campaign fields afterwards', async () => {
  expect(BLACK_FRIDAY_STARTS_AT).toBe(Date.parse('2026-11-21T18:00:00+08:00'));
  expect(blackFridayActive(BLACK_FRIDAY_STARTS_AT - 1)).toBe(false);
  expect(blackFridayActive(BLACK_FRIDAY_STARTS_AT)).toBe(true);
  expect(blackFridayActive(Date.parse('2026-11-25T12:00:00+08:00'))).toBe(true);
  expect(blackFridayActive(BLACK_FRIDAY_ENDS_AT - 1)).toBe(true);
  expect(blackFridayActive(BLACK_FRIDAY_ENDS_AT)).toBe(false);
  expect(params(campaignPricingUrl('en', 'openmotion_header_pricing', 'x', new Date(BLACK_FRIDAY_ENDS_AT))).has('utm_campaign')).toBe(false);

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BLACK_FRIDAY_ENDS_AT + 60_000);
  render(<PricingEntry trackingPage="studio" />);
  const link = container.querySelector<HTMLAnchorElement>('a')!;
  link.addEventListener('click', event => event.preventDefault());
  expect(container.textContent).not.toContain('50% OFF');
  expect(link.getAttribute('aria-label')).toBe('Pricing');
  await act(async () => { link.click(); });
  expect(tracked().at(-1)?.properties).not.toHaveProperty('campaign_id');
  expect(params(link.href).get('od_entry_source')).toBe('openmotion_manage_subscription');
});

it('keeps a dismissed banner hidden for the rest of the local day only', () => {
  const evening = new Date(2026, 10, 25, 23, 30);
  expect(bannerDismissedToday(evening)).toBe(false);
  dismissBannerToday(evening);
  expect(bannerDismissedToday(new Date(2026, 10, 25, 23, 59))).toBe(true);
  expect(bannerDismissedToday(new Date(2026, 10, 26, 0, 1))).toBe(false);
});

it('localizes the banner and the Pricing label in every supported language', () => {
  for (const locale of ['zh-CN', 'ja', 'ko', 'de', 'fr', 'ru', 'es', 'pt-BR', 'it', 'tr'] as const) {
    const messages = campaignUi[locale];
    act(() => root.render(<I18nProvider key={locale} initialLocale={locale}><BlackFridayTopBanner trackingPage="explore" onClose={() => {}} /><PricingEntry trackingPage="studio" /></I18nProvider>));
    expect(container.textContent).toContain(messages['Claim offer']);
    expect(container.textContent).toContain(messages['7-day unlimited image gen']);
    expect(container.querySelector('aside')!.getAttribute('aria-label')).toBe(messages['Black Friday campaign banner']);
    expect(container.querySelector('a[aria-label^="Pricing"]')!.getAttribute('aria-label')).toBe(messages['Pricing · Black Friday up to 50% off']);
  }
});

it('drops the Pricing badge and campaign fields when the campaign ends while the page stays open', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(BLACK_FRIDAY_ENDS_AT - 30_000);
  render(<PricingEntry trackingPage="studio" />);
  expect(container.textContent).toContain('50% OFF');
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.textContent).not.toContain('50% OFF');
  const link = container.querySelector<HTMLAnchorElement>('a')!;
  link.addEventListener('click', event => event.preventDefault());
  await act(async () => { link.click(); });
  expect(tracked().at(-1)?.properties).not.toHaveProperty('campaign_id');
});

it('keeps a dismissal for the day in the page when storage is unavailable', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  const noon = new Date(2026, 10, 25, 12);
  dismissBannerToday(noon);
  expect(bannerDismissedToday(noon)).toBe(true);
  expect(bannerDismissedToday(new Date(2026, 10, 26, 9))).toBe(false);
  setItem.mockRestore();
});

it('keeps the Pricing entry with localized Free credits badge before the campaign starts', () => {
  vi.setSystemTime(BLACK_FRIDAY_STARTS_AT - 60_000);
  render(<PricingEntry trackingPage="studio" />);
  expect(container.textContent).not.toContain('50% OFF');
  expect(container.textContent).toContain(campaignUi['zh-CN']['Free credits']);
  expect(params(container.querySelector<HTMLAnchorElement>('a')!.href).has('utm_campaign')).toBe(false);
  act(() => root.render(<I18nProvider key="en" initialLocale="en"><PricingEntry trackingPage="studio" /></I18nProvider>));
  expect(container.textContent).toContain('Free credits');
  for (const locale of ['zh-CN', 'ja', 'ko', 'de', 'fr', 'ru', 'es', 'pt-BR', 'it', 'tr'] as const) {
    act(() => root.render(<I18nProvider key={locale} initialLocale={locale}><PricingEntry trackingPage="studio" /></I18nProvider>));
    expect(container.textContent).toContain(campaignUi[locale]['Free credits']);
  }
});

it('repeats a 12-hour countdown anchored at 2026-11-21 18:00 +08:00 and expires after 2026-12-04 23:59:59 +08:00', async () => {
  expect(readBlackFridayCountdown(Date.parse('2026-11-21T18:00:00+08:00'))).toEqual({
    hours: '11', minutes: '59', seconds: '59', datetime: 'PT11H59M59S',
  });
  expect(readBlackFridayCountdown(Date.parse('2026-11-22T00:00:00+08:00'))).toEqual({
    hours: '05', minutes: '59', seconds: '59', datetime: 'PT05H59M59S',
  });
  expect(readBlackFridayCountdown(Date.parse('2026-11-22T05:59:59+08:00'))).toEqual({
    hours: '00', minutes: '00', seconds: '00', datetime: 'PT00H00M00S',
  });
  expect(readBlackFridayCountdown(Date.parse('2026-11-22T06:00:00+08:00'))).toEqual({
    hours: '11', minutes: '59', seconds: '59', datetime: 'PT11H59M59S',
  });
  expect(readBlackFridayCountdown(Date.parse('2026-11-22T18:00:00+08:00'))).toEqual({
    hours: '11', minutes: '59', seconds: '59', datetime: 'PT11H59M59S',
  });
  expect(readBlackFridayCountdown(Date.parse('2026-12-04T18:00:00+08:00'))).toEqual({
    hours: '05', minutes: '59', seconds: '59', datetime: 'PT05H59M59S',
  });
  expect(readBlackFridayCountdown(Date.parse('2026-12-04T23:59:59+08:00'))).toEqual({
    hours: '00', minutes: '00', seconds: '00', datetime: 'PT00H00M00S',
  });

  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(Date.parse('2026-12-04T23:59:58+08:00'));
  const onExpire = vi.fn();
  render(<BlackFridayTopBanner trackingPage="explore" onClose={() => {}} onExpire={onExpire} />);
  const timeEl = container.querySelector('time')!;
  expect(timeEl.getAttribute('datetime')).toBe('PT00H00M01S');
  expect(timeEl.textContent).toBe('00:00:01');

  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(timeEl.textContent).toBe('00:00:00');
  expect(onExpire).not.toHaveBeenCalled();

  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(onExpire).toHaveBeenCalledOnce();
});

it('activates the Explore Black Friday hero from 2026-11-25 20:00 +08:00 until 2026-12-04 23:59:59 +08:00 with a 12h rolling countdown', async () => {
  expect(BLACK_FRIDAY_HERO_STARTS_AT).toBe(Date.parse('2026-11-25T20:00:00+08:00'));
  expect(BLACK_FRIDAY_HERO_ENDS_AT).toBe(Date.parse('2026-12-05T00:00:00+08:00'));
  expect(blackFridayHeroActive(BLACK_FRIDAY_HERO_STARTS_AT - 1)).toBe(false);
  expect(blackFridayHeroActive(BLACK_FRIDAY_HERO_STARTS_AT)).toBe(true);
  expect(blackFridayHeroActive(Date.parse('2026-12-04T23:59:59+08:00'))).toBe(true);
  expect(blackFridayHeroActive(BLACK_FRIDAY_HERO_ENDS_AT)).toBe(false);

  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(Date.parse('2026-12-04T23:59:58+08:00'));
  const onExpire = vi.fn();
  render(<ExploreBlackFridayHero onExpire={onExpire} />);
  const cta = container.querySelector<HTMLAnchorElement>('a[href*="pricing"]')!;
  expect(cta.getAttribute('target')).toBeNull();
  expect(cta.getAttribute('rel')).toBeNull();
  const timeEl = container.querySelector('time')!;
  expect(timeEl.getAttribute('datetime')).toBe('PT00H00M01S');

  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(timeEl.getAttribute('datetime')).toBe('PT00H00M00S');
  expect(onExpire).not.toHaveBeenCalled();

  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(onExpire).toHaveBeenCalledOnce();
});

it('localizes the Explore Black Friday hero across all 10 non-English locales with script-aware layout hooks', () => {
  vi.setSystemTime(BLACK_FRIDAY_HERO_STARTS_AT);
  for (const locale of ['zh-CN', 'ja', 'ko', 'de', 'fr', 'ru', 'es', 'pt-BR', 'it', 'tr'] as const) {
    const messages = campaignUi[locale];
    act(() => root.render(<I18nProvider key={locale} initialLocale={locale}><ExploreBlackFridayHero /></I18nProvider>));
    const section = container.querySelector('section[data-bf-hero]')!;
    expect(section.getAttribute('aria-label')).toBe(messages['Black Friday flagship image 7 days unlimited hero']);
    expect(section.getAttribute('data-script')).toBe(locale === 'zh-CN' ? 'zh' : (locale === 'ja' || locale === 'ko') ? 'cjk' : 'latin');
    expect(container.textContent).toContain(messages['Flagship Image · 7 Days Unlimited']);
    expect(container.textContent).toContain(messages['Claim 50% Off']);
    expect(container.textContent).toContain(messages['Annual Pro & Max']);
    expect(container.textContent).toContain(messages['API Supported']);
    expect(container.textContent).toContain(messages['Up to 50% off annual']);
  }
});

it('reports ExploreBlackFridayHero impression once per page load, bf_hero CTA click with utm_medium=hero, and marks checkout return', async () => {
  vi.setSystemTime(BLACK_FRIDAY_HERO_STARTS_AT);
  render(<ExploreBlackFridayHero />);
  render(<ExploreBlackFridayHero />);
  expect(tracked().filter(row => row.event === 'surface_view')).toEqual([
    { event: 'surface_view', properties: { page_name: 'explore', area: 'campaign_banner', element: 'banner', campaign_id: 'black_friday_2026', hook_id: 'bf_hero' } },
  ]);

  const cta = container.querySelector<HTMLAnchorElement>('a[href*="pricing"]')!;
  cta.addEventListener('click', event => event.preventDefault());
  const heroEntryId = params(cta.href).get('od_entry_id');
  expect(params(cta.href).get('od_entry_source')).toBe('openmotion_manage_subscription');
  expect(params(cta.href).get('utm_medium')).toBe('hero');

  await act(async () => { cta.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(tracked().find(row => row.event === 'ui_click')?.properties).toMatchObject({
    page_name: 'explore',
    area: 'campaign_banner',
    element: 'claim_offer',
    campaign_id: 'black_friday_2026',
    hook_id: 'bf_hero',
    entry_id: heroEntryId,
  });
  expect(params(cta.href).get('od_entry_id')).not.toBe(heroEntryId);
  expect(consumeExternalCheckoutPending()).toEqual({ hookId: 'bf_hero', entryId: heroEntryId });

  for (const row of tracked()) {
    expect(validProperties(studioEvents, row.event, row.properties), JSON.stringify(row)).toBe(true);
  }
});

it('navigates Pricing links in the same tab in top-level browsers and keeps _blank in desktop or embedded iframes', () => {
  render(<PricingEntry trackingPage="studio" />);
  expect(container.querySelector('a')?.getAttribute('target')).toBeNull();
  expect(container.querySelector('a')?.getAttribute('rel')).toBeNull();

  window.__OPENMOTION_HOST__ = {
    info: async () => ({
      hostKind: 'desktop',
      shellVersion: '0.2.2',
      contractVersion: '1.0',
      platform: 'darwin',
      arch: 'arm64',
      releaseChannel: 'stable',
      isPackaged: true,
    }),
    capabilities: async () => [],
    invoke: async () => ({ ok: true, data: {} }),
    subscribe: () => () => {},
  };
  try {
    render(<BlackFridayTopBanner trackingPage="explore" onClose={() => {}} />);
    const bannerCta = container.querySelector<HTMLAnchorElement>('a[href*="pricing"]');
    expect(bannerCta?.getAttribute('target')).toBe('_blank');
    expect(bannerCta?.getAttribute('rel')).toBe('noopener noreferrer');

    vi.setSystemTime(BLACK_FRIDAY_HERO_STARTS_AT);
    render(<ExploreBlackFridayHero />);
    const heroCta = container.querySelector<HTMLAnchorElement>('a[href*="pricing"]');
    expect(heroCta?.getAttribute('target')).toBe('_blank');
    expect(heroCta?.getAttribute('rel')).toBe('noopener noreferrer');
  } finally {
    delete window.__OPENMOTION_HOST__;
  }
});

it('uses direct public Pricing URL when server reports upgradeHandoffEnabled=false in OIDC mode', () => {
  accountSummaryHook.account = {
    state: 'signed-in',
    authMode: 'oidc',
    upgradeHandoffEnabled: false,
    appUserId: 'usr_app_1',
    consoleUrl: 'https://open-design.ai/cloud',
  };
  render(<PricingEntry trackingPage="studio" />);
  const link = container.querySelector<HTMLAnchorElement>('a')!;
  const url = new URL(link.href);
  expect(url.origin).toBe('https://open-design.ai');
  expect(url.pathname).toBe('/zh/pricing/');
});
