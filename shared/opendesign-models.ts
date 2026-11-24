import type { Modality, Model } from './gateway.ts';

export const modelRoutingTiers = ['flagship', 'balanced', 'fast'] as const;
export type ModelRoutingTier = typeof modelRoutingTiers[number];

export type OpenDesignModelProfile = {
  modelId: string;
  label: string;
  modality: Modality;
  mode: string;
  tier: ModelRoutingTier;
  bestFor: readonly string[];
  description: string;
};

/**
 * Models served by an OpenDesign API key, in menu order, together with fallback routing metadata
 * (`tier`, `bestFor`, `description`) hydrated during discovery whenever the live AMR `/api/v1/media/models`
 * payload omits those fields. Server-published fields always take precedence once AMR exposes them.
 */
export const openDesignModels: readonly OpenDesignModelProfile[] = [
  {
    modelId: 'gpt-image-2.6-flare',
    label: 'GPT Image 2.6 Flare',
    modality: 'image',
    mode: 'text-to-image',
    tier: 'fast',
    bestFor: ['batch-sprites', 'transparent-cutout', 'multi-ref-edit', 'ui-icons'],
    description: 'Fast image generation and multi-reference editing with native transparent background support; ideal for sprite, prop, and icon batches.',
  },
  {
    modelId: 'gpt-image-2.6-sunburst',
    label: 'GPT Image 2.6 Sunburst',
    modality: 'image',
    mode: 'text-to-image',
    tier: 'flagship',
    bestFor: ['hero-art', 'character-portraits', 'transparent-cutout', 'multi-ref-edit', 'text-rendering'],
    description: 'Flagship image generation and multi-reference editing with crisp instruction following, legible text, and native transparent background.',
  },
  {
    modelId: 'seedream-5.5',
    label: 'Seedream 5.5',
    modality: 'image',
    mode: 'text-to-image',
    tier: 'flagship',
    bestFor: ['hero-art', 'painterly-scenes', 'photoreal', 'backgrounds'],
    description: 'Flagship painterly and photoreal image generation for hero key art and backgrounds (up to 1 reference image on edits; opaque output).',
  },
  {
    modelId: 'seedream-5.0-flash',
    label: 'Seedream 5.0 Flash',
    modality: 'image',
    mode: 'text-to-image',
    tier: 'fast',
    bestFor: ['batch-tiles', 'backgrounds', 'card-art', 'multi-ref-edit'],
    description: 'Fast opaque image generation and multi-reference editing for backgrounds, tiles, card art, and rapid visual batches.',
  },
  {
    modelId: 'doubao-seedance-2-5-260628',
    label: 'Seedance 2.5',
    modality: 'video',
    mode: 'text-to-video',
    tier: 'flagship',
    bestFor: ['long-video', 'cinematic-shots', 'multi-shot', 'native-audio', 'first-frame-i2v'],
    description: 'Flagship video model supporting longer clips (up to 30s), native audio, 21:9/480p options, and first-frame image-to-video.',
  },
  {
    modelId: 'doubao-seedance-2-5-flash-261115',
    label: 'Seedance 2.5 Flash',
    modality: 'video',
    mode: 'text-to-video',
    tier: 'fast',
    bestFor: ['fast-video', 'short-i2v', 'draft-clips'],
    description: 'Faster video generation tier for quick short clips and rapid visual drafts.',
  },
  {
    modelId: 'wan-2.7',
    label: 'Wan 2.7',
    modality: 'video',
    mode: 'text-to-video',
    tier: 'balanced',
    bestFor: ['short-i2v', 'sprite-animation', 'fast-video'],
    description: 'Fast, reliable short video and first-frame image-to-video model (2–15s); strong default for short loops and 2D sprite animation references.',
  },
  {
    modelId: 'elevenlabs-v3',
    label: 'Eleven v3',
    modality: 'audio',
    mode: 'text-to-speech',
    tier: 'flagship',
    bestFor: ['multilingual-speech', 'en-speech', 'character-voice', 'narration'],
    description: 'Expressive English and multilingual text-to-speech for character dialogue, announcers, and narration.',
  },
  {
    modelId: 'byteplus-tts-2',
    label: 'BytePlus TTS 2.0',
    modality: 'audio',
    mode: 'text-to-speech',
    tier: 'flagship',
    bestFor: ['zh-speech', 'character-voice', 'narration'],
    description: 'Natural Chinese (Mandarin) text-to-speech for dialogue and narration (uses 2.0 uranus voices).',
  },
  // The Cloud catalogue does not list its music model yet, so discovery would otherwise show no music.
  {
    modelId: 'elevenlabs-music-v2',
    label: 'Eleven Music v2',
    modality: 'audio',
    mode: 'text-to-audio',
    tier: 'flagship',
    bestFor: ['bgm-loop', 'soundtrack', 'ambience'],
    description: 'Instrumental background music, loops, and ambience beds (prompt instrumental, no vocals).',
  },
];

const openDesignProfileById = new Map<string, OpenDesignModelProfile>(
  openDesignModels.map(profile => [profile.modelId, profile]),
);

export const openDesignModelLabel = (modelId: string) => openDesignProfileById.get(modelId)?.label;
export const openDesignModelProfile = (modelId: string) => openDesignProfileById.get(modelId);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function sanitizeTier(value: unknown): ModelRoutingTier | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (modelRoutingTiers as readonly string[]).includes(normalized)
    ? normalized as ModelRoutingTier
    : undefined;
}

function sanitizeBestFor(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
    if (tags.length >= 12) break;
  }
  return tags;
}

function sanitizeDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\s+/g, ' ').trim().slice(0, 400);
}

/**
 * Extract optional server-published routing metadata (`tier`, `bestFor`, `description`) from a live
 * OpenDesign Cloud or account catalogue row (either top-level or nested under `capabilities`).
 * Explicit empty values (`best_for: []`, `description: ""`) are preserved as authoritative so
 * server-side clearing is never overwritten by local fallback profiles.
 */
export function parseServerModelRoutingMetadata(row: unknown): {
  description?: string;
  tier?: ModelRoutingTier;
  bestFor?: string[];
} {
  if (!isRecord(row)) return {};
  const caps = isRecord(row.capabilities) ? row.capabilities : undefined;
  const tier = sanitizeTier(row.tier) ?? sanitizeTier(caps?.tier);
  const bestFor =
    sanitizeBestFor(row.bestFor)
    ?? sanitizeBestFor(row.best_for)
    ?? sanitizeBestFor(caps?.bestFor)
    ?? sanitizeBestFor(caps?.best_for);
  const description = sanitizeDescription(row.description) ?? sanitizeDescription(caps?.description);
  return {
    ...(description !== undefined ? { description } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(bestFor !== undefined ? { bestFor } : {}),
  };
}

/**
 * Hydrate fallback routing metadata onto OpenDesign (`opendesign` / `account`) models without
 * overwriting live server-published fields, and without fabricating traits for unknown new models.
 */
export function hydrateOpenDesignModelMetadata<
  T extends Pick<Model, 'provider' | 'modelId' | 'description' | 'tier' | 'bestFor'>,
>(model: T): T {
  if (model.provider !== 'opendesign' && model.provider !== 'account') return model;
  const profile = openDesignProfileById.get(model.modelId);
  if (!profile) return model;
  const description = sanitizeDescription(model.description) ?? profile.description;
  const tier = sanitizeTier(model.tier) ?? profile.tier;
  const bestFor = sanitizeBestFor(model.bestFor) ?? [...profile.bestFor];
  return { ...model, description, tier, bestFor };
}

/** Most reference images each OpenDesign image model accepts on /images/edits, measured 2026-11-20
 * ("OpenDesign API image model capabilities, tested"). Seedream 5.5 rejects two or more with HTTP 400. */
const openDesignImageReferenceCaps: Record<string, number> = {
  'gpt-image-2.6-sunburst': 16, 'gpt-image-2.6-flare': 16, 'seedream-5.0-flash': 10, 'seedream-5.5': 1,
};
export const openDesignImageReferenceCap = (modelId: string) => Object.hasOwn(openDesignImageReferenceCaps, modelId) ? openDesignImageReferenceCaps[modelId] : undefined;
