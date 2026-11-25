import { confirmedSource, rememberSource, supportsProjectTextEdits, supportsOrderedTextEdits } from "./confirmedTextSources";
import { acknowledgeFileEdit } from "./isolatedEditVersions";
import { runOrderedProjectBarrier } from "./orderedProjectEdits";
import { createStudioSaveHttpError, StudioSaveHttpError } from "./studioSaveDiagnostics";
import { serializeStudioFileMutation } from "./studioFileMutationCoordinator";
import { cloudHistoryForWrite, type RecordEditInput, type StudioWriteHistory } from "./studioFileHistory";
import { buildProjectApiPath } from "./projectRouting";
import { studioWriteHeaders } from "./studioFileVersion";
import { deriveTimelineStoreKeyForDomId } from "../player/lib/timelineElementHelpers";
import { studioApiFetch } from "./studioApiFetch";
import type { TimelineElement } from "../player";

interface TimelineCompositionInsertionResult {
  path: string;
  hostId: string;
  track: number;
  duration: number;
  before: string;
  after: string;
  version: string;
}

async function insertTimelineComposition(input: {
  projectId: string;
  targetPath: string;
  sourcePath: string;
  start: number;
  track: number;
  canvasPosition?: { left: number; top: number };
}, history?: StudioWriteHistory): Promise<TimelineCompositionInsertionResult> {
  const parent = confirmedSource(input.projectId, input.targetPath);
  const child = confirmedSource(input.projectId, input.sourcePath);
  if (parent && child && supportsProjectTextEdits(input.projectId)) {
    const { insertCompositionInMemory } = await import('../../../packages/edit-core/insert-composition');
    const result = insertCompositionInMemory({ ...input, desiredTrack: input.track, parentSource: parent.content, childSource: child.content });
    if (!result.ok) throw new StudioSaveHttpError(result.error, result.status);
    const { commitTextEdits } = await import('./studioTextEdits');
    const path = input.targetPath;
    const edit = { path, version: parent.version, before: parent.content, after: result.html };
    const saved = await commitTextEdits(input.projectId, [edit], { history, label: 'Add composition to timeline',
      dependencies: { [input.sourcePath]: child.version } });
    return { path, before: parent.content, after: edit.after, version: saved.versions[path]!, hostId: result.hostId,
      track: result.track, duration: result.duration };
  }
  const current = await studioApiFetch(
    buildProjectApiPath(input.projectId, `/files/${encodeURIComponent(input.targetPath)}`),
  );
  if (!current.ok) {
    throw await createStudioSaveHttpError(current, `Failed to read ${input.targetPath}`);
  }
  const snapshot = (await current.json()) as { version?: string };
  if (typeof snapshot.version !== "string") throw new Error("Missing composition file version");

  const response = await studioApiFetch(
    buildProjectApiPath(
      input.projectId,
      `/file-mutations/insert-composition/${encodeURIComponent(input.targetPath)}`,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...studioWriteHeaders(history) },
      body: JSON.stringify({
        sourcePath: input.sourcePath,
        start: input.start,
        track: input.track,
        canvasPosition: input.canvasPosition,
        expectedVersion: snapshot.version,
      }),
    },
  );
  if (!response.ok) {
    throw await createStudioSaveHttpError(response, "Failed to add composition to timeline");
  }
  const result = (await response.json()) as TimelineCompositionInsertionResult;
  if (supportsOrderedTextEdits(input.projectId)) {
    const current = confirmedSource(input.projectId, input.targetPath);
    if (!current || current.version === snapshot.version || current.version === result.version) {
      rememberSource(input.projectId, input.targetPath, { version: result.version, content: result.after });
      acknowledgeFileEdit(input.projectId, input.targetPath, snapshot.version, result.version);
    }
  }
  return result;
}

export async function commitTimelineCompositionInsertion(input: {
  projectId: string;
  targetPath: string;
  sourcePath: string;
  start: number;
  track: number;
  canvasPosition?: { left: number; top: number };
  writeFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  observeVersion?: (path: string, version: string | null) => void;
  selectHost: (key: string) => void;
  resync?: () => void;
  refresh: () => void;
  isActive?: () => boolean;
}): Promise<TimelineElement | undefined> {
  const label = "Add composition to timeline";
  const insert = async () => input.isActive?.() === false
    ? undefined : insertTimelineComposition(input, cloudHistoryForWrite(input.writeFile, { label }));
  const finish = async (result?: TimelineCompositionInsertionResult) => {
    if (!result) return;
    input.observeVersion?.(input.targetPath, result.version);
    try {
      await input.recordEdit({
        label,
        files: { [input.targetPath]: { before: result.before, after: result.after } },
      });
    } catch (error) {
      await input.writeFile(input.targetPath, result.before, result.after);
      throw error;
    }
    const key = deriveTimelineStoreKeyForDomId(result.hostId, input.targetPath);
    const element: TimelineElement = {
      id: result.hostId, key, domId: result.hostId, sourceFile: input.targetPath,
      tag: "div", start: Math.round(input.start * 100) / 100, duration: result.duration,
      track: result.track, authoredTrack: result.track, compositionSrc: input.sourcePath,
    };
    if (input.isActive?.() === false) return element;
    input.selectHost(key);
    try {
      input.resync?.();
    } catch (error) {
      console.error("[Studio] Composition insertion committed but preview resync failed", error);
    }
    try {
      input.refresh();
    } catch (error) {
      console.error("[Studio] Composition insertion committed but refresh failed", error);
    }
    return element;
  };
  // Only the read and atomic insertion hold the project queue. A compensating write can enqueue separately.
  if (supportsOrderedTextEdits(input.projectId)) {
    return finish(await runOrderedProjectBarrier(input.projectId, insert));
  }
  return serializeStudioFileMutation(input.writeFile, input.targetPath, async () => finish(await insert()));
}
