import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { PREVIEW_THUMBNAIL_CAPTURE } from '../../src/studio/engine/preview-thumbnail-capture.ts';
import { PREVIEW_BRIDGE_SCRIPT } from '../../src/studio/engine/preview-bridge.ts';
import { buildSubCompositionHtmlInMemory } from '../../src/studio/engine/preview-bundler.ts';
import { createStudioPreviewRoutes, SNAPDOM_VENDOR_PATH } from '../../src/studio/routes/preview.ts';
import { computePreviewImpact } from '../../shared/preview-impact.ts';
import { computeCompositionRevisions } from '../../src/studio/routes/projects.ts';

describe('preview-thumbnail-capture embedded bridge script', () => {
  it('parses as valid ES5 browser code and registers capture-frames in preview-bridge', () => {
    assert.doesNotThrow(() => new vm.Script(`(function(){${PREVIEW_THUMBNAIL_CAPTURE}})()`));
    assert.match(PREVIEW_BRIDGE_SCRIPT, /capture-frames/);
    assert.match(PREVIEW_BRIDGE_SCRIPT, /thumbnail-capture/);
    assert.equal(SNAPDOM_VENDOR_PATH, '/api/vendor/snapdom.js');
  });

  it('pauses playback, recovers when rAF is throttled, and downgrades preview-asset fetch credentials for 302 S3 redirects', async () => {
    let paused = false;
    const sought: number[] = [];
    const observedFetches: Array<{ url: string; credentials?: string }> = [];
    const origFetch = (input: string, init?: { credentials?: string }) => {
      observedFetches.push({ url: input, credentials: init?.credentials });
      return Promise.resolve({ ok: true });
    };

    const fakeStage = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1280,
      clientHeight: 720,
      textContent: 'Hello',
      getAttribute: (name: string) => (name === 'data-width' ? '1280' : name === 'data-height' ? '720' : null),
      querySelectorAll: () => [],
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    };

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
        cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0x01]).buffer) });
      },
    };

    const sandbox: Record<string, unknown> = {
      URL,
      Promise,
      Array,
      Object,
      Number,
      Math,
      String,
      Error,
      setTimeout,
      clearTimeout,
      location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/api/projects/p1/preview/comp/s1.html?capture=1&pt=tok' },
      // Simulate throttled cross-origin iframe where requestAnimationFrame never fires.
      requestAnimationFrame: () => 0,
      player: () => ({
        pause: () => { paused = true; },
        seek: (t: number) => { sought.push(t); },
      }),
      document: {
        body: fakeStage,
        fonts: { ready: Promise.resolve() },
        querySelector: () => fakeStage,
        querySelectorAll: () => [],
        createElement: (tag: string) => (tag === 'canvas' ? { ...fakeCanvas } : {}),
      },
      window: {
        innerWidth: 1280,
        innerHeight: 720,
        fetch: origFetch,
        snapdom: async () => {
          const fetchFn = (sandbox.window as { fetch: typeof origFetch }).fetch;
          await fetchFn('https://preview.example.test/api/projects/p1/preview/~assets/lease/assets/hero.png', { credentials: 'include' });
          await fetchFn('https://cdn.example.test/other.png', { credentials: 'include' });
          return { toCanvas: async () => ({}) };
        },
      },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (msg: Record<string, unknown>) => Promise<{ frames: ArrayBuffer[]; width: number; height: number }>;

    const result = await capturePreviewFrames({ times: [0.5, 2.5], width: 240 });
    assert.equal(paused, true);
    assert.deepEqual(sought, [0.5, 2.5]);
    assert.equal(result.frames.length, 2);
    assert.equal(result.width, 240);
    assert.equal(result.height, 135);
    assert.equal((sandbox.window as { fetch: unknown }).fetch, origFetch, 'window.fetch must be restored');
    assert.deepEqual(observedFetches.slice(0, 2), [
      {
        url: 'https://preview.example.test/api/projects/p1/preview/~assets/lease/assets/hero.png',
        credentials: 'same-origin',
      },
      {
        url: 'https://cdn.example.test/other.png',
        credentials: 'include',
      },
    ]);
  });

  it('streams progressive frames hero-cover first and returns streamed metadata when onFrame is supplied', async () => {
    const sought: number[] = [];
    const emitted: Array<{ index: number; total: number; byte0: number }> = [];
    let frameCounter = 0;

    const fakeStage = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1920,
      clientHeight: 1080,
      textContent: 'Scene',
      getAttribute: (name: string) => (name === 'data-width' ? '1920' : name === 'data-height' ? '1080' : null),
      querySelectorAll: () => [],
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
    };

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
        const seq = ++frameCounter;
        cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([seq]).buffer) });
      },
    };

    const sandbox: Record<string, unknown> = {
      URL,
      Promise,
      Array,
      Object,
      Number,
      Math,
      String,
      Error,
      setTimeout,
      clearTimeout,
      location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/api/projects/p1/preview/comp/s1.html?capture=1&pt=tok' },
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      player: () => ({
        pause: () => {},
        seek: (t: number) => { sought.push(t); },
      }),
      document: {
        body: fakeStage,
        fonts: { ready: Promise.resolve() },
        querySelector: () => fakeStage,
        querySelectorAll: () => [],
        createElement: (tag: string) => (tag === 'canvas' ? { ...fakeCanvas } : {}),
      },
      window: {
        innerWidth: 1920,
        innerHeight: 1080,
        fetch: () => Promise.resolve({ ok: true }),
        snapdom: async () => ({ toCanvas: async () => ({}) }),
      },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (
      msg: Record<string, unknown>,
      onFrame: (ev: { index: number; total: number; frame: ArrayBuffer }, buf: ArrayBuffer) => void,
    ) => Promise<{ frames: ArrayBuffer[]; streamed?: boolean; frameCount?: number }>;

    const result = await capturePreviewFrames({ times: [0.4, 3.4, 6.4, 9.4], width: 240, progressive: true }, (ev, buf) => {
      emitted.push({ index: ev.index, total: ev.total, byte0: new Uint8Array(buf)[0]! });
    });

    // Mid-scene hero frame (index 2 => 6.4s) is captured and streamed first, then remaining indices.
    assert.deepEqual(sought, [6.4, 0.4, 3.4, 9.4]);
    assert.deepEqual(emitted.map((e) => e.index), [2, 0, 1, 3]);
    assert.equal(result.streamed, true);
    assert.equal(result.frameCount, 4);
    assert.equal(result.frames.length, 0);
  });

  it('announces capture=1 timeline-state immediately via fast boot poll without waiting 500ms or preloading video', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const appendedScripts: string[] = [];
    let videoLoadCalls = 0;
    const intervals: Array<ReturnType<typeof setInterval>> = [];
    const trackedSetInterval = ((fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      intervals.push(id);
      return id;
    }) as typeof setInterval;

    const fakeVideo = {
      tagName: 'VIDEO',
      preload: 'none',
      readyState: 0,
      networkState: 0,
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === 'src' ? 'assets/heavy.mp4' : null),
      querySelector: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
      load: () => { videoLoadCalls += 1; },
    };

    const fakeWindow: Record<string, unknown> = {
      addEventListener: () => {},
      innerWidth: 1920,
      innerHeight: 1080,
      __player: null,
      __clipManifest: { compositionWidth: 1920, compositionHeight: 1080, fps: 30, durationInFrames: 180 },
      parent: {
        postMessage: (msg: Record<string, unknown>) => {
          posted.push(msg);
        },
      },
    };
    const fakeDocument = {
      readyState: 'interactive',
      visibilityState: 'visible',
      referrer: 'https://studio.example.test/',
      baseURI: 'https://preview.example.test/api/projects/p1/preview/~assets/lease-1/',
      currentScript: {
        getAttribute: () => JSON.stringify({ projectId: 'p1', compositionPath: 'compositions/s1.html', sourceVersions: {} }),
      },
      head: {
        appendChild: (node: { src?: string }) => {
          if (node.src) appendedScripts.push(node.src);
        },
      },
      documentElement: { appendChild: () => {} },
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: (sel: string) => (sel === 'video' ? [fakeVideo] : []),
      createElement: () => ({}),
    };

    const sandbox: Record<string, unknown> = {
      URL,
      Promise,
      Array,
      Object,
      Number,
      Math,
      String,
      Error,
      JSON,
      Boolean,
      setTimeout,
      clearTimeout,
      setInterval: trackedSetInterval,
      clearInterval,
      location: {
        origin: 'https://preview.example.test',
        href: 'https://preview.example.test/api/projects/p1/preview/comp/compositions/s1.html?capture=1&pt=tok-fast',
      },
      window: fakeWindow,
      document: fakeDocument,
      innerWidth: 1920,
      innerHeight: 1080,
    };

    try {
      const start = Date.now();
      vm.runInNewContext(PREVIEW_BRIDGE_SCRIPT, sandbox);
      // SnapDOM preload starts eagerly in capture=1 mode.
      assert.deepEqual(appendedScripts, ['/api/vendor/snapdom.js']);

      // Simulate async runtime boot 30ms later (well before the 500ms heartbeat, without window.load).
      setTimeout(() => {
        fakeWindow.__player = { getTime: () => 0, getDuration: () => 6, isPlaying: () => false };
      }, 30);

      await new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
          if (posted.some((m) => m.type === 'timeline-state' && Number(m.duration) === 6)) {
            clearInterval(check);
            resolve();
          } else if (Date.now() - start > 300) {
            clearInterval(check);
            reject(new Error('Expected fast boot poll to emit timeline-state well under 500ms'));
          }
        }, 10);
      });

      const elapsed = Date.now() - start;
      assert.ok(elapsed < 300, `Expected <300ms fast boot handshake, got ${elapsed}ms`);
      assert.equal(videoLoadCalls, 0, 'capture=1 must not preload <video> elements via asset tracker');
      assert.equal(fakeVideo.preload, 'none');
    } finally {
      for (const id of intervals) clearInterval(id);
    }
  });

  it('computes per-composition cache revisions from each file version plus transitive data-composition-src closure, index <head>, and shared assets', () => {
    const baseIndexHtml =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles/theme.css"><script src="assets/gsap.min.js"></script><script>window.__boot=1;</script></head>' +
      '<body><div data-composition-src="compositions/s1.html" data-start="0" data-duration="5"></div>' +
      '<div data-composition-src="compositions/nested-parent.html" data-start="5" data-duration="5"></div></body></html>';
    const baseFiles = [
      { path: 'index.html', sha256: 'idx-1', blobScope: 'workspace' },
      { path: 'compositions/s1.html', sha256: 's1-aaaaaaaaaaaaaaaa', blobScope: 'workspace' },
      { path: 'compositions/s2.html', sha256: 's2-bbbbbbbbbbbbbbbb', blobScope: 'catalog' },
      { path: 'compositions/nested-parent.html', sha256: 'np-cccccccccccccccc', blobScope: 'workspace' },
      { path: 'assets/gsap.min.js', sha256: 'gsap-1', blobScope: 'workspace' },
      { path: 'assets/hero.png', sha256: 'img-1', blobScope: 'workspace' },
      { path: 'assets/shared-bg.webp', sha256: 'bg-1', blobScope: 'workspace' },
      { path: 'assets/bgm.mp3', sha256: 'aud-1', blobScope: 'workspace' },
      { path: 'styles/theme.css', sha256: 'css-1', blobScope: 'workspace' },
      { path: 'motion-project.json', sha256: 'meta-1', blobScope: 'workspace' },
    ];
    const comps = ['index.html', 'compositions/s1.html', 'compositions/s2.html', 'compositions/nested-parent.html'];
    const readText = (p: string): string | null => {
      if (p === 'index.html') return baseIndexHtml;
      if (p === 'styles/theme.css') return '.bg { background: url("../assets/shared-bg.webp"); }';
      if (p === 'compositions/s1.html') {
        return '<div><img src="assets/hero.png"><script>const tl = gsap.timeline({ paused: true }); tl.to("#a", { opacity: 1 });</script></div>';
      }
      if (p === 'compositions/nested-parent.html') {
        return '<div data-composition-src="compositions/s2.html"></div><script>const tl = gsap.timeline({ paused: true });</script>';
      }
      return '<div><svg></svg><script>const tl = gsap.timeline({ paused: true }); tl.to("#a", { opacity: 1 });</script></div>';
    };

    const rev1 = computeCompositionRevisions(baseFiles, comps, baseIndexHtml, 'proj-rev-1', readText);
    assert.ok(rev1['index.html']!.startsWith('"sha256:idx-1"|deps:'));
    assert.ok(rev1['compositions/s1.html']!.startsWith('"sha256:s1-aaaaaaaaaaaaaaaa"|media:'));
    assert.ok(rev1['compositions/s2.html']!.startsWith('"sha256:s2-bbbbbbbbbbbbbbbb"|media:'));
    assert.ok(rev1['compositions/nested-parent.html']!.startsWith('"sha256:np-cccccccccccccccc"|deps:'));

    // Editing only s2.html updates s2.html, its nesting parent, and master index.html (transitive closure), while s1.html stays cached.
    const filesS2Edited = baseFiles.map((f) =>
      f.path === 'compositions/s2.html' ? { ...f, sha256: 'patch-id-2', blobScope: 'patch' } : f,
    );
    const rev2 = computeCompositionRevisions(filesS2Edited, comps, baseIndexHtml, 'proj-rev-2', readText);
    assert.equal(rev2['compositions/s1.html'], rev1['compositions/s1.html']);
    assert.notEqual(rev2['index.html'], rev1['index.html']);
    assert.ok(rev2['compositions/s2.html']!.startsWith('"patch:patch-id-2"|media:'));
    assert.notEqual(rev2['compositions/s2.html'], rev1['compositions/s2.html']);
    assert.notEqual(rev2['compositions/nested-parent.html'], rev1['compositions/nested-parent.html']);

    // Editing index.html <body> (moving/trimming/splitting clips, even with GSAP <script> in <head> and scenes) updates ONLY index.html.
    const movedBodyIndexHtml = baseIndexHtml.replace('data-start="0"', 'data-start="3"');
    const filesIndexBodyEdited = baseFiles.map((f) =>
      f.path === 'index.html' ? { ...f, sha256: 'idx-2', blobScope: 'patch' } : f,
    );
    const readTextMoved = (p: string) => (p === 'index.html' ? movedBodyIndexHtml : readText(p));
    const rev3 = computeCompositionRevisions(filesIndexBodyEdited, comps, movedBodyIndexHtml, 'proj-rev-3', readTextMoved);
    assert.equal(rev3['compositions/s1.html'], rev1['compositions/s1.html']);
    assert.equal(rev3['compositions/s2.html'], rev1['compositions/s2.html']);
    assert.equal(rev3['compositions/nested-parent.html'], rev1['compositions/nested-parent.html']);
    assert.notEqual(rev3['index.html'], rev1['index.html']);
    assert.ok(rev3['index.html']!.startsWith('"patch:idx-2"|deps:'));

    // Editing non-preview metadata leaves every composition (including index.html) cached.
    const filesMetaEdited = baseFiles.map((f) =>
      f.path === 'motion-project.json' ? { ...f, sha256: 'meta-2' } : f,
    );
    // Timeline beat edits notify peer timelines without invalidating every composition preview.
    const beatPath = 'beats/assets/music.wav.json';
    assert.deepEqual(computePreviewImpact([beatPath]), { affectsPreview: false, affectedCompositions: [] });
    assert.equal(computePreviewImpact([beatPath, 'assets/theme.json']).affectsPreview, true);
    assert.equal(computePreviewImpact(['beats/palette.json']).affectsPreview, true);
    const withBeatGrid = computeCompositionRevisions([...baseFiles, { path: beatPath, sha256: '9'.repeat(64) }], comps, baseIndexHtml, 'proj-rev-beat', readText);
    assert.deepEqual(withBeatGrid, rev1);
    const revMeta = computeCompositionRevisions(filesMetaEdited, comps, baseIndexHtml, 'proj-rev-meta', readText);
    assert.equal(revMeta['index.html'], rev1['index.html']);
    assert.equal(revMeta['compositions/s1.html'], rev1['compositions/s1.html']);
    assert.equal(revMeta['compositions/s2.html'], rev1['compositions/s2.html']);

    // Editing a shared stylesheet or referenced asset invalidates every composition cleanly.
    const filesCssEdited = baseFiles.map((f) =>
      f.path === 'styles/theme.css' ? { ...f, sha256: 'css-2', blobScope: 'patch' } : f,
    );
    const revCss = computeCompositionRevisions(filesCssEdited, comps, baseIndexHtml, 'proj-rev-css', readText);
    assert.notEqual(revCss['index.html'], rev1['index.html']);
    assert.notEqual(revCss['compositions/s1.html'], rev1['compositions/s1.html']);
    assert.notEqual(revCss['compositions/s2.html'], rev1['compositions/s2.html']);

    // Editing an image referenced ONLY by s1.html invalidates s1.html + index.html, while untouched s2.html stays cached!
    const filesImgEdited = baseFiles.map((f) =>
      f.path === 'assets/hero.png' ? { ...f, sha256: 'img-2' } : f,
    );
    const revImg = computeCompositionRevisions(filesImgEdited, comps, baseIndexHtml, 'proj-rev-img', readText);
    assert.notEqual(revImg['compositions/s1.html'], rev1['compositions/s1.html']);
    assert.notEqual(revImg['index.html'], rev1['index.html']);
    assert.equal(revImg['compositions/s2.html'], rev1['compositions/s2.html']);

    // Editing a shared CSS-referenced image invalidates every scene using styles/theme.css.
    const filesSharedBgEdited = baseFiles.map((f) =>
      f.path === 'assets/shared-bg.webp' ? { ...f, sha256: 'bg-2' } : f,
    );
    const revSharedBg = computeCompositionRevisions(filesSharedBgEdited, comps, baseIndexHtml, 'proj-rev-bg', readText);
    assert.notEqual(revSharedBg['compositions/s1.html'], rev1['compositions/s1.html']);
    assert.notEqual(revSharedBg['compositions/s2.html'], rev1['compositions/s2.html']);

    // Uploading or editing pure audio OR an unreferenced image/video leaves EVERY composition cached (no cache avalanche!).
    const revWithUnrelatedUploads = computeCompositionRevisions(
      [
        ...baseFiles.map((f) => (f.path === 'assets/bgm.mp3' ? { ...f, sha256: 'aud-2' } : f)),
        { path: 'assets/new-bgm.wav', sha256: 'wav-1', blobScope: 'workspace' },
        { path: 'assets/unused-photo.png', sha256: 'unused-1', blobScope: 'workspace' },
        { path: 'assets/unused-broll.mp4', sha256: 'unused-2', blobScope: 'workspace' },
      ],
      comps,
      baseIndexHtml,
      'proj-rev-uploads',
      readText,
    );
    assert.deepEqual(revWithUnrelatedUploads, rev1);

    // Editing index.html <head> invalidates every composition cleanly.
    const editedHeadIndexHtml = baseIndexHtml.replace('</head>', '<style>.hero{color:red}</style></head>');
    const readTextEditedHead = (p: string) => (p === 'index.html' ? editedHeadIndexHtml : readText(p));
    const revHead = computeCompositionRevisions(filesIndexBodyEdited, comps, editedHeadIndexHtml, 'proj-rev-head', readTextEditedHead);
    assert.notEqual(revHead['compositions/s1.html'], rev1['compositions/s1.html']);
    assert.notEqual(revHead['compositions/s2.html'], rev1['compositions/s2.html']);

    // Missing composition paths fall back cleanly to projectRevision.
    const revMissing = computeCompositionRevisions(baseFiles, [...comps, 'compositions/missing.html'], baseIndexHtml, 'proj-rev-5', readText);
    assert.equal(revMissing['compositions/missing.html'], 'proj-rev-5');
  });

  it('fails closed to projectRevision for dynamic runtime HTML fetches, embedded documents, unresolved refs, or unreadable sources while preserving GSAP siblings', () => {
    const files = [
      { path: 'index.html', sha256: 'idx-1', blobScope: 'workspace' },
      { path: 'compositions/child-color.html', sha256: 'child-red', blobScope: 'workspace' },
      { path: 'compositions/parent-scripted.html', sha256: 'parent-1', blobScope: 'workspace' },
      { path: 'compositions/nested-dynamic.html', sha256: 'nested-1', blobScope: 'workspace' },
      { path: 'compositions/unresolved-ref.html', sha256: 'unres-1', blobScope: 'workspace' },
      { path: 'compositions/iframe-scene.html', sha256: 'iframe-1', blobScope: 'workspace' },
      { path: 'compositions/gsap-sibling.html', sha256: 'gsap-1', blobScope: 'workspace' },
    ];
    const comps = files.map((f) => f.path);
    const textByPath: Record<string, string> = {
      'index.html':
        '<!DOCTYPE html><html><head><script src="assets/gsap.min.js"></script></head>' +
        '<body><div data-composition-src="compositions/parent-scripted.html"></div></body></html>',
      'compositions/child-color.html': '<div style="background:red"></div>',
      'compositions/parent-scripted.html':
        '<div id="host"></div><script>fetch("compositions/child-color.html").then(r=>r.text());</script>',
      'compositions/nested-dynamic.html':
        '<div data-composition-src="compositions/parent-scripted.html"></div>',
      'compositions/unresolved-ref.html':
        '<div data-composition-src="compositions/does-not-exist.html"></div>',
      'compositions/iframe-scene.html':
        '<iframe src="compositions/child-color.html"></iframe>',
      'compositions/gsap-sibling.html':
        '<div><h1>Animated</h1><script>const tl = gsap.timeline({ paused: true }); tl.from("h1", { y: 20 });</script></div>',
    };
    const readText = (p: string) => textByPath[p] ?? null;

    const revRed = computeCompositionRevisions(files, comps, textByPath['index.html']!, 'proj-red', readText);
    assert.equal(revRed['index.html'], 'proj-red');
    assert.equal(revRed['compositions/parent-scripted.html'], 'proj-red');
    assert.equal(revRed['compositions/nested-dynamic.html'], 'proj-red');
    assert.equal(revRed['compositions/unresolved-ref.html'], 'proj-red');
    assert.equal(revRed['compositions/iframe-scene.html'], 'proj-red');
    assert.ok(revRed['compositions/gsap-sibling.html']!.startsWith('"sha256:gsap-1"|shared:'));

    // Editing child-color.html invalidates the fetching parent, nested-dynamic, and index.html while leaving gsap-sibling cached.
    const blueFiles = files.map((f) =>
      f.path === 'compositions/child-color.html' ? { ...f, sha256: 'child-blue' } : f,
    );
    const revBlue = computeCompositionRevisions(blueFiles, comps, textByPath['index.html']!, 'proj-blue', readText);
    assert.equal(revBlue['compositions/parent-scripted.html'], 'proj-blue');
    assert.notEqual(revBlue['compositions/parent-scripted.html'], revRed['compositions/parent-scripted.html']);
    assert.equal(revBlue['compositions/nested-dynamic.html'], 'proj-blue');
    assert.equal(revBlue['index.html'], 'proj-blue');
    assert.equal(revBlue['compositions/gsap-sibling.html'], revRed['compositions/gsap-sibling.html']);

    // Dynamic loader in index.html <head> forces every composition to projectRevision.
    const dynamicHeadIndex =
      '<html><head><script>fetch("compositions/child-color.html");</script></head><body></body></html>';
    const revDynamicHead = computeCompositionRevisions(files, comps, dynamicHeadIndex, 'proj-head-dyn', readText);
    for (const comp of comps) {
      assert.equal(revDynamicHead[comp], 'proj-head-dyn');
    }

    // Without readText, fail closed to projectRevision for all compositions.
    const revNoReader = computeCompositionRevisions(files, comps, textByPath['index.html']!, 'proj-no-reader');
    for (const comp of comps) {
      assert.equal(revNoReader[comp], 'proj-no-reader');
    }
  });

  it('handles transitive and cyclic data-composition-src references deterministically without hanging', () => {
    const files = [
      { path: 'index.html', sha256: 'idx-1', blobScope: 'workspace' },
      { path: 'compositions/cycle-a.html', sha256: 'ca-1', blobScope: 'workspace' },
      { path: 'compositions/cycle-b.html', sha256: 'cb-1', blobScope: 'workspace' },
      { path: 'compositions/other.html', sha256: 'other-1', blobScope: 'workspace' },
    ];
    const comps = files.map((f) => f.path);
    const textByPath: Record<string, string> = {
      'index.html': '<html><head></head><body><div data-composition-src="compositions/cycle-a.html"></div></body></html>',
      'compositions/cycle-a.html': '<div data-composition-src="compositions/cycle-b.html"></div>',
      'compositions/cycle-b.html': '<div data-composition-src="compositions/cycle-a.html"></div>',
      'compositions/other.html': '<div>Unrelated</div>',
    };
    const readText = (p: string) => textByPath[p] ?? null;

    const rev1 = computeCompositionRevisions(files, comps, textByPath['index.html']!, 'proj-1', readText);
    const editedFiles = files.map((f) =>
      f.path === 'compositions/cycle-b.html' ? { ...f, sha256: 'cb-2' } : f,
    );
    const rev2 = computeCompositionRevisions(editedFiles, comps, textByPath['index.html']!, 'proj-2', readText);
    assert.notEqual(rev2['compositions/cycle-b.html'], rev1['compositions/cycle-b.html']);
    assert.notEqual(rev2['compositions/cycle-a.html'], rev1['compositions/cycle-a.html']);
    assert.notEqual(rev2['index.html'], rev1['index.html']);
    assert.equal(rev2['compositions/other.html'], rev1['compositions/other.html']);
  });

  it('inlines decoded images to data URLs once and memoizes preview-asset fetches across multi-frame captures', async () => {
    const attrs: Record<string, string> = { src: 'assets/hero.png' };
    const fakeImg = {
      complete: true,
      naturalWidth: 1600,
      naturalHeight: 900,
      src: 'https://preview.example.test/api/projects/p1/preview/~assets/lease/assets/hero.png',
      currentSrc: 'https://preview.example.test/api/projects/p1/preview/~assets/lease/assets/hero.png',
      getAttribute: (name: string) => attrs[name] ?? null,
      setAttribute: (name: string, val: string) => { attrs[name] = val; },
      hasAttribute: (name: string) => name in attrs,
      removeAttribute: (name: string) => { delete attrs[name]; },
    };
    const fakeStage = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1280,
      clientHeight: 720,
      textContent: 'With image',
      getAttribute: (name: string) => (name === 'data-width' ? '1280' : name === 'data-height' ? '720' : null),
      querySelectorAll: (sel: string) => (sel === 'img' ? [fakeImg] : []),
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    };

    let fetchCount = 0;
    const origFetch = async () => {
      fetchCount += 1;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    };

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
      toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
        cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8]).buffer) });
      },
    };

    const sandbox: Record<string, unknown> = {
      URL,
      Response,
      Promise,
      Array,
      Object,
      Number,
      Math,
      String,
      Error,
      setTimeout,
      clearTimeout,
      location: {
        origin: 'https://preview.example.test',
        href: 'https://preview.example.test/api/projects/p1/preview/comp/s1.html?capture=1&pt=tok',
      },
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      player: () => ({ pause: () => {}, seek: () => {} }),
      document: {
        body: fakeStage,
        fonts: { ready: Promise.resolve() },
        querySelector: () => fakeStage,
        querySelectorAll: () => [],
        createElement: (tag: string) => (tag === 'canvas' ? { ...fakeCanvas } : {}),
      },
      window: {
        innerWidth: 1280,
        innerHeight: 720,
        fetch: origFetch,
        snapdom: async () => {
          const fetchFn = (sandbox.window as { fetch: (u: string, init?: RequestInit) => Promise<Response> }).fetch;
          // Simulate a CSS background-image fetch happening on every frame.
          await fetchFn('https://preview.example.test/api/projects/p1/preview/~assets/lease/assets/bg.png', { credentials: 'include' });
          return { toCanvas: async () => ({}) };
        },
      },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (msg: Record<string, unknown>) => Promise<{ frames: ArrayBuffer[] }>;

    const result = await capturePreviewFrames({ times: [1, 2, 3, 4], width: 240 });
    assert.equal(result.frames.length, 4);
    assert.equal(attrs.src, 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(attrs.width, '1600');
    assert.equal(attrs.height, '900');
    assert.equal(fetchCount, 1, 'identical preview asset GETs across frames must be memoized');
  });

  it('adds crossorigin="anonymous" on project-local <img> tags and snapdom preload only in capture=1 isolated builds', async () => {
    const files = new Map<string, string>([
      ['index.html', '<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>'],
      [
        'compositions/scene-1.html',
        '<template><div data-composition-id="scene-1" data-width="1920" data-height="1080">' +
          '<img src="assets/local.png">' +
          '<img src="https://cdn.example.test/external.png">' +
          '</div></template>',
      ],
    ]);
    const virtual = {
      projectId: 'p1',
      projectName: 'Test',
      revision: 'rev-1',
      getBlobMetadata: () => null,
      listFiles: () =>
        [...files.keys()].map((p) => ({
          path: p,
          sha256: 'a'.repeat(64),
          sizeBytes: files.get(p)!.length,
          mimeType: 'text/html',
          isText: true,
          blobScope: 'workspace' as const,
          updatedAt: new Date(),
          metadata: null,
        })),
      getFile: (p: string) =>
        files.has(p)
          ? {
              path: p,
              sha256: 'a'.repeat(64),
              sizeBytes: files.get(p)!.length,
              mimeType: 'text/html',
              isText: true,
              blobScope: 'workspace' as const,
              updatedAt: new Date(),
              metadata: null,
            }
          : null,
      exists: (p: string) => files.has(p) || p === 'assets/local.png',
      readText: (p: string) => files.get(p) ?? null,
    };

    const captureHtml = await buildSubCompositionHtmlInMemory(virtual, 'compositions/scene-1.html', {
      capture: true,
      bridgeOrigin: 'https://preview.example.test',
      skipDeterministicFonts: true,
    });
    assert.ok(captureHtml);
    assert.match(captureHtml, /<link rel="preload" as="script" href="https:\/\/preview\.example\.test\/api\/vendor\/snapdom\.js">/);
    assert.match(captureHtml, /<img(?=[^>]*\bsrc="assets\/local\.png")(?=[^>]*\bcrossorigin="anonymous")[^>]*>/);
    assert.doesNotMatch(captureHtml, /<img(?=[^>]*\bsrc="https:\/\/cdn\.example\.test\/external\.png")(?=[^>]*\bcrossorigin="anonymous")[^>]*>/);

    const interactiveHtml = await buildSubCompositionHtmlInMemory(virtual, 'compositions/scene-1.html', {
      capture: false,
      bridgeOrigin: 'https://preview.example.test',
      skipDeterministicFonts: true,
    });
    assert.ok(interactiveHtml);
    assert.doesNotMatch(interactiveHtml, /snapdom\.js/);
    assert.doesNotMatch(interactiveHtml, /<img[^>]*crossorigin="anonymous"/);
  });

  it('passes dpr=1, defaults to 160x90, uses 1-frame settle for DOM-only scenes, and skips unchanged static frames with distinct buffers', async () => {
    const snapOptions: Array<Record<string, unknown>> = [];
    let rafCalls = 0;
    let frameBytes = 0;
    let activeObserverCb: (() => void) | null = null;
    let disconnected = false;
    class FakeMutationObserver {
      private cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe() { activeObserverCb = this.cb; }
      takeRecords() { return []; }
      disconnect() { disconnected = true; }
    }

    const fakeStage = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1920,
      clientHeight: 1080,
      textContent: 'Static tail scene',
      getAttribute: (name: string) => (name === 'data-width' ? '1920' : name === 'data-height' ? '1080' : null),
      querySelectorAll: () => [],
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
    };

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
      toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
        const seq = ++frameBytes;
        cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, seq]).buffer) });
      },
    };

    const sandbox: Record<string, unknown> = {
      URL,
      Promise,
      Array,
      Object,
      Number,
      Math,
      String,
      Boolean,
      Error,
      MutationObserver: FakeMutationObserver,
      setTimeout,
      clearTimeout,
      location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/api/projects/p1/preview/comp/s1.html?capture=1&pt=tok' },
      requestAnimationFrame: (fn: () => void) => {
        rafCalls += 1;
        return setTimeout(fn, 0);
      },
      player: () => ({
        pause: () => {},
        seek: (t: number) => {
          // Mutate only at t=1; t=2 and t=3 hold the exact same DOM state.
          if (t === 1) activeObserverCb?.();
        },
      }),
      document: {
        body: fakeStage,
        fonts: { ready: Promise.resolve() },
        getAnimations: () => [],
        querySelector: () => fakeStage,
        querySelectorAll: () => [],
        createElement: (tag: string) => (tag === 'canvas' ? { ...fakeCanvas } : {}),
      },
      window: {
        innerWidth: 1920,
        innerHeight: 1080,
        fetch: () => Promise.resolve({ ok: true }),
        snapdom: async (_el: unknown, opts: Record<string, unknown>) => {
          snapOptions.push(opts);
          return { toCanvas: async () => ({}) };
        },
      },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (msg: Record<string, unknown>) => Promise<{ frames: ArrayBuffer[]; width: number; height: number }>;

    const result = await capturePreviewFrames({ times: [0.5, 1, 2, 3] });
    assert.equal(result.width, 160);
    assert.equal(result.height, 90);
    assert.equal(result.frames.length, 4);
    // Only frame 0 (initial) and frame 1 (mutated) invoke SnapDOM; frames 2 & 3 reuse frame 1's buffer.
    assert.equal(snapOptions.length, 2);
    assert.equal(snapOptions[0]?.dpr, 1);
    assert.equal(snapOptions[1]?.dpr, 1);
    // 1 animation frame settle per timestamp for DOM-only scenes (4 instead of 8).
    assert.equal(rafCalls, 4);
    assert.equal(disconnected, true);
    // Reused buffers must be distinct ArrayBuffer instances so transferable postMessage never fails.
    assert.notEqual(result.frames[1], result.frames[2]);
    assert.notEqual(result.frames[2], result.frames[3]);
    assert.deepEqual(Array.from(new Uint8Array(result.frames[1]!)), Array.from(new Uint8Array(result.frames[2]!)));
    assert.deepEqual(Array.from(new Uint8Array(result.frames[1]!)), Array.from(new Uint8Array(result.frames[3]!)));
  });

  it('uses the direct canvas fast-path even when a pure-canvas composition contains inline script and style tags', async () => {
    let snapdomCalled = 0;
    let rafCalls = 0;
    const pureCanvas = {
      nodeType: 1,
      tagName: 'CANVAS',
      textContent: 'Canvas fallback',
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
    };
    const inlineScript = { nodeType: 1, tagName: 'SCRIPT', textContent: 'drawCube();' };
    const inlineStyle = { nodeType: 1, tagName: 'STYLE', textContent: 'canvas{width:100%}' };
    const fakeStage = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1920,
      clientHeight: 1080,
      textContent: 'Canvas fallbackdrawCube();canvas{width:100%}',
      childNodes: [inlineStyle, pureCanvas, inlineScript],
      getAttribute: (name: string) => (name === 'data-width' ? '1920' : name === 'data-height' ? '1080' : null),
      querySelectorAll: (sel: string) => (sel === 'canvas' ? [pureCanvas] : []),
      querySelector: (sel: string) => (sel === 'canvas,video' ? pureCanvas : null),
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
    };
    const outCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
      toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
        cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0x09]).buffer) });
      },
    };
    const sandbox: Record<string, unknown> = {
      URL,
      Promise,
      Array,
      Object,
      Number,
      Math,
      String,
      Boolean,
      Error,
      setTimeout,
      clearTimeout,
      location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/api/projects/p1/preview/comp/cube.html?capture=1&pt=tok' },
      requestAnimationFrame: (fn: () => void) => {
        rafCalls += 1;
        return setTimeout(fn, 0);
      },
      player: () => ({ pause: () => {}, seek: () => {} }),
      document: {
        body: fakeStage,
        fonts: { ready: Promise.resolve() },
        querySelector: () => fakeStage,
        querySelectorAll: () => [],
        createElement: (tag: string) => (tag === 'canvas' ? { ...outCanvas } : {}),
      },
      window: {
        innerWidth: 1920,
        innerHeight: 1080,
        fetch: () => Promise.resolve({ ok: true }),
        snapdom: async () => {
          snapdomCalled += 1;
          return { toCanvas: async () => ({}) };
        },
      },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (msg: Record<string, unknown>) => Promise<{ frames: ArrayBuffer[] }>;

    const result = await capturePreviewFrames({ times: [0.5, 2.5] });
    assert.equal(result.frames.length, 2);
    assert.equal(snapdomCalled, 0, 'pure canvas with inline script/style must bypass SnapDOM');
    assert.equal(rafCalls, 4, 'canvas scenes keep 2-frame settle per timestamp');
  });

  it('serves /api/vendor/snapdom.js pre-compressed with br/gzip when requested and raw otherwise', async () => {
    const routes = createStudioPreviewRoutes({
      storage: { putBlobIfAbsent: async () => {} },
    } as unknown as Parameters<typeof createStudioPreviewRoutes>[0]);

    const brRes = await routes.request(SNAPDOM_VENDOR_PATH, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(brRes.status, 200);
    assert.equal(brRes.headers.get('content-encoding'), 'br');
    assert.equal(brRes.headers.get('vary'), 'Accept-Encoding');
    const brBuf = Buffer.from(await brRes.arrayBuffer());

    const gzipRes = await routes.request(SNAPDOM_VENDOR_PATH, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(gzipRes.status, 200);
    assert.equal(gzipRes.headers.get('content-encoding'), 'gzip');
    const gzipBuf = Buffer.from(await gzipRes.arrayBuffer());

    const rawRes = await routes.request(SNAPDOM_VENDOR_PATH);
    assert.equal(rawRes.status, 200);
    assert.equal(rawRes.headers.get('content-encoding'), null);
    const rawBuf = Buffer.from(await rawRes.arrayBuffer());

    assert.ok(brBuf.length < rawBuf.length / 2, 'brotli bundle should shrink transfer by >50%');
    assert.ok(gzipBuf.length < rawBuf.length / 2, 'gzip bundle should shrink transfer by >50%');
    assert.deepEqual(brotliDecompressSync(brBuf), rawBuf);
    assert.deepEqual(gunzipSync(gzipBuf), rawBuf);
  });

  it('never skips frames when selector resolves directly to a <canvas> target and uses 2-frame settle', async () => {
    let drawCalls = 0;
    let rafCalls = 0;
    let observedTarget: unknown = null;
    class FakeMutationObserver {
      observe(el: unknown) { observedTarget = el; }
      takeRecords() { return []; }
      disconnect() {}
    }

    const canvasTarget = {
      nodeType: 1,
      tagName: 'CANVAS',
      getBoundingClientRect: () => ({ width: 800, height: 450 }),
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const fakeRoot = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1920,
      clientHeight: 1080,
      getAttribute: (name: string) => (name === 'data-width' ? '1920' : name === 'data-height' ? '1080' : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
    };
    const outCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ clearRect: () => {}, drawImage: () => { drawCalls += 1; } }),
      toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
        cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, drawCalls]).buffer) });
      },
    };
    const sandbox: Record<string, unknown> = {
      URL, Promise, Array, Object, Number, Math, String, Boolean, Error,
      MutationObserver: FakeMutationObserver,
      setTimeout, clearTimeout,
      location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/api/projects/p1/preview?capture=1&pt=tok' },
      requestAnimationFrame: (fn: () => void) => { rafCalls += 1; return setTimeout(fn, 0); },
      player: () => ({ pause: () => {}, seek: () => {} }),
      document: {
        documentElement: fakeRoot,
        body: fakeRoot,
        fonts: { ready: Promise.resolve() },
        getAnimations: () => [],
        querySelector: () => fakeRoot,
        querySelectorAll: (sel: string) => (sel === '#layer-canvas' ? [canvasTarget] : []),
        createElement: (tag: string) => (tag === 'canvas' ? { ...outCanvas } : {}),
      },
      window: { innerWidth: 1920, innerHeight: 1080, fetch: () => Promise.resolve({ ok: true }) },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (msg: Record<string, unknown>) => Promise<{ frames: ArrayBuffer[] }>;

    const result = await capturePreviewFrames({ times: [0.5, 1.5, 2.5], selector: '#layer-canvas' });
    assert.equal(result.frames.length, 3);
    assert.equal(observedTarget, null, 'direct <canvas> target must not attach static-reuse observer');
    assert.equal(drawCalls, 3, 'every timestamp on a direct <canvas> target must draw fresh pixels');
    assert.equal(rafCalls, 6, 'direct <canvas> target must use 2-frame settle');
    assert.deepEqual(
      Array.from(result.frames, (buf) => new Uint8Array(buf)[2]),
      [1, 2, 3],
    );
  });

  it('tracks documentElement mutations for selector captures so ancestor style/class edits trigger fresh SnapDOM captures', async () => {
    let snapCalls = 0;
    let observedNode: unknown = null;
    let observerCb: (() => void) | null = null;
    class FakeMutationObserver {
      private cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe(el: unknown) { observedNode = el; observerCb = this.cb; }
      takeRecords() { return []; }
      disconnect() {}
    }

    const docEl = { nodeType: 1, tagName: 'HTML' };
    const selectedEl = {
      nodeType: 1,
      tagName: 'DIV',
      textContent: 'Card',
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 400, height: 225 }),
    };
    const fakeRoot = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1920,
      clientHeight: 1080,
      getAttribute: (name: string) => (name === 'data-width' ? '1920' : name === 'data-height' ? '1080' : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
    };
    const outCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
      toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
        cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, snapCalls]).buffer) });
      },
    };
    const sandbox: Record<string, unknown> = {
      URL, Promise, Array, Object, Number, Math, String, Boolean, Error,
      MutationObserver: FakeMutationObserver,
      setTimeout, clearTimeout,
      location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/api/projects/p1/preview?capture=1&pt=tok' },
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      player: () => ({
        pause: () => {},
        // Simulate an ancestor class/CSS-var mutation on documentElement at t=2 (not inside #card).
        seek: (t: number) => { if (t === 2) observerCb?.(); },
      }),
      document: {
        documentElement: docEl,
        body: fakeRoot,
        fonts: { ready: Promise.resolve() },
        getAnimations: () => [],
        querySelector: () => fakeRoot,
        querySelectorAll: (sel: string) => (sel === '#card' ? [selectedEl] : []),
        createElement: (tag: string) => (tag === 'canvas' ? { ...outCanvas } : {}),
      },
      window: {
        innerWidth: 1920,
        innerHeight: 1080,
        fetch: () => Promise.resolve({ ok: true }),
        snapdom: async () => { snapCalls += 1; return { toCanvas: async () => ({}) }; },
      },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (msg: Record<string, unknown>) => Promise<{ frames: ArrayBuffer[] }>;

    const result = await capturePreviewFrames({ times: [1, 2, 3], selector: '#card' });
    assert.equal(observedNode, docEl, 'selector capture must observe documentElement for inherited ancestor changes');
    assert.equal(snapCalls, 2, 'frame 0 and ancestor-mutated frame 1 capture fresh; unchanged frame 2 reuses');
    assert.deepEqual(Array.from(result.frames, (buf) => new Uint8Array(buf)[2]), [1, 2, 2]);
  });

  it('discards a tainted scratch canvas after a cross-origin image inline error so subsequent images still inline', async () => {
    const attrs1: Record<string, string> = { src: 'https://foreign.example/no-cors.png' };
    const attrs2: Record<string, string> = { src: 'assets/local.png' };
    const makeImg = (attrs: Record<string, string>, tainted: boolean) => ({
      complete: true,
      naturalWidth: 200,
      naturalHeight: 100,
      src: attrs.src,
      currentSrc: attrs.src,
      tainted,
      getAttribute: (name: string) => attrs[name] ?? null,
      setAttribute: (name: string, val: string) => { attrs[name] = val; },
      hasAttribute: (name: string) => name in attrs,
      removeAttribute: (name: string) => { delete attrs[name]; },
    });
    const img1 = makeImg(attrs1, true);
    const img2 = makeImg(attrs2, false);
    const fakeStage = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1280,
      clientHeight: 720,
      textContent: 'Images',
      getAttribute: (name: string) => (name === 'data-width' ? '1280' : name === 'data-height' ? '720' : null),
      querySelectorAll: (sel: string) => (sel === 'img' ? [img1, img2] : []),
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    };

    let createdCanvases = 0;
    const makeCanvas = () => {
      createdCanvases += 1;
      let isTainted = false;
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect: () => {},
          drawImage: (source: { tainted?: boolean }) => {
            if (source && source.tainted) isTainted = true;
          },
        }),
        toDataURL: () => {
          if (isTainted) throw new Error('SecurityError: tainted canvas');
          return 'data:image/png;base64,CLEAN=';
        },
        toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
          cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8]).buffer) });
        },
      };
    };

    const sandbox: Record<string, unknown> = {
      URL, Promise, Array, Object, Number, Math, String, Boolean, Error,
      setTimeout, clearTimeout,
      location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/api/projects/p1/preview?capture=1&pt=tok' },
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      player: () => ({ pause: () => {}, seek: () => {} }),
      document: {
        body: fakeStage,
        fonts: { ready: Promise.resolve() },
        querySelector: () => fakeStage,
        querySelectorAll: () => [],
        createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : {}),
      },
      window: {
        innerWidth: 1280,
        innerHeight: 720,
        fetch: () => Promise.resolve({ ok: true }),
        snapdom: async () => ({ toCanvas: async () => ({}) }),
      },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (msg: Record<string, unknown>) => Promise<{ frames: ArrayBuffer[] }>;

    await capturePreviewFrames({ times: [1] });
    assert.equal(attrs1.src, 'https://foreign.example/no-cors.png', 'tainted image stays untouched');
    assert.equal(attrs2.src, 'data:image/png;base64,CLEAN=', 'subsequent local image must inline on a fresh canvas');
    assert.ok(createdCanvases >= 3, 'expected a fresh scratch canvas after taint plus output canvas');
  });

  it('caps selector capture scale and output height and releases temporary canvas backings', async () => {
    const snapdomCalls: Array<{ scale?: number }> = [];
    const createdCanvases: Array<{ width: number; height: number }> = [];
    const snapCanvases: Array<{ width: number; height: number }> = [];

    const narrowTarget = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 10,
      clientHeight: 600,
      textContent: 'Tall sliver',
      querySelectorAll: () => [],
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 10, height: 600 }),
    };
    const fakeStage = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1920,
      clientHeight: 1080,
      textContent: 'Stage',
      getAttribute: (name: string) => (name === 'data-width' ? '1920' : name === 'data-height' ? '1080' : null),
      querySelectorAll: () => [],
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
    };

    const sandbox: Record<string, unknown> = {
      URL,
      Promise,
      Array,
      Object,
      Number,
      Math,
      String,
      Boolean,
      Error,
      setTimeout,
      clearTimeout,
      location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/api/projects/p1/preview/comp/s1.html?capture=1&pt=tok' },
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      player: () => ({ pause: () => {}, seek: () => {} }),
      document: {
        body: fakeStage,
        fonts: { ready: Promise.resolve() },
        querySelector: () => fakeStage,
        querySelectorAll: (sel: string) => (sel === '#sliver' ? [narrowTarget] : []),
        createElement: (tag: string) => {
          if (tag !== 'canvas') return {};
          const cv = {
            width: 0,
            height: 0,
            getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
            toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
              cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8]).buffer) });
            },
          };
          createdCanvases.push(cv);
          return cv;
        },
      },
      window: {
        innerWidth: 1920,
        innerHeight: 1080,
        fetch: () => Promise.resolve({ ok: true }),
        snapdom: async (_target: unknown, opts: { scale?: number }) => {
          snapdomCalls.push(opts);
          const sc = { width: 240, height: 480 };
          snapCanvases.push(sc);
          return { toCanvas: async () => sc };
        },
      },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (msg: Record<string, unknown>) => Promise<{ frames: ArrayBuffer[]; width: number; height: number }>;

    const result = await capturePreviewFrames({ times: [1], width: 240, selector: '#sliver' });
    assert.equal(result.frames.length, 1);
    assert.ok(result.height <= 480, `expected bounded height <= 480, got ${result.height}`);
    assert.ok(result.width >= 48 && result.width <= 240);
    assert.ok((snapdomCalls[0]?.scale ?? 99) <= 2, `expected bounded scale <= 2, got ${snapdomCalls[0]?.scale}`);
    assert.equal(createdCanvases[0]?.width, 0, 'output canvas backing should be released');
    assert.equal(createdCanvases[0]?.height, 0, 'output canvas backing should be released');
    assert.equal(snapCanvases[0]?.width, 0, 'snapdom canvas backing should be released');
    assert.equal(snapCanvases[0]?.height, 0, 'snapdom canvas backing should be released');
  });

  it('passes fast:"auto", placeholders:false, referentially-stable excludeStyleProps, and prefers WebP/JPEG when inlining images', async () => {
    const snapOpts: Array<Record<string, unknown>> = [];
    const dataUrlCalls: Array<{ mime?: string; quality?: number }> = [];
    const attrsPng: Record<string, string> = { src: 'assets/logo.png' };
    const attrsJpg: Record<string, string> = { src: 'assets/photo.jpg' };
    const makeImg = (attrs: Record<string, string>) => ({
      complete: true,
      naturalWidth: 800,
      naturalHeight: 450,
      src: attrs.src,
      currentSrc: attrs.src,
      getAttribute: (name: string) => attrs[name] ?? null,
      setAttribute: (name: string, val: string) => { attrs[name] = val; },
      hasAttribute: (name: string) => name in attrs,
      removeAttribute: (name: string) => { delete attrs[name]; },
    });
    const fakeStage = {
      nodeType: 1,
      tagName: 'DIV',
      clientWidth: 1280,
      clientHeight: 720,
      textContent: 'Media scene',
      getAttribute: (name: string) => (name === 'data-width' ? '1280' : name === 'data-height' ? '720' : null),
      querySelectorAll: (sel: string) => (sel === 'img' ? [makeImg(attrsPng), makeImg(attrsJpg)] : []),
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    };

    let webpSupported = true;
    const makeCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
      toDataURL: (mime?: string, quality?: number) => {
        dataUrlCalls.push({ mime, quality });
        if (mime === 'image/webp') {
          return webpSupported ? 'data:image/webp;base64,UklGR=' : 'data:image/png;base64,FALLBACK=';
        }
        if (mime === 'image/jpeg') return 'data:image/jpeg;base64,/9j/4AA=';
        return 'data:image/png;base64,iVBOR=';
      },
      toBlob: (cb: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) => {
        cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8]).buffer) });
      },
    });

    const sandbox: Record<string, unknown> = {
      URL, Promise, Array, Object, Number, Math, String, Boolean, Error,
      setTimeout, clearTimeout,
      location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/api/projects/p1/preview?capture=1&pt=tok' },
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      player: () => ({ pause: () => {}, seek: () => {} }),
      document: {
        body: fakeStage,
        fonts: { ready: Promise.resolve() },
        querySelector: () => fakeStage,
        querySelectorAll: () => [],
        createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : {}),
      },
      window: {
        innerWidth: 1280,
        innerHeight: 720,
        fetch: () => Promise.resolve({ ok: true }),
        snapdom: async (_el: unknown, opts: Record<string, unknown>) => {
          snapOpts.push(opts);
          return { toCanvas: async () => ({}) };
        },
      },
    };

    const capturePreviewFrames = vm.runInNewContext(
      `(function(){${PREVIEW_THUMBNAIL_CAPTURE}; return capturePreviewFrames;})()`,
      sandbox,
    ) as (msg: Record<string, unknown>) => Promise<{ frames: ArrayBuffer[] }>;

    await capturePreviewFrames({ times: [1, 2] });
    assert.equal(snapOpts.length, 2);
    assert.equal(snapOpts[0]?.fast, 'auto');
    assert.equal(snapOpts[0]?.placeholders, false);
    assert.equal(Object.prototype.toString.call(snapOpts[0]?.excludeStyleProps), '[object RegExp]');
    assert.equal((snapOpts[0]?.excludeStyleProps as RegExp).test('--accent'), true);
    assert.equal((snapOpts[0]?.excludeStyleProps as RegExp).test('background-color'), false);
    assert.equal(snapOpts[0]?.excludeStyleProps, snapOpts[1]?.excludeStyleProps, 'excludeStyleProps RegExp must stay referentially stable across frames for SnapDOM style cache reuse');
    assert.equal(attrsPng.src, 'data:image/webp;base64,UklGR=');
    assert.equal(attrsJpg.src, 'data:image/webp;base64,UklGR=');

    // When WebP is unavailable, opaque .jpg images fall back to image/jpeg (0.82) while .png keeps alpha PNG.
    webpSupported = false;
    attrsPng.src = 'assets/logo.png';
    attrsJpg.src = 'assets/photo.jpg';
    await capturePreviewFrames({ times: [1] });
    assert.equal(attrsPng.src, 'data:image/png;base64,FALLBACK=');
    assert.equal(attrsJpg.src, 'data:image/jpeg;base64,/9j/4AA=');
  });

  it('replaces <video poster> with <img> and forces preload="none" without autoplay in capture=1 builds only', async () => {
    const files = new Map<string, string>([
      ['index.html', '<!DOCTYPE html><html><head><title>Video</title></head><body></body></html>'],
      [
        'compositions/video-scene.html',
        '<template><div data-composition-id="v" data-width="1920" data-height="1080">' +
          '<video id="hero-vid" class="clip" src="assets/hero.mp4" poster="assets/hero-poster.jpg" autoplay style="width:1920px;height:1080px;object-fit:cover"></video>' +
          '<video id="raw-vid" src="assets/raw.mp4" autoplay preload="auto"></video>' +
          '<audio id="bgm" src="assets/bgm.mp3" autoplay preload="auto"></audio>' +
          '</div></template>',
      ],
    ]);
    const virtual = {
      projectId: 'p1',
      projectName: 'Video',
      revision: 'rev-1',
      getBlobMetadata: () => null,
      listFiles: () =>
        [...files.keys()].map((p) => ({
          path: p,
          sha256: 'a'.repeat(64),
          sizeBytes: files.get(p)!.length,
          mimeType: 'text/html',
          isText: true,
          blobScope: 'workspace' as const,
          updatedAt: new Date(),
          metadata: null,
        })),
      getFile: () => null,
      exists: (p: string) => files.has(p) || p.startsWith('assets/'),
      readText: (p: string) => files.get(p) ?? null,
    };

    const captureHtml = await buildSubCompositionHtmlInMemory(virtual, 'compositions/video-scene.html', {
      capture: true,
      skipDeterministicFonts: true,
    });
    assert.ok(captureHtml);
    // Poster-backed <video> becomes an <img> with crossorigin="anonymous" and preserved id/class/style.
    assert.match(
      captureHtml,
      /<img(?=[^>]*\bid="hero-vid")(?=[^>]*\bclass="clip")(?=[^>]*\bsrc="assets\/hero-poster\.jpg")(?=[^>]*\bcrossorigin="anonymous")(?=[^>]*\bdata-om-capture-video-poster="1")[^>]*>/,
    );
    // Posterless <video> and <audio> stay inert (preload="none", no autoplay).
    assert.match(captureHtml, /<video(?=[^>]*\bid="raw-vid")(?=[^>]*\bpreload="none")[^>]*>/);
    assert.doesNotMatch(captureHtml, /<video[^>]*\bautoplay\b/i);
    assert.match(captureHtml, /<audio(?=[^>]*\bid="bgm")(?=[^>]*\bpreload="none")[^>]*>/);
    assert.doesNotMatch(captureHtml, /<audio[^>]*\bautoplay\b/i);

    // Interactive mode keeps the original <video> tags untouched.
    const interactiveHtml = await buildSubCompositionHtmlInMemory(virtual, 'compositions/video-scene.html', {
      capture: false,
      skipDeterministicFonts: true,
    });
    assert.ok(interactiveHtml);
    assert.match(interactiveHtml, /<video(?=[^>]*\bid="hero-vid")(?=[^>]*\bposter="assets\/hero-poster\.jpg")[^>]*>/);
    assert.doesNotMatch(interactiveHtml, /data-om-capture-video-poster/);
  });
});
