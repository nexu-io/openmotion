// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EntitlementPromoModal } from './EntitlementPromoModal';

vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string) => text, locale: 'en' }) }));
vi.mock('./tracking', () => ({ trackMotion: vi.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let intersect: (slot: string, visible: boolean) => void;
let motion: EventTarget & { matches: boolean };
let connection: EventTarget & { saveData: boolean };
let finishDecode: () => void;

function render(open = true) {
  act(() => root.render(<StrictMode><EntitlementPromoModal open={open} mode="guest" hookId="header_pricing" onClose={() => {}} /></StrictMode>));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  const decoded = new Promise<void>(resolve => { finishDecode = resolve; });
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockReturnValue(decoded);
  motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => motion);
  connection = Object.assign(new EventTarget(), { saveData: false });
  Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
      intersect = (slot, visible) => {
        const target = host.querySelector(`[data-promo-slot="${slot}"]`)!;
        act(() => callback([{ target, isIntersecting: visible, intersectionRatio: Number(visible) }]));
      };
    }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(navigator, 'connection');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('ships a WebP first frame for every clip and prioritizes the leading card', () => {
  render();
  expect(host.querySelector('video')).toBeNull();
  const previews = [...host.querySelectorAll<HTMLImageElement>('[data-promo-slot] img')];
  const posters = new Set(previews.map(image => image.getAttribute('src')!));
  expect(previews).toHaveLength(20);
  expect(posters.size).toBe(14);
  for (const poster of posters) {
    const file = readFileSync(resolve(import.meta.dirname, `../../public${poster}`));
    expect(file.toString('ascii', 8, 12)).toBe('WEBP');
  }
  expect(host.querySelector('.om-epm-card img')?.getAttribute('fetchpriority')).toBe('high');
  for (const image of host.querySelectorAll('.om-epm-side img')) {
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('fetchpriority')).toBe('low');
  }
});

it('waits for the visible poster to decode and paint, then releases video on exit and close', async () => {
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
  render();
  intersect('hadal-play.mp4', true);
  expect(HTMLImageElement.prototype.decode).not.toHaveBeenCalled();
  const image = host.querySelector('[data-promo-slot="hadal-play.mp4"] img')!;
  act(() => image.dispatchEvent(new Event('load')));
  act(() => vi.advanceTimersToNextFrame());
  expect(host.querySelector('video')).toBeNull();
  await act(async () => finishDecode());
  act(() => vi.advanceTimersToNextFrame());
  expect(host.querySelector('video')).toBeNull();
  act(() => vi.advanceTimersToNextFrame());
  const first = host.querySelector('video')!;
  expect(host.querySelectorAll('video')).toHaveLength(1);
  expect(first.src).toMatch(/epm-hadal-play\.mp4$/);
  expect(first.getAttribute('poster')).toMatch(/epm-hadal-play-poster\.webp$/);
  expect(first.autoplay && first.muted && first.loop && first.hasAttribute('playsinline')).toBe(true);
  intersect('hadal-play.mp4', false);
  expect(first.hasAttribute('src')).toBe(false);
  intersect('hadal-play.mp4', true);
  const resumed = host.querySelector('video')!;
  render(false);
  expect(host.querySelector('dialog')).toBeNull();
  expect(resumed.hasAttribute('src')).toBe(false);
});

it('keeps posters for reduced motion, Save-Data, and background tabs', async () => {
  motion.matches = true;
  render();
  intersect('left-0', true);
  intersect('left-4', true);
  await act(async () => finishDecode());
  expect(HTMLImageElement.prototype.decode).not.toHaveBeenCalled();
  connection.saveData = true;
  motion.matches = false;
  act(() => motion.dispatchEvent(new Event('change')));
  expect(HTMLImageElement.prototype.decode).not.toHaveBeenCalled();
  connection.saveData = false;
  await act(async () => { connection.dispatchEvent(new Event('change')); });
  act(() => vi.advanceTimersToNextFrame());
  act(() => vi.advanceTimersToNextFrame());
  expect(host.querySelectorAll('video')).toHaveLength(1);
  expect(host.querySelector('[data-promo-slot="left-4"] img')).toBeTruthy();
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.querySelector('video')).toBeNull();
  visible.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.querySelectorAll('video')).toHaveLength(1);
});

it('keeps resource cards, feature cards, and model rows free from truncation rules across locales', () => {
  render();
  const rowsWrap = host.querySelector('.om-epm-mrows');
  expect(rowsWrap?.querySelectorAll('.om-epm-mrow')).toHaveLength(5);
  expect(host.querySelectorAll('.om-epm-card.is-res')).toHaveLength(4);

  const css = readFileSync(resolve(import.meta.dirname, './EntitlementPromoModal.css'), 'utf8');
  expect(css).toMatch(/\.om-epm-card\.is-res\s*\{[^}]*grid-column:\s*span 2/);
  expect(css).toMatch(/\.om-epm-card\.is-res\s*\{[^}]*grid-template-columns:\s*\d+px\s+minmax\(0,\s*1fr\)/);
  expect(css).not.toMatch(/\.om-epm-card\.is-res\s+(?:h4|p)\s*\{[^}]*overflow:\s*visible/);
  expect(css).not.toMatch(/\.om-epm-card\s+(?:h4|p)\s*\{[^}]*white-space:\s*nowrap/);
  expect(css).toMatch(/\.om-epm-mrows\s*\{[^}]*grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\)\s+auto/);
  expect(css).toMatch(/\.om-epm-mrow\s*\{[^}]*grid-template-columns:\s*subgrid/);
  expect(css).toMatch(/\.om-epm-giftbar\s*\{[^}]*min-height:/);
});
