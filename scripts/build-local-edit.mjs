import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('scripts/prepare-local-edit.ts', root))],
  platform: 'node', target: 'node22', format: 'cjs', bundle: true, minify: true, write: false });
const bytes = outputFiles[0].contents;
const sha256 = createHash('sha256').update(bytes).digest('hex');
const directory = new URL('studio/build/editor-assets/', root);
await mkdir(directory, {recursive: true});
await writeFile(new URL('openmotion-edit-' + sha256 + '.cjs', directory), bytes);
await writeFile(new URL('../edit-core-sha256', directory), sha256);
