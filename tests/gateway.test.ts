import test from 'node:test';
import https from 'node:https';
import { Readable } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import { mediaBytes } from './media-fixtures.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, readFile, stat, writeFile, mkdir, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';
import { ModelGateway, gatewayFor } from '../gateway/service.ts';
import { classifyModel, discoverModels, normalizeModels } from '../gateway/catalog.ts';
import { apiJson, downloadMedia, isPublicAddress, mediaType, providerOrigin, publicProviderFetch, resolvePublicAddresses, type Fetcher } from '../gateway/network.ts';
import { publicBrandAddress, brandWebsite } from '../gateway/brand-network.ts';
import { callTool } from '../mcp.ts';
import { createTracker, validProperties, type PendingEvent } from '../tracking/core.ts';
import { omEvents, studioEvents } from '../tracking/events.ts';
import type { Agent } from '../shared/gateway.ts';
import { detectAgents, generateCodexImage } from '../gateway/agents.ts';
import { AssetConversations, type AssetAgentRpc } from '../gateway/asset-chat.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
test('Codex adapter retains service authorization failures, imports a fresh raster and rejects references or symlinks', { skip: process.platform === 'win32' }, () => fixture(async store => {
  const bin = path.join(store.directory, 'fixture-codex'), previous = process.env.CODEX_BIN;
  const script = async (body: string) => { await writeFile(bin, `#!${process.execPath}\n${body}\n`); await chmod(bin, 0o700); };
  const work = path.join(store.directory, 'codex-work'); await mkdir(work);
  const reference = path.join(work, 'reference.png'); await writeFile(reference, png);
  process.env.CODEX_BIN = bin;
  try {
    await script(`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Image generation failed: 401 Unauthorized, personal engine key required'}})+'\\n'); });`);
    await assert.rejects(generateCodexImage('Edit sky', work, new AbortController().signal, reference), /CODEX_IMAGE_PROXY_AUTH_REQUIRED.*model_provider/);
    await script(`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'401 Unauthorized authentication_error'}})+'\\n'); });`);
    await assert.rejects(generateCodexImage('Edit sky', work, new AbortController().signal, reference), error => {
      assert.match(String(error), /CODEX_IMAGE_AUTH_REQUIRED.*active Codex provider/);
      assert.doesNotMatch(String(error), /PROXY_AUTH_REQUIRED|missing or expired/); return true;
    });
    await script(`process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('image generation failed: 401 Unauthorized, personal engine '); setTimeout(() => process.stderr.write('key required\\n'), 10); });`);
    await assert.rejects(generateCodexImage('Edit sky', work, new AbortController().signal, reference), /CODEX_IMAGE_PROXY_AUTH_REQUIRED/);
    await script(`process.stdin.resume(); process.stdin.on('end', () => { console.error('image generation failed: upstream unavailable Bearer test-secret sk-private'); });`);
    await assert.rejects(generateCodexImage('Edit sky', work, new AbortController().signal, reference), error => {
      assert.match(String(error), /upstream unavailable/); assert.doesNotMatch(String(error), /test-secret|sk-private/); return true;
    });
    await script(`const fs = require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => { fs.writeFileSync('result.webp', Buffer.from('${png.toString('base64')}', 'base64')); });`);
    assert.deepEqual(await generateCodexImage('Edit sky', work, new AbortController().signal, reference), png);
    await script(`process.stdin.resume();`);
    await assert.rejects(generateCodexImage('Edit sky', work, new AbortController().signal, reference), /no generated image/);
    await script(`require('node:fs').symlinkSync(${JSON.stringify(reference)}, 'image.png'); process.stdin.resume();`);
    await assert.rejects(generateCodexImage('Edit sky', work, new AbortController().signal, reference));
    const controller = new AbortController(); controller.abort(new Error('Cancelled fixture'));
    await assert.rejects(generateCodexImage('Edit sky', work, controller.signal, reference), /Cancelled fixture/);
  } finally { if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; }
}, false));

test('Codex media detection, image generation and asset chat use the newer bundled CLI', { timeout: 10_000 }, t => fixture(async store => {
  const windows = process.platform === 'win32';
  const standalone = path.join(store.directory, windows ? 'codex.cmd' : 'codex');
  const bundled = path.join(store.directory, 'bundled codex.cmd');
  const bundledScript = path.join(store.directory, 'bundled.cjs');
  const work = path.join(store.directory, 'codex-work');
  await mkdir(work);
  const staleCli = windows ? String.raw`@"%~dp0\standalone.cjs" %*` : `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'codex-cli 0.99.0'
else
  exit 1
fi
`;
  await writeFile(standalone, staleCli, { mode: 0o700 });
  if (windows) await writeFile(path.join(store.directory, 'standalone.cjs'), "if (process.argv[2] === '--version') console.log('codex-cli 0.99.0'); else process.exitCode = 1;");
  await writeFile(bundled, String.raw`@"%~dp0\bundled.cjs" %*`, { mode: 0o700 });
  await writeFile(bundledScript, `
const [command, arg] = process.argv.slice(2);
if (command === '--version') console.log('codex-cli 0.100.0');
else if (command === 'login' && arg === 'status') console.log('Logged in');
else if (command === 'features' && arg === 'list') console.log('image_generation stable true');
else if (command === 'exec' && arg === '--help') console.log('--ephemeral');
else if (command === 'exec' && arg === '--ephemeral') {
  process.stdin.resume();
  process.stdin.on('end', () => require('node:fs').writeFileSync('image.png', Buffer.from('${png.toString('base64')}', 'base64')));
} else process.exitCode = 1;
`, { mode: 0o700 });

  const connections = new EventEmitter();
  class FakeRpc {
    readonly command: { bin: string; args: string[] };
    constructor(bin: string, _cwd: string, _onMessage: unknown, _onClose: unknown, args: string[]) {
      this.command = { bin, args };
    }
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'fixture-thread' } };
      if (method === 'turn/start') {
        connections.emit('started', this.command);
        return { turn: { id: 'fixture-turn' } };
      }
      return {};
    }
    send() {}
    close() {}
  }
  const chats = new AssetConversations(store, { rpc: FakeRpc as unknown as typeof AssetAgentRpc });
  const envKeys = ['PATH', 'CODEX_BIN', 'CODEX_APP_RUNTIME_CLI_PATH'] as const;
  const previous = envKeys.map(key => process.env[key]);
  process.env.PATH = store.directory;
  delete process.env.CODEX_BIN;
  process.env.CODEX_APP_RUNTIME_CLI_PATH = bundled;
  try {
    const codex = (await detectAgents()).find(agent => agent.id === 'codex');
    assert.equal(codex?.available, true, codex?.reason);
    assert.deepEqual(await generateCodexImage('A lake', work, t.signal), png);

    const chat = await chats.create();
    const [[command]] = await Promise.all([
      once(connections, 'started', { signal: t.signal }),
      chats.start(chat.id, { requestId: 'fixture-request', text: 'A lake' }),
    ]);
    assert.deepEqual(command, { bin: process.execPath, args: [bundledScript, 'app-server', '--listen', 'stdio://'] });
  } finally {
    for (const [index, key] of envKeys.entries()) {
      const before = previous[index];
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
    await chats.close();
  }
}, false));

const agents = async (): Promise<Agent[]> => [{ id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'ready' }];
const fetcher = (callback: (url: string, init: RequestInit) => unknown): Fetcher => (async (url, init = {}) => {
  const body = callback(String(url), init);
  return body instanceof Response ? body : Response.json(body);
}) as Fetcher;
async function finish(gateway: ModelGateway, id: string) {
  await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
  return gateway.getJob(id);
}

test('scoped projects keep one workspace gateway and its active task ownership', () => fixture(async store => {
  const gateway = gatewayFor(store);
  assert.equal(gatewayFor(store.forProject(store.projectId)), gateway);
  assert.equal(gatewayFor(store.forProject(store.projectId).forProject(store.projectId)), gateway);
}));

test('capabilities distinguish an installed Agent from a callable media adapter; unavailable routes do not fall back', () => fixture(async store => {
  const gateway = new ModelGateway(store, { detect: async () => [{ ...(await agents())[0], available: false, authenticated: false }] });
  const status = await gateway.status();
  assert.equal(status.agents[0].installed, true);
  assert.equal(status.providers.find(p => p.id === 'codex')!.available, false);
  await gateway.configureProvider('fal', { apiKey: 'test-only-key' });
  await gateway.setRoute('image', 'codex:image-generation');
  await assert.rejects(gateway.submit({ modality: 'image', prompt: 'lake' }), /unavailable/);
  await assert.rejects(gateway.setRoute('image', 'fal:fal-ai/kokoro/american-english'), /same modality/);
  const ready = await gateway.status();
  assert.equal(ready.providers.find(p => p.id === 'fal')!.verification, 'unverified');
  assert.doesNotMatch(JSON.stringify(ready), /test-only-key/);
  assert.equal((await stat(path.join(gateway.root, 'secrets.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(gateway.root)).mode & 0o777, 0o700);
}));

test('generation telemetry separates intent, committed jobs and saved assets across retries and cancellations', () => fixture(async store => {
  const events: PendingEvent[] = [];
  const tracking = createTracker({ registry: omEvents, entrypoint: 'worker', enabled: true, flushIntervalMs: 0,
    send: async batch => { events.push(...batch); return 'accepted'; } });
  const gateway = new ModelGateway(store, { tracking, detect: agents, codex: async () => png });
  const input = { modality: 'image' as const, prompt: 'private prompt', idempotencyKey: 'private-request-id' };
  try {
    const job = await gateway.submit(input);
    assert.equal((await gateway.submit(input)).id, job.id);
    await gateway.listJobs(); await gateway.getJob(job.id);
    await finish(gateway, job.id);
    for (const modality of ['video', 'audio'] as const) {
      await assert.rejects(gateway.submit({ modality, prompt: '' }));
    }
    const cancelled = await gateway.submit({ ...input, idempotencyKey: 'cancel' });
    await gateway.cancel(cancelled.id); await gateway.cancel(cancelled.id);
    gateway.options.codex = async () => Buffer.from('invalid image');
    const failed = await finish(gateway, (await gateway.submit({ ...input, idempotencyKey: 'fail' })).id);
    assert.equal(failed.state, 'failed');
    await tracking.flush();
    const fields = (name: string) => events.filter(e => e.event === name).map(e => e.properties);
    assert.deepEqual(fields('media_generation_requested').map(p => p.modality), ['image','image','video','audio','image','image']);
    assert.deepEqual(fields('media_generation_submitted').map(p => p.job_id), [job.id,cancelled.id,failed.id]);
    assert.deepEqual(fields('media_generation_result'), [
      { job_id: job.id, modality: 'image', job_state: 'completed', asset_count: 1 },
      { job_id: cancelled.id, modality: 'image', job_state: 'cancelled', asset_count: 0 },
      { job_id: failed.id, modality: 'image', job_state: 'failed', asset_count: 0 },
    ]);
    assert.ok(events.every(e => e.entrypoint === 'worker'));
    assert.doesNotMatch(JSON.stringify(events), /private prompt|private-request-id|assets\/generated/);
    assert.equal(validProperties(omEvents, 'media_generation_requested', { modality: 'other' }), false);
    assert.equal(validProperties(omEvents, 'media_generation_requested', { modality: 'image', prompt: 'hello' }), false);
    assert.ok(!('media_generation_result' in studioEvents));
    tracking.setEnabled(false);
    await finish(gateway, (await gateway.submit({ ...input, idempotencyKey: 'opt-out' })).id);
    assert.equal(tracking.pending(), 0);
  } finally { await gateway.close(); tracking.close(); }
}));

test('completed telemetry is recorded per modality after generated bytes reach the project', () => fixture(async store => {
  const events: PendingEvent[] = [];
  const tracking = createTracker({ registry: omEvents, entrypoint: 'worker', enabled: true, flushIntervalMs: 0,
    send: async batch => { events.push(...batch); return 'accepted'; } });
  const output = {
    image: png,
    video: await mediaBytes('video'),
    audio: await mediaBytes('audio'),
  };
  const models = { image: 'fal:fal-ai/flux/schnell', video: 'fal:fal-ai/wan/v2.2-a14b/text-to-video', audio: 'fal:fal-ai/kokoro/american-english' };
  let mode: keyof typeof output = 'image';
  const gateway = new ModelGateway(store, { tracking, detect: agents, pollMs: 1, download: async () => output[mode],
    fetcher: fetcher((url, init) => {
      if (init.method === 'POST') return { request_id: 'fixture', status_url: 'https://queue.fal.run/test/status', response_url: 'https://queue.fal.run/test/result' };
      if (url.endsWith('/status')) return { status: 'COMPLETED' };
      return { outputs: ['https://cdn.example/output'] };
    }) });
  try {
    await gateway.configureProvider('fal', { apiKey: 'test-only' });
    for (mode of ['image', 'video', 'audio'] as const) {
      const job = await gateway.submit({ modality: mode, prompt: 'test', model: models[mode] });
      const result = await finish(gateway, job.id);
      assert.equal(result.state, 'completed', result.error);
      assert.deepEqual(await readFile(path.join(store.projectDirectory, result.assets[0].path)), output[mode]);
      await tracking.flush();
      assert.deepEqual(events.splice(0).map(e => [e.event, e.properties]), [
        ['media_generation_requested', { modality: mode }],
        ['media_generation_submitted', { modality: mode, job_id: job.id }],
        ['media_generation_result', { modality: mode, job_id: job.id, job_state: 'completed', asset_count: 1 }],
      ]);
    }
  } finally { await gateway.close(); tracking.close(); }
}));

test('Codex generation persists actual bytes in the originating project after switching; idempotency survives configuration changes', () => fixture(async store => {
  let calls = 0;
  const gateway = new ModelGateway(store, { detect: agents, codex: async () => { calls++; return png; } });
  const input = { modality: 'image' as const, prompt: 'lake', parameters: { aspect_ratio: '16:9' }, idempotencyKey: 'one-image' };
  const queued = await gateway.submit(input);
  assert.equal((await gateway.submit(input)).id, queued.id);
  await assert.rejects(gateway.submit({ ...input, prompt: 'another' }), /Idempotency/);
  const nextId = randomUUID();
  await cp(store.projectDirectory, store.projectDirectoryFor(nextId), { recursive: true });
  await store.lock(() => store.selectProject(nextId, { id: nextId, title: 'Another project' }));
  const result = await finish(gateway, queued.id);
  assert.equal(result.state, 'completed', result.error); assert.equal(calls, 1);
  assert.equal(result.projectId, 'project'); assert.equal(result.assets[0].mimeType, 'image/png');
  assert.deepEqual(await readFile(path.join(store.projectDirectoryFor('project'), result.assets[0].path)), png);
  await assert.rejects(stat(path.join(store.projectDirectory, result.assets[0].path)), { code: 'ENOENT' });
  await gateway.configureProvider('codex', { enabled: false });
  assert.equal((await gateway.submit({ ...input, projectId: 'project' })).id, queued.id);
  await gateway.close();
}));

test('cancelled tasks do not import output, malformed media fails, interrupted tasks are never charged again', () => fixture(async store => {
  let release: (value: Buffer) => void = () => {};
  let calls = 0;
  const gateway = new ModelGateway(store, { detect: agents, codex: async () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const job = await gateway.submit({ modality: 'image', prompt: 'cancel' });
  await gateway.tick();
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
  await gateway.cancel(job.id);
  assert((await stat(path.join(gateway.root, 'work', job.id))).isDirectory(), 'the live worker owns cancellation cleanup');
  release(png);
  await Promise.all([...gateway.active.values()].map(task => task.done));
  assert.equal((await gateway.getJob(job.id)).state, 'cancelled');
  assert.deepEqual((await gateway.getJob(job.id)).assets, []);
  gateway.options.codex = async () => Buffer.from('<html>not an image</html>');
  const bad = await finish(gateway, (await gateway.submit({ modality: 'image', prompt: 'bad' })).id);
  assert.equal(bad.state, 'failed'); assert.match(bad.error!, /valid image/);
  const interrupted = await gateway.submit({ modality: 'image', prompt: 'interrupted' });
  await writeFile(path.join(gateway.root, 'jobs', interrupted.id + '.json'), JSON.stringify({ ...interrupted, state: 'running', workerPid: 99999999 }));
  await gateway.tick();
  assert.equal((await gateway.getJob(interrupted.id)).phase, 'interrupted');
  assert.equal(gateway.active.size, 0);
  await gateway.close();
}));

test('reference edits snapshot real project bytes; source changes and idempotent retries cannot change the reference', () => fixture(async store => {
  const source = path.join(store.projectDirectory, 'assets', 'reference.png');
  await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, png);
  let reference: string | undefined;
  const gateway = new ModelGateway(store, { detect: agents, codex: async (_prompt, _dir, _signal, image) => {
    reference = image; assert.ok(image); assert.deepEqual(await readFile(image), png); return png;
  } });
  const input = { modality: 'image' as const, prompt: 'golden sunset', referenceAsset: 'assets/reference.png', idempotencyKey: 'reference-edit' };
  const job = await gateway.submit(input);
  assert.equal(job.reference?.path, input.referenceAsset); assert.equal(job.reference?.sha256.length, 64);
  await writeFile(source, 'source changed after submission');
  assert.equal((await gateway.submit(input)).id, job.id);
  const result = await finish(gateway, job.id);
  assert.equal(result.state, 'completed', result.error);
  assert.equal(await readFile(source, 'utf8'), 'source changed after submission');
  assert.ok(reference); await assert.rejects(stat(reference), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(store.projectDirectory, result.assets[0].path)), png);
  await gateway.close();
}));

test('reference inputs enforce project boundary, image type, adapter support and queued cancellation cleanup', () => fixture(async store => {
  const source = path.join(store.projectDirectory, 'reference.png'); await writeFile(source, png);
  await writeFile(path.join(store.projectDirectory, 'fake.png'), '<html>not an image</html>');
  await symlink(source, path.join(store.projectDirectory, 'linked.png'));
  const gateway = new ModelGateway(store, { detect: agents });
  const input = { modality: 'image' as const, prompt: 'edit' };
  for (const referenceAsset of ['../reference.png', '/etc/passwd', 'fake.png', 'linked.png']) await assert.rejects(gateway.submit({ ...input, referenceAsset }));
  await gateway.configureProvider('fal', { apiKey: 'test-only-key' });
  await assert.rejects(gateway.submit({ ...input, referenceAsset: 'reference.png', model: 'fal:fal-ai/flux/schnell' }), /does not support reference/);
  const job = await gateway.submit({ ...input, referenceAsset: 'reference.png' });
  const snapshot = path.join(gateway.root, 'work', job.id, 'reference.png');
  assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
  await gateway.cancel(job.id); await assert.rejects(stat(snapshot), { code: 'ENOENT' });
  await gateway.close();
}));

test('fal uses returned queue URLs and provider-native voice input; auth rejection is redacted and disables availability', () => fixture(async store => {
  const seen: string[] = [];
  const gateway = new ModelGateway(store, { detect: agents, pollMs: 1, download: async () => png, fetcher: fetcher((url, init) => {
    seen.push(url); assert.equal(new Headers(init.headers).get('Authorization'), 'Key test-fal-secret');
    if (init.method === 'POST') {
      assert.equal(JSON.parse(init.body as string).prompt, 'forest');
      return { request_id: 'remote-1', status_url: 'https://queue.fal.run/fal-ai/flux/requests/remote-1/status', response_url: 'https://queue.fal.run/fal-ai/flux/requests/remote-1' };
    }
    if (url.endsWith('/status')) return { status: 'COMPLETED' };
    return { images: [{ url: 'https://cdn.example/generated.png' }] };
  }) });
  await gateway.configureProvider('fal', { apiKey: 'test-fal-secret' });
  const result = await finish(gateway, (await gateway.submit({ modality: 'image', prompt: 'forest', model: 'fal:fal-ai/flux/schnell' })).id);
  assert.equal(result.state, 'completed', result.error); assert.equal(seen.length, 3);
  assert.equal((await gateway.status()).providers.find(p => p.id === 'fal')!.verification, 'verified');
  gateway.options.fetcher = fetcher((_url, init) => {
    assert.equal(JSON.parse(init.body as string).prompt, 'Hello');
    return new Response('test-fal-secret private provider diagnostics', { status: 401 });
  });
  const failed = await finish(gateway, (await gateway.submit({ modality: 'audio', prompt: 'Hello', model: 'fal:fal-ai/kokoro/american-english' })).id);
  assert.equal(failed.state, 'failed'); assert.doesNotMatch(JSON.stringify(failed), /test-fal-secret|private provider diagnostics/);
  assert.equal((await gateway.status()).providers.find(p => p.id === 'fal')!.available, false);
  await gateway.configureProvider('fal', { apiKey: 'replacement' });
  assert.equal((await gateway.status()).providers.find(p => p.id === 'fal')!.verification, 'unverified');
  await gateway.close();
}));

test('Atlas submits and polls video, maps actual media, and refuses credentials inside arbitrary parameters', () => fixture(async store => {
  const mp4 = await mediaBytes('video');
  const gateway = new ModelGateway(store, { detect: agents, pollMs: 1, download: async () => mp4, fetcher: fetcher((url, init) => {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer atlas-secret');
    if (init.method === 'POST') { assert.ok(url.endsWith('/generateVideo')); assert.equal(JSON.parse(init.body as string).duration, 5); return { code: 200, data: { id: 'video-1' } }; }
    assert.ok(url.endsWith('/prediction/video-1')); return { code: 200, data: { status: 'completed', outputs: ['https://cdn.example/video.mp4'] } };
  }) });
  await gateway.configureProvider('atlascloud', { apiKey: 'atlas-secret' });
  const input = { modality: 'video' as const, prompt: 'lake', model: 'atlascloud:bytedance/seedance-2.0/text-to-video', parameters: { duration: 5 } };
  const result = await finish(gateway, (await gateway.submit(input)).id);
  assert.equal(result.state, 'completed', result.error); assert.equal(result.assets[0].mimeType, 'video/mp4');
  await assert.rejects(gateway.submit({ ...input, parameters: { api_key: 'secret' } }), /reserved/);
  await assert.rejects(gateway.registerModel({ provider: 'fal', modelId: '../keys', modality: 'image', label: 'bad', mode: 'text-to-image' }), /Invalid model/);
  await gateway.close();
}));

test('catalogue discovery classifies output rather than input and follows public pagination without credentials', async () => {
  assert.deepEqual(classifyModel('image-to-video'), { modality: 'video', mode: 'image-to-video' });
  assert.equal(classifyModel('image-to-text'), null);
  assert.equal(normalizeModels('fal', [{ endpoint_id: 'fal-ai/whisper', metadata: { category: 'speech-to-text' } }]).length, 0);
  let pages = 0;
  const models = await discoverModels('fal', 'image', fetcher((url, init) => {
    assert.equal(init.headers, undefined); pages++;
    if (pages === 1) return { models: [{ endpoint_id: 'fal-ai/edit', metadata: { category: 'image-to-image' } }], next_cursor: 'next' };
    assert.ok(url.includes('cursor=next'));
    return { models: [{ endpoint_id: 'fal-ai/video', metadata: { category: 'image-to-video' } }] };
  }));
  assert.equal(pages, 2); assert.deepEqual(models.map(m => m.modality), ['image', 'video']);
});

test('provider JSON stops reading at the response size cap', async () => {
  let pulled = 0, cancelled = false;
  const chunk = new Uint8Array(1024 * 1024).fill(120);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      // A buffering regression must finish draining and fail an assertion, not exhaust memory.
      if (pulled >= 32 * 1024 * 1024) { controller.close(); return; }
      pulled += chunk.length; controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  });
  const oversized: Fetcher = async () => new Response(stream, { status: 200 });
  await assert.rejects(apiJson(oversized, 'https://example.com/v1/models'), /exceeds 16 MB/);
  // A buffering implementation would drain the body; this one stops a chunk past the cap and cancels.
  assert.ok(pulled <= 18 * 1024 * 1024, `pulled ${pulled} bytes before rejecting`);
  assert.ok(cancelled, 'the reader is cancelled once the cap is passed');
  const small: Fetcher = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  assert.deepEqual(await apiJson(small, 'https://example.com/v1/models'), { ok: true });
  const bom: Fetcher = async () => new Response(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('{"ok":true}')]), { status: 200 });
  assert.deepEqual(await apiJson(bom, 'https://example.com/v1/models'), { ok: true });
});

test('production JSON transport stops before buffering oversized bodies and keeps media limits separate', async t => {
  let pulled = 0;
  const chunk = Buffer.alloc(512, 120);
  let response: Readable;
  t.mock.method(https, 'request', (_url: URL, _options: unknown, receive: (body: Readable) => void) => {
    pulled = 0;
    response = Object.assign(new Readable({
      read() {
        if (pulled >= 20 * 1024) { this.push(null); return; }
        pulled += chunk.length; this.push(chunk);
      },
    }), { statusCode: 200, headers: {} });
    const request = new EventEmitter() as EventEmitter & { setTimeout: () => unknown; end: () => void };
    request.setTimeout = () => request;
    request.end = () => receive(response);
    return request;
  });
  await assert.rejects(apiJson(publicProviderFetch, 'https://8.8.8.8/v1/models', {}, { maxBytes: 1024 }), /Provider response exceeds/);
  assert.ok(response!.destroyed, 'the production transport destroys the oversized response');
  assert.ok(pulled <= 2048, `transport buffered ${pulled} bytes before rejecting`);
  const media = await publicProviderFetch('https://8.8.8.8/media');
  assert.equal((await media.arrayBuffer()).byteLength, 20 * 1024, 'direct media traffic retains its larger cap');
});

test('JSON reader honors per-request size limits', async () => {
  const body = JSON.stringify({ text: 'x'.repeat(1024) });
  const source: Fetcher = async () => new Response(body);
  assert.deepEqual(await apiJson(source, 'https://example.com', {}, { maxBytes: 2048 }), JSON.parse(body));
  await assert.rejects(apiJson(source, 'https://example.com', {}, { maxBytes: 512 }), /Provider response exceeds/);
});

test('ADTS AAC output is identified as AAC, not as the MP3 whose sync bits it shares', () => {
  const frame = (header: string) => Buffer.concat([Buffer.from(header, 'hex'), Buffer.alloc(32)]);
  // MPEG-4 AAC-LC with and without CRC, then MPEG-2 AAC.
  for (const header of ['fff15080', 'fff05080', 'fff95080']) assert.deepEqual(mediaType(frame(header), 'audio'), { mimeType: 'audio/aac', extension: 'aac' });
  // MPEG-1 Layer III, MPEG-2 Layer III and an ID3v2 tag stay MP3.
  for (const header of ['fffb9064', 'fff38064', '49443304']) assert.deepEqual(mediaType(frame(header), 'audio'), { mimeType: 'audio/mpeg', extension: 'mp3' });
});

test('media import rejects non-public URLs, unexpected file signatures and wrong output modalities', async () => {
  for (const url of ['http://example.com/file.png', 'https://127.0.0.1/file.png', 'https://user:pass@example.com/file.png', 'https://[::1]/image']) await assert.rejects(downloadMedia(url, new AbortController().signal));
  assert.throws(() => mediaType(png, 'video'), /valid video/);
  assert.deepEqual(await downloadMedia('data:image/png;base64,' + png.toString('base64'), new AbortController().signal), png);
});

test('gateway and brand capture share one public-address rule', () => {
  for (const host of ['[2002:c000:204::1]', '[2001::1]', '[2001:db8::1]', '[2001:0:53aa:64c:0:0:0:1]', '198.18.0.1', '192.0.2.1', '192.0.0.1', '169.254.1.1'])
    assert.throws(() => providerOrigin(`https://${host}/`), /public HTTPS gateway origin/);
  for (const host of ['[2606:4700:4700::1111]', '192.0.78.1', '203.0.113.9'])
    assert.ok(providerOrigin(`https://${host}/`), host);
  for (const address of ['198.18.0.1', '192.0.2.1', '192.0.78.1', '2002:c000:204::1', '2001::1', '2001:db8::1', '10.0.0.1', '192.168.1.1', '2606:4700::1111'])
    assert.equal(publicBrandAddress(address), isPublicAddress(address), address);
  // brandWebsite resolves a concrete URL before capture, so it must keep working after the merge.
  assert.equal(brandWebsite('https://example.com'), 'https://example.com/');
  assert.throws(() => brandWebsite('https://127.0.0.1/'), /public HTTPS website/);
});

test('HTTP and MCP share settings, routes and job state without exposing keys or project data paths', () => fixture(async store => {
  const request = transport(store), gateway = gatewayFor(store); gateway.options.detect = agents;
  const response = await request('/motion-api/models/providers/fal', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'http-secret' }) });
  assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /http-secret/);
  const capabilities = await callTool('openmotion_get_capabilities', {}, store) as Awaited<ReturnType<ModelGateway['status']>>;
  assert.equal(capabilities.providers.find(p => p.id === 'fal')!.configured, true);
  await callTool('openmotion_set_model_route', { modality: 'image', model: 'codex:image-generation' }, store);
  const status = await (await request('/motion-api/models/capabilities')).json();
  assert.equal(status.routes.image, 'codex:image-generation');
  const job = await gateway.submit({ modality: 'image', prompt: 'asset' });
  const read = await callTool('openmotion_get_generation', { jobId: job.id }, store) as { job: typeof job };
  assert.equal(read.job.id, job.id);
  const cancelled = await request(`/motion-api/generations/${job.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await cancelled.json()).job.state, 'cancelled');
  assert.equal((await request('/motion-api/generations', { method: 'POST', body: '{}' })).status, 503);
  assert.equal((await request('/model-gateway/secrets.json')).status, 404);
  await gateway.close();
}));

// A partial transfer is durable across manual recovery, not merely an in-memory retry.
test('account image download resumes verified bytes and refreshes URLs without persisting them', () => fixture(async store => {
  const { resumableDownload } = await import('../gateway/resumable-download.ts');
  const directory = path.join(store.directory, 'resume-test'); await mkdir(directory);
  const bytes = Buffer.alloc(1024 * 1024 + 100, 37), cut = 1024 * 1024;
  let reads = 0;
  const asset = async () => ({ assetId: 'original', mime: 'image/png', size: bytes.length, url: `https://media.example/image?secret=${++reads}` });
  const interrupted = () => {
    let pulled = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!pulled) { pulled = true; controller.enqueue(bytes.subarray(0, cut)); }
      else controller.error(new Error('connection reset with signed secret'));
    } }), { headers: { etag: '"one"', 'content-length': String(bytes.length) } });
  };
  const signal = new AbortController().signal, progress: any[] = [];
  await assert.rejects(resumableDownload(directory, asset, signal, async p => { progress.push(p); }, async () => interrupted(), 1), /original image/);
  const checkpoint = JSON.parse(await readFile(path.join(directory, 'image-download.json'), 'utf8'));
  assert.equal(checkpoint.bytes, cut); assert.doesNotMatch(JSON.stringify(checkpoint), /https|secret|url/i);
  const result = await resumableDownload(directory, asset, signal, async p => { progress.push(p); }, async (_url, init) => {
    const headers = new Headers(init.headers); assert.equal(headers.get('range'), `bytes=${cut}-`); assert.equal(headers.get('if-range'), '"one"');
    return new Response(bytes.subarray(cut), { status: 206, headers: { etag: '"one"', 'content-range': `bytes ${cut}-${bytes.length - 1}/${bytes.length}`, 'content-length': String(bytes.length - cut) } });
  });
  assert.deepEqual(result, bytes); assert.equal(reads, 2); assert.equal(progress.at(-1).receivedBytes, bytes.length);
}));

test('account image auto retry verifies Range and never appends changed or corrupted files', () => fixture(async store => {
  const { resumableDownload } = await import('../gateway/resumable-download.ts');
  const bytes = Buffer.alloc(80, 17), other = Buffer.alloc(80, 52), signal = new AbortController().signal;
  for (const mode of ['range', 'changed-etag', 'ignored-range', 'corrupt-file', 'wrong-range', 'range-not-satisfiable', 'no-etag', 'different-asset']) {
    const directory = path.join(store.directory, mode); await mkdir(directory);
    let call = 0;
    const asset = async () => ({ assetId: 'original', mime: 'image/png', size: bytes.length, url: 'https://media.example/original' });
    const broken = async () => {
      let read = false;
      return new Response(new ReadableStream({ pull(controller) { if (read) controller.error(new Error('broken')); else { read = true; controller.enqueue(bytes.subarray(0, 32)); } } }), { headers: mode === 'no-etag' ? {} : { etag: '"old"' } });
    };
    if (['corrupt-file', 'different-asset'].includes(mode)) {
      await assert.rejects(resumableDownload(directory, asset, signal, async () => {}, broken, 1));
      if (mode === 'corrupt-file') await writeFile(path.join(directory, 'image.partial'), Buffer.alloc(32, 99));
    }
    const expected = mode === 'changed-etag' || mode === 'ignored-range' || mode === 'different-asset' ? other : bytes;
    const result = await resumableDownload(directory, mode === 'different-asset' ? async () => ({ ...await asset(), assetId: 'replacement' }) : asset, signal, async () => {}, async (_url, init) => {
      call++;
      const range = new Headers(init.headers).get('range');
      if (call === 1 && !['corrupt-file', 'different-asset'].includes(mode)) return broken();
      if (mode === 'no-etag' || mode === 'corrupt-file' || mode === 'different-asset' || call === 3) {
        assert.equal(range, null, mode); return new Response(expected, { headers: { etag: '"new"' } });
      }
      assert.equal(range, 'bytes=32-', mode);
      if (mode === 'range-not-satisfiable') return new Response(null, { status: 416 });
      if (mode === 'ignored-range') return new Response(other, { headers: { etag: '"new"' } });
      return new Response(expected.subarray(32), { status: 206, headers: { etag: mode === 'changed-etag' ? '"new"' : '"old"',
        'content-range': `bytes ${mode === 'wrong-range' ? 31 : 32}-79/80` } });
    });
    assert.deepEqual(result, expected, mode);
  }
}));

test('resolvePublicAddresses resolves proxy Fake-IP (198.18.0.0/15) via public DNS while blocking private IPs', async () => {
  const signal = new AbortController().signal;
  let queried = 0;
  const resolved = await resolvePublicAddresses('media.example', signal, 'Generated media points to a non-public address', {
    lookup: async () => [{ address: '198.18.0.243', family: 4 }],
    publicDns: async () => { queried += 1; return [{ address: '142.251.35.91', family: 4 }]; },
  });
  assert.equal(resolved[0].address, '142.251.35.91');
  assert.equal(queried, 1);

  for (const literal of ['127.0.0.1', '198.18.0.1', '10.0.0.1']) {
    await assert.rejects(
      resolvePublicAddresses(literal, signal, 'Generated media points to a non-public address'),
      /non-public address/,
    );
  }
  await assert.rejects(
    resolvePublicAddresses('mixed.example', signal, 'Generated media points to a non-public address', {
      lookup: async () => [{ address: '198.18.0.243', family: 4 }, { address: '10.0.0.1', family: 4 }],
      publicDns: async () => [{ address: '142.251.35.91', family: 4 }],
    }),
    /non-public address/,
  );
  await assert.rejects(
    resolvePublicAddresses('spoofed.example', signal, 'Generated media points to a non-public address', {
      lookup: async () => [{ address: '198.18.0.243', family: 4 }],
      publicDns: async () => [{ address: '10.0.0.1', family: 4 }],
    }),
    /non-public address/,
  );
});

test('gateway runs up to 4 OpenDesign jobs concurrently while keeping BYOK and local codex jobs capped at 2', () => fixture(async store => {
  let inflightRemote = 0, peakRemote = 0;
  let inflightFal = 0, peakFal = 0;
  const resolvers: (() => void)[] = [];
  const falResolvers: (() => void)[] = [];
  const gateway = new ModelGateway(store, {
    detect: agents,
    pollMs: 1,
    download: async () => png,
    fetcher: (async (u, init = {}) => {
      const url = String(u);
      if (url.endsWith('/api/v1/media/models')) {
        return Response.json({ models: [{ model: 'seedream-5.0-flash', kind: 'image', capabilities: { edits: true } }] });
      }
      if (url.startsWith('https://queue.fal.run/') && init?.method === 'POST') {
        inflightFal++;
        peakFal = Math.max(peakFal, inflightFal);
        return new Promise<Response>(resolve => {
          falResolvers.push(() => {
            inflightFal--;
            resolve(Response.json({
              request_id: `fal-${falResolvers.length}`,
              status_url: `https://queue.fal.run/status/${falResolvers.length}`,
              response_url: `https://queue.fal.run/response/${falResolvers.length}`,
            }));
          });
        });
      }
      if (url.startsWith('https://queue.fal.run/status/')) return Response.json({ status: 'COMPLETED' });
      if (url.startsWith('https://queue.fal.run/response/')) return Response.json({ images: [{ url: 'https://cdn.example/out.png' }] });
      if (init?.method === 'POST' && url.endsWith('/images/generations')) {
        inflightRemote++;
        peakRemote = Math.max(peakRemote, inflightRemote);
        return new Promise<Response>(resolve => {
          resolvers.push(() => {
            inflightRemote--;
            resolve(Response.json({ task_id: `t-${resolvers.length}`, status: 'queued' }));
          });
        });
      }
      return Response.json({ status: 'succeeded', assets: [{ url: 'https://cdn.example/out.png' }] });
    }) as Fetcher,
  });
  try {
    await gateway.configureProvider('opendesign', { apiKey: 'test-key', baseUrl: 'https://cloud.example' });
    const remoteJobs = [];
    for (let i = 0; i < 6; i++) {
      remoteJobs.push(await gateway.submit({ modality: 'image', model: 'opendesign:seedream-5.0-flash', prompt: `Tile ${i}`, library: {} }));
    }
    await gateway.tick();
    while (resolvers.length < 4) await new Promise(r => setTimeout(r, 5));
    assert.equal(gateway.active.size, 4);
    assert.equal(peakRemote, 4);
    while (resolvers.length) resolvers.shift()!();
    await Promise.all([...gateway.active.values()].map(task => task.done));
    await gateway.tick();
    while (resolvers.length < 2) await new Promise(r => setTimeout(r, 5));
    assert.equal(gateway.active.size, 2);
    while (resolvers.length) resolvers.shift()!();
    await Promise.all([...gateway.active.values()].map(task => task.done));
    for (const job of remoteJobs) assert.equal((await gateway.getJob(job.id)).state, 'completed');

    // Non-OpenDesign BYOK providers (e.g. fal) stay capped at 2 concurrent workers.
    await gateway.configureProvider('fal', { apiKey: 'fal-test-key' });
    const falJobs = [];
    for (let i = 0; i < 4; i++) {
      falJobs.push(await gateway.submit({ modality: 'image', model: 'fal:fal-ai/flux/schnell', prompt: `Fal ${i}`, library: {} }));
    }
    await gateway.tick();
    while (falResolvers.length < 2) await new Promise(r => setTimeout(r, 5));
    assert.equal(gateway.active.size, 2);
    assert.equal(peakFal, 2);
    while (falResolvers.length) falResolvers.shift()!();
    await Promise.all([...gateway.active.values()].map(task => task.done));
    await gateway.tick();
    while (falResolvers.length < 2) await new Promise(r => setTimeout(r, 5));
    while (falResolvers.length) falResolvers.shift()!();
    await Promise.all([...gateway.active.values()].map(task => task.done));
    for (const job of falJobs) assert.equal((await gateway.getJob(job.id)).state, 'completed');

    // Local codex jobs also stay capped at 2 concurrent workers.
    let inflightLocal = 0, peakLocal = 0;
    const localResolvers: (() => void)[] = [];
    gateway.options.codex = async () => {
      inflightLocal++;
      peakLocal = Math.max(peakLocal, inflightLocal);
      await new Promise<void>(resolve => localResolvers.push(() => { inflightLocal--; resolve(); }));
      return png;
    };
    const localJobs = [];
    for (let i = 0; i < 4; i++) {
      localJobs.push(await gateway.submit({ modality: 'image', model: 'codex:image-generation', prompt: `Local ${i}`, library: {} }));
    }
    await gateway.tick();
    while (localResolvers.length < 2) await new Promise(r => setTimeout(r, 5));
    assert.equal(gateway.active.size, 2);
    assert.equal(peakLocal, 2);
    while (localResolvers.length) localResolvers.shift()!();
    await Promise.all([...gateway.active.values()].map(task => task.done));
    await gateway.tick();
    while (localResolvers.length < 2) await new Promise(r => setTimeout(r, 5));
    while (localResolvers.length) localResolvers.shift()!();
    await Promise.all([...gateway.active.values()].map(task => task.done));
    for (const job of localJobs) assert.equal((await gateway.getJob(job.id)).state, 'completed');
  } finally { await gateway.close(); }
}));

test('OpenDesign model discovery hydrates fallback routing traits, prefers server-published metadata, indexes tags, and never fabricates unknown models', () => fixture(async store => {
  const gateway = new ModelGateway(store, {
    detect: async () => [],
    fetcher: (async (u) => {
      const url = String(u);
      if (url.endsWith('/api/v1/media/models')) {
        return Response.json({
          models: [
            // Existing model without server routing metadata -> hydrated from fallback profile.
            { model: 'gpt-image-2.6-flare', kind: 'image', capabilities: { edits: true, background: ['auto', 'transparent', 'opaque'] } },
            // Existing model WITH server-published routing metadata -> server fields take precedence,
            // and an invalid top-level tier falls through to a valid nested capabilities.tier.
            {
              model: 'seedream-5.5',
              kind: 'image',
              tier: 'ultra-invalid',
              best_for: ['Server Tag', 'editorial-key-art'],
              description: 'Server-published Seedream description.',
              capabilities: { edits: true, tier: 'balanced' },
            },
            // Existing model WITH explicit empty server metadata -> stays cleared (never overwritten by fallback).
            {
              model: 'gpt-image-2.6-sunburst',
              kind: 'image',
              best_for: [],
              description: '',
              capabilities: { edits: true },
            },
            // Brand-new unseen model WITH server-published metadata under capabilities -> flows through untouched.
            {
              model: 'gpt-image-3-pro',
              kind: 'image',
              capabilities: {
                edits: true,
                max_input_images: 12,
                tier: 'flagship',
                best_for: ['3d-concept', 'sprite-sheets'],
                description: 'Next-gen image model published directly by AMR.',
              },
            },
            // Brand-new unseen model WITHOUT server routing metadata -> no fabricated traits.
            { model: 'future-mystery-v9', kind: 'video', capabilities: {} },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as Fetcher,
  });
  try {
    await gateway.configureProvider('opendesign', { apiKey: 'test-key', baseUrl: 'https://cloud.example' });
    const listed = await gateway.listModels({ provider: 'opendesign', refresh: true });
    const byId = new Map(listed.models.map(model => [model.modelId, model]));

    const flare = byId.get('gpt-image-2.6-flare')!;
    assert.equal(flare.tier, 'fast');
    assert(flare.bestFor?.includes('transparent-cutout'));
    assert(flare.description && flare.description.length > 0);

    const seedream = byId.get('seedream-5.5')!;
    assert.equal(seedream.tier, 'balanced');
    assert.deepEqual(seedream.bestFor, ['server-tag', 'editorial-key-art']);
    assert.equal(seedream.description, 'Server-published Seedream description.');

    const sunburst = byId.get('gpt-image-2.6-sunburst')!;
    assert.equal(sunburst.tier, 'flagship');
    assert.deepEqual(sunburst.bestFor, []);
    assert.equal(sunburst.description, '');

    const nextGen = byId.get('gpt-image-3-pro')!;
    assert.equal(nextGen.tier, 'flagship');
    assert.deepEqual(nextGen.bestFor, ['3d-concept', 'sprite-sheets']);
    assert.equal(nextGen.description, 'Next-gen image model published directly by AMR.');

    const unseen = byId.get('future-mystery-v9')!;
    assert.equal(unseen.tier, undefined);
    assert.equal(unseen.bestFor, undefined);
    assert.equal(unseen.description, undefined);

    // Search indexes tier and bestFor tags (both fallback and server-published), and respects server-cleared tags.
    const zhSpeech = await gateway.listModels({ provider: 'opendesign', query: 'zh-speech' });
    assert.equal(zhSpeech.models[0]?.modelId, 'byteplus-tts-2');
    const spriteSheets = await gateway.listModels({ provider: 'opendesign', query: 'sprite-sheets' });
    assert.equal(spriteSheets.models[0]?.modelId, 'gpt-image-3-pro');
    const transparentCutout = await gateway.listModels({ provider: 'opendesign', modality: 'image', query: 'transparent-cutout' });
    assert(transparentCutout.models.some(m => m.modelId === 'gpt-image-2.6-flare'));
    assert(!transparentCutout.models.some(m => m.modelId === 'gpt-image-2.6-sunburst'));

    // Non-OpenDesign models do not receive OpenDesign fallback traits.
    const falModels = await gateway.listModels({ provider: 'fal' });
    assert(falModels.models.length > 0);
    assert(falModels.models.every(m => m.tier === undefined && m.bestFor === undefined));
  } finally { await gateway.close(); }
}));
