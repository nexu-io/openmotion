import type { Model } from './gateway.ts';

export type GenerationOption = {
  key: string; label: string; kind: 'choice' | 'number' | 'boolean' | 'text';
  choices?: { value: string | number; label: string; requires?: Record<string, string | number> }[];
  default?: string | number | boolean; min?: number; max?: number; step?: number;
  presentation?: 'ratio' | 'count'; required?: boolean;
  /** The choices are suggestions: any other non-empty string is also accepted. */
  allowCustom?: boolean;
};
export type GenerationOptions = { delivery: 'provider' | 'prompt'; fields: GenerationOption[] };
const choice = (key: string, label: string, values: (string | number)[], value?: string | number, presentation?: GenerationOption['presentation']): GenerationOption => ({ key, label, kind: 'choice', choices: values.map(value => ({ value, label: String(value) })), default: value, presentation });
const number = (key: string, label: string, value?: number, min?: number, max?: number, step = 1): GenerationOption => ({ key, label, kind: 'number', default: value, min, max, step });
const toggle = (key: string, label: string, value = false): GenerationOption => ({ key, label, kind: 'boolean', default: value });
const text = (key: string, label: string, required = false): GenerationOption => ({ key, label, kind: 'text', required });

/** OpenDesign speech voices that produced audio through the media API on 2026-11-16; the first is the default.
 * Other voice IDs pass through unchecked: the media API publishes no voice list. Seed TTS 2.0 accepts only its
 * 2.0 (`*_uranus_bigtts`) speakers; 1.0 speakers fail upstream with a resource mismatch. */
const cloudSpeechVoices: Record<string, { value: string; label: string }[]> = {
  'byteplus-tts-2': [{ value: 'zh_female_vv_uranus_bigtts', label: 'Vivi · Chinese female' }],
  'elevenlabs-v3': [
    ['21m00Tcm4TlvDq8ikWAM', 'Rachel · Female'], ['JBFqnCBsd6RMkjVDRZzb', 'George · Male'], ['EXAVITQu4vr4xnSDxMaL', 'Sarah · Female'],
    ['pNInz6obpgDQGcFmaJgB', 'Adam · Male'], ['nPczCjzI2devNBz1zQrb', 'Brian · Male'], ['pFZP5JQG7iQjIQuC4Bku', 'Lily · Female'],
  ].map(([value, label]) => ({ value, label })),
};
const cloudSpeech = (model: Model) => ['opendesign', 'account'].includes(model.provider) && model.mode === 'text-to-speech';
// Own keys only: a model ID such as `constructor` must not resolve to an Object prototype member.
const checkedVoices = (model: Model) => Object.hasOwn(cloudSpeechVoices, model.modelId) ? cloudSpeechVoices[model.modelId] : undefined;
/** Parameters a request starts from: the model's saved defaults, and for OpenDesign speech its first checked voice.
 * The voice stays out of `model.defaults`, so Settings never shows or saves it as a user override. */
export function modelDefaults(model: Model): Record<string, unknown> {
  const voice = cloudSpeech(model) ? checkedVoices(model)?.[0].value : undefined;
  return voice ? { voice, ...model.defaults } : { ...model.defaults };
}

/** These Cloud models derive first-frame video geometry from the input image. */
export function usesInputImageRatio(model: Model, hasInputImage: boolean, parameters: Record<string, unknown> = {}): boolean {
  const images = { ...model.defaults, ...parameters }.images;
  const firstFrame = Array.isArray(images) && images.some(image => image && typeof image === 'object' && image.role === 'first_frame');
  return (hasInputImage || firstFrame) && model.modality === 'video' && ['opendesign', 'account'].includes(model.provider)
    && ['wan-2.7', 'doubao-seedance-2-5-260628'].includes(model.modelId);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isOpenDesignMedia = (model: Model) => ['opendesign', 'account'].includes(model.provider);

function publishedStrings(raw: unknown): { values: string[]; default?: string } | undefined {
  const envelope = isRecord(raw) ? raw : undefined;
  const rawValues = Array.isArray(raw) ? raw : Array.isArray(envelope?.values) ? envelope.values : undefined;
  if (!rawValues) return undefined;
  const values = [...new Set(rawValues.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
  if (!values.length) return undefined;
  const fallback = typeof envelope?.default === 'string' && values.includes(envelope.default) ? envelope.default : undefined;
  return { values, ...(fallback !== undefined ? { default: fallback } : {}) };
}

function publishedDurations(raw: unknown): { values: number[]; default?: number } | undefined {
  const envelope = isRecord(raw) ? raw : undefined;
  const rawValues = Array.isArray(raw) ? raw : Array.isArray(envelope?.values) ? envelope.values : undefined;
  if (!rawValues) return undefined;
  const values = [...new Set(rawValues.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0))];
  if (!values.length) return undefined;
  const fallback = typeof envelope?.default === 'number' && values.includes(envelope.default) ? envelope.default : undefined;
  return { values, ...(fallback !== undefined ? { default: fallback } : {}) };
}

type PublishedImageProfile = { aspect_ratio: string; resolution: string };
type PublishedImageProfiles = { profiles: PublishedImageProfile[]; default?: PublishedImageProfile };

function parseProfileEnvelope(raw: unknown): PublishedImageProfiles | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) return undefined;
  const seen = new Set<string>(), profiles: PublishedImageProfile[] = [];
  for (const item of raw.profiles) {
    if (!isRecord(item) || typeof item.aspect_ratio !== 'string' || !item.aspect_ratio.trim() || typeof item.resolution !== 'string' || !item.resolution.trim()) continue;
    const key = `${item.aspect_ratio}\0${item.resolution}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push({ aspect_ratio: item.aspect_ratio, resolution: item.resolution });
  }
  if (!profiles.length) return undefined;
  const rawDefault = isRecord(raw.default) ? raw.default : undefined;
  const def = rawDefault && typeof rawDefault.aspect_ratio === 'string' && typeof rawDefault.resolution === 'string'
    ? profiles.find(p => p.aspect_ratio === rawDefault.aspect_ratio && p.resolution === rawDefault.resolution)
    : undefined;
  return { profiles, ...(def ? { default: def } : {}) };
}

function publishedImageProfiles(model: Model, isEdit = false): PublishedImageProfiles | undefined {
  if (!isOpenDesignMedia(model) || model.modality !== 'image' || !isRecord(model.nativeOptions?.profiles)) return undefined;
  const profiles = model.nativeOptions.profiles;
  const primary = isEdit ? parseProfileEnvelope(profiles.edits) : parseProfileEnvelope(profiles.generations);
  return primary ?? parseProfileEnvelope(profiles.generations) ?? parseProfileEnvelope(profiles.edits);
}

/** Published resolutions valid for a chosen image aspect ratio, when the catalogue publishes profile pairs. */
export function compatibleImageResolutions(model: Model, aspectRatio: unknown, hasInputImage = false): string[] | undefined {
  const envelope = publishedImageProfiles(model, hasInputImage);
  if (!envelope || typeof aspectRatio !== 'string' || !aspectRatio.trim()) return undefined;
  return [...new Set(envelope.profiles.filter(p => p.aspect_ratio === aspectRatio).map(p => p.resolution))];
}

/** Resolve defaults without carrying a text-to-video ratio into a first-frame request,
 * and complete published OpenDesign image (aspect_ratio, resolution) output profile pairs. */
export function resolveGenerationParameters(model: Model, parameters: Record<string, unknown>, hasInputImage = false): Record<string, unknown> {
  const resolved = { ...modelDefaults(model), ...parameters };
  if (usesInputImageRatio(model, hasInputImage, parameters)) {
    // An explicit fixed ratio is a conflicting instruction, not a default to silently replace.
    if (parameters.ratio !== undefined && parameters.ratio !== 'adaptive') throw new Error('First-frame video follows the input image ratio. Remove parameters.ratio or set it to "adaptive".');
    if (resolved.ratio !== 'adaptive') delete resolved.ratio;
  }
  const isEdit = hasInputImage || (Array.isArray(resolved.images) && resolved.images.length > 0);
  const imageProfiles = publishedImageProfiles(model, isEdit);
  if (imageProfiles && (resolved.aspect_ratio !== undefined || resolved.resolution !== undefined)) {
    if (resolved.size !== undefined) throw new Error('Cannot combine size with aspect_ratio or resolution.');
    if (resolved.output !== undefined) throw new Error('Cannot combine output with aspect_ratio or resolution.');
    if (resolved.aspect_ratio !== undefined) {
      const validRatio = typeof resolved.aspect_ratio === 'string' && imageProfiles.profiles.some(p => p.aspect_ratio === resolved.aspect_ratio);
      if (!validRatio) {
        if (parameters.aspect_ratio !== undefined) throw new Error(`Aspect ratio ${String(resolved.aspect_ratio)} is not available for this model.`);
        delete resolved.aspect_ratio;
      }
    }
    if (resolved.resolution !== undefined) {
      const validRes = typeof resolved.resolution === 'string' && imageProfiles.profiles.some(p => p.resolution === resolved.resolution);
      if (!validRes) {
        if (parameters.resolution !== undefined) throw new Error(`Resolution ${String(resolved.resolution)} is not available for this model.`);
        delete resolved.resolution;
      }
    }
    const hasRatio = resolved.aspect_ratio !== undefined, hasResolution = resolved.resolution !== undefined;
    if (hasRatio && hasResolution) {
      if (!imageProfiles.profiles.some(p => p.aspect_ratio === resolved.aspect_ratio && p.resolution === resolved.resolution)) {
        if (parameters.aspect_ratio !== undefined || parameters.resolution !== undefined) {
          throw new Error(`Resolution ${String(resolved.resolution)} is not available for aspect ratio ${String(resolved.aspect_ratio)}.`);
        }
        delete resolved.aspect_ratio;
        delete resolved.resolution;
      }
    } else if (hasRatio) {
      const matching = imageProfiles.profiles.filter(p => p.aspect_ratio === resolved.aspect_ratio);
      const preferred = matching.find(p => p.resolution === imageProfiles.default?.resolution) ?? matching[0];
      if (preferred) resolved.resolution = preferred.resolution;
    } else if (hasResolution) {
      const matching = imageProfiles.profiles.filter(p => p.resolution === resolved.resolution);
      const preferred = matching.find(p => p.aspect_ratio === imageProfiles.default?.aspect_ratio) ?? matching[0];
      if (preferred) resolved.aspect_ratio = preferred.aspect_ratio;
    }
  }
  return resolved;
}

/** Exact endpoint profiles, checked 2026-11-15. Sources: docs/generation-options.md.
 * An unknown catalogue model deliberately gets no guessed schema. */
export function generationOptions(model: Model, hasInputImage = false): GenerationOptions | undefined {
  const endpoint = `${model.provider}:${model.modelId}`;
  if (endpoint === 'codex:image-generation' && model.modality === 'image') return { delivery: 'prompt', fields: [
    choice('aspect_ratio', 'Aspect ratio', ['1:1', '4:3', '3:4', '16:9', '9:16'], undefined, 'ratio'),
    choice('background', 'Background', ['opaque', 'transparent']),
  ] };
  let fields: GenerationOption[] | undefined;
  if (endpoint === 'atlascloud:google/nano-banana-2/text-to-image' && model.modality === 'image') fields = [
    choice('aspect_ratio', 'Aspect ratio', ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'], undefined, 'ratio'),
    choice('resolution', 'Resolution', ['1k', '2k', '4k']), choice('output_format', 'Output format', ['default', 'png', 'jpeg']),
    choice('thinking_level', 'Thinking level', ['default', 'minimal', 'high']), toggle('enable_web_search', 'Web search'), number('seed', 'Seed', -1),
  ];
  if (endpoint === 'atlascloud:bytedance/seedance-2.0/text-to-video' && model.modality === 'video') fields = [
    choice('ratio', 'Aspect ratio', ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], undefined, 'ratio'),
    { ...choice('resolution', 'Resolution', []), choices: ['480p', '720p', '720p-SR', '1080p', '1080p-SR', '1440p-SR', '4k'].map(value => ({ value, label: value, ...(value === '4k' ? { requires: { ratio: '16:9' } } : {}) })) },
    choice('duration', 'Duration (seconds)', [-1, ...Array.from({ length: 12 }, (_, i) => i + 4)], 5),
    toggle('generate_audio', 'Generate audio', true), choice('bitrate_mode', 'Bitrate', ['standard', 'high']), number('seed', 'Seed'),
  ];
  if (endpoint === 'atlascloud:suno/chirp-v4' && model.modality === 'audio') fields = [toggle('instrumental', 'Instrumental only'), choice('vocal_gender', 'Vocal gender', ['Male', 'Female'])];
  if (endpoint === 'fal:fal-ai/flux/schnell' && model.modality === 'image') fields = [
    { ...choice('image_size', 'Image size', [], 'landscape_4_3', 'ratio'), choices: [
      ['square_hd', '1:1 HD'], ['square', '1:1'], ['portrait_4_3', '3:4'], ['portrait_16_9', '9:16'], ['landscape_4_3', '4:3'], ['landscape_16_9', '16:9'],
    ].map(([value, label]) => ({ value, label })) },
    { ...number('num_images', 'Output count', 1, 1), presentation: 'count' }, choice('output_format', 'Output format', ['jpeg', 'png'], 'jpeg'), number('seed', 'Seed'),
  ];
  if (endpoint === 'fal:fal-ai/wan/v2.2-a14b/text-to-video' && model.modality === 'video') fields = [
    choice('aspect_ratio', 'Aspect ratio', ['16:9', '9:16', '1:1'], '16:9', 'ratio'), choice('resolution', 'Resolution', ['480p', '580p', '720p'], '720p'),
    number('num_frames', 'Frames', 81, 17, 161), number('frames_per_second', 'Frames per second', 16, 4, 60),
    toggle('enable_prompt_expansion', 'Expand prompt'), text('negative_prompt', 'Negative prompt'), number('seed', 'Seed'),
  ];
  if (endpoint === 'fal:fal-ai/kokoro/american-english' && model.modality === 'audio') fields = [
    choice('voice', 'Speech voice', ['af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa'], 'af_heart'),
    number('speed', 'Speech speed', 1, undefined, undefined, 0.1),
  ];
  // Cloud and account image models publish output profile pairs (`profiles`), legacy `sizes`, and optional `quality`.
  if (isOpenDesignMedia(model) && model.modality === 'image') {
    const imageFields: GenerationOption[] = [];
    const profiles = publishedImageProfiles(model, hasInputImage);
    if (profiles) {
      const ratios = [...new Set(profiles.profiles.map(p => p.aspect_ratio))];
      const resolutions = [...new Set(profiles.profiles.map(p => p.resolution))];
      if (ratios.length) imageFields.push(choice('aspect_ratio', 'Aspect ratio', ratios, profiles.default?.aspect_ratio, 'ratio'));
      if (resolutions.length) imageFields.push(choice('resolution', 'Resolution', resolutions, profiles.default?.resolution));
    } else {
      const sizes = publishedStrings(model.nativeOptions?.sizes);
      if (sizes) imageFields.push(choice('size', 'Image size', sizes.values, sizes.default));
    }
    const quality = publishedStrings(model.nativeOptions?.quality);
    if (quality) imageFields.push(choice('quality', 'Quality', quality.values, quality.default));
    if (imageFields.length) fields = imageFields;
  }
  // Cloud and account video models publish allowed ratios, resolutions and integer durations via `capabilities`.
  if (isOpenDesignMedia(model) && model.modality === 'video') {
    const videoFields: GenerationOption[] = [];
    const ratios = publishedStrings(model.nativeOptions?.ratios);
    if (ratios) videoFields.push(choice('ratio', 'Aspect ratio', ratios.values, ratios.default, 'ratio'));
    const resolutions = publishedStrings(model.nativeOptions?.resolutions);
    if (resolutions) videoFields.push(choice('resolution', 'Resolution', resolutions.values, resolutions.default));
    const durations = publishedDurations(model.nativeOptions?.durations);
    if (durations) videoFields.push(choice('duration', 'Duration (seconds)', durations.values, durations.default));
    if (videoFields.length) fields = videoFields;
  }
  // Speech models without checked voices keep a free voice ID: the API publishes no voice list.
  if (cloudSpeech(model)) { const voices = checkedVoices(model); fields = [voices ? { key: 'voice', label: 'Speech voice', kind: 'choice', choices: voices, default: voices[0].value, allowCustom: true } : text('voice', 'Voice ID', true)]; }
  // The connector's `audio music --duration` takes whole seconds; music models publish no duration range.
  if (model.provider === 'account' && model.modality === 'audio' && model.mode === 'text-to-audio') fields = [number('duration', 'Duration (seconds)', undefined, 1)];
  return fields ? { delivery: 'provider', fields } : undefined;
}

/** Validate maintained fields; preserve the advanced provider-native escape hatch. */
export function validateGenerationOptions(model: Model, parameters: Record<string, unknown>, hasInputImage = false) {
  const isEdit = hasInputImage || (Array.isArray(parameters.images) && parameters.images.length > 0);
  for (const field of generationOptions(model, isEdit)?.fields ?? []) {
    const value = parameters[field.key];
    if (value === undefined) { if (field.required) throw new Error(`${field.label} is required`); continue; }
    // fal also accepts custom dimensions; the quick picker is only a subset.
    if (field.key === 'image_size' && value && typeof value === 'object' && !Array.isArray(value)) {
      const { width, height } = value as Record<string, unknown>;
      if ([width, height].every(n => typeof n === 'number' && Number.isInteger(n) && n > 0)) continue;
    }
    if (field.allowCustom && typeof value === 'string' && value.trim() && !field.choices?.some(c => c.value === value)) continue;
    const valid = field.kind === 'choice' ? field.choices?.some(c => c.value === value)
      : field.kind === 'boolean' ? typeof value === 'boolean'
      : field.kind === 'text' ? typeof value === 'string' && (!field.required || !!value.trim())
      : typeof value === 'number' && Number.isFinite(value) && (field.step !== 1 || Number.isInteger(value)) && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
    if (!valid) throw new Error(`Invalid ${field.label}: ${field.key}`);
    const requires = field.choices?.find(c => c.value === value)?.requires;
    if (requires) for (const [key, required] of Object.entries(requires)) {
      if (parameters[key] !== required) throw new Error(`${field.label} ${value} requires ${key} ${required}`);
    }
  }
  const imageProfiles = publishedImageProfiles(model, isEdit);
  if (imageProfiles && typeof parameters.aspect_ratio === 'string' && typeof parameters.resolution === 'string') {
    if (!imageProfiles.profiles.some(p => p.aspect_ratio === parameters.aspect_ratio && p.resolution === parameters.resolution)) {
      throw new Error(`Resolution ${parameters.resolution} is not available for aspect ratio ${parameters.aspect_ratio}.`);
    }
  }
}
