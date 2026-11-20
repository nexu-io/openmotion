import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibleImageResolutions, generationOptions, modelDefaults, resolveGenerationParameters, usesInputImageRatio, validateGenerationOptions } from '../shared/generation-options.ts';
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

test('OpenDesign Cloud and account video models derive ratio, resolution and integer duration from published capabilities', () => {
  for (const provider of ['opendesign', 'account'] as const) {
    const model: Model = {
      id: `${provider}:wan-2.7`, provider, modelId: 'wan-2.7', label: 'Wan 2.7', modality: 'video', mode: 'text-to-video', source: 'live',
      nativeOptions: {
        ratios: { values: ['16:9', '9:16', '1:1'], default: '16:9' },
        resolutions: { values: ['720P', '1080P'], default: '720P' },
        durations: { values: [5, 10], default: 5 },
      },
    };
    const schema = generationOptions(model)!;
    assert.deepEqual(schema.fields.map(f => [f.key, f.default, f.presentation]), [
      ['ratio', '16:9', 'ratio'],
      ['resolution', '720P', undefined],
      ['duration', 5, undefined],
    ]);
    assert.doesNotThrow(() => validateGenerationOptions(model, { ratio: '9:16', resolution: '1080P', duration: 10 }));
    assert.throws(() => validateGenerationOptions(model, { duration: '5' }), /Invalid Duration/);
    assert.throws(() => validateGenerationOptions(model, { ratio: '21:9' }), /Invalid Aspect ratio/);
  }
  // Plain array capabilities (without { values, default } envelope) are also supported.
  const arrayModel: Model = {
    id: 'opendesign:kling-v2', provider: 'opendesign', modelId: 'kling-v2', label: 'Kling', modality: 'video', mode: 'text-to-video', source: 'live',
    nativeOptions: { ratios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], durations: [5, 10] },
  };
  const schema = generationOptions(arrayModel)!;
  assert.deepEqual(schema.fields.map(f => f.key), ['ratio', 'resolution', 'duration']);
  assert.equal(schema.fields[0].default, undefined);
});

test('OpenDesign Cloud and account image models derive paired profiles, complete missing pair values, and fall back to sizes', () => {
  const profiled: Model = {
    id: 'account:nano-banana-2', provider: 'account', modelId: 'nano-banana-2', label: 'Nano Banana 2', modality: 'image', mode: 'text-to-image', source: 'live',
    nativeOptions: {
      profiles: {
        generations: {
          profiles: [
            { aspect_ratio: '1:1', resolution: '1K' },
            { aspect_ratio: '1:1', resolution: '2K' },
            { aspect_ratio: '16:9', resolution: '2K' },
            { aspect_ratio: '9:16', resolution: '2K' },
          ],
          default: { aspect_ratio: '1:1', resolution: '1K' },
        },
      },
      quality: { values: ['standard', 'high'], default: 'standard' },
    },
  };
  const schema = generationOptions(profiled)!;
  assert.deepEqual(schema.fields.map(f => [f.key, f.default, f.presentation]), [
    ['aspect_ratio', '1:1', 'ratio'],
    ['resolution', '1K', undefined],
    ['quality', 'standard', undefined],
  ]);
  assert.deepEqual(compatibleImageResolutions(profiled, '1:1'), ['1K', '2K']);
  assert.deepEqual(compatibleImageResolutions(profiled, '16:9'), ['2K']);
  assert.deepEqual(resolveGenerationParameters(profiled, { aspect_ratio: '16:9' }), { aspect_ratio: '16:9', resolution: '2K' });
  assert.deepEqual(resolveGenerationParameters(profiled, { aspect_ratio: '1:1' }), { aspect_ratio: '1:1', resolution: '1K' });
  assert.deepEqual(resolveGenerationParameters(profiled, { resolution: '2K' }), { resolution: '2K', aspect_ratio: '1:1' });
  assert.throws(() => resolveGenerationParameters(profiled, { aspect_ratio: '16:9', resolution: '1K' }), /Resolution 1K is not available for aspect ratio 16:9/);
  assert.throws(() => resolveGenerationParameters(profiled, { aspect_ratio: '16:9', size: '1024x1024' }), /Cannot combine size with aspect_ratio or resolution/);
  assert.throws(() => resolveGenerationParameters(profiled, { aspect_ratio: '16:9', output: { aspect_ratio: '1:1', resolution: '1K' } }), /Cannot combine output with aspect_ratio or resolution/);
  assert.deepEqual(resolveGenerationParameters(profiled, { size: '1024x1024' }), { size: '1024x1024' });

  const sized: Model = {
    id: 'opendesign:gpt-image-1', provider: 'opendesign', modelId: 'gpt-image-1', label: 'GPT Image', modality: 'image', mode: 'text-to-image', source: 'live',
    nativeOptions: {
      sizes: { values: ['1024x1024', '1536x1024'], default: '1024x1024' },
      quality: { values: ['medium', 'high'], default: 'medium' },
    },
  };
  const sizedSchema = generationOptions(sized)!;
  assert.deepEqual(sizedSchema.fields.map(f => [f.key, f.default]), [['size', '1024x1024'], ['quality', 'medium']]);
});

test('OpenDesign image edit mode validates and filters against the distinct edits profile envelope', () => {
  const model: Model = {
    id: 'opendesign:nano-banana-2', provider: 'opendesign', modelId: 'nano-banana-2', label: 'Nano Banana 2', modality: 'image', mode: 'text-to-image', source: 'live',
    supportsImageReference: true,
    nativeOptions: {
      profiles: {
        generations: {
          profiles: [
            { aspect_ratio: '1:1', resolution: '1K' },
            { aspect_ratio: '16:9', resolution: '2K' },
          ],
          default: { aspect_ratio: '1:1', resolution: '1K' },
        },
        edits: {
          profiles: [{ aspect_ratio: '1:1', resolution: '2K' }],
          default: { aspect_ratio: '1:1', resolution: '2K' },
        },
      },
    },
  };
  assert.deepEqual(generationOptions(model, false)!.fields.map(f => [f.key, f.choices!.map(c => c.value)]), [
    ['aspect_ratio', ['1:1', '16:9']],
    ['resolution', ['1K', '2K']],
  ]);
  assert.deepEqual(generationOptions(model, true)!.fields.map(f => [f.key, f.choices!.map(c => c.value)]), [
    ['aspect_ratio', ['1:1']],
    ['resolution', ['2K']],
  ]);
  assert.deepEqual(compatibleImageResolutions(model, '16:9', false), ['2K']);
  assert.deepEqual(compatibleImageResolutions(model, '16:9', true), []);
  assert.deepEqual(compatibleImageResolutions(model, '1:1', true), ['2K']);
  assert.deepEqual(resolveGenerationParameters(model, { aspect_ratio: '1:1' }, true), { aspect_ratio: '1:1', resolution: '2K' });
  assert.throws(() => resolveGenerationParameters(model, { aspect_ratio: '16:9', resolution: '2K' }, true), /Aspect ratio 16:9 is not available/);
  assert.throws(() => resolveGenerationParameters(model, { aspect_ratio: '16:9' }, true), /Aspect ratio 16:9 is not available/);
  assert.throws(() => resolveGenerationParameters(model, { resolution: '1K' }, true), /Resolution 1K is not available/);
  assert.throws(() => resolveGenerationParameters(model, { images: ['ma_1'], aspect_ratio: '16:9', resolution: '2K' }), /Aspect ratio 16:9 is not available/);
  assert.throws(() => validateGenerationOptions(model, { aspect_ratio: '16:9', resolution: '2K' }, true), /Invalid Aspect ratio/);
  assert.doesNotThrow(() => validateGenerationOptions(model, { aspect_ratio: '1:1', resolution: '2K' }, true));
  // Saved generation-only defaults are dropped during edit mode when the caller did not specify them.
  const withDefaults: Model = { ...model, defaults: { aspect_ratio: '16:9', resolution: '1K' } };
  assert.deepEqual(resolveGenerationParameters(withDefaults, {}, true), {});
});

test('OpenDesign Cloud packs image aspect_ratio and resolution into output, preserves explicit output, and rejects lone fields without profiles', async () => {
  const bodies: Record<string, unknown>[] = [];
  const model: Model = {
    id: 'opendesign:nano-banana-2', provider: 'opendesign', modelId: 'nano-banana-2', label: 'Nano Banana 2', modality: 'image', mode: 'text-to-image', source: 'live',
    nativeOptions: {
      profiles: {
        generations: {
          profiles: [{ aspect_ratio: '9:16', resolution: '2K' }, { aspect_ratio: '1:1', resolution: '1K' }],
          default: { aspect_ratio: '1:1', resolution: '1K' },
        },
      },
    },
  };
  const unprofiled: Model = { id: 'opendesign:custom-image', provider: 'opendesign', modelId: 'custom-image', label: 'Custom Image', modality: 'image', mode: 'text-to-image', source: 'live' };
  const run = async (target: Model, parameters: Record<string, unknown>) => providerAdapters.opendesign.generate(
    { id: 'job-1', model: target, modality: 'image', prompt: 'A poster', parameters } as GenerationJob,
    {
      key: 'fixture-only', baseUrl: 'https://cloud.example', signal: new AbortController().signal, progress: async () => {}, pollMs: 0,
      fetcher: async (url, init) => {
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ task_id: 'task_1' });
        }
        assert.match(String(url), /\/images\/tasks\/task_1$/);
        return Response.json({ status: 'succeeded', assets: [{ url: 'https://cdn.example/out.png' }] });
      },
    },
  );
  await run(model, { aspect_ratio: '9:16', quality: 'high' });
  await run(model, { output: { aspect_ratio: '1:1', resolution: '1K' } });
  await run(unprofiled, { aspect_ratio: '16:9', resolution: '2K' });
  assert.deepEqual(bodies[0], { model: 'nano-banana-2', prompt: 'A poster', quality: 'high', output: { aspect_ratio: '9:16', resolution: '2K' } });
  assert.deepEqual(bodies[1], { model: 'nano-banana-2', prompt: 'A poster', output: { aspect_ratio: '1:1', resolution: '1K' } });
  assert.deepEqual(bodies[2], { model: 'custom-image', prompt: 'A poster', output: { aspect_ratio: '16:9', resolution: '2K' } });
  await assert.rejects(run(unprofiled, { aspect_ratio: '16:9' }), /require both aspect_ratio and resolution together/);
  await assert.rejects(run(unprofiled, { resolution: '2K' }), /require both aspect_ratio and resolution together/);
  await assert.rejects(run(unprofiled, { aspect_ratio: '16:9', resolution: '2K', size: '1024x1024' }), /Cannot combine size/);
  await assert.rejects(run(unprofiled, { aspect_ratio: '16:9', resolution: '2K', output: { aspect_ratio: '1:1', resolution: '1K' } }), /Cannot combine output/);
  assert.equal(bodies.length, 3);
});

test('account media model sync preserves capabilities in nativeOptions for generationOptions', () => fixture(async store => {
  const account = new OpenDesignAccount(store.directory, {
    run: async args => {
      if (args[0] === 'model') return JSON.stringify({ source: 'remote', data: [] });
      if (args[0] === 'media') return JSON.stringify({
        models: [
          { model: 'wan-2.7', kind: 'video', capabilities: { ratios: { values: ['16:9', '9:16'], default: '16:9' }, durations: { values: [5, 10], default: 5 } } },
        ],
      });
      return '{}';
    },
  });
  account.identity = async () => 'fixture-session';
  (account as any).profile = async () => ({ runtimeKey: 'runtime-key' });
  try {
    await account.models(true);
    const [video] = await account.mediaModels();
    assert.equal(video.id, 'account:wan-2.7');
    assert.deepEqual(generationOptions(video)!.fields.map(f => f.key), ['ratio', 'duration']);
  } finally { account.close(); }
}));
