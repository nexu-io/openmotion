import type { Model } from './gateway.ts';

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

export const videoFeatures: Record<VideoFeatureId, VideoFeatureSpec> = {
  'camera-control': {
    id: 'camera-control',
    recommended: 'doubao-seedance-2-5-260628',
    controls: [
      {
        key: 'movement',
        label: 'Camera movement',
        choices: [
          { value: 'push-in', label: 'Push in', prompt: 'slow steady dolly push-in toward the subject' },
          { value: 'pull-out', label: 'Pull out', prompt: 'smooth pull-back reveal widening to show the full scene' },
          { value: 'orbit', label: 'Orbit', prompt: 'continuous smooth 360-degree camera orbit around the subject' },
          { value: 'pan', label: 'Pan', prompt: 'fluid horizontal camera pan across the scene' },
          { value: 'crane-up', label: 'Crane up', prompt: 'sweeping crane shot rising upward' },
          { value: 'drone', label: 'Aerial drone', prompt: 'cinematic aerial drone tracking shot' },
          { value: 'static', label: 'Locked tripod', prompt: 'locked tripod static camera with all motion inside the frame' },
        ],
      },
      {
        key: 'pace',
        label: 'Motion pace',
        choices: [
          { value: 'slow', label: 'Slow cinematic', prompt: 'slow, deliberate cinematic pacing' },
          { value: 'smooth', label: 'Steady smooth', prompt: 'steady, balanced natural motion' },
          { value: 'dynamic', label: 'Dynamic', prompt: 'energetic, dynamic camera momentum' },
        ],
      },
    ],
  },
  'multi-shot': {
    id: 'multi-shot',
    recommended: 'doubao-seedance-2-5-260628',
    defaultDuration: 10,
    controls: [
      {
        key: 'shots',
        label: 'Shot count',
        choices: [
          { value: '2', label: '2 shots', prompt: 'a cohesive 2-shot sequence' },
          { value: '3', label: '3 shots', prompt: 'a cohesive 3-shot narrative sequence' },
          { value: '4', label: '4 shots', prompt: 'a cohesive 4-shot storyboard sequence' },
        ],
      },
      {
        key: 'style',
        label: 'Shot progression',
        choices: [
          { value: 'narrative', label: 'Wide → Medium → Close-up', prompt: 'progressing from an establishing wide shot to medium action and an intimate close-up' },
          { value: 'cut', label: 'Clean editorial cuts', prompt: 'connected by crisp editorial cuts keeping subject, wardrobe, and lighting consistent across shots' },
          { value: 'match', label: 'Match-cut flow', prompt: 'linked by seamless visual match cuts with unified color grading and atmosphere' },
        ],
      },
    ],
  },
  'native-audio': {
    id: 'native-audio',
    recommended: 'doubao-seedance-2-5-260628',
    forceAudio: true,
    controls: [
      {
        key: 'audioStyle',
        label: 'Sound direction',
        choices: [
          { value: 'ambience', label: 'Natural ambience', prompt: 'rich synchronized natural environmental ambience and realistic foley sound effects' },
          { value: 'dialogue', label: 'Dialogue & voices', prompt: 'clear, natural synchronized spoken dialogue matching the character and scene acoustics' },
          { value: 'cinematic', label: 'Cinematic score', prompt: 'immersive cinematic sound design, impactful foley, and subtle atmospheric score' },
        ],
      },
    ],
  },
};

export type VideoFeatureChoices = Record<string, string>;

export function defaultVideoFeatureChoices(feature: VideoFeatureId): VideoFeatureChoices {
  return Object.fromEntries(videoFeatures[feature].controls.map(control => [control.key, control.choices[0].value]));
}

export function videoFeaturePrompt(feature: VideoFeatureId, prompt: string, choices: VideoFeatureChoices = {}): string {
  const userText = prompt.trim();
  if (!userText) return '';
  const spec = videoFeatures[feature];
  const parts = spec.controls.map(control => {
    const selected = control.choices.find(choice => choice.value === choices[control.key]) ?? control.choices[0];
    return selected.prompt;
  });
  if (feature === 'camera-control') {
    return `Camera direction: ${parts.join(', ')}. Scene: ${userText}`;
  }
  if (feature === 'multi-shot') {
    return `Multi-shot direction: ${parts.join(', ')}. Story: ${userText}`;
  }
  return `Audio direction: ${parts.join(', ')}. Scene: ${userText}`;
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
