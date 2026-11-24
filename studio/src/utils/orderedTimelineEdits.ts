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
type DisplayedFile = { edit: Promise<EditFile>; baseline: Promise<ConfirmedSource> };
const displayed = new Map<string, DisplayedFile>();
const key = (project: string, path: string) => JSON.stringify([project, path]);

export function projectedTimelineText(project: string, path: string) {
  return displayed.get(key(project, path))?.edit.then(edit => edit.after);
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
    const captured = previous
      ? previous.edit.then(prior => ({ content: prior.after, version: prior.version }))
      : readBase(project, path);
    const projected = captured.then(async ({content, version}) => ({path, before: content, after: await apply(content), version}));
    const next = { edit: projected, baseline: previous?.baseline ?? captured };
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
    if (!saved.changedPaths.length) return [];
    const files = snapshots(accepted);
    await recordEdit({ label, files, coalesceKey, coalesceMs });
    // Later gestures own the currently displayed rows. Only the final matching receipt may refresh the canvas.
    const current = accepted.every((edit, i) => displayed.get(key(project, edit.path)) === projections[i] &&
      confirmedSource(project, edit.path)?.version === saved.versions[edit.path]);
    if (current && onSaved) {
      // The mounted preview can still be at the start of this burst. Paint its entire accepted delta once.
      const previous = accepted.length === 1 ? await projections[0]!.baseline : undefined;
      const first = accepted[0]!;
      await onSaved(previous ? { [first.path]: { before: previous.content, after: first.after } } : files, previous);
    }
    return saved.changedPaths;
  } catch (error) {
    (await shown.catch(() => undefined))?.();
    throw error;
  } finally {
    transforms.forEach(({path}, i) => {
      const id = key(project, path);
      if (displayed.get(id) === projections[i]) displayed.delete(id);
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
