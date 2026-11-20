import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCheckpoint, requireProduction } from '../shared/creative-checkpoint.ts';

const basedOn = { versionId: 'version-1', revision: 'revision-1' };
const directions = { kind: 'preview_shown' as const, previewType: 'creative_directions' as const, motionRisk: 'low' as const,
  candidates: [{ id: 'quiet', evidence: [{ path: 'quiet/storyboard.png' }] }, { id: 'bold', evidence: [{ path: 'bold/storyboard.png' }] }] };

test('checkpoint flow waits after a preview and confirms a clear direction', () => {
  const shown = applyCheckpoint(undefined, directions, basedOn, 1, 'show');
  assert.equal(shown.creative.status, 'waiting_user');
  assert.equal(shown.signal?.event, 'preview_generated');
  assert.throws(() => applyCheckpoint(shown.creative, { kind: 'decision', previewVersion: 1, decision: 'selected', directionId: 'missing' }, basedOn, 2), /INVALID_ARGUMENT/);

  const selected = applyCheckpoint(shown.creative, { kind: 'decision', previewVersion: 1, decision: 'selected', directionId: 'quiet' }, basedOn, 2, 'select');
  assert.equal(selected.creative.status, 'confirmed');
  assert.equal(selected.creative.selectedDirectionId, 'quiet');
  assert.equal(selected.signal?.event, 'preview_selected_or_confirmed');
  assert.throws(() => requireProduction(selected.creative), /CREATIVE_CONFIRMATION_REQUIRED/);
});

test('high-risk direction requires a motion sample and stale responses are rejected', () => {
  const shown = applyCheckpoint(undefined, { ...directions, motionRisk: 'high' }, basedOn, 1, 'show');
  const selected = applyCheckpoint(shown.creative, { kind: 'decision', previewVersion: 1, decision: 'selected', directionId: 'quiet' }, basedOn, 2, 'select');
  assert.equal(selected.creative.status, 'previewing');
  assert.throws(() => applyCheckpoint(selected.creative, { kind: 'decision', previewVersion: 1, decision: 'confirmed' }, basedOn, 3), /show the revised preview/);
  assert.throws(() => applyCheckpoint(selected.creative, { kind: 'preview_shown', previewType: 'storyboard', candidates: [{ id: 'storyboard', evidence: [{ path: 'storyboard.png' }] }] }, basedOn, 3), /motion_sample/);

  const sample = applyCheckpoint(selected.creative, { kind: 'preview_shown', previewType: 'motion_sample', candidates: [{ id: 'sample', evidence: [{ jobId: 'job-1' }] }] }, basedOn, 3, 'sample');
  assert.equal(sample.creative.status, 'waiting_user');
  const confirmed = applyCheckpoint(sample.creative, { kind: 'decision', previewVersion: 2, decision: 'confirmed' }, basedOn, 4, 'confirm');
  assert.equal(confirmed.creative.status, 'confirmed');
  const started = applyCheckpoint(confirmed.creative, { kind: 'production_started' }, basedOn, 5, 'start');
  assert.equal(started.creative.status, 'producing');
  assert.doesNotThrow(() => requireProduction(started.creative));
  const redesign = applyCheckpoint(started.creative, { kind: 'decision', decision: 'revision_requested', reason: 'motion_or_audio', scope: 'scene' }, basedOn, 6, 'redesign');
  const revisedPreview = applyCheckpoint(redesign.creative, { kind: 'preview_shown', previewType: 'motion_sample', candidates: [{ id: 'revised-sample', evidence: [{ jobId: 'job-2' }] }] }, basedOn, 7, 'revised-sample');
  const revisedConfirmation = applyCheckpoint(revisedPreview.creative, { kind: 'decision', previewVersion: 3, decision: 'confirmed' }, basedOn, 8, 'reconfirm');
  const restarted = applyCheckpoint(revisedConfirmation.creative, { kind: 'production_started' }, basedOn, 9, 'restart');
  assert.equal(restarted.signal?.event, 'production_started');
  assert.equal(restarted.creative.productionStartedAt, 5);
});

test('saved previews can be switched and production starts once', () => {
  const first = applyCheckpoint(undefined, { ...directions, candidates: [{ id: 'first', evidence: [{ path: 'first.png' }] }, { id: 'second', evidence: [{ path: 'second.png' }] }] }, basedOn, 1, 'show-1');
  const revised = applyCheckpoint(first.creative, { kind: 'decision', previewVersion: 1, decision: 'revision_requested', reason: 'visual_adjustment', scope: 'frames' }, basedOn, 2, 'revise');
  const second = applyCheckpoint(revised.creative, { ...directions, candidates: [{ id: 'new-first', evidence: [{ path: 'new-first.png' }] }, { id: 'new-second', evidence: [{ path: 'new-second.png' }] }] }, basedOn, 3, 'show-2');
  const switched = applyCheckpoint(second.creative, { kind: 'decision', previewVersion: 1, decision: 'switched' }, basedOn, 4, 'switch');
  assert.equal(switched.creative.currentPreviewVersion, 1);
  assert.throws(() => applyCheckpoint(switched.creative, { kind: 'decision', previewVersion: 2, decision: 'confirmed' }, basedOn, 5), /PREVIEW_VERSION_CONFLICT/);

  const chosen = applyCheckpoint(switched.creative, { kind: 'decision', previewVersion: 1, decision: 'selected', directionId: 'first' }, basedOn, 5, 'choose');
  const started = applyCheckpoint(chosen.creative, { kind: 'production_started' }, basedOn, 6, 'start');
  const replay = applyCheckpoint(started.creative, { kind: 'production_started' }, basedOn, 7, 'start-again');
  assert.equal(started.signal?.event, 'production_started');
  assert.equal(replay.changed, false);
  assert.equal(replay.creative.productionStartedAt, 6);
});

test('skip reasons can satisfy the production gate', () => {
  const skipped = applyCheckpoint(undefined, { kind: 'skipped', skipReason: 'simple_template_adaptation' }, basedOn, 1, 'skip');
  assert.equal(skipped.creative.status, 'confirmed');
  assert.throws(() => requireProduction(skipped.creative), /CREATIVE_CONFIRMATION_REQUIRED/);
  const started = applyCheckpoint(skipped.creative, { kind: 'production_started' }, basedOn, 2, 'start');
  assert.doesNotThrow(() => requireProduction(started.creative));
  assert.equal(started.signal?.properties.start_basis, 'simple_template_adaptation');
});
