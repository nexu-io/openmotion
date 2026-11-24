import { useI18n } from "../../i18n/I18n";
import { memo, useEffect, useMemo, useState } from "react";
import { useThumbnailLease } from "../../hooks/useThumbnailLease";
import { useThumbnailStripSize } from "../../hooks/useThumbnailStripSize";
import { useLocalUploadPreview } from "../../utils/localUploadPreviewStore";
import {
  thumbnailScheduler,
  type ThumbnailPriority,
  type ThumbnailSnapshot,
} from "../lib/thumbnailScheduler";
import { bindThumbnailPlaybackHold } from "../lib/thumbnailPlaybackHold";
import { createVideoThumbnailRequest } from "../lib/videoThumbnailRequest";
import { usePlayerStore } from "../store/playerStore";
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
): ThumbnailSnapshot {
  if (rich.status === "ready") return rich;
  if (shown.status === "ready") return shown;
  if (poster.status === "ready") return poster;
  if (rich.status === "loading" || poster.status === "loading") return { status: "loading" };
  return poster;
}

type VideoThumbnailRequest = ReturnType<typeof createVideoThumbnailRequest>;

function useVideoThumbnailSnapshot(
  poster: VideoThumbnailRequest | null,
  rich: VideoThumbnailRequest | null,
  media: string,
): { snapshot: ThumbnailSnapshot; settled: boolean } {
  const posterSnapshot = useThumbnailLease(poster);
  const richSnapshot = useThumbnailLease(rich);
  const [shown, setShown] = useState({ media, request: rich });
  const richSettled = richSnapshot.status === "ready" || rich === null;
  if (richSettled && (shown.media !== media || shown.request !== rich)) setShown({ media, request: rich });
  const shownSnapshot = useThumbnailLease(shown.media === media ? shown.request : null);
  const snapshot = selectThumbnailSnapshot(posterSnapshot, richSnapshot, shownSnapshot);
  const settled = rich
    ? richSnapshot.status === "ready" || richSnapshot.status === "error"
    : poster
      ? posterSnapshot.status === "ready" || posterSnapshot.status === "error"
      : false;
  return { snapshot, settled };
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
  const { t } = useI18n();
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
  const { snapshot, settled: videoStripSettled } = useVideoThumbnailSnapshot(
    measured ? posterRequest : null,
    measured && requestFrameCount > 1 ? richRequest : null,
    `${projectId}\0${videoSrc}`,
  );
  const loadGeneration = usePlayerStore((s) => s.assetReadinessGeneration);
  const timelinePreviewSettledInitial = usePlayerStore((s) => s.timelinePreviewSettledInitial);
  const gateTaskId = useMemo(
    () =>
      measured && priority !== "overscan" && !localPreviewUrl && !timelinePreviewSettledInitial
        ? `video:${projectId}:${videoSrc}`
        : null,
    [localPreviewUrl, measured, priority, projectId, timelinePreviewSettledInitial, videoSrc],
  );

  useEffect(() => {
    if (!gateTaskId) return;
    usePlayerStore.getState().registerTimelinePreviewTask(gateTaskId, loadGeneration);
    return () => {
      usePlayerStore.getState().settleTimelinePreviewTask(gateTaskId, loadGeneration);
    };
  }, [gateTaskId, loadGeneration]);

  useEffect(() => {
    if (!gateTaskId || (!videoStripSettled && !localPreviewUrl)) return;
    usePlayerStore.getState().settleTimelinePreviewTask(gateTaskId, loadGeneration);
  }, [gateTaskId, loadGeneration, localPreviewUrl, videoStripSettled]);

  const value = snapshot.status === "ready" ? snapshot.value : null;
  const urls = value?.kind === "filmstrip" ? value.urls : value?.kind === "image" ? [value.url] : [];
  const aspect = value && value.kind !== "waveform" ? value.aspect : 16 / 9;
  const { frameW, frameCount } = computeThumbnailStrip(container.width, aspect, container.height);
  const showLoadingShimmer = snapshot.status === "loading" && !localPreviewUrl;

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
      {!localPreviewUrl && snapshot.status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/60">
          <span className="rounded-sm bg-black/50 px-1 text-[8px] text-neutral-500">
            {t("no preview")}</span>
        </div>
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
