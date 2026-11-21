import type { Model } from './gateway.ts';
import { buildCapabilityPrompt, findCapability } from './capability-registry.ts';

export type VideoFeatureId = 'camera-control' | 'multi-shot' | 'native-audio';

export type OpenDesignVideoEntry = {
  modelId: string;
  label: string;
  badge?: 'New' | 'Popular';
  tagline: string;
  durations: { min: number; max: number; default: number };
  resolutions: readonly string[];
  audioMode: 'toggle' | 'always-on';
};

/**
 * OpenDesign video models verified against core/amr main + live API (2026-11-20).
 * Order reflects menu priority: flagship first, newly added Flash right beside it, then Wan 2.7.
 */
export const openDesignVideoModels: readonly OpenDesignVideoEntry[] = [
  {
    modelId: 'doubao-seedance-2-5-260628',
    label: 'Seedance 2.5',
    badge: 'Popular',
    tagline: '4–30s cinematic video up to 1080p with native audio.',
    durations: { min: 4, max: 30, default: 5 },
    resolutions: ['480p', '720p', '1080p'],
    audioMode: 'toggle',
  },
  {
    modelId: 'doubao-seedance-2-5-flash-261115',
    label: 'Seedance 2.5 Flash',
    badge: 'New',
    tagline: 'Fast 4–30s generation at 480p/720p with native audio.',
    durations: { min: 4, max: 30, default: 5 },
    resolutions: ['480p', '720p'],
    audioMode: 'toggle',
  },
  {
    modelId: 'wan-2.7',
    label: 'Wan 2.7',
    badge: 'Popular',
    tagline: '2–15s 720p/1080p video with built-in synchronized audio.',
    durations: { min: 2, max: 15, default: 5 },
    resolutions: ['720p', '1080p'],
    audioMode: 'always-on',
  },
];

const openDesignVideoById = new Map(openDesignVideoModels.map(entry => [entry.modelId, entry]));

export function isOpenDesignProvider(providerId: string) {
  return providerId === 'account' || providerId === 'opendesign';
}

export function videoModelLabel(model: Pick<Model, 'modelId' | 'label'>) {
  return openDesignVideoById.get(model.modelId)?.label ?? model.label;
}

export function videoModelBadge(model: Pick<Model, 'modelId'>) {
  return openDesignVideoById.get(model.modelId)?.badge;
}

export type VideoFeatureChoice = { value: string; label: string; prompt: string };
export type VideoFeatureControl = {
  key: string;
  label: string;
  choices: readonly [VideoFeatureChoice, ...VideoFeatureChoice[]];
};

export type VideoFeatureSpec = {
  id: VideoFeatureId;
  recommended: string;
  defaultDuration?: number;
  forceAudio?: boolean;
  controls: readonly VideoFeatureControl[];
};

function toVideoFeature(id: VideoFeatureId): VideoFeatureSpec {
  const cap = findCapability(id)!;
  const exec = cap.executor;
  if (exec.kind !== 'prompt-preset') throw new Error(`Expected prompt-preset executor for ${id}`);
  return {
    id,
    recommended: exec.recommendedModel,
    ...(exec.defaultDuration !== undefined ? { defaultDuration: exec.defaultDuration } : {}),
    ...(exec.forceAudio ? { forceAudio: true } : {}),
    controls: (cap.input.controls ?? []) as readonly VideoFeatureControl[],
  };
}

export const videoFeatures: Record<VideoFeatureId, VideoFeatureSpec> = {
  'camera-control': toVideoFeature('camera-control'),
  'multi-shot': toVideoFeature('multi-shot'),
  'native-audio': toVideoFeature('native-audio'),
};

export type VideoFeatureChoices = Record<string, string>;

export function defaultVideoFeatureChoices(feature: VideoFeatureId): VideoFeatureChoices {
  return Object.fromEntries(videoFeatures[feature].controls.map(control => [control.key, control.choices[0].value]));
}

export function videoFeaturePrompt(feature: VideoFeatureId, prompt: string, choices: VideoFeatureChoices = {}): string {
  return buildCapabilityPrompt(feature, prompt, choices);
}

export function videoFeatureParameters(feature: VideoFeatureId, model: Pick<Model, 'provider' | 'modelId'>): Record<string, unknown> {
  if (!isOpenDesignProvider(model.provider)) return {};
  const meta = openDesignVideoById.get(model.modelId);
  if (!meta) return {};
  const spec = videoFeatures[feature];
  const params: Record<string, unknown> = {};
  if (spec.defaultDuration !== undefined && spec.defaultDuration >= meta.durations.min && spec.defaultDuration <= meta.durations.max) {
    params.duration = spec.defaultDuration;
  }
  if (spec.forceAudio && meta.audioMode === 'toggle') {
    params.generate_audio = true;
  }
  return params;
}
