import { scenarioDefinitions, type ScenarioDefinition, type ScenarioId, type ScenarioStepDefinition } from '../../../shared/scenarios';

/**
 * Scene studios: each workflow is presented to people as a studio. They give one brief
 * and receive the whole kit; the ordered steps stay behind the Step by step and Agent modes.
 */
export const studioScenes = [
  { id: 'all', label: 'All scenes' },
  { id: 'ecommerce', label: 'E-commerce' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'social', label: 'Social' },
  { id: 'film', label: 'Film' },
] as const;

export type StudioSceneId = typeof studioScenes[number]['id'];

type ScenarioStudio = {
  /** Studio name shown on cards and in the studio view. */
  title: string;
  /** The one thing people type before the kit is made. */
  inputHint: string;
  scenes: readonly Exclude<StudioSceneId, 'all'>[];
};

export const scenarioStudios: Record<ScenarioId, ScenarioStudio> = {
  'black-friday': {
    title: 'Promo Kit Studio',
    inputHint: 'Describe your product and the offer. You get product images, a detail page, a sales film and social posts.',
    scenes: ['ecommerce', 'marketing'],
  },
  'design-full-chain': {
    title: 'Launch Kit Studio',
    inputHint: 'Describe what you are launching. You get a landing page, page images, a promo video and social posts.',
    scenes: ['ecommerce', 'marketing'],
  },
  'gemini-4-neon': {
    title: 'Code Motion Studio',
    inputHint: 'Describe the animation you want. You get a live code animation, key stills, a film and social posts.',
    scenes: ['marketing', 'social'],
  },
  'ai-influencer': {
    title: 'Virtual Creator Studio',
    inputHint: 'Describe your creator and this episode. You get persona visuals, a link-in-bio page, a voiceover, a talking video and social posts.',
    scenes: ['social'],
  },
  'motion-full-chain': {
    title: 'Story Film Studio',
    inputHint: 'Describe your film idea. You get a storyboard, a motion film, a soundtrack and social posts.',
    scenes: ['film', 'social'],
  },
};

export const scenarioStudio = (id: ScenarioId) => scenarioStudios[id];

export function studiosForScene(scene: StudioSceneId): ScenarioDefinition[] {
  return scenarioDefinitions.filter(scenario => scene === 'all' || scenarioStudios[scenario.id].scenes.some(id => id === scene));
}

/** Everything a studio hands back: every step except the brief people type themselves. */
export function studioDeliverables(scenario: ScenarioDefinition): ScenarioStepDefinition[] {
  return scenario.steps.filter(step => step.type !== 'brief');
}

