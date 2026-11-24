import { NON_PREVIEW_FILES } from "../../../../shared/preview-impact";
import { getCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import { usePlayerStore } from "../store/playerStore";
import { thumbnailRevisionOf } from "../store/thumbnailSlice";
import {
  clearRemoteCompositionFilmstripStateForTest,
  fetchRemoteCompositionFilmstrip,
  subsampleFilmstripFrames,
  uploadRemoteCompositionFilmstripIfEligible,
} from "./remoteCompositionFilmstrip";
import {
  acquireSharedPreviewGrant,
  clearSharedPreviewGrantsForTest,
  invalidateSharedPreviewGrant,
  isolatedPreviewOrigin,
} from "./previewLease";
import {
  createThumbnailKey,
  thumbnailScheduler,
  type ThumbnailLoadedResult,
  type ThumbnailPriority,
  type ThumbnailRequest,
  type ThumbnailValue,
} from "./thumbnailScheduler";

export const MAX_CLIENT_COMPOSITION_FRAMES = 8;
/** Cap how many uncached composition clips can block initial editor unlock. */
export const MAX_INITIAL_TIMELINE_PREVIEW_GATE = 4;
/** Maximum extra wait after primary assets settle before releasing to background capture. */
export const TIMELINE_PREVIEW_GATE_TIMEOUT_MS = 4_500;

const CAPTURE_TARGET_WIDTH = 160;
const CAPTURE_MAX_HEIGHT = 480;
const CAPTURE_MAX_SCALE = 2;
const CAPTURE_JPEG_QUALITY = 0.78;
const CAPTURE_BOOT_TIMEOUT_MS = 12_000;
const CAPTURE_MEDIA_TIMEOUT_MS = 2_000;
const CAPTURE_RAF_FALLBACK_MS = 250;
const CAPTURE_FRAME_YIELD_MS = 8;
const CAPTURE_IDLE_TEARDOWN_MS = 1_500;
const MAX_CONCURRENT_ISOLATED_CAPTURES = 3;
const MAX_CONCURRENT_SAME_ORIGIN_CAPTURES = 2;
const MAX_CONCURRENT_EDIT_REFRESH_CAPTURES = 1;
const IDB_NAME = "openmotion-client-comp-thumbs-v1";
const IDB_STORE = "strips";
const IDB_MAX_ENTRIES = 120;
const MEMORY_STRIP_CACHE_MAX = 64;
const SHARED_COVER_CACHE_MAX = 128;

interface CachedStripRecord {
  key: string;
  aspect: number;
  width: number;
  height: number;
  blobs: Blob[];
  updatedAt: number;
}

interface SharedCoverEntry {
  blob: Blob;
  aspect: number;
  width: number;
  height: number;
  projectId: string;
  compPath: string;
  compRev: string;
  contentRevision: number;
}

interface MemoryStripEntry {
  blobs: readonly Blob[];
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

interface CapturePreviewWindow extends Window {
  __player?: {
    seek?: (time: number) => void;
    pause?: () => void;
    getDuration?: () => number;
  };
}

export interface ClientCaptureInput {
  previewUrl: string;
  projectId: string;
  sessionEpoch: number;
  contentRevision: number;
  frameCount: number;
  duration?: number;
  seekTime?: number;
  selector?: string;
  selectorIndex?: number;
  priority?: ThumbnailPriority;
  /** Boosts capture priority above background clips when participating in initial editor unlock. */
  gatePriority?: boolean;
  rich?: boolean;
}

type SnapdomModuleFn = typeof import("@zumer/snapdom").snapdom;

type ProgressiveFrameCallback = (
  index: number,
  total: number,
  blob: Blob,
  dims: { aspect: number; width: number; height: number },
) => void;

let testCapabilityOverride: boolean | null = null;
let snapdomLoader: Promise<SnapdomModuleFn | null> | null = null;
const projectRevisionByProjectId = new Map<string, string>();
const compositionRevisionsByProjectId = new Map<string, Map<string, string>>();
const projectSharedTagByProjectId = new Map<string, string>();
const revisionListenersByProjectId = new Map<string, Set<() => void>>();
let liveSharedDepSeq = 0;

const SHARED_REV_MARKER = "|shared:";
const DEPS_REV_MARKER = "|deps:";

function splitSharedRev(rev: string): { base: string; shared: string } {
  const idx = rev.indexOf(SHARED_REV_MARKER);
  return idx >= 0
    ? { base: rev.slice(0, idx), shared: rev.slice(idx + SHARED_REV_MARKER.length) }
    : { base: rev, shared: "" };
}

function splitSharedTagParts(tag: string): { head: string; assets: string } {
  const idx = tag.indexOf(":");
  return idx >= 0
    ? { head: tag.slice(0, idx), assets: tag.slice(idx + 1) }
    : { head: tag, assets: "" };
}

function joinSharedRev(base: string, shared: string): string {
  return shared ? `${base}${SHARED_REV_MARKER}${shared}` : base;
}

function notifyRevisionListeners(projectId: string): void {
  const listeners = revisionListenersByProjectId.get(projectId);
  if (!listeners) return;
  for (const listener of new Set(listeners)) listener();
}
// In-memory cover cache keyed by composition identity (ignoring frameCount) so sidebar 1-frame
// cards immediately reuse frames already captured for a timeline strip without booting a 2nd run.
const sharedCoverCache = new Map<string, SharedCoverEntry>();
// In-memory LRU strip cache keyed independent of sessionEpoch so switching projects/compositions
// renders captured filmstrips synchronously in 0ms without re-queuing or re-fetching posters.
const memoryStripCache = new Map<string, MemoryStripEntry>();
// Maps any ThumbnailValue handed out from memoryStripCache back to its entry for owner ref-counting.
const entryByValue = new WeakMap<ThumbnailValue, MemoryStripEntry>();
const inFlightIdbReads = new Map<string, Promise<MemoryStripEntry | null>>();
// Live progressive frame values emitted mid-capture so clips display frame 1 immediately
// while remaining filmstrip frames stream in the background.
const progressiveStrips = new Map<string, ThumbnailValue>();
const progressiveListeners = new Map<string, Set<() => void>>();

function notifyProgressiveListeners(idbKey: string): void {
  const listeners = progressiveListeners.get(idbKey);
  if (!listeners) return;
  for (const listener of new Set(listeners)) listener();
}

function setProgressiveEntry(idbKey: string, value: ThumbnailValue): void {
  progressiveStrips.set(idbKey, value);
  notifyProgressiveListeners(idbKey);
}

function clearProgressiveEntry(idbKey: string): void {
  if (!progressiveStrips.delete(idbKey)) return;
  notifyProgressiveListeners(idbKey);
}

function putSharedCoverCache(
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

function retainMemoryEntry(entry: MemoryStripEntry): () => void {
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

/** Reset in-memory capture caches between unit tests. */
export function clearClientCompositionCaptureCacheForTest(): void {
  cancelIdleTeardown();
  for (const slot of captureIframePool) {
    slot.loaded = null;
    try {
      slot.iframe.src = "about:blank";
      slot.iframe.remove();
    } catch {
      // ignore teardown errors
    }
  }
  captureIframePool.length = 0;
  activeCaptureCount = 0;
  activeEditRefreshCount = 0;
  activeDocKeys.clear();
  pendingCaptureJobs.length = 0;
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
  sharedCoverCache.clear();
  projectRevisionByProjectId.clear();
  compositionRevisionsByProjectId.clear();
  projectSharedTagByProjectId.clear();
  revisionListenersByProjectId.clear();
  liveSharedDepSeq = 0;
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
  clearRemoteCompositionFilmstripStateForTest();
  clearSharedPreviewGrantsForTest();
  thumbnailScheduler.setOpeningGateActive(usePlayerStore.getState().editorInputLocked);
}

function normalizeCompositionPathForGate(raw: string): string {
  const withoutOrigin = raw.replace(/^https?:\/\/[^/]+/i, "");
  const previewComp = /\/preview\/comp\/([^?#]+)/.exec(withoutOrigin);
  if (previewComp?.[1]) {
    try {
      return decodeURIComponent(previewComp[1]).replace(/^(\.\/|\/)+/, "");
    } catch {
      return previewComp[1].replace(/^(\.\/|\/)+/, "");
    }
  }
  const previewRoot = /\/preview\/([^?#]+)/.exec(withoutOrigin);
  if (previewRoot?.[1]) {
    try {
      return decodeURIComponent(previewRoot[1]).replace(/^(\.\/|\/)+/, "");
    } catch {
      return previewRoot[1].replace(/^(\.\/|\/)+/, "");
    }
  }
  return withoutOrigin.split(/[?#]/)[0]!.replace(/^(\.\/|\/)+/, "");
}

/**
 * Pick at most `maxCount` unique visible composition paths closest to `currentTime`
 * to participate in the initial unified loading gate. Remaining clips capture
 * progressively in the background so long projects (20–30+ scenes) never stall.
 */
export function selectInitialGateCompositionPaths(
  elements: ReadonlyArray<{
    compositionSrc?: string;
    hidden?: boolean;
    start: number;
    duration: number;
  }>,
  currentTime: number,
  maxCount: number = MAX_INITIAL_TIMELINE_PREVIEW_GATE,
): string[] {
  if (maxCount <= 0) return [];
  const safeTime = Number.isFinite(currentTime) ? currentTime : 0;
  const bestDistance = new Map<string, { dist: number; start: number }>();
  for (const el of elements) {
    if (!el.compositionSrc || el.hidden) continue;
    const normalized = normalizeCompositionPathForGate(el.compositionSrc);
    if (!normalized) continue;
    const end = el.start + Math.max(0, el.duration);
    const dist =
      safeTime >= el.start && safeTime <= end
        ? 0
        : Math.min(Math.abs(safeTime - el.start), Math.abs(safeTime - end));
    const prev = bestDistance.get(normalized);
    if (!prev || dist < prev.dist || (dist === prev.dist && el.start < prev.start)) {
      bestDistance.set(normalized, { dist, start: el.start });
    }
  }
  return Array.from(bestDistance.entries())
    .sort((a, b) => a[1].dist - b[1].dist || a[1].start - b[1].start)
    .slice(0, maxCount)
    .map(([src]) => src);
}

/** Override browser capture eligibility in unit tests. */
export function setClientCompositionCaptureCapabilityForTest(enabled: boolean | null): void {
  testCapabilityOverride = enabled;
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
      if (entry.value.kind === "filmstrip" && entry.value.urls.length > 0) {
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
    if (entry.value.kind === "filmstrip" && entry.value.urls.length > 0) {
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
    memoryStripCache.delete(key);
    entry.inCache = false;
    maybeRevokeEntry(entry);
  }
}

function evictStaleProjectRevisions(
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
  for (const slot of captureIframePool) {
    if (slot.busy || !slot.loaded || slot.loaded.projectId !== projectId) continue;
    if (slot.loaded.compRev === resolveCompositionRevision(projectId, slot.loaded.compPath).rev) continue;
    slot.loaded = null;
    resetCaptureIframe(slot.iframe);
  }
}

/**
 * Proactively drop cached strip/cover entries and idle capture iframes whose revision
 * was superseded by a persisted file edit, freeing old blobs and object URLs immediately
 * instead of waiting for LRU eviction while keeping at most one fallback strip per clip
 * until the refreshed capture completes.
 */
export function evictStaleCompositionCaptures(
  projectId: string,
  compositions: readonly string[] | null = null,
  currentRevisions?: Readonly<Record<string, number>>,
): void {
  if (!projectId) return;
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
  for (const slot of captureIframePool) {
    if (slot.busy || !slot.loaded || slot.loaded.projectId !== projectId) continue;
    if (!isStale(slot.loaded.compPath, slot.loaded.contentRevision)) continue;
    slot.loaded = null;
    resetCaptureIframe(slot.iframe);
  }
}

export function setCachedProjectRevision(
  projectId: string,
  revision: string | null | undefined,
  compositionRevisions?: Readonly<Record<string, string>> | null,
): void {
  if (!projectId) return;
  let projectRevChanged = false;
  let changed = false;
  if (typeof revision === "string" && revision.trim()) {
    const trimmed = revision.trim();
    if (projectRevisionByProjectId.get(projectId) !== trimmed) {
      projectRevisionByProjectId.set(projectId, trimmed);
      projectRevChanged = true;
      changed = true;
    }
  }
  if (compositionRevisions && typeof compositionRevisions === "object") {
    const normalized = new Map<string, string>();
    let detectedSharedTag = "";
    for (const [rawPath, compRev] of Object.entries(compositionRevisions)) {
      if (typeof compRev !== "string" || !compRev.trim()) continue;
      const key = normalizeCompositionPathForGate(rawPath);
      if (key) {
        const trimmedRev = compRev.trim();
        normalized.set(key, trimmedRev);
        if (!detectedSharedTag) {
          const { shared } = splitSharedRev(trimmedRev);
          if (shared) detectedSharedTag = shared;
        }
      }
    }
    if (detectedSharedTag) {
      projectSharedTagByProjectId.set(projectId, detectedSharedTag);
    } else {
      projectSharedTagByProjectId.delete(projectId);
    }
    const prev = compositionRevisionsByProjectId.get(projectId);
    if (normalized.size > 0) {
      const changedPaths = new Set<string>();
      for (const [k, v] of normalized) {
        if (prev?.get(k) !== v) changedPaths.add(k);
      }
      if (prev) {
        for (const k of prev.keys()) {
          if (!normalized.has(k)) changedPaths.add(k);
        }
      }
      const same =
        prev !== undefined &&
        prev.size === normalized.size &&
        changedPaths.size === 0;
      if (!same) {
        compositionRevisionsByProjectId.set(projectId, normalized);
        changed = true;
      }
      if (changed) {
        const hadPrev = prev !== undefined;
        evictStaleProjectRevisions(projectId, (compPath) => {
          if (normalized.has(compPath)) return changedPaths.has(compPath);
          return projectRevChanged || (hadPrev && prev.has(compPath));
        });
        notifyRevisionListeners(projectId);
      }
      return;
    }
  }
  if (compositionRevisionsByProjectId.delete(projectId)) {
    changed = true;
  }
  projectSharedTagByProjectId.delete(projectId);
  if (changed) {
    evictStaleProjectRevisions(projectId);
    notifyRevisionListeners(projectId);
  }
}

const HTML_FILE_RE = /\.html?$/i;

/**
 * Update individual HTML composition file versions (and shared CSS/asset/`<head>` render
 * dependencies) in real time from Studio file saves or SSE `file-change` events so:
 * - edited scenes refresh immediately using the exact persisted version returned on reload,
 * - moving/trimming/splitting clips in `index.html <body>` leaves untouched scenes warm,
 * - shared asset/CSS/`<head>` edits invalidate affected scenes immediately without reload.
 */
export function updateCachedCompositionRevisions(
  projectId: string,
  fileVersions: Readonly<Record<string, string | null>> | null | undefined,
  options?: {
    readonly changedPaths?: readonly string[];
    readonly indexHeadHash?: string;
    readonly indexHeadChanged?: boolean;
  },
): void {
  if (!projectId) return;
  let perComp = compositionRevisionsByProjectId.get(projectId);
  const changedPaths = new Set<string>();
  let changed = false;

  const isPreviewSharedNonHtml = (rawPath: string): boolean => {
    const key = normalizeCompositionPathForGate(rawPath);
    if (!key || key === "." || HTML_FILE_RE.test(key)) return false;
    return !NON_PREVIEW_FILES.has(key);
  };

  const projectRev = projectRevisionByProjectId.get(projectId) ?? "";
  const isFailClosedRev = (rev: string | undefined): boolean =>
    Boolean(rev && projectRev && rev === projectRev);

  let nonHtmlSharedChanged = false;
  if (fileVersions) {
    for (const rawPath of Object.keys(fileVersions)) {
      if (isPreviewSharedNonHtml(rawPath)) {
        nonHtmlSharedChanged = true;
        break;
      }
    }
  }
  if (!nonHtmlSharedChanged && options?.changedPaths) {
    for (const rawPath of options.changedPaths) {
      if (isPreviewSharedNonHtml(rawPath)) {
        nonHtmlSharedChanged = true;
        break;
      }
    }
  }

  const prevSharedTag = projectSharedTagByProjectId.get(projectId) ?? "";
  const { head: prevHead, assets: prevAssets } = splitSharedTagParts(prevSharedTag);
  let nextHead = prevHead;
  let nextAssets = prevAssets;
  let sharedTagChanged = false;

  if (options?.indexHeadHash && options.indexHeadHash !== prevHead) {
    nextHead = options.indexHeadHash;
    sharedTagChanged = true;
  } else if (options?.indexHeadChanged) {
    nextHead = `h${++liveSharedDepSeq}`;
    sharedTagChanged = true;
  }

  if (nonHtmlSharedChanged) {
    nextAssets = `a${++liveSharedDepSeq}`;
    sharedTagChanged = true;
  }

  const activeSharedTag = sharedTagChanged ? `${nextHead}:${nextAssets}` : prevSharedTag;
  if (sharedTagChanged) {
    projectSharedTagByProjectId.set(projectId, activeSharedTag);
    if (perComp) {
      for (const [compKey, existingRev] of perComp) {
        if (isFailClosedRev(existingRev)) continue;
        const { base } = splitSharedRev(existingRev);
        const rewritten = joinSharedRev(base, activeSharedTag);
        if (rewritten !== existingRev) {
          perComp.set(compKey, rewritten);
          changedPaths.add(compKey);
          changed = true;
        }
      }
    }
  }

  if (fileVersions) {
    const editedSubComps = new Set<string>();
    for (const [rawPath, rawVersion] of Object.entries(fileVersions)) {
      const key = normalizeCompositionPathForGate(rawPath);
      if (!key) continue;
      const tracked = perComp?.has(key) === true;
      if (!tracked && !HTML_FILE_RE.test(key)) continue;
      if (typeof rawVersion === "string" && rawVersion.trim()) {
        const trimmed = rawVersion.trim();
        if (!perComp) {
          perComp = new Map();
          compositionRevisionsByProjectId.set(projectId, perComp);
        }
        const existingRev = perComp.get(key);
        if (isFailClosedRev(existingRev)) {
          if (key !== "index.html") editedSubComps.add(key);
          continue;
        }
        const existingDepsIdx = existingRev ? splitSharedRev(existingRev).base.indexOf(DEPS_REV_MARKER) : -1;
        const existingDepsSuffix =
          existingRev && existingDepsIdx >= 0 ? splitSharedRev(existingRev).base.slice(existingDepsIdx) : "";
        const nextRev = trimmed.includes(SHARED_REV_MARKER)
          ? trimmed
          : joinSharedRev(`${trimmed}${existingDepsSuffix}`, activeSharedTag);
        if (existingRev !== nextRev) {
          perComp.set(key, nextRev);
          changedPaths.add(key);
          changed = true;
          if (key !== "index.html") editedSubComps.add(key);
        }
      } else if (rawVersion === null && perComp?.delete(key)) {
        changedPaths.add(key);
        changed = true;
        if (key !== "index.html") editedSubComps.add(key);
      }
    }
    // If a sub-composition changed, invalidate any parent composition that embeds nested scenes (`|deps:`).
    if (editedSubComps.size > 0 && perComp) {
      const nestedTag = `d${++liveSharedDepSeq}`;
      for (const [compKey, existingRev] of perComp) {
        if (editedSubComps.has(compKey)) continue;
        const { base, shared } = splitSharedRev(existingRev);
        const depsIdx = base.indexOf(DEPS_REV_MARKER);
        if (depsIdx < 0) continue;
        const rewritten = joinSharedRev(`${base.slice(0, depsIdx)}${DEPS_REV_MARKER}${nestedTag}`, shared);
        if (rewritten !== existingRev) {
          perComp.set(compKey, rewritten);
          changedPaths.add(compKey);
          changed = true;
        }
      }
    }
  }

  if (changed) {
    evictStaleProjectRevisions(projectId, (compPath) => changedPaths.has(compPath));
    notifyRevisionListeners(projectId);
  }
}

export function subscribeCompositionCacheRevision(projectId: string, listener: () => void): () => void {
  if (!projectId) return () => {};
  let listeners = revisionListenersByProjectId.get(projectId);
  if (!listeners) {
    listeners = new Set();
    revisionListenersByProjectId.set(projectId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = revisionListenersByProjectId.get(projectId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) revisionListenersByProjectId.delete(projectId);
  };
}

export function getCompositionCacheRevision(projectId: string, compPathOrUrl: string): string {
  return resolveCompositionRevision(projectId, compPathOrUrl).rev;
}

/**
 * Stable cache-revision token for a composition strip. Uses the persisted per-file
 * version alone when known so session-local `contentRevision` counters neither bust
 * untouched strips nor mismatch IndexedDB entries after a page refresh.
 */
export function getCompositionCacheKeyRevision(
  projectId: string,
  compPathOrUrl: string,
  contentRevision = 0,
): string {
  const { rev, hasFileVersion } = resolveCompositionRevision(projectId, compPathOrUrl);
  return hasFileVersion ? `file:${rev}` : `rev:${rev}|${contentRevision}`;
}

function resolveCompositionRevision(
  projectId: string,
  compPathOrUrl: string,
): { rev: string; hasFileVersion: boolean } {
  const projectRev = projectRevisionByProjectId.get(projectId) ?? "";
  const perComp = compositionRevisionsByProjectId.get(projectId);
  if (perComp) {
    const normalized = normalizeCompositionPathForGate(compPathOrUrl);
    const exact = perComp.get(normalized);
    if (exact) {
      // Fail-closed compositions equal to `projectRevision` must keep tracking live
      // session `contentRevision` bumps so edits invalidate them before reload.
      return { rev: exact, hasFileVersion: !projectRev || exact !== projectRev };
    }
  }
  return { rev: projectRev, hasFileVersion: false };
}

export function canCaptureCompositionInBrowser(): boolean {
  if (testCapabilityOverride !== null) return testCapabilityOverride;
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (typeof HTMLCanvasElement === "undefined" || typeof requestAnimationFrame !== "function") return false;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/HappyDOM|jsdom/i.test(ua)) return false;
  return true;
}

/** Quantize requested timeline tiles into 1 / 2 / 4 / 8 captured frames so zooming reuses caches. */
export function quantizeCompositionFrameCount(
  tileCount: number,
  durationSeconds?: number,
): number {
  if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds <= 0.5) {
    return 1;
  }
  const safe = Math.max(1, Number.isFinite(tileCount) ? Math.ceil(tileCount) : 1);
  if (safe <= 1) return 1;
  if (safe <= 2) return 2;
  if (safe <= 4) return 4;
  return MAX_CLIENT_COMPOSITION_FRAMES;
}

/** Pick evenly distributed timestamps that avoid blank t=0 fade-ins and tail fade-outs. */
export function computeCompositionSampleTimes(
  durationSeconds: number,
  frameCount: number,
  seekTime?: number,
): number[] {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const count = Math.max(1, Math.min(MAX_CLIENT_COMPOSITION_FRAMES, Math.floor(frameCount || 1)));
  if (safeDuration <= 0) {
    return [Math.max(0, Number.isFinite(seekTime) ? seekTime! : 0)];
  }
  if (count === 1) {
    const preferred =
      typeof seekTime === "number" && Number.isFinite(seekTime) && seekTime > 0 && seekTime < safeDuration
        ? seekTime
        : safeDuration <= 3
          ? safeDuration * 0.5
          : Math.min(3, safeDuration * 0.35);
    return [Number(preferred.toFixed(3))];
  }
  if (count === 2) {
    return [
      Number((safeDuration * 0.25).toFixed(3)),
      Number((safeDuration * 0.75).toFixed(3)),
    ];
  }
  const start = safeDuration * 0.04;
  const end = safeDuration * 0.94;
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => Number((start + i * step).toFixed(3)));
}

/** Selector thumbnails sample the clip's visible interval in its own composition. */
export function captureSampleTimes(
  documentDuration: number,
  input: Pick<ClientCaptureInput, "frameCount" | "selector" | "seekTime" | "duration">,
): number[] {
  const { duration, frameCount, seekTime, selector } = input;
  if (!selector || duration === undefined || !Number.isFinite(duration)) {
    return computeCompositionSampleTimes(documentDuration || duration || 0, frameCount, seekTime);
  }
  const start = typeof seekTime === "number" && Number.isFinite(seekTime) ? seekTime : 0;
  const limit = documentDuration > 0 ? documentDuration : Infinity;
  const from = Math.min(limit, Math.max(0, start));
  const to = Math.min(limit, Math.max(from, start + duration));
  if (from === to) return [from];
  return computeCompositionSampleTimes(1, frameCount).map(fraction => from + (to - from) * fraction);
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function nextAnimationFrames(win: Window, count: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let rafId = 0;
    let remaining = Math.max(1, count);
    let settled = false;
    const cleanup = () => {
      clearTimeout(fallbackTimer);
      win.cancelAnimationFrame?.(rafId);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    const fallbackTimer = setTimeout(finish, CAPTURE_RAF_FALLBACK_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    const step = () => {
      if (settled) return;
      if (--remaining <= 0) {
        finish();
        return;
      }
      rafId = win.requestAnimationFrame(step);
    };
    rafId = win.requestAnimationFrame(step);
  });
}

async function waitUntilInteractiveIdle(signal: AbortSignal, gatePriority = false): Promise<void> {
  // Wait for primary composition assets to finish so capture hits the warm HTTP cache
  // without competing with initial preview loads, and yield while playing or hidden.
  // While the opening gate is up (`editorInputLocked`), only gated timeline clips may run
  // so non-gated sidebar cards never spawn SnapDOM iframes or contend for sockets.
  while (!signal.aborted) {
    const state = usePlayerStore.getState();
    const gateAllowed = gatePriority || !state.editorInputLocked;
    const assetsSettled =
      state.assetReadinessPhase === "ready" || state.assetReadinessSkipped || !state.editorInputLocked;
    if (gateAllowed && assetsSettled && !state.isPlaying && (typeof document === "undefined" || !document.hidden)) {
      return;
    }
    await sleepAbortable(60, signal);
  }
  throw abortError();
}

// ---------------------------------------------------------------------------
// IndexedDB Persistent Cache (best-effort; degrades cleanly in private mode)
// ---------------------------------------------------------------------------

let idbOpenPromise: Promise<IDBDatabase | null> | null = null;

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

async function readCachedStrip(key: string): Promise<CachedStripRecord | null> {
  const db = await openThumbDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const rec = req.result as CachedStripRecord | undefined;
        if (rec && Array.isArray(rec.blobs) && rec.blobs.length > 0) resolve(rec);
        else resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeCachedStrip(record: CachedStripRecord): Promise<void> {
  const db = await openThumbDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      store.put(record);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const overflow = (countReq.result || 0) - IDB_MAX_ENTRIES;
        if (overflow <= 0) return;
        let removed = 0;
        const cursorReq = store.index("updatedAt").openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || removed >= overflow) return;
          cursor.delete();
          removed += 1;
          cursor.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Bounded Concurrent Offscreen Capture Iframe Pool (steady-state 0 RAM)
// ---------------------------------------------------------------------------

type CaptureQueuePriority = "overscan" | "visible" | "gate" | "interaction";

const CAPTURE_PRIORITY_RANK: Readonly<Record<CaptureQueuePriority, number>> = {
  overscan: 0,
  visible: 1,
  gate: 2,
  interaction: 3,
};

interface LoadedCaptureState {
  docKey: string;
  projectId: string;
  compPath: string;
  compRev: string;
  contentRevision: number;
  origin: string;
  token: string;
  tokenExpiresAt: number;
  duration: number;
}

interface CaptureIframeSlot {
  iframe: HTMLIFrameElement;
  busy: boolean;
  loaded: LoadedCaptureState | null;
}

interface QueuedCaptureJob {
  priority: CaptureQueuePriority;
  docKey: string;
  isEditRefresh: boolean;
  seq: number;
  signal: AbortSignal;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

const captureIframePool: CaptureIframeSlot[] = [];
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let activeCaptureCount = 0;
let activeEditRefreshCount = 0;
let captureJobSeq = 0;
const activeDocKeys = new Set<string>();
const pendingCaptureJobs: QueuedCaptureJob[] = [];

function maxConcurrentCaptures(): number {
  return isolatedPreviewOrigin()
    ? MAX_CONCURRENT_ISOLATED_CAPTURES
    : MAX_CONCURRENT_SAME_ORIGIN_CAPTURES;
}

function cancelIdleTeardown(): void {
  if (teardownTimer !== null) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
}

function scheduleIdleTeardown(): void {
  cancelIdleTeardown();
  if (activeCaptureCount > 0 || pendingCaptureJobs.length > 0) return;
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    if (activeCaptureCount > 0 || pendingCaptureJobs.length > 0 || captureIframePool.length === 0) return;
    for (const slot of captureIframePool) {
      slot.loaded = null;
      try {
        slot.iframe.src = "about:blank";
        slot.iframe.remove();
      } catch {
        // ignore teardown errors
      }
    }
    captureIframePool.length = 0;
  }, CAPTURE_IDLE_TEARDOWN_MS);
}

function createCaptureIframe(width: number, height: number): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("data-openmotion-thumb-capture", "true");
  iframe.setAttribute("inert", "");
  iframe.tabIndex = -1;
  iframe.referrerPolicy = "no-referrer";
  iframe.allow = "autoplay 'none'";
  iframe.sandbox.add("allow-scripts", "allow-same-origin");
  // Keep hidden capture frames intersecting the viewport (0 opacity, behind the app):
  // positioning a cross-origin preview iframe offscreen (e.g. left: -10000px) causes Chromium
  // to throttle/suspend requestAnimationFrame inside isolated preview captures.
  Object.assign(iframe.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: `${width}px`,
    height: `${height}px`,
    opacity: "0",
    border: "0",
    pointerEvents: "none",
    zIndex: "-1",
  });
  document.body.appendChild(iframe);
  return iframe;
}

function acquireCaptureSlot(width = 1280, height = 720, preferredDocKey?: string): CaptureIframeSlot {
  cancelIdleTeardown();
  let warmMatch: CaptureIframeSlot | null = null;
  let emptySlot: CaptureIframeSlot | null = null;
  let fallbackSlot: CaptureIframeSlot | null = null;
  for (let i = captureIframePool.length - 1; i >= 0; i--) {
    const slot = captureIframePool[i]!;
    if (!slot.iframe.isConnected) {
      if (!slot.busy) {
        slot.loaded = null;
        captureIframePool.splice(i, 1);
      }
      continue;
    }
    if (slot.busy) continue;
    if (preferredDocKey && slot.loaded?.docKey === preferredDocKey) {
      warmMatch = slot;
      break;
    }
    if (!slot.loaded && !emptySlot) {
      emptySlot = slot;
    } else if (!fallbackSlot) {
      fallbackSlot = slot;
    }
  }
  const chosen = warmMatch ?? emptySlot ?? fallbackSlot;
  if (chosen) {
    chosen.busy = true;
    if (!warmMatch) {
      chosen.loaded = null;
      chosen.iframe.style.width = `${width}px`;
      chosen.iframe.style.height = `${height}px`;
    }
    return chosen;
  }
  const slot: CaptureIframeSlot = {
    iframe: createCaptureIframe(width, height),
    busy: true,
    loaded: null,
  };
  captureIframePool.push(slot);
  return slot;
}

function releaseCaptureSlot(slot: CaptureIframeSlot, reset: boolean): void {
  if (reset) {
    slot.loaded = null;
    resetCaptureIframe(slot.iframe);
  }
  slot.busy = false;
}

function resetCaptureIframe(iframe: HTMLIFrameElement): void {
  try {
    iframe.src = "about:blank";
  } catch {
    // ignore reset errors
  }
}

let previewSafeFetchDepth = 0;
let previewSafeFetchOrig: typeof fetch | null = null;
let previewSafeFetchWrapped: typeof fetch | null = null;

/**
 * SnapDOM defaults same-origin image/CSS fetches to `credentials: "include"`.
 * In cloud mode, `/api/projects/:id/preview/*` 302-redirects to cross-origin presigned
 * S3/R2/OSS URLs that do not emit `Access-Control-Allow-Credentials: true`, so `"include"`
 * fails with a CORS error and renders placeholder boxes. Downgrading preview-asset requests
 * to `"same-origin"` keeps cookies on the first hop and drops them across the 302 redirect.
 * Ref-counted so concurrent same-origin captures share one wrapper and only the outermost
 * owner restores `globalThis.fetch`.
 */
export async function withPreviewRedirectSafeFetch<T>(run: () => Promise<T>): Promise<T> {
  if (typeof globalThis.fetch !== "function") return run();
  if (previewSafeFetchDepth === 0) {
    const origFetch = globalThis.fetch;
    const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
      const baseHref = typeof window !== "undefined" ? window.location.href : "";
      const baseOrigin = typeof window !== "undefined" ? window.location.origin : "";
      if (init?.credentials === "include" && baseOrigin) {
        try {
          const rawUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : typeof input?.url === "string"
                  ? input.url
                  : "";
          if (rawUrl) {
            const parsed = new URL(rawUrl, baseHref);
            if (
              parsed.origin === baseOrigin &&
              /^\/api\/projects\/[^/]+\/preview\//.test(parsed.pathname)
            ) {
              return origFetch.call(globalThis, input, { ...init, credentials: "same-origin" });
            }
          }
        } catch {
          // ignore URL parse errors and fall through to original fetch
        }
      }
      return origFetch.call(globalThis, input, init);
    }) as typeof fetch;
    previewSafeFetchOrig = origFetch;
    previewSafeFetchWrapped = wrapped;
    globalThis.fetch = wrapped;
  }
  previewSafeFetchDepth += 1;
  try {
    return await run();
  } finally {
    previewSafeFetchDepth = Math.max(0, previewSafeFetchDepth - 1);
    if (previewSafeFetchDepth === 0) {
      if (previewSafeFetchOrig && globalThis.fetch === previewSafeFetchWrapped) {
        globalThis.fetch = previewSafeFetchOrig;
      }
      previewSafeFetchOrig = null;
      previewSafeFetchWrapped = null;
    }
  }
}

function findIdleWarmDocKeys(): Set<string> {
  const warm = new Set<string>();
  for (const slot of captureIframePool) {
    if (!slot.busy && slot.iframe.isConnected && slot.loaded) {
      warm.add(slot.loaded.docKey);
    }
  }
  return warm;
}

function pumpCaptureQueue(): void {
  const limit = maxConcurrentCaptures();
  while (activeCaptureCount < limit && pendingCaptureJobs.length > 0) {
    const warmDocKeys = findIdleWarmDocKeys();
    let bestIdx = -1;
    for (let i = 0; i < pendingCaptureJobs.length; i++) {
      const cand = pendingCaptureJobs[i]!;
      // Never load the exact same composition document into two hidden iframes at once;
      // sibling clips wait briefly and then reuse the warm loaded iframe without reloading.
      if (activeDocKeys.has(cand.docKey)) continue;
      if (cand.isEditRefresh && activeEditRefreshCount >= MAX_CONCURRENT_EDIT_REFRESH_CAPTURES) continue;
      if (bestIdx < 0) {
        bestIdx = i;
        continue;
      }
      const best = pendingCaptureJobs[bestIdx]!;
      const delta = CAPTURE_PRIORITY_RANK[cand.priority] - CAPTURE_PRIORITY_RANK[best.priority];
      if (delta > 0) {
        bestIdx = i;
      } else if (delta === 0) {
        const candWarm = warmDocKeys.has(cand.docKey) ? 1 : 0;
        const bestWarm = warmDocKeys.has(best.docKey) ? 1 : 0;
        if (candWarm > bestWarm || (candWarm === bestWarm && cand.seq < best.seq)) {
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0) break;
    const [job] = pendingCaptureJobs.splice(bestIdx, 1);
    if (!job) break;
    job.signal.removeEventListener("abort", job.onAbort);
    if (job.signal.aborted) {
      job.reject(abortError());
      continue;
    }
    activeCaptureCount += 1;
    activeDocKeys.add(job.docKey);
    if (job.isEditRefresh) activeEditRefreshCount += 1;
    cancelIdleTeardown();
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeCaptureCount = Math.max(0, activeCaptureCount - 1);
        activeDocKeys.delete(job.docKey);
        if (job.isEditRefresh) {
          activeEditRefreshCount = Math.max(0, activeEditRefreshCount - 1);
        }
        if (pendingCaptureJobs.length > 0) {
          pumpCaptureQueue();
        } else {
          scheduleIdleTeardown();
        }
      });
  }
  if (activeCaptureCount === 0 && pendingCaptureJobs.length === 0) {
    scheduleIdleTeardown();
  }
}

function resolveQueuePriority(input: Pick<ClientCaptureInput, "priority" | "gatePriority">): CaptureQueuePriority {
  if (input.priority === "interaction") return "interaction";
  if (input.gatePriority) return "gate";
  if (input.priority === "overscan") return "overscan";
  return "visible";
}

function enqueueSerializedCapture<T>(
  priority: CaptureQueuePriority,
  docKey: string,
  isEditRefresh: boolean,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const job: QueuedCaptureJob = {
      priority,
      docKey,
      isEditRefresh,
      seq: ++captureJobSeq,
      signal,
      task,
      resolve: (value) => resolve(value as T),
      reject,
      onAbort: () => {
        const idx = pendingCaptureJobs.indexOf(job);
        if (idx >= 0) {
          pendingCaptureJobs.splice(idx, 1);
          reject(abortError());
        }
      },
    };
    signal.addEventListener("abort", job.onAbort, { once: true });
    pendingCaptureJobs.push(job);
    cancelIdleTeardown();
    pumpCaptureQueue();
  });
}

async function loadLocalSnapdom(): Promise<SnapdomModuleFn | null> {
  if (!snapdomLoader) {
    snapdomLoader = import("@zumer/snapdom")
      .then((mod) => (typeof mod.snapdom === "function" ? mod.snapdom : null))
      .catch(() => null);
  }
  return snapdomLoader;
}

function hasVisibleText(node: Node): boolean {
  if (node.nodeType === 3) return Boolean((node.nodeValue ?? "").replace(/\s+/g, "").trim());
  if (node.nodeType !== 1) return false;
  const tag = (node as Element).tagName.toUpperCase();
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "CANVAS") {
    return false;
  }
  if (!node.childNodes || node.childNodes.length === 0) {
    return Boolean((node.textContent ?? "").replace(/\s+/g, "").trim());
  }
  for (const child of Array.from(node.childNodes)) {
    if (hasVisibleText(child)) return true;
  }
  return false;
}

function findPureCanvasTarget(root: Element, stageW: number, stageH: number): HTMLCanvasElement | null {
  if (root instanceof HTMLCanvasElement) return root;
  const canvases = root.querySelectorAll("canvas");
  if (canvases.length !== 1) return null;
  if (hasVisibleText(root)) return null;
  if (root.querySelector("img,svg,video")) return null;
  const canvas = canvases[0]!;
  const rect = canvas.getBoundingClientRect();
  return rect.width >= stageW * 0.9 && rect.height >= stageH * 0.9 ? canvas : null;
}

function isOrContainsDynamicVisual(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === "CANVAS" || tag === "VIDEO") return true;
  return Boolean(el.querySelector("canvas,video"));
}

function canSkipUnchangedFrame(doc: Document, target: Element): boolean {
  if (typeof MutationObserver !== "function" || typeof doc.getAnimations !== "function") return false;
  if (isOrContainsDynamicVisual(target)) return false;
  try {
    return doc.getAnimations().length === 0;
  } catch {
    return false;
  }
}

function releaseCanvasBacking(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // ignore teardown errors
  }
}

function drawToJpegBlob(
  source: CanvasImageSource,
  outW: number,
  outH: number,
  reusable?: HTMLCanvasElement,
): Promise<Blob> {
  const out = reusable ?? document.createElement("canvas");
  if (out.width !== outW) out.width = outW;
  if (out.height !== outH) out.height = outH;
  const ctx = out.getContext("2d");
  if (!ctx) {
    if (!reusable) releaseCanvasBacking(out);
    return Promise.reject(new Error("2D context unavailable"));
  }
  ctx.clearRect(0, 0, outW, outH);
  ctx.drawImage(source, 0, 0, outW, outH);
  return new Promise((resolve, reject) => {
    out.toBlob(
      (blob) => {
        if (!reusable) releaseCanvasBacking(out);
        if (blob && blob.size > 0) resolve(blob);
        else reject(new Error("Failed to encode composition thumbnail frame"));
      },
      "image/jpeg",
      CAPTURE_JPEG_QUALITY,
    );
  });
}

async function waitForDocumentMedia(doc: Document, signal: AbortSignal): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (doc.fonts?.ready) tasks.push(doc.fonts.ready.catch(() => undefined));
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    if (img.complete) continue;
    if (!img.getAttribute("src") && !img.getAttribute("srcset")) continue;
    if (img.loading === "lazy") img.loading = "eager";
    tasks.push(
      new Promise<void>((resolve) => {
        const done = () => {
          img.removeEventListener("load", done);
          img.removeEventListener("error", done);
          resolve();
        };
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      }),
    );
  }
  if (tasks.length === 0) return;
  await Promise.race([
    Promise.all(tasks),
    sleepAbortable(CAPTURE_MEDIA_TIMEOUT_MS, signal),
  ]);
}

function buildCaptureUrl(previewUrl: string, contentRevision: number, fileVersion?: string): URL {
  const url = new URL(previewUrl, window.location.origin);
  url.searchParams.set("capture", "1");
  const revisionToken = fileVersion || (contentRevision > 0 ? String(contentRevision) : "");
  if (revisionToken) url.searchParams.set("revision", revisionToken);
  return url;
}

function buildCaptureDocumentKey(
  input: Pick<ClientCaptureInput, "projectId" | "previewUrl" | "contentRevision">,
  previewOrigin: string | undefined,
): string {
  const { rev: compRev, hasFileVersion } = resolveCompositionRevision(input.projectId, input.previewUrl);
  const revTag = hasFileVersion ? 0 : input.contentRevision;
  if (previewOrigin) {
    const expectedOrigin = new URL(previewOrigin).origin;
    const source = new URL(input.previewUrl, window.location.origin);
    return `iso|${expectedOrigin}|${source.pathname}|${source.search}|rev=${revTag}|compRev=${compRev}`;
  }
  const captureUrl = buildCaptureUrl(input.previewUrl, input.contentRevision, compRev);
  return `same|${captureUrl.href}|compRev=${compRev}`;
}

function computeBoundedCaptureDimensions(
  targetW: number,
  targetH: number,
): { outW: number; outH: number; scale: number; aspect: number } {
  const safeW = Math.max(1, targetW);
  const safeH = Math.max(1, targetH);
  let outW = CAPTURE_TARGET_WIDTH;
  const outH = Math.max(27, Math.min(CAPTURE_MAX_HEIGHT, Math.round((outW * safeH) / safeW)));
  if (outH === CAPTURE_MAX_HEIGHT) {
    outW = Math.max(48, Math.min(CAPTURE_TARGET_WIDTH, Math.round((outH * safeW) / safeH)));
  }
  const scale = Math.min(CAPTURE_MAX_SCALE, outW / safeW);
  return { outW, outH, scale, aspect: safeW / safeH };
}

async function captureSameOrigin(
  input: ClientCaptureInput,
  docKey: string,
  signal: AbortSignal,
  onFrame?: ProgressiveFrameCallback,
): Promise<{ blobs: Blob[]; aspect: number; width: number; height: number }> {
  const snapdom = await loadLocalSnapdom();
  if (!snapdom) throw new Error("SnapDOM unavailable");
  if (signal.aborted) throw abortError();

  const compPath = normalizeCompositionPathForGate(input.previewUrl);
  const { rev: compRev } = resolveCompositionRevision(input.projectId, input.previewUrl);
  const slot = acquireCaptureSlot(1280, 720, docKey);
  const iframe = slot.iframe;
  const captureUrl = buildCaptureUrl(input.previewUrl, input.contentRevision, compRev);
  let resetSlot = false;

  try {
    let win = iframe.contentWindow as CapturePreviewWindow | null;
    let doc = iframe.contentDocument;
    const canReuseWarm =
      slot.loaded !== null &&
      slot.loaded.docKey === docKey &&
      win !== null &&
      doc !== null &&
      typeof win.__player?.seek === "function";

    if (!canReuseWarm) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out loading offscreen composition for thumbnail capture"));
        }, CAPTURE_BOOT_TIMEOUT_MS);
        const onLoad = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("Failed to load offscreen composition"));
        };
        const onAbort = () => {
          cleanup();
          reject(abortError());
        };
        function cleanup() {
          clearTimeout(timeout);
          iframe.removeEventListener("load", onLoad);
          iframe.removeEventListener("error", onError);
          signal.removeEventListener("abort", onAbort);
        }
        iframe.addEventListener("load", onLoad, { once: true });
        iframe.addEventListener("error", onError, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
        iframe.src = captureUrl.href;
      });

      win = iframe.contentWindow as CapturePreviewWindow | null;
      doc = iframe.contentDocument;
      if (!win || !doc) throw new Error("Offscreen capture frame is inaccessible");

      // Wait for HyperFrames player bootstrap inside the offscreen document.
      const deadline = Date.now() + CAPTURE_BOOT_TIMEOUT_MS;
      while (!signal.aborted) {
        const dur = win.__player?.getDuration?.() ?? 0;
        if (win.__player?.seek && Number.isFinite(dur) && dur > 0) break;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for composition player");
        await sleepAbortable(30, signal);
      }
      if (signal.aborted) throw abortError();
    }

    if (!win || !doc) throw new Error("Offscreen capture frame is inaccessible");

    win.__player?.pause?.();
    const root = (doc.querySelector("[data-composition-id]") ?? doc.body) as Element;
    const stageW = Number(root.getAttribute("data-width")) || root.clientWidth || 1280;
    const stageH = Number(root.getAttribute("data-height")) || root.clientHeight || 720;
    if (!canReuseWarm) {
      iframe.style.width = `${stageW}px`;
      iframe.style.height = `${stageH}px`;
      await waitForDocumentMedia(doc, signal);
      if (signal.aborted) throw abortError();
      slot.loaded = {
        docKey,
        projectId: input.projectId,
        compPath,
        compRev,
        contentRevision: input.contentRevision,
        origin: window.location.origin,
        token: "",
        tokenExpiresAt: Number.POSITIVE_INFINITY,
        duration: win.__player?.getDuration?.() || 0,
      };
    }

    let target: Element = root;
    if (input.selector) {
      try {
        const match = doc.querySelectorAll(input.selector)[input.selectorIndex ?? 0];
        if (match) target = match;
      } catch {
        // invalid selector falls back to stage root
      }
    }
    let targetW = stageW;
    let targetH = stageH;
    if (target !== root) {
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        targetW = rect.width;
        targetH = rect.height;
      }
    }

    const { outW, outH, scale, aspect } = computeBoundedCaptureDimensions(targetW, targetH);
    const actualDuration = win.__player?.getDuration?.() || 0;
    const effectiveFrameCount =
      !input.selector && actualDuration > 0 && actualDuration <= 0.5 ? 1 : input.frameCount;
    const times = captureSampleTimes(actualDuration, { ...input, frameCount: effectiveFrameCount });
    const order: number[] = [];
    if (onFrame && times.length >= 3) {
      const coverIdx = Math.floor(times.length / 2);
      order.push(coverIdx);
      for (let i = 0; i < times.length; i++) {
        if (i !== coverIdx) order.push(i);
      }
    } else {
      for (let i = 0; i < times.length; i++) order.push(i);
    }

    const hasAsyncVisual = isOrContainsDynamicVisual(target);
    const settleFrames = hasAsyncVisual ? 2 : 1;
    const outCanvas = document.createElement("canvas");
    let observer: MutationObserver | null = null;
    let observedMutated = false;
    const observeRoot = doc.documentElement ?? (target === root ? root : null);
    if (times.length > 1 && observeRoot && canSkipUnchangedFrame(doc, target)) {
      try {
        observer = new MutationObserver(() => {
          observedMutated = true;
        });
        observer.observe(observeRoot, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        });
      } catch {
        observer = null;
      }
    }

    const blobs: Array<Blob | undefined> = new Array(times.length);
    let lastBlob: Blob | null = null;
    try {
      for (const frameIdx of order) {
        const t = times[frameIdx]!;
        await waitUntilInteractiveIdle(signal, Boolean(input.gatePriority));
        if (observer) {
          observer.takeRecords();
          observedMutated = false;
        }
        win.__player!.seek!(t);
        await nextAnimationFrames(win, settleFrames, signal);

        let blob: Blob;
        if (
          observer &&
          lastBlob &&
          !observedMutated &&
          observer.takeRecords().length === 0 &&
          canSkipUnchangedFrame(doc, target)
        ) {
          blob = lastBlob;
        } else {
          const pureCanvas = findPureCanvasTarget(target, targetW, targetH);
          if (pureCanvas) {
            blob = await drawToJpegBlob(pureCanvas, outW, outH, outCanvas);
          } else {
            const rendered = await withPreviewRedirectSafeFetch(async () => {
              const snap = await snapdom(target, {
                scale,
                dpr: 1,
                fast: true,
                embedFonts: false,
                exclude: "video",
              });
              return snap.toCanvas();
            });
            try {
              blob = await drawToJpegBlob(rendered, outW, outH, outCanvas);
            } finally {
              releaseCanvasBacking(rendered);
            }
          }
        }
        lastBlob = blob;
        blobs[frameIdx] = blob;
        onFrame?.(frameIdx, times.length, blob, { aspect, width: outW, height: outH });
        if (times.length > 1) await sleepAbortable(CAPTURE_FRAME_YIELD_MS, signal);
      }
    } finally {
      observer?.disconnect();
      releaseCanvasBacking(outCanvas);
    }

    return {
      blobs: blobs.filter((b): b is Blob => Boolean(b)),
      aspect,
      width: outW,
      height: outH,
    };
  } catch (error) {
    resetSlot = true;
    throw error;
  } finally {
    releaseCaptureSlot(slot, resetSlot);
  }
}

async function captureIsolatedOrigin(
  input: ClientCaptureInput,
  previewOrigin: string,
  docKey: string,
  signal: AbortSignal,
  onFrame?: ProgressiveFrameCallback,
): Promise<{ blobs: Blob[]; aspect: number; width: number; height: number }> {
  const expectedOrigin = new URL(previewOrigin).origin;
  const grant = await acquireSharedPreviewGrant(input.projectId, expectedOrigin, signal);
  const token = grant.token;

  const compPath = normalizeCompositionPathForGate(input.previewUrl);
  const { rev: compRev } = resolveCompositionRevision(input.projectId, input.previewUrl);
  const source = new URL(input.previewUrl, window.location.origin);
  const isolatedUrl = new URL(source.pathname, expectedOrigin);
  isolatedUrl.search = source.search;
  isolatedUrl.searchParams.set("capture", "1");
  const revisionToken = compRev || (input.contentRevision > 0 ? String(input.contentRevision) : "");
  if (revisionToken) isolatedUrl.searchParams.set("revision", revisionToken);
  isolatedUrl.searchParams.set("pt", token);

  const slot = acquireCaptureSlot(1920, 1080, docKey);
  const iframe = slot.iframe;
  let resetSlot = false;

  try {
    const canReuseWarm =
      slot.loaded !== null &&
      slot.loaded.docKey === docKey &&
      slot.loaded.origin === expectedOrigin &&
      slot.loaded.token === token &&
      slot.loaded.tokenExpiresAt > Date.now() + 5_000 &&
      iframe.contentWindow !== null;

    let duration: number;
    if (canReuseWarm) {
      duration = slot.loaded!.duration;
    } else {
      duration = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          if (grant.expiresAt <= Date.now()) {
            invalidateSharedPreviewGrant(input.projectId, token);
          }
          reject(new Error("Timed out waiting for isolated capture bridge"));
        }, CAPTURE_BOOT_TIMEOUT_MS);
        const onMessage = (event: MessageEvent) => {
          if (event.origin !== expectedOrigin || event.source !== iframe.contentWindow) return;
          const data = event.data;
          if (!data || data.source !== "openmotion-preview-bridge" || data.token !== token) return;
          if (data.type === "preview-build-busy") {
            cleanup();
            reject(new Error("Isolated preview builder is busy"));
            return;
          }
          if (data.type === "timeline-state" && typeof data.duration === "number" && data.duration > 0) {
            if (typeof data.width === "number" && data.width > 0 && typeof data.height === "number" && data.height > 0) {
              iframe.style.width = `${data.width}px`;
              iframe.style.height = `${data.height}px`;
            }
            cleanup();
            resolve(data.duration);
          }
        };
        const onAbort = () => {
          cleanup();
          reject(abortError());
        };
        function cleanup() {
          clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          signal.removeEventListener("abort", onAbort);
        }
        window.addEventListener("message", onMessage);
        signal.addEventListener("abort", onAbort, { once: true });
        iframe.src = isolatedUrl.href;
      });
      slot.loaded = {
        docKey,
        projectId: input.projectId,
        compPath,
        compRev,
        contentRevision: input.contentRevision,
        origin: expectedOrigin,
        token,
        tokenExpiresAt: grant.expiresAt,
        duration,
      };
    }

    const effectiveFrameCount =
      !input.selector && duration > 0 && duration <= 0.5 ? 1 : input.frameCount;
    const times = captureSampleTimes(duration, { ...input, frameCount: effectiveFrameCount });
    const requestId = `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const streamedBlobs: Array<Blob | undefined> = new Array(times.length);
    let streamedCount = 0;

    const payload = await new Promise<{
      frames?: ArrayBuffer[];
      streamed?: boolean;
      frameCount?: number;
      mimeType?: string;
      width?: number;
      height?: number;
      aspect?: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out capturing frames from isolated preview"));
      }, CAPTURE_BOOT_TIMEOUT_MS * 2);
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== expectedOrigin || event.source !== iframe.contentWindow) return;
        const data = event.data;
        if (!data || data.source !== "openmotion-preview-bridge" || data.token !== token) return;
        if (data.type === "capture-frame" && data.requestId === requestId) {
          const idx = typeof data.index === "number" ? data.index : -1;
          if (idx >= 0 && idx < times.length && data.frame instanceof ArrayBuffer) {
            const mime = typeof data.mimeType === "string" && data.mimeType ? data.mimeType : "image/jpeg";
            const blob = new Blob([data.frame], { type: mime });
            if (!streamedBlobs[idx]) streamedCount += 1;
            streamedBlobs[idx] = blob;
            onFrame?.(idx, Number(data.total) || times.length, blob, {
              aspect: typeof data.aspect === "number" && data.aspect > 0 ? data.aspect : 16 / 9,
              width: typeof data.width === "number" && data.width > 0 ? data.width : CAPTURE_TARGET_WIDTH,
              height: typeof data.height === "number" && data.height > 0 ? data.height : 90,
            });
          }
          return;
        }
        if (data.type === "response" && data.requestId === requestId) {
          cleanup();
          if (data.ok && data.result && (Array.isArray(data.result.frames) || data.result.streamed)) {
            resolve(data.result);
          } else {
            reject(new Error(String(data.error || "Isolated capture failed")));
          }
        }
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      function cleanup() {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        signal.removeEventListener("abort", onAbort);
      }
      window.addEventListener("message", onMessage);
      signal.addEventListener("abort", onAbort, { once: true });
      iframe.contentWindow?.postMessage(
        {
          source: "openmotion-studio",
          version: 1,
          type: "capture-frames",
          projectId: input.projectId,
          token,
          requestId,
          times,
          width: CAPTURE_TARGET_WIDTH,
          selector: input.selector,
          selectorIndex: input.selectorIndex,
          progressive: Boolean(onFrame),
        },
        expectedOrigin,
      );
    });

    const mimeType = payload.mimeType || "image/jpeg";
    const blobs =
      streamedCount > 0
        ? streamedBlobs.filter((b): b is Blob => Boolean(b))
        : (payload.frames ?? []).map((buf) => new Blob([buf], { type: mimeType }));
    return {
      blobs,
      aspect: payload.aspect && payload.aspect > 0 ? payload.aspect : 16 / 9,
      width: payload.width || CAPTURE_TARGET_WIDTH,
      height: payload.height || 90,
    };
  } catch (error) {
    resetSlot = true;
    throw error;
  } finally {
    releaseCaptureSlot(slot, resetSlot);
  }
}

type StripCacheInput = Pick<ClientCaptureInput,
  "projectId" | "previewUrl" | "contentRevision" | "frameCount" | "selector" | "selectorIndex" | "seekTime" | "duration">;

export function selectorCaptureWindowKey({ selector, seekTime, duration }: Pick<ClientCaptureInput, "selector" | "seekTime" | "duration">) {
  if (!selector) return undefined;
  return `clip-window-v1:${Number.isFinite(seekTime) ? seekTime : 0}:${Number.isFinite(duration) ? duration : "full"}`;
}

function coverCacheKey(
  input: StripCacheInput,
  projectRev: string,
  hasFileVersion: boolean,
): string {
  return createThumbnailKey({
    project: input.projectId,
    url: input.previewUrl,
    projectRev,
    rev: hasFileVersion ? undefined : input.contentRevision,
    sel: input.selector,
    idx: input.selectorIndex,
    samples: selectorCaptureWindowKey(input),
  });
}

function compPathCacheTag(projectId: string, compPath: string, projectRev: string, contentRevision: number): string {
  return `${projectId}|${normalizeCompositionPathForGate(compPath)}|${projectRev}|${contentRevision}`;
}

function clipIdentityCacheKey(
  input: Pick<StripCacheInput, "projectId" | "previewUrl" | "selector" | "selectorIndex">,
): string {
  return createThumbnailKey({
    project: input.projectId,
    url: input.previewUrl,
    sel: input.selector,
    idx: input.selectorIndex,
  });
}

interface StripCacheMeta {
  clipIdentityKey: string;
  projectId: string;
  compPath: string;
  compRev: string;
  contentRevision: number;
}

function stripMemoryCacheKey(
  input: StripCacheInput,
): {
  idbKey: string;
  baseCoverKey: string;
  compPathKey: string;
  meta: StripCacheMeta;
} {
  const compPath = normalizeCompositionPathForGate(input.previewUrl);
  const { rev: compRev, hasFileVersion } = resolveCompositionRevision(input.projectId, input.previewUrl);
  const effectiveContentRevision = hasFileVersion ? 0 : input.contentRevision;
  const baseCoverKey = coverCacheKey(input, compRev, hasFileVersion);
  return {
    idbKey: `${baseCoverKey}&frames=${input.frameCount}`,
    baseCoverKey,
    compPathKey: compPathCacheTag(
      input.projectId,
      input.previewUrl,
      compRev,
      effectiveContentRevision,
    ),
    meta: {
      clipIdentityKey: clipIdentityCacheKey(input),
      projectId: input.projectId,
      compPath,
      compRev,
      contentRevision: effectiveContentRevision,
    },
  };
}

function putMemoryStripCache(
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
    memoryStripCache.delete(idbKey);
    memoryStripCache.set(idbKey, existing);
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
  entryByValue.set(value, entry);
  if (coverValue !== value) entryByValue.set(coverValue, entry);
  // Drop superseded revisions for the same clip once a fresh capture lands so repeated drags
  // do not accumulate stale strips in RAM until the 64-entry LRU ceiling is hit.
  const currentCompRev = resolveCompositionRevision(meta.projectId, meta.compPath).rev;
  const isCurrentRev = meta.compRev === currentCompRev;
  for (const [oldKey, oldEntry] of memoryStripCache) {
    if (oldEntry.clipIdentityKey !== meta.clipIdentityKey) continue;
    const isSuperseded =
      oldEntry.contentRevision < meta.contentRevision ||
      (isCurrentRev && oldEntry.compRev !== meta.compRev);
    if (!isSuperseded) continue;
    // Never replace a multi-frame filmstrip fallback with a 1-frame cover while a strip refresh is pending.
    if (value.kind !== "filmstrip" && oldEntry.value.kind === "filmstrip") continue;
    memoryStripCache.delete(oldKey);
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
  memoryStripCache.set(idbKey, entry);
  while (memoryStripCache.size > MEMORY_STRIP_CACHE_MAX) {
    const oldestKey = memoryStripCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = memoryStripCache.get(oldestKey);
    memoryStripCache.delete(oldestKey);
    if (evicted) {
      evicted.inCache = false;
      maybeRevokeEntry(evicted);
    }
  }
  return entry;
}

function retainOrRematerialize(idbKey: string, entry: MemoryStripEntry): MemoryStripEntry {
  if (!entry.revoked) return entry;
  return putMemoryStripCache(
    idbKey,
    entry.baseCoverKey,
    entry.compPathKey,
    {
      clipIdentityKey: entry.clipIdentityKey,
      projectId: entry.projectId,
      compPath: entry.compPath,
      compRev: entry.compRev,
      contentRevision: entry.contentRevision,
    },
    entry.blobs,
    entry.aspect,
    entry.width,
    entry.height,
  );
}

function memoryEntryToThumbnailResult(entry: MemoryStripEntry): ThumbnailLoadedResult {
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

function peekMemoryEntry(
  input: StripCacheInput,
): { entry: MemoryStripEntry; value: ThumbnailValue } | null {
  const { idbKey, baseCoverKey, compPathKey, meta } = stripMemoryCacheKey(input);
  const exact = memoryStripCache.get(idbKey);
  if (exact && !exact.fallbackOnly) {
    memoryStripCache.delete(idbKey);
    memoryStripCache.set(idbKey, exact);
    return { entry: exact, value: exact.value };
  }
  if (!input.selector && input.frameCount > 1 && input.frameCount < MAX_CLIENT_COMPOSITION_FRAMES) {
    const canonicalKey = `${baseCoverKey}&frames=${MAX_CLIENT_COMPOSITION_FRAMES}`;
    const canonical = memoryStripCache.get(canonicalKey);
    if (canonical && !canonical.fallbackOnly && canonical.value.kind === "filmstrip" && canonical.urls.length >= input.frameCount) {
      memoryStripCache.delete(canonicalKey);
      memoryStripCache.set(canonicalKey, canonical);
      return { entry: canonical, value: canonical.value };
    }
  }
  if (input.frameCount === 1) {
    // Reuse an already-resident multi-frame strip's middle frame without creating duplicate
    // object URLs or triggering LRU eviction during React render.
    for (const [key, entry] of memoryStripCache) {
      if (!entry.fallbackOnly && entry.baseCoverKey === baseCoverKey) {
        memoryStripCache.delete(key);
        memoryStripCache.set(key, entry);
        return { entry, value: entry.coverValue };
      }
    }
    const shared = sharedCoverCache.get(baseCoverKey);
    if (shared) {
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
    return null;
  }
  // Any already-cached strip with at least as many frames for the exact same content version
  // satisfies narrower frame counts without re-running SnapDOM (ThumbnailTiles samples evenly).
  let bestKey: string | null = null;
  let bestEntry: MemoryStripEntry | null = null;
  for (const [key, entry] of memoryStripCache) {
    if (entry.fallbackOnly || entry.baseCoverKey !== baseCoverKey || entry.urls.length < input.frameCount) continue;
    if (!bestEntry || entry.urls.length > bestEntry.urls.length) {
      bestKey = key;
      bestEntry = entry;
    }
  }
  if (bestKey && bestEntry) {
    memoryStripCache.delete(bestKey);
    memoryStripCache.set(bestKey, bestEntry);
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
    if (entry.value.kind === "filmstrip" && entry.value.urls.length > 0) {
      return entry.value;
    }
    if (!fallbackRenderImage && entry.value.kind === "image" && entry.value.representative === "render") {
      fallbackRenderImage = entry.value;
    }
  }
  return fallbackRenderImage;
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

/** True when any frame count for this composition is already cached in RAM (no blocking gate needed). */
export function hasAnyCachedCompositionCapture(
  projectId: string,
  compPath: string,
  contentRevision = 0,
): boolean {
  const { rev: compRev, hasFileVersion } = resolveCompositionRevision(projectId, compPath);
  const target = compPathCacheTag(projectId, compPath, compRev, hasFileVersion ? 0 : contentRevision);
  for (const entry of memoryStripCache.values()) {
    if (!entry.fallbackOnly && entry.compPathKey === target) return true;
  }
  return false;
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

async function readCachedStripWithCanonicalFallback(
  idbKey: string,
  baseCoverKey: string,
  frameCount: number,
): Promise<{ storageKey: string; record: CachedStripRecord } | null> {
  const exact = await readCachedStrip(idbKey);
  if (exact) return { storageKey: idbKey, record: exact };
  if (frameCount < MAX_CLIENT_COMPOSITION_FRAMES) {
    const canonicalKey = `${baseCoverKey}&frames=${MAX_CLIENT_COMPOSITION_FRAMES}`;
    const canonical = await readCachedStrip(canonicalKey);
    if (canonical && (frameCount === 1 || canonical.blobs.length >= frameCount)) {
      return { storageKey: canonicalKey, record: canonical };
    }
  }
  return null;
}

/**
 * Fast-path IndexedDB + remote shared filmstrip lookup that bypasses `thumbnailScheduler`'s
 * 2-slot composition bucket so warm reloads (~5–15ms) and cold pre-baked/S3 template opens
 * (~20–60ms, 0 SnapDOM) recover all cached strips in parallel.
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
  const canonicalIdbKey =
    !input.selector && input.frameCount < MAX_CLIENT_COMPOSITION_FRAMES
      ? `${baseCoverKey}&frames=${MAX_CLIENT_COMPOSITION_FRAMES}`
      : null;

  const hydrateRecord = (
    targetKey: string,
    blobs: readonly Blob[],
    aspect: number,
    width: number,
    height: number,
  ): MemoryStripEntry => {
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
    return putMemoryStripCache(
      targetKey,
      baseCoverKey,
      compPathKey,
      meta,
      blobs,
      aspect,
      width,
      height,
    );
  };

  let entryPromise = inFlightIdbReads.get(idbKey);
  if (!entryPromise) {
    entryPromise = (async (): Promise<MemoryStripEntry | null> => {
      const found = await readCachedStripWithCanonicalFallback(idbKey, baseCoverKey, input.frameCount);
      if (found) {
        const { storageKey, record: cached } = found;
        return hydrateRecord(
          storageKey,
          cached.blobs,
          cached.aspect,
          cached.width,
          cached.height,
        );
      }

      // Tier 1.5: shared pre-baked / S3 composition filmstrip sprite cache (whole compositions only).
      if (!input.selector && getCachedCloudDisklessMode()) {
        const remote = await fetchRemoteCompositionFilmstrip({
          projectId: input.projectId,
          previewUrl: input.previewUrl,
          compRev,
          contentRevision: remoteContentRevision,
        });
        if (remote.status === "hit") {
          const remoteKey = `${baseCoverKey}&frames=${remote.frameCount}`;
          const remoteEntry = hydrateRecord(
            remoteKey,
            remote.blobs,
            remote.aspect,
            remote.width,
            remote.height,
          );
          void writeCachedStrip({
            key: remoteKey,
            aspect: remote.aspect,
            width: remote.width,
            height: remote.height,
            blobs: remote.blobs,
            updatedAt: Date.now(),
          });
          if (remote.frameCount >= input.frameCount) {
            if (remote.frameCount === input.frameCount || remote.frameCount === MAX_CLIENT_COMPOSITION_FRAMES) {
              return remoteEntry;
            }
            if (input.frameCount === 1) {
              const coverBlob = subsampleFilmstripFrames(remote.blobs, 1)[0]!;
              return hydrateRecord(idbKey, [coverBlob], remote.aspect, remote.width, remote.height);
            }
            const sliced = subsampleFilmstripFrames(remote.blobs, input.frameCount);
            return hydrateRecord(idbKey, sliced, remote.aspect, remote.width, remote.height);
          }
        }
      }
      return null;
    })().finally(() => {
      inFlightIdbReads.delete(idbKey);
    });
    inFlightIdbReads.set(idbKey, entryPromise);
  }
  return entryPromise.then((entry) => {
    if (!entry) return null;
    const storageKey =
      canonicalIdbKey && entry.blobs.length >= MAX_CLIENT_COMPOSITION_FRAMES
        ? canonicalIdbKey
        : idbKey;
    const live = retainOrRematerialize(storageKey, entry);
    return {
      value: input.frameCount === 1 ? live.coverValue : live.value,
      release: retainMemoryEntry(live),
    };
  });
}

async function runClientCompositionCapture(
  input: ClientCaptureInput,
  signal: AbortSignal,
): Promise<ThumbnailLoadedResult> {
  const { idbKey, baseCoverKey, compPathKey, meta } = stripMemoryCacheKey(input);

  // 0 & 1. Fast path: synchronous in-memory strip/cover hit (including downsampling from canonical strips).
  const memHit = peekMemoryEntry(input);
  if (memHit) {
    const release = retainMemoryEntry(memHit.entry);
    const isCover = memHit.value === memHit.entry.coverValue && memHit.value !== memHit.entry.value;
    return {
      value: memHit.value,
      weight: isCover ? memHit.entry.width * memHit.entry.height * 4 : memHit.entry.weight,
      dispose: release,
    };
  }

  // 2. Fast path: persistent IndexedDB hit across page refreshes (reusing canonical strip when present).
  const found = await readCachedStripWithCanonicalFallback(idbKey, baseCoverKey, input.frameCount);
  if (signal.aborted) throw abortError();
  if (found) {
    const { storageKey, record: cached } = found;
    const coverBlob = cached.blobs[Math.min(cached.blobs.length - 1, Math.floor(cached.blobs.length / 2))]!;
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
    const entry = putMemoryStripCache(
      storageKey,
      baseCoverKey,
      compPathKey,
      meta,
      cached.blobs,
      cached.aspect,
      cached.width,
      cached.height,
    );
    if (input.frameCount === 1) {
      const release = retainMemoryEntry(entry);
      return {
        value: entry.coverValue,
        weight: entry.width * entry.height * 4,
        dispose: release,
      };
    }
    return memoryEntryToThumbnailResult(entry);
  }

  // 3. Priority-queued bounded-pool offscreen browser capture (paused during playback).
  const queuePriority = resolveQueuePriority(input);
  const precreatedUrls: Array<string | undefined> = [];
  const receivedBlobs: Array<Blob | undefined> = [];
  let receivedCount = 0;
  let committed = false;

  const fillNearestUrls = (total: number): string[] => {
    const dense: string[] = [];
    for (let i = 0; i < total; i++) {
      let bestUrl = precreatedUrls[i];
      if (!bestUrl) {
        let bestDist = Infinity;
        for (let j = 0; j < precreatedUrls.length; j++) {
          const cand = precreatedUrls[j];
          if (!cand) continue;
          const dist = Math.abs(i - j);
          if (dist < bestDist) {
            bestDist = dist;
            bestUrl = cand;
          }
        }
      }
      if (bestUrl) dense.push(bestUrl);
    }
    return dense;
  };

  const onProgressiveFrame: ProgressiveFrameCallback = (index, total, blob, dims) => {
    if (signal.aborted) return;
    if (!receivedBlobs[index]) receivedCount += 1;
    receivedBlobs[index] = blob;
    const isFirst = receivedCount === 1;
    const isMidpoint = total >= 4 && receivedCount === Math.ceil(total / 2);
    if (!isFirst && !isMidpoint) return;

    if (isFirst) {
      putSharedCoverCache(baseCoverKey, {
        blob,
        aspect: dims.aspect,
        width: dims.width,
        height: dims.height,
        projectId: meta.projectId,
        compPath: meta.compPath,
        compRev: meta.compRev,
        contentRevision: meta.contentRevision,
      });
      const firstUrl = precreatedUrls[index] ?? URL.createObjectURL(blob);
      precreatedUrls[index] = firstUrl;
      setProgressiveEntry(
        idbKey,
        input.frameCount === 1
          ? { kind: "image", url: firstUrl, aspect: dims.aspect, representative: "render" }
          : { kind: "filmstrip", urls: [firstUrl], aspect: dims.aspect },
      );
      return;
    }

    for (let i = 0; i < receivedBlobs.length; i++) {
      if (receivedBlobs[i] && !precreatedUrls[i]) {
        precreatedUrls[i] = URL.createObjectURL(receivedBlobs[i]!);
      }
    }
    const denseUrls = fillNearestUrls(total);
    if (denseUrls.length > 0) {
      setProgressiveEntry(idbKey, { kind: "filmstrip", urls: denseUrls, aspect: dims.aspect });
    }
  };

  const previewOrigin = isolatedPreviewOrigin();
  const docKey = buildCaptureDocumentKey(input, previewOrigin);
  const isEditRefresh = input.contentRevision > 0;

  const gatePriority = Boolean(input.gatePriority);
  try {
    await waitUntilInteractiveIdle(signal, gatePriority);
    if (signal.aborted) throw abortError();
    const result = await enqueueSerializedCapture(queuePriority, docKey, isEditRefresh, signal, async () => {
      await waitUntilInteractiveIdle(signal, gatePriority);
      if (signal.aborted) throw abortError();
      return previewOrigin
        ? captureIsolatedOrigin(input, previewOrigin, docKey, signal, onProgressiveFrame)
        : captureSameOrigin(input, docKey, signal, onProgressiveFrame);
    });

    if (signal.aborted) throw abortError();
    if (result.blobs.length === 0) throw new Error("Client composition capture returned no frames");

    const coverBlob = result.blobs[Math.min(result.blobs.length - 1, Math.floor(result.blobs.length / 2))]!;
    putSharedCoverCache(baseCoverKey, {
      blob: coverBlob,
      aspect: result.aspect,
      width: result.width,
      height: result.height,
      projectId: meta.projectId,
      compPath: meta.compPath,
      compRev: meta.compRev,
      contentRevision: meta.contentRevision,
    });

    void writeCachedStrip({
      key: idbKey,
      aspect: result.aspect,
      width: result.width,
      height: result.height,
      blobs: result.blobs,
      updatedAt: Date.now(),
    });

    if (!input.selector) {
      const { rev: compRev, hasFileVersion } = resolveCompositionRevision(input.projectId, input.previewUrl);
      void uploadRemoteCompositionFilmstripIfEligible({
        projectId: input.projectId,
        previewUrl: input.previewUrl,
        compRev,
        contentRevision: hasFileVersion ? 0 : input.contentRevision,
        blobs: result.blobs,
        width: result.width,
        height: result.height,
        aspect: result.aspect,
        duration: input.duration,
      });
    }

    const entry = putMemoryStripCache(
      idbKey,
      baseCoverKey,
      compPathKey,
      meta,
      result.blobs,
      result.aspect,
      result.width,
      result.height,
      precreatedUrls,
    );
    committed = true;
    clearProgressiveEntry(idbKey);
    return memoryEntryToThumbnailResult(entry);
  } finally {
    clearProgressiveEntry(idbKey);
    if (!committed) {
      for (const url of precreatedUrls) {
        if (!url) continue;
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
  }
}

/** Keep ThumbnailScheduler's opening-gate hold synced with `editorInputLocked` so deferred captures never occupy slots. */
function syncOpeningGateHold(): void {
  thumbnailScheduler.setOpeningGateActive(usePlayerStore.getState().editorInputLocked);
}
syncOpeningGateHold();
const unbindOpeningGateHold = usePlayerStore.subscribe((state) => {
  thumbnailScheduler.setOpeningGateActive(state.editorInputLocked);
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unbindOpeningGateHold();
    thumbnailScheduler.setOpeningGateActive(false);
  });
}

/** Build a scheduler-managed request that captures real composition frames in the browser. */
export function createClientCompositionCaptureRequest(input: ClientCaptureInput): ThumbnailRequest {
  const { rev: compRev, hasFileVersion } = resolveCompositionRevision(input.projectId, input.previewUrl);
  return {
    key: createThumbnailKey({
      kind: "client-comp-capture",
      previewUrl: input.previewUrl,
      projectRev: compRev,
      revision: hasFileVersion ? undefined : input.contentRevision,
      frames: input.frameCount,
      selector: input.selector,
      selectorIndex: input.selectorIndex,
      samples: selectorCaptureWindowKey(input),
    }),
    projectId: input.projectId,
    sessionEpoch: input.sessionEpoch,
    kind: "composition",
    concurrencyBucket: "client-capture",
    priority: input.priority ?? "visible",
    rich: input.rich ?? true,
    gatePriority: Boolean(input.gatePriority),
    compositionPath: normalizeCompositionPathForGate(input.previewUrl),
    contentRevision: hasFileVersion ? 0 : input.contentRevision,
    compositionRevision: compRev,
    load: (signal) => runClientCompositionCapture(input, signal),
  };
}
