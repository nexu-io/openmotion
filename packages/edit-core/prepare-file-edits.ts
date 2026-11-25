import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';
import { isBeatMedia } from '../../shared/asset-names.ts';
import { createTextPatch } from '../../shared/create-text-patch.ts';
import { applyProjectEdit, type EditRequest } from './commands.ts';
import { projectEditInputs } from './project-inputs.ts';

export type ObservedEditFile = { path: string; fileVersion: string | null; content?: string; offset?: number; truncated?: boolean; totalLength?: number; isText?: boolean; mimeType?: string };

/** Prepare one ordered action against a fixed snapshot. Never perform project I/O here. */
export async function prepareFileEdits(edit: EditRequest, files: readonly ObservedEditFile[]) {
  const { commands, requested, targets } = projectEditInputs(edit);
  const observed = new Map(files.map(file => [file.path, file]));
  if (observed.size !== files.length) throw new Error('Provide a single version of each input');
  const dependencies: Record<string, string | null> = Object.create(null);
  const sources = new Map<string, string>();
  for (const [path, kind] of requested) {
    const file = observed.get(path);
    if (!file || (file.fileVersion === null && kind !== 'optional-text') ||
        (file.fileVersion !== null && !/^"(?:sha256|patch):[a-f0-9]{64}"$/.test(file.fileVersion))) {
      throw new Error('Supply the observed version of ' + path);
    }
    dependencies[path] = file.fileVersion;
    if (kind !== 'asset') {
      if (file.fileVersion !== null && (typeof file.content !== 'string' || file.truncated || file.offset ||
          (file.totalLength !== undefined && file.content.length !== file.totalLength))) throw new Error('Supply the full text of ' + path);
      if (file.fileVersion === null && file.content) throw new Error('A missing file cannot have prior contents');
      sources.set(path, file.content ?? '');
    }
  }
  const original = new Map(sources);
  const labels = new Set<string>();
  const beatAssets = new Set<string>();
  for (const command of commands) {
    if (command.kind === 'setBeatGrid') {
      const file = observed.get(command.assetPath)!;
      if (!isBeatMedia(command.assetPath, { mimeType: file.mimeType ?? '', isText: file.isText !== false })) throw new Error('Beat markers require an audio or video asset');
      beatAssets.add(command.assetPath);
    }
    const before = sources.get(command.compositionPath)!;
    const { content, label } = await applyProjectEdit(before, command, sources);
    if (content !== before) labels.add(label);
    sources.set(command.compositionPath, content);
  }
  const changes = [...targets].flatMap(path => {
    const before = original.get(path)!, after = sources.get(path)!;
    if (before === after) return [];
    const content = /\.html?$/i.test(path) ? stampHfIdsInPlace(after) : after;
    if (before === content) return [];
    const baseVersion = dependencies[path];
    const patch = baseVersion === null ? null : createTextPatch(before, content);
    delete dependencies[path];
    return [{ path, baseVersion, ...(patch === null ? { content } : { patch }) }];
  });
  // Only grids that actually changed require a type check; unchanged dependencies retain their version guard.
  const checkedAssets = [...beatAssets].filter(asset => changes.some(file => file.path === 'beats/' + asset + '.json'));
  return { files: changes, dependencies, ...(checkedAssets.length && { beatAssets: checkedAssets }),
    label: labels.size === 1 ? [...labels][0] : 'Edit project' };
}
