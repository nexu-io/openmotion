import { mainVisualTrack } from "../player/components/timelineLinkage";
// Asset-drop handlers for the timeline: drop an existing project asset at a
// placement, or upload dragged-in OS files and place them sequentially.
// Extracted verbatim from useTimelineEditing.ts to keep it under the studio
// 600-line cap.
import { takeImportEntry, type ImportEntryPoint } from "../motion/editorTracking";
import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { compositionInsertionFailureMessage } from "../i18n/editorErrors";
import type { TimelineElement } from "../player";
import type { TimelineDropPlacement } from "../player/components/timelineCallbacks";
import { mainTrackAppendStart, resolveDropTrack, topTrackZIndex } from "../utils/timelineDropTrackInsert";
import {
  buildTimelineAssetId,
  buildTimelineAssetInsertHtml,
  fitTimelineAssetGeometry,
  getTimelineAssetKind,
  insertTimelineAssetIntoSource,
  resolveTimelineAssetCompositionSize,
  resolveTimelineAssetSrc,
} from "../utils/timelineAssetDrop";
import { generateId } from "../utils/generateId";
import { saveProjectFilesWithHistory, type RecordEditInput } from "../utils/studioFileHistory";
import {
  collectHtmlIds,
  resolveDroppedAssetDuration,
  resolveDroppedAssetHasAudio,
} from "../utils/studioHelpers";
import { formatTimelineAttributeNumber } from "./timelineEditingHelpers";
import { readFileContent } from "./timelineTimingSync";
import { commitTimelineCompositionInsertion } from "../utils/timelineCompositionInsert";
import { extendRootDurationInSource } from "../utils/rootDuration";
import { deriveTimelineStoreKeyForDomId } from "../player/lib/timelineElementHelpers";
import { selectAndRevealTimelineElement } from "../player/components/timelineDropReveal";
import { usePlayerStore } from "../player/store/playerStore";
import { beginPendingAssetDrop, dismissPendingAssetDrop, finishPendingAssetDrop, isPendingAssetDropActive, updatePendingAssetDrop } from "../player/store/pendingAssetDrops";

/** The first uploaded file opens the new track (if asked); each next one aims right after the previous. */
function fileDropPlacement(
  index: number,
  next: { start: number; track: number },
  dropped: TimelineDropPlacement | undefined,
  previous: TimelineElement | undefined,
): TimelineDropPlacement {
  if (index === 0 || !previous) return { ...dropped, ...next };
  return previous ? { start: previous.start + previous.duration, track: previous.track } : next;
}

interface DropGesture {
  placed: TimelineElement[];
  onNewTrack: boolean;
  deferRefresh?: boolean;
}

function timelineDropTarget(
  sourceFile: string,
  placement: Pick<TimelineElement, "start" | "track">,
): TimelineElement {
  return {
    id: "timeline-drop",
    tag: "div",
    start: placement.start,
    duration: 0,
    track: placement.track,
    sourceFile,
  };
}

interface UseTimelineAssetDropOpsOptions {
  projectIdRef: MutableRefObject<string | null>;
  activeCompPath: string | null;
  timelineElements: TimelineElement[];
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  reloadPreview: () => void;
  uploadProjectFiles: (files: Iterable<File>, dir?: string, entryPoint?: ImportEntryPoint) => Promise<string[]>;
  isRecordingRef?: RefObject<boolean>;
  forceReloadSdkSession?: () => void;
  observeProjectFileVersion?: (path: string, version: string | null) => void;
  checkEditable?: (targets: readonly TimelineElement[]) => boolean;
}

export function useTimelineAssetDropOps({
  projectIdRef,
  activeCompPath,
  timelineElements,
  showToast,
  writeProjectFile,
  recordEdit,
  reloadPreview,
  uploadProjectFiles,
  isRecordingRef,
  forceReloadSdkSession,
  observeProjectFileVersion,
  checkEditable,
}: UseTimelineAssetDropOpsOptions) {
  const projectId = projectIdRef.current;
  const timelineReady = usePlayerStore((state) => state.timelineReady);
  const pendingDrops = usePlayerStore((state) => state.pendingAssetDrops);
  const elementsRef = useRef(timelineElements);
  const dropScopeRef = useRef(0);
  elementsRef.current = timelineElements;
  useEffect(() => () => {
    dropScopeRef.current++;
    usePlayerStore.setState({ pendingAssetDrops: [] });
  }, [projectId, activeCompPath]);
  useEffect(() => {
    if (!timelineReady) return;
    usePlayerStore.setState((state) => {
      const pendingAssetDrops = state.pendingAssetDrops.filter((drop) =>
        !drop.element || !timelineElements.some((element) =>
          (element.key ?? element.id) === drop.element!.key),
      );
      return pendingAssetDrops.length === state.pendingAssetDrops.length ? state : { pendingAssetDrops };
    });
  }, [timelineElements, timelineReady, pendingDrops]);
  // fallow-ignore-next-line complexity
  const dropAssetAt = useCallback(
    // fallow-ignore-next-line complexity
    async (
      assetPath: string,
      placement: TimelineDropPlacement,
      durationOverride?: number,
      gesture: DropGesture = { placed: [], onNewTrack: false },
      existingPendingId?: string,
    ): Promise<TimelineElement | undefined> => {
      if (isRecordingRef?.current) {
        if (existingPendingId) finishPendingAssetDrop(existingPendingId);
        showToast("Cannot edit timeline while recording", "error");
        return undefined;
      }
      const targetPath = activeCompPath || "index.html";
      if (checkEditable && !checkEditable([timelineDropTarget(targetPath, placement)])) {
        if (existingPendingId) finishPendingAssetDrop(existingPendingId);
        return undefined;
      }
      const pid = projectIdRef.current;
      if (!pid) throw new Error("No active project");

      const kind = getTimelineAssetKind(assetPath);
      if (!kind) {
        if (existingPendingId) finishPendingAssetDrop(existingPendingId);
        showToast("Only image, video, and audio assets can be dropped onto the timeline.");
        return undefined;
      }

      const fileElements = elementsRef.current.filter(element =>
        (element.sourceFile || activeCompPath || "index.html") === targetPath);
      if (kind !== "audio" && placement.insertRow == null && !placement.newTrack &&
          usePlayerStore.getState().rippleEditEnabled && placement.track === mainVisualTrack(fileElements)) {
        const awaitingPreview = usePlayerStore.getState().pendingAssetDrops.flatMap(drop => drop.element ? [drop.element] : []);
        placement = { ...placement, start: mainTrackAppendStart([...fileElements, ...gesture.placed, ...awaitingPreview], placement.track) };
        if (existingPendingId) updatePendingAssetDrop(existingPendingId, { placement });
      }

      const pendingId = existingPendingId ?? beginPendingAssetDrop(assetPath, placement, durationOverride);
      const stillActive = () => isPendingAssetDropActive(pendingId);
      try {
        const normalizedStart = Number(formatTimelineAttributeNumber(placement.start));
        const duration =
          Number.isFinite(durationOverride) && durationOverride != null && durationOverride > 0
            ? durationOverride
            : await resolveDroppedAssetDuration(pid, assetPath, kind);
        const normalizedDuration = Number(formatTimelineAttributeNumber(duration));
        updatePendingAssetDrop(pendingId, { duration: normalizedDuration });
        // A video with an audio stream lands audible; the mixer only hears a
        // <video> marked data-has-audio, and a muted drop was losing the sound.
        const hasAudio = await resolveDroppedAssetHasAudio(pid, assetPath, kind);
        if (!stillActive()) return undefined;
        const resolvedAssetSrc = resolveTimelineAssetSrc(targetPath, assetPath);

        const tag = kind === "image" ? "img" : kind;

        let newId = "";
        let newElementZIndex = 1;
        let track = 0;
        let start = normalizedStart;
        const insertAsset = (originalContent: string) => {
          if (!stillActive()) throw new Error("The timeline drop is no longer active.");
          const fileElements = elementsRef.current
            .filter((te) => (te.sourceFile || activeCompPath || "index.html") === targetPath)
            .map((te) => ({ ...te, sourceFile: targetPath }));
          newElementZIndex = Math.max(1, fileElements.length + gesture.placed.length + 1);
          const ids = collectHtmlIds(originalContent);
          newId = buildTimelineAssetId(assetPath, ids);
          // Include drops saved while this preview was still reloading.
          const awaitingPreview = usePlayerStore.getState().pendingAssetDrops.flatMap((drop) =>
            drop.element && ids.includes(drop.element.domId ?? "")
              ? [drop.element] : [],
          );
          if (placement.newTrack) newElementZIndex = topTrackZIndex(originalContent, [...fileElements, ...gesture.placed, ...awaitingPreview]);
          const resolved = resolveDropTrack({
            magneticMainTrack: usePlayerStore.getState().rippleEditEnabled && placement.track === mainVisualTrack(fileElements),
            source: originalContent,
            // Rows and insertRow count the rows the timeline shows; a track this drop opened has no others.
            elements: gesture.onNewTrack ? [] : fileElements,
            placed: [...gesture.placed, ...awaitingPreview],
            placement,
            dropped: {
              id: newId,
              tag,
              start: normalizedStart,
              duration: normalizedDuration,
            },
          });
          track = resolved.track;
          start = resolved.start;
          updatePendingAssetDrop(pendingId, {
            placement: { ...placement, start },
          });
          return extendRootDurationInSource(
            insertTimelineAssetIntoSource(
              resolved.source,
              buildTimelineAssetInsertHtml({
                id: newId,
                hfId: `hf-${generateId()}`,
                assetPath: resolvedAssetSrc,
                kind,
                start,
                duration: normalizedDuration,
                track,
                zIndex: newElementZIndex,
                hasAudio,
                geometry: fitTimelineAssetGeometry(
                  null,
                  resolveTimelineAssetCompositionSize(originalContent),
                ),
              }),
            ),
            start + normalizedDuration,
          );
        };

        await saveProjectFilesWithHistory({
          projectId: pid,
          label: "Add timeline asset",
          files: { [targetPath]: insertAsset },
          readFile: (path) => readFileContent(pid, path),
          writeFile: writeProjectFile,
          recordEdit,
        });

        const key = deriveTimelineStoreKeyForDomId(newId, targetPath);
        const lane = placement.insertRow == null && !placement.newTrack ? placement.track : track;
        const element = {
          id: newId, key, domId: newId, sourceFile: targetPath,
          tag, start, duration: normalizedDuration, track: lane, authoredTrack: track, zIndex: newElementZIndex,
        };
        finishPendingAssetDrop(pendingId, element);
        if (!stillActive()) return element;
        if (!gesture.deferRefresh) {
          selectAndRevealTimelineElement(key);
          forceReloadSdkSession?.();
          reloadPreview();
        }
        return element;
      } catch (error) {
        if (!stillActive()) return undefined;
        finishPendingAssetDrop(pendingId);
        const message =
          error instanceof Error ? error.message : "Failed to drop asset onto timeline";
        showToast(message);
        return undefined;
      }
    },
    [
      projectIdRef,
      activeCompPath,
      recordEdit,
      showToast,
      writeProjectFile,
      reloadPreview,
      isRecordingRef,
      forceReloadSdkSession,
      checkEditable,
    ],
  );

  const handleTimelineAssetDrop = useCallback(
    async (assetPath: string, placement: TimelineDropPlacement, durationOverride?: number, reportFailure = false) => {
      const result = await dropAssetAt(assetPath, placement, durationOverride);
      if (reportFailure && !result) throw new Error('Could not place the asset on the timeline. Check that the composition is editable.');
    },
    [dropAssetAt],
  );

  // fallow-ignore-next-line complexity
  const handleTimelineFileDrop = useCallback(
    // fallow-ignore-next-line complexity
    async (files: File[], placement?: TimelineDropPlacement) => {
      if (!files.length) return;
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const targetPath = activeCompPath || "index.html";
      const initialPlacement = placement ?? { start: 0, track: 0 };
      if (checkEditable && !checkEditable([timelineDropTarget(targetPath, initialPlacement)])) {
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) return;
      // Read the entry point before any await so a later import cannot claim it.
      const entryPoint = takeImportEntry() ?? "timeline_drop";
      const scope = dropScopeRef.current;
      let cursor = initialPlacement.start;
      const uploading = files.map(file => {
        const duration = getTimelineAssetKind(file.name) === "image" ? 3 : undefined;
        const id = beginPendingAssetDrop(file.name, { ...initialPlacement, start: cursor }, duration);
        cursor += duration ?? 5;
        return { id, name: file.name };
      });
      for (const pending of uploading.slice(1)) {
        updatePendingAssetDrop(pending.id, { rowOwnerId: uploading[0].id });
      }
      let uploaded: string[];
      try { uploaded = await uploadProjectFiles(files, undefined, entryPoint); }
      catch (error) {
        if (scope !== dropScopeRef.current) return;
        uploading.forEach(({ id }) => finishPendingAssetDrop(id));
        showToast(error instanceof Error ? error.message : "Upload failed: network error", "error");
        return;
      }
      if (scope !== dropScopeRef.current) return;
      if (uploaded.length === 0) { uploading.forEach(({ id }) => finishPendingAssetDrop(id)); return; }
      // Match accepted names; a rejected file must never inherit another file's clip.
      const remaining = [...uploading];
      const pendingIds = uploaded.map(path => {
        const index = remaining.findIndex(file => file.name === path.split("/").pop());
        const pending = index < 0 ? undefined : remaining.splice(index, 1)[0];
        if (pending) { updatePendingAssetDrop(pending.id, { assetPath: path }); return pending.id; }
        return beginPendingAssetDrop(path, initialPlacement);
      });
      remaining.forEach(({ id }) => dismissPendingAssetDrop(id));
      pendingIds.forEach((id, index) => updatePendingAssetDrop(id, {
        rowOwnerId: index === 0 ? undefined : pendingIds[0],
      }));
      const gesture: DropGesture = { placed: [], onNewTrack: false, deferRefresh: true };
      for (const [index, assetPath] of uploaded.entries()) {
        if (scope !== dropScopeRef.current) return;
        const nextPlacement = fileDropPlacement(index, initialPlacement, placement, gesture.placed.at(-1));
        updatePendingAssetDrop(pendingIds[index], { placement: nextPlacement });
        const clip = await dropAssetAt(
          assetPath,
          nextPlacement,
          undefined,
          gesture,
          pendingIds[index],
        );
        if (!clip) continue;
        gesture.placed.push(clip);
        if (nextPlacement.insertRow != null || nextPlacement.newTrack) gesture.onNewTrack = true;
      }
      const last = gesture.placed.at(-1);
      if (last && scope === dropScopeRef.current) {
        selectAndRevealTimelineElement(last.key ?? last.id);
        forceReloadSdkSession?.();
        reloadPreview();
      }
    },
    [
      activeCompPath,
      checkEditable,
      dropAssetAt,
      projectIdRef,
      uploadProjectFiles,
      forceReloadSdkSession,
      reloadPreview,
      isRecordingRef,
      showToast,
    ],
  );

  const handleTimelineCompositionDrop = useCallback(
    async (sourcePath: string, placement: Pick<TimelineElement, "start" | "track">) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const targetPath = activeCompPath || "index.html";
      if (checkEditable && !checkEditable([timelineDropTarget(targetPath, placement)])) {
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) throw new Error("No active project");
      const pendingId = beginPendingAssetDrop(sourcePath, placement);
      const isActive = () => isPendingAssetDropActive(pendingId);
      try {
        const element = await commitTimelineCompositionInsertion({
          projectId: pid,
          targetPath,
          sourcePath,
          start: placement.start,
          track: placement.track,
          writeFile: writeProjectFile,
          recordEdit,
          observeVersion: observeProjectFileVersion,
          selectHost: selectAndRevealTimelineElement,
          resync: forceReloadSdkSession,
          refresh: reloadPreview,
          isActive,
        });
        if (element && isActive()) finishPendingAssetDrop(pendingId, element);
      } catch (error) {
        if (!isActive()) return;
        finishPendingAssetDrop(pendingId);
        showToast(compositionInsertionFailureMessage(error), "error");
      }
    },
    [
      activeCompPath,
      checkEditable,
      forceReloadSdkSession,
      isRecordingRef,
      observeProjectFileVersion,
      projectIdRef,
      recordEdit,
      reloadPreview,
      showToast,
      writeProjectFile,
    ],
  );

  return { handleTimelineAssetDrop, handleTimelineFileDrop, handleTimelineCompositionDrop };
}
