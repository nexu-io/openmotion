// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { StudioApp } from '../App';
import { getMotionProjectEditor, preloadMotionProjectEditor } from './MotionProjectEditor';

vi.mock('../App', () => ({ StudioApp: () => null }));

it('mounts the resolved editor directly after its speculative import finishes', async () => {
  expect(getMotionProjectEditor()).not.toBe(StudioApp);
  const pending = preloadMotionProjectEditor();
  expect(preloadMotionProjectEditor()).toBe(pending);
  await vi.dynamicImportSettled();
  expect(getMotionProjectEditor()).toBe(StudioApp);
  expect(preloadMotionProjectEditor()).toBe(pending);
});
