import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runFile } from '../scripts/runtime-assets.mjs';
import { consumerEnvironment, checkedTemplateRuntime } from '../.github/scripts/motion-registry-smoke.mjs';

const script = fileURLToPath(new URL('../.github/scripts/motion-registry-smoke.mjs', import.meta.url));

test('isolated registry consumer supports legacy packages and fails on a hosted catalog fallback', async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'openmotion-registry-consumer-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const server = path.join(work, 'mcp.mjs'), input = path.join(work, 'input.json'), report = path.join(work, 'result.json');
  await writeFile(server, `import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})){
 const {id,method}=JSON.parse(line);if(!id)continue;
 const result=method==='initialize'?{serverInfo:{version:'1.0.0'}}:method==='tools/list'?{tools:[{name:'openmotion_list_templates'}]}:method==='tools/call'?{structuredContent:{source:'hosted',warning:'Hosted service unavailable; using builtins'}}:{contents:[]};
 console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
}`);
  const options = { transport: { command: process.execPath, args: [server] }, version: '1.0.0', tools: ['openmotion_list_templates'], report };
  await writeFile(input, JSON.stringify(options));
  const env = consumerEnvironment(work, { ...process.env, GITHUB_TOKEN: 'must-not-pass', AWS_SECRET_ACCESS_KEY: 'must-not-pass' });
  assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  await runFile(process.execPath, [script, 'consumer', input], { env });
  assert.deepEqual(JSON.parse(await readFile(report)), { status: 'not-run-legacy-cms' });
  const app = path.join(work, 'app'); await mkdir(path.join(app, 'scripts'), { recursive: true });
  await writeFile(path.join(app, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(app, 'scripts/npm-runtime.mjs'), 'export async function nativeConfiguration(){return {paths:{HYPERFRAMES_BROWSER_PATH:"unused"}}}');
  await writeFile(path.join(app, 'editor-runtime.ts'), 'export async function readEditor(){return null;}');
  const output = path.join(work, 'evidence');
  await writeFile(input, JSON.stringify({ ...options, templateCheck: { appRoot: app, dataDirectory: path.join(work, 'data'), output } }));
  await assert.rejects(runFile(process.execPath, [script, 'consumer', input], { env }), /Catalog must load successfully/);
  const result = JSON.parse(await readFile(path.join(output, 'result.json')));
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Hosted service unavailable/);
});

test('registry acceptance rejects unsuccessful or missing nested template-runtime results', () => {
  const passed = { status: 'passed', checks: ['copied brief', 'explicit creation'] };
  assert.equal(checkedTemplateRuntime(passed, true), passed);
  for (const status of ['failed', 'running', 'not-run-legacy-cms', undefined]) {
    assert.throws(() => checkedTemplateRuntime({ status }, true), /Unexpected template-runtime consumer result/);
  }
  assert.throws(() => checkedTemplateRuntime(null, true), /Unexpected template-runtime consumer result/);
  assert.equal(checkedTemplateRuntime({ status: 'not-run-legacy-cms' }, false).status, 'not-run-legacy-cms');
});
