import type { RefObject } from "react";
import type { CompositionEdit } from "../../../packages/edit-core/commands";
import { contentDependencies, isContentCommand } from "../../../packages/edit-core/content-schema";
import { scheduleCommittedPreview } from "../player/committedPreview";
import { projectLocalTimelineEdit } from "../player/lib/peerTimeline";
import { syncRestoredTimelineFromPreview } from "../player/lib/timelineRestoreSync";
import { usePlayerStore } from "../player/store/playerStore";
import { confirmedSource } from "../utils/confirmedTextSources";
import { applyUndoRestoreToPreview } from "../utils/gsapUndoRestore";
import { saveOrderedTimeline } from "../utils/orderedTimelineEdits";
import type { RecordEditInput, StudioWriteHistory } from "../utils/studioFileHistory";
import type { PersistDomEditOperations } from "./domEditCommitTypes";

type Options = NonNullable<Parameters<PersistDomEditOperations>[2]>;

/** Validation, the property change and any linked changes share one observed source and one undo step. */
export async function savePreparedDomEdit(
  project: string,
  command: CompositionEdit,
  shownVersion: string | undefined,
  options: Options,
  history: StudioWriteHistory,
  recordEdit: (entry: RecordEditInput) => Promise<void>,
  view: {
    frame: RefObject<HTMLIFrameElement | null>;
    projectId: RefObject<string | null>;
    activePath: string | null;
    refresh: (paths: readonly string[]) => void;
  },
) {
  const path = command.compositionPath;
  const inputs = isContentCommand(command) ? contentDependencies(command) : [];
  let version: string | undefined;
  let applied: { frame: HTMLIFrameElement; content: string } | undefined;
  const changed = await saveOrderedTimeline(
    project,
    [
      {
        path,
        shownVersion,
        async apply(source, files) {
          options.validateContent?.(source);
          const { applyProjectEdit } = await import("../../../packages/edit-core/commands");
          const { content } = await applyProjectEdit(source, command, files);
          // An explicit command (e.g. setClipSpeed) already implements the linked updates.
          return options.projectEdit ? content : (options.prepareContent?.(content, path) ?? content);
        },
      },
    ],
    history.label,
    {
      ...options,
      undoGroup: history.continuous ? history.windowId : undefined,
      recordEdit,
      readPaths: inputs.filter((input) => input.type === "text").map((input) => input.path),
      assetPaths: inputs.filter((input) => input.type === "asset").map((input) => input.path),
      onReceipt: (versions) => {
        version = versions[path];
      },
      projectPending(files) {
        const file = files[path];
        if (!file || !options.syncTimingInPlace || view.projectId.current !== project) return;
        const frame = view.frame.current;
        const undoRows = projectLocalTimelineEdit(project, path, file, frame);
        if (frame?.contentDocument) {
          const strategy = applyUndoRestoreToPreview(
            frame,
            view.activePath,
            { [path]: { previous: file.before, restored: file.after } },
            usePlayerStore.getState().currentTime,
            () => {},
          );
          if (strategy === "soft") {
            syncRestoredTimelineFromPreview(frame.contentDocument);
            applied = { frame, content: file.after };
          }
        }
        return undoRows;
      },
      onSaved: async (_files, previous) => {
        if (view.projectId.current !== project) return;
        const frame = view.frame.current;
        if (applied && applied.frame === frame && applied.content === confirmedSource(project, path)?.content)
          return;
        if (frame)
          scheduleCommittedPreview(
            frame,
            project,
            [{ path, previous, current: confirmedSource(project, path) }],
            view.refresh,
          );
        else if (!options.skipRefresh) view.refresh([path]);
      },
    },
  );
  return version ? { sourceFile: path, version, changed: changed.length > 0 } : undefined;
}
