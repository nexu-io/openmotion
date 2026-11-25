export const MODEL_HUB_LATEST_MODELS = {
  'seedance-2-5': 'Seedance 2.5',
  'gpt-image-2-6': 'GPT Image 2.0',
  'gemini-4': 'Gemini 4 Neon',
} as const;

export function modelHubLatestModel(id: string | null | undefined): string | undefined {
  return id ? MODEL_HUB_LATEST_MODELS[id as keyof typeof MODEL_HUB_LATEST_MODELS] : undefined;
}
