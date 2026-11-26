import { isNonVisualPreviewFile } from "../../../../shared/preview-impact";
import { cancelPendingRemoteFilmstripUploads } from "./remoteCompositionFilmstrip";
import { createThumbnailKey, type ThumbnailPriority } from "./thumbnailScheduler";

export const MAX_CLIENT_COMPOSITION_FRAMES = 8;
/** Prioritize a bounded set of compositions nearest the playhead. */
const MAX_PRIORITY_COMPOSITIONS = 4;
export const CAPTURE_TARGET_WIDTH = 160;

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

export type StripCacheInput = Pick<
  ClientCaptureInput,
  "projectId" | "previewUrl" | "contentRevision" | "frameCount" | "selector" | "selectorIndex" | "seekTime" | "duration"
> & {
  /** Prefer returning an already-warm multi-frame sprite/filmstrip when `frameCount === 1` (sidebar hover preview). */
  preferMultiFrame?: boolean;
};

export interface StripCacheMeta {
  clipIdentityKey: string;
  projectId: string;
  compPath: string;
  compRev: string;
  contentRevision: number;
}

export type RevisionInvalidationHook = (
  projectId: string,
  isPathChanged: (compPath: string) => boolean,
) => void;

const projectRevisionByProjectId = new Map<string, string>();
const compositionRevisionsByProjectId = new Map<string, Map<string, string>>();
const projectSharedTagByProjectId = new Map<string, string>();
const revisionListenersByProjectId = new Map<string, Set<() => void>>();
const invalidationHooks = new Set<RevisionInvalidationHook>();
let liveSharedDepSeq = 0;

const SHARED_REV_MARKER = "|shared:";
const DEPS_REV_MARKER = "|deps:";
const HTML_FILE_RE = /\.html?$/i;

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

function runInvalidationHooks(
  projectId: string,
  isPathChanged: (compPath: string) => boolean = () => true,
): void {
  for (const hook of invalidationHooks) {
    hook(projectId, isPathChanged);
  }
}

/** Register an internal cache or capture-pool invalidation hook triggered on revision updates. */
export function registerRevisionInvalidationHook(hook: RevisionInvalidationHook): () => void {
  invalidationHooks.add(hook);
  return () => {
    invalidationHooks.delete(hook);
  };
}

/** Reset revision registries between unit tests. */
export function resetCompositionRevisionsForTest(): void {
  projectRevisionByProjectId.clear();
  compositionRevisionsByProjectId.clear();
  projectSharedTagByProjectId.clear();
  revisionListenersByProjectId.clear();
  liveSharedDepSeq = 0;
}

export function normalizeCompositionPathForGate(raw: string): string {
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
 * for prioritized capture. Remaining clips generate progressively in the background.
 */
export function selectPriorityCompositionPaths(
  elements: ReadonlyArray<{
    compositionSrc?: string;
    hidden?: boolean;
    start: number;
    duration: number;
  }>,
  currentTime: number,
  maxCount: number = MAX_PRIORITY_COMPOSITIONS,
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
        for (const changedComp of changedPaths) {
          cancelPendingRemoteFilmstripUploads(projectId, changedComp);
        }
        runInvalidationHooks(projectId, (compPath) => {
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
    cancelPendingRemoteFilmstripUploads(projectId);
    runInvalidationHooks(projectId);
    notifyRevisionListeners(projectId);
  }
}

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
    return !isNonVisualPreviewFile(key);
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
    for (const changedComp of changedPaths) {
      cancelPendingRemoteFilmstripUploads(projectId, changedComp);
    }
    runInvalidationHooks(projectId, (compPath) => changedPaths.has(compPath));
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

export function resolveCompositionRevision(
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
  return computeCompositionSampleTimes(1, frameCount).map((fraction) => from + (to - from) * fraction);
}

export function selectorCaptureWindowKey({
  selector,
  seekTime,
  duration,
}: Pick<ClientCaptureInput, "selector" | "seekTime" | "duration">): string | undefined {
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

function compPathCacheTag(
  projectId: string,
  compPath: string,
  projectRev: string,
  contentRevision: number,
): string {
  return `${projectId}|${normalizeCompositionPathForGate(compPath)}|${projectRev}|${contentRevision}`;
}

export function clipIdentityCacheKey(
  input: Pick<StripCacheInput, "projectId" | "previewUrl" | "selector" | "selectorIndex">,
): string {
  return createThumbnailKey({
    project: input.projectId,
    url: input.previewUrl,
    sel: input.selector,
    idx: input.selectorIndex,
  });
}

export function stripMemoryCacheKey(
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
