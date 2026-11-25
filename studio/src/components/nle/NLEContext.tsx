import { beginTimelineSourceRead, openTimelineSource } from "../../player/lib/peerTimeline";
import { readCurrentProjectSource } from "../../utils/readCurrentProjectSource";
import { buildProjectApiPath } from "../../utils/projectRouting";
import {
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTimelinePlayer } from "../../player/hooks/useTimelinePlayer";
import { usePlayerStore, type TimelineElement } from "../../player/store/playerStore";
import { thumbnailRevisionOf } from "../../player/store/thumbnailSlice";
import {
  getCompositionCacheKeyRevision,
  subscribeCompositionCacheRevision,
} from "../../player/lib/clientCompositionCapture";
import {
  getCachedCompositionTimeline,
  saveCachedCompositionTimeline,
} from "../../player/lib/compositionTimelineCache";
import type { PreviewIframeSlot } from "../../player/hooks/useTimelineSyncCallbacks";
import type { CompositionLevel } from "./CompositionBreadcrumb";
import { useCompositionStack } from "./useCompositionStack";
import { setCompositionSourceMap } from "../editor/domEditingDom";
import { ensureMotionPathPluginLoaded } from "../../utils/gsapSoftReload";
import { useAssetPreviewStore } from "../../utils/assetPreviewStore";
import { createStableContext } from "../../utils/hmrStableContext";
import { thumbnailScheduler } from "../../player/lib/thumbnailScheduler";
import { previewReloadBegun } from "../../player/previewReloading";

export function shouldDisableTimelineWhileCompositionLoading(compositionLoading: boolean): boolean {
  return compositionLoading;
}

export interface NLEContextValue {
  projectId: string;
  // player (from useTimelinePlayer — single instance for the whole shell)
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number, options?: { keepPlaying?: boolean; follow?: boolean }) => boolean;
  refreshPlayer: () => void;
  onIframeLoad: () => void;
  // The hidden reload iframe NLEPreview renders next to the live one during a full reload.
  previewSlots: PreviewIframeSlot[];
  onShadowIframeLoad: (gen: number) => void;
  onShadowReadyChange: (gen: number, ready: boolean) => void;
  onShadowError: (gen: number, message: string) => void;
  setShadowIframeNode: (node: HTMLIFrameElement | null) => void;
  resetPreviewSlots: () => void;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  // composition stack (from useCompositionStack)
  compositionStack: CompositionLevel[];
  updateCompositionStack: React.Dispatch<React.SetStateAction<CompositionLevel[]>>;
  handleNavigateComposition: (index: number) => void;
  handleDrillDown: (element: TimelineElement) => void;
  compIdToSrc: Map<string, string>;
  initialTimelineElements?: TimelineElement[];
  initialTimelineDuration?: number;
  hasCachedTimelineSnapshot?: boolean;
  // layout state
  // composition loading
  compositionLoading: boolean;
  setCompositionLoading: (loading: boolean) => void;
  timelineDisabled: boolean;
  timelineSessionEpoch: number;
  hasLoadedOnceRef: React.MutableRefObject<boolean>;
  // preview composition size (for preview block drop)
  previewCompositionSize: { width: number; height: number } | null;
  setPreviewCompositionSize: (size: { width: number; height: number } | null) => void;
}

const NLEContext = createStableContext<NLEContextValue | null>("NLEContext", null);

export function useNLEContext(): NLEContextValue {
  const ctx = useContext(NLEContext);
  if (!ctx) throw new Error("useNLEContext must be used within an NLEProvider");
  return ctx;
}

export interface NLEProviderProps {
  projectId: string;
  refreshKey?: number;
  activeCompositionPath?: string | null;
  onIframeRef?: (iframe: HTMLIFrameElement | null) => void;
  onCompositionChange?: (compositionPath: string | null) => void;
  onCompIdToSrcChange?: (map: Map<string, string>) => void;
  onCompositionLoadingChange?: (loading: boolean) => void;
  /** A preview reload was abandoned; the previous preview is still showing. */
  onPreviewReloadFailed?: (message: string) => void;
  children: ReactNode;
}

export function NLEProvider({
  projectId,
  refreshKey,
  activeCompositionPath,
  onIframeRef,
  onCompositionChange,
  onCompIdToSrcChange,
  onCompositionLoadingChange,
  onPreviewReloadFailed,
  children,
}: NLEProviderProps) {
  const shadowPromotedRef = useRef<() => void>(() => {});
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    iframeRef,
    play,
    pause,
    togglePlay,
    seek,
    onIframeLoad: baseOnIframeLoad,
    refreshPlayer,
    previewSlots,
    onShadowIframeLoad,
    onShadowReadyChange,
    onShadowError,
    setShadowIframeNode,
    resetPreviewSlots,
  } = useTimelinePlayer({
    onShadowPromoted: () => shadowPromotedRef.current(),
    onPreviewReloadFailed,
  });

  // Switch both project-scoped stores before the browser paints the new editor.
  useLayoutEffect(() => {
    usePlayerStore.getState().beginTimelineSession(projectId);
    useAssetPreviewStore.getState().clearPreviewAsset();
    return () => thumbnailScheduler.endBackgroundCaptures(projectId);
  }, [projectId]);

  // Authored composition size measured from the loaded preview — drives drop
  // coordinate mapping so blocks land where the user pointed on any comp size.
  const [previewCompositionSize, setPreviewCompositionSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  // Lightweight reload: change iframe src instead of destroying the Player.
  const prevRefreshKeyRef = useRef(refreshKey);
  useEffect(() => {
    try {
      if (refreshKey === prevRefreshKeyRef.current) return;
      prevRefreshKeyRef.current = refreshKey;
      refreshPlayer();
    } finally {
      previewReloadBegun();
    }
  }, [refreshKey, refreshPlayer]);

  // Steps that follow every load of the live iframe, including a reload promoted in place.
  const afterLiveIframeLoad = useCallback(() => {
    // Pre-load + register MotionPathPlugin once so adding a motion path in the
    // studio doesn't take the async plugin-load flash path on the first soft
    // reload (the comp may not ship the plugin until it actually uses one).
    ensureMotionPathPluginLoaded(iframeRef.current);
    onIframeRef?.(iframeRef.current);
  }, [iframeRef, onIframeRef]);
  shadowPromotedRef.current = afterLiveIframeLoad;

  const onIframeLoad = useCallback(() => {
    baseOnIframeLoad();
    afterLiveIframeLoad();
  }, [baseOnIframeLoad, afterLiveIframeLoad]);

  const {
    compositionStack,
    updateCompositionStack,
    handleNavigateComposition,
    handleDrillDown: drillDown,
    compIdToSrc,
    setCompIdToSrc,
  } = useCompositionStack({
    projectId,
    activeCompositionPath,
    onCompositionChange,
  });

  const activeSource = compositionStack.length > 1 ? compositionStack[compositionStack.length - 1]!.id : "index.html";
  useLayoutEffect(() => openTimelineSource(projectId, activeSource), [projectId, activeSource]);

  // Wrap handleDrillDown to also scan the iframe DOM for data-composition-src
  const iframeRef_ = iframeRef;
  const handleDrillDown = useCallback(
    (element: TimelineElement) => {
      if (!element.compositionSrc) return;
      usePlayerStore.getState().setSelectedElementId(null);
      // Check compIdToSrc map first; then scan iframe DOM; then fall through to drillDown
      const compId = element.id;
      let resolvedPath = compIdToSrc.get(compId);
      if (!resolvedPath) {
        try {
          const doc = iframeRef_.current?.contentDocument;
          if (doc) {
            const host = doc.querySelector(
              `[data-composition-id="${CSS.escape(compId)}"][data-composition-src]`,
            );
            if (host) {
              resolvedPath = host.getAttribute("data-composition-src") || undefined;
            }
          }
        } catch {
          /* cross-origin */
        }
      }
      // Delegate with the resolved compositionSrc (may be same as original)
      drillDown({
        id: compId,
        label: element.label,
        compositionSrc: resolvedPath ?? element.compositionSrc,
      });
    },
    [compIdToSrc, drillDown, iframeRef_],
  );

  // Composition ID → file path map from raw index.html
  const compIdToSrcRef = useRef(compIdToSrc);
  compIdToSrcRef.current = compIdToSrc;
  const onCompIdToSrcChangeRef = useRef(onCompIdToSrcChange);
  onCompIdToSrcChangeRef.current = onCompIdToSrcChange;

  useEffect(() => {
    const controller = new AbortController();
    const emptyMap = new Map<string, string>();
    setCompIdToSrc(emptyMap);
    setCompositionSourceMap(emptyMap);
    onCompIdToSrcChangeRef.current?.(emptyMap);

    const rememberSource = beginTimelineSourceRead(projectId, "index.html");
    readCurrentProjectSource(projectId, "index.html", buildProjectApiPath(projectId, "/files/index.html"), undefined, controller.signal)
      .then(({ response, data }) => {
        if (controller.signal.aborted) return;
        if (!response.ok || typeof data?.content !== "string") throw new Error(`Invalid source response (${response.status})`);
        const html = data.content;
        const map = new Map<string, string>();
        const re =
          /data-composition-id=["']([^"']+)["'][^>]*data-composition-src=["']([^"']+)["']|data-composition-src=["']([^"']+)["'][^>]*data-composition-id=["']([^"']+)["']/g;
        let match;
        while ((match = re.exec(html)) !== null) {
          const id = match[1] || match[4];
          const src = match[2] || match[3];
          if (id && src) map.set(id, src);
        }
        setCompIdToSrc(map);
        // Let DOM source-resolution recover a subcomposition element's source file
        // (the runtime drops the linkage when inlining — see getSourceFileForElement).
        setCompositionSourceMap(map);
        onCompIdToSrcChangeRef.current?.(map);
        rememberSource(html, { version: data.version ?? response.headers?.get("etag") });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Non-fatal: drill-down still works via the iframe DOM scan; without
        // the map only source-file resolution for sub-comps degrades.
        console.warn("[studio] Couldn't load composition source map from index.html:", err);
      });
    return () => controller.abort();
  }, [projectId, setCompIdToSrc]);

  // Patch elements with compositionSrc whenever elements or compIdToSrc change.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (compIdToSrc.size === 0) return;
    const patchElements = (elements: TimelineElement[]): TimelineElement[] | null => {
      const map = compIdToSrcRef.current;
      if (map.size === 0) return null;
      let patched = false;
      const updated = elements.map((el) => {
        if (el.compositionSrc) return el;
        const src = map.get(el.id) ?? map.get(el.id.replace(/-(host|comp|layer)$/, ""));
        if (src) {
          patched = true;
          return { ...el, compositionSrc: src };
        }
        return el;
      });
      return patched ? updated : null;
    };
    const patched = patchElements(usePlayerStore.getState().elements);
    if (patched) usePlayerStore.getState().setElements(patched);
    let patching = false;
    return usePlayerStore.subscribe((state, prev) => {
      if (patching) return;
      if (state.elements === prev.elements || state.elements.length === 0) return;
      if (state.elements.every((el) => el.compositionSrc)) return;
      patching = true;
      const result = patchElements(state.elements);
      if (result) state.setElements(result);
      patching = false;
    });
  }, [compIdToSrc]);

  const hasLoadedOnceRef = useRef(false);
  const [compositionLoading, setCompositionLoadingRaw] = useState(true);
  const activePreviewScope =
    compositionStack.length > 1
      ? `${projectId}::${compositionStack[compositionStack.length - 1]?.previewUrl ?? ""}`
      : `${projectId}::master`;
  const loadedScopeRef = useRef(activePreviewScope);
  useLayoutEffect(() => {
    if (loadedScopeRef.current === activePreviewScope) return;
    loadedScopeRef.current = activePreviewScope;
    // Allow the newly mounted Player for the switched project/composition to report
    // loading again without forcing compositionLoading=true out-of-band (which would
    // strand the timeline disabled if Player already settled before this effect ran).
    hasLoadedOnceRef.current = false;
  }, [activePreviewScope]);
  const setCompositionLoading = useCallback((loading: boolean) => {
    if (!loading) hasLoadedOnceRef.current = true;
    if (loading && hasLoadedOnceRef.current) return;
    setCompositionLoadingRaw(loading);
  }, []);
  const timelineDisabled = shouldDisableTimelineWhileCompositionLoading(compositionLoading);
  const timelineSessionEpoch = usePlayerStore((state) => state.timelineSessionEpoch);
  const timelineReady = usePlayerStore(
    (state) => state.timelineProjectId === projectId && state.timelineReady,
  );
  const activeCompPreviewUrl =
    compositionStack.length > 1
      ? compositionStack[compositionStack.length - 1]!.previewUrl
      : buildProjectApiPath(projectId, "/preview");
  const activeThumbRevision = usePlayerStore((state) =>
    thumbnailRevisionOf(state.thumbnailRevisions, activeSource),
  );
  const subscribeActiveCompRev = useCallback(
    (listener: () => void) => subscribeCompositionCacheRevision(projectId, listener),
    [projectId],
  );
  const getActiveCompRev = useCallback(
    () => getCompositionCacheKeyRevision(projectId, activeCompPreviewUrl, activeThumbRevision),
    [activeCompPreviewUrl, activeThumbRevision, projectId],
  );
  const activeCacheRev = useSyncExternalStore(subscribeActiveCompRev, getActiveCompRev, () => "");
  const activeRevisionKey = `${activeCacheRev}|t:${activeThumbRevision}`;

  // Persist settled timeline structure per composition so switching back renders tracks
  // and cached thumbnails immediately while the live preview iframe boots.
  useEffect(() => {
    if (
      compositionLoading ||
      !timelineReady ||
      !hasLoadedOnceRef.current ||
      loadedScopeRef.current !== activePreviewScope
    ) {
      return;
    }
    const saveCurrent = () => {
      const state = usePlayerStore.getState();
      if (
        state.timelineProjectId !== projectId ||
        !state.timelineReady ||
        state.elements.length === 0 ||
        !(state.duration > 0)
      ) {
        return;
      }
      saveCachedCompositionTimeline({
        projectId,
        compPath: activeSource,
        revisionKey: activeRevisionKey,
        elements: state.elements,
        duration: state.duration,
      });
    };
    saveCurrent();
    return usePlayerStore.subscribe((state, prev) => {
      if (state.elements === prev.elements && state.duration === prev.duration) return;
      saveCurrent();
    });
  }, [
    activePreviewScope,
    activeRevisionKey,
    activeSource,
    compositionLoading,
    projectId,
    timelineReady,
  ]);

  const stackMatchesActiveComp =
    !activeCompositionPath ||
    (activeCompositionPath === "index.html"
      ? activeSource === "index.html"
      : activeSource === activeCompositionPath);
  const cachedTimeline = stackMatchesActiveComp
    ? getCachedCompositionTimeline(projectId, activeSource, activeRevisionKey)
    : null;

  useEffect(() => {
    onCompositionLoadingChange?.(compositionLoading);
  }, [compositionLoading, onCompositionLoadingChange]);

  const onIframeRefStable = useRef(onIframeRef);
  onIframeRefStable.current = onIframeRef;
  useEffect(() => {
    onIframeRefStable.current?.(iframeRef.current);
  }, [compositionStack.length, refreshKey, iframeRef]);

  const value: NLEContextValue = {
    projectId,
    iframeRef,
    play,
    pause,
    containerRef,
    togglePlay,
    seek,
    refreshPlayer,
    onIframeLoad,
    previewSlots,
    onShadowIframeLoad,
    onShadowReadyChange,
    onShadowError,
    setShadowIframeNode,
    resetPreviewSlots,
    compositionStack,
    updateCompositionStack,
    handleNavigateComposition,
    handleDrillDown,
    compIdToSrc,
    initialTimelineElements: cachedTimeline?.elements,
    initialTimelineDuration: cachedTimeline?.duration,
    hasCachedTimelineSnapshot: Boolean(cachedTimeline),
    compositionLoading,
    setCompositionLoading,
    timelineDisabled,
    timelineSessionEpoch,
    hasLoadedOnceRef,
    previewCompositionSize,
    setPreviewCompositionSize,
  };

  return <NLEContext.Provider value={value}>{children}</NLEContext.Provider>;
}
