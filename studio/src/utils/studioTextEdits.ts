import type { CompositionEdit } from '../../../packages/edit-core/commands';
import { enqueueProjectEdit, runOrderedProjectBarrier } from './orderedProjectEdits';
import { contentDependencies, isContentCommand } from '../../../packages/edit-core/content-schema';
import { confirmedSource, forgetSource, observeSourceRead, pendingSourceRead, rememberSource, supportsOrderedTextEdits, supportsProjectTextEdits, type ConfirmedSource } from './confirmedTextSources';
import { acknowledgeFileEdit, isolatedEditVersion } from './isolatedEditVersions';
import { reconcileFileEdit } from './rebasedFileEdit';
import type { StudioWriteHistory } from './studioFileHistory';
import { createStudioWriteToken, studioWriteHeaders } from './studioFileVersion';
import { createStudioSaveHttpError, RejectedCanvasGesture, retryStudioSave, StudioFileConflictError, StudioSaveNetworkError } from './studioSaveDiagnostics';
import { studioApiFetch } from './studioApiFetch';
import { trackStudioProjectSave } from './studioSaveState';

export type TextEditSource = { path: string; before: string; after: string };
type Prepared = TextEditSource & { version: string };

// Commands which read external assets, nested compositions or beat sidecars still require the
// semantic endpoint until the browser can attest all of the corresponding input revisions.
export const isLocalProjectEdit = (command: CompositionEdit) => isContentCommand(command)
  ? contentDependencies(command).length === 0
  : command.kind !== 'setBeatGrid' && command.kind !== 'gradeMedia';

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
  const response = await studioApiFetch('/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(path));
  if (response.status === 404) {
    forgetSource(project, path);
    reconcileFileEdit(project, path);
    throw new StudioFileConflictError({ syncLatest: true, filePath: path, currentVersion: null, currentContent: null, attemptedContent });
  }
  if (!response.ok) throw await createStudioSaveHttpError(response, 'Could not read ' + path);
  const data = await response.json();
  observeSourceRead(project, path, response, data);
  source = confirmedSource(project, path);
  if (source && !matches(source)) {
    reconcileFileEdit(project, path, source.version);
    throw new StudioFileConflictError({ syncLatest: true, filePath: path, currentVersion: source.version, currentContent: source.content, attemptedContent });
  }
  return source;
}

export async function tryStudioTextEdit(project: string, sources: readonly TextEditSource[], history?: StudioWriteHistory) {
  const prepare = async (drafts?: ReadonlyMap<string, ConfirmedSource>) => {
    const edits: Prepared[] = [];
    for (const source of sources) {
      const draft = drafts?.get(source.path);
      if (draft && draft.content !== source.before) throw staleSource(source.path, draft, source.after);
      const base = draft ?? await resolveEditSource(project, source.path, current => current.content === source.before, source.after);
      if (!base) return;
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
  if (plan) return commitTextEdits(project, plan.edits, history);
}

export async function tryStudioCommandPatches(project: string, commands: CompositionEdit[], versions: Record<string, string>,
  history?: StudioWriteHistory, predicted?: (path: string) => string | undefined) {
  if (!commands.length || !commands.every(isLocalProjectEdit)) return;
  if (!supportsProjectTextEdits(project) && !Object.values(versions).some(version => version.startsWith('"patch:'))) return;
  const ordered = supportsOrderedTextEdits(project);
  const canvasGesture = !predicted && commands.every(c => c.kind === 'moveCanvasElement' || c.kind === 'setCanvasBox');
  const captured = new Map<string, ConfirmedSource>();
  for (const [path, version] of Object.entries(versions)) {
    const source = confirmedSource(project, path);
    const shownVersion = predicted ? version : isolatedEditVersion(project, path, version);
    if (source?.version === shownVersion) captured.set(path, source);
  }
  const prepare = async (drafts?: ReadonlyMap<string, ConfirmedSource>) => {
    const files = new Map<string, Prepared>();
    for (const path of new Set(commands.map(command => command.compositionPath))) {
      const expected = predicted ? versions[path] : isolatedEditVersion(project, path, versions[path]);
      const projected = drafts?.get(path);
      const source = projected ?? await resolveEditSource(project, path,
        current => ordered || current.version === expected, predicted?.(path) ?? '', true);
      if (!source) return;
      if (source.version === expected && !projected && !captured.has(path)) captured.set(path, source);
      if (source.version !== expected) {
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
    const label = await applyCommands(commands, files).catch(error => {
      // Only the in-memory transformation is covered. Reads, submissions and receipts keep their save errors.
      if (canvasGesture) throw new RejectedCanvasGesture(error);
      throw error;
    });
    return { edits: [...files.values()], label: history?.label ?? label, undoGroup: history?.continuous ? history.windowId : undefined };
  };
  let edits: Prepared[] = [];
  let saved;
  if (ordered) {
    saved = await enqueueProjectEdit(project, commands[0].compositionPath, async drafts => {
      const plan = await prepare(drafts);
      if (!plan) throw new Error('Missing source for ordered project edit');
      edits = plan.edits;
      return plan;
    }, canvasGesture);
  } else {
    const plan = await prepare();
    if (!plan) return;
    edits = plan.edits;
    saved = await commitTextEdits(project, edits, history, plan.label);
  }
  const divergent = [];
  for (const file of edits) {
    const visible = predicted?.(file.path);
    if (visible !== undefined && file.after !== visible) {
      divergent.push(reconcileFileEdit(project, file.path, saved.versions[file.path], saved.changedPaths.includes(file.path)));
    }
  }
  return { ...saved, divergent };
}

function staleSource(path: string, source: ConfirmedSource, attemptedContent: string) {
  return new StudioFileConflictError({ filePath: path, currentVersion: source.version, currentContent: source.content, attemptedContent, syncLatest: true });
}

async function applyCommands(commands: CompositionEdit[], files: Map<string, Prepared>) {
  const { applyProjectEdit } = await import('../../../packages/edit-core/commands');
  const labels = new Set<string>();
  const inputs = new Map<string, string>();
  for (const command of commands) {
    const file = files.get(command.compositionPath)!;
    const edited = await applyProjectEdit(file.after, command, inputs);
    if (edited.content !== file.after) labels.add(edited.label);
    file.after = edited.content;
  }
  return labels.size === 1 ? [...labels][0] : 'Edit project';
}

/** A catalog drop creates the missing files and edits their host in one project transaction. */
export async function placeCatalogComponent(project: string, path: string, name: string, label: string,
  insertHost: (content: string) => string) {
  return runOrderedProjectBarrier(project, async () => {
    let source = confirmedSource(project, path);
    if (!source) {
      const response = await studioApiFetch('/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(path));
      if (!response.ok) throw await createStudioSaveHttpError(response, 'Could not read ' + path);
      const data = await response.json();
      if (typeof data.content !== 'string' || typeof data.version !== 'string') throw new Error('Missing composition source or version');
      observeSourceRead(project, path, response, data);
      source = { content: data.content, version: data.version };
    }
    return commitTextEdits(project, [{ path, before: source.content, version: source.version, after: insertHost(source.content) }], undefined, label, name);
  });
}

async function commitTextEdits(project: string, edits: Prepared[], history?: StudioWriteHistory, label = 'Edit file', installComponent?: string) {
  const { createTextPatch } = await import('../../../shared/create-text-patch');
  const { stampHfIdsInPlace } = await import('@hyperframes/parsers/hf-ids');
  const versions = Object.fromEntries(edits.map(file => [file.path, file.version]));
  const changed = edits.filter(file => file.after !== file.before);
  const files = changed.map(file => {
    if (/\.html?$/i.test(file.path)) file.after = stampHfIdsInPlace(file.after);
    const patch = installComponent && !supportsProjectTextEdits(project) ? null : createTextPatch(file.before, file.after);
    return { path: file.path, baseVersion: file.version, ...(patch === null ? { content: file.after } : { patch }) };
  });
  if (!files.length) return { versions, changedPaths: [], divergent: [] };
  const dependencies = Object.fromEntries(edits.filter(file => file.before === file.after).map(file => [file.path, file.version]));
  const body = JSON.stringify({ files, ...(Object.keys(dependencies).length && { dependencies }), label: history?.label ?? label,
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
    if (installComponent && !supportsProjectTextEdits(project)) forgetSource(project, file.path);
    else rememberSource(project, file.path, { content: file.after, version });
    acknowledgeFileEdit(project, file.path, file.version, version);
  }
  return { versions: { ...versions, ...commit.versions }, changedPaths: commit.changedPaths, divergent: [] };
}
