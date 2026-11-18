import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.ts';
import { VoiceLibrary } from '../gateway/voice-library.ts';
import { assetOperation } from '../gateway/asset-operations.ts';
import { ModelGateway, gatewayFor } from '../gateway/service.ts';
import { AssetLibrary } from '../gateway/asset-library.ts';
import { mediaBytes } from './media-fixtures.ts';
import { fishAudio, miniMaxSpeech } from '../gateway/speech-providers.ts';
import { providerDirectory } from '../gateway/settings.ts';
import { getWorkflow } from '../shared/workflow.ts';

const input = { requestId: 'voice-one', name: 'Narrator', provider: 'fishaudio' as const, externalId: 'my-private-voice', kind: 'cloned' as const };
test('voice receipts, revisions, source bindings and reversible trash survive reopening without leaking keys', () => fixture(async store => {
  const library = new VoiceLibrary(store);
  const first = await library.add(input);
  assert.equal(first.connection, 'required');
  assert.equal((await library.add(input)).id, first.id);
  await assert.rejects(library.add({ ...input, name: 'changed' }), /REQUEST_ID_CONFLICT/);
  await library.connections.configure('fishaudio', { apiKey: 'synthetic-first-key' });
  assert.equal((await library.get(first.id)).connection, 'changed');
  await assert.rejects(library.resolve({ voiceId: first.id, revision: 1 }, 'fishaudio'), /Check this voice/);
  const listed = new VoiceLibrary(store, async (url, options) => {
    assert.equal(String(url), 'https://api.fish.audio/model?self=true&page_size=100&page_number=1');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer synthetic-first-key');
    return Response.json({ items: [{ _id: input.externalId, title: 'Narrator' }], has_more: false });
  });
  const checked = await listed.check(first.id, 1);
  assert.equal(checked.access, 'listed'); assert.equal(checked.connection, 'ready');
  const ref = { voiceId: checked.id, revision: checked.revision };
  assert.equal((await library.resolve(ref, 'fishaudio')).externalId, input.externalId);
  await assert.rejects(library.resolve(ref, 'minimax-speech'), /same provider/);
  assert.doesNotMatch(JSON.stringify(await library.list()), /synthetic-first-key|scope|receipt/);
  const updated = await library.update(checked.id, checked.revision, { name: 'Updated narrator' });
  await assert.rejects(library.update(checked.id, checked.revision, { name: 'Stale writer' }), /VOICE_CHANGED/);
  const removed = await library.update(updated.id, updated.revision, { trashed: true });
  assert.equal((await library.list()).length, 0); assert.equal((await library.list(true)).length, 1);
  await assert.rejects(library.resolve({ voiceId: removed.id, revision: removed.revision }, 'fishaudio'), /VOICE_CHANGED/);
  await library.update(removed.id, removed.revision, { trashed: false });
  assert.equal((await new VoiceLibrary(store).list()).length, 1);
  await library.connections.configure('fishaudio', { apiKey: 'synthetic-replacement-key' });
  assert.equal((await library.get(first.id)).connection, 'changed');
  await assert.rejects(library.get('../outside'), /VOICE_NOT_FOUND/);
  await assert.rejects(library.update(first.id, 4, { preview: { assetId: first.id, versionId: first.id } }), /ASSET_NOT_FOUND/);
}, false));

test('MiniMax missing list entries stay unverified and changed connections cannot accept stale catalogue responses', () => fixture(async store => {
  const library = new VoiceLibrary(store, async (url, options) => {
    assert.equal(String(url), 'https://api.minimax.io/v1/get_voice');
    assert.deepEqual(JSON.parse(String(options?.body)), { voice_type: 'all' });
    return Response.json({ base_resp: { status_code: 0 }, system_voice: [], voice_cloning: [], voice_generation: [] });
  });
  await library.connections.configure('minimax-speech', { apiKey: 'mini-test' });
  const voice = await library.add({ ...input, requestId: 'mini', provider: 'minimax-speech' });
  const checked = await library.check(voice.id, 1);
  assert.equal(checked.access, 'not_listed'); assert.equal(checked.connection, 'ready');
  const stale = new VoiceLibrary(store, async () => {
    await library.connections.configure('minimax-speech', { apiKey: 'another-account' });
    return Response.json({ base_resp: { status_code: 0 }, voice_cloning: [{ voice_id: voice.externalId }] });
  });
  await assert.rejects(stale.check(voice.id, checked.revision), /Connection changed/);
  assert.equal((await library.get(voice.id)).revision, checked.revision);
}, false));

test('UI and MCP asset dispatcher share voice records and speech job snapshots, rejecting cross-provider and conflicting options', () => fixture(async store => {
  const library = new VoiceLibrary(store);
  await library.connections.configure('fishaudio', { apiKey: 'voice-job-key' });
  const created = await assetOperation(store, { action: 'voice', voice: { command: 'add', ...input } });
  assert.equal((await assetOperation(store, { action: 'voice', voice: { command: 'get', voiceId: created.voice.id } })).voice.name, input.name);
  const gateway = new ModelGateway(store, { detect: async () => [] });
  try {
    const ref = { voiceId: created.voice.id, revision: 1 };
    const generation = { modality: 'audio' as const, mode: 'text-to-speech', prompt: 'My narration', model: 'fishaudio:s2-pro', library: {}, voiceRef: ref, idempotencyKey: 'speech-once' };
    const job = await gateway.submit(generation);
    assert.equal(job.voice?.externalId, input.externalId); assert.equal(job.parameters.voice, input.externalId);
    assert.equal((await gateway.submit(generation)).id, job.id);
    await library.connections.configure('minimax-speech', { apiKey: 'synthetic-cross-provider' });
    await assert.rejects(gateway.submit({ ...generation, idempotencyKey: 'cross-provider', model: 'minimax-speech:speech-2.8-hd' }), /same provider/);
    await assert.rejects(gateway.submit({ ...generation, idempotencyKey: 'conflicting-options', parameters: { voice: 'a-different-voice' } }), /conflict/);
    const directory = await providerDirectory(gateway);
    assert.deepEqual(directory.providers.find(p => p.id === 'fishaudio')?.kinds, ['audio']);
    assert.deepEqual(directory.providers.find(p => p.id === 'minimax-speech')?.kinds, ['audio']);
  } finally { await gateway.close(); }
}, false));

test('native speech adapters map the exact voice inputs, never retry paid submissions and reject envelope errors', async () => {
  const job: any = { modality: 'audio', prompt: 'Hello', model: { provider: 'minimax-speech', mode: 'text-to-speech', modelId: 's2-pro' }, parameters: { voice: 'chosen', speed: 1.2 } };
  const base = { key: 'test-key', signal: new AbortController().signal, progress: async () => {} };
  let calls = 0;
  const fish = await fishAudio.generate(job, { ...base, fetcher: async (url, init) => {
    calls++; assert.equal(String(url), 'https://api.fish.audio/v1/tts');
    const body = JSON.parse(String(init?.body)); assert.equal(body.reference_id, 'chosen'); assert.equal(body.text, 'Hello'); assert.equal(body.prosody.speed, 1.2);
    assert.equal(new Headers(init?.headers).get('model'), 's2-pro');
    return new Response(Buffer.from('audio bytes'), { headers: { 'Content-Type': 'audio/mpeg' } });
  } });
  assert.equal(fish[0].toString(), 'audio bytes'); assert.equal(calls, 1);
  const mini = await miniMaxSpeech.generate({ ...job, model: { ...job.model, modelId: 'speech-2.8-hd' } }, { ...base, fetcher: async (url, init) => {
    assert.equal(String(url), 'https://api.minimax.io/v1/t2a_v2');
    const body = JSON.parse(String(init?.body)); assert.deepEqual(body.voice_setting, { voice_id: 'chosen', speed: 1.2 }); assert.equal(body.output_format, 'hex');
    return Response.json({ base_resp: { status_code: 0 }, data: { audio: Buffer.from('audio').toString('hex') } });
  } });
  assert.equal(mini[0].toString(), 'audio');
  calls = 0;
  await assert.rejects(miniMaxSpeech.generate(job, { ...base, fetcher: async () => { calls++; return Response.json({ base_resp: { status_code: 1008 } }); } }), /1008/);
  assert.equal(calls, 1);
  await assert.rejects(fishAudio.generate(job, { ...base, fetcher: async () => new Response('denied', { status: 403 }) }), /403/);
  for (const section of ['fish', 'minimax']) assert.match((await getWorkflow(section, 'media')).content, /voiceRef/);
});


test('native speech through the public asset operation saves reusable audio and voice provenance once', () => fixture(async store => {
  const audio = await mediaBytes('audio');
  const gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  let calls = 0;
  gateway.options.fetcher = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.minimax.io/v1/t2a_v2');
    assert.equal(JSON.parse(String(init?.body)).voice_setting.voice_id, input.externalId);
    return Response.json({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } });
  };
  try {
    await gateway.connections.configure('minimax-speech', { apiKey: 'synthetic-speech-key' });
    const { voice } = await assetOperation(store, { action: 'voice', voice: { command: 'add', ...input, provider: 'minimax-speech' } });
    const args = { action: 'generate', requestId: 'speech-output', modality: 'audio', mode: 'text-to-speech', prompt: 'A fixture script', model: 'minimax-speech:speech-2.8-hd', voiceRef: { voiceId: voice.id, revision: voice.revision } };
    const { job } = await assetOperation(store, args);
    await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
    const completed = await gateway.getJob(job.id);
    assert.equal(completed.state, 'completed', completed.error);
    assert.equal(completed.libraryAssets?.length, 1);
    const library = new AssetLibrary(store), reference = completed.libraryAssets![0];
    const { version } = await library.resolve(reference);
    assert.equal((version.result?.voice as any).externalId, input.externalId);
    assert.equal((version.result?.voice as any).voiceId, voice.id);
    assert.equal((await assetOperation(store, args)).job.id, job.id);
    assert.equal(calls, 1);
    await new VoiceLibrary(store).update(voice.id, voice.revision, { trashed: true });
    assert.equal((await library.resolve(reference)).version.id, version.id);
  } finally { await gateway.close(); }
}, false));

test('MiniMax regions isolate keys, catalogues and identical remote voice IDs while preserving international records', () => fixture(async store => {
  const audio = await mediaBytes('audio'), gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const origin = new URL(String(url)).origin, region = origin.endsWith('.cn') ? 'cn' : 'global';
    assert.ok(['https://api.minimax.cn', 'https://api.minimax.io'].includes(origin));
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer synthetic-${region}`);
    calls.push(String(url));
    if (String(url).endsWith('/get_voice')) return Response.json({ base_resp: { status_code: 0 }, voice_cloning: [{ voice_id: 'same-remote-id', voice_name: region }] });
    assert.equal(String(url), `${origin}/v1/t2a_v2`);
    assert.equal(JSON.parse(String(init?.body)).voice_setting.voice_id, 'same-remote-id');
    return Response.json({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } });
  };
  gateway.options.fetcher = fetcher;
  const library = new VoiceLibrary(store, fetcher);
  try {
    await gateway.connections.configure('minimax-speech', { apiKey: 'synthetic-global' });
    const original = await library.add({ ...input, requestId: 'global-record', provider: 'minimax-speech', externalId: 'same-remote-id' });
    await gateway.connections.configure('minimax-speech-cn', { apiKey: 'synthetic-cn' });
    const china = await library.add({ ...input, requestId: 'cn-record', provider: 'minimax-speech-cn', externalId: 'same-remote-id' });
    assert.notEqual(original.id, china.id);
    assert.deepEqual(await new VoiceLibrary(store).get(original.id), original);
    for (const record of [original, china]) {
      const checked = await library.check(record.id, record.revision);
      assert.equal(checked.access, 'listed');
      const voiceRef = { voiceId: checked.id, revision: checked.revision };
      await assert.rejects(library.resolve(voiceRef, record.provider === 'minimax-speech' ? 'minimax-speech-cn' : 'minimax-speech'), /same provider/);
      const result = await assetOperation(store, { action: 'generate', requestId: `regional-${record.provider}`, modality: 'audio', mode: 'text-to-speech', prompt: 'Regional narration', model: `${record.provider}:speech-2.8-hd`, voiceRef });
      await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
      const completed = await gateway.getJob(result.job.id);
      assert.equal(completed.state, 'completed', completed.error);
      assert.equal(completed.voice?.provider, record.provider);
    }
    const directory = await providerDirectory(gateway);
    for (const id of ['minimax-speech', 'minimax-speech-cn']) {
      const provider = directory.providers.find(p => p.id === id)!;
      assert.equal(provider.group, 'MiniMax Speech'); assert.equal(provider.configured, true);
      assert.equal(directory.models.filter(model => model.provider === id).length, 2);
    }
    await gateway.connections.configure('minimax-speech-cn', { apiKey: null });
    assert.equal((await library.get(original.id)).connection, 'ready');
    assert.equal((await library.get(china.id)).connection, 'required');
    assert.equal(calls.length, 4);
  } finally { await gateway.close(); }
}, false));

test('speech adapters retain native settings and the explicit speed alias wins only when supplied', async () => {
  const base = { key: 'synthetic-key', signal: new AbortController().signal, progress: async () => {} };
  const job: any = { modality: 'audio', prompt: 'Narration', model: { provider: 'fishaudio', mode: 'text-to-speech', modelId: 's2-pro' }, parameters: { voice: 'chosen', prosody: { speed: 1.6, volume: -4 } } };
  await fishAudio.generate(job, { ...base, fetcher: async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).prosody, job.parameters.prosody);
    return new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } });
  } });
  const voice_setting = { voice_id: 'chosen', speed: 1.3, vol: 2, pitch: 4, emotion: 'happy' };
  const audio_setting = { format: 'mp3', sample_rate: 44100, bitrate: 192000, channel: 2 };
  for (const speed of [undefined, 0.9]) await miniMaxSpeech.generate({ ...job, model: { ...job.model, provider: 'minimax-speech', modelId: 'speech-2.8-hd' }, parameters: { voice: 'chosen', voice_setting, audio_setting, ...(speed ? { speed } : {}) } }, { ...base, fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.voice_setting, { ...voice_setting, speed: speed ?? voice_setting.speed });
    assert.deepEqual(body.audio_setting, audio_setting);
    return Response.json({ base_resp: { status_code: 0 }, data: { audio: '6162' } });
  } });
});

test('saved voice retries return the original task after rename, trash or key removal and retain native emotion', () => fixture(async store => {
  const library = new VoiceLibrary(store), gateway = new ModelGateway(store, { detect: async () => [] });
  try {
    await library.connections.configure('minimax-speech', { apiKey: 'synthetic-replay-key' });
    const voice = await library.add({ ...input, requestId: 'replay-voice', provider: 'minimax-speech' });
    const request = { modality: 'audio' as const, mode: 'text-to-speech', model: 'minimax-speech:speech-2.8-hd', library: {}, prompt: 'A script', voiceRef: { voiceId: voice.id, revision: voice.revision }, parameters: { voice_setting: { emotion: 'happy' } }, idempotencyKey: 'original-speech' };
    const job = await gateway.submit(request);
    assert.deepEqual(job.parameters.voice_setting, { emotion: 'happy' });
    await assert.rejects(gateway.submit({ ...request, idempotencyKey: 'conflicting-voice', parameters: { voice_setting: { voice_id: 'another-voice' } } }), /conflict/);
    const renamed = await library.update(voice.id, voice.revision, { name: 'Renamed' });
    assert.equal((await gateway.submit(request)).id, job.id);
    await library.update(voice.id, renamed.revision, { trashed: true });
    await library.connections.configure('minimax-speech', { apiKey: null });
    assert.equal((await gateway.submit(request)).id, job.id);
    await assert.rejects(gateway.submit({ ...request, prompt: 'Changed script' }), /Idempotency/);
    assert.equal((await gateway.listJobs()).length, 1);
  } finally { await gateway.close(); }
}, false));

test('MiniMax synchronous speech uses the job budget and accepts hex audio beyond catalogue response sizes', async t => {
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  const bytes = 9 * 1024 * 1024;
  let submissions = 0;
  const output = await miniMaxSpeech.generate({ modality: 'audio', prompt: 'Long narration', parameters: { voice: 'chosen' }, model: { provider: 'minimax-speech-cn', mode: 'text-to-speech', modelId: 'speech-2.8-hd' } } as any, {
    key: 'synthetic-long-speech', signal: new AbortController().signal, progress: async () => {}, fetcher: async (_url, init) => {
      submissions++; assert.equal(init?.signal?.aborted, false);
      return Response.json({ base_resp: { status_code: 0 }, data: { audio: Buffer.alloc(bytes, 1).toString('hex') } });
    },
  });
  assert.deepEqual(timeouts, [15 * 60_000]); assert.equal(output[0].length, bytes); assert.equal(submissions, 1);
});

test('queued speech and restored selections survive voice metadata edits and rechecks without changing the pinned source', () => fixture(async store => {
  const audio = await mediaBytes('audio'), gateway = new ModelGateway(store, { detect: async () => [] });
  let submissions = 0;
  gateway.options.fetcher = async (_url, init) => {
    submissions++; assert.equal(JSON.parse(String(init?.body)).voice_setting.voice_id, input.externalId);
    return Response.json({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } });
  };
  const library = new VoiceLibrary(store, async () => Response.json({ base_resp: { status_code: 0 }, voice_cloning: [{ voice_id: input.externalId }] }));
  try {
    await library.connections.configure('minimax-speech', { apiKey: 'synthetic-queued-voice-key' });
    const voice = await library.add({ ...input, provider: 'minimax-speech' });
    const request = { modality: 'audio' as const, model: 'minimax-speech:speech-2.8-hd', prompt: 'A queued script', library: {}, voiceRef: { voiceId: voice.id, revision: voice.revision } };
    const queued = await gateway.submit({ ...request, idempotencyKey: 'before-metadata-change' });
    const renamed = await library.update(voice.id, voice.revision, { name: 'Renamed narrator', description: 'Updated metadata' });
    const restored = await gateway.submit({ ...request, idempotencyKey: 'restored-older-selection' });
    const checked = await library.check(voice.id, renamed.revision);
    assert.equal(checked.connection, 'ready');
    await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
    for (const job of [queued, restored]) {
      const completed = await gateway.getJob(job.id);
      assert.equal(completed.state, 'completed', completed.error);
      assert.deepEqual(completed.voice, job.voice);
      assert.equal(completed.voice?.externalId, input.externalId);
    }
    assert.equal(submissions, 2);
    await assert.rejects(library.resolve({ voiceId: voice.id, revision: checked.revision + 1 }, 'minimax-speech'), /VOICE_CHANGED/);
    await assert.rejects(library.update(voice.id, renamed.revision, { name: 'Stale update' }), /VOICE_CHANGED/);
  } finally { await gateway.close(); }
}, false));

for (const change of ['trash', 'connection', 'rebound-connection', 'identity'] as const) test(`queued voice jobs still stop on ${change} changes before a provider call`, () => fixture(async store => {
  const gateway = new ModelGateway(store, { detect: async () => [] }), library = new VoiceLibrary(store, async () => Response.json({ items: [{ _id: input.externalId, title: input.name }], has_more: false }));
  let submissions = 0; gateway.options.fetcher = async () => { submissions++; throw new Error('Unexpected paid submission'); };
  try {
    await library.connections.configure('fishaudio', { apiKey: 'synthetic-original-connection' });
    const voice = await library.add(input);
    const job = await gateway.submit({ modality: 'audio', model: 'fishaudio:s2-pro', prompt: 'Queued narration', library: {}, voiceRef: { voiceId: voice.id, revision: voice.revision } });
    if (change === 'trash') await library.update(voice.id, voice.revision, { trashed: true });
    else if (change === 'connection' || change === 'rebound-connection') {
      await library.connections.configure('fishaudio', { apiKey: 'synthetic-changed-connection' });
      if (change === 'rebound-connection') {
        const rebound = await library.check(voice.id, voice.revision); assert.equal(rebound.connection, 'ready');
        await assert.rejects(library.resolve({ voiceId: voice.id, revision: voice.revision }, 'fishaudio'), /VOICE_CHANGED/);
        assert.equal((await library.resolve({ voiceId: voice.id, revision: rebound.revision }, 'fishaudio')).externalId, input.externalId);
        assert.doesNotMatch(JSON.stringify(rebound), /scope/);
      }
    }
    else {
      const file = path.join(store.directory, 'asset-library', 'voices', voice.id + '.json');
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), externalId: 'different-remote-identity' }));
    }
    await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
    const completed = await gateway.getJob(job.id);
    assert.equal(completed.state, 'failed');
    assert.match(completed.error ?? '', /VOICE_CHANGED|Check this voice/); assert.equal(submissions, 0);
  } finally { await gateway.close(); }
}, false));

test('native speech rejects missing voices before queueing and accepts explicit voices, saved selections and model defaults', () => fixture(async store => {
  const gateway = new ModelGateway(store, { detect: async () => [] });
  try {
    for (const provider of ['fishaudio', 'minimax-speech-cn', 'minimax-speech']) {
      await gateway.connections.configure(provider, { apiKey: `synthetic-${provider}` });
      const model = `${provider}:${provider === 'fishaudio' ? 's2-pro' : 'speech-2.8-hd'}`;
      const request = { modality: 'audio' as const, model, prompt: 'Speech requires a voice', library: {} };
      for (const parameters of [undefined, { voice: '' }, { voice: '  ' }]) await assert.rejects(gateway.submit({ ...request, parameters }), /Voice ID|voice/);
      assert.equal((await gateway.listJobs()).length, 0);
    }
    const request = { modality: 'audio' as const, model: 'fishaudio:s2-pro', prompt: 'A narrator', library: {} };
    assert.equal((await gateway.submit({ ...request, parameters: { voice: 'explicit-voice' } })).parameters.voice, 'explicit-voice');
    const voice = await new VoiceLibrary(store).add(input);
    assert.equal((await gateway.submit({ ...request, voiceRef: { voiceId: voice.id, revision: voice.revision } })).parameters.voice, input.externalId);
    await gateway.connections.updateMetadata('fishaudio:s2-pro', { defaults: { voice: 'default-voice' } });
    assert.equal((await gateway.submit(request)).model.defaults?.voice, 'default-voice');
  } finally { await gateway.close(); }
}, false));
