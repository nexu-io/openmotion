import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/I18n";
import {
  EDITOR_ASSET_AUTO_RELEASE_MS,
  EDITOR_ASSET_ESCAPE_HATCH_MS,
  UnifiedEditorOpeningCover,
  useEditorOpeningGate,
} from "../motion/editorOpeningGate";
import { usePlayerStore } from "../player/store/playerStore";
import {
  hasRetryFailedAssetsHandler,
  retryFailedPreviewAssets,
} from "../player/store/readinessSlice";
import { thumbnailScheduler } from "../player/lib/thumbnailScheduler";
import { thumbnailRevisionOf } from "../player/store/thumbnailSlice";
import {
  canCaptureCompositionInBrowser,
  hasAnyCachedCompositionCapture,
  MAX_INITIAL_TIMELINE_PREVIEW_GATE,
  selectInitialGateCompositionPaths,
  TIMELINE_PREVIEW_GATE_TIMEOUT_MS,
} from "../player/lib/clientCompositionCapture";
import { getCachedCloudDisklessMode } from "../utils/cloudRuntime";
import type { PreviewAssetFailure } from "../player/lib/previewAssetReadiness";
import type { AppToast } from "../utils/studioHelpers";

export { EDITOR_ASSET_AUTO_RELEASE_MS, EDITOR_ASSET_ESCAPE_HATCH_MS };
const TIMELINE_PREVIEW_REGISTER_GRACE_MS = 400;
export const EDITOR_ASSET_PROGRESS_DEBOUNCE_MS = 120;
export const EDITOR_ASSET_PROGRESS_MIN_VISIBLE_MS = 300;
const EXIT_FADE_MS = 200;

export interface EditorAssetLoadingOverlayProps {
  visible: boolean;
  onSkip: () => void;
  escapeDelayMs?: number;
  autoReleaseMs?: number;
}

/**
 * Seamless solid full-cover opening gate shared with `MotionApp`'s shell loading
 * boundary. When mounted inside `EditorOpeningGateHost`, delegates state to the
 * single host cover so shell resolution -> Suspense -> editor readiness stay on
 * one unbroken DOM node without resetting copy or animation; renders directly
 * when mounted standalone.
 */
export function EditorAssetLoadingOverlay({
  visible,
  onSkip,
  escapeDelayMs = EDITOR_ASSET_ESCAPE_HATCH_MS,
  autoReleaseMs = EDITOR_ASSET_AUTO_RELEASE_MS,
}: EditorAssetLoadingOverlayProps) {
  const openingGate = useEditorOpeningGate();
  const ownerRef = useRef<symbol | null>(null);
  if (!ownerRef.current) ownerRef.current = Symbol("editor-opening-gate");
  const onSkipRef = useRef(onSkip);
  onSkipRef.current = onSkip;
  const stableSkip = useCallback(() => onSkipRef.current(), []);

  useLayoutEffect(() => {
    if (!openingGate) return;
    openingGate.setDelegation({
      owner: ownerRef.current!,
      visible,
      onSkip: stableSkip,
      escapeDelayMs,
      autoReleaseMs,
    });
  }, [autoReleaseMs, escapeDelayMs, openingGate, stableSkip, visible]);

  useLayoutEffect(() => {
    if (!openingGate) return;
    const owner = ownerRef.current!;
    return () => {
      openingGate.clearDelegation(owner);
    };
  }, [openingGate]);

  if (openingGate) return null;

  return (
    <UnifiedEditorOpeningCover
      visible={visible}
      onSkip={onSkip}
      escapeDelayMs={escapeDelayMs}
      autoReleaseMs={autoReleaseMs}
      fadeOnExit
    />
  );
}

export interface EditorAssetProgressBarProps {
  loading: boolean;
  completed: number;
  total: number;
  indeterminate?: boolean;
  debounceMs?: number;
}

/**
 * Non-blocking slim progress bar pinned directly beneath the editor header
 * while composition assets preload or retry in the background. Appears after
 * a brief debounce, holds long enough to read once shown, and never blocks input.
 */
export function EditorAssetProgressBar({
  loading,
  completed,
  total,
  indeterminate = false,
  debounceMs = EDITOR_ASSET_PROGRESS_DEBOUNCE_MS,
}: EditorAssetProgressBarProps) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef<number>(0);

  useEffect(() => {
    if (!loading) {
      if (!mounted) {
        setVisible(false);
        return;
      }
      const elapsed = shownAtRef.current > 0 ? Date.now() - shownAtRef.current : EDITOR_ASSET_PROGRESS_MIN_VISIBLE_MS;
      const holdMs = Math.max(0, EDITOR_ASSET_PROGRESS_MIN_VISIBLE_MS - elapsed);
      let unmountTimer: ReturnType<typeof setTimeout> | undefined;
      const fadeTimer = setTimeout(() => {
        setVisible(false);
        unmountTimer = setTimeout(() => {
          shownAtRef.current = 0;
          setMounted(false);
        }, EXIT_FADE_MS);
      }, holdMs);
      return () => {
        clearTimeout(fadeTimer);
        if (unmountTimer) clearTimeout(unmountTimer);
      };
    }

    if (mounted) {
      setVisible(true);
      return;
    }

    let rafId = 0;
    const showTimer = setTimeout(() => {
      shownAtRef.current = Date.now();
      setMounted(true);
      rafId = requestAnimationFrame(() => setVisible(true));
    }, debounceMs);
    return () => {
      clearTimeout(showTimer);
      cancelAnimationFrame(rafId);
    };
  }, [debounceMs, loading, mounted]);

  if (!mounted) return null;

  const hasDeterminateCount = !indeterminate && total > 0;
  const boundedCompleted = hasDeterminateCount ? Math.min(total, Math.max(0, completed)) : 0;
  const ratio = hasDeterminateCount ? boundedCompleted / total : 0;
  const displayRatio = hasDeterminateCount ? Math.max(loading ? 0.06 : 1, ratio) : 0;
  const percent = Math.round(ratio * 100);

  return (
    <div
      className="motion-editor-asset-bar"
      data-visible={visible ? "true" : "false"}
      data-testid="editor-asset-progress-bar"
      role="progressbar"
      aria-label={t("Preparing project assets")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={hasDeterminateCount ? percent : undefined}
    >
      <div
        className="motion-editor-asset-bar-fill"
        data-indeterminate={hasDeterminateCount ? undefined : "true"}
        style={hasDeterminateCount ? { transform: `scaleX(${displayRatio})` } : undefined}
      />
    </div>
  );
}

type ShowToastFn = (
  message: string,
  tone?: AppToast["tone"],
  presentation?: AppToast["presentation"],
  action?: AppToast["action"],
) => number;

export function formatAssetFailureMessage(
  failed: readonly PreviewAssetFailure[],
  t: (message: string, values?: Record<string, string | number>) => string,
): string {
  if (failed.length === 1) {
    return t("{count} asset failed to load ({name})", { count: 1, name: failed[0].label });
  }
  return t("{count} assets failed to load", { count: failed.length });
}

function hasNonDomRetryableFailure(failed: readonly PreviewAssetFailure[]): boolean {
  return failed.some((item) => item.kind === "font" || item.kind === "lottie");
}

let activeRetryRunner: (() => Promise<void>) | null = null;

/**
 * Trigger the active editor's asset retry flow (used by both the failure toast and
 * the persistent PlayerControls retry pill). Falls back to calling the registered
 * preview retry handler directly when invoked outside a mounted StudioApp (e.g. unit tests).
 */
export async function triggerEditorAssetRetry(): Promise<void> {
  if (activeRetryRunner) {
    await activeRetryRunner();
    return;
  }
  const store = usePlayerStore.getState();
  if (store.assetReadinessRetrying) return;
  store.setAssetReadinessRetrying(true);
  try {
    await retryFailedPreviewAssets();
    if (store.timelineProjectId) {
      thumbnailScheduler.retryFailed(store.timelineProjectId);
    }
  } finally {
    usePlayerStore.getState().setAssetReadinessRetrying(false);
  }
}

/**
 * Coordinates the seamless initial full-cover opening gate (waiting for project files,
 * preview first frame, all composition assets, and initial visible timeline clip filmstrips
 * with 4s skip / 4.5s filmstrip cap / 12s global auto-release), post-entry non-blocking
 * top progress bar, partial-failure Toast with in-place Retry, and shared retry runner.
 */
export function useEditorAssetReadiness({
  projectId,
  fileTreeLoaded = true,
  compositionLoading = false,
  unreachableProject,
  compositionMissing,
  showToast,
  onReloadPreview,
}: {
  projectId: string | null;
  fileTreeLoaded?: boolean;
  compositionLoading?: boolean;
  unreachableProject: boolean;
  compositionMissing: boolean;
  showToast: ShowToastFn;
  onReloadPreview?: () => void;
}) {
  const { t } = useI18n();
  const assetPhase = usePlayerStore((s) => s.assetReadinessPhase);
  const completed = usePlayerStore((s) => s.assetReadinessCompleted);
  const total = usePlayerStore((s) => s.assetReadinessTotal);
  const failed = usePlayerStore((s) => s.assetReadinessFailed);
  const skipped = usePlayerStore((s) => s.assetReadinessSkipped);
  const retrying = usePlayerStore((s) => s.assetReadinessRetrying);
  const loadGeneration = usePlayerStore((s) => s.assetReadinessGeneration);
  const timelineProjectId = usePlayerStore((s) => s.timelineProjectId);
  const previewBooted = usePlayerStore((s) => s.previewBooted);
  const previewLoadError = usePlayerStore((s) => s.previewLoadError);
  const timelinePreviewCompleted = usePlayerStore((s) => s.timelinePreviewCompleted);
  const timelinePreviewTotal = usePlayerStore((s) => s.timelinePreviewTotal);
  const timelinePreviewSettledInitial = usePlayerStore((s) => s.timelinePreviewSettledInitial);
  const expectedTimelinePreviewCount = usePlayerStore((s) => {
    if (!projectId || s.thumbnailMode === "hidden") {
      return 0;
    }
    let expected = 0;
    if (getCachedCloudDisklessMode() && canCaptureCompositionInBrowser()) {
      const gatePaths = selectInitialGateCompositionPaths(s.elements, s.currentTime);
      for (const compPath of gatePaths) {
        const rev = thumbnailRevisionOf(s.thumbnailRevisions, compPath);
        if (!hasAnyCachedCompositionCapture(projectId, compPath, rev)) {
          expected += 1;
        }
      }
    }
    let videoCount = 0;
    for (const el of s.elements) {
      if (el.tag === "video" && el.src && !el.hidden) {
        videoCount += 1;
        if (videoCount >= MAX_INITIAL_TIMELINE_PREVIEW_GATE) break;
      }
    }
    return expected + videoCount;
  });

  const [settledProjectId, setSettledProjectId] = useState<string | null>(null);
  const [graceElapsedGen, setGraceElapsedGen] = useState<number>(-1);

  const suppress = !projectId || previewLoadError || unreachableProject || compositionMissing;
  const previewMatchesProject = timelineProjectId === null || timelineProjectId === projectId;
  const coreReady =
    fileTreeLoaded && previewMatchesProject && previewBooted && !compositionLoading && assetPhase === "ready";
  const hasPendingTimelinePreviewGate = expectedTimelinePreviewCount > 0 || timelinePreviewTotal > 0;
  const awaitingTimelinePreviews =
    !suppress &&
    !skipped &&
    settledProjectId !== projectId &&
    hasPendingTimelinePreviewGate &&
    !timelinePreviewSettledInitial &&
    coreReady;

  useEffect(() => {
    if (!awaitingTimelinePreviews || timelinePreviewTotal > 0) return;
    const timer = setTimeout(
      () => setGraceElapsedGen(loadGeneration),
      TIMELINE_PREVIEW_REGISTER_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [awaitingTimelinePreviews, loadGeneration, timelinePreviewTotal]);

  useEffect(() => {
    if (!awaitingTimelinePreviews) return;
    const timer = setTimeout(() => {
      usePlayerStore.getState().markInitialTimelinePreviewGateSettled(loadGeneration);
    }, TIMELINE_PREVIEW_GATE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [awaitingTimelinePreviews, loadGeneration]);

  const timelinePreviewsReady =
    !hasPendingTimelinePreviewGate ||
    timelinePreviewSettledInitial ||
    (timelinePreviewTotal > 0
      ? timelinePreviewCompleted >= timelinePreviewTotal
      : graceElapsedGen === loadGeneration);

  const allInitialReady = coreReady && timelinePreviewsReady;
  const blocking =
    !suppress &&
    !skipped &&
    settledProjectId !== projectId &&
    !allInitialReady;
  const backgroundLoading = !suppress && !blocking && (assetPhase === "loading" || retrying);

  useEffect(() => {
    if (!projectId) {
      setSettledProjectId(null);
      return;
    }
    if (suppress || skipped || allInitialReady) {
      usePlayerStore.getState().markInitialTimelinePreviewGateSettled(loadGeneration);
      setSettledProjectId(projectId);
    }
  }, [allInitialReady, loadGeneration, projectId, skipped, suppress]);

  useEffect(() => {
    usePlayerStore.getState().setEditorInputLocked(blocking);
    return () => {
      usePlayerStore.getState().setEditorInputLocked(false);
    };
  }, [blocking]);

  const skip = useCallback(() => {
    usePlayerStore.getState().skipAssetReadiness();
  }, []);

  const reportedGenRef = useRef<number>(-1);
  const retrySequenceRef = useRef(0);
  const onReloadPreviewRef = useRef(onReloadPreview);
  onReloadPreviewRef.current = onReloadPreview;

  const notifyFailuresRef = useRef<(failures: readonly PreviewAssetFailure[], generation: number) => void>(
    () => {},
  );

  const retryFailedAssets = useCallback(async () => {
    const store = usePlayerStore.getState();
    if (store.assetReadinessRetrying) return;
    const currentFailed = store.assetReadinessFailed;
    const gen = store.assetReadinessGeneration;
    store.setAssetReadinessRetrying(true);
    try {
      if (projectId) {
        thumbnailScheduler.retryFailed(projectId);
      }
      if (!hasRetryFailedAssetsHandler() || hasNonDomRetryableFailure(currentFailed)) {
        if (hasRetryFailedAssetsHandler()) {
          await retryFailedPreviewAssets();
        }
        const remainingAfterDomRetry = usePlayerStore.getState().assetReadinessFailed;
        if (remainingAfterDomRetry.length === 0) {
          showToast(t("Assets reloaded"), "info", "feedback");
          return;
        }
        if (onReloadPreviewRef.current && hasNonDomRetryableFailure(remainingAfterDomRetry)) {
          onReloadPreviewRef.current();
          return;
        }
        notifyFailuresRef.current(remainingAfterDomRetry, gen);
        return;
      }
      const remaining = await retryFailedPreviewAssets();
      if (remaining.length === 0) {
        showToast(t("Assets reloaded"), "info", "feedback");
        return;
      }
      notifyFailuresRef.current(remaining, gen);
    } finally {
      usePlayerStore.getState().setAssetReadinessRetrying(false);
    }
  }, [projectId, showToast, t]);

  const notifyFailures = useCallback(
    (failures: readonly PreviewAssetFailure[], generation: number) => {
      if (failures.length === 0) return;
      const attemptKey = `asset-retry-${generation}-${++retrySequenceRef.current}`;
      showToast(formatAssetFailureMessage(failures, t), "error", "feedback", {
        key: attemptKey,
        label: t("Retry"),
        onClick: retryFailedAssets,
      });
    },
    [retryFailedAssets, showToast, t],
  );
  notifyFailuresRef.current = notifyFailures;

  useEffect(() => {
    activeRetryRunner = retryFailedAssets;
    return () => {
      if (activeRetryRunner === retryFailedAssets) {
        activeRetryRunner = null;
      }
    };
  }, [retryFailedAssets]);

  useEffect(() => {
    if (
      suppress ||
      blocking ||
      assetPhase !== "ready" ||
      failed.length === 0 ||
      reportedGenRef.current === loadGeneration
    ) {
      return;
    }
    reportedGenRef.current = loadGeneration;
    notifyFailures(failed, loadGeneration);
  }, [suppress, blocking, assetPhase, failed, loadGeneration, notifyFailures]);

  return {
    blocking,
    backgroundLoading,
    loading: backgroundLoading,
    completed,
    total,
    indeterminate: retrying || total === 0,
    failed,
    retrying,
    skip,
    retryFailedAssets,
  };
}
