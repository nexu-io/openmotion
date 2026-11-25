import { useEffect, useRef, useState } from 'react';
import type { GalleryTemplate, TemplatePage } from '../../../shared/catalog';
import { readSwrCache, writeSwrCache } from './swrCache';
import { motionApi } from './useWorkspace';

export type CoveredTemplatesSnapshot = {
  items: GalleryTemplate[];
  catalogVersion?: string;
  warning?: string;
};

function coveredTemplatesCacheKey(locale: string, covered: boolean): string {
  return `template-catalog:${locale}:${covered ? '1' : '0'}`;
}

export function readCachedCoveredTemplates(locale: string, covered = true): CoveredTemplatesSnapshot | null {
  const cached = readSwrCache<CoveredTemplatesSnapshot>('public', coveredTemplatesCacheKey(locale, covered));
  return cached && Array.isArray(cached.items) ? cached : null;
}

export function writeCachedCoveredTemplates(locale: string, covered: boolean, snapshot: CoveredTemplatesSnapshot): void {
  writeSwrCache('public', coveredTemplatesCacheKey(locale, covered), snapshot);
}

export async function loadCoveredTemplates(
  locale: string,
  signal: AbortSignal,
  onFirstPage?: (page: TemplatePage) => void,
  { covered = true } = {},
) {
  const items = new Map<string, GalleryTemplate>();
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({ category: 'all', limit: '60', offset: String(offset), locale });
    if (covered) query.set('covered', 'true');
    const page = await motionApi<TemplatePage>(`/template-catalog?${query}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    });
    signal.throwIfAborted();
    if (!Array.isArray(page.items)) throw new Error('Invalid catalogue');
    for (const item of page.items) items.set(item.id, item);
    if (page.next == null) {
      const snapshot: CoveredTemplatesSnapshot = {
        items: [...items.values()],
        catalogVersion: page.catalogVersion,
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
  const hasVisibleCatalog = useRef(Boolean(catalog));
  hasVisibleCatalog.current = Boolean(catalog);
  useEffect(() => {
    if (!enabled || freshLoaded) return;
    const controller = new AbortController();
    setFailed(false);
    void loadCoveredTemplates(
      locale,
      controller.signal,
      showFirstPage && !hasVisibleCatalog.current ? page => setFirst({ locale, covered, page }) : undefined,
      { covered },
    ).then(result => {
      if (!controller.signal.aborted) setLoaded({ locale, covered, items: result.items, fromCache: false });
    }).catch(() => {
      if (!controller.signal.aborted && !hasVisibleCatalog.current) setFailed(true);
    });
    return () => controller.abort();
  }, [locale, enabled, attempt, freshLoaded, showFirstPage, covered]);
  return { catalog, firstPage: first?.locale === locale && first.covered === covered ? first.page : null, failed, retry: () => setAttempt(value => value + 1) };
}
