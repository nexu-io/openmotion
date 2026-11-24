import { studioFileRevision } from "../../utils/studioFileVersion";
import { isStudioEditSaving } from "../../utils/studioPendingEdits";
import { notePeerPreviewChange, previewContentGeneration } from "../sceneSwap";
import { usePlayerStore } from "../store/playerStore";
import { holdHistoryTimelineUntilPreviewReplaced } from "../timelineRestorePending";
import { parseAuthoredTimeline } from "./authoredTimeline";
import { stageStructurePreview } from "../peerTimingPreview";
import { confirmedSource } from "../../utils/confirmedTextSources";
import { applyAuthoredTimeline } from "./timelineHistoryRestore";

type Projection = NonNullable<ReturnType<typeof parseAuthoredTimeline>>;
// A baseline owns either the already-read source or the projected rows, never a DOM.
type Baseline = ({ content: string; rows?: never } | { rows: Projection; content?: never }) & {
  writeRevision: number;
  generation: number;
};

interface ActiveTimeline {
  projectId: string;
  path: string;
  generation: number;
  baseline?: Baseline;
  readOrder: number;
}

let active: ActiveTimeline | null = null;

/** NLE owns the currently displayed composition. Leaving it invalidates every outstanding read. */
export function openTimelineSource(projectId: string, path: string): () => void {
  const scope = { projectId, path, generation: 0, readOrder: 0 };
  active = scope;
  if (usePlayerStore.getState().timelineSourceProjected) usePlayerStore.setState({ timelineSourceProjected: false });
  return () => {
    if (active === scope) active = null;
  };
}

function timelineFor(projectId: string, path: string) {
  return active?.projectId === projectId && active.path === path &&
    usePlayerStore.getState().timelineProjectId === projectId ? active : null;
}

/** Reuse a read already being made by the editor. A late initial read cannot replace a peer update. */
export function beginTimelineSourceRead(
  projectId: string, path: string,
): (content: string, rows?: Projection) => void {
  const scope = timelineFor(projectId, path);
  if (!scope) return () => {};
  const generation = scope.generation;
  const read = ++scope.readOrder;
  const revision = studioFileRevision();
  return (content: string, rows?: Projection) => {
    if (scope !== active || scope.generation !== generation || scope.readOrder !== read ||
        studioFileRevision() !== revision) return;
    // The SDK often reads the same version immediately after NLE projects it.
    const baseline = scope.baseline;
    if (baseline?.rows && baseline.writeRevision === revision && baseline.generation === generation) return;
    scope.baseline = { ...(rows ? { rows } : { content }), writeRevision: revision, generation };
  };
}

/** Display edit-core's structural result while its conditional write is in flight.
 * A newer confirmed projection takes ownership if another writer wins the race. */
export function projectLocalTimelineEdit(
  projectId: string, path: string, file: { before: string; after: string }, frame: HTMLIFrameElement | null,
): (() => void) | undefined {
  const scope = timelineFor(projectId, path);
  if (!scope) return;
  const duration = usePlayerStore.getState().duration;
  const before = parseAuthoredTimeline(file.before, path, projectId, duration);
  const after = parseAuthoredTimeline(file.after, path, projectId, duration);
  if (!before || !after || !applyAuthoredTimeline(before, after)) return;

  const generation = ++scope.generation;
  const projected = { rows: after, generation, writeRevision: studioFileRevision() };
  scope.baseline = projected;
  const release = holdHistoryTimelineUntilPreviewReplaced(frame);
  return () => {
    if (timelineFor(projectId, path) === scope && scope.baseline === projected) {
      applyAuthoredTimeline(after, before);
      scope.baseline = { rows: before, generation: ++scope.generation, writeRevision: studioFileRevision() };
    }
    release?.();
  };
}

/** All pending local gestures on this file have settled after a failure. Restore the confirmed
 * authored rows and keep runtime-only or other-composition rows in place. */
export function restoreConfirmedTimeline(projectId: string, path: string, content: string) {
  const scope = timelineFor(projectId, path);
  if (!scope) return;
  const duration = usePlayerStore.getState().duration;
  const previous = scope.baseline;
  const before = previous?.rows ?? (previous?.content ? parseAuthoredTimeline(previous.content, path, projectId, duration) : null);
  const after = parseAuthoredTimeline(content, path, projectId, duration);
  if (!after) return;
  applyAuthoredTimeline(before, after, true);
  scope.baseline = { rows: after, generation: ++scope.generation, writeRevision: studioFileRevision() };
}

/** Project a local structural edit without publishing it to other windows or advancing its confirmed source. */
export function projectPendingStructure(projectId: string, path: string, frame: HTMLIFrameElement | null,
  files: Record<string, { before: string; after: string }>, selection?: readonly string[]) {
  const file = files[path];
  if (!file || !timelineFor(projectId, path)) return;
  const { selectedElementIds, selectedElementId } = usePlayerStore.getState();
  const revertTimeline = projectLocalTimelineEdit(projectId, path, file, frame);
  const previous = confirmedSource(projectId, path);
  const revertPreview = frame && previous?.content === file.before && Object.keys(files).length === 1
    ? stageStructurePreview(frame, path, previous, file.after) : undefined;
  if (revertTimeline && selection) usePlayerStore.getState().setSelection(selection);
  const drawnSelection = usePlayerStore.getState().selectedElementIds;
  return () => {
    const restoreSelection = revertTimeline && timelineFor(projectId, path) && drawnSelection !== selectedElementIds &&
      usePlayerStore.getState().selectedElementIds === drawnSelection;
    revertPreview?.();
    revertTimeline?.();
    if (restoreSelection) {
      const state = usePlayerStore.getState();
      const keys = new Set(state.elements.map(element => element.key ?? element.id));
      state.setSelection([...selectedElementIds].filter(key => keys.has(key)), selectedElementId);
    }
  };
}

/** Capture the current view before fetching its latest source. A newer notification,
 * a switch or a local save invalidates this read; the normal preview refresh still runs. */
export function beginPeerTimelineUpdate(projectId: string, path: string, oldFrame?: HTMLIFrameElement | null) {
  const scope = timelineFor(projectId, path);
  if (!scope) return null;
  notePeerPreviewChange();
  const generation = ++scope.generation;
  const previous = scope.baseline;
  const revision = studioFileRevision();
  const staleBaseline = previous?.writeRevision !== revision;
  const wasSaving = isStudioEditSaving();
  const contentGeneration = oldFrame ? previewContentGeneration(oldFrame) : null;
  const document = oldFrame?.contentDocument;
  return (content: string, frame: HTMLIFrameElement | null) => {
    if (timelineFor(projectId, path) !== scope || scope.generation !== generation ||
        wasSaving || isStudioEditSaving() || studioFileRevision() !== revision) return false;
    const duration = usePlayerStore.getState().duration;
    const after = parseAuthoredTimeline(content, path, projectId, duration);
    if (!after) return false;
    const beforeText = previous?.content;
    const before = beforeText === undefined ? previous?.rows ?? null :
      beforeText === content ? after : parseAuthoredTimeline(beforeText, path, projectId, duration);
    // Discard SDK/source reads that started before this confirmed version landed.
    scope.readOrder++;
    scope.baseline = { rows: after, writeRevision: revision, generation };
    const changed = applyAuthoredTimeline(before, after, !before || staleBaseline);
    if (frame && frame === oldFrame && frame.contentDocument === document &&
        contentGeneration === previewContentGeneration(frame)) holdHistoryTimelineUntilPreviewReplaced(frame);
    return changed;
  };
}
