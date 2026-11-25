import { isolatedPreviewOrigin } from "../../player/lib/previewLease";
import { IsolatedHoverPlayer } from "../../player/components/IsolatedHoverPlayer";
import { IconButton } from "open-design-ui/icon-button";
import { RemixIcon } from "../../icons/RemixIcons";
import { useI18n } from "../../i18n/I18n";
import { buildProjectApiPath } from "../../utils/projectRouting";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { useThumbnailLease } from "../../hooks/useThumbnailLease";
import {
  thumbnailScheduler,
  type ThumbnailRequest,
  type ThumbnailSnapshot,
  type ThumbnailValue,
} from "../../player/lib/thumbnailScheduler";
import {
  buildCompositionThumbnailUrl,
  compositionThumbnailRequest,
  resolveThumbnailSeekTime,
  THUMBNAIL_SEEK_TIME_SECONDS,
} from "../../player/components/CompositionThumbnail";
import { getCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import {
  acquireCachedCompositionCaptureFromIdb,
  canCaptureCompositionInBrowser,
  createClientCompositionCaptureRequest,
  getCompositionCacheKeyRevision,
  peekCachedCompositionCapture,
  peekFallbackCompositionCapture,
  retainCachedCompositionCapture,
  subscribeCompositionCacheRevision,
} from "../../player/lib/clientCompositionCapture";
import { setPreviewMediaMuted } from "../../player/lib/timelineIframeHelpers";
import { postFrameDisplayScale } from "../../player/lib/runtimeProtocol";
import { usePlayerStore } from "../../player/store/playerStore";
import { thumbnailRevisionOf } from "../../player/store/thumbnailSlice";
import { encodePreviewPath } from "../../player/components/thumbnailUtils";
import { SpriteFrame } from "../../player/components/SpriteFrame";
import { TIMELINE_COMPOSITION_MIME } from "../../utils/timelineCompositionDrop";
import { useDockPanelVisible } from "../dock/Dock";
import { ItemLoadErrorBadge } from "../ui/ItemLoadErrorBadge";
import { Tooltip } from "../ui/Tooltip";
import { OverflowText } from "../ui/OverflowText";

interface CompositionsTabProps {
  projectId: string;
  compositions: string[];
  activeComposition: string | null;
  /** The project's root composition (same value App.tsx auto-opens on load), or null if none. */
  masterCompositionPath?: string | null;
  onSelect: (comp: string) => void;
  onRenderComposition?: (comp: string) => void;
  onAddToTimeline?: (comp: string) => void;
  isRendering?: boolean;
  lintFindingsByFile?: Map<string, { count: number; messages: string[] }>;
}

const DEFAULT_PREVIEW_STAGE = { width: 1920, height: 1080 };
const CARD_W = 80;
const CARD_H = 45;
const THUMBNAIL_PLAYBACK_SYNC_ATTEMPTS = 10;
const SPRITE_HOVER_DEBOUNCE_MS = 120;
const SPRITE_HOVER_INTERVAL_MS = 360;
const IFRAME_HOVER_DEBOUNCE_MS = 300;

type PreviewWindow = Window & {
  __player?: {
    play?: () => void;
    pause?: () => void;
    seek?: (time: number) => void;
    getDuration?: () => number;
  };
};

export function resolveCompositionPreviewScale(input: {
  cardWidth: number;
  cardHeight: number;
  stageWidth: number;
  stageHeight: number;
}): number {
  const safeStageWidth =
    Number.isFinite(input.stageWidth) && input.stageWidth > 0
      ? input.stageWidth
      : DEFAULT_PREVIEW_STAGE.width;
  const safeStageHeight =
    Number.isFinite(input.stageHeight) && input.stageHeight > 0
      ? input.stageHeight
      : DEFAULT_PREVIEW_STAGE.height;
  const scaleX = input.cardWidth / safeStageWidth;
  const scaleY = input.cardHeight / safeStageHeight;
  return Math.min(scaleX, scaleY);
}

function compositionPreviewUrl(projectId: string, comp: string): string {
  return buildProjectApiPath(projectId, `/preview/comp/${encodePreviewPath(comp)}`);
}

export function compositionCardThumbnailUrl(
  projectId: string,
  comp: string,
  contentRevision: number,
): string {
  return buildCompositionThumbnailUrl({
    previewUrl: compositionPreviewUrl(projectId, comp),
    seekTime: THUMBNAIL_SEEK_TIME_SECONDS,
    duration: 0,
    origin: window.location.origin,
    contentRevision,
  });
}

function parsePositiveNumber(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// fallow-ignore-next-line complexity
function resolveIframeDuration(iframe: HTMLIFrameElement | null): number | null {
  try {
    const win = iframe?.contentWindow as PreviewWindow | null;
    const playerDuration = win?.__player?.getDuration?.();
    if (Number.isFinite(playerDuration) && playerDuration != null && playerDuration > 0) {
      return playerDuration;
    }
  } catch {
    /* cross-origin iframe */
  }

  try {
    const doc = iframe?.contentDocument;
    const root = doc?.querySelector("[data-composition-id]") ?? doc?.documentElement ?? null;
    return (
      parsePositiveNumber(root?.getAttribute("data-composition-duration") ?? null) ??
      parsePositiveNumber(root?.getAttribute("data-duration") ?? null)
    );
  } catch {
    return null;
  }
}

export function syncIframePlayback(iframe: HTMLIFrameElement | null, shouldPlay: boolean): boolean {
  try {
    const player = (iframe?.contentWindow as PreviewWindow | null)?.__player;
    if (!player) return false;

    if (shouldPlay) {
      setPreviewMediaMuted(iframe, true);
      player.play?.();
      return true;
    }

    player.pause?.();
    player.seek?.(resolveThumbnailSeekTime(resolveIframeDuration(iframe)));
    return true;
  } catch {
    return false;
  }
}

const coverFrameCount = (value: ThumbnailValue | null | undefined): number =>
  value?.kind === "sprite"
    ? Math.max(0, value.frameCount)
    : value?.kind === "filmstrip"
      ? value.urls.length
      : value?.kind === "image" && value.url
        ? 1
        : 0;

const coverUrlOf = (value: ThumbnailValue | null | undefined): string | null =>
  value?.kind === "image"
    ? value.url
    : value?.kind === "sprite"
      ? (value.frameCount > 0 ? value.url : null)
      : value?.kind === "filmstrip"
        ? (value.urls[Math.min(value.urls.length - 1, Math.floor(value.urls.length / 2))] ?? value.urls[0] ?? null)
        : null;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const imageUrlOf = (snapshot: ThumbnailSnapshot) =>
  snapshot.status === "ready" ? coverUrlOf(snapshot.value) : null;

// A layout effect takes the old frame's lease before the passive cleanup drops the first one.
// Preserves the last shown frame across transient null requests (e.g. IDB probe on revision bump)
// while releasing its scheduler lease as soon as the card leaves the viewport or panel hides.
function useLastFrame(
  request: ThumbnailRequest | null,
  snapshot: ThumbnailSnapshot,
  keepLease: boolean,
  identityKey: string,
) {
  const current = imageUrlOf(snapshot);
  const [kept, setKept] = useState<{
    identityKey: string;
    request: ThumbnailRequest;
    url: string;
  } | null>(null);
  if (kept && (!keepLease || kept.identityKey !== identityKey)) setKept(null);
  if (
    keepLease &&
    request &&
    current &&
    (kept?.request !== request || kept.identityKey !== identityKey)
  ) {
    setKept({ identityKey, request, url: current });
  }
  useLayoutEffect(() => {
    if (!keepLease || !kept || kept.identityKey !== identityKey || kept.request === request) return;
    const lease = thumbnailScheduler.acquire(kept.request, () => {});
    return () => lease.release();
  }, [identityKey, keepLease, kept, request]);
  return current ?? (keepLease && kept?.identityKey === identityKey ? kept.url : null);
}

/** Retain a cloud-captured cover across revision bumps / IDB checks so edits never flash back to loading. */
function useRetainedCardCover({
  captureEnabled,
  projectId,
  previewUrl,
  coverIdentity,
  compCacheRev,
  settledCover,
  captureFailed,
}: {
  captureEnabled: boolean;
  projectId: string;
  previewUrl: string;
  coverIdentity: string;
  compCacheRev: string;
  settledCover: ThumbnailValue | null;
  captureFailed: boolean;
}): ThumbnailValue | null {
  const fallbackCachedCover = useMemo(() => {
    if (!captureEnabled || settledCover || captureFailed) return null;
    const candidate = peekFallbackCompositionCapture({ projectId, previewUrl });
    return coverUrlOf(candidate) ? candidate : null;
  }, [captureEnabled, captureFailed, compCacheRev, previewUrl, projectId, settledCover]);

  const [retained, setRetained] = useState<{
    identity: string;
    value: ThumbnailValue;
  } | null>(null);

  if (!captureEnabled || captureFailed) {
    if (retained !== null) setRetained(null);
  } else if (settledCover) {
    if (retained?.identity !== coverIdentity || retained.value !== settledCover) {
      setRetained({ identity: coverIdentity, value: settledCover });
    }
  } else if (retained && retained.identity !== coverIdentity) {
    setRetained(
      fallbackCachedCover ? { identity: coverIdentity, value: fallbackCachedCover } : null,
    );
  } else if (!retained && fallbackCachedCover) {
    setRetained({ identity: coverIdentity, value: fallbackCachedCover });
  }

  const activeRetained =
    !captureEnabled || captureFailed
      ? null
      : settledCover ??
        (retained?.identity === coverIdentity ? retained.value : fallbackCachedCover);

  useLayoutEffect(() => retainCachedCompositionCapture(activeRetained), [activeRetained]);
  return activeRetained;
}

function useNearViewport<T extends Element>(enabled: boolean): [(element: T | null) => void, boolean] {
  const [element, setElement] = useState<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!enabled || !element) {
      setNear(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root: element.closest("[data-composition-list]"), rootMargin: "80px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled]);
  return [setElement, enabled && near];
}

// fallow-ignore-next-line complexity
function CompCard({
  projectId,
  comp,
  coverComp = comp,
  isActive,
  isRoot,
  onSelect,
  onRender,
  isRendering,
  onAddToTimeline,
  contentRevision,
  coverContentRevision = contentRevision,
}: {
  projectId: string;
  comp: string;
  coverComp?: string;
  isActive: boolean;
  isRoot: boolean;
  onSelect: () => void;
  onRender?: () => void;
  isRendering?: boolean;
  onAddToTimeline?: () => void;
  contentRevision: number;
  coverContentRevision?: number;
}) {
  const { t } = useI18n();
  const panelVisible = useDockPanelVisible();
  const previewOrigin = isolatedPreviewOrigin();
  const [hovered, setHovered] = useState(false);
  const [spriteHoverActive, setSpriteHoverActive] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoverFrameIndex, setHoverFrameIndex] = useState<number | null>(null);
  const [stageSize, setStageSize] = useState(DEFAULT_PREVIEW_STAGE);
  const [livePreviewLoaded, setLivePreviewLoaded] = useState(false);
  const [loadedFrameUrl, setLoadedFrameUrl] = useState<string | null>(null);
  const [renderedCoverIdentity, setRenderedCoverIdentity] = useState<string | null>(null);
  const [failedFrameUrl, setFailedFrameUrl] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggedRef = useRef(false);

  const requestIframePlaybackSync = useCallback((shouldPlay: boolean) => {
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }

    const sync = (remainingAttempts: number) => {
      if (syncIframePlayback(iframeRef.current, shouldPlay) || remainingAttempts <= 0) return;

      syncTimer.current = setTimeout(() => sync(remainingAttempts - 1), 100);
    };

    sync(THUMBNAIL_PLAYBACK_SYNC_ATTEMPTS);
  }, []);

  const stopHoverPreview = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }
    setHovered(false);
    setSpriteHoverActive(false);
    setIsScrubbing(false);
    setHoverFrameIndex(null);
    setLivePreviewLoaded(false);
  }, []);

  useEffect(() => {
    if (!panelVisible) stopHoverPreview();
  }, [panelVisible, stopHoverPreview]);

  const openComposition = () => {
    stopHoverPreview();
    onSelect();
  };
  const name = comp.replace(/^compositions\//, "").replace(/\.html$/, "");
  const previewUrl = compositionPreviewUrl(projectId, comp);
  const coverPreviewUrl = compositionPreviewUrl(projectId, coverComp);
  const coverIdentity = `${projectId}|${coverComp}`;
  const thumbnailUrl = compositionCardThumbnailUrl(projectId, coverComp, coverContentRevision);
  const [thumbnailBox, nearViewport] = useNearViewport<HTMLDivElement>(panelVisible);
  const timelineSessionEpoch = usePlayerStore((state) => state.timelineSessionEpoch);
  const captureEnabled = nearViewport && getCachedCloudDisklessMode() && canCaptureCompositionInBrowser();
  const subscribeCacheRev = useCallback(
    (listener: () => void) =>
      captureEnabled ? subscribeCompositionCacheRevision(projectId, listener) : () => {},
    [captureEnabled, projectId],
  );
  const getCacheRev = useCallback(
    () =>
      captureEnabled
        ? getCompositionCacheKeyRevision(projectId, coverPreviewUrl, coverContentRevision)
        : "",
    [captureEnabled, coverContentRevision, coverPreviewUrl, projectId],
  );
  const compCacheRev = useSyncExternalStore(subscribeCacheRev, getCacheRev, () => "");
  const captureContentRevision = compCacheRev.startsWith("file:") ? 0 : coverContentRevision;
  const syncCachedCover = useMemo(
    () =>
      captureEnabled
        ? peekCachedCompositionCapture({
            previewUrl: coverPreviewUrl,
            projectId,
            contentRevision: captureContentRevision,
            frameCount: 1,
            preferMultiFrame: true,
          })
        : null,
    [captureContentRevision, captureEnabled, compCacheRev, coverPreviewUrl, projectId],
  );
  // Keep cached cover object URLs alive while this card renders them, even after LRU eviction.
  useLayoutEffect(() => retainCachedCompositionCapture(syncCachedCover), [syncCachedCover]);
  const coverProbeKey = captureEnabled
    ? `${projectId}|${coverPreviewUrl}|${compCacheRev}|${captureContentRevision}`
    : null;
  const [idbCoverProbe, setIdbCoverProbe] = useState<{
    key: string;
    value: ReturnType<typeof peekCachedCompositionCapture>;
  } | null>(null);
  useEffect(() => {
    if (!coverProbeKey || syncCachedCover) return;
    let cancelled = false;
    let releaseLease: (() => void) | null = null;
    void acquireCachedCompositionCaptureFromIdb({
      previewUrl: coverPreviewUrl,
      projectId,
      contentRevision: captureContentRevision,
      frameCount: 1,
      preferMultiFrame: true,
    })
      .then((lease) => {
        if (cancelled) {
          lease?.release();
          return;
        }
        releaseLease = lease?.release ?? null;
        setIdbCoverProbe({ key: coverProbeKey, value: lease?.value ?? null });
      })
      .catch(() => {
        if (!cancelled) setIdbCoverProbe({ key: coverProbeKey, value: null });
      });
    return () => {
      cancelled = true;
      releaseLease?.();
      releaseLease = null;
    };
  }, [captureContentRevision, coverPreviewUrl, coverProbeKey, projectId, syncCachedCover]);
  const idbCachedCover =
    coverProbeKey && idbCoverProbe?.key === coverProbeKey ? idbCoverProbe.value : null;
  const cachedCover = syncCachedCover ?? idbCachedCover;
  const idbCoverPending = Boolean(
    coverProbeKey && !syncCachedCover && idbCoverProbe?.key !== coverProbeKey,
  );
  const captureRequest = useMemo(
    () =>
      captureEnabled && !cachedCover && !idbCoverPending
        ? createClientCompositionCaptureRequest({
            previewUrl: coverPreviewUrl,
            projectId,
            sessionEpoch: timelineSessionEpoch,
            contentRevision: captureContentRevision,
            frameCount: 1,
            seekTime: THUMBNAIL_SEEK_TIME_SECONDS,
            priority: "overscan",
            rich: true,
          })
        : null,
    [
      cachedCover,
      captureContentRevision,
      captureEnabled,
      compCacheRev,
      coverPreviewUrl,
      idbCoverPending,
      projectId,
      timelineSessionEpoch,
    ],
  );
  const captureThumbnail = useThumbnailLease(captureRequest);
  const settledCover =
    cachedCover ??
    (captureThumbnail.status === "ready" && coverUrlOf(captureThumbnail.value)
      ? captureThumbnail.value
      : null);
  const activeRetainedCover = useRetainedCardCover({
    captureEnabled,
    projectId,
    previewUrl: coverPreviewUrl,
    coverIdentity,
    compCacheRev,
    settledCover,
    captureFailed: captureThumbnail.status === "error",
  });
  const thumbnailRequest = useMemo(
    () =>
      nearViewport && !cachedCover && !idbCoverPending && !activeRetainedCover
        ? compositionThumbnailRequest(thumbnailUrl, projectId, {
            sessionEpoch: timelineSessionEpoch,
            rich: true,
          })
        : null,
    [
      activeRetainedCover,
      cachedCover,
      idbCoverPending,
      nearViewport,
      projectId,
      thumbnailUrl,
      timelineSessionEpoch,
    ],
  );
  const posterThumbnail = useThumbnailLease(thumbnailRequest);
  const activeRequest = activeRetainedCover
    ? null
    : captureThumbnail.status === "ready"
      ? captureRequest
      : thumbnailRequest;
  const thumbnail: ThumbnailSnapshot = activeRetainedCover
    ? { status: "ready", value: activeRetainedCover }
    : captureThumbnail.status === "ready"
      ? captureThumbnail
      : posterThumbnail;
  const lastFrameUrl = useLastFrame(activeRequest, thumbnail, nearViewport, coverIdentity);
  const displayedCoverValue =
    activeRetainedCover ?? (thumbnail.status === "ready" ? thumbnail.value : null);
  const totalCoverFrames = coverFrameCount(displayedCoverValue);
  const hasMultiFramePreview =
    totalCoverFrames > 1 &&
    (displayedCoverValue?.kind === "sprite" || displayedCoverValue?.kind === "filmstrip");
  const defaultFrameIndex = totalCoverFrames > 1 ? Math.floor(totalCoverFrames / 2) : 0;
  const activeFrameIndex =
    hoverFrameIndex !== null
      ? Math.max(0, Math.min(totalCoverFrames - 1, hoverFrameIndex))
      : defaultFrameIndex;
  const spriteCoverValue =
    displayedCoverValue?.kind === "sprite" &&
    displayedCoverValue.frameCount > 0 &&
    displayedCoverValue.url !== failedFrameUrl
      ? displayedCoverValue
      : null;
  const activeFilmstripUrl =
    displayedCoverValue?.kind === "filmstrip" && displayedCoverValue.urls.length > 0
      ? (displayedCoverValue.urls[activeFrameIndex] ?? displayedCoverValue.urls[0] ?? null)
      : null;
  const frameUrl = activeFilmstripUrl ?? coverUrlOf(activeRetainedCover) ?? lastFrameUrl;
  const thumbnailFailed = thumbnail.status === "error";
  const posterUrl =
    spriteCoverValue || thumbnailFailed || frameUrl === failedFrameUrl ? null : frameUrl;
  const posterLoaded = Boolean(spriteCoverValue) || (!!posterUrl && loadedFrameUrl === posterUrl);
  const hasRenderedCover = Boolean(spriteCoverValue) || (Boolean(posterUrl) && renderedCoverIdentity === coverIdentity);
  const posterRequestFailed = Boolean(thumbnailRequest) && posterThumbnail.status === "error";
  const captureRequestFailed = captureEnabled
    ? Boolean(captureRequest) && captureThumbnail.status === "error"
    : true;
  const imageElementFailed = Boolean(frameUrl && failedFrameUrl === frameUrl);
  const showCoverError =
    !spriteCoverValue &&
    !activeRetainedCover &&
    !livePreviewLoaded &&
    !idbCoverPending &&
    !posterLoaded &&
    !hasRenderedCover &&
    (imageElementFailed || (posterRequestFailed && captureRequestFailed));
  const handleEnter = () => {
    if (!panelVisible) return;
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (hasMultiFramePreview) {
      hoverTimer.current = setTimeout(() => {
        setSpriteHoverActive(true);
      }, SPRITE_HOVER_DEBOUNCE_MS);
      return;
    }
    hoverTimer.current = setTimeout(() => setHovered(true), IFRAME_HOVER_DEBOUNCE_MS);
  };
  const handleThumbnailPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!panelVisible || !hasMultiFramePreview) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(0.9999, (event.clientX - rect.left) / rect.width));
    const nextIdx = Math.floor(ratio * totalCoverFrames);
    setIsScrubbing(true);
    setHoverFrameIndex(nextIdx);
  };
  const handleThumbnailPointerLeave = () => {
    setIsScrubbing(false);
  };
  const shouldMountIframeHover = hovered && panelVisible && !hasMultiFramePreview;

  useEffect(() => {
    if (!hasMultiFramePreview || !spriteHoverActive || !panelVisible || isScrubbing) return;
    if (prefersReducedMotion()) return;
    setHoverFrameIndex((prev) => (prev === null ? 0 : (prev + 1) % totalCoverFrames));
    const interval = setInterval(() => {
      setHoverFrameIndex((prev) => (prev === null ? 0 : (prev + 1) % totalCoverFrames));
    }, SPRITE_HOVER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasMultiFramePreview, isScrubbing, panelVisible, spriteHoverActive, totalCoverFrames]);

  const handleReloadCover = useCallback(() => {
    setFailedFrameUrl(null);
    let retried = false;
    if (captureRequest && thumbnailScheduler.retryEntry(captureRequest)) retried = true;
    if (thumbnailRequest && thumbnailScheduler.retryEntry(thumbnailRequest)) retried = true;
    if (!retried) {
      thumbnailScheduler.retryFailed(projectId, coverComp);
    }
  }, [captureRequest, coverComp, projectId, thumbnailRequest]);
  const previewScale = resolveCompositionPreviewScale({
    cardWidth: CARD_W,
    cardHeight: CARD_H,
    stageWidth: stageSize.width,
    stageHeight: stageSize.height,
  });
  const thumbnailOffsetX = (CARD_W - stageSize.width * previewScale) / 2;
  const thumbnailOffsetY = (CARD_H - stageSize.height * previewScale) / 2;

  useEffect(() => {
    if (shouldMountIframeHover && !previewOrigin) requestIframePlaybackSync(true);
  }, [shouldMountIframeHover, previewOrigin, requestIframePlaybackSync]);

  useEffect(() => {
    if (livePreviewLoaded) postFrameDisplayScale(iframeRef.current);
  }, [livePreviewLoaded, previewScale]);

  useEffect(() => {
    if (!shouldMountIframeHover) return;
    const onRuntimeReady = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (frame && event.source === frame.contentWindow && event.data?.type === "ready") {
        postFrameDisplayScale(frame);
      }
    };
    window.addEventListener("message", onRuntimeReady);
    return () => window.removeEventListener("message", onRuntimeReady);
  }, [shouldMountIframeHover]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, []);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      aria-label={t("Open composition {name}", { name: name })}
      aria-pressed={isActive}
      aria-current={isActive ? "true" : undefined}
      onDragStart={(event) => {
        stopHoverPreview();
        draggedRef.current = true;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(TIMELINE_COMPOSITION_MIME, JSON.stringify({ sourcePath: comp }));
      }}
      onDragEnd={() => {
        window.setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }}
      onClick={() => {
        if (!draggedRef.current) openComposition();
      }}
      onKeyDown={(event) => {
        // Only when the row itself is focused — keydowns bubbling from the
        // inner controls (play button) must keep their native activation.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openComposition();
        }
      }}
      onPointerEnter={handleEnter}
      onPointerLeave={stopHoverPreview}
      className={`motion-composition-card group/card w-full select-none text-left px-2 py-1.5 flex items-center gap-2.5 transition-colors cursor-grab active:cursor-grabbing outline-hidden focus-visible:bg-neutral-800/60 ${
        isActive
          ? "bg-studio-accent/10"
          : "hover:bg-neutral-800/50"
      }`}
    >
      <div
        ref={thumbnailBox}
        onPointerMove={handleThumbnailPointerMove}
        onPointerLeave={handleThumbnailPointerLeave}
        className="w-20 h-[45px] rounded-sm overflow-hidden bg-neutral-900 shrink-0 relative"
      >
        {!posterLoaded && !hasRenderedCover && !livePreviewLoaded && (
          <div className="motion-composition-placeholder absolute inset-0 flex items-center justify-center" data-testid="composition-cover-placeholder" aria-hidden="true">
            <span className="motion-composition-placeholder-mark" />
          </div>
        )}
        {spriteCoverValue && (
          <SpriteFrame
            sprite={spriteCoverValue}
            frameIndex={activeFrameIndex}
            fit="contain"
            containerWidth={CARD_W}
            containerHeight={CARD_H}
            className="absolute inset-0"
          />
        )}
        {posterUrl && (
          <img
            src={posterUrl}
            alt=""
            draggable={false}
            decoding="async"
            data-filmstrip-frame={hasMultiFramePreview ? activeFrameIndex : undefined}
            onLoad={() => {
              setLoadedFrameUrl(posterUrl);
              setRenderedCoverIdentity(coverIdentity);
            }}
            onError={() => {
              setFailedFrameUrl(posterUrl);
              setRenderedCoverIdentity(null);
            }}
            className={`absolute inset-0 h-full w-full object-contain transition-opacity ${
              livePreviewLoaded || (!posterLoaded && !hasRenderedCover) ? "opacity-0" : "opacity-100"
            }`}
          />
        )}
        {hasMultiFramePreview && (spriteHoverActive || isScrubbing) && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-neutral-950/60"
            data-testid="composition-hover-progress"
            aria-hidden="true"
          >
            <div
              className="h-full bg-studio-accent transition-[width] duration-75"
              style={{ width: `${((activeFrameIndex + 1) / totalCoverFrames) * 100}%` }}
            />
          </div>
        )}
        {shouldMountIframeHover && previewOrigin && (
          <div className="absolute inset-0 pointer-events-none" style={{ visibility: livePreviewLoaded ? "visible" : "hidden" }}>
            <IsolatedHoverPlayer source={previewUrl} origin={previewOrigin} onReady={setLivePreviewLoaded}
              onError={() => setLivePreviewLoaded(false)} />
          </div>
        )}
        {shouldMountIframeHover && !previewOrigin && (
          <iframe
            ref={iframeRef}
            src={previewUrl}
            sandbox="allow-scripts allow-same-origin"
            className="absolute border-none pointer-events-none"
            style={{
              transformOrigin: "0 0",
              width: stageSize.width,
              height: stageSize.height,
              left: thumbnailOffsetX,
              top: thumbnailOffsetY,
              transform: `scale(${previewScale})`,
            }}
            onLoad={(e) => {
              try {
                const iframe = e.currentTarget;
                const root = iframe.contentDocument?.querySelector("[data-composition-id]");
                const width =
                  Number(root?.getAttribute("data-width")) || DEFAULT_PREVIEW_STAGE.width;
                const height =
                  Number(root?.getAttribute("data-height")) || DEFAULT_PREVIEW_STAGE.height;
                setStageSize({ width, height });
                setLivePreviewLoaded(true);
                requestIframePlaybackSync(true);
              } catch {
                setStageSize(DEFAULT_PREVIEW_STAGE);
              }
            }}
            title={t("{name} preview", { name: name })}
            tabIndex={-1}
          />
        )}
        {showCoverError && <ItemLoadErrorBadge compact onReload={handleReloadCover} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1">
          <OverflowText text={name} className="motion-composition-name text-[11px] font-medium text-neutral-300 truncate" />
          {isRoot && (
            <Tooltip label={t("Root composition: opens automatically on load")} wrap><span
              aria-label={t("Root composition: opens automatically on load")}
              className="max-w-full truncate flex-shrink-0 rounded-full bg-neutral-700/60 px-1.5 py-px text-[8px] font-bold uppercase tracking-wide text-neutral-300"
            >
              {t("Root")}</span></Tooltip>
          )}
        </div>
        <OverflowText text={comp} className="text-[9px] text-neutral-600 truncate block" />
      </div>
      {onAddToTimeline && (
        <Tooltip label={t("Add {name} to timeline at playhead", { name: name })} wrap><IconButton variant="plain"
          type="button"
          aria-label={t("Add {name} to timeline at playhead", { name: name })}
          onClick={(event) => {
            event.stopPropagation();
            onAddToTimeline();
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-neutral-600 opacity-0 transition-[color,background-color,opacity] hover:bg-neutral-800 hover:text-accent-ink group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus:opacity-100"
          icon={<span aria-hidden="true">+</span>}
        /></Tooltip>
      )}
      {onRender && (
        <Tooltip label={isRendering ? t("A render is already in progress") : t("Render {name}", { name: name })}>
          <IconButton variant="plain"
            type="button"
            aria-label={isRendering ? t("A render is already in progress") : t("Render {name}", { name: name })}
            disabled={isRendering}
            onClick={(e) => {
              e.stopPropagation();
              onRender();
            }}
            // h-6 w-6 = the 24x24 WCAG 2.2 (2.5.8) minimum target; the 14px glyph
            // is unchanged, only the box grows. The sibling "+" button is h-8 w-8,
            // so the card row already has the room.
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors ${
              isRendering
                ? "text-neutral-600 cursor-not-allowed"
                : "text-neutral-600 hover:text-accent-ink hover:bg-neutral-800"
            }`}
            icon={<RemixIcon name="download-2-line" size={14} />}
          />
        </Tooltip>
      )}
    </div>
  );
}

export const CompositionsTab = memo(function CompositionsTab({
  projectId,
  compositions,
  activeComposition,
  masterCompositionPath = null,
  onSelect,
  onRenderComposition,
  onAddToTimeline,
  isRendering,
}: CompositionsTabProps) {
  const { t } = useI18n();
  const thumbnailRevisions = usePlayerStore((state) => state.thumbnailRevisions);
  const firstTimelineChildComp = usePlayerStore((state) => {
    if (!masterCompositionPath) return null;
    let earliestStart = Infinity;
    let earliestComp: string | null = null;
    for (const el of state.elements) {
      if (!el.compositionSrc) continue;
      const normalized = el.compositionSrc.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "");
      if (normalized === masterCompositionPath) continue;
      if (el.start < earliestStart) {
        earliestStart = el.start;
        earliestComp = normalized;
      }
    }
    return earliestComp;
  });
  const sortedCompositions = useMemo(
    () =>
      [...compositions].sort(
        (a, b) => Number(b === masterCompositionPath) - Number(a === masterCompositionPath),
      ),
    [compositions, masterCompositionPath],
  );
  // Reuse the earliest child composition's cover for the Root card so editing the master
  // timeline never triggers redundant SnapDOM captures or cover reloads for index.html.
  const rootCoverComp = useMemo(() => {
    if (!masterCompositionPath) return null;
    if (firstTimelineChildComp && compositions.includes(firstTimelineChildComp)) {
      return firstTimelineChildComp;
    }
    return sortedCompositions.find((c) => c !== masterCompositionPath) ?? null;
  }, [compositions, firstTimelineChildComp, masterCompositionPath, sortedCompositions]);

  if (compositions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <p className="text-xs text-neutral-600 text-center">{t("No compositions found")}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto" data-composition-list>
      {sortedCompositions.map((comp) => {
        const isRoot = comp === masterCompositionPath;
        const effectiveCoverComp = isRoot && rootCoverComp ? rootCoverComp : comp;
        return (
          <CompCard
            key={`${projectId}:${comp}`}
            projectId={projectId}
            comp={comp}
            coverComp={effectiveCoverComp}
            isActive={activeComposition === comp}
            isRoot={isRoot}
            onSelect={() => onSelect(comp)}
            onRender={onRenderComposition ? () => onRenderComposition(comp) : undefined}
            onAddToTimeline={onAddToTimeline ? () => onAddToTimeline(comp) : undefined}
            isRendering={isRendering}
            contentRevision={thumbnailRevisionOf(thumbnailRevisions, comp)}
            coverContentRevision={thumbnailRevisionOf(thumbnailRevisions, effectiveCoverComp)}
          />
        );
      })}
    </div>
  );
});
