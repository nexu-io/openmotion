import { useEffect, useRef, useState } from 'react';
import type { GalleryTemplate, TemplatePage } from '../../../shared/catalog';
import { isColdTemplatePage, loadCoveredTemplates, readCachedCoveredTemplates, TemplateCatalogNotReady } from './useCoveredTemplates';
import { motionApi } from './useWorkspace';

export const libraryBatchSize = 16;

type LibraryCatalog = {
  items: GalleryTemplate[];
  complete: boolean;
  loading: boolean;
  error: string;
  total?: number;
  warning?: string;
  catalogVersion?: string;
};

const empty: LibraryCatalog = { items: [], complete: false, loading: true, error: '' };

export function useTemplateLibraryCatalog(locale: string, open: boolean, progressive: boolean) {
  const [catalog, setCatalog] = useState(empty);
  const [catalogLocale, setCatalogLocale] = useState(locale);
  if (locale !== catalogLocale) {
    setCatalogLocale(locale);
    setCatalog(empty);
  }
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    if (!open) { setCatalog(empty); return; }
    const controller = new AbortController();
    const { signal } = controller;
    let complete = readCachedCoveredTemplates(locale);
    let pending = false;
    let needsRetry = false;
    setCatalog(complete ? { ...complete, complete: true, loading: false, error: '' } : empty);

    async function load() {
      if (pending) return;
      pending = true;
      try {
        const result = await loadCoveredTemplates(locale, signal, page => {
          if (progressive && !complete) {
            setCatalog({ ...empty, items: page.items, total: page.total, catalogVersion: page.catalogVersion });
          }
        }, { firstPageSize: progressive ? libraryBatchSize : 60 });
        if (signal.aborted) return;
        complete = result;
        needsRetry = false;
        setCatalog({ ...result, complete: true, loading: false, error: '' });
      } catch (error) {
        if (signal.aborted) return;
        needsRetry = true;
        if (error instanceof TemplateCatalogNotReady) {
          setCatalog(current => ({ ...current, items: complete || error.page.offset > 0 ? current.items : error.page.items, total: undefined,
            loading: false, error: error.message }));
        } else if (!complete) {
          setCatalog(current => ({ ...current, loading: false, error: progressive ? 'Templates could not be loaded.' : (error as Error).message }));
        }
      } finally { pending = false; }
    }

    retry.current = () => { void load(); };
    void load();
    const timer = setInterval(async () => {
      if (pending || document.hidden) return;
      if (needsRetry) { await load(); return; }
      pending = true;
      try {
        const page = await motionApi<TemplatePage>(`/template-catalog?limit=1&locale=${encodeURIComponent(locale)}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        });
        if (signal.aborted) return;
        if (isColdTemplatePage(page) || page.catalogVersion !== complete?.catalogVersion) {
          pending = false;
          await load();
        } else {
          setCatalog(current => current.warning === page.warning ? current : { ...current, warning: page.warning });
        }
      } catch { /* A failed refresh probe leaves the current catalog visible. */ }
      finally { pending = false; }
    }, 5000);
    return () => { controller.abort(); clearInterval(timer); retry.current = () => {}; };
  }, [locale, open, progressive]);
  return { ...catalog, retry: () => retry.current() };
}
