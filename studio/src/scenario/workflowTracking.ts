// Workflows report each Generate attempt with the shared `asset_generation_submit_result`, as page_name=creative_studio,
// studio_id=workflows and scene_id=<workflow id> like their page view, so they join the Design/Cinema/Sound generation dashboards.
// Prompts, parameters and asset ids never leave the browser; only the modality, the model id, the reference count and fixed categories do.
import { reportAssetGenerationSubmit } from '../motion/pageTracking';
import { ScenarioApiError } from './scenarioClient';

/** Which Generate control started the request, from the mutation intent each control uses (`generate:`, `quick-gen:`, `retry:`). */
export function generateOrigin(intent: string): 'step' | 'quick' | 'retry' {
  if (intent.startsWith('quick-gen:')) return 'quick';
  if (intent.startsWith('retry:')) return 'retry';
  return 'step';
}

export function generateErrorKind(error: unknown): 'provider_unavailable' | 'conflict' | 'invalid' | 'other' {
  if (!(error instanceof ScenarioApiError)) return 'other';
  if (error.code === 'PROVIDER_UNAVAILABLE') return 'provider_unavailable';
  if (error.code === 'SCENARIO_CONFLICT') return 'conflict';
  if (error.code === 'INVALID_ARGUMENT') return 'invalid';
  return 'other';
}

/** One Generate attempt in a workflow step, once the workflow service accepted or rejected it. */
export function reportWorkflowGenerate(workflowId: string, intent: string, args: Record<string, unknown>, outcome: 'success' | 'failure', error?: unknown) {
  const references = Array.isArray(args.referencePoolItemIds) ? args.referencePoolItemIds.length : 0;
  reportAssetGenerationSubmit(args.modality, outcome, references, false,
    { studio: 'workflows', scene: workflowId, ...(typeof args.model === 'string' ? { model: args.model } : {}) },
    { generate_origin: generateOrigin(intent), ...(outcome === 'failure' ? { error_kind: generateErrorKind(error) } : {}) });
}
