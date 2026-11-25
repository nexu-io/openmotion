// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished, vi } from 'vitest';
import { orderedEditFixture } from '../../tests/orderedEditFixture';
import { TimelineHistoryButtons } from '../components/TimelineHistoryButtons';
import { mountedCanvasVersion } from '../components/editor/isolatedSourceTarget';
import { usePlayerStore } from '../player/store/playerStore';
import { setCachedCloudDisklessMode } from '../utils/cloudRuntime';
import { saveCloudTimeline } from '../utils/cloudTimelineEdit';
import { submitStudioCommands } from '../utils/projectEditBatch';
import { trackStudioPendingEdit } from '../utils/studioPendingEdits';
import { StudioFileConflictError } from '../utils/studioSaveDiagnostics';
import { useEditHistoryActions } from './useEditHistoryActions';
import { usePersistentEditHistory } from './usePersistentEditHistory';
import { usePreviewPersistence } from './usePreviewPersistence';
import { useProjectFileWriter } from './useProjectFileWriter';

const html = '<div data-composition-id="scene" data-hf-id="scene" data-duration="8"><div id="picture" data-hf-id="picture" data-start="0" data-duration="1" style="position:absolute;left:0px;top:0px;width:80px;height:60px"></div></div>';

// Real ordered writes (including precondition checks), source reads, toolbar and history actions.
// The HTTP history endpoint restores exactly the bytes captured after the first write.
async function editor(project: string, path: string, activePath: string | null, knownPath = path) {
  setCachedCloudDisklessMode(true);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onTestFinished(() => { setCachedCloudDisklessMode(null); vi.unstubAllGlobals(); });
  const db = orderedEditFixture(project, { [path]: html });
  const start = (await db.getVersion(path))!;
  const frame = document.body.appendChild(document.createElement('iframe'));
  const doc = frame.contentDocument!;
  doc.body.innerHTML = html;
  const stamp = doc.createElement('script');
  stamp.setAttribute('data-openmotion-source-versions', '');
  stamp.textContent = JSON.stringify({projectId: project, sourceVersions: { [path]: start }});
  doc.head.append(stamp);
  const frameRef = { current: frame }, pathRef = { current: activePath };
  usePlayerStore.setState({timelineProjectId: project});
  onTestFinished(() => { frame.remove(); usePlayerStore.setState({timelineProjectId: null}); });

  let first = '', steps = 0;
  const ack = Promise.withResolvers<void>(), sent = Promise.withResolvers<void>();
  let holdReceipt = false;
  const nav = { id: 'second', label: 'Move', paths: [knownPath], endedAt: 1000 };
  const navigation = () => ({ currentSeq: steps ? 1 : 2, back: nav, forward: steps ? nav : null });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/history/step')) {
      expect(JSON.parse(String(init?.body))).toEqual({direction: 'back'});
      steps++;
      db.replaceFile(path, first);
      return Response.json({ok: true, appliedFiles: [path], stepLabel: 'Move', navigation: navigation()});
    }
    if (String(input).includes('/history?')) return Response.json({...navigation(), entries: []});
    const response = await db.request(input, init);
    if (holdReceipt && init?.method === 'POST') {
      holdReceipt = false;
      sent.resolve();
      await ack.promise;
    }
    return response;
  });
  const host = document.createElement('div'), root = createRoot(host);
  let done: Promise<void> | undefined;
  const toast = vi.fn(), reload = vi.fn();
  function Harness() {
    const history = usePersistentEditHistory({projectId: project});
    const writer = useProjectFileWriter({projectId: project});
    const preview = usePreviewPersistence({ ...writer, previewIframeRef: frameRef, activeCompPathRef: pathRef,
      showToast: toast, recordEdit: history.recordEdit, reloadPreview: reload });
    const actions = useEditHistoryActions({ ...writer, editHistory: history, showToast: toast, activeCompPath: activePath,
      projectId: project, syncHistoryPreviewAfterApply: preview.syncHistoryPreviewAfterApply,
      waitForPendingDomEditSaves: preview.settlePendingEdits });
    return <TimelineHistoryButtons canUndo={history.canUndo} onUndo={() => { done = actions.undo(); }} />;
  }
  await act(async () => root.render(<Harness />));
  onTestFinished(() => act(() => root.unmount()));
  return { db, start, doc, toast, reload, steps: () => steps, capture: () => { first = db.files[path]!; },
    holdNextReceipt: () => { holdReceipt = true; return {sent: sent.promise, release: ack.resolve}; },
    clickUndo() {
      const button = host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!;
      expect(button.disabled).toBe(false);
      button.click();
      return done!;
    } };
}

it.each([
  { view: 'standalone', path: 'compositions/reel.html', active: 'compositions/reel.html', pending: false },
  { view: 'master', path: 'index.html', active: null, pending: true },
])('saves the next canvas move on the same $view after two moves and toolbar Undo', async ({view, path, active, pending}) => {
  const project = 'history-canvas-' + view;
  const {db, start, doc, toast, reload, capture, clickUndo, steps, holdNextReceipt} = await editor(project, path, active);
  const move = (left: number, version: string) => submitStudioCommands(project, [{ kind: 'setCanvasBox', compositionPath: path,
    target: {id: 'picture'}, box: {left, top: 0, width: 80 + left, height: 60, makeRelative: false} }], {[path]:version});
  await move(10, start);
  capture();
  const first = db.files[path]!, firstVersion = (await db.getVersion(path))!;
  const held = pending ? holdNextReceipt() : null;
  const second = move(20, start);
  trackStudioPendingEdit(second);
  await (held ? held.sent : second);
  doc.body.innerHTML = db.files[path]!;
  expect(doc.getElementById('picture')?.style.left).toBe('20px');
  await act(async () => {
    const undo = clickUndo();
    expect(steps()).toBe(0);
    held?.release();
    await second; await undo;
  });
  expect(steps()).toBe(1);
  expect(db.files[path]).toBe(first);
  expect(toast).toHaveBeenCalledWith('Move', 'info');
  expect(reload).not.toHaveBeenCalled();
  expect(doc.getElementById('picture')?.style.left).toBe('10px');
  // A soft restore kept the original same-origin doc. An isolated preview that
  // reloaded instead reports the restored source version in its next measurement.
  const shown = pending ? mountedCanvasVersion(doc, project, path)! : firstVersion;
  await move(35, shown);
  expect(db.packets.at(-1)?.[0]?.files[0]?.baseVersion).toBe(firstVersion);
  expect(db.files[path]).toMatch(/left:\s*35px/);
  const peer = db.files[path]!.replace(/left:\s*35px/, 'left:90px');
  db.replaceFile(path, peer);
  await expect(move(50, shown)).rejects.toBeInstanceOf(StudioFileConflictError);
  expect(db.files[path]).toBe(peer);
});

it('moves a timeline clip again after undo when the navigation read had not caught up with its save', async () => {
  const project = 'history-timeline', path = 'index.html';
  const {db, capture, clickUndo} = await editor(project, path, null, 'previous.txt');
  const move = (start: number) => saveCloudTimeline(project, [{path, command: {kind: 'moveClips', changes: [{hfId:'picture', start}]}}],
    async () => {}, async () => {}, 'Move clip');
  await move(1); capture();
  const first = db.files[path]!, version = await db.getVersion(path);
  await move(2);
  await act(() => clickUndo());
  expect(db.files[path]).toBe(first);
  await move(3);
  expect(db.packets.at(-1)?.[0]?.files[0]?.baseVersion).toBe(version);
  expect(db.files[path]).toMatch(/data-start="3"/);
});
