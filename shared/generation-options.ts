import type { Model } from './gateway.ts';

export type GenerationOption = {
  key: string; label: string; kind: 'choice' | 'number' | 'boolean' | 'text';
  choices?: { value: string | number; label: string; requires?: Record<string, string | number> }[];
  default?: string | number | boolean; min?: number; max?: number; step?: number;
  presentation?: 'ratio' | 'count'; required?: boolean;
};
export type GenerationOptions = { delivery: 'provider' | 'prompt'; fields: GenerationOption[] };
const choice = (key: string, label: string, values: (string | number)[], value?: string | number, presentation?: GenerationOption['presentation']): GenerationOption => ({ key, label, kind: 'choice', choices: values.map(value => ({ value, label: String(value) })), default: value, presentation });
const number = (key: string, label: string, value?: number, min?: number, max?: number, step = 1): GenerationOption => ({ key, label, kind: 'number', default: value, min, max, step });
const toggle = (key: string, label: string, value = false): GenerationOption => ({ key, label, kind: 'boolean', default: value });
const text = (key: string, label: string, required = false): GenerationOption => ({ key, label, kind: 'text', required });

/** Exact endpoint profiles, checked 2026-11-15. Sources: docs/generation-options.md.
 * An unknown catalogue model deliberately gets no guessed schema. */
export function generationOptions(model: Model): GenerationOptions | undefined {
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
  if (['opendesign', 'account'].includes(model.provider) && model.mode === 'text-to-speech') fields = [text('voice', 'Voice ID', true)];
  // The connector's `audio music --duration` takes whole seconds; music models publish no duration range.
  if (model.provider === 'account' && model.modality === 'audio' && model.mode === 'text-to-audio') fields = [number('duration', 'Duration (seconds)', undefined, 1)];
  return fields ? { delivery: 'provider', fields } : undefined;
}

/** Validate maintained fields; preserve the advanced provider-native escape hatch. */
export function validateGenerationOptions(model: Model, parameters: Record<string, unknown>) {
  for (const field of generationOptions(model)?.fields ?? []) {
    const value = parameters[field.key];
    if (value === undefined) { if (field.required) throw new Error(`${field.label} is required`); continue; }
    // fal also accepts custom dimensions; the quick picker is only a subset.
    if (field.key === 'image_size' && value && typeof value === 'object' && !Array.isArray(value)) {
      const { width, height } = value as Record<string, unknown>;
      if ([width, height].every(n => typeof n === 'number' && Number.isInteger(n) && n > 0)) continue;
    }
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
}
