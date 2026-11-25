// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setCachedCloudDisklessMode } from '../utils/cloudRuntime';
import { resolveWorkspaceRoute } from './resolveWorkspaceRoute';

const projectId = '11111111-1111-1111-1111-111111111111';
const sessionId = '22222222-2222-2222-2222-222222222222';
const artifactId = '33333333-3333-3333-3333-333333333333';
const artifact = { kind: 'motion-project', projectId, id: artifactId, title: 'Film' };
const opened = { sessionId, projectId, artifact };
const catalog = { activeId: projectId, projects: [{ id: projectId }], sessions: [{ id: sessionId,
  activeArtifactId: artifactId, artifacts: [artifact] }] };
const path = '/motion-api/preview/open?projectId=' + projectId;
const signal = new AbortController().signal;
const fetcher = vi.fn<(path: string, options?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  setCachedCloudDisklessMode(true);
  vi.stubGlobal('fetch', fetcher.mockReset());
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCachedCloudDisklessMode(null);
});

it.each([null, sessionId])('opens an explicit cloud project in one scoped request (session %s)', async session => {
  fetcher.mockResolvedValue(Response.json(opened));
  await expect(resolveWorkspaceRoute(projectId, session, false, signal)).resolves.toEqual({ sessionId, artifact });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(path, { method: 'POST', signal, priority: 'high' });
});

it.each([401, 403, 404, 409])('propagates scoped open HTTP %s without retrying through other endpoints', async status => {
  fetcher.mockResolvedValue(Response.json({ error: 'Could not open this project' }, { status }));
  await expect(resolveWorkspaceRoute(projectId, sessionId, false, signal)).rejects.toMatchObject({ status });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  { ...opened, sessionId: artifactId },
  { ...opened, projectId: artifactId },
  { ...opened, artifact: { ...artifact, projectId: artifactId } },
  { ...opened, artifact: null },
  {},
])('rejects an inconsistent response from the scoped open', async receipt => {
  fetcher.mockResolvedValue(Response.json(receipt));
  await expect(resolveWorkspaceRoute(projectId, sessionId, false, signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('reads identities from an older cloud catalog without opening the preview twice', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ projectId, sessionId })).mockResolvedValueOnce(Response.json(catalog));
  await expect(resolveWorkspaceRoute(projectId, sessionId, false, signal)).resolves.toEqual({ sessionId, artifact });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([path, '/motion-api/projects']);
});

it('uses the catalog active artifact on a cloud session-only bookmark', async () => {
  fetcher.mockResolvedValueOnce(Response.json(catalog)).mockResolvedValueOnce(Response.json(opened));
  await expect(resolveWorkspaceRoute(null, sessionId, false, signal)).resolves.toEqual({ sessionId, artifact });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/motion-api/projects', path]);
});

it('discards a late successful scoped response after navigation is superseded', async () => {
  const controller = new AbortController();
  const response = Promise.withResolvers<Response>();
  fetcher.mockReturnValueOnce(response.promise);
  const resolving = resolveWorkspaceRoute(projectId, sessionId, false, controller.signal);
  controller.abort();
  response.resolve(Response.json(opened));
  await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('refuses a project removed from an older cloud catalog during navigation', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ projectId, sessionId }))
    .mockResolvedValueOnce(Response.json({ ...catalog, projects: [] }));
  await expect(resolveWorkspaceRoute(projectId, sessionId, false, signal)).rejects.toThrow('项目不存在');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([path, '/motion-api/projects']);
});
