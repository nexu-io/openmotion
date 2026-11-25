import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createEmptyLibraryCounts,
  type UnifiedLibraryCategory,
  type UnifiedLibraryCounts,
  type UnifiedLibraryItem,
  type UnifiedLibraryOrigin,
  type UnifiedLibraryResponse,
  type UnifiedLibrarySort,
} from '../../../shared/library-index';
import { gatewayRequest } from './gatewayClient';

export type UnifiedLibraryViewMode = 'list' | 'grid';

const VIEW_MODE_KEY = 'openmotion.library.view-mode.v1';

function readStoredViewMode(): UnifiedLibraryViewMode {
  if (typeof window === 'undefined') return 'list';
  try {
    return window.localStorage.getItem(VIEW_MODE_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

function writeStoredViewMode(mode: UnifiedLibraryViewMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Non-fatal in private browsing.
  }
}

function isUnifiedLibraryResponse(value: unknown): value is UnifiedLibraryResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UnifiedLibraryResponse>;
  return (
    Array.isArray(candidate.items) &&
    candidate.counts !== null &&
    typeof candidate.counts === 'object' &&
    typeof candidate.total === 'number'
  );
}

export function useUnifiedLibrary({
  active,
  enabled = true,
  revision = 0,
}: {
  active: boolean;
  enabled?: boolean;
  revision?: number;
}) {
  const [category, setCategory] = useState<UnifiedLibraryCategory>('all');
  const [origin, setOrigin] = useState<UnifiedLibraryOrigin>('all');
  const [sort, setSort] = useState<UnifiedLibrarySort>('newest');
  const [query, setQuery] = useState('');
  const [viewMode, setViewModeState] = useState<UnifiedLibraryViewMode>(() => readStoredViewMode());
  const [items, setItems] = useState<UnifiedLibraryItem[]>([]);
  const [counts, setCounts] = useState<UnifiedLibraryCounts>(() => createEmptyLibraryCounts());
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreError, setLoadingMoreError] = useState(false);
  const [error, setError] = useState(false);
  const [supported, setSupported] = useState(true);
  const [retryCount, setRetryCount] = useState(0);

  const requestSeqRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const setViewMode = useCallback((next: UnifiedLibraryViewMode) => {
    setViewModeState(next);
    writeStoredViewMode(next);
  }, []);

  const resetFilters = useCallback(() => {
    setCategory('all');
    setOrigin('all');
    setQuery('');
  }, []);

  const buildPath = useCallback(
    (offsetValue: number) => {
      const params = new URLSearchParams({
        category,
        origin,
        sort,
        offset: String(offsetValue),
        limit: '100',
      });
      if (query.trim()) {
        params.set('query', query.trim());
      }
      return `library/index?${params.toString()}`;
    },
    [category, origin, query, sort],
  );

  useEffect(() => {
    if (!active || !enabled || !supported) return;
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    if (!hasLoadedRef.current) {
      setLoading(true);
    }
    setError(false);
    setLoadingMoreError(false);

    void gatewayRequest<unknown>(buildPath(0))
      .then(data => {
        if (cancelled || seq !== requestSeqRef.current) return;
        if (!isUnifiedLibraryResponse(data)) {
          setSupported(false);
          setLoading(false);
          return;
        }
        hasLoadedRef.current = true;
        setItems(data.items);
        setCounts(data.counts);
        setTotal(data.total);
        setNextOffset(data.nextOffset);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [active, buildPath, enabled, retryCount, revision, supported]);

  const loadMore = useCallback(async () => {
    if (!active || !enabled || nextOffset === null || loadingMore) return;
    const seq = requestSeqRef.current;
    setLoadingMore(true);
    setLoadingMoreError(false);
    try {
      const data = await gatewayRequest<unknown>(buildPath(nextOffset));
      if (seq !== requestSeqRef.current || !isUnifiedLibraryResponse(data)) return;
      setItems(prev => {
        const seen = new Set(prev.map(entry => entry.id));
        return [...prev, ...data.items.filter(entry => !seen.has(entry.id))];
      });
      setCounts(data.counts);
      setTotal(data.total);
      setNextOffset(data.nextOffset);
    } catch {
      if (seq === requestSeqRef.current) setLoadingMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [active, buildPath, enabled, loadingMore, nextOffset]);

  const retry = useCallback(() => {
    setError(false);
    setLoadingMoreError(false);
    setLoadingMoreError(false);
    setRetryCount(v => v + 1);
  }, []);

  return {
    category,
    setCategory,
    origin,
    setOrigin,
    sort,
    setSort,
    query,
    setQuery,
    viewMode,
    setViewMode,
    items,
    counts,
    total,
    nextOffset,
    loading,
    loadingMore,
    loadingMoreError,
    error,
    supported,
    hasLoaded: hasLoadedRef.current,
    resetFilters,
    loadMore,
    retry,
  };
}
