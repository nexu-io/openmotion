import { useCallback, useMemo, type MutableRefObject } from "react";
import { changedFilePaths, changedFileVersion, changedFileVersions, readFileChangeAffectsPreview, readFileTreeChanged } from "../components/editor/manualEditsParsing";
import { isUnrelatedPreviewHtmlChange } from "../player/lib/previewHtmlSources";
import { presentPendingCanvasChange } from "./submitIsolatedCanvasEdit";
import { queuePeerPreviewFiles, syncPeerComposition } from "./syncPeerComposition";
import { canPresentDuringStudioEdit } from "../player/committedPreview";
import { previewDocumentIdentity } from "../player/lib/previewAdapter";
import { createRemoteFileReader } from "./remoteFileReads";
import { knownCompositionSource } from "../player/lib/compositionPosterSource";
import { evictStaleCompositionCaptures } from "../player/lib/clientCompositionCapture";
import { expectPosterFileVersion } from "../player/lib/posterFileRead";
import { usePlayerStore } from "../player/store/playerStore";
import { clearStudioSaveFailures } from "../utils/studioSaveState";
import { advanceCachedFile } from "./orderedFileChanges";
import { confirmedSource, forgetProjectSources } from "../utils/confirmedTextSources";
import {
  deleteExternalConflictSnapshot,
  loadExternalConflictSnapshot,
  persistExternalConflictSnapshot,
  persistExternalFailureSnapshot,
} from "../utils/externalConflictStorage";
import { notifyExternalFileReload } from "./externalFileReloadBus";
import { useExternalFileChangeCoordinator } from "./useExternalFileChangeCoordinator";
import type { useFileManager } from "./useFileManager";
import type { usePreviewPersistence } from "./usePreviewPersistence";

type FileManager = Pick<
  ReturnType<typeof useFileManager>,
  | "editingFile"
  | "flushPendingSourceSave"
  | "discardPendingSourceSave"
  | "getPendingSourceCandidate"
  | "overwriteExternalConflict"
  | "readProjectFile"
  | "updateEditingFileContent"
  | "refreshOpenSource"
  | "refreshFileTree"
>;

type PreviewPersistence = Pick<
  ReturnType<typeof usePreviewPersistence>,
  "drainPendingDomEditSaves" | "resetDomEditSaveQueueBreaker"
>;

interface UseStudioExternalFileChangesOptions {
  projectId: string | null;
  activeCompPath: string | null;
  masterCompPath: string | null;
  previewIframeRef: MutableRefObject<HTMLIFrameElement | null>;
  fileManager: FileManager;
  previewPersistence: PreviewPersistence;
  pendingTimelineEditPathRef: MutableRefObject<Set<string>>;
  reloadPreview: (path?: string | readonly string[]) => void;
  onOutsideChange?: () => void;
  onHistoryChanged?: (writeToken?: string) => void | Promise<void>;
}

/** Connects the app's save queues, recovery storage, and reload surfaces to one owner. */
export function useStudioExternalFileChanges({
  projectId,
  activeCompPath,
  masterCompPath,
  previewIframeRef,
  fileManager,
  previewPersistence,
  pendingTimelineEditPathRef,
  reloadPreview,
  onOutsideChange,
  onHistoryChanged,
}: UseStudioExternalFileChangesOptions) {
  const { flushPendingSourceSave, discardPendingSourceSave } = fileManager;
  const { drainPendingDomEditSaves, resetDomEditSaveQueueBreaker } = previewPersistence;
  const bumpThumbnailRevisions = usePlayerStore((state) => state.bumpThumbnailRevisions);
  const onAcceptedPersistedFileChange = useCallback(
    (path: string, affectedCompositions: readonly string[] | null, ownWrite?: { token: string; version: string }) => {
      onOutsideChange?.();
      bumpThumbnailRevisions(affectedCompositions, path);
      if (projectId) {
        evictStaleCompositionCaptures(projectId, affectedCompositions, usePlayerStore.getState().thumbnailRevisions);
        if (ownWrite) expectPosterFileVersion(projectId, path, ownWrite);
      }
    },
    [bumpThumbnailRevisions, onOutsideChange, projectId],
  );
  const filesForChange = useMemo(() => createRemoteFileReader(), []);
  const earlyPreviews = useMemo(() => new WeakMap<HTMLIFrameElement, Map<string, { version: string | null; queued: boolean; src: string; documentId?: string }>>(), [projectId]);
  const presentPendingPeerChange = useCallback((payload: unknown) => {
    const paths = changedFilePaths(payload);
    const frame = previewIframeRef.current;
    if (frame && !paths) earlyPreviews.delete(frame);
    if (!projectId || !paths?.length) return;
    const read = filesForChange(projectId, payload);
    const versions = changedFileVersions(payload);
    const independent = frame && !frame.contentDocument && versions && readFileChangeAffectsPreview(payload) && !readFileTreeChanged(payload) &&
      paths.every(file => versions[file] && canPresentDuringStudioEdit(frame, projectId, file));
    if (frame) {
      const early = earlyPreviews.get(frame) ?? new Map();
      for (const file of paths) {
        if (independent || early.has(file)) early.set(file, { version: versions?.[file] ?? null, queued: !!independent, src: frame.src, documentId: previewDocumentIdentity(frame) });
      }
      if (early.size) earlyPreviews.set(frame, early);
      // Only presentation can pass the drain; source views and conflict handling still settle in order.
      if (independent) queuePeerPreviewFiles(frame, projectId, paths, versions, read, reloadPreview);
    }
    for (const file of paths) {
      void presentPendingCanvasChange(projectId, file, previewIframeRef, () => read(projectId, file)).catch(() => {});
    }
  }, [projectId, previewIframeRef, filesForChange, earlyPreviews, reloadPreview]);
  const refreshFileViews = useCallback((payload: unknown, acceptChange: (unaffectedPreview?: string) => void) => {
    const activePath = activeCompPath ?? masterCompPath;
    const previous = projectId && activePath
      ? confirmedSource(projectId, activePath) ?? knownCompositionSource(usePlayerStore.getState(), projectId, activePath)
      : null;
    // Capture the displayed source first. All readers below belong to the new thumbnail revision.
    const paths = changedFilePaths(payload);
    const treeChanged = readFileTreeChanged(payload);
    const affectsPreview = readFileChangeAffectsPreview(payload);
    const unrelated = affectsPreview && isUnrelatedPreviewHtmlChange(
      previewIframeRef.current, projectId, activePath, paths, treeChanged,
    );
    acceptChange(unrelated ? activePath ?? undefined : undefined);
    if (!projectId) return;
    const previousSources = new Map(paths?.map(path => [path, confirmedSource(projectId, path)]));
    const read = filesForChange(projectId, payload);
    const changedPath = paths?.length === 1 ? paths[0] : undefined;
    const version = changedPath && changedFileVersion(payload, changedPath);
    const preview = unrelated ? "unaffected" as const : affectsPreview
      ? syncPeerComposition(projectId, activePath, paths, read, previewIframeRef, previous, version, {
        versions: changedFileVersions(payload), treeChanged, refresh: reloadPreview,
        alreadyQueued: (file, version) => {
          const frame = previewIframeRef.current;
          const early = frame && earlyPreviews.get(frame);
          const latest = early?.get(file);
          if (!frame || !early || !latest) return false;
          if (latest.version !== version) return true; // A newer event owns this file while the drain catches up.
          early.delete(file);
          return latest.queued && frame.src === latest.src && latest.documentId === previewDocumentIdentity(frame);
        },
      })
      : undefined;
    if (!paths) forgetProjectSources(projectId);
    for (const path of paths ?? ["."]) {
      // Mounted consumers captured their previous source above. Advance any other warm
      // file too, but never download an unvisited file merely to keep it resident.
      const previous = previousSources.get(path);
      const current = advanceCachedFile(projectId, path, payload, previous);
      notifyExternalFileReload(path, read, { projectId, paths, treeChanged, previous, current });
      fileManager.refreshOpenSource(path, read);
    }
    return preview;
  }, [projectId, activeCompPath, masterCompPath, previewIframeRef, filesForChange, fileManager.refreshOpenSource, reloadPreview, earlyPreviews]);

  const drainPendingChanges = useCallback(async () => {
    const source = await flushPendingSourceSave();
    if (source.status !== "clean") return source;
    return drainPendingDomEditSaves();
  }, [drainPendingDomEditSaves, flushPendingSourceSave]);

  const discardPendingChanges = useCallback(() => {
    discardPendingSourceSave();
    resetDomEditSaveQueueBreaker();
    if (projectId) clearStudioSaveFailures(projectId);
  }, [discardPendingSourceSave, resetDomEditSaveQueueBreaker, projectId]);

  return useExternalFileChangeCoordinator({
    projectId,
    activeCompPath,
    recoveryFilePath: fileManager.editingFile?.path ?? activeCompPath ?? masterCompPath,
    pendingTimelineEditPathRef,
    drainPendingChanges,
    getPendingCandidate: fileManager.getPendingSourceCandidate,
    discardPendingChanges,
    reloadPreview,
    refreshFileViews,
    presentPendingPeerChange,
    persistConflictSnapshot: persistExternalConflictSnapshot,
    persistFailureSnapshot: persistExternalFailureSnapshot,
    loadConflictSnapshot: loadExternalConflictSnapshot,
    deleteConflictSnapshot: deleteExternalConflictSnapshot,
    overwriteConflict: fileManager.overwriteExternalConflict,
    readProjectFile: fileManager.readProjectFile,
    onUseExternalFile: fileManager.updateEditingFileContent,
    resetSaveQueues: resetDomEditSaveQueueBreaker,
    onAcceptedPersistedFileChange,
    refreshFileTree: fileManager.refreshFileTree,
    onHistoryChanged,
  });
}
