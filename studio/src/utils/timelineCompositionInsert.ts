import { confirmedSource, supportsProjectTextEdits, supportsOrderedTextEdits } from "./confirmedTextSources";
import { saveOrderedTimeline } from "./orderedTimelineEdits";
import { createStudioSaveHttpError, StudioSaveHttpError } from "./studioSaveDiagnostics";
import { serializeStudioFileMutation } from "./studioFileMutationCoordinator";
import { cloudHistoryForWrite, type RecordEditInput, type StudioWriteHistory } from "./studioFileHistory";
import { buildProjectApiPath } from "./projectRouting";
import { studioWriteHeaders } from "./studioFileVersion";
import { deriveTimelineStoreKeyForDomId } from "../player/lib/timelineElementHelpers";
import { projectPendingStructure } from "../player/lib/peerTimeline";
import { scheduleCommittedTimelinePreview } from "../player/committedTimelinePreview";
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

interface CompositionDrop {
  projectId: string;
  targetPath: string;
  sourcePath: string;
  start: number;
  track: number;
  canvasPosition?: { left: number; top: number };
}
interface InsertionOptions extends CompositionDrop {
  writeFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  observeVersion?: (path: string, version: string | null) => void;
  selectHost: (key: string) => void;
  resync?: () => void;
  refresh: () => void;
  isActive?: () => boolean;
  frame?: HTMLIFrameElement | null;
  onProjected?: (element: TimelineElement) => void;
}

const label = "Add composition to timeline";

function timelineHost(input: CompositionDrop, {hostId, track, duration}: Pick<TimelineCompositionInsertionResult, "hostId" | "track" | "duration">) {
  return {
    id: hostId, key: deriveTimelineStoreKeyForDomId(hostId, input.targetPath), domId: hostId, sourceFile: input.targetPath,
    tag: "div", start: Math.max(0, Math.round(input.start * 100) / 100), duration,
    track, authoredTrack: track, compositionSrc: input.sourcePath,
  } satisfies TimelineElement;
}

async function insertOrdered(input: InsertionOptions) {
  const { projectId, targetPath, sourcePath, frame } = input;
  let host: ReturnType<typeof timelineHost> | undefined;
  await saveOrderedTimeline(projectId, [{
    path: targetPath,
    apply: async (parentSource, sources) => {
      const { insertCompositionInMemory } = await import('../../../packages/edit-core/insert-composition');
      const result = insertCompositionInMemory({ ...input, desiredTrack: input.track, parentSource, childSource: sources.get(sourcePath)! });
      if (!result.ok) throw new StudioSaveHttpError(result.error, result.status);
      host = timelineHost(input, result);
      return result.html;
    },
  }], label, {
    readPaths: [sourcePath],
    recordEdit: input.recordEdit,
    projectPending: files => {
      if (!host || input.isActive?.() === false) return;
      const selected = host.key;
      const rollback = projectPendingStructure(projectId, targetPath, frame ?? null, files, [selected]);
      input.selectHost(selected);
      input.onProjected?.(host);
      return rollback;
    },
    onReceipt: versions => {
      const version = versions[targetPath];
      if (version && confirmedSource(projectId, targetPath)?.version === version && input.isActive?.() !== false) {
        input.observeVersion?.(targetPath, version);
      }
    },
    onSaved: async (files, previous, bases) => {
      if (input.isActive?.() === false) return;
      if (frame?.isConnected) scheduleCommittedTimelinePreview(frame, projectId, targetPath, files, previous, input.refresh, bases);
      else input.refresh();
    },
  });
  return host;
}

async function insertTimelineComposition(input: CompositionDrop, history?: StudioWriteHistory): Promise<TimelineCompositionInsertionResult> {
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
  return response.json() as Promise<TimelineCompositionInsertionResult>;
}

export async function commitTimelineCompositionInsertion(input: InsertionOptions): Promise<TimelineElement | undefined> {
  if (input.isActive?.() === false) return;
  if (supportsOrderedTextEdits(input.projectId)) return insertOrdered(input);
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
    const element = timelineHost(input, result);
    if (input.isActive?.() === false) return element;
    input.selectHost(element.key);
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
  return serializeStudioFileMutation(input.writeFile, input.targetPath, async () => finish(await insert()));
}
