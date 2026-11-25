import type { TimelineElement } from "../store/playerStore";

export interface CachedCompositionTimeline {
  projectId: string;
  compPath: string;
  /** Revision token combining server composition version and local edit counter so edits invalidate automatically. */
  revisionKey: string;
  elements: TimelineElement[];
  duration: number;
}

const MAX_CACHED_COMPOSITION_TIMELINES = 64;
const cache = new Map<string, CachedCompositionTimeline>();

function normalizeCompPath(compPath: string): string {
  const cleaned = compPath.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "");
  return cleaned || "index.html";
}

function cacheKey(projectId: string, compPath: string): string {
  return `${projectId}\0${normalizeCompPath(compPath)}`;
}

/**
 * Remember the last resolved timeline structure for a composition so switching back
 * to an already-visited composition renders its tracks and cached thumbnails immediately
 * while the live preview iframe boots in the background.
 */
export function saveCachedCompositionTimeline(entry: CachedCompositionTimeline): void {
  if (
    !entry.projectId ||
    !entry.revisionKey ||
    entry.elements.length === 0 ||
    !Number.isFinite(entry.duration) ||
    entry.duration <= 0
  ) {
    return;
  }
  const normalizedPath = normalizeCompPath(entry.compPath);
  const key = cacheKey(entry.projectId, normalizedPath);
  cache.delete(key);
  cache.set(key, {
    ...entry,
    compPath: normalizedPath,
    elements: [...entry.elements],
  });
  while (cache.size > MAX_CACHED_COMPOSITION_TIMELINES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

/**
 * Synchronously return a cached timeline snapshot when the composition's revision
 * matches, promoting it in LRU order. Returns `null` on cold misses or after edits.
 */
export function getCachedCompositionTimeline(
  projectId: string,
  compPath: string,
  revisionKey: string,
): CachedCompositionTimeline | null {
  if (!projectId || !revisionKey) return null;
  const key = cacheKey(projectId, compPath);
  const existing = cache.get(key);
  if (!existing) return null;
  if (existing.revisionKey !== revisionKey) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, existing);
  return existing;
}

/** Drop cached timeline snapshots for a project (or a single composition within it). */
export function invalidateCachedCompositionTimelines(projectId: string, compPath?: string): void {
  if (compPath !== undefined) {
    cache.delete(cacheKey(projectId, compPath));
    return;
  }
  const prefix = `${projectId}\0`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Tests only: reset all cached composition timeline snapshots. */
export function clearCachedCompositionTimelinesForTest(): void {
  cache.clear();
}
