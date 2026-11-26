// fallow-ignore-file complexity
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STUDIO_MOTION_PATH } from "../components/editor/studioMotion";
import { STYLE_HISTORY_PREFIX } from "../i18n/styleHistory";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import type { RestoreFiles } from "../utils/gsapUndoRestore";
import { whileScriptWrites } from "../player/previewReloading";
import {
  beginStudioShownRestore,
  cancelNewestStudioWaitingPress,
  hasStudioPendingEdits,
  paintBackNewestStudioPendingEdit,
} from "../utils/studioPendingEdits";
import { reportHistoryStep, takeHistoryTrigger } from "../motion/editorTracking";
import type { HistoryStepGuard } from "../../../shared/ordered-text-edits";

interface HistoryResult {
  ok: boolean;
  reason?: string;
  message?: string;
  label?: string;
  paths?: string[];
  undoes?: string;
  /** Per-file restored/previous content, used to soft-apply the preview. */
  files?: RestoreFiles;
  reconcilePaths?: string[];
}
interface HistoryFileCallbacks {
  readFile: (path: string) => Promise<string>;
  serialize?: <T>(paths: readonly string[], task: () => Promise<T>) => Promise<T>;
  claimedAfter?: number;
  predictedId?: string;
  pendingUndoId?: string;
  guard?: HistoryStepGuard;
  onSuperseded?: (paths?: readonly string[]) => void;
}
export interface EditHistoryHandle {
  projectWide?: boolean;
  availableNow?: (direction: "undo" | "redo") => boolean;
  guard?: (direction: "undo" | "redo") => HistoryStepGuard | undefined;
  pendingUndoId?: () => string | undefined;
  watchSuperseded?: (listener: NonNullable<HistoryFileCallbacks['onSuperseded']>) => () => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: (cb: HistoryFileCallbacks) => Promise<HistoryResult>;
  redo: (cb: HistoryFileCallbacks) => Promise<HistoryResult>;
  predict?: (direction: "undo" | "redo") => { id: string; files: RestoreFiles } | null;
  claims?: () => number;
  state: {
    undo: ReadonlyArray<{ createdAt: number }>;
    redo: ReadonlyArray<{ createdAt: number }>;
  };
}

export interface UseEditHistoryActionsOptions {
  editHistory: Omit<EditHistoryHandle, 'state'>;
  readOptionalProjectFile: (path: string) => Promise<string>;
  readProjectFile: (path: string) => Promise<string>;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  showToast: (message: string, tone?: "error" | "info", presentation?: "feedback") => void;
  syncHistoryPreviewAfterApply: (restore: Pick<HistoryResult, "paths" | "files">) => Promise<void>;
  showHistoryRestoreNow?: (files: RestoreFiles, projectWide?: boolean) => HistoryPaint | null;
  waitForPendingDomEditSaves: () => Promise<void>;
  onAfterUndoRedo?: (restore: Pick<HistoryResult, "paths" | "files">) => void;
  /** Active composition path — decides whether undo/redo must resync the SDK session. */
  activeCompPath?: string | null;
  /** Reloads the SDK session after a revert of the active comp, past the self-write suppress window. */
  forceReloadSdkSession?: () => void;
  projectId?: string | null;
}

export type HistoryPaint = (() => void) & { supersede?: () => void };

/** Takes one step of the project's history: the single owner of undo/redo over project files. */
export function useEditHistoryActions({
  editHistory,
  readOptionalProjectFile,
  readProjectFile,
  writeProjectFile,
  showToast,
  syncHistoryPreviewAfterApply,
  showHistoryRestoreNow,
  waitForPendingDomEditSaves,
  onAfterUndoRedo,
  activeCompPath,
  forceReloadSdkSession,
  projectId,
}: UseEditHistoryActionsOptions) {
  const queue = useMemo(() => ({ tail: null as Promise<void> | null, stopWatching: undefined as (() => void) | undefined }), [projectId]);
  const activeQueue = useRef<typeof queue | null>(queue);
  activeQueue.current = queue;
  useEffect(() => {
    activeQueue.current = queue;
    return () => {
      queue.stopWatching?.();
      queue.stopWatching = undefined;
      if (activeQueue.current === queue) activeQueue.current = null;
    };
  }, [queue]);
  const [pendingQueue, setPendingQueue] = useState<typeof queue | null>(null);
  const historyRef = useRef(editHistory);
  historyRef.current = editHistory;
  const readHistoryFile = useCallback(
    (path: string): Promise<string> =>
      path === STUDIO_MOTION_PATH ? readOptionalProjectFile(path) : readProjectFile(path),
    [readOptionalProjectFile, readProjectFile],
  );
  const serializeHistoryFiles = useCallback(
    <T>(paths: readonly string[], task: () => Promise<T>) =>
      serializeStudioFileMutations(writeProjectFile, paths, task),
    [writeProjectFile],
  );

  const apply = useCallback(
    async (direction: "undo" | "redo", method: ReturnType<typeof takeHistoryTrigger>, releaseWrite: () => void) => {
      const noun = direction === "undo" ? "Undo" : "Redo";
      // One result per step the person asked for; the step itself never waits on this.
      const report = (outcome: "success" | "unavailable" | "failure") =>
        reportHistoryStep(direction, outcome, projectId, method);
      const projectWide = historyRef.current.projectWide;
      if (!projectWide && direction === "undo" && cancelNewestStudioWaitingPress()) return report("success");
      const available = (projectWide ? historyRef.current.availableNow?.(direction) : undefined)
        ?? (direction === "undo" ? historyRef.current.canUndo : historyRef.current.canRedo);
      if (!available && !projectWide && !(direction === "undo" && hasStudioPendingEdits())) return report("unavailable");
      // An edit still saving is newer than any step this tab predicts, so it paints back first.
      const pendingEditShown = !projectWide && direction === "undo" ? paintBackNewestStudioPendingEdit() : null;
      const predicted = pendingEditShown ? null : (historyRef.current.predict?.(direction) ?? null);
      const pendingUndoId = projectWide && direction === 'undo' && !predicted ? historyRef.current.pendingUndoId?.() : undefined;
      if (projectWide && !available && !predicted && !pendingUndoId) return report("unavailable");
      const guard = projectWide && !predicted && !pendingUndoId ? historyRef.current.guard?.(direction) : undefined;
      let predictedShown: HistoryPaint | null = null;
      if (predicted && showHistoryRestoreNow) {
        predictedShown = projectWide ? showHistoryRestoreNow(predicted.files, true) : showHistoryRestoreNow(predicted.files);
      }
      const shownLanded = predictedShown ? beginStudioShownRestore() : null;
      const putBack = predictedShown ?? pendingEditShown?.showAgain;
      const claimedAfter =
        pendingEditShown?.claimsAtBegin ??
        (!projectWide && direction === "undo" && hasStudioPendingEdits() ? editHistory.claims?.() : undefined);
      let result: HistoryResult = { ok: false, reason: "failed" };
      let serverSteppedShown = false;
      let revertIsTheUndo = false;
      let superseded = false;
      const successorPaths = new Set<string>();
      const yieldPreview = (paths?: readonly string[]) => {
        paths?.forEach(path => successorPaths.add(path));
        if (superseded) return;
        superseded = true;
        // A verified successor will paint from its own source. Keep the current pixels
        // until then so the replaced move cannot flash back between two receipts.
        predictedShown?.supersede?.();
        shownLanded?.();
        releaseWrite();
      };
      const stopWatching = projectWide ? historyRef.current.watchSuperseded?.(yieldPreview) : undefined;
      queue.stopWatching = stopWatching;
      try {
        await waitForPendingDomEditSaves();
        if (projectWide && activeQueue.current !== queue) return;
        revertIsTheUndo = Boolean(pendingEditShown && !(await pendingEditShown.landed()));
        if (revertIsTheUndo) return report("success");
        result = await editHistory[direction]({
          readFile: readHistoryFile,
          serialize: serializeHistoryFiles,
          claimedAfter,
          ...(projectWide && predicted && { predictedId: predicted.id }),
          ...(pendingUndoId && {pendingUndoId}),
          ...(guard && { guard }),
          ...(projectWide && !stopWatching && {onSuperseded: yieldPreview}),
        });
        const stepped = Boolean(result.ok && result.label);
        const editClaimed =
          pendingEditShown !== null &&
          (editHistory.claims?.() ?? 0) > pendingEditShown.claimsAtBegin;
        serverSteppedShown = predictedShown
          ? stepped && result.undoes === predicted?.id && (!projectWide || matchesPrediction(result, predicted!.files))
          : stepped && editClaimed;
      } catch (error) {
        report("failure");
        throw error;
      } finally {
        if (queue.stopWatching === stopWatching) { stopWatching?.(); queue.stopWatching = undefined; }
        if (putBack && !superseded && !serverSteppedShown && !revertIsTheUndo) putBack();
        shownLanded?.();
      }
      if (projectWide && activeQueue.current !== queue) return;
      report(result.ok && result.label ? "success" : result.reason === "failed" ? "failure" : "unavailable");
      if (superseded || result.reconcilePaths?.length) {
        const paths = result.reconcilePaths ?? result.paths ?? Object.keys(predicted?.files ?? {});
        const missing = paths.filter(path => !successorPaths.has(path));
        if (missing.length) await syncHistoryPreviewAfterApply({paths:missing});
        if (superseded && result.ok) return;
      }
      if (!result.ok && result.reason === "content-mismatch") {
        if (projectWide && predictedShown && !superseded) await syncHistoryPreviewAfterApply({ paths: result.paths?.length ? result.paths : Object.keys(predicted!.files) });
        showToast(
          direction === "undo"
            ? "Content has changed. This step cannot be undone."
            : "Content has changed. This step cannot be redone.",
          "error",
          "feedback",
        );
        return;
      }
      if (!result.ok && result.reason === "failed") {
        console.warn(`${noun} failed`, result.message);
        showToast(`${noun} failed: ${result.message ?? "Unknown save failure"}`, "error");
        return;
      }
      if (result.ok && result.label) {
        const files =
          serverSteppedShown && predictedShown && !projectWide
            ? fromShown(result.files, predicted!.files)
            : result.files;
        const restore = { paths: result.paths, files };
        onAfterUndoRedo?.(restore);
        if (activeCompPath && result.paths?.includes(activeCompPath)) {
          forceReloadSdkSession?.();
        }
        await syncHistoryPreviewAfterApply(restore);
        const message = result.label.startsWith(STYLE_HISTORY_PREFIX)
          ? `${direction === "undo" ? "Undid" : "Redid"}: ${result.label}`
          : result.label;
        showToast(message, "info");
      }
    },
    [
      editHistory,
      queue,
      readHistoryFile,
      showToast,
      syncHistoryPreviewAfterApply,
      showHistoryRestoreNow,
      waitForPendingDomEditSaves,
      serializeHistoryFiles,
      onAfterUndoRedo,
      activeCompPath,
      forceReloadSdkSession,
      projectId,
    ],
  );

  const run = useCallback((direction: "undo" | "redo") => {
    const method = takeHistoryTrigger();
    const step = () => whileScriptWrites(release => apply(direction, method, release));
    if (!editHistory.projectWide) return step();
    const current = () => activeQueue.current === queue ? step() : Promise.resolve();
    const next = queue.tail ? queue.tail.then(current, current) : current();
    queue.tail = next;
    setPendingQueue(queue);
    const finish = () => {
      if (queue.tail !== next) return;
      queue.tail = null;
      if (activeQueue.current === queue) setPendingQueue(null);
    };
    void next.then(finish, finish);
    return next;
  }, [apply, editHistory.projectWide, queue]);
  const undo = useCallback(() => run("undo"), [run]);
  const redo = useCallback(() => run("redo"), [run]);
  const pending = pendingQueue === queue;
  return useMemo(() => ({ undo, redo, pending }), [undo, redo, pending]);
}

function matchesPrediction(result: HistoryResult, shown: RestoreFiles): boolean {
  const paths = result.paths ?? [];
  return paths.length === Object.keys(shown).length && paths.every(path =>
    shown[path] && result.files?.[path]?.restored === shown[path].restored);
}

function fromShown(files: RestoreFiles | undefined, shown: RestoreFiles) {
  if (!files) return files;
  return Object.fromEntries(
    Object.entries(files).map(([path, f]) => [
      path,
      { ...f, previous: shown[path]?.restored ?? f.previous },
    ]),
  );
}
