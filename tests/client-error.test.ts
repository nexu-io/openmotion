import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clientErrorMessage, isFilesystemError } from '../shared/client-error.ts';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';
import { Phase1Service } from '../phase1.ts';
import { pluginRoot } from '../hyperframes.ts';
import type { Service } from '../server.ts';

const filesystemError = (code: string, syscall: string, file: string) =>
  Object.assign(new Error(`${code}: something went wrong, ${syscall} '${file}'`), { code, syscall, path: file });

test('filesystem failures lose the absolute path and keep the code', () => {
  const windows = filesystemError('ENOENT', 'stat', 'C:\\motion-data\\workspace\\probe.md');
  const message = clientErrorMessage(windows, 'fallback');
  assert.equal(isFilesystemError(windows), true);
  assert(!message.includes('C:\\'), message);
  assert(!message.includes('motion-data'), message);
  assert(message.includes('ENOENT'), message);

  const posix = filesystemError('EACCES', 'open', '/srv/motion/workspace/project.md');
  const posixMessage = clientErrorMessage(posix, 'fallback');
  assert(!posixMessage.includes('/srv/motion'), posixMessage);
  assert(posixMessage.includes('EACCES'), posixMessage);
});

test('every errno that carries the resolved path is masked, not only a short list', () => {
  // Directory preparation collides with a regular file, and removal of a non-empty
  // directory, both reach the workspace with `path` set and an errno outside a short list.
  for (const [code, syscall] of [['EEXIST', 'mkdir'], ['ENOTEMPTY', 'rmdir'], ['EIO', 'open'], ['EDQUOT', 'write'], ['EFBIG', 'write']]) {
    const error = filesystemError(code, syscall, '/srv/motion/workspace/nested');
    assert.equal(isFilesystemError(error), true, code);
    assert(!clientErrorMessage(error, 'fallback').includes('/srv/motion'), code);
  }
});

test('application errors keep their own message', () => {
  // Brand Kit "not found" reuses the ENOENT code but is not a node:fs error.
  assert.equal(clientErrorMessage(Object.assign(new Error('Brand Kit not found'), { code: 'ENOENT' }), 'fallback'), 'Brand Kit not found');
  assert.equal(clientErrorMessage(new Error('INVALID_ARGUMENT: projectId is required'), 'fallback'), 'INVALID_ARGUMENT: projectId is required');
  assert.equal(clientErrorMessage(new Error('PROJECT_SCOPE_MISMATCH'), 'fallback'), 'PROJECT_SCOPE_MISMATCH');
  assert.equal(isFilesystemError(Object.assign(new Error('Brand Kit not found'), { code: 'ENOENT' })), false);
});

test('non-error values use the caller fallback', () => {
  assert.equal(clientErrorMessage('boom', 'Tool failed'), 'Tool failed');
  assert.equal(clientErrorMessage(undefined, '操作失败'), '操作失败');
  assert.equal(isFilesystemError({ code: 'ENOENT' }), false);
});

test('a filesystem failure inside a request is reported and replayed masked', async () => {
  await fixture(async store => {
    const service = new Phase1Service(store, pluginRoot, {
      origin: () => 'http://127.0.0.1:4173', nativeUrl: () => undefined, openProject: async () => {}, mutation: async task => task(), cancel: async () => {},
    });
    // A font import skips the native runtime, so the missing source reaches node:fs and fails with the
    // resolved absolute path in the message.
    const sourcePath = path.join(store.directory, 'missing-font.ttf');
    const args = { projectId: store.projectId, requestId: crypto.randomUUID(), items: [{ itemId: crypto.randomUUID(), sourcePath }] };
    const first = await service.call('openmotion_import_assets', args) as any;
    // The second call returns the stored result, so the recorded text has to be safe already.
    const replay = await service.call('openmotion_import_assets', args) as any;
    for (const [label, result] of [['first', first], ['replay', replay]] as const) {
      const failure = result.items[0];
      assert.equal(failure.status, 'failed', label);
      assert(!String(failure.error).includes(store.directory), `${label} leaked the path: ${failure.error}`);
      assert(!String(failure.error).includes('missing-font.ttf'), `${label} leaked the file name: ${failure.error}`);
    }
  });
});

test('the phase-one HTTP bridge masks a filesystem failure and keeps a stable code', async () => {
  await fixture(async store => {
    // The bridge rebuilds tool errors from JSON, so masking has to happen before it
    // serializes them; the MCP side cannot classify a round-tripped error.
    const failure = filesystemError('ENOENT', 'stat', `${store.directory}/projects/demo/index.html`);
    // The first attempt carries the errno fields; the retry replays the recorded failure, which has
    // the masked text and only the stored code left.
    let attempt = 0;
    const context = {
      runtimeRoot: '/runtime',
      phase1: { call: async () => {
        attempt += 1;
        if (attempt === 1) throw failure;
        throw Object.assign(new Error('The local file operation failed (ENOENT). Check that the project files still exist and try again.'), { code: 'FILE_OPERATION_FAILED' });
      } },
    } as unknown as Service;
    const request = transport(store, context);
    const call = () => request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'openmotion_get_project', arguments: {} }),
    });

    const response = await call();
    assert.equal(response.status, 400);
    const body = await response.json();
    assert(!String(body.error).includes(store.directory), String(body.error));
    assert(body.error.includes('ENOENT'), String(body.error));
    assert.equal(body.code, 'FILE_OPERATION_FAILED');

    const replay = await call();
    assert.equal(replay.status, 400);
    const replayBody = await replay.json();
    assert(!String(replayBody.error).includes(store.directory), String(replayBody.error));
    assert.equal(replayBody.code, 'FILE_OPERATION_FAILED');
  });
});