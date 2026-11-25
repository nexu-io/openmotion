import { useCallback, useMemo, useRef } from "react";
import { findUnsafeMutationValues } from "@hyperframes/core/studio-api/finite-mutation";
import { readProjectFileContent as readSharedProjectFileContent } from "../utils/studioFileHistory";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import {
  extractGsapScriptText,
  readNestedFiles,
  settleNestedReads,
} from "../utils/gsapSoftReload";
import { trackKeyframeCommit } from "../utils/keyframeUsage";
import { serializeStudioFileMutation } from "../utils/studioFileMutationCoordinator";
import { trackedStudioEdit } from "../utils/studioPendingEdits";
import {
  getStudioSaveErrorMessage,
  isStudioSaveErrorAlreadyToasted,
  markStudioSaveErrorAlreadyToasted,
} from "../utils/studioSaveDiagnostics";
import type { CutoverDeps } from "../utils/sdkCutover";
import { updateKeyframeCacheFromParsed } from "./gsapKeyframeCacheHelpers";
import { applyPreviewSync, finishUnchangedMutation, redrawUnlessPaintedBack, refreshMutationPreview, softReloadOrEscalate } from "./gsapPreviewSync";
export { applyPreviewSync } from "./gsapPreviewSync";
import { createKeyedSerializer } from "./serializeByKey";
import {
  GsapMutationHttpError,
  formatGsapMutationRejectionToast,
  readJsonResponseBody,
} from "./gsapScriptCommitHelpers";
import {
  gsapWriteFile,
  type CommitMutation,
  type CommitMutationCall,
  type CommitMutationOptions,
  type GsapScriptCommitsParams,
  type MutationResult,
} from "./gsapScriptCommitTypes";
import { useGsapAnimationOps } from "./useGsapAnimationOps";
import { useGsapArcPathOps } from "./useGsapArcPathOps";
import { useGsapKeyframeOps } from "./useGsapKeyframeOps";
import { useGsapPropertyDebounce } from "./useGsapPropertyDebounce";
import {
  useGsapSaveFailureTelemetry,
  useSafeGsapCommitMutation,
} from "./useSafeGsapCommitMutation";
import { requestGsapMutation } from "./gsapMutationClient";
import { cloudHistoryForWrite, type StudioWriteHistory } from "../utils/studioFileHistory";
import { saveOrderedGsapEdit } from "./orderedGsapEdits";
import { getCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { scheduleCommittedPreview } from "../player/committedPreview";
import { confirmedSource } from "../utils/confirmedTextSources";
import { projectedTimelineText } from "../utils/orderedTimelineEdits";
import { readStudioEditSource } from "../utils/studioTextEdits";
import { whileScriptWrites } from "../player/previewReloading";

async function mutateGsapScript(
  projectId: string,
  route: "gsap-mutations" | "gsap-mutations-batch",
  sourceFile: string,
  body: unknown,
  history?: StudioWriteHistory,
): Promise<MutationResult> {
  const res = await requestGsapMutation(projectId, route, sourceFile, body, history);
  if (!res.ok) throw new GsapMutationHttpError(res.status, await readJsonResponseBody(res));
  const result = (await res.json()) as MutationResult;
  if (!result.ok) throw new Error(`Failed to update GSAP in ${sourceFile}`);
  return result;
}

type ShowToast = (message: string, tone?: "error" | "info") => void;

function showUnchangedMutationFeedback(
  mutations: Record<string, unknown>[],
  result: MutationResult,
  showToast: ShowToast | undefined,
): void {
  if (result.changed !== false || mutations.length !== 1) return;
  if (mutations[0]?.type === "move-keyframe") {
    showToast?.("A keyframe already exists at that time", "info");
  }
}

async function runMutationRequest(
  mutations: Record<string, unknown>[],
  options: CommitMutationOptions,
  showToast: ShowToast | undefined,
  request: () => Promise<MutationResult>,
): Promise<MutationResult | undefined> {
  const unsafeFields = mutations.flatMap((mutation) => findUnsafeMutationValues(mutation));
  if (unsafeFields.length > 0) {
    showToast?.("Couldn't read element layout. Try again at a different playhead time", "error");
    if (options.skipReload) return;
    throw markStudioSaveErrorAlreadyToasted(
      new Error(
        `Mutation contains unsafe values: ${unsafeFields.map((field) => field.path).join(", ")}`,
      ),
    );
  }
  try {
    const result = await request();
    showUnchangedMutationFeedback(mutations, result, showToast);
    return result;
  } catch (error) {
    if (error instanceof GsapMutationHttpError) {
      showToast?.(formatGsapMutationRejectionToast(error), "error");
      markStudioSaveErrorAlreadyToasted(error);
    }
    if (options.skipReload) return;
    throw error;
  }
}

function isActiveCommitTarget(
  projectIdRef: { current: string | null },
  activeCompPathRef: { current: string | null },
  projectId: string,
  compositionPath: string | null,
): boolean {
  return projectIdRef.current === projectId && activeCompPathRef.current === compositionPath;
}

function syncCommittedGsapMutation({
  iframe,
  selection,
  mutation,
  targetPath,
  result,
  options,
  onFileContentChanged,
  forceReloadSdkSession,
  reloadPreview,
  onCacheInvalidate,
  nestedFiles,
}: {
  iframe: HTMLIFrameElement | null;
  selection: DomEditSelection;
  mutation: Record<string, unknown>;
  targetPath: string;
  result: MutationResult;
  options: CommitMutationOptions;
  onFileContentChanged?: (path: string, content: string) => void;
  forceReloadSdkSession?: () => void;
  reloadPreview: () => void;
  onCacheInvalidate: () => void;
  nestedFiles?: Map<string, string> | null;
}): void {
  if (result.after != null) onFileContentChanged?.(targetPath, result.after);
  // Server wrote the file; the in-memory SDK doc is now stale. Resync it so a
  // later SDK-routed edit doesn't serialize the pre-write doc and revert this.
  forceReloadSdkSession?.();
  if (options.skipReload) return;
  if (result.parsed?.animations) {
    updateKeyframeCacheFromParsed(
      result.parsed.animations,
      targetPath,
      selection.id ?? undefined,
      mutation,
      // The live preview document is what resolves a class / descendant tween to
      // the elements it really animates; without it only whole-id selectors do.
      iframe?.contentDocument,
    );
  }
  refreshMutationPreview(iframe, result, options, reloadPreview, onCacheInvalidate, nestedFiles);
}

/** Apply batched deltas directly only when every member has an in-place change. */
function batchPreviewOptions(calls: CommitMutationCall[], options: CommitMutationOptions): CommitMutationOptions {
  const patches = calls.flatMap(call => call.options.instantPatch ? [call.options.instantPatch] : []);
  const { instantPatch: _single, ...rest } = options;
  return patches.length === calls.length ? { ...rest, instantPatches: patches } : rest;
}

// oxfmt-ignore
// fallow-ignore-next-line complexity
export function useGsapScriptCommits({ projectIdRef, activeCompPath, previewIframeRef, editHistory, reloadPreview, onCacheInvalidate, onFileContentChanged, showToast, sdkSession, publishSdkSession, writeProjectFile, forceReloadSdkSession }: GsapScriptCommitsParams) {
  const activeProjectId = projectIdRef.current;
  const activeCompPathRef = useRef(activeCompPath);
  activeCompPathRef.current = activeCompPath;
  // Serializer for per-key commits (options.serializeKey). Keyed by
  // `gsap:${animationId}:meta`, it chains a meta commit onto the prior one for
  // the same animationId so their POSTs can't interleave. Held in a ref so the
  // chain survives re-renders.
  const serializerRef = useRef(createKeyedSerializer());
  const newestPaint = useRef<symbol | null>(null);
  const recordMutationEdit = useCallback(async (targetPath: string, result: MutationResult, options: CommitMutationOptions) => {
    if (result.before == null || result.after == null) return;
    await editHistory.recordEdit({
      label: options.label,
      coalesceKey: options.coalesceKey,
      coalesceMs: options.coalesceMs,
      files: { [targetPath]: { before: result.before, after: result.after } },
    });
  }, [editHistory]);

  const finalizeSuccessfulMutation = useCallback(async (projectId: string, compositionPath: string | null, selection: DomEditSelection, mutation: Record<string, unknown>, targetPath: string, result: MutationResult, options: CommitMutationOptions) => {
    if (projectIdRef.current !== projectId) return;
    const previewIsActive = isActiveCommitTarget(
      projectIdRef,
      activeCompPathRef,
      projectId,
      compositionPath,
    );
    // A no-op file write may still owe the runtime a deferred instant patch.
    if (result.changed === false) {
      if (previewIsActive) {
        finishUnchangedMutation(previewIframeRef.current, result, options, reloadPreview);
      }
      return;
    }
    await recordMutationEdit(targetPath, result, options);
    const nestedFiles = await settleNestedReads(
      result.scriptText
        ? readNestedFiles(previewIframeRef.current, result.scriptText, (path) =>
            readSharedProjectFileContent(projectId, path),
          )
        : null,
    );
    // The durable mutation belongs to the project captured when it was queued.
    // A later project must never receive its file state or preview refresh.
    if (!isActiveCommitTarget(projectIdRef, activeCompPathRef, projectId, compositionPath)) return;
    syncCommittedGsapMutation({
      iframe: previewIframeRef.current,
      selection,
      mutation,
      targetPath,
      result,
      options,
      onFileContentChanged,
      forceReloadSdkSession,
      reloadPreview,
      onCacheInvalidate,
      nestedFiles,
    });
  }, [projectIdRef, previewIframeRef, reloadPreview, onCacheInvalidate, onFileContentChanged, forceReloadSdkSession, recordMutationEdit]);

  const runCommit = useCallback((pid: string, compositionPath: string | null, targetPath: string, selection: DomEditSelection, mutation: Record<string, unknown>, options: CommitMutationOptions) => whileScriptWrites(async () => {
    const result = await runMutationRequest([mutation], options, showToast, () =>
      mutateGsapScript(pid, "gsap-mutations", targetPath, mutation, options.history ?? cloudHistoryForWrite(writeProjectFile, options)),
    );
    if (!result) return;
    trackKeyframeCommit([mutation], result, options);
    options.onResult?.(result);
    await finalizeSuccessfulMutation(pid, compositionPath, selection, mutation, targetPath, result, options);
  }), [showToast, finalizeSuccessfulMutation, writeProjectFile]);

  const runBatchCommit = useCallback((pid: string, compositionPath: string | null, targetPath: string, calls: CommitMutationCall[], options: CommitMutationOptions) => whileScriptWrites(async () => {
    const first = calls[0];
    const last = calls.at(-1);
    if (!first || !last) return;
    const mutations = calls.map(({ mutation }) => mutation);
    const result = await runMutationRequest(mutations, options, showToast, () =>
      mutateGsapScript(pid, "gsap-mutations-batch", targetPath, { mutations }, options.history ?? cloudHistoryForWrite(writeProjectFile, options)),
    );
    if (!result) return;
    trackKeyframeCommit(mutations, result, options, calls.map((call) => call.options));
    options.onResult?.(result);
    await finalizeSuccessfulMutation(pid, compositionPath, last.selection, last.mutation, targetPath, result, batchPreviewOptions(calls, options));
  }), [showToast, finalizeSuccessfulMutation, writeProjectFile]);

  const runOrderedCommit = useCallback(async (pid: string, compositionPath: string | null, path: string, calls: CommitMutationCall[], options: CommitMutationOptions) => {
    const last = calls.at(-1);
    if (!last) return;
    const mutations = calls.map(call => call.mutation);
    const display = calls.length > 1 ? batchPreviewOptions(calls, options) : options;
    const active = () => isActiveCommitTarget(projectIdRef, activeCompPathRef, pid, compositionPath);
    const gesture = Symbol();
    let painted: MutationResult | undefined;
    let fallback = false;
    let saved = false;
    const requestFallback = () => {
      fallback = true;
      if (saved && active() && newestPaint.current === gesture) reloadPreview();
    };
    const present = (result: MutationResult, paintOptions = display) => {
      if (!active() || paintOptions.skipReload) return;
      painted = result;
      newestPaint.current = gesture;
      const frame = previewIframeRef.current;
      if (finishUnchangedMutation(frame, result, paintOptions, requestFallback)) return;
      if (result.parsed) updateKeyframeCacheFromParsed(result.parsed.animations, path,
        last.selection.id ?? undefined, last.mutation, frame?.contentDocument);
      if (!frame?.contentDocument) {
        fallback = true;
        return;
      }
      redrawUnlessPaintedBack(paintOptions, () => {
        paintOptions.beforeReload?.();
        // Replaying the parent timeline can reset styles owned by a nested composition.
        // Read only those children, taking an outstanding edit's projection when available.
        const reads = paintOptions.softReload && result.scriptText && !paintOptions.instantPatch && !paintOptions.instantPatches?.length
          ? readNestedFiles(frame, result.scriptText, child => projectedTimelineText(pid, child)
              ?? readStudioEditSource(pid, child).then(file => file.content)) : null;
        if (!reads) applyPreviewSync(frame, result, paintOptions, requestFallback);
        else void settleNestedReads(reads).then(files => {
          if (active() && newestPaint.current === gesture && frame === previewIframeRef.current)
            redrawUnlessPaintedBack(paintOptions, () => applyPreviewSync(frame, result, paintOptions, requestFallback, files));
        });
      });
    };
    const result = await runMutationRequest(mutations, options, showToast, () => saveOrderedGsapEdit(
      pid, path, last.selection, mutations, options, options.history ?? cloudHistoryForWrite(writeProjectFile, options),
      editHistory.recordEdit, present, (accepted, previous) => {
        if (!active()) return;
        const frame = previewIframeRef.current;
        if (accepted.after != null) onFileContentChanged?.(path, accepted.after);
        forceReloadSdkSession?.();
        if (display.skipReload) return;
        if (!painted || painted.scriptText !== accepted.scriptText) {
          // Another entry point may have confirmed a newer script. Bind that script
          // instead of applying this older gesture's runtime values over it.
          present(accepted, { ...display, instantPatch: undefined, instantPatches: undefined });
        }
        saved = true;
        if (fallback && !display.deferPreviewSync) {
          if (frame) scheduleCommittedPreview(frame, pid, [{ path, previous, current: confirmedSource(pid, path) }], reloadPreview);
          else reloadPreview();
        }
        onCacheInvalidate();
      },
    ));
    if (result) {
      trackKeyframeCommit(mutations, result, options, calls.map(call => call.options));
      options.onResult?.(result);
    }
  }, [projectIdRef, previewIframeRef, editHistory.recordEdit, showToast, onFileContentChanged, forceReloadSdkSession, onCacheInvalidate, reloadPreview, writeProjectFile]);

  // Every GSAP-script commit is a read-modify-write of one file. Overlapping
  // commits to the SAME file (any op type, any animation) interleave server-side,
  // so every legacy request takes the same project/file lock as SDK writes. An
  // explicit key adds ordering for related calls but never replaces the file lock.
  const commitMutation = useMemo<CommitMutation>(() => {
    const serializeFile = <T,>(file: string, task: () => Promise<T>): Promise<T> => {
      if (writeProjectFile) {
        return serializeStudioFileMutation(writeProjectFile, file, task);
      }
      return serializerRef.current(`gsap-file:${file}`, task);
    };
    const serializeCommit = <T,>(
      file: string,
      serializeKey: string | undefined,
      task: () => Promise<T>,
    ): Promise<T> => {
      const fileKey = `gsap-file:${file}`;
      const run = () => serializeFile(file, task);
      if (serializeKey && (writeProjectFile || serializeKey !== fileKey)) {
        return serializerRef.current(serializeKey, run);
      }
      return run();
    };
    const commit: CommitMutation = trackedStudioEdit((selection, mutation, options) => {
      if (!activeProjectId) return Promise.resolve();
      const file = gsapWriteFile(selection, activeCompPath);
      if (getCachedCloudDisklessMode()) {
        return runOrderedCommit(activeProjectId, activeCompPath, file, [{ selection, mutation, options }], options);
      }
      return serializeCommit(file, options.serializeKey, () =>
        runCommit(activeProjectId, activeCompPath, file, selection, mutation, options),
      );
    }) as CommitMutation;
    commit.batch = trackedStudioEdit((calls: CommitMutationCall[], options: CommitMutationOptions) => {
      if (!activeProjectId) return Promise.resolve();
      const file = calls[0] ? gsapWriteFile(calls[0].selection, activeCompPath) : "index.html";
      if (getCachedCloudDisklessMode()) return runOrderedCommit(activeProjectId, activeCompPath, file, calls, options);
      return serializeCommit(file, options.serializeKey, () =>
        runBatchCommit(activeProjectId, activeCompPath, file, calls, options),
      );
    });
    return commit;
  }, [runCommit, runBatchCommit, runOrderedCommit, activeCompPath, activeProjectId, writeProjectFile]);
  const trackGsapSaveFailure = useGsapSaveFailureTelemetry(activeCompPath);
  const handleGsapSaveFailure = useCallback(
    (
      error: unknown,
      selection: DomEditSelection,
      mutation: Record<string, unknown>,
      label?: string,
    ) => {
      trackGsapSaveFailure(error, selection, mutation, label);
      if (!isStudioSaveErrorAlreadyToasted(error)) {
        showToast?.(`Couldn't save animation: ${getStudioSaveErrorMessage(error)}`, "error");
      }
    },
    [showToast, trackGsapSaveFailure],
  );
  const commitMutationSafely = useSafeGsapCommitMutation(commitMutation, handleGsapSaveFailure);

  // One stable SDK-deps object shared by all GSAP child hooks. Memoized so the
  // hooks' callbacks keep a stable identity (an inline literal here re-fired the
  // property-debounce flush on every render). refresh() soft-reloads (preserving
  // the playhead) and invalidates the panel cache, matching the server path.
  const sdkRefresh = useCallback(
    (after: string) => {
      // extractGsapScriptText returns null when zero/multiple GSAP scripts are
      // present — that's an ambiguous/structural change that genuinely needs a full
      // reload. But a SINGLE-script soft-reloadable edit must not escalate to a full
      // remount even if applySoftReload reports failure (same U4 invariant as
      // applyPreviewSync): the live state is already correct, and a remount re-inlines
      // subcomps + reverts their keyframes.
      const script = extractGsapScriptText(after);
      if (script) {
        // Soft-reload in place. reloadPreview is the ASYNC-failure escalation — a
        // plugin-CDN load error genuinely breaks the iframe → full reload. Per U4, a
        // synchronous "verify-failed" (transient empty __timelines) does NOT escalate,
        // but a "cannot-soft-reload" (structural failure) does.
        softReloadOrEscalate(previewIframeRef.current, script, reloadPreview, "sdk_refresh", after);
      } else {
        reloadPreview();
      }
      onCacheInvalidate();
    },
    [previewIframeRef, reloadPreview, onCacheInvalidate],
  );
  // Read the on-disk bytes of targetPath so the SDK GSAP persist captures the
  // exact prior content as its undo `before` (matching the style/delete paths),
  // instead of a normalized full-DOM re-emit that would reformat the whole file.
  const readProjectFileContent = useCallback(
    (path: string): Promise<string> => {
      if (!activeProjectId) throw new Error("No active project");
      return readSharedProjectFileContent(activeProjectId, path);
    },
    [activeProjectId],
  );
  const sdkDeps = useMemo<CutoverDeps | null>(
    () =>
      writeProjectFile && !getCachedCloudDisklessMode()
        ? {
            editHistory: { recordEdit: editHistory.recordEdit },
            writeProjectFile,
            reloadPreview,
            refresh: sdkRefresh,
            compositionPath: activeCompPath,
            readProjectFile: readProjectFileContent,
            publishSession: publishSdkSession,
          }
        : null,
    [
      editHistory.recordEdit,
      writeProjectFile,
      reloadPreview,
      sdkRefresh,
      activeCompPath,
      readProjectFileContent,
      publishSdkSession,
    ],
  );

  const propertyOps = useGsapPropertyDebounce(commitMutationSafely, {
    sdkSession,
    sdkDeps,
    activeCompPath,
    onFlushError: handleGsapSaveFailure,
  });
  const animationOps = useGsapAnimationOps({
    projectIdRef,
    activeCompPath,
    commitMutation,
    commitMutationSafely,
    showToast,
    sdkSession,
    sdkDeps,
    writeProjectFile,
  });
  const keyframeOps = useGsapKeyframeOps({
    activeCompPath,
    commitMutation,
    commitMutationSafely,
    trackGsapSaveFailure: handleGsapSaveFailure,
    sdkSession,
    sdkDeps,
  });
  const arcPathOps = useGsapArcPathOps(commitMutationSafely);
  return { commitMutation, ...propertyOps, ...animationOps, ...keyframeOps, ...arcPathOps };
}
