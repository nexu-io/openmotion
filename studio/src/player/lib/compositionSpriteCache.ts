import { getCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import { thumbnailRevisionOf } from "../store/thumbnailSlice";
import { fetchRemoteCompositionFilmstrip } from "./remoteCompositionFilmstrip";
import {
  thumbnailScheduler,
  type ThumbnailLoadedResult,
  type ThumbnailValue,
} from "./thumbnailScheduler";
import {
  CAPTURE_TARGET_WIDTH,
  clipIdentityCacheKey,
  MAX_CLIENT_COMPOSITION_FRAMES,
  normalizeCompositionPathForGate,
  registerRevisionInvalidationHook,
  resolveCompositionRevision,
  stripMemoryCacheKey,
  type StripCacheInput,
  type StripCacheMeta,
} from "./compositionRevisionKey";

const IDB_NAME = "openmotion-client-comp-thumbs-v1";
const IDB_STORE = "strips";
/** Persistent IndexedDB strip budget (bytes) across projects, evicted oldest-first (LRU). */
export const IDB_MAX_BYTES = 128 * 1024 * 1024;
const IDB_TOUCH_INTERVAL_MS = 60_000;
/** In-memory decoded pixel budget (32 MiB) + entry ceiling (128) for L0 RAM strip/sprite cache. */
export const MEMORY_STRIP_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MEMORY_STRIP_CACHE_MAX = 128;
const SHARED_COVER_CACHE_MAX = 256;

export interface CachedSpriteData {
  blob: Blob;
  frameCount: number;
  cols: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
}

export interface CachedStripRecord {
  key: string;
  aspect: number;
  width: number;
  height: number;
  /** Legacy per-frame blobs (SnapDOM captures and pre-sprite IDB records). */
  blobs?: Blob[];
  /** Zero-slice packed sprite sheet (remote filmstrip hits). */
  sprite?: CachedSpriteData;
  updatedAt: number;
  /** Total persisted bytes of `sprite.blob` or `blobs`, used for byte-budgeted LRU eviction. */
  bytes?: number;
}

export interface SharedCoverEntry {
  blob?: Blob;
  sprite?: CachedSpriteData;
  aspect: number;
  width: number;
  height: number;
  projectId: string;
  compPath: string;
  compRev: string;
  contentRevision: number;
}

export interface MemoryStripEntry {
  blobs: readonly Blob[];
  sprite?: CachedSpriteData;
  frameCount: number;
  value: ThumbnailValue;
  coverValue: ThumbnailValue;
  urls: string[];
  aspect: number;
  width: number;
  height: number;
  weight: number;
  baseCoverKey: string;
  compPathKey: string;
  clipIdentityKey: string;
  projectId: string;
  compPath: string;
  compRev: string;
  contentRevision: number;
  inCache: boolean;
  refCount: number;
  revoked: boolean;
  /** Retained solely for `peekFallbackCompositionCapture` after being superseded by a newer revision. */
  fallbackOnly: boolean;
}

function isMultiFrameVisualValue(value: ThumbnailValue): boolean {
  return (
    (value.kind === "filmstrip" && value.urls.length > 0) ||
    (value.kind === "sprite" && value.frameCount > 0)
  );
}

// In-memory cover cache keyed by composition identity (ignoring frameCount) so sidebar 1-frame
// cards immediately reuse frames already captured for a timeline strip without booting a 2nd run.
const sharedCoverCache = new Map<string, SharedCoverEntry>();
// In-memory LRU strip cache keyed independent of sessionEpoch so switching projects/compositions
// renders captured filmstrips synchronously in 0ms without re-queuing or re-fetching posters.
const memoryStripCache = new Map<string, MemoryStripEntry>();
let memoryStripCacheBytes = 0;
let memoryStripMaxBytes = MEMORY_STRIP_CACHE_MAX_BYTES;
// Maps any ThumbnailValue handed out from memoryStripCache back to its entry for owner ref-counting.
const entryByValue = new WeakMap<ThumbnailValue, MemoryStripEntry>();
const inFlightIdbReads = new Map<string, Promise<MemoryStripEntry | null>>();
// Live progressive frame values emitted mid-capture so clips display frame 1 immediately
// while remaining filmstrip frames stream in the background.
const progressiveStrips = new Map<string, ThumbnailValue>();
const progressiveListeners = new Map<string, Set<() => void>>();

let idbOpenPromise: Promise<IDBDatabase | null> | null = null;
let idbMaxBytes = IDB_MAX_BYTES;

function removeFromMemoryStripCache(key: string): MemoryStripEntry | undefined {
  const existing = memoryStripCache.get(key);
  if (!existing) return undefined;
  memoryStripCache.delete(key);
  memoryStripCacheBytes = Math.max(0, memoryStripCacheBytes - existing.weight);
  return existing;
}

function insertIntoMemoryStripCache(key: string, entry: MemoryStripEntry): void {
  const prev = removeFromMemoryStripCache(key);
  if (prev && prev !== entry) {
    prev.inCache = false;
    maybeRevokeEntry(prev);
  }
  memoryStripCache.set(key, entry);
  memoryStripCacheBytes += entry.weight;
}

function touchMemoryStripCache(key: string, entry: MemoryStripEntry): void {
  memoryStripCache.delete(key);
  memoryStripCache.set(key, entry);
}

function notifyProgressiveListeners(idbKey: string): void {
  const listeners = progressiveListeners.get(idbKey);
  if (!listeners) return;
  for (const listener of new Set(listeners)) listener();
}

export function setProgressiveEntry(idbKey: string, value: ThumbnailValue): void {
  progressiveStrips.set(idbKey, value);
  notifyProgressiveListeners(idbKey);
}

export function clearProgressiveEntry(idbKey: string): void {
  if (!progressiveStrips.delete(idbKey)) return;
  notifyProgressiveListeners(idbKey);
}

/** Subscribe to mid-capture progressive frame updates for a composition strip. */
export function subscribeProgressiveCompositionCapture(
  input: StripCacheInput,
  listener: () => void,
): () => void {
  const { idbKey } = stripMemoryCacheKey(input);
  let listeners = progressiveListeners.get(idbKey);
  if (!listeners) {
    listeners = new Set();
    progressiveListeners.set(idbKey, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = progressiveListeners.get(idbKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) progressiveListeners.delete(idbKey);
  };
}

/** Read the current progressive mid-capture thumbnail value (referentially stable). */
export function getProgressiveCompositionCapture(
  input: StripCacheInput,
): ThumbnailValue | null {
  const { idbKey } = stripMemoryCacheKey(input);
  return progressiveStrips.get(idbKey) ?? null;
}

export function putSharedCoverCache(
  baseCoverKey: string,
  entry: SharedCoverEntry,
): void {
  if (sharedCoverCache.has(baseCoverKey)) sharedCoverCache.delete(baseCoverKey);
  sharedCoverCache.set(baseCoverKey, entry);
  while (sharedCoverCache.size > SHARED_COVER_CACHE_MAX) {
    const oldestKey = sharedCoverCache.keys().next().value;
    if (!oldestKey) break;
    sharedCoverCache.delete(oldestKey);
  }
}

function maybeRevokeEntry(entry: MemoryStripEntry): void {
  if (entry.revoked || entry.inCache || entry.refCount > 0) return;
  entry.revoked = true;
  for (const url of entry.urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}

export function retainMemoryEntry(entry: MemoryStripEntry): () => void {
  entry.refCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    maybeRevokeEntry(entry);
  };
}

/**
 * Retain ownership of a ThumbnailValue returned by `peekCachedCompositionCapture`
 * so LRU cache eviction does not revoke its object URLs while mounted.
 */
export function retainCachedCompositionCapture(
  value: ThumbnailValue | null | undefined,
): () => void {
  if (!value) return () => {};
  const entry = entryByValue.get(value);
  if (!entry) return () => {};
  return retainMemoryEntry(entry);
}

/** Tests only: override the L0 RAM decoded pixel byte budget for deterministic LRU tests. */
export function setMemoryStripCacheMaxBytesForTest(maxBytes: number | null): void {
  memoryStripMaxBytes =
    maxBytes !== null && Number.isFinite(maxBytes) && maxBytes >= 0
      ? maxBytes
      : MEMORY_STRIP_CACHE_MAX_BYTES;
}

/** Tests only: override the IndexedDB byte budget to exercise LRU capacity eviction deterministically. */
export function setClientCompositionIdbMaxBytesForTest(maxBytes: number | null): void {
  idbMaxBytes =
    maxBytes !== null && Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : IDB_MAX_BYTES;
}

/** Tests only: exercise IndexedDB persistence & byte-budgeted LRU eviction directly. */
export async function writeClientCompositionStripToIdbForTest(
  record: CachedStripRecord,
): Promise<void> {
  await writeCachedStrip(record);
}

/** Tests only: inspect whether a strip record is still persisted in IndexedDB. */
export async function readClientCompositionStripFromIdbForTest(
  key: string,
): Promise<{ key: string; bytes: number; updatedAt: number; blobsCount: number; spriteFrames?: number } | null> {
  const rec = await readCachedStrip(key);
  if (!rec) return null;
  return {
    key: rec.key,
    bytes: computeCachedStripBytes(rec),
    updatedAt: rec.updatedAt,
    blobsCount: rec.sprite ? 1 : (rec.blobs?.length ?? 0),
    ...(rec.sprite ? { spriteFrames: rec.sprite.frameCount } : {}),
  };
}

export function resetCompositionSpriteCacheForTest(): void {
  for (const entry of memoryStripCache.values()) {
    entry.inCache = false;
    if (!entry.revoked) {
      entry.revoked = true;
      for (const url of entry.urls) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
  }
  memoryStripCache.clear();
  memoryStripCacheBytes = 0;
  memoryStripMaxBytes = MEMORY_STRIP_CACHE_MAX_BYTES;
  sharedCoverCache.clear();
  inFlightIdbReads.clear();
  const prevDbPromise = idbOpenPromise;
  idbOpenPromise = null;
  if (prevDbPromise) {
    void prevDbPromise.then((db) => {
      try {
        db?.close();
      } catch {
        // ignore
      }
    });
  }
  progressiveStrips.clear();
  progressiveListeners.clear();
  idbMaxBytes = IDB_MAX_BYTES;
}

function evictStaleMemoryStripEntries(isStale: (entry: MemoryStripEntry) => boolean): void {
  // Preserve at most one freshest fallback entry per clip identity (preferring a multi-frame
  // filmstrip over a 1-frame render) so refreshing timeline clips keep displaying their previous
  // filmstrip until the new revision lands, while immediately evicting older superseded entries.
  const hasFreshFilmstrip = new Set<string>();
  const hasFreshRender = new Set<string>();
  const staleEntries: Array<[string, MemoryStripEntry]> = [];
  for (const pair of memoryStripCache) {
    const entry = pair[1];
    if (entry.revoked) continue;
    if (isStale(entry)) {
      staleEntries.push(pair);
    } else {
      entry.fallbackOnly = false;
      if (isMultiFrameVisualValue(entry.value)) {
        hasFreshFilmstrip.add(entry.clipIdentityKey);
      } else if (entry.value.kind === "image" && entry.value.representative === "render") {
        hasFreshRender.add(entry.clipIdentityKey);
      }
    }
  }
  const preservedFallbackKeys = new Map<string, string>();
  for (let i = staleEntries.length - 1; i >= 0; i--) {
    const [key, entry] = staleEntries[i]!;
    if (hasFreshFilmstrip.has(entry.clipIdentityKey)) continue;
    if (isMultiFrameVisualValue(entry.value)) {
      if (!preservedFallbackKeys.has(entry.clipIdentityKey)) {
        preservedFallbackKeys.set(entry.clipIdentityKey, key);
      }
    }
  }
  for (let i = staleEntries.length - 1; i >= 0; i--) {
    const [key, entry] = staleEntries[i]!;
    if (
      hasFreshFilmstrip.has(entry.clipIdentityKey) ||
      hasFreshRender.has(entry.clipIdentityKey) ||
      preservedFallbackKeys.has(entry.clipIdentityKey)
    ) {
      continue;
    }
    if (entry.value.kind === "image" && entry.value.representative === "render") {
      preservedFallbackKeys.set(entry.clipIdentityKey, key);
    }
  }
  for (const [key, entry] of staleEntries) {
    if (preservedFallbackKeys.get(entry.clipIdentityKey) === key) {
      entry.fallbackOnly = true;
      continue;
    }
    removeFromMemoryStripCache(key);
    entry.inCache = false;
    maybeRevokeEntry(entry);
  }
}

export function evictStaleProjectCacheEntries(
  projectId: string,
  isPathChanged: (compPath: string) => boolean = () => true,
): void {
  evictStaleMemoryStripEntries(
    (entry) =>
      entry.projectId === projectId &&
      entry.compRev !== resolveCompositionRevision(projectId, entry.compPath).rev,
  );
  thumbnailScheduler.invalidateMatching(projectId, (req) => {
    if (req.kind !== "composition" || !req.compositionPath) return false;
    if (req.compositionRevision !== undefined) {
      return req.compositionRevision !== resolveCompositionRevision(projectId, req.compositionPath).rev;
    }
    return isPathChanged(req.compositionPath);
  });
  for (const [key, entry] of sharedCoverCache) {
    if (entry.projectId !== projectId) continue;
    if (entry.compRev === resolveCompositionRevision(projectId, entry.compPath).rev) continue;
    sharedCoverCache.delete(key);
  }
}

registerRevisionInvalidationHook(evictStaleProjectCacheEntries);

export function evictStaleCompositionCacheEntries(
  projectId: string,
  compositions: readonly string[] | null = null,
  currentRevisions?: Readonly<Record<string, number>>,
): (compPath: string, contentRevision: number) => boolean {
  const affected =
    compositions === null
      ? null
      : new Set(compositions.map((path) => normalizeCompositionPathForGate(path)).filter(Boolean));
  const isStale = (compPath: string, contentRevision: number): boolean => {
    if (affected !== null && !affected.has(compPath)) return false;
    // Compositions pinned to a persisted file version are invalidated only by real file-version
    // updates (`setCachedProjectRevision` / `updateCachedCompositionRevisions`), not session counters.
    if (resolveCompositionRevision(projectId, compPath).hasFileVersion) return false;
    if (!currentRevisions) return true;
    return contentRevision < thumbnailRevisionOf(currentRevisions, compPath);
  };
  evictStaleMemoryStripEntries(
    (entry) => entry.projectId === projectId && isStale(entry.compPath, entry.contentRevision),
  );
  thumbnailScheduler.invalidateMatching(projectId, (req) => {
    if (req.kind !== "composition" || !req.compositionPath) return false;
    return isStale(req.compositionPath, req.contentRevision ?? 0);
  });
  for (const [key, entry] of sharedCoverCache) {
    if (entry.projectId !== projectId || !isStale(entry.compPath, entry.contentRevision)) continue;
    sharedCoverCache.delete(key);
  }
  return isStale;
}

// ---------------------------------------------------------------------------
// IndexedDB Persistent Cache (128 MiB byte-budgeted LRU; degrades cleanly in private mode)
// ---------------------------------------------------------------------------

function recordFrameCount(record: Pick<CachedStripRecord, "blobs" | "sprite">): number {
  if (record.sprite && record.sprite.frameCount > 0) return record.sprite.frameCount;
  return Array.isArray(record.blobs) ? record.blobs.length : 0;
}

function isValidCachedStripRecord(record: CachedStripRecord | undefined): record is CachedStripRecord {
  if (!record) return false;
  if (record.sprite && record.sprite.blob && record.sprite.frameCount > 0) return true;
  return Array.isArray(record.blobs) && record.blobs.length > 0;
}

function computeCachedStripBytes(record: Pick<CachedStripRecord, "blobs" | "sprite" | "bytes">): number {
  if (typeof record.bytes === "number" && Number.isFinite(record.bytes) && record.bytes >= 0) {
    return record.bytes;
  }
  if (record.sprite?.blob) {
    const size = record.sprite.blob.size;
    return typeof size === "number" && Number.isFinite(size) ? Math.max(0, size) : 0;
  }
  let total = 0;
  for (const blob of record.blobs ?? []) {
    const size = typeof blob?.size === "number" && Number.isFinite(blob.size) ? blob.size : 0;
    total += Math.max(0, size);
  }
  return total;
}

function openThumbDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!idbOpenPromise) {
    idbOpenPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            const store = db.createObjectStore(IDB_STORE, { keyPath: "key" });
            store.createIndex("updatedAt", "updatedAt");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return idbOpenPromise;
}

function touchCachedStripTimestamp(db: IDBDatabase, record: CachedStripRecord): void {
  const now = Date.now();
  if (now - (record.updatedAt || 0) < IDB_TOUCH_INTERVAL_MS) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({
      ...record,
      bytes: computeCachedStripBytes(record),
      updatedAt: now,
    });
  } catch {
    // Best-effort LRU touch; ignore quota or read-only storage errors.
  }
}

export async function readCachedStrip(key: string): Promise<CachedStripRecord | null> {
  const db = await openThumbDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const rec = req.result as CachedStripRecord | undefined;
        if (isValidCachedStripRecord(rec)) {
          touchCachedStripTimestamp(db, rec);
          resolve(rec);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function writeCachedStrip(record: CachedStripRecord): Promise<void> {
  const bytes = computeCachedStripBytes(record);
  const budget = idbMaxBytes;
  if (bytes > budget) return;
  const db = await openThumbDb();
  if (!db) return;
  const normalizedRecord: CachedStripRecord = { ...record, bytes };
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      store.put(normalizedRecord);
      const oldestFirst: Array<{ key: IDBValidKey; bytes: number }> = [];
      let totalBytes = 0;
      const cursorReq = store.index("updatedAt").openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const existing = cursor.value as CachedStripRecord | undefined;
          const entryBytes = existing ? computeCachedStripBytes(existing) : 0;
          oldestFirst.push({ key: cursor.primaryKey, bytes: entryBytes });
          totalBytes += entryBytes;
          cursor.continue();
          return;
        }
        if (totalBytes <= budget) return;
        for (const item of oldestFirst) {
          if (totalBytes <= budget) break;
          if (item.key === normalizedRecord.key) continue;
          store.delete(item.key);
          totalBytes -= item.bytes;
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function commitMemoryStripEntry(
  idbKey: string,
  meta: StripCacheMeta,
  entry: MemoryStripEntry,
): MemoryStripEntry {
  entryByValue.set(entry.value, entry);
  if (entry.coverValue !== entry.value) entryByValue.set(entry.coverValue, entry);
  // Drop superseded revisions for the same clip once a fresh capture lands so repeated drags
  // do not accumulate stale strips in RAM until the LRU ceiling is hit.
  const currentCompRev = resolveCompositionRevision(meta.projectId, meta.compPath).rev;
  const isCurrentRev = meta.compRev === currentCompRev;
  const nextIsMultiFrame = isMultiFrameVisualValue(entry.value);
  for (const [oldKey, oldEntry] of memoryStripCache) {
    if (oldEntry.clipIdentityKey !== meta.clipIdentityKey) continue;
    const isSuperseded =
      oldEntry.fallbackOnly ||
      oldEntry.contentRevision < meta.contentRevision ||
      (isCurrentRev && oldEntry.compRev !== meta.compRev);
    if (!isSuperseded) continue;
    // Never replace a multi-frame filmstrip/sprite fallback with a 1-frame cover while a strip refresh is pending.
    if (!nextIsMultiFrame && isMultiFrameVisualValue(oldEntry.value)) continue;
    removeFromMemoryStripCache(oldKey);
    oldEntry.inCache = false;
    maybeRevokeEntry(oldEntry);
  }
  for (const [oldCoverKey, oldCover] of sharedCoverCache) {
    if (oldCover.projectId !== meta.projectId || oldCover.compPath !== meta.compPath) continue;
    const isSuperseded =
      oldCover.contentRevision < meta.contentRevision ||
      (isCurrentRev && oldCover.compRev !== meta.compRev);
    if (isSuperseded) {
      sharedCoverCache.delete(oldCoverKey);
    }
  }
  thumbnailScheduler.invalidateMatching(meta.projectId, (req) => {
    if (req.kind !== "composition" || req.compositionPath !== meta.compPath) return false;
    if ((req.contentRevision ?? 0) < meta.contentRevision) return true;
    return isCurrentRev && req.compositionRevision !== undefined && req.compositionRevision !== meta.compRev;
  });
  insertIntoMemoryStripCache(idbKey, entry);
  while (
    memoryStripCache.size > MEMORY_STRIP_CACHE_MAX ||
    (memoryStripCache.size > 1 && memoryStripCacheBytes > memoryStripMaxBytes)
  ) {
    const oldestKey = memoryStripCache.keys().next().value;
    if (!oldestKey || oldestKey === idbKey) break;
    const evicted = removeFromMemoryStripCache(oldestKey);
    if (evicted) {
      evicted.inCache = false;
      maybeRevokeEntry(evicted);
    }
  }
  return entry;
}

export function putMemorySpriteCache(
  idbKey: string,
  baseCoverKey: string,
  compPathKey: string,
  meta: StripCacheMeta,
  sprite: CachedSpriteData,
  aspect: number,
): MemoryStripEntry {
  const existing = memoryStripCache.get(idbKey);
  if (existing && !existing.revoked && existing.value.kind === "sprite") {
    existing.fallbackOnly = false;
    touchMemoryStripCache(idbKey, existing);
    return existing;
  }
  if (existing) {
    removeFromMemoryStripCache(idbKey);
    existing.inCache = false;
    maybeRevokeEntry(existing);
  }
  const url = URL.createObjectURL(sprite.blob);
  const weight =
    Math.max(1, sprite.cols * sprite.rows) * sprite.frameWidth * sprite.frameHeight * 4;
  const value: ThumbnailValue = {
    kind: "sprite",
    url,
    aspect,
    frameCount: sprite.frameCount,
    cols: sprite.cols,
    rows: sprite.rows,
    frameWidth: sprite.frameWidth,
    frameHeight: sprite.frameHeight,
  };
  const entry: MemoryStripEntry = {
    blobs: [],
    sprite,
    frameCount: sprite.frameCount,
    value,
    coverValue: value,
    urls: [url],
    aspect,
    width: sprite.frameWidth,
    height: sprite.frameHeight,
    weight,
    baseCoverKey,
    compPathKey,
    clipIdentityKey: meta.clipIdentityKey,
    projectId: meta.projectId,
    compPath: meta.compPath,
    compRev: meta.compRev,
    contentRevision: meta.contentRevision,
    inCache: true,
    refCount: 0,
    revoked: false,
    fallbackOnly: false,
  };
  return commitMemoryStripEntry(idbKey, meta, entry);
}

export function putMemoryStripCache(
  idbKey: string,
  baseCoverKey: string,
  compPathKey: string,
  meta: StripCacheMeta,
  blobs: readonly Blob[],
  aspect: number,
  width: number,
  height: number,
  precreatedUrls?: ReadonlyArray<string | undefined>,
): MemoryStripEntry {
  const existing = memoryStripCache.get(idbKey);
  if (existing) {
    if (precreatedUrls) {
      for (const url of precreatedUrls) {
        if (!url) continue;
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
    existing.fallbackOnly = false;
    touchMemoryStripCache(idbKey, existing);
    return existing;
  }
  const urls = blobs.map((blob, idx) => precreatedUrls?.[idx] ?? URL.createObjectURL(blob));
  const weight = Math.max(1, urls.length) * width * height * 4;
  const value: ThumbnailValue =
    urls.length === 1
      ? { kind: "image", url: urls[0]!, aspect, representative: "render" }
      : { kind: "filmstrip", urls, aspect };
  const coverUrl = urls[Math.min(urls.length - 1, Math.floor(urls.length / 2))]!;
  const coverValue: ThumbnailValue =
    value.kind === "image"
      ? value
      : { kind: "image", url: coverUrl, aspect, representative: "render" };
  const entry: MemoryStripEntry = {
    blobs,
    frameCount: urls.length,
    value,
    coverValue,
    urls,
    aspect,
    width,
    height,
    weight,
    baseCoverKey,
    compPathKey,
    clipIdentityKey: meta.clipIdentityKey,
    projectId: meta.projectId,
    compPath: meta.compPath,
    compRev: meta.compRev,
    contentRevision: meta.contentRevision,
    inCache: true,
    refCount: 0,
    revoked: false,
    fallbackOnly: false,
  };
  return commitMemoryStripEntry(idbKey, meta, entry);
}

export function retainOrRematerialize(idbKey: string, entry: MemoryStripEntry): MemoryStripEntry {
  if (!entry.revoked) return entry;
  const meta: StripCacheMeta = {
    clipIdentityKey: entry.clipIdentityKey,
    projectId: entry.projectId,
    compPath: entry.compPath,
    compRev: entry.compRev,
    contentRevision: entry.contentRevision,
  };
  if (entry.sprite) {
    return putMemorySpriteCache(
      idbKey,
      entry.baseCoverKey,
      entry.compPathKey,
      meta,
      entry.sprite,
      entry.aspect,
    );
  }
  return putMemoryStripCache(
    idbKey,
    entry.baseCoverKey,
    entry.compPathKey,
    meta,
    entry.blobs,
    entry.aspect,
    entry.width,
    entry.height,
  );
}

export function memoryEntryToThumbnailResult(entry: MemoryStripEntry): ThumbnailLoadedResult {
  // Retain the entry on behalf of ThumbnailScheduler so LRU eviction in memoryStripCache
  // only drops cache ownership; object URLs stay valid until ThumbnailScheduler disposes
  // its result and all direct consumers release their leases.
  const release = retainMemoryEntry(entry);
  return {
    value: entry.value,
    weight: entry.weight,
    dispose: release,
  };
}

export function peekMemoryEntry(
  input: StripCacheInput,
): { entry: MemoryStripEntry; value: ThumbnailValue } | null {
  const { idbKey, baseCoverKey, compPathKey, meta } = stripMemoryCacheKey(input);
  if (input.frameCount === 1 && input.preferMultiFrame) {
    let bestKey: string | null = null;
    let bestEntry: MemoryStripEntry | null = null;
    for (const [key, entry] of memoryStripCache) {
      if (entry.fallbackOnly || entry.baseCoverKey !== baseCoverKey) continue;
      if (!bestEntry || entry.frameCount > bestEntry.frameCount) {
        bestKey = key;
        bestEntry = entry;
      }
    }
    if (bestKey && bestEntry) {
      touchMemoryStripCache(bestKey, bestEntry);
      return { entry: bestEntry, value: bestEntry.value };
    }
  }
  const exact = memoryStripCache.get(idbKey);
  if (exact && !exact.fallbackOnly) {
    touchMemoryStripCache(idbKey, exact);
    return { entry: exact, value: exact.value };
  }
  if (!input.selector && input.frameCount > 1 && input.frameCount < MAX_CLIENT_COMPOSITION_FRAMES) {
    const canonicalKey = `${baseCoverKey}&frames=${MAX_CLIENT_COMPOSITION_FRAMES}`;
    const canonical = memoryStripCache.get(canonicalKey);
    if (
      canonical &&
      !canonical.fallbackOnly &&
      isMultiFrameVisualValue(canonical.value) &&
      canonical.frameCount >= input.frameCount
    ) {
      touchMemoryStripCache(canonicalKey, canonical);
      return { entry: canonical, value: canonical.value };
    }
  }
  if (input.frameCount === 1) {
    // Reuse an already-resident multi-frame strip or sprite without creating duplicate
    // object URLs or triggering LRU eviction during React render.
    for (const [key, entry] of memoryStripCache) {
      if (!entry.fallbackOnly && entry.baseCoverKey === baseCoverKey) {
        touchMemoryStripCache(key, entry);
        return { entry, value: input.preferMultiFrame ? entry.value : entry.coverValue };
      }
    }
    const shared = sharedCoverCache.get(baseCoverKey);
    if (shared) {
      if (shared.sprite) {
        const spriteKey = `${baseCoverKey}&frames=${shared.sprite.frameCount}`;
        const entry = putMemorySpriteCache(
          spriteKey,
          baseCoverKey,
          compPathKey,
          meta,
          shared.sprite,
          shared.aspect,
        );
        return { entry, value: entry.value };
      }
      if (shared.blob) {
        const entry = putMemoryStripCache(
          idbKey,
          baseCoverKey,
          compPathKey,
          meta,
          [shared.blob],
          shared.aspect,
          shared.width,
          shared.height,
        );
        return { entry, value: entry.value };
      }
    }
    return null;
  }
  // Any already-cached strip/sprite with at least as many frames for the exact same content version
  // satisfies narrower frame counts without re-running SnapDOM (ThumbnailTiles samples evenly).
  let bestKey: string | null = null;
  let bestEntry: MemoryStripEntry | null = null;
  for (const [key, entry] of memoryStripCache) {
    if (entry.fallbackOnly || entry.baseCoverKey !== baseCoverKey || entry.frameCount < input.frameCount) continue;
    if (!bestEntry || entry.frameCount > bestEntry.frameCount) {
      bestKey = key;
      bestEntry = entry;
    }
  }
  if (bestKey && bestEntry) {
    touchMemoryStripCache(bestKey, bestEntry);
    return { entry: bestEntry, value: bestEntry.value };
  }
  return null;
}

/**
 * Synchronously return a warm in-memory captured strip/cover when available.
 * Independent of `sessionEpoch` so switching projects or sub-compositions renders in 0ms.
 * Callers holding the returned value across renders should retain it via
 * `retainCachedCompositionCapture(value)` so LRU eviction never revokes active URLs.
 */
export function peekCachedCompositionCapture(
  input: StripCacheInput,
): ThumbnailValue | null {
  return peekMemoryEntry(input)?.value ?? null;
}

/**
 * Return the freshest in-memory captured strip/render for the same clip identity
 * regardless of frame count, revision, or selector time window, so a refreshing or
 * remounted timeline clip keeps showing its previous filmstrip until the refresh completes.
 */
export function peekFallbackCompositionCapture(
  input: Pick<StripCacheInput, "projectId" | "previewUrl" | "selector" | "selectorIndex">,
): ThumbnailValue | null {
  const target = clipIdentityCacheKey(input);
  let fallbackRenderImage: ThumbnailValue | null = null;
  const entries = [...memoryStripCache.values()];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.revoked || entry.clipIdentityKey !== target) continue;
    if (isMultiFrameVisualValue(entry.value)) {
      return entry.value;
    }
    if (!fallbackRenderImage && entry.value.kind === "image" && entry.value.representative === "render") {
      fallbackRenderImage = entry.value;
    }
  }
  return fallbackRenderImage;
}

/**
 * Seed a newly split right-half clip with the corresponding slice of its parent's
 * already-cached filmstrip as a `fallbackOnly` entry so the right half mounts with
 * immediate visual frames (zero text/skeleton flash) while its fresh capture runs.
 */
export function seedSplitCompositionCaptureFallback(params: {
  projectId: string;
  previewUrl: string;
  fromSelector?: string;
  fromSelectorIndex?: number;
  toSelector?: string;
  toSelectorIndex?: number;
  splitFraction?: number;
}): boolean {
  if (!params.projectId || !params.previewUrl || !params.fromSelector || !params.toSelector) {
    return false;
  }
  const fromIdentity = clipIdentityCacheKey({
    projectId: params.projectId,
    previewUrl: params.previewUrl,
    selector: params.fromSelector,
    selectorIndex: params.fromSelectorIndex,
  });
  const toIdentity = clipIdentityCacheKey({
    projectId: params.projectId,
    previewUrl: params.previewUrl,
    selector: params.toSelector,
    selectorIndex: params.toSelectorIndex,
  });
  if (fromIdentity === toIdentity) return false;

  let source: MemoryStripEntry | null = null;
  const entries = [...memoryStripCache.values()];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.revoked || entry.clipIdentityKey !== fromIdentity) continue;
    if (!entry.sprite && entry.blobs.length === 0) continue;
    if (isMultiFrameVisualValue(entry.value)) {
      source = entry;
      break;
    }
    if (!source && entry.value.kind === "image" && entry.value.representative === "render") {
      source = entry;
    }
  }
  if (!source) return false;

  const fallbackKey = `split-fallback:${toIdentity}`;
  const prev = removeFromMemoryStripCache(fallbackKey);
  if (prev) {
    prev.inCache = false;
    maybeRevokeEntry(prev);
  }

  if (source.sprite) {
    const url = URL.createObjectURL(source.sprite.blob);
    const value: ThumbnailValue = {
      kind: "sprite",
      url,
      aspect: source.aspect,
      frameCount: source.sprite.frameCount,
      cols: source.sprite.cols,
      rows: source.sprite.rows,
      frameWidth: source.sprite.frameWidth,
      frameHeight: source.sprite.frameHeight,
    };
    const entry: MemoryStripEntry = {
      blobs: [],
      sprite: source.sprite,
      frameCount: source.sprite.frameCount,
      value,
      coverValue: value,
      urls: [url],
      aspect: source.aspect,
      width: source.width,
      height: source.height,
      weight: source.weight,
      baseCoverKey: fallbackKey,
      compPathKey: source.compPathKey,
      clipIdentityKey: toIdentity,
      projectId: source.projectId,
      compPath: source.compPath,
      compRev: "__split_fallback__",
      contentRevision: -1,
      inCache: true,
      refCount: 0,
      revoked: false,
      fallbackOnly: true,
    };
    entryByValue.set(value, entry);
    insertIntoMemoryStripCache(fallbackKey, entry);
    return true;
  }

  const fraction =
    typeof params.splitFraction === "number" && Number.isFinite(params.splitFraction)
      ? Math.max(0, Math.min(0.99, params.splitFraction))
      : 0.5;
  const startIdx =
    source.blobs.length > 1
      ? Math.min(source.blobs.length - 1, Math.floor(fraction * source.blobs.length))
      : 0;
  const slicedBlobs = source.blobs.slice(startIdx);
  if (slicedBlobs.length === 0) return false;

  const urls = slicedBlobs.map((blob) => URL.createObjectURL(blob));
  const value: ThumbnailValue =
    urls.length === 1
      ? { kind: "image", url: urls[0]!, aspect: source.aspect, representative: "render" }
      : { kind: "filmstrip", urls, aspect: source.aspect };
  const coverUrl = urls[Math.min(urls.length - 1, Math.floor(urls.length / 2))]!;
  const coverValue: ThumbnailValue =
    value.kind === "image"
      ? value
      : { kind: "image", url: coverUrl, aspect: source.aspect, representative: "render" };
  const entry: MemoryStripEntry = {
    blobs: slicedBlobs,
    frameCount: urls.length,
    value,
    coverValue,
    urls,
    aspect: source.aspect,
    width: source.width,
    height: source.height,
    weight: Math.max(1, urls.length) * source.width * source.height * 4,
    baseCoverKey: fallbackKey,
    compPathKey: source.compPathKey,
    clipIdentityKey: toIdentity,
    projectId: source.projectId,
    compPath: source.compPath,
    compRev: "__split_fallback__",
    contentRevision: -1,
    inCache: true,
    refCount: 0,
    revoked: false,
    fallbackOnly: true,
  };
  entryByValue.set(value, entry);
  if (coverValue !== value) entryByValue.set(coverValue, entry);
  insertIntoMemoryStripCache(fallbackKey, entry);
  return true;
}

/** Seed an in-memory cached capture strip in unit tests to exercise LRU/ownership semantics. */
export function seedClientCompositionCaptureForTest(
  input: StripCacheInput,
  blobs: readonly Blob[],
  dims: { aspect?: number; width?: number; height?: number } = {},
): ThumbnailValue {
  const { idbKey, baseCoverKey, compPathKey, meta } = stripMemoryCacheKey(input);
  const aspect = dims.aspect ?? 16 / 9;
  const width = dims.width ?? CAPTURE_TARGET_WIDTH;
  const height = dims.height ?? 135;
  const coverBlob = blobs[Math.min(blobs.length - 1, Math.floor(blobs.length / 2))]!;
  putSharedCoverCache(baseCoverKey, {
    blob: coverBlob,
    aspect,
    width,
    height,
    projectId: meta.projectId,
    compPath: meta.compPath,
    compRev: meta.compRev,
    contentRevision: meta.contentRevision,
  });
  return putMemoryStripCache(idbKey, baseCoverKey, compPathKey, meta, blobs, aspect, width, height).value;
}

/** Seed an in-memory zero-slice sprite capture in unit tests. */
export function seedClientCompositionSpriteForTest(
  input: StripCacheInput,
  spriteBlob: Blob,
  dims: { frameCount?: number; cols?: number; rows?: number; width?: number; height?: number; aspect?: number } = {},
): ThumbnailValue {
  const frameCount = Math.max(1, dims.frameCount ?? input.frameCount);
  const { idbKey, baseCoverKey, compPathKey, meta } = stripMemoryCacheKey({ ...input, frameCount });
  const frameWidth = dims.width ?? CAPTURE_TARGET_WIDTH;
  const frameHeight = dims.height ?? 90;
  const aspect = dims.aspect ?? frameWidth / frameHeight;
  const sprite: CachedSpriteData = {
    blob: spriteBlob,
    frameCount,
    cols: dims.cols ?? frameCount,
    rows: dims.rows ?? 1,
    frameWidth,
    frameHeight,
  };
  putSharedCoverCache(baseCoverKey, {
    sprite,
    aspect,
    width: frameWidth,
    height: frameHeight,
    projectId: meta.projectId,
    compPath: meta.compPath,
    compRev: meta.compRev,
    contentRevision: meta.contentRevision,
  });
  return putMemorySpriteCache(idbKey, baseCoverKey, compPathKey, meta, sprite, aspect).value;
}

export async function readCachedStripWithCanonicalFallback(
  idbKey: string,
  baseCoverKey: string,
  frameCount: number,
  preferMultiFrame = false,
): Promise<{ storageKey: string; record: CachedStripRecord } | null> {
  const canonicalKey =
    frameCount < MAX_CLIENT_COMPOSITION_FRAMES
      ? `${baseCoverKey}&frames=${MAX_CLIENT_COMPOSITION_FRAMES}`
      : null;
  if (preferMultiFrame && canonicalKey) {
    const canonical = await readCachedStrip(canonicalKey);
    if (canonical && recordFrameCount(canonical) >= frameCount) {
      return { storageKey: canonicalKey, record: canonical };
    }
  }
  const exact = await readCachedStrip(idbKey);
  if (exact) return { storageKey: idbKey, record: exact };
  if (canonicalKey && !preferMultiFrame) {
    const canonical = await readCachedStrip(canonicalKey);
    if (canonical && (frameCount === 1 || recordFrameCount(canonical) >= frameCount)) {
      return { storageKey: canonicalKey, record: canonical };
    }
  }
  return null;
}

export function hydrateCachedRecordIntoMemory(
  storageKey: string,
  baseCoverKey: string,
  compPathKey: string,
  meta: StripCacheMeta,
  cached: CachedStripRecord,
): MemoryStripEntry | null {
  if (cached.sprite && cached.sprite.blob && cached.sprite.frameCount > 0) {
    putSharedCoverCache(baseCoverKey, {
      sprite: cached.sprite,
      aspect: cached.aspect,
      width: cached.sprite.frameWidth,
      height: cached.sprite.frameHeight,
      projectId: meta.projectId,
      compPath: meta.compPath,
      compRev: meta.compRev,
      contentRevision: meta.contentRevision,
    });
    return putMemorySpriteCache(
      storageKey,
      baseCoverKey,
      compPathKey,
      meta,
      cached.sprite,
      cached.aspect,
    );
  }
  const blobs = cached.blobs;
  if (!Array.isArray(blobs) || blobs.length === 0) return null;
  const coverBlob = blobs[Math.min(blobs.length - 1, Math.floor(blobs.length / 2))]!;
  putSharedCoverCache(baseCoverKey, {
    blob: coverBlob,
    aspect: cached.aspect,
    width: cached.width,
    height: cached.height,
    projectId: meta.projectId,
    compPath: meta.compPath,
    compRev: meta.compRev,
    contentRevision: meta.contentRevision,
  });
  return putMemoryStripCache(
    storageKey,
    baseCoverKey,
    compPathKey,
    meta,
    blobs,
    cached.aspect,
    cached.width,
    cached.height,
  );
}

/**
 * Fast-path IndexedDB + remote shared filmstrip lookup that bypasses `thumbnailScheduler`'s
 * 2-slot composition bucket so warm reloads (~5–15ms) and cold pre-baked/S3 template opens
 * (~20–60ms, 0 SnapDOM, 0 canvas slicing) recover all cached strips in parallel.
 * Returns a retained lease that the caller must release when unmounting or changing keys.
 */
export function acquireCachedCompositionCaptureFromIdb(
  input: StripCacheInput,
): Promise<{ value: ThumbnailValue; release: () => void } | null> {
  const syncHit = peekMemoryEntry(input);
  if (syncHit) {
    return Promise.resolve({
      value: syncHit.value,
      release: retainMemoryEntry(syncHit.entry),
    });
  }
  const { rev: compRev, hasFileVersion } = resolveCompositionRevision(input.projectId, input.previewUrl);
  const remoteContentRevision = hasFileVersion ? 0 : input.contentRevision;
  const { idbKey, baseCoverKey, compPathKey, meta } = stripMemoryCacheKey(input);
  const readKey = input.preferMultiFrame ? `${idbKey}|multi` : idbKey;

  let entryPromise = inFlightIdbReads.get(readKey);
  if (!entryPromise) {
    entryPromise = (async (): Promise<MemoryStripEntry | null> => {
      const found = await readCachedStripWithCanonicalFallback(
        idbKey,
        baseCoverKey,
        input.frameCount,
        Boolean(input.preferMultiFrame),
      );
      if (found) {
        return hydrateCachedRecordIntoMemory(
          found.storageKey,
          baseCoverKey,
          compPathKey,
          meta,
          found.record,
        );
      }

      // Tier 1.5: shared pre-baked / S3 composition filmstrip sprite cache (whole compositions only).
      // Zero-slice: persist and render the packed sprite blob directly via CSS background-position.
      if (!input.selector && getCachedCloudDisklessMode()) {
        const remote = await fetchRemoteCompositionFilmstrip({
          projectId: input.projectId,
          previewUrl: input.previewUrl,
          compRev,
          contentRevision: remoteContentRevision,
        });
        if (remote.status === "hit") {
          const sprite: CachedSpriteData = {
            blob: remote.spriteBlob,
            frameCount: remote.frameCount,
            cols: remote.cols,
            rows: remote.rows,
            frameWidth: remote.width,
            frameHeight: remote.height,
          };
          const remoteKey = `${baseCoverKey}&frames=${remote.frameCount}`;
          putSharedCoverCache(baseCoverKey, {
            sprite,
            aspect: remote.aspect,
            width: remote.width,
            height: remote.height,
            projectId: meta.projectId,
            compPath: meta.compPath,
            compRev: meta.compRev,
            contentRevision: meta.contentRevision,
          });
          const remoteEntry = putMemorySpriteCache(
            remoteKey,
            baseCoverKey,
            compPathKey,
            meta,
            sprite,
            remote.aspect,
          );
          void writeCachedStrip({
            key: remoteKey,
            aspect: remote.aspect,
            width: remote.width,
            height: remote.height,
            sprite,
            updatedAt: Date.now(),
          });
          if (remote.frameCount >= input.frameCount || input.frameCount === 1) {
            return remoteEntry;
          }
        }
      }
      return null;
    })().finally(() => {
      inFlightIdbReads.delete(readKey);
    });
    inFlightIdbReads.set(readKey, entryPromise);
  }
  return entryPromise.then((entry) => {
    if (!entry) return null;
    const storageKey = `${baseCoverKey}&frames=${entry.frameCount}`;
    const live = retainOrRematerialize(storageKey, entry);
    return {
      value: input.frameCount === 1 && !input.preferMultiFrame ? live.coverValue : live.value,
      release: retainMemoryEntry(live),
    };
  });
}
