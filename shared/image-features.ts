import type { Model } from './gateway.ts';
import {
  buildCapabilityPrompt,
  capabilitySupportsModel,
  findCapability,
  relightCapabilityControls,
} from './capability-registry.ts';

/**
 * Image features projected from the Unified Capability Center (`shared/capability-registry.ts`).
 * GUI menus, Studio composer, and MCP meta-tools share one canonical definition.
 */
export type ImageFeatureId = 'remove-background' | 'relight' | 'character';
type ImageFeature = {
  models: readonly string[];
  recommended: string;
  maxReferences: number;
  parameters?: Record<string, unknown>;
  promptOptional: boolean;
};

function toImageFeature(id: ImageFeatureId): ImageFeature {
  const cap = findCapability(id)!;
  const exec = cap.executor;
  if (exec.kind !== 'prompt-preset') throw new Error(`Expected prompt-preset executor for ${id}`);
  return {
    models: exec.models,
    recommended: exec.recommendedModel,
    maxReferences: cap.input.maxReferences,
    ...(exec.defaultParameters ? { parameters: exec.defaultParameters } : {}),
    promptOptional: !cap.input.promptRequired,
  };
}

export const imageFeatures: Record<ImageFeatureId, ImageFeature> = {
  'remove-background': toImageFeature('remove-background'),
  relight: toImageFeature('relight'),
  character: toImageFeature('character'),
};

export const imageFeatureModel = (feature: ImageFeatureId, model: Model) =>
  capabilitySupportsModel(findCapability(feature)!, model);

export const relightControls = relightCapabilityControls as readonly {
  key: 'direction' | 'temperature' | 'mood';
  label: string;
  choices: typeof relightCapabilityControls[number]['choices'];
}[];

export type RelightChoices = Partial<Record<'direction' | 'temperature' | 'mood', string>>;

/** The prompt sent to the model: the capability's fixed instruction, then what the user wrote. */
export function imageFeaturePrompt(feature: ImageFeatureId, prompt: string, relight: RelightChoices = {}): string {
  return buildCapabilityPrompt(feature, prompt, relight);
}
