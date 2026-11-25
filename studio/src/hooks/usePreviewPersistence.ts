import { computePreviewImpact } from "../../../shared/preview-impact";
import { useCallback, useRef, useState } from "react";
import { saveFailureFeedback } from "../utils/saveFailureFeedback";
import { useMountEffect } from "./useMountEffect";
import {
  installStudioManualEditSeekReapply,
  reapplyPositionEditsAfterSeek,
} from "../components/editor/manualEdits";
import {
  afterStudioManualEditGestures,
  isStudioManualEditGestureLiveIn,
} from "../components/editor/manualEditsDom";
import { STUDIO_MOTION_PATH } from "../components/editor/studioMotion";
import { markScenesStale } from "../player/sceneSwap";
import { createDomEditSaveQueue, type DomEditSaveDrainResult } from "../utils/domEditSaveQueue";
import {
  flushStudioPendingEdits,
  hasStudioPendingEdits,
  type StudioPendingEditsDrainResult,
} from "../utils/studioPendingEdits";
import { trackStudioEvent } from "../utils/studioTelemetry";
import {
  applyUndoRestoreToPreview,
  readUndoNestedFiles,
  showRestoreInPlace,
  type RestoreFiles,
} from "../utils/gsapUndoRestore";
import { settleNestedReads } from "../utils/gsapSoftReload";
import { readProjectFileContent } from "../utils/studioFileHistory";
import { usePlayerStore } from "../player";
import { syncRestoredTimelineFromPreview } from "../player/lib/timelineRestoreSync";
import { syncHistoryTimelineFromFiles } from "../player/lib/timelineHistoryRestore";
import { holdHistoryTimelineUntilPreviewReplaced } from "../player/timelineRestorePending";
import { studioFileRevision } from "../utils/studioFileVersion";
import { mountedCanvasVersion, recordMountedCanvasRestore } from "../components/editor/isolatedSourceTarget";
import { mountedPeerFileVersion, stagePeerHistoryGeometry } from "../player/peerTimingPreview";
import { scheduleCommittedPreview } from "../player/committedPreview";
import { confirmedSource } from "../utils/confirmedTextSources";
import { createPreviewAdapter, previewDocumentIdentity } from "../player/lib/previewAdapter";
import { rememberHistoryTimelineBase } from "../player/lib/peerTimeline";
import type { HistoryPaint } from "./useEditHistoryActions";

/** The restore payload the undo/redo preview-sync consumes (from the history store). */
interface HistoryPreviewRestore {
  paths?: string[];
  files?: RestoreFiles;
}

// ── Types ──

interface RecordEditInput {
  label: string;
  coalesceKey?: string;
  files: Record<string, { before: string; after: string }>;
}

export interface UsePreviewPersistenceParams {
  showToast: (message: string, tone?: "error" | "info", presentation?: "feedback") => void;
  readOptionalProjectFile: (path: string) => Promise<string>;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  previewIframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  activeCompPathRef: React.MutableRefObject<string | null>;
  /** Called to reload the preview after undo/redo or external file changes. */
  reloadPreview: () => void;
  invalidateHistoryCompositions?: (paths: readonly string[]) => void;
}

function readIframeDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    return iframe.contentDocument;
  } catch {
    return null;
  }
}

function installManualEditReapply(iframe: HTMLIFrameElement): void {
  const reapply = () => {
    const doc = readIframeDocument(iframe);
    if (doc) reapplyPositionEditsAfterSeek(doc);
  };
  const install = () => {
    reapply();
    if (iframe.contentWindow) installStudioManualEditSeekReapply(iframe.contentWindow, reapply);
  };
  const win = iframe.contentWindow;
  install();
  win?.requestAnimationFrame?.(install);
  for (const delayMs of [80, 250, 500, 1000, 2000]) {
    win?.setTimeout?.(install, delayMs);
  }
}

export async function drainStudioSaveQueues(
  flushPendingFields: () => Promise<StudioPendingEditsDrainResult>,
  waitForDomQueue: () => Promise<DomEditSaveDrainResult>,
): Promise<StudioPendingEditsDrainResult | DomEditSaveDrainResult> {
  const pending = await flushPendingFields();
  if (pending.status !== "clean") return pending;
  return waitForDomQueue();
}

// fallow-ignore-next-line complexity
async function clearLegacyStudioMotionFile(
  readOptionalProjectFile: (path: string) => Promise<string>,
  writeProjectFile: (path: string, content: string) => Promise<void>,
): Promise<void> {
  const content = await readOptionalProjectFile(STUDIO_MOTION_PATH).catch(() => null);
  if (!content) return;
  try {
    const parsed = JSON.parse(content) as { motions?: unknown[] };
    if (!Array.isArray(parsed.motions) || parsed.motions.length === 0) return;
  } catch {
    return;
  }
  await writeProjectFile(STUDIO_MOTION_PATH, JSON.stringify({ version: 1, motions: [] })).catch(
    () => {},
  );
}

// ── Hook ──

export function usePreviewPersistence({
  showToast,
  readOptionalProjectFile: _readOptionalProjectFile,
  writeProjectFile: _writeProjectFile,
  recordEdit: _recordEdit,
  previewIframeRef,
  activeCompPathRef,
  reloadPreview,
  invalidateHistoryCompositions,
}: UsePreviewPersistenceParams) {
  void _recordEdit;

  const [domEditSaveQueuePaused, setDomEditSaveQueuePaused] = useState<string | null>(null);

  const domTextCommitVersionRef = useRef(0);
  const projectedHistory = useRef<{frame: HTMLIFrameElement; path: string; restored: string} | null>(null);
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const domEditSaveQueueRef = useRef<ReturnType<typeof createDomEditSaveQueue> | null>(null);
  const applyStudioManualEditsToPreviewRef = useRef<
    (iframe?: HTMLIFrameElement | null) => Promise<void>
  >(async () => {});

  if (!domEditSaveQueueRef.current) {
    domEditSaveQueueRef.current = createDomEditSaveQueue({
      onOpen: (event) => {
        const message = saveFailureFeedback(event.statusCode, event.errorMessage);
        setDomEditSaveQueuePaused(message);
        showToastRef.current(message, "error", "feedback");
        trackStudioEvent("save_queue_paused", {
          source: "dom_edit",
          error_message: event.errorMessage,
          status_code: event.statusCode,
          consecutive_failures: event.consecutiveFailures,
        });
      },
      onReset: () => {
        setDomEditSaveQueuePaused(null);
      },
    });
  }

  // ── Queue / drain helpers ──

  const queueDomEditSave = useCallback(<T>(save: () => Promise<T>): Promise<T> => {
    return domEditSaveQueueRef.current?.enqueue(save) ?? save();
  }, []);

  const drainPendingDomEditSaves = useCallback(async (options?: { blur?: boolean }) => {
    return drainStudioSaveQueues(() => flushStudioPendingEdits(options), async () => {
      return (await domEditSaveQueueRef.current?.waitForIdle()) ?? { status: "clean" as const };
    });
  }, []);

  const waitForPendingDomEditSaves = useCallback(async (options?: { blur?: boolean }): Promise<void> => {
    const result = await drainPendingDomEditSaves(options);
    if (result.status !== "clean") throw result.error;
  }, [drainPendingDomEditSaves]);

  const settlePendingEdits = useCallback(async (): Promise<void> => {
    const queued = domEditSaveQueueRef.current?.waitForIdle();
    await flushStudioPendingEdits({ onlyCurrent: true });
    await queued;
  }, []);

  const resetDomEditSaveQueueBreaker = useCallback(() => {
    domEditSaveQueueRef.current?.reset();
    setDomEditSaveQueuePaused(null);
  }, []);

  useMountEffect(() => () => {
    domEditSaveQueueRef.current?.destroy();
  });

  // ── Apply manual edits (HTML-baked — install seek hooks) ──
  // reapplyPositionEditsAfterSeek now also handles motion reapply from DOM attributes.

  const applyCurrentStudioManualEditsToPreview = useCallback(
    (iframe: HTMLIFrameElement | null = previewIframeRef.current) => {
      if (!iframe) return;
      if (!readIframeDocument(iframe)) return;
      installManualEditReapply(iframe);
    },
    [previewIframeRef],
  );

  const applyStudioManualEditsToPreview = useCallback(
    async (iframe: HTMLIFrameElement | null = previewIframeRef.current) => {
      applyCurrentStudioManualEditsToPreview(iframe);
    },
    [applyCurrentStudioManualEditsToPreview, previewIframeRef],
  );
  applyStudioManualEditsToPreviewRef.current = applyStudioManualEditsToPreview;

  // ── Sync preview after undo/redo ──

  // Undo never repaints under a live gesture; the preview reloads once the last one ends.
  const heldPreviewDoc = useCallback(() => {
    const doc = previewIframeRef.current?.contentDocument;
    return doc && isStudioManualEditGestureLiveIn(doc) ? doc : null;
  }, [previewIframeRef]);

  const syncHistoryPreviewAfterApply = useCallback(
    async (restore: HistoryPreviewRestore) => {
      const paths = restore.paths ?? Object.keys(restore.files ?? {});
      const impact = computePreviewImpact(paths);
      if (!impact.affectsPreview) return;
      invalidateHistoryCompositions?.(impact.affectedCompositions);
      const iframe = previewIframeRef.current;
      const doc = iframe?.contentDocument;
      const activePath = activeCompPathRef.current;
      const projectId = usePlayerStore.getState().timelineProjectId;
      if (!doc && iframe && projectId && createPreviewAdapter({iframe}).token) {
        const staged = projectedHistory.current;
        projectedHistory.current = null;
        const changes = paths.filter(path => computePreviewImpact([path]).affectsPreview).map(path => {
          const file = restore.files?.[path];
          if (!file?.versions) return {path};
          const {previousVersion, restored} = file.versions;
          return {path, previous: previousVersion ? {version: previousVersion, content: file.previous} : undefined,
            current: {version: restored, content: file.restored}};
        });
        const path = activePath ?? "index.html";
        const restored = restore.files?.[path];
        const current = confirmedSource(projectId, path);
        const alreadyShown = staged?.frame === iframe && staged.path === path && staged.restored === restored?.restored;
        if (restored && (!restored.versions || !current || current.version === restored.versions.restored)) {
          if (syncHistoryTimelineFromFiles(activePath, restore.files, alreadyShown || hasStudioPendingEdits() ? "fields" : false)) {
            rememberHistoryTimelineBase(projectId, path, restored.restored);
            holdHistoryTimelineUntilPreviewReplaced(iframe);
          }
        }
        scheduleCommittedPreview(iframe, projectId, changes, reloadPreview, {historyRestore:true});
        return;
      }
      const revision = studioFileRevision();
      const isCurrent = () => previewIframeRef.current === iframe && iframe?.contentDocument === doc &&
        activeCompPathRef.current === activePath && usePlayerStore.getState().timelineProjectId === projectId;
      const deferUnderGesture = () => {
        const held = heldPreviewDoc();
        if (!held) return false;
        afterStudioManualEditGestures(held, () => {
          if (!isCurrent()) return;
          if (studioFileRevision() === revision && syncHistoryTimelineFromFiles(activePath, restore.files))
            holdHistoryTimelineUntilPreviewReplaced(iframe);
          markScenesStale(iframe, paths);
          reloadPreview();
        });
        return true;
      };
      if (deferUnderGesture()) return;
      // A confirmed restore updates source-backed rows now. Structural previews
      // may load independently; their old messages must not undo these rows.
      const reloadRestoredPreview = () => {
        if (syncHistoryTimelineFromFiles(activePath, restore.files)) holdHistoryTimelineUntilPreviewReplaced(iframe);
        reloadPreview();
      };
      const nestedFiles = await settleNestedReads(
        readUndoNestedFiles(
          iframe,
          activePath,
          restore.files,
          (path) =>
            projectId
              ? readProjectFileContent(projectId, path)
              : Promise.reject(new Error("No project is open to read nested files from.")),
        ),
      );
      // A newer write owns the preview; discard the snapshot read before it.
      if (!isCurrent() || studioFileRevision() !== revision || deferUnderGesture()) return;
      const mounts = Object.entries(restore.files ?? {}).flatMap(([path, file]) => {
        const shown = doc && projectId && mountedCanvasVersion(doc, projectId, path);
        return shown && file.versions ? [{path, shown, versions: file.versions}] : [];
      });
      if (mounts.some(({shown, versions}) => shown !== versions.restored && !versions.previous.has(shown))) {
        markScenesStale(iframe, paths);
        reloadRestoredPreview();
        return;
      }
      const strategy = applyUndoRestoreToPreview(
        iframe,
        activePath,
        restore.files,
        usePlayerStore.getState().currentTime,
        reloadRestoredPreview,
        nestedFiles,
      );
      if (strategy === "full") return;
      for (const {path, versions} of mounts) recordMountedCanvasRestore(doc!, projectId!, path, versions.restored);
      syncRestoredTimelineFromPreview(previewIframeRef.current?.contentDocument);
    },
    [previewIframeRef, activeCompPathRef, reloadPreview, invalidateHistoryCompositions, heldPreviewDoc],
  );

  // A restore the server has not confirmed yet: in place now, or not at all. A GSAP script re-run is not
  // synchronous, and a pending save would land under it.
  const showHistoryRestoreNow = useCallback(
    (files: RestoreFiles, projectWide = false): HistoryPaint | null => {
      const iframe = previewIframeRef.current;
      if (projectWide) {
        const project = usePlayerStore.getState().timelineProjectId;
        if (!project || !iframe || readIframeDocument(iframe) || Object.keys(files).length !== 1) return null;
        const [[path, file]] = Object.entries(files) as [string, RestoreFiles[string]][];
        const known = confirmedSource(project, path);
        const mounted = mountedPeerFileVersion(iframe, path);
        if (!mounted || !(mounted === file.versions?.previousVersion || mounted === file.versions?.restored ||
            known?.version === mounted && (known.content === file.previous || known.content === file.restored))) return null;
        const activePath = activeCompPathRef.current;
        const documentId = previewDocumentIdentity(iframe);
        const mountedContent = mounted === file.versions?.restored ? file.restored : mounted === file.versions?.previousVersion ? file.previous : known!.content;
        const discard = stagePeerHistoryGeometry(iframe, path, file.previous, file.restored, mounted, mountedContent);
        const previousRows = usePlayerStore.getState().elements;
        const changed = syncHistoryTimelineFromFiles(activePath, files, hasStudioPendingEdits() ? "fields" : "predict");
        if (changed) rememberHistoryTimelineBase(project, path, file.restored);
        const release = changed ? holdHistoryTimelineUntilPreviewReplaced(iframe) : undefined;
        const projection = changed ? {frame: iframe, path, restored: file.restored} : null;
        projectedHistory.current = projection;
        const rollback = () => {
          if (projectedHistory.current === projection) projectedHistory.current = null;
          discard?.();
          release?.();
          // The save being taken back may itself have failed. Its original rows
          // already show the last confirmed revision in that case.
          if (!file.versions?.previousVersion && confirmedSource(project, path)?.content === file.restored) return;
          if (changed && iframe === previewIframeRef.current && previewDocumentIdentity(iframe) === documentId &&
              activeCompPathRef.current === activePath && usePlayerStore.getState().timelineProjectId === project &&
              syncHistoryTimelineFromFiles(activePath, { [path]: {previous: file.restored, restored: file.previous} }, "predict", previousRows))
            rememberHistoryTimelineBase(project, path, file.previous);
        };
        rollback.supersede = () => {
          discard?.supersede();
          if (projectedHistory.current === projection) projectedHistory.current = null;
          // The incoming version retires the draft/manifest hold when it paints.
          // Rolling them back now would expose the previous move for a frame.
        };
        return rollback;
      }
      if (!domEditSaveQueueRef.current?.isIdle() || hasStudioPendingEdits() || heldPreviewDoc())
        return null;
      const now = () => usePlayerStore.getState().currentTime;
      const putBack = showRestoreInPlace(iframe, activeCompPathRef.current, files, now());
      if (!putBack) return null;
      syncRestoredTimelineFromPreview(iframe?.contentDocument);
      return () => {
        if (!heldPreviewDoc() && putBack(now())) {
          syncRestoredTimelineFromPreview(iframe?.contentDocument);
        } else void syncHistoryPreviewAfterApply({ paths: Object.keys(files) });
      };
    },
    [previewIframeRef, activeCompPathRef, syncHistoryPreviewAfterApply, heldPreviewDoc],
  );

  // ── Migrate legacy studio-motion.json ──
  // Projects that used the old JSON-file approach may still have a populated
  // studio-motion.json in the project's .hyperframes folder. The studio no longer reads it, but
  // the legacy render-script injection in `preview.ts` / `vite.studioMotion.ts`
  // could still fire alongside the new seek-reapply runtime. Empty the file so
  // the legacy codepath no-ops.
  useMountEffect(() => {
    void clearLegacyStudioMotionFile(_readOptionalProjectFile, _writeProjectFile);
  });

  return {
    domTextCommitVersionRef,
    domEditSaveQueueRef,
    applyStudioManualEditsToPreviewRef,
    queueDomEditSave,
    drainPendingDomEditSaves,
    waitForPendingDomEditSaves,
    settlePendingEdits,
    domEditSaveQueuePaused,
    resetDomEditSaveQueueBreaker,
    applyCurrentStudioManualEditsToPreview,
    applyStudioManualEditsToPreview,
    syncHistoryPreviewAfterApply,
    showHistoryRestoreNow,
  };
}
