import { describe, expect, it } from 'vitest';
import { enrichGenerationOptionsWithSSOT, generationOptions } from '../../../shared/generation-options';
import type { Model } from '../../../shared/gateway';
import {
  applyModelParamChange,
  buildMediaHiddenDirective,
  migrateModelParameters,
  preferredAudioModelFilter,
  preferredAudioModelFilters,
  preferredImageModelFilter,
  preferredImageModelFilters,
  preferredVideoModelFilter,
  resolveEffectiveMediaModel,
  resolveSubmittedMediaParameters,
  resolveSuperAgentModelSchema,
} from './modelParams';

function makeBuiltinModel(partial: Omit<Model, 'generationOptions'>): Model {
  return {
    ...partial,
    generationOptions: generationOptions(partial),
  };
}

describe('Super Agent SSOT modelParams', () => {
  const nanoBanana = makeBuiltinModel({
    id: 'atlascloud:google/nano-banana-2/text-to-image',
    provider: 'atlascloud',
    modelId: 'google/nano-banana-2/text-to-image',
    label: 'Nano Banana 2',
    modality: 'image',
    mode: 'text-to-image',
    source: 'builtin',
  });

  const fluxSchnell = makeBuiltinModel({
    id: 'fal:fal-ai/flux/schnell',
    provider: 'fal',
    modelId: 'fal-ai/flux/schnell',
    label: 'FLUX.1 Schnell',
    modality: 'image',
    mode: 'text-to-image',
    source: 'builtin',
  });

  const codexImage = makeBuiltinModel({
    id: 'codex:image-generation',
    provider: 'codex',
    modelId: 'image-generation',
    label: 'Codex Image',
    modality: 'image',
    mode: 'text-to-image',
    source: 'builtin',
    supportsImageReference: true,
    maxInputImages: 1,
  });

  const seedance = makeBuiltinModel({
    id: 'atlascloud:bytedance/seedance-2.0/text-to-video',
    provider: 'atlascloud',
    modelId: 'bytedance/seedance-2.0/text-to-video',
    label: 'Seedance 2.0',
    modality: 'video',
    mode: 'text-to-video',
    source: 'builtin',
  });

  const wan22 = makeBuiltinModel({
    id: 'fal:fal-ai/wan/v2.2-a14b/text-to-video',
    provider: 'fal',
    modelId: 'fal-ai/wan/v2.2-a14b/text-to-video',
    label: 'Wan 2.2',
    modality: 'video',
    mode: 'text-to-video',
    source: 'builtin',
  });

  const sunoMusic = makeBuiltinModel({
    id: 'atlascloud:suno/chirp-v4',
    provider: 'atlascloud',
    modelId: 'suno/chirp-v4',
    label: 'Suno v4',
    modality: 'audio',
    mode: 'text-to-audio',
    source: 'builtin',
  });

  const kokoroTts = makeBuiltinModel({
    id: 'fal:fal-ai/kokoro/american-english',
    provider: 'fal',
    modelId: 'fal-ai/kokoro/american-english',
    label: 'Kokoro TTS',
    modality: 'audio',
    mode: 'text-to-speech',
    source: 'builtin',
  });

  it('resolves explicit, route, and sub-scene/audio-type preferred models', () => {
    const models = [sunoMusic, kokoroTts, nanoBanana, codexImage];
    const routes = { audio: sunoMusic.id, image: nanoBanana.id };

    expect(resolveEffectiveMediaModel(models, routes, 'audio', 'auto')?.id).toBe(sunoMusic.id);
    expect(
      resolveEffectiveMediaModel(models, routes, 'audio', 'auto', preferredAudioModelFilter('voiceover'))?.id,
    ).toBe(kokoroTts.id);
    expect(
      resolveEffectiveMediaModel(models, routes, 'image', 'auto', preferredImageModelFilter('relight'))?.id,
    ).toBe(codexImage.id);
    expect(resolveEffectiveMediaModel(models, routes, 'audio', kokoroTts.id)?.id).toBe(kokoroTts.id);
  });

  it('splits primary and advanced SSOT tiers and respects first-frame lock and always-on audio', () => {
    const imageSchema = resolveSuperAgentModelSchema(nanoBanana, 'image');
    expect(imageSchema.primaryFields.map(f => f.key)).toEqual(['aspect_ratio', 'resolution']);
    expect(imageSchema.advancedFields.map(f => f.key)).toEqual([
      'output_format',
      'thinking_level',
      'enable_web_search',
      'seed',
    ]);

    const seedance25: Model = {
      id: 'opendesign:doubao-seedance-2-5-260628',
      provider: 'opendesign',
      modelId: 'doubao-seedance-2-5-260628',
      label: 'Seedance 2.5',
      modality: 'video',
      mode: 'text-to-video',
      source: 'live',
      maxInputImages: 1,
      nativeOptions: {
        ratios: { values: ['16:9', '9:16', 'adaptive'], default: '16:9' },
        resolutions: { values: ['720p', '1080p'], default: '720p' },
        durations: { values: [5, 10], default: 5 },
      },
    };
    const lockedVideoSchema = resolveSuperAgentModelSchema(seedance25, 'video', true, {});
    expect(lockedVideoSchema.inputImageRatioLocked).toBe(true);
    expect(lockedVideoSchema.fields.some(f => f.key === 'ratio')).toBe(false);

    const wanAudio: Model = {
      id: 'opendesign:wan-2.7',
      provider: 'opendesign',
      modelId: 'wan-2.7',
      label: 'Wan 2.7',
      modality: 'video',
      mode: 'text-to-video',
      source: 'live',
      nativeOptions: {
        ratios: { values: ['16:9', '9:16'], default: '16:9' },
        durations: { values: [5, 10], default: 5 },
      },
    };
    expect(resolveSuperAgentModelSchema(wanAudio, 'video').alwaysOnAudio).toBe(true);
  });

  it('propagates choice requires constraints and clears incompatible OpenDesign image resolutions', () => {
    const schema = resolveSuperAgentModelSchema(seedance, 'video');
    const resField = schema.fields.find(f => f.key === 'resolution')!;
    const next = applyModelParamChange(seedance, { ratio: '9:16' }, resField, '4k');
    expect(next).toEqual({ ratio: '16:9', resolution: '4k' });

    const profiledImage: Model = {
      id: 'opendesign:nano-banana-2',
      provider: 'opendesign',
      modelId: 'nano-banana-2',
      label: 'Nano Banana 2 Cloud',
      modality: 'image',
      mode: 'text-to-image',
      source: 'live',
      nativeOptions: {
        profiles: {
          generations: {
            profiles: [
              { aspect_ratio: '16:9', resolution: '1K' },
              { aspect_ratio: '16:9', resolution: '4k' },
              { aspect_ratio: '1:1', resolution: '1K' },
            ],
            default: { aspect_ratio: '16:9', resolution: '1K' },
          },
        },
      },
    };
    const imgSchema = resolveSuperAgentModelSchema(profiledImage, 'image');
    const ratioField = imgSchema.fields.find(f => f.key === 'aspect_ratio')!;
    const afterChange = applyModelParamChange(profiledImage, { resolution: '4k' }, ratioField, '1:1');
    expect(afterChange).toEqual({ aspect_ratio: '1:1' });
  });

  it('migrates compatible SSOT parameters across models and drops incompatible values', () => {
    // Seedance (`ratio`) -> Wan 2.2 (`aspect_ratio`) via standardKey='aspectRatio' + shared `seed`
    const migratedVideo = migrateModelParameters(
      seedance,
      wan22,
      { ratio: '16:9', resolution: '1080p', bitrate_mode: 'high', seed: 42 },
      'video',
    );
    expect(migratedVideo).toEqual({
      aspect_ratio: '16:9',
      seed: 42,
    });

    // Nano Banana (`aspect_ratio`, `output_format: png`, `seed`) -> FLUX Schnell (`image_size` via ratio label, `output_format`, `seed`)
    const migratedImage = migrateModelParameters(
      nanoBanana,
      fluxSchnell,
      { aspect_ratio: '16:9', output_format: 'png', thinking_level: 'high', seed: 99 },
      'image',
    );
    expect(migratedImage).toEqual({
      image_size: 'landscape_16_9',
      output_format: 'png',
      seed: 99,
    });

    // Round-trip FLUX Schnell -> Nano Banana preserves 16:9 alongside output_format & seed
    expect(migrateModelParameters(fluxSchnell, nanoBanana, migratedImage, 'image')).toEqual({
      aspect_ratio: '16:9',
      output_format: 'png',
      seed: 99,
    });

    // Normalized ratio fallback: FLUX Schnell `square_hd` (`1:1 HD`) -> Nano Banana `aspect_ratio: '1:1'`
    expect(migrateModelParameters(fluxSchnell, nanoBanana, { image_size: 'square_hd' }, 'image')).toEqual({
      aspect_ratio: '1:1',
    });
  });

  it('builds clean submitted parameters and prompt vs provider directives', () => {
    const submitted = resolveSubmittedMediaParameters(
      kokoroTts,
      { voice: 'af_bella', speed: 1.2 },
      'audio',
      false,
      'voiceover',
    );
    expect(submitted.wireParameters).toEqual({ voice: 'af_bella', speed: 1.2 });
    expect(submitted.activeAdvancedCount).toBe(1);

    const providerDirective = buildMediaHiddenDirective({
      modality: 'audio',
      effectiveModel: kokoroTts,
      selectedModelId: kokoroTts.id,
      wireParameters: submitted.wireParameters,
      sceneNote: 'audioType=Voiceover',
    });
    expect(providerDirective).toContain('openmotion_assets_use');
    expect(providerDirective).toContain('mode="text-to-speech"');
    expect(providerDirective).toContain('"voice":"af_bella"');
    expect(providerDirective).toContain('"speed":1.2');

    const promptDirective = buildMediaHiddenDirective({
      modality: 'image',
      effectiveModel: codexImage,
      selectedModelId: codexImage.id,
      wireParameters: { aspect_ratio: '16:9', background: 'transparent' },
      hasInputImage: true,
    });
    expect(promptDirective).toContain('prompt-delivery model codex:image-generation');
    expect(promptDirective).toContain('references=[<attached image assetId/versionId>]');
    expect(promptDirective).toContain('"background":"transparent"');

    // Also verify enrichGenerationOptionsWithSSOT preserves standardKey & tier cleanly
    const enriched = enrichGenerationOptionsWithSSOT('audio', {
      delivery: 'provider',
      fields: [{ key: 'seed', label: 'Seed', kind: 'number', step: 1 }],
    });
    expect(enriched.fields[0].standardKey).toBe('seed');
    expect(enriched.fields[0].tier).toBe('advanced');
  });

  it('prefers ready providers over unconfigured routes and handles SFX, input-image, first-frame, and asset artifact directives', () => {
    const accountMusic: Model = {
      id: 'account:elevenlabs-music-v2',
      provider: 'account',
      modelId: 'elevenlabs-music-v2',
      label: 'ElevenLabs Music',
      modality: 'audio',
      mode: 'text-to-audio',
      source: 'live',
    };
    const accountTts: Model = {
      id: 'account:elevenlabs-v3',
      provider: 'account',
      modelId: 'elevenlabs-v3',
      label: 'ElevenLabs Voice',
      modality: 'audio',
      mode: 'text-to-speech',
      source: 'builtin',
    };
    const providers = [
      { id: 'fal', label: 'fal', enabled: false, configured: false, available: false, credentialSource: 'none' as const, verification: 'unverified' as const },
      { id: 'account', label: 'OpenDesign', enabled: true, configured: true, available: true, credentialSource: 'account' as const, verification: 'unverified' as const, mediaEntitlement: 'included' as const },
    ];
    // Unconfigured fal TTS route must NOT beat ready account models; SFX must fall back to text-to-audio (not TTS).
    expect(
      resolveEffectiveMediaModel(
        [kokoroTts, accountTts, accountMusic],
        { audio: kokoroTts.id },
        'audio',
        'auto',
        preferredAudioModelFilters('sfx'),
        providers,
      )?.id,
    ).toBe(accountMusic.id);

    // Input-image filter triggers even in text-to-image scene when hasInputImage=true.
    expect(
      resolveEffectiveMediaModel(
        [nanoBanana, codexImage],
        { image: nanoBanana.id },
        'image',
        'auto',
        preferredImageModelFilter('text-to-image', true),
      )?.id,
    ).toBe(codexImage.id);

    // Video first-frame filter selects a model with maxInputImages > 0.
    const i2vModel: Model = { ...seedance, id: 'account:seedance', provider: 'account', maxInputImages: 1 };
    expect(
      resolveEffectiveMediaModel(
        [wan22, i2vModel],
        { video: wan22.id },
        'video',
        'auto',
        preferredVideoModelFilter(true),
      )?.id,
    ).toBe(i2vModel.id);

    // Directive always emits kind="asset", concrete references JSON, polling instructions, and TTS spoken-script constraint.
    const directiveWithRefs = buildMediaHiddenDirective({
      modality: 'image',
      effectiveModel: codexImage,
      selectedModelId: codexImage.id,
      wireParameters: {},
      hasInputImage: true,
      attachedImageReferences: [
        { assetId: 'asset-1', versionId: 'ver-1' },
        { assetId: 'asset-2', versionId: 'ver-2' },
      ],
    });
    expect(directiveWithRefs).toContain('references=[{"assetId":"asset-1","versionId":"ver-1"}]');
    expect(directiveWithRefs).toContain('openmotion_present_artifact(kind="asset", assetId=..., versionId=...)');
    expect(directiveWithRefs).toContain('keep calling openmotion_assets_use(action="status", jobId=...) sequentially');

    const ttsDirective = buildMediaHiddenDirective({
      modality: 'audio',
      effectiveModel: accountTts,
      selectedModelId: accountTts.id,
      wireParameters: { voice: '21m00Tcm4TlvDq8ikWAM' },
      sceneNote: 'audioType=Voiceover',
    });
    expect(ttsDirective).toContain('exact spoken narration words as prompt');
    expect(ttsDirective).toContain('openmotion_present_artifact(kind="asset", assetId=..., versionId=...)');
    expect(ttsDirective).toContain('NEVER call schedule');

    // Ready account image models rank ahead of ready codex:image-generation when routes.image is unset.
    const accountFlare: Model = {
      id: 'account:gpt-image-2.6-flare',
      provider: 'account',
      modelId: 'gpt-image-2.6-flare',
      label: 'gpt-image-2.6-flare',
      modality: 'image',
      mode: 'text-to-image',
      source: 'live',
      supportsImageReference: true,
    };
    const bothReady = [
      { id: 'codex', label: 'Codex', enabled: true, configured: true, available: true, credentialSource: 'none' as const, verification: 'unverified' as const },
      { id: 'account', label: 'OpenDesign', enabled: true, configured: true, available: true, credentialSource: 'account' as const, verification: 'unverified' as const, mediaEntitlement: 'included' as const },
    ];
    expect(
      resolveEffectiveMediaModel([codexImage, accountFlare], {}, 'image', 'auto', undefined, bothReady)?.id,
    ).toBe(accountFlare.id);

    // Same-provider ties break alphabetically by label regardless of catalog order (UI vs submission parity).
    const accountBytePlusTts: Model = {
      id: 'account:byteplus-tts-2',
      provider: 'account',
      modelId: 'byteplus-tts-2',
      label: 'BytePlus Voice',
      modality: 'audio',
      mode: 'text-to-speech',
      source: 'live',
    };
    const elevenLabsFirst = resolveEffectiveMediaModel(
      [accountTts, accountBytePlusTts],
      { audio: accountMusic.id },
      'audio',
      'auto',
      preferredAudioModelFilters('voiceover'),
      bothReady,
    );
    const bytePlusFirst = resolveEffectiveMediaModel(
      [accountBytePlusTts, accountTts],
      { audio: accountMusic.id },
      'audio',
      'auto',
      preferredAudioModelFilters('voiceover'),
      bothReady,
    );
    expect(elevenLabsFirst?.id).toBe(accountBytePlusTts.id);
    expect(bytePlusFirst?.id).toBe(accountBytePlusTts.id);

    // remove-background prefers transparent-capable image-reference models and falls back when none declare it.
    const accountGpt2 = makeBuiltinModel({
      id: 'account:gpt-image-2',
      provider: 'account',
      modelId: 'gpt-image-2',
      label: 'gpt-image-2',
      modality: 'image',
      mode: 'text-to-image',
      source: 'live',
      supportsImageReference: true,
    });
    const accountCutout: Model = {
      ...accountFlare,
      generationOptions: {
        delivery: 'provider',
        fields: [
          {
            key: 'background',
            label: 'Background',
            kind: 'choice',
            choices: [{ value: 'transparent', label: 'Transparent' }],
          },
        ],
      },
    };
    expect(
      resolveEffectiveMediaModel(
        [accountGpt2, accountCutout],
        { image: accountGpt2.id },
        'image',
        'auto',
        preferredImageModelFilters('remove-background'),
        bothReady,
      )?.id,
    ).toBe(accountCutout.id);
    expect(
      resolveEffectiveMediaModel(
        [accountGpt2],
        {},
        'image',
        'auto',
        preferredImageModelFilters('remove-background'),
        bothReady,
      )?.id,
    ).toBe(accountGpt2.id);
  });
});
