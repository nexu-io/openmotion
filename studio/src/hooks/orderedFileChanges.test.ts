import { advanceCachedFile } from "./orderedFileChanges";

import { expect, it, vi } from 'vitest';
import { confirmedSource, rememberSource } from '../utils/confirmedTextSources';
import { createRemoteFileReader } from './remoteFileReads';

const path = 'intro.html';
const steps = Array.from({length: 100}, (_, i) => ({ id: 'op' + i, revision: 'r' + (i+1),
  patches: [{path, from: 'v' + i, to: 'v' + (i+1), patch: [[1+i,0,'a']]}] }));
const payload = { path, fileVersions: {[path]:'v100'}, ordered: {fromRevision:'r0', steps, historySeq:100} };

it('replays inclusive ordered bytes into a single refresh and handles duplicate delivery', async () => {
  const read = vi.fn();
  rememberSource('warm',path,{content:'x',version:'v0'});
  const forChange = createRemoteFileReader(read);
  for (let i = 0; i < 2; i++) {
    const view = forChange('warm',payload);
    const file = view('warm',path);
    expect(view('warm',path)).toBe(file);
    expect(await file).toMatchObject({content:'x'+'a'.repeat(100),version:'v100'});
  }
  expect(read).not.toHaveBeenCalled();
});

it('falls back to one authoritative read on a gap and preserves the newer cache', async () => {
  rememberSource('gap',path,{content:'new',version:'v101'});
  const read = vi.fn().mockResolvedValue({content:'new',version:'v101'});
  const view = createRemoteFileReader(read)('gap',payload);
  await Promise.all([view('gap',path),view('gap',path)]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(confirmedSource('gap',path)?.version).toBe('v101');
});

it('advances an unopened warm file, leaves a cold file absent and invalidates an unbridgeable version', () => {
  const base = {content:'x',version:'v0'};
  rememberSource('away', path, base);
  expect(advanceCachedFile('away', path, payload, base)?.version).toBe('v100');
  expect(confirmedSource('away', path)?.content).toBe('x'+'a'.repeat(100));
  expect(advanceCachedFile('cold', path, payload)).toBeUndefined();
  expect(confirmedSource('cold', path)).toBeUndefined();
  const stale = confirmedSource('away', path);
  advanceCachedFile('away', path, {path, fileVersions:{[path]: null}}, stale);
  expect(confirmedSource('away', path)).toBeUndefined();
});
