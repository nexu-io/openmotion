// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const account = vi.hoisted(() => ({ state: 'signed-out' as string }));
vi.mock('./AccountSettings', () => ({ useAccountSummary: () => ({ account: { state: account.state } }) }));
vi.mock('./useMediaCatalog', () => ({ useMediaCatalog: () => ({ catalog: { models: [], status: { providers: [{ id: 'gemini', label: 'Gemini', available: false }] } }, failed: false, retry: () => {} }) }));
vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
import { ModelHub } from './ModelHub';
import { findModelHub } from './modelHubs';
import { I18nProvider } from '../i18n/I18n';
import modelHubUi from '../i18n/model-hub-ui.json';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root | undefined;
afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = undefined;
  }
  container?.remove();
});
async function render() {
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  const onProvider = vi.fn();
  await act(async () => root!.render(<I18nProvider initialLocale="en"><ModelHub id="gemini-4" onExplore={() => {}} onProvider={onProvider} onModel={() => {}} onUse={() => {}} onSettings={() => {}} /></I18nProvider>));
  return { onProvider, hero: () => [...container.querySelectorAll<HTMLButtonElement>('.om-model-hub-hero-copy button')].map(button => button.textContent) };
}

it('offers to connect when nothing is connected and shows the connection once signed in', async () => {
  account.state = 'signed-out';
  let view = await render();
  expect(view.hero()).toContain('Sign in to use Gemini 4 Neon now');
  expect(view.hero()).toContain('Connect your own API key');
  act(() => root!.unmount());
  root = undefined;
  container.remove();
  account.state = 'signed-in';
  view = await render();
  expect(view.hero()).toContain('Connected to OpenDesign');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-model-hub-connected')!.click());
  expect(view.onProvider).toHaveBeenCalledWith('account');
});

it('renders curated Seedance 2.5 and GPT Image 2.6 showcase galleries with lightbox preview and remix handoff', async () => {
  for (const hubId of ['seedance-2-5', 'gpt-image-2-6'] as const) {
    const hub = findModelHub(hubId)!;
    const firstCase = hub.cases![0];
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    const onScene = vi.fn();
    await act(async () => root!.render(
      <I18nProvider initialLocale="zh-CN">
        <ModelHub id={hubId} onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onScene={onScene} onSettings={() => {}} />
      </I18nProvider>,
    ));

    const cards = container.querySelectorAll<HTMLElement>('.om-hub-showcase-card');
    expect(cards.length).toBe(hubId === 'seedance-2-5' ? 70 : 62);

    const expectedKind = hubId === 'seedance-2-5' ? 'video' : 'image';
    const kindBadge = cards[0].querySelector<HTMLElement>('.om-hub-showcase-kind')!;
    expect(kindBadge).not.toBeNull();
    expect(kindBadge.dataset.kind).toBe(expectedKind);
    expect(kindBadge.querySelector('svg')?.getAttribute('data-remix-icon')).toBe(expectedKind === 'video' ? 'movie-line' : 'image-line');

    const remix = cards[0].querySelector<HTMLButtonElement>('.om-hub-showcase-cta')!;
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => { remix.dispatchEvent(key); });
    expect(key.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    cards[0].focus();
    await act(async () => cards[0].click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.parentElement).toBe(document.body);
    expect(dialog?.contains(document.activeElement)).toBe(true);
    if (hubId === 'seedance-2-5') {
      const video = dialog!.querySelector<HTMLVideoElement>('video.om-hub-lightbox-video');
      expect(video).not.toBeNull();
      expect(video!.getAttribute('src')).toBe(firstCase.videoHd ?? firstCase.video);
    }
    const credit = dialog!.querySelector<HTMLAnchorElement>('.om-hub-lightbox-credit');
    if (firstCase.author && firstCase.sourceUrl) {
      expect(credit).not.toBeNull();
      expect(credit!.getAttribute('href')).toBe(firstCase.sourceUrl);
      expect(credit!.textContent).toContain(firstCase.author);
    } else {
      expect(credit).toBeNull();
    }
    const promptBox = dialog!.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(promptBox.value.length).toBeGreaterThan(0);

    const remixBtn = dialog!.querySelector<HTMLButtonElement>('.om-hub-lightbox-cta')!;
    expect(remixBtn.textContent).toContain('一键做同款');
    await act(async () => remixBtn.click());

    expect(onScene).toHaveBeenCalledOnce();
    const [destination, draft] = onScene.mock.calls[0];
    expect(destination.scene.modality).toBe(hubId === 'seedance-2-5' ? 'video' : 'image');
    expect(draft).toMatchObject({
      modality: hubId === 'seedance-2-5' ? 'video' : 'image',
      prompt: promptBox.value,
      references: [],
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => root!.unmount());
    root = undefined;
    container.remove();
  }
});

it('falls back from videoHd to video and then poster when non-X lightbox streams fail', async () => {
  const seedance = findModelHub('seedance-2-5')!;
  const firstCase = seedance.cases![0];
  const originalVideo = firstCase.video;
  const originalVideoHd = firstCase.videoHd;
  firstCase.videoHd = 'https://example.com/hd.mp4';
  firstCase.video = 'https://example.com/sd.mp4';
  try {
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <I18nProvider initialLocale="en">
        <ModelHub id="seedance-2-5" onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onSettings={() => {}} />
      </I18nProvider>,
    ));
    await act(async () => container.querySelector<HTMLElement>('.om-hub-showcase-card')!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const hdVideo = dialog.querySelector<HTMLVideoElement>('video.om-hub-lightbox-video')!;
    expect(hdVideo.getAttribute('src')).toBe('https://example.com/hd.mp4');

    await act(async () => { hdVideo.dispatchEvent(new Event('error')); });
    const sdVideo = dialog.querySelector<HTMLVideoElement>('video.om-hub-lightbox-video')!;
    expect(sdVideo.getAttribute('src')).toBe('https://example.com/sd.mp4');

    await act(async () => { sdVideo.dispatchEvent(new Event('error')); });
    expect(dialog.querySelector('video.om-hub-lightbox-video')).toBeNull();
    expect(dialog.querySelector<HTMLImageElement>('.om-hub-lightbox-media img')!.getAttribute('src')).toBe(firstCase.poster);
  } finally {
    firstCase.video = originalVideo;
    firstCase.videoHd = originalVideoHd;
  }
});

it('plays X-hosted Seedance showcase videos inside a no-referrer srcDoc iframe on hover and lightbox', async () => {
  const seedance = findModelHub('seedance-2-5')!;
  const xCase = seedance.cases!.find(item => item.video?.startsWith('https://video.twimg.com/'))!;
  expect(xCase).toBeDefined();
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <I18nProvider initialLocale="en">
      <ModelHub id="seedance-2-5" onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onSettings={() => {}} />
    </I18nProvider>,
  ));

  const xCard = [...container.querySelectorAll<HTMLElement>('.om-hub-showcase-card')]
    .find(card => card.getAttribute('aria-label') === xCase.title)!;
  expect(xCard).toBeDefined();
  await act(async () => xCard.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  const hoverIframe = xCard.querySelector<HTMLIFrameElement>('iframe.om-hub-showcase-video')!;
  expect(hoverIframe).not.toBeNull();
  expect(hoverIframe.getAttribute('srcdoc')).toContain('name="referrer" content="no-referrer"');
  expect(hoverIframe.getAttribute('srcdoc')).toContain(xCase.video!);

  await act(async () => xCard.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const lightboxIframe = dialog.querySelector<HTMLIFrameElement>('iframe.om-hub-lightbox-video')!;
  expect(lightboxIframe).not.toBeNull();
  expect(lightboxIframe.getAttribute('srcdoc')).toContain(xCase.videoHd ?? xCase.video!);
});

it('localizes Seedance 2.5 and GPT Image 2.6 hubs across all 10 non-English locales and adapts masonry columns to viewport widths', async () => {
  const originalWidth = window.innerWidth;
  try {
    for (const [width, expectedCols] of [[375, 1], [768, 2], [1024, 3], [1440, 4]] as const) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      container = document.createElement('div'); document.body.append(container);
      root = createRoot(container);
      await act(async () => root!.render(
        <I18nProvider initialLocale="en">
          <ModelHub id="seedance-2-5" onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onSettings={() => {}} />
        </I18nProvider>,
      ));
      expect(container.querySelectorAll('.om-hub-masonry-col').length, `width ${width}`).toBe(expectedCols);
      act(() => root!.unmount());
      root = undefined;
      container.remove();
    }

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    const firstSeedance = findModelHub('seedance-2-5')!.cases![0];
    const zhMessages = modelHubUi['zh-CN'] as Record<string, string>;
    for (const hubId of ['seedance-2-5', 'gpt-image-2-6']) {
      for (const example of findModelHub(hubId)!.cases!) {
        expect(zhMessages[example.title], `zh-CN title: ${example.title}`).toBeTruthy();
        expect(zhMessages[example.prompt], `zh-CN prompt: ${example.title}`).toBeTruthy();
      }
    }
    for (const locale of ['zh-CN', 'ja', 'ko', 'de', 'fr', 'ru', 'es', 'pt-BR', 'it', 'tr'] as const) {
      const messages = modelHubUi[locale] as Record<string, string>;
      container = document.createElement('div'); document.body.append(container);
      root = createRoot(container);
      await act(async () => root!.render(
        <I18nProvider key={locale} initialLocale={locale}>
          <ModelHub id="seedance-2-5" onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onSettings={() => {}} />
        </I18nProvider>,
      ));
      expect(container.textContent, locale).toContain(messages['Start Creating']);
      expect(container.textContent, locale).toContain(messages['Cinema & VFX']);
      expect(container.textContent, locale).toContain(messages['Fashion & Visual']);
      expect(container.textContent, locale).toContain(messages[firstSeedance.title] ?? firstSeedance.title);
      await act(async () => container.querySelector<HTMLElement>('.om-hub-showcase-card')!.click());
      expect(document.querySelector('.om-hub-lightbox-cta')!.textContent, locale).toContain(messages['Remix this look']);
      expect(document.querySelector<HTMLTextAreaElement>('.om-hub-lightbox textarea')!.value, locale)
        .toBe(messages[firstSeedance.prompt] ?? firstSeedance.prompt);
      act(() => root!.unmount());
      root = undefined;
      container.remove();
    }
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  }
});

it('only mounts showcase card video playback on hover/focus and stops when leaving', async () => {
  const seedance = findModelHub('seedance-2-5')!;
  const firstCase = seedance.cases![0];
  const originalVideo = firstCase.video;
  const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  firstCase.video = 'https://example.com/seedance-preview.mp4';
  try {
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <I18nProvider initialLocale="zh-CN">
        <ModelHub id="seedance-2-5" onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onSettings={() => {}} />
      </I18nProvider>,
    ));

    const firstCard = container.querySelector<HTMLElement>('.om-hub-showcase-card')!;
    // Resting state: never autoplays video
    expect(firstCard.querySelector('video')).toBeNull();

    // Hover/focus mounts and plays the preview video
    await act(async () => firstCard.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const hoverVideo = firstCard.querySelector<HTMLVideoElement>('video.om-hub-showcase-video');
    expect(hoverVideo).not.toBeNull();
    expect(hoverVideo!.getAttribute('src')).toBe('https://example.com/seedance-preview.mp4');

    // Leaving unmounts the video and returns to the static poster
    await act(async () => firstCard.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(firstCard.querySelector('video')).toBeNull();
  } finally {
    firstCase.video = originalVideo;
    playSpy.mockRestore();
    pauseSpy.mockRestore();
  }
});
