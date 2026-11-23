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
