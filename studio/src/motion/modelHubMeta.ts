export const MODEL_HUB_LATEST_MODELS = {
  'seedance-2-5': 'Seedance 2.5',
  'gpt-image-2-6': 'GPT Image 2.0',
  'gemini-4': 'Gemini 4 Neon',
} as const;

export type ModelHubId = keyof typeof MODEL_HUB_LATEST_MODELS;

export const MODEL_HUB_MATCHERS: Record<ModelHubId, { modelPattern: RegExp; preferredPattern?: RegExp }> = {
  'seedance-2-5': {
    modelPattern: /seedance[\s._/-]*v?2[.\s_-]5(?!\d|\.\d)/i,
    preferredPattern: /seedance[\s._/-]*v?2[.\s_-]5(?!\d|\.\d)(?!.*flash)/i,
  },
  'gpt-image-2-6': {
    modelPattern: /gpt[\s._/-]*image[\s._/-]*v?2(?:[.\s_-](?:0|6))?(?!\d|\.\d)/i,
    preferredPattern: /gpt[\s._/-]*image[\s._/-]*v?2(?:[.\s_-]0)?(?!\d|\.\d)/i,
  },
  'gemini-4': {
    modelPattern: /gemini-4/i,
  },
};

export function modelHubLatestModel(id: string | null | undefined): string | undefined {
  return id ? MODEL_HUB_LATEST_MODELS[id as ModelHubId] : undefined;
}

export function isModelHubId(id: string | null | undefined): id is ModelHubId {
  return Boolean(id && Object.hasOwn(MODEL_HUB_MATCHERS, id));
}

export function matchesModelHubText(hubId: ModelHubId, fields: readonly (string | undefined)[]): boolean {
  const { modelPattern } = MODEL_HUB_MATCHERS[hubId];
  return fields.some(field => Boolean(field && modelPattern.test(field)));
}

export function prefersModelHubText(hubId: ModelHubId, fields: readonly (string | undefined)[]): boolean {
  const { preferredPattern } = MODEL_HUB_MATCHERS[hubId];
  return Boolean(preferredPattern && fields.some(field => Boolean(field && preferredPattern.test(field))));
}

export function hubIdForModelSpec(spec: string | null | undefined): ModelHubId | undefined {
  if (!spec) return undefined;
  if (spec.startsWith('hub:')) {
    const candidate = spec.slice(4);
    return isModelHubId(candidate) ? candidate : undefined;
  }
  return (Object.keys(MODEL_HUB_MATCHERS) as ModelHubId[]).find(hubId => MODEL_HUB_MATCHERS[hubId].modelPattern.test(spec));
}
