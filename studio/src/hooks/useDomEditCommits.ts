import { supportsOrderedTextEdits } from "../utils/confirmedTextSources";
import { trackStudioPendingEdit } from "../utils/studioPendingEdits";
import { submitIsolatedCanvasEdit } from "./submitIsolatedCanvasEdit";
import type { SdkSessionHandle } from "./useSdkSession";
import { cloudHistoryForWrite } from "../utils/studioFileHistory";
import { buildProjectApiPath } from "../utils/projectRouting";
import { useCallback } from "react";
import { findUnsafeDomPatchValues } from "@hyperframes/core/studio-api/finite-mutation";
import { FONT_EXT } from "../utils/mediaTypes";
import { primaryFontFamilyValue } from "../utils/studioFontHelpers";
import { StudioSaveHttpError, trackStudioSaveFailure } from "../utils/studioSaveDiagnostics";
import type { DomEditSelection } from "../components/editor/domEditing";
import { fontFamilyFromAssetPath, type ImportedFontAsset } from "../components/editor/fontAssets";
import type { CommitDomEditPatchBatches } from "./domEditCommitTypes";
import type { ResolveDomSelectionOptions } from "./useDomSelectionTypes";
import type { PatchOperation } from "../utils/sourcePatcher";
import { DomEditPersistUnsafeValueError } from "./domEditPersistFailure";
import { useDomEditPersist, type RecordEditInput } from "./useDomEditPersist";
import { useDomEditPositionPatchCommit } from "./useDomEditPositionPatchCommit";
import { inlineTextBatches } from "../components/editor/isolatedInlineTextPatch";
import { useDomEditTextCommits } from "./useDomEditTextCommits";
import { useDomGeometryCommits } from "./useDomGeometryCommits";
import { useElementLifecycleOps } from "./useElementLifecycleOps";
import {
  AtomicElementPatchConvergenceError,
  batchesAreInlineStyleOnly,
  formatUnsafeFieldList,
  patchElementBatches,
  isolatedCanvasCommands,
} from "./useDomEditCommitsHelpers";
import type { CutoverResult } from "../utils/sdkCutover";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import { encodeUrlPath } from "@hyperframes/parsers";

export interface UseDomEditCommitsParams {
  activeCompPath: string | null;
  previewIframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
  queueDomEditSave: <T>(save: () => Promise<T>) => Promise<T>;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  editHistory: { recordEdit: (entry: RecordEditInput) => Promise<void> };
  fileTree: string[];
  fontAssets?: ImportedFontAsset[];
  importedFontAssetsRef: React.MutableRefObject<ImportedFontAsset[]>;
  projectId: string | null;
  projectIdRef: React.MutableRefObject<string | null>;
  reloadPreview: (changedPaths?: string | readonly string[]) => void;

  // From useDomSelection
  domEditSelection: DomEditSelection | null;
  applyDomSelection: (
    selection: DomEditSelection | null,
    options?: { revealPanel?: boolean; additive?: boolean; preserveGroup?: boolean },
  ) => void;
  clearDomSelection: () => void;
  refreshDomEditSelectionFromPreview: (selection: DomEditSelection) => void;
  buildDomSelectionFromTarget: (
    target: HTMLElement,
    options?: ResolveDomSelectionOptions,
  ) => Promise<DomEditSelection | null>;
  /** Resync the in-memory SDK session after a SERVER-side write (NOT the SDK
   * path, whose session is already current) so a later SDK edit doesn't
   * serialize the pre-write doc and revert the server's change. */
  forceReloadSdkSession?: SdkSessionHandle["forceReload"];
  /** Stage 7 Step 3c: called before the server-side patch path. */
  onTrySdkPersist?: (
    selection: DomEditSelection,
    operations: PatchOperation[],
    originalContent: string,
    targetPath: string,
    options?: { label?: string; coalesceKey?: string; skipRefresh?: boolean },
  ) => Promise<CutoverResult>;
  /** Stage 7 §3.1: called before the server-side delete path. */
  onTrySdkDelete?: (
    hfId: string,
    originalContent: string,
    targetPath: string,
  ) => Promise<CutoverResult>;
  /** Resolver-shadow tripwire for z-index reorder targets (telemetry-only, decoupled from cutover). */
  onReorderShadow?: (targets: string[]) => void;
  readOnlyPreview: boolean;
}

export function useDomEditCommits({
  activeCompPath,
  previewIframeRef,
  showToast,
  queueDomEditSave,
  writeProjectFile,
  editHistory,
  fileTree,
  fontAssets = [],
  importedFontAssetsRef,
  projectId,
  projectIdRef,
  reloadPreview,
  domEditSelection,
  applyDomSelection,
  clearDomSelection,
  refreshDomEditSelectionFromPreview,
  buildDomSelectionFromTarget,
  forceReloadSdkSession,
  onTrySdkPersist,
  onTrySdkDelete,
  onReorderShadow,
  readOnlyPreview,
}: UseDomEditCommitsParams) {
  const resolveImportedFontAsset = useCallback(
    (fontFamilyValue: string): ImportedFontAsset | null => {
      const family = primaryFontFamilyValue(fontFamilyValue);
      if (!family) return null;
      const imported = importedFontAssetsRef.current.find(
        (font) => font.family.toLowerCase() === family.toLowerCase(),
      );
      if (imported) return imported;
      // An authored face already owns its source and weight; do not replace it with a filename guess.
      const doc = previewIframeRef.current?.contentDocument;
      if (doc?.fonts && Array.from(doc.fonts).some(face => face.family.replace(/^["']|["']$/g, "").toLowerCase() === family.toLowerCase())) return null;
      const known = fontAssets.find(font => font.family.toLowerCase() === family.toLowerCase());
      if (known) return known;
      const asset = fileTree.find(
        (path) =>
          FONT_EXT.test(path) &&
          fontFamilyFromAssetPath(path).toLowerCase() === family.toLowerCase(),
      );
      if (!asset || !projectId) return null;
      return {
        family: fontFamilyFromAssetPath(asset),
        path: asset,
        url: buildProjectApiPath(projectId, `/preview/${encodeUrlPath(asset)}`),
      };
    },
    [fileTree, fontAssets, projectId, importedFontAssetsRef, previewIframeRef],
  );

  const persistDomEditOperations = useDomEditPersist({
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
  });

  const commitDomEditPatchBatches: CommitDomEditPatchBatches = useCallback(
    (batches, options) => {
      const expectedProjectId = projectIdRef.current;
      if (!expectedProjectId) return Promise.reject(new Error("No active project"));
      const history = cloudHistoryForWrite(writeProjectFile, options);
      const intent = history && isolatedCanvasCommands(batches);
      const ordered = !!intent && supportsOrderedTextEdits(expectedProjectId);
      // The ordered transport serializes preparation and commits; older hosts use the file locks.
      // fallow-ignore-next-line complexity
      const perform = async () => {
        if (projectIdRef.current !== expectedProjectId) {
          throw new Error("Active project changed before the edit could be saved");
        }
        const pid = expectedProjectId;
        const unsafeFields = batches.flatMap((batch) =>
          batch.patches.flatMap((patch) => findUnsafeDomPatchValues(patch)),
        );
        if (unsafeFields.length > 0) {
          showToast("Couldn't save edit because it contains invalid layout values", "error");
          throw new DomEditPersistUnsafeValueError(
            `DOM patch contains unsafe values: ${formatUnsafeFieldList(unsafeFields)}`,
            { alreadyToasted: true },
          );
        }

        const sourceFiles = batches.map((batch) => batch.sourceFile);
        async function saveFiles() {
          if (intent) {
            const result = await submitIsolatedCanvasEdit(pid, intent.commands, intent.versions, history, previewIframeRef, reloadPreview, options.coalesceKey);
            const changed = result.changedPaths.length > 0;
            if (changed) await editHistory.recordEdit({ ...options, files: {} });
            return { allMatched: true, changedPaths: result.changedPaths, reconcileFromServer: result.divergent.length > 0, previewScheduled: true, presentPaths: result.presentChanged && !result.deferPresentation ? sourceFiles : [], savedVersions: result.versions };
          }
          const atomicResult = await patchElementBatches(pid, batches, history);
          const files = Object.fromEntries(
            atomicResult.files
              .filter((result) => result.changed)
              .map((result) => [
                result.sourceFile,
                { before: result.before, after: result.after },
              ]),
          );
          const anyChanged = Object.keys(files).length > 0;
          if (anyChanged) {
            await editHistory.recordEdit({
              label: options.label,
              coalesceKey: options.coalesceKey,
              coalesceMs: options.coalesceMs,
              files,
              targets: batches
                .filter((batch) => Object.hasOwn(files, batch.sourceFile))
                .flatMap((batch) =>
                  batch.patches.map(({ target }) => ({
                    file: batch.sourceFile,
                    ...(target.id && { id: target.id }),
                    ...(target.hfId && { hfId: target.hfId }),
                    ...(target.selector && { selector: target.selector }),
                    ...(target.selectorIndex !== undefined && {
                      selectorIndex: target.selectorIndex,
                    }),
                  })),
                ),
            });
          }
          return {
            allMatched:
              atomicResult.durable && atomicResult.files.every((result) => result.allMatched),
            changedPaths: Object.keys(files),
            reconcileFromServer: false, previewScheduled: false, presentPaths: Object.keys(files), savedVersions: undefined,
          };
        }
        const { allMatched, changedPaths, reconcileFromServer, previewScheduled, presentPaths, savedVersions } = ordered
          ? await saveFiles()
          : await serializeStudioFileMutations(writeProjectFile, sourceFiles, saveFiles);
        const changed = changedPaths.length > 0;
        if (reconcileFromServer) return { durable: true, allMatched, changed };
        if (presentPaths.length) forceReloadSdkSession?.(savedVersions ? { projectId: pid, versions: savedVersions } : undefined);
        const durable = allMatched;
        // A z-only reorder already applied its inline styles to the live iframe
        // DOM (and the store) synchronously, so remounting the iframe here only
        // produces a visible blink. Skip the reload when the caller asked for it
        // AND the persist is provably in sync: style-only ops, every target
        // matched. Any unmatched patch means the live DOM now shows state disk
        // doesn't hold — reload so the preview reconverges.
        const skipSafe =
          options.skipReload === true && batchesAreInlineStyleOnly(batches) && durable;
        if (!durable) reloadPreview(sourceFiles);
        else if (presentPaths.length && !skipSafe && !previewScheduled) reloadPreview(presentPaths);
        const savedCanvasVersion = batches.length === 1 ? savedVersions?.[batches[0]!.sourceFile] : undefined;
        return { durable, allMatched, changed, ...(savedCanvasVersion && { savedCanvasVersion }) };
      };
      const saved = (ordered ? perform() : queueDomEditSave(perform)).catch((error) => {
        if (error instanceof AtomicElementPatchConvergenceError) reloadPreview(batches.map(batch => batch.sourceFile));
        const alreadyToasted =
          (error instanceof StudioSaveHttpError ||
            error instanceof DomEditPersistUnsafeValueError) &&
          error.alreadyToasted;
        if (!alreadyToasted) {
          showToast(error instanceof Error ? error.message : "Failed to reorder layers", "error");
        }
        trackStudioSaveFailure({
          source: "dom_edit",
          error,
          filePath: batches.map((batch) => batch.sourceFile).join(","),
          mutationType: "z-reorder",
          label: options.label,
        });
        throw error;
      });
      if (ordered) trackStudioPendingEdit(saved);
      return saved;
    },
    [
      editHistory,
      forceReloadSdkSession,
      previewIframeRef,
      projectIdRef,
      queueDomEditSave,
      reloadPreview,
      showToast,
      writeProjectFile,
    ],
  );

  const persistBoundText = useCallback(async (selection: DomEditSelection, value: string, typingKey?: string) => {
    const project = projectIdRef.current;
    if (!project || !selection.isolatedTarget?.binding) throw new Error("Missing bound text target");
    const plain = document.createElement("span");
    plain.textContent = value;
    const batches = await inlineTextBatches(project, selection.isolatedTarget, plain.innerHTML, value);
    if (projectIdRef.current !== project) throw new Error("Active project changed before the edit could be saved");
    const result = await commitDomEditPatchBatches(batches, {
      label: "Edit text", coalesceKey: typingKey ?? "bound-text:" + selection.selector, continuous: Boolean(typingKey),
    });
    if (!result.durable) throw new Error("Bound text was not saved");
  }, [commitDomEditPatchBatches, projectIdRef]);

  // ── Text & style commits (delegated to useDomEditTextCommits) ──

  const {
    handleDomStyleCommit,
    handleDomStyleCommitForSelection,
    handleDomAttributeCommit,
    handleDomAttributeLiveCommit,
    handleDomAttributeQuietCommit,
    handleDomHtmlAttributeCommit,
    handleDomAttributesCommit,
    handleDomAttributeBatchCommit,
    handleDomTextCommit,
    handleDomTextCommitForSelection,
    handleDomRichTextCommit,
    commitDomTextFields,
    handleDomTextFieldStyleCommit,
    handleDomAddTextField,
    handleDomRemoveTextField,
  } = useDomEditTextCommits({
    readOnlyPreview,
    activeCompPath,
    previewIframeRef,
    domEditSelection,
    applyDomSelection,
    refreshDomEditSelectionFromPreview,
    buildDomSelectionFromTarget,
    persistDomEditOperations,
    persistBoundText,
    resolveImportedFontAsset,
    showToast,
  });

  // ── Position patch helper (shared by geometry + lifecycle hooks) ──

  const commitPositionPatchToHtml = useDomEditPositionPatchCommit({
    activeCompPath,
    persistDomEditOperations,
    showToast,
  });

  // ── Geometry commits (path offset, box size, rotation) ──

  const {
    stageElementPositionOffset,
    handleDomBoxSizeCommit,
    handleDomRotationCommit,
    handleDomManualEditsReset,
  } = useDomGeometryCommits({
    showToast,
    commitPositionPatchToHtml,
    readOnlyPreview,
  });

  // ── Element lifecycle (delete, z-index reorder) ──

  const { handleDomEditElementsDelete, handleDomZIndexReorderCommit } = useElementLifecycleOps({
    activeCompPath,
    showToast,
    writeProjectFile,
    editHistory,
    projectIdRef,
    reloadPreview,
    clearDomSelection,
    onTrySdkDelete,
    onReorderShadow,
    forceReloadSdkSession,
    commitDomEditPatchBatches,
  });

  return {
    commitDomEditPatchBatches,
    resolveImportedFontAsset,
    handleDomStyleCommit,
    handleDomStyleCommitForSelection,
    handleDomAttributeCommit,
    handleDomAttributeLiveCommit,
    handleDomAttributeQuietCommit,
    handleDomHtmlAttributeCommit,
    handleDomAttributesCommit,
    handleDomAttributeBatchCommit,
    handleDomTextCommit,
    handleDomTextCommitForSelection,
    handleDomRichTextCommit,
    commitDomTextFields,
    handleDomTextFieldStyleCommit,
    handleDomAddTextField,
    handleDomRemoveTextField,
    stageElementPositionOffset,
    commitPositionPatchToHtml,
    handleDomBoxSizeCommit,
    handleDomRotationCommit,
    handleDomManualEditsReset,
    handleDomEditElementsDelete,
    handleDomZIndexReorderCommit,
  };
}
