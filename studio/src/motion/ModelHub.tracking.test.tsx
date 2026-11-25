// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validProperties } from '../../../tracking/core.ts';
import { studioEvents } from '../../../tracking/events.ts';

const sent: { event: string; properties: Record<string, unknown> }[] = [];
vi.mock('./tracking', () => ({ trackMotion: vi.fn(async (event: string, properties: Record<string, unknown>) => { sent.push({ event, properties }); return 'queued'; }) }));
vi.mock('./AccountSettings', () => ({ useAccountSummary: () => ({ account: { state: 'signed-out' }, error: false }) }));
vi.mock('./useMediaCatalog', () => ({ useMediaCatalog: () => ({ catalog: { models: [], status: { providers: [{ id: 'gemini', label: 'Gemini', available: false }] } }, failed: false, retry: () => {} }) }));
const { ModelHub, resetModelHubCaseImpressions } = await import('./ModelHub');
const { I18nProvider } = await import('../i18n/I18n');
const { findModelHub } = await import('./modelHubs');
const { consumeExternalCheckoutPending } = await import('./entitlementModalBus');
await (await import('./reporting')).loadReportingTransport();

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const of = (event: string) => sent.filter(row => row.event === event);
const clicks = () => of('ui_click').map(row => row.properties);
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')]
  .find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)!;
beforeEach(() => {
  sent.length = 0;
  resetModelHubCaseImpressions();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it('reports one hub view and its hero, filter, video and detail actions by id only', async () => {
  const hub = findModelHub('gemini-4')!;
  await act(async () => root.render(<I18nProvider initialLocale="en"><ModelHub id="gemini-4" hasProject onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onSettings={() => {}} /></I18nProvider>));
  expect(of('page_view').map(row => row.properties)).toEqual([expect.objectContaining({ page_name: 'model_hub', hub_id: 'gemini-4', signed_in: false, has_project: true })]);

  await act(async () => button('Connect MCP', container.querySelector('.om-model-hub-hero')!).click());
  expect(clicks().at(-1)).toMatchObject({ page_name: 'model_hub', area: 'hub_hero', element: 'manage_connection', hub_id: 'gemini-4', signed_in: false });

  const filters = container.querySelectorAll<HTMLButtonElement>('.om-hub-video-filters button');
  await act(async () => filters[1].click());
  expect(clicks().at(-1)).toMatchObject({ area: 'hub_videos', element: 'filter_option', filter_value: expect.stringMatching(/^[a-z0-9-]+$/) });

  const cover = container.querySelector<HTMLButtonElement>('.om-hub-video .om-gallery-cover')!;
  await act(async () => cover.click());
  expect(clicks().at(-1)).toMatchObject({ area: 'hub_videos', element: 'open_detail', hub_video_id: expect.stringMatching(/^[a-z0-9-]+$/i), position: 0, signed_in: false });
  const dialog = document.querySelector<HTMLElement>('.om-hub-video-detail')!;
  await act(async () => button('Recreate this template', dialog).click());
  expect(clicks().at(-1)).toMatchObject({ area: 'hub_video_detail', element: 'start_use', template_action: 'recreate' });
  await act(async () => button('Next template', dialog).click());
  expect(clicks().at(-1)).toMatchObject({ area: 'hub_video_detail', element: 'detail_next' });
  await act(async () => button('Close template preview', dialog).click());
  expect(clicks().at(-1)).toMatchObject({ area: 'hub_video_detail', element: 'close_detail' });

  for (const row of sent) expect(validProperties(studioEvents, row.event, row.properties), JSON.stringify(row)).toBe(true);
  // Video titles, creators and post links never leave the browser.
  const text = JSON.stringify(sent);
  for (const video of hub.videos.slice(0, 5)) {
    expect(text).not.toContain(video.title);
    expect(text).not.toContain(video.post);
  }
});

it('reports showcase card impressions, promo pill attribution, category filter, open_detail, copy_prompt status, and start_use with template source handoff', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(Date.parse('2026-11-25T12:00:00+08:00'));
  consumeExternalCheckoutPending();

  type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;
  let observerCb: ObserverCallback | undefined;
  const observed: Element[] = [];
  class MockIntersectionObserver {
    constructor(cb: ObserverCallback) { observerCb = cb; }
    observe(el: Element) { observed.push(el); }
    disconnect() {}
  }
  const origIO = globalThis.IntersectionObserver;
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

  const onScene = vi.fn();
  const hub = findModelHub('seedance-2-5')!;
  const firstCase = hub.cases![0];
  try {
    await act(async () => root.render(
      <I18nProvider initialLocale="en">
        <ModelHub id="seedance-2-5" hasProject onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onScene={onScene} onSettings={() => {}} />
      </I18nProvider>,
    ));

    // 1. Qualified card impression (>= 50% visible for 1 unbroken second, once per result set)
    const firstCard = container.querySelector<HTMLElement>(`.om-hub-showcase-card[data-template-id="${firstCase.id}"]`)!;
    expect(firstCard).not.toBeNull();
    expect(observed).toContain(firstCard);
    act(() => {
      observerCb?.([{ target: firstCard, isIntersecting: true, intersectionRatio: 0.6 } as IntersectionObserverEntry]);
    });
    act(() => { vi.advanceTimersByTime(999); });
    expect(of('surface_view')).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(1); });
    expect(of('surface_view')).toEqual([
      {
        event: 'surface_view',
        properties: {
          page_name: 'model_hub',
          area: 'hub_videos',
          element: 'card',
          hub_id: 'seedance-2-5',
          template_id: firstCase.id,
          position: 0,
          signed_in: false,
          filter_value: 'all',
        },
      },
    ]);
    // Re-entering viewport in the same result set does not double-count
    act(() => {
      observerCb?.([{ target: firstCard, isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry]);
      observerCb?.([{ target: firstCard, isIntersecting: true, intersectionRatio: 0.8 } as IntersectionObserverEntry]);
      vi.advanceTimersByTime(1500);
    });
    expect(of('surface_view')).toHaveLength(1);

    // 2. Promo pill click carries bf_hub, utm_medium=model_hub, od_entry_source, and marks checkout pending
    const promoPill = container.querySelector<HTMLAnchorElement>('.om-hub-promo-pill')!;
    promoPill.addEventListener('click', event => event.preventDefault());
    const pillUrl = new URL(promoPill.href);
    const pillEntryId = pillUrl.searchParams.get('od_entry_id');
    expect(pillUrl.searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');
    expect(pillUrl.searchParams.get('utm_medium')).toBe('model_hub');
    await act(async () => { promoPill.click(); });
    expect(clicks().at(-1)).toMatchObject({
      page_name: 'model_hub',
      area: 'hub_hero',
      element: 'claim_offer',
      hub_id: 'seedance-2-5',
      campaign_id: 'black_friday_2026',
      hook_id: 'bf_hub',
      entry_id: pillEntryId,
    });
    expect(consumeExternalCheckoutPending()).toEqual({ hookId: 'bf_hub', entryId: pillEntryId });

    // 3. Top-right Start Creating stays hub_hero / open_in_studio without template_id
    await act(async () => container.querySelector<HTMLButtonElement>('.om-hub-editorial-cta')!.click());
    expect(clicks().at(-1)).toMatchObject({ page_name: 'model_hub', area: 'hub_hero', element: 'open_in_studio', hub_id: 'seedance-2-5' });
    expect(clicks().at(-1)).not.toHaveProperty('template_id');

    // 4. Card Remix button reports hub_videos / start_use with prompt_edited=false and hands template source to Studio draft
    await act(async () => firstCard.querySelector<HTMLButtonElement>('.om-hub-showcase-cta')!.click());
    expect(clicks().at(-1)).toMatchObject({
      page_name: 'model_hub',
      area: 'hub_videos',
      element: 'start_use',
      hub_id: 'seedance-2-5',
      template_id: firstCase.id,
      position: 0,
      prompt_edited: false,
    });
    expect(onScene.mock.calls.at(-1)?.[1]).toMatchObject({
      source: { hubId: 'seedance-2-5', templateId: firstCase.id, promptEdited: false },
    });

    // 5. Card open_detail + Lightbox copy_prompt (success & failure) + edited start_use
    await act(async () => firstCard.click());
    expect(clicks().at(-1)).toMatchObject({
      page_name: 'model_hub',
      area: 'hub_videos',
      element: 'open_detail',
      hub_id: 'seedance-2-5',
      template_id: firstCase.id,
      position: 0,
      filter_value: 'all',
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => dialog.querySelector<HTMLButtonElement>('.om-hub-lightbox-copy')!.click());
    expect(clicks().at(-1)).toMatchObject({
      page_name: 'model_hub',
      area: 'hub_video_detail',
      element: 'copy_prompt',
      hub_id: 'seedance-2-5',
      template_id: firstCase.id,
      copy_status: 'clipboard_written',
    });

    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    await act(async () => dialog.querySelector<HTMLButtonElement>('.om-hub-lightbox-copy')!.click());
    expect(clicks().at(-1)).toMatchObject({
      page_name: 'model_hub',
      area: 'hub_video_detail',
      element: 'copy_prompt',
      hub_id: 'seedance-2-5',
      template_id: firstCase.id,
      copy_status: 'failed',
    });

    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, `${firstCase.prompt} — custom lighting`);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => dialog.querySelector<HTMLButtonElement>('.om-hub-lightbox-cta')!.click());
    expect(clicks().at(-1)).toMatchObject({
      page_name: 'model_hub',
      area: 'hub_video_detail',
      element: 'start_use',
      hub_id: 'seedance-2-5',
      template_id: firstCase.id,
      position: 0,
      prompt_edited: true,
    });
    expect(onScene.mock.calls.at(-1)?.[1]).toMatchObject({
      source: { hubId: 'seedance-2-5', templateId: firstCase.id, promptEdited: true },
    });

    // 6. Category filter tab click reports hub_videos / category_select (ignoring no-op clicks on active tab)
    const tabs = container.querySelectorAll<HTMLButtonElement>('.om-hub-editorial-tab');
    const clicksBeforeTab = clicks().length;
    await act(async () => tabs[0].click());
    expect(clicks().length).toBe(clicksBeforeTab);
    await act(async () => tabs[1].click());
    expect(clicks().at(-1)).toMatchObject({
      page_name: 'model_hub',
      area: 'hub_videos',
      element: 'category_select',
      hub_id: 'seedance-2-5',
      filter_value: expect.stringMatching(/^[a-z0-9-]+$/),
    });

    // Every emitted event passes the closed tracking schema and never leaks titles or prompt text
    for (const row of sent) {
      expect(validProperties(studioEvents, row.event, row.properties), JSON.stringify(row)).toBe(true);
    }
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain(firstCase.title);
    expect(serialized).not.toContain(firstCase.prompt);
    expect(serialized).not.toContain('custom lighting');
  } finally {
    vi.stubGlobal('IntersectionObserver', origIO);
    vi.useRealTimers();
  }
});

it('pauses showcase card impression observers while the lightbox is open and deduplicates across remounts', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(Date.parse('2026-11-25T12:00:00+08:00'));

  type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;
  let observerCb: ObserverCallback | undefined;
  let disconnectCount = 0;
  class MockIntersectionObserver {
    constructor(cb: ObserverCallback) { observerCb = cb; }
    observe() {}
    disconnect() { disconnectCount++; }
  }
  const origIO = globalThis.IntersectionObserver;
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

  const hub = findModelHub('gpt-image-2-6')!;
  const firstCase = hub.cases![0];
  const secondCase = hub.cases![1];
  try {
    await act(async () => root.render(
      <I18nProvider initialLocale="en">
        <ModelHub id="gpt-image-2-6" hasProject onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onScene={() => {}} onSettings={() => {}} />
      </I18nProvider>,
    ));

    const firstCard = container.querySelector<HTMLElement>(`.om-hub-showcase-card[data-template-id="${firstCase.id}"]`)!;
    const secondCard = container.querySelector<HTMLElement>(`.om-hub-showcase-card[data-template-id="${secondCase.id}"]`)!;

    // First card completes its 1s impression.
    act(() => {
      observerCb?.([{ target: firstCard, isIntersecting: true, intersectionRatio: 0.7 } as IntersectionObserverEntry]);
      vi.advanceTimersByTime(1000);
    });
    expect(of('surface_view')).toHaveLength(1);

    // Second card enters view, then lightbox opens before 1s elapses: observer disconnects and timer is cancelled.
    const disconnectsBeforeLightbox = disconnectCount;
    act(() => {
      observerCb?.([{ target: secondCard, isIntersecting: true, intersectionRatio: 0.7 } as IntersectionObserverEntry]);
      vi.advanceTimersByTime(500);
    });
    await act(async () => firstCard.click());
    expect(disconnectCount).toBeGreaterThan(disconnectsBeforeLightbox);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(of('surface_view')).toHaveLength(1);

    // Unmount and remount (simulating navigating to Studio and pressing Back): first card is not re-reported.
    await act(async () => root.render(null));
    await act(async () => root.render(
      <I18nProvider initialLocale="en">
        <ModelHub id="gpt-image-2-6" hasProject onExplore={() => {}} onProvider={() => {}} onModel={() => {}} onUse={() => {}} onScene={() => {}} onSettings={() => {}} />
      </I18nProvider>,
    ));
    const remountedFirst = container.querySelector<HTMLElement>(`.om-hub-showcase-card[data-template-id="${firstCase.id}"]`)!;
    act(() => {
      observerCb?.([{ target: remountedFirst, isIntersecting: true, intersectionRatio: 0.9 } as IntersectionObserverEntry]);
      vi.advanceTimersByTime(2000);
    });
    expect(of('surface_view')).toHaveLength(1);
  } finally {
    vi.stubGlobal('IntersectionObserver', origIO);
    vi.useRealTimers();
  }
});
