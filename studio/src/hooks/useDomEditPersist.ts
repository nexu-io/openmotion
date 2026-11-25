import { mountedCanvasVersion, isolatedSourceVersion } from "../components/editor/isolatedSourceTarget";
import { confirmedSource } from "../utils/confirmedTextSources";
import { scheduleCommittedPreview } from "../player/committedPreview";
import { isolatedEditVersion } from "../utils/isolatedEditVersions";
import { savePreparedDomEdit } from "./orderedDomEdit";
import type { ProjectEditCommand } from "../../../packages/edit-core/commands";
import { submitStudioCommands } from "../utils/projectEditBatch";
import { submitIsolatedCanvasEdit } from "./submitIsolatedCanvasEdit";
import type { SdkSessionHandle } from "./useSdkSession";
import { useCallback, useRef } from "react";
import { findUnsafeDomPatchValues } from "@hyperframes/core/studio-api/finite-mutation";
import { trackStudioPendingEdit } from "../utils/studioPendingEdits";
import { trackStudioEvent } from "../utils/studioTelemetry";
import { buildDomEditPatchTarget, type DomEditSelection } from "../components/editor/domEditing";
import type { PersistDomEditOperations } from "./domEditCommitTypes";
import { applyPatchByTarget, findTagByTarget, type PatchOperation } from "../utils/sourcePatcher";
import {
  DomEditPersistUnsafeValueError,
  DomEditPersistPreparedWriteError,
  DomEditPersistUnresolvableError,
  warnDomEditPersistNoOp,
} from "./domEditPersistFailure";
import {
  formatUnsafeFieldList,
  postPatchElement,
  writePreparedContent,
  type PatchElementResponse,
} from "./useDomEditCommitsHelpers";
import { importedFontFaceCssFor } from "../utils/studioFontHelpers";
import { countStudioManualEditSave } from "../components/editor/manualEditsDom";
import type { CutoverResult } from "../utils/sdkCutover";
import { reseekPreviewRuntime } from "./timelineTrackVisibility";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import { getCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { readProjectFileContent, studioHistoryForWrite, type ProjectFileWriter } from "../utils/studioFileHistory";
import { applyUndoRestoreToPreview } from "../utils/gsapUndoRestore";
import { syncRestoredTimelineFromPreview } from "../player/lib/timelineRestoreSync";
import { usePlayerStore } from "../player/store/playerStore";

import type { RecordEditInput } from "../utils/studioFileHistory";
export type { RecordEditInput } from "../utils/studioFileHistory";

export interface UseDomEditPersistParams {
  activeCompPath: string | null;
  previewIframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
  queueDomEditSave: <T>(save: () => Promise<T>) => Promise<T>;
  writeProjectFile: ProjectFileWriter;
  editHistory: { recordEdit: (entry: RecordEditInput) => Promise<void> };
  projectIdRef: React.MutableRefObject<string | null>;
  reloadPreview: (changedPaths?: string | readonly string[]) => void;
  forceReloadSdkSession?: SdkSessionHandle["forceReload"];
  onTrySdkPersist?: (
    selection: DomEditSelection,
    operations: PatchOperation[],
    originalContent: string,
    targetPath: string,
    options?: { label?: string; coalesceKey?: string; skipRefresh?: boolean },
  ) => Promise<CutoverResult>;
}

/** Studio's one DOM-edit writer: patches the source file, records history, then reloads or reseeks the preview. */
export function useDomEditPersist({
  activeCompPath,
  previewIframeRef,
  showToast,
  queueDomEditSave,
  writeProjectFile,
  editHistory,
  projectIdRef,
  reloadPreview,
  forceReloadSdkSession,
  onTrySdkPersist,
}: UseDomEditPersistParams): PersistDomEditOperations {
  const reportedUnresolvableRef = useRef(new Set<string>());

  // fallow-ignore-next-line complexity
  const performPersistDomEditOperations = useCallback(
    // fallow-ignore-next-line complexity
    async (
      selection: DomEditSelection,
      operations: PatchOperation[],
      options: Parameters<PersistDomEditOperations>[2],
      expectedProjectId: string,
    ) => {
      if (projectIdRef.current !== expectedProjectId) {
        throw new Error("Active project changed before the edit could be saved");
      }
      const pid = expectedProjectId;
      if (options?.shouldSave && !options.shouldSave()) return;

      const targetPath = selection.sourceFile || activeCompPath || "index.html";
      const completePersistence = <T>(result: T, changed: boolean): T => {
        if (!selection.isolatedTarget && options?.skipRefresh && changed && !options.deferRender)
          reseekPreviewRuntime(previewIframeRef.current);
        return result;
      };

      const readTarget = async (): Promise<string | null> => {
        const content = await readProjectFileContent(pid, targetPath);
        if (projectIdRef.current !== expectedProjectId) {
          throw new Error("Active project changed before the edit could be saved");
        }
        return options?.shouldSave && !options.shouldSave() ? null : content;
      };

      // Validate layout values BEFORE any persist path runs. The SDK cutover
      // path (onTrySdkPersist) returns early on success, so leaving this check
      // after it let invalid numeric values bypass the guard whenever the
      // cutover flag was on.
      const patchTarget = buildDomEditPatchTarget(selection);
      const font = options?.importedFont;
      const patchBody = {
        target: patchTarget,
        operations,
        ...(font ? { fontFaceCss: importedFontFaceCssFor(font, targetPath) } : {}),
      };
      const unsafeFields = findUnsafeDomPatchValues(patchBody);
      if (unsafeFields.length > 0) {
        const fields = formatUnsafeFieldList(unsafeFields);
        showToast("Couldn't save edit because it contains invalid layout values", "error");
        throw new DomEditPersistUnsafeValueError(`DOM patch contains unsafe values: ${fields}`, {
          alreadyToasted: true,
        });
      }

      const history = {
        label: options?.label ?? "Edit layer",
        coalesceKey: options?.coalesceKey,
        coalesceMs: options?.coalesceMs,
      };
      if (getCachedCloudDisklessMode()) {
        const command: ProjectEditCommand = options?.projectEdit ?? (options?.canvasPosition
          ? { kind: "moveCanvasElement", target: patchTarget, time: usePlayerStore.getState().currentTime, ...options.canvasPosition }
          : { kind: "editElements", patches: [patchBody] });
        const edit = { ...command, compositionPath: targetPath };
        const writeHistory = studioHistoryForWrite(writeProjectFile, history.label, history.coalesceKey, history.coalesceMs, options?.continuous);
        const shown = selection.isolatedTarget ? isolatedSourceVersion(selection.isolatedTarget)
          : selection.element && mountedCanvasVersion(selection.element.ownerDocument, pid, targetPath);
        if (options?.prepareContent || options?.validateContent) {
          return savePreparedDomEdit(pid, edit, shown, options, writeHistory, editHistory.recordEdit, {
            frame: previewIframeRef, projectId: projectIdRef, activePath: activeCompPath, refresh: reloadPreview,
          });
        }
        const versions = shown ? { [targetPath]: shown } : {};
        const result = selection.isolatedTarget
          ? await submitIsolatedCanvasEdit(pid, [edit], versions, writeHistory, previewIframeRef, reloadPreview, options?.coalesceKey)
          : { ...await submitStudioCommands(pid, [edit], versions, writeHistory), presentChanged: true, deferPresentation: false };
        const changed = result.changedPaths.includes(targetPath);
        if (changed) await editHistory.recordEdit({ ...history, files: {} });
        if (projectIdRef.current === pid && changed && result.presentChanged && !result.divergent.length && !result.deferPresentation) {
          forceReloadSdkSession?.({ projectId: pid, versions: result.versions });
          if (!selection.isolatedTarget && !options?.skipRefresh) reloadPreview(targetPath);
        }
        return completePersistence({ sourceFile: targetPath, version: result.versions[targetPath], changed }, changed);
      }
      if (onTrySdkPersist && !selection.isolatedTarget && !font && !options?.prepareContent && !options?.validateContent) {
        const originalContent = await readTarget();
        if (originalContent === null) return;
        const cutover = await onTrySdkPersist(selection, operations, originalContent, targetPath, {
          label: options?.label,
          coalesceKey: options?.coalesceKey,
          skipRefresh: options?.skipRefresh,
        });
        if (cutover.status === "failed") throw cutover.error;
        if (cutover.status === "committed") {
          // SDK handled it — its in-memory doc is already current, so do NOT
          // forceReload (that would echo-reload the session we just wrote).
          return completePersistence(
            { sourceFile: targetPath, version: cutover.version, changed: true },
            true,
          );
        }
      }

      const prepare = options?.prepareContent;
      let preparedWriteFailed = false;
      // Read, server patch, follow-up write and history hold the file's queue, so no save lands between them.
      const originalVersion = selection.isolatedTarget && isolatedEditVersion(pid, targetPath, isolatedSourceVersion(selection.isolatedTarget));
      const saved = await serializeStudioFileMutations(writeProjectFile, [targetPath], async () => {
        const originalContent = await readTarget();
        if (originalContent === null) return null;
        options?.validateContent?.(originalContent);
        let patchData: PatchElementResponse;
        if (
          selection.element?.namespaceURI === "http://www.w3.org/2000/svg" &&
          selection.hfId && !font &&
          operations.length > 0 &&
          operations.every(op => op.type === "inline-style" && op.childSelector === undefined)
        ) {
          // shortcut: 0.9.7's server rejects SVG; retain the normal file queue and history until upstream supports it.
          const target = { hfId: selection.hfId };
          const matched = findTagByTarget(originalContent, target) !== null;
          const content = matched
            ? operations.reduce((html, op) => applyPatchByTarget(html, target, op), originalContent)
            : originalContent;
          const changed = content !== originalContent;
          if (changed) await writeProjectFile(targetPath, content, originalContent);
          patchData = { matched, changed, content, path: targetPath };
        } else {
          patchData = await postPatchElement(pid, targetPath, patchBody, showToast,
            selection.isolatedTarget && isolatedSourceVersion(selection.isolatedTarget));
        }
        if (!patchData.changed) return { patchData, originalContent, patchedContent: null, finalContent: null };

        const patchedContent =
          typeof patchData.content === "string" ? patchData.content : originalContent;
        const prepared = prepare
          ? await writePreparedContent(
              targetPath,
              patchedContent,
              prepare,
              async (path, content, expected) => { await writeProjectFile(path, content, expected); },
              showToast,
            )
          : { content: patchedContent, failed: false };
        preparedWriteFailed = prepared.failed;
        const finalContent = prepared.content;

        await editHistory.recordEdit({
          ...history,
          targets: [
            {
              file: targetPath,
              ...(selection.id && { id: selection.id }),
              ...(selection.hfId && { hfId: selection.hfId }),
              ...(selection.selector && { selector: selection.selector }),
              ...(selection.selectorIndex !== undefined && {
                selectorIndex: selection.selectorIndex,
              }),
            },
          ],
          files: { [targetPath]: { before: originalContent, after: finalContent } },
        });
        return { patchData, originalContent, patchedContent, finalContent };
      });
      if (saved === null) return;
      const { patchData, originalContent, patchedContent, finalContent } = saved;

      if (finalContent === null) {
        if (patchData.matched === false) {
          const targetKey = selection.selector ?? selection.id ?? "selection";
          if (!reportedUnresolvableRef.current.has(targetKey)) {
            reportedUnresolvableRef.current.add(targetKey);
            trackStudioEvent("save_skipped_unresolvable", {
              target_id: selection.id ?? undefined,
              target_selector: selection.selector ?? undefined,
              target_source_file: selection.sourceFile ?? undefined,
              composition: activeCompPath ?? undefined,
            });
          }
          throw new DomEditPersistUnresolvableError(targetPath);
        }
        warnDomEditPersistNoOp(selection, operations);
        return completePersistence(
          typeof patchData.path === "string" && typeof patchData.version === "string"
            ? { sourceFile: patchData.path, version: patchData.version, changed: false }
            : undefined,
          false,
        );
      }
      forceReloadSdkSession?.();

      if (selection.isolatedTarget) {
        const frame = previewIframeRef.current;
        const current = confirmedSource(pid, targetPath);
        if (frame && projectIdRef.current === pid) {
          scheduleCommittedPreview(frame, pid, [{ path: targetPath,
            previous: originalVersion ? {content: originalContent, version: originalVersion} : undefined,
            current: current?.content === finalContent ? current : undefined,
          }], reloadPreview, options?.coalesceKey ? {gestureId: options.coalesceKey} : undefined);
        }
      } else if (options?.syncTimingInPlace) {
        // Reuse the same attribute-only diff and runtime rebind as soft undo.
        // Keep the iframe, media decoder, thumbnails and ruler alive during a slider drag.
        const strategy = applyUndoRestoreToPreview(
          previewIframeRef.current, activeCompPath,
          { [targetPath]: { previous: originalContent, restored: finalContent } },
          usePlayerStore.getState().currentTime, () => reloadPreview(targetPath),
        );
        if (strategy === "soft") syncRestoredTimelineFromPreview(previewIframeRef.current?.contentDocument);
      } else if (!options?.skipRefresh) {
        reloadPreview(targetPath);
      }
      const outcome = completePersistence(
        finalContent === patchedContent &&
          typeof patchData.path === "string" &&
          typeof patchData.version === "string"
          ? { sourceFile: patchData.path, version: patchData.version, changed: true }
          : undefined,
        true,
      );
      if (preparedWriteFailed) throw new DomEditPersistPreparedWriteError(targetPath);
      return outcome;
    },
    [
      activeCompPath,
      editHistory,
      writeProjectFile,
      projectIdRef,
      reloadPreview,
      showToast,
      forceReloadSdkSession,
      onTrySdkPersist,
      previewIframeRef,
    ],
  );

  const persistDomEditOperations: PersistDomEditOperations = useCallback(
    (selection, operations, options) => {
      const expectedProjectId = projectIdRef.current;
      if (!expectedProjectId) return Promise.reject(new Error("No active project"));
      // Counted, so a preview reload requested before this save settles is not shown over it.
      const perform = () => performPersistDomEditOperations(selection, operations, options, expectedProjectId);
      const ordered = getCachedCloudDisklessMode();
      const save = () => {
        if (!ordered) return queueDomEditSave(perform);
        const result = perform();
        trackStudioPendingEdit(result);
        return result;
      };
      return selection.element ? countStudioManualEditSave(selection.element, save) : save();
    },
    [performPersistDomEditOperations, projectIdRef, queueDomEditSave],
  );

  return persistDomEditOperations;
}
