// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GalleryTemplate } from '../../../shared/catalog';
import { I18nProvider } from '../i18n/I18n';
import { RelatedTemplatePreviews } from './RelatedTemplatePreviews';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, dialog: HTMLDialogElement, host: HTMLDivElement;
let reducedMotion: EventTarget & { matches: boolean };
const templates = ['First', 'Second', 'Poster only'].map((title, index) => ({
  id: String(index), title, posterUrl: `/${index}.jpg`, previewUrl: index < 2 ? `/${index}.mp4` : undefined,
})) as GalleryTemplate[];
const select = vi.fn();
beforeEach(() => {
  reducedMotion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', (query: string) => query.includes('reduced-motion') ? reducedMotion : Object.assign(new EventTarget(), { matches: false }));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function () { this.dispatchEvent(new Event('playing')); });
  dialog = document.createElement('dialog'); host = document.createElement('div');
  dialog.append(host); document.body.append(dialog); dialog.showModal(); root = createRoot(host); select.mockClear();
});
afterEach(() => { act(() => root.unmount()); dialog.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function mount() {
  await act(async () => root.render(<I18nProvider initialLocale="en"><RelatedTemplatePreviews templates={templates} panel={{ current: host }} onSelect={select} /></I18nProvider>));
}
const card = (title: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Preview template ${title}"]`)!;
const player = () => dialog.querySelector<HTMLVideoElement>('video[src]');
async function focus(title: string) {
  await act(async () => { card(title).focus(); await new Promise(resolve => setTimeout(resolve, 180)); });
}
it('lazily previews one focused card inside the dialog and preserves click selection', async () => {
  await mount(); expect(player()).toBeNull();
  await focus('First');
  const first = player()!;
  expect(first.getAttribute('src')).toBe('/0.mp4');
  expect(first.muted && first.loop && first.hasAttribute('playsinline')).toBe(true);
  expect(first.closest('dialog')).toBe(dialog);
  expect(select).not.toHaveBeenCalled();
  await focus('Second');
  expect(dialog.querySelectorAll('video[src]')).toHaveLength(1);
  expect(first.hasAttribute('src')).toBe(false);
  expect(first.pause).toHaveBeenCalled();
  expect(player()?.getAttribute('src')).toBe('/1.mp4');
  await act(async () => card('Second').click());
  expect(select).toHaveBeenCalledWith(templates[1], 2);
  expect(player()).toBeNull();
});
it('dismisses preview media with Escape, scrolling and page visibility changes', async () => {
  await mount(); await focus('First');
  await act(async () => card('First').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(player()).toBeNull(); expect(dialog.open).toBe(true);
  await focus('Second'); expect(player()).not.toBeNull();
  await act(async () => host.dispatchEvent(new Event('scroll')));
  expect(player()).toBeNull();
  await focus('First'); const previous = player()!;
  await act(async () => { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); });
  expect(player()).toBeNull(); expect(previous.hasAttribute('src')).toBe(false);
});
it('keeps poster-only and reduced-motion previews free of video requests', async () => {
  reducedMotion.matches = true;
  await mount(); await focus('First');
  expect(player()).toBeNull(); expect(dialog.querySelector('img[src="/0.jpg"]')).not.toBeNull();
  await act(async () => { reducedMotion.matches = false; reducedMotion.dispatchEvent(new Event('change')); });
  expect(player()).not.toBeNull();
  await act(async () => { reducedMotion.matches = true; reducedMotion.dispatchEvent(new Event('change')); });
  expect(player()).toBeNull();
  await focus('Poster only');
  expect(player()).toBeNull(); expect(dialog.querySelector('[role=status]')).toBeNull();
});
it('recovers from blocked or failed playback without trapping a loading state', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('Autoplay blocked'));
  await mount(); await focus('First');
  expect(player()).toBeNull();
  expect(dialog.querySelector('[role=status]')?.textContent).toContain('Preview unavailable. Try again.');
  await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click());
  expect(player()?.getAttribute('src')).toBe('/0.mp4');
  await act(async () => player()!.dispatchEvent(new Event('error')));
  expect(player()).toBeNull();
  expect(dialog.querySelector('[role=status]')?.textContent).toContain('Preview unavailable. Try again.');
});
it('ignores a late playback rejection after switching to another card', async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  await mount(); await focus('First'); await focus('Second');
  await act(async () => reject(new Error('Previous player stopped')));
  expect(player()?.getAttribute('src')).toBe('/1.mp4');
  expect(dialog.querySelector('[role=status]')).toBeNull();
});
