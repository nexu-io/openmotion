import { Button } from 'open-design-ui/button';
import { blackFridayTemplates } from '../../../shared/black-friday-collection';
import { groupBrandSeries, rankDiscoverySeries } from './brandStoryData';
import { collectionFacet, formatCategories, isFormatCategory, templateCollectionFacets, templatesInCollection, type TemplateCollection } from './templateCollections';
import { aiTechnologyIndustry, purposeOrder } from './templateDiscoveryTaxonomy';
import { useCoveredTemplates } from './useCoveredTemplates';
import { useEffect, useMemo, useState } from 'react';
import type { GalleryTemplate, TemplatePage } from '../../../shared/catalog';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { TemplateGalleryCard } from './TemplateGalleryCard';
import { motionApi } from './useWorkspace';
import { useWorkspaceChrome } from './WorkspaceChromeContext';

// Each Explore collection owns its loaded pages. New pages append to the existing collection.
interface ExploreTemplateQuery {
  search?: string;
  limit?: number;
  covered?: boolean;
  firstPages?: Map<string, TemplatePage>;
}

export function useExploreTemplates(category: string | undefined, locale: string, { search = '', limit = 8, covered = true, firstPages }: ExploreTemplateQuery = {}) {
  const cacheKey = JSON.stringify([category, locale, search, limit, covered]);
  const cached = firstPages?.get(cacheKey);
  const [pages, setPages] = useState<TemplatePage[]>(() => cached ? [cached] : []);
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(Boolean(category) && !cached);
  const [loadedQuery, setLoadedQuery] = useState(cacheKey);
  if (loadedQuery !== cacheKey) {
    setLoadedQuery(cacheKey);
    setPages(cached ? [cached] : []);
    setOffset(0);
    setError(false);
    setLoading(Boolean(category) && !cached);
  }
  useEffect(() => {
    if (!category) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ category, locale, limit: String(limit), offset: String(offset) });
    if (covered) query.set('covered', 'true');
    if (search) query.set('query', search);
    motionApi<TemplatePage>('/template-catalog?' + query, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    }).then(page => {
      if (!Array.isArray(page.items)) throw new Error('Invalid template page');
      if (controller.signal.aborted) return;
      if (offset === 0) firstPages?.set(cacheKey, page);
      setPages(existing => {
        const previous = offset === 0 ? [] : existing;
        const seen = new Set(previous.flatMap(group => group.items.map(item => item.id)));
        const items = page.items.filter(item => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
        return [...previous, { ...page, items }];
      });
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [category, locale, offset, attempt, search, limit, covered, firstPages, cacheKey]);
  const next = pages.at(-1)?.next;
  function loadMore() {
    if (loading || next == null || next <= offset) return;
    setLoading(true);
    setOffset(next);
  }
  function retry() {
    setLoading(true);
    setError(false);
    setAttempt(value => value + 1);
  }
  return { pages, loading, error, hasMore: next != null && next > offset, retry, loadMore };
}

export type ExploreTemplateFilter = TemplateCollection | 'all';

function exploreCategories(purposes: string[]): (readonly [ExploreTemplateFilter, string])[] {
  return [
    ['all', 'All'], ['top-100-brands', 'TOP 100 brands'],
    ...purposes.map(purpose => [`purpose:${purpose}`, purpose] as const),
    ['ai-technology', aiTechnologyIndustry], ['black-friday', 'Black Friday collection'],
    ...Object.entries(formatCategories).map(([id, label]) => [id as keyof typeof formatCategories, label] as const),
  ];
}

export function useExploreTemplateShelf(filter: ExploreTemplateFilter, locale: string, enabled: boolean, loadFilters: boolean, all: ReturnType<typeof useExploreTemplates>, limit: number) {
  const collection = filter === 'all' ? null : filter;
  const curated = useCoveredTemplates(locale, enabled && loadFilters);
  const filtered = useExploreTemplates(enabled && isFormatCategory(filter) ? filter : undefined, locale, { limit });
  const page = filter === 'all' ? all : filtered;
  const fullCatalog = enabled && loadFilters ? curated.catalog : null;
  const firstPage = all.pages[0];
  const { categories, industries } = useMemo(() => {
    const { purposes, industries } = templateCollectionFacets(fullCatalog ?? firstPage?.items ?? []);
    // Keep the standard shortcuts while only a sample of the catalogue is available.
    return { categories: exploreCategories(fullCatalog ? purposes : [...new Set([...purposeOrder, ...purposes])]), industries };
  }, [fullCatalog, firstPage]);
  const items = useMemo(() => {
    const catalog = curated.catalog ?? [];
    if (collection === 'top-100-brands') return rankDiscoverySeries(groupBrandSeries(catalog)).slice(0, limit).map(brand => brand.items[0]);
    if (collection === 'black-friday') return blackFridayTemplates(catalog, locale).flatMap(stage => stage.items).slice(0, limit);
    if (collectionFacet(collection)) return templatesInCollection(catalog, collection).slice(0, limit);
    return page.pages[0]?.items.slice(0, limit) ?? [];
  }, [collection, curated.catalog, locale, limit, page.pages]);
  const shelf = { items, collection, categories, industries };
  if (!collection || isFormatCategory(collection)) return { ...shelf, loading: page.loading, error: page.error, retry: page.retry };
  // The campaign ships its published references so it can open while the live catalogue is unavailable.
  const requiresCatalog = collection !== 'black-friday';
  return { ...shelf, loading: requiresCatalog && !curated.catalog && !curated.failed, error: requiresCatalog && curated.failed, retry: curated.retry };
}

export function ExploreActionLabel({ label }: { label: 'Use this prompt' | 'Use Skill' }) {
  const { t } = useI18n();
  return <>{t(label)}<RemixIcon name="arrow-right-line" size={15} /></>;
}

export function TemplatePromptAction({ item, onTry }: { item: GalleryTemplate; onTry: (prompt: string) => void }) {
  const prompt = [item.description?.trim(), item.styleDescription?.trim()].filter(Boolean).join('\n\n');
  if (!prompt) return null;
  return <Button variant="plain" className="om-nav-item om-feed-prompt-action" onClick={() => onTry(prompt)}>
    <ExploreActionLabel label="Use this prompt" />
  </Button>;
}

export function ExploreTemplateCard({ item, active, retained, onPriority, onTry, onOpen }: {
  item: GalleryTemplate; active: boolean; retained?: boolean; onPriority: (id: string | null) => void; onTry: (prompt: string) => void; onOpen?: () => void;
}) {
  const { t } = useI18n();
  const { openLibrary } = useWorkspaceChrome();
  return <TemplateGalleryCard brandedFallback showCoverDuration={false} template={item} playbackId={'community/' + item.id} active={active} retained={retained} onPriority={onPriority}
    onSelect={(template, trigger) => { onOpen?.(); openLibrary(trigger, template); }}
    footer={<div className="om-feed-template-copy">
      <strong>{item.title}</strong>
      <p className="om-feed-card-description">
        {item.duration != null && <small className="om-feed-duration">{t('{value}s', { value: Number(item.duration.toFixed(1)) })}{item.description ? ' · ' : ''}</small>}
        {item.description}
      </p>
      <TemplatePromptAction item={item} onTry={onTry} />
    </div>} />;
}
