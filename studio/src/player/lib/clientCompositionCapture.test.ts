// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  canCaptureCompositionInBrowser,
  clearClientCompositionCaptureCacheForTest,
  computeCompositionSampleTimes,
  createClientCompositionCaptureRequest,
  quantizeCompositionFrameCount,
  selectInitialGateCompositionPaths,
  setCachedProjectRevision,
  setClientCompositionCaptureCapabilityForTest,
} from "./clientCompositionCapture";

afterEach(() => {
  setClientCompositionCaptureCapabilityForTest(null);
  clearClientCompositionCaptureCacheForTest();
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
});
