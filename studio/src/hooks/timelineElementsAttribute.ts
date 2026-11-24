import { projectTimelineControl } from "./timelineControlPreview";
import { refreshCommittedTimeline } from "./timelineTimingSync";
import { getCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { confirmedSource, supportsOrderedTextEdits } from "../utils/confirmedTextSources";
import { saveCloudTimeline, timelineAttributeCommand } from "../utils/cloudTimelineEdit";
import { useCallback } from "react";
import { useCaptionWorkspace } from "../motion/captionWorkspace";
import type { TimelineEditCallbacks } from "../player/components/timelineCallbacks";
import { syncStoredElementAttribute } from "../player/lib/automationStoreSync";
import { saveProjectFilesWithHistory } from "../utils/studioFileHistory";
import { applyPatchByTarget } from "../utils/sourcePatcher";
import {
  buildPatchTarget,
  findTimelineElementInIframe,
  readFileContent,
} from "./timelineEditingHelpers";
import type { UseTimelineElementVisibilityEditingInput } from "./timelineTrackVisibility";
import { projectForTimelineSave, type TimelineEditOutcome } from "./timelineEditPermission";

type ElementAttributeEdits = Parameters<
  NonNullable<TimelineEditCallbacks["onSetElementsAttributeQuiet"]>
>[0];

type PatchTarget = NonNullable<ReturnType<typeof buildPatchTarget>>;

// Legacy cues identify themselves by DOM id. Custom HTML can identify a caption
// solely by its source attribute, even with an ordinary id and no timeline role.
function mayChangeCaptionLock(projectId: string, paths: Iterable<string>, edits: ElementAttributeEdits): boolean {
  if (edits.some(({ element }) => /^(?:transcript|text)-[a-f0-9-]{36}-/.test(element.domId || element.id))) return true;
  return Array.from(paths).some(path => {
    const source = confirmedSource(projectId, path);
    return !source || /data-caption-track/i.test(source.content);
  });
}

function editsByFile(
  edits: ElementAttributeEdits,
  activeCompPath: string | null,
): Map<string, Array<{ target: PatchTarget; value: string | null }>> {
  const byFile = new Map<string, Array<{ target: PatchTarget; value: string | null }>>();
  for (const { element, value } of edits) {
    const target = buildPatchTarget(element);
    if (!target) throw new Error("A clip has no id to save it by");
    const path = element.sourceFile || activeCompPath || "index.html";
    byFile.set(path, [...(byFile.get(path) ?? []), { target, value }]);
  }
  return byFile;
}

function patchLive(
  iframe: HTMLIFrameElement | null,
  edits: ElementAttributeEdits,
  attr: string,
  activeCompPath: string | null,
): void {
  for (const { element, value } of edits) {
    const node = findTimelineElementInIframe(iframe, element, activeCompPath);
    if (value === null) node?.removeAttribute(attr);
    else node?.setAttribute(attr, value);
    syncStoredElementAttribute(element, attr, value);
  }
}

/** One attribute written on several clips as a single save and a single undo step. */
export function useSetElementsAttribute({
  projectIdRef,
  activeCompPath,
  showToast,
  writeProjectFile,
  recordEdit,
  previewIframeRef,
  reloadPreview,
  pendingTimelineEditPathRef,
  isRecordingRef,
}: UseTimelineElementVisibilityEditingInput) {
  return useCallback(
    async (
      edits: ElementAttributeEdits,
      attr: string,
      label: string,
    ): Promise<TimelineEditOutcome> => {
      const projectId = projectForTimelineSave(
        isRecordingRef?.current,
        projectIdRef.current,
        showToast,
      );
      if (typeof projectId !== "string") return projectId;
      if (edits.length === 0) return { status: "saved" };
      let settle: ((saved: boolean) => void) | undefined;
      try {
        const byFile = editsByFile(edits, activeCompPath);
        for (const path of byFile.keys()) pendingTimelineEditPathRef.current.add(path);
        const uniform = edits.every(edit => edit.value === edits[0]?.value);
        const state = attr === "muted" ? "muted" : attr === "data-timeline-locked" ? "locked" : null;
        const iframe = previewIframeRef.current;
        if (attr === "muted" || attr === "data-timeline-locked" || attr === "data-volume") {
          settle = projectTimelineControl(projectId, activeCompPath, iframe, attr, edits);
        }
        const cloud = getCachedCloudDisklessMode();
        const onSaved = cloud && iframe && !iframe.contentDocument && reloadPreview
          ? refreshCommittedTimeline(iframe, activeCompPath ?? "index.html", projectId, reloadPreview) : undefined;
        let changedPaths: string[];
        if (state && uniform && cloud) {
          changedPaths = await saveCloudTimeline(
            projectId,
            [...byFile].map(([path, patches]) => ({ path, command: resolve => ({
              kind: "setClipState", hfIds: patches.map(p => resolve({...p.target, domId:p.target.id ?? undefined})), state, enabled: edits[0]!.value !== null,
            }) })),
            writeProjectFile, recordEdit, label, onSaved,
          );
        } else if (cloud && supportsOrderedTextEdits(projectId)) {
          changedPaths = await saveCloudTimeline(projectId, [...byFile].map(([path, patches]) => ({
            path, command: timelineAttributeCommand(patches, attr),
          })), writeProjectFile, recordEdit, label, onSaved);
        } else {
          const apply = cloud ? (await import("../../../packages/edit-core/canvas-commands")).applyCanvasCommand : undefined;
          const commands = new Map([...byFile].map(([path, patches]) => [path, timelineAttributeCommand(patches, attr)]));
          const files = Object.fromEntries([...byFile].map(([path, patches]) => [path, (before: string) =>
            apply ? apply(before, commands.get(path)!) : patches.reduce((html, { target, value }) =>
              applyPatchByTarget(html, target, { type: attr === "muted" ? "html-attribute" : "attribute", property: attr, value }), before),
          ]));
          changedPaths = await saveProjectFilesWithHistory({
            projectId, label, files,
            commandForWrite: apply ? (path) => commands.get(path) : undefined,
            readFile: (path) => readFileContent(projectId, path),
            writeFile: writeProjectFile, recordEdit, onSaved,
          });
        }
        if (settle) settle(true);
        else patchLive(iframe, edits, attr, activeCompPath);
        if (!onSaved && changedPaths.length && iframe && !iframe.contentDocument) reloadPreview?.();
        if (attr === "data-timeline-locked" && changedPaths.length && mayChangeCaptionLock(projectId, changedPaths, edits)) {
          useCaptionWorkspace.getState().changed();
        }
        return { status: "saved" };
      } catch (error) {
        settle?.(false);
        const reason = error instanceof Error ? error.message : "Could not save the clips";
        showToast(reason, "error");
        return { status: "failed", reason };
      }
    },
    [
      projectIdRef,
      activeCompPath,
      showToast,
      writeProjectFile,
      recordEdit,
      previewIframeRef,
      reloadPreview,
      pendingTimelineEditPathRef,
      isRecordingRef,
    ],
  );
}
