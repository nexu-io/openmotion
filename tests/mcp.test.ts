import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fixture } from './fixtures.ts';

test('actual MCP stdio exposes exactly phase-one tools and rejects hidden writes without side effects', () => fixture(async store => {
  const before = await store.get();
  const messages = [
    { id: 1, method: 'initialize' }, { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'openmotion_write_files', arguments: { expectedRevision: before.revision, files: [{ path: 'notes.md', content: 'hidden' }] } } },
    { id: 4, method: 'tools/call', params: { name: 'openmotion_edit_project', arguments: {} } },
  ];
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'mcp.ts'], { input: messages.map(m => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n', encoding: 'utf8', env: { ...process.env, MOTION_DATA_DIR: store.directory }, timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, 'openmotion');
  assert.equal(responses[0].result.serverInfo.title, 'OpenMotion');
  const icons = responses[0].result.serverInfo.icons;
  assert.deepEqual(icons.map((icon: any) => icon.theme), ['light', 'dark']);
  for (const icon of icons) {
    assert.equal(icon.mimeType, 'image/svg+xml');
    assert.deepEqual(icon.sizes, ['any']);
    const filename = `../docs/readme/opendesign-symbol${icon.theme === 'dark' ? '-dark' : ''}.svg`;
    assert.equal(icon.src, 'data:image/svg+xml;base64,' + readFileSync(new URL(filename, import.meta.url)).toString('base64'));
  }

  assert.ok(responses[1].result.tools.every((tool: any) => tool.title.startsWith('OpenMotion · ')));
  assert.ok(responses[1].result.tools.every((tool: any) => tool.name.startsWith('openmotion_')));
  assert.match(responses[2].result.content[0].text, /MCP_TOOL_NOT_EXPOSED/);
  assert.match(responses[3].result.content[0].text, /INVALID_ARGUMENT/);
  assert.deepEqual(await store.get(), before);
}));

test('MCP branding retains compatibility with protocol revisions before icon support', () => fixture(async store => {
  const { rpc } = await import('../mcp.ts');
  for (const protocolVersion of ['2024-11-05', '2025-03-26', '2025-06-18']) {
    const response: any = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } }, store);
    assert.equal(response.result.protocolVersion, protocolVersion);
    assert.equal(response.result.serverInfo.icons, undefined);
  }
}));

test('workflow sections are read-only and expose native production instructions', () => fixture(async store => {
  const { callTool } = await import('../mcp.ts');
  const before = await store.get();
  for (const section of ['start', 'intake', 'templates', 'production', 'verification']) {
    const result = await callTool('openmotion_get_workflow', { section }, store) as any;
    assert.equal(result.section, section); assert.ok(result.content.length > 100);
  }
  await assert.rejects(callTool('openmotion_get_workflow', { section: '../secrets' }, store), /Unknown workflow section/);
  assert.deepEqual(await store.get(), before);
}));

test('actual MCP stdio inspect returns regional provider metadata and keeps environment keys private', () => fixture(async store => {
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'regional-inspect-test', version: '1' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/call', params: { name: 'openmotion_media_use', arguments: { action: 'inspect' } } },
  ];
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'mcp.ts'], {
    input: messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n', encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, MOTION_DATA_DIR: store.directory, MINIMAX_SPEECH_CN_API_KEY: 'synthetic-stdio-cn-secret', MINIMAX_SPEECH_API_KEY: 'synthetic-stdio-global-secret' },
  });
  assert.equal(child.status, 0, child.stderr);
  const reply = child.stdout.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 2);
  assert.equal(reply.result.isError, undefined, JSON.stringify(reply));
  const inspected = reply.result.structuredContent;
  for (const [id, region, baseUrl] of [['minimax-speech-cn', 'China mainland', 'https://api.minimax.cn'], ['minimax-speech', 'International', 'https://api.minimax.io']]) {
    const provider = inspected.providers.find((p: any) => p.id === id);
    assert.equal(provider.group, 'MiniMax Speech'); assert.equal(provider.region, region); assert.equal(provider.baseUrl, baseUrl);
    assert.equal(provider.configured, true);
  }
  const fish = inspected.providers.find((p: any) => p.id === 'fishaudio');
  assert.equal(fish.baseUrl, 'https://api.fish.audio'); assert.equal(fish.group, undefined);
  assert.doesNotMatch(child.stdout, /synthetic-stdio-(cn|global)-secret/);
}, false));
