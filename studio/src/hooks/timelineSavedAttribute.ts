import { getCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { timelineAttributeCommand } from "../utils/cloudTimelineEdit";
import { supportsOrderedTextEdits } from "../utils/confirmedTextSources";
import { saveOrderedTimeline } from "../utils/orderedTimelineEdits";
import { applyPatchByTarget, readAttributeByTarget, readTagSnippetByTarget, type PatchOperation } from "../utils/sourcePatcher";
import { writeProjectFilesWithHistoryInQueue, type RecordEditInput } from "../utils/studioFileHistory";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import { readFileContent } from "./timelineTimingSync";
import type { buildPatchTarget } from "../utils/timelineElementSplit";

type PatchTarget = NonNullable<ReturnType<typeof buildPatchTarget>>;

export interface PersistElementAttributeInput {
  projectId: string;
  targetPath: string;
  patchTarget: PatchTarget;
  attr: string;
  value: string | null;
  label: string;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  pendingTimelineEditPathRef: { current: Set<string> };
  /** Write the attribute directly on the live preview DOM node. */
  patchLive: (value: string | null) => void;
  /** What the file held for the attribute, read inside the queue before this write. */
  onFileRead: (value: string | null) => void;
}

/**
 * One attribute, persisted to source and optimistically patched onto the
 * live preview, with a revert on save failure. The shared core behind
 * `setAudioGroupAttribute` (a group id addressed by its own DOM id) and
 * `useSetElementAttribute` (an arbitrary timeline clip) — same shape, only
 * how the live node is found and where the patch target resolves to differs,
 * which is exactly what `patchLive`/`patchTarget` parameterize.
 */
export async function persistElementAttribute({
  projectId,
  targetPath,
  patchTarget,
  attr,
  value,
  label,
  writeProjectFile,
  recordEdit,
  pendingTimelineEditPathRef,
  patchLive,
  onFileRead,
}: PersistElementAttributeInput): Promise<string[]> {
  const command = getCachedCloudDisklessMode() ? timelineAttributeCommand([{ target: patchTarget, value }], attr) : undefined;
  const operation: PatchOperation = { type: "attribute", property: attr, value };
  let previousValue: string | null = null;
  const apply = async (before: string) => {
    if (readTagSnippetByTarget(before, patchTarget) === undefined) {
      throw new Error(`Unable to patch element in ${targetPath}`);
    }
    previousValue = readAttributeByTarget(before, patchTarget, attr) ?? null;
    return command
      ? (await import("../../../packages/edit-core/canvas-commands")).applyCanvasCommand(before, command)
      : applyPatchByTarget(before, patchTarget, operation);
  };
  const preview = () => {
    onFileRead(previousValue);
    patchLive(value);
    pendingTimelineEditPathRef.current.add(targetPath);
    const original = previousValue;
    return () => patchLive(original);
  };
  if (command && supportsOrderedTextEdits(projectId)) {
    return saveOrderedTimeline(projectId, [{ path: targetPath, apply }], label, {
      projectPending: preview, recordEdit,
    });
  }
  return serializeStudioFileMutations(writeProjectFile, [targetPath], async () => {
    const before = await readFileContent(projectId, targetPath);
    const patched = await apply(before);
    const rollback = preview();
    try {
      return await writeProjectFilesWithHistoryInQueue({
        projectId,
        label,
        commandForWrite: command ? () => command : undefined,
        files: { [targetPath]: () => patched },
        readFile: async () => before,
        writeFile: writeProjectFile,
        recordEdit,
      });
    } catch (error) {
      // The optimistic live write already ran; unwind it on a save failure so
      // the preview doesn't show a value that never reached disk.
      rollback();
      throw error;
    }
  });
}
