import assert from 'node:assert/strict';
import test from 'node:test';
import { OrderedEditEvents } from '../../src/services/ordered-edit-events.ts';
import type { CommitProjectFilesResult } from '../../src/services/project-files-service.ts';
import type { PendingTextRevision } from '../../src/services/project-text-edits.ts';
import type { ProjectEvent } from '../../src/contracts/events.ts';

const path = 'scene.html';
function step(n: number): CommitProjectFilesResult {
  return { projectId: 'p', revision: 'r' + n, previousRevision: 'r' + (n-1), versionId: 'v' + n,
    versionNumber: n, historySeq: n, changedPaths: [path], deletedPaths: [], versionsByPath: {[path]: '"patch:' + n + '"'},
    affectsPreview: true, affectedCompositions: [path], writeToken: 'op' + n, replayed: false };
}

function delta(n: number, inserted = 'a'): PendingTextRevision {
  return {path, parentScope: 'patch', parentId: String(n-1), sizeBytes: 15, depth: 1,
    chainPatchBytes: 0, checkpointDue: false, mimeType: 'text/html', patch: [[10, 0, inserted]]};
}

async function deliveries(collector: OrderedEditEvents) {
  const seen: ProjectEvent[] = [];
  await collector.publish(async item => { seen.push(item); }, async () => undefined);
  return seen;
}

test('one ordered file event carries 100 committed patches, plus a history notification for older tabs', async () => {
  const collector = new OrderedEditEvents('w', 'p');
  for (let n = 1; n <= 100; n++) collector.record(step(n), [delta(n)]);
  collector.record({...step(1), replayed: true}, [delta(1)]);
  const seen = await deliveries(collector);
  assert.equal(seen.length, 2);
  const [files, history] = seen;
  assert.ok(files.type === 'files-changed' && history.type === 'history-changed');
  assert.equal(history.includedInOrderedEdit, true);
  assert.equal(files.ordered?.fromRevision, 'r0');
  assert.deepEqual(files.ordered?.steps.map(s => s.id), Array.from({length:100},(_,i) => 'op'+(i+1)));
  assert.deepEqual(files.ordered?.steps[99].patches?.[0],
    {path, from: '"patch:99"', to: '"patch:100"', patch: [[10,0,'a']]});
  assert.deepEqual(files.fileVersions, {[path]: '"patch:100"'});
});

test('interleaved commits split ranges; oversized changes omit patch bodies', async () => {
  const collector = new OrderedEditEvents('w','p');
  collector.record(step(1), [delta(1)]);
  collector.record(step(3), [delta(3, 'a'.repeat(70*1024))]);
  const seen = await deliveries(collector);
  const files = seen.filter((e): e is Extract<ProjectEvent, {paths: string[]}> => e.type === 'files-changed');
  assert.deepEqual(files.map(e => e.ordered?.fromRevision), ['r0','r2']);
  for (const event of files) assert.equal(event.ordered?.steps[0].patches, undefined);
});
