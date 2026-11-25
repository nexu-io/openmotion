// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const account = vi.hoisted(() => ({ state: 'signed-out' as string }));
const defaultCatalog = vi.hoisted(() => ({
  models: [] as Array<Record<string, unknown>>,
  status: { providers: [{ id: 'gemini', label: 'Gemini', available: false }] as Array<Record<string, unknown>>, routes: {} as Record<string, string>, agents: [], capabilities: [] },
}));
const catalogState = vi.hoisted(() => ({
  catalog: defaultCatalog as typeof defaultCatalog | undefined,
  failed: false,
}));
vi.mock('./AccountSettings', () => ({ useAccountSummary: () => ({ account: { state: account.state } }) }));
vi.mock('./useMediaCatalog', () => ({ useMediaCatalog: () => ({ catalog: catalogState.catalog, failed: catalogState.failed, retry: () => {} }) }));
vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
import { ModelHub } from './ModelHub';
import { findModelHub } from './modelHubs';
import { creationModels } from './creationModels';
import { mediaEditorDestination } from './creativeStudios';
import { gptImageStory, storyModels } from './exploreModelStories';
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
  catalogState.catalog = defaultCatalog;
  catalogState.failed = false;
});
async function render() {
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  const onProvider = vi.fn();
  const onOpenMcp = vi.fn();
  const onSettings = vi.fn();
  const onUse = vi.fn();
  await act(async () => root!.render(<I18nProvider initialLocale="en"><ModelHub id="gemini-4" onExplore={() => {}} onProvider={onProvider} onOpenMcp={onOpenMcp} onModel={() => {}} onUse={onUse} onSettings={onSettings} /></I18nProvider>));
  return { onProvider, onOpenMcp, onSettings, onUse, hero: () => [...container.querySelectorAll<HTMLButtonElement>('.om-model-hub-hero-copy button')].map(button => button.textContent) };
}

it('guides guests to sign in on Open in Motion Studio and always surfaces Connect MCP until connected', async () => {
  account.state = 'signed-out';
  let view = await render();
  expect(view.hero()).toContain('Open in Motion Studio');
  expect(view.hero()).toContain('Connect MCP');
  const [openBtn, mcpBtn] = [...container.querySelectorAll<HTMLButtonElement>('.om-model-hub-hero-copy button')];
  await act(async () => openBtn.click());
  expect(view.onSettings).toHaveBeenCalledWith('account');
  await act(async () => mcpBtn.click());
  expect(view.onOpenMcp).toHaveBeenCalled();
  act(() => root!.unmount());
  root = undefined;
  container.remove();

  account.state = 'signed-in';
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ connections: [{ activeTokenCount: 1 }] }),
  });
  vi.stubGlobal('fetch', fetchSpy);
  view = await render();
  expect(fetchSpy).toHaveBeenCalledWith(
    '/motion-api/connections',
    expect.objectContaining({ credentials: 'same-origin' }),
  );
  expect(view.hero()).toContain('Open in Motion Studio');
  expect(view.hero()).toContain('Connected to Gemini · MCP');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-model-hub-connected')!.click());
  expect(view.onOpenMcp).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('renders curated Seedance 2.5 and GPT Image 2.0 showcase galleries with lightbox preview and remix handoff', async () => {
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

    const promoPill = container.querySelector<HTMLAnchorElement>('.om-hub-promo-pill');
    expect(promoPill?.getAttribute('target')).toBe('_blank');
    expect(promoPill?.getAttribute('rel')).toBe('noopener noreferrer');

    const cards = container.querySelectorAll<HTMLElement>('.om-hub-showcase-card');
    expect(cards.length).toBe(hubId === 'seedance-2-5' ? 70 : 35);

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

it('ships complete, self-contained prompts and full 10-locale showcase translations while adapting masonry columns', async () => {
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

    const locales = ['zh-CN', 'ja', 'ko', 'de', 'fr', 'ru', 'es', 'pt-BR', 'it', 'tr'] as const;
    for (const hubId of ['seedance-2-5', 'gpt-image-2-6']) {
      for (const example of findModelHub(hubId)!.cases!) {
        expect(example.prompt, `placeholder ref in ${example.id}`).not.toMatch(/<<<image_|uploaded image|Transform your photo|Empower your digital identity|Surround yourself with/i);
        expect(example.prompt, `clipped ending in ${example.id}`).not.toMatch(/\b(a|an|the|and|of|to|in|on|with|from|into|through|beneath|behind|above|across|as|at|for|or)\.\s*$/i);
        for (const locale of locales) {
          const messages = modelHubUi[locale] as Record<string, string>;
          expect(messages[example.title], `${locale} title: ${example.title}`).toBeTruthy();
          expect(messages[example.prompt], `${locale} prompt: ${example.id}`).toBeTruthy();
        }
      }
    }

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    const firstSeedance = findModelHub('seedance-2-5')!.cases![0];
    for (const locale of locales) {
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
      expect(container.textContent, locale).toContain(messages[firstSeedance.title]);
      await act(async () => container.querySelector<HTMLElement>('.om-hub-showcase-card')!.click());
      expect(document.querySelector('.om-hub-lightbox-cta')!.textContent, locale).toContain(messages['Remix this look']);
      expect(document.querySelector<HTMLTextAreaElement>('.om-hub-lightbox textarea')!.value, locale)
        .toBe(messages[firstSeedance.prompt]);
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

it('carries and preselects the hub model on remix and hero CTA only when returned by the backend catalog', async () => {
  const opendesignProvider = { id: 'opendesign', label: 'OpenDesign', protocol: 'opendesign', category: 'gateway', kinds: ['image', 'video'], configured: true, enabled: true, available: true };
  const imageModelsWithGpt2 = [
    { id: 'opendesign:seedream-5.5', provider: 'opendesign', modelId: 'seedream-5.5', label: 'Seedream 5.5', modality: 'image', mode: 'text-to-image', source: 'builtin' },
    { id: 'opendesign:gpt-image-2.6-sunburst', provider: 'opendesign', modelId: 'gpt-image-2.6-sunburst', label: 'GPT Image 2.6 Sunburst', modality: 'image', mode: 'text-to-image', source: 'builtin' },
    { id: 'opendesign:gpt-image-2.0', provider: 'opendesign', modelId: 'gpt-image-2.0', label: 'GPT Image 2.0', modality: 'image', mode: 'text-to-image', source: 'builtin' },
  ];
  const videoModelsWithSeedance = [
    { id: 'opendesign:wan-2.7', provider: 'opendesign', modelId: 'wan-2.7', label: 'Wan 2.7', modality: 'video', mode: 'text-to-video', source: 'builtin' },
    { id: 'opendesign:doubao-seedance-2-5-flash-261115', provider: 'opendesign', modelId: 'doubao-seedance-2-5-flash-261115', label: 'Seedance 2.5 Flash', modality: 'video', mode: 'text-to-video', source: 'builtin' },
    { id: 'opendesign:doubao-seedance-2-5-260628', provider: 'opendesign', modelId: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5', modality: 'video', mode: 'text-to-video', source: 'builtin' },
  ];

  // 1. Backend returns GPT Image 2.0 + Seedance 2.5 -> remix & hero CTA carry and preselect exact preferred model
  for (const [hubId, models, expectedId] of [
    ['gpt-image-2-6', imageModelsWithGpt2, 'opendesign:gpt-image-2.0'],
    ['seedance-2-5', videoModelsWithSeedance, 'opendesign:doubao-seedance-2-5-260628'],
  ] as const) {
    catalogState.catalog = {
      models: [...models],
      status: { providers: [opendesignProvider], routes: {}, agents: [], capabilities: [] },
    };
    const onScene = vi.fn();
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <I18nProvider initialLocale="zh-CN">
        <ModelHub id={hubId} onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onScene={onScene} onSettings={() => {}} />
      </I18nProvider>,
    ));

    // Card "做同款" CTA
    await act(async () => container.querySelector<HTMLButtonElement>('.om-hub-showcase-cta')!.click());
    expect(onScene).toHaveBeenCalledTimes(1);
    const [remixDest, remixDraft] = onScene.mock.calls[0];
    expect(remixDest.model).toBe(expectedId);
    expect(remixDraft.preferredModel).toBe(expectedId);

    // Creation page resolves and selects that exact model
    const resolved = creationModels(
      catalogState.catalog as Parameters<typeof creationModels>[0],
      remixDest.scene.modality,
      remixDest.model,
      remixDest.scene,
      false,
      0,
      remixDraft.preferredModel,
    );
    expect(resolved.selected?.id).toBe(expectedId);
    expect(resolved.preferred?.id).toBe(expectedId);

    // Hero primary CTA ("前往生图" / "开始创作") also carries the matched model
    await act(async () => container.querySelector<HTMLButtonElement>('.om-hub-editorial-cta')!.click());
    expect(onScene).toHaveBeenCalledTimes(2);
    expect(onScene.mock.calls[1][0].model).toBe(expectedId);

    act(() => root!.unmount());
    root = undefined;
    container.remove();
  }

  // 2. Backend does NOT return GPT Image 2.x -> remix & hero CTA leave model unselected (no fake pin)
  const catalogWithoutGpt2 = {
    models: [
      { id: 'opendesign:seedream-5.5', provider: 'opendesign', modelId: 'seedream-5.5', label: 'Seedream 5.5', modality: 'image', mode: 'text-to-image', source: 'builtin' },
      { id: 'opendesign:nano-banana-2', provider: 'opendesign', modelId: 'nano-banana-2', label: 'Nano Banana 2', modality: 'image', mode: 'text-to-image', source: 'builtin' },
    ],
    status: { providers: [opendesignProvider], routes: { image: 'opendesign:seedream-5.5' }, agents: [], capabilities: [] },
  };
  catalogState.catalog = catalogWithoutGpt2;
  const onSceneMissing = vi.fn();
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <I18nProvider initialLocale="zh-CN">
      <ModelHub id="gpt-image-2-6" onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onScene={onSceneMissing} onSettings={() => {}} />
    </I18nProvider>,
  ));
  await act(async () => container.querySelector<HTMLButtonElement>('.om-hub-showcase-cta')!.click());
  const [missingDest, missingDraft] = onSceneMissing.mock.calls[0];
  expect(missingDest.model).toBeNull();
  expect(missingDraft.preferredModel).toBeUndefined();
  const resolvedMissing = creationModels(
    catalogWithoutGpt2 as Parameters<typeof creationModels>[0],
    'image',
    missingDest.model,
    missingDest.scene,
    false,
    0,
    missingDraft.preferredModel,
  );
  expect(resolvedMissing.selected?.id).toBe('opendesign:seedream-5.5');
  act(() => root!.unmount());
  root = undefined;
  container.remove();

  // 3. Catalog still loading on ModelHub -> passes soft hub hint; creationModels selects only if backend returns it
  catalogState.catalog = undefined;
  const onSceneLoading = vi.fn();
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <I18nProvider initialLocale="zh-CN">
      <ModelHub id="gpt-image-2-6" onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onScene={onSceneLoading} onSettings={() => {}} />
    </I18nProvider>,
  ));
  await act(async () => container.querySelector<HTMLButtonElement>('.om-hub-showcase-cta')!.click());
  const [loadingDest, loadingDraft] = onSceneLoading.mock.calls[0];
  expect(loadingDest.model).toBeNull();
  expect(loadingDraft.preferredModel).toBe('hub:gpt-image-2-6');

  const liveWithGpt2 = {
    models: [
      { id: 'opendesign:seedream-5.5', provider: 'opendesign', modelId: 'seedream-5.5', label: 'Seedream 5.5', modality: 'image', mode: 'text-to-image', source: 'builtin' },
      { id: 'opendesign:gpt-image-2', provider: 'opendesign', modelId: 'gpt-image-2', label: 'GPT Image 2.0', modality: 'image', mode: 'text-to-image', source: 'builtin' },
    ],
    status: { providers: [opendesignProvider], routes: { image: 'opendesign:seedream-5.5' }, agents: [], capabilities: [] },
  };
  expect(creationModels(liveWithGpt2 as Parameters<typeof creationModels>[0], 'image', null, loadingDest.scene, false, 0, loadingDraft.preferredModel).selected?.id)
    .toBe('opendesign:gpt-image-2');
  expect(creationModels(catalogWithoutGpt2 as Parameters<typeof creationModels>[0], 'image', null, loadingDest.scene, false, 0, loadingDraft.preferredModel).selected?.id)
    .toBe('opendesign:seedream-5.5');
  // Explicit user switch overrides soft hub hint
  expect(creationModels(liveWithGpt2 as Parameters<typeof creationModels>[0], 'image', 'opendesign:seedream-5.5', loadingDest.scene, false, 0, loadingDraft.preferredModel).selected?.id)
    .toBe('opendesign:seedream-5.5');

  // 4. Explore story models + Cinema template preferredModel work for both live and guest/compatible catalogs
  expect(storyModels(gptImageStory, liveWithGpt2 as Parameters<typeof storyModels>[1])[0]?.id).toBe('opendesign:gpt-image-2');
  expect(storyModels(gptImageStory, catalogWithoutGpt2 as Parameters<typeof storyModels>[1])).toEqual([]);
  const guestVideoCatalog = {
    models: videoModelsWithSeedance,
    status: { providers: [], routes: {}, agents: [], capabilities: [] },
  };
  const guestCinemaResolved = creationModels(
    guestVideoCatalog as Parameters<typeof creationModels>[0],
    'video',
    null,
    mediaEditorDestination('text-to-video').scene,
    false,
    0,
    'doubao-seedance-2-5-260628',
  );
  expect(guestCinemaResolved.preferred?.id).toBe('opendesign:doubao-seedance-2-5-260628');
});
