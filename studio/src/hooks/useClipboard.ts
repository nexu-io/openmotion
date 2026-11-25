import { supportsOrderedTextEdits } from "../utils/confirmedTextSources";
import { projectPendingStructure } from "../player/lib/peerTimeline";
import { isolatedStructureRefresh } from "./timelineTimingSync";
import { applyPasteCommand, type PasteCommand } from "../../../packages/edit-core/content-commands";
import { getCachedCloudDisklessMode } from "../utils/cloudRuntime";
export { pasteElementHtml, pasteTimelineClips, resolveFreeTrack, type PlacedClip } from "../../../packages/edit-core/clipboard";
import { useCallback, useRef } from "react";
import { trackStudioClick } from "../motion/editorTracking";
import type { TimelineElement } from "../player";
import { usePlayerStore } from "../player";
import { toAuthoredStart } from "../player/store/timelineElement";
import type { DomEditSelection } from "../components/editor/domEditing";
import {
  type ClipboardPayload,
  type TimelineClipboardClip,
} from "../utils/clipboardPayload";
import { contentDependencies } from "../../../packages/edit-core/content-schema";
import { projectedTimelineText, saveTimelineFiles } from "../utils/orderedTimelineEdits";
import { type ProjectFileWriter } from "../utils/studioFileHistory";
import { findElementForSelection } from "../components/editor/domEditingElement";
import { findTimelineElementInIframe, readFileContent } from "./timelineEditingHelpers";
import { buildTimelineElementKey } from "../player/lib/timelineElementHelpers";
import {
  authoredMarkup,
  findAuthoredIdentity,
  type AuthoredIdentity,
  liveMarkupWithoutPreviewMarks,
  parseSavedSource,
} from "../utils/authoredSource";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";

type InPlace = { inPlace?: boolean };

const pasteStart = (
  payload: Extract<ClipboardPayload, { kind: "timeline-clip" }>,
  targetPath: string,
  playhead: number,
  options?: InPlace,
) =>
  options?.inPlace && payload.copiedInComposition === targetPath
    ? Math.min(...payload.clips.map((clip) => clip.start))
    : playhead;

const pasteWords = (payload: ClipboardPayload) =>
  payload.kind === "timeline-clip"
    ? {
        label: clipLabel("Paste", payload.clips.length),
        toast: clipToast("Pasted", payload.clips.length),
      }
    : { label: "Paste element", toast: "Pasted element" };

interface RecordEditInput {
  label: string;
  coalesceKey?: string;
  files: Record<string, { before: string; after: string }>;
}

export interface UseClipboardOptions {
  projectId: string | null;
  activeCompPath: string | null;
  fileTree?: readonly string[];
  domEditSelectionRef: React.MutableRefObject<DomEditSelection | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: ProjectFileWriter;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  reloadPreview: () => void;
  handleTimelineElementsDelete: (elements: TimelineElement[]) => Promise<void>;
  handleDomEditElementDelete: (selection: DomEditSelection) => Promise<void>;
  previewIframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  waitForPendingDomEditSaves: () => Promise<void>;
}

/** The timeline element(s) a copy/cut/duplicate acts on: the multi-selection
 *  when one is active, else the single primary selection. */
function getSelectedElements(): TimelineElement[] {
  const { selectedElementId, selectedElementIds, elements } = usePlayerStore.getState();
  if (!selectedElementId) return [];
  const ids = selectedElementIds.size > 1 ? selectedElementIds : new Set([selectedElementId]);
  return elements.filter((el) => ids.has(el.key ?? el.id));
}

function elementKey(domId: string, sourceFile: string): string {
  return buildTimelineElementKey({ id: domId, fallbackIndex: 0, domId, sourceFile });
}

/** "Paste clip" / "Paste clips" — the edit-history label, no count shown. */
function clipLabel(verb: string, clipCount: number): string {
  return `${verb} ${clipCount > 1 ? "clips" : "clip"}`;
}

/** "Pasted clip" / "Pasted 3 clips" — the toast message, count shown once plural. */
function clipToast(verbPast: string, clipCount: number): string {
  return clipCount > 1 ? `${verbPast} ${clipCount} clips` : `${verbPast} clip`;
}

function getSelectedDomElement(
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>,
  selection: DomEditSelection,
  activeCompositionPath: string | null,
): Element | null {
  let doc: Document | null = null;
  try {
    doc = iframeRef.current?.contentDocument ?? null;
  } catch {
    return null;
  }
  if (!doc) return null;

  return findElementForSelection(doc, selection, activeCompositionPath);
}

function clipboardMarkup(
  saved: Document, sourceFile: string, target: AuthoredIdentity, live: Element | null,
  files?: readonly string[], action: "copy" | "duplicate" = "copy",
): string {
  // Split scene instances share their source URL. The selected row identifies
  // the authored host even while an earlier preview is still mounted.
  const selected = findAuthoredIdentity(saved, target);
  if (selected) return authoredMarkup(selected, live, sourceFile, files);
  if (live) {
    const liveHfId = live.getAttribute("data-hf-id") ?? undefined;
    const authored = findAuthoredIdentity(saved, { id: live.id || undefined, hfId: liveHfId });
    if (authored) return authoredMarkup(authored, live, sourceFile, files);
    // Live-only clips generated by composition JS have no authored data-hf-id stamp;
    // keep materializing them while still rejecting deleted authored clips on duplicate.
    if ((!target.hfId && !liveHfId) || action === "copy") {
      return liveMarkupWithoutPreviewMarks(live);
    }
  }
  if (action === "duplicate") throw new Error("The selected clip is no longer available. Select it again in the timeline.");
  throw new Error("Cannot copy an element that is missing from its source file.");
}

function clipboardProjection(pid: string, path: string, frame: HTMLIFrameElement | null, getIds: () => string[]) {
  let selected = false;
  return {
    projectPending(files: Record<string, { before: string; after: string }>) {
      const keys = getIds().map(id => elementKey(id, path));
      const rollback = projectPendingStructure(pid, path, frame, files, keys.length ? keys : undefined);
      selected = keys.length > 0 && keys.every(key => usePlayerStore.getState().selectedElementIds.has(key));
      return rollback;
    },
    selectAfterSave() {
      const ids = getIds();
      if (!selected && ids.length) usePlayerStore.getState().setSelection(ids.map(id => elementKey(id, path)));
    },
  };
}

export function useClipboard({
  projectId,
  activeCompPath,
  fileTree,
  domEditSelectionRef,
  showToast,
  writeProjectFile,
  recordEdit,
  reloadPreview,
  handleTimelineElementsDelete,
  handleDomEditElementDelete,
  previewIframeRef,
  waitForPendingDomEditSaves,
}: UseClipboardOptions) {
  const clipboardRef = useRef<Promise<ClipboardPayload | null> | null>(null);
  const pastedDomElementRef = useRef<{ projectId: string; path: string; hfId: string } | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // After any save still in flight on the file, so a copy right after an edit takes the edit.
  const readSaved = useCallback(
    async (path: string): Promise<string> => {
      const pid = projectIdRef.current;
      if (!pid) throw new Error("No project is open.");
      const projected = projectedTimelineText(pid, path);
      if (projected) return projected;
      // Only the order matters here; a failed save already shows its own banner.
      await waitForPendingDomEditSaves().catch(() => {});
      return serializeStudioFileMutations(writeProjectFile, [path], () =>
        readFileContent(pid, path),
      );
    },
    [waitForPendingDomEditSaves, writeProjectFile],
  );

  const readClips = useCallback(
    async (elements: TimelineElement[], action: "copy" | "duplicate" = "copy"): Promise<TimelineClipboardClip[]> => {
      const documents = new Map<string, Promise<Document>>();
      return Promise.all(elements.map(async element => {
        const path = element.sourceFile || activeCompPath || "index.html";
        let source = documents.get(path);
        if (!source) {
          source = readSaved(path).then(parseSavedSource);
          documents.set(path, source);
        }
        const live = findTimelineElementInIframe(previewIframeRef.current, element, activeCompPath);
        return {
          html: clipboardMarkup(await source, path, { id: element.domId, hfId: element.hfId }, live, fileTree, action),
          start: element.start,
          duration: element.duration,
          track: element.authoredTrack ?? element.track,
        };
      }));
    },
    [activeCompPath, fileTree, previewIframeRef, readSaved],
  );

  const copyTimelineSelection = useCallback((elements: TimelineElement[]): Promise<ClipboardPayload> => {
    const sourceFile = elements[0]?.sourceFile || activeCompPath || "index.html";
    return readClips(elements).then((clips) => {
      showToast(clips.length > 1 ? `Copied ${clips.length} clips` : "Copied clip", "info");
      return {
        kind: "timeline-clip",
        clips,
        sourceFile,
        projectId: projectIdRef.current ?? undefined,
        copiedInComposition: activeCompPath || "index.html",
      };
    });
  }, [activeCompPath, readClips, showToast]);

  const copyDomSelection = useCallback(
    (domSelection: DomEditSelection): Promise<ClipboardPayload> | null => {
      const live = getSelectedDomElement(previewIframeRef, domSelection, activeCompPath);
      if (!live && !domSelection.id && !domSelection.hfId) {
        showToast("Unable to copy this element.", "info");
        return null;
      }
      const sourceFile = domSelection.sourceFile || activeCompPath || "index.html";
      return readSaved(sourceFile).then((content) => {
        const html = clipboardMarkup(parseSavedSource(content), sourceFile, domSelection, live, fileTree);
        showToast("Copied element", "info");
        return {
          kind: "dom-element",
          html,
          sourceFile,
          projectId: projectIdRef.current ?? undefined,
          originSelector: domSelection.selector,
          originSelectorIndex: domSelection.selectorIndex,
        };
      });
    },
    [activeCompPath, fileTree, previewIframeRef, readSaved, showToast],
  );

  // The key handler needs its answer now, so the targets are found here and only the file read
  // is pending. Returns this copy's own result; a failed copy leaves the clipboard as it was.
  const copyToClipboard = useCallback((): Promise<ClipboardPayload | null> | null => {
    const domSelection = domEditSelectionRef.current;
    let pending: Promise<ClipboardPayload> | null;
    const { selectedElementId, selectedElementIds } = usePlayerStore.getState();
    const selectedClips = getSelectedElements();
    const selectedDom = domSelection && getSelectedDomElement(previewIframeRef, domSelection, activeCompPath);
    // Selecting a nested or untimed canvas element can leave its owning clip
    // selected in the timeline. Copy the actual canvas target in that case.
    const isClipTarget = domSelection && selectedClips.some((element) => {
      if (selectedDom) return findTimelineElementInIframe(previewIframeRef.current, element, activeCompPath) === selectedDom;
      return (element.sourceFile || activeCompPath || "index.html") === domSelection.sourceFile &&
        ((element.hfId && element.hfId === domSelection.hfId) || (element.domId && element.domId === domSelection.id));
    });
    if (domSelection && !isClipTarget) pending = copyDomSelection(domSelection);
    else if (selectedElementId) {
      if (selectedClips.length !== Math.max(1, selectedElementIds.size)) {
        showToast("The selected clip is no longer available. Select it again in the timeline.", "error");
        return null;
      }
      pending = copyTimelineSelection(selectedClips);
    }
    else if (domSelection) pending = copyDomSelection(domSelection);
    else {
      showToast("Nothing selected to copy.", "info");
      return null;
    }
    if (!pending) return null;
    const own = pending.catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : "Failed to copy", "error");
      return null;
    });
    const previous = clipboardRef.current;
    const settled = own.then((payload) => payload ?? previous);
    clipboardRef.current = settled;
    void settled.then((payload) => {
      if (!payload && clipboardRef.current === settled) clipboardRef.current = null;
    });
    return own;
  }, [activeCompPath, copyDomSelection, copyTimelineSelection, domEditSelectionRef, previewIframeRef, showToast]);

  const handleCopy = useCallback((): boolean => {
    const copied = copyToClipboard() !== null;
    // Copy changes nothing in the project, so it is an interaction, not an edit.
    if (copied) trackStudioClick("timeline", "copy");
    return copied;
  }, [copyToClipboard]);

  // Two independent paste modes (timeline clip vs DOM element) behind one guarded save.
  // fallow-ignore-next-line complexity
  const handlePaste = useCallback(
    async (options?: InPlace) => {
      const payload = await clipboardRef.current;
      if (!payload) {
        showToast("Nothing to paste.", "info");
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) return;

      const targetPath = activeCompPath || "index.html";
      try {
        let pastedIds: string[] = [];
        let pastedHfId: string | null = null;
        const fromThisFile = payload.sourceFile === targetPath && payload.projectId === pid;
        const playhead = usePlayerStore.getState().currentTime;
        const command: PasteCommand = payload.kind === "timeline-clip"
          ? { kind: "pasteClips", compositionPath: targetPath, start: pasteStart(payload, targetPath, playhead, options), clips: payload.clips, copyLook: fromThisFile }
          : { kind: "pasteElement", compositionPath: targetPath, start: playhead, html: payload.html, originSelector: payload.originSelector, originSelectorIndex: payload.originSelectorIndex, copyLook: fromThisFile };
        const paste = (originalContent: string) => {
          const result = applyPasteCommand(originalContent, command);
          pastedIds = result.ids;
          pastedHfId = result.hfId ?? null;
          return result.content;
        };

        const { label, toast } = pasteWords(payload);
        const onSaved = getCachedCloudDisklessMode()
          ? isolatedStructureRefresh(previewIframeRef.current, targetPath, pid, reloadPreview) : undefined;

        const projection = clipboardProjection(pid, targetPath, previewIframeRef.current, () => pastedIds);
        const changedPaths = await saveTimelineFiles({
          projectId: pid,
          label,
          files: { [targetPath]: paste },
          readFile: (path) => readFileContent(pid, path),
          writeFile: writeProjectFile,
          commandForWrite: () => getCachedCloudDisklessMode() ? command : undefined,
          recordEdit,
          projectPending: (onSaved || supportsOrderedTextEdits(pid)) ? projection.projectPending : undefined,
          onSaved,
        }, contentDependencies(command));

        if (!changedPaths.length) throw new Error("Failed to paste");

        // CapCut: the pasted clip(s) become the selection; the playhead does not
        // move. reloadPreview is a bare refresh-key bump with no selection
        // snapshot of its own; calling setSelection before it is what makes the
        // post-reload store state land on the pasted ids instead of stale ones.
        projection.selectAfterSave();
        pastedDomElementRef.current = pastedHfId ? { projectId: pid, path: targetPath, hfId: pastedHfId } : null;
        if (!onSaved) reloadPreview();
        showToast(toast, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to paste";
        showToast(message);
      }
    },
    [activeCompPath, previewIframeRef, recordEdit, reloadPreview, showToast, writeProjectFile],
  );

  // Duplicates the selection right after it, or with `inPlace` at its own time on a track of its own,
  // without touching the clipboard — a pending copy must survive a Cmd+D. Shares
  // pasteTimelineClips with handlePaste; only the anchor and clip source differ (the
  // selection's end or start here, the playhead or the copy's own time there).
  const handleDuplicate = useCallback(
    async (options?: InPlace): Promise<boolean> => {
      const elements = getSelectedElements();
      const { selectedElementId, selectedElementIds } = usePlayerStore.getState();
      if (!selectedElementId) return false;
      if (elements.length !== Math.max(1, selectedElementIds.size)) {
        showToast("The selected clip is no longer available. Select it again in the timeline.", "error");
        return false;
      }
      const pid = projectIdRef.current;
      if (!pid) return false;

      const pathOf = (el: TimelineElement) => el.sourceFile || activeCompPath || "index.html";
      const targetPath = pathOf(elements[0]!);
      // The copy lands in targetPath's own clock, so anchor and lane check are local to it.
      const anchorTime = toAuthoredStart(
        elements[0]!,
        options?.inPlace
          ? Math.min(...elements.map((el) => el.start))
          : Math.max(...elements.map((el) => el.start + el.duration)),
      );

      try {
        const clips = await readClips(elements, "duplicate");
        let ids: string[] = [];
        const command: PasteCommand = { kind: "pasteClips", compositionPath: targetPath, start: anchorTime, clips, copyLook: true };
        const duplicate = (originalContent: string) => {
          const result = applyPasteCommand(originalContent, command);
          ids = result.ids;
          return result.content;
        };
        const onSaved = getCachedCloudDisklessMode()
          ? isolatedStructureRefresh(previewIframeRef.current, activeCompPath ?? "index.html", pid, reloadPreview) : undefined;

        const projection = clipboardProjection(pid, targetPath, previewIframeRef.current, () => ids);
        const changedPaths = await saveTimelineFiles({
          projectId: pid,
          label: clipLabel("Duplicate", clips.length),
          files: { [targetPath]: duplicate },
          readFile: (path) => readFileContent(pid, path),
          writeFile: writeProjectFile,
          commandForWrite: () => getCachedCloudDisklessMode() ? command : undefined,
          recordEdit,
          projectPending: (onSaved || supportsOrderedTextEdits(pid)) ? projection.projectPending : undefined,
          onSaved,
        }, contentDependencies(command));

        if (!changedPaths.length) throw new Error("Failed to duplicate");

        // The duplicate becomes the selection, mirroring CapCut's own paste
        // convention — there is no CapCut Duplicate to match directly (Cmd+D is
        // a no-op there); this is our own choice for consistency with paste.
        // Select before reloading, same reason as handlePaste above.
        projection.selectAfterSave();
        if (!onSaved) reloadPreview();
        showToast(clipToast("Duplicated", clips.length), "info");
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to duplicate";
        showToast(message, "error");
        return false;
      }
    },
    [
      activeCompPath,
      readClips,
      previewIframeRef,
      recordEdit,
      reloadPreview,
      showToast,
      writeProjectFile,
    ],
  );

  const handleCut = useCallback(async (): Promise<boolean> => {
    const selected = getSelectedElements();
    const domSelection = domEditSelectionRef.current;
    const copied = copyToClipboard();
    const payload = copied && await copied;
    if (!payload) return false;

    if (payload.kind === "timeline-clip" && selected.length > 0) {
      // One call for the whole selection, not one per element: the batched
      // delete writes and records history once, so a multi-clip Cmd+X undoes
      // in a single Cmd+Z instead of needing one per clip.
      await handleTimelineElementsDelete(selected);
      return true;
    }

    if (domSelection) {
      await handleDomEditElementDelete(domSelection);
      return true;
    }
    return true;
  }, [
    copyToClipboard,
    domEditSelectionRef,
    handleTimelineElementsDelete,
    handleDomEditElementDelete,
  ]);

  const canPaste = useCallback(() => clipboardRef.current !== null, []);

  return { pastedDomElementRef, handleCopy, handlePaste, handleCut, handleDuplicate, canPaste };
}
