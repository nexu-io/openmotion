// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyLibraryCounts,
  type UnifiedLibraryItem,
  type UnifiedLibrarySort,
} from '../../../shared/library-index';
import { I18nProvider } from '../i18n/I18n';
import { LibraryTimelineView } from './LibraryTimelineView';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function makeSampleItems(nowMs: number): UnifiedLibraryItem[] {
  const yesterdayMs = nowMs - 86_400_000;
  const olderMs = nowMs - 6 * 86_400_000;
  return [
    {
      id: 'motion-export:exp_1',
      kind: 'motion-export',
      category: 'videos',
      title: 'luma_coffee.mp4',
      subtitle: 'LUMA Coffee Film',
      createdAt: nowMs - 3_600_000,
      updatedAt: nowMs - 1_200_000,
      origin: 'super-agent',
      originLabel: 'Coffee Launch Agent',
      moduleLabel: 'Motion Studio',
      badgeLabel: 'MP4',
      sourceChatId: 'chat_1',
      sourceChatTitle: 'Coffee Launch Agent',
      downloadUrl: '/motion-api/exports/exp_1/file',
      mimeType: 'video/mp4',
      filename: 'luma_coffee.mp4',
      target: {
        kind: 'motion-export',
        projectId: 'proj_motion_1',
        jobId: 'exp_1',
        downloadUrl: '/motion-api/exports/exp_1/file',
      },
    },
    {
      id: 'design:proj_deck_1',
      kind: 'design-project',
      category: 'slides',
      title: 'Q4 Product Keynote',
      subtitle: 'Slide deck',
      createdAt: yesterdayMs - 10_000,
      updatedAt: yesterdayMs,
      origin: 'workflow',
      originLabel: 'Launch Campaign Flow',
      moduleLabel: 'Design Studio',
      badgeLabel: 'Slide deck',
      sourceScenarioId: 'campaign-launch',
      sourceRunId: 'run_1',
      sourceRunTitle: 'Launch Campaign Flow',
      target: {
        kind: 'design-project',
        projectId: 'proj_deck_1',
        scenario: 'deck',
      },
    },
    {
      id: 'super-agent:chat_2:art_web',
      kind: 'super-agent-web',
      category: 'websites',
      title: 'Interactive Showcase Page',
      subtitle: 'https://open-design.ai/showcase/demo',
      createdAt: olderMs - 5_000,
      updatedAt: olderMs,
      origin: 'super-agent',
      originLabel: 'Web Demo Agent',
      moduleLabel: 'Super Agent',
      badgeLabel: 'Web Page',
      sourceChatId: 'chat_2',
      sourceChatTitle: 'Web Demo Agent',
      externalUrl: 'https://open-design.ai/showcase/demo',
      target: {
        kind: 'super-agent',
        chatId: 'chat_2',
        artifactId: 'art_web',
      },
    },
    {
      id: 'asset:asset_img_1',
      kind: 'asset',
      category: 'images',
      title: 'hero_still.png',
      subtitle: 'Minimal warm coffee studio shot',
      createdAt: olderMs - 15_000,
      updatedAt: olderMs - 10_000,
      origin: 'mcp',
      originLabel: 'MCP & Agents',
      moduleLabel: 'Image Studio',
      badgeLabel: 'PNG',
      previewUrl: '/motion-api/assets/asset_img_1/versions/v1/file',
      downloadUrl: '/motion-api/assets/asset_img_1/versions/v1/file?download=',
      canTrash: true,
      target: {
        kind: 'asset',
        assetId: 'asset_img_1',
        versionId: 'v1',
      },
    },
  ];
}

describe('LibraryTimelineView', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    container.dataset.motionStudio = 'true';
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('groups items by calendar day, toggles list/grid views, hides zero-count pills, and dispatches jumps & menu actions', async () => {
    const items = makeSampleItems(Date.now());
    const counts = {
      ...createEmptyLibraryCounts(),
      all: 4,
      videos: 1,
      slides: 1,
      websites: 1,
      images: 1,
    };

    const onCategoryChange = vi.fn();
    const onOriginChange = vi.fn();
    const onSortChange = vi.fn();
    const onQueryChange = vi.fn();
    const onOpenItem = vi.fn();
    const onOpenSourceChat = vi.fn();
    const onOpenSourceWorkflow = vi.fn();
    const onDownloadItem = vi.fn();
    const onCopyExternalUrl = vi.fn();
    const onOpenExternalUrl = vi.fn();
    const onTrashAsset = vi.fn();
    const onOpenTrash = vi.fn();

    let viewMode: 'list' | 'grid' = 'list';
    let sort: UnifiedLibrarySort = 'newest';

    const renderView = () => (
      <I18nProvider initialLocale="en">
        <LibraryTimelineView
          items={items}
          counts={counts}
          total={items.length}
          nextOffset={null}
          category="all"
          onCategoryChange={onCategoryChange}
          origin="all"
          onOriginChange={onOriginChange}
          sort={sort}
          onSortChange={next => {
            sort = next;
            onSortChange(next);
          }}
          query=""
          onQueryChange={onQueryChange}
          viewMode={viewMode}
          onViewModeChange={next => {
            viewMode = next;
          }}
          loading={false}
          loadingMore={false}
          error={false}
          onRetry={vi.fn()}
          onLoadMore={vi.fn()}
          onResetFilters={vi.fn()}
          onOpenTrash={onOpenTrash}
          onOpenItem={onOpenItem}
          onOpenSourceChat={onOpenSourceChat}
          onOpenSourceWorkflow={onOpenSourceWorkflow}
          onDownloadItem={onDownloadItem}
          onCopyExternalUrl={onCopyExternalUrl}
          onOpenExternalUrl={onOpenExternalUrl}
          onTrashAsset={onTrashAsset}
        />
      </I18nProvider>
    );

    root = createRoot(container);
    await act(async () => {
      root!.render(renderView());
    });
    await flush();

    // Category pills show populated categories and hide zero-count ones (e.g., Audio, Brand Kits)
    const pills = Array.from(container.querySelectorAll<HTMLButtonElement>('.om-library-cat-pill')).map(
      b => b.textContent,
    );
    expect(pills.some(text => text?.startsWith('Websites'))).toBe(true);
    expect(pills.some(text => text?.startsWith('Slides'))).toBe(true);
    expect(pills.some(text => text?.startsWith('Videos'))).toBe(true);
    expect(pills.some(text => text?.startsWith('Images'))).toBe(true);
    expect(pills.some(text => text?.startsWith('Audio'))).toBe(false);
    expect(pills.some(text => text?.startsWith('Brand Kits'))).toBe(false);

    // Date headings include Today and Yesterday
    const headings = Array.from(container.querySelectorAll('.om-library-day-heading')).map(h => h.textContent);
    expect(headings.length).toBe(3);
    expect(headings[0]).toContain('Today');
    expect(headings[0]).toContain('(1)');
    expect(headings[1]).toContain('Yesterday');
    expect(headings[1]).toContain('(1)');

    // Clicking first row invokes primary jump handler
    const rows = container.querySelectorAll<HTMLButtonElement>('.om-library-row-main');
    expect(rows).toHaveLength(4);
    await act(async () => {
      rows[0]!.click();
    });
    expect(onOpenItem).toHaveBeenCalledWith(items[0]);

    // Overflow menu on first item exposes Open source task + Download
    const moreBtns = container.querySelectorAll<HTMLButtonElement>('.om-library-more-btn');
    await act(async () => {
      moreBtns[0]!.click();
    });
    await flush();
    const menuItems = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const sourceTaskItem = menuItems.find(el => el.textContent?.includes('Open source task'));
    expect(sourceTaskItem).toBeDefined();
    await act(async () => {
      sourceTaskItem!.click();
    });
    expect(onOpenSourceChat).toHaveBeenCalledWith('chat_1');

    // Overflow menu on Design slide item exposes Open source workflow
    await act(async () => {
      moreBtns[1]!.click();
    });
    await flush();
    const wfItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      el => el.textContent?.includes('Open source workflow'),
    );
    expect(wfItem).toBeDefined();
    await act(async () => {
      wfItem!.click();
    });
    expect(onOpenSourceWorkflow).toHaveBeenCalledWith('campaign-launch', 'run_1');

    // Overflow menu on Super Agent web item exposes Copy link
    await act(async () => {
      moreBtns[2]!.click();
    });
    await flush();
    const copyLinkItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      el => el.textContent?.includes('Copy link'),
    );
    expect(copyLinkItem).toBeDefined();
    await act(async () => {
      copyLinkItem!.click();
    });
    expect(onCopyExternalUrl).toHaveBeenCalledWith('https://open-design.ai/showcase/demo');

    // Overflow menu on asset item exposes Move to trash
    await act(async () => {
      moreBtns[3]!.click();
    });
    await flush();
    const trashItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      el => el.textContent?.includes('Move to trash'),
    );
    expect(trashItem).toBeDefined();
    await act(async () => {
      trashItem!.click();
    });
    expect(onTrashAsset).toHaveBeenCalledWith('asset_img_1');

    // Switch to Grid view and verify cards render cleanly
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')!.click();
      root!.render(renderView());
    });
    await flush();
    expect(container.querySelector('[data-testid="unified-library-grid"]')).not.toBeNull();
    expect(container.querySelectorAll('.om-library-card')).toHaveLength(4);

    // Clicking Websites pill filters category
    const webPill = Array.from(container.querySelectorAll<HTMLButtonElement>('.om-library-cat-pill')).find(
      b => b.textContent?.startsWith('Websites'),
    )!;
    await act(async () => {
      webPill.click();
    });
    expect(onCategoryChange).toHaveBeenCalledWith('websites');
  });
});
