// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { WorkspaceChromeContext, type WorkspaceChrome } from './WorkspaceChromeContext';
import { BLACK_FRIDAY_HERO_ENDS_AT, BLACK_FRIDAY_HERO_STARTS_AT, useExploreCampaign } from './campaignAttribution';

vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
vi.mock('./useMediaCatalog', () => ({
  useMediaCatalog: () => ({ catalog: { models: [], status: { providers: [] } }, failed: false, retry: () => {} }),
}));
vi.mock('./ExploreTemplates', () => ({
  ExploreActionLabel: () => null,
  ExploreTemplateCard: () => null,
  TemplatePromptAction: () => null,
  useExploreTemplates: () => ({ pages: [], loading: false, error: null, retry: () => {} }),
  useExploreTemplateShelf: () => ({ items: [], categories: [], industries: [], collection: null, loading: false, error: null, retry: () => {} }),
}));
vi.mock('./useTemplatePlayback', () => ({
  EXPLORE_TEMPLATE_PLAYERS: 4,
  useTemplatePlayback: () => new Set<string>(),
  useTemplatePlaybackActive: () => false,
  useTemplatePlaybackStore: () => ({
    subscribe: () => () => {},
    isPlaying: () => false,
    getSnapshot: () => new Set<string>(),
    setPriority: () => {},
  }),
}));
vi.mock('../design/scenes/ExploreDesignSection', () => ({ ExploreDesignSection: () => null }));

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function renderExplore(onModelHub = vi.fn()) {
  function ExploreTestPage() {
    const filters = { community: null, medium: null };
    const campaign = useExploreCampaign(filters);
    return <I18nProvider initialLocale="zh-CN">
      <WorkspaceChromeContext.Provider value={chrome}>
        <ExploreStudios
          active
          campaign={campaign}
          filters={filters}
          onNavigate={vi.fn()}
          onChooseStudio={vi.fn()}
          onSelectDesignScene={vi.fn()}
          onOpenDesignProject={vi.fn()}
          onOpenMotionEditor={vi.fn()}
          motionEditorDisabled={false}
          onSkill={vi.fn()}
          onOpenBlackFriday={vi.fn()}
          onModel={vi.fn()}
          onModelHub={onModelHub}
          onCreators={vi.fn()}
          onMcp={vi.fn()}
        />
      </WorkspaceChromeContext.Provider>
    </I18nProvider>;
  }
  act(() => root.render(<ExploreTestPage />));
  return { onModelHub };
}

it('keeps the previous Explore layout before 2026-11-25 20:00 +08:00', () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(BLACK_FRIDAY_HERO_STARTS_AT - 1000);
  renderExplore();

  expect(container.querySelector('[data-bf-hero]')).toBeNull();
  expect(container.querySelector('[data-bf-spotlight]')).toBeNull();
  expect(container.querySelector('h1.om-explore-title')).not.toBeNull();
});

it('shows the Black Friday hero and spotlight cards during the campaign window and opens Seedance / GPT Image hubs', () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(BLACK_FRIDAY_HERO_STARTS_AT);
  const { onModelHub } = renderExplore();

  expect(container.querySelector('[data-bf-hero]')).not.toBeNull();
  expect(container.querySelector('[data-bf-spotlight]')).not.toBeNull();
  expect(container.querySelector('h1.om-explore-title')).toBeNull();

  const seedanceCard = container.querySelector<HTMLButtonElement>('[data-scene="seedance-2-5"]')!;
  const gptImageCard = container.querySelector<HTMLButtonElement>('[data-scene="gpt-image-2-6"]')!;
  expect(seedanceCard).not.toBeNull();
  expect(gptImageCard).not.toBeNull();

  act(() => seedanceCard.click());
  act(() => gptImageCard.click());
  expect(onModelHub).toHaveBeenNthCalledWith(1, 'seedance-2-5');
  expect(onModelHub).toHaveBeenNthCalledWith(2, 'gpt-image-2-6');
});

it('removes the Black Friday hero and restores the previous Explore layout right after 2026-12-04 23:59:59 +08:00', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(BLACK_FRIDAY_HERO_ENDS_AT - 1000);
  renderExplore();

  expect(container.querySelector('[data-bf-hero]')).not.toBeNull();
  expect(container.querySelector('[data-bf-spotlight]')).not.toBeNull();

  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(container.querySelector('[data-bf-hero]')).toBeNull();
  expect(container.querySelector('[data-bf-spotlight]')).toBeNull();
  expect(container.querySelector('h1.om-explore-title')).not.toBeNull();
});
