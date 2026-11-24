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
