import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import { PREVIEW_FIRST_FRAME } from '../../src/studio/engine/preview-first-frame.ts';
import { PREVIEW_BRIDGE_SCRIPT } from '../../src/studio/engine/preview-bridge.ts';

function media(start = 0) {
  return {
    tagName: 'VIDEO', readyState: 0, error: null as unknown, preload: 'metadata', currentSrc: 'video.mp4',
    hasAttribute: (name: string) => name === 'data-start',
    getAttribute: (name: string) => name === 'data-start' ? String(start) : name === 'data-duration' ? '5' : null,
    parentElement: undefined, checkVisibility: () => true,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120 }),
  };
}
it('waits for the visible frame, ignoring future and hidden media, then releases the list', () => {
  const visible = media(), later = media(5), hidden = { ...media(), checkVisibility: () => false };
  let scans = 0;
  const visualFrameStatus = runInNewContext(PREVIEW_FIRST_FRAME + '\nvisualFrameStatus', {
    document: { querySelectorAll: () => { scans++; return [visible, later, hidden]; } }, innerWidth: 320, innerHeight: 180,
  });
  assert.equal(visualFrameStatus(0), 'loading');
  assert.equal(visible.preload, 'auto');
  assert.equal(later.preload, 'metadata');
  assert.equal(hidden.preload, 'metadata');
  visible.readyState = 2;
  assert.equal(visualFrameStatus(0), 'ready');
  assert.equal(visualFrameStatus(10), 'ready');
  assert.equal(scans, 1);
});
it('settles on media errors so that the host can offer a retry', () => {
  const item = media();
  item.error = { code: 4 };
  const status = runInNewContext(PREVIEW_FIRST_FRAME + '\nvisualFrameStatus(0)', {
    document: { querySelectorAll: () => [item] }, innerWidth: 320, innerHeight: 180,
  });
  assert.equal(status, 'error');
});

it('rechecks a replacement for a still-loading DOM node', () => {
  const old = { ...media(), isConnected: true }, fresh = media();
  let nodes = [old];
  const status = runInNewContext(PREVIEW_FIRST_FRAME + '\nvisualFrameStatus', {
    document: { querySelectorAll: () => nodes }, innerWidth: 320, innerHeight: 180,
  });
  assert.equal(status(0), 'loading');
  old.isConnected = false;
  nodes = [{ ...fresh, readyState: 2, isConnected: true }];
  assert.equal(status(0), 'ready');
});

it('re-evaluates visible media when a restore seek moves to another scene before frame 0 settles', () => {
  const scene0 = media(0);
  const scene2 = { ...media(10), readyState: 2 };
  const status = runInNewContext(PREVIEW_FIRST_FRAME + '\nvisualFrameStatus', {
    document: { querySelectorAll: () => [scene0, scene2] }, innerWidth: 320, innerHeight: 180,
  });
  assert.equal(status(0), 'loading');
  assert.equal(status(12), 'ready');
});

it('awaits seek completion and two paint frames before acknowledging playback-control waitForPaint seek', async () => {
  const document = parseHTMLContent('<html><body><div data-composition-id="main" data-duration="20"></div></body></html>');
  const script = document.createElement('script');
  script.setAttribute('data-openmotion-preview', JSON.stringify({
    projectId: 'p', compositionPath: 'index.html', sourceVersions: {},
  }));
  Object.defineProperty(document, 'currentScript', { value: script });
  const sent: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (msg: Record<string, unknown>) => sent.push(msg) };
  const seekLog: number[] = [];
  let currentTime = 0;
  const player = {
    getTime: () => currentTime,
    getDuration: () => 20,
    isPlaying: () => false,
    seek: (time: number) => { currentTime = time; seekLog.push(time); },
    pause: () => {},
  };
  let releaseSeek!: () => void;
  const seekGate = new Promise<void>((resolve) => { releaseSeek = resolve; });
  const rafQueue: Array<() => void> = [];
  let onMessage!: (event: unknown) => void;
  const window = {
    parent,
    __player: player,
    __hfWaitForSeekCompletion: () => seekGate,
    addEventListener: (event: string, handler: typeof onMessage) => { if (event === 'message') onMessage = handler; },
  };
  runInNewContext(PREVIEW_BRIDGE_SCRIPT, {
    window,
    document,
    URL,
    CSS: { escape: (s: string) => s },
    crypto: { randomUUID: () => 'doc-1' },
    setInterval() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; },
    innerWidth: 1920,
    innerHeight: 1080,
    location: { href: 'https://preview.test/api/projects/p/preview?pt=grant' },
  });

  sent.length = 0;
  onMessage({
    source: parent,
    origin: 'https://studio.test',
    data: {
      source: 'openmotion-studio',
      version: 1,
      type: 'playback-control',
      projectId: 'p',
      token: 'grant',
      requestId: 'req-seek-paint',
      action: 'seek',
      time: 12.5,
      reseek: true,
      waitForPaint: true,
    },
  });

  // Guard seek + target seek ran synchronously; response waits for seek completion + 2 rAFs.
  assert.deepEqual(seekLog, [12.499, 12.5]);
  assert.equal(sent.some((m) => m.type === 'response' && m.requestId === 'req-seek-paint'), false);

  releaseSeek();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rafQueue.length, 1);
  assert.equal(sent.some((m) => m.type === 'response' && m.requestId === 'req-seek-paint'), false);

  rafQueue.shift()!();
  assert.equal(rafQueue.length, 1);
  assert.equal(sent.some((m) => m.type === 'response' && m.requestId === 'req-seek-paint'), false);

  rafQueue.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  const response = sent.find((m) => m.type === 'response' && m.requestId === 'req-seek-paint');
  assert.equal(response?.ok, true);
  assert.equal((response?.result as { currentTime?: number })?.currentTime, 12.5);
});
