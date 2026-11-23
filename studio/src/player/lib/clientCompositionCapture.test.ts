// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canCaptureCompositionInBrowser,
  clearClientCompositionCaptureCacheForTest,
  computeCompositionSampleTimes,
  createClientCompositionCaptureRequest,
  peekCachedCompositionCapture,
  quantizeCompositionFrameCount,
  retainCachedCompositionCapture,
  seedClientCompositionCaptureForTest,
  selectInitialGateCompositionPaths,
  setCachedProjectRevision,
  setClientCompositionCaptureCapabilityForTest,
} from "./clientCompositionCapture";
import { ThumbnailScheduler } from "./thumbnailScheduler";

afterEach(() => {
  setClientCompositionCaptureCapabilityForTest(null);
  clearClientCompositionCaptureCacheForTest();
  vi.restoreAllMocks();
});

describe("clientCompositionCapture", () => {
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
});
