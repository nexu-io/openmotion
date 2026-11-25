// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedTextEditOperation } from '../../../shared/ordered-text-edits';
import { confirmedSource, observeEditAssets, observeSourceRead } from './confirmedTextSources';
import { readStudioAssetVersion, saveOrderedStudioFile, tryStudioCommandPatches, tryStudioTextEdit } from './studioTextEdits';
import { orderedEditFixture } from '../../tests/orderedEditFixture';
import { setCachedCloudDisklessMode } from './cloudRuntime';
import { applyTextPatch } from '../../../shared/text-patch';
import { getStudioSaveSnapshot, trackStudioProjectSave } from './studioSaveState';
import { RejectedCanvasGesture, StudioFileConflictError } from './studioSaveDiagnostics';
import { acknowledgeFileEdit } from './isolatedEditVersions';
import { stageFileProjection, finishFileProjections } from './projectedTextEdits';

function observe(project: string, path: string, content: string, version: string) {
  observeSourceRead(project, path, new Response(null, { headers: {
    'X-OpenMotion-Text-Edits': '1', 'X-OpenMotion-Ordered-Edits': '1',
  } }), { content, version });
}
function receipt(id: string, path: string, version: string) {
  return { id, versions: { [path]: version }, changedPaths: [path], writeToken: id, revision: version, versionId: version };
}
function recordAcceptedBatches(path: string) {
  const batches: string[][] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const operations: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    batches.push(operations.map(op => op.label));
    return Response.json({ committed: operations.map(op => receipt(op.id, path, op.id)) });
  });
  return batches;
}
afterEach(() => vi.unstubAllGlobals());

it('rejects an impossible drag before sending, keeps the save status honest and accepts the next layer', async () => {
  const project = 'rejected-gesture', path = 'scene.html';
  observe(project, path, '<div id="locked" data-timeline-locked></div><div id="other"></div>', 'base');
  const batches = recordAcceptedBatches(path);
  const move = (id: string) => tryStudioCommandPatches(project, [{
    compositionPath: path, kind: 'moveCanvasElement', target: { id }, delta: { x: 20, y: 0 },
  }], { [path]: 'base' });
  await expect(move('locked')).rejects.toBeInstanceOf(RejectedCanvasGesture);
  expect(batches).toEqual([]);
  expect(getStudioSaveSnapshot(project)).toEqual({ pending: 0, failed: false, savedAt: null });
  await move('other');
  expect(batches).toHaveLength(1);
  expect(getStudioSaveSnapshot(project).savedAt).toBeTypeOf('number');

  await expect(trackStudioProjectSave(project, path, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  await expect(move('locked')).rejects.toBeInstanceOf(RejectedCanvasGesture);
  expect(getStudioSaveSnapshot(project).failed).toBe(true);
});

it.each([true, false])('distinguishes a local receipt from a peer move while preparing a projected drag (local %s)', async local => {
  const project = 'drag-base-' + local, path = 'clip.html';
  const original = '<div id="box" data-hf-id="box" style="position:absolute;left:0px"></div>';
  const moved = original.replace('left:0px', 'left:10px');
  observe(project, path, original, 'v0');
  const pending = Promise.withResolvers<{ path: string; before: string; after: string; version: string }>();
  const previous = stageFileProjection(project, path, Promise.resolve({ content: original, version: 'v0' }), pending.promise);
  const post = vi.fn(async (_url: string, init: RequestInit) => {
    const [op]: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    expect(op.files[0]!.baseVersion).toBe('v1');
    return Response.json({ committed: [receipt(op.id, path, 'v2')] });
  });
  vi.stubGlobal('fetch', post);
  try {
    const next = tryStudioCommandPatches(project, [{
      compositionPath: path, kind: 'moveCanvasElement', target: { id: 'box' }, delta: { x: 5, y: 0 },
    }], { [path]: 'v0' });
    // The projection still names v0 when the preceding change becomes authoritative.
    observe(project, path, moved, 'v1');
    if (local) acknowledgeFileEdit(project, path, 'v0', 'v1');
    pending.resolve({ path, before: original, after: moved, version: 'v0' });
    if (local) {
      await expect(next).resolves.toMatchObject({ versions: { [path]: 'v2' } });
      const content = confirmedSource(project, path)!.content;
      expect(content).toMatch(/left:\s*10px/);
      expect(content).toMatch(/translate:\s*5px 0px/);
    } else {
      await expect(next).rejects.toBeInstanceOf(StudioFileConflictError);
      expect(post).not.toHaveBeenCalled();
    }
  } finally {
    finishFileProjections(project, [previous]);
  }
});

it('sends 100 completed edits in order and ties each patch to its predecessor', async () => {
  const path = 'style.css', project = 'ordered-burst';
  let text = ' '.repeat(1024) + '0';
  observe(project, path, text, 'start');
  const post = vi.fn(async (_url: string, init: RequestInit) => {
    const ops: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    expect(ops).toHaveLength(100);
    const committed = ops.map((op, i) => {
      const [file] = op.files;
      expect(file.baseVersion).toEqual(i ? {after: ops[i - 1].id} : 'start');
      text = 'patch' in file ? applyTextPatch(text, file.patch) : file.content;
      expect(text.trim()).toBe(String(i + 1));
      return receipt(op.id, path, 'v' + (i + 1));
    });
    return Response.json({ committed });
  });
  vi.stubGlobal('fetch', post);
  const saves = Array.from({ length: 100 }, (_, i) => tryStudioTextEdit(project,
    [{path, before: ' '.repeat(1024) + i, after: ' '.repeat(1024) + (i + 1)}]));
  const results = await Promise.all(saves);
  expect(results.map(r => r?.versions[path])).toEqual(saves.map((_, i) => 'v' + (i + 1)));
  expect(confirmedSource(project, path)?.content).toBe(text);
  expect(post).toHaveBeenCalledTimes(1);
});

it('keeps a committed prefix and continues an independent edit after a conflict', async () => {
  const project = 'ordered-prefix';
  for (const path of ['a.css','b.css','c.css']) observe(project, path, 'old', 'base');
  const sent: string[][] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const ops: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    const paths = ops.map(op => op.files[0].path);
    sent.push(paths);
    const first = receipt(ops[0].id, paths[0], 'saved');
    return Response.json({committed:[first], ...(ops.length > 1 && {failed: {
      id:ops[1].id, status:409, code:'VERSION_CONFLICT', path:paths[1], currentVersion:'other', message:'stale',
    }})});
  });
  const results = await Promise.allSettled(['a.css','b.css','c.css'].map(path => tryStudioTextEdit(project, [{path,before:'old',after:'new'}])));
  expect(results.map(r => r.status)).toEqual(['fulfilled','rejected','fulfilled']);
  expect(sent).toEqual([['a.css','b.css','c.css'],['c.css']]);
});

it('compiles consecutive semantic edits against the projected HTML before confirmation', async () => {
  const project = 'ordered-command', path = 'clip.html';
  let text = '<p id="target" data-hf-id="target">hello</p>' + ' '.repeat(150);
  observe(project, path, text, 'base');
  const post = vi.fn(async (_url: string, init: RequestInit) => {
    const ops: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    return Response.json({committed: ops.map((op, i) => {
      const file = op.files[0];
      text = 'patch' in file ? applyTextPatch(text, file.patch) : file.content;
      return receipt(op.id, path, 'r' + i);
    })});
  });
  vi.stubGlobal('fetch', post);
  await Promise.all(['red','blue'].map(value => tryStudioCommandPatches(project, [{
    kind:'editElements', compositionPath:path, patches:[{target:{hfId:'target'}, operations:[{type:'inline-style',property:'color',value}]}],
  }],{[path]:'base'})));
  expect(post).toHaveBeenCalledTimes(1);
  expect(text).toMatch(/color:\s*blue/);
});

it('preserves order across server-side edits with external dependencies', async () => {
  const project = 'barrier', path = 'scene.css';
  observe(project, path, '0', 'base');
  const sequence: string[] = [];
  const { runOrderedProjectBarrier } = await import('./orderedProjectEdits');
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const [op]: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    sequence.push('patch');
    return Response.json({ committed: [receipt(op.id, path, 'r' + sequence.length)] });
  });
  const first = tryStudioTextEdit(project, [{path, before:'0', after:'1'}]);
  const middle = runOrderedProjectBarrier(project, async () => { sequence.push('semantic'); });
  const last = tryStudioTextEdit(project, [{path, before:'1', after:'2'}]);
  await Promise.all([first, middle, last]);
  expect(sequence).toEqual(['patch','semantic','patch']);
});

it('sends the prefix picked at the deadline even when more edits arrive during preparation', async () => {
  const { enqueueProjectEdit } = await import('./orderedProjectEdits');
  const project = 'ordered-prepare-deadline', path = 'style.css';
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const batches = recordAcceptedBatches(path);
  function enqueue(i: number) {
    return enqueueProjectEdit(project, path, async () => {
      if (i === 0) { started.resolve(); await release.promise; }
      return { edits: [{ path, before: String(i), after: String(i + 1), version: 'base' }], label: String(i) };
    });
  }
  const first = enqueue(0);
  await started.promise;
  const tail = Array.from({ length: 40 }, (_, i) => enqueue(i + 1));
  release.resolve();
  await Promise.all([first, ...tail]);
  expect(batches).toEqual([['0'], tail.map((_, i) => String(i + 1))]);
});

it('starts the first batch by its deadline when continuous input precedes timer callbacks', async () => {
  const project = 'busy-input-loop', path = 'style.css';
  observe(project, path, '0', 'base');
  const batches = recordAcceptedBatches(path);
  const start = Date.now() - 2000;
  const now = vi.spyOn(Date, 'now');
  let saves;
  try {
    saves = Array.from({ length: 25 }, (_, i) => {
      now.mockReturnValue(start + i * 50);
      return tryStudioTextEdit(project, [{ path, before: String(i), after: String(i + 1) }]);
    });
  } finally {
    now.mockRestore();
  }
  await Promise.all(saves);
  expect(batches.map(batch => batch.length)).toEqual([21, 4]);
});

it('chains a newly created empty file across an unrelated edit in the same packet', async () => {
  const project = 'ordered-new-file';
  setCachedCloudDisklessMode(true);
  try {
    const api = orderedEditFixture(project, { 'notes.txt': 'old' });
    await Promise.all([
      saveOrderedStudioFile(project, 'new.txt', '', undefined, null),
      saveOrderedStudioFile(project, 'notes.txt', 'changed', 'old', await api.getVersion('notes.txt')),
      saveOrderedStudioFile(project, 'new.txt', 'draft', '', null),
    ]);
    expect(api.packets).toHaveLength(1);
    const [create, other, write] = api.packets[0]!;
    expect(create?.files[0]?.baseVersion).toBe(null);
    expect(typeof other?.files[0]?.baseVersion).toBe('string');
    expect(write?.files[0]?.baseVersion).toEqual({after:create!.id});
    expect(api.files).toEqual({'new.txt':'draft', 'notes.txt':'changed'});
    expect(confirmedSource(project, 'new.txt')?.content).toBe('draft');
  } finally {
    setCachedCloudDisklessMode(null);
  }
});

it('uses the freshly authored child file for the following operation before its first receipt', async () => {
  const project = 'create-then-reference', path = 'child.html', host = 'index.html';
  const source = '<main data-hf-id="hf-scene" data-composition-id="child" data-duration="5"></main>';
  const gate = Promise.withResolvers<void>();
  setCachedCloudDisklessMode(true);
  try {
    const api = orderedEditFixture(project, {[host]:'<main data-hf-id="hf-host" data-composition-id="host"></main>'}, () => gate.promise);
    const { saveOrderedTimeline, projectedTimelineText } = await import('./orderedTimelineEdits');
    const created = saveOrderedStudioFile(project, path, source, undefined, null);
    const placed = saveOrderedTimeline(project, [{
      path: host, apply: (html, inputs) => html.replace('</main>', '<p>' + inputs.get(path)!.match(/data-duration="(\d+)"/)![1] + '</p></main>'),
    }], 'Use new composition', {readPaths:[path], recordEdit:vi.fn()});
    expect(await projectedTimelineText(project, host)).toContain('<p>5</p>');
    gate.resolve();
    await Promise.all([created, placed]);
    expect(api.packets).toHaveLength(1);
    const [create, use] = api.packets[0]!;
    expect(use!.dependencies?.[path]).toEqual({after:create!.id});
    expect(api.files[host]).toMatch(/>5<\/p>/);
    expect(api.request.mock.calls.some(([url]) => String(url).endsWith('/files/' + path))).toBe(false);
  } finally {
    gate.resolve();
    setCachedCloudDisklessMode(null);
  }
});

it('shares an in-flight metadata read for a binary dependency', async () => {
  const gate = Promise.withResolvers<Response>();
  const fetch = vi.fn().mockReturnValue(gate.promise);
  vi.stubGlobal('fetch', fetch);
  const path = 'media/song.mp3';
  const first = readStudioAssetVersion('cold-media', path);
  const second = readStudioAssetVersion('cold-media', path);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]![0])).toContain('media%2Fsong.mp3?view=metadata');
  gate.resolve(Response.json({version:'audio-v1'}));
  expect(await Promise.all([first, second])).toEqual(['audio-v1','audio-v1']);
});

describe('editable media dependencies', () => {
  beforeEach(() => setCachedCloudDisklessMode(true));
  afterEach(() => setCachedCloudDisklessMode(null));

  const svgPath = 'art.svg';
  const scenePath = 'index.html';
  const emptyScene = '<main data-hf-id="hf-scene" data-composition-id="scene"></main>';
  const newSvg = '<svg><circle r="8"/></svg>';

  function placeSvg(project: string) {
    return tryStudioCommandPatches(project, [{
      kind: 'placeAsset', compositionPath: scenePath, assetPath: svgPath,
      start: 0, duration: 1, track: 0, hfId: 'placed-art',
    }], {});
  }

  it.each([
    ['edit', false], ['edit', true], ['create', false], ['create', true],
  ] as const)('places an SVG after %s with a preceding packet in flight: %s', async (action, inFlight) => {
    const project = 'ordered-svg-' + action + '-' + inFlight;
    const original = action === 'edit' ? '<svg/>' : undefined;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const api = orderedEditFixture(project, { [scenePath]: emptyScene, ...(original && { [svgPath]: original }) },
        () => { started.resolve(); return release.promise; });
      const before = await api.getVersion(svgPath);
      if (before) observeEditAssets(project, { [svgPath]: {version: before} });
      const write = saveOrderedStudioFile(project, svgPath, newSvg, original, before);
      if (inFlight) await started.promise;
      const place = placeSvg(project);
      release.resolve();
      await Promise.all([write, place]);
      expect(api.packets.map(packet => packet.length)).toEqual(inFlight ? [1, 1] : [2]);
      const [written, placed] = api.packets.flat();
      expect(placed!.dependencies?.[svgPath]).toEqual(inFlight ? await api.getVersion(svgPath) : { after: written!.id });
      expect(api.files[scenePath]).toContain('art.svg');
      expect(api.request.mock.calls.some(([url]) => String(url).endsWith('?view=metadata'))).toBe(false);
    } finally {
      release.resolve();
    }
  });

  it('keeps a later peer edit to the SVG as a real placement conflict', async () => {
    const project = 'ordered-svg-peer';
    const api = orderedEditFixture(project, { [scenePath]: emptyScene, [svgPath]: '<svg/>' });
    const original = (await api.getVersion(svgPath))!;
    observeEditAssets(project, { [svgPath]: {version:original} });
    await saveOrderedStudioFile(project, svgPath, newSvg, '<svg/>', original);
    const ownVersion = await api.getVersion(svgPath);
    await fetch('/api/projects/' + project + '/text-edits/batch', { method:'POST', body: JSON.stringify({ operations: [{
      id:'peer-edit', label:'Change SVG', files:[{ path:svgPath, baseVersion:ownVersion, content:'<svg><path/></svg>' }],
    }] }) });
    await expect(placeSvg(project)).rejects.toMatchObject({ filePath:svgPath, currentVersion:await api.getVersion(svgPath) });
    expect(api.packets.at(-1)![0]!.dependencies?.[svgPath]).toBe(ownVersion);
    expect(api.files[scenePath]).toBe(emptyScene);
  });

  it('links a metadata-only dependency to an earlier file write in the same packet', async () => {
    const project = 'svg-metadata-predecessor';
    const api = orderedEditFixture(project, { [scenePath]: emptyScene, [svgPath]: '<svg/>' });
    observeEditAssets(project, { [svgPath]: {version:(await api.getVersion(svgPath))!} });
    await Promise.all([
      tryStudioTextEdit(project, [{ path: svgPath, before: '<svg/>', after: newSvg }]),
      placeSvg(project),
    ]);
    const [write, place] = api.packets[0]!;
    expect(api.packets).toHaveLength(1);
    expect(place!.dependencies?.[svgPath]).toEqual({after:write!.id});
  });

  it('does not place a peer SVG when the local creation of that path was rejected', async () => {
    const project = 'svg-create-peer';
    const api = orderedEditFixture(project, { [scenePath]: emptyScene, [svgPath]: '<svg><rect/></svg>' });
    const results = await Promise.allSettled([
      saveOrderedStudioFile(project, svgPath, newSvg, undefined, null),
      placeSvg(project),
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(api.files[scenePath]).toBe(emptyScene);
    expect(api.files[svgPath]).toBe('<svg><rect/></svg>');
  });

  it('guards a timeline media reference to a newly authored SVG without a metadata request', async () => {
    const project = 'svg-timeline-reference';
    const api = orderedEditFixture(project, { [scenePath]: emptyScene });
    const { saveOrderedTimeline } = await import('./orderedTimelineEdits');
    await Promise.all([
      saveOrderedStudioFile(project, svgPath, newSvg, undefined, null),
      saveOrderedTimeline(project, [{ path:scenePath, apply:html => html.replace('</main>', '<img src="art.svg"></main>') }],
        'Place SVG', {assetPaths:[svgPath], recordEdit:vi.fn()}),
    ]);
    const [write, place] = api.packets[0]!;
    expect(api.packets).toHaveLength(1);
    expect(place!.dependencies?.[svgPath]).toEqual({after:write!.id});
    expect(api.request.mock.calls.some(([url]) => String(url).endsWith('?view=metadata'))).toBe(false);
  });
});
