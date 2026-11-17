import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalAgentDirectory } from '../gateway/local-agents.ts';
import { agentInvocation, discoverAcp, parseAgentAuth, parseAgentModels } from '../gateway/agent-discovery.ts';
import { terminalCommand } from '../gateway/agent-terminal.ts';
import { localAgents } from '../shared/local-agents.ts';

test('Agent discovery excludes hidden models and unrelated CLI/auth output', () => {
  assert.deepEqual(parseAgentModels('codex', JSON.stringify({ models: [{ slug: 'model-1', display_name: 'One', supported_reasoning_levels: [{ effort: 'high' }], base_instructions: 'private' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'model-1' }] })), [{ id: 'model-1', label: 'One', source: 'cli', reasoning: ['high'] }]);
  assert.deepEqual(parseAgentModels('lines', '\x1b[32mprovider/model-1\x1b[0m\nNot logged in\nmodel-2 - Model two\n'), [{ id: 'provider/model-1', label: 'provider/model-1', source: 'cli' }, { id: 'model-2', label: 'model-2', source: 'cli' }]);
  assert.equal(parseAgentAuth('codex', true, 'Logged in using ChatGPT'), 'signed-in');
  assert.equal(parseAgentAuth('codex', false, 'Not logged in'), 'signed-out');
  assert.equal(parseAgentAuth('claude', true, '{"loggedIn":false}'), 'signed-out');
  assert.equal(parseAgentAuth('other', true, 'OK'), 'unknown');
  assert(!localAgents.some(agent => ['ollama', 'lmstudio', 'comfyui'].includes(agent.id)));
});

test('Agent defaults persist outside the checkout and selected model reaches the scoped terminal command', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-agent-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  let signedIn = true, launches = 0;
  const probes: string[][] = [];
  const directory = new LocalAgentDirectory(root, async bin => bin === 'codex' ? '/Applications/Agent Space/codex' : null, async (_bin, args) => {
    probes.push(args);
    return { ok: true, text: args[0] === '--version' ? 'codex-cli 1.2.3' : args[0] === '--help' ? '--model MODEL' : args[0] === 'login' ? signedIn ? 'Logged in' : 'Not logged in' : JSON.stringify({ models: [{ slug: 'model-1', supported_reasoning_levels: [{ effort: 'high' }] }] }) };
  }, async (_dir, command) => { launches++; assert.match(command, /--model' 'model-1'/); });
  await directory.list(); assert.equal(probes.length, 0, 'listing must not launch every installed CLI');
  await directory.inspect('codex');
  const choice = { agent: 'codex', model: 'model-1', reasoning: 'high' };
  await directory.choose(choice);
  assert.deepEqual((await directory.list()).default, choice);
  assert.equal((await stat(directory.file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(directory.file, 'utf8'), /token|credential|Logged in/);
  const plan = await directory.prepare(choice, "/projects/a 'quote' $(touch bad)", 'http://127.0.0.1:49937', 'launch');
  assert(plan.modelInCommand); assert.match(plan.command, /model_reasoning_effort="high"/);
  assert.doesNotMatch(plan.command, /dangerously|skip-permissions|approval_policy/);
  assert.match(plan.instruction, /connect\/guide\?host=codex/);
  assert.equal(launches, 0, 'prepare is read-only');
  await directory.open(choice, '/projects/test', 'http://localhost', 'launch'); assert.equal(launches, 1);
  await assert.rejects(directory.choose({ agent: 'claude', model: 'default' }), /Install/);
  await assert.rejects(directory.choose({ agent: 'codex', model: 'unknown' }), /Refresh/);
  await assert.rejects(directory.choose({ ...choice, reasoning: 'unknown' }), /reasoning/);
  await assert.rejects(directory.addModel('codex', 'model; rm -rf'), /Invalid/);
  await directory.addModel('codex', 'custom-model'); await directory.choose({ agent: 'codex', model: 'custom-model' });
  const restarted = new LocalAgentDirectory(root, directory.resolve, directory.probe);
  assert.equal((await restarted.list()).default?.model, 'custom-model');
  signedIn = false; await directory.inspect('codex'); await assert.rejects(directory.choose(choice), /Sign in/);
  assert.match((await directory.prepare(choice, '/project', 'http://localhost', 'login')).command, /'login'/);
});

test('terminal quoting keeps metacharacters literal on POSIX and Windows', () => {
  assert.equal(terminalCommand('/bin/cli', ['a\'b', '$(echo bad)'], '/p a'), "cd '/p a' && '/bin/cli' 'a'\\''b' '$(echo bad)'");
  assert.equal(terminalCommand('C:\\cli.cmd', ["a'b", '$x'], 'C:\\project', 'win32'), "Set-Location -LiteralPath 'C:\\project'\n& 'C:\\cli.cmd' 'a''b' '$x'");
});

test('ACP discovery lists session models, denies client operations and sends no prompt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-acp-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'agent.mjs'), log = path.join(root, 'calls.json');
  await writeFile(script, `import readline from 'node:readline'; import {writeFileSync} from 'node:fs'; const calls=[]; const send=v=>console.log(JSON.stringify(v)); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); calls.push(m); writeFileSync(process.argv[2],JSON.stringify(calls)); if(m.method==='initialize') send({id:1,result:{protocolVersion:1}}); else if(m.method==='session/new'){send({id:99,method:'fs/read_text_file',params:{path:'/private'}});} else if(m.id===99 && m.error) send({id:2,result:{models:{availableModels:[{modelId:'acp-model',name:'ACP model'}]}}}); });`);
  const result = await discoverAcp(process.execPath, [script, log]);
  assert.equal(result.models[0].id, 'acp-model');
  const calls = JSON.parse(await readFile(log, 'utf8'));
  assert.deepEqual(calls.filter((call: any) => call.method).map((call: any) => call.method), ['initialize', 'session/new']);
  assert.deepEqual(calls[1].params.mcpServers, []); assert.equal(calls[2].error.code, -32601);
  const shim = path.join(root, 'agent.cmd'); await writeFile(shim, '"%dp0%\\node_modules\\agent\\cli.js" %*');
  assert.deepEqual(await agentInvocation(shim, ['--version']), { bin: process.execPath, args: [path.join(root, 'node_modules/agent/cli.js'), '--version'] });
});
