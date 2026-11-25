import { useCallback, type RefObject } from "react";
import {
  readProjectFileContent,
  saveProjectFilesWithHistory,
  type DomEditCommitBaseParams, type RecordEditInput,
} from "../utils/studioFileHistory";
import {
  buildDomEditPatchTarget,
  readHfId,
  type DomEditSelection,
} from "../components/editor/domEditing";
import { scheduleCommittedPreview } from "../player/committedPreview";
import { stageStructurePreview } from "../player/peerTimingPreview";
import { projectLocalTimelineEdit } from "../player/lib/peerTimeline";
import type { GroupSelectionResult, followGroupSelection } from "./groupResultSelection";
import { getCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { saveOrderedTimeline } from "../utils/orderedTimelineEdits";
import { isolatedSourceVersion, mountedCanvasVersion } from "../components/editor/isolatedSourceTarget";
import { confirmedSource, type ConfirmedSource } from "../utils/confirmedTextSources";
import {
  findMatchingTimelineElementId,
  resolveElementTrack,
  type ElementMatchSelection,
} from "../utils/studioHelpers";
import type { TimelineElement } from "../player";

interface UseGroupCommitsParams extends DomEditCommitBaseParams {
  /** Refresh the SDK after the document hierarchy changes. */
  forceReloadSdkSession?: () => void;
  timelineElements: TimelineElement[];
  previewIframeRef?: RefObject<HTMLIFrameElement | null>;
  followSelection?: (frame: HTMLIFrameElement, path: string, group: GroupSelectionResult) => ReturnType<typeof followGroupSelection> | undefined;
}

interface PatchTarget {
  id?: string | null;
  hfId?: string;
  selector?: string;
  selectorIndex?: number;
}

interface GroupGeometry {
  bbox: { left: number; top: number; width: number; height: number };
  targets: PatchTarget[];
  rebases: Array<{ target: PatchTarget; left: number; top: number; track?: number }>;
}

// The member's current resolved track (authored, or the runtime's positional-
// index fallback). Threaded through so the server can stamp it explicitly —
// same hazard and fix as the razor split.
function resolveAuthoredTrack(
  selection: ElementMatchSelection,
  timelineElements: TimelineElement[],
): number | undefined {
  const id = findMatchingTimelineElementId(selection, timelineElements);
  if (!id) return undefined;
  const match = timelineElements.find((el) => (el.key ?? el.id) === id);
  if (!match) return undefined;
  return resolveElementTrack(match);
}

// Wrapper sits at the members' bounding box top-left; each member is rebased so
// its absolute position is unchanged. offsetLeft/Top are layout coordinates in
// composition space (transforms excluded), exactly the space the rebase formula
// `left_new = left_old - W.left` operates in — GSAP x/y and offset vars are
// transform deltas and stay correct without adjustment.
export function computeGroupGeometry(
  members: DomEditSelection[],
  timelineElements: TimelineElement[],
): GroupGeometry {
  const boxes = members.map((m) => {
    const el = m.element;
    const box = m.isolatedTarget ? m.isolatedLayoutBox : {
      x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight,
    };
    if (!box) throw new Error("Cannot measure the selected elements in the preview.");
    return {
      target: buildDomEditPatchTarget(m), track: resolveAuthoredTrack(m, timelineElements),
      left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height,
    };
  });
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const width = Math.max(...boxes.map((b) => b.right)) - left;
  const height = Math.max(...boxes.map((b) => b.bottom)) - top;
  return {
    bbox: { left, top, width, height },
    targets: boxes.map((b) => b.target),
    rebases: boxes.map((b) => ({
      target: b.target,
      left: b.left - left,
      top: b.top - top,
      track: b.track,
    })),
  };
}

// Ungroup re-derives each child's track from the raw DOM (no DomEditSelection
// exists per child); matches by id, falling back to hfId for a child with no
// authored id. A child with neither keeps its current track, unstamped.
export function resolveGroupChildTracks(
  group: DomEditSelection,
  timelineElements: TimelineElement[],
): Array<{ target: PatchTarget; track?: number }> {
  const sourceFile = group.sourceFile || "index.html";
  const result: Array<{ target: PatchTarget; track?: number }> = [];
  for (const child of Array.from(group.element.children)) {
    const id = (child as HTMLElement).id || undefined;
    const hfId = readHfId(child);
    if (!id && !hfId) continue;
    const track = resolveAuthoredTrack(
      { id, hfId, sourceFile, isCompositionHost: false },
      timelineElements,
    );
    result.push({ target: buildDomEditPatchTarget({ id, hfId }), track });
  }
  return result;
}

async function saveGroupEdit(
  projectId: string,
  path: string,
  label: string,
  transform: Promise<(source: string) => {html: string; selection: GroupSelectionResult}>,
  deps: UseGroupCommitsParams,
  shown: DomEditSelection,
): Promise<void> {
  let result: GroupSelectionResult;
  let selection: ReturnType<typeof followGroupSelection> | undefined;
  const apply = (source: string, fn: Awaited<typeof transform>) => {
    const edit = fn(source);
    result = edit.selection;
    return edit.html;
  };
  const projection = {
    projectPending(files: RecordEditInput["files"]) {
      const frame = deps.previewIframeRef?.current;
      const base = confirmedSource(projectId, path);
      const file = files[path];
      if (!frame || !file) return;
      selection = deps.followSelection?.(frame, path, result);
      if (base?.content !== file.before) return selection?.rollback;
      const undoTimeline = projectLocalTimelineEdit(projectId, path, file, frame);
      const undoPreview = stageStructurePreview(frame, path, base, file.after, group => {
        result.members = group.members;
        selection?.ready();
      });
      return () => { undoPreview?.(); undoTimeline?.(); selection?.rollback(); };
    },
    onSaved: async (_files: RecordEditInput["files"], previous?: ConfirmedSource) => {
      selection?.saved();
      const frame = deps.previewIframeRef?.current;
      if (!frame || deps.projectIdRef.current !== projectId) return;
      scheduleCommittedPreview(frame, projectId, [{path, previous, current: confirmedSource(projectId, path)}], deps.reloadPreview);
    },
    recordEdit: deps.editHistory.recordEdit,
  };
  if (getCachedCloudDisklessMode()) {
    const shownVersion = shown.isolatedTarget ? isolatedSourceVersion(shown.isolatedTarget)
      : mountedCanvasVersion(shown.element.ownerDocument, projectId, path);
    await saveOrderedTimeline(projectId, [{path, shownVersion, apply: async source => apply(source, await transform)}], label, projection);
  } else {
    const fn = await transform;
    await saveProjectFilesWithHistory({projectId, label, ...projection, files: { [path]: source => apply(source, fn) },
      readFile: file => Promise.resolve(confirmedSource(projectId, file)?.content ?? readProjectFileContent(projectId, file)),
      writeFile: deps.writeProjectFile});
  }
  if (!deps.previewIframeRef?.current) {
    deps.clearDomSelection();
    deps.reloadPreview();
  }
  deps.forceReloadSdkSession?.();
}

export function useGroupCommits(params: UseGroupCommitsParams) {
  const { activeCompPath, showToast, projectIdRef, timelineElements } = params;

  const groupSelection = useCallback(
    async (members: DomEditSelection[]): Promise<string | null> => {
      const pid = projectIdRef.current;
      if (!pid || members.length === 0) return null;

      // All members must live in the same source file — the wrapper is one node
      // in one document. (Cross-file grouping is out of scope.)
      const targetPath = members[0].sourceFile || activeCompPath || "index.html";
      if (members.some((m) => (m.sourceFile || activeCompPath || "index.html") !== targetPath)) {
        showToast("Can't group elements from different files", "error");
        return null;
      }

      // Auto-name "Group N" by the count of existing groups in the document.
      const doc = members[0].element.ownerDocument;
      const groupId = `Group ${doc.querySelectorAll("[data-hf-group]").length + 1}`;
      try {
        const { bbox, targets, rebases } = computeGroupGeometry(members, timelineElements);
        let label = groupId;
        const group = Promise.all([import("../../../packages/edit-core/canvas-source"), import("@hyperframes/studio-server/source-mutation")])
          .then(([{ groupCanvasElements }, { findTargetElement, parseSourceDocument }]) => (source: string) => {
          const result = groupCanvasElements(source, targets, groupId, bbox, rebases);
          if (!result.matched) throw new Error(result.error || "Cannot group the selected elements.");
          label = result.groupId ?? groupId;
          // The upstream groupId is a display label. The emitted DOM id accounts
          // for collisions in the file, so get it from an actual wrapped member.
          const first = targets[0];
          const parent = first && findTargetElement(parseSourceDocument(result.html).document, first)?.parentElement;
          const id = parent?.getAttribute("data-hf-group") === label ? parent.id : undefined;
          return { html: result.html, selection: { wrap: true, wrapper: { id }, members: targets } };
        });
        await saveGroupEdit(pid, targetPath, "Group elements", group, params, members[0]!);
        return label;
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Failed to group elements", "error");
        return null;
      }
    },
    [activeCompPath, projectIdRef, showToast, params, timelineElements],
  );

  const ungroupSelection = useCallback(
    async (group: DomEditSelection): Promise<void> => {
      const pid = projectIdRef.current;
      if (!pid) return;
      const targetPath = group.sourceFile || activeCompPath || "index.html";
      const childTracks = resolveGroupChildTracks(group, timelineElements);

      try {
        const target = buildDomEditPatchTarget(group);
        const ungroup = import("../../../packages/edit-core/canvas-source").then(({ unwrapGroupWithGsapCleanup }) => (source: string) => {
          const result = unwrapGroupWithGsapCleanup(source, target, childTracks);
          if (!result.unwrapped) throw new Error("Group was not found.");
          return {html: result.html, selection: {wrap:false, wrapper:target, members:result.memberIds?.map(id => ({id})) ?? []}};
        });
        await saveGroupEdit(pid, targetPath, "Ungroup elements", ungroup, params, group);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Failed to ungroup elements", "error");
      }
    },
    [activeCompPath, projectIdRef, showToast, params, timelineElements],
  );

  return { groupSelection, ungroupSelection };
}
