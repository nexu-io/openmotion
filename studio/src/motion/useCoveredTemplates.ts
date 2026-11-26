import { useEffect, useRef, useState } from 'react';
import type { GalleryTemplate, TemplatePage } from '../../../shared/catalog';
import { readSwrCache, writeSwrCache } from './swrCache';
import { motionApi } from './useWorkspace';

export type CoveredTemplatesSnapshot = {
  items: GalleryTemplate[];
  catalogVersion?: string;
  catalogReady?: boolean;
  warning?: string;
};

function coveredTemplatesCacheKey(locale: string, covered: boolean): string {
  return `template-catalog:${locale}:${covered ? '1' : '0'}`;
}

export function readCachedCoveredTemplates(locale: string, covered = true): CoveredTemplatesSnapshot | null {
  const cached = readSwrCache<CoveredTemplatesSnapshot>('public', coveredTemplatesCacheKey(locale, covered));
  if (!cached || !Array.isArray(cached.items) || cached.catalogReady === false) return null;
  // Older clients persisted the four fallback cards before Prism had a publication.
  return cached.catalogVersion === 'builtin' && !cached.catalogReady ? null : cached;
}

export function writeCachedCoveredTemplates(locale: string, covered: boolean, snapshot: CoveredTemplatesSnapshot): void {
  writeSwrCache('public', coveredTemplatesCacheKey(locale, covered), snapshot);
}

export class TemplateCatalogNotReady extends Error {
  constructor(readonly page: TemplatePage) { super('Templates could not be loaded.'); }
}

export function isColdTemplatePage(page: TemplatePage & { source?: string }): boolean {
  return page.catalogReady === false || (page.catalogReady === undefined && page.source === 'prism' && page.catalogVersion === 'builtin');
}

export async function loadCoveredTemplates(
  locale: string,
  signal: AbortSignal,
  onFirstPage?: (page: TemplatePage) => void,
  { covered = true, firstPageSize = 60 } = {},
) {
  const items = new Map<string, GalleryTemplate>();
  let offset = 0;
  let version: string | undefined;
  while (true) {
    const query = new URLSearchParams({ category: 'all', limit: String(offset === 0 ? firstPageSize : 60), offset: String(offset), locale });
    if (covered) query.set('covered', 'true');
    const page = await motionApi<TemplatePage>(`/template-catalog?${query}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    });
    signal.throwIfAborted();
    if (!Array.isArray(page.items)) throw new Error('Invalid catalogue');
    if (isColdTemplatePage(page)) throw new TemplateCatalogNotReady({ ...page, catalogReady: false });
    if (offset === 0) version = page.catalogVersion;
    else if (version !== page.catalogVersion) throw new Error('Templates could not be loaded.');
    for (const item of page.items) items.set(item.id, item);
    if (page.next == null) {
      if (typeof page.total === 'number' && items.size !== page.total) throw new Error('Templates could not be loaded.');
      const snapshot: CoveredTemplatesSnapshot = {
        items: [...items.values()],
        catalogVersion: page.catalogVersion,
        catalogReady: true,
        warning: page.warning,
      };
      writeCachedCoveredTemplates(locale, covered, snapshot);
      return snapshot;
    }
    if (offset === 0) onFirstPage?.(page);
    if (!Number.isSafeInteger(page.next) || page.next <= offset) throw new Error('Invalid catalogue cursor');
    offset = page.next;
  }
}

export function useCoveredTemplates(locale: string, enabled = true, { showFirstPage = false, covered = true } = {}) {
  const [loaded, setLoaded] = useState<{ locale: string; covered: boolean; items: GalleryTemplate[]; fromCache?: boolean } | null>(() => {
    const cached = readCachedCoveredTemplates(locale, covered);
    return cached ? { locale, covered, items: cached.items, fromCache: true } : null;
  });
  const cachedNow = loaded?.locale === locale && loaded.covered === covered
    ? null
    : readCachedCoveredTemplates(locale, covered);
  const catalog = loaded?.locale === locale && loaded.covered === covered
    ? loaded.items
    : cachedNow?.items ?? null;
  const freshLoaded = Boolean(loaded?.locale === locale && loaded.covered === covered && !loaded.fromCache);
  const [first, setFirst] = useState<{ locale: string; covered: boolean; page: TemplatePage } | null>(null);
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const recovering = useRef<string | null>(null);
  const hasVisibleCatalog = useRef(Boolean(catalog));
  hasVisibleCatalog.current = Boolean(catalog);
  useEffect(() => {
    if (!enabled || freshLoaded) return;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const key = coveredTemplatesCacheKey(locale, covered);
    async function load() {
      try {
        const result = await loadCoveredTemplates(locale, controller.signal,
          showFirstPage && !hasVisibleCatalog.current ? page => setFirst({ locale, covered, page }) : undefined, { covered });
        if (!controller.signal.aborted) {
          recovering.current = null;
          setLoaded({ locale, covered, items: result.items, fromCache: false });
          setFailed(false);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof TemplateCatalogNotReady) {
          recovering.current = key;
          if (showFirstPage && !hasVisibleCatalog.current) {
            setFirst(previous => error.page.offset > 0 && previous?.locale === locale && previous.covered === covered
              ? { ...previous, page: { ...previous.page, catalogReady: false } } : { locale, covered, page: error.page });
          }
        }
        if (!hasVisibleCatalog.current || recovering.current === key) setFailed(true);
        if (recovering.current === key) retryTimer = setTimeout(load, 5000);
      }
    }
    setFailed(false);
    void load();
    return () => { controller.abort(); clearTimeout(retryTimer); };
  }, [locale, enabled, attempt, freshLoaded, showFirstPage, covered]);
  return { catalog, firstPage: first?.locale === locale && first.covered === covered ? first.page : null, failed, retry: () => setAttempt(value => value + 1) };
}
