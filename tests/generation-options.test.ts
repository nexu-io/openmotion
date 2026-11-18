import test from 'node:test';
import assert from 'node:assert/strict';
import { generationOptions, modelDefaults, resolveGenerationParameters, usesInputImageRatio, validateGenerationOptions } from '../shared/generation-options.ts';
import { builtinModels } from '../gateway/catalog.ts';
import { fixture } from './fixtures.ts';
import { gatewayFor } from '../gateway/service.ts';
import { providerAdapters } from '../gateway/providers.ts';
import type { GenerationJob, Model } from '../shared/gateway.ts';
import { OpenDesignAccount } from '../gateway/account.ts';
import type { AccountSummary } from '../shared/provider-directory.ts';

for (const provider of ['opendesign', 'account']) for (const modelId of ['wan-2.7', 'doubao-seedance-2-5-260628']) {
  test(`${provider}:${modelId} first-frame parameters follow the image without inheriting a fixed ratio`, () => {
    const model: Model = { id: `${provider}:${modelId}`, provider, modelId, label: modelId, modality: 'video', mode: 'text-to-video', source: 'live',
      defaults: { ratio: '16:9', duration: 5 }, nativeOptions: { ratios: { default: '16:9' } } };
    const explicit = { ratio: '9:16', duration: 4 };
    assert.throws(() => resolveGenerationParameters(model, explicit, true), /First-frame video.*Remove parameters.ratio.*adaptive/);
    for (const ratio of ['16:9', '', null, 1]) assert.throws(() => resolveGenerationParameters(model, { ratio }, true), /First-frame video/);
    assert.deepEqual(resolveGenerationParameters(model, {}, true), { duration: 5 });
    assert.deepEqual(resolveGenerationParameters(model, { ratio: 'adaptive' }, true), { duration: 5, ratio: 'adaptive' });
    assert.deepEqual(resolveGenerationParameters({ ...model, defaults: { ratio: 'adaptive' } }, {}, true), { ratio: 'adaptive' });
    assert.deepEqual(resolveGenerationParameters({ ...model, defaults: undefined }, {}, true), {});
    // Text-only generation keeps both saved and explicit fixed ratios, without mutating their source.
    assert.deepEqual(resolveGenerationParameters(model, {}), { ratio: '16:9', duration: 5 });
    assert.deepEqual(resolveGenerationParameters(model, explicit), explicit);
    assert.deepEqual(model.defaults, { ratio: '16:9', duration: 5 });
    assert.deepEqual(explicit, { ratio: '9:16', duration: 4 });
    const images = [{ asset_id: 'ma_frame', role: 'first_frame' }];
    assert.equal(usesInputImageRatio(model, false, { images }), true);
    assert.throws(() => resolveGenerationParameters(model, { images, ratio: '16:9' }), /First-frame video/);
    assert.deepEqual(resolveGenerationParameters(model, { images }), { duration: 5, images });
    assert.deepEqual(resolveGenerationParameters({ ...model, defaults: { ...model.defaults, images } }, {}), { duration: 5, images });
  });
}

test('first-frame ratio policy leaves other providers, models and image editing unchanged', () => {
  const base: Model = { id: 'opendesign:wan-2.7', provider: 'opendesign', modelId: 'wan-2.7', label: 'Wan', modality: 'video', mode: 'text-to-video', source: 'live', defaults: { ratio: '16:9' } };
  for (const model of [{ ...base, provider: 'fal' }, { ...base, provider: 'atlascloud' }, { ...base, modelId: 'future-video' }, { ...base, modality: 'image' as const }]) {
    assert.equal(usesInputImageRatio(model, true), false);
    assert.deepEqual(resolveGenerationParameters(model, { ratio: '4:3' }, true), { ratio: '4:3' });
  }
});

test('account first-frame ratio rejection makes no connector call and does not enable account video references', () => fixture(async store => {
  let calls = 0;
  const account = new OpenDesignAccount(store.directory, { run: async () => { calls++; throw new Error('unexpected connector call'); } });
  account.identity = async () => 'fixture-session';
  account.summary = async () => ({ state: 'signed-in' } as AccountSummary);
  const model: Model = { id: 'account:wan-2.7', provider: 'account', modelId: 'wan-2.7', label: 'Wan', modality: 'video', mode: 'text-to-video', source: 'live', defaults: { ratio: '16:9' } };
  const job = { model, modality: 'video', providerOrigin: 'fixture-session', parameters: { ratio: '16:9' } } as GenerationJob;
  try {
    const run = (parameters: Record<string, unknown>) => account.generate({ ...job, parameters }, store.directory, new AbortController().signal, async () => {}, 'not-read.png');
    await assert.rejects(run({ ratio: '16:9' }), /First-frame video/);
    for (const parameters of [{}, { ratio: 'adaptive' }]) await assert.rejects(run(parameters), /Account reference images are supported for image editing only/);
    assert.equal(calls, 0);
  } finally { account.close(); }
}));

test('exact endpoint schemas preserve provider types and never guess from a model label', () => {
  const seedance = builtinModels.find(m => m.modelId === 'bytedance/seedance-2.0/text-to-video')!;
  const schema = generationOptions(seedance)!;
  assert.equal(schema.fields.find(f => f.key === 'duration')!.choices![2].value, 5);
  assert.ok(schema.fields.some(f => f.key === 'ratio'));
  assert.ok(!schema.fields.some(f => f.key === 'aspect_ratio'));
  assert.throws(() => validateGenerationOptions(seedance, { duration: '5' }), /Invalid Duration/);
  assert.throws(() => validateGenerationOptions(seedance, { generate_audio: 'true' }), /Invalid Generate audio/);
  validateGenerationOptions(seedance, { duration: 5, generate_audio: true });
  assert.throws(() => validateGenerationOptions(seedance, { resolution: '4k', ratio: '9:16' }), /requires ratio 16:9/);
  validateGenerationOptions(seedance, { resolution: '4k', ratio: '16:9' });
  assert.equal(generationOptions({ ...seedance, modelId: 'unknown', label: seedance.label }), undefined);
  const flux = builtinModels.find(m => m.modelId === 'fal-ai/flux/schnell')!;
  validateGenerationOptions(flux, { image_size: { width: 1280, height: 720 } });
  assert.throws(() => validateGenerationOptions(flux, { num_images: 1.5 }), /Output count/);
  const codex = builtinModels.find(m => m.provider === 'codex')!;
  assert.equal(generationOptions(codex)?.delivery, 'prompt');
});

test('discovery returns the same schema used to reject invalid submissions before queueing', () => fixture(async store => {
  const gateway = gatewayFor(store);
  await gateway.configureProvider('atlascloud', { apiKey: 'fixture-only' });
  const { models } = await gateway.listModels({ provider: 'atlascloud', modality: 'video' });
  const model = models.find(m => m.modelId === 'bytedance/seedance-2.0/text-to-video')!;
  assert.deepEqual(model.generationOptions, generationOptions(model));
  const input = { modality: 'video' as const, prompt: 'Ocean', model: model.id, library: {}, idempotencyKey: 'typed-video' };
  await assert.rejects(gateway.submit({ ...input, parameters: { duration: '5' } }), /Invalid Duration/);
  assert.equal((await gateway.listJobs()).length, 0);
  const original = await gateway.submit({ ...input, parameters: { duration: 5, ratio: '9:16' } });
  assert.deepEqual(original.parameters, { duration: 5, ratio: '9:16' });
  assert.equal((await gateway.submit({ ...input, parameters: original.parameters })).id, original.id);
  assert.equal((await gateway.listJobs()).length, 1);
}));

test('Kokoro sends spoken text in prompt alongside native voice and speed, without retry', async () => {
  const bodies: any[] = [], model = builtinModels.find(m => m.modelId === 'fal-ai/kokoro/american-english')!;
  const job = { model, modality: 'audio', prompt: 'Hello world', parameters: { voice: 'af_heart', speed: 1.2 } } as GenerationJob;
  const urls = await providerAdapters.fal.generate(job, {
    key: 'fixture-only', signal: new AbortController().signal, progress: async () => {}, pollMs: 0,
    fetcher: async (_url, init) => {
      if (init?.method === 'POST') { bodies.push(JSON.parse(String(init.body))); return Response.json({ request_id: 'test', status_url: 'https://queue.fal.run/request/status', response_url: 'https://queue.fal.run/request/result' }); }
      return Response.json(String(_url).endsWith('status') ? { status: 'COMPLETED' } : { audio: { url: 'https://cdn.example/voice.wav' } });
    },
  });
  assert.deepEqual(bodies, [{ prompt: 'Hello world', voice: 'af_heart', speed: 1.2 }]);
  assert.deepEqual(urls, ['https://cdn.example/voice.wav']);
});

test('OpenDesign speech offers checked voices with a default, accepts other voice IDs, and keeps a free voice ID for other models', () => fixture(async store => {
  const byteplus = builtinModels.find(m => m.id === 'opendesign:byteplus-tts-2')!, eleven = builtinModels.find(m => m.id === 'opendesign:elevenlabs-v3')!;
  const [voice] = generationOptions(byteplus)!.fields;
  assert.deepEqual([voice.key, voice.kind, voice.default, voice.required, voice.allowCustom], ['voice', 'choice', 'zh_female_vv_uranus_bigtts', undefined, true]);
  assert.equal(generationOptions(eleven)!.fields[0].choices!.length, 6);
  // The list is a checked subset: an unlisted voice ID still reaches the provider, but a blank or non-string one does not.
  assert.doesNotThrow(() => validateGenerationOptions(byteplus, { voice: 'zh_female_xiaohe_uranus_bigtts' }));
  assert.throws(() => validateGenerationOptions(byteplus, { voice: ' ' }), /Invalid Speech voice/);
  assert.throws(() => validateGenerationOptions(eleven, { voice: 1 }), /Invalid Speech voice/);
  assert.deepEqual(modelDefaults({ ...eleven, id: 'account:elevenlabs-v3', provider: 'account' }), { voice: '21m00Tcm4TlvDq8ikWAM' });
  // A saved override still wins over the built-in default.
  assert.deepEqual(modelDefaults({ ...eleven, defaults: { voice: 'JBFqnCBsd6RMkjVDRZzb' } }), { voice: 'JBFqnCBsd6RMkjVDRZzb' });
  const other = { ...byteplus, id: 'opendesign:other-tts', modelId: 'other-tts' };
  assert.deepEqual(modelDefaults(other), {});
  assert.throws(() => validateGenerationOptions(other, {}), /Voice ID is required/);
  const prototypeName = { ...byteplus, id: 'opendesign:constructor', modelId: 'constructor' };
  assert.deepEqual(modelDefaults(prototypeName), {});
  assert.throws(() => validateGenerationOptions(prototypeName, {}), /Voice ID is required/);
  assert.deepEqual(modelDefaults({ ...byteplus, mode: 'text-to-audio' }), {});
  // Discovery shows the default through the schema; the model's saved defaults stay empty for Settings.
  const gateway = gatewayFor(store);
  await gateway.configureProvider('opendesign', { apiKey: 'fixture-only' });
  const { models } = await gateway.listModels({ provider: 'opendesign', modality: 'audio' });
  const listed = models.find(m => m.id === byteplus.id)!;
  assert.equal(listed.generationOptions!.fields[0].default, 'zh_female_vv_uranus_bigtts');
  assert.equal(listed.defaults?.voice, undefined);
  await gateway.close();
}));

test('AI/ML API built-in models expose their checked schemas and reject values outside them', () => {
  const byId = (id: string) => builtinModels.find(model => model.id === id)!;
  const keys = (id: string) => generationOptions(byId(id))?.fields.map(field => field.key);
  assert.deepEqual(keys('aimlapi:flux/schnell'), ['image_size', 'num_images', 'seed']);
  assert.deepEqual(keys('aimlapi:bytedance/seedance-1-0-pro-fast'), ['resolution', 'duration', 'camerafixed', 'seed']);
  assert.deepEqual(keys('aimlapi:stable-audio'), ['seconds_total', 'steps']);
  assert.deepEqual(keys('aimlapi:openai/tts-1'), ['voice', 'speed']);
  validateGenerationOptions(byId('aimlapi:bytedance/seedance-1-0-pro-fast'), { resolution: '480p', duration: 5 });
  assert.throws(() => validateGenerationOptions(byId('aimlapi:bytedance/seedance-1-0-pro-fast'), { duration: 7 }), /duration/);
  assert.throws(() => validateGenerationOptions(byId('aimlapi:flux/schnell'), { num_images: 5 }), /num_images/);
  assert.throws(() => validateGenerationOptions(byId('aimlapi:stable-audio'), { seconds_total: 60 }), /seconds_total/);
  assert.throws(() => validateGenerationOptions(byId('aimlapi:openai/tts-1'), { voice: 'robot' }), /voice/);
  // A live catalogue model of the same provider gets no guessed schema.
  assert.equal(generationOptions({ ...byId('aimlapi:flux/schnell'), id: 'aimlapi:vendor/other', modelId: 'vendor/other', source: 'live' }), undefined);
});
