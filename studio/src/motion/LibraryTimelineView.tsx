import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useMemo, useState, type ReactNode } from 'react';
import {
  UNIFIED_LIBRARY_CATEGORIES,
  UNIFIED_LIBRARY_ORIGINS,
  type UnifiedLibraryCategory,
  type UnifiedLibraryCounts,
  type UnifiedLibraryItem,
  type UnifiedLibraryOrigin,
  type UnifiedLibrarySort,
} from '../../../shared/library-index';
import { VideoFrameThumbnail } from '../components/ui/VideoFrameThumbnail';
import { Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../components/ui/Menu';
import { Skeleton } from '../components/ui/Skeleton';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import type { UnifiedLibraryViewMode } from './useUnifiedLibrary';

const CATEGORY_META: Record<
  UnifiedLibraryCategory,
  { label: string; icon: string }
> = {
  all: { label: 'All', icon: 'apps-2-line' },
  websites: { label: 'Websites', icon: 'global-line' },
  slides: { label: 'Slides', icon: 'slideshow-line' },
  docs: { label: 'Documents', icon: 'file-text-line' },
  motion: { label: 'Motion', icon: 'clapperboard-line' },
  games: { label: 'Games', icon: 'gamepad-line' },
  images: { label: 'Images', icon: 'image-line' },
  videos: { label: 'Videos', icon: 'film-line' },
  audio: { label: 'Audio', icon: 'music-2-line' },
  'brand-kits': { label: 'Brand Kits', icon: 'palette-line' },
  workflows: { label: 'Workflows', icon: 'route-line' },
};

const ORIGIN_META: Record<UnifiedLibraryOrigin, string> = {
  all: 'All sources',
  'super-agent': 'Super Agent',
  studio: 'Studios & Editors',
  workflow: 'Workflows',
  mcp: 'MCP & Agents',
  upload: 'Local upload',
};

const SORT_META: Record<UnifiedLibrarySort, string> = {
  newest: 'Newest',
  oldest: 'Oldest first',
  name: 'Name',
};

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDayHeading(
  timestamp: number,
  locale: string,
  t: (message: string, values?: Record<string, string | number>) => string,
  nowMs: number,
): string {
  const todayKey = dayKey(nowMs);
  const yesterdayKey = dayKey(nowMs - 86_400_000);
  const key = dayKey(timestamp);
  if (key === todayKey) return t('Today');
  if (key === yesterdayKey) return t('Yesterday');
  const d = new Date(timestamp);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
  }).format(d);
}

function formatRowTimestamp(timestamp: number, locale: string, includeDate: boolean): string {
  const d = new Date(timestamp);
  return new Intl.DateTimeFormat(locale, {
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function primaryOpenLabel(item: UnifiedLibraryItem): string {
  switch (item.target.kind) {
    case 'motion-project':
    case 'motion-export':
      return item.target.projectId ? 'Open in Motion Studio' : 'Download video';
    case 'design-project':
      return 'Open in Design Studio';
    case 'game-project':
      return 'Open in Game Studio';
    case 'brand-kit':
      return 'Open Brand Kit';
    case 'workflow-run':
      return 'Open workflow';
    case 'super-agent':
      return 'Open in Super Agent';
    case 'asset':
    default:
      return 'Open asset details';
  }
}

function LibraryCategoryBadge({
  category,
  size = 'sm',
}: {
  category: Exclude<UnifiedLibraryCategory, 'all'>;
  size?: 'sm' | 'lg';
}) {
  const meta = CATEGORY_META[category];
  return (
    <span
      className={size === 'lg' ? 'om-library-card-badge' : 'om-library-row-badge'}
      data-category={category}
      aria-hidden="true"
    >
      <RemixIcon name={meta.icon} size={size === 'lg' ? 28 : 18} />
    </span>
  );
}

function LibraryRowLeading({ item }: { item: UnifiedLibraryItem }) {
  const [failed, setFailed] = useState(false);
  const showImageThumb = !failed && Boolean(item.previewUrl) && (item.category === 'images' || item.category === 'games');
  if (showImageThumb) {
    return (
      <span className="om-library-row-thumb" aria-hidden="true">
        <img src={item.previewUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </span>
    );
  }
  return <LibraryCategoryBadge category={item.category} size="sm" />;
}

function LibraryCardVisual({ item, t }: { item: UnifiedLibraryItem; t: (msg: string) => string }) {
  const [failed, setFailed] = useState(false);
  const showImage = !failed && Boolean(item.previewUrl) && (item.category === 'images' || item.category === 'games');
  if (showImage) {
    return (
      <div className="om-library-card-media">
        <img src={item.previewUrl} alt={item.title} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </div>
    );
  }
  if (item.category === 'videos' && item.previewUrl && item.kind === 'asset') {
    return (
      <div className="om-library-card-media">
        <VideoFrameThumbnail src={item.previewUrl} fallbackLabel={t('Preview unavailable')} />
      </div>
    );
  }
  return (
    <div className="om-library-card-media om-library-card-media-symbol" data-category={item.category}>
      <LibraryCategoryBadge category={item.category} size="lg" />
      {item.badgeLabel && <span className="om-library-card-format">{t(item.badgeLabel)}</span>}
    </div>
  );
}

function LibraryItemMenu({
  item,
  onOpenItem,
  onOpenSourceChat,
  onOpenSourceWorkflow,
  onDownloadItem,
  onCopyExternalUrl,
  onOpenExternalUrl,
  onTrashAsset,
}: {
  item: UnifiedLibraryItem;
  onOpenItem: (item: UnifiedLibraryItem) => void;
  onOpenSourceChat?: (chatId: string) => void;
  onOpenSourceWorkflow?: (scenarioId: string, runId: string) => void;
  onDownloadItem: (item: UnifiedLibraryItem) => void;
  onCopyExternalUrl: (url: string) => void;
  onOpenExternalUrl: (url: string) => void;
  onTrashAsset: (assetId: string) => void;
}) {
  const { t } = useI18n();
  const hasChatSource = Boolean(item.sourceChatId && item.target.kind !== 'super-agent' && onOpenSourceChat);
  const hasWorkflowSource = Boolean(
    item.sourceScenarioId &&
      item.sourceRunId &&
      item.target.kind !== 'workflow-run' &&
      onOpenSourceWorkflow,
  );
  const hasSecondary = Boolean(item.downloadUrl || item.externalUrl || (item.canTrash && item.target.kind === 'asset'));

  return (
    <Menu
      modal={false}
      align="end"
      aria-label={t('More actions')}
      trigger={
        <IconButton
          variant="ghost"
          type="button"
          className="om-library-more-btn"
          aria-label={t('More actions')}
          icon={<RemixIcon name="more-line" size={16} />}
        />
      }
    >
      <MenuItem closeOnClick onClick={() => onOpenItem(item)}>
        <span className="om-menu-label">
          <RemixIcon name="arrow-right-up-line" size={15} />
          {t(primaryOpenLabel(item))}
        </span>
      </MenuItem>
      {hasChatSource && (
        <MenuItem closeOnClick onClick={() => onOpenSourceChat?.(item.sourceChatId!)}>
          <span className="om-menu-label">
            <RemixIcon name="chat-1-line" size={15} />
            {t('Open source task')}
          </span>
        </MenuItem>
      )}
      {hasWorkflowSource && (
        <MenuItem closeOnClick onClick={() => onOpenSourceWorkflow?.(item.sourceScenarioId!, item.sourceRunId!)}>
          <span className="om-menu-label">
            <RemixIcon name="route-line" size={15} />
            {t('Open source workflow')}
          </span>
        </MenuItem>
      )}
      {hasSecondary && <MenuSeparator />}
      {item.downloadUrl && (
        <MenuItem closeOnClick onClick={() => onDownloadItem(item)}>
          <span className="om-menu-label">
            <RemixIcon name="download-2-line" size={15} />
            {t('Download')}
          </span>
        </MenuItem>
      )}
      {item.externalUrl && (
        <>
          <MenuItem closeOnClick onClick={() => onOpenExternalUrl(item.externalUrl!)}>
            <span className="om-menu-label">
              <RemixIcon name="external-link-line" size={15} />
              {t('Open link')}
            </span>
          </MenuItem>
          <MenuItem closeOnClick onClick={() => onCopyExternalUrl(item.externalUrl!)}>
            <span className="om-menu-label">
              <RemixIcon name="link" size={15} />
              {t('Copy link')}
            </span>
          </MenuItem>
        </>
      )}
      {item.canTrash && item.target.kind === 'asset' && (
        <MenuItem
          closeOnClick
          onClick={() => {
            if (item.target.kind === 'asset') onTrashAsset(item.target.assetId);
          }}
        >
          <span className="om-menu-label">
            <RemixIcon name="delete-bin-line" size={15} />
            {t('Move to trash')}
          </span>
        </MenuItem>
      )}
    </Menu>
  );
}

export type LibraryTimelineViewProps = {
  items: UnifiedLibraryItem[];
  counts: UnifiedLibraryCounts;
  total: number;
  nextOffset: number | null;
  category: UnifiedLibraryCategory;
  onCategoryChange: (category: UnifiedLibraryCategory) => void;
  origin: UnifiedLibraryOrigin;
  onOriginChange: (origin: UnifiedLibraryOrigin) => void;
  sort: UnifiedLibrarySort;
  onSortChange: (sort: UnifiedLibrarySort) => void;
  query: string;
  onQueryChange: (query: string) => void;
  viewMode: UnifiedLibraryViewMode;
  onViewModeChange: (mode: UnifiedLibraryViewMode) => void;
  loading: boolean;
  loadingMore: boolean;
  loadingMoreError?: boolean;
  error: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onResetFilters: () => void;
  onOpenTrash: () => void;
  onOpenItem: (item: UnifiedLibraryItem) => void;
  onOpenSourceChat?: (chatId: string) => void;
  onOpenSourceWorkflow?: (scenarioId: string, runId: string) => void;
  onDownloadItem: (item: UnifiedLibraryItem) => void;
  onCopyExternalUrl: (url: string) => void;
  onOpenExternalUrl: (url: string) => void;
  onTrashAsset: (assetId: string) => void;
  leadingBanner?: ReactNode;
  onEmptyCreate?: () => void;
  onEmptyUpload?: () => void;
};

export function LibraryTimelineView({
  items,
  counts,
  nextOffset,
  category,
  onCategoryChange,
  origin,
  onOriginChange,
  sort,
  onSortChange,
  query,
  onQueryChange,
  viewMode,
  onViewModeChange,
  loading,
  loadingMore,
  loadingMoreError = false,
  error,
  onRetry,
  onLoadMore,
  onResetFilters,
  onOpenTrash,
  onOpenItem,
  onOpenSourceChat,
  onOpenSourceWorkflow,
  onDownloadItem,
  onCopyExternalUrl,
  onOpenExternalUrl,
  onTrashAsset,
  leadingBanner,
  onEmptyCreate,
  onEmptyUpload,
}: LibraryTimelineViewProps) {
  const { t, locale } = useI18n();
  const nowMs = Date.now();
  const hasFilters = Boolean(query.trim() || category !== 'all' || origin !== 'all');

  const visibleCategories = useMemo(
    () =>
      UNIFIED_LIBRARY_CATEGORIES.filter(
        cat => cat === 'all' || counts[cat] > 0 || category === cat,
      ),
    [category, counts],
  );

  const groupedByDay = useMemo(() => {
    if (sort === 'name') {
      return [{ key: 'alpha', heading: '', items }];
    }
    const groups: Array<{ key: string; heading: string; items: UnifiedLibraryItem[] }> = [];
    const byKey = new Map<string, { key: string; heading: string; items: UnifiedLibraryItem[] }>();
    for (const item of items) {
      const key = dayKey(item.updatedAt);
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          heading: formatDayHeading(item.updatedAt, locale, t, nowMs),
          items: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  }, [items, locale, nowMs, sort, t]);

  const subtitleFor = (item: UnifiedLibraryItem) => {
    const originText = item.origin === 'upload' || item.origin === 'mcp'
      ? t(item.originLabel)
      : item.originLabel;
    const moduleText = t(item.moduleLabel);
    if (item.subtitle && item.subtitle.trim() && item.subtitle !== originText) {
      return `${originText} · ${item.subtitle.trim()}`;
    }
    if (originText !== moduleText) {
      return `${originText} · ${moduleText}`;
    }
    return originText;
  };

  return (
    <div className="om-library-shell" data-testid="unified-library-view">
      <div className="om-library-toolbar">
        <div className="om-library-toolbar-left">
          <nav className="om-library-categories" aria-label={t('Library categories')}>
            {visibleCategories.map(cat => {
              const active = category === cat;
              const count = counts[cat];
              return (
                <Button
                  key={cat}
                  variant="plain"
                  type="button"
                  className="om-library-cat-pill"
                  aria-current={active ? 'page' : undefined}
                  data-active={active || undefined}
                  onClick={() => onCategoryChange(cat)}
                >
                  <span>{t(CATEGORY_META[cat].label)}</span>
                  {cat !== 'all' && count > 0 && (
                    <span className="om-library-cat-count">{count}</span>
                  )}
                </Button>
              );
            })}
          </nav>
        </div>

        <div className="om-library-toolbar-right">
          <label className="om-field om-library-search">
            <RemixIcon name="search-line" size={15} />
            <input
              type="search"
              value={query}
              onChange={event => onQueryChange(event.target.value)}
              placeholder={t('Search files and projects…')}
              aria-label={t('Search library')}
              maxLength={200}
            />
          </label>

          <Menu
            modal={false}
            aria-label={t('Source')}
            trigger={
              <Button variant="plain" type="button" className="om-library-filter-btn" aria-label={t('Source')}>
                <span>{t(ORIGIN_META[origin])}</span>
                <RemixIcon name="arrow-down-s-line" size={14} />
              </Button>
            }
          >
            <MenuRadioGroup value={origin} onValueChange={v => onOriginChange(v as UnifiedLibraryOrigin)}>
              {UNIFIED_LIBRARY_ORIGINS.map(opt => (
                <MenuRadioItem key={opt} value={opt} closeOnClick>
                  {t(ORIGIN_META[opt])}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </Menu>

          <Menu
            modal={false}
            aria-label={t('Sort')}
            trigger={
              <Button variant="plain" type="button" className="om-library-filter-btn" aria-label={t('Sort')}>
                <span>{t(SORT_META[sort])}</span>
                <RemixIcon name="arrow-down-s-line" size={14} />
              </Button>
            }
          >
            <MenuRadioGroup value={sort} onValueChange={v => onSortChange(v as UnifiedLibrarySort)}>
              {(['newest', 'oldest', 'name'] as const).map(opt => (
                <MenuRadioItem key={opt} value={opt} closeOnClick>
                  {t(SORT_META[opt])}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </Menu>

          <div className="om-library-view-toggle" role="group" aria-label={t('Layout view')}>
            <Tooltip label={t('List view')}>
              <IconButton
                variant="ghost"
                type="button"
                className="om-library-view-btn"
                data-active={viewMode === 'list' || undefined}
                aria-label={t('List view')}
                aria-pressed={viewMode === 'list'}
                onClick={() => onViewModeChange('list')}
                icon={<RemixIcon name="menu-line" size={16} />}
              />
            </Tooltip>
            <Tooltip label={t('Grid view')}>
              <IconButton
                variant="ghost"
                type="button"
                className="om-library-view-btn"
                data-active={viewMode === 'grid' || undefined}
                aria-label={t('Grid view')}
                aria-pressed={viewMode === 'grid'}
                onClick={() => onViewModeChange('grid')}
                icon={<RemixIcon name="layout-grid-line" size={16} />}
              />
            </Tooltip>
          </div>

          <Tooltip label={t('Trash')}>
            <IconButton
              variant="ghost"
              type="button"
              className="om-library-trash-btn"
              aria-label={t('Trash')}
              onClick={onOpenTrash}
              icon={<RemixIcon name="delete-bin-line" size={16} />}
            />
          </Tooltip>
        </div>
      </div>

      {hasFilters && (
        <div className="om-library-active-bar">
          <Button variant="plain" type="button" className="om-library-clear-btn" onClick={onResetFilters}>
            <RemixIcon name="close-line" size={13} />
            <span>{t('Clear filters')}</span>
          </Button>
        </div>
      )}

      {leadingBanner}

      {error ? (
        <div className="om-library-empty">
          <RemixIcon name="error-warning-line" size={24} />
          <p>{t('Could not load library index.')}</p>
          <Button variant="plain" type="button" className="om-collab-tonal-btn" onClick={onRetry}>
            {t('Retry')}
          </Button>
        </div>
      ) : loading && items.length === 0 ? (
        <div className="om-library-skeletons" aria-busy="true" aria-label={t('Loading library')}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="om-library-skeleton-row">
              <Skeleton style={{ width: '36px', height: '36px', borderRadius: 'var(--motion-radius-md)' }} />
              <div className="om-library-skeleton-copy">
                <Skeleton style={{ width: `${32 + (i % 3) * 14}%`, height: '14px' }} />
                <Skeleton style={{ width: `${46 + (i % 2) * 18}%`, height: '12px' }} />
              </div>
              <Skeleton style={{ width: '56px', height: '12px' }} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="om-library-empty">
          <RemixIcon name="folder-open-line" size={26} />
          <p>
            {hasFilters
              ? t('No matching creations found.')
              : t('Creations from Super Agent, Studios, Workflows, and MCP will appear here.')}
          </p>
          <div className="om-library-empty-actions">
            {hasFilters ? (
              <Button variant="plain" type="button" className="om-collab-tonal-btn" onClick={onResetFilters}>
                {t('Clear filters')}
              </Button>
            ) : (
              <>
                {onEmptyUpload && (
                  <Button variant="plain" type="button" className="om-collab-tonal-btn" onClick={onEmptyUpload}>
                    {t('Upload')}
                  </Button>
                )}
                {onEmptyCreate && (
                  <Button variant="primary" type="button" onClick={onEmptyCreate}>
                    {t('AI Create')}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      ) : viewMode === 'list' ? (
        <div className="om-library-timeline" data-testid="unified-library-list">
          {groupedByDay.map(group => (
            <section key={group.key} className="om-library-day-group">
              {group.heading && (
                <h2 className="om-library-day-heading">
                  <span>{group.heading}</span>
                  <span className="om-library-day-count">({group.items.length})</span>
                </h2>
              )}
              <div className="om-library-day-rows" role="list">
                {group.items.map(item => (
                  <div key={item.id} className="om-library-row" role="listitem" data-kind={item.kind}>
                    <Button
                      variant="plain"
                      type="button"
                      className="om-library-row-main"
                      aria-label={item.title}
                      onClick={() => onOpenItem(item)}
                    >
                      <LibraryRowLeading item={item} />
                      <div className="om-library-row-copy">
                        <div className="om-library-row-title-line">
                          <strong className="om-library-row-title">{item.title}</strong>
                          {item.badgeLabel && (
                            <span className="om-library-row-tag">{t(item.badgeLabel)}</span>
                          )}
                        </div>
                        <span className="om-library-row-meta">{subtitleFor(item)}</span>
                      </div>
                      <time
                        className="om-library-row-time"
                        dateTime={new Date(item.updatedAt).toISOString()}
                      >
                        {formatRowTimestamp(item.updatedAt, locale, sort === 'name')}
                      </time>
                    </Button>
                    <LibraryItemMenu
                      item={item}
                      onOpenItem={onOpenItem}
                      onOpenSourceChat={onOpenSourceChat}
                      onOpenSourceWorkflow={onOpenSourceWorkflow}
                      onDownloadItem={onDownloadItem}
                      onCopyExternalUrl={onCopyExternalUrl}
                      onOpenExternalUrl={onOpenExternalUrl}
                      onTrashAsset={onTrashAsset}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="om-library-grid" data-testid="unified-library-grid">
          {items.map(item => (
            <div key={item.id} className="om-library-card" data-kind={item.kind}>
              <Button
                variant="plain"
                type="button"
                className="om-library-card-main"
                aria-label={item.title}
                onClick={() => onOpenItem(item)}
              >
                <LibraryCardVisual item={item} t={t} />
                <div className="om-library-card-body">
                  <strong className="om-library-card-title">{item.title}</strong>
                  <span className="om-library-card-meta">{subtitleFor(item)}</span>
                </div>
              </Button>
              <div className="om-library-card-footer">
                <time className="om-library-card-time" dateTime={new Date(item.updatedAt).toISOString()}>
                  {formatRowTimestamp(item.updatedAt, locale, true)}
                </time>
                <LibraryItemMenu
                  item={item}
                  onOpenItem={onOpenItem}
                  onOpenSourceChat={onOpenSourceChat}
                  onOpenSourceWorkflow={onOpenSourceWorkflow}
                  onDownloadItem={onDownloadItem}
                  onCopyExternalUrl={onCopyExternalUrl}
                  onOpenExternalUrl={onOpenExternalUrl}
                  onTrashAsset={onTrashAsset}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {nextOffset !== null && items.length > 0 && (
        <div className="om-library-load-more">
          {loadingMoreError && (
            <span className="om-muted" role="status">
              {t('Could not load more items.')}
            </span>
          )}
          <Button
            variant="plain"
            type="button"
            className="om-collab-tonal-btn"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {t(loadingMore ? 'Loading…' : loadingMoreError ? 'Retry' : 'Load more')}
          </Button>
        </div>
      )}
    </div>
  );
}
