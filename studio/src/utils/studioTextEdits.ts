import { readCurrentProjectSource } from "./readCurrentProjectSource";
import { finishFileProjections, hasProjectedFile, presentAcceptedFiles, projectedFileSource, stageFileProjection } from './projectedTextEdits';
import { hasRelativeLutSource } from '../../../packages/edit-core/color-grading';
import type { CompositionEdit } from '../../../packages/edit-core/commands';
import { enqueueProjectEdit, runOrderedProjectBarrier, type DraftSource, type EditFile } from './orderedProjectEdits';
import { getCachedCloudDisklessMode } from './cloudRuntime';
import { contentDependencies, isContentCommand } from '../../../packages/edit-core/content-schema';
import { confirmedSource, observedEditAsset, forgetSource, observePendingSourceRead, pendingSourceRead, rememberSource, supportsOrderedTextEdits, supportsProjectTextEdits, type ConfirmedSource } from './confirmedTextSources';
import { acknowledgeFileEdit, isolatedEditVersion } from './isolatedEditVersions';
import { reconcileFileEdit } from './rebasedFileEdit';
import type { StudioWriteHistory } from './studioFileHistory';
import { createStudioWriteToken, studioWriteHeaders } from './studioFileVersion';
import { createStudioSaveHttpError, RejectedCanvasGesture, retryStudioSave, StudioFileConflictError, StudioSaveNetworkError } from './studioSaveDiagnostics';
import { studioApiFetch } from './studioApiFetch';
import { trackStudioProjectSave } from './studioSaveState';

export type TextEditSource = { path: string; before: string; after: string };
type Prepared = EditFile<string | null>;
type CommandInput = 'text' | 'asset' | 'edited-asset';

function commandInputs(project: string, commands: readonly CompositionEdit[]) {
  const required = new Map<string, CommandInput>();
  for (const command of commands) {
    if (command.kind === 'setBeatGrid') return; // Uses its observed optional sidecar.
    if (!isContentCommand(command)) continue;
    for (const input of contentDependencies(command)) {
      if (required.get(input.path) === 'text') continue;
      // A reference to a file being authored locally can be resolved before the file exists in storage.
      const editingAsset = input.type === 'asset' && hasProjectedFile(project, input.path);
      required.set(input.path, editingAsset ? 'edited-asset' : input.type);
    }
  }
  return required;
}

async function localDependencies(project: string, required: ReadonlyMap<string, CommandInput>, drafts?: ReadonlyMap<string, DraftSource>) {
  const texts = new Map<string, DraftSource>();
  const assets: Record<string, string> = Object.create(null);
  const hosted = getCachedCloudDisklessMode();
  const loaded = await Promise.all([...required].map(async ([path, kind]) => {
    if (kind === 'asset') {
      const version = observedEditAsset(project, path)?.version ?? (hosted ? await readStudioAssetVersion(project, path) : undefined);
      if (version) assets[path] = version;
      return Boolean(version);
    }
    const source = drafts?.get(path) ?? confirmedSource(project, path) ?? (hosted ? await readStudioEditSource(project, path) : undefined);
    if (source) texts.set(path, source);
    return Boolean(source);
  }));
  if (loaded.includes(false)) return;
  return { texts, assets };
}

const pendingAssetVersions = new Map<string, Promise<string>>();

export function readStudioAssetVersion(project: string, path: string): Promise<string> {
  const cached = observedEditAsset(project, path)?.version;
  if (cached) return Promise.resolve(cached);
  const key = JSON.stringify([project, path]);
  const pending = pendingAssetVersions.get(key);
  if (pending) return pending;
  const read = fetchAssetVersion(project, path).finally(() => pendingAssetVersions.delete(key));
  pendingAssetVersions.set(key, read);
  return read;
}

async function fetchAssetVersion(project: string, path: string) {
  const response = await studioApiFetch('/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(path) + '?view=metadata');
  if (!response.ok) throw await createStudioSaveHttpError(response, 'Could not read ' + path);
  const data = await response.json();
  if (typeof data.version !== 'string') throw new Error('Missing file version for ' + path);
  return data.version as string;
}

export async function readStudioEditSource(project: string, path: string) {
  const source = await resolveEditSource(project, path, () => true, '', true);
  if (!source) throw new Error('Missing file version for ' + path);
  return source;
}

/** Resolve the exact bytes used to prepare an edit. A changed base is never substituted. */
export async function resolveEditSource(project: string, path: string, matches: (source: ConfirmedSource) => boolean,
  attemptedContent: string, advertised = supportsProjectTextEdits(project)) {
  let source = confirmedSource(project, path);
  if (source && matches(source)) return source;
  if (!advertised) return;
  const pending = pendingSourceRead(project, path);
  if (pending) {
    await pending.catch(() => undefined);
    source = confirmedSource(project, path);
    if (source && matches(source)) return source;
  }
  source = await observePendingSourceRead(project, path, fetchEditSource(project, path, attemptedContent));
  if (source && !matches(source)) {
    reconcileFileEdit(project, path, source.version);
    throw staleSource(path, source, attemptedContent);
  }
  return source;
}

async function fetchEditSource(project: string, path: string, attemptedContent: string) {
  const { response, data } = await readCurrentProjectSource(project, path);
  if (response.status === 404) {
    forgetSource(project, path);
    reconcileFileEdit(project, path);
    throw new StudioFileConflictError({ syncLatest: true, filePath: path, currentVersion: null, currentContent: null, attemptedContent });
  }
  if (!response.ok) throw await createStudioSaveHttpError(response, 'Could not read ' + path);
  if (!data) throw new Error("Invalid source response");
  const version = data.version ?? response.headers.get('etag');
  return confirmedSource(project, path) ?? (typeof data.content === 'string' && typeof version === 'string'
    ? { content: data.content as string, version } : undefined);
}

export async function tryStudioTextEdit(project: string, sources: readonly TextEditSource[], history?: StudioWriteHistory) {
  const prepare = async (drafts?: ReadonlyMap<string, DraftSource>) => {
    const edits: Prepared[] = [];
    for (const source of sources) {
      const draft = drafts?.get(source.path);
      if (draft && draft.content !== source.before) throw staleSource(source.path, draft, source.after);
      const base = draft ?? await resolveEditSource(project, source.path, current => current.content === source.before, source.after,
        supportsOrderedTextEdits(project) || supportsProjectTextEdits(project));
      if (!base?.version) return;
      edits.push({ ...source, version: base.version });
    }
    return { edits, label: history?.label ?? 'Edit file', undoGroup: history?.continuous ? history.windowId : undefined };
  };
  if (sources.length && supportsOrderedTextEdits(project)) {
    const result = await enqueueProjectEdit(project, sources[0].path, async drafts => {
      const plan = await prepare(drafts);
      if (!plan) throw new Error('Missing source for ordered text edit');
      return plan;
    });
    return { ...result, divergent: [] };
  }
  const plan = await prepare();
  if (plan) return commitTextEdits(project, plan.edits, { history });
}

export async function tryStudioCommandPatches(project: string, commands: CompositionEdit[], versions: Record<string, string>,
  history?: StudioWriteHistory, predicted?: (path: string) => string | undefined,
  observedText?: (path: string) => string | undefined) {
  if (!commands.length) return;
  const hosted = getCachedCloudDisklessMode();
  if (!hosted && !supportsProjectTextEdits(project) && !Object.values(versions).some(version => version.startsWith('"patch:'))) return;
  const targets = new Set(commands.map(command => command.compositionPath));
  if (targets.size > 1 && commands.some(command => command.kind === 'gradeMedia' && hasRelativeLutSource(command.value))) {
    throw new Error('Use an absolute LUT source when grading multiple compositions');
  }
  const ordered = supportsOrderedTextEdits(project);
  const required = commandInputs(project, commands);
  if (!required) return;
  const canvasGesture = !predicted && commands.every(c => c.kind === 'moveCanvasElement' || c.kind === 'setCanvasBox');
  const captured = new Map<string, ConfirmedSource>();
  for (const [path, version] of Object.entries(versions)) {
    const source = confirmedSource(project, path);
    const shownVersion = predicted ? version : isolatedEditVersion(project, path, version);
    if (source?.version === shownVersion) captured.set(path, source);
  }
  const prepare = async (drafts?: ReadonlyMap<string, DraftSource>) => {
    const dependencies = await localDependencies(project, required, drafts);
    if (!dependencies) return;
    const files = new Map<string, Prepared>();
    for (const path of targets) {
      const shown = versions[path];
      const expected = shown && isolatedEditVersion(project, path, shown);
      const projected = drafts?.get(path);
      const source = projected ?? await resolveEditSource(project, path,
        current => ordered || current.version === expected, predicted?.(path) ?? '', true);
      if (!source) return;
      const before = observedText?.(path);
      if (expected === undefined && before !== undefined && source.content !== before) {
        throw staleSource(path, source, predicted?.(path) ?? '');
      }
      if (expected && source.version === expected && !captured.has(path)) {
        // A cold read can first be observed while resolving the working copy's base.
        const observed = projected ? confirmedSource(project, path) : source;
        if (observed?.version === expected) captured.set(path, { content: observed.content, version: expected });
      }
      if (expected !== undefined && source.version !== expected) {
        const original = captured.get(path);
        const confirmed = projected ? confirmedSource(project, path) : source;
        const { canReplayCanvasCommands } = await import('./canvasReplay');
        if (!ordered || !original || !confirmed ||
            !await canReplayCanvasCommands(commands.filter(command => command.compositionPath === path), original.content, confirmed.content)) {
          reconcileFileEdit(project, path, source.version);
          throw staleSource(path, source, predicted?.(path) ?? '');
        }
      }
      files.set(path, { path, before: source.content, after: source.content, version: source.version });
    }
    for (const [path, observed] of dependencies.texts) {
      if (files.has(path)) continue;
      const base = observed;
      files.set(path, { path, before: base.content, after: base.content, version: base.version });
    }
    const label = await applyCommands(commands, files).catch(error => {
      // Only the in-memory transformation is covered. Reads, submissions and receipts keep their save errors.
      if (canvasGesture) throw new RejectedCanvasGesture(error);
      throw error;
    });
    return { edits: [...files.values()], dependencies: dependencies.assets, label: history?.label ?? label, undoGroup: history?.continuous ? history.windowId : undefined };
  };
  let edits: Prepared[] = [];
  let saved;
  if (ordered) {
    // Resolve all inputs against the same working copy, before registering our outputs.
    // A following gesture can then preview these bytes even while an older HTTP packet is in flight.
    const inputs = new Set(targets);
    for (const [path, type] of required) {
      if (type !== 'asset' && (hosted || confirmedSource(project, path) || hasProjectedFile(project, path))) inputs.add(path);
    }
    const bases = new Map([...inputs].map(path => [
      path, projectedFileSource(project, path) ?? readStudioEditSource(project, path),
    ]));
    const projection = Promise.all([...bases].map(async ([path, base]) => [path, await base] as const))
      .then(files => prepare(new Map(files)))
      .then(plan => {
        if (!plan) throw new Error('Missing source for ordered project edit');
        return plan;
      });
    const pending = [...targets].map(path => stageFileProjection(project, path, bases.get(path)!,
      projection.then(plan => plan.edits.find(file => file.path === path)!)));
    // The transport reports preparation errors. An earlier packet may still be awaiting its receipt.
    for (const file of pending) void file.edit.catch(() => {});
    try {
      saved = await enqueueProjectEdit(project, commands[0].compositionPath, async drafts => {
        const local = await projection;
        const sameBase = local.edits.every(file => {
          const current = drafts.get(file.path) ?? confirmedSource(project, file.path);
          return current?.version === file.version && current.content === file.before;
        });
        const plan = sameBase ? local : await prepare(drafts);
        if (!plan) throw new Error('Missing source for ordered project edit');
        if (!sameBase) {
          for (const file of plan.edits) {
            if (required.get(file.path) !== 'edited-asset') continue;
            const authored = await bases.get(file.path)!;
            if (file.before !== authored.content) throw staleSource(file.path, {content:file.before, version:file.version}, '');
          }
        }
        edits = plan.edits;
        return plan;
      }, canvasGesture);
      await presentAcceptedFiles(project, pending, edits, saved.versions);
    } catch (error) {
      // A prior timeline/animation projection may have painted into this session.
      for (const file of pending) if (file.present) file.session.failed = true;
      throw error;
    } finally {
      finishFileProjections(project, pending);
    }
  } else {
    const plan = await prepare();
    if (!plan) return;
    edits = plan.edits;
    saved = await commitTextEdits(project, edits, { history, label: plan.label, dependencies: plan.dependencies });
  }
  const divergent = [];
  for (const file of edits) {
    const visible = predicted?.(file.path);
    if (visible !== undefined && file.after !== visible) {
      divergent.push(reconcileFileEdit(project, file.path, saved.versions[file.path], saved.changedPaths.includes(file.path)));
    }
  }
  return { ...saved, divergent, observedSources: captured };
}

function staleSource(path: string, source: DraftSource, attemptedContent: string) {
  return new StudioFileConflictError({ filePath: path, currentVersion: source.version, currentContent: source.content, attemptedContent, syncLatest: true });
}

async function applyCommands(commands: CompositionEdit[], files: Map<string, Prepared>) {
  const { applyProjectEdit } = await import('../../../packages/edit-core/commands');
  const labels = new Set<string>();
  const inputs = new Map(Array.from(files, ([path, file]) => [path, file.after]));
  for (const command of commands) {
    const file = files.get(command.compositionPath)!;
    const edited = await applyProjectEdit(file.after, command, inputs);
    if (edited.content !== file.after) labels.add(edited.label);
    file.after = edited.content;
    inputs.set(file.path, edited.content);
  }
  return labels.size === 1 ? [...labels][0] : 'Edit project';
}

/** A catalog drop creates the missing files and edits their host in one project transaction. */
export async function placeCatalogComponent(project: string, path: string, name: string, label: string,
  insertHost: (content: string) => string) {
  if (supportsOrderedTextEdits(project)) {
    return saveProjectedFile(project, path, () => readStudioEditSource(project, path),
      base => insertHost(base.content), {label, installComponent: name});
  }
  return runOrderedProjectBarrier(project, async () => {
    let source = confirmedSource(project, path);
    if (!source) {
      const { response, data } = await readCurrentProjectSource(project, path);
      if (!response.ok) throw await createStudioSaveHttpError(response, 'Could not read ' + path);
      if (typeof data?.content !== 'string' || typeof data.version !== 'string') throw new Error('Missing composition source or version');
      source = { content: data.content, version: data.version };
    }
    return commitTextEdits(project, [{ path, before: source.content, version: source.version, after: insertHost(source.content) }], { label, installComponent: name });
  });
}

/** A single-file change shares the working copy with timeline and inspector operations. */
async function saveProjectedFile(project: string, path: string, read: () => Promise<DraftSource>,
  transform: (base: DraftSource) => string, metadata: {label: string; undoGroup?: string; installComponent?: string}) {
  const base = projectedFileSource(project, path) ?? read();
  const apply = (source: DraftSource) => ({path, version:source.version, before:source.content, after:transform(source)});
  const local = base.then(apply);
  // The queue reports a preparation error, even when the previous packet is still in flight.
  void local.catch(() => {});
  const projection = stageFileProjection(project, path, base, local);
  let accepted: Prepared | undefined;
  try {
    const result = await enqueueProjectEdit(project, path, async drafts => {
      const edit = await local;
      const current = drafts.get(path) ?? confirmedSource(project, path) ?? await base;
      accepted = current.version === edit.version && current.content === edit.before ? edit : apply(current);
      return { ...metadata, edits: [accepted] };
    });
    if (accepted) await presentAcceptedFiles(project, [projection], [accepted], result.versions);
    return result;
  } catch (error) {
    if (projection.present) projection.session.failed = true;
    throw error;
  } finally {
    finishFileProjections(project, [projection]);
  }
}

export function saveOrderedStudioFile(project: string, path: string, content: string,
  before: string | undefined, version: string | null | undefined, history?: StudioWriteHistory) {
  const read = async (): Promise<DraftSource> => {
    const known = confirmedSource(project, path);
    if (known) return known;
    if (version === null) return {content:'', version:null};
    try { return await readStudioEditSource(project, path); }
    catch (error) {
      if (!(error instanceof StudioFileConflictError) || error.currentVersion !== null || version !== undefined) throw error;
      if (before !== undefined && before !== '') throw error;
      return {content:'', version:null};
    }
  };
  return saveProjectedFile(project, path, read, base => {
    const expectedVersion = version ? isolatedEditVersion(project, path, version) : null;
    if (before !== undefined ? base.content !== before : base.version !== expectedVersion) {
      throw staleSource(path, base, content);
    }
    return content;
  }, {label:history?.label ?? 'Edit file', undoGroup:history?.continuous ? history.windowId : undefined});
}

interface TextEditOptions {
  label?: string;
  history?: StudioWriteHistory;
  installComponent?: string;
  dependencies?: Record<string, string>;
  beatAssets?: string[];
}

export async function commitTextEdits(project: string, edits: (TextEditSource & { version: string | null })[],
  { label = 'Edit file', history, installComponent, dependencies: readVersions, beatAssets }: TextEditOptions = {}) {
  const { createTextPatch } = await import('../../../shared/create-text-patch');
  const { stampHfIdsInPlace } = await import('@hyperframes/parsers/hf-ids');
  const versions: Record<string, string> = Object.fromEntries(edits.flatMap(file => file.version === null ? [] : [[file.path, file.version]]));
  const changed = edits.filter(file => file.after !== file.before);
  const files = changed.map(file => {
    if (/\.html?$/i.test(file.path)) file.after = stampHfIdsInPlace(file.after);
    const patch = file.version === null || (installComponent && !supportsProjectTextEdits(project)) ? null : createTextPatch(file.before, file.after);
    return { path: file.path, baseVersion: file.version, ...(patch === null ? { content: file.after } : { patch }) };
  });
  if (!files.length) return { versions, changedPaths: [], divergent: [] };
  const dependencies = { ...readVersions, ...Object.fromEntries(edits.filter(file => file.before === file.after).map(file => [file.path, file.version])) };
  const body = JSON.stringify({ files, ...(beatAssets && { beatAssets }), ...(Object.keys(dependencies).length && { dependencies }), label: history?.label ?? label,
    ...(installComponent && { installComponent }), ...(history?.continuous && { undoGroup: history.windowId }) });
  const requestId = createStudioWriteToken();
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': requestId, ...studioWriteHeaders(history, requestId) };
  const commit = await trackStudioProjectSave(project, files[0].path, () => retryStudioSave(async () => {
    let response: Response;
    try {
      response = await studioApiFetch('/api/projects/' + encodeURIComponent(project) + '/text-edits', { method: 'POST', headers, body });
    } catch (cause) {
      throw new StudioSaveNetworkError('Failed to save the project edit', { cause });
    }
    if (response.status === 409) {
      const details = await response.clone().json().catch(() => null);
      if (details?.code !== 'VERSION_CONFLICT') throw await createStudioSaveHttpError(response, 'Failed to save the project edit');
      const conflict = details.details ?? details;
      const path = typeof conflict.path === 'string' ? conflict.path : files[0].path;
      forgetSource(project, path);
      reconcileFileEdit(project, path, conflict.currentVersion);
      throw new StudioFileConflictError({ syncLatest: true, filePath: path, currentVersion: conflict.currentVersion ?? null,
        currentContent: conflict.currentContent ?? null, attemptedContent: changed.find(file => file.path === path)?.after ?? '' });
    }
    if (!response.ok) throw await createStudioSaveHttpError(response, 'Failed to save the project edit');
    const result = await response.json() as { versions: Record<string, string>; changedPaths: string[] };
    if (!changed.every(file => typeof result.versions?.[file.path] === 'string')) throw new Error('Missing committed file version');
    return result;
  }));
  for (const file of changed) {
    const version = commit.versions[file.path];
    const known = confirmedSource(project, file.path);
    if (known && known.version !== file.version && known.version !== version) continue;
    if (installComponent && !supportsProjectTextEdits(project)) forgetSource(project, file.path);
    else rememberSource(project, file.path, { content: file.after, version });
    acknowledgeFileEdit(project, file.path, file.version, version);
  }
  return { versions: { ...versions, ...commit.versions }, changedPaths: commit.changedPaths, divergent: [] };
}
