import {
  type DurationCapability,
  type IoModality,
  type ModelCapabilities,
  type ModelEndpointEntry,
  type MultimodalModality,
  type MultimodalTask,
  type ParameterChoiceOption,
  type ParameterFieldSchema,
  type ParameterTier,
  type ParameterValueType,
  type CanonicalModelRecord,
  type RegistryStats,
  type StandardParameterKey,
} from './schema.ts';

const WIRE_TO_STANDARD_KEY: Record<string, StandardParameterKey> = {
  // Prompts & text controls
  prompt: 'prompt',
  text: 'prompt',
  negative_prompt: 'negativePrompt',
  negativeprompt: 'negativePrompt',
  system_prompt: 'systemPrompt',
  enable_prompt_expansion: 'promptExtend',
  prompt_extend: 'promptExtend',
  expand_prompt: 'promptExtend',
  magic_prompt: 'promptExtend',
  magic_prompt_option: 'promptExtend',
  enhance_prompt: 'promptExtend',
  enhance_prompt_mode: 'promptExtend',
  thinking_level: 'thinkingLevel',
  enable_thinking: 'thinkingLevel',
  reasoning_effort: 'reasoningEffort',
  enable_web_search: 'webSearch',
  web_search: 'webSearch',
  // Common output & determinism
  seed: 'seed',
  num_images: 'count',
  n: 'count',
  num_outputs: 'count',
  max_images: 'count',
  num_layers: 'maxLayers',
  max_layers: 'maxLayers',
  output_format: 'outputFormat',
  format: 'outputFormat',
  output_mime_type: 'outputFormat',
  response_format: 'outputFormat',
  output_compression: 'outputCompression',
  enable_safety_checker: 'safetyChecker',
  safety_checker: 'safetyChecker',
  safety_tolerance: 'safetyTolerance',
  moderation: 'moderation',
  watermark: 'watermark',
  sync_mode: 'syncMode',
  // Geometry & visual controls
  aspect_ratio: 'aspectRatio',
  aspectratio: 'aspectRatio',
  ratio: 'aspectRatio',
  resolution: 'resolution',
  image_size: 'size',
  size: 'size',
  width: 'width',
  height: 'height',
  quality: 'quality',
  background: 'background',
  style: 'style',
  style_type: 'style',
  rendering_speed: 'renderingSpeed',
  colors: 'colorPalette',
  rgb_colors: 'colorPalette',
  // Diffusion / sampling
  num_inference_steps: 'steps',
  steps: 'steps',
  guidance_scale: 'cfg',
  cfg_scale: 'cfg',
  cfg: 'cfg',
  strength: 'strength',
  denoise: 'strength',
  sampler: 'sampler',
  sampler_name: 'sampler',
  scheduler: 'scheduler',
  acceleration: 'acceleration',
  // Reference / multimodal media inputs
  image: 'inputImage',
  image_url: 'inputImage',
  start_image_url: 'inputImage',
  first_frame_url: 'inputImage',
  first_frame_image: 'inputImage',
  subject_image_url: 'inputImage',
  image_urls: 'referenceImages',
  reference_images: 'referenceImages',
  reference_image_urls: 'referenceImages',
  source_image_urls: 'referenceImages',
  input_images: 'referenceImages',
  images: 'referenceImages',
  end_image_url: 'endImage',
  last_frame_url: 'endImage',
  last_frame_image: 'endImage',
  tail_image_url: 'endImage',
  middle_image_urls: 'middleImages',
  mask: 'maskImage',
  mask_url: 'maskImage',
  mask_image: 'maskImage',
  markup_image_url: 'maskImage',
  video: 'inputVideo',
  video_url: 'inputVideo',
  video_urls: 'referenceVideos',
  reference_videos: 'referenceVideos',
  reference_video_urls: 'referenceVideos',
  audio: 'generateAudio',
  audio_url: 'inputAudio',
  audio_urls: 'referenceAudios',
  reference_audios: 'referenceAudios',
  reference_audio_urls: 'referenceAudios',
  input_fidelity: 'inputFidelity',
  // Video controls
  duration: 'duration',
  duration_seconds: 'duration',
  music_length_ms: 'duration',
  seconds: 'duration',
  fps: 'fps',
  frames_per_second: 'fps',
  num_frames: 'numFrames',
  generate_audio: 'generateAudio',
  sound: 'generateAudio',
  with_audio: 'generateAudio',
  camera_fixed: 'cameraFixed',
  camera_control: 'cameraControl',
  bitrate_mode: 'bitrateMode',
  codec: 'codec',
  hdr: 'hdr',
  return_last_frame: 'returnLastFrame',
  multi_prompt: 'multiPrompt',
  draft: 'draftMode',
  // Animated image
  frame_count: 'frameCount',
  frame_duration_ms: 'frameDurationMs',
  // Audio / Speech / Music / SFX
  voice: 'voice',
  voice_id: 'voice',
  voice_ids: 'voice',
  language: 'language',
  language_code: 'language',
  speed: 'speed',
  pitch: 'pitch',
  volume: 'volume',
  stability: 'stability',
  similarity_boost: 'similarityBoost',
  emotion: 'emotion',
  sample_rate: 'sampleRate',
  timestamps: 'timestamps',
  instrumental: 'instrumental',
  force_instrumental: 'instrumental',
  make_instrumental: 'instrumental',
  lyrics: 'lyrics',
  tags: 'musicStyle',
  styles: 'musicStyle',
  vocal_gender: 'vocalGender',
  loop: 'loop',
};

const SKIPPED_INTERNAL_KEYS = new Set([
  'model',
  'end_user_id',
  'webhook_url',
  'callback_url',
]);

export function mapWireKeyToStandard(
  wireKey: string,
  modality: MultimodalModality,
  valueType?: ParameterValueType,
): StandardParameterKey | undefined {
  const normalized = wireKey.trim().toLowerCase();
  if (normalized === 'audio') {
    return valueType === 'boolean' || modality === 'video' ? 'generateAudio' : 'inputAudio';
  }
  if (normalized === 'mode' && modality === 'video') {
    return 'quality';
  }
  return WIRE_TO_STANDARD_KEY[normalized];
}

export const PRIMARY_STANDARD_KEYS_BY_MODALITY: Record<MultimodalModality, readonly StandardParameterKey[]> = {
  image: ['aspectRatio', 'resolution', 'size', 'quality', 'count', 'background'],
  video: ['aspectRatio', 'resolution', 'duration', 'generateAudio'],
  audio: ['voice', 'duration', 'instrumental', 'language'],
  '3d': ['quality', 'outputFormat'],
};

/**
 * Classify whether a parameter belongs to quick primary controls or collapsible advanced controls.
 * Shared as the SSOT rule across Studio, Super Agent, and registry conversions.
 */
export function classifyParameterTier(
  modality: MultimodalModality,
  wireKey: string,
  standardKey?: StandardParameterKey,
  valueType?: ParameterValueType,
): ParameterTier {
  const std = standardKey ?? mapWireKeyToStandard(wireKey, modality, valueType);
  if (std && PRIMARY_STANDARD_KEYS_BY_MODALITY[modality].includes(std)) {
    return 'primary';
  }
  return 'advanced';
}

export function humanizeParameterKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .replace(/\bUrl\b/g, 'URL')
    .replace(/\bUrls\b/g, 'URLs')
    .replace(/\bFps\b/g, 'FPS')
    .replace(/\bHdr\b/g, 'HDR')
    .replace(/\bCfg\b/g, 'CFG')
    .replace(/\bMs\b/g, 'ms')
    .replace(/\bId\b/g, 'ID')
    .replace(/\bIds\b/g, 'IDs');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveRef(
  schema: Record<string, unknown>,
  rootSchemas: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 8) return schema;
  const ref = typeof schema.$ref === 'string' ? schema.$ref : undefined;
  if (!ref) return schema;
  const match = ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!match) return schema;
  const target = rootSchemas[match[1]];
  if (!isRecord(target)) return schema;
  return resolveRef({ ...target, ...schema, $ref: undefined }, rootSchemas, depth + 1);
}

function flattenUnionSchemas(
  schema: Record<string, unknown>,
  rootSchemas: Record<string, unknown>,
): { primary: Record<string, unknown>; enumValues?: (string | number | boolean)[]; nullable: boolean } {
  const resolved = resolveRef(schema, rootSchemas);
  const branches = (Array.isArray(resolved.anyOf) ? resolved.anyOf : Array.isArray(resolved.oneOf) ? resolved.oneOf : null)
    ?.filter(isRecord)
    .map(b => resolveRef(b, rootSchemas));

  if (!branches || branches.length === 0) {
    const directEnum = Array.isArray(resolved.enum)
      ? resolved.enum.filter((v): v is string | number | boolean =>
          typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      : undefined;
    return {
      primary: resolved,
      ...(directEnum?.length ? { enumValues: directEnum } : {}),
      nullable: resolved.type === 'null',
    };
  }

  let nullable = false;
  const nonNull: Record<string, unknown>[] = [];
  const collectedEnum: (string | number | boolean)[] = [];

  for (const branch of branches) {
    if (branch.type === 'null') {
      nullable = true;
      continue;
    }
    nonNull.push(branch);
    if (Array.isArray(branch.enum)) {
      for (const v of branch.enum) {
        if ((typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && !collectedEnum.includes(v)) {
          collectedEnum.push(v);
        }
      }
    }
    if (branch.const !== undefined && (typeof branch.const === 'string' || typeof branch.const === 'number' || typeof branch.const === 'boolean')) {
      if (!collectedEnum.includes(branch.const)) collectedEnum.push(branch.const);
    }
  }

  // Prefer enum/primitive branch over object fallback (e.g., fal `image_size: ImageSizeEnum | { width, height }`)
  const preferred = nonNull.find(b => Array.isArray(b.enum))
    ?? nonNull.find(b => b.type === 'string' || b.type === 'integer' || b.type === 'number' || b.type === 'boolean')
    ?? nonNull[0]
    ?? resolved;

  const merged: Record<string, unknown> = {
    ...preferred,
    title: resolved.title ?? preferred.title,
    description: resolved.description ?? preferred.description,
    default: resolved.default !== undefined ? resolved.default : preferred.default,
  };

  return {
    primary: merged,
    ...(collectedEnum.length ? { enumValues: collectedEnum } : {}),
    nullable,
  };
}

function inferValueType(
  schema: Record<string, unknown>,
  enumValues?: readonly (string | number | boolean)[],
): ParameterValueType {
  if (enumValues && enumValues.length > 0 && schema.type !== 'boolean') {
    return 'enum';
  }
  switch (schema.type) {
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    case 'string':
    default:
      return 'string';
  }
}

function cleanDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > 360 ? `${compact.slice(0, 357)}...` : compact;
}

/**
 * Find the request Input schema object inside an OpenAPI 3.0 document
 * (supports fal.ai `expand=openapi-3.0`, Atlas Cloud `/model/schema/*.json`, and Replicate Cog `openapi_schema`).
 */
export function extractOpenApiInputSchema(
  doc: unknown,
): { inputSchema: Record<string, unknown>; rootSchemas: Record<string, unknown> } | null {
  if (!isRecord(doc)) return null;
  const components = isRecord(doc.components) ? doc.components : undefined;
  const rootSchemas = components && isRecord(components.schemas) ? components.schemas : {};

  // 1. Check requestBody $ref or inline schema in paths
  if (isRecord(doc.paths)) {
    for (const pathItem of Object.values(doc.paths)) {
      if (!isRecord(pathItem)) continue;
      const postOp = isRecord(pathItem.post) ? pathItem.post : undefined;
      const reqBody = postOp && isRecord(postOp.requestBody) ? postOp.requestBody : undefined;
      const content = reqBody && isRecord(reqBody.content) ? reqBody.content : undefined;
      const appJson = content && isRecord(content['application/json']) ? content['application/json'] : undefined;
      const bodySchema = appJson && isRecord(appJson.schema) ? appJson.schema : undefined;
      if (bodySchema) {
        const resolved = resolveRef(bodySchema, rootSchemas);
        if (isRecord(resolved.properties)) {
          return { inputSchema: resolved, rootSchemas };
        }
      }
    }
  }

  // 2. Fallback to components.schemas.Input or *Input
  const directInput = rootSchemas.Input;
  if (isRecord(directInput) && isRecord(directInput.properties)) {
    return { inputSchema: directInput, rootSchemas };
  }
  const suffixInputKey = Object.keys(rootSchemas).find(k => /Input$/i.test(k) && isRecord(rootSchemas[k]) && isRecord((rootSchemas[k] as Record<string, unknown>).properties));
  if (suffixInputKey) {
    return { inputSchema: rootSchemas[suffixInputKey] as Record<string, unknown>, rootSchemas };
  }
  return null;
}

/**
 * Normalize an OpenAPI 3.0 document into ordered `ParameterFieldSchema[]` + `standardParameterMap`.
 */
export function normalizeOpenApiParameters(
  doc: unknown,
  modality: MultimodalModality,
): {
  parameters: ParameterFieldSchema[];
  standardParameterMap: Partial<Record<StandardParameterKey, string>>;
  requiredParameters: string[];
} {
  const extracted = extractOpenApiInputSchema(doc);
  if (!extracted) {
    return { parameters: [], standardParameterMap: {}, requiredParameters: [] };
  }
  const { inputSchema, rootSchemas } = extracted;
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const requiredSet = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((item): item is string => typeof item === 'string')
      : [],
  );
  const falOrder = Array.isArray(inputSchema['x-fal-order-properties'])
    ? inputSchema['x-fal-order-properties'].filter((item): item is string => typeof item === 'string')
    : [];

  const parameters: ParameterFieldSchema[] = [];
  const standardParameterMap: Partial<Record<StandardParameterKey, string>> = {};

  for (const [key, rawProp] of Object.entries(properties)) {
    if (SKIPPED_INTERNAL_KEYS.has(key.toLowerCase())) continue;
    if (!isRecord(rawProp)) continue;

    const { primary, enumValues } = flattenUnionSchemas(rawProp, rootSchemas);
    const type = inferValueType(primary, enumValues);
    const standardKey = mapWireKeyToStandard(key, modality, type);

    const falIndex = falOrder.indexOf(key);
    const xOrder = typeof rawProp['x-order'] === 'number'
      ? rawProp['x-order']
      : typeof primary['x-order'] === 'number'
        ? primary['x-order']
        : undefined;
    const uiOrder = falIndex >= 0 ? falIndex : xOrder;

    const field: ParameterFieldSchema = {
      key,
      ...(standardKey ? { standardKey } : {}),
      label: typeof primary.title === 'string' && primary.title.trim()
        ? primary.title.trim()
        : humanizeParameterKey(key),
      type,
      required: requiredSet.has(key),
    };

    if (primary.default !== undefined && primary.default !== null) {
      field.default = primary.default as ParameterFieldSchema['default'];
    }
    if (enumValues && enumValues.length > 0 && type !== 'boolean') {
      field.enum = enumValues;
    }
    // Check if union allows custom object/string alongside enum (e.g., fal `image_size`)
    if (enumValues?.length && Array.isArray(rawProp.anyOf) && rawProp.anyOf.some(b => isRecord(b) && (b.type === 'object' || (typeof b.$ref === 'string' && /ImageSize/i.test(b.$ref))))) {
      field.allowCustom = true;
    }

    if (typeof primary.minimum === 'number') field.min = primary.minimum;
    if (typeof primary.maximum === 'number') field.max = primary.maximum;
    if (typeof primary.multipleOf === 'number') field.step = primary.multipleOf;
    if (typeof primary.minItems === 'number') field.minItems = primary.minItems;
    if (typeof primary.maxItems === 'number') field.maxItems = primary.maxItems;
    if (typeof primary.minLength === 'number') field.minLength = primary.minLength;
    if (typeof primary.maxLength === 'number') field.maxLength = primary.maxLength;

    if (type === 'array' && isRecord(primary.items)) {
      const itemResolved = flattenUnionSchemas(primary.items, rootSchemas);
      field.itemType = inferValueType(itemResolved.primary, itemResolved.enumValues);
    }

    if (uiOrder !== undefined) field.uiOrder = uiOrder;
    const description = cleanDescription(primary.description);
    if (description) field.description = description;

    parameters.push(field);
    if (standardKey && !standardParameterMap[standardKey]) {
      standardParameterMap[standardKey] = key;
    }
  }

  parameters.sort((a, b) => {
    const ao = a.uiOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.uiOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.key.localeCompare(b.key);
  });

  const requiredParameters = parameters.filter(p => p.required).map(p => p.key);
  return { parameters, standardParameterMap, requiredParameters };
}

function parseNumericValues(values: readonly (string | number | boolean)[] | undefined): {
  numbers: number[];
  supportsAuto: boolean;
} {
  if (!values?.length) return { numbers: [], supportsAuto: false };
  const numbers: number[] = [];
  let supportsAuto = false;
  for (const v of values) {
    if (v === 'auto' || v === -1 || v === '-1') {
      supportsAuto = true;
      continue;
    }
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/s$/i, '')) : Number.NaN;
    if (Number.isFinite(n) && n > 0) numbers.push(n);
  }
  return { numbers: [...new Set(numbers)].sort((a, b) => a - b), supportsAuto };
}

const ASPECT_RATIO_PATTERN = /^(?:\d+:\d+|auto|adaptive|match_input_image|square(?:_hd)?|portrait_\d+_\d+|landscape_\d+_\d+)$/i;

function stringEnumOf(param: ParameterFieldSchema | undefined): string[] | undefined {
  if (!param) return undefined;
  const raw = param.enum ?? param.choices?.map(c => c.value);
  if (!raw?.length) return undefined;
  const out = [...new Set(raw.map(String).filter(Boolean))];
  return out.length ? out : undefined;
}

/**
 * Infer structured `ModelCapabilities` from normalized `ParameterFieldSchema[]` + task/modality metadata.
 */
export function inferCapabilitiesFromParameters(
  modality: MultimodalModality,
  tasks: readonly MultimodalTask[],
  parameters: readonly ParameterFieldSchema[],
  overrides?: Partial<ModelCapabilities>,
): ModelCapabilities {
  const byStd = new Map<StandardParameterKey, ParameterFieldSchema>();
  for (const param of parameters) {
    if (param.standardKey && !byStd.has(param.standardKey)) {
      byStd.set(param.standardKey, param);
    }
  }

  const inputSet = new Set<IoModality>(overrides?.inputModalities ?? ['text']);
  const outputSet = new Set<IoModality>(overrides?.outputModalities ?? [modality]);

  const hasSingleImage = byStd.has('inputImage');
  const refImages = byStd.get('referenceImages');
  const hasEndImage = byStd.has('endImage');
  const hasMask = byStd.has('maskImage');
  const hasInputVideo = byStd.has('inputVideo');
  const refVideos = byStd.get('referenceVideos');
  const hasInputAudio = byStd.has('inputAudio');
  const refAudios = byStd.get('referenceAudios');

  if (
    hasSingleImage || refImages || hasEndImage || hasMask
    || tasks.some(t => t.startsWith('image-') || t === 'inpainting' || t === 'outpainting' || t === 'upscale' || t === 'remove-background' || t === 'relight' || t === 'layerize' || t === 'first-last-frame-to-video')
  ) {
    inputSet.add('image');
  }
  if (hasInputVideo || refVideos || tasks.some(t => t.startsWith('video-'))) {
    inputSet.add('video');
  }
  if (hasInputAudio || refAudios || tasks.some(t => t.startsWith('audio-') || t === 'speech-to-text' || t === 'voice-clone' || t === 'voice-changer' || t === 'stem-separation')) {
    inputSet.add('audio');
  }

  const generateAudio = byStd.get('generateAudio');
  if (modality === 'video' && (generateAudio || overrides?.supportsNativeAudio || overrides?.nativeAudioAlwaysOn)) {
    outputSet.add('audio');
  }

  let maxReferenceImages = overrides?.maxReferenceImages;
  if (maxReferenceImages === undefined) {
    if (refImages?.maxItems !== undefined) maxReferenceImages = refImages.maxItems;
    else if (refImages) {
      const m = refImages.description?.match(/up to\s+(\d+)\s+(?:reference\s+)?images?/i);
      maxReferenceImages = m ? Number(m[1]) : 4;
    } else if (hasSingleImage && hasEndImage) maxReferenceImages = 2;
    else if (hasSingleImage) maxReferenceImages = 1;
  }

  let maxReferenceVideos = overrides?.maxReferenceVideos;
  if (maxReferenceVideos === undefined) {
    if (refVideos?.maxItems !== undefined) maxReferenceVideos = refVideos.maxItems;
    else if (hasInputVideo) maxReferenceVideos = 1;
  }

  let maxReferenceAudios = overrides?.maxReferenceAudios;
  if (maxReferenceAudios === undefined) {
    if (refAudios?.maxItems !== undefined) maxReferenceAudios = refAudios.maxItems;
    else if (hasInputAudio) maxReferenceAudios = 1;
  }

  const ratioParam = byStd.get('aspectRatio');
  const sizeParam = byStd.get('size');
  const resolutionParam = byStd.get('resolution');
  const formatParam = byStd.get('outputFormat');
  const qualityParam = byStd.get('quality');
  const backgroundParam = byStd.get('background');
  const durationParam = byStd.get('duration');

  const aspectRatios = overrides?.aspectRatios
    ?? stringEnumOf(ratioParam)
    ?? stringEnumOf(sizeParam)?.filter(v => ASPECT_RATIO_PATTERN.test(v));
  const resolutions = overrides?.resolutions ?? stringEnumOf(resolutionParam);
  const sizes = overrides?.sizes ?? stringEnumOf(sizeParam);
  const outputFormats = overrides?.outputFormats ?? stringEnumOf(formatParam);
  const qualities = overrides?.qualities ?? stringEnumOf(qualityParam);

  let duration: DurationCapability | undefined = overrides?.duration;
  if (!duration && durationParam) {
    const isMs = durationParam.key.toLowerCase().endsWith('_ms');
    const scale = isMs ? 1 / 1000 : 1;
    const parsed = parseNumericValues(durationParam.enum ?? durationParam.choices?.map(c => c.value));
    const min = durationParam.min !== undefined ? durationParam.min * scale : parsed.numbers[0];
    const max = durationParam.max !== undefined ? durationParam.max * scale : parsed.numbers.at(-1);
    const defRaw = durationParam.default;
    const defNum = typeof defRaw === 'number'
      ? (defRaw > 0 ? defRaw * scale : undefined)
      : typeof defRaw === 'string' && /^\d+(?:\.\d+)?s?$/i.test(defRaw)
        ? Number(defRaw.replace(/s$/i, '')) * scale
        : undefined;
    const supportsAuto = parsed.supportsAuto || defRaw === 'auto' || defRaw === -1;
    if (min !== undefined || max !== undefined || parsed.numbers.length > 0) {
      duration = {
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(defNum !== undefined ? { default: defNum } : {}),
        ...(parsed.numbers.length > 0 && parsed.numbers.length <= 32 ? { values: parsed.numbers } : {}),
        ...(supportsAuto ? { supportsAuto: true } : {}),
      };
    }
  }

  const features = new Set<string>(overrides?.features ?? []);
  if (byStd.has('webSearch')) features.add('web-search');
  if (byStd.has('thinkingLevel') || byStd.has('reasoningEffort')) features.add('reasoning');
  if (byStd.has('hdr')) features.add('hdr');
  if (byStd.has('multiPrompt')) features.add('multi-shot');
  if (byStd.has('frameCount') || outputFormats?.some(f => f.toLowerCase() === 'gif')) features.add('animated-gif');
  if (parameters.some(p => p.key.toLowerCase().includes('svg')) || outputFormats?.some(f => f.toLowerCase() === 'svg')) features.add('svg');
  if (resolutions?.some(r => /4k|2160p/i.test(r)) || sizes?.some(s => /4k|3840/i.test(s))) features.add('4k');

  const bgValues = stringEnumOf(backgroundParam)?.map(v => v.toLowerCase()) ?? [];
  const supportsTransparentBackground = overrides?.supportsTransparentBackground
    ?? (bgValues.includes('transparent') || tasks.includes('remove-background') || undefined);

  const supportsLayerDecomposition = overrides?.supportsLayerDecomposition
    ?? (tasks.includes('layerize') || byStd.has('maxLayers') || undefined);

  return {
    inputModalities: [...inputSet],
    outputModalities: [...outputSet],
    tasks: [...new Set(tasks)],
    ...(maxReferenceImages !== undefined ? { maxReferenceImages } : {}),
    ...(maxReferenceVideos !== undefined ? { maxReferenceVideos } : {}),
    ...(maxReferenceAudios !== undefined ? { maxReferenceAudios } : {}),
    ...(inputSet.has('image') ? { supportsImageInput: true } : {}),
    ...(hasEndImage || tasks.includes('first-last-frame-to-video') || overrides?.supportsFirstLastFrame
      ? { supportsFirstLastFrame: true }
      : {}),
    ...(hasMask || overrides?.supportsMask ? { supportsMask: true } : {}),
    ...(generateAudio || overrides?.supportsNativeAudio || overrides?.nativeAudioAlwaysOn
      ? { supportsNativeAudio: true }
      : {}),
    ...(overrides?.nativeAudioAlwaysOn ? { nativeAudioAlwaysOn: true } : {}),
    ...(supportsTransparentBackground ? { supportsTransparentBackground: true } : {}),
    ...(supportsLayerDecomposition ? { supportsLayerDecomposition: true } : {}),
    ...(byStd.has('promptExtend') || overrides?.supportsPromptExpansion ? { supportsPromptExpansion: true } : {}),
    ...(byStd.has('seed') || overrides?.supportsSeed ? { supportsSeed: true } : {}),
    ...(byStd.has('multiPrompt') || overrides?.supportsMultiPrompt ? { supportsMultiPrompt: true } : {}),
    ...(byStd.has('cameraControl') || byStd.has('cameraFixed') || overrides?.supportsCameraControl
      ? { supportsCameraControl: true }
      : {}),
    ...(overrides?.supportsStreaming ? { supportsStreaming: true } : {}),
    ...(aspectRatios?.length ? { aspectRatios } : {}),
    ...(resolutions?.length ? { resolutions } : {}),
    ...(sizes?.length ? { sizes } : {}),
    ...(outputFormats?.length ? { outputFormats } : {}),
    ...(qualities?.length ? { qualities } : {}),
    ...(duration ? { duration } : {}),
    ...(features.size ? { features: [...features].sort() } : {}),
  };
}

/**
 * Classify a provider category / endpoint slug into normalized modality + tasks.
 * Evaluates explicit endpoint/category signals before optional capability tags so
 * tags such as `lipsync` never override an explicit `text-to-video` or `image-to-video` slug.
 */
function classifyMultimodalText(
  text: string,
  explicitModality?: string,
): { modality: MultimodalModality; primaryTask: MultimodalTask; tasks: MultimodalTask[] } | null {
  const s = `${text} ${explicitModality ?? ''}`.toLowerCase().replace(/_/g, '-');

  // Exclude pure LLM / text / embedding / training endpoints
  if (/\b(?:to-text|llm|chat|embedding|rerank|training|lora-train|detection|segmentation|ocr|caption)\b/.test(s) && !/speech-to-text|image-to-image|text-to-image|text-to-video|image-to-video|text-to-audio|text-to-speech|text-to-music/.test(s)) {
    return null;
  }

  // 3D
  if (/text-to-3d|image-to-3d|\b3d\b/.test(s) && /tripo|meshy|hunyuan-?3d|trellis|rodin|3d/.test(s)) {
    const task: MultimodalTask = /image-to-3d/.test(s) ? 'image-to-3d' : 'text-to-3d';
    return { modality: '3d', primaryTask: task, tasks: [task] };
  }

  // Video — check explicit task slugs/categories BEFORE capability tags like `lipsync`/`avatar`.
  if (/first-last-frame|start-end-frame/.test(s)) {
    return { modality: 'video', primaryTask: 'first-last-frame-to-video', tasks: ['first-last-frame-to-video', 'image-to-video'] };
  }
  if (/reference-to-video|\br2v\b/.test(s)) {
    return { modality: 'video', primaryTask: 'reference-to-video', tasks: ['reference-to-video'] };
  }
  if (/video-to-video|video-edit|edit-video|\/edit\b/.test(s) && /video|kling|seedance|veo|wan|runway|luma|sora|hailuo|vidu|pixverse/.test(s) && !/image-to-image|text-to-image|edit-image|image-edit|edit-sequential/.test(s)) {
    const isEdit = /edit/.test(s);
    return { modality: 'video', primaryTask: isEdit ? 'video-edit' : 'video-to-video', tasks: [isEdit ? 'video-edit' : 'video-to-video'] };
  }
  if (/video-extend|extend-video|\bextend\b/.test(s) && /video|veo|kling|seedance|luma|runway/.test(s)) {
    return { modality: 'video', primaryTask: 'video-extend', tasks: ['video-extend'] };
  }
  if (/image-to-video|\bi2v\b/.test(s)) {
    return { modality: 'video', primaryTask: 'image-to-video', tasks: ['image-to-video'] };
  }
  if (/text-to-video|\bt2v\b/.test(s)) {
    return { modality: 'video', primaryTask: 'text-to-video', tasks: ['text-to-video'] };
  }
  if (/lip-?sync|avatar|talking/.test(s) && /video|sync|avatar|lip/.test(s)) {
    return { modality: 'video', primaryTask: 'lip-sync', tasks: ['lip-sync'] };
  }
  if (/video-generation|\bvideo\b/.test(s) && !/image-to-image|text-to-image|text-to-speech|text-to-audio/.test(s)) {
    return { modality: 'video', primaryTask: 'text-to-video', tasks: ['text-to-video'] };
  }

  // Audio / Speech / Music / SFX
  if (/speech-to-text|scribe|whisper|transcri/.test(s)) {
    return { modality: 'audio', primaryTask: 'speech-to-text', tasks: ['speech-to-text'] };
  }
  if (/sound-effect|\bsfx\b|foley/.test(s)) {
    return { modality: 'audio', primaryTask: 'text-to-sfx', tasks: ['text-to-sfx'] };
  }
  if (/music|suno|chirp|lyria|udio|minimax-music|song/.test(s)) {
    return { modality: 'audio', primaryTask: 'text-to-music', tasks: ['text-to-music'] };
  }
  if (/voice-clone/.test(s)) {
    return { modality: 'audio', primaryTask: 'voice-clone', tasks: ['voice-clone'] };
  }
  if (/voice-changer|speech-to-speech/.test(s)) {
    return { modality: 'audio', primaryTask: 'voice-changer', tasks: ['voice-changer'] };
  }
  if (/stem/.test(s) && /audio|music/.test(s)) {
    return { modality: 'audio', primaryTask: 'stem-separation', tasks: ['stem-separation'] };
  }
  if (/text-to-speech|\btts\b|kokoro|eleven-v|byteplus-tts|chatterbox|cosyvoice|fish-speech|f5-tts|orpheus/.test(s)) {
    return { modality: 'audio', primaryTask: 'text-to-speech', tasks: ['text-to-speech'] };
  }
  if (/audio-to-audio/.test(s)) {
    return { modality: 'audio', primaryTask: 'audio-to-audio', tasks: ['audio-to-audio'] };
  }
  if (/text-to-audio|\baudio\b/.test(s)) {
    return { modality: 'audio', primaryTask: 'text-to-music', tasks: ['text-to-music'] };
  }

  // Image
  if (/layerize|layer-decomp/.test(s)) {
    return { modality: 'image', primaryTask: 'layerize', tasks: ['layerize', 'image-edit'] };
  }
  if (/remove-background|rembg|bria\/background|rmbg/.test(s)) {
    return { modality: 'image', primaryTask: 'remove-background', tasks: ['remove-background'] };
  }
  if (/upscal|super-resolution|esrgan|clarity/.test(s)) {
    return { modality: 'image', primaryTask: 'upscale', tasks: ['upscale'] };
  }
  if (/relight|ic-light/.test(s)) {
    return { modality: 'image', primaryTask: 'relight', tasks: ['relight'] };
  }
  if (/inpaint/.test(s)) {
    return { modality: 'image', primaryTask: 'inpainting', tasks: ['inpainting', 'image-edit'] };
  }
  if (/outpaint/.test(s)) {
    return { modality: 'image', primaryTask: 'outpainting', tasks: ['outpainting', 'image-edit'] };
  }
  if (/\/edit\b|image-edit|edit-image|edit-sequential|kontext/.test(s)) {
    return { modality: 'image', primaryTask: 'image-edit', tasks: ['image-edit', 'image-to-image'] };
  }
  if (/image-to-image|\bi2i\b/.test(s)) {
    return { modality: 'image', primaryTask: 'image-to-image', tasks: ['image-to-image', 'image-edit'] };
  }
  if (/text-to-image|\bt2i\b|image-generation|\bimage\b/.test(s)) {
    return { modality: 'image', primaryTask: 'text-to-image', tasks: ['text-to-image'] };
  }

  return null;
}

export function classifyMultimodalTask(
  categoryOrSlug: string,
  explicitModality?: string,
  tags?: readonly string[],
): { modality: MultimodalModality; primaryTask: MultimodalTask; tasks: MultimodalTask[] } | null {
  const primary = classifyMultimodalText(categoryOrSlug, explicitModality);
  if (primary) return primary;
  if (tags?.length) {
    return classifyMultimodalText(`${categoryOrSlug} ${tags.join(' ')}`, explicitModality);
  }
  return null;
}

interface CanonicalRule {
  pattern: RegExp;
  creator: string;
  family: string;
  canonical: (match: RegExpMatchArray, lower: string) => string;
}

const CANONICAL_RULES: readonly CanonicalRule[] = [
  {
    pattern: /seedance[-_/]?v?(\d+(?:[.-]\d+)?)(?:[-_/]?(flash|pro|lite|mini))?/i,
    creator: 'ByteDance',
    family: 'seedance',
    canonical: (m) => `bytedance/seedance-${m[1].replace('-', '.')}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /seedream[-_/]?v?(\d+(?:[.-]\d+)?)(?:[-_/]?(flash|pro|lite))?/i,
    creator: 'ByteDance',
    family: 'seedream',
    canonical: (m) => `bytedance/seedream-${m[1].replace('-', '.')}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /gpt-image[-_/]?(\d+(?:[.-]\d+)?)(?:[-_/]?(sunburst|flare|mini))?/i,
    creator: 'OpenAI',
    family: 'gpt-image',
    canonical: (m) => `openai/gpt-image-${m[1].replace('-', '.')}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /sora[-_/]?v?(\d+(?:[.-]\d+)?)(?:[-_/]?(pro|turbo))?/i,
    creator: 'OpenAI',
    family: 'sora',
    canonical: (m) => `openai/sora-${m[1].replace('-', '.')}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /kling[-_/]?v?(\d+(?:[.-]\d+)?)(?:[-_/]?(pro|master|turbo|o1|standard|std))?/i,
    creator: 'Kuaishou',
    family: 'kling',
    canonical: (m) => `kuaishou/kling-${m[1].replace('-', '.')}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /veo[-_/]?v?(\d+(?:[.-]\d+)?)(?:[-_/]?(fast|lite|pro))?/i,
    creator: 'Google',
    family: 'veo',
    canonical: (m) => `google/veo-${m[1].replace('-', '.')}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /nano-banana(?:[-_/]?(pro|\d+(?:[.-]\d+)?))?/i,
    creator: 'Google',
    family: 'nano-banana',
    canonical: (m) => `google/nano-banana${m[1] ? `-${m[1].replace('-', '.').toLowerCase()}` : ''}`,
  },
  {
    pattern: /imagen[-_/]?v?(\d+(?:[.-]\d+)?)(?:[-_/]?(fast|ultra))?/i,
    creator: 'Google',
    family: 'imagen',
    canonical: (m) => `google/imagen-${m[1].replace('-', '.')}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /lyria[-_/]?v?(\d+(?:[.-]\d+)?)?/i,
    creator: 'Google',
    family: 'lyria',
    canonical: (m) => `google/lyria${m[1] ? `-${m[1].replace('-', '.')}` : ''}`,
  },
  {
    pattern: /wan[-_/]?v?(\d+(?:[.-]\d+)?)(?:[-_/]?(prime|pro|turbo|flash|a14b|image)(?=$|[\s/_.-]))?/i,
    creator: 'Alibaba',
    family: 'wan',
    canonical: (m) => `alibaba/wan-${m[1].replace('-', '.')}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /qwen[-_/]?image(?:[-_/]?(\d+(?:[.-]\d+)?))?(?:[-_/]?(pro|edit))?/i,
    creator: 'Alibaba',
    family: 'qwen-image',
    canonical: (m) => `alibaba/qwen-image${m[1] ? `-${m[1].replace('-', '.')}` : ''}${m[2] && m[2].toLowerCase() !== 'edit' ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /flux[-_.]?(2|1\.1|1)(?:[-_/]?(pro|max|dev|schnell|kontext|klein|ultra))?/i,
    creator: 'Black Forest Labs',
    family: 'flux',
    canonical: (m) => `bfl/flux-${m[1]}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /flux\/(schnell|dev|pro)/i,
    creator: 'Black Forest Labs',
    family: 'flux',
    canonical: (m) => `bfl/flux-1-${m[1].toLowerCase()}`,
  },
  {
    pattern: /ideogram[-_/]?v?(\d+(?:[.-]\d+)?)?/i,
    creator: 'Ideogram',
    family: 'ideogram',
    canonical: (m) => `ideogram/ideogram${m[1] ? `-v${m[1].replace('-', '.')}` : ''}`,
  },
  {
    pattern: /recraft[-_/]?v?(\d+(?:[.-]\d+)?)?/i,
    creator: 'Recraft',
    family: 'recraft',
    canonical: (m) => `recraft/recraft${m[1] ? `-v${m[1].replace('-', '.')}` : ''}`,
  },
  {
    pattern: /eleven(?:labs)?[-_/]?(?:tts[-_/]?)?(?:eleven[-_/]?)?(v\d+(?:[.-]\d+)?|music[-_/]?v?\d+(?:[.-]\d+)?|sound-effects[-_/]?v?\d+|scribe[-_/]?v?\d+|multilingual[-_/]?v?\d+)/i,
    creator: 'ElevenLabs',
    family: 'elevenlabs',
    canonical: (m) => `elevenlabs/${m[1].toLowerCase().replace(/\//g, '-').replace(/_/g, '-')}`,
  },
  {
    pattern: /(?:suno|chirp)[-_/]?(?:chirp[-_/]?)?v?(\d+(?:[.-]\d+)?)/i,
    creator: 'Suno',
    family: 'suno',
    canonical: (m) => `suno/suno-v${m[1].replace('-', '.')}`,
  },
  {
    pattern: /byteplus[-_/]?tts[-_/]?(\d+(?:[.-]\d+)?)?/i,
    creator: 'ByteDance',
    family: 'seed-tts',
    canonical: (m) => `bytedance/seed-tts${m[1] ? `-${m[1].replace('-', '.')}` : ''}`,
  },
  {
    pattern: /kokoro/i,
    creator: 'Hexgrad',
    family: 'kokoro',
    canonical: () => 'hexgrad/kokoro',
  },
  {
    pattern: /(?:minimax|hailuo)[-_/]?v?(\d+(?:[.-]\d+)?)?/i,
    creator: 'MiniMax',
    family: 'hailuo',
    canonical: (m) => `minimax/hailuo${m[1] ? `-${m[1].replace('-', '.')}` : ''}`,
  },
  {
    pattern: /vidu[-_/]?v?(\d+(?:[.-]\d+)?)?(?:[-_/]?(q\d+|pro))?/i,
    creator: 'Shengshu',
    family: 'vidu',
    canonical: (m) => `shengshu/vidu${m[1] ? `-${m[1].replace('-', '.')}` : ''}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /luma[-_/]?(?:ray[-_/]?)?(\d+(?:[.-]\d+)?)?/i,
    creator: 'Luma AI',
    family: 'luma',
    canonical: (m) => `luma/ray${m[1] ? `-${m[1].replace('-', '.')}` : ''}`,
  },
  {
    pattern: /runway[-_/]?(?:gen[-_/]?)?(\d+(?:[.-]\d+)?)?(?:[-_/]?(turbo|aleph))?/i,
    creator: 'Runway',
    family: 'runway',
    canonical: (m) => `runway/gen-${m[1] ? m[1].replace('-', '.') : '4'}${m[2] ? `-${m[2].toLowerCase()}` : ''}`,
  },
  {
    pattern: /pixverse[-_/]?v?(\d+(?:[.-]\d+)?)?/i,
    creator: 'PixVerse',
    family: 'pixverse',
    canonical: (m) => `pixverse/pixverse${m[1] ? `-v${m[1].replace('-', '.')}` : ''}`,
  },
  {
    pattern: /hunyuan[-_/]?(video|image|3d)[-_/]?v?(\d+(?:[.-]\d+)?)?/i,
    creator: 'Tencent',
    family: 'hunyuan',
    canonical: (m) => `tencent/hunyuan-${m[1].toLowerCase()}${m[2] ? `-${m[2].replace('-', '.')}` : ''}`,
  },
  {
    pattern: /tripo[-_/]?v?(\d+(?:[.-]\d+)?)?/i,
    creator: 'Tripo',
    family: 'tripo',
    canonical: (m) => `tripo/tripo${m[1] ? `-v${m[1].replace('-', '.')}` : ''}`,
  },
  {
    pattern: /meshy[-_/]?v?(\d+(?:[.-]\d+)?)?/i,
    creator: 'Meshy',
    family: 'meshy',
    canonical: (m) => `meshy/meshy${m[1] ? `-v${m[1].replace('-', '.')}` : ''}`,
  },
];

const TASK_PATH_SEGMENT_RE = /\/(?:first-last-frame-to-video|start-end-frame-to-video|reference-to-video|text-to-video|image-to-video|video-to-video|video-edit|edit-video|video-extend|extend-video|text-to-image|image-to-image|image-edit|edit-image|edit-sequential|sequential|text-to-speech|text-to-audio|text-to-music|speech-to-text|text-to-3d|image-to-3d|lip-sync|lipsync|upscale|inpaint|outpaint|remove-background|layerize|edit|us|t2v|i2v|r2v|v2v|t2i|i2i)(?=\/|$)/gi;
const TASK_NAME_PHRASE_RE = /\b(?:first[- ]last[- ]frame[- ]to[- ]video|reference[- ]to[- ]video|text[- ]to[- ]video|image[- ]to[- ]video|video[- ]to[- ]video|video[- ]edit|edit[- ]video|text[- ]to[- ]image|image[- ]to[- ]image|image[- ]edit|edit[- ]image|text[- ]to[- ]speech|text[- ]to[- ]audio|text[- ]to[- ]music|speech[- ]to[- ]text|text[- ]to[- ]3d|image[- ]to[- ]3d)\b/gi;

function stripTaskSegments(input: string): string {
  return input
    .replace(TASK_PATH_SEGMENT_RE, '')
    .replace(TASK_NAME_PHRASE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolveCanonicalIdentity(
  endpointId: string,
  displayName?: string,
  organization?: string,
): { canonicalId: string; family: string; creator: string } {
  const strippedEndpoint = stripTaskSegments(endpointId);
  const strippedDisplay = displayName ? stripTaskSegments(displayName) : '';
  const probe = `${strippedEndpoint} ${strippedDisplay}`.trim();
  const lower = probe.toLowerCase();

  for (const rule of CANONICAL_RULES) {
    const match = probe.match(rule.pattern);
    if (match) {
      return {
        canonicalId: rule.canonical(match, lower),
        family: rule.family,
        creator: rule.creator,
      };
    }
  }

  const clean = strippedEndpoint
    .replace(/^fal-ai\//i, '')
    .replace(/\/us$/i, '')
    .toLowerCase();
  const segments = clean.split('/').filter(Boolean);
  const creator = organization?.trim() || (segments.length > 1 ? humanizeParameterKey(segments[0]) : 'Community');
  const family = (segments.length > 1 ? segments[1] : segments[0] ?? 'other')
    .replace(/[-_.]v?\d+(?:[.-]\d+)*.*$/i, '') || segments[0] || 'other';
  const canonicalId = segments.length >= 2 ? `${segments[0]}/${segments[1]}` : clean || endpointId.toLowerCase();

  return { canonicalId, family, creator };
}

function qualityRank(q: ModelEndpointEntry['schemaQuality']): number {
  if (q === 'openapi-live') return 3;
  if (q === 'verified-curated') return 2;
  return 1;
}

function mergeStringUnions(...lists: (readonly string[] | undefined)[]): string[] | undefined {
  const out = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) out.add(item);
  }
  return out.size ? [...out] : undefined;
}

function mergeDuration(durations: (DurationCapability | undefined)[]): DurationCapability | undefined {
  const valid = durations.filter((d): d is DurationCapability => Boolean(d));
  if (!valid.length) return undefined;
  const mins = valid.map(d => d.min).filter((n): n is number => n !== undefined);
  const maxs = valid.map(d => d.max).filter((n): n is number => n !== undefined);
  const values = [...new Set(valid.flatMap(d => d.values ?? []))].sort((a, b) => a - b);
  const def = valid.find(d => d.default !== undefined)?.default;
  const supportsAuto = valid.some(d => d.supportsAuto);
  return {
    ...(mins.length ? { min: Math.min(...mins) } : {}),
    ...(maxs.length ? { max: Math.max(...maxs) } : {}),
    ...(def !== undefined ? { default: def } : {}),
    ...(values.length && values.length <= 32 ? { values } : {}),
    ...(supportsAuto ? { supportsAuto: true } : {}),
  };
}

/**
 * Aggregate provider endpoints into canonical cross-provider `CanonicalModelRecord`s.
 * Endpoints are always grouped by `(canonicalId, modality)` so a single canonical record
 * never mixes modalities. When a canonical family spans multiple modalities, the dominant
 * modality keeps `canonicalId` and secondary modalities are disambiguated as
 * `${canonicalId}-${modality}` (unless `canonicalId` already ends with that suffix).
 */
export function buildCanonicalModels(
  endpoints: readonly ModelEndpointEntry[],
): Record<string, CanonicalModelRecord> {
  const byCanonical = new Map<string, Map<MultimodalModality, ModelEndpointEntry[]>>();
  for (const ep of endpoints) {
    let byModality = byCanonical.get(ep.canonicalId);
    if (!byModality) {
      byModality = new Map<MultimodalModality, ModelEndpointEntry[]>();
      byCanonical.set(ep.canonicalId, byModality);
    }
    const list = byModality.get(ep.modality) ?? [];
    list.push(ep);
    byModality.set(ep.modality, list);
  }

  const grouped = new Map<string, ModelEndpointEntry[]>();
  const sortGroup = (items: readonly ModelEndpointEntry[]) =>
    items.slice().sort((a, b) => {
      const qr = qualityRank(b.schemaQuality) - qualityRank(a.schemaQuality);
      if (qr !== 0) return qr;
      return b.parameters.length - a.parameters.length || a.id.localeCompare(b.id);
    });

  for (const [baseId, modalityMap] of [...byCanonical.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const buckets = [...modalityMap.entries()]
      .map(([modality, items]) => ({ modality, items: sortGroup(items) }))
      .sort((a, b) => {
        const qr = qualityRank(b.items[0].schemaQuality) - qualityRank(a.items[0].schemaQuality);
        if (qr !== 0) return qr;
        return b.items.length - a.items.length || a.modality.localeCompare(b.modality);
      });

    for (let i = 0; i < buckets.length; i++) {
      const { modality, items } = buckets[i];
      let recordKey = baseId;
      if (buckets.length > 1 && i > 0) {
        const suffix = `-${modality}`;
        recordKey = baseId.endsWith(suffix) ? baseId : `${baseId}${suffix}`;
      }
      const existing = grouped.get(recordKey);
      grouped.set(recordKey, existing ? sortGroup([...existing, ...items]) : items);
    }
  }

  const records: Record<string, CanonicalModelRecord> = {};
  for (const canonicalId of [...grouped.keys()].sort()) {
    const group = grouped.get(canonicalId)!;
    const best = group[0];

    const inputModalities = mergeStringUnions(...group.map(g => g.capabilities.inputModalities)) as IoModality[];
    const outputModalities = mergeStringUnions(...group.map(g => g.capabilities.outputModalities)) as IoModality[];
    const tasks = mergeStringUnions(...group.map(g => g.tasks)) as MultimodalTask[];
    const aspectRatios = mergeStringUnions(...group.map(g => g.capabilities.aspectRatios));
    const resolutions = mergeStringUnions(...group.map(g => g.capabilities.resolutions));
    const sizes = mergeStringUnions(...group.map(g => g.capabilities.sizes));
    const outputFormats = mergeStringUnions(...group.map(g => g.capabilities.outputFormats));
    const qualities = mergeStringUnions(...group.map(g => g.capabilities.qualities));
    const features = mergeStringUnions(...group.map(g => g.capabilities.features));
    const duration = mergeDuration(group.map(g => g.capabilities.duration));

    const maxRefImages = group.map(g => g.capabilities.maxReferenceImages).filter((n): n is number => n !== undefined);
    const maxRefVideos = group.map(g => g.capabilities.maxReferenceVideos).filter((n): n is number => n !== undefined);
    const maxRefAudios = group.map(g => g.capabilities.maxReferenceAudios).filter((n): n is number => n !== undefined);

    const standardParameters: Partial<Record<StandardParameterKey, ParameterFieldSchema>> = {};
    for (const ep of group) {
      for (const param of ep.parameters) {
        if (!param.standardKey) continue;
        const existing = standardParameters[param.standardKey];
        if (!existing) {
          standardParameters[param.standardKey] = { ...param };
        } else if (!existing.enum?.length && param.enum?.length) {
          standardParameters[param.standardKey] = { ...existing, enum: param.enum, ...(param.default !== undefined && existing.default === undefined ? { default: param.default } : {}) };
        }
      }
    }

    const cleanDisplayName = best.displayName
      .replace(/\s+(?:Text[- ]to[- ](?:Image|Video|Audio|Speech)|Image[- ]to[- ](?:Image|Video)|Reference[- ]to[- ]Video|Edit|Layerize)$/i, '')
      .trim() || best.displayName;

    records[canonicalId] = {
      id: canonicalId,
      family: best.family,
      creator: best.creator,
      displayName: cleanDisplayName,
      modality: best.modality,
      tasks,
      ...(best.description ? { description: best.description } : {}),
      capabilities: {
        inputModalities,
        outputModalities,
        tasks,
        ...(maxRefImages.length ? { maxReferenceImages: Math.max(...maxRefImages) } : {}),
        ...(maxRefVideos.length ? { maxReferenceVideos: Math.max(...maxRefVideos) } : {}),
        ...(maxRefAudios.length ? { maxReferenceAudios: Math.max(...maxRefAudios) } : {}),
        ...(group.some(g => g.capabilities.supportsImageInput) ? { supportsImageInput: true } : {}),
        ...(group.some(g => g.capabilities.supportsFirstLastFrame) ? { supportsFirstLastFrame: true } : {}),
        ...(group.some(g => g.capabilities.supportsMask) ? { supportsMask: true } : {}),
        ...(group.some(g => g.capabilities.supportsNativeAudio) ? { supportsNativeAudio: true } : {}),
        ...(group.every(g => g.capabilities.nativeAudioAlwaysOn) && group.length > 0 ? { nativeAudioAlwaysOn: true } : {}),
        ...(group.some(g => g.capabilities.supportsTransparentBackground) ? { supportsTransparentBackground: true } : {}),
        ...(group.some(g => g.capabilities.supportsLayerDecomposition) ? { supportsLayerDecomposition: true } : {}),
        ...(group.some(g => g.capabilities.supportsPromptExpansion) ? { supportsPromptExpansion: true } : {}),
        ...(group.some(g => g.capabilities.supportsSeed) ? { supportsSeed: true } : {}),
        ...(group.some(g => g.capabilities.supportsMultiPrompt) ? { supportsMultiPrompt: true } : {}),
        ...(group.some(g => g.capabilities.supportsCameraControl) ? { supportsCameraControl: true } : {}),
        ...(group.some(g => g.capabilities.supportsStreaming) ? { supportsStreaming: true } : {}),
        ...(aspectRatios?.length ? { aspectRatios } : {}),
        ...(resolutions?.length ? { resolutions } : {}),
        ...(sizes?.length ? { sizes } : {}),
        ...(outputFormats?.length ? { outputFormats } : {}),
        ...(qualities?.length ? { qualities } : {}),
        ...(duration ? { duration } : {}),
        ...(features?.length ? { features: features.sort() } : {}),
      },
      standardParameters,
      endpointIds: group.map(g => g.id),
      providers: [...new Set(group.map(g => g.provider))].sort(),
      sources: [...new Set(group.map(g => g.source))],
      ...(mergeStringUnions(...group.map(g => g.tags)) ? { tags: mergeStringUnions(...group.map(g => g.tags))!.slice(0, 16) } : {}),
      lastSyncedAt: group.map(g => g.syncedAt).sort().at(-1) ?? best.syncedAt,
    };
  }

  return records;
}

export function computeRegistryStats(
  endpoints: readonly ModelEndpointEntry[],
  canonicalModels: Record<string, CanonicalModelRecord>,
): RegistryStats {
  const byModality: Record<MultimodalModality, number> = {
    image: 0,
    video: 0,
    audio: 0,
    '3d': 0,
  };
  const byProvider: Record<string, number> = {};
  const byFamily: Record<string, number> = {};
  const bySchemaQuality: Record<ModelEndpointEntry['schemaQuality'], number> = {
    'openapi-live': 0,
    'verified-curated': 0,
    'catalog-metadata': 0,
  };

  for (const ep of endpoints) {
    byModality[ep.modality] = (byModality[ep.modality] ?? 0) + 1;
    byProvider[ep.provider] = (byProvider[ep.provider] ?? 0) + 1;
    byFamily[ep.family] = (byFamily[ep.family] ?? 0) + 1;
    bySchemaQuality[ep.schemaQuality] = (bySchemaQuality[ep.schemaQuality] ?? 0) + 1;
  }

  const sortedRecord = (rec: Record<string, number>) =>
    Object.fromEntries(Object.entries(rec).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

  return {
    totalEndpoints: endpoints.length,
    totalCanonicalModels: Object.keys(canonicalModels).length,
    withDetailedSchema: bySchemaQuality['openapi-live'] + bySchemaQuality['verified-curated'],
    byModality,
    byProvider: sortedRecord(byProvider),
    byFamily: sortedRecord(byFamily),
    bySchemaQuality,
  };
}

export function buildStandardParamMap(
  parameters: readonly ParameterFieldSchema[],
): Partial<Record<StandardParameterKey, string>> {
  const map: Partial<Record<StandardParameterKey, string>> = {};
  for (const param of parameters) {
    if (param.standardKey && !map[param.standardKey]) {
      map[param.standardKey] = param.key;
    }
  }
  return map;
}

export function choiceField(
  key: string,
  label: string,
  values: readonly (string | number | boolean)[],
  opts: {
    standardKey?: StandardParameterKey;
    default?: string | number | boolean;
    required?: boolean;
    allowCustom?: boolean;
    choices?: readonly ParameterChoiceOption[];
    description?: string;
    uiOrder?: number;
  } = {},
): ParameterFieldSchema {
  return {
    key,
    ...(opts.standardKey ? { standardKey: opts.standardKey } : {}),
    label,
    type: 'enum',
    required: Boolean(opts.required),
    ...(opts.default !== undefined ? { default: opts.default } : {}),
    enum: values,
    ...(opts.choices ? { choices: opts.choices } : {}),
    ...(opts.allowCustom ? { allowCustom: true } : {}),
    ...(opts.uiOrder !== undefined ? { uiOrder: opts.uiOrder } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };
}
