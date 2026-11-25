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
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'application/octet-stream' } })));
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
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mime-corrected');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await act(async () => player.dispatchEvent(new Event('error')));
  expect(player.style.opacity).toBe('0');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(createUrl.mock.calls[0][0].type).toBe('video/mp4');
  expect(player.getAttribute('src')).toBe('blob:mime-corrected');
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  await act(async () => player.dispatchEvent(new Event('error')));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  act(() => intersect(false));
  expect(revokeUrl).toHaveBeenCalledWith('blob:mime-corrected');
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
