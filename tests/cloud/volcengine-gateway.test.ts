import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import { GatewayError, buildGatewayStatus, createPlatformModelGateway } from '../../src/services/model-gateway.ts';
import {
  DEFAULT_ARK_VIDEO_MODELS,
  VolcengineModelGateway,
  parseArkModelList,
  parseSseFrames,
} from '../../src/services/volcengine-adapter.ts';
import { modelDefaults } from '../../shared/generation-options.ts';

const BASE = 'https://ark.example.test/api/v3';
const KEY = 'test-ark-key-not-real';
const ctx = { workspaceId: 'ws-1', idempotencyKey: 'job-1' };

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };

function fakeArk(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const fetcher = (async (input: unknown, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetcher };
}

function gateway(fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof VolcengineModelGateway>[0]> = {}) {
  return new VolcengineModelGateway({ apiKey: KEY, baseUrl: BASE, imageModels: ['doubao-seedream-test'], fetcher, ...extra });
}

const videoInput = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'job-1',
  modality: 'video' as const,
  mode: 'text-to-video' as const,
  modelId: 'doubao-seedance-2-0-260128',
  prompt: 'A folding lamp opens',
  parameters: { ratio: '16:9', duration: 5, resolution: '720p', unexpected: 'dropped', nested: { a: 1 } },
  inputs: [],
  ...overrides,
});

function makeConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud',
    SESSION_SECRET: '0'.repeat(32),
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    MODEL_GATEWAY_MODE: 'volcengine',
    ARK_API_KEY: KEY,
    ...overrides,
  });
}

describe('Volcengine Ark gateway configuration', () => {
  it('requires ARK_API_KEY for api/media roles and builds the backend from config', () => {
    assert.throws(() => makeConfig({ ARK_API_KEY: undefined }), /requires ARK_API_KEY or VOLC_TTS_API_KEY/);
    assert.equal(createPlatformModelGateway(makeConfig({ ARK_API_KEY: undefined, VOLC_TTS_API_KEY: 'speech-key' })).mode, 'volcengine');
    const gw = createPlatformModelGateway(makeConfig({ ARK_IMAGE_MODELS: 'doubao-seedream-a, doubao-seedream-a' }));
    assert.equal(gw.mode, 'volcengine');
    assert.equal(gw.providerId, 'opendesign');
  });

  it('parses and validates model lists', () => {
    assert.deepEqual(parseArkModelList(' a-1, b.2  a-1 '), ['a-1', 'b.2']);
    assert.deepEqual(parseArkModelList(undefined), []);
    assert.throws(() => parseArkModelList('bad/id'), /invalid Ark model ID/);
  });

  it('rejects a non-HTTPS base URL', () => {
    assert.throws(() => new VolcengineModelGateway({ apiKey: KEY, baseUrl: 'http://ark.example.test/api/v3' }), /https/);
  });

  it('lists configured image models and default Seedance video models with provider-native options', async () => {
    const models = await gateway(fakeArk([]).fetcher).listMediaModels(ctx);
    assert.deepEqual(models.map((m) => m.modelId), ['doubao-seedream-test', ...DEFAULT_ARK_VIDEO_MODELS]);
    assert.ok(models.every((m) => m.provider === 'opendesign' && m.id === `opendesign:${m.modelId}`));
    const v25 = models.find((m) => m.modelId === 'doubao-seedance-2-5-260628')!;
    const duration = v25.generationOptions?.fields.find((f) => f.key === 'duration');
    assert.equal(duration?.max, 30);
    const v20 = models.find((m) => m.modelId === 'doubao-seedance-2-0-260128')!;
    assert.equal(v20.generationOptions?.fields.find((f) => f.key === 'duration')?.max, 15);
    assert.equal(v20.generationOptions?.fields.find((f) => f.key === 'generate_audio')?.default, false);
  });

  it('reports its own identity in gateway status instead of a verified OpenDesign platform', async () => {
    const gw = gateway(fakeArk([]).fetcher);
    const status = buildGatewayStatus(await gw.listMediaModels(ctx), {}, await gw.getBillingSummary(ctx), gw.statusIdentity);
    assert.equal(status.providers[0].id, 'opendesign');
    assert.equal(status.providers[0].label, 'Volcengine');
    assert.equal(status.providers[0].verification, 'unverified');
    assert.equal(status.providers[0].mediaEntitlement, 'unknown');
    assert.equal(status.capabilities.find((c) => c.modality === 'audio')?.available, false);
  });
});

describe('Volcengine Ark video tasks', () => {
  it('submits once with Bearer auth and whitelisted parameters, then polls to a validated output URL', async () => {
    const { calls, fetcher } = fakeArk([
      { body: { id: 'cgt-2026-abc' } },
      { body: { id: 'cgt-2026-abc', status: 'queued' } },
      { body: { id: 'cgt-2026-abc', status: 'running' } },
      { body: { id: 'cgt-2026-abc', status: 'succeeded', duration: 5, ratio: '16:9', content: { video_url: 'https://tos.example.test/v.mp4?sig=1' } } },
    ]);
    const gw = gateway(fetcher);
    const first = await gw.submitTask(ctx, videoInput());
    const replay = await gw.submitTask(ctx, videoInput());
    assert.equal(first.remoteTaskId, 'cgt-2026-abc');
    assert.equal(replay.remoteTaskId, 'cgt-2026-abc');
    assert.equal(calls.length, 1, 'an idempotent replay must not submit a second paid task');
    assert.equal(calls[0].url, `${BASE}/contents/generations/tasks`);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(calls[0].body, {
      watermark: false,
      generate_audio: false,
      ratio: '16:9',
      resolution: '720p',
      duration: 5,
      model: 'doubao-seedance-2-0-260128',
      content: [{ type: 'text', text: 'A folding lamp opens' }],
    });

    assert.equal((await gw.pollTask(ctx, { modality: 'video', remoteTaskId: first.remoteTaskId })).status, 'pending');
    assert.equal((await gw.pollTask(ctx, { modality: 'video', remoteTaskId: first.remoteTaskId })).status, 'running');
    const done = await gw.pollTask(ctx, { modality: 'video', remoteTaskId: first.remoteTaskId });
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.outputs, [{ downloadUrl: 'https://tos.example.test/v.mp4?sig=1', mimeType: 'video/mp4' }]);
    assert.equal(done.metadata?.durationSec, 5);
    assert.equal(calls[1].url, `${BASE}/contents/generations/tasks/cgt-2026-abc`);
    assert.equal(calls[1].method, 'GET');
  });

  it('sends a reference image as a first-frame data URL', async () => {
    const { calls, fetcher } = fakeArk([{ body: { id: 'cgt-ref' } }]);
    const gw = gateway(fetcher);
    const ref = await gw.uploadReference(ctx, { bytes: Buffer.from('png-bytes'), mimeType: 'image/png', idempotencyKey: 'job-1-upload-0' });
    await gw.submitTask(ctx, videoInput({ inputs: [{ remoteAssetId: ref.remoteAssetId }] }));
    assert.deepEqual(calls[0].body.content[1], {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}` },
      role: 'first_frame',
    });
  });

  it('rejects unsupported or oversized references before any paid request', async () => {
    const gw = gateway(fakeArk([]).fetcher);
    await assert.rejects(gw.uploadReference(ctx, { bytes: Buffer.from('x'), mimeType: 'image/gif', idempotencyKey: 'k' }), { code: 'unsupported_media_type' });
    await assert.rejects(gw.uploadReference(ctx, { bytes: Buffer.alloc(11 * 1024 * 1024), mimeType: 'image/png', idempotencyKey: 'k' }), { code: 'asset_too_large' });
  });

  it('maps rejected auth and invalid input without echoing provider text or the key', async () => {
    const secretEcho = { error: { code: 'AuthenticationError', message: `bad key ${KEY}` } };
    const { fetcher } = fakeArk([{ status: 401, body: secretEcho }, { status: 400, body: { error: { code: 'InvalidParameter', message: 'prompt: secret user text' } } }]);
    const gw = gateway(fetcher);
    await assert.rejects(gw.submitTask(ctx, videoInput()), (error: GatewayError) => {
      assert.equal(error.code, 'unauthorized');
      assert.ok(!error.message.includes(KEY));
      assert.match(error.message, /AuthenticationError/);
      return true;
    });
    await assert.rejects(gw.submitTask({ ...ctx, idempotencyKey: 'job-2' }, videoInput({ jobId: 'job-2' })), (error: GatewayError) => {
      assert.equal(error.code, 'invalid_request');
      assert.ok(!error.message.includes('secret user text'));
      return true;
    });
  });

  it('reports a transport failure or 5xx on submit as outcome unknown and never retries the paid POST', async () => {
    const { calls, fetcher } = fakeArk([new Error('socket hang up'), { status: 503, body: {} }]);
    const gw = gateway(fetcher);
    await assert.rejects(gw.submitTask(ctx, videoInput()), (error: GatewayError) => error.outcomeUnknown && error.code === 'request_state_unknown');
    await assert.rejects(gw.submitTask({ ...ctx, idempotencyKey: 'job-2' }, videoInput({ jobId: 'job-2' })), (error: GatewayError) => error.outcomeUnknown);
    assert.equal(calls.length, 2);
  });

  it('rejects an unsafe task ID and non-HTTPS output URLs', async () => {
    const { fetcher } = fakeArk([
      { body: { id: '../../etc' } },
      { body: { status: 'succeeded', content: { video_url: 'http://insecure.example.test/v.mp4' } } },
    ]);
    const gw = gateway(fetcher);
    await assert.rejects(gw.submitTask(ctx, videoInput()), { code: 'request_state_unknown' });
    await assert.rejects(gw.pollTask(ctx, { modality: 'video', remoteTaskId: 'bad/id' }), { code: 'invalid_request' });
    const polled = await gw.pollTask(ctx, { modality: 'video', remoteTaskId: 'cgt-ok' });
    assert.equal(polled.status, 'failed');
  });

  it('maps failed, expired and cancelled tasks to terminal results', async () => {
    const { fetcher } = fakeArk([
      { body: { status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'x' } } },
      { body: { status: 'expired' } },
      { body: { status: 'cancelled' } },
    ]);
    const gw = gateway(fetcher);
    const failed = await gw.pollTask(ctx, { modality: 'video', remoteTaskId: 't1' });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!.message, /OutputVideoSensitiveContentDetected/);
    assert.equal((await gw.pollTask(ctx, { modality: 'video', remoteTaskId: 't2' })).status, 'failed');
    assert.equal((await gw.pollTask(ctx, { modality: 'video', remoteTaskId: 't3' })).status, 'cancelled');
  });

  it('refuses a model that is not configured', async () => {
    const gw = gateway(fakeArk([]).fetcher);
    await assert.rejects(gw.submitTask(ctx, videoInput({ modelId: 'doubao-unknown' })), { code: 'invalid_request' });
  });
});

describe('Volcengine Ark images', () => {
  it('generates synchronously, then serves the held result through polling', async () => {
    const { calls, fetcher } = fakeArk([{ body: { data: [{ url: 'https://tos.example.test/i.png' }, { error: { code: 'x' } }] } }]);
    const gw = gateway(fetcher);
    const submitted = await gw.submitTask(ctx, {
      jobId: 'job-1', modality: 'image', mode: 'text-to-image', modelId: 'doubao-seedream-test',
      prompt: 'A ceramic cup', parameters: { size: '2K' }, inputs: [],
    });
    assert.equal(calls[0].url, `${BASE}/images/generations`);
    assert.deepEqual(calls[0].body, { watermark: false, size: '2K', model: 'doubao-seedream-test', prompt: 'A ceramic cup', response_format: 'url' });
    const polled = await gw.pollTask(ctx, { modality: 'image', remoteTaskId: submitted.remoteTaskId });
    assert.equal(polled.status, 'succeeded');
    assert.deepEqual(polled.outputs, [{ downloadUrl: 'https://tos.example.test/i.png' }]);
  });

  it('reports a lost in-memory image result as outcome unknown instead of resubmitting', async () => {
    const { calls, fetcher } = fakeArk([]);
    const polled = await gateway(fetcher).pollTask(ctx, { modality: 'image', remoteTaskId: 'volcsync_missing' });
    assert.equal(polled.status, 'failed');
    assert.equal(polled.error?.outcomeUnknown, true);
    assert.equal(calls.length, 0);
  });
});

describe('Volcengine output download', () => {
  it('downloads without the Ark Authorization header', async () => {
    let seen: RequestInit | undefined;
    const gw = gateway(fakeArk([]).fetcher, {
      mediaStreamer: async (_url, init) => { seen = init; return new Response('video-bytes'); },
    });
    const stream = await gw.downloadOutput(ctx, { downloadUrl: 'https://tos.example.test/v.mp4' });
    assert.equal(await new Response(stream).text(), 'video-bytes');
    assert.equal(new Headers(seen?.headers).get('authorization'), null);
    await assert.rejects(gw.downloadOutput(ctx, { downloadUrl: 'http://tos.example.test/v.mp4' }), { code: 'provider_error' });
  });
});

const SPEECH_KEY = 'test-speech-key-not-real';
function sseResponse(frames: Array<{ event: string; data: unknown }>) {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}
function fakeSpeech(responses: Array<{ status?: number; text: string } | Error>) {
  const calls: Call[] = [];
  const fetcher = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return new Response(next.text, { status: next.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetcher };
}
const speechGateway = (fetcher: typeof fetch) =>
  new VolcengineModelGateway({ speechApiKey: SPEECH_KEY, speechBaseUrl: 'https://speech.example.test', fetcher });
const speechInput = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'job-s', modality: 'audio' as const, mode: 'text-to-speech' as const, modelId: 'seed-tts-2.0',
  prompt: '你好，欢迎。', parameters: { voice: 'zh_female_xiaohe_uranus_bigtts', speech_rate: 10 }, inputs: [], ...overrides,
});

describe('Volcengine speech and Seed Audio', () => {
  it('offers only speech/sound models with a speech key, and defaults to a checked 2.0 voice', async () => {
    const models = await speechGateway(fakeSpeech([]).fetcher).listMediaModels(ctx);
    assert.deepEqual(models.map((m) => [m.modelId, m.mode]), [['seed-tts-2.0', 'text-to-speech'], ['seed-audio-1.0', 'text-to-audio']]);
    assert.equal(modelDefaults(models[0]).voice, 'zh_female_xiaohe_uranus_bigtts');
  });

  it('parses SSE frames and skips malformed ones', () => {
    const frames = parseSseFrames('event: 352\ndata: {"code":0,"data":"AA=="}\n\n: keepalive\n\nevent: 1\ndata: not-json\n\n');
    assert.deepEqual(frames, [{ event: '352', data: { code: 0, data: 'AA==' } }]);
  });

  it('synthesizes speech over SSE once, concatenating audio, and serves it through polling', async () => {
    const audio1 = Buffer.from('mp3-part-1'), audio2 = Buffer.from('mp3-part-2');
    const { calls, fetcher } = fakeSpeech([{ text: sseResponse([
      { event: '352', data: { code: 0, message: '', data: audio1.toString('base64') } },
      { event: '351', data: { code: 0, data: null, sentence: { text: '你好，欢迎。', words: [] } } },
      { event: '352', data: { code: 0, message: '', data: audio2.toString('base64') } },
      { event: '152', data: { code: 20000000, message: 'ok', data: null } },
    ]) }]);
    const gw = speechGateway(fetcher);
    const submitted = await gw.submitTask({ ...ctx, idempotencyKey: 'job-s' }, speechInput());
    await gw.submitTask({ ...ctx, idempotencyKey: 'job-s' }, speechInput());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://speech.example.test/api/v3/tts/unidirectional/sse');
    assert.equal(calls[0].headers['x-api-key'], SPEECH_KEY);
    assert.equal(calls[0].headers['x-api-resource-id'], 'seed-tts-2.0');
    assert.equal(calls[0].headers.authorization, undefined);
    assert.deepEqual(calls[0].body.req_params, {
      text: '你好，欢迎。', speaker: 'zh_female_xiaohe_uranus_bigtts',
      audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: 10 },
    });
    assert.match(calls[0].body.user.uid, /^[a-f0-9]{32}$/);
    const polled = await gw.pollTask(ctx, { modality: 'audio', remoteTaskId: submitted.remoteTaskId });
    assert.equal(polled.status, 'succeeded');
    assert.deepEqual(polled.outputs?.[0].inlineBytes, Buffer.concat([audio1, audio2]));
    assert.equal(polled.outputs?.[0].mimeType, 'audio/mpeg');
    assert.deepEqual(polled.metadata, { sentences: [{ text: '你好，欢迎。' }] });
    assert.equal(await new Response(await gw.downloadOutput(ctx, polled.outputs![0])).text(), 'mp3-part-1mp3-part-2');
  });

  it('requires a valid voice and maps speech application errors without forwarding their text', async () => {
    const { calls, fetcher } = fakeSpeech([{ text: sseResponse([{ event: '153', data: { code: 45000000, message: 'speaker permission denied secret' } }]) }]);
    const gw = speechGateway(fetcher);
    await assert.rejects(gw.submitTask(ctx, speechInput({ parameters: { voice: 'bad voice' } })), { code: 'invalid_request' });
    assert.equal(calls.length, 0);
    await assert.rejects(gw.submitTask({ ...ctx, idempotencyKey: 'job-2' }, speechInput({ jobId: 'job-2' })), (error: GatewayError) => {
      assert.equal(error.code, 'forbidden_api_key');
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  });

  it('treats a transport failure, 5xx or empty audio as outcome unknown and never retries', async () => {
    const { calls, fetcher } = fakeSpeech([new Error('socket hang up'), { status: 502, text: '' }, { text: sseResponse([{ event: '152', data: { code: 20000000 } }]) }]);
    const gw = speechGateway(fetcher);
    for (const id of ['a', 'b', 'c']) {
      await assert.rejects(gw.submitTask({ ...ctx, idempotencyKey: id }, speechInput({ jobId: id })), (error: GatewayError) => error.outcomeUnknown);
    }
    assert.equal(calls.length, 3);
  });

  it('generates Seed Audio from a prompt with the documented body', async () => {
    const sound = Buffer.from('sound-mp3');
    const { calls, fetcher } = fakeSpeech([{ text: JSON.stringify({ code: 0, audio: sound.toString('base64'), duration: 6.5 }) }]);
    const gw = speechGateway(fetcher);
    const submitted = await gw.submitTask(ctx, { ...speechInput(), mode: 'text-to-audio', modelId: 'seed-audio-1.0', prompt: 'rain on a tin roof', parameters: {} });
    assert.equal(calls[0].url, 'https://speech.example.test/api/v3/tts/create');
    assert.deepEqual(calls[0].body, { model: 'seed-audio-1.0', text_prompt: 'rain on a tin roof', audio_config: { format: 'mp3' } });
    const polled = await gw.pollTask(ctx, { modality: 'audio', remoteTaskId: submitted.remoteTaskId });
    assert.deepEqual(polled.outputs?.[0].inlineBytes, sound);
    assert.deepEqual(polled.metadata, { durationSec: 6.5 });
    await assert.rejects(gw.submitTask({ ...ctx, idempotencyKey: 'long' }, { ...speechInput({ jobId: 'long' }), mode: 'text-to-audio', modelId: 'seed-audio-1.0', prompt: 'x'.repeat(3001), parameters: {} }), { code: 'invalid_request' });
  });

  it('does not offer image/video without an Ark key', async () => {
    const gw = speechGateway(fakeSpeech([]).fetcher);
    await assert.rejects(gw.submitTask(ctx, videoInput()), { code: 'invalid_request' });
  });
});
