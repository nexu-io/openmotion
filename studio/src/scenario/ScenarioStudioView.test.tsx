import { describe, expect, it } from 'vitest';
import { scenarioDefinitions } from '../../../shared/scenarios';
import type { ScenarioStepState } from '../../../shared/scenario-runs';
import { deliverableState, studioInputFields } from './ScenarioStudioView';
import { scenarioStudios, studioDeliverables, studioScenes, studiosForScene } from './scenarioStudios';

const step = (patch: Partial<ScenarioStepState>): ScenarioStepState => ({
  stepId: 'product-images', status: 'todo', iterations: [], activeIterationId: null, bindings: {}, draft: {}, links: {}, ...patch,
});

describe('scene studios', () => {
  it('gives every workflow a studio and places it in at least one scene', () => {
    for (const scenario of scenarioDefinitions) {
      expect(scenarioStudios[scenario.id].title).toMatch(/Studio$/);
      expect(scenarioStudios[scenario.id].scenes.length).toBeGreaterThan(0);
    }
    expect(studiosForScene('all')).toHaveLength(scenarioDefinitions.length);
    for (const scene of studioScenes.filter(item => item.id !== 'all')) expect(studiosForScene(scene.id).length, scene.id).toBeGreaterThan(0);
    expect(studiosForScene('ecommerce').map(scenario => scenario.id)).toEqual(['design-full-chain', 'black-friday']);
  });

  it('hands back every step except the brief, and asks only for the idea plus required fields', () => {
    const blackFriday = scenarioDefinitions.find(scenario => scenario.id === 'black-friday')!;
    expect(studioDeliverables(blackFriday).map(item => item.id)).toEqual(['product-images', 'detail-page', 'sales-film', 'social']);
    expect(studioInputFields(blackFriday).map(field => field.id)).toEqual(['productName']);
  });

  it('reads each deliverable as waiting, making, ready or failed', () => {
    expect(deliverableState(undefined)).toBe('waiting');
    expect(deliverableState(step({ status: 'in-progress' }))).toBe('making');
    const job = (state: 'running' | 'failed' | 'completed') => ({ jobId: 'j', state, modality: 'image' as const, model: 'm' });
    const iteration = (state: 'running' | 'failed' | 'completed', outputs: { type: 'pool'; poolItemId: string }[] = []) =>
      ({ id: 'i', number: 1, createdAt: 0, source: 'generated' as const, inputs: [], outputs, job: job(state) });
    expect(deliverableState(step({ iterations: [iteration('running')], activeIterationId: 'i' }))).toBe('making');
    expect(deliverableState(step({ iterations: [iteration('failed')], activeIterationId: 'i' }))).toBe('failed');
    expect(deliverableState(step({ iterations: [iteration('completed', [{ type: 'pool', poolItemId: 'p' }])] }))).toBe('ready');
    expect(deliverableState(step({ status: 'done' }))).toBe('ready');
  });
});
