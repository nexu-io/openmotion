import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import tailwindcss from '@tailwindcss/vite';
import { build as viteBuild } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'packages/design-system/components');
const output = path.join(root, 'dist/open-design-ui');
const packageDist = path.join(output, 'dist');
const packageVersion = '0.0.1';

// shortcut: package the current Button and Slider exports, add entries when the registry grows.
const entryPoints = {
  button: path.join(source, 'button.tsx'),
  slider: path.join(source, 'slider.tsx'),
};

const packageManifest = {
  name: 'open-design-ui',
  version: packageVersion,
  description: 'Shared React UI components from Open Design and OpenMotion.',
  type: 'module',
  license: 'Apache-2.0',
  files: ['dist', 'README.md', 'LICENSE'],
  sideEffects: ['./dist/styles.css'],
  exports: {
    './button': { types: './dist/button.d.ts', import: './dist/button.js' },
    './slider': { types: './dist/slider.d.ts', import: './dist/slider.js' },
    './styles.css': './dist/styles.css',
  },
  peerDependencies: {
    '@base-ui/react': '^1.7.0',
    react: '^19.0.0',
    'react-dom': '^19.0.0',
  },
  dependencies: { cn: '^0.2.4' },
};

const readme = `# Open Design UI

Shared React controls from Open Design and OpenMotion.

## Install

\`\`\`sh
npm install open-design-ui
\`\`\`

## Use

Set \`data-motion-ui\` on the document's \`<html>\` element to enable the theme tokens. Use \`data-theme="light"\` or \`data-theme="dark"\` to choose a theme explicitly.

\`\`\`tsx
import { useState } from 'react';
import { Button } from 'open-design-ui/button';
import { Slider } from 'open-design-ui/slider';
import 'open-design-ui/styles.css';

export function Controls() {
  const [value, setValue] = useState(5);
  return (
    <>
      <Button type="button" variant="primary" onClick={() => setValue(5)}>Reset</Button>
      <Slider label="Guidance scale" min={1} max={10} value={value} onCommit={setValue} />
    </>
  );
}
\`\`\`
`;

await rm(output, { recursive: true, force: true });
await mkdir(packageDist, { recursive: true });

await esbuild({
  entryPoints,
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  platform: 'browser',
  outdir: packageDist,
  external: ['react', 'react-dom', '@base-ui/react/*', 'cn'],
});

const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
const { stdout, stderr } = await promisify(execFile)(process.execPath, [
  tsc,
  '--declaration',
  '--emitDeclarationOnly',
  '--jsx', 'react-jsx',
  '--module', 'ESNext',
  '--moduleResolution', 'Bundler',
  '--target', 'ES2022',
  '--strict',
  '--skipLibCheck',
  '--rootDir', source,
  '--outDir', packageDist,
  ...Object.values(entryPoints),
], { cwd: root });
if (stdout.trim()) process.stdout.write(stdout);
if (stderr.trim()) process.stderr.write(stderr);

await viteBuild({
  root: source,
  configFile: false,
  publicDir: false,
  plugins: [tailwindcss()],
  build: {
    outDir: packageDist,
    emptyOutDir: false,
    rollupOptions: {
      input: path.join(source, 'styles.css'),
      output: { assetFileNames: '[name][extname]' },
    },
  },
});

await writeFile(path.join(output, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);
await writeFile(path.join(output, 'README.md'), readme);
await copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));

for (const file of ['button.js', 'button.d.ts', 'slider.js', 'slider.d.ts', 'styles.css']) {
  const target = path.join(packageDist, file);
  await readFile(target);
}
assert.equal(JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8')).name, 'open-design-ui');
console.log(`Built ${packageManifest.name}@${packageVersion} at ${path.relative(root, output)}`);
