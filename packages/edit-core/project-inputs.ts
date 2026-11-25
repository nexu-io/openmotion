import { locateEdit, type EditRequest } from './commands.ts';
import { contentDependencies, isContentCommand } from './content-schema.ts';
import { hasRelativeLutSource } from './color-grading.ts';

export type EditInputKind = 'text' | 'optional-text' | 'asset';

/** The inputs a caller must observe to run this command, including direct read-only dependencies. */
export function projectEditInputs(edit: EditRequest) {
  const commands = (edit.kind === 'batch' ? edit.commands : [edit]).map(locateEdit);
  const targets = new Set<string>();
  const requested = new Map<string, EditInputKind>();
  function requireInput(path: string, kind: EditInputKind) {
    const previous = requested.get(path);
    requested.set(path, previous && previous !== kind ? 'text' : kind);
  }
  for (const command of commands) {
    const path = command.compositionPath;
    if (command.kind !== 'setBeatGrid' && !/\.html?$/i.test(path)) throw new Error('A composition must be an HTML file');
    targets.add(path);
    requireInput(path, command.kind === 'setBeatGrid' ? 'optional-text' : 'text');
    if (command.kind === 'setBeatGrid') requireInput(command.assetPath, 'asset');
    if (isContentCommand(command)) {
      for (const input of contentDependencies(command)) requireInput(input.path, input.type);
    }
  }
  if (targets.size > 1 && commands.some(command => command.kind === 'gradeMedia' && hasRelativeLutSource(command.value))) {
    throw new Error('Use an absolute LUT source when grading multiple compositions');
  }
  return { commands, targets, requested };
}
