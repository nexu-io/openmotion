// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { WorkspaceChromeContext, type WorkspaceChrome } from './WorkspaceChromeContext';
import { StudioHostContext } from './StudioHost';
import { designClient } from '../design/designClient';

const mockScheduleIdlePreloads = vi.fn(() => () => {});
const mockUseMediaCatalog = vi.fn((active: boolean) => ({
  catalog: active ? { models: [], status: { providers: [] } } : undefined,
  failed: false,
  retry: vi.fn(),
}));

vi.mock('../utils/idlePreload', () => ({
  scheduleIdlePreloads: (...args: unknown[]) => mockScheduleIdlePreloads(...args),
}));

vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
vi.mock('./useMediaCatalog', () => ({
  useMediaCatalog: (active: boolean) => mockUseMediaCatalog(active),
}));
vi.mock('./ExploreTemplates', () => ({
  ExploreActionLabel: () => null,
  ExploreTemplateCard: () => null,
  TemplatePromptAction: () => null,
  useExploreTemplates: () => ({ pages: [], loading: false, error: null, retry: () => {} }),
  useExploreTemplateShelf: () => ({ items: [], categories: [], industries: [], collection: null, loading: false, error: null, retry: () => {} }),
}));
vi.mock('./useTemplatePlayback', () => ({
  useTemplatePlayback: () => new Set<string>(),
  useTemplatePlaybackPool: () => ({ playing: new Set<string>(), retained: new Set<string>() }),
}));
vi.mock('./useIntegrationInfo', () => ({
  useIntegrationInfo: () => ({ info: null }),
}));

import { ExploreStudios } from './ExploreStudios';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const chrome: WorkspaceChrome = {
  openModelSettings: vi.fn(),
  openProviderSettings: vi.fn(),
  openAccountSettings: vi.fn(),
  openSubscriptionSettings: vi.fn(),
  openLibrary: vi.fn(),
  openSkills: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;
let observed: Map<Element, () => void>;

beforeEach(() => {
  mockUseMediaCatalog.mockClear();
  mockScheduleIdlePreloads.mockClear();
  observed = new Map();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
    observe(target: Element) {
      observed.set(target, () => this.callback([{ target, isIntersecting: true, intersectionRatio: 1 }]));
    }
    unobserve(target: Element) { observed.delete(target); }
    disconnect() {}
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderExploreHome(
  active = true,
  chromeOverrides: Partial<WorkspaceChrome> = {},
  preloadEditorHost?: () => Promise<unknown>,
) {
  const hostValue = { preloadEditorHost };
  act(() => root.render(
    <I18nProvider initialLocale="en">
      <StudioHostContext.Provider value={hostValue as never}>
        <WorkspaceChromeContext.Provider value={{ ...chrome, ...chromeOverrides }}>
          <ExploreStudios
            active={active}
            campaign={{ showHero: false, expire: vi.fn() }}
            filters={{ community: null, medium: null }}
            onNavigate={vi.fn()}
            onChooseStudio={vi.fn()}
            onSelectDesignScene={vi.fn()}
            onOpenDesignProject={vi.fn()}
            onOpenMotionEditor={vi.fn()}
            motionEditorDisabled={false}
            onSkill={vi.fn()}
            onOpenBlackFriday={vi.fn()}
            onModel={vi.fn()}
            onModelHub={vi.fn()}
            onCreators={vi.fn()}
            onMcp={vi.fn()}
          />
        </WorkspaceChromeContext.Provider>
      </StudioHostContext.Provider>
    </I18nProvider>,
  ));
}

it('defers below-the-fold model catalog and design template requests until their sections approach view', async () => {
  const listTemplatesSpy = vi.spyOn(designClient, 'listTemplates').mockResolvedValue({
    items: [{
      id: 'tpl-1',
      scenario: 'web-page',
      title: 'Launch landing page',
      description: 'Responsive hero layout',
      previewUrl: '/design-templates/tpl-1/index.html',
      examplePrompt: '',
    }],
    nextCursor: null,
  });

  renderExploreHome();

  // Neither below-the-fold API fires on initial above-the-fold mount.
  expect(mockUseMediaCatalog).toHaveBeenCalled();
  expect(mockUseMediaCatalog.mock.calls.every(([active]) => active === false)).toBe(true);
  expect(listTemplatesSpy).not.toHaveBeenCalled();

  // Provider avatar in ClaudeStories is lazy-loaded.
  const providerImg = container.querySelector<HTMLImageElement>('[aria-labelledby="explore-claude"] .om-provider-avatar img');
  expect(providerImg?.getAttribute('loading')).toBe('lazy');
  expect(providerImg?.getAttribute('decoding')).toBe('async');

  // Approaching the first ModelCollection activates the media catalog fetch.
  const seedanceSection = container.querySelector('section[aria-labelledby="explore-seedance"]')!;
  const gptImageSection = container.querySelector('section[aria-labelledby="explore-gpt-image"]')!;
  expect(observed.has(seedanceSection)).toBe(true);
  expect(observed.has(gptImageSection)).toBe(true);
  act(() => observed.get(seedanceSection)!());
  expect(mockUseMediaCatalog).toHaveBeenLastCalledWith(true);

  // Approaching the Design Studio section host loads design starter templates.
  const designSection = container.querySelector('section[data-studio="design"]')!;
  expect(observed.has(designSection)).toBe(true);
  await act(async () => {
    observed.get(designSection)!();
    await Promise.resolve();
  });
  expect(listTemplatesSpy).toHaveBeenCalledTimes(1);
  expect(listTemplatesSpy).toHaveBeenCalledWith({ limit: 8 });
  expect(container.querySelector('[data-design-template="tpl-1"]')).not.toBeNull();

  // Keep-alive hide/show does not re-fetch already-loaded design templates.
  renderExploreHome(false);
  renderExploreHome(true);
  expect(listTemplatesSpy).toHaveBeenCalledTimes(1);
});

it('prefetches the model catalog immediately when focusing an Explore highlight shortcut for Seedance or GPT Image', () => {
  vi.spyOn(designClient, 'listTemplates').mockResolvedValue({ items: [], nextCursor: null });

  renderExploreHome();
  expect(mockUseMediaCatalog.mock.calls.every(([active]) => active === false)).toBe(true);

  const highlights = container.querySelector('[aria-labelledby="explore-highlights"]')!;
  const seedanceShortcut = [...highlights.querySelectorAll<HTMLButtonElement>('.om-story-card')]
    .find(card => card.textContent?.includes('Seedance'))!;
  expect(seedanceShortcut).toBeTruthy();

  act(() => {
    seedanceShortcut.focus();
  });
  expect(mockUseMediaCatalog).toHaveBeenLastCalledWith(true);
});

it('skips speculative editor preloading for guests and while auth is resolving, then defers it after sign-in', () => {
  const preloadHost = vi.fn(async () => {});

  renderExploreHome(true, { guestMode: true, authResolving: false }, preloadHost);
  expect(mockScheduleIdlePreloads).not.toHaveBeenCalled();

  renderExploreHome(true, { guestMode: false, authResolving: true }, preloadHost);
  expect(mockScheduleIdlePreloads).not.toHaveBeenCalled();

  renderExploreHome(true, { guestMode: false, authResolving: false }, preloadHost);
  expect(mockScheduleIdlePreloads).toHaveBeenCalledTimes(1);
  expect(mockScheduleIdlePreloads).toHaveBeenCalledWith(
    [expect.any(Function), preloadHost],
    { delayMs: 4000 },
  );
});
