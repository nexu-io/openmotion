import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleScenes } from '../library/components/scene-timing/schedule-scenes.mjs';

test('apportions a mixed storyboard while preserving the final fixed beat', () => {
  const storyboard = Object.freeze([
    Object.freeze({ id: 'hook', weight: 1 }),
    Object.freeze({ id: 'payoff', weight: 2 }),
    Object.freeze({ id: 'end-card', frames: 60 }),
  ]);
  assert.deepEqual(scheduleScenes(storyboard, 360), [
    { id: 'hook', startFrame: 0, endFrame: 100 },
    { id: 'payoff', startFrame: 100, endFrame: 300 },
    { id: 'end-card', startFrame: 300, endFrame: 360 },
  ]);
  assert.deepEqual(scheduleScenes(storyboard, 450).at(-1),
    { id: 'end-card', startFrame: 390, endFrame: 450 });
});

test('awards equal remainders in input order and treats missing weights as 1', () => {
  assert.deepEqual(scheduleScenes([{ id: 'a' }, { id: 'locked', frames: 3 }, { id: 'b' }], 8), [
    { id: 'a', startFrame: 0, endFrame: 3 },
    { id: 'locked', startFrame: 3, endFrame: 6 },
    { id: 'b', startFrame: 6, endFrame: 8 },
  ]);
});

test('reserves a frame for every weighted scene, even at extreme ratios', () => {
  assert.deepEqual(scheduleScenes([{ id: 'short' }, { id: 'long', weight: Number.MAX_SAFE_INTEGER }], 2), [
    { id: 'short', startFrame: 0, endFrame: 1 },
    { id: 'long', startFrame: 1, endFrame: 2 },
  ]);
});

test('apportions exactly when intermediate weights exceed the safe integer range', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(scheduleScenes([{ id: 'a', weight: max - 1 }, { id: 'b', weight: max }], 5), [
    { id: 'a', startFrame: 0, endFrame: 2 },
    { id: 'b', startFrame: 2, endFrame: 5 },
  ]);
});

test('accepts an exact all-fixed budget and rejects a short or long one', () => {
  const fixed = [{ id: 'hold', frames: 4 }];
  assert.deepEqual(scheduleScenes(fixed, 4), [{ id: 'hold', startFrame: 0, endFrame: 4 }]);
  assert.throws(() => scheduleScenes(fixed, 3), /exceed totalFrames/);
  assert.throws(() => scheduleScenes(fixed, 5), /must fill totalFrames/);
  assert.throws(() => scheduleScenes([...fixed, { id: 'tail' }], 4), /at least one frame each/);
});

test('rejects zero, negative, fractional, non-finite and unsafe timing values', () => {
  for (const invalid of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => scheduleScenes([{ id: 'a', weight: invalid }], 4), /weight must be/);
    assert.throws(() => scheduleScenes([{ id: 'a', frames: invalid }], 4), /frames must be/);
    assert.throws(() => scheduleScenes([{ id: 'a' }], invalid), /totalFrames must be/);
  }
});

test('rejects ambiguous timing and missing or duplicate scene IDs', () => {
  assert.throws(() => scheduleScenes([{ id: 'a', frames: 2, weight: 2 }], 4), /both frames and weight/);
  assert.throws(() => scheduleScenes([{ id: 'a' }, { id: 'a' }], 4), /unique/);
  assert.throws(() => scheduleScenes([{ id: ' ' }], 4), /non-empty/);
  assert.throws(() => scheduleScenes([], 4), /At least one scene/);
});
