import { expect, it } from 'vitest';
import { imageFeaturePrompt } from '../../../shared/image-features';
import { videoFeaturePrompt } from '../../../shared/video-features';
import { assetPromptForReuse } from './assetPromptForReuse';

it('extracts the Chinese supplement from legacy cutout prompts, including already stacked prompts', () => {
  const note = '保留发丝和玻璃边缘。\n保留原本的阴影。';
  const submitted = imageFeaturePrompt('remove-background', note);
  expect(assetPromptForReuse(submitted, 'image')).toBe(note);
  expect(assetPromptForReuse(imageFeaturePrompt('remove-background', submitted), 'image')).toBe(note);
});

it('restores an empty supplement for both optional image features', () => {
  expect(assetPromptForReuse(imageFeaturePrompt('remove-background', ''), 'image')).toBe('');
  expect(assetPromptForReuse(imageFeaturePrompt('relight', '', { direction: 'back', temperature: 'cool', mood: 'neon' }), 'image')).toBe('');
});

it('unwraps a legacy prompt composed in multiple feature scenes of the same modality', () => {
  const note = '让角色走进夜市。';
  const character = imageFeaturePrompt('character', note);
  const relight = imageFeaturePrompt('relight', character, { direction: 'right', temperature: 'neutral', mood: 'moonlight' });
  expect(assetPromptForReuse(character, 'image')).toBe(note);
  expect(assetPromptForReuse(relight, 'image')).toBe(note);
});

it('preserves ordinary prompts, near matches, and instructions embedded in the description', () => {
  const ordinary = 'Camera direction: pan across a lake. Scene: a bird takes flight.';
  const wrapped = videoFeaturePrompt('camera-control', ordinary, { movement: 'pan', pace: 'dynamic' });
  expect(assetPromptForReuse(ordinary, 'video')).toBe(ordinary);
  expect(assetPromptForReuse(wrapped, 'video')).toBe(ordinary);
  expect(assetPromptForReuse(wrapped, 'audio')).toBe(wrapped);
  expect(assetPromptForReuse(`Hold on the title card. ${wrapped}`, 'video')).toBe(`Hold on the title card. ${wrapped}`);
});
