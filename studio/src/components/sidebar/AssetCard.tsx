import { IconButton } from "open-design-ui/icon-button";
import { MediaDurationBadge } from "./MediaDurationBadge";
import { AssetQuickAdd } from "./AssetQuickAdd";
import { useMvpEditor } from "../../motion/StudioHost";
import { RemixIcon } from "../../icons/RemixIcons";
import { useI18n } from "../../i18n/I18n";
/**
 * AssetCard and FontRow — visual asset tile / row components for the Assets panel.
 * Extracted from AssetsTab.tsx to keep that file under the 600-line CI gate.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Tooltip } from "../ui/Tooltip";
import { ItemLoadErrorBadge } from "../ui/ItemLoadErrorBadge";
import { triggerEditorAssetRetry } from "../EditorAssetLoadingOverlay";
import { useDockPanelVisible } from "../dock/Dock";
import { useNearViewport } from "../../hooks/useNearViewport";
import { useThumbnailLease } from "../../hooks/useThumbnailLease";
import { createVideoThumbnailRequest } from "../../player/lib/videoThumbnailRequest";
import { thumbnailScheduler } from "../../player/lib/thumbnailScheduler";
import {
  matchesFailedPreviewAsset,
  withRetryQueryParam,
} from "../../player/lib/previewAssetReadiness";
import { mediaThumbnailRevisionOf } from "../../player/store/thumbnailSlice";
import { VIDEO_EXT, IMAGE_EXT } from "../../utils/mediaTypes";
import { TIMELINE_ASSET_MIME } from "../../utils/timelineAssetDrop";
import { ContextMenu } from "./AssetContextMenu";
import { InlineAssetRename } from "./InlineAssetRename";
import { usePlayerStore } from "../../player/store/playerStore";
import { timelineClipFocusId } from "../../player/components/timelineNavigationIdentity";
import { useAssetPreviewStore } from "../../utils/assetPreviewStore";
import { findClipForAsset, isPointerClick } from "../../utils/assetClickBehavior";
import { basename, ext, type CopyFeedback } from "./assetHelpers";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";
import { useCloudDisklessMode } from "../../utils/cloudRuntime";
import { clearLocalUploadPreview, useLocalUploadPreview } from "../../utils/localUploadPreviewStore";

/** Drag payload writer shared by the asset tile and the font row: copy effect
 *  plus the timeline-asset MIME and a plain-text path fallback. */
function writeAssetDragData(e: React.DragEvent, asset: string, duration?: number): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(TIMELINE_ASSET_MIME, JSON.stringify({ path: asset, duration }));
  e.dataTransfer.setData("text/plain", asset);
}

/** Copy-path outcome chip. Copying is a context-menu action, so this is pure
 *  feedback — it renders only once a copy has succeeded or failed, and never
 *  as an idle affordance for something the tile itself does not do. */
function CopyChip({ feedback, asset }: { feedback: CopyFeedback; asset: string }) {
  const { t } = useI18n();
  if (feedback?.path !== asset) return null;
  return (
    <span
      role="status"
      className={`shrink-0 text-[9px] font-medium px-1.5 py-px rounded ${
        feedback.ok ? "text-accent-ink bg-panel-accent/10" : "text-danger-ink bg-red-500/10"
      }`}
    >
      {feedback.ok ? t("Copied") : t("Copy failed")}
    </span>
  );
}

/** Open the row/tile context menu at the pointer, shared by asset tile + font row. */
function openAssetContextMenu(
  e: React.MouseEvent,
  setContextMenu: (menu: { x: number; y: number }) => void,
): void {
  e.preventDefault();
  setContextMenu({ x: e.clientX, y: e.clientY });
}

/**
 * Lazily probe a video/audio URL for its duration via a hidden HTMLVideoElement
 * (`preload="metadata"`). The manifest only covers ~/.media assets, so project
 * assets in assets/ have no manifest entry — this fills the gap.
 * Returns `undefined` until the probe completes; `null` if it failed.
 */
function useProbedDuration(src: string, skip: boolean): number | null | undefined {
  const [duration, setDuration] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // The in-flight probe element, so unmount cleanup can abort its network
    // fetch (clearing `src`) instead of leaving it to finish in the background.
    let liveVid: HTMLVideoElement | null = null;

    function teardown(vid: HTMLVideoElement) {
      vid.onloadedmetadata = null;
      vid.onerror = null;
      vid.src = "";
    }

    function probe(attempt: number) {
      if (cancelled) return;
      const vid = document.createElement("video");
      liveVid = vid;
      vid.preload = "metadata";
      vid.muted = true;
      vid.onloadedmetadata = () => {
        const d = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : null;
        teardown(vid);
        if (!cancelled) setDuration(d);
      };
      vid.onerror = () => {
        teardown(vid);
        if (!cancelled) {
          if (attempt < 1) retryTimer = setTimeout(() => probe(attempt + 1), 50);
          else setDuration(null);
        }
      };
      vid.src = src;
    }

    probe(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (liveVid) teardown(liveVid);
    };
  }, [src, skip]);
  return duration;
}

function useAssetVideoPoster({
  enabled,
  projectId,
  src,
  duration,
}: {
  enabled: boolean;
  projectId: string;
  src: string;
  duration?: number;
}) {
  const sessionEpoch = usePlayerStore((state) => state.timelineSessionEpoch);
  const request = useMemo(
    () =>
      enabled
        ? createVideoThumbnailRequest(
            {
              projectId,
              sessionEpoch,
              videoSrc: src,
              duration: duration ?? 1,
              priority: "visible",
            },
            1,
            false,
          )
        : null,
    [duration, enabled, projectId, sessionEpoch, src],
  );
  const snapshot = useThumbnailLease(request);
  const decoded =
    snapshot.status === "ready" && snapshot.value.kind === "image" ? snapshot.value.url : null;
  const loading = enabled && (snapshot.status === "queued" || snapshot.status === "loading");
  const error = enabled && snapshot.status === "error";
  const reload = useCallback(() => {
    thumbnailScheduler.retryEntry(request);
  }, [request]);
  return { decoded, loading, error, reload };
}

export interface AssetCardProps {
  projectId: string;
  asset: string;
  displayName?: string;
  used: boolean;
  duration?: number;
  optimizing?: boolean;
  onCopy: (path: string) => void;
  copyFeedback: CopyFeedback;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAssetToTimeline?: (path: string) => unknown;
}

/**
 * Thumbnail card for images and video assets in the responsive media grid.
 *
 * Click behaviour (CapCut-style):
 *   - Already added  → selects the clip on the timeline (setSelectedElementId).
 *   - Not yet added  → opens the asset preview overlay over the canvas.
 * Drag behaviour is preserved: a pointer movement exceeding DRAG_THRESHOLD_PX
 * before pointerup is treated as drag-start, not a click.
 */
// fallow-ignore-next-line complexity
export function AssetCard({
  projectId,
  asset,
  displayName,
  used,
  duration,
  optimizing = false,
  onCopy,
  copyFeedback,
  onDelete,
  onRename,
  onAddAssetToTimeline,
}: AssetCardProps) {
  const mvp = useMvpEditor();
  const { t } = useI18n();
  const panelVisible = useDockPanelVisible();
  const isCloudMode = useCloudDisklessMode();
  const localPreview = useLocalUploadPreview(projectId, asset);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const visible = useNearViewport(card, panelVisible);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [imgRetryAttempt, setImgRetryAttempt] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const isCopied = copyFeedback?.path === asset && copyFeedback.ok;
  const fullName = displayName ?? asset.split("/").pop() ?? asset;
  const name = displayName ?? basename(asset);
  const extension = ext(asset);
  const sourceUrl = resolveMediaPreviewUrl(asset, projectId);
  const revision = usePlayerStore((state) => mediaThumbnailRevisionOf(state.thumbnailRevisions, asset));
  const serveUrl = revision ? `${sourceUrl}?revision=${revision}` : sourceUrl;
  const imgSrc = useMemo(() => {
    if (imgRetryAttempt <= 0) return serveUrl;
    const baseHref = typeof window !== "undefined" ? window.location.href : undefined;
    return withRetryQueryParam(serveUrl, imgRetryAttempt, baseHref) ?? serveUrl;
  }, [imgRetryAttempt, serveUrl]);
  const isVideo = VIDEO_EXT.test(asset);
  const isImage = IMAGE_EXT.test(asset);
  useEffect(() => {
    if (!panelVisible) setHovered(false);
  }, [panelVisible]);
  useEffect(() => {
    setImgError(false);
    setImgLoaded(false);
    setImgRetryAttempt(0);
  }, [serveUrl, localPreview]);
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setImgLoaded(true);
    }
  }, [imgSrc]);
  // In cloud mode, duration comes from PG metadata; only fall back to <video> probe in local mode.
  const probedDuration = useProbedDuration(serveUrl, !visible || !isVideo || duration != null || isCloudMode);
  const resolvedDuration = duration ?? probedDuration ?? undefined;
  const videoPoster = useAssetVideoPoster({
    enabled: isVideo && visible,
    projectId,
    src: serveUrl,
    duration: resolvedDuration,
  });
  const videoPosterUrl = videoPoster.decoded ?? localPreview;
  const previewAssetFailed = usePlayerStore((s) =>
    matchesFailedPreviewAsset(s.assetReadinessFailed, asset),
  );
  const previewAssetRetrying = usePlayerStore((s) => s.assetReadinessRetrying);
  const itemError =
    (isImage && imgError && !localPreview) ||
    (isVideo && !videoPosterUrl && videoPoster.error) ||
    previewAssetFailed;
  const handleReloadItem = useCallback(() => {
    if (isImage && imgError) {
      setImgError(false);
      setImgLoaded(false);
      setImgRetryAttempt((attempt) => attempt + 1);
    }
    if (isVideo && videoPoster.error) {
      videoPoster.reload();
    }
    if (previewAssetFailed) {
      void triggerEditorAssetRetry();
    }
  }, [imgError, isImage, isVideo, previewAssetFailed, videoPoster]);

  // Drag-threshold click gate: track pointer-down position so we can ignore
  // pointer-up events that followed a real drag gesture.
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  const setSelectedElementId = usePlayerStore((s) => s.setSelectedElementId);
  const requestTimelineFocus = usePlayerStore((s) => s.requestTimelineFocus);
  const elements = usePlayerStore((s) => s.elements);
  const setPreviewAsset = useAssetPreviewStore((s) => s.setPreviewAsset);
  const clearPreviewAsset = useAssetPreviewStore((s) => s.clearPreviewAsset);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Legacy: reveal an existing clip. MVP: always preview the source. Otherwise open
  // the preview overlay. Shared by pointer-up and keyboard activation so the
  // tile does the same thing however it is operated.
  const activateCard = useCallback(() => {
    if (used && !mvp) {
      const clip = findClipForAsset(elements, asset);
      if (clip) {
        // Dismiss any open preview overlay (from another asset) — the reveal
        // must not leave a stale preview card floating over the canvas.
        clearPreviewAsset();
        const clipKey = clip.key ?? clip.id;
        setSelectedElementId(clipKey);
        // Scroll the timeline so the selected clip is actually visible.
        requestTimelineFocus(timelineClipFocusId(clipKey));
        return;
      }
    }
    // Not added (or no matching clip found) → preview overlay
    setPreviewAsset(asset, projectId, onAddAssetToTimeline ? () => onAddAssetToTimeline(asset) : undefined);
  }, [
    mvp,
    used,
    elements,
    asset,
    projectId,
    setSelectedElementId,
    requestTimelineFocus,
    setPreviewAsset,
    onAddAssetToTimeline,
    clearPreviewAsset,
  ]);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const origin = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!origin) return;
      if (!isPointerClick(e.clientX - origin.x, e.clientY - origin.y)) return;
      activateCard();
    },
    [activateCard],
  );

  return (
    <>
      <div
        ref={setCard}
        draggable
        role="button"
        tabIndex={0}
        aria-label={t("{name}: open, drag to timeline, right-click for actions", { name: name })}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activateCard();
          }
        }}
        onDragStart={(e) => writeAssetDragData(e, asset, resolvedDuration)}
        onContextMenu={(e) => openAssetContextMenu(e, setContextMenu)}
        onPointerEnter={() => {
          if (panelVisible) setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        className={`cursor-pointer rounded-md overflow-hidden bg-neutral-900 transition-colors outline-hidden focus-visible:bg-neutral-800/60 ${
          isCopied ? "bg-studio-accent/10" : "hover:bg-neutral-800"
        }`}
      >
        {/* Thumbnail */}
        <div
          className="motion-asset-thumbnail w-full aspect-video overflow-hidden bg-neutral-900 relative"
          data-item-error={itemError ? "true" : undefined}
        >
          {((isImage && !imgLoaded && !imgError && !localPreview) ||
            (isVideo && !videoPosterUrl && videoPoster.loading)) && (
            <div
              className="pointer-events-none absolute inset-0 animate-pulse motion-reduce:animate-none"
              style={{ background: "var(--timeline-thumbnail-shimmer)" }}
              aria-hidden="true"
            />
          )}
          {isImage && localPreview && <img src={localPreview} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover" />}
          {isImage && !imgError && (
            <img
              ref={imgRef}
              src={imgSrc}
              alt={name}
              draggable={false}
              loading="lazy"
              className="w-full h-full object-cover"
              onLoad={() => {
                setImgLoaded(true);
                if (localPreview) clearLocalUploadPreview(projectId, asset);
              }}
              onError={() => setImgError(true)}
            />
          )}
          {isVideo && (
            <>
              {videoPosterUrl && (
                <img
                  src={videoPosterUrl}
                  alt=""
                  draggable={false}
                  className="w-full h-full object-cover"
                  onLoad={() => {
                    if (videoPoster.decoded && localPreview) {
                      clearLocalUploadPreview(projectId, asset);
                    }
                  }}
                />
              )}
              {hovered && panelVisible && (
                <video
                  src={serveUrl}
                  autoPlay
                  muted
                  loop
                  playsInline
                  className="absolute inset-0 w-full h-full object-cover"
                />
              )}
            </>
          )}
          {((!isImage && !isVideo) || (isImage && imgError && !localPreview)) && (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[10px] font-medium text-neutral-600">{extension}</span>
            </div>
          )}

          {/* Current-composition usage badge — top-left */}
          {used && (
            <span className="absolute top-1 left-1 text-[9px] font-semibold leading-none px-1.5 py-[3px] rounded-sm bg-neutral-950/80 text-panel-text-1">
              {t("In use")}</span>
          )}

          {/* Background optimization badge — bottom-left while proxy/sprite derives on worker-media */}
          {optimizing && (
            <Tooltip
              label={
                isVideo
                  ? t("Optimizing preview & timeline frames in the background — ready to edit now")
                  : t("Optimizing high-res preview in the background — ready to edit now")
              }
              wrap
            >
              <span
                data-asset-optimizing="true"
                role="status"
                className="absolute bottom-1 left-1 inline-flex items-center gap-1 text-[9px] font-medium leading-none px-1.5 py-[3px] rounded-sm bg-neutral-950/80 text-panel-text-2"
              >
                <span
                  aria-hidden="true"
                  className="inline-block w-2 h-2 rounded-full border border-border border-t-panel-text-1 animate-spin motion-reduce:animate-none"
                />
                {t("Optimizing")}
              </span>
            </Tooltip>
          )}

          {/* Duration badge — top-right, media only */}
          <MediaDurationBadge duration={resolvedDuration} className="absolute top-1 right-1" />
          {onAddAssetToTimeline && <AssetQuickAdd asset={asset} onAdd={onAddAssetToTimeline} />}
          {itemError && (
            <ItemLoadErrorBadge
              reloading={previewAssetFailed && previewAssetRetrying}
              onReload={handleReloadItem}
            />
          )}
        </div>

        {/* Match catalog caption spacing and typography; keep actions beside the name. */}
        <div className="flex items-center gap-1 px-1.5 py-1.5">
          {renaming && onRename ? <InlineAssetRename displayName={displayName} asset={asset} onRename={onRename} onDone={() => setRenaming(false)} /> : <Tooltip label={fullName} lines={3}>
            <span className="min-w-0 flex-1 text-[10px] font-medium text-neutral-200 truncate leading-tight text-left">
              {fullName}
            </span>
          </Tooltip>}
          <CopyChip feedback={copyFeedback} asset={asset} />
          <Tooltip label={t("Actions for {value0}", { value0: fullName })} wrap><IconButton variant="plain" type="button" className="motion-asset-menu-button" aria-label={t("Actions for {value0}", { value0: fullName })} aria-haspopup="menu" onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); setContextMenu({ x: rect.left, y: rect.bottom }); }} icon={<RemixIcon name="more-line" size={16} />} /></Tooltip>
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          asset={asset}
          onClose={() => setContextMenu(null)}
          onCopy={onCopy}
          onDelete={onDelete}
          displayName={displayName}
          onRename={onRename}
          onStartRename={() => setRenaming(true)}
          onAddAtPlayhead={onAddAssetToTimeline}
          onPreview={path => setPreviewAsset(path, projectId)}
          downloadUrl={serveUrl}
        />
      )}
    </>
  );
}

export interface FontRowProps {
  asset: string;
  displayName?: string;
  used: boolean;
  onCopy: (path: string) => void;
  copyFeedback: CopyFeedback;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAssetToTimeline?: (path: string) => unknown;
}

/**
 * Compact row for font assets (no meaningful thumbnail; show ext badge + name).
 */
export function FontRow({
  asset,
  displayName,
  used,
  onCopy,
  copyFeedback,
  onDelete,
  onRename,
  onAddAssetToTimeline,
}: FontRowProps) {
  const { t } = useI18n();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const name = displayName ?? basename(asset);
  const extension = ext(asset);
  const isCopied = copyFeedback?.path === asset && copyFeedback.ok;

  return (
    <>
      <div
        draggable
        role="button"
        tabIndex={0}
        aria-label={t("{name}: copy path, drag to timeline, right-click for actions", { name: name })}
        onClick={() => onCopy(asset)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCopy(asset);
          }
        }}
        onDragStart={(e) => writeAssetDragData(e, asset)}
        onContextMenu={(e) => openAssetContextMenu(e, setContextMenu)}
        className={`om-asset-action-row px-2.5 py-1.5 flex items-center gap-2.5 cursor-pointer transition-colors outline-hidden focus-visible:bg-neutral-800/60 ${
          isCopied
            ? "bg-studio-accent/10 border-l-2 border-studio-accent"
            : "border-l-2 border-transparent hover:bg-neutral-800/50"
        }`}
      >
        <div className="w-[50px] h-[32px] rounded-sm overflow-hidden bg-neutral-900 shrink-0 flex items-center justify-center">
          <span className="text-[9px] font-medium text-text-muted">{extension}</span>
        </div>
        <div className="min-w-0 flex-1">
          <span
            className={`text-xs font-medium truncate block ${used ? "text-panel-text-1" : "text-panel-text-3"}`}
          >
            {name}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral-600 truncate">{extension}</span>
            {used && (
              <span className="text-[9px] font-medium text-accent-ink bg-panel-accent/10 px-1.5 py-px rounded-sm">
                {t("In use")}</span>
            )}
            <CopyChip feedback={copyFeedback} asset={asset} />
          </div>
        </div>
        {onAddAssetToTimeline && <AssetQuickAdd asset={asset} onAdd={onAddAssetToTimeline} compact />}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          asset={asset}
          onClose={() => setContextMenu(null)}
          onCopy={onCopy}
          onDelete={onDelete}
          displayName={displayName}
          onRename={onRename}
          onAddAtPlayhead={onAddAssetToTimeline}
        />
      )}
    </>
  );
}
