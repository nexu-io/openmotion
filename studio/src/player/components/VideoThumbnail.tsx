import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useThumbnailLease } from "../../hooks/useThumbnailLease";
import { useThumbnailStripSize } from "../../hooks/useThumbnailStripSize";
import { useLocalUploadPreview } from "../../utils/localUploadPreviewStore";
import {
  thumbnailScheduler,
  type ThumbnailPriority,
  type ThumbnailSnapshot,
} from "../lib/thumbnailScheduler";
import { bindThumbnailPlaybackHold } from "../lib/thumbnailPlaybackHold";
import {
  createVideoThumbnailRequest,
  peekReadyVideoThumbnailRequest,
  recordReadyVideoThumbnailRequest,
  sliceVideoFallbackUrls,
  type ReadyVideoFallbackEntry,
} from "../lib/videoThumbnailRequest";
import { matchesFailedPreviewAsset } from "../lib/previewAssetReadiness";
import { usePlayerStore } from "../store/playerStore";
import { triggerEditorAssetRetry } from "../../components/EditorAssetLoadingOverlay";
import { ItemLoadErrorBadge } from "../../components/ui/ItemLoadErrorBadge";
import { ThumbnailTiles } from "./ThumbnailTiles";
import {
  computeThumbnailStrip,
  quantizeThumbnailFrameCount,
  thumbnailFrameForTile,
} from "./thumbnailUtils";
import { useValueAtRest } from "./timelineMotion";

const unbindPlaybackHold = bindThumbnailPlaybackHold(usePlayerStore, thumbnailScheduler);
import.meta.hot?.dispose(unbindPlaybackHold);

interface VideoThumbnailProps {
  videoSrc: string;
  label: string;
  labelColor: string;
  duration?: number;
  sourceStart?: number;
  sourceRangeDuration?: number;
  projectId?: string;
  sessionEpoch?: number;
  priority?: ThumbnailPriority;
}

function selectThumbnailSnapshot(
  poster: ThumbnailSnapshot,
  rich: ThumbnailSnapshot,
  shown: ThumbnailSnapshot,
  fallback: ThumbnailSnapshot,
): ThumbnailSnapshot {
  if (rich.status === "ready") return rich;
  if (shown.status === "ready") return shown;
  if (poster.status === "ready") return poster;
  if (fallback.status === "ready") return fallback;
  if (rich.status === "loading" || poster.status === "loading") return { status: "loading" };
  return poster;
}

type VideoThumbnailRequest = ReturnType<typeof createVideoThumbnailRequest>;

function useVideoThumbnailSnapshot(
  poster: VideoThumbnailRequest | null,
  rich: VideoThumbnailRequest | null,
  media: string,
  sessionMediaKey: string,
  range: { sourceStart: number; sourceRangeDuration: number; frameCount: number },
): ThumbnailSnapshot {
  const posterSnapshot = useThumbnailLease(poster);
  const richSnapshot = useThumbnailLease(rich);
  const [shown, setShown] = useState({ media, request: rich });
  const richSettled = richSnapshot.status === "ready" || rich === null;
  if (richSettled && (shown.media !== media || shown.request !== rich)) setShown({ media, request: rich });
  const shownSnapshot = useThumbnailLease(shown.media === media ? shown.request : null);

  // On initial mount (e.g. newly created right half of a split video clip), borrow an
  // already-ready scheduler entry for the exact same video source so frame 0 renders
  // immediately without flashing a loading shimmer while the child range decodes locally.
  const [mountFallback, setMountFallback] = useState<{
    sessionMediaKey: string;
    entry: ReadyVideoFallbackEntry;
  } | null>(() => {
    const candidate = peekReadyVideoThumbnailRequest(sessionMediaKey);
    return candidate ? { sessionMediaKey, entry: candidate } : null;
  });

  const ownSettledOrFailed =
    richSnapshot.status === "ready" ||
    posterSnapshot.status === "ready" ||
    (posterSnapshot.status === "error" && (rich === null || richSnapshot.status === "error"));
  if (mountFallback && (mountFallback.sessionMediaKey !== sessionMediaKey || ownSettledOrFailed)) {
    setMountFallback(null);
  }
  const activeFallback =
    mountFallback && mountFallback.sessionMediaKey === sessionMediaKey ? mountFallback.entry : null;
  const fallbackSnapshot = useThumbnailLease(activeFallback?.request ?? null);

  useEffect(() => {
    if (rich && richSnapshot.status === "ready") {
      recordReadyVideoThumbnailRequest(sessionMediaKey, {
        request: rich,
        sourceStart: range.sourceStart,
        sourceRangeDuration: range.sourceRangeDuration,
        frameCount: range.frameCount,
      });
    } else if (poster && posterSnapshot.status === "ready") {
      recordReadyVideoThumbnailRequest(sessionMediaKey, {
        request: poster,
        sourceStart: range.sourceStart,
        sourceRangeDuration: range.sourceRangeDuration,
        frameCount: 1,
      });
    }
  }, [
    poster,
    posterSnapshot.status,
    range.frameCount,
    range.sourceRangeDuration,
    range.sourceStart,
    rich,
    richSnapshot.status,
    sessionMediaKey,
  ]);

  const slicedFallbackSnapshot = useMemo<ThumbnailSnapshot>(() => {
    if (!activeFallback || fallbackSnapshot.status !== "ready") return fallbackSnapshot;
    if (fallbackSnapshot.value.kind !== "filmstrip") return fallbackSnapshot;
    const slicedUrls = sliceVideoFallbackUrls(
      fallbackSnapshot.value.urls,
      activeFallback.sourceStart,
      activeFallback.sourceRangeDuration,
      range.sourceStart,
      range.sourceRangeDuration,
    );
    if (slicedUrls === fallbackSnapshot.value.urls) return fallbackSnapshot;
    return {
      status: "ready",
      value: {
        kind: "filmstrip",
        urls: slicedUrls,
        aspect: fallbackSnapshot.value.aspect,
      },
    };
  }, [activeFallback, fallbackSnapshot, range.sourceRangeDuration, range.sourceStart]);

  return selectThumbnailSnapshot(posterSnapshot, richSnapshot, shownSnapshot, slicedFallbackSnapshot);
}

function useRangeHeldDuringTrim(
  props: Required<
    Pick<VideoThumbnailProps, "videoSrc" | "duration" | "projectId" | "sessionEpoch" | "priority">
  > &
    Pick<VideoThumbnailProps, "sourceStart" | "sourceRangeDuration">,
) {
  const {
    videoSrc,
    sourceStart,
    sourceRangeDuration,
    duration,
    projectId,
    sessionEpoch,
    priority,
  } = props;
  const range = useValueAtRest(
    useMemo(
      () => ({ sourceStart, sourceRangeDuration, duration }),
      [duration, sourceRangeDuration, sourceStart],
    ),
  );
  return useMemo(
    () => ({ videoSrc, ...range, projectId, sessionEpoch, priority }),
    [priority, projectId, range, sessionEpoch, videoSrc],
  );
}

/** Sparse frames from the original media, shared across visible clips and asset cards. */
export const VideoThumbnail = memo(function VideoThumbnail({
  videoSrc,
  label,
  labelColor,
  duration = 5,
  sourceStart,
  sourceRangeDuration,
  projectId = videoSrc,
  sessionEpoch = 0,
  priority = "visible",
}: VideoThumbnailProps) {
  const [container, setContainerRef, watchGap] = useThumbnailStripSize();
  const localAssetPath = useMemo(() => {
    try {
      const url = new URL(videoSrc, typeof window !== "undefined" ? window.location.href : "http://localhost");
      const match = url.pathname.match(/^\/api\/projects\/[^/]+\/preview\/(.+)$/);
      return match ? decodeURIComponent(match[1]) : "";
    } catch {
      return "";
    }
  }, [videoSrc]);
  const localPreviewUrl = useLocalUploadPreview(projectId, localAssetPath);
  const requestFrameCount = useValueAtRest(
    quantizeThumbnailFrameCount(
      computeThumbnailStrip(container.width, 16 / 9, container.height).frameCount,
    ),
  );
  const requestProps = useRangeHeldDuringTrim({
    videoSrc,
    sourceStart,
    sourceRangeDuration,
    duration,
    projectId,
    sessionEpoch,
    priority,
  });
  const measured = useValueAtRest(container.width > 0);
  const posterRequest = useMemo(
    () => createVideoThumbnailRequest(requestProps, 1, false),
    [requestProps],
  );
  const richRequest = useMemo(
    () => createVideoThumbnailRequest(requestProps, requestFrameCount, true),
    [requestFrameCount, requestProps],
  );
  const snapshot = useVideoThumbnailSnapshot(
    measured ? posterRequest : null,
    measured && requestFrameCount > 1 ? richRequest : null,
    `${projectId}\0${videoSrc}`,
    `${projectId}\0${sessionEpoch}\0${videoSrc}`,
    {
      sourceStart: requestProps.sourceStart ?? 0,
      sourceRangeDuration: requestProps.sourceRangeDuration ?? requestProps.duration,
      frameCount: requestFrameCount,
    },
  );
  const previewAssetFailed = usePlayerStore((s) =>
    matchesFailedPreviewAsset(s.assetReadinessFailed, videoSrc),
  );
  const previewAssetRetrying = usePlayerStore((s) => s.assetReadinessRetrying);
  const handleReload = useCallback(() => {
    thumbnailScheduler.retryEntry(posterRequest);
    if (requestFrameCount > 1) {
      thumbnailScheduler.retryEntry(richRequest);
    }
    if (previewAssetFailed) {
      void triggerEditorAssetRetry();
    }
  }, [posterRequest, previewAssetFailed, requestFrameCount, richRequest]);
  const value = snapshot.status === "ready" ? snapshot.value : null;
  const urls = value?.kind === "filmstrip" ? value.urls : value?.kind === "image" ? [value.url] : [];
  const aspect = value && value.kind !== "waveform" ? value.aspect : 16 / 9;
  const { frameW, frameCount } = computeThumbnailStrip(container.width, aspect, container.height);
  const showLoadingShimmer = snapshot.status === "loading" && !localPreviewUrl;
  const thumbnailFailed = !localPreviewUrl && urls.length === 0 && snapshot.status === "error";
  const showError = thumbnailFailed || previewAssetFailed;

  return (
    <div ref={setContainerRef} className="absolute inset-0 overflow-hidden">
      {!urls.length && localPreviewUrl && (
        <img src={localPreviewUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      )}
      {urls.length > 0 && (
        <ThumbnailTiles
          strip={container}
          frameW={frameW}
          frameCount={frameCount}
          watchGap={watchGap}
        >
          {(index) => {
            const src = urls[thumbnailFrameForTile(index, frameCount, urls.length)];
            return (
              <div
                key={index}
                className="relative h-full shrink-0 overflow-hidden bg-neutral-900"
                style={{ width: frameW }}
              >
                <img
                  src={src}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
            );
          }}
        </ThumbnailTiles>
      )}
      {showLoadingShimmer && (
        <div
          className="absolute inset-0 animate-pulse motion-reduce:animate-none"
          style={{
            background: "var(--timeline-thumbnail-shimmer)",
          }}
        />
      )}
      {showError && (
        <ItemLoadErrorBadge
          nestedInButton
          compact={container.width > 0 && container.width < 96}
          reloading={previewAssetFailed && previewAssetRetrying}
          onReload={handleReload}
        />
      )}
      {label && (
        <div
          className="absolute inset-x-0 bottom-0 z-10 px-1.5 pb-0.5 pt-3"
          style={{
            background: "var(--timeline-thumbnail-label-gradient)",
          }}
        >
          <span
            className="block truncate text-[9px] font-semibold leading-tight"
            style={{ color: labelColor, textShadow: "var(--timeline-thumbnail-label-shadow)" }}
          >
            {label}
          </span>
        </div>
      )}
    </div>
  );
});
