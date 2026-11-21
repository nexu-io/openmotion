import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '../shared/gateway.ts';
import { generationOptions } from '../shared/generation-options.ts';
import { imageFeatureCapable, imageFeatureSupported, type ImageFeatureId } from '../shared/image-features.ts';
import { modelCapabilities } from '../shared/model-capabilities.ts';
import { openDesignImageReferenceCap, openDesignModels } from '../shared/opendesign-models.ts';
import { videoFeatureCapable, videoFeatureParameters, videoFeatureSupported, type VideoFeatureId } from '../shared/video-features.ts';

const imageModel = (overrides: Partial<Model>): Model => ({
  id: 'opendesign:test-image',
  provider: 'opendesign',
  modelId: 'test-image',
  label: 'Test Image',
  modality: 'image',
  mode: 'text-to-image',
  source: 'live',
  ...overrides,
});

const videoModel = (overrides: Partial<Model>): Model => ({
  id: 'opendesign:test-video',
  provider: 'opendesign',
  modelId: 'test-video',
  label: 'Test Video',
  modality: 'video',
  mode: 'text-to-video',
  source: 'live',
  ...overrides,
});

const placeholderOpenDesignModel = (provider: 'opendesign' | 'account', modelId: string): Model => {
  const entry = openDesignModels.find(item => item.modelId === modelId)!;
  const placeholder: Model = {
    id: `${provider}:${entry.modelId}`,
    provider,
    modelId: entry.modelId,
    label: entry.label,
    modality: entry.modality,
    mode: entry.mode,
    source: 'builtin',
  };
  const cap = entry.modality === 'image' ? openDesignImageReferenceCap(entry.modelId) : undefined;
  if (cap) Object.assign(placeholder, { supportsImageReference: true, maxInputImages: cap });
  else if (entry.modality === 'video') Object.assign(placeholder, { maxInputImages: 1 });
  const options = generationOptions(placeholder);
  return options ? { ...placeholder, generationOptions: options } : placeholder;
};

test('existing OpenDesign image and video models keep exact feature eligibility across Cloud, account and placeholders', () => {
  const imageMatrix: [string, Record<ImageFeatureId, boolean>][] = [
    ['gpt-image-2.6-sunburst', { 'remove-background': true, relight: true, character: true }],
    ['gpt-image-2.6-flare', { 'remove-background': true, relight: true, character: true }],
    ['seedream-5.5', { 'remove-background': false, relight: true, character: true }],
    ['seedream-5.0-flash', { 'remove-background': false, relight: true, character: true }],
  ];
  const videoMatrix: [string, Record<VideoFeatureId, boolean>][] = [
    ['doubao-seedance-2-5-260628', { 'camera-control': true, 'multi-shot': true }],
    ['doubao-seedance-2-5-flash-261115', { 'camera-control': true, 'multi-shot': true }],
    ['wan-2.7', { 'camera-control': true, 'multi-shot': true }],
  ];

  for (const provider of ['opendesign', 'account'] as const) {
    for (const [modelId, expected] of imageMatrix) {
      const live = imageModel({
        id: `${provider}:${modelId}`, provider, modelId,
        supportsImageReference: true, maxInputImages: openDesignImageReferenceCap(modelId) ?? 1,
      });
      const placeholder = placeholderOpenDesignModel(provider, modelId);
      for (const candidate of [live, placeholder]) {
        for (const [feature, ok] of Object.entries(expected) as [ImageFeatureId, boolean][]) {
          assert.equal(imageFeatureSupported(feature, candidate), ok, `${provider}:${modelId} (${candidate.source}) -> ${feature}`);
        }
      }
    }
    for (const [modelId, expected] of videoMatrix) {
      const live = videoModel({ id: `${provider}:${modelId}`, provider, modelId, maxInputImages: 1 });
      const placeholder = placeholderOpenDesignModel(provider, modelId);
      for (const candidate of [live, placeholder]) {
        for (const [feature, ok] of Object.entries(expected) as [VideoFeatureId, boolean][]) {
          assert.equal(videoFeatureSupported(feature, candidate), ok, `${provider}:${modelId} (${candidate.source}) -> ${feature}`);
        }
      }
    }
  }
});

test('modelCapabilities derives image edit, reference limits and transparent background without model ID allowlists', () => {
  const futureTransparent = imageModel({
    id: 'opendesign:future-studio-image-v3',
    modelId: 'future-studio-image-v3',
    supportsImageReference: true,
    maxInputImages: 8,
    nativeOptions: { background: ['opaque', 'transparent'] },
  });
  const futureNoEdit = imageModel({
    id: 'opendesign:future-txt2img-only',
    modelId: 'future-txt2img-only',
    supportsImageReference: false,
    maxInputImages: 0,
  });
  // An image-to-image endpoint with zero reference limit cannot satisfy reference-backed image features.
  const zeroRefI2i = imageModel({
    id: 'opendesign:broken-i2i',
    modelId: 'broken-i2i',
    mode: 'image-to-image',
    supportsImageReference: false,
    maxInputImages: 0,
    nativeOptions: { background: ['transparent'] },
  });
  const codex = imageModel({ id: 'codex:image-generation', provider: 'codex', modelId: 'image-generation', source: 'builtin', supportsImageReference: true, maxInputImages: 1 });
  const falFlux = imageModel({ id: 'fal:fal-ai/flux/schnell', provider: 'fal', modelId: 'fal-ai/flux/schnell', source: 'builtin' });

  assert.deepEqual(modelCapabilities(futureTransparent).image, { edit: true, maxReferences: 8, transparentBackground: true });
  assert.deepEqual(modelCapabilities(futureNoEdit).image, { edit: false, maxReferences: 0, transparentBackground: false });
  assert.deepEqual(modelCapabilities(zeroRefI2i).image, { edit: false, maxReferences: 0, transparentBackground: true });
  assert.deepEqual(modelCapabilities(codex).image, { edit: true, maxReferences: 1, transparentBackground: true });
  assert.deepEqual(modelCapabilities(falFlux).image, { edit: false, maxReferences: 0, transparentBackground: false });

  assert.equal(imageFeatureSupported('remove-background', futureTransparent), true);
  assert.equal(imageFeatureSupported('relight', futureTransparent), true);
  assert.equal(imageFeatureSupported('character', futureTransparent), true);
  assert.equal(imageFeatureSupported('relight', futureNoEdit), false);
  assert.equal(imageFeatureSupported('character', futureNoEdit), false);
  assert.equal(imageFeatureSupported('remove-background', zeroRefI2i), false);

  // Pure capability checks remain provider-agnostic, while Studio feature checks scope to OpenDesign.
  assert.equal(imageFeatureCapable('remove-background', codex), true);
  assert.equal(imageFeatureSupported('remove-background', codex), false);
  assert.equal(imageFeatureCapable('relight', falFlux), false);
});

test('videoFeatureParameters strictly honors published duration schemas and keeps BYOK consistent', () => {
  // Seedance publishing durations that omit 10s must NOT fall back to the static 4–30s table.
  const narrowSeedance = videoModel({
    modelId: 'doubao-seedance-2-5-260628',
    maxInputImages: 1,
    nativeOptions: { durations: [5, 4, 6, 8, 12] },
  });
  const narrowWan = videoModel({
    modelId: 'wan-2.7',
    maxInputImages: 1,
    nativeOptions: { durations: [5, 2, 15] },
  });
  const futureVideo = videoModel({
    id: 'opendesign:future-video-3',
    modelId: 'future-video-3',
    nativeOptions: { durations: [4, 5, 10, 20] },
  });
  const imageOnlyVideo = videoModel({
    id: 'opendesign:future-i2v-only',
    modelId: 'future-i2v-only',
    mode: 'image-to-video',
    maxInputImages: 1,
  });
  const atlasSeedance = videoModel({
    id: 'atlascloud:bytedance/seedance-2.0/text-to-video',
    provider: 'atlascloud',
    modelId: 'bytedance/seedance-2.0/text-to-video',
    source: 'builtin',
  });

  assert.deepEqual(videoFeatureParameters('multi-shot', narrowSeedance), {});
  assert.deepEqual(videoFeatureParameters('multi-shot', narrowWan), {});
  assert.deepEqual(videoFeatureParameters('multi-shot', futureVideo), { duration: 10 });
  assert.equal(videoFeatureSupported('camera-control', futureVideo), true);
  assert.equal(videoFeatureSupported('multi-shot', imageOnlyVideo), false);

  // BYOK video models never receive OpenDesign seeded parameters regardless of full Model vs Pick shape,
  // while remaining capability-eligible for provider-agnostic consumers such as Workflows.
  assert.deepEqual(videoFeatureParameters('multi-shot', atlasSeedance), {});
  assert.deepEqual(videoFeatureParameters('multi-shot', { provider: 'atlascloud', modelId: 'bytedance/seedance-2.0/text-to-video' }), {});
  assert.equal(videoFeatureCapable('multi-shot', atlasSeedance), true);
  assert.equal(videoFeatureCapable('camera-control', atlasSeedance), true);
  assert.equal(videoFeatureSupported('multi-shot', atlasSeedance), false);
});
