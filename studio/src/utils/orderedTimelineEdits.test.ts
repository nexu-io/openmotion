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
  const visible: string[] = [];
  const save = (label: string, command: TimelineFileEdit['command']) =>
    saveCloudTimeline(project, [{path, command}], writer, history, label, undefined, {
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
    expect(writer).not.toHaveBeenCalled();
  } finally {
    release.resolve(); close(); usePlayerStore.getState().reset(); vi.unstubAllGlobals();
  }
});
