import { observedSourceVersion, supportsOrderedTextEdits } from "./confirmedTextSources";
import { tryStudioCommandPatches } from "./studioTextEdits";
import type { CompositionEdit, ProjectEditCommand } from "../../../packages/edit-core/commands";
import type { StudioWriteHistory } from "./studioFileHistory";
import { acceptFileEditReceipt } from "./rebasedFileEdit";
import { studioApiFetch } from "./studioApiFetch";
import { createStudioWriteToken, studioWriteHeaders } from "./studioFileVersion";
import { createStudioSaveHttpError, retryStudioSave, StudioFileConflictError, StudioSaveNetworkError } from "./studioSaveDiagnostics";
import { trackStudioProjectSave } from "./studioSaveState";

type BatchItem = { path: string; before: string; after: string; command: ProjectEditCommand };

/** The caller holds the file queues. Persist the complete gesture as one version. */
export async function commitStudioEditBatch(projectId: string, edits: readonly BatchItem[], history?: StudioWriteHistory) {
  if (!edits.length) return [];
  const original = new Map<string, string>();
  for (const { path, before } of edits) {
    if (!original.has(path)) original.set(path, before);
  }
  const versions = Object.fromEntries(await Promise.all(Array.from(original, async ([path, source]) =>
    [path, await observedSourceVersion(projectId, path, source)] as const)));
  const commands = edits.map(({ path, command }) => ({ ...command, compositionPath: path }));
  const predicted = new Map(edits.map(edit => [edit.path, edit.after]));
  const result = await submitStudioCommands(projectId, commands, versions, history, path => predicted.get(path));
  return result.divergent;
}

/** Submit the displayed base once per gesture. Retries reuse its request ID. */
export async function submitStudioCommands(projectId: string, commands: CompositionEdit[],
  versions: Record<string, string>, history?: StudioWriteHistory, attempted?: (path: string) => string | undefined) {
  if (!commands.length) throw new Error("No editing commands supplied.");
  const patched = await tryStudioCommandPatches(projectId, commands, versions, history, attempted);
  if (patched) return patched;
  if (supportsOrderedTextEdits(projectId)) throw new Error("Could not prepare the project edit in Studio.");
  return submitSemanticCommands(projectId, commands, versions, history, attempted);
}

async function submitSemanticCommands(projectId: string, commands: CompositionEdit[], versions: Record<string,string>,
  history?: StudioWriteHistory, attempted?: (path: string) => string | undefined) {
  const path = commands[0]!.compositionPath;
  const requestId = createStudioWriteToken();
  const body = JSON.stringify({
    versions, edit: { kind: "batch", commands },
    ...(history?.continuous && { undoGroup: history.windowId }),
  });
  const headers = { "Content-Type": "application/json", "Idempotency-Key": requestId, ...studioWriteHeaders(history) };
  return trackStudioProjectSave(projectId, path, () => retryStudioSave(async () => {
    let response: Response;
    try {
      response = await studioApiFetch(`/api/projects/${encodeURIComponent(projectId)}/edits`, {
        method: "POST",
        headers,
        body,
      });
    } catch (cause) {
      throw new StudioSaveNetworkError("Failed to save the project edit", { cause });
    }
    if (response.status === 409 && attempted) {
      const details = await response.json();
      throw new StudioFileConflictError({ filePath: details.path ?? path,
        currentVersion: details.currentVersion ?? null, currentContent: details.currentContent ?? null,
        attemptedContent: attempted(details.path ?? path) ?? "" });
    }
    if (!response.ok) throw await createStudioSaveHttpError(response, "Failed to save the project edit");
    const result = await response.json() as { versions: Record<string, string>; changedPaths?: string[]; rebased?: boolean };
    // Older pods enforce the displayed base, so their returned file versions identify changes.
    const changedPaths = result.changedPaths ?? Object.keys(versions).filter(path => versions[path] !== result.versions[path]);
    const divergent = [];
    for (const [path, before] of Object.entries(versions)) {
      const version = result.versions[path];
      if (!version) continue;
      const file = await acceptFileEditReceipt(projectId, path, before, attempted?.(path), version, result);
      if (file) divergent.push(file);
    }
    return { changedPaths, versions: result.versions, divergent };
  }));
}
