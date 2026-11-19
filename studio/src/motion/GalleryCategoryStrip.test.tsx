// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { GalleryCategoryStrip } from './GalleryCategoryStrip';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, viewport: HTMLDivElement;
let resize: () => void, width: number, total: number;
let scroll: ReturnType<typeof vi.fn>;
const arrow = (direction: string) => host.querySelector<HTMLButtonElement>(`button[data-direction=${direction}]`)!;
beforeEach(async () => {
  width = 200; total = 600;
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<I18nProvider initialLocale="en"><GalleryCategoryStrip label="Video purpose"><button>All</button><button>Product launch</button><button>Company introduction</button></GalleryCategoryStrip></I18nProvider>));
  viewport = host.querySelector<HTMLDivElement>('.om-gallery-category-viewport')!;
  Object.defineProperties(viewport, { clientWidth: { get: () => width }, scrollWidth: { get: () => total } });
  scroll = vi.fn((options: ScrollToOptions) => {
    viewport.scrollLeft = Math.max(0, Math.min(total - width, viewport.scrollLeft + (options.left ?? 0)));
    viewport.dispatchEvent(new Event('scroll'));
  });
  viewport.scrollBy = scroll;
  await act(async () => resize());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('tracks clipped edges while paging in both directions and after a resize', async () => {
  expect(arrow('start').disabled).toBe(true);
  expect(arrow('end').disabled).toBe(false);
  expect(arrow('end').getAttribute('aria-controls')).toBe(viewport.id);
  await act(async () => arrow('end').click());
  expect(scroll).toHaveBeenLastCalledWith({ left: 150, behavior: 'smooth' });
  expect(arrow('start').disabled).toBe(false);
  expect(host.firstElementChild?.getAttribute('data-scroll-start')).toBe('true');
  await act(async () => { viewport.scrollLeft = 400; viewport.dispatchEvent(new Event('scroll')); });
  expect(arrow('end').disabled).toBe(true);
  expect(host.firstElementChild?.getAttribute('data-scroll-end')).toBe('false');
  await act(async () => arrow('start').click());
  expect(scroll).toHaveBeenLastCalledWith({ left: -150, behavior: 'smooth' });
  expect(arrow('end').disabled).toBe(false);
  await act(async () => { width = 700; viewport.scrollLeft = 0; resize(); });
  expect(arrow('start').disabled).toBe(true);
  expect(arrow('end').disabled).toBe(true);
});

it('reveals keyboard-focused categories without scrolling their surrounding page', async () => {
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 200 } as DOMRect);
  const last = viewport.querySelectorAll('button')[2];
  vi.spyOn(last, 'getBoundingClientRect').mockReturnValue({ left: 250, right: 330 } as DOMRect);
  await act(async () => last.focus());
  expect(document.activeElement).toBe(last);
  expect(scroll).toHaveBeenLastCalledWith({ left: 162, behavior: 'instant' });
});

it('respects reduced motion and leaves trackpad, vertical scroll and pinch gestures native', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  await act(async () => arrow('end').click());
  expect(scroll).toHaveBeenLastCalledWith({ left: 150, behavior: 'instant' });
  for (const delta of [{ deltaX: 60 }, { deltaY: 60 }, { deltaY: 20, ctrlKey: true }]) {
    const event = new WheelEvent('wheel', { ...delta, bubbles: true, cancelable: true });
    viewport.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
});
