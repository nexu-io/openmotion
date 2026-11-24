import { cancelRemovedCanvasTargets, watchedCanvasTargets } from "../components/editor/remoteCanvasTargets";
import { readMountedSource } from "./syncPeerComposition";
import type { RefObject } from "react";
import type { CompositionEdit } from "../../../packages/edit-core/commands";
import { hasPeerLiveEdit, hasPeerTimingDocument, tryApplyPeerChanges } from "../player/peerTimingPreview";
import { isPreviewChanging } from "../player/previewReloading";
import { announcePreviewScenesSwapped } from "../player/sceneSwap";
import { confirmedSource, supportsOrderedTextEdits, type ConfirmedSource } from "../utils/confirmedTextSources";
import { submitStudioCommands } from "../utils/projectEditBatch";
import type { StudioWriteHistory } from "../utils/studioFileHistory";

// Only presentation is frame-bound. The project transport owns persistence across preview replacements.
type Presentation = { previous?: ConfirmedSource; outstanding: number; changed: boolean };
const presentations = new WeakMap<HTMLIFrameElement, Map<string, Presentation>>();

function beginPresentation(frame: HTMLIFrameElement, path: string, previous?: ConfirmedSource) {
  const byPath = presentations.get(frame) ?? new Map<string, Presentation>();
  presentations.set(frame, byPath);
  const group = byPath.get(path) ?? { previous, outstanding: 0, changed: false };
  group.outstanding++;
  byPath.set(path, group);
  return { state: group, end() {
    if (--group.outstanding) return false;
    byPath.delete(path);
    return true;
  } };
}

/** Show a non-geometric peer edit while the project save is still in flight. */
export async function presentPendingCanvasChange(
  project: string, path: string, frameRef: RefObject<HTMLIFrameElement | null>,
  read: () => Promise<{ content?: string; version?: string | null }> | undefined,
) {
  const frame = frameRef.current;
  const group = frame && presentations.get(frame)?.get(path);
  if (!frame) return;
  const targets = watchedCanvasTargets(frame, path);
  if (!group && !targets.length) return;
  const previous = group?.previous ?? confirmedSource(project, path);
  const file = await read();
  if (frameRef.current !== frame || typeof file?.content !== "string" || !file.version || previous?.version === file.version) return;
  await cancelRemovedCanvasTargets(frame, targets, file.content, async version =>
    previous?.version === version ? previous.content : (await readMountedSource(project, version))?.content);
  if (!group || !previous) return;
  const current = { content: file.content, version: file.version };
  const isCurrent = () => frameRef.current === frame && !isPreviewChanging() && presentations.get(frame)?.get(path) === group;
  if (await tryApplyPeerChanges(frame, { path, previous, current }, isCurrent, "paint-only")) {
    group.previous = current;
  }
}

/** Use the snapshots already held by the patch writer to confirm what the mounted canvas shows. */
export async function submitIsolatedCanvasEdit(
  project: string, commands: CompositionEdit[], versions: Record<string, string>, history: StudioWriteHistory | undefined,
  frameRef: RefObject<HTMLIFrameElement | null>, gestureId?: string,
) {
  const path = commands[0]?.compositionPath;
  const frame = frameRef.current;
  const ordered = supportsOrderedTextEdits(project);
  const start = path && frame && (ordered || hasPeerTimingDocument(frame) || hasPeerLiveEdit(frame, "position")) ? confirmedSource(project, path) : undefined;
  const group = frame && path && ordered ? beginPresentation(frame, path, start) : undefined;
  let last = true;
  const saved = submitStudioCommands(project, commands, versions, history);
  const result = await saved.then(receipt => {
    if (group && receipt.changedPaths.includes(path)) group.state.changed = true;
    return receipt;
  }).finally(() => {
    if (group) last = group.end();
  });
  if (!last) return { ...result, previewApplied: true, deferPresentation: true, presentChanged: false };
  const previous = group?.state.previous ?? start;
  const presentChanged = group?.state.changed || result.changedPaths.length > 0;
  const current = path && previous && confirmedSource(project, path);
  let previewApplied = false;
  if (frame && path && previous && current && presentChanged && Object.keys(versions).length === 1 &&
      !result.divergent.length && current.version === result.versions[path]) {
    const isCurrent = () => frame === frameRef.current && !isPreviewChanging() && confirmedSource(project, path)?.version === current.version;
    previewApplied = await tryApplyPeerChanges(frame, { path, previous, current }, isCurrent, { gestureId });
    if (previewApplied) announcePreviewScenesSwapped(frame);
  }
  return { ...result, previewApplied, deferPresentation: false, presentChanged };
}
