import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareInstallationFlow } from '../scripts/install-onboarding.mjs';

test('plugin preparation uses its declared MCP workspace instead of silently selecting the host default', async t => {
  const appRoot = await mkdtemp(path.join(tmpdir(), 'motion-plugin-workspace-'));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  const dataDirectory = path.join(appRoot, 'selected-data');
  await mkdir(path.join(appRoot, 'docs')); await mkdir(path.join(appRoot, 'scripts'));
  await writeFile(path.join(appRoot, 'docs/install-onboarding.md'), '<!-- installation-onboarding:start -->Reuse the connection workspace.<!-- installation-onboarding:end -->');
  await writeFile(path.join(appRoot, '.mcp.json'), JSON.stringify({ mcpServers: { openmotion: { cwd: '.', env: { MOTION_DATA_DIR: dataDirectory } } } }));
  await writeFile(path.join(appRoot, 'scripts/open-template-library.ts'), `if(process.env.MOTION_DATA_DIR!==${JSON.stringify(dataDirectory)}) throw new Error('Wrong workspace'); console.log(JSON.stringify({target:'templates',projectCreated:false,previewUrl:'http://127.0.0.1:4173/?templates=1'}));`);
  // This seam tests the workspace/preview protocol without contacting a native
  // host or enqueueing messages in the developer's current chat.
  const result = await prepareInstallationFlow({ appRoot, host: 'workbuddy', templateEnvironment: 'prod' });
  assert.equal(result.dataDirectory, dataDirectory);
  assert.equal(result.preview.status, 'ready');
  assert.equal(result.onboardingComplete, false);
});
