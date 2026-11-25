import type { Model } from '../../../shared/gateway.ts';
import {
  defaultVideoAudioEnabled,
  generationOptions,
  videoAudioAlwaysOn,
  type GenerationOption,
} from '../../../shared/generation-options.ts';
import {
  openDesignImageReferenceCap,
  openDesignModels,
} from '../../../shared/opendesign-models.ts';
import { openDesignVideoModels } from '../../../shared/video-features.ts';
import {
  buildStandardParamMap,
  choiceField,
  inferCapabilitiesFromParameters,
  mapWireKeyToStandard,
  resolveCanonicalIdentity,
} from './normalize.ts';
import {
  REGISTRY_SCHEMA_VERSION,
  type ModelCapabilities,
  type ModelEndpointEntry,
  type ModelPricing,
  type MultimodalModality,
  type MultimodalTask,
  type ParameterFieldSchema,
  type ProviderCatalogShard,
  type ProviderInfo,
} from './schema.ts';

const CURATED_SYNC_DATE = '2026-11-23T00:00:00.000Z';

export const CURATED_PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'opendesign',
    name: 'OpenDesign Cloud',
    website: 'https://open-design.ai/cloud',
    docsUrl: 'https://open-design.ai/cloud/dashboard',
    protocol: 'opendesign',
    source: 'curated',
    authEnv: 'OPENDESIGN_API_KEY',
    supportsLiveSchema: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    website: 'https://platform.openai.com',
    docsUrl: 'https://platform.openai.com/docs/api-reference/images',
    protocol: 'openai',
    source: 'curated',
    authEnv: 'OPENAI_API_KEY',
    supportsLiveSchema: false,
  },
  {
    id: 'google',
    name: 'Google Gemini / Vertex AI',
    website: 'https://ai.google.dev',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/video',
    protocol: 'google-genai',
    source: 'curated',
    authEnv: 'GEMINI_API_KEY',
    supportsLiveSchema: false,
  },
  {
    id: 'bytedance',
    name: 'ByteDance ModelArk / Seed',
    website: 'https://www.byteplus.com',
    docsUrl: 'https://docs.byteplus.com/en/docs/ModelArk',
    protocol: 'bytedance-ark',
    source: 'curated',
    authEnv: 'ARK_API_KEY',
    supportsLiveSchema: false,
  },
  {
    id: 'kling',
    name: 'Kling AI (Kuaishou)',
    website: 'https://klingai.com',
    docsUrl: 'https://docs.qingque.cn/d/home/eZQA01gB33Q40W8pM4m8M104',
    protocol: 'kling',
    source: 'curated',
    authEnv: 'KLING_API_KEY',
    supportsLiveSchema: false,
  },
  {
    id: 'bfl',
    name: 'Black Forest Labs',
    website: 'https://bfl.ai',
    docsUrl: 'https://docs.bfl.ai',
    protocol: 'bfl',
    source: 'curated',
    authEnv: 'BFL_API_KEY',
    supportsLiveSchema: false,
  },
  {
    id: 'ideogram',
    name: 'Ideogram',
    website: 'https://ideogram.ai',
    docsUrl: 'https://developer.ideogram.ai',
    protocol: 'ideogram',
    source: 'curated',
    authEnv: 'IDEOGRAM_API_KEY',
    supportsLiveSchema: false,
  },
  {
    id: 'recraft',
    name: 'Recraft',
    website: 'https://www.recraft.ai',
    docsUrl: 'https://www.recraft.ai/docs',
    protocol: 'recraft',
    source: 'curated',
    authEnv: 'RECRAFT_API_KEY',
    supportsLiveSchema: false,
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    website: 'https://elevenlabs.io',
    docsUrl: 'https://elevenlabs.io/docs/api-reference',
    protocol: 'elevenlabs',
    source: 'curated',
    authEnv: 'ELEVENLABS_API_KEY',
    supportsLiveSchema: false,
  },
  {
    id: 'suno',
    name: 'Suno',
    website: 'https://suno.com',
    protocol: 'suno',
    source: 'curated',
    supportsLiveSchema: false,
  },
  {
    id: 'codex',
    name: 'Codex Local Agent',
    protocol: 'custom',
    source: 'curated',
    supportsLiveSchema: false,
  },
];

interface CuratedEndpointInput {
  canonicalId: string;
  family: string;
  creator: string;
  provider: string;
  endpointId: string;
  displayName: string;
  modality: MultimodalModality;
  primaryTask: MultimodalTask;
  tasks: readonly MultimodalTask[];
  description: string;
  docsUrl?: string;
  pricing?: ModelPricing;
  parameters: readonly ParameterFieldSchema[];
  capabilityOverrides?: Partial<ModelCapabilities>;
  tags?: readonly string[];
}

function makeCurated(input: CuratedEndpointInput): ModelEndpointEntry {
  const ordered = input.parameters.map((param, idx) => ({
    ...param,
    uiOrder: param.uiOrder ?? idx,
  }));
  return {
    id: `${input.provider}:${input.endpointId}`,
    canonicalId: input.canonicalId,
    family: input.family,
    creator: input.creator,
    provider: input.provider,
    endpointId: input.endpointId,
    displayName: input.displayName,
    modality: input.modality,
    primaryTask: input.primaryTask,
    tasks: input.tasks,
    description: input.description,
    source: 'curated',
    ...(input.docsUrl ? { docsUrl: input.docsUrl } : {}),
    schemaQuality: 'verified-curated',
    status: 'active',
    ...(input.pricing ? { pricing: input.pricing } : {}),
    capabilities: inferCapabilitiesFromParameters(
      input.modality,
      input.tasks,
      ordered,
      input.capabilityOverrides,
    ),
    parameters: ordered,
    standardParameterMap: buildStandardParamMap(ordered),
    requiredParameters: ordered.filter(p => p.required).map(p => p.key),
    ...(input.tags ? { tags: input.tags } : {}),
    syncedAt: CURATED_SYNC_DATE,
  };
}

const promptParam = (description = 'Text prompt describing what to generate.'): ParameterFieldSchema => ({
  key: 'prompt',
  standardKey: 'prompt',
  label: 'Prompt',
  type: 'string',
  required: true,
  description,
});

const seedParam = (defaultValue?: number): ParameterFieldSchema => ({
  key: 'seed',
  standardKey: 'seed',
  label: 'Seed',
  type: 'integer',
  required: false,
  ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  description: 'Random seed for reproducible generation.',
});

function generationOptionToParameterField(option: GenerationOption, modality: MultimodalModality): ParameterFieldSchema {
  const standardKey = mapWireKeyToStandard(option.key, modality);
  if (option.kind === 'choice') {
    const choices = option.choices ?? [];
    return {
      key: option.key,
      ...(standardKey ? { standardKey } : {}),
      label: option.label,
      type: 'enum',
      required: Boolean(option.required),
      ...(option.default !== undefined ? { default: option.default } : {}),
      enum: choices.map(c => c.value),
      choices: choices.map(c => ({
        value: c.value,
        label: c.label,
        ...(c.requires
          ? { requires: Object.entries(c.requires).map(([field, value]) => ({ field, values: [value] })) }
          : {}),
      })),
      ...(option.allowCustom ? { allowCustom: true } : {}),
    };
  }
  if (option.kind === 'boolean') {
    return {
      key: option.key,
      ...(standardKey ? { standardKey } : {}),
      label: option.label,
      type: 'boolean',
      required: Boolean(option.required),
      ...(option.default !== undefined ? { default: option.default } : {}),
    };
  }
  if (option.kind === 'number') {
    const isInteger = option.step === undefined || option.step === 1;
    return {
      key: option.key,
      ...(standardKey ? { standardKey } : {}),
      label: option.label,
      type: isInteger ? 'integer' : 'number',
      required: Boolean(option.required),
      ...(option.default !== undefined ? { default: option.default } : {}),
      ...(option.min !== undefined ? { min: option.min } : {}),
      ...(option.max !== undefined ? { max: option.max } : {}),
      ...(option.step !== undefined ? { step: option.step } : {}),
    };
  }
  return {
    key: option.key,
    ...(standardKey ? { standardKey } : {}),
    label: option.label,
    type: 'string',
    required: Boolean(option.required),
    ...(option.default !== undefined ? { default: option.default } : {}),
  };
}

const openDesignVideoById = new Map(openDesignVideoModels.map(entry => [entry.modelId, entry]));

const OPENDESIGN_VIDEO_RATIOS: Record<string, readonly string[]> = {
  'doubao-seedance-2-5-260628': ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  'doubao-seedance-2-5-flash-261115': ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  'wan-2.7': ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
};

function buildOpenDesignCuratedEndpoints(): ModelEndpointEntry[] {
  const entries: ModelEndpointEntry[] = [];

  for (const model of openDesignModels) {
    const identity = resolveCanonicalIdentity(model.modelId, model.label);
    const videoMeta = openDesignVideoById.get(model.modelId);
    const durationValues = videoMeta
      ? Array.from({ length: videoMeta.durations.max - videoMeta.durations.min + 1 }, (_, i) => videoMeta.durations.min + i)
      : undefined;

    const syntheticModel: Model = {
      id: `opendesign:${model.modelId}`,
      provider: 'opendesign',
      modelId: model.modelId,
      label: model.label,
      modality: model.modality,
      source: 'builtin',
      mode: model.mode,
      defaults: {},
      ...(videoMeta
        ? {
            nativeOptions: {
              ratios: {
                values: [...(OPENDESIGN_VIDEO_RATIOS[model.modelId] ?? ['adaptive', '16:9', '9:16', '1:1'])],
                default: '16:9',
              },
              resolutions: {
                values: [...videoMeta.resolutions],
                default: videoMeta.resolutions.includes('720p') ? '720p' : videoMeta.resolutions[0],
              },
              durations: {
                values: durationValues,
                default: videoMeta.durations.default,
              },
            },
          }
        : {}),
    };

    const sharedOpts = generationOptions(syntheticModel)
      ?? (model.modality === 'audio' && model.mode === 'text-to-audio'
        ? generationOptions({ ...syntheticModel, provider: 'account' })
        : undefined);
    const derivedParams = (sharedOpts?.fields ?? []).map(opt => generationOptionToParameterField(opt, model.modality));
    const refCap = model.modality === 'image' ? openDesignImageReferenceCap(model.modelId) : undefined;

    const parameters: ParameterFieldSchema[] = [
      promptParam(
        model.modality === 'video'
          ? 'Text prompt directing shot, motion, camera, and audio.'
          : model.mode === 'text-to-speech'
            ? 'Script text to synthesize.'
            : model.mode === 'text-to-audio'
              ? 'Music style, instrumentation, mood, and tempo description.'
              : 'Text prompt describing what to generate.',
      ),
      ...derivedParams,
    ];

    if (refCap !== undefined) {
      parameters.push({
        key: 'images',
        standardKey: 'referenceImages',
        label: refCap === 1 ? 'Reference Image' : 'Reference Images',
        type: 'array',
        itemType: 'string',
        required: false,
        maxItems: refCap,
        description: `Up to ${refCap} reference ${refCap === 1 ? 'image' : 'images'} accepted on /images/edits.`,
      });
    } else if (model.modality === 'video' && model.modelId.startsWith('doubao-seedance-')) {
      parameters.push({
        key: 'images',
        standardKey: 'referenceImages',
        label: 'First Frame / Reference Images',
        type: 'array',
        itemType: 'string',
        required: false,
        maxItems: 10,
      });
    }

    const alwaysOnAudio = videoAudioAlwaysOn(syntheticModel);
    const nativeAudio = defaultVideoAudioEnabled(syntheticModel);
    const primaryTask: MultimodalTask = model.modality === 'video'
      ? 'text-to-video'
      : model.modality === 'audio'
        ? (model.mode === 'text-to-audio' ? 'text-to-music' : 'text-to-speech')
        : 'text-to-image';
    const tasks: MultimodalTask[] = model.modality === 'video'
      ? (model.modelId.startsWith('doubao-seedance-')
          ? ['text-to-video', 'image-to-video', 'reference-to-video']
          : ['text-to-video', 'image-to-video'])
      : model.modality === 'image'
        ? (derivedParams.some(p => p.key === 'background')
            ? ['text-to-image', 'image-edit', 'remove-background']
            : ['text-to-image', 'image-edit'])
        : [primaryTask];

    const sizeParam = derivedParams.find(p => p.key === 'size');
    const sizeResolutions = sizeParam?.enum?.filter((v): v is string => typeof v === 'string');

    entries.push(
      makeCurated({
        canonicalId: identity.canonicalId,
        family: identity.family,
        creator: identity.creator,
        provider: 'opendesign',
        endpointId: model.modelId,
        displayName: model.label,
        modality: model.modality,
        primaryTask,
        tasks,
        description: videoMeta?.tagline
          ?? `${model.label} served via OpenDesign Cloud${refCap !== undefined ? ` (up to ${refCap} reference ${refCap === 1 ? 'image' : 'images'} on edits)` : ''}.`,
        parameters,
        capabilityOverrides: {
          ...(refCap !== undefined ? { maxReferenceImages: refCap } : {}),
          ...(sizeResolutions?.length ? { resolutions: sizeResolutions } : {}),
          ...(nativeAudio ? { supportsNativeAudio: true } : {}),
          ...(alwaysOnAudio ? { nativeAudioAlwaysOn: true } : {}),
        },
        tags: [
          'opendesign',
          'verified',
          ...(videoMeta?.badge === 'New' ? ['fast'] : []),
          ...(nativeAudio ? ['native-audio'] : []),
          ...(primaryTask === 'text-to-speech' ? ['tts'] : []),
          ...(primaryTask === 'text-to-music' ? ['music'] : []),
        ],
      }),
    );
  }

  // Codex local agent image generation — derived directly from shared/generation-options.ts (`delivery: 'prompt'`).
  const codexModel: Model = {
    id: 'codex:image-generation',
    provider: 'codex',
    modelId: 'image-generation',
    label: 'Codex Local Image Generation',
    modality: 'image',
    source: 'builtin',
    mode: 'text-to-image',
    defaults: {},
  };
  const codexOpts = generationOptions(codexModel);
  entries.push(
    makeCurated({
      canonicalId: 'openai/codex-image-generation',
      family: 'gpt-image',
      creator: 'OpenAI',
      provider: 'codex',
      endpointId: 'image-generation',
      displayName: 'Codex Local Image Generation',
      modality: 'image',
      primaryTask: 'text-to-image',
      tasks: ['text-to-image', 'image-edit'],
      description: 'Image generation via local Codex CLI agent (preferences are passed via instruction prompt).',
      parameters: [
        promptParam(),
        ...(codexOpts?.fields ?? []).map(opt => generationOptionToParameterField(opt, 'image')),
      ],
      capabilityOverrides: { maxReferenceImages: 1, supportsTransparentBackground: true },
      tags: ['local-agent', 'verified', ...(codexOpts?.delivery === 'prompt' ? ['prompt-delivery'] : [])],
    }),
  );

  return entries;
}

export const CURATED_ENDPOINTS: readonly ModelEndpointEntry[] = [
  // ── OpenDesign Cloud & Codex verified models (derived directly from shared/opendesign-models.ts, shared/video-features.ts, and shared/generation-options.ts) ──
  ...buildOpenDesignCuratedEndpoints(),

  // ── Direct First-Party Official API Specs (OpenAI, Google, ByteDance, Kling, BFL, Ideogram, Recraft, ElevenLabs, Suno) ──
  makeCurated({
    canonicalId: 'openai/gpt-image-1.5',
    family: 'gpt-image',
    creator: 'OpenAI',
    provider: 'openai',
    endpointId: 'gpt-image-1.5',
    displayName: 'GPT Image 1.5',
    modality: 'image',
    primaryTask: 'text-to-image',
    tasks: ['text-to-image', 'image-edit', 'inpainting'],
    description: 'OpenAI GPT Image 1.5 native image generation and high-fidelity editing API.',
    docsUrl: 'https://platform.openai.com/docs/api-reference/images/create',
    parameters: [
      promptParam(),
      choiceField('size', 'Size', ['auto', '1024x1024', '1536x1024', '1024x1536'], { standardKey: 'size', default: 'auto' }),
      choiceField('quality', 'Quality', ['auto', 'low', 'medium', 'high'], { standardKey: 'quality', default: 'auto' }),
      choiceField('background', 'Background', ['auto', 'opaque', 'transparent'], { standardKey: 'background', default: 'auto' }),
      choiceField('output_format', 'Output Format', ['png', 'jpeg', 'webp'], { standardKey: 'outputFormat', default: 'png' }),
      { key: 'output_compression', standardKey: 'outputCompression', label: 'Output Compression', type: 'integer', required: false, default: 100, min: 0, max: 100, step: 1 },
      choiceField('moderation', 'Moderation', ['auto', 'low'], { standardKey: 'moderation', default: 'auto' }),
      choiceField('input_fidelity', 'Input Fidelity', ['low', 'high'], { standardKey: 'inputFidelity', default: 'low', description: 'Controls detail preservation during /v1/images/edits.' }),
      { key: 'n', standardKey: 'count', label: 'Count', type: 'integer', required: false, default: 1, min: 1, max: 10, step: 1 },
      { key: 'image', standardKey: 'referenceImages', label: 'Input Images', type: 'array', itemType: 'string', required: false, maxItems: 16 },
      { key: 'mask', standardKey: 'maskImage', label: 'Edit Mask', type: 'string', required: false },
    ],
    capabilityOverrides: { maxReferenceImages: 16, supportsMask: true, supportsTransparentBackground: true },
    tags: ['official-api', 'verified'],
  }),
  makeCurated({
    canonicalId: 'openai/gpt-image-2',
    family: 'gpt-image',
    creator: 'OpenAI',
    provider: 'openai',
    endpointId: 'gpt-image-2',
    displayName: 'GPT Image 2',
    modality: 'image',
    primaryTask: 'text-to-image',
    tasks: ['text-to-image', 'image-edit', 'inpainting'],
    description: 'OpenAI GPT Image 2 flagship image model supporting flexible custom resolutions up to 4K (3840x2160) and transparent output.',
    docsUrl: 'https://platform.openai.com/docs/api-reference/images/create',
    parameters: [
      promptParam(),
      choiceField('size', 'Size', ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '3840x2160'], { standardKey: 'size', default: 'auto', allowCustom: true, description: 'Supports custom WxH up to 4K with 16px edge multiples.' }),
      choiceField('quality', 'Quality', ['auto', 'low', 'medium', 'high', 'max'], { standardKey: 'quality', default: 'auto' }),
      choiceField('background', 'Background', ['auto', 'opaque', 'transparent'], { standardKey: 'background', default: 'auto' }),
      choiceField('output_format', 'Output Format', ['png', 'jpeg', 'webp'], { standardKey: 'outputFormat', default: 'png' }),
      { key: 'output_compression', standardKey: 'outputCompression', label: 'Output Compression', type: 'integer', required: false, default: 100, min: 0, max: 100, step: 1 },
      choiceField('moderation', 'Moderation', ['auto', 'low'], { standardKey: 'moderation', default: 'auto' }),
      { key: 'n', standardKey: 'count', label: 'Count', type: 'integer', required: false, default: 1, min: 1, max: 10, step: 1 },
      { key: 'image', standardKey: 'referenceImages', label: 'Input Images', type: 'array', itemType: 'string', required: false, maxItems: 16 },
      { key: 'mask', standardKey: 'maskImage', label: 'Edit Mask', type: 'string', required: false },
    ],
    capabilityOverrides: { maxReferenceImages: 16, supportsMask: true, supportsTransparentBackground: true, features: ['4k'] },
    tags: ['official-api', 'flagship', 'verified'],
  }),
  makeCurated({
    canonicalId: 'openai/sora-2',
    family: 'sora',
    creator: 'OpenAI',
    provider: 'openai',
    endpointId: 'sora-2',
    displayName: 'Sora 2',
    modality: 'video',
    primaryTask: 'text-to-video',
    tasks: ['text-to-video', 'image-to-video', 'video-to-video'],
    description: 'OpenAI Sora 2 text- and image-to-video model with synchronized native dialogue, lip-sync, and ambient sound.',
    docsUrl: 'https://platform.openai.com/docs/guides/video-generation',
    parameters: [
      promptParam(),
      choiceField('size', 'Resolution Size', ['1280x720', '720x1280'], { standardKey: 'size', default: '1280x720' }),
      choiceField('seconds', 'Duration (seconds)', ['4', '8', '12'], { standardKey: 'duration', default: '4' }),
      { key: 'input_reference', standardKey: 'inputImage', label: 'Input Reference Image/Video', type: 'string', required: false },
    ],
    capabilityOverrides: {
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['720p'],
      supportsNativeAudio: true,
      nativeAudioAlwaysOn: true,
      maxReferenceImages: 1,
    },
    tags: ['official-api', 'flagship', 'native-audio'],
  }),
  makeCurated({
    canonicalId: 'openai/sora-2-pro',
    family: 'sora',
    creator: 'OpenAI',
    provider: 'openai',
    endpointId: 'sora-2-pro',
    displayName: 'Sora 2 Pro',
    modality: 'video',
    primaryTask: 'text-to-video',
    tasks: ['text-to-video', 'image-to-video', 'video-to-video'],
    description: 'OpenAI Sora 2 Pro cinema-tier video generation with 1080p output, extended durations up to 25s, and synchronized audio.',
    docsUrl: 'https://platform.openai.com/docs/guides/video-generation',
    parameters: [
      promptParam(),
      choiceField('size', 'Resolution Size', ['1280x720', '720x1280', '1792x1024', '1024x1792', '1920x1080', '1080x1920'], { standardKey: 'size', default: '1920x1080' }),
      choiceField('seconds', 'Duration (seconds)', ['4', '8', '12', '16', '20', '25'], { standardKey: 'duration', default: '8' }),
      { key: 'input_reference', standardKey: 'inputImage', label: 'Input Reference Image/Video', type: 'string', required: false },
    ],
    capabilityOverrides: {
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['720p', '1080p'],
      supportsNativeAudio: true,
      nativeAudioAlwaysOn: true,
      maxReferenceImages: 1,
    },
    tags: ['official-api', 'flagship', 'pro', 'native-audio'],
  }),
  makeCurated({
    canonicalId: 'google/veo-3.1',
    family: 'veo',
    creator: 'Google',
    provider: 'google',
    endpointId: 'veo-3.1-generate-preview',
    displayName: 'Google Veo 3.1',
    modality: 'video',
    primaryTask: 'text-to-video',
    tasks: ['text-to-video', 'image-to-video', 'first-last-frame-to-video', 'video-extend'],
    description: 'Google DeepMind Veo 3.1 video model on Gemini / Vertex AI with native synchronized audio, first/last frame control, and video extension.',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/video',
    parameters: [
      promptParam(),
      choiceField('aspectRatio', 'Aspect Ratio', ['16:9', '9:16'], { standardKey: 'aspectRatio', default: '16:9' }),
      choiceField('resolution', 'Resolution', ['720p', '1080p'], { standardKey: 'resolution', default: '720p' }),
      choiceField('durationSeconds', 'Duration (seconds)', [4, 6, 8], { standardKey: 'duration', default: 8 }),
      { key: 'generateAudio', standardKey: 'generateAudio', label: 'Generate Audio', type: 'boolean', required: false, default: true },
      { key: 'negativePrompt', standardKey: 'negativePrompt', label: 'Negative Prompt', type: 'string', required: false },
      { key: 'image', standardKey: 'inputImage', label: 'Start Frame Image', type: 'string', required: false },
      { key: 'lastFrame', standardKey: 'endImage', label: 'Last Frame Image', type: 'string', required: false },
      { key: 'referenceImages', standardKey: 'referenceImages', label: 'Reference Images', type: 'array', itemType: 'string', required: false, maxItems: 3 },
      seedParam(),
    ],
    capabilityOverrides: { supportsFirstLastFrame: true, supportsNativeAudio: true, maxReferenceImages: 3 },
    tags: ['official-api', 'flagship', 'native-audio'],
  }),
  makeCurated({
    canonicalId: 'google/imagen-4',
    family: 'imagen',
    creator: 'Google',
    provider: 'google',
    endpointId: 'imagen-4.0-generate-001',
    displayName: 'Google Imagen 4',
    modality: 'image',
    primaryTask: 'text-to-image',
    tasks: ['text-to-image'],
    description: 'Google Imagen 4 photorealistic image generation model via Gemini / Vertex AI.',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/imagen',
    parameters: [
      promptParam(),
      choiceField('aspectRatio', 'Aspect Ratio', ['1:1', '3:4', '4:3', '9:16', '16:9'], { standardKey: 'aspectRatio', default: '1:1' }),
      choiceField('outputMimeType', 'Output Format', ['image/png', 'image/jpeg', 'image/webp'], { standardKey: 'outputFormat', default: 'image/png' }),
      { key: 'sampleCount', standardKey: 'count', label: 'Sample Count', type: 'integer', required: false, default: 1, min: 1, max: 4, step: 1 },
      seedParam(),
    ],
    tags: ['official-api', 'flagship'],
  }),
  makeCurated({
    canonicalId: 'bytedance/seedream-5.5',
    family: 'seedream',
    creator: 'ByteDance',
    provider: 'bytedance',
    endpointId: 'doubao-seedream-5-5',
    displayName: 'Seedream 5.5 (ModelArk)',
    modality: 'image',
    primaryTask: 'text-to-image',
    tasks: ['text-to-image', 'image-edit', 'layerize'],
    description: 'ByteDance Seedream 5.5 native image generation, multi-image editing, transparent PNG, and layer decomposition via ModelArk.',
    docsUrl: 'https://docs.byteplus.com/en/docs/ModelArk',
    parameters: [
      promptParam(),
      choiceField('aspect_ratio', 'Aspect Ratio', ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'], { standardKey: 'aspectRatio', default: '1:1' }),
      choiceField('size', 'Resolution', ['1K', '2K', '4K'], { standardKey: 'resolution', default: '2K', allowCustom: true }),
      choiceField('output_format', 'Output Format', ['png', 'jpeg', 'webp'], { standardKey: 'outputFormat', default: 'png' }),
      choiceField('background', 'Background', ['auto', 'opaque', 'transparent'], { standardKey: 'background', default: 'auto' }),
      { key: 'image', standardKey: 'referenceImages', label: 'Reference Images', type: 'array', itemType: 'string', required: false, maxItems: 10 },
      { key: 'watermark', standardKey: 'watermark', label: 'Watermark', type: 'boolean', required: false, default: false },
      seedParam(),
    ],
    capabilityOverrides: { maxReferenceImages: 10, supportsTransparentBackground: true, supportsLayerDecomposition: true, features: ['4k'] },
    tags: ['official-api', 'flagship'],
  }),
  makeCurated({
    canonicalId: 'bytedance/seedance-2.5',
    family: 'seedance',
    creator: 'ByteDance',
    provider: 'bytedance',
    endpointId: 'doubao-seedance-2-5',
    displayName: 'Seedance 2.5 (ModelArk)',
    modality: 'video',
    primaryTask: 'text-to-video',
    tasks: ['text-to-video', 'image-to-video', 'first-last-frame-to-video', 'reference-to-video'],
    description: 'ByteDance Seedance 2.5 multimodal video generation with 4–30s duration, synchronized audio, and image/video/audio reference conditioning.',
    docsUrl: 'https://docs.byteplus.com/en/docs/ModelArk',
    parameters: [
      promptParam(),
      choiceField('aspect_ratio', 'Aspect Ratio', ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], { standardKey: 'aspectRatio', default: 'auto' }),
      choiceField('resolution', 'Resolution', ['480p', '720p', '1080p'], { standardKey: 'resolution', default: '720p' }),
      { key: 'duration', standardKey: 'duration', label: 'Duration (seconds)', type: 'integer', required: false, default: 5, min: 4, max: 30, step: 1, description: 'Supports 4–30 seconds, or -1 for auto/reference-matched duration.' },
      { key: 'generate_audio', standardKey: 'generateAudio', label: 'Generate Audio', type: 'boolean', required: false, default: true },
      { key: 'camera_fixed', standardKey: 'cameraFixed', label: 'Lock Camera', type: 'boolean', required: false, default: false },
      { key: 'return_last_frame', standardKey: 'returnLastFrame', label: 'Return Last Frame', type: 'boolean', required: false, default: false },
      { key: 'reference_images', standardKey: 'referenceImages', label: 'Reference Images', type: 'array', itemType: 'string', required: false, maxItems: 10 },
      { key: 'reference_videos', standardKey: 'referenceVideos', label: 'Reference Videos', type: 'array', itemType: 'string', required: false, maxItems: 5 },
      { key: 'reference_audios', standardKey: 'referenceAudios', label: 'Reference Audios', type: 'array', itemType: 'string', required: false, maxItems: 5 },
      seedParam(),
    ],
    capabilityOverrides: {
      supportsNativeAudio: true,
      supportsFirstLastFrame: true,
      supportsCameraControl: true,
      maxReferenceImages: 10,
      maxReferenceVideos: 5,
      maxReferenceAudios: 5,
      duration: { min: 4, max: 30, default: 5, supportsAuto: true },
    },
    tags: ['official-api', 'flagship', 'native-audio'],
  }),
  makeCurated({
    canonicalId: 'kuaishou/kling-3.0-pro',
    family: 'kling',
    creator: 'Kuaishou',
    provider: 'kling',
    endpointId: 'kling-v3-pro',
    displayName: 'Kling 3.0 Pro',
    modality: 'video',
    primaryTask: 'text-to-video',
    tasks: ['text-to-video', 'image-to-video', 'first-last-frame-to-video'],
    description: 'Kuaishou Kling 3.0 Pro cinematic video generation with 3–15s duration, multi-shot prompts, native audio, and camera control.',
    parameters: [
      promptParam(),
      { key: 'negative_prompt', standardKey: 'negativePrompt', label: 'Negative Prompt', type: 'string', required: false },
      choiceField('aspect_ratio', 'Aspect Ratio', ['16:9', '9:16', '1:1', '21:9'], { standardKey: 'aspectRatio', default: '16:9' }),
      choiceField('mode', 'Quality Mode', ['std', 'pro'], { standardKey: 'quality', default: 'pro' }),
      choiceField('resolution', 'Resolution', ['720p', '1080p'], { standardKey: 'resolution', default: '1080p' }),
      { key: 'duration', standardKey: 'duration', label: 'Duration (seconds)', type: 'integer', required: false, default: 5, min: 3, max: 15, step: 1 },
      { key: 'generate_audio', standardKey: 'generateAudio', label: 'Generate Audio', type: 'boolean', required: false, default: true },
      { key: 'cfg_scale', standardKey: 'cfg', label: 'CFG Scale', type: 'number', required: false, default: 0.5, min: 0, max: 1, step: 0.05 },
      { key: 'start_image_url', standardKey: 'inputImage', label: 'Start Frame Image', type: 'string', required: false },
      { key: 'end_image_url', standardKey: 'endImage', label: 'End Frame Image', type: 'string', required: false },
      { key: 'camera_control', standardKey: 'cameraControl', label: 'Camera Control', type: 'object', required: false },
    ],
    capabilityOverrides: { supportsFirstLastFrame: true, supportsNativeAudio: true, supportsCameraControl: true },
    tags: ['official-api', 'flagship', 'native-audio'],
  }),
  makeCurated({
    canonicalId: 'bfl/flux-2-pro',
    family: 'flux',
    creator: 'Black Forest Labs',
    provider: 'bfl',
    endpointId: 'flux-2-pro',
    displayName: 'FLUX.2 Pro',
    modality: 'image',
    primaryTask: 'text-to-image',
    tasks: ['text-to-image', 'image-edit'],
    description: 'Black Forest Labs FLUX.2 Pro flagship photorealistic image generation and multi-reference editing model.',
    docsUrl: 'https://docs.bfl.ai',
    parameters: [
      promptParam(),
      { key: 'width', standardKey: 'width', label: 'Width', type: 'integer', required: false, default: 1024, min: 256, max: 2048, step: 16 },
      { key: 'height', standardKey: 'height', label: 'Height', type: 'integer', required: false, default: 1024, min: 256, max: 2048, step: 16 },
      choiceField('output_format', 'Output Format', ['jpeg', 'png'], { standardKey: 'outputFormat', default: 'jpeg' }),
      { key: 'safety_tolerance', standardKey: 'safetyTolerance', label: 'Safety Tolerance', type: 'integer', required: false, default: 2, min: 0, max: 6, step: 1 },
      { key: 'input_images', standardKey: 'referenceImages', label: 'Reference Images', type: 'array', itemType: 'string', required: false, maxItems: 10 },
      seedParam(),
    ],
    capabilityOverrides: { maxReferenceImages: 10 },
    tags: ['official-api', 'flagship'],
  }),
  makeCurated({
    canonicalId: 'ideogram/ideogram-v3',
    family: 'ideogram',
    creator: 'Ideogram',
    provider: 'ideogram',
    endpointId: 'ideogram-v3',
    displayName: 'Ideogram v3',
    modality: 'image',
    primaryTask: 'text-to-image',
    tasks: ['text-to-image', 'image-edit', 'inpainting'],
    description: 'Ideogram v3 specialized for crisp graphic design layouts, typography rendering, and style control.',
    docsUrl: 'https://developer.ideogram.ai',
    parameters: [
      promptParam(),
      choiceField('aspect_ratio', 'Aspect Ratio', ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '16:10', '10:16', '2:1', '1:2', '3:1', '1:3'], { standardKey: 'aspectRatio', default: '1:1' }),
      choiceField('rendering_speed', 'Rendering Speed', ['TURBO', 'DEFAULT', 'QUALITY'], { standardKey: 'renderingSpeed', default: 'DEFAULT' }),
      choiceField('magic_prompt', 'Magic Prompt', ['AUTO', 'ON', 'OFF'], { standardKey: 'promptExtend', default: 'AUTO' }),
      choiceField('style_type', 'Style Type', ['AUTO', 'GENERAL', 'REALISTIC', 'DESIGN', 'FICTION'], { standardKey: 'style', default: 'AUTO' }),
      { key: 'negative_prompt', standardKey: 'negativePrompt', label: 'Negative Prompt', type: 'string', required: false },
      { key: 'num_images', standardKey: 'count', label: 'Count', type: 'integer', required: false, default: 1, min: 1, max: 8, step: 1 },
      seedParam(),
    ],
    tags: ['official-api', 'typography'],
  }),
  makeCurated({
    canonicalId: 'recraft/recraft-v4',
    family: 'recraft',
    creator: 'Recraft',
    provider: 'recraft',
    endpointId: 'recraftv4',
    displayName: 'Recraft v4',
    modality: 'image',
    primaryTask: 'text-to-image',
    tasks: ['text-to-image', 'image-to-image'],
    description: 'Recraft v4 design-system-grade raster and native SVG vector generation with explicit RGB palette control.',
    docsUrl: 'https://www.recraft.ai/docs',
    parameters: [
      promptParam('Creative design prompt (up to 1000 chars).'),
      choiceField('size', 'Canvas Size', ['1024x1024', '1365x1024', '1024x1365', '1536x1024', '1024x1536', '1820x1024', '1024x1820', '2048x1024', '1024x2048'], { standardKey: 'size', default: '1024x1024' }),
      choiceField('style', 'Style', ['realistic_image', 'digital_illustration', 'vector_illustration', 'icon'], { standardKey: 'style', default: 'realistic_image' }),
      choiceField('response_format', 'Output Format', ['url', 'b64_json'], { standardKey: 'outputFormat', default: 'url' }),
      { key: 'colors', standardKey: 'colorPalette', label: 'RGB Color Palette', type: 'array', itemType: 'object', required: false, description: 'Explicit RGB color constraints for brand consistency.' },
      { key: 'n', standardKey: 'count', label: 'Count', type: 'integer', required: false, default: 1, min: 1, max: 6, step: 1 },
    ],
    capabilityOverrides: { features: ['svg', 'brand-palette'] },
    tags: ['official-api', 'vector', 'svg'],
  }),
  makeCurated({
    canonicalId: 'elevenlabs/v3',
    family: 'elevenlabs',
    creator: 'ElevenLabs',
    provider: 'elevenlabs',
    endpointId: 'eleven_v3',
    displayName: 'ElevenLabs v3',
    modality: 'audio',
    primaryTask: 'text-to-speech',
    tasks: ['text-to-speech'],
    description: 'ElevenLabs flagship Eleven v3 expressive speech synthesis with inline audio performance tags and fine voice settings.',
    docsUrl: 'https://elevenlabs.io/docs/api-reference/text-to-speech/convert',
    parameters: [
      { key: 'text', standardKey: 'prompt', label: 'Script Text', type: 'string', required: true },
      { key: 'voice_id', standardKey: 'voice', label: 'Voice ID', type: 'string', required: true },
      { key: 'language_code', standardKey: 'language', label: 'Language Code', type: 'string', required: false },
      { key: 'stability', standardKey: 'stability', label: 'Stability', type: 'number', required: false, default: 0.5, min: 0, max: 1, step: 0.05 },
      { key: 'similarity_boost', standardKey: 'similarityBoost', label: 'Similarity Boost', type: 'number', required: false, default: 0.75, min: 0, max: 1, step: 0.05 },
      { key: 'speed', standardKey: 'speed', label: 'Speed', type: 'number', required: false, default: 1, min: 0.7, max: 1.2, step: 0.05 },
      choiceField('output_format', 'Output Format', ['mp3_44100_128', 'mp3_44100_192', 'pcm_24000', 'pcm_44100', 'ulaw_8000'], { standardKey: 'outputFormat', default: 'mp3_44100_128' }),
      seedParam(),
    ],
    capabilityOverrides: { supportsStreaming: true },
    tags: ['official-api', 'flagship', 'tts'],
  }),
  makeCurated({
    canonicalId: 'suno/suno-v4',
    family: 'suno',
    creator: 'Suno',
    provider: 'suno',
    endpointId: 'chirp-v4',
    displayName: 'Suno v4 (Chirp v4)',
    modality: 'audio',
    primaryTask: 'text-to-music',
    tasks: ['text-to-music'],
    description: 'Suno v4 full-song music generation with vocals, custom lyrics, genre tags, and instrumental mode.',
    parameters: [
      promptParam('Music style inspiration or custom song brief.'),
      { key: 'tags', standardKey: 'musicStyle', label: 'Style Tags', type: 'string', required: false },
      { key: 'lyrics', standardKey: 'lyrics', label: 'Custom Lyrics', type: 'string', required: false },
      { key: 'make_instrumental', standardKey: 'instrumental', label: 'Instrumental Only', type: 'boolean', required: false, default: false },
      choiceField('vocal_gender', 'Vocal Gender', ['Male', 'Female'], { standardKey: 'vocalGender' }),
    ],
    tags: ['official-api', 'music'],
  }),
];

export function buildCuratedShard(): ProviderCatalogShard {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    shardId: 'curated',
    source: 'curated',
    generatedAt: CURATED_SYNC_DATE,
    providers: CURATED_PROVIDERS,
    endpoints: CURATED_ENDPOINTS,
  };
}
