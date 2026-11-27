// @vitest-environment happy-dom
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { languages, type Locale } from '../i18n/manifest';
import {
  MAGI2_MODAL_AUDIENCE_TIMEOUT_MS,
  MAGI2_MODAL_COPY,
  MAGI2_MODAL_DISMISSED_KEY,
  MAGI2_MODAL_SEEN_COOKIE,
  buildMagi2ConsolePlanUrl,
  classifyMagi2Audience,
  readMagi2CountdownParts,
} from './magi2LaunchModalConfig';

const mockAccountState = vi.hoisted(() => ({
  account: null as { state: string; plan?: string; billingUnavailable?: boolean; consoleUrl?: string } | null,
  error: false,
  locale: 'zh-CN' as Locale,
}));

vi.mock('../i18n/I18n', () => ({
  useI18n: () => ({ locale: mockAccountState.locale, t: (s: string) => s }),
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

import { Magi2LaunchModal } from './Magi2LaunchModal';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function clearCookies() {
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T12:00:00+08:00'));
  clearCookies();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
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
  vi.useRealTimers();
});

describe('Magi2LaunchModal logic & assets', () => {
  it('provides complete localized copy across all 11 supported locales', () => {
    expect(languages).toHaveLength(11);
    const en = MAGI2_MODAL_COPY.en;
    for (const { locale } of languages) {
      const copy = MAGI2_MODAL_COPY[locale];
      expect(copy, `missing ${locale}`).toBeTruthy();
      expect(copy.eyebrow.trim().length).toBeGreaterThan(0);
      expect(copy.headline).toContain('MAGI-2');
      expect(copy.description.some(s => s.strong)).toBe(true);
      expect(copy.cta.trim().length).toBeGreaterThan(0);
      expect(copy.countdownPrefix.trim().length).toBeGreaterThan(0);
      if (locale !== 'en') {
        expect(copy.eyebrow).not.toBe(en.eyebrow);
        expect(copy.headline).not.toBe(en.headline);
        expect(copy.cta).not.toBe(en.cta);
      }
    }
  });

  it('classifies guests and free users as eligible and paid/unknown users as ineligible', () => {
    expect(classifyMagi2Audience(null)).toBe('unknown');
    expect(classifyMagi2Audience({ state: 'signed-out' })).toBe('guest');
    expect(classifyMagi2Audience({ state: 'signed-in', plan: 'free' })).toBe('free');
    expect(classifyMagi2Audience({ state: 'signed-in', plan: '' })).toBe('free');
    expect(classifyMagi2Audience({ state: 'signed-in', plan: 'plus' })).toBe('paid');
    expect(classifyMagi2Audience({ state: 'signed-in', plan: 'pro_yearly' })).toBe('paid');
    expect(classifyMagi2Audience({ state: 'signed-in', plan: 'team_max' })).toBe('paid');
    expect(classifyMagi2Audience({ state: 'signed-in', plan: 'free', billingUnavailable: true })).toBe('unknown');
  });

  it('computes 12-hour rolling countdown with centiseconds', () => {
    expect(readMagi2CountdownParts(Date.parse('2026-11-21T18:00:00.250+08:00'), false)).toEqual([11, 59, 59, 75]);
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

  it('keeps self-hosted video and WebP poster strictly under the 1 MiB repository storage budget', () => {
    const videoBytes = statSync(resolve(import.meta.dirname, './black-friday-modal/magi2-planet-6s.mp4')).size;
    const posterBytes = statSync(resolve(import.meta.dirname, './black-friday-modal/magi2-planet-poster.webp')).size;
    expect(videoBytes).toBeLessThan(1024 * 1024);
    expect(posterBytes).toBeLessThan(80 * 1024);
  });
});

describe('Magi2LaunchModal runtime behavior', () => {
  it('opens for guests, writes shared od_bf_magi2_modal_seen cookie, and renders console plan CTA', () => {
    mockAccountState.account = { state: 'signed-out' };
    act(() => root.render(<Magi2LaunchModal trackingPage="explore" />));
    const modal = document.querySelector('[data-testid="magi2-launch-modal"]');
    expect(modal).toBeTruthy();
    expect(document.querySelector('[data-testid="magi2-launch-modal-headline"]')?.textContent).toBe('全网首发 MAGI-2');
    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="magi2-launch-modal-cta"]');
    expect(cta?.href).toContain('https://open-design.ai/cloud/dashboard?billing=plan');
    expect(document.cookie).toContain(`${MAGI2_MODAL_SEEN_COOKIE}=1`);
    expect(window.sessionStorage.getItem(MAGI2_MODAL_DISMISSED_KEY)).toBe('1');
  });

  it('never opens for paid users', () => {
    mockAccountState.account = { state: 'signed-in', plan: 'pro' };
    act(() => root.render(<Magi2LaunchModal trackingPage="explore" />));
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();
  });

  it('fails closed when account lookup exceeds the 5-second deadline', () => {
    mockAccountState.account = null;
    act(() => root.render(<Magi2LaunchModal trackingPage="explore" />));
    act(() => vi.advanceTimersByTime(MAGI2_MODAL_AUDIENCE_TIMEOUT_MS + 100));
    mockAccountState.account = { state: 'signed-out' };
    act(() => root.render(<Magi2LaunchModal trackingPage="explore" />));
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();
  });

  it('suppresses duplicate popup when od_bf_magi2_modal_seen cookie exists, but ignores legacy od_bf_home_modal_seen', () => {
    document.cookie = 'od_bf_home_modal_seen=1; path=/';
    mockAccountState.account = { state: 'signed-in', plan: 'free' };
    act(() => root.render(<Magi2LaunchModal trackingPage="explore" />));
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(host);
    // od_bf_magi2_modal_seen cookie is now set, so a fresh mount is suppressed.
    act(() => root.render(<Magi2LaunchModal trackingPage="explore" />));
    expect(document.querySelector('[data-testid="magi2-launch-modal"]')).toBeNull();
  });
});
