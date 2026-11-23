import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "open-design-ui/button";
import { useI18n } from "../i18n/I18n";
import { usePlayerStore } from "../player/store/playerStore";
import { retryFailedPreviewAssets } from "../player/store/readinessSlice";
import { thumbnailRevisionOf } from "../player/store/thumbnailSlice";
import {
  EDITOR_LOADING_OVERLAY_DEBOUNCE_MS,
  EDITOR_LOADING_SLOW_ESCAPE_MS,
  type PreviewAssetFailure,
} from "../player/lib/previewAssetReadiness";
import {
  canCaptureCompositionInBrowser,
  hasAnyCachedCompositionCapture,
  selectInitialGateCompositionPaths,
  TIMELINE_PREVIEW_GATE_TIMEOUT_MS,
} from "../player/lib/clientCompositionCapture";
import { getCachedCloudDisklessMode } from "../utils/cloudRuntime";
import type { AppToast } from "../utils/studioHelpers";

export interface EditorAssetLoadingOverlayProps {
  loading: boolean;
  completed: number;
  total: number;
  loadGeneration: number;
  /** Override visual fade-in debounce (revisits use a longer threshold to avoid flash). */
  debounceMs?: number;
  onSkip: () => void;
}

const EXIT_FADE_MS = 200;
export const EDITOR_LOADING_REVISIT_DEBOUNCE_MS = 350;

const visitedReadyScopes = new Set<string>();

/** Clear session-level visited scope memory between unit tests. */
export function clearVisitedEditorLoadingScopesForTest(): void {
  visitedReadyScopes.clear();
}

/**
 * Unified editor-level loading scrim shown over the workspace while composition
 * assets finish loading. Warm cache hits (<150ms, or <350ms on revisits) never
 * paint the overlay; slow loads (>8s) expose a non-destructive escape hatch.
 */
export function EditorAssetLoadingOverlay({
  loading,
  completed,
  total,
  loadGeneration,
  debounceMs = EDITOR_LOADING_OVERLAY_DEBOUNCE_MS,
  onSkip,
}: EditorAssetLoadingOverlayProps) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!loading) {
      setVisible(false);
      setSlow(false);
      const unmountTimer = setTimeout(() => setMounted(false), EXIT_FADE_MS);
      return () => clearTimeout(unmountTimer);
    }

    let rafId = 0;
    const showTimer = setTimeout(() => {
      setMounted(true);
      rafId = requestAnimationFrame(() => setVisible(true));
    }, debounceMs);
    return () => {
      clearTimeout(showTimer);
      cancelAnimationFrame(rafId);
    };
  }, [debounceMs, loading]);

  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), EDITOR_LOADING_SLOW_ESCAPE_MS);
    return () => clearTimeout(slowTimer);
  }, [loading, loadGeneration]);

  if (!mounted) return null;

  const hasCount = total > 0;
  const boundedCompleted = hasCount ? Math.min(total, Math.max(0, completed)) : 0;
  const ratio = hasCount ? boundedCompleted / total : 0;
  const percent = Math.round(ratio * 100);

  return (
    <div
      className="motion-editor-asset-loading"
      data-visible={visible ? "true" : "false"}
      data-testid="editor-asset-loading-overlay"
      role="status"
      aria-live="polite"
      style={{ pointerEvents: loading ? "auto" : "none" }}
      onDragStart={(event) => event.preventDefault()}
    >
      <div className="motion-editor-asset-loading-card">
        <span className="motion-editor-asset-loading-mark" aria-hidden="true" />
        <p className="motion-editor-asset-loading-title">
          {hasCount ? t("Preparing project assets") : t("Loading composition")}
        </p>
        <p className="motion-editor-asset-loading-detail">
          {slow
            ? t(
                "Loading is taking longer than expected. You can enter the editor now while remaining assets finish in the background.",
              )
            : t("Editing and preview will unlock once assets finish loading.")}
        </p>
        <div className="motion-editor-asset-loading-progress">
          <div
            className="motion-editor-asset-loading-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={hasCount ? percent : undefined}
          >
            <div
              className="motion-editor-asset-loading-fill"
              data-indeterminate={hasCount ? undefined : "true"}
              style={hasCount ? { transform: `scaleX(${ratio})` } : undefined}
            />
          </div>
          {hasCount && (
            <div className="motion-editor-asset-loading-meta">
              <span>{t("{completed} / {total} assets", { completed: boundedCompleted, total })}</span>
              <span>{percent}%</span>
            </div>
          )}
        </div>
        {slow && (
          <div className="motion-editor-asset-loading-escape">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              data-testid="editor-asset-loading-skip"
              onClick={onSkip}
            >
              {t("Skip waiting, enter editor")}
            </Button>
          </div>
        )}
      </div>
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

/**
 * Coordinates the single editor-ready gate (file tree + timeline + composition
 * assets), mirrors the interaction lock to global hotkey handlers, and reports
 * partial asset failures via a non-blocking Toast with in-place Retry.
 */
const TIMELINE_PREVIEW_REGISTER_GRACE_MS = 400;

export function useEditorAssetReadinessGate({
  projectId,
  activeCompPath,
  fileTreeLoaded,
  compositionLoading = false,
  unreachableProject,
  compositionMissing,
  showToast,
}: {
  projectId: string | null;
  activeCompPath?: string | null;
  fileTreeLoaded: boolean;
  compositionLoading?: boolean;
  unreachableProject: boolean;
  compositionMissing: boolean;
  showToast: ShowToastFn;
}) {
  const { t } = useI18n();
  const scopeKey = projectId ? `${projectId}::${activeCompPath || "index.html"}` : null;
  const isRevisit = Boolean(scopeKey && visitedReadyScopes.has(scopeKey));
  const timelineReady = usePlayerStore(
    (s) => Boolean(projectId) && s.timelineProjectId === projectId && s.timelineReady,
  );
  const assetPhase = usePlayerStore((s) => s.assetReadinessPhase);
  const assetCompleted = usePlayerStore((s) => s.assetReadinessCompleted);
  const assetTotal = usePlayerStore((s) => s.assetReadinessTotal);
  const failed = usePlayerStore((s) => s.assetReadinessFailed);
  const skipped = usePlayerStore((s) => s.assetReadinessSkipped);
  const loadGeneration = usePlayerStore((s) => s.assetReadinessGeneration);
  const previewLoadError = usePlayerStore((s) => s.previewLoadError);
  const timelinePreviewCompleted = usePlayerStore((s) => s.timelinePreviewCompleted);
  const timelinePreviewTotal = usePlayerStore((s) => s.timelinePreviewTotal);
  const timelinePreviewSettledInitial = usePlayerStore((s) => s.timelinePreviewSettledInitial);
  const expectedTimelinePreviewCount = usePlayerStore((s) => {
    if (
      !projectId ||
      !getCachedCloudDisklessMode() ||
      !canCaptureCompositionInBrowser() ||
      s.thumbnailMode === "hidden"
    ) {
      return 0;
    }
    const gatePaths = selectInitialGateCompositionPaths(s.elements, s.currentTime);
    let uncached = 0;
    for (const compPath of gatePaths) {
      const rev = thumbnailRevisionOf(s.thumbnailRevisions, compPath);
      if (!hasAnyCachedCompositionCapture(projectId, compPath, rev)) {
        uncached += 1;
      }
    }
    return uncached;
  });
  const hasPendingTimelinePreviewGate = expectedTimelinePreviewCount > 0 || timelinePreviewTotal > 0;
  const skip = usePlayerStore((s) => s.skipAssetReadiness);

  const [graceElapsedGen, setGraceElapsedGen] = useState<number>(-1);
  const coreReady = timelineReady && assetPhase === "ready";
  // TimelinePane only mounts CompositionThumbnail once compositionLoading clears,
  // so only start the registration grace and max-wait ceiling after !compositionLoading.
  const awaitingTimelinePreviews =
    hasPendingTimelinePreviewGate && !timelinePreviewSettledInitial && coreReady && !compositionLoading;

  useEffect(() => {
    if (!awaitingTimelinePreviews || timelinePreviewTotal > 0) return;
    const timer = setTimeout(() => setGraceElapsedGen(loadGeneration), TIMELINE_PREVIEW_REGISTER_GRACE_MS);
    return () => clearTimeout(timer);
  }, [awaitingTimelinePreviews, loadGeneration, timelinePreviewTotal]);

  // Hard ceiling on blocking for timeline thumbnails: slow or heavy scenes release cleanly
  // after TIMELINE_PREVIEW_GATE_TIMEOUT_MS and finish capturing progressively in the background.
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
    (!compositionLoading &&
      (timelinePreviewTotal > 0
        ? timelinePreviewCompleted >= timelinePreviewTotal
        : graceElapsedGen === loadGeneration));

  const bypassGate =
    previewLoadError || unreachableProject || compositionMissing || skipped;
  const ready =
    Boolean(projectId) &&
    fileTreeLoaded &&
    (bypassGate || (coreReady && timelinePreviewsReady));
  const locked = Boolean(projectId) && !ready;

  useEffect(() => {
    if (ready) {
      usePlayerStore.getState().markInitialTimelinePreviewGateSettled(loadGeneration);
      if (scopeKey && !bypassGate) {
        visitedReadyScopes.add(scopeKey);
      }
    }
  }, [bypassGate, loadGeneration, ready, scopeKey]);

  useEffect(() => {
    usePlayerStore.getState().setEditorInputLocked(locked);
    return () => {
      usePlayerStore.getState().setEditorInputLocked(false);
    };
  }, [locked]);

  // Pre-reserve uncached gated composition slots in the unified total before
  // CompositionThumbnail mounts so the progress bar rises monotonically instead
  // of hitting 100% on primary assets and then jumping backwards.
  const effectiveTimelineTotal =
    hasPendingTimelinePreviewGate && !timelinePreviewSettledInitial && !ready
      ? Math.max(timelinePreviewTotal, expectedTimelinePreviewCount)
      : timelinePreviewTotal;
  const completed = assetCompleted + timelinePreviewCompleted;
  const total = assetTotal + effectiveTimelineTotal;

  const reportedGenRef = useRef<number>(-1);
  const retrySequenceRef = useRef(0);

  const notifyFailures = useCallback(
    (failures: readonly PreviewAssetFailure[], generation: number) => {
      if (failures.length === 0) return;
      const attemptKey = `asset-retry-${generation}-${++retrySequenceRef.current}`;
      showToast(formatAssetFailureMessage(failures, t), "error", "feedback", {
        key: attemptKey,
        label: t("Retry"),
        onClick: async () => {
          const remaining = await retryFailedPreviewAssets();
          if (remaining.length === 0) {
            showToast(t("Assets reloaded"), "info", "feedback");
            return;
          }
          notifyFailures(remaining, generation);
        },
      });
    },
    [showToast, t],
  );

  useEffect(() => {
    if (!ready || failed.length === 0 || reportedGenRef.current === loadGeneration) return;
    reportedGenRef.current = loadGeneration;
    notifyFailures(failed, loadGeneration);
  }, [ready, failed, loadGeneration, notifyFailures]);

  return {
    locked,
    completed,
    total,
    loadGeneration,
    debounceMs: isRevisit
      ? EDITOR_LOADING_REVISIT_DEBOUNCE_MS
      : EDITOR_LOADING_OVERLAY_DEBOUNCE_MS,
    skip,
  };
}
