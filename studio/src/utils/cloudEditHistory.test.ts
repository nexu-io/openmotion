import { expect, it } from 'vitest';
import { CloudEditHistory } from './cloudEditHistory';

const navigation = (revision: string, versionId: string) => ({ supportsGuardedSteps: true, revision, currentVersionId: versionId, back: { versionId }, forward: null });
const save = (parentRevision: string, revision: string, versionId: string, coalesced = false) => ({
  id: `op-${revision}`, writeToken: `op-${revision}`, historySeq: 4, parentRevision, parentVersionId: coalesced ? versionId : 'base',
  revision, versionId, coalesced, versions: { 'index.html': revision }, changedPaths: ['index.html'],
});
const files = (before: string, after: string) => ({ 'index.html': { before, after, beforeVersion: `file-${before}`, afterVersion: `file-${after}` } });

it('retains the original bytes for an entire owned gesture, including an in-place version update', () => {
  const history = new CloudEditHistory('gesture');
  history.offered(navigation('r0', 'base'));
  const first = history.begin();
  first.accept(save('r0', 'r1', 'same-id'), files('A', 'B'), 'drag');
  first.finish();
  const second = history.begin();
  second.accept(save('r1', 'r2', 'same-id', true), files('B', 'C'), 'drag');
  second.finish();
  expect(history.confirmed('undo')).toMatchObject({ files: { 'index.html': { previous: 'C', restored: 'A' } },
    guard: { expectedVersionId: 'same-id', expectedRevision: 'r2', expectedTargetVersionId: 'base', expectedTargetRevision: 'r0' } });
  history.offered({ ...navigation('r0', 'base'), forward: { versionId: 'same-id', targetVersionId: 'same-id', targetRevision: 'peer' } });
  expect(history.predict('redo')).toBeNull();
});

it('retires a delayed receipt after a foreign event or ambiguous failure and declines partially owned gestures', () => {
  const history = new CloudEditHistory('peers');
  history.offered(navigation('r0', 'base'));
  const delayed = history.begin();
  history.clear();
  delayed.accept(save('r0', 'r1', 'one'), files('A', 'B'));
  delayed.finish();
  history.offered(navigation('r1', 'one'));
  expect(history.predict('undo')).toBeNull();
  const continuation = history.begin();
  continuation.accept(save('r1', 'r2', 'one', true), files('B', 'C'));
  continuation.finish();
  expect(history.predict('undo')).toBeNull();
  const local = history.begin();
  local.accept({ ...save('r2', 'r3', 'two'), parentVersionId: 'one' }, files('C', 'D'));
  local.finish();
  expect(history.predict('undo')).toBeTruthy();
  history.begin().finish(true);
  expect(history.predict('undo')).toBeNull();
});

it('requires matching speculative bytes, transaction parent and full changed path set before confirming a pending ID', async () => {
  const history = new CloudEditHistory('rebase');
  history.offered(navigation('r0', 'base'));
  const entry = history.begin(async () => ({ edits: [{ path: 'index.html', before: 'A', after: 'B', version: 'file-A' }] }));
  await Promise.resolve();
  const pending = history.predict('undo');
  expect(pending).toBeTruthy();
  entry.accept(save('r0', 'r1', 'one'), files('A', 'B with stamped identifiers'));
  entry.finish();
  expect(history.confirmed('undo')?.id).not.toBe(pending!.id);
  const incomplete = history.begin();
  incomplete.accept({ ...save('r1', 'r2', 'two'), parentVersionId: 'one', changedPaths: ['index.html', 'image.jpg'] }, files('B', 'C'));
  incomplete.finish();
  expect(history.predict('undo')).toBeNull();
});

it('withholds an older local undo when a peer commits between accepted steps in one batch', () => {
  const history = new CloudEditHistory('interleaved');
  history.offered(navigation('r0', 'base'));
  const first = history.begin();
  const last = history.begin();
  first.accept(save('r0', 'r1', 'one'), files('A', 'B'));
  first.finish();
  last.accept({ ...save('peer-r', 'r3', 'three'), parentVersionId: 'peer' }, files('B+peer', 'C+peer'));
  last.finish();
  expect(history.predict('undo')).toBeNull();
  history.offered(navigation('r3', 'three'));
  expect(history.confirmed('undo')).toMatchObject({ files: { 'index.html': { restored: 'B+peer' } },
    guard: { expectedTargetRevision: 'peer-r', expectedTargetVersionId: 'peer' } });
});
