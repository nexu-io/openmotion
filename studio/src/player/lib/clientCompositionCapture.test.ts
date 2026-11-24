// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canCaptureCompositionInBrowser,
  captureSampleTimes,
  clearClientCompositionCaptureCacheForTest,
  computeCompositionSampleTimes,
  createClientCompositionCaptureRequest,
  evictStaleCompositionCaptures,
  getCompositionCacheKeyRevision,
  getCompositionCacheRevision,
  getProgressiveCompositionCapture,
  peekCachedCompositionCapture,
  peekFallbackCompositionCapture,
  quantizeCompositionFrameCount,
  retainCachedCompositionCapture,
  seedClientCompositionCaptureForTest,
  selectInitialGateCompositionPaths,
  setCachedProjectRevision,
  setClientCompositionCaptureCapabilityForTest,
  subscribeCompositionCacheRevision,
  subscribeProgressiveCompositionCapture,
  updateCachedCompositionRevisions,
  withPreviewRedirectSafeFetch,
} from "./clientCompositionCapture";
import { bindPreviewLease } from "./previewLease";
import { ThumbnailScheduler, thumbnailScheduler } from "./thumbnailScheduler";
import { usePlayerStore } from "../store/playerStore";

afterEach(() => {
  setClientCompositionCaptureCapabilityForTest(null);
  clearClientCompositionCaptureCacheForTest();
  vi.restoreAllMocks();
});

describe("clientCompositionCapture", () => {
  it("samples selector filmstrips inside their visible interval in the rendered composition", () => {
    const clip = { selector: "#card", seekTime: 12, duration: 2, frameCount: 2 };
    expect(captureSampleTimes(20, clip)).toEqual([12.5, 13.5]);
    expect(captureSampleTimes(20, { ...clip, frameCount: 1 })).toEqual([13]);
    // A nested composition has its own clock, independent of its parent's start.
    expect(captureSampleTimes(5, { ...clip, seekTime: 2 })).toEqual([2.5, 3.5]);
    expect(captureSampleTimes(20, { ...clip, selector: undefined })).toEqual([5, 15]);
  });

  it("invalidates selector captures across moves and trims while retaining composition covers", () => {
    const input = { projectId: "windows", previewUrl: "/preview", contentRevision: 1, sessionEpoch: 0,
      frameCount: 2, selector: "#card", seekTime: 5, duration: 2 };
    const cached = seedClientCompositionCaptureForTest(input, [new Blob(["old"])]);
    const key = createClientCompositionCaptureRequest(input).key;
    for (const changed of [{ ...input, seekTime: 6 }, { ...input, duration: 1 }]) {
      expect(createClientCompositionCaptureRequest(changed).key).not.toBe(key);
      expect(peekCachedCompositionCapture(changed)).toBeNull();
    }
    expect(peekCachedCompositionCapture(input)).toBe(cached);
    const whole = { ...input, selector: undefined };
    expect(createClientCompositionCaptureRequest(whole).key)
      .toBe(createClientCompositionCaptureRequest({ ...whole, duration: 3 }).key);
  });

  it("clamps partially visible, zero-length and sub-frame selection windows", () => {
    const clip = { selector: "#card", seekTime: 19, duration: 4, frameCount: 4 };
    const times = captureSampleTimes(20, clip);
    expect(times).toHaveLength(4);
    expect(times.every(value => value > 19 && value < 20)).toBe(true);
    expect(captureSampleTimes(20, { ...clip, duration: 0 })).toEqual([19]);
    expect(captureSampleTimes(20, { ...clip, seekTime: 25 })).toEqual([20]);
    expect(captureSampleTimes(20, { ...clip, seekTime: -1, frameCount: 1 })).toEqual([1.5]);
    expect(captureSampleTimes(20, { ...clip, duration: 0.0001 }).every(t => t > 19 && t < 19.0001)).toBe(true);
  });

  it("disables browser capture automatically under HappyDOM unless overridden", () => {
    expect(canCaptureCompositionInBrowser()).toBe(false);
    setClientCompositionCaptureCapabilityForTest(true);
    expect(canCaptureCompositionInBrowser()).toBe(true);
  });

  it("quantizes tile counts into 1 / 2 / 4 / 8 frames and clamps ultra-short clips", () => {
    expect(quantizeCompositionFrameCount(1, 10)).toBe(1);
    expect(quantizeCompositionFrameCount(2, 10)).toBe(2);
    expect(quantizeCompositionFrameCount(3, 10)).toBe(4);
    expect(quantizeCompositionFrameCount(4, 10)).toBe(4);
    expect(quantizeCompositionFrameCount(5, 10)).toBe(8);
    expect(quantizeCompositionFrameCount(20, 60)).toBe(8);
    expect(quantizeCompositionFrameCount(8, 0.3)).toBe(1);
  });

  it("spaces sample timestamps across the clip while avoiding blank start/end edges", () => {
    expect(computeCompositionSampleTimes(48, 1)).toEqual([3]);
    expect(computeCompositionSampleTimes(2, 1)).toEqual([1]);
    expect(computeCompositionSampleTimes(4, 2)).toEqual([1, 3]);
    const times = computeCompositionSampleTimes(10, 4);
    expect(times).toHaveLength(4);
    expect(times[0]).toBeGreaterThan(0);
    expect(times[3]).toBeLessThan(10);
    expect(times).toEqual([0.4, 3.4, 6.4, 9.4]);
  });

  it("includes project revision and frame count in scheduler request identity", () => {
    setCachedProjectRevision("proj-1", "rev-a");
    const reqA = createClientCompositionCaptureRequest({
      previewUrl: "/api/projects/proj-1/preview/comp/compositions/intro.html",
      projectId: "proj-1",
      sessionEpoch: 0,
      contentRevision: 0,
      frameCount: 4,
      duration: 5,
    });
    setCachedProjectRevision("proj-1", "rev-b");
    const reqB = createClientCompositionCaptureRequest({
      previewUrl: "/api/projects/proj-1/preview/comp/compositions/intro.html",
      projectId: "proj-1",
      sessionEpoch: 0,
      contentRevision: 0,
      frameCount: 4,
      duration: 5,
    });
    expect(reqA.key).not.toBe(reqB.key);
    expect(reqA.kind).toBe("composition");
  });

  it("caps initial blocking gate compositions to the 4 visible clips nearest the playhead", () => {
    const elements = Array.from({ length: 10 }, (_, idx) => ({
      compositionSrc: idx === 4 ? "/api/projects/p1/preview/comp/compositions/s4.html" : `compositions/s${idx}.html`,
      hidden: idx === 5,
      start: idx * 5,
      duration: 5,
    }));
    // Playhead at t=22s sits inside s4 (20..25), next nearest are s3 (dist 2), s2 (dist 7), s6 (dist 8, s5 hidden).
    expect(selectInitialGateCompositionPaths(elements, 22, 4)).toEqual([
      "compositions/s4.html",
      "compositions/s3.html",
      "compositions/s2.html",
      "compositions/s6.html",
    ]);
    // At t=0, picks first 4 clips left-to-right.
    expect(selectInitialGateCompositionPaths(elements, 0, 4)).toEqual([
      "compositions/s0.html",
      "compositions/s1.html",
      "compositions/s2.html",
      "compositions/s3.html",
    ]);
  });

  it("keeps strip object URLs alive past LRU eviction while ThumbnailScheduler retains the result, and revokes on scheduler disposal", async () => {
    const activeUrls = new Set<string>();
    let seq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:test/strip-${++seq}`;
      activeUrls.add(url);
      return url;
    });
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      activeUrls.delete(url);
    });

    const firstInput = {
      previewUrl: "/api/projects/proj-lru/preview/comp/compositions/scene-0.html",
      projectId: "proj-lru",
      contentRevision: 0,
      frameCount: 2,
    };
    const firstVal = seedClientCompositionCaptureForTest(firstInput, [
      new Blob(["a"], { type: "image/jpeg" }),
      new Blob(["b"], { type: "image/jpeg" }),
    ]);
    expect(firstVal.kind).toBe("filmstrip");
    const firstUrls = firstVal.kind === "filmstrip" ? [...firstVal.urls] : [];
    expect(firstUrls).toHaveLength(2);

    const scheduler = new ThumbnailScheduler();
    const req = createClientCompositionCaptureRequest({
      ...firstInput,
      sessionEpoch: 1,
      duration: 5,
    });
    const lease = scheduler.acquire(req, () => {});
    await vi.waitFor(() => {
      expect(scheduler.getSnapshot(req).status).toBe("ready");
    });

    // Release active lease while ThumbnailScheduler still retains the cached ready entry.
    lease.release();
    expect(scheduler.getSnapshot(req).status).toBe("ready");

    // Cache 65 additional distinct strips so scene-0 is evicted from memoryStripCache (max 64).
    for (let i = 1; i <= 65; i += 1) {
      seedClientCompositionCaptureForTest(
        {
          previewUrl: `/api/projects/proj-lru/preview/comp/compositions/scene-${i}.html`,
          projectId: "proj-lru",
          contentRevision: 0,
          frameCount: 2,
        },
        [new Blob([`f${i}-0`]), new Blob([`f${i}-1`])],
      );
    }

    // Evicted from memoryStripCache, yet URLs stay live because ThumbnailScheduler still owns them.
    expect(peekCachedCompositionCapture(firstInput)).toBeNull();
    for (const url of firstUrls) {
      expect(activeUrls.has(url)).toBe(true);
      expect(revokeSpy).not.toHaveBeenCalledWith(url);
    }

    // Remounting a tile receives the ready scheduler snapshot with readable URLs.
    const remountLease = scheduler.acquire(req, () => {});
    const snap = scheduler.getSnapshot(req);
    expect(snap.status).toBe("ready");
    if (snap.status === "ready" && snap.value.kind === "filmstrip") {
      for (const url of snap.value.urls) expect(activeUrls.has(url)).toBe(true);
    }

    // Once the scheduler drops its entry, its dispose() releases the final ref and revokes the URLs.
    remountLease.release();
    scheduler.invalidateProject("proj-lru");
    for (const url of firstUrls) {
      expect(activeUrls.has(url)).toBe(false);
      expect(revokeSpy).toHaveBeenCalledWith(url);
    }
  });

  it("keeps direct sync-hit and reused cover URLs alive past LRU eviction until consumers release", () => {
    const activeUrls = new Set<string>();
    let seq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:test/direct-${++seq}`;
      activeUrls.add(url);
      return url;
    });
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      activeUrls.delete(url);
    });

    const firstInput = {
      previewUrl: "/api/projects/proj-direct/preview/comp/compositions/scene-0.html",
      projectId: "proj-direct",
      contentRevision: 0,
      frameCount: 4,
    };
    seedClientCompositionCaptureForTest(firstInput, [
      new Blob(["0"]),
      new Blob(["1"]),
      new Blob(["2"]),
      new Blob(["3"]),
    ]);

    const stripVal = peekCachedCompositionCapture(firstInput);
    expect(stripVal?.kind).toBe("filmstrip");
    const urlsBeforeCover = seq;
    // Sidebar 1-frame cover reuses the resident strip's URL without creating a duplicate object URL.
    const coverVal = peekCachedCompositionCapture({ ...firstInput, frameCount: 1 });
    expect(coverVal?.kind).toBe("image");
    expect(seq).toBe(urlsBeforeCover);

    const releaseStrip = retainCachedCompositionCapture(stripVal);
    const releaseCover = retainCachedCompositionCapture(coverVal);
    const stripUrls = stripVal?.kind === "filmstrip" ? [...stripVal.urls] : [];

    // Push 65 distinct entries to evict scene-0 from memoryStripCache.
    for (let i = 1; i <= 65; i += 1) {
      seedClientCompositionCaptureForTest(
        {
          previewUrl: `/api/projects/proj-direct/preview/comp/compositions/scene-${i}.html`,
          projectId: "proj-direct",
          contentRevision: 0,
          frameCount: 2,
        },
        [new Blob([`a-${i}`]), new Blob([`b-${i}`])],
      );
    }

    // Both consumers still hold leases -> URLs must not be revoked.
    for (const url of stripUrls) expect(activeUrls.has(url)).toBe(true);

    // Releasing only the strip still leaves the sidebar cover active.
    releaseStrip();
    for (const url of stripUrls) expect(activeUrls.has(url)).toBe(true);

    // Releasing the final consumer revokes all URLs for the evicted entry.
    releaseCover();
    for (const url of stripUrls) {
      expect(activeUrls.has(url)).toBe(false);
      expect(revokeSpy).toHaveBeenCalledWith(url);
    }
  });

  it("mounts the isolated capture iframe inside the viewport with opacity 0 so cross-origin rAF is not throttled", async () => {
    const meta = document.createElement("meta");
    meta.name = "openmotion-preview-origin";
    meta.content = "https://preview.example.test/";
    document.head.appendChild(meta);

    usePlayerStore.setState({
      assetReadinessPhase: "ready",
      assetReadinessSkipped: false,
      editorInputLocked: false,
      isPlaying: false,
    });

    const iframeSrcs = new WeakMap<HTMLIFrameElement, string>();
    const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        return iframeSrcs.get(this) ?? "";
      },
      set(this: HTMLIFrameElement, value: string) {
        iframeSrcs.set(this, String(value));
      },
    });

    const posted: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        token: "tok-isolated-1",
        previewOrigin: "https://preview.example.test",
        assetLease: "lease-1",
      }),
    ) as unknown as typeof fetch;

    let seq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/iso-${++seq}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    try {
      const req = createClientCompositionCaptureRequest({
        previewUrl: "/api/projects/proj-iso/preview/comp/compositions/scene-1.html",
        projectId: "proj-iso",
        sessionEpoch: 1,
        contentRevision: 2,
        frameCount: 2,
        duration: 6,
      });

      const controller = new AbortController();
      const pending = req.load(controller.signal);

      let iframe: HTMLIFrameElement | null = null;
      await vi.waitFor(() => {
        iframe = document.querySelector<HTMLIFrameElement>('iframe[data-openmotion-thumb-capture="true"]');
        expect(iframe).toBeTruthy();
        expect(iframe?.src).toContain("https://preview.example.test/api/projects/proj-iso/preview/comp/compositions/scene-1.html");
        expect(iframe?.src).toContain("capture=1");
        expect(iframe?.src).toContain("pt=tok-isolated-1");
      });

      expect(iframe!.style.position).toBe("fixed");
      expect(iframe!.style.left).toBe("0px");
      expect(iframe!.style.top).toBe("0px");
      expect(iframe!.style.opacity).toBe("0");
      expect(iframe!.style.pointerEvents).toBe("none");
      expect(iframe!.style.zIndex).toBe("-1");
      expect(iframe!.hasAttribute("inert")).toBe(true);
      expect(iframe!.referrerPolicy).toBe("no-referrer");

      const fakeContentWindow = {
        postMessage: (message: Record<string, unknown>, targetOrigin: string) => {
          posted.push({ message, targetOrigin });
          if (message.type === "capture-frames") {
            queueMicrotask(() => {
              window.dispatchEvent(
                new MessageEvent("message", {
                  origin: "https://preview.example.test",
                  source: fakeContentWindow as unknown as Window,
                  data: {
                    source: "openmotion-preview-bridge",
                    version: 1,
                    type: "response",
                    projectId: "proj-iso",
                    token: "tok-isolated-1",
                    requestId: message.requestId,
                    ok: true,
                    result: {
                      frames: [new Uint8Array([1, 2]).buffer, new Uint8Array([3, 4]).buffer],
                      mimeType: "image/jpeg",
                      width: 240,
                      height: 135,
                      aspect: 16 / 9,
                    },
                  },
                }),
              );
            });
          }
        },
      };
      Object.defineProperty(iframe!, "contentWindow", {
        configurable: true,
        value: fakeContentWindow,
      });

      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example.test",
          source: fakeContentWindow as unknown as Window,
          data: {
            source: "openmotion-preview-bridge",
            version: 1,
            type: "timeline-state",
            projectId: "proj-iso",
            token: "tok-isolated-1",
            duration: 6,
            width: 1080,
            height: 1920,
          },
        }),
      );

      const loaded = await pending;
      expect(iframe!.style.width).toBe("1080px");
      expect(iframe!.style.height).toBe("1920px");
      expect(posted).toHaveLength(1);
      expect(posted[0]?.targetOrigin).toBe("https://preview.example.test");
      expect(posted[0]?.message.width).toBe(160);
      expect(loaded.value.kind).toBe("filmstrip");
      if (loaded.value.kind === "filmstrip") {
        expect(loaded.value.urls).toHaveLength(2);
      }
      loaded.dispose?.();
    } finally {
      if (origSrcDescriptor) Object.defineProperty(HTMLIFrameElement.prototype, "src", origSrcDescriptor);
      globalThis.fetch = origFetch;
      meta.remove();
      document.querySelector('iframe[data-openmotion-thumb-capture="true"]')?.remove();
    }
  });

  it("fails fast on preview-build-busy and resets the capture iframe to about:blank", async () => {
    const meta = document.createElement("meta");
    meta.name = "openmotion-preview-origin";
    meta.content = "https://preview.example.test";
    document.head.appendChild(meta);

    usePlayerStore.setState({
      assetReadinessPhase: "ready",
      assetReadinessSkipped: false,
      editorInputLocked: false,
      isPlaying: false,
    });

    const iframeSrcs = new WeakMap<HTMLIFrameElement, string>();
    const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        return iframeSrcs.get(this) ?? "";
      },
      set(this: HTMLIFrameElement, value: string) {
        iframeSrcs.set(this, String(value));
      },
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        token: "tok-busy-1",
        previewOrigin: "https://preview.example.test",
        assetLease: "lease-busy",
      }),
    ) as unknown as typeof fetch;

    try {
      const req = createClientCompositionCaptureRequest({
        previewUrl: "/api/projects/proj-busy/preview/comp/compositions/scene-busy.html",
        projectId: "proj-busy",
        sessionEpoch: 1,
        contentRevision: 1,
        frameCount: 2,
        duration: 5,
      });

      const pending = req.load(new AbortController().signal);
      let iframe: HTMLIFrameElement | null = null;
      await vi.waitFor(() => {
        iframe = document.querySelector<HTMLIFrameElement>('iframe[data-openmotion-thumb-capture="true"]');
        expect(iframe?.src).toContain("pt=tok-busy-1");
      });

      const fakeContentWindow = {} as Window;
      Object.defineProperty(iframe!, "contentWindow", {
        configurable: true,
        value: fakeContentWindow,
      });

      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example.test",
          source: fakeContentWindow,
          data: {
            source: "openmotion-preview-bridge",
            version: 1,
            type: "preview-build-busy",
            projectId: "proj-busy",
            token: "tok-busy-1",
            retryAfterMs: 1000,
          },
        }),
      );

      await expect(pending).rejects.toThrow(/busy/i);
      expect(iframe!.src).toBe("about:blank");
    } finally {
      if (origSrcDescriptor) Object.defineProperty(HTMLIFrameElement.prototype, "src", origSrcDescriptor);
      globalThis.fetch = origFetch;
      meta.remove();
      document.querySelector('iframe[data-openmotion-thumb-capture="true"]')?.remove();
    }
  });

  it("downgrades credentials from include to same-origin only for same-origin preview assets and restores fetch", async () => {
    const calls: Array<{ input: RequestInfo | URL; credentials?: RequestCredentials }> = [];
    const origFetch = globalThis.fetch;
    const stubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, credentials: init?.credentials });
      return new Response("ok");
    }) as unknown as typeof fetch;
    globalThis.fetch = stubFetch;

    try {
      await withPreviewRedirectSafeFetch(async () => {
        await globalThis.fetch("/api/projects/p1/preview/assets/hero.png", { credentials: "include" });
        await globalThis.fetch("/motion-api/projects", { credentials: "include" });
        await globalThis.fetch("https://cdn.example.test/image.png", { credentials: "include" });
      });
      expect(globalThis.fetch).toBe(stubFetch);
      expect(calls).toEqual([
        { input: "/api/projects/p1/preview/assets/hero.png", credentials: "same-origin" },
        { input: "/motion-api/projects", credentials: "include" },
        { input: "https://cdn.example.test/image.png", credentials: "include" },
      ]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("keeps withPreviewRedirectSafeFetch re-entrant across concurrent same-origin captures and restores fetch only after the last exits", async () => {
    const calls: Array<{ input: RequestInfo | URL; credentials?: RequestCredentials }> = [];
    const origFetch = globalThis.fetch;
    const stubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, credentials: init?.credentials });
      return new Response("ok");
    }) as unknown as typeof fetch;
    globalThis.fetch = stubFetch;

    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    const secondGate = new Promise<void>((r) => { releaseSecond = r; });

    try {
      const job1 = withPreviewRedirectSafeFetch(async () => {
        await globalThis.fetch("/api/projects/p1/preview/assets/one.png", { credentials: "include" });
        await firstGate;
      });
      const job2 = withPreviewRedirectSafeFetch(async () => {
        await secondGate;
        // Runs AFTER job1 has exited: wrapper must still downgrade preview asset credentials.
        await globalThis.fetch("/api/projects/p1/preview/assets/two.png", { credentials: "include" });
      });

      // Finish job1 while job2 is still active.
      releaseFirst();
      await job1;
      expect(globalThis.fetch).not.toBe(stubFetch);

      // Now finish job2 and confirm original fetch is restored exactly.
      releaseSecond();
      await job2;
      expect(globalThis.fetch).toBe(stubFetch);
      expect(calls).toEqual([
        { input: "/api/projects/p1/preview/assets/one.png", credentials: "same-origin" },
        { input: "/api/projects/p1/preview/assets/two.png", credentials: "same-origin" },
      ]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("keeps untouched sibling compositions cached when per-composition revisions update only one scene", () => {
    setCachedProjectRevision("proj-percomp", "rev-1", {
      "compositions/scene-1.html": "sha1:head:shared",
      "compositions/scene-2.html": "sha2:head:shared",
    });

    const scene1Input = {
      previewUrl: "/api/projects/proj-percomp/preview/comp/compositions/scene-1.html",
      projectId: "proj-percomp",
      contentRevision: 0,
      frameCount: 4,
    };
    const scene2Input = {
      previewUrl: "/api/projects/proj-percomp/preview/comp/compositions/scene-2.html",
      projectId: "proj-percomp",
      contentRevision: 0,
      frameCount: 4,
    };
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/pc-${Math.random()}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    seedClientCompositionCaptureForTest(scene1Input, [new Blob(["1a"]), new Blob(["1b"])]);
    seedClientCompositionCaptureForTest(scene2Input, [new Blob(["2a"]), new Blob(["2b"])]);
    const req1Before = createClientCompositionCaptureRequest({ ...scene1Input, sessionEpoch: 1 });
    const req2Before = createClientCompositionCaptureRequest({ ...scene2Input, sessionEpoch: 1 });

    // Only scene-2 changed; whole-project revision bumped from rev-1 -> rev-2.
    const listener = vi.fn();
    const unsubRev = subscribeCompositionCacheRevision("proj-percomp", listener);
    setCachedProjectRevision("proj-percomp", "rev-2", {
      "compositions/scene-1.html": "sha1:head:shared",
      "compositions/scene-2.html": "sha2-edited:head:shared",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getCompositionCacheRevision("proj-percomp", scene1Input.previewUrl)).toBe("sha1:head:shared");
    expect(getCompositionCacheRevision("proj-percomp", scene2Input.previewUrl)).toBe("sha2-edited:head:shared");
    // Re-setting identical revisions does not trigger spurious re-renders.
    setCachedProjectRevision("proj-percomp", "rev-2", {
      "compositions/scene-1.html": "sha1:head:shared",
      "compositions/scene-2.html": "sha2-edited:head:shared",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubRev();

    expect(peekCachedCompositionCapture(scene1Input)).not.toBeNull();
    expect(peekCachedCompositionCapture(scene2Input)).toBeNull();
    expect(createClientCompositionCaptureRequest({ ...scene1Input, sessionEpoch: 1 }).key).toBe(req1Before.key);
    expect(createClientCompositionCaptureRequest({ ...scene2Input, sessionEpoch: 1 }).key).not.toBe(req2Before.key);
    expect(req1Before.concurrencyBucket).toBe("client-capture");
  });

  it("reuses one shared preview-token across concurrent capture slots and streams progressive frames without duplicating URLs", async () => {
    const meta = document.createElement("meta");
    meta.name = "openmotion-preview-origin";
    meta.content = "https://preview.example.test";
    document.head.appendChild(meta);

    usePlayerStore.setState({
      assetReadinessPhase: "ready",
      assetReadinessSkipped: false,
      editorInputLocked: false,
      isPlaying: false,
    });

    const iframeSrcs = new WeakMap<HTMLIFrameElement, string>();
    const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        return iframeSrcs.get(this) ?? "";
      },
      set(this: HTMLIFrameElement, value: string) {
        iframeSrcs.set(this, String(value));
      },
    });

    const origFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () =>
      Response.json({
        token: "tok-shared-pool",
        previewOrigin: "https://preview.example.test",
        assetLease: "lease-shared",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const createdUrls: string[] = [];
    const revokedUrls: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:test/prog-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revokedUrls.push(String(url));
    });

    try {
      const inputs = [0, 1, 2, 3].map((idx) => ({
        previewUrl: `/api/projects/proj-pool/preview/comp/compositions/scene-${idx}.html`,
        projectId: "proj-pool",
        sessionEpoch: 1,
        contentRevision: 0,
        frameCount: 4,
        duration: 8,
      }));

      // Subscribe to progressive frame updates on scene-0.
      const progressiveSnapshots: Array<ReturnType<typeof getProgressiveCompositionCapture>> = [];
      const unsub = subscribeProgressiveCompositionCapture(inputs[0]!, () => {
        progressiveSnapshots.push(getProgressiveCompositionCapture(inputs[0]!));
      });

      const pending = inputs.map((inp) =>
        createClientCompositionCaptureRequest(inp).load(new AbortController().signal),
      );

      // Exactly 3 concurrent iframes should be spawned (4th waits in pool) and only 1 preview-token POST made.
      let iframes: HTMLIFrameElement[] = [];
      await vi.waitFor(() => {
        iframes = Array.from(
          document.querySelectorAll<HTMLIFrameElement>('iframe[data-openmotion-thumb-capture="true"]'),
        );
        expect(iframes).toHaveLength(3);
        expect(iframes.every((f) => f.src.includes("pt=tok-shared-pool"))).toBe(true);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Attach mock contentWindows to all 3 slots; hold scene-0 after frame 1 to inspect progressive UI state.
      let finishScene0: (() => void) | null = null;
      const attachMockWindow = (iframe: HTMLIFrameElement, holdMidway: boolean) => {
        const win = {
          postMessage: (message: Record<string, unknown>) => {
            if (message.type !== "capture-frames") return;
            expect(message.progressive).toBe(true);
            const sendFrame = (index: number) => {
              window.dispatchEvent(
                new MessageEvent("message", {
                  origin: "https://preview.example.test",
                  source: win as unknown as Window,
                  data: {
                    source: "openmotion-preview-bridge",
                    version: 1,
                    type: "capture-frame",
                    projectId: "proj-pool",
                    token: "tok-shared-pool",
                    requestId: message.requestId,
                    index,
                    total: 4,
                    frame: new Uint8Array([index + 1]).buffer,
                    mimeType: "image/jpeg",
                    width: 240,
                    height: 135,
                    aspect: 16 / 9,
                  },
                }),
              );
            };
            const sendDone = () => {
              window.dispatchEvent(
                new MessageEvent("message", {
                  origin: "https://preview.example.test",
                  source: win as unknown as Window,
                  data: {
                    source: "openmotion-preview-bridge",
                    version: 1,
                    type: "response",
                    projectId: "proj-pool",
                    token: "tok-shared-pool",
                    requestId: message.requestId,
                    ok: true,
                    result: {
                      frames: [],
                      streamed: true,
                      frameCount: 4,
                      mimeType: "image/jpeg",
                      width: 240,
                      height: 135,
                      aspect: 16 / 9,
                    },
                  },
                }),
              );
            };
            queueMicrotask(() => {
              sendFrame(2); // Hero cover frame first
              if (holdMidway) {
                finishScene0 = () => {
                  sendFrame(0);
                  sendFrame(1);
                  sendFrame(3);
                  sendDone();
                };
              } else {
                sendFrame(0);
                sendFrame(1);
                sendFrame(3);
                sendDone();
              }
            });
          },
        };
        Object.defineProperty(iframe, "contentWindow", { configurable: true, value: win });
        return win;
      };

      const slotWins = iframes.map((iframe, idx) => attachMockWindow(iframe, idx === 0));
      for (const win of slotWins) {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "https://preview.example.test",
            source: win as unknown as Window,
            data: {
              source: "openmotion-preview-bridge",
              version: 1,
              type: "timeline-state",
              projectId: "proj-pool",
              token: "tok-shared-pool",
              duration: 8,
              width: 1280,
              height: 720,
            },
          }),
        );
      }

      // Scene-0 should emit a progressive filmstrip after its very first frame, and seed the 1-frame cover cache.
      await vi.waitFor(() => {
        expect(progressiveSnapshots.length).toBeGreaterThanOrEqual(1);
        expect(finishScene0).not.toBeNull();
      });
      const firstProg = progressiveSnapshots[0];
      expect(firstProg?.kind).toBe("filmstrip");
      const heroUrl = firstProg?.kind === "filmstrip" ? firstProg.urls[0] : "";
      expect(heroUrl).toBeTruthy();

      // Scene-1 and Scene-2 finish, freeing a slot for Scene-3 which reuses the same warm iframe + shared token.
      await vi.waitFor(() => {
        expect(iframes.some((f) => f.src.includes("scene-3.html"))).toBe(true);
      });
      const scene3Idx = iframes.findIndex((f) => f.src.includes("scene-3.html"));
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example.test",
          source: slotWins[scene3Idx] as unknown as Window,
          data: {
            source: "openmotion-preview-bridge",
            version: 1,
            type: "timeline-state",
            projectId: "proj-pool",
            token: "tok-shared-pool",
            duration: 8,
            width: 1280,
            height: 720,
          },
        }),
      );

      // Complete Scene-0's remaining frames; final filmstrip must reuse heroUrl at index 2 without revoking it.
      finishScene0!();
      const results = await Promise.all(pending);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll('iframe[data-openmotion-thumb-capture="true"]')).toHaveLength(3);
      const scene0Val = results[0]!.value;
      expect(scene0Val.kind).toBe("filmstrip");
      if (scene0Val.kind === "filmstrip") {
        expect(scene0Val.urls).toHaveLength(4);
        expect(scene0Val.urls[2]).toBe(heroUrl);
      }
      expect(revokedUrls).not.toContain(heroUrl);
      expect(getProgressiveCompositionCapture(inputs[0]!)).toBeNull();
      unsub();
      for (const res of results) res.dispose?.();
    } finally {
      if (origSrcDescriptor) Object.defineProperty(HTMLIFrameElement.prototype, "src", origSrcDescriptor);
      globalThis.fetch = origFetch;
      meta.remove();
    }
  });

  it("reuses the live player's bindPreviewLease grant with zero extra preview-token requests", async () => {
    const meta = document.createElement("meta");
    meta.name = "openmotion-preview-origin";
    meta.content = "https://preview.example.test";
    document.head.appendChild(meta);

    usePlayerStore.setState({
      assetReadinessPhase: "ready",
      assetReadinessSkipped: false,
      editorInputLocked: false,
      isPlaying: false,
    });

    const iframeSrcs = new WeakMap<HTMLIFrameElement, string>();
    const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        return iframeSrcs.get(this) ?? "";
      },
      set(this: HTMLIFrameElement, value: string) {
        iframeSrcs.set(this, String(value));
      },
    });

    const origFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () =>
      Response.json({
        token: "tok-live-player",
        previewOrigin: "https://preview.example.test",
        assetLease: "lease-live-player",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test/live-reuse");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const navigate = vi.fn();
    const liveLease = bindPreviewLease(
      new URL("https://studio.example.test/api/projects/proj-live/preview"),
      "https://preview.example.test",
      navigate,
      vi.fn(),
    );

    try {
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const req = createClientCompositionCaptureRequest({
        previewUrl: "/api/projects/proj-live/preview/comp/compositions/s1.html",
        projectId: "proj-live",
        sessionEpoch: 1,
        contentRevision: 0,
        frameCount: 1,
        duration: 5,
      });
      const pending = req.load(new AbortController().signal);

      let iframe: HTMLIFrameElement | null = null;
      await vi.waitFor(() => {
        iframe = document.querySelector<HTMLIFrameElement>('iframe[data-openmotion-thumb-capture="true"]');
        expect(iframe?.src).toContain("pt=tok-live-player");
      });
      // Zero additional POST /preview-token calls!
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const fakeWin = {
        postMessage: (msg: Record<string, unknown>) => {
          if (msg.type === "capture-frames") {
            queueMicrotask(() => {
              window.dispatchEvent(
                new MessageEvent("message", {
                  origin: "https://preview.example.test",
                  source: fakeWin as unknown as Window,
                  data: {
                    source: "openmotion-preview-bridge",
                    version: 1,
                    type: "response",
                    projectId: "proj-live",
                    token: "tok-live-player",
                    requestId: msg.requestId,
                    ok: true,
                    result: {
                      frames: [new Uint8Array([9, 8]).buffer],
                      mimeType: "image/jpeg",
                      width: 240,
                      height: 135,
                      aspect: 16 / 9,
                    },
                  },
                }),
              );
            });
          }
        },
      };
      Object.defineProperty(iframe!, "contentWindow", { configurable: true, value: fakeWin });
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example.test",
          source: fakeWin as unknown as Window,
          data: {
            source: "openmotion-preview-bridge",
            version: 1,
            type: "timeline-state",
            projectId: "proj-live",
            token: "tok-live-player",
            duration: 5,
            width: 1280,
            height: 720,
          },
        }),
      );

      const loaded = await pending;
      expect(loaded.value.kind).toBe("image");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      loaded.dispose?.();
    } finally {
      liveLease.dispose();
      if (origSrcDescriptor) Object.defineProperty(HTMLIFrameElement.prototype, "src", origSrcDescriptor);
      globalThis.fetch = origFetch;
      meta.remove();
    }
  });

  it("returns the freshest same-clip filmstrip fallback across revisions and frame counts without bleeding across clips", () => {
    const previewUrl = "/api/projects/proj-fb/preview/comp/compositions/scene.html";
    setCachedProjectRevision("proj-fb", "rev-1");
    const strip4 = seedClientCompositionCaptureForTest(
      { projectId: "proj-fb", previewUrl, contentRevision: 0, frameCount: 4 },
      [new Blob(["1"]), new Blob(["2"]), new Blob(["3"]), new Blob(["4"])],
    );
    const single1 = seedClientCompositionCaptureForTest(
      { projectId: "proj-fb", previewUrl, contentRevision: 1, frameCount: 1 },
      [new Blob(["cover"])],
    );
    expect(single1.kind).toBe("image");

    // Prefers the existing multi-frame filmstrip over a 1-frame render for the same clip.
    setCachedProjectRevision("proj-fb", "rev-2");
    expect(peekFallbackCompositionCapture({ projectId: "proj-fb", previewUrl })).toBe(strip4);

    // Different clip or selector never receives this clip's fallback.
    expect(
      peekFallbackCompositionCapture({
        projectId: "proj-fb",
        previewUrl: "/api/projects/proj-fb/preview/comp/compositions/other.html",
      }),
    ).toBeNull();
    expect(
      peekFallbackCompositionCapture({
        projectId: "proj-fb",
        previewUrl,
        selector: "#headline",
      }),
    ).toBeNull();

    // Once a newer filmstrip is seeded, fallback prefers the newest one.
    const strip8 = seedClientCompositionCaptureForTest(
      { projectId: "proj-fb", previewUrl, contentRevision: 2, frameCount: 8 },
      Array.from({ length: 8 }, (_, idx) => new Blob([String(idx)])),
    );
    expect(peekFallbackCompositionCapture({ projectId: "proj-fb", previewUrl })).toBe(strip8);
  });

  it("keys per-file captures by file version plus shared head/asset tag, ignores session contentRevision, and reuses canonical strips for narrower frame counts", () => {
    const introUrl = "/api/projects/proj-fv/preview/comp/compositions/intro.html";
    const outroUrl = "/api/projects/proj-fv/preview/comp/compositions/outro.html";
    let seq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/fv-${++seq}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    setCachedProjectRevision("proj-fv", "proj-rev-1", {
      "compositions/intro.html": '"sha256:intro-v1"|shared:111111111111:222222222222',
      "compositions/outro.html": '"sha256:outro-v1"|shared:111111111111:222222222222',
      "compositions/dynamic.html": "proj-rev-1",
    });

    // Fail-closed compositions equal to projectRevision keep tracking live session contentRevision bumps.
    const dynamicUrl = "/api/projects/proj-fv/preview/comp/compositions/dynamic.html";
    expect(getCompositionCacheKeyRevision("proj-fv", dynamicUrl, 0)).toBe("rev:proj-rev-1|0");
    expect(getCompositionCacheKeyRevision("proj-fv", dynamicUrl, 3)).toBe("rev:proj-rev-1|3");

    const introV1 = seedClientCompositionCaptureForTest(
      { projectId: "proj-fv", previewUrl: introUrl, contentRevision: 0, frameCount: 8 },
      Array.from({ length: 8 }, (_, idx) => new Blob([`v1-${idx}`])),
    );
    const urlsAfterSeed = seq;

    // Session-local contentRevision bumps do not bust a persisted file version.
    expect(getCompositionCacheKeyRevision("proj-fv", introUrl, 0)).toBe('file:"sha256:intro-v1"|shared:111111111111:222222222222');
    expect(getCompositionCacheKeyRevision("proj-fv", introUrl, 5)).toBe('file:"sha256:intro-v1"|shared:111111111111:222222222222');
    expect(
      peekCachedCompositionCapture({ projectId: "proj-fv", previewUrl: introUrl, contentRevision: 5, frameCount: 8 }),
    ).toBe(introV1);

    // Narrower frame counts (4, 2, 1) reuse the canonical 8-frame strip with zero duplicate URLs.
    expect(
      peekCachedCompositionCapture({ projectId: "proj-fv", previewUrl: introUrl, contentRevision: 0, frameCount: 4 }),
    ).toBe(introV1);
    expect(
      peekCachedCompositionCapture({ projectId: "proj-fv", previewUrl: introUrl, contentRevision: 0, frameCount: 2 }),
    ).toBe(introV1);
    const cover = peekCachedCompositionCapture({
      projectId: "proj-fv",
      previewUrl: introUrl,
      contentRevision: 0,
      frameCount: 1,
    });
    expect(cover?.kind).toBe("image");
    expect(seq).toBe(urlsAfterSeed);

    // index.html <body> edit (same indexHeadHash) & non-preview metadata leave intro.html and outro.html cached.
    const listener = vi.fn();
    const unsub = subscribeCompositionCacheRevision("proj-fv", listener);
    updateCachedCompositionRevisions(
      "proj-fv",
      {
        "index.html": '"patch:idx-2"',
        "motion-project.json": '"sha256:meta-2"',
      },
      { indexHeadHash: "111111111111" },
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      peekCachedCompositionCapture({ projectId: "proj-fv", previewUrl: introUrl, contentRevision: 0, frameCount: 8 }),
    ).toBe(introV1);

    // Real file-version update for intro.html preserves |shared: and invalidates only intro.html.
    updateCachedCompositionRevisions("proj-fv", { "compositions/intro.html": '"patch:intro-v2"' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(
      peekCachedCompositionCapture({ projectId: "proj-fv", previewUrl: introUrl, contentRevision: 0, frameCount: 8 }),
    ).toBeNull();
    expect(getCompositionCacheRevision("proj-fv", introUrl)).toBe('"patch:intro-v2"|shared:111111111111:222222222222');
    expect(getCompositionCacheRevision("proj-fv", outroUrl)).toBe('"sha256:outro-v1"|shared:111111111111:222222222222');

    // Undo back to v1 immediately hits the cached v1 strip with zero re-capture.
    updateCachedCompositionRevisions("proj-fv", { "compositions/intro.html": '"sha256:intro-v1"' });
    expect(
      peekCachedCompositionCapture({ projectId: "proj-fv", previewUrl: introUrl, contentRevision: 0, frameCount: 8 }),
    ).toBe(introV1);

    // Shared stylesheet edit invalidates every composition immediately without a reload,
    // while keeping fail-closed compositions on `rev:<projectRev>|<contentRevision>`.
    updateCachedCompositionRevisions("proj-fv", {
      "styles/theme.css": '"patch:css-2"',
      "compositions/dynamic.html": '"patch:dyn-2"',
    });
    expect(
      peekCachedCompositionCapture({ projectId: "proj-fv", previewUrl: introUrl, contentRevision: 0, frameCount: 8 }),
    ).toBeNull();
    expect(getCompositionCacheRevision("proj-fv", outroUrl)).not.toBe('"sha256:outro-v1"|shared:111111111111:222222222222');
    expect(getCompositionCacheKeyRevision("proj-fv", dynamicUrl, 4)).toBe("rev:proj-rev-1|4");
    unsub();
  });

  it("reuses a single warm isolated capture iframe across sibling selector clips of the same composition without reloading", async () => {
    const meta = document.createElement("meta");
    meta.name = "openmotion-preview-origin";
    meta.content = "https://preview.example.test";
    document.head.appendChild(meta);

    usePlayerStore.setState({
      assetReadinessPhase: "ready",
      assetReadinessSkipped: false,
      editorInputLocked: false,
      isPlaying: false,
    });

    const iframeSrcs = new WeakMap<HTMLIFrameElement, string>();
    const srcAssignments: string[] = [];
    const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        return iframeSrcs.get(this) ?? "";
      },
      set(this: HTMLIFrameElement, value: string) {
        const next = String(value);
        iframeSrcs.set(this, next);
        srcAssignments.push(next);
      },
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        token: "tok-reuse-same-doc",
        previewOrigin: "https://preview.example.test",
        assetLease: "lease-reuse",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    ) as unknown as typeof fetch;
    let urlSeq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/reuse-${++urlSeq}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    try {
      const selectors = ['[data-hf-id="clip-1"]', '[data-hf-id="clip-2"]', '[data-hf-id="clip-3"]'];
      const pending = selectors.map((selector) =>
        createClientCompositionCaptureRequest({
          previewUrl: "/api/projects/proj-reuse/preview/comp/compositions/chart.html",
          projectId: "proj-reuse",
          sessionEpoch: 1,
          contentRevision: 4,
          frameCount: 2,
          seekTime: 0,
          duration: 10,
          selector,
        }).load(new AbortController().signal),
      );

      let iframe: HTMLIFrameElement | null = null;
      await vi.waitFor(() => {
        const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-openmotion-thumb-capture="true"]');
        expect(frames).toHaveLength(1);
        iframe = frames[0]!;
        expect(iframe.src).toContain("compositions/chart.html");
      });

      const postedSelectors: string[] = [];
      const fakeWin = {
        postMessage: (msg: Record<string, unknown>) => {
          if (msg.type !== "capture-frames") return;
          postedSelectors.push(String(msg.selector ?? ""));
          queueMicrotask(() => {
            window.dispatchEvent(
              new MessageEvent("message", {
                origin: "https://preview.example.test",
                source: fakeWin as unknown as Window,
                data: {
                  source: "openmotion-preview-bridge",
                  version: 1,
                  type: "response",
                  projectId: "proj-reuse",
                  token: "tok-reuse-same-doc",
                  requestId: msg.requestId,
                  ok: true,
                  result: {
                    frames: [new Uint8Array([1]).buffer, new Uint8Array([2]).buffer],
                    mimeType: "image/jpeg",
                    width: 240,
                    height: 135,
                    aspect: 16 / 9,
                  },
                },
              }),
            );
          });
        },
      };
      Object.defineProperty(iframe!, "contentWindow", { configurable: true, value: fakeWin });

      // Send timeline-state ONLY ONCE — clips 2 & 3 must reuse the already-loaded iframe without navigation.
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example.test",
          source: fakeWin as unknown as Window,
          data: {
            source: "openmotion-preview-bridge",
            version: 1,
            type: "timeline-state",
            projectId: "proj-reuse",
            token: "tok-reuse-same-doc",
            duration: 10,
            width: 1920,
            height: 1080,
          },
        }),
      );

      const results = await Promise.all(pending);
      expect(results).toHaveLength(3);
      expect(document.querySelectorAll('iframe[data-openmotion-thumb-capture="true"]')).toHaveLength(1);
      expect(srcAssignments.filter((s) => s.includes("chart.html"))).toHaveLength(1);
      expect(postedSelectors).toEqual(selectors);
      for (const r of results) r.dispose?.();
    } finally {
      if (origSrcDescriptor) Object.defineProperty(HTMLIFrameElement.prototype, "src", origSrcDescriptor);
      globalThis.fetch = origFetch;
      meta.remove();
    }
  });

  it("bounds post-edit refresh captures (contentRevision > 0) to 1 concurrent iframe even across distinct scenes", async () => {
    const meta = document.createElement("meta");
    meta.name = "openmotion-preview-origin";
    meta.content = "https://preview.example.test";
    document.head.appendChild(meta);

    usePlayerStore.setState({
      assetReadinessPhase: "ready",
      assetReadinessSkipped: false,
      editorInputLocked: false,
      isPlaying: false,
    });

    const iframeSrcs = new WeakMap<HTMLIFrameElement, string>();
    const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        return iframeSrcs.get(this) ?? "";
      },
      set(this: HTMLIFrameElement, value: string) {
        iframeSrcs.set(this, String(value));
      },
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        token: "tok-edit-cap",
        previewOrigin: "https://preview.example.test",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    ) as unknown as typeof fetch;

    try {
      const c1 = new AbortController();
      const c2 = new AbortController();
      const p1 = createClientCompositionCaptureRequest({
        previewUrl: "/api/projects/proj-edit/preview/comp/compositions/a.html",
        projectId: "proj-edit",
        sessionEpoch: 1,
        contentRevision: 2,
        frameCount: 2,
        duration: 5,
      }).load(c1.signal);
      const p2 = createClientCompositionCaptureRequest({
        previewUrl: "/api/projects/proj-edit/preview/comp/compositions/b.html",
        projectId: "proj-edit",
        sessionEpoch: 1,
        contentRevision: 2,
        frameCount: 2,
        duration: 5,
      }).load(c2.signal);

      await vi.waitFor(() => {
        const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-openmotion-thumb-capture="true"]');
        expect(frames).toHaveLength(1);
        expect(frames[0]?.src).toContain("compositions/a.html");
      });
      // Give the queue a tick to confirm the second edit-refresh scene stays queued rather than booting a 2nd iframe.
      await new Promise((r) => setTimeout(r, 20));
      expect(document.querySelectorAll('iframe[data-openmotion-thumb-capture="true"]')).toHaveLength(1);

      c1.abort();
      c2.abort();
      await Promise.allSettled([p1, p2]);
    } finally {
      if (origSrcDescriptor) Object.defineProperty(HTMLIFrameElement.prototype, "src", origSrcDescriptor);
      globalThis.fetch = origFetch;
      meta.remove();
    }
  });

  it("evicts redundant stale revisions on edit invalidation while keeping one fallback strip until the new revision lands", () => {
    const activeUrls = new Set<string>();
    let seq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:test/evict-${++seq}`;
      activeUrls.add(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      activeUrls.delete(String(url));
    });

    const rev0A2 = {
      previewUrl: "/api/projects/proj-evict/preview/comp/compositions/a.html",
      projectId: "proj-evict",
      contentRevision: 0,
      frameCount: 2,
    };
    const rev0A4 = {
      previewUrl: "/api/projects/proj-evict/preview/comp/compositions/a.html",
      projectId: "proj-evict",
      contentRevision: 0,
      frameCount: 4,
    };
    const rev0B = {
      previewUrl: "/api/projects/proj-evict/preview/comp/compositions/b.html",
      projectId: "proj-evict",
      contentRevision: 0,
      frameCount: 2,
    };
    const valA2 = seedClientCompositionCaptureForTest(rev0A2, [new Blob(["a1"]), new Blob(["a2"])]);
    const valA4 = seedClientCompositionCaptureForTest(rev0A4, [
      new Blob(["a1"]),
      new Blob(["a2"]),
      new Blob(["a3"]),
      new Blob(["a4"]),
    ]);
    const valB = seedClientCompositionCaptureForTest(rev0B, [new Blob(["b1"]), new Blob(["b2"])]);
    const urlsA2 = valA2.kind === "filmstrip" ? [...valA2.urls] : [];
    const urlsA4 = valA4.kind === "filmstrip" ? [...valA4.urls] : [];
    const urlsB = valB.kind === "filmstrip" ? [...valB.urls] : [];

    // Bumping revision for a.html immediately evicts redundant stale variants (rev0A2) while keeping
    // only the single freshest fallback (rev0A4) until rev 1 lands; untouched b.html stays warm.
    evictStaleCompositionCaptures("proj-evict", ["compositions/a.html"], { "compositions/a.html": 1 });
    expect(peekCachedCompositionCapture(rev0A2)).toBeNull();
    expect(peekFallbackCompositionCapture({ projectId: "proj-evict", previewUrl: rev0A4.previewUrl })).toBe(valA4);
    expect(peekCachedCompositionCapture(rev0B)).toBe(valB);
    for (const url of urlsA2) expect(activeUrls.has(url)).toBe(false);
    for (const url of urlsA4) expect(activeUrls.has(url)).toBe(true);
    for (const url of urlsB) expect(activeUrls.has(url)).toBe(true);

    // Once rev 1 finishes capturing, the retained rev 0 fallback is immediately evicted and revoked.
    const valA1 = seedClientCompositionCaptureForTest(
      { ...rev0A4, contentRevision: 1 },
      [new Blob(["n1"]), new Blob(["n2"]), new Blob(["n3"]), new Blob(["n4"])],
    );
    expect(peekCachedCompositionCapture(rev0A4)).toBeNull();
    expect(peekFallbackCompositionCapture({ projectId: "proj-evict", previewUrl: rev0A4.previewUrl })).toBe(valA1);
    for (const url of urlsA4) expect(activeUrls.has(url)).toBe(false);

    // Updating project per-composition revision for b.html keeps its single fallback until the new revision lands,
    // then revokes the previous revision immediately on arrival.
    setCachedProjectRevision("proj-evict", "proj-rev-2", { "compositions/b.html": "sha-b-2" });
    expect(peekFallbackCompositionCapture({ projectId: "proj-evict", previewUrl: rev0B.previewUrl })).toBe(valB);
    const valB2 = seedClientCompositionCaptureForTest(rev0B, [new Blob(["nb1"]), new Blob(["nb2"])]);
    expect(peekFallbackCompositionCapture({ projectId: "proj-evict", previewUrl: rev0B.previewUrl })).toBe(valB2);
    for (const url of urlsB) expect(activeUrls.has(url)).toBe(false);
  });

  it("does not pin superseded MemoryStripEntry object URLs or stale poster entries in ThumbnailScheduler across edits", async () => {
    const activeUrls = new Set<string>();
    let seq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:test/sched-${++seq}`;
      activeUrls.add(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      activeUrls.delete(String(url));
    });

    const previewUrl = "/api/projects/proj-sched/preview/comp/compositions/choice.html";
    const rev0 = {
      previewUrl,
      projectId: "proj-sched",
      contentRevision: 0,
      frameCount: 2,
    };
    const val0 = seedClientCompositionCaptureForTest(rev0, [new Blob(["f1"]), new Blob(["f2"])]);
    const urls0 = val0.kind === "filmstrip" ? [...val0.urls] : [];

    // Acquire rev 0 on the singleton ThumbnailScheduler (matching live CompositionThumbnail).
    const req0 = createClientCompositionCaptureRequest({ ...rev0, sessionEpoch: 1 });
    const lease0 = thumbnailScheduler.acquire(req0, () => {});
    await vi.waitFor(() => {
      expect(thumbnailScheduler.getSnapshot(req0).status).toBe("ready");
    });

    // Also acquire an unleased stale composition poster entry for rev 0.
    const posterDispose = vi.fn();
    const posterLease = thumbnailScheduler.acquire(
      {
        key: "cloud=1&kind=composition&url=choice-rev0",
        projectId: "proj-sched",
        sessionEpoch: 1,
        kind: "composition",
        priority: "visible",
        compositionPath: "compositions/choice.html",
        contentRevision: 0,
        load: async () => ({
          value: { kind: "image", url: "blob:test/poster-0", aspect: 16 / 9, representative: "text" },
          weight: 1024,
          dispose: posterDispose,
        }),
      },
      () => {},
    );
    await vi.waitFor(() => {
      expect(thumbnailScheduler.getDiagnostics().cacheEntries).toBeGreaterThanOrEqual(2);
    });
    posterLease.release();

    // Edit invalidation runs while React still holds lease0 (before switching to rev 1).
    evictStaleCompositionCaptures("proj-sched", ["compositions/choice.html"], { "compositions/choice.html": 1 });
    // Unleased stale poster is disposed immediately.
    expect(posterDispose).toHaveBeenCalledTimes(1);
    // Still-leased rev 0 capture remains alive until React switches and releases lease0.
    for (const url of urls0) expect(activeUrls.has(url)).toBe(true);

    // React switches to rev 1 and releases lease0 -> ThumbnailScheduler drops rev 0 immediately (not pinned in LRU).
    lease0.release();
    expect(thumbnailScheduler.getSnapshot(req0).status).toBe("idle");

    // Once rev 1 finishes capturing, rev 0's blob URLs are immediately revoked because refCount is now 0.
    const val1 = seedClientCompositionCaptureForTest(
      { ...rev0, contentRevision: 1 },
      [new Blob(["n1"]), new Blob(["n2"])],
    );
    expect(val1.kind).toBe("filmstrip");
    for (const url of urls0) expect(activeUrls.has(url)).toBe(false);
    thumbnailScheduler.invalidateProject("proj-sched");
  });

  it("does not cache an in-flight capture whose revision was invalidated before acceptResult ran", async () => {
    const activeUrls = new Set<string>();
    let seq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:test/inflight-${++seq}`;
      activeUrls.add(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      activeUrls.delete(String(url));
    });

    const previewUrl = "/api/projects/proj-inflight/preview/comp/compositions/choice.html";
    const rev0 = {
      previewUrl,
      projectId: "proj-inflight",
      contentRevision: 0,
      frameCount: 2,
    };
    const val0 = seedClientCompositionCaptureForTest(rev0, [new Blob(["i1"]), new Blob(["i2"])]);
    const urls0 = val0.kind === "filmstrip" ? [...val0.urls] : [];

    // Acquire rev 0 on the singleton scheduler: synchronously it is still in "loading" state
    // because load() resolves on a microtask.
    const req0 = createClientCompositionCaptureRequest({ ...rev0, sessionEpoch: 1 });
    const lease0 = thumbnailScheduler.acquire(req0, () => {});
    expect(thumbnailScheduler.getSnapshot(req0).status).toBe("loading");

    // Trigger edit invalidation BEFORE rev 0 resolves into acceptResult().
    evictStaleCompositionCaptures("proj-inflight", ["compositions/choice.html"], { "compositions/choice.html": 1 });

    // Let rev 0's microtask settle while React still holds lease0.
    await vi.waitFor(() => {
      expect(thumbnailScheduler.getSnapshot(req0).status).toBe("ready");
    });

    // Releasing lease0 must drop rev 0 immediately instead of keeping it cached in ThumbnailScheduler.
    lease0.release();
    expect(thumbnailScheduler.getSnapshot(req0).status).toBe("idle");

    // When rev 1 lands, rev 0's object URLs are revoked immediately (refCount reached 0).
    seedClientCompositionCaptureForTest(
      { ...rev0, contentRevision: 1 },
      [new Blob(["r1"]), new Blob(["r2"])],
    );
    for (const url of urls0) expect(activeUrls.has(url)).toBe(false);
    thumbnailScheduler.invalidateProject("proj-inflight");
  });

  it("ignores session-local eviction for file-version-pinned strips and evicts only on real file-version updates", () => {
    const activeUrls = new Set<string>();
    let seq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:test/filever-${++seq}`;
      activeUrls.add(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      activeUrls.delete(String(url));
    });

    setCachedProjectRevision("proj-fv", "proj-rev-1", {
      "compositions/intro.html": '"sha256:intro-v1"',
    });
    const baseInput = {
      previewUrl: "/api/projects/proj-fv/preview/comp/compositions/intro.html",
      projectId: "proj-fv",
      contentRevision: 0,
      frameCount: 8,
    };
    const v1Val = seedClientCompositionCaptureForTest(
      baseInput,
      Array.from({ length: 8 }, (_, idx) => new Blob([`v1-${idx}`])),
    );
    const v1Urls = v1Val.kind === "filmstrip" ? [...v1Val.urls] : [];

    // Session-local contentRevision bump (e.g. unrelated file edit) must NOT evict a file-version-pinned strip.
    evictStaleCompositionCaptures("proj-fv", null, { __all__: 2, "compositions/intro.html": 2 });
    expect(peekCachedCompositionCapture(baseInput)).toBe(v1Val);
    for (const url of v1Urls) expect(activeUrls.has(url)).toBe(true);

    // Real file-version change marks v1 as fallback-only (not a warm hit) while preserving it for fallback display.
    updateCachedCompositionRevisions("proj-fv", { "compositions/intro.html": '"patch:intro-v2"' });
    expect(peekCachedCompositionCapture(baseInput)).toBeNull();
    expect(peekFallbackCompositionCapture({ projectId: "proj-fv", previewUrl: baseInput.previewUrl })).toBe(v1Val);
    for (const url of v1Urls) expect(activeUrls.has(url)).toBe(true);

    // Once v2 lands, v1's RAM object URLs are immediately revoked.
    const v2Val = seedClientCompositionCaptureForTest(
      baseInput,
      Array.from({ length: 8 }, (_, idx) => new Blob([`v2-${idx}`])),
    );
    expect(peekCachedCompositionCapture(baseInput)).toBe(v2Val);
    for (const url of v1Urls) expect(activeUrls.has(url)).toBe(false);
  });

  it("keeps three deferred sidebar captures queued out of scheduler slots while a gated timeline clip runs", async () => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test/gated-slot");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const projectId = "proj-gate-slots";
    const gatedInput = {
      previewUrl: `/api/projects/${projectId}/preview/comp/compositions/intro.html`,
      projectId,
      contentRevision: 0,
      frameCount: 2,
    };
    seedClientCompositionCaptureForTest(gatedInput, [new Blob(["g1"]), new Blob(["g2"])]);

    usePlayerStore.setState({
      editorInputLocked: true,
      assetReadinessPhase: "ready",
      assetReadinessSkipped: false,
      isPlaying: false,
    });

    const sidebarReqs = ["index.html", "compositions/a.html", "compositions/b.html"].map((comp) =>
      createClientCompositionCaptureRequest({
        previewUrl: `/api/projects/${projectId}/preview/comp/${comp}`,
        projectId,
        sessionEpoch: 1,
        contentRevision: 0,
        frameCount: 1,
        priority: "overscan",
      }),
    );
    const sidebarLeases = sidebarReqs.map((req) => thumbnailScheduler.acquire(req, () => {}));

    // All three sidebar requests must stay queued without claiming client-capture scheduler slots.
    for (const req of sidebarReqs) {
      expect(thumbnailScheduler.getSnapshot(req).status).toBe("queued");
    }
    expect(thumbnailScheduler.getDiagnostics().active).toBe(0);

    // Gated timeline capture arrives afterwards and resolves immediately instead of starving behind sidebar jobs.
    const gatedReq = createClientCompositionCaptureRequest({
      ...gatedInput,
      sessionEpoch: 1,
      priority: "interaction",
      gatePriority: true,
    });
    const gatedLease = thumbnailScheduler.acquire(gatedReq, () => {});
    await vi.waitFor(() => {
      expect(thumbnailScheduler.getSnapshot(gatedReq).status).toBe("ready");
    });

    // Clearing editorInputLocked releases the opening-gate hold so queued sidebar captures can start.
    usePlayerStore.setState({ editorInputLocked: false });
    await vi.waitFor(() => {
      expect(
        sidebarReqs.some((req) => thumbnailScheduler.getSnapshot(req).status !== "queued"),
      ).toBe(true);
    });

    gatedLease.release();
    for (const lease of sidebarLeases) lease.release();
    thumbnailScheduler.invalidateProject(projectId);
  });
});
