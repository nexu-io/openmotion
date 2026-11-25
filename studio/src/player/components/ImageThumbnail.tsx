import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useThumbnailLease } from "../../hooks/useThumbnailLease";
import { useThumbnailStripSize } from "../../hooks/useThumbnailStripSize";
import {
  createThumbnailKey,
  thumbnailScheduler,
  type ThumbnailPriority,
} from "../lib/thumbnailScheduler";
import { decodeImageThumbnail } from "../lib/thumbnailImageDecoder";
import {
  matchesFailedPreviewAsset,
  withRetryQueryParam,
} from "../lib/previewAssetReadiness";
import { usePlayerStore } from "../store/playerStore";
import { triggerEditorAssetRetry } from "../../components/EditorAssetLoadingOverlay";
import { ItemLoadErrorBadge } from "../../components/ui/ItemLoadErrorBadge";
import { ThumbnailTiles } from "./ThumbnailTiles";
import { computeThumbnailStrip } from "./thumbnailUtils";

export interface ImageThumbnailProps {
  imageSrc: string;
  label: string;
  labelColor: string;
  projectId?: string;
  sessionEpoch?: number;
  priority?: ThumbnailPriority;
  rich?: boolean;
}

/** A scheduler-backed still-image strip. Mounting is the sole work trigger. */
export const ImageThumbnail = memo(function ImageThumbnail({
  imageSrc,
  label,
  labelColor,
  projectId = imageSrc,
  sessionEpoch = 0,
  priority = "visible",
  rich = false,
}: ImageThumbnailProps) {
  const [container, setContainerRef, watchGap] = useThumbnailStripSize();
  const [retryAttempt, setRetryAttempt] = useState(0);
  useEffect(() => {
    setRetryAttempt(0);
  }, [imageSrc]);
  const effectiveSrc = useMemo(() => {
    if (retryAttempt <= 0) return imageSrc;
    const baseHref = typeof window !== "undefined" ? window.location.href : undefined;
    return withRetryQueryParam(imageSrc, retryAttempt, baseHref) ?? imageSrc;
  }, [imageSrc, retryAttempt]);

  const request = useMemo(
    () => ({
      key: createThumbnailKey({ kind: "image", source: effectiveSrc, rich: Number(rich) }),
      projectId,
      sessionEpoch,
      kind: "image" as const,
      priority,
      rich,
      load: (signal: AbortSignal) => decodeImageThumbnail(effectiveSrc, signal),
    }),
    [effectiveSrc, priority, projectId, rich, sessionEpoch],
  );
  const snapshot = useThumbnailLease(request);
  const previewAssetFailed = usePlayerStore((s) =>
    matchesFailedPreviewAsset(s.assetReadinessFailed, imageSrc),
  );
  const previewAssetRetrying = usePlayerStore((s) => s.assetReadinessRetrying);
  const handleReload = useCallback(() => {
    if (snapshot.status === "error") {
      const baseHref = typeof window !== "undefined" ? window.location.href : undefined;
      if (withRetryQueryParam(imageSrc, retryAttempt + 1, baseHref)) {
        setRetryAttempt((attempt) => attempt + 1);
      } else {
        thumbnailScheduler.retryEntry(request);
      }
    }
    if (previewAssetFailed) {
      void triggerEditorAssetRetry();
    }
  }, [imageSrc, previewAssetFailed, request, retryAttempt, snapshot.status]);

  const value = snapshot.status === "ready" ? snapshot.value : null;
  const aspect = value?.kind === "image" ? value.aspect : 16 / 9;
  const { frameW, frameCount } = computeThumbnailStrip(container.width, aspect, container.height);
  const showError = snapshot.status === "error" || previewAssetFailed;

  return (
    <div ref={setContainerRef} className="absolute inset-0 overflow-hidden">
      {value?.kind === "image" && (
        <ThumbnailTiles
          strip={container}
          frameW={frameW}
          frameCount={frameCount}
          watchGap={watchGap}
        >
          {(index) => (
            <div
              key={index}
              className="relative h-full shrink-0 overflow-hidden bg-neutral-900"
              style={{ width: frameW }}
            >
              <img
                src={value.url}
                alt=""
                draggable={false}
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
          )}
        </ThumbnailTiles>
      )}
      {snapshot.status === "loading" && (
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
