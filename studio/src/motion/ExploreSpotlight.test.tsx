// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { ExploreSpotlight } from './ExploreSpotlight';
import { motionStudioCover } from './skillCatalog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, intersect: (visible: boolean) => void;
const connection = Object.assign(new EventTarget(), { saveData: false });
const preference = Object.assign(new EventTarget(), { matches: false });
const video = () => host.querySelector('video');
const slide = () => host.querySelector('.om-feature-slide:not([inert])')!;
const toggle = () => [...slide().querySelectorAll('button')].find(button => ['Play', 'Pause'].includes(button.textContent.trim()))!;
const render = () => act(async () => root.render(<I18nProvider initialLocale="en"><ExploreSpotlight active
  onNavigate={vi.fn()} onOpenMotionEditor={vi.fn()} motionEditorDisabled={false} onOpenBlackFriday={vi.fn()} onModelHub={vi.fn()} />
</I18nProvider>));

beforeEach(() => {
  connection.saveData = false;
  preference.matches = false;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('navigator', { connection });
  vi.stubGlobal('matchMedia', () => preference);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) { intersect = visible => callback([{ isIntersecting: visible }]); }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps Save-Data poster-only until Play, then requests the native MP4 without a Blob', async () => {
  connection.saveData = true;
  await render();
  act(() => intersect(true));
  expect(slide().querySelector('img')?.getAttribute('src')).toBe(motionStudioCover?.poster);
  expect(video()?.hasAttribute('src')).toBe(false);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  act(() => { toggle().focus(); toggle().click(); });
  const player = video()!;
  expect(player.getAttribute('src')).toBe(motionStudioCover?.video);
  expect(player.muted && player.loop && player.hasAttribute('playsinline')).toBe(true);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(player.style.opacity).toBe('0');
  act(() => { player.dispatchEvent(new Event('play')); player.dispatchEvent(new Event('playing')); });
  expect(toggle().textContent).toContain('Pause');
  expect(player.style.opacity).toBe('1');
  act(() => player.dispatchEvent(new Event('error')));
  expect(player.style.opacity).toBe('0');
  act(() => intersect(false));
  expect(player.hasAttribute('src')).toBe(false);
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  act(() => intersect(true));
  expect(video()?.hasAttribute('src')).toBe(false);
});

it('respects reduced motion, releases an active transfer when Save-Data turns on, and stops in a hidden tab', async () => {
  preference.matches = true;
  await render();
  act(() => intersect(true));
  expect(video()?.hasAttribute('src')).toBe(false);
  act(() => { preference.matches = false; preference.dispatchEvent(new Event('change')); });
  const original = video()!;
  expect(original.getAttribute('src')).toBe(motionStudioCover?.video);
  act(() => { connection.saveData = true; connection.dispatchEvent(new Event('change')); });
  expect(original.hasAttribute('src')).toBe(false);
  expect(video()?.hasAttribute('src')).toBe(false);
  act(() => { connection.saveData = false; connection.dispatchEvent(new Event('change')); });
  const resumed = video()!;
  expect(resumed.getAttribute('src')).toBe(motionStudioCover?.video);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(video()).toBeNull();
  expect(resumed.hasAttribute('src')).toBe(false);
});

it('pauses without stripping src when scrolling past the hero in normal mode, then resumes cleanly and releases when inactive', async () => {
  const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  await render();
  act(() => intersect(true));
  const player = video()!;
  expect(player.getAttribute('src')).toBe(motionStudioCover?.video);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

  // Scrolling offscreen pauses in place without unloading the video element.
  act(() => intersect(false));
  expect(video()).toBe(player);
  expect(player.getAttribute('src')).toBe(motionStudioCover?.video);
  expect(pauseSpy).toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();

  // Scrolling back resumes playback on the same video element.
  act(() => intersect(true));
  expect(video()).toBe(player);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();

  // Leaving Explore (active=false) releases the media source immediately.
  await act(async () => root.render(<I18nProvider initialLocale="en"><ExploreSpotlight active={false}
    onNavigate={vi.fn()} onOpenMotionEditor={vi.fn()} motionEditorDisabled={false} onOpenBlackFriday={vi.fn()} onModelHub={vi.fn()} />
  </I18nProvider>));
  expect(video()).toBeNull();
  expect(player.hasAttribute('src')).toBe(false);
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
});
