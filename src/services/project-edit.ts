import { createTextPatch } from '../../shared/create-text-patch.ts';
import { stampHfIdsInPlace, walkCompositionDescendants } from '@hyperframes/parsers/hf-ids';
import { parseSourceDocument, type SourceMutationTarget } from '@hyperframes/studio-server/source-mutation';
import { projectEditInputs } from '../../packages/edit-core/project-inputs.ts';
import { applyProjectEdit, type CompositionEdit, type EditRequest } from '../../packages/edit-core/commands.ts';
import { editRequestSchema, editSchemaDefinitions } from '../../packages/edit-core/schema.ts';
import { validateInput } from '../../shared/phase1-tools.ts';
import { isBeatMedia } from '../../shared/asset-names.ts';
import { ToolInputError } from '../../shared/tool-input-error.ts';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import { sha256Hex } from '../studio/etag.ts';
import { normalizeSafeProjectPath, type ProjectFilesService } from './project-files-service.ts';

export type EditGuard =
  | { source: 'studio'; versions: Record<string, string | null>; writeToken: string; windowId?: string; undoGroup?: string }
  | { source: 'agent'; expectedRevision: string; expectedVersionId: string };

function invalid(message: string) {
  return new CloudError('INVALID_ARGUMENT', message, { status: 400, applied: false });
}

function validateEdit(input: unknown): asserts input is EditRequest {
  try {
    validateInput(editRequestSchema, input, 'edit', 'edit', editSchemaDefinitions);
  } catch (error) {
    if (error instanceof ToolInputError) throw invalid(error.message);
    throw error;
  }
}

function commandPath(path: string, writable = false) {
  const normalized = normalizeSafeProjectPath(path, writable);
  if (normalized !== path) throw invalid('Use canonical project-relative paths');
  return normalized;
}

// On a newer base, address the same element. A selector or positional fallback
// can point at a different child after another editor restructures the HTML.
function stableTarget(target: { hfId?: string; id?: string | null }) {
  return target.hfId || target.id ? { hfId: target.hfId, id: target.id } : undefined;
}

function targetsStillMatch(source: string, targets: SourceMutationTarget[]): boolean {
  // Match within nested composition templates as well. An SDK fallback to the
  // first DOM match would silently retarget ambiguous edits after restructuring.
  const identities = targets.map(target => [
    ...(target.hfId ? ['hf:' + target.hfId] : []),
    ...(target.id ? ['id:' + target.id] : []),
  ]);
  const matches = new Map<string, Element | null | undefined>(identities.flat().map(key => [key, undefined]));
  // The preview and source parser mint identical hfIds for unstamped templates.
  const { document } = parseSourceDocument(source);
  walkCompositionDescendants(document, element => {
    const record = (key: string) => {
      if (matches.has(key)) matches.set(key, matches.get(key) === undefined ? element : null);
    };
    record('hf:' + (element.getAttribute('data-hf-id') ?? ''));
    record('id:' + (element.getAttribute('id') ?? ''));
  });
  return identities.every(keys => {
    const first = matches.get(keys[0]);
    return Boolean(first) && keys.every(key => matches.get(key) === first);
  });
}

const snapshotAttributes = new Set(['style', 'class', 'id', 'data-hf-id', 'data-composition-variables', 'data-variable-values']);

function onNewBase(command: CompositionEdit): CompositionEdit | undefined {
  switch (command.kind) {
    case 'moveClips':
      // Absolute paint ranks describe the entire observed order.
      return command.stacking && 'ranks' in command.stacking ? undefined : command;
    case 'moveClip':
    case 'trimClips':
    case 'setClipState':
      return command;
    case 'setCanvasBox':
    case 'moveCanvasElement': {
      const target = stableTarget(command.target);
      return target && { ...command, target };
    }
    case 'editElements': {
      const patches = [];
      for (const patch of command.patches) {
        const target = stableTarget(patch.target);
        if (!target || patch.operations.some(op => op.childSelector !== undefined || op.childIndex !== undefined ||
            op.type === 'rich-text' || (op.type !== 'inline-style' && snapshotAttributes.has(op.property.toLowerCase())))) return;
        patches.push({ ...patch, target });
      }
      return { ...command, patches };
    }
  }
}

export async function commitProjectEdit(files: ProjectFilesService, auth: AuthContext, projectId: string,
  input: unknown, requestId: string, guard: EditGuard) {
  validateEdit(input);
  if (!requestId || requestId.length > 100 ||
      (guard.source === 'agent' && (!guard.expectedRevision || !guard.expectedVersionId))) {
    throw invalid('Project edits require a request ID and a base version');
  }
  let inputs: ReturnType<typeof projectEditInputs>;
  try { inputs = projectEditInputs(input); }
  catch (error) { throw invalid(error instanceof Error ? error.message : 'Invalid editing command'); }
  const { commands, targets, requested } = inputs;
  for (const path of requested.keys()) commandPath(path, targets.has(path));
  const plan = commands.map(command => ({ command, rebasedCommand: onNewBase(command) }));
  const canRebase = !files.textPatchWrites && plan.every(item => item.rebasedCommand !== undefined);
  if (guard.source === 'studio' && ([...targets].some(path => !Object.hasOwn(guard.versions, path) ||
      (guard.versions[path] === null ? requested.get(path) !== 'optional-text' : typeof guard.versions[path] !== 'string' || !guard.versions[path])) ||
      Object.keys(guard.versions).some(path => !requested.has(path)))) {
    throw invalid('Supply a base version for every edited composition');
  }
  const base = guard.source === 'studio' ? guard.versions : [guard.expectedRevision, guard.expectedVersionId];
  // Preserve receipts issued by the original move endpoint during rolling upgrades.
  const legacyMove = input.kind === 'moveClip';
  const scope = `project:${projectId}:${guard.source}:${legacyMove ? 'moveClip' : 'edit'}`;
  const commandHash = legacyMove
    ? sha256Hex(JSON.stringify([input.compositionPath, input.hfId, input.start,
      guard.source === 'studio' ? guard.versions[input.compositionPath] : base]))
    : sha256Hex(JSON.stringify([input, base], (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value));
  const undoGroup = guard.source === 'studio' && files.textPatchWrites ? guard.undoGroup : undefined;
  const hash = undoGroup ? sha256Hex(JSON.stringify([commandHash, undoGroup])) : commandHash;
  // Persist with the exact input versions we evaluated. A racing commit may
  // invalidate them between read and write, even if the client base was fresh.
  async function applyCurrent() {
    const snapshot = await files.readEditInputs(auth, projectId, requested, scope, requestId, hash,
      !files.textPatchWrites && !canRebase && guard.source === 'agent' ? guard : undefined);
    if (snapshot.kind === 'replay') return snapshot.commit;
    for (const command of commands) {
      if (command.kind !== 'setBeatGrid') continue;
      if (!isBeatMedia(command.assetPath, snapshot.filesByPath.get(command.assetPath))) {
        throw invalid('Beat markers require a project audio or video asset');
      }
    }
    const { versions } = snapshot;
    const sources = new Map(snapshot.sources);
    const staleProject = guard.source === 'agent' && (snapshot.revision !== guard.expectedRevision || snapshot.versionId !== guard.expectedVersionId);
    const rebased = !files.textPatchWrites && (guard.source === 'agent'
      ? snapshot.revision !== guard.expectedRevision || snapshot.versionId !== guard.expectedVersionId
      : Object.entries(guard.versions).some(([path, expected]) => versions.get(path) !== expected));
    if (!canRebase && guard.source === 'studio') {
      for (const [path, expected] of Object.entries(guard.versions)) {
        if (versions.get(path) !== expected) throw new CloudError('VERSION_CONFLICT', 'Project file changed before the edit', {
          status: 409, applied: false, details: { path, currentVersion: versions.get(path), currentContent: sources.get(path) },
        });
      }
    }
    const changed = new Map<string, string>();
    const labels = new Set<string>();
    for (const item of plan) {
      const command = rebased ? item.rebasedCommand! : item.command;
      const path = command.compositionPath;
      try {
        const before = sources.get(path)!;
        if (rebased) {
          const targets = command.kind === 'editElements' ? command.patches.map(patch => patch.target)
            : command.kind === 'setCanvasBox' || command.kind === 'moveCanvasElement' ? [command.target] : [];
          if (targets.length && !targetsStillMatch(before, targets)) {
            throw new CloudError('VERSION_CONFLICT', 'The edited canvas element changed identity.', {
              status: 409, applied: false, details: { path, currentVersion: versions.get(path), currentContent: snapshot.sources.get(path) },
            });
          }
        }
        const edited = await applyProjectEdit(before, command, sources);
        if (edited.content !== before) {
          sources.set(path, edited.content);
          changed.set(path, edited.content);
          labels.add(edited.label);
        }
      } catch (error) {
        if (isCloudError(error)) throw error;
        throw invalid(error instanceof Error ? error.message : 'Invalid project edit');
      }
    }
    if (files.textPatchWrites) {
      if (guard.source === 'agent' && staleProject) await files.checkObservedFiles(auth, projectId, guard, versions);
      const edits = Array.from(changed, ([path, source]) => {
        const content = /\.html?$/i.test(path) ? stampHfIdsInPlace(source) : source;
        const baseVersion = versions.get(path) ?? null;
        const patch = baseVersion === null ? null : createTextPatch(snapshot.sources.get(path)!, content);
        return {path, baseVersion, ...(patch === null ? {content} : {patch})};
      });
      // A no-op still guards its read set and obtains an idempotent receipt.
      if (edits.length) {
        return files.commitTextEdits(auth, projectId, {files: edits, dependencies: Object.fromEntries(versions), undoGroup,
          label: labels.size === 1 ? [...labels][0] : 'Edit project'}, {source: guard.source, requestId,
          writeToken: guard.source === 'studio' ? guard.writeToken : undefined, command: {scope, hash, result: {rebased: false}}});
      }
    }
    return files.commitChanges(auth, {
      projectId, requestId, idempotencyScope: scope, commandReceipt: { inputHash: hash, result: { rebased } },
      ops: Array.from(changed, ([path, content]) => ({ op: 'upsert_text', path, content,
        stampHfIds: /\.html?$/i.test(path) })),
      filePreconditions: Array.from(versions, ([path, version]) => version === null
        ? { path, ifNoneMatch: '*' as const } : { path, ifMatch: version }),
      source: guard.source, summary: labels.size === 1 ? [...labels][0] : 'Edit project',
      ...(guard.source === 'studio' ? { writeToken: guard.writeToken, windowId: guard.windowId } :
        { actorKind: 'agent', ...(!canRebase && !files.textPatchWrites && { expectedRevision: guard.expectedRevision, expectedVersionId: guard.expectedVersionId }) }),
    });
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await applyCurrent();
    } catch (error) {
      if (!canRebase || attempt >= 5 || !isCloudError(error) ||
          error.code !== 'VERSION_CONFLICT' || error.details?.code !== 'VERSION_MISMATCH') throw error;
    }
  }
}
