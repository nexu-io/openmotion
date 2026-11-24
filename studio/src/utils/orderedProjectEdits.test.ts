// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { OrderedTextEditOperation } from '../../../shared/ordered-text-edits';
import { confirmedSource, observeSourceRead } from './confirmedTextSources';
import { tryStudioCommandPatches, tryStudioTextEdit } from './studioTextEdits';
import { applyTextPatch } from '../../../shared/text-patch';

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
