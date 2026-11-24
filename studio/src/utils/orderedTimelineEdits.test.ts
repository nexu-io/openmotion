// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { applyTextPatch } from '../../../shared/text-patch';
import type { OrderedTextEditOperation } from '../../../shared/ordered-text-edits';
import { openTimelineSource, projectPendingStructure } from '../player/lib/peerTimeline';
import { usePlayerStore } from '../player/store/playerStore';
import { confirmedSource, observeSourceRead } from './confirmedTextSources';
import { saveCloudTimeline, type TimelineFileEdit } from './cloudTimelineEdit';

it('projects a split and deletion while an earlier move waits for its receipt, and batches the suffix in order', async () => {
  const project = 'timeline-burst', path = 'index.html';
  const clip = (id: string) => '<audio id="' + id + '" data-hf-id="hf-' + id + '" src="a.mp3" data-start="0" data-duration="9" data-track-index="1"></audio>';
  let stored = '<div data-composition-id="root" data-duration="20">' + clip('a') + clip('b') + '</div>';
  observeSourceRead(project, path, new Response(null, {headers: {'X-OpenMotion-Text-Edits':'1','X-OpenMotion-Ordered-Edits':'1'}}), {content: stored, version:'base'});
  usePlayerStore.setState({timelineProjectId: project, duration: 20, elements: []});
  const close = openTimelineSource(project, path);
  const first = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const packs: string[][] = [];
  let revision = 0;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const ops: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    packs.push(ops.map(op => op.label!));
    if (packs.length === 1) { first.resolve(); await release.promise; }
    return Response.json({committed:ops.map((op, i) => {
      const file = op.files[0]!;
      expect(file.baseVersion).toEqual(i ? {after: ops[i-1]!.id} : revision ? 'v'+revision : 'base');
      stored = 'patch' in file ? applyTextPatch(stored,file.patch) : file.content;
      const version = 'v' + ++revision;
      return {id:op.id, versions:{[path]:version}, changedPaths:[path], versionId:version, revision:version, writeToken:op.id};
    })});
  });
  vi.stubGlobal('fetch', fetch);
  const writer = vi.fn(async () => {});
  const history = vi.fn(async () => {});
  const initial = stored;
  const refresh = vi.fn(async () => {});
  const visible: string[] = [];
  const save = (label: string, command: TimelineFileEdit['command']) =>
    saveCloudTimeline(project, [{path, command}], writer, history, label, refresh, {
      projectPending(files) {
        visible.push(label);
        return projectPendingStructure(project, path, null, files);
      },
    });
  try {
    const move = save('move', {kind:'moveClips', changes:[{hfId:'hf-a', start:1, track:2}]});
    await first.promise;
    const trim = save('trim', {kind:'trimClips', changes:[{hfId:'hf-a',start:1,duration:7,playbackStart:1}]});
    const split = save('split', {kind:'splitClips',hfIds:['hf-a'],at:4});
    const remove = save('delete', {kind:'deleteClips',hfIds:['hf-b']});
    await vi.waitFor(() => expect(visible).toEqual(['move','trim','split','delete']));
    const rows = usePlayerStore.getState().elements;
    expect(rows.some(e => e.domId === 'b')).toBe(false);
    expect(rows.some(e => e.start === 4)).toBe(true);
    expect(packs).toEqual([['move']]);
    release.resolve();
    await Promise.all([move,trim,split,remove]);
    expect(packs).toEqual([['move'],['trim','split','delete']]);
    expect(confirmedSource(project,path)?.content).toBe(stored);
    expect(history).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ [path]: { before: initial, after: stored } }, { content: initial, version: "base" });
    expect(writer).not.toHaveBeenCalled();
  } finally {
    release.resolve(); close(); usePlayerStore.getState().reset(); vi.unstubAllGlobals();
  }
});

it('allows a valid gesture after a missing target and paints it even when the final gesture is a no-op', async () => {
  const { saveOrderedTimeline } = await import('./orderedTimelineEdits');
  const project = 'timeline-missing-target', path = 'notes.txt';
  observeSourceRead(project, path, new Response(null, { headers: { 'X-OpenMotion-Text-Edits':'1', 'X-OpenMotion-Ordered-Edits':'1' } }), { content:'a', version:'v1' });
  const sent: string[] = [];
  const history = vi.fn(async () => {});
  const paint = vi.fn(async () => {});
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const operations: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    sent.push(...operations.map(op => op.label!));
    return Response.json({ committed: operations.map(op => ({
      id:op.id, versions:{[path]:'v2'}, changedPaths:[path], versionId:'v2', revision:'2', writeToken:op.id,
    })) });
  }));
  try {
    const run = (label: string, apply: (source: string) => string, refresh?: typeof paint) =>
      saveOrderedTimeline(project, [{path, apply}], label, {recordEdit: history, onSaved: refresh});
    const [invalid, changed, noop] = await Promise.allSettled([
      run('missing', () => { throw new Error('Missing clip'); }),
      run('rename', source => source+'b', paint),
      run('noop', source => source),
    ]);
    expect(invalid.status).toBe('rejected');
    expect([changed, noop]).toEqual([{status:'fulfilled',value:[path]}, {status:'fulfilled',value:[]}]);
    expect(sent).toEqual(['rename']);
    expect(history).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledExactlyOnceWith({[path]:{before:'a', after:'ab'}},{version:'v1',content:'a'});
  } finally { vi.unstubAllGlobals(); }
});

it('restores authoritative rows when multiple consecutive optimistic gestures fail', async () => {
  const project = 'timeline-rejected-edits', path = 'index.html';
  const source = '<div data-composition-id="root" data-duration="12"><audio id="a" src="a.mp3" data-hf-id="hf-a" data-start="1" data-duration="7" data-track-index="1"></audio></div>';
  observeSourceRead(project, path, new Response(null, {headers:{'X-OpenMotion-Text-Edits':'1','X-OpenMotion-Ordered-Edits':'1'}}), {content:source,version:'v1'});
  usePlayerStore.setState({timelineProjectId: project, duration: 12, elements: []});
  const close = openTimelineSource(project, path);
  const first = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const sent: string[] = [];
  const writer = vi.fn(async () => {});
  const history = vi.fn(async () => {});
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const [op] = JSON.parse(String(init.body)).operations as OrderedTextEditOperation[];
    sent.push(op!.label!);
    if (sent.length === 1) { first.resolve(); await release.promise; }
    return Response.json({committed:[],failed:{id:op!.id,status:422,code:'INVALID_ARGUMENT',message:'The edit was refused'}});
  }));
  const run = (label: string, command: TimelineFileEdit['command']) => saveCloudTimeline(project, [{path, command}], writer, history, label, undefined, {
    projectPending: files => projectPendingStructure(project, path, null, files),
  });
  try {
    const move = run('move', {kind:'moveClips',changes:[{hfId:'hf-a',start:2,track:2}]});
    await first.promise;
    const trim = run('trim', {kind:'trimClips',changes:[{hfId:'hf-a',start:2,duration:4,playbackStart:1}]});
    const split = run('split', {kind:'splitClips',hfIds:['hf-a'],at:4});
    const outcomes = Promise.allSettled([move,trim,split]);
    await vi.waitFor(() => expect(usePlayerStore.getState().elements.some(row => row.start === 4)).toBe(true));
    release.resolve();
    expect((await outcomes).map(r=>r.status)).toEqual(['rejected','rejected','rejected']);
    expect(usePlayerStore.getState().elements.map(row=>[row.domId,row.start,row.duration])).toEqual([['a',1,7]]);
    expect(confirmedSource(project,path)?.content).toBe(source);
    expect(history).not.toHaveBeenCalled();
  } finally { release.resolve(); close(); usePlayerStore.getState().reset(); vi.unstubAllGlobals(); }
});
