import { restoreConfirmedTimeline } from "../player/lib/peerTimeline";
import { confirmedSource, supportsOrderedTextEdits, type ConfirmedSource } from './confirmedTextSources';
import { reconcileFileEdit } from './rebasedFileEdit';
import { isolatedEditVersion } from './isolatedEditVersions';
import { enqueueProjectEdit, type EditFile } from './orderedProjectEdits';
import { readProjectFileContent, saveProjectFilesWithHistory, cloudHistoryForWrite, type RecordEditInput } from './studioFileHistory';
import { StudioFileConflictError } from './studioSaveDiagnostics';

type Transform = { path: string; apply(source: string): string | Promise<string> };
type Changes = RecordEditInput['files'];
type Options = {
  projectPending?: (files: Changes) => (() => void) | undefined;
  onSaved?: (files: Changes, previous?: ConfirmedSource) => Promise<void>;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  undoGroup?: string;
  coalesceKey?: string;
  coalesceMs?: number;
};

// A structural edit needs the rows produced by the preceding gesture even while its receipt is in flight.
// Keep only the newest local computation per file; the transport owns persistence and confirmed sources.
type DisplayedFile = {
  edit: Promise<EditFile>;
  before: Promise<ConfirmedSource>;
  session: { baseline: Promise<ConfirmedSource>; failed: boolean };
  refresh: Options['onSaved'];
};
const displayed = new Map<string, DisplayedFile>();
const key = (project: string, path: string) => JSON.stringify([project, path]);

function visibleSource(file: DisplayedFile): Promise<ConfirmedSource> {
  // A gesture with an invalid target changes no bytes. The next gesture still sees the previous projection.
  return file.edit.then(edit => ({ content: edit.after, version: edit.version }), () => file.before);
}

export function projectedTimelineText(project: string, path: string) {
  const file = displayed.get(key(project, path));
  return file && visibleSource(file).then(source => source.content);
}

async function readBase(project: string, path: string) {
  const warm = confirmedSource(project, path);
  if (warm) return warm;
  await readProjectFileContent(project, path);
  const base = confirmedSource(project, path);
  if (!base) throw new Error('No confirmed source for ' + path);
  return base;
}

function snapshots(items: readonly EditFile[]): Changes {
  return Object.fromEntries(items.filter(f => f.before !== f.after).map(f => [f.path, {before: f.before, after: f.after}]));
}

export async function saveOrderedTimeline(
  project: string, transforms: Transform[], label: string, { projectPending, onSaved, recordEdit, undoGroup, coalesceKey, coalesceMs }: Options,
): Promise<string[]> {
  if (!transforms.length) return [];
  const projections = transforms.map(({ path, apply }) => {
    const id = key(project, path);
    const previous = displayed.get(id);
    const captured = previous ? visibleSource(previous) : readBase(project, path);
    const projected = captured.then(async ({content, version}) => ({path, before: content, after: await apply(content), version}));
    const next = { edit: projected, before: captured, session: previous?.session ?? { baseline: captured, failed: false }, refresh: onSaved ?? previous?.refresh };
    displayed.set(id, next);
    return next;
  });
  const view = Promise.all(projections.map(projected => projected.edit));
  const shown = view.then(edits => projectPending?.(snapshots(edits)));
  // Surface preparation failures through the gesture's save promise, even if it is waiting for an earlier packet.
  void shown.catch(() => {});
  let accepted: EditFile[] = [];
  try {
    const saved = await enqueueProjectEdit(project, transforms[0]!.path, async drafts => {
      const projected = await view;
      accepted = await Promise.all(transforms.map(async ({path, apply}, index) => {
        const local = projected[index]!;
        const current = drafts.get(path) ?? await readBase(project, path);
        const expected = isolatedEditVersion(project, path, local.version);
        if (current.version !== local.version && current.version !== expected) {
          reconcileFileEdit(project, path, current.version);
          throw new StudioFileConflictError({filePath: path, currentVersion: current.version, currentContent: current.content,
            attemptedContent: local.after, syncLatest: true});
        }
        // A canvas edit earlier in the same packet can have changed unrelated source bytes.
        const after = current.content === local.before ? local.after : await apply(current.content);
        return {path, before: current.content, after, version: current.version};
      }));
      return {edits: accepted, label, undoGroup};
    });
    const files = snapshots(accepted);
    if (saved.changedPaths.length) await recordEdit({ label, files, coalesceKey, coalesceMs });
    // Later gestures own the currently displayed rows. Only the final matching receipt may refresh the canvas.
    const current = accepted.every((edit, i) => displayed.get(key(project, edit.path)) === projections[i] &&
      confirmedSource(project, edit.path)?.version === saved.versions[edit.path]);
    if (current && accepted.length === 1) {
      // A final no-op or volume edit may still have an earlier structural edit to paint.
      const first = accepted[0]!;
      const projection = projections[0]!;
      const previous = await projection.session.baseline;
      if (previous.version !== saved.versions[first.path]) {
        await projection.refresh?.({ [first.path]: { before: previous.content, after: first.after } }, previous);
      }
    } else if (current && saved.changedPaths.length) {
      await onSaved?.(files);
    }
    return saved.changedPaths;
  } catch (error) {
    for (const projection of projections) projection.session.failed = true;
    (await shown.catch(() => undefined))?.();
    throw error;
  } finally {
    transforms.forEach(({path}, i) => {
      const id = key(project, path);
      const projection = projections[i]!;
      if (displayed.get(id) !== projection) return;
      displayed.delete(id);
      if (projection.session.failed) {
        const confirmed = confirmedSource(project, path);
        if (confirmed) restoreConfirmedTimeline(project, path, confirmed.content);
        // The player can still have uncommitted paint even when the timeline rows are restored.
        reconcileFileEdit(project, path, confirmed?.version);
      }
    });
  }
}

/** File-local clipboard and audio group transforms run through the same timeline session. */
export function saveTimelineFiles(
  input: Parameters<typeof saveProjectFilesWithHistory>[0], localInputs: boolean,
) {
  if (!localInputs || !supportsOrderedTextEdits(input.projectId)) return saveProjectFilesWithHistory(input);
  const history = cloudHistoryForWrite(input.writeFile, input);
  return saveOrderedTimeline(input.projectId, Object.entries(input.files).map(([path, apply]) => ({path, apply})),
    input.label, { ...input, undoGroup: history?.continuous ? history.windowId : undefined });
}
