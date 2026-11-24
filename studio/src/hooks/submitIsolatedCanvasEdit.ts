import { cancelRemovedCanvasTargets, watchedCanvasTargets } from "../components/editor/remoteCanvasTargets";
import { readMountedSource } from "./syncPeerComposition";
import type { RefObject } from "react";
import type { CompositionEdit } from "../../../packages/edit-core/commands";
import { tryApplyPeerChanges } from "../player/peerTimingPreview";
import { isPreviewChanging } from "../player/previewReloading";
import { scheduleCommittedPreview } from "../player/committedPreview";
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
  read: () => Promise<{ content?: string; version?: string | null; missing?: boolean }> | undefined,
) {
  const frame = frameRef.current;
  const group = frame && presentations.get(frame)?.get(path);
  if (!frame) return;
  const targets = watchedCanvasTargets(frame, path);
  if (!group && !targets.length) return;
  const previous = group?.previous ?? confirmedSource(project, path);
  const file = await read();
  if (frameRef.current !== frame || !file) return;
  const content = file.missing ? "" : file.content;
  if (typeof content !== "string" || (!file.missing && (!file.version || previous?.version === file.version))) return;
  await cancelRemovedCanvasTargets(frame, targets, content, async version =>
    previous?.version === version ? previous.content : (await readMountedSource(project, version))?.content);
  if (!group || !previous || !file.version) return;
  const current = { content, version: file.version };
  const isCurrent = () => frameRef.current === frame && !isPreviewChanging() && presentations.get(frame)?.get(path) === group;
  if (await tryApplyPeerChanges(frame, { path, previous, current }, isCurrent, "paint-only")) {
    group.previous = current;
  }
}

/** Use the snapshots already held by the patch writer to confirm what the mounted canvas shows. */
export async function submitIsolatedCanvasEdit(
  project: string, commands: CompositionEdit[], versions: Record<string, string>, history: StudioWriteHistory | undefined,
  frameRef: RefObject<HTMLIFrameElement | null>, refresh: (paths: readonly string[]) => void, gestureId?: string,
) {
  const path = commands[0]?.compositionPath;
  const frame = frameRef.current;
  const ordered = supportsOrderedTextEdits(project);
  const bases = new Map(Object.keys(versions).map(file => [file, confirmedSource(project, file)]));
  const group = frame && path && ordered ? beginPresentation(frame, path, bases.get(path)) : undefined;
  let last = true;
  const saved = submitStudioCommands(project, commands, versions, history);
  const result = await saved.then(receipt => {
    if (group && receipt.changedPaths.includes(path)) group.state.changed = true;
    return receipt;
  }).finally(() => {
    if (group) last = group.end();
  });
  const presentChanged = group?.state.changed || result.changedPaths.length > 0;
  if (frame && frame === frameRef.current && !result.divergent.length && result.changedPaths.length) {
    const changes = result.changedPaths.map(file => {
      const current = confirmedSource(project, file);
      const previous = path === file && group ? group.state.previous : bases.get(file);
      return { path: file, previous, current: result.versions[file] === current?.version ? current : undefined };
    });
    scheduleCommittedPreview(frame, project, changes, refresh, { gestureId });
  }
  return { ...result, deferPresentation: !last, presentChanged: last && presentChanged };
}
