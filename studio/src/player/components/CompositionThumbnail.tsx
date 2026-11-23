import { memo, useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import { useThumbnailLease } from "../../hooks/useThumbnailLease";
import { useThumbnailStripSize } from "../../hooks/useThumbnailStripSize";
import {
  createThumbnailKey,
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
import {
  compositionDisplayName,
  loadCloudCompositionPoster,
} from "../lib/cloudCompositionPoster";
import {
  acquireCachedCompositionCaptureFromIdb,
  canCaptureCompositionInBrowser,
  createClientCompositionCaptureRequest,
  peekCachedCompositionCapture,
  quantizeCompositionFrameCount,
  retainCachedCompositionCapture,
  selectInitialGateCompositionPaths,
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

/** The composition a preview URL renders: `/preview/comp/<path>`, or the root for `/preview`. */
export function compositionPathOfPreviewUrl(previewUrl: string): string {
  const match = /\/preview\/comp\/([^?#]+)/.exec(previewUrl);
  return match?.[1] ? decodeURIComponent(match[1]) : "index.html";
}

export function compositionThumbnailRequest(
  url: string,
  projectId: string,
  { sessionEpoch = 0, priority = "visible", rich = false }: Partial<ThumbnailRequest> = {},
): ThumbnailRequest {
  const cloud = getCachedCloudDisklessMode();
  const identity = new URL(url, window.location.origin);
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
  const desiredCaptureFrames = useValueAtRest(
    quantizeCompositionFrameCount(
      computeThumbnailStrip(container.width, 16 / 9, container.height, 48).frameCount,
      effectiveClipDuration,
    ),
  );
  const captureMeasured = useValueAtRest(container.width > 0);
  const captureCacheKey = captureEnabled && captureMeasured
    ? `${projectId}|${previewUrl}|${contentRevision}|${desiredCaptureFrames}|${selector ?? ""}|${selectorIndex ?? 0}`
    : null;

  // Tier 0: synchronous in-memory hit (0ms across project/composition switches).
  const syncCachedValue = useMemo(
    () =>
      captureEnabled && captureMeasured
        ? peekCachedCompositionCapture({
            previewUrl,
            projectId,
            contentRevision,
            frameCount: desiredCaptureFrames,
            selector,
            selectorIndex,
          })
        : null,
    [
      captureEnabled,
      captureMeasured,
      contentRevision,
      desiredCaptureFrames,
      previewUrl,
      projectId,
      selector,
      selectorIndex,
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
      contentRevision,
      frameCount: desiredCaptureFrames,
      selector,
      selectorIndex,
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
    contentRevision,
    desiredCaptureFrames,
    previewUrl,
    projectId,
    selector,
    selectorIndex,
    syncCachedValue,
  ]);

  const idbValue = captureCacheKey && idbProbe?.key === captureCacheKey ? idbProbe.value : null;
  const cachedValue = syncCachedValue ?? idbValue;
  const idbPending = Boolean(captureCacheKey && !syncCachedValue && idbProbe?.key !== captureCacheKey);

  const loadGeneration = usePlayerStore((s) => s.assetReadinessGeneration);
  const inInitialGateSet = usePlayerStore((s) => {
    if (!captureEnabled || selector || priority === "overscan" || s.timelinePreviewSettledInitial) {
      return false;
    }
    return selectInitialGateCompositionPaths(s.elements, s.currentTime).includes(compPath);
  });
  const participatesInInitialGate =
    Boolean(captureCacheKey) && !syncCachedValue && inInitialGateSet;

  // Skip HTTP poster fetch when client capture is already cached or still checking fast IDB.
  const request = useMemo(
    () =>
      cachedValue || idbPending
        ? null
        : compositionThumbnailRequest(url, projectId, { sessionEpoch, priority, rich: true }),
    [cachedValue, idbPending, priority, projectId, sessionEpoch, url],
  );
  const posterSnapshot = useThumbnailLease(request);

  // Tier 2: serialized priority-queued offscreen browser capture (cold misses only).
  const captureRequest = useMemo(
    () =>
      captureEnabled && captureMeasured && !cachedValue && !idbPending
        ? createClientCompositionCaptureRequest({
            previewUrl,
            projectId,
            sessionEpoch,
            contentRevision,
            frameCount: desiredCaptureFrames,
            duration: effectiveClipDuration,
            seekTime,
            selector,
            selectorIndex,
            priority,
            gatePriority: participatesInInitialGate,
            rich: true,
          })
        : null,
    [
      cachedValue,
      captureEnabled,
      captureMeasured,
      contentRevision,
      desiredCaptureFrames,
      effectiveClipDuration,
      idbPending,
      participatesInInitialGate,
      previewUrl,
      priority,
      projectId,
      seekTime,
      selector,
      selectorIndex,
      sessionEpoch,
    ],
  );
  const captureSnapshot = useThumbnailLease(captureRequest);
  const gateTaskId = useMemo(
    () => (participatesInInitialGate ? `${projectId}:${previewUrl}:${contentRevision}` : null),
    [contentRevision, participatesInInitialGate, previewUrl, projectId],
  );
  const captureSettled =
    Boolean(cachedValue) ||
    captureSnapshot.status === "ready" ||
    captureSnapshot.status === "error";

  useEffect(() => {
    if (!gateTaskId) return;
    const store = usePlayerStore.getState();
    store.registerTimelinePreviewTask(gateTaskId, loadGeneration);
    return () => {
      usePlayerStore.getState().settleTimelinePreviewTask(gateTaskId, loadGeneration);
    };
  }, [gateTaskId, loadGeneration]);

  useEffect(() => {
    if (!gateTaskId || !captureSettled) return;
    usePlayerStore.getState().settleTimelinePreviewTask(gateTaskId, loadGeneration);
  }, [captureSettled, gateTaskId, loadGeneration]);

  const snapshot = captureSnapshot.status === "ready" ? captureSnapshot : posterSnapshot;
  const resolvedValue =
    cachedValue ??
    (snapshot.status === "ready" &&
    (snapshot.value.kind === "image" || snapshot.value.kind === "filmstrip")
      ? snapshot.value
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
              frameCount <= 1 || value.urls.length <= 1
                ? 0
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
      {!value && snapshot.status !== "error" && (
        <Skeleton animated={false} style={{ position: "absolute", inset: 0 }} />
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
