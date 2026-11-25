import { useEffect, useState } from 'react';
import { skillPreviewSnapshot } from './skillCoverMedia';

const MAX_CACHED_PREVIEWS = 12;

interface PreviewCacheEntry {
  readonly promise: Promise<Blob>;
  readonly controller: AbortController;
  subscribers: number;
  settled: boolean;
}

const blobCacheByFetch = new WeakMap<typeof fetch, Map<string, PreviewCacheEntry>>();

function getPreviewBlobCache(fetcher: typeof fetch): Map<string, PreviewCacheEntry> {
  let cache = blobCacheByFetch.get(fetcher);
  if (!cache) {
    cache = new Map();
    blobCacheByFetch.set(fetcher, cache);
  }
  return cache;
}

function acquireSkillPreviewBlob(url: string): { promise: Promise<Blob>; release: () => void } {
  const fetcher = globalThis.fetch;
  const cache = getPreviewBlobCache(fetcher);
  let entry = cache.get(url);
  if (entry) {
    cache.delete(url);
    cache.set(url, entry);
  } else {
    const controller = new AbortController();
    // GitHub Raw serves archived MP4s as octet-stream.
    const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const created: PreviewCacheEntry = {
      controller,
      subscribers: 0,
      settled: false,
      promise: fetcher(url, { signal: requestSignal, credentials: 'omit', redirect: 'error' })
        .then(async response => {
          if (!response.ok) throw new Error('Skill preview unavailable');
          const blob = await response.blob();
          created.settled = true;
          return new Blob([blob], { type: 'video/mp4' });
        })
        .catch(error => {
          created.settled = true;
          if (cache.get(url) === created) cache.delete(url);
          throw error;
        }),
    };

    if (cache.size >= MAX_CACHED_PREVIEWS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(url, created);
    entry = created;
  }

  entry.subscribers++;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.subscribers--;
      if (!entry.settled && entry.subscribers <= 0) {
        if (cache.get(url) === entry) cache.delete(url);
        entry.controller.abort();
      }
    },
  };
}

export function useSkillPreview(url: string | undefined, active: boolean, onFailure?: (failed: boolean) => void) {
  const [source, setSource] = useState<{ original: string; playable: string }>();
  const snapshot = url?.startsWith(skillPreviewSnapshot);
  useEffect(() => {
    if (!active || !url || !snapshot) return;
    let cancelled = false;
    let playable: string | undefined;
    const { promise, release } = acquireSkillPreviewBlob(url);
    void promise.then(blob => {
      if (cancelled) return;
      playable = URL.createObjectURL(blob);
      setSource({ original: url, playable });
    }).catch(() => { if (!cancelled) onFailure?.(true); });
    return () => {
      cancelled = true;
      release();
      if (playable) URL.revokeObjectURL(playable);
      setSource(undefined);
    };
  }, [url, snapshot, active, onFailure]);
  if (!active) return undefined;
  if (!snapshot) return url;
  return source?.original === url ? source?.playable : undefined;
}
