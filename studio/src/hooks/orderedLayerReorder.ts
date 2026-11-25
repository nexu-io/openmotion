import type { RefObject } from "react";
import type { CompositionEdit } from "../../../packages/edit-core/commands";
import { scheduleCommittedPreview } from "../player/committedPreview";
import { confirmedSource } from "../utils/confirmedTextSources";
import { prepareTimelineFile, timelineTimingEdits } from "../utils/cloudTimelineEdit";
import { saveOrderedTimeline } from "../utils/orderedTimelineEdits";
import type { RecordEditInput } from "../utils/studioFileHistory";
import type { TimelineAtomicMoveEdit } from "./timelineMoveAdapter";

/** Paint order and its mirrored timeline lanes are one undoable source change. */
export async function saveLayerOrder(
  project: string,
  edits: CompositionEdit[],
  versions: Record<string, string>,
  lanes: TimelineAtomicMoveEdit[],
  activePath: string | null,
  options: {
    label: string;
    coalesceKey: string;
    recordEdit: (edit: RecordEditInput) => Promise<void>;
    frame: RefObject<HTMLIFrameElement | null>;
    refresh: (paths: readonly string[]) => void;
  },
) {
  const timing = timelineTimingEdits(
    lanes.map(({ element, updates }) => ({ element, ...updates })),
    activePath,
  );
  const paths = new Set([...edits.map((edit) => edit.compositionPath), ...timing.map((edit) => edit.path)]);
  let savedVersions: Readonly<Record<string, string>> = {};
  const changedPaths = await saveOrderedTimeline(
    project,
    [...paths].map((path) => ({
      path,
      shownVersion: versions[path],
      async apply(source: string) {
        const { applyProjectEdit } = await import("../../../packages/edit-core/commands");
        let content = source;
        for (const edit of edits)
          if (edit.compositionPath === path) {
            content = (await applyProjectEdit(content, edit, new Map())).content;
          }
        const movement = timing.find((edit) => edit.path === path);
        return movement ? (await prepareTimelineFile(content, movement)).after : content;
      },
    })),
    options.label,
    {
      recordEdit: options.recordEdit,
      coalesceKey: options.coalesceKey,
      onReceipt: (versions) => {
        savedVersions = versions;
      },
      onSaved: async (files, previous, bases) => {
        const frame = options.frame.current;
        const paths = Object.keys(files);
        if (frame)
          scheduleCommittedPreview(
            frame,
            project,
            paths.map((path) => ({
              path,
              previous: bases?.get(path) ?? previous,
              current: confirmedSource(project, path),
            })),
            options.refresh,
          );
      },
    },
  );
  return { changedPaths, savedVersions };
}
