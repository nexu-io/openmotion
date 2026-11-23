import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PREVIEW_ASSET_READINESS } from '../../src/studio/engine/preview-asset-readiness.ts';

function createFakeImg(src: string, opts: { lazy?: boolean; complete?: boolean; naturalWidth?: number } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  let currentSrc = src;
  let complete = opts.complete ?? false;
  let naturalWidth = opts.naturalWidth ?? 0;
  return {
    tagName: 'IMG',
    loading: opts.lazy ? 'lazy' : 'eager',
    isConnected: true,
    get src() { return currentSrc; },
    set src(val: string) { currentSrc = val; },
    get currentSrc() { return currentSrc; },
    get complete() { return complete; },
    get naturalWidth() { return naturalWidth; },
    getAttribute(name: string) { return name === 'src' ? currentSrc : null; },
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    triggerLoad() {
      complete = true;
      naturalWidth = 320;
      for (const fn of [...(listeners.get('load') ?? [])]) fn();
    },
    triggerError() {
      complete = true;
      naturalWidth = 0;
      for (const fn of [...(listeners.get('error') ?? [])]) fn();
    },
  };
}

function createFakeVideo(src: string, hidden = false) {
  const listeners = new Map<string, Set<() => void>>();
  let currentSrc = src;
  let readyState = 0;
  let networkState = 0;
  return {
    tagName: 'VIDEO',
    preload: 'none',
    error: null,
    isConnected: true,
    get src() { return currentSrc; },
    set src(val: string) { currentSrc = val; },
    get currentSrc() { return currentSrc; },
    get readyState() { return readyState; },
    get networkState() { return networkState; },
    hasAttribute(name: string) { return hidden && name === 'data-hf-clip-hidden'; },
    getAttribute(name: string) { return name === 'src' ? currentSrc : null; },
    load() { networkState = 2; },
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    triggerLoaded() {
      readyState = 2;
      for (const fn of [...(listeners.get('loadeddata') ?? [])]) fn();
    },
  };
}

it('promotes lazy images, caps concurrent video preloads, and settles once ready', () => {
  const img = createFakeImg('/assets/slide.png', { lazy: true });
  const videos = [1, 2, 3, 4].map((n) => createFakeVideo(`/assets/v${n}.mp4`));
  const hiddenVideo = createFakeVideo('/assets/hidden.mp4', true);
  const snapshots: Array<{ status: string; completed: number; total: number; failed: unknown[] }> = [];

  const tracker = runInNewContext(
    `${PREVIEW_ASSET_READINESS}\ncreateAssetTracker(onChange)`,
    {
      URL,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      location: { href: 'https://preview.test/index.html', origin: 'https://preview.test' },
      window: {},
      document: {
        baseURI: 'https://preview.test/index.html',
        querySelectorAll(selector: string) {
          if (selector.includes('img')) return [img];
          if (selector === 'video') return [...videos, hiddenVideo];
          return [];
        },
      },
      onChange: (snap: { status: string; completed: number; total: number; failed: unknown[] }) => {
        snapshots.push(JSON.parse(JSON.stringify(snap)));
      },
    },
  );

  try {
    assert.equal(img.loading, 'eager');
    assert.equal(hiddenVideo.preload, 'none');
    // MAX_VIDEO_PRELOADS = 3
    assert.equal(videos[0].preload, 'auto');
    assert.equal(videos[1].preload, 'auto');
    assert.equal(videos[2].preload, 'auto');
    assert.equal(videos[3].preload, 'none');
    assert.deepEqual(snapshots.at(-1), { status: 'loading', completed: 0, total: 5, failed: [] });

    img.triggerLoad();
    videos[0].triggerLoaded();
    assert.equal(videos[3].preload, 'auto');
    videos[1].triggerLoaded();
    videos[2].triggerLoaded();
    videos[3].triggerLoaded();

    assert.deepEqual(snapshots.at(-1), { status: 'ready', completed: 5, total: 5, failed: [] });
  } finally {
    tracker.dispose();
  }
});

it('fast-fails 404 assets and supports retryFailed recovery', async () => {
  const broken = createFakeImg('https://preview.test/assets/missing.png');
  const ok = createFakeImg('https://preview.test/assets/ok.png');
  const snapshots: Array<{ status: string; completed: number; total: number; failed: Array<{ label: string; reason: string }> }> = [];

  const tracker = runInNewContext(
    `${PREVIEW_ASSET_READINESS}\ncreateAssetTracker(onChange)`,
    {
      URL,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: async () => ({ status: 404, type: 'basic' }),
      location: { href: 'https://preview.test/index.html', origin: 'https://preview.test' },
      window: {},
      document: {
        baseURI: 'https://preview.test/index.html',
        querySelectorAll(selector: string) {
          if (selector.includes('img')) return [broken, ok];
          return [];
        },
      },
      onChange: (snap: { status: string; completed: number; total: number; failed: Array<{ label: string; reason: string }> }) => {
        snapshots.push(snap);
      },
    },
  );

  try {
    broken.triggerError();
    await new Promise((r) => setTimeout(r, 10));
    ok.triggerLoad();

    const settled = snapshots.at(-1);
    assert.equal(settled?.status, 'ready');
    assert.equal(settled?.completed, 2);
    assert.equal(settled?.total, 2);
    assert.equal(settled?.failed.length, 1);
    assert.equal(settled?.failed[0]?.label, 'missing.png');

    const retried = await new Promise<{ failed: unknown[] }>((resolve) => {
      tracker.retryFailed(resolve);
      assert.match(broken.src, /_omRetry=3/);
      broken.triggerLoad();
    });
    assert.equal(retried.failed.length, 0);
  } finally {
    tracker.dispose();
  }
});
