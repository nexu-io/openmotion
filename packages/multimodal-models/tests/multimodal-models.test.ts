import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDesignImageReferenceCap, openDesignModels } from '../../../shared/opendesign-models.ts';
import { openDesignVideoModels } from '../../../shared/video-features.ts';
import {
  assertValidShard,
  buildCanonicalModels,
  buildCuratedShard,
  classifyMultimodalTask,
  classifyParameterTier,
  compareModels,
  createRegistryFromShards,
  formatComparisonMarkdown,
  getCanonicalModel,
  getEndpoint,
  inferCapabilitiesFromParameters,
  listCanonicalModels,
  listEndpoints,
  loadRegistry,
  normalizeOpenApiParameters,
  resolveCanonicalIdentity,
  runSync,
  sanitizeModelsDevProviderId,
  searchModels,
  syncFalSource,
  toOpenMotionGenerationOptions,
  validateModelParameters,
  type ModelEndpointEntry,
} from '../src/index.ts';

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

test('normalizeOpenApiParameters resolves $ref, anyOf unions, x-fal-order-properties, and canonical parameter keys', () => {
  const sampleOpenApi = {
    components: {
      schemas: {
        ImageSize: {
          type: 'object',
          properties: { width: { type: 'integer' }, height: { type: 'integer' } },
        },
        SeedanceInput: {
          type: 'object',
          'x-fal-order-properties': ['prompt', 'aspect_ratio', 'duration', 'generate_audio', 'reference_images', 'end_image_url'],
          required: ['prompt'],
          properties: {
            generate_audio: { type: 'boolean', default: true, description: 'Generate synchronized audio.' },
            prompt: { type: 'string', description: 'Scene prompt.' },
            aspect_ratio: { type: 'string', enum: ['auto', '16:9', '9:16', '1:1'], default: 'auto' },
            duration: {
              anyOf: [{ type: 'string', enum: ['auto', '4', '5', '10', '30'] }, { type: 'null' }],
              default: '5',
            },
            reference_images: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 10,
            },
            end_image_url: { type: 'string' },
            image_size: {
              anyOf: [{ type: 'string', enum: ['square_hd', 'landscape_16_9'] }, { $ref: '#/components/schemas/ImageSize' }],
              default: 'landscape_16_9',
            },
          },
        },
      },
    },
  };

  const { parameters, standardParameterMap, requiredParameters } = normalizeOpenApiParameters(sampleOpenApi, 'video');
  assert.deepEqual(requiredParameters, ['prompt']);
  assert.equal(parameters[0].key, 'prompt');
  assert.equal(parameters[1].key, 'aspect_ratio');
  assert.equal(parameters[2].key, 'duration');
  assert.equal(standardParameterMap.aspectRatio, 'aspect_ratio');
  assert.equal(standardParameterMap.duration, 'duration');
  assert.equal(standardParameterMap.generateAudio, 'generate_audio');
  assert.equal(standardParameterMap.referenceImages, 'reference_images');
  assert.equal(standardParameterMap.endImage, 'end_image_url');

  const sizeField = parameters.find(p => p.key === 'image_size')!;
  assert.equal(sizeField.allowCustom, true);
  assert.deepEqual(sizeField.enum, ['square_hd', 'landscape_16_9']);

  const caps = inferCapabilitiesFromParameters('video', ['text-to-video', 'reference-to-video'], parameters);
  assert.equal(caps.supportsNativeAudio, true);
  assert.equal(caps.supportsFirstLastFrame, true);
  assert.equal(caps.maxReferenceImages, 10);
  assert.equal(caps.duration?.min, 4);
  assert.equal(caps.duration?.max, 30);
  assert.equal(caps.duration?.supportsAuto, true);
  assert.ok(caps.inputModalities.includes('image'));
  assert.ok(caps.outputModalities.includes('audio'));
});

test('resolveCanonicalIdentity and classifyMultimodalTask group cross-provider aliases cleanly', () => {
  assert.equal(resolveCanonicalIdentity('bytedance/seedance-2.5/us/text-to-video').canonicalId, 'bytedance/seedance-2.5');
  assert.equal(resolveCanonicalIdentity('doubao-seedance-2-5-260628', 'Seedance 2.5').canonicalId, 'bytedance/seedance-2.5');
  assert.equal(resolveCanonicalIdentity('openai/gpt-image-2.6/sunburst/edit').canonicalId, 'openai/gpt-image-2.6-sunburst');
  assert.equal(resolveCanonicalIdentity('fal-ai/veo3.1/fast/first-last-frame-to-video').canonicalId, 'google/veo-3.1-fast');
  assert.equal(resolveCanonicalIdentity('alibaba/wan-3.0/text-to-video').canonicalId, 'alibaba/wan-3.0');
  assert.equal(resolveCanonicalIdentity('kling/v4/reference-to-video').canonicalId, 'kuaishou/kling-4');

  // Task path segments must not leak into canonical variant tokens
  assert.equal(resolveCanonicalIdentity('fal-ai/wan/v2.7/image-to-video').canonicalId, 'alibaba/wan-2.7');
  assert.equal(resolveCanonicalIdentity('fal-ai/wan/v2.7/text-to-video').canonicalId, 'alibaba/wan-2.7');
  assert.equal(resolveCanonicalIdentity('fal-ai/wan/v2.7/edit-video').canonicalId, 'alibaba/wan-2.7');
  assert.equal(resolveCanonicalIdentity('fal-ai/wan/v2.7/image').canonicalId, 'alibaba/wan-2.7-image');

  assert.deepEqual(classifyMultimodalTask('first-last-frame-to-video'), {
    modality: 'video',
    primaryTask: 'first-last-frame-to-video',
    tasks: ['first-last-frame-to-video', 'image-to-video'],
  });
  // Explicit video endpoint slugs must win over capability tags like `lipsync`
  assert.deepEqual(
    classifyMultimodalTask('text-to-video bytedance/seedance-2.5/us/text-to-video', undefined, ['lipsync', 'avatar']),
    { modality: 'video', primaryTask: 'text-to-video', tasks: ['text-to-video'] },
  );
  assert.deepEqual(
    classifyMultimodalTask('image-to-video fal-ai/wan/v2.7/image-to-video lipsync'),
    { modality: 'video', primaryTask: 'image-to-video', tasks: ['image-to-video'] },
  );
  assert.equal(classifyMultimodalTask('text-to-text llm chat'), null);
});

test('max_images maps to count rather than layer decomposition, and buildCanonicalModels never mixes modalities', () => {
  const { parameters, standardParameterMap } = normalizeOpenApiParameters({
    components: {
      schemas: {
        Input: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            max_images: { type: 'integer', minimum: 1, maximum: 8, default: 1 },
          },
        },
      },
    },
  }, 'image');
  assert.equal(standardParameterMap.count, 'max_images');
  assert.equal(standardParameterMap.maxLayers, undefined);
  const caps = inferCapabilitiesFromParameters('image', ['text-to-image'], parameters);
  assert.equal(caps.supportsLayerDecomposition, undefined);

  const layerCaps = inferCapabilitiesFromParameters('image', ['layerize'], parameters);
  assert.equal(layerCaps.supportsLayerDecomposition, true);

  const makeEp = (id: string, modality: ModelEndpointEntry['modality'], task: ModelEndpointEntry['primaryTask']): ModelEndpointEntry => ({
    id,
    canonicalId: 'minimax/hailuo',
    family: 'hailuo',
    creator: 'MiniMax',
    provider: 'fal',
    endpointId: id,
    displayName: 'MiniMax Hailuo',
    modality,
    primaryTask: task,
    tasks: [task],
    source: 'fal',
    schemaQuality: 'openapi-live',
    status: 'active',
    capabilities: { inputModalities: ['text'], outputModalities: [modality === '3d' ? '3d' : modality], tasks: [task] },
    parameters: [],
    standardParameterMap: {},
    requiredParameters: [],
    syncedAt: '2026-11-23T00:00:00.000Z',
  });

  const canonical = buildCanonicalModels([
    makeEp('fal:minimax/hailuo/t2v', 'video', 'text-to-video'),
    makeEp('fal:minimax/hailuo/i2v', 'video', 'image-to-video'),
    makeEp('fal:minimax/hailuo/image', 'image', 'text-to-image'),
    makeEp('fal:minimax/hailuo/tts', 'audio', 'text-to-speech'),
  ]);
  assert.equal(canonical['minimax/hailuo']?.modality, 'video');
  assert.deepEqual([...(canonical['minimax/hailuo']?.endpointIds ?? [])].sort(), ['fal:minimax/hailuo/i2v', 'fal:minimax/hailuo/t2v']);
  assert.equal(canonical['minimax/hailuo-image']?.modality, 'image');
  assert.equal(canonical['minimax/hailuo-audio']?.modality, 'audio');
});

test('curated shard stays aligned with shared OpenDesign contracts and Codex prompt delivery', () => {
  const curated = buildCuratedShard();
  const byId = new Map(curated.endpoints.map(ep => [ep.id, ep]));

  for (const model of openDesignModels) {
    const ep = byId.get(`opendesign:${model.modelId}`);
    assert.ok(ep, `Missing curated OpenDesign endpoint for ${model.modelId}`);
    assert.equal(ep.displayName, model.label);
    assert.equal(ep.modality, model.modality);
    const refCap = openDesignImageReferenceCap(model.modelId);
    if (refCap !== undefined) {
      assert.equal(ep.capabilities.maxReferenceImages, refCap, `Reference cap mismatch for ${model.modelId}`);
    }
  }

  for (const video of openDesignVideoModels) {
    const ep = byId.get(`opendesign:${video.modelId}`);
    assert.ok(ep, `Missing curated OpenDesign video endpoint for ${video.modelId}`);
    assert.equal(ep.capabilities.duration?.min, video.durations.min);
    assert.equal(ep.capabilities.duration?.max, video.durations.max);
    assert.equal(ep.capabilities.duration?.default, video.durations.default);
    assert.deepEqual(ep.capabilities.resolutions, [...video.resolutions]);
  }

  const codex = byId.get('codex:image-generation');
  assert.ok(codex, 'Expected codex:image-generation curated endpoint');
  assert.equal(toOpenMotionGenerationOptions(codex).delivery, 'prompt');
});

test('syncFalSource surfaces failures and runSync preserves previous shards without leaving orphans', async () => {
  const alwaysFail = async () => {
    throw new Error('simulated network outage');
  };
  const failedFal = await syncFalSource({ scope: 'flagship', fetcher: alwaysFail });
  assert.equal(failedFal.report.status, 'error');
  assert.equal(failedFal.report.endpointCount, 0);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mm-sync-test-'));
  try {
    const curated = buildCuratedShard();
    const prevFal = {
      ...curated,
      shardId: 'fal',
      source: 'fal' as const,
      endpoints: curated.endpoints.slice(0, 1).map(ep => ({ ...ep, id: 'fal:test/model', provider: 'fal', source: 'fal' as const })),
    };
    mkdirSync(path.join(tmpDir, 'providers'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'providers', 'fal.json'), JSON.stringify(prevFal, null, 2));

    const res = await runSync({
      scope: 'flagship',
      outputDir: tmpDir,
      sources: ['curated', 'fal'],
      fetcher: alwaysFail,
    });
    const falReport = res.reports.find(r => r.source === 'fal');
    assert.equal(falReport?.status, 'error');
    assert.ok(res.manifest.shards.includes('providers/fal.json'), 'Expected previous fal shard to remain in manifest');
    assert.ok(res.shards.some(s => s.shardId === 'fal' && s.endpoints.length === 1));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validateModelParameters translates canonical keys, checks constraints, and produces provider wire payloads', () => {
  const curatedRegistry = createRegistryFromShards([buildCuratedShard()]);
  const seedance = getEndpoint('opendesign:doubao-seedance-2-5-260628', curatedRegistry)!;
  assert.ok(seedance);

  // Valid request using canonical StandardParameterKey names
  const ok = validateModelParameters(
    seedance,
    { prompt: 'Waves crashing at sunset', aspectRatio: '16:9', resolution: '1080p', duration: 12, generateAudio: false },
    { strictUnknown: true },
    curatedRegistry,
  );
  assert.equal(ok.valid, true, JSON.stringify(ok.issues));
  assert.equal(ok.resolvedPayload.ratio, '16:9');
  assert.equal(ok.resolvedPayload.resolution, '1080p');
  assert.equal(ok.resolvedPayload.duration, 12);
  assert.equal(ok.resolvedPayload.generate_audio, false);

  // Unchanged schema defaults must stay out of resolvedPayload (returned separately in defaults)
  const minimal = validateModelParameters(
    seedance,
    { prompt: 'Minimal prompt only' },
    { strictUnknown: true },
    curatedRegistry,
  );
  assert.equal(minimal.valid, true);
  assert.deepEqual(Object.keys(minimal.resolvedPayload), ['prompt']);
  assert.equal(minimal.defaults.duration, 5);

  // Invalid enum, out-of-range duration, and missing required prompt
  const bad = validateModelParameters(
    seedance,
    { aspectRatio: '5:4', duration: 99, bogusField: true },
    { strictUnknown: true },
    curatedRegistry,
  );
  assert.equal(bad.valid, false);
  const codes = new Set(bad.issues.map(i => i.code));
  assert.ok(codes.has('missing_required'));
  assert.ok(codes.has('invalid_enum'));
  assert.ok(codes.has('out_of_range'));
  assert.ok(codes.has('unknown_parameter'));
});

test('persisted live registry shards load cleanly, stay below 1 MiB, and support query, compare, and OpenMotion bridge', () => {
  const registry = loadRegistry({ forceReload: true });

  // Verify every generated file stays below the repository's 1 MiB ordinary Git file limit
  for (const rel of ['index.json', 'sources-report.json', ...registry.sources.filter(s => s.endpointCount > 0).map(s => `providers/${s.source}.json`)]) {
    const size = statSync(path.join(DATA_DIR, rel)).size;
    assert.ok(size < 1024 * 1024, `${rel} exceeds 1 MiB (${size} bytes)`);
  }

  assert.ok(registry.stats.totalEndpoints >= 100, `Expected >= 100 endpoints, got ${registry.stats.totalEndpoints}`);
  assert.ok(registry.stats.withDetailedSchema >= 50, `Expected >= 50 endpoints with detailed schemas, got ${registry.stats.withDetailedSchema}`);
  assert.ok(registry.stats.byModality.image > 0);
  assert.ok(registry.stats.byModality.video > 0);
  assert.ok(registry.stats.byModality.audio > 0);

  // Key flagship models requested by user must be queryable with real parameters
  const seedance = getCanonicalModel('bytedance/seedance-2.5', registry);
  assert.ok(seedance, 'Expected bytedance/seedance-2.5 canonical model');
  assert.ok(seedance.standardParameters.duration, 'Seedance 2.5 should expose duration parameter');
  assert.ok(seedance.standardParameters.aspectRatio, 'Seedance 2.5 should expose aspectRatio parameter');
  assert.ok(seedance.standardParameters.generateAudio, 'Seedance 2.5 should expose generateAudio parameter');

  const seedream = getCanonicalModel('bytedance/seedream-5.5', registry);
  assert.ok(seedream, 'Expected bytedance/seedream-5.5 canonical model');
  assert.equal(seedream.modality, 'image');

  const gptImage2 = getCanonicalModel('openai/gpt-image-2', registry);
  assert.ok(gptImage2, 'Expected openai/gpt-image-2 canonical model');
  assert.ok(gptImage2.standardParameters.quality);
  assert.ok(gptImage2.standardParameters.background);

  // Filter & search
  const nativeAudioVideos = listEndpoints({ modality: 'video', supportsNativeAudio: true, detailedSchemaOnly: true }, registry);
  assert.ok(nativeAudioVideos.length >= 5);
  const hits = searchModels('seedream', { modality: 'image', limit: 10 }, registry);
  assert.ok(hits.length >= 2);
  assert.ok(listCanonicalModels({ family: 'seedance' }, registry).length >= 1);

  // Side-by-side comparison matrix
  const cmp = compareModels(['bytedance/seedance-2.5', 'google/veo-3.1', 'openai/sora-2-pro'], registry);
  assert.equal(cmp.models.length, 3);
  assert.ok(cmp.sharedStandardParameters.includes('duration'));
  const md = formatComparisonMarkdown(cmp);
  assert.match(md, /Seedance 2\.5/);
  assert.match(md, /Veo 3\.1/);
  assert.match(md, /Sora 2 Pro/);

  // OpenMotion GenerationOptions bridge
  const bestSeedanceEp = getEndpoint('bytedance/seedance-2.5', registry)!;
  const genOpts = toOpenMotionGenerationOptions(bestSeedanceEp);
  assert.equal(genOpts.delivery, 'provider');
  assert.ok(genOpts.fields.length >= 3);
  assert.ok(genOpts.fields.some(f => f.presentation === 'ratio'));
  assert.ok(genOpts.fields.every(f => f.tier === 'primary' || f.tier === 'advanced'));
  assert.ok(genOpts.fields.every(f => typeof f.uiOrder === 'number'));
  assert.equal(classifyParameterTier('video', 'duration', 'duration'), 'primary');
  assert.equal(classifyParameterTier('video', 'seed', 'seed'), 'advanced');
  assert.equal(classifyParameterTier('image', 'aspect_ratio', 'aspectRatio'), 'primary');
  assert.equal(classifyParameterTier('image', 'negative_prompt', 'negativePrompt'), 'advanced');
  assert.equal(classifyParameterTier('audio', 'voice', 'voice'), 'primary');
  assert.equal(classifyParameterTier('audio', 'speed', 'speed'), 'advanced');

  // Curated shard validates cleanly
  assertValidShard(buildCuratedShard());

  // No canonical model record may mix endpoints of different modalities
  for (const record of Object.values(registry.canonicalModels)) {
    for (const epId of record.endpointIds) {
      const ep = registry.endpoints[epId];
      assert.ok(ep, `Canonical record ${record.id} references missing endpoint ${epId}`);
      assert.equal(ep.modality, record.modality, `Canonical record ${record.id} mixes modality ${ep.modality} into ${record.modality}`);
    }
  }

  // Flagship fal video endpoints must not be misclassified as lip-sync due to tags
  const falSeedance = registry.endpoints['fal:bytedance/seedance-2.5/us/text-to-video'];
  if (falSeedance) {
    assert.equal(falSeedance.primaryTask, 'text-to-video');
  }

  // Sanitized models.dev provider IDs must not emit `token...:<slug>` patterns that trigger secret scanners
  assert.equal(sanitizeModelsDevProviderId('alibaba-token-plan'), 'modelsdev-alibaba-quota-plan');
  const modelsDevRaw = readFileSync(path.join(DATA_DIR, 'providers', 'models-dev.json'), 'utf8');
  assert.equal(/modelsdev-[^"]*token[^"]*:/.test(modelsDevRaw), false);
});
