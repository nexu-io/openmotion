import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import { PREVIEW_ASSET_READINESS } from '../../src/studio/engine/preview-asset-readiness.ts';
import { bridgeDocumentTags, PREVIEW_BRIDGE_SCRIPT } from '../../src/studio/engine/preview-bridge.ts';

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
    triggerError() {
      for (const fn of [...(listeners.get('error') ?? [])]) fn();
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
    assert.deepEqual(snapshots.at(-1), { status: 'loading', completed: 0, total: 5, failed: [], pendingAsset: 'slide.png' });

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

it('keeps the item deadline active during a stalled HEAD probe and releases video slots on timeout', () => {
  const stalledImg = createFakeImg('https://preview.test/assets/stalled.png');
  const videos = [1, 2, 3, 4].map((n) => createFakeVideo(`https://preview.test/assets/v${n}.mp4`));
  const snapshots: Array<{
    status: string;
    completed: number;
    total: number;
    failed: Array<{ id: string; label: string; kind: string; reason: string }>;
  }> = [];

  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const fakeSetTimeout = (fn: () => void, ms = 0) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + Math.max(0, ms), fn });
    return id;
  };
  const fakeClearTimeout = (id: number) => {
    timers.delete(id);
  };
  const advanceBy = (ms: number) => {
    const target = now + ms;
    while (true) {
      let earliestId: number | null = null;
      let earliestAt = Infinity;
      for (const [id, entry] of timers) {
        if (entry.at <= target && entry.at < earliestAt) {
          earliestAt = entry.at;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const next = timers.get(earliestId)!;
      timers.delete(earliestId);
      now = next.at;
      next.fn();
    }
    now = target;
  };

  const probeSignals: AbortSignal[] = [];
  const tracker = runInNewContext(
    `${PREVIEW_ASSET_READINESS}\ncreateAssetTracker(onChange)`,
    {
      URL,
      AbortController,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      setInterval,
      clearInterval,
      fetch: (_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) probeSignals.push(init.signal);
        return new Promise(() => {});
      },
      location: { href: 'https://preview.test/index.html', origin: 'https://preview.test' },
      window: {},
      document: {
        baseURI: 'https://preview.test/index.html',
        querySelectorAll(selector: string) {
          if (selector.includes('img')) return [stalledImg];
          if (selector === 'video') return videos;
          return [];
        },
      },
      onChange: (snap: {
        status: string;
        completed: number;
        total: number;
        failed: Array<{ id: string; label: string; kind: string; reason: string }>;
      }) => {
        snapshots.push(JSON.parse(JSON.stringify(snap)));
      },
    },
  );

  try {
    // 3 video slots occupied; v4 waits in queue.
    assert.equal(videos[3].preload, 'none');

    // Trigger image + v1 errors whose same-origin HEAD probes stall indefinitely.
    stalledImg.triggerError();
    videos[0].triggerError();
    assert.equal(probeSignals.length, 2);
    assert.equal(probeSignals[0]?.aborted, false);
    assert.equal(probeSignals[1]?.aborted, false);

    // Other two active videos load normally before the 10s deadline.
    videos[1].triggerLoaded();
    videos[2].triggerLoaded();
    // Freeing v2/v3 already started v4; complete v4 too so only stalled image + v1 remain.
    assert.equal(videos[3].preload, 'auto');
    videos[3].triggerLoaded();
    assert.equal(snapshots.at(-1)?.status, 'loading');

    // Advancing past the 10s deadline aborts both stalled HEAD probes and unlocks cleanly.
    advanceBy(10_000);
    assert.equal(probeSignals[0]?.aborted, true);
    assert.equal(probeSignals[1]?.aborted, true);
    assert.deepEqual(snapshots.at(-1), {
      status: 'ready',
      completed: 5,
      total: 5,
      failed: [
        { id: 'img-0', label: 'stalled.png', kind: 'image', reason: 'timeout' },
        { id: 'video-0', label: 'v1.mp4', kind: 'video', reason: 'timeout' },
      ],
    });
  } finally {
    tracker.dispose();
  }
});

it('frees the video concurrency slot when all active video slots stall on HEAD probes', () => {
  const videos = [1, 2, 3, 4].map((n) => createFakeVideo(`https://preview.test/assets/v${n}.mp4`));
  const snapshots: Array<{
    status: string;
    completed: number;
    total: number;
    failed: Array<{ id: string; reason: string }>;
  }> = [];

  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const fakeSetTimeout = (fn: () => void, ms = 0) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + Math.max(0, ms), fn });
    return id;
  };
  const fakeClearTimeout = (id: number) => {
    timers.delete(id);
  };
  const advanceBy = (ms: number) => {
    const target = now + ms;
    while (true) {
      let earliestId: number | null = null;
      let earliestAt = Infinity;
      for (const [id, entry] of timers) {
        if (entry.at <= target && entry.at < earliestAt) {
          earliestAt = entry.at;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const next = timers.get(earliestId)!;
      timers.delete(earliestId);
      now = next.at;
      next.fn();
    }
    now = target;
  };

  const tracker = runInNewContext(
    `${PREVIEW_ASSET_READINESS}\ncreateAssetTracker(onChange)`,
    {
      URL,
      AbortController,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      setInterval,
      clearInterval,
      fetch: () => new Promise(() => {}),
      location: { href: 'https://preview.test/index.html', origin: 'https://preview.test' },
      window: {},
      document: {
        baseURI: 'https://preview.test/index.html',
        querySelectorAll(selector: string) {
          if (selector === 'video') return videos;
          return [];
        },
      },
      onChange: (snap: {
        status: string;
        completed: number;
        total: number;
        failed: Array<{ id: string; reason: string }>;
      }) => {
        snapshots.push(JSON.parse(JSON.stringify(snap)));
      },
    },
  );

  try {
    videos[0].triggerError();
    videos[1].triggerError();
    videos[2].triggerError();
    assert.equal(videos[3].preload, 'none');

    // All three stalled HEAD probes time out at 10s, releasing slots so v4 starts preloading.
    advanceBy(10_000);
    assert.equal(videos[3].preload, 'auto');
    assert.equal(snapshots.at(-1)?.status, 'loading');
    assert.equal(snapshots.at(-1)?.completed, 3);

    videos[3].triggerLoaded();
    assert.equal(snapshots.at(-1)?.status, 'ready');
    assert.equal(snapshots.at(-1)?.completed, 4);
    assert.equal(snapshots.at(-1)?.failed.length, 3);
  } finally {
    tracker.dispose();
  }
});

it('reports parsed media at bridge startup before duration, then tracks the mounted document to readiness', () => {
  const origin = 'https://preview.test';
  const tags = bridgeDocumentTags(origin, 'p', 'index.html', {});
  const document = parseHTMLContent(`<html><head>${tags.preload}</head><body>
    <div data-hyperframes-ignore><img src="ignored.png"></div>
    <video data-hf-clip-hidden src="hidden.mp4"></video>
    <img id="deferred" loading="lazy" src="Later%20scene.jpg">
    <img id="poster" src="/preview/~assets/lease/Opening%20shot.jpg?sig=secret">
    ${tags.script}</body></html>`);
  Object.defineProperty(document, 'currentScript', { value: document.querySelector('script') });
  let duration = 0, readyState = 'loading', imageLoaded = false;
  Object.defineProperty(document, 'readyState', { get: () => readyState });
  const poster = document.querySelector<HTMLImageElement>('#poster')!;
  const deferred = document.querySelector<HTMLImageElement>('#deferred')!;
  deferred.loading = 'lazy';
  Object.defineProperty(deferred, 'complete', { value: false });
  Object.defineProperties(poster, {
    complete: { get: () => imageLoaded }, naturalWidth: { get: () => imageLoaded ? 320 : 0 },
    currentSrc: { value: `https://storage.test/derived/${'a'.repeat(64)}/proxy.webp?sig=secret` },
  });
  const sent: Array<{ type: string; duration?: number; assets?: unknown }> = [];
  const ticks = new Map<number, () => void>();
  runInNewContext(PREVIEW_BRIDGE_SCRIPT, {
    URL, document, location: { href: `${origin}/preview?pt=grant` },
    window: { parent: { postMessage: (msg: typeof sent[number]) => sent.push(msg) },
      addEventListener() {}, __player: { getDuration: () => duration } },
    setInterval: (fn: () => void, ms: number) => { ticks.set(ms, fn); return ms; },
    clearInterval: (ms: number) => ticks.delete(ms), setTimeout() {}, clearTimeout() {},
    innerWidth: 320, innerHeight: 180,
  });
  const boot = { status: 'loading', completed: 0, total: 0, failed: [] };
  const hint = { ...boot, pendingAsset: 'Opening shot.jpg' };
  assert.deepEqual(JSON.parse(JSON.stringify(sent.find(m => m.type === 'asset-readiness'))), {
    source: 'openmotion-preview-bridge', version: 1, type: 'asset-readiness', projectId: 'p', token: 'grant', ...hint,
  });
  ticks.get(500)!();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)?.assets)), hint);
  assert.equal(deferred.loading, 'lazy');

  imageLoaded = true;
  ticks.get(500)!();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)?.assets)), boot);
  const video = document.createElement('video');
  video.setAttribute('src', '/assets/Next%20scene.mp4');
  video.preload = 'none';
  let videoState = 0, networkState = 0, loads = 0;
  Object.defineProperties(video, { readyState: { get: () => videoState }, networkState: { get: () => networkState } });
  video.load = () => { loads++; };
  document.body.appendChild(video);
  for (networkState of [0, 1, 3]) {
    ticks.get(500)!();
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)?.assets)), boot);
  }
  networkState = 2;
  ticks.get(500)!();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)?.assets)), { ...boot, pendingAsset: 'Next scene.mp4' });
  assert.equal(video.preload, 'none');
  assert.equal(loads, 0);

  deferred.remove();
  duration = 8;
  readyState = 'interactive';
  ticks.get(25)!();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)?.assets)), { ...boot, completed: 1, total: 2, pendingAsset: 'Next scene.mp4' });
  assert.equal(video.preload, 'auto');
  assert.equal(loads, 0);
  videoState = 2;
  video.dispatchEvent(new document.defaultView!.Event('loadeddata'));
  ticks.get(500)!();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)?.assets)), { status: 'ready', completed: 2, total: 2, failed: [] });
});

it('preview bridge reports live buffering state for active media at the playhead', () => {
  assert.match(PREVIEW_BRIDGE_SCRIPT, /function isMediaBuffering\(time\)/);
  assert.match(PREVIEW_BRIDGE_SCRIPT, /buffering:buffering/);
  assert.match(PREVIEW_BRIDGE_SCRIPT, /\['waiting','playing','canplay','canplaythrough','error'\]/);
});
