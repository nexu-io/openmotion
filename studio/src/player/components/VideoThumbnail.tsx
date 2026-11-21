import { useI18n } from "../../i18n/I18n";
import { memo, useEffect, useMemo, useState } from "react";
import { useThumbnailLease } from "../../hooks/useThumbnailLease";
import { useThumbnailStripSize } from "../../hooks/useThumbnailStripSize";
import { useCloudDisklessMode } from "../../utils/cloudRuntime";
import { useLocalUploadPreview } from "../../utils/localUploadPreviewStore";
import {
  createThumbnailKey,
  thumbnailScheduler,
  type ThumbnailPriority,
  type ThumbnailSnapshot,
} from "../lib/thumbnailScheduler";
import { bindThumbnailPlaybackHold } from "../lib/thumbnailPlaybackHold";
import {
  computeSpriteFrameSlice,
  loadSpriteManifest,
  resolveSpriteManifestUrl,
  resolveVideoPosterUrl,
  type SpriteManifestData,
} from "../lib/spriteThumbnailLoader";
import { decodeVideoThumbnail } from "../lib/thumbnailVideoDecoder";
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

function createVideoThumbnailRequest(
  props: Pick<VideoThumbnailProps, "videoSrc" | "sourceStart" | "sourceRangeDuration"> &
    Required<Pick<VideoThumbnailProps, "duration" | "projectId" | "sessionEpoch" | "priority">>,
  frameCount: number,
  rich: boolean,
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
  return {
    key: createThumbnailKey({
      kind: "video",
      source: videoSrc,
      start: sourceStart,
      duration: sourceRangeDuration ?? duration,
      frames: frameCount,
    }),
    projectId,
    sessionEpoch,
    kind: "video" as const,
    priority,
    rich,
    load: (signal: AbortSignal) =>
      decodeVideoThumbnail(
        {
          source: videoSrc,
          contentVersion: createThumbnailKey({ project: projectId, session: sessionEpoch }),
          sourceStart,
          sourceRangeDuration: sourceRangeDuration ?? duration,
          frameCount,
          fit: "cover",
        },
        signal,
      ),
  };
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
): ThumbnailSnapshot {
  const posterSnapshot = useThumbnailLease(poster);
  const richSnapshot = useThumbnailLease(rich);
  const [shown, setShown] = useState({ media, request: rich });
  const settled = richSnapshot.status === "ready" || rich === null;
  if (settled && shown.request !== rich) setShown({ media, request: rich });
  const shownSnapshot = useThumbnailLease(shown.media === media ? shown.request : null);
  return selectThumbnailSnapshot(posterSnapshot, richSnapshot, shownSnapshot);
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

type CloudSpriteState =
  | { status: "disabled"; manifest: null }
  | { status: "loading"; manifest: null }
  | { status: "ready"; manifest: SpriteManifestData }
  | { status: "fallback"; manifest: null };

function useCloudVideoSprite(spriteUrl: string | null, enabled: boolean): CloudSpriteState {
  const [state, setState] = useState<CloudSpriteState>(() =>
    enabled && spriteUrl ? { status: "loading", manifest: null } : { status: "disabled", manifest: null },
  );

  useEffect(() => {
    if (!enabled || !spriteUrl) {
      setState({ status: "disabled", manifest: null });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading", manifest: null });
    void loadSpriteManifest(spriteUrl, controller.signal).then((manifest) => {
      if (cancelled) return;
      if (manifest) {
        setState({ status: "ready", manifest });
      } else {
        setState({ status: "fallback", manifest: null });
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, spriteUrl]);

  return state;
}

/** Sparse, bounded video frames supplied by cloud sprite sheets (preferred) or the shared thumbnail scheduler. */
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
  const isCloudMode = useCloudDisklessMode();
  const [container, setContainerRef, watchGap] = useThumbnailStripSize();
  const [posterFailed, setPosterFailed] = useState(false);
  const spriteUrl = useMemo(() => (isCloudMode ? resolveSpriteManifestUrl(videoSrc) : null), [isCloudMode, videoSrc]);
  const posterUrl = useMemo(() => (isCloudMode ? resolveVideoPosterUrl(videoSrc, 320) : null), [isCloudMode, videoSrc]);
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
  const effectivePosterUrl = (!posterFailed && posterUrl) || localPreviewUrl || null;
  useEffect(() => {
    setPosterFailed(false);
  }, [posterUrl]);

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
  const sprite = useCloudVideoSprite(spriteUrl, measured && Boolean(spriteUrl));
  const useClientDecoder = !spriteUrl || sprite.status === "fallback";

  const posterRequest = useMemo(
    () => createVideoThumbnailRequest(requestProps, 1, false),
    [requestProps],
  );
  const richRequest = useMemo(
    () => createVideoThumbnailRequest(requestProps, requestFrameCount, true),
    [requestFrameCount, requestProps],
  );
  const snapshot = useVideoThumbnailSnapshot(
    measured && useClientDecoder ? posterRequest : null,
    measured && useClientDecoder && requestFrameCount > 1 ? richRequest : null,
    posterRequest.key,
  );

  const spriteManifest = sprite.status === "ready" ? sprite.manifest : null;
  const value = !spriteManifest && snapshot.status === "ready" ? snapshot.value : null;
  const urls =
    value?.kind === "filmstrip" ? value.urls : value?.kind === "image" ? [value.url] : [];
  const aspect = spriteManifest
    ? spriteManifest.frameWidth / spriteManifest.frameHeight
    : value?.kind === "image" || value?.kind === "filmstrip"
      ? value.aspect
      : 16 / 9;
  const { frameW, frameCount } = computeThumbnailStrip(container.width, aspect, container.height);
  const effectiveSourceStart = sourceStart ?? 0;
  const effectiveRangeDuration = sourceRangeDuration ?? duration;
  const showLoadingShimmer =
    (sprite.status === "loading" && !effectivePosterUrl) ||
    (useClientDecoder && snapshot.status === "loading" && urls.length === 0);

  return (
    <div ref={setContainerRef} className="absolute inset-0 overflow-hidden">
      {spriteManifest && container.height > 0 && (
        <ThumbnailTiles
          strip={container}
          frameW={frameW}
          frameCount={frameCount}
          watchGap={watchGap}
        >
          {(index) => {
            const sampleTime =
              effectiveSourceStart +
              ((index + 0.5) / Math.max(1, frameCount)) * Math.max(0.01, effectiveRangeDuration);
            const slice = computeSpriteFrameSlice(spriteManifest, sampleTime, frameW, container.height);
            return (
              <div
                key={index}
                data-sprite-tile={index}
                className="relative h-full shrink-0 overflow-hidden bg-neutral-900"
                style={{
                  width: frameW,
                  backgroundImage: `url("${slice.sheetUrl}")`,
                  backgroundSize: slice.backgroundSize,
                  backgroundPosition: slice.backgroundPosition,
                  backgroundRepeat: "no-repeat",
                }}
              />
            );
          }}
        </ThumbnailTiles>
      )}
      {sprite.status === "loading" && effectivePosterUrl && (
        <img
          src={effectivePosterUrl}
          alt=""
          draggable={false}
          onError={() => {
            if (effectivePosterUrl === posterUrl) setPosterFailed(true);
          }}
          className="absolute inset-0 h-full w-full object-cover opacity-80"
        />
      )}
      {!spriteManifest && urls.length > 0 && (
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
      {useClientDecoder && snapshot.status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/60">
          <span className="rounded-sm bg-black/50 px-1 text-[8px] text-neutral-500">
            {t("no preview")}</span>
        </div>
      )}
      {sprite.status === "loading" && (
        <span
          data-sprite-optimizing="true"
          className="pointer-events-none absolute top-1 right-1 z-10 inline-flex items-center gap-1 rounded-sm bg-neutral-950/75 px-1 py-px text-[8px] font-medium leading-none text-neutral-200"
        >
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-studio-accent motion-reduce:animate-none"
          />
          {t("Optimizing")}
        </span>
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
