import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useThumbnailLease } from "../../hooks/useThumbnailLease";
import { useThumbnailStripSize } from "../../hooks/useThumbnailStripSize";
import {
  createThumbnailKey,
  thumbnailScheduler,
  type ThumbnailPriority,
  type ThumbnailRequest,
  type ThumbnailValue,
} from "../lib/thumbnailScheduler";
import { usePlayerStore } from "../store/playerStore";
import { TIMELINE_VIEWPORT_BUDGETS } from "../lib/timelineViewportBudgets";
import { ThumbnailTiles } from "./ThumbnailTiles";
import {
  computeThumbnailStrip,
  probeImageAspect,
} from "./thumbnailUtils";
import { useValueAtRest } from "./timelineMotion";
import { getCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import { compositionPathOfPreviewUrl } from "../../utils/projectCompositionPath";
export { compositionPathOfPreviewUrl } from "../../utils/projectCompositionPath";
import {
  compositionDisplayName,
  loadCloudCompositionPoster,
} from "../lib/cloudCompositionPoster";
import {
  acquireCachedCompositionCaptureFromIdb,
  canCaptureCompositionInBrowser,
  createClientCompositionCaptureRequest,
  getCompositionCacheKeyRevision,
  getProgressiveCompositionCapture,
  MAX_CLIENT_COMPOSITION_FRAMES,
  peekCachedCompositionCapture,
  peekFallbackCompositionCapture,
  quantizeCompositionFrameCount,
  retainCachedCompositionCapture,
  selectInitialGateCompositionPaths,
  selectorCaptureWindowKey,
  subscribeCompositionCacheRevision,
  subscribeProgressiveCompositionCapture,
} from "../lib/clientCompositionCapture";
import { studioApiFetch } from "../../utils/studioApiFetch";
import { Skeleton } from "../../components/ui/Skeleton";

interface CompositionThumbnailProps {
  previewUrl: string;
  label: string;
  labelColor: string;
  selector?: string;
  selectorIndex?: number;
  seekTime?: number;
  duration?: number;
  /** Actual clip duration on the timeline, used to space multi-frame client captures. */
  clipDuration?: number;
  width?: number;
  height?: number;
  projectId?: string;
  sessionEpoch?: number;
  contentRevision?: number;
  priority?: ThumbnailPriority;
  rich?: boolean;
}

const THUMBNAIL_URL_VERSION = "v4";
export const THUMBNAIL_SEEK_TIME_SECONDS = 3;

export function resolveThumbnailSeekTime(durationSeconds: number | null | undefined): number {
  if (
    Number.isFinite(durationSeconds) &&
    durationSeconds != null &&
    durationSeconds > 0 &&
    durationSeconds <= THUMBNAIL_SEEK_TIME_SECONDS
  ) {
    return durationSeconds / 2;
  }

  return THUMBNAIL_SEEK_TIME_SECONDS;
}

export function buildCompositionThumbnailUrl({
  previewUrl,
  seekTime = 2,
  duration = 5,
  selector,
  selectorIndex,
  origin,
  output,
  contentRevision = 0,
}: {
  previewUrl: string;
  seekTime?: number;
  duration?: number;
  selector?: string;
  selectorIndex?: number;
  origin: string;
  /**
   * Capture density. Omitted, the route bounds the image to its preview cap —
   * right for the timeline, where thumbnails are small and numerous and their
   * decoded bytes are budgeted. `"source"` uses the composition's own dimensions.
   */
  output?: "source";
  contentRevision?: number;
}): string {
  const thumbnailBase = previewUrl
    .replace("/preview/comp/", "/thumbnail/")
    .replace(/\/preview$/, "/thumbnail/index.html");
  const thumbnailUrl = new URL(thumbnailBase, origin);
  thumbnailUrl.searchParams.set("t", (seekTime + duration / 2).toFixed(2));
  thumbnailUrl.searchParams.set("v", THUMBNAIL_URL_VERSION);
  thumbnailUrl.searchParams.set("revision", String(contentRevision));
  if (output) thumbnailUrl.searchParams.set("output", output);
  if (selector) {
    thumbnailUrl.searchParams.set("selector", selector);
    if (selectorIndex != null && selectorIndex > 0) {
      thumbnailUrl.searchParams.set("selectorIndex", String(selectorIndex));
    }
  }
  return thumbnailUrl.toString();
}

export function compositionThumbnailRequest(
  url: string,
  projectId: string,
  { sessionEpoch = 0, priority = "visible", rich = false }: Partial<ThumbnailRequest> = {},
): ThumbnailRequest {
  const cloud = getCachedCloudDisklessMode();
  const identity = new URL(url, window.location.origin);
  const thumbMatch = /\/thumbnail\/([^?#]+)/.exec(identity.pathname);
  let compositionPath: string | undefined;
  if (thumbMatch?.[1]) {
    try {
      compositionPath = decodeURIComponent(thumbMatch[1]).replace(/^(\.\/|\/)+/, "");
    } catch {
      compositionPath = thumbMatch[1].replace(/^(\.\/|\/)+/, "");
    }
  }
  const rawRevision = Number(identity.searchParams.get("revision") ?? 0);
  const contentRevision = Number.isFinite(rawRevision) ? rawRevision : 0;
  if (cloud) {
    // A representative is shared by the card and every strip of this composition/selection.
    identity.searchParams.delete("t");
    identity.searchParams.delete("output");
  }
  return {
    key: createThumbnailKey({ kind: "composition", url: identity.href, cloud: Number(cloud) }),
    projectId,
    sessionEpoch,
    kind: "composition",
    priority,
    rich,
    compositionPath,
    contentRevision,
    load: (signal) => cloud
      ? loadCloudCompositionPoster(identity, projectId, sessionEpoch, signal)
      : loadCompositionImage(url, signal),
  };
}

async function loadCompositionImage(url: string, signal: AbortSignal) {
  // Canvas and editing requests keep their normal browser network priority.
  const options: RequestInit = { signal, priority: "low" };
  let response = await studioApiFetch(url, options);
  if (response.status === 202) {
    const cached = new URL(url, window.location.origin);
    cached.searchParams.set("cached", "1");
    // Only the first request enqueues work. Check for the image while this card is visible.
    const deadline = Date.now() + 180_000;
    let delay = 500;
    do {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, delay);
        function abort() {
          clearTimeout(timer);
          reject(signal.reason);
        }
        signal.addEventListener("abort", abort, { once: true });
      });
      response = await studioApiFetch(cached.pathname + cached.search, options);
      delay = Math.min(4000, delay * 2);
    } while (response.status === 204 && Date.now() < deadline);
    if (response.status === 204) throw new Error("Composition thumbnail is still pending");
  }
  if (!response.ok) throw new Error(`Composition thumbnail failed (${response.status})`);
  const blob = await response.blob();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const objectUrl = URL.createObjectURL(blob);
  try {
    let decodedBytes = 0;
    const aspect = await probeImageAspect(objectUrl, signal, false, (width, height) => {
      decodedBytes = width * height * 4;
    });
    return {
      value: { kind: "image" as const, url: objectUrl, aspect },
      weight: decodedBytes ||
        TIMELINE_VIEWPORT_BUDGETS.posterMaxPhysicalWidth *
          TIMELINE_VIEWPORT_BUDGETS.posterMaxPhysicalHeight * 4,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

type RenderedCaptureValue =
  | Extract<ThumbnailValue, { kind: "filmstrip" }>
  | (Extract<ThumbnailValue, { kind: "image" }> & { representative: "render" });

function isRenderedCaptureValue(
  value: ThumbnailValue | null | undefined,
): value is RenderedCaptureValue {
  if (!value) return false;
  if (value.kind === "filmstrip") return value.urls.length > 0;
  return value.kind === "image" && value.representative === "render";
}

/**
 * Keep displaying a clip's already-rendered filmstrip/capture while a refresh
 * (frame-count change, revision bump, or selector window update) recalculates,
 * so the clip swaps atomically without flashing skeleton -> text -> filmstrip.
 */
function useRetainedCompositionCapture({
  captureEnabled,
  projectId,
  previewUrl,
  selector,
  selectorIndex,
  captureCacheKey,
  settledCapture,
  captureFailed,
}: {
  captureEnabled: boolean;
  projectId: string;
  previewUrl: string;
  selector?: string;
  selectorIndex?: number;
  captureCacheKey: string | null;
  settledCapture: RenderedCaptureValue | null;
  captureFailed: boolean;
}): RenderedCaptureValue | null {
  const clipIdentity = `${projectId}|${previewUrl}|${selector ?? ""}|${selectorIndex ?? 0}`;
  const fallbackCachedCapture = useMemo(() => {
    if (!captureEnabled || settledCapture || captureFailed) return null;
    const candidate = peekFallbackCompositionCapture({
      projectId,
      previewUrl,
      selector,
      selectorIndex,
    });
    return isRenderedCaptureValue(candidate) ? candidate : null;
  }, [
    captureEnabled,
    captureFailed,
    captureCacheKey,
    previewUrl,
    projectId,
    selector,
    selectorIndex,
    settledCapture,
  ]);

  const [retained, setRetained] = useState<{
    identity: string;
    value: RenderedCaptureValue;
  } | null>(null);

  if (!captureEnabled || captureFailed) {
    if (retained !== null) setRetained(null);
  } else if (settledCapture) {
    if (retained?.identity !== clipIdentity || retained.value !== settledCapture) {
      setRetained({ identity: clipIdentity, value: settledCapture });
    }
  } else if (retained && retained.identity !== clipIdentity) {
    setRetained(
      fallbackCachedCapture ? { identity: clipIdentity, value: fallbackCachedCapture } : null,
    );
  } else if (!retained && fallbackCachedCapture) {
    setRetained({ identity: clipIdentity, value: fallbackCachedCapture });
  }

  const activeRetained =
    !captureEnabled || captureFailed
      ? null
      : settledCapture ??
        (retained?.identity === clipIdentity ? retained.value : fallbackCachedCapture);

  // Retain object URLs across LRU eviction and old scheduler/IDB lease cleanup while refreshing.
  useLayoutEffect(() => retainCachedCompositionCapture(activeRetained), [activeRetained]);

  return activeRetained;
}

/** Composition poster, deduplicated and budgeted by project/session. */
export const CompositionThumbnail = memo(function CompositionThumbnail({
  previewUrl,
  label,
  labelColor,
  selector,
  selectorIndex,
  seekTime = 2,
  duration = 5,
  clipDuration,
  projectId = previewUrl,
  sessionEpoch = 0,
  contentRevision = 0,
  priority = "visible",
}: CompositionThumbnailProps) {
  const [container, setContainerRef, watchGap] = useThumbnailStripSize();
  const cloud = getCachedCloudDisklessMode();
  const compPath = useMemo(() => compositionPathOfPreviewUrl(previewUrl), [previewUrl]);
  const url = buildCompositionThumbnailUrl({
    previewUrl,
    seekTime,
    duration,
    selector,
    selectorIndex,
    origin: window.location.origin,
    // Small element crops need source-resolution pixels before they are scaled down.
    output: selector ? "source" : undefined,
    contentRevision,
  });

  const effectiveClipDuration = clipDuration ?? duration;
  const captureEnabled = cloud && canCaptureCompositionInBrowser();
  const subscribeCacheRev = useCallback(
    (listener: () => void) =>
      captureEnabled ? subscribeCompositionCacheRevision(projectId, listener) : () => {},
    [captureEnabled, projectId],
  );
  const getCacheRev = useCallback(
    () => (captureEnabled ? getCompositionCacheKeyRevision(projectId, previewUrl, contentRevision) : ""),
    [captureEnabled, contentRevision, previewUrl, projectId],
  );
  const compCacheRev = useSyncExternalStore(subscribeCacheRev, getCacheRev, () => "");
  const captureContentRevision = compCacheRev.startsWith("file:") ? 0 : contentRevision;
  const quantizedTileFrames = useValueAtRest(
    quantizeCompositionFrameCount(
      computeThumbnailStrip(container.width, 16 / 9, container.height, 48).frameCount,
      effectiveClipDuration,
    ),
  );
  // Whole HTML compositions capture one canonical filmstrip per content version so
  // trimming, stretching, or zooming the timeline simply displays fewer or more tiles
  // from that cached strip without ever re-running SnapDOM.
  const desiredCaptureFrames = selector ? quantizedTileFrames : MAX_CLIENT_COMPOSITION_FRAMES;
  const captureMeasured = useValueAtRest(container.width > 0);
  const captureStart = useValueAtRest(seekTime);
  const captureDuration = useValueAtRest(effectiveClipDuration);
  const selectorStart = selector ? captureStart : undefined;
  const selectorDuration = selector ? captureDuration : undefined;
  const captureCacheKey = captureEnabled && captureMeasured
    ? `${projectId}|${previewUrl}|${compCacheRev}|${desiredCaptureFrames}|${selector ?? ""}|${selectorIndex ?? 0}|${selectorCaptureWindowKey({ selector, seekTime: selectorStart, duration: selectorDuration }) ?? ""}`
    : null;

  // Tier 0: synchronous in-memory hit (0ms across project/composition switches).
  const syncCachedValue = useMemo(
    () =>
      captureEnabled && captureMeasured
        ? peekCachedCompositionCapture({
            previewUrl,
            projectId,
            contentRevision: captureContentRevision,
            frameCount: desiredCaptureFrames,
            selector,
            selectorIndex,
            seekTime: selectorStart,
            duration: selectorDuration,
          })
        : null,
    [
      captureContentRevision,
      captureEnabled,
      captureMeasured,
      compCacheRev,
      desiredCaptureFrames,
      previewUrl,
      projectId,
      selector,
      selectorIndex,
      selectorStart,
      selectorDuration,
    ],
  );

  // Keep the sync cache entry's object URLs alive while this tile renders them, even after LRU eviction.
  useLayoutEffect(() => retainCachedCompositionCapture(syncCachedValue), [syncCachedValue]);

  // Tier 1: parallel fast-path IndexedDB check (bypasses thumbnailScheduler's 2-slot composition bucket).
  const [idbProbe, setIdbProbe] = useState<{ key: string; value: ThumbnailValue | null } | null>(null);
  useEffect(() => {
    if (!captureCacheKey || syncCachedValue) return;
    let cancelled = false;
    let releaseLease: (() => void) | null = null;
    void acquireCachedCompositionCaptureFromIdb({
      previewUrl,
      projectId,
      contentRevision: captureContentRevision,
      frameCount: desiredCaptureFrames,
      selector,
      selectorIndex,
      seekTime: selectorStart,
      duration: selectorDuration,
    })
      .then((lease) => {
        if (cancelled) {
          lease?.release();
          return;
        }
        releaseLease = lease?.release ?? null;
        setIdbProbe({ key: captureCacheKey, value: lease?.value ?? null });
      })
      .catch(() => {
        if (!cancelled) setIdbProbe({ key: captureCacheKey, value: null });
      });
    return () => {
      cancelled = true;
      releaseLease?.();
      releaseLease = null;
    };
  }, [
    captureCacheKey,
    captureContentRevision,
    desiredCaptureFrames,
    previewUrl,
    projectId,
    selector,
    selectorIndex,
    selectorStart,
    selectorDuration,
    syncCachedValue,
  ]);

  const idbValue = captureCacheKey && idbProbe?.key === captureCacheKey ? idbProbe.value : null;
  const cachedValue = syncCachedValue ?? idbValue;
  const idbPending = Boolean(captureCacheKey && !syncCachedValue && idbProbe?.key !== captureCacheKey);

  const loadGeneration = usePlayerStore((s) => s.assetReadinessGeneration);
  const inPlayheadPrioritySet = usePlayerStore((s) => {
    if (!captureEnabled || selector || priority === "overscan") {
      return false;
    }
    return selectInitialGateCompositionPaths(s.elements, s.currentTime).includes(compPath);
  });
  const timelinePreviewSettledInitial = usePlayerStore((s) => s.timelinePreviewSettledInitial);
  const participatesInInitialGate =
    Boolean(captureCacheKey) &&
    !syncCachedValue &&
    !timelinePreviewSettledInitial &&
    inPlayheadPrioritySet;
  const boostCapturePriority =
    Boolean(captureCacheKey) && !syncCachedValue && inPlayheadPrioritySet;

  // Tier 2: priority-queued offscreen browser capture (cold misses only).
  const captureRequest = useMemo(
    () =>
      captureEnabled && captureMeasured && !cachedValue && !idbPending
        ? createClientCompositionCaptureRequest({
            previewUrl,
            projectId,
            sessionEpoch,
            contentRevision: captureContentRevision,
            frameCount: desiredCaptureFrames,
            duration: selectorDuration,
            seekTime: selectorStart,
            selector,
            selectorIndex,
            priority: boostCapturePriority ? "interaction" : priority,
            gatePriority: boostCapturePriority,
            rich: true,
          })
        : null,
    [
      cachedValue,
      captureContentRevision,
      captureEnabled,
      captureMeasured,
      compCacheRev,
      desiredCaptureFrames,
      idbPending,
      boostCapturePriority,
      previewUrl,
      priority,
      projectId,
      selector,
      selectorIndex,
      selectorStart,
      selectorDuration,
      sessionEpoch,
    ],
  );
  const captureSnapshot = useThumbnailLease(captureRequest);
  const settledCapture = isRenderedCaptureValue(cachedValue)
    ? cachedValue
    : captureSnapshot.status === "ready" && isRenderedCaptureValue(captureSnapshot.value)
      ? captureSnapshot.value
      : null;
  const retainedCapture = useRetainedCompositionCapture({
    captureEnabled,
    projectId,
    previewUrl,
    selector,
    selectorIndex,
    captureCacheKey,
    settledCapture,
    captureFailed: captureSnapshot.status === "error",
  });

  // Skip HTTP poster fetch when client capture is cached, checking IDB, or holding a prior strip.
  const request = useMemo(
    () =>
      cachedValue || idbPending || retainedCapture
        ? null
        : compositionThumbnailRequest(url, projectId, { sessionEpoch, priority, rich: true }),
    [cachedValue, idbPending, priority, projectId, retainedCapture, sessionEpoch, url],
  );
  const posterSnapshot = useThumbnailLease(request);

  const progressiveTarget = useMemo(
    () =>
      captureEnabled &&
      captureMeasured &&
      !cachedValue &&
      !idbPending &&
      !retainedCapture &&
      captureSnapshot.status !== "ready"
        ? {
            previewUrl,
            projectId,
            contentRevision: captureContentRevision,
            frameCount: desiredCaptureFrames,
            selector,
            selectorIndex,
            seekTime: selectorStart,
            duration: selectorDuration,
          }
        : null,
    [
      cachedValue,
      captureContentRevision,
      captureEnabled,
      captureMeasured,
      captureSnapshot.status,
      compCacheRev,
      desiredCaptureFrames,
      idbPending,
      previewUrl,
      projectId,
      retainedCapture,
      selector,
      selectorIndex,
      selectorStart,
      selectorDuration,
    ],
  );
  const subscribeProgressive = useCallback(
    (listener: () => void) =>
      progressiveTarget ? subscribeProgressiveCompositionCapture(progressiveTarget, listener) : () => {},
    [progressiveTarget],
  );
  const getProgressiveSnapshot = useCallback(
    () => (progressiveTarget ? getProgressiveCompositionCapture(progressiveTarget) : null),
    [progressiveTarget],
  );
  const progressiveValue = useSyncExternalStore(subscribeProgressive, getProgressiveSnapshot, () => null);
  const gateTaskId = useMemo(
    () => (participatesInInitialGate ? `comp:${projectId}:${previewUrl}:${compCacheRev}` : null),
    [compCacheRev, participatesInInitialGate, previewUrl, projectId],
  );
  const captureSettled =
    Boolean(cachedValue) ||
    captureSnapshot.status === "ready" ||
    captureSnapshot.status === "error";

  useEffect(() => {
    if (!gateTaskId) return;
    usePlayerStore.getState().registerTimelinePreviewTask(gateTaskId, loadGeneration);
    return () => {
      usePlayerStore.getState().settleTimelinePreviewTask(gateTaskId, loadGeneration);
    };
  }, [gateTaskId, loadGeneration]);

  useEffect(() => {
    if (!gateTaskId || !captureSettled) return;
    usePlayerStore.getState().settleTimelinePreviewTask(gateTaskId, loadGeneration);
  }, [captureSettled, gateTaskId, loadGeneration]);

  const autoRetriedKeyRef = useRef<string | null>(null);
  const [autoRetryPending, setAutoRetryPending] = useState(false);

  // Bounded 1x quiet automatic backoff retry when a transient capture error occurs.
  useEffect(() => {
    if (
      !captureEnabled ||
      !captureCacheKey ||
      !projectId ||
      Boolean(cachedValue) ||
      Boolean(progressiveValue) ||
      captureSnapshot.status !== "error"
    ) {
      setAutoRetryPending(false);
      return;
    }
    if (autoRetriedKeyRef.current === captureCacheKey) {
      setAutoRetryPending(false);
      return;
    }
    setAutoRetryPending(true);
    const timer = setTimeout(() => {
      autoRetriedKeyRef.current = captureCacheKey;
      setAutoRetryPending(false);
      thumbnailScheduler.retryFailed(projectId, compPath);
    }, 2_000);
    return () => clearTimeout(timer);
  }, [
    cachedValue,
    captureCacheKey,
    captureEnabled,
    captureSnapshot.status,
    compPath,
    progressiveValue,
    projectId,
  ]);

  const snapshot = captureSnapshot.status === "ready" ? captureSnapshot : posterSnapshot;
  const resolvedValue =
    cachedValue ??
    (captureSnapshot.status === "ready" &&
    (captureSnapshot.value.kind === "image" || captureSnapshot.value.kind === "filmstrip")
      ? captureSnapshot.value
      : null) ??
    retainedCapture ??
    (progressiveValue && (progressiveValue.kind === "image" || progressiveValue.kind === "filmstrip")
      ? progressiveValue
      : null) ??
    (posterSnapshot.status === "ready" &&
    (posterSnapshot.value.kind === "image" || posterSnapshot.value.kind === "filmstrip")
      ? posterSnapshot.value
      : null);
  const value =
    resolvedValue && (resolvedValue.kind === "image" || resolvedValue.kind === "filmstrip")
      ? resolvedValue
      : null;
  const { frameW, frameCount } = computeThumbnailStrip(
    container.width,
    value?.aspect ?? 16 / 9,
    container.height,
    48,
  );
  const compositionName = useMemo(() => compositionDisplayName(compPath), [compPath]);
  const isTextStrip = value?.kind === "image" && value.representative === "text";
  const isSingleMediaStrip = value?.kind === "image" && value.representative !== "text";
  const textTitle = isTextStrip ? (label || value.label || compositionName) : "";
  const textMeta =
    isTextStrip &&
    !selector &&
    compositionName &&
    compositionName.toLowerCase() !== textTitle.toLowerCase() &&
    container.width >= 260
      ? compositionName
      : "";
  const mediaTitle = isSingleMediaStrip ? (label || (!selector ? compositionName : "")) : "";
  const showInlineMediaTitle = Boolean(mediaTitle) && container.width >= frameW + 48;
  const showOverlayLabel = Boolean(label) && !isTextStrip && !showInlineMediaTitle;

  return (
    <div ref={setContainerRef} className="absolute inset-0 overflow-hidden">
      {value?.kind === "filmstrip" && value.urls.length > 0 && (
        <ThumbnailTiles
          strip={container}
          frameW={frameW}
          frameCount={frameCount}
          watchGap={watchGap}
          style={{
            mixBlendMode:
              "var(--timeline-composition-thumbnail-blend)" as CSSProperties["mixBlendMode"],
          }}
        >
          {(index) => {
            const frameIndex =
              value.urls.length <= 1
                ? 0
                : frameCount <= 1
                  ? Math.floor(value.urls.length / 2)
                  : Math.min(
                      value.urls.length - 1,
                      Math.round((index / (frameCount - 1)) * (value.urls.length - 1)),
                    );
            return (
              <div
                key={index}
                className="relative h-full shrink-0 overflow-hidden"
                style={{ width: frameW }}
              >
                <img
                  src={value.urls[frameIndex]}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-cover"
                  style={{ opacity: "var(--timeline-composition-thumbnail-opacity)" }}
                />
              </div>
            );
          }}
        </ThumbnailTiles>
      )}
      {isSingleMediaStrip && (
        <div
          className="timeline-composition-strip"
          data-composition-strip="media"
          style={{
            mixBlendMode:
              "var(--timeline-composition-thumbnail-blend)" as CSSProperties["mixBlendMode"],
          }}
        >
          <div
            className="timeline-composition-strip__thumb relative h-full shrink-0 overflow-hidden"
            style={{ width: frameW }}
          >
            <img
              src={value.url}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full object-contain"
              style={{ opacity: "var(--timeline-composition-thumbnail-opacity)" }}
            />
          </div>
          {showInlineMediaTitle && (
            <div className="timeline-composition-strip__body">
              <span className="timeline-composition-strip__title">{mediaTitle}</span>
            </div>
          )}
        </div>
      )}
      {isTextStrip && (
        <div
          className="timeline-composition-strip timeline-composition-strip--text"
          data-composition-strip="text"
        >
          <div className="timeline-composition-strip__body">
            {(container.width === 0 || container.width >= 110) && (
              <span className="timeline-composition-strip__icon" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <rect
                    x="2"
                    y="3"
                    width="12"
                    height="10"
                    rx="1.75"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M5.5 3v10M10.5 3v10"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    opacity="0.65"
                  />
                </svg>
              </span>
            )}
            {textTitle && <span className="timeline-composition-strip__title">{textTitle}</span>}
            {textMeta && <span className="timeline-composition-strip__meta">{textMeta}</span>}
          </div>
        </div>
      )}
      {!value && (snapshot.status !== "error" || autoRetryPending) && (
        <Skeleton style={{ position: "absolute", inset: 0 }} />
      )}
      {showOverlayLabel && (
        <div className="absolute inset-y-0 left-3 z-10 flex items-center">
          <span
            className="block max-w-full truncate text-[10px] font-semibold leading-none"
            style={{
              color: labelColor,
              textShadow: value ? "0 1px 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.6)" : "none",
            }}
          >
            {label}
          </span>
        </div>
      )}
    </div>
  );
});
