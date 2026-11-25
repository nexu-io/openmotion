import { finishFileProjections, hasProjectedFile, presentAcceptedFiles, projectedFileSource, stageFileProjection,
  type PresentFiles } from './projectedTextEdits';
import { supportsOrderedTextEdits } from './confirmedTextSources';
import { reconcileFileEdit } from './rebasedFileEdit';
import { isolatedEditVersion } from './isolatedEditVersions';
import { enqueueProjectEdit, type DraftSource, type EditFile } from './orderedProjectEdits';
import { readStudioAssetVersion, readStudioEditSource } from './studioTextEdits';
import { saveProjectFilesWithHistory, cloudHistoryForWrite, type RecordEditInput } from './studioFileHistory';
import { StudioFileConflictError } from './studioSaveDiagnostics';

type Transform = { path: string; shownVersion?: string; apply(source: string, inputs: ReadonlyMap<string, string>): string | Promise<string> };
type Changes = RecordEditInput['files'];
type Options = {
  readPaths?: readonly string[];
  assetPaths?: readonly string[];
  onReceipt?: (versions: Readonly<Record<string, string>>) => void;
  projectPending?: (files: Changes) => (() => void) | undefined;
  onSaved?: PresentFiles;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  undoGroup?: string;
  coalesceKey?: string;
  coalesceMs?: number;
};

export { projectedFileText as projectedTimelineText } from './projectedTextEdits';

function displayedSource(project: string, path: string) {
  return projectedFileSource(project, path) ?? readStudioEditSource(project, path);
}

function checkBase(project: string, path: string, source: DraftSource, shown: string | null | undefined, attempted: string, observed?: string) {
  if (shown === undefined || source.version === shown || (shown === null ? source.content === observed : source.version === isolatedEditVersion(project, path, shown))) return;
  reconcileFileEdit(project, path, source.version);
  throw new StudioFileConflictError({ filePath: path, currentVersion: source.version, currentContent: source.content,
    attemptedContent: attempted, syncLatest: true });
}

function snapshots(items: readonly EditFile<string | null>[]): Changes {
  return Object.fromEntries(items.filter(f => f.before !== f.after).map(f => [f.path, {before: f.before, after: f.after}]));
}

export async function saveOrderedTimeline(
  project: string, transforms: Transform[], label: string, { readPaths = [], assetPaths = [], onReceipt, projectPending, onSaved, recordEdit, undoGroup, coalesceKey, coalesceMs }: Options,
): Promise<string[]> {
  if (!transforms.length) return [];
  const textPaths = new Set(readPaths);
  const mediaPaths = new Set<string>();
  for (const path of assetPaths) {
    if (hasProjectedFile(project, path)) textPaths.add(path);
    else if (!textPaths.has(path)) mediaPaths.add(path);
  }
  const reads = Promise.all([...textPaths].map(async path => ({ path, ...await displayedSource(project, path) })));
  const inputs = reads.then(files => new Map(files.map(file => [file.path, file.content])));
  const assets = Promise.all([...mediaPaths].map(async path => [path, await readStudioAssetVersion(project, path)] as const));
  void assets.catch(() => {}); // The FIFO reports failure; a slow prior receipt must not delay painting.
  const projections = transforms.map(({ path, apply, shownVersion }) => {
    const captured = displayedSource(project, path);
    const projected = Promise.all([captured, inputs]).then(async ([base, sources]) => {
      checkBase(project, path, base, shownVersion, base.content);
      return {path, before: base.content, after: await apply(base.content, sources), version: base.version};
    });
    return stageFileProjection(project, path, captured, projected, onSaved);
  });
  const view = Promise.all(projections.map(projected => projected.edit));
  const shown = view.then(edits => projectPending?.(snapshots(edits)));
  // Surface preparation failures through the gesture's save promise, even if it is waiting for an earlier packet.
  void shown.catch(() => {});
  let accepted: EditFile<string | null>[] = [];
  try {
    const saved = await enqueueProjectEdit(project, transforms[0]!.path, async drafts => {
      const projected = await view;
      const observed = await reads;
      const guards = await Promise.all(observed.map(async file => {
        const current = drafts.get(file.path) ?? await readStudioEditSource(project, file.path);
        checkBase(project, file.path, current, file.version, file.content, file.content);
        return { path: file.path, before: current.content, after: current.content, version: current.version };
      }));
      const changedInput = guards.some((file, i) => file.before !== observed[i]!.content);
      const sources = new Map(guards.map(file => [file.path, file.before]));
      accepted = await Promise.all(transforms.map(async ({path, apply}, index) => {
        const local = projected[index]!;
        const current = drafts.get(path) ?? await readStudioEditSource(project, path);
        checkBase(project, path, current, local.version, local.after, local.before);
        // A canvas edit earlier in the same packet can have changed unrelated source bytes.
        const after = !changedInput && current.content === local.before ? local.after : await apply(current.content, sources);
        return {path, before: current.content, after, version: current.version};
      }));
      const targets = new Set(accepted.map(edit => edit.path));
      return {edits: [...accepted, ...guards.filter(file => !targets.has(file.path))], dependencies: Object.fromEntries(await assets), label, undoGroup};
    });
    onReceipt?.(saved.versions);
    const files = snapshots(accepted);
    if (saved.changedPaths.length) await recordEdit({ label, files, coalesceKey, coalesceMs });
    await presentAcceptedFiles(project, projections, accepted, saved.versions);
    return saved.changedPaths;
  } catch (error) {
    for (const projection of projections) projection.session.failed = true;
    (await shown.catch(() => undefined))?.();
    throw error;
  } finally {
    finishFileProjections(project, projections);
  }
}

/** File-local clipboard and audio group transforms run through the same timeline session. */
export function saveTimelineFiles(
  input: Parameters<typeof saveProjectFilesWithHistory>[0], localInputs: boolean | readonly {path: string; type: 'text' | 'asset'}[],
) {
  if (!localInputs || !supportsOrderedTextEdits(input.projectId)) return saveProjectFilesWithHistory(input);
  const history = cloudHistoryForWrite(input.writeFile, input);
  const dependencies = typeof localInputs === 'boolean' ? [] : localInputs;
  return saveOrderedTimeline(input.projectId, Object.entries(input.files).map(([path, apply]) => ({path, apply})),
    input.label, { ...input, undoGroup: history?.continuous ? history.windowId : undefined,
      readPaths: dependencies.filter(file => file.type === 'text').map(file => file.path),
      assetPaths: dependencies.filter(file => file.type === 'asset').map(file => file.path) });
}
