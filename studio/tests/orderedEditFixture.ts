import { onTestFinished, vi } from 'vitest';
import type { OrderedTextEditOperation, OrderedTextEditReceipt } from '../../shared/ordered-text-edits';
import { applyTextPatch } from '../../shared/text-patch';
import { observeSourceRead } from '../src/utils/confirmedTextSources';
import { studioFileContentVersion } from '../src/utils/studioFileVersion';

/** Exercise the browser writer through its HTTP contract, including intra-packet version checks. */
export function orderedEditFixture(project: string, initial: Record<string, string>,
  beforeCommit?: () => Promise<Response | void> | Response | void) {
  const files = { ...initial };
  const versions = new Map<string, string>();
  const packets: OrderedTextEditOperation[][] = [];
  const reset = () => {
    for (const path of Object.keys(files)) observeSourceRead(project, path, new Response(), {});
  };
  reset();
  onTestFinished(reset);
  const getVersion = async (path: string) => {
    if (!Object.hasOwn(files, path)) return null;
    const version = versions.get(path) ?? await studioFileContentVersion(files[path]!);
    versions.set(path, version);
    return version;
  };
  const headers = { 'X-OpenMotion-Ordered-Edits': '1', 'X-OpenMotion-Text-Edits': '1' };
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://studio.test');
    const prefix = '/api/projects/' + project;
    if (url.pathname.startsWith(prefix + '/files/')) {
      const path = decodeURIComponent(url.pathname.slice((prefix + '/files/').length));
      const version = await getVersion(path);
      if (version === null) return url.searchParams.get('optional') === '1' ?
        Response.json({ missing: true, content: '', version: null }, {headers}) : new Response(null, {status:404});
      return Response.json(url.searchParams.get('view') === 'metadata' ? {path, version} : {content: files[path], version}, {headers});
    }
    if (url.pathname !== prefix + '/text-edits/batch' || init?.method !== 'POST') throw new Error('Unexpected edit request: ' + url.pathname);
    const ops: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    packets.push(ops);
    const failure = await beforeCommit?.();
    if (failure) return failure;
    const committed: OrderedTextEditReceipt[] = [];
    for (const op of ops) {
      for (const [path, base] of [...Object.entries(op.dependencies ?? {}), ...op.files.map(f => [f.path, f.baseVersion] as const)]) {
        const expected = base && typeof base === 'object' ? committed.find(r => r.id === base.after)?.versions[path] : base;
        const current = await getVersion(path);
        if (expected !== current) return Response.json({committed, failed: { id: op.id, path, currentVersion: current,
          status: 409, code: 'VERSION_CONFLICT', message: 'File changed before this edit' }});
      }
      const receipt: OrderedTextEditReceipt = {id: op.id, versions:{}, changedPaths:[], writeToken:op.id, revision:op.id, versionId:op.id};
      for (const file of op.files) {
        files[file.path] = 'content' in file ? file.content : applyTextPatch(files[file.path]!, file.patch);
        versions.delete(file.path);
        receipt.versions[file.path] = (await getVersion(file.path))!;
        receipt.changedPaths.push(file.path);
      }
      committed.push(receipt);
    }
    return Response.json({ committed });
  });
  vi.stubGlobal('fetch', request);
  const replaceFile = (path: string, content: string) => { files[path] = content; versions.delete(path); };
  return { files, packets, request, getVersion, replaceFile };
}
