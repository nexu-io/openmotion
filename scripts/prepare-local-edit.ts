// Node CLI shipped with each Studio build. Project reads and authenticated writes stay with the host Agent.
import { projectEditInputs } from '../packages/edit-core/project-inputs.ts';
import { prepareFileEdits, type ObservedEditFile } from '../packages/edit-core/prepare-file-edits.ts';
import { editRequestSchema, editSchemaDefinitions } from '../packages/edit-core/schema.ts';
import type { EditRequest } from '../packages/edit-core/commands.ts';
import { validateInput } from '../shared/phase1-tools.ts';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { edit: EditRequest; files?: ObservedEditFile[] };
  validateInput(editRequestSchema, input.edit, 'edit', 'edit', editSchemaDefinitions);
  if (!input.files) {
    const { requested } = projectEditInputs(input.edit);
    return { inputs: Array.from(requested, ([path, kind]) => ({ path, kind })) };
  }
  const textEdits = await prepareFileEdits(input.edit, input.files);
  return textEdits.files.length ? { textEdits } : { changed: false };
}
main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write(String(error.message ?? error) + '\n');
  process.exitCode = 1;
});
