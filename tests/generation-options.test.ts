import test from 'node:test';
import assert from 'node:assert/strict';
import { generationOptions, validateGenerationOptions } from '../shared/generation-options.ts';
import { builtinModels } from '../gateway/catalog.ts';
import { fixture } from './fixtures.ts';
import { gatewayFor } from '../gateway/service.ts';
import { providerAdapters } from '../gateway/providers.ts';
import type { GenerationJob } from '../shared/gateway.ts';

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
