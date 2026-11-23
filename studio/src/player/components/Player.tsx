import { PreviewCompositionLoading } from "./PreviewCompositionLoading";
import { IsolatedPlayer } from "./IsolatedPlayer";
import { isolatedPreviewOrigin } from "../lib/previewLease";
import { Button } from "open-design-ui/button";
import { useI18n } from "../../i18n/I18n";
import { buildProjectApiPath } from "../../utils/projectRouting";
import { forwardRef, useEffect, useRef, useState } from "react";
import { isLottieAnimationLoaded } from "@hyperframes/core/runtime/lottie-readiness";
import { scanPendingCompositionAssets } from "@hyperframes/core/composition-readiness";
import { installAcceleratedCanvasTracker } from "@hyperframes/core/page-motion-blur";
import { useMountEffect } from "../../hooks/useMountEffect";
import { applyPreviewVariablesToUrl } from "../../hooks/previewVariablesStore";
import { HyperframesLoader } from "../../components/ui";
import { brandPlayerLoading } from "../../components/ui/openDesignLoading";
import { usePlayerStore } from "../store/playerStore";
import { registerRetryFailedAssetsHandler } from "../store/readinessSlice";
import { trackDocumentAssetReadiness } from "../lib/previewAssetReadiness";
import { announcePreviewDocumentLoaded } from "../sceneSwap";
import type { IframeWindow } from "../lib/playbackTypes";
// Importing "@hyperframes/player" registers a class extending HTMLElement at
// module load, which throws under SSR, hence the dynamic import behind a
// `typeof window` guard. Kicking it here rather than in the mount effect puts
// the chunk request in flight before the shell's first layout. Clearing the memo
// on rejection stops one failure poisoning every later mount; the browser's
// module map still caches a failed fetch, so recovery is a page reload.
let playerModule: Promise<unknown> | null = null;

export function loadPlayerModule(): Promise<unknown> {
  playerModule ??= import("@hyperframes/player").catch((err: unknown) => {
    playerModule = null;
    throw err;
  });
  return playerModule;
}

if (typeof window !== "undefined") void loadPlayerModule().catch(() => {});

if (typeof window !== "undefined") installAcceleratedCanvasTracker();

export interface PlayerProps {
  projectId?: string;
  directUrl?: string;
  onLoad: () => void;
  /** Signals whether the loaded document can be shown in the editor. */
  onReadyToShowChange?: (ready: boolean) => void;
  onPreviewError?: (message: string) => void;
  onCompositionLoadingChange?: (loading: boolean) => void;
  onPainted?: (details: { iframe: HTMLIFrameElement; startedAt: number; loadId: number }) => void;
  portrait?: boolean;
  style?: React.CSSProperties;
  suppressLoadingOverlay?: boolean;
  loadingUi?: "studio" | "host";
  noLoadTimeout?: boolean;
  /** Show the live preview’s loading indicator until its first displayable frame. */
  showInitialLoading?: boolean;
  /** Track all referenced composition assets for the unified editor readiness gate (live slot only). */
  trackAssets?: boolean;
}

interface HyperframesPlayerElement extends HTMLElement {
  iframeElement: HTMLIFrameElement;
  ready?: boolean;
  painted?: boolean;
}

const MEDIA_HAVE_FUTURE_DATA = 3;
const MEDIA_HAVE_METADATA = 1;
const MEDIA_NETWORK_NO_SOURCE = 3;
const ASSET_WAIT_DEADLINE_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getShaderTransitionLoading(event: Event): boolean | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (!isRecord(detail)) return null;
  const state = detail.state;
  if (!isRecord(state)) return null;
  return state.loading === true && state.ready !== true;
}

const COMPOSITION_LOADING_OVERLAY_DELAY_MS = 400;
const PREVIEW_BOOT_DEADLINE_MS = 5000;
const DEFAULT_PREVIEW_ERROR = "The composition preview did not become ready.";
const PLAYER_MODULE_ERROR = "Interface resources could not be loaded. Reload the editor to try again.";

export function shouldShowCompositionLoadingOverlay(compositionLoading: boolean): boolean {
  return compositionLoading;
}

export function readPreviewErrorMessage(event: Event): string {
  if (!(event instanceof CustomEvent) || !isRecord(event.detail)) return DEFAULT_PREVIEW_ERROR;
  return typeof event.detail.message === "string" && event.detail.message.trim()
    ? event.detail.message
    : DEFAULT_PREVIEW_ERROR;
}

function enableInteractiveIframe(player: HyperframesPlayerElement): void {
  const root = player.shadowRoot;
  if (!root) return;

  const container = root.querySelector<HTMLElement>(".hfp-container");
  const iframe = root.querySelector<HTMLIFrameElement>(".hfp-iframe");

  container?.style.setProperty("pointer-events", "auto");
  iframe?.style.setProperty("pointer-events", "auto");
}

const studioDraws = (wait: boolean, loadingUi: PlayerProps["loadingUi"]) =>
  wait && loadingUi !== "host";

function isPreviewMediaElement(el: Element): el is HTMLMediaElement {
  const tagName = el.tagName.toLowerCase();
  return tagName === "video" || tagName === "audio";
}

// Follow the runtime's preload policy. Deferred clips use preload="none"
// until they approach the playhead; waiting for their data would keep a ready
// first frame covered until the safety deadline on every page refresh.
// Metadata-only media can likewise stop loading before HAVE_FUTURE_DATA.
// Eager media still waits for playable data, and Lotties for their assets.
//
// Returns whichever value was returned last on cross-origin / transient DOM
// races so a brief access failure (e.g. an iframe that just swapped src)
// doesn't flicker the overlay state — we keep showing whatever was most
// recently true.
export function hasUnloadedAssets(iframe: HTMLIFrameElement, lastResult: boolean): boolean {
  try {
    const win = iframe.contentWindow as unknown as (Window & { __hfLottie?: unknown[] }) | null;
    const doc = iframe.contentDocument;
    if (!win || !doc) return lastResult;

    for (const el of doc.querySelectorAll("video, audio")) {
      if (
        isPreviewMediaElement(el) &&
        el.preload !== "none" &&
        !el.error &&
        el.networkState !== MEDIA_NETWORK_NO_SOURCE &&
        el.readyState < (el.preload === "metadata" ? MEDIA_HAVE_METADATA : MEDIA_HAVE_FUTURE_DATA)
      ) {
        return true;
      }
    }

    const lotties = win.__hfLottie;
    if (lotties?.length) {
      for (const anim of lotties) {
        if (!isLottieAnimationLoaded(anim)) return true;
      }
    }

    return false;
  } catch {
    return lastResult;
  }
}

// The runtime's playback handshake also waits for the soundtrack. Once rendering
// has settled, audio can continue buffering behind an already usable first frame.
function waitingOnlyForAudio(doc: Document): boolean {
  const win = doc.defaultView as (Window & { __renderReady?: boolean; __hfLottie?: unknown[] }) | null;
  if (!win?.__renderReady || win.__hfLottie?.some(anim => !isLottieAnimationLoaded(anim))) return false;
  const { pendingImages, pendingMedia, fontsLoading } = scanPendingCompositionAssets(doc, { scope: "first-frame" });
  return !fontsLoading && pendingImages.length === 0 && pendingMedia.length > 0 &&
    pendingMedia.every(media => media.tagName === "AUDIO");
}

const runtimeBootedIn = (iframe: HTMLIFrameElement) =>
  (iframe.contentWindow as IframeWindow | null)?.__playerReady === true;

/**
 * Renders a composition preview using the <hyperframes-player> web component.
 *
 * The web component handles iframe scaling, dimension detection, and
 * ResizeObserver internally. This wrapper bridges its inner iframe to the
 * forwarded ref so useTimelinePlayer can access it for clip manifest parsing,
 * timeline probing, and DOM inspection.
 */
const SameOriginPlayer = forwardRef<HTMLIFrameElement, PlayerProps>(
  (
    {
      projectId,
      directUrl,
      onLoad,
      onReadyToShowChange,
      onPreviewError,
      onCompositionLoadingChange,
      onPainted,
      portrait,
      style,
      suppressLoadingOverlay,
      noLoadTimeout,
      showInitialLoading,
      trackAssets,
      ...host
    },
    ref,
  ) => {
  const { t } = useI18n();
    const containerRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<HyperframesPlayerElement | null>(null);
    const loadCountRef = useRef(0);
    const assetPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const assetFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryPreviewRef = useRef<(() => void) | null>(null);
    const loadStartedAtRef = useRef(0);
    const loadIdRef = useRef(0);
    const retryCountRef = useRef(0);
    // Read at call time: this element outlives its first props (a shadow preview is
    // promoted in place), so mount-time closures would go stale.
    const onLoadRef = useRef(onLoad);
    onLoadRef.current = onLoad;
    const onReadyToShowChangeRef = useRef(onReadyToShowChange);
    onReadyToShowChangeRef.current = onReadyToShowChange;
    const onPaintedRef = useRef(onPainted);
    onPaintedRef.current = onPainted;
    // A shadow promoted in place already has a frame and never needs an initial cover or asset gate.
    const startsWithLoading = useRef(showInitialLoading === true).current;
    const tracksAssets = useRef(trackAssets === true).current;
    const assetReadinessGenRef = useRef(usePlayerStore.getState().assetReadinessGeneration);
    const [assetScanTick, setAssetScanTick] = useState(0);
    const [awaitingFirstFrame, setAwaitingFirstFrame] = useState(startsWithLoading);
    const awaitingFrameRef = useRef(awaitingFirstFrame);
    awaitingFrameRef.current = awaitingFirstFrame;
    const onPreviewErrorRef = useRef(onPreviewError);
    onPreviewErrorRef.current = onPreviewError;
    const [loaded, setLoaded] = useState(false);
    const [assetsLoading, setAssetsLoading] = useState(false);
    const [assetOverlayVisible, setAssetOverlayVisible] = useState(false);
    const [assetOverlayFading, setAssetOverlayFading] = useState(false);
    const [assetWaitLong, setAssetWaitLong] = useState(false);
    const [shaderTransitionLoading, setShaderTransitionLoading] = useState(false);
    const [compositionLoading, setCompositionLoading] = useState(true);
    const [painted, setPainted] = useState(false);
    const [visualFrameReady, setVisualFrameReady] = useState(false);
    const [compositionOverlayDeferred, setCompositionOverlayDeferred] = useState(true);
    const [previewError, setPreviewError] = useState<string | null>(null);

    // eslint-disable-next-line no-restricted-syntax
    useEffect(() => {
      if (!compositionLoading) {
        setCompositionOverlayDeferred(true);
        return;
      }
      const timer = setTimeout(
        () => setCompositionOverlayDeferred(false),
        COMPOSITION_LOADING_OVERLAY_DELAY_MS,
      );
      return () => clearTimeout(timer);
    }, [compositionLoading]);

    useMountEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const previewSource =
        directUrl || (projectId ? buildProjectApiPath(projectId, "/preview") : null);
      if (!previewSource) return;

      if (tracksAssets) {
        assetReadinessGenRef.current = usePlayerStore.getState().beginAssetReadinessLoad();
      }

      let canceled = false;
      let cleanup: (() => void) | undefined;

      void loadPlayerModule().then(() => {
        if (canceled) return;

        // Create the web component imperatively to avoid JSX custom-element typing.
        const player = document.createElement("hyperframes-player") as HyperframesPlayerElement;
        const srcUrl = new URL(previewSource, window.location.origin);
        applyPreviewVariablesToUrl(srcUrl);
        const src = srcUrl.origin === window.location.origin ? srcUrl.pathname + srcUrl.search : srcUrl.href;
        const retryPreview = () => {
          retryCountRef.current += 1;
          const retryUrl = new URL(src, window.location.origin);
          retryUrl.searchParams.set("_hfStudioRetry", String(retryCountRef.current));
          setPreviewError(null);
          if (tracksAssets) {
            assetReadinessGenRef.current = usePlayerStore.getState().beginAssetReadinessLoad();
          }
          setCompositionLoading(true);
          loadStartedAtRef.current = performance.now();
          loadIdRef.current += 1;
          setVisualFrameReady(false);
          setAwaitingFirstFrame(startsWithLoading);
          if (startsWithLoading) player.setAttribute("assets-loading-ui", "none");
          player.removeAttribute("no-load-timeout");
          player.setAttribute("src", retryUrl.origin === window.location.origin ? retryUrl.pathname + retryUrl.search : retryUrl.href);
        };
        retryPreviewRef.current = retryPreview;
        const stopLoadingBrand = brandPlayerLoading(player);
        const iframe = player.iframeElement;
        playerRef.current = player;
        const preventToggle = (e: Event) => e.stopImmediatePropagation();
        const handleShaderTransitionState = (event: Event) => {
          const loading = getShaderTransitionLoading(event);
          if (loading !== null) setShaderTransitionLoading(loading);
        };
        let loadedDocument: Document | null = null;
        const handleReady = () => {
          setPreviewError(null);
          setCompositionLoading(false);
          if (iframe.contentDocument && runtimeBootedIn(iframe)) handleLoad();
        };
        const handlePainted = () => {
          player.removeAttribute("assets-loading-ui");
          setPainted(true);
          if (!startsWithLoading) {
            onPaintedRef.current?.({ iframe, startedAt: loadStartedAtRef.current, loadId: loadIdRef.current });
          }
        };
        const handleError = (event: Event) => {
          player.removeAttribute("assets-loading-ui");
          const message = readPreviewErrorMessage(event);
          onPreviewErrorRef.current?.(message);
          setPreviewError(message);
          setCompositionLoading(false);
          if (tracksAssets) {
            const store = usePlayerStore.getState();
            store.setPreviewLoadError(true);
            store.updateAssetReadiness(
              { status: "ready", completed: 0, total: 0, failed: [] },
              assetReadinessGenRef.current,
            );
          }
        };
        const handleLoad = () => {
          const doc = iframe.contentDocument;
          if (doc && doc === loadedDocument) return;
          loadedDocument = doc;
          loadCountRef.current++;
          setLoaded(true);
          setAssetScanTick((tick) => tick + 1);
          setPreviewError(null);
          setShaderTransitionLoading(false);
          setCompositionLoading(!player.ready);
          setPainted(Boolean(player.painted));
          // Reveal animation on reload (hot-reload, composition switch)
          if (loadCountRef.current > 1) {
            container.classList.remove("preview-revealing");
            void container.offsetWidth;
            container.classList.add("preview-revealing");
            const onEnd = () => container.classList.remove("preview-revealing");
            container.addEventListener("animationend", onEnd, { once: true });
          }
          onLoadRef.current();
          announcePreviewDocumentLoaded(iframe);

          // Show a loading overlay until requested media and Lottie assets
          // are ready. Without this users can click play before audio has
          // buffered — the runtime is resilient (queued play() resolves once
          // data arrives), but the overlay communicates why the first frame
          // or first audio beat may lag.
          //
          // Skip the overlay on subsequent loads (content refreshes via
          // refreshPlayer). The browser has already cached the assets from
          // the first load, so they resolve near-instantly and the overlay
          // just creates a disruptive flash.
          //
          // Poll with a 10 s elapsed-time safety cap. Counting interval ticks
          // stretches the wait when background tabs throttle timers. If the cap
          // trips we hide the overlay so the UI doesn't appear stuck forever,
          // but we log a debug warning so the case is diagnosable — a long
          // cold video or a broken asset can legitimately exceed 10 s on a
          // slow network.
          if (assetPollRef.current) clearInterval(assetPollRef.current);
          const isContentRefresh = loadCountRef.current > 1;
          // The iframe can load about:blank before its actual composition. Ownership
          // follows the live preview’s first frame rather than the number of DOM load events.
          const audioOnly = Boolean(
            awaitingFrameRef.current && retryCountRef.current === 0 && doc && player.ready && waitingOnlyForAudio(doc),
          );
          setVisualFrameReady(audioOnly);
          let lastUnloaded = !audioOnly && !isContentRefresh && hasUnloadedAssets(iframe, false);
          if (lastUnloaded) {
            setAssetsLoading(true);
            const deadline = performance.now() + ASSET_WAIT_DEADLINE_MS;
            assetPollRef.current = setInterval(() => {
              lastUnloaded = hasUnloadedAssets(iframe, lastUnloaded);
              if (!lastUnloaded || performance.now() >= deadline) {
                if (lastUnloaded) {
                  console.debug(
                    "[studio] asset readiness poll hit the 10s cap, continuing with unloaded assets",
                  );
                }
                if (assetPollRef.current) clearInterval(assetPollRef.current);
                assetPollRef.current = null;
                setAssetsLoading(false);
              }
            }, 100);
          } else {
            setAssetsLoading(false);
          }
        };

        // Attach lifecycle listeners before assigning src or connecting the
        // custom element. A warm local iframe can otherwise finish before
        // Studio observes its load and never initialize the timeline.
        iframe.addEventListener("load", handleLoad);
        player.addEventListener("click", preventToggle, { capture: true });
        player.addEventListener("shadertransitionstate", handleShaderTransitionState);
        player.addEventListener("ready", handleReady);
        player.addEventListener("painted", handlePainted);
        player.addEventListener("error", handleError);

        // Bridge the inner iframe to the forwarded ref for useTimelinePlayer.
        if (typeof ref === "function") {
          ref(iframe);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLIFrameElement | null>).current = iframe;
        }

        // Studio already covers this first load. A second asset spinner would add
        // its fade to the first paint; shader and playback readiness stay native.
        if (awaitingFrameRef.current) player.setAttribute("assets-loading-ui", "none");
        player.setAttribute("shader-capture-scale", "1");
        player.setAttribute("shader-loading", "player");
        player.setAttribute("low-power-idle", "");
        player.toggleAttribute("no-load-timeout", noLoadTimeout === true);
        player.setAttribute("width", String(portrait ? 1080 : 1920));
        player.setAttribute("height", String(portrait ? 1920 : 1080));
        player.style.width = "100%";
        player.style.height = "100%";
        player.style.display = "block";
        player.style.background = "transparent";
        loadStartedAtRef.current = performance.now();
        loadIdRef.current += 1;
        player.setAttribute("src", src);
        container.appendChild(player);

        enableInteractiveIframe(player);

        cleanup = () => {
          playerRef.current = null;
          stopLoadingBrand();
          iframe.removeEventListener("load", handleLoad);
          player.removeEventListener("click", preventToggle, { capture: true });
          player.removeEventListener("shadertransitionstate", handleShaderTransitionState);
          player.removeEventListener("ready", handleReady);
          player.removeEventListener("painted", handlePainted);
          player.removeEventListener("error", handleError);
          if (assetPollRef.current) clearInterval(assetPollRef.current);
          assetPollRef.current = null;
          // `remove()` rather than `container.removeChild(player)`: by the time
          // this cleanup runs the element may already be detached — React can
          // re-render the container, a crossfade refresh can swap it, or a
          // translation/extension can reparent it. `removeChild` then throws
          // NotFoundError, which the error boundary turns into a full-screen
          // "Something went wrong". `remove()` is a no-op when already detached.
          player.remove();
          if (retryPreviewRef.current === retryPreview) retryPreviewRef.current = null;
          // Clear the forwarded ref only if it still points to THIS iframe.
          // During crossfade refreshes the retiring Player unmounts after the
          // new Player has already assigned its iframe to the same ref — blindly
          // nulling it would break seeking in the new Player.
          // Callback refs are skipped — we can't read back the current value to
          // guard against clobbering a newer assignment. The mutable-ref branch
          // (the only path used today) is guarded by identity check.
          if (typeof ref === "function") {
            // no-op: can't safely guard callback refs
          } else if (ref) {
            const mutableRef = ref as React.MutableRefObject<HTMLIFrameElement | null>;
            if (mutableRef.current === iframe) {
              mutableRef.current = null;
            }
          }
        };
      }, () => {
        if (canceled) return;
        setPreviewError(PLAYER_MODULE_ERROR);
        setCompositionLoading(false);
        if (tracksAssets) {
          const store = usePlayerStore.getState();
          store.setPreviewLoadError(true);
          store.updateAssetReadiness(
            { status: "ready", completed: 0, total: 0, failed: [] },
            assetReadinessGenRef.current,
          );
        }
        onPreviewErrorRef.current?.(PLAYER_MODULE_ERROR);
      });

      return () => {
        canceled = true;
        cleanup?.();
      };
    });

    // Surface a "Continue anyway" escape hatch once the asset wait drags on.
    // eslint-disable-next-line no-restricted-syntax
    useEffect(() => {
      if (!assetsLoading) {
        setAssetWaitLong(false);
        return;
      }
      const timer = setTimeout(() => setAssetWaitLong(true), 3000);
      return () => clearTimeout(timer);
    }, [assetsLoading]);

    useEffect(() => {
      if (assetFadeRef.current) {
        clearTimeout(assetFadeRef.current);
        assetFadeRef.current = null;
      }

      if (assetsLoading) {
        setAssetOverlayVisible(true);
        setAssetOverlayFading(false);
        return;
      }

      setAssetOverlayFading(true);
      assetFadeRef.current = setTimeout(() => {
        setAssetOverlayVisible(false);
        setAssetOverlayFading(false);
        assetFadeRef.current = null;
      }, 240);

      return () => {
        if (assetFadeRef.current) {
          clearTimeout(assetFadeRef.current);
          assetFadeRef.current = null;
        }
      };
    }, [assetsLoading]);

    const handleContinueAnyway = () => {
      if (assetPollRef.current) {
        clearInterval(assetPollRef.current);
        assetPollRef.current = null;
      }
      setAssetsLoading(false);
    };

    const firstFrameShown =
      loaded && (painted || visualFrameReady) && !compositionLoading && !shaderTransitionLoading && !previewError;
    const readyToShow = firstFrameShown && !assetsLoading;
    // Work waiting on the boot starts at the first frame, while media still buffers.
    useEffect(() => {
      if (firstFrameShown) usePlayerStore.getState().markPreviewBooted();
    }, [firstFrameShown]);
    // Let the frame reach the compositor before dismissing the poster and reporting it.
    useEffect(() => {
      if (!readyToShow) {
        onReadyToShowChangeRef.current?.(false);
        return;
      }
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          setAwaitingFirstFrame(false);
          onReadyToShowChangeRef.current?.(true);
          const iframe = playerRef.current?.iframeElement;
          if (iframe && startsWithLoading) {
            onPaintedRef.current?.({ iframe, startedAt: loadStartedAtRef.current, loadId: loadIdRef.current });
          }
        });
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }, [readyToShow]);

    useEffect(() => {
      if (previewError) usePlayerStore.getState().markPreviewBooted();
    }, [previewError]);

    // Track every referenced asset in the live composition document once the
    // runtime has booted so Studio unlocks only after composition media settles.
    useEffect(() => {
      if (!tracksAssets || previewError || !loaded || compositionLoading) return;
      const iframe = playerRef.current?.iframeElement;
      const doc = iframe?.contentDocument;
      if (!doc) return;
      const isInitialBlank =
        doc.URL === "about:blank" &&
        (doc.body?.childElementCount ?? 0) === 0 &&
        !runtimeBootedIn(iframe);
      if (isInitialBlank) return;
      const generation = assetReadinessGenRef.current;
      const tracker = trackDocumentAssetReadiness(
        doc,
        iframe.contentWindow,
        (progress) => {
          usePlayerStore.getState().updateAssetReadiness(progress, generation);
        },
      );
      registerRetryFailedAssetsHandler(generation, () => tracker.retryFailed());
      return () => {
        registerRetryFailedAssetsHandler(generation, null);
        tracker.dispose();
      };
    }, [tracksAssets, previewError, loaded, compositionLoading, assetScanTick]);

    useEffect(() => {
      const timer = setTimeout(
        () => usePlayerStore.getState().markPreviewBooted(),
        PREVIEW_BOOT_DEADLINE_MS,
      );
      return () => clearTimeout(timer);
    }, [projectId]);

    const compositionWaitShown =
      !suppressLoadingOverlay && !compositionOverlayDeferred && shouldShowCompositionLoadingOverlay(compositionLoading);
    const assetWaitShown =
      assetOverlayVisible && !shaderTransitionLoading && !compositionWaitShown && !previewError;
    // Displaying the first frame is local to the canvas. Timeline and editor controls
    // continue to use their existing readiness signals.
    const initialWait = awaitingFirstFrame && !assetWaitLong;
    const showCompositionOverlay = studioDraws(!previewError && (initialWait || compositionWaitShown), host.loadingUi);
    const showAssetOverlay = studioDraws(!initialWait && assetWaitShown, host.loadingUi);

    useEffect(() => {
      onCompositionLoadingChange?.(compositionWaitShown || assetWaitShown);
    }, [onCompositionLoadingChange, compositionWaitShown, assetWaitShown]);

    return (
      <div
        className="relative w-full h-full max-w-full max-h-full overflow-hidden flex items-center justify-center"
        style={style}
      >
        <div ref={containerRef} className="w-full h-full" />
        {showCompositionOverlay && <PreviewCompositionLoading />}
        {showAssetOverlay && (
          <div
            className="absolute inset-0 bg-black flex items-center justify-center z-20 select-none"
            data-hyperframes-ignore=""
            draggable={false}
            style={{
              opacity: assetOverlayFading ? 0 : 1,
              pointerEvents: assetOverlayFading ? "none" : "auto",
              transition: "opacity 180ms ease-in",
            }}
            onDragStart={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="flex flex-col items-center gap-3">
              <HyperframesLoader
                title={t("Preparing preview assets")}
                detail="Waiting for media and motion assets before playback starts."
                size={56}
              />
              {assetWaitLong && (
                <Button variant="plain"
                  type="button"
                  onClick={handleContinueAnyway}
                  className="px-3 py-1.5 text-[11px] rounded-md border border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800 transition-colors"
                >
                  {t("Continue anyway")}</Button>
              )}
            </div>
          </div>
        )}
        {previewError && (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center bg-black/90 px-6 text-center"
            data-hyperframes-ignore=""
            data-testid="composition-preview-error"
          >
            <div className="max-w-sm">
              <p className="text-sm font-semibold text-white">{t("Preview failed to load")}</p>
              <p className="mt-1 text-xs text-neutral-400">{t(previewError)}</p>
              <Button variant="plain"
                type="button"
                className="mt-4 rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-neutral-200"
                onClick={() => previewError === PLAYER_MODULE_ERROR ? window.location.reload() : retryPreviewRef.current?.()}
              >
                {t(previewError === PLAYER_MODULE_ERROR ? "Reload editor" : "Retry preview")}</Button>
            </div>
          </div>
        )}
      </div>
    );
  },
);

export const Player = forwardRef<HTMLIFrameElement, PlayerProps>((props, ref) => {
  const origin = isolatedPreviewOrigin();
  return origin ? <IsolatedPlayer {...props} origin={origin} ref={ref} /> : <SameOriginPlayer {...props} ref={ref} />;
});

Player.displayName = "Player";
