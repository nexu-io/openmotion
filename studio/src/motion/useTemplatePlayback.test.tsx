// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryTemplate } from '../../../shared/catalog';
import { I18nProvider } from '../i18n/I18n';
import { TemplateGalleryCard } from './TemplateGalleryCard';
import { useTemplatePlaybackPool } from './useTemplatePlayback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let report!: (entries: Partial<IntersectionObserverEntry>[]) => void;
let observed: Map<string, Element>;
let connection: EventTarget & { saveData: boolean };
let reducedMotion: EventTarget & { matches: boolean };

const makeTemplates = (count: number): GalleryTemplate[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `tpl-${index + 1}`,
    title: `Template ${index + 1}`,
    posterUrl: `/poster-${index + 1}.webp`,
    previewUrl: `/preview-${index + 1}.mp4`,
  })) as GalleryTemplate[];

function GalleryHarness({
  templates,
  enabled = true,
  playerBudget = 2,
  retainedBudget = 4,
}: {
  templates: GalleryTemplate[];
  enabled?: boolean;
  playerBudget?: number;
  retainedBudget?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const { playing, retained } = useTemplatePlaybackPool(
    container,
    templates.map(item => item.id).join(','),
    enabled,
    true,
    null,
    false,
    playerBudget,
    retainedBudget,
  );
  return (
    <I18nProvider initialLocale="en">
      <div ref={container}>
        {templates.map(template => (
          <TemplateGalleryCard
            key={template.id}
            template={template}
            active={playing.has(template.id)}
            retained={retained.has(template.id)}
            onPriority={() => {}}
            onSelect={() => {}}
          />
        ))}
      </div>
    </I18nProvider>
  );
}

beforeEach(() => {
  observed = new Map();
  connection = Object.assign(new EventTarget(), { saveData: false });
  reducedMotion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('navigator', { connection });
  vi.stubGlobal('matchMedia', (query: string) =>
    query.includes('reduced-motion') ? reducedMotion : Object.assign(new EventTarget(), { matches: false }),
  );
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('playing'));
  });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
      report = callback;
    }
    observe(element: Element) {
      const id = (element as HTMLElement).dataset.templateId;
      if (id) observed.set(id, element);
    }
    disconnect() {}
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const videoFor = (id: string) => host.querySelector<HTMLVideoElement>(`[data-template-id="${id}"] video`)!;
const setVisible = (visibleIds: string[]) => {
  const visibleSet = new Set(visibleIds);
  report(
    [...observed.entries()].map(([id, target]) => ({
      target,
      isIntersecting: visibleSet.has(id),
      intersectionRatio: visibleSet.has(id) ? 1 : 0,
    })),
  );
};

describe('useTemplatePlaybackPool (bounded LRU warm-pause pool)', () => {
  it('pauses offscreen cards without unloading src on short scrolls and evicts oldest entries beyond retainedBudget', async () => {
    const templates = makeTemplates(6);
    await act(async () => root.render(<GalleryHarness templates={templates} playerBudget={2} retainedBudget={4} />));

    // Scroll 1 & 2 into view: both load and play.
    await act(async () => setVisible(['tpl-1', 'tpl-2']));
    expect(host.querySelectorAll('video[src]')).toHaveLength(2);
    expect(videoFor('tpl-1').getAttribute('src')).toBe('/preview-1.mp4');
    expect(videoFor('tpl-2').getAttribute('src')).toBe('/preview-2.mp4');
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();

    // Scroll down to 3 & 4: 1 & 2 pause in the warm pool without stripping src or calling load().
    await act(async () => setVisible(['tpl-3', 'tpl-4']));
    expect(host.querySelectorAll('video[src]')).toHaveLength(4);
    expect(videoFor('tpl-1').getAttribute('src')).toBe('/preview-1.mp4');
    expect(videoFor('tpl-2').getAttribute('src')).toBe('/preview-2.mp4');
    expect(videoFor('tpl-3').getAttribute('src')).toBe('/preview-3.mp4');
    expect(videoFor('tpl-4').getAttribute('src')).toBe('/preview-4.mp4');
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();

    // Scroll back up to 1 & 2: resumes directly from warm pool without ever calling load().
    await act(async () => setVisible(['tpl-1', 'tpl-2']));
    expect(host.querySelectorAll('video[src]')).toHaveLength(4);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();

    // Scroll down to 5 & 6: LRU cap (4) evicts oldest paused cards (3 & 4), keeping 1, 2, 5, 6.
    await act(async () => setVisible(['tpl-5', 'tpl-6']));
    expect(host.querySelectorAll('video[src]')).toHaveLength(4);
    expect(videoFor('tpl-3').hasAttribute('src')).toBe(false);
    expect(videoFor('tpl-4').hasAttribute('src')).toBe(false);
    expect(videoFor('tpl-1').getAttribute('src')).toBe('/preview-1.mp4');
    expect(videoFor('tpl-2').getAttribute('src')).toBe('/preview-2.mp4');
    expect(videoFor('tpl-5').getAttribute('src')).toBe('/preview-5.mp4');
    expect(videoFor('tpl-6').getAttribute('src')).toBe('/preview-6.mp4');
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(2);
  });

  it('releases all retained videos immediately when inactive, hidden, or Save-Data activates', async () => {
    const templates = makeTemplates(4);
    await act(async () => root.render(<GalleryHarness templates={templates} playerBudget={2} retainedBudget={4} />));
    await act(async () => setVisible(['tpl-1', 'tpl-2']));
    await act(async () => setVisible(['tpl-3', 'tpl-4']));
    expect(host.querySelectorAll('video[src]')).toHaveLength(4);

    // Tab hidden clears playing + retained immediately.
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(host.querySelectorAll('video[src]')).toHaveLength(0);

    // Returning tab restores visible videos; deactivating Explore (enabled=false) clears all again.
    hiddenSpy.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(host.querySelectorAll('video[src]')).toHaveLength(2);

    await act(async () => root.render(<GalleryHarness templates={templates} enabled={false} playerBudget={2} retainedBudget={4} />));
    expect(host.querySelectorAll('video[src]')).toHaveLength(0);
  });

  it('retries a TemplateGalleryCard once when resuming from a warm pause hits a stale URL error, then falls back cleanly', async () => {
    const [template] = makeTemplates(1);
    // Do not auto-emit playing on resume so we can simulate an expired presigned URL error right on resume.
    let autoPlaySucceeds = true;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(async function (this: HTMLMediaElement) {
      if (autoPlaySucceeds) this.dispatchEvent(new Event('playing'));
    });

    await act(async () => root.render(
      <I18nProvider initialLocale="en">
        <TemplateGalleryCard template={template} active retained onPriority={() => {}} onSelect={() => {}} />
      </I18nProvider>,
    ));
    const player = videoFor('tpl-1');
    expect(player.getAttribute('src')).toBe('/preview-1.mp4');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

    // Pause in warm pool, then resume with a simulated expired-URL media error.
    await act(async () => root.render(
      <I18nProvider initialLocale="en">
        <TemplateGalleryCard template={template} active={false} retained onPriority={() => {}} onSelect={() => {}} />
      </I18nProvider>,
    ));
    autoPlaySucceeds = false;
    await act(async () => root.render(
      <I18nProvider initialLocale="en">
        <TemplateGalleryCard template={template} active retained onPriority={() => {}} onSelect={() => {}} />
      </I18nProvider>,
    ));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);

    // First error after warm-pause resume triggers a single clean reload + retry.
    await act(async () => player.dispatchEvent(new Event('error')));
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    expect(player.getAttribute('src')).toBe('/preview-1.mp4');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(3);

    // Second error permanently falls back to poster and releases src.
    await act(async () => player.dispatchEvent(new Event('error')));
    expect(player.hasAttribute('src')).toBe(false);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(2);
  });
});
