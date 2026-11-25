// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analyzeMusicFromUrl } from '@hyperframes/core/beats';
import { usePlayerStore } from '../player/store/playerStore';
import { useMusicBeatAnalysis } from './useMusicBeatAnalysis';

vi.mock('@hyperframes/core/beats', async importOriginal => ({
  ...await importOriginal<typeof import('@hyperframes/core/beats')>(),
  analyzeMusicFromUrl: vi.fn().mockRejectedValue(new Error('no media in DOM test')),
}));
vi.mock('../contexts/FileManagerContext', () => ({
  useFileManagerContextOptional: () => ({ readOptionalProjectFile: async () => '', writeProjectFile: async () => {} }),
}));

let root: Root;
function Probe() { useMusicBeatAnalysis(); return null; }

beforeEach(() => {
  vi.useFakeTimers();
  usePlayerStore.setState({ timelineProjectId: 'demo', previewBooted: false, elements: [
    { id: 'audio-1', tag: 'audio', src: 'assets/clip.mp3', start: 0, duration: 4, track: 1 },
  ] });
  root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
  vi.useRealTimers();
});

it('lets the first frame load before downloading audio for automatic beat detection', async () => {
  expect(analyzeMusicFromUrl).not.toHaveBeenCalled();
  await act(async () => usePlayerStore.getState().markPreviewBooted());
  expect(analyzeMusicFromUrl).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(analyzeMusicFromUrl).toHaveBeenCalledOnce();
});

it('still analyzes when the preview never boots', async () => {
  await vi.advanceTimersByTimeAsync(8_000);
  expect(analyzeMusicFromUrl).toHaveBeenCalledOnce();
});
