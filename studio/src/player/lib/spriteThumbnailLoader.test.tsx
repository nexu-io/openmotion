// @vitest-environment happy-dom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import { emitMediaDerived } from "../../utils/mediaDerivedBus";
import { MockResizeObserver } from "../../hooks/resizeObserverTestUtils";
import { loadWaveform } from "./audioWaveformLoader";
import { loadPeakMap } from "../components/clipPeakMap";
import {
  clearSpriteCache,
  computeSpriteFrameSlice,
  loadSpriteManifest,
  resolveSpriteManifestUrl,
  resolveVideoPosterUrl,
  type SpriteManifestData,
} from "./spriteThumbnailLoader";
import { decodeVideoThumbnail } from "./thumbnailVideoDecoder";
import { thumbnailScheduler } from "./thumbnailScheduler";
import { createHappyDomRootHarness } from "../components/testRootHarness";
import { VideoThumbnail } from "../components/VideoThumbnail";

vi.mock("./thumbnailVideoDecoder", () => ({ decodeVideoThumbnail: vi.fn() }));

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

class ImmediateImage {
  src = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    queueMicrotask(() => this.onload?.());
  }
}

const SAMPLE_MANIFEST: SpriteManifestData = {
  version: 1,
  sha256: "a".repeat(64),
  durationSec: 120,
  frameCount: 120,
  frameWidth: 160,
  frameHeight: 90,
  intervalSec: 1,
  columns: 10,
  rows: 6,
  sheets: [
    {
      index: 0,
      url: "/api/projects/p1/sprite-sheet/0/assets/clip.mp4",
      startFrame: 0,
      frameCount: 60,
      columns: 10,
      rows: 6,
      width: 1600,
      height: 540,
    },
    {
      index: 1,
      url: "/api/projects/p1/sprite-sheet/1/assets/clip.mp4",
      startFrame: 60,
      frameCount: 60,
      columns: 10,
      rows: 6,
      width: 1600,
      height: 540,
    },
  ],
};

const harness = createHappyDomRootHarness();

describe("cloud sprite sheets, waveform 202 retry & VideoThumbnail integration", () => {
  beforeEach(() => {
    clearSpriteCache();
    setCachedCloudDisklessMode(null);
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    vi.stubGlobal("Image", ImmediateImage);
  });

  afterEach(() => {
    clearSpriteCache();
    setCachedCloudDisklessMode(null);
    thumbnailScheduler.invalidateProject("p1");
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("maps preview URLs to sprite and poster URLs and computes exact multi-sheet CSS slices", () => {
    expect(resolveSpriteManifestUrl("/api/projects/p1/preview/assets/clip.mp4?revision=2")).toBe(
      "/api/projects/p1/sprite/assets/clip.mp4?revision=2",
    );
    expect(resolveVideoPosterUrl("/api/projects/p1/preview/assets/clip.mp4")).toBe(
      "/api/projects/p1/image-thumbnail/assets/clip.mp4?w=320",
    );
    expect(resolveSpriteManifestUrl("https://external.example/video.mp4")).toBeNull();

    // Sheet 0 frame 0 (col=0, row=0) at exact 16:9 tile 80x45
    const slice0 = computeSpriteFrameSlice(SAMPLE_MANIFEST, 0.2, 80, 45);
    expect(slice0.sheetUrl).toBe("/api/projects/p1/sprite-sheet/0/assets/clip.mp4");
    expect(slice0.backgroundSize).toBe("800.00px 270.00px");
    expect(slice0.backgroundPosition).toBe("0.00px 0.00px");

    // Sheet 1 frame 75 (local=15 -> col=5, row=1)
    const slice75 = computeSpriteFrameSlice(SAMPLE_MANIFEST, 75.1, 80, 45);
    expect(slice75.sheetUrl).toBe("/api/projects/p1/sprite-sheet/1/assets/clip.mp4");
    expect(slice75.backgroundPosition).toBe("-400.00px -45.00px");
  });

  it("wakes up immediately on media-derived-ready SSE when sprite returns 202 pending", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ pending: true, sha256: SAMPLE_MANIFEST.sha256 }, { status: 202 });
        }
        return Response.json(SAMPLE_MANIFEST, { status: 200 });
      }),
    );

    const controller = new AbortController();
    const pendingPromise = loadSpriteManifest("/api/projects/p1/sprite/assets/clip.mp4", controller.signal);

    await vi.waitFor(() => expect(calls).toBe(1));
    emitMediaDerived({
      type: "media-derived-ready",
      projectId: "p1",
      sha256: SAMPLE_MANIFEST.sha256,
      kind: "sprite",
      status: "ready",
    });

    const manifest = await pendingPromise;
    expect(manifest?.frameCount).toBe(120);
    expect(calls).toBe(2);
  });

  it("handles 202 pending in audioWaveformLoader and clipPeakMap without throwing or poisoning cache", async () => {
    let wfCalls = 0;
    let peakCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/waveform/silent.mp4")) {
          return Response.json({ peaks: [], bins: [], binSeconds: 0, hasAudio: false }, { status: 200 });
        }
        if (url.includes("/waveform/")) {
          wfCalls += 1;
          if (wfCalls === 1) {
            return Response.json({ pending: true, sha256: "c".repeat(64) }, { status: 202 });
          }
          return Response.json({ peaks: [0.1, 0.8, 0.4], hasAudio: true }, { status: 200 });
        }
        if (url.includes("/peaks/")) {
          peakCalls += 1;
          if (peakCalls === 1) {
            return Response.json({ pending: true, sha256: "d".repeat(64) }, { status: 202 });
          }
          return Response.json({ binSeconds: 0.5, bins: [0.2, 0.9] }, { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );

    // 1. Silent video returns [] cleanly
    const silentPeaks = await loadWaveform(
      "/api/projects/p1/preview/assets/silent.mp4",
      "/api/projects/p1/waveform/silent.mp4",
      new AbortController().signal,
      "video",
    );
    expect(silentPeaks).toEqual([]);

    // 2. Pending 202 waveform wakes up via SSE and never falls back to browser AudioContext decode
    const wfPromise = loadWaveform(
      "/api/projects/p1/preview/assets/song.mp3",
      "/api/projects/p1/waveform/assets/song.mp3",
      new AbortController().signal,
      "audio",
    );
    await vi.waitFor(() => expect(wfCalls).toBe(1));
    emitMediaDerived({
      type: "media-derived-ready",
      projectId: "p1",
      sha256: "c".repeat(64),
      kind: "waveform",
      status: "ready",
    });
    await expect(wfPromise).resolves.toEqual([0.1, 0.8, 0.4]);

    // 3. Pending 202 peakMap wakes up via SSE and returns PeakMap
    const peakPromise = loadPeakMap("/api/projects/p1/peaks/assets/song.mp3");
    await vi.waitFor(() => expect(peakCalls).toBe(1));
    emitMediaDerived({
      type: "media-derived-ready",
      projectId: "p1",
      sha256: "d".repeat(64),
      kind: "waveform",
      status: "ready",
    });
    await expect(peakPromise).resolves.toEqual({ binSeconds: 0.5, bins: [0.2, 0.9] });
  });

  it("renders CSS sprite tiles in cloud mode without invoking mediabunny, and falls back to mediabunny on 404", async () => {
    setCachedCloudDisklessMode(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/sprite/assets/ready.mp4")) {
          return Response.json(SAMPLE_MANIFEST, { status: 200 });
        }
        return Response.json({ unavailable: true }, { status: 404 });
      }),
    );

    const host = document.body.appendChild(document.createElement("div"));
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 320 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 40 });
    const root = harness.mount(host);

    await act(async () => {
      root.render(
        <VideoThumbnail
          videoSrc="/api/projects/p1/preview/assets/ready.mp4"
          label=""
          labelColor="#fff"
          duration={10}
          projectId="p1"
          sessionEpoch={1}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(host.querySelectorAll("[data-sprite-tile]").length).toBeGreaterThan(0);
    });
    expect(decodeVideoThumbnail).not.toHaveBeenCalled();

    // Now render a video whose sprite returns 404 -> seamlessly falls back to decodeVideoThumbnail
    vi.mocked(decodeVideoThumbnail).mockResolvedValue({
      value: { kind: "image", url: "blob:fallback", aspect: 16 / 9 },
      weight: 128,
    });
    await act(async () => {
      root.render(
        <VideoThumbnail
          videoSrc="/api/projects/p1/preview/assets/missing-sprite.mp4"
          label=""
          labelColor="#fff"
          duration={10}
          projectId="p1"
          sessionEpoch={1}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(decodeVideoThumbnail).toHaveBeenCalled();
    });
    host.remove();
  });
});
