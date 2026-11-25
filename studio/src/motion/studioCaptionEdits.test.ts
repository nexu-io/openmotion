// @vitest-environment happy-dom
import { expect, it, onTestFinished, vi } from 'vitest';
import { setCachedCloudDisklessMode } from '../utils/cloudRuntime';
import { orderedEditFixture } from '../../tests/orderedEditFixture';
import type { StudioShellValue } from '../contexts/StudioContext';
import { openTimelineSource } from '../player/lib/peerTimeline';
import { usePlayerStore } from '../player/store/playerStore';
import { editStudioCaptions, readStudioCaptionTracks } from './studioCaptionEdits';

const path = 'compositions/intro.html';
const html = '<main data-composition-id="intro" data-width="1920" data-height="1080" data-duration="10"></main>';
function openProject() {
  const projectId = crypto.randomUUID();
  setCachedCloudDisklessMode(true);
  onTestFinished(() => setCachedCloudDisklessMode(null));
  const shell = {
    projectId, activeCompPath: path, previewIframeRef: { current: null }, recordEdit: vi.fn(async () => {}), reloadPreview: vi.fn(),
  };
  usePlayerStore.setState({ timelineProjectId: projectId, elements: [], duration: 10 });
  onTestFinished(openTimelineSource(projectId, path));
  onTestFinished(() => { vi.unstubAllGlobals(); usePlayerStore.setState({ timelineProjectId: null, elements: [] }); });
  return { projectId, shell: shell as unknown as StudioShellValue, record: shell.recordEdit };
}
const segments = [{ id: 'line', text: 'Opening', start: 0, end: 2 }];
it('uses the same projected caption source in the panel, timeline and ordered transport before a save returns', async () => {
  const { projectId, shell, record } = openProject();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = orderedEditFixture(projectId, { [path]: html }, () => gate);
  let trackId = '';
  const add = editStudioCaptions(shell, { command: 'caption_add', segments }, id => { trackId = id; });
  await vi.waitFor(() => { expect(trackId).toBeTruthy(); expect(server.packets).toHaveLength(1); });
  expect(usePlayerStore.getState().elements.some(element => element.domId?.includes(trackId))).toBe(true);
  const color = editStudioCaptions(shell, { command: 'caption_update', transcriptId: trackId, captionSettings: { preset: 'card' } });
  const hide = editStudioCaptions(shell, { command: 'caption_toggle', visible: false });
  const imported = editStudioCaptions(shell, { command: 'caption_add', textKind: 'text', segments: [{ ...segments[0]!, text: 'Title' }] });
  const tracks = await readStudioCaptionTracks(projectId, path);
  expect(tracks.find(t => t.id === trackId)).toMatchObject({ cueCount: 1, settings: { preset: 'card', visible: false } });
  expect(tracks.find(t => t.kind === 'text')).toMatchObject({ cueCount: 1 });
  expect(server.files[path]).toBe(html);
  expect(record).not.toHaveBeenCalled();
  release(); await Promise.all([add, color, hide, imported]);
  expect(server.packets.map(packet => packet.length)).toEqual([1, 3]);
  const following = server.packets[1]!;
  expect(following[1]!.files[0]!.baseVersion).toEqual({after: following[0]!.id});
  expect(following[2]!.files[0]!.baseVersion).toEqual({after: following[1]!.id});
  expect(record).toHaveBeenCalledTimes(4);
  expect(await readStudioCaptionTracks(projectId, path)).toEqual(tracks);
  expect(server.files[path]).toContain('Opening');
  expect(server.files[path]).toContain('Title');
  expect(server.request.mock.calls.filter(([url]) => String(url).includes('/files/'))).toHaveLength(1);
});

it('rolls back a rejected optimistic caption and accepts a fresh SRT import on the same file', async () => {
  const { projectId, shell, record } = openProject();
  let fail = true;
  const server = orderedEditFixture(projectId, { [path]: html }, () => fail
    ? Response.json({ committed: [], failed: { id: server.packets.at(-1)![0]!.id, path, status: 409, code: 'VERSION_CONFLICT', message: 'File changed before this edit' } })
    : undefined);
  await expect(editStudioCaptions(shell, { command: 'caption_add', segments })).rejects.toThrow();
  expect(await readStudioCaptionTracks(projectId, path)).toEqual([]);
  expect(usePlayerStore.getState().elements).toHaveLength(0);
  expect(record).not.toHaveBeenCalled();
  fail = false;
  await editStudioCaptions(shell, { command: 'caption_add', subtitles: '1\n00:00:00,000 --> 00:00:02,000\nAfter retry' });
  expect(server.files[path]).toContain('After retry');
  expect(await readStudioCaptionTracks(projectId, path)).toHaveLength(1);
});

it('writes through the conditional file writer and keeps undo on the standalone file server', async () => {
  const { projectId, shell, record } = openProject();
  setCachedCloudDisklessMode(false);
  let content = html;
  const reads = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toContain('/files/' + encodeURIComponent(path));
    expect(init?.method ?? 'GET').toBe('GET');
    return Response.json({ content, version: '"native-file"' });
  });
  vi.stubGlobal('fetch', reads);
  shell.writeProjectFile = vi.fn(async (_path: string, after: string, before?: string) => {
    expect(before).toBe(content);
    content = after;
  });
  await Promise.all([
    editStudioCaptions(shell, { command: 'caption_add', segments }),
    editStudioCaptions(shell, { command: 'caption_toggle', visible: false }),
  ]);
  expect(record).toHaveBeenCalledTimes(2);
  expect(shell.writeProjectFile).toHaveBeenCalledTimes(2);
  expect((await readStudioCaptionTracks(projectId, path))[0]).toMatchObject({ settings: { visible: false } });
});
