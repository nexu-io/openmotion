import { useCallback, type RefObject } from "react";
import { buildDomEditPatchTarget, type DomEditSelection } from "../components/editor/domEditing";
import { isIsolatedSourceFile, isolatedSourceVersion } from "../components/editor/isolatedSourceTarget";
import { stageElementOffset, type ElementOffsetStagerDeps } from "./elementOffsetStager";
import type { CanvasCommand } from "../../../packages/edit-core/canvas-schema";
import { commitStudioEditBatch, submitStudioCommands } from "../utils/projectEditBatch";
import { supportsOrderedTextEdits } from "../utils/confirmedTextSources";
import { readProjectFileContent } from "../utils/studioFileHistory";
import {
  serializeStudioFileMutations,
  type StudioProjectFileWriter,
} from "../utils/studioFileMutationCoordinator";

export interface CanvasGroupWrite {
  path: string;
  ifMatch?: string;
  command: CanvasCommand;
}

export function groupMemberVersion(selection: DomEditSelection) {
  const target = selection.isolatedTarget;
  return target && isIsolatedSourceFile(target) ? isolatedSourceVersion(target) : undefined;
}

/** All members move in one project edit, including selections spanning several files. */
export function commitCloudGroupMove(
  projectId: string,
  writer: StudioProjectFileWriter,
  edits: CanvasGroupWrite[],
) {
  if (supportsOrderedTextEdits(projectId)) {
    const versions: Record<string, string> = Object.create(null);
    for (const {path, ifMatch} of edits) {
      if (!ifMatch) continue;
      if (versions[path] && versions[path] !== ifMatch) throw new Error('Selected elements have different source versions');
      versions[path] = ifMatch;
    }
    const commands = edits.map(({path, command}) => ({...command, compositionPath: path}));
    return submitStudioCommands(projectId, commands, versions).then(result => result.changedPaths.length > 0);
  }
  const paths = [...new Set(edits.map((edit) => edit.path))];
  return serializeStudioFileMutations(writer, paths, async () => {
    const sources = new Map(
      await Promise.all(
        paths.map(async (path) => [path, await readProjectFileContent(projectId, path)] as const),
      ),
    );
    const { applyCanvasCommand } = await import("../../../packages/edit-core/canvas-commands");
    const prepared = edits.map((edit) => {
      const before = sources.get(edit.path)!;
      const after = applyCanvasCommand(before, edit.command);
      sources.set(edit.path, after);
      return { ...edit, before, after };
    });
    if (prepared.every((edit) => edit.before === edit.after)) return false;
    await commitStudioEditBatch(projectId, prepared);
    return true;
  });
}

export function stageCloudGroupOffset(
  selection: DomEditSelection,
  next: { x: number; y: number },
  plain: boolean,
  path: string,
  time: number,
  key: string,
  showToast: ElementOffsetStagerDeps["showToast"],
  batch: CanvasGroupWrite[],
) {
  const target = buildDomEditPatchTarget(selection);
  return stageElementOffset(
    {
      showToast,
      commitPositionPatchToHtml: async (_, operations) => {
        batch.push({
          path,
          ifMatch: groupMemberVersion(selection),
          command: plain
            ? { kind: "moveCanvasElement", target, ...next, time }
            : { kind: "editElements", patches: [{ target, operations }] },
        });
        return undefined;
      },
    },
    selection,
    next,
    plain,
    key,
  );
}

export function useCloudGroupMove(
  project: RefObject<string | null>,
  writer: StudioProjectFileWriter,
  refreshAnimations: () => void,
  reloadPreview: () => void,
) {
  return useCallback(
    async (edits: CanvasGroupWrite[]) => {
      const pid = project.current;
      if (!pid) throw new Error("No project is open");
      const changed = await commitCloudGroupMove(pid, writer, edits);
      if (changed && pid === project.current && edits.some((edit) => edit.command.kind === "editAnimation")) {
        refreshAnimations();
        reloadPreview();
      }
      return changed;
    },
    [project, writer, refreshAnimations, reloadPreview],
  );
}
