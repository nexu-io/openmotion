import { restoreConfirmedTimeline } from "../player/lib/peerTimeline";
import { confirmedSource, type ConfirmedSource } from "./confirmedTextSources";
import type { DraftSource, EditFile } from "./orderedProjectEdits";
import { reconcileFileEdit } from "./rebasedFileEdit";
import type { RecordEditInput } from "./studioFileHistory";

export type PresentFiles = (
  files: RecordEditInput["files"],
  previous?: ConfirmedSource,
  bases?: ReadonlyMap<string, ConfirmedSource>,
) => Promise<void>;

interface FileProjection {
  path: string;
  key: string;
  edit: Promise<EditFile<string | null>>;
  before: Promise<DraftSource>;
  session: { baseline: Promise<DraftSource>; failed: boolean };
  present?: PresentFiles;
}

const latest = new Map<string, FileProjection>();
const keyFor = (project: string, path: string) => JSON.stringify([project, path]);

export function hasProjectedFile(project: string, path: string) {
  return latest.has(keyFor(project, path));
}

/** The working copy shared by canvas, inspector, animation and timeline edits. */
export function projectedFileSource(project: string, path: string): Promise<DraftSource> | undefined {
  const projection = latest.get(keyFor(project, path));
  // A rejected local gesture contributes no bytes to its successor.
  return projection?.edit.then(
    (edit) => ({ content: edit.after, version: edit.version }),
    () => projection.before,
  );
}

export function projectedFileText(project: string, path: string) {
  return projectedFileSource(project, path)?.then((file) => file.content);
}

/** Reserve this file synchronously, before source compilation or network activity. */
export function stageFileProjection(
  project: string,
  path: string,
  before: Promise<DraftSource>,
  edit: Promise<EditFile<string | null>>,
  present?: PresentFiles,
): FileProjection {
  const key = keyFor(project, path);
  const previous = latest.get(key);
  const projection = {
    key,
    path,
    before,
    edit,
    session: previous?.session ?? { baseline: before, failed: false },
    present: present ?? previous?.present,
  };
  latest.set(key, projection);
  return projection;
}

/** The final owner for each file presents its confirmed bytes, including any preceding edits in this session. */
export async function presentAcceptedFiles(
  project: string,
  projections: FileProjection[],
  accepted: readonly EditFile<string | null>[],
  versions: Readonly<Record<string, string>>,
) {
  const updates = new Map<
    PresentFiles,
    {
      files: Record<string, { before: string; after: string; version: string }>;
      bases: Map<string, ConfirmedSource>;
    }
  >();
  const finalSources = new Map(accepted.map((file) => [file.path, file]));
  const baselines = await Promise.all(projections.map((projection) => projection.session.baseline));
  for (const [index, projection] of projections.entries()) {
    const { path, present, key } = projection;
    if (!present || latest.get(key) !== projection) continue;
    const base = baselines[index]!;
    const version = versions[path];
    const file = finalSources.get(path);
    const known = confirmedSource(project, path);
    if (!file || !version || version === base.version || (known && known.version !== version)) continue;
    const batch = updates.get(present) ?? { files: {}, bases: new Map<string, ConfirmedSource>() };
    batch.files[path] = { before: base.content, after: file.after, version };
    if (base.version !== null) batch.bases.set(path, {content: base.content, version: base.version});
    updates.set(present, batch);
  }
  for (const [present, { files, bases }] of updates) {
    if (bases.size === 1) await present(files, bases.values().next().value);
    else await present(files, undefined, bases);
  }
}

export function finishFileProjections(project: string, projections: FileProjection[]) {
  for (const projection of projections) {
    if (latest.get(projection.key) !== projection) continue;
    latest.delete(projection.key);
    if (projection.session.failed) {
      const confirmed = confirmedSource(project, projection.path);
      if (confirmed) restoreConfirmedTimeline(project, projection.path, confirmed.content);
      reconcileFileEdit(project, projection.path, confirmed?.version);
    }
  }
}
