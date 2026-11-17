import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, symlink, stat } from 'node:fs/promises';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';
import { execute, pluginRoot } from '../hyperframes.ts';
import { verificationBinaries } from '../scripts/verify-export.ts';
import { AssetLibrary, assetHash } from '../gateway/asset-library.ts';
import { ModelGateway, gatewayFor } from '../gateway/service.ts';
import { assetOperation } from '../gateway/asset-operations.ts';
import { AssetConversations, type AssetAgentRpc } from '../gateway/asset-chat.ts';
import { Phase1Service } from '../phase1.ts';

async function image(dir: string, name = 'image.png', color = 'red') {
  const file = path.join(dir, name);
  const result = await execute(verificationBinaries().ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=32x24`, '-frames:v', '1', '-y', file], dir, 20_000);
  assert.equal(result.code, 0, result.stderr); return file;
}
const agents = async () => [{ id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'ready' }];
const until = async (predicate: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Timed out'); };

test('missing media tools reject library generation before invoking the model and preserve idempotency', () => fixture(async store => {
  const original = process.env.HYPERFRAMES_FFPROBE_PATH;
  process.env.HYPERFRAMES_FFPROBE_PATH = path.join(store.directory, 'missing-ffprobe');
  let calls = 0;
  const gateway = new ModelGateway(store, { detect: agents, codex: async () => { calls++; return Buffer.alloc(0); } });
  try {
    const input = { modality: 'image' as const, model: 'codex:image-generation', prompt: 'A lake', library: {}, idempotencyKey: 'missing-media' };
    const job = await gateway.submit(input);
    await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
    const failed = await gateway.getJob(job.id);
    assert.equal(failed.state, 'failed'); assert.match(failed.error!, /ASSET_MEDIA_RUNTIME_NOT_READY.*ffprobe/);
    assert.equal(calls, 0); assert.equal((await new AssetLibrary(store).list()).total, 0);
    assert.equal((await gateway.submit(input)).id, job.id);
    await gateway.tick(); assert.equal(calls, 0);
  } finally {
    await gateway.close();
    if (original === undefined) delete process.env.HYPERFRAMES_FFPROBE_PATH; else process.env.HYPERFRAMES_FFPROBE_PATH = original;
  }
}, false));

test('immutable upload versions, content-based receipts, filters and reversible trash survive reopening', () => fixture(async store => {
  const library = new AssetLibrary(store), first = await image(store.directory), duplicate = path.join(store.directory, 'copy.png');
  await writeFile(duplicate, await readFile(first));
  const a = await library.importFile(first, { requestId: 'upload', name: 'Landscape' });
  assert.equal((await library.importFile(duplicate, { requestId: 'upload', name: 'Landscape' })).id, a.id);
  assert.equal((await library.list()).total, 1);
  const old = await library.resolve({ assetId: a.id, versionId: a.currentVersionId });
  const second = await image(store.directory, 'second.png', 'blue');
  await assert.rejects(library.importFile(second, { requestId: 'upload', name: 'Landscape' }), /REQUEST_ID_CONFLICT/);
  const b = await library.importFile(second, { requestId: 'edit', name: 'Landscape', assetId: a.id, parentVersionId: a.currentVersionId });
  assert.equal(b.versions.length, 2); assert.equal(b.versions[1].parentVersionId, a.currentVersionId);
  assert.deepEqual(await readFile(old.filename), await readFile(first));
  assert.equal((await library.list({ modality: 'video' })).total, 0);
  assert.equal((await library.list({ source: 'upload', query: 'land' })).total, 1);
  await library.update(a.id, { trashed: true }); assert.equal((await library.list()).total, 0); assert.equal((await library.list({ trash: true })).total, 1);
  await assert.rejects(library.resolve({ assetId: a.id, versionId: a.currentVersionId }), /UNAVAILABLE/);
  await library.update(a.id, { trashed: false, currentVersionId: a.currentVersionId });
  assert.equal((await new AssetLibrary(store).get(a.id)).versions.length, 2);
  assert.equal((await stat(old.filename)).mode & 0o777, 0o600);
  await assert.rejects(library.get('../outside'), /NOT_FOUND/);
  await symlink(first, path.join(store.directory, 'linked.png'));
  await assert.rejects(library.importFile(path.join(store.directory, 'linked.png'), { requestId: 'link', name: 'link' }));
  await writeFile(path.join(store.directory, 'fake.png'), '<script>bad</script>');
  await assert.rejects(library.importFile(path.join(store.directory, 'fake.png'), { requestId: 'fake', name: 'fake' }), /not readable/);
}, false));

test('workspace generation keeps job identity and pinned references without requiring a project', () => fixture(async store => {
  const original = await image(store.directory), bytes = await readFile(original); let calls = 0;
  const gateway = new ModelGateway(store, { detect: agents, codex: async () => { calls++; return bytes; } });
  const input = { modality: 'image' as const, model: 'codex:image-generation', prompt: 'A lake\nAt sunrise', library: {}, idempotencyKey: 'generate' };
  const job = await gateway.submit(input); assert.equal(job.projectId, undefined);
  assert.equal((await gateway.submit(input)).id, job.id);
  await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
  const completed = await gateway.getJob(job.id); assert.equal(completed.state, 'completed', completed.error); assert.equal(calls, 1);
  const reference = completed.libraryAssets![0], asset = await new AssetLibrary(store).get(reference.assetId);
  assert.equal(asset.versions[0].prompt, 'A lake\nAt sunrise'); assert.equal(asset.name, 'A lake At sunrise');
  const edited = await gateway.submit({ ...input, idempotencyKey: 'edit', library: { assetId: asset.id, parentVersionId: reference.versionId, references: [reference] } });
  await new AssetLibrary(store).update(asset.id, { trashed: true });
  await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
  assert.equal((await gateway.getJob(edited.id)).state, 'completed');
  assert.ok((await new AssetLibrary(store).get(asset.id)).trashedAt, 'A running job preserves trash state and retains its paid output');
  const versions = (await new AssetLibrary(store).get(asset.id)).versions;
  assert.equal(versions.length, 2); assert.deepEqual(versions[1].references, [reference]);
  assert.equal((await gateway.submit(input)).id, job.id); assert.equal(calls, 2);
  await gateway.close();
}, false));

test('asset HTTP uploads are replayable and media supports byte ranges; project imports pin independent copies', () => fixture(async store => {
  const source = await image(store.directory), bytes = await readFile(source), fetch = transport(store);
  const upload = () => fetch('/motion-api/assets/upload?requestId=browser-upload', { method: 'POST', body: new Blob([bytes]), headers: { 'X-File-Name': encodeURIComponent('My image.png') } });
  const response = await upload(); assert.equal(response.status, 200, await response.clone().text());
  const { asset } = await response.json(); assert.equal((await (await upload()).json()).asset.id, asset.id);
  const url = `/motion-api/assets/${asset.id}/versions/${asset.currentVersionId}/file`;
  const range = await fetch(url, { headers: { Range: 'bytes=0-7' } }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8));
  const download = await fetch(url + '?download=1'); assert.match(download.headers.get('content-disposition')!, /attachment/);
  const invalid = await fetch(url, { headers: { Range: 'bytes=999999-' } }); assert.equal(invalid.status, 416);
  const service = new Phase1Service(store, pluginRoot, { origin: () => 'http://localhost:4173', nativeUrl: () => undefined, openProject: async () => {}, mutation: async task => task(), cancel: async () => {} });
  const project = await service.call('openmotion_create_project', { requestId: 'project', projectType: 'natural_language', title: 'Film', requirements: 'A silent film' });
  const imported = await service.call('openmotion_assets', { action: 'import_to_project', projectId: project.projectId, requestId: 'import', assetId: asset.id, versionId: asset.currentVersionId });
  assert.equal(imported.status, 'completed', JSON.stringify(imported)); assert.equal(imported.appliedToTimeline, false);
  const copied = path.join(store.projectDirectoryFor(project.projectId), imported.items[0].path);
  await new AssetLibrary(store).update(asset.id, { trashed: true });
  assert.deepEqual(await readFile(copied), bytes);
}, false));

test('in-app Agent streams, confirms generation, persists threads, rejects duplicate turns and stops without resubmitting', () => fixture(async store => {
  const binaries: any[] = [];
  class FakeRpc {
    notify: (message: any) => void; sent: any[] = []; requests: any[] = [];
    constructor(_bin: string, _cwd: string, notify: (message: any) => void) { this.notify = notify; binaries.push(this); }
    async request(method: string, params: any) { this.requests.push({ method, params }); return method.startsWith('thread/') ? { thread: { id: 'codex-thread' } } : method === 'turn/start' ? { turn: { id: 'turn' } } : {}; }
    send(value: any) { this.sent.push(value); }
    close() {}
  }
  const chats = new AssetConversations(store, { resolve: async () => '/fake/codex', rpc: FakeRpc as unknown as typeof AssetAgentRpc });
  const chat = await chats.create(), input = { requestId: 'one', text: 'Make a lake image', model: 'fixture-model', reasoning: 'high' };
  assert.equal(chats.pending, 0);
  await chats.start(chat.id, input); await until(() => binaries[0]?.requests.some((r: any) => r.method === 'turn/start'));
  assert.equal(chats.pending, 1);
  const rpc = binaries[0];
  assert.equal(rpc.requests.find((r: any) => r.method === 'turn/start').params.effort, 'high');
  await assert.rejects(chats.start(chat.id, { requestId: 'invalid-effort', text: 'hello', reasoning: 'high' }), /Choose an Agent model/);
  assert.equal(rpc.requests.find((r: any) => r.method === 'thread/start').params.sandbox, 'read-only');
  assert.ok(rpc.requests.find((r: any) => r.method === 'thread/start').params.dynamicTools.some((tool: any) => tool.name === 'openmotion_assets_use'));
  rpc.notify({ method: 'item/agentMessage/delta', params: { itemId: 'message', delta: 'Creating an image.' } });
  assert.equal((await chats.get(chat.id)).messages.at(-1)?.text, 'Creating an image.');
  await assert.rejects(chats.start(chat.id, { ...input, requestId: 'two' }), /already working/);
  assert.equal((await chats.start(chat.id, input)).id, chat.id);
  rpc.notify({ id: 90, method: 'item/tool/call', params: { tool: 'openmotion_assets', callId: 'paid', arguments: { action: 'generate', requestId: 'agent-choice', model: 'codex:image-generation', modality: 'image', prompt: 'A lake' } } });
  await until(async () => (await chats.get(chat.id)).approvals.length === 1);
  assert.equal((await gatewayFor(store).listJobs()).length, 0);
  const approval = (await chats.get(chat.id)).approvals[0]; await chats.answer(chat.id, approval.id, false);
  await until(() => rpc.sent.some((r: any) => r.id === 90));
  assert.equal(rpc.sent.find((r: any) => r.id === 90).result.success, false);
  assert.equal((await gatewayFor(store).listJobs()).length, 0);
  const gateway = gatewayFor(store); gateway.options.detect = agents;
  gateway.options.codex = async () => readFile(await image(store.directory));
  rpc.notify({ id: 91, method: 'item/tool/call', params: { tool: 'openmotion_assets', callId: 'approved', arguments: { action: 'generate', requestId: 'proposed', model: 'codex:image-generation', modality: 'image', prompt: 'A lake' } } });
  await until(async () => (await chats.get(chat.id)).approvals.length === 1);
  await chats.answer(chat.id, (await chats.get(chat.id)).approvals[0].id, true);
  await until(() => rpc.sent.some((r: any) => r.id === 91));
  const toolResult = rpc.sent.find((r: any) => r.id === 91).result;
  assert.equal(toolResult.success, true, JSON.stringify(toolResult));
  const approvedJob = JSON.parse(toolResult.contentItems[0].text).job;
  assert.equal(approvedJob.library.conversationId, chat.id);
  await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
  assert.equal((await gateway.getJob(approvedJob.id)).state, 'completed');
  const pinned = (await gateway.getJob(approvedJob.id)).libraryAssets![0];
  rpc.notify({ id: 92, method: 'item/tool/call', params: { tool: 'openmotion_assets_use', arguments: { action: 'read', ...pinned } } });
  await until(() => rpc.sent.some((r: any) => r.id === 92));
  const viewed = rpc.sent.find((r: any) => r.id === 92).result;
  assert.equal(viewed.success, true);
  assert.ok(viewed.contentItems.some((item: any) => item.type === 'inputImage' && item.imageUrl.startsWith('data:image/png;base64,')));
  const tone = path.join(store.directory, 'chat-audio.wav');
  assert.equal((await execute(verificationBinaries().ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.2', tone], store.directory)).code, 0);
  const audio = await new AssetLibrary(store).importFile(tone, { requestId: 'chat-audio', name: 'Audio' });
  rpc.notify({ id: 93, method: 'item/tool/call', params: { tool: 'openmotion_assets_use', arguments: { action: 'read', assetId: audio.id, versionId: audio.currentVersionId } } });
  await until(() => rpc.sent.some((r: any) => r.id === 93));
  assert.ok(rpc.sent.find((r: any) => r.id === 93).result.contentItems.some((item: any) => item.type === 'inputAudio' && item.audioUrl.startsWith('data:audio/wav;base64,')));
  assert.doesNotMatch(JSON.stringify((await chats.get(chat.id)).messages), /base64|"data":/);
  rpc.notify({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await until(() => !chats.active.size);
  assert.equal(chats.pending, 0);
  await chats.start(chat.id, { requestId: 'follow-up', text: 'Try another idea' });
  await until(() => binaries[1]?.requests.some((r: any) => r.method === 'turn/start'));
  assert.equal(binaries[1].requests.find((r: any) => r.method === 'thread/resume').params.threadId, 'codex-thread');
  assert.equal((await chats.start(chat.id, input)).id, chat.id);
  await assert.rejects(chats.start(chat.id, { ...input, text: 'Different paid work' }), /REQUEST_ID_CONFLICT/);
  await chats.stop(chat.id); assert.equal((await chats.get(chat.id)).state, 'cancelled');
  await chats.start(chat.id, { requestId: 'follow-up', text: 'Try another idea' }); assert.equal(binaries.length, 2);
  await chats.start(chat.id, input);
  const restarted = new AssetConversations(store, { resolve: async () => { throw new Error('Replay must not need Codex'); } });
  const replay = await restarted.start(chat.id, input);
  assert.equal(replay.messages.filter(message => message.role === 'user').length, 2);
  assert.equal(replay.requestReceipts?.length, 2);
  await assert.rejects(restarted.start(chat.id, { ...input, text: 'Different paid work' }), /REQUEST_ID_CONFLICT/);
  assert.equal(binaries.length, 2);
  await chats.close(); await gatewayFor(store).close();
}, false));

test('legacy conversation receipts survive new turns and replay after references are trashed', () => fixture(async store => {
  const library = new AssetLibrary(store), asset = await library.importFile(await image(store.directory), { requestId: 'reference', name: 'Reference' });
  let launches = 0;
  class FakeRpc {
    constructor() { launches++; }
    async request(method: string) { return method.startsWith('thread/') ? { thread: { id: 'legacy-thread' } } : method === 'turn/start' ? { turn: { id: 'turn' } } : {}; }
    send() {}
    close() {}
  }
  const chats = new AssetConversations(store, { resolve: async () => '/fake/codex', rpc: FakeRpc as unknown as typeof AssetAgentRpc });
  try {
    const chat = await chats.create(), input = { requestId: 'legacy', text: 'Use this reference', references: [{ assetId: asset.id, versionId: asset.currentVersionId }] };
    await writeFile(await chats.file(chat.id), JSON.stringify({ ...chat, lastRequestId: input.requestId, lastRequestHash: assetHash(input) }));
    await chats.start(chat.id, { requestId: 'next', text: 'A new turn' });
    await until(() => launches === 1);
    await chats.stop(chat.id);
    await library.update(asset.id, { trashed: true });
    const restarted = new AssetConversations(store, { resolve: async () => null });
    assert.equal((await restarted.start(chat.id, input)).requestReceipts?.length, 2);
    await assert.rejects(restarted.start(chat.id, { ...input, text: 'Changed legacy input' }), /REQUEST_ID_CONFLICT/);
    assert.equal(launches, 1);
  } finally { await chats.close(); }
}, false));
