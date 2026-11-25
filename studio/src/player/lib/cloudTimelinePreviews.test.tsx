// @vitest-environment happy-dom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import { emitMediaDerived } from "../../utils/mediaDerivedBus";
import { MockResizeObserver } from "../../hooks/resizeObserverTestUtils";
import {
  AUDIO_WAVEFORM_PENDING_BUDGET_MS,
  loadWaveform,
  VIDEO_WAVEFORM_PENDING_BUDGET_MS,
} from "./audioWaveformLoader";
import { TIMELINE_VIEWPORT_BUDGETS } from "./timelineViewportBudgets";
import { loadPeakMap } from "../components/clipPeakMap";
import { decodeVideoThumbnail } from "./thumbnailVideoDecoder";
import { thumbnailScheduler } from "./thumbnailScheduler";
import { createHappyDomRootHarness } from "../components/testRootHarness";
import { VideoThumbnail } from "../components/VideoThumbnail";

vi.mock("./thumbnailVideoDecoder", () => ({ decodeVideoThumbnail: vi.fn() }));

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const harness = createHappyDomRootHarness();

describe("cloud timeline media previews", () => {
  beforeEach(() => {
    setCachedCloudDisklessMode(null);
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    setCachedCloudDisklessMode(null);
    thumbnailScheduler.invalidateProject("p1");
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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

  it("decodes the original cloud video without enqueueing or polling poster or sprite jobs", async () => {
    setCachedCloudDisklessMode(true);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(decodeVideoThumbnail).mockResolvedValue({
      value: { kind: "filmstrip", urls: ["blob:first", "blob:last"], aspect: 16 / 9 }, weight: 512,
    });
    const host = document.body.appendChild(document.createElement("div"));
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 320 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 40 });
    const root = harness.mount(host);
    await act(async () => {
      root.render(<VideoThumbnail videoSrc="/api/projects/p1/preview/assets/clip.mp4"
        label="" labelColor="#fff" duration={10} projectId="p1" sessionEpoch={1} />);
    });
    await vi.waitFor(() => expect(host.querySelector('img[src="blob:first"]')).toBeTruthy());
    expect(decodeVideoThumbnail).toHaveBeenCalledWith(expect.objectContaining({
      source: "/api/projects/p1/preview/assets/clip.mp4",
    }), expect.any(AbortSignal));
    expect(fetch).not.toHaveBeenCalled();
    host.remove();
  });

  it("falls back to browser decoding before the 30s thumbnail timeout when audio waveform stays 202 pending", async () => {
    vi.useFakeTimers();
    try {
      expect(AUDIO_WAVEFORM_PENDING_BUDGET_MS).toBeLessThan(TIMELINE_VIEWPORT_BUDGETS.thumbnailLoadTimeoutMs);
      expect(VIDEO_WAVEFORM_PENDING_BUDGET_MS).toBeLessThan(TIMELINE_VIEWPORT_BUDGETS.thumbnailLoadTimeoutMs);

      const requestedUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const url = String(input);
          requestedUrls.push(url);
          if (url.includes("/waveform/")) {
            return Response.json({ pending: true, sha256: "e".repeat(64) }, { status: 202 });
          }
          return new Response(new ArrayBuffer(16), { status: 200 });
        }),
      );
      const channel = new Float32Array(8000).map((_, index) => (index % 2 ? 0.5 : -1));
      const close = vi.fn(async () => {});
      vi.stubGlobal(
        "AudioContext",
        class {
          decodeAudioData = async () => ({ getChannelData: () => channel });
          close = close;
        },
      );

      const controller = new AbortController();
      const schedulerTimeout = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")),
        TIMELINE_VIEWPORT_BUDGETS.thumbnailLoadTimeoutMs);

      const promise = loadWaveform(
        "/api/projects/p1/preview/assets/soundtrack.m4a",
        "/api/projects/p1/waveform/assets/soundtrack.m4a",
        controller.signal,
        "audio",
      );

      await vi.advanceTimersByTimeAsync(AUDIO_WAVEFORM_PENDING_BUDGET_MS + 100);
      const peaks = await promise;
      clearTimeout(schedulerTimeout);

      expect(controller.signal.aborted).toBe(false);
      expect(peaks).toHaveLength(4000);
      expect(requestedUrls).toContain("/api/projects/p1/preview/assets/soundtrack.m4a");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back immediately to browser decoding when waveform endpoint returns 503", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("/waveform/")) {
          return Response.json({ error: "Waveform extraction unavailable" }, { status: 503 });
        }
        return new Response(new ArrayBuffer(16), { status: 200 });
      }),
    );
    const channel = new Float32Array(8000).map(() => 0.75);
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        decodeAudioData = async () => ({ getChannelData: () => channel });
        close = close;
      },
    );

    const peaks = await loadWaveform(
      "/api/projects/p1/preview/assets/soundtrack.m4a",
      "/api/projects/p1/waveform/assets/soundtrack.m4a",
      new AbortController().signal,
      "audio",
    );

    expect(peaks).toHaveLength(4000);
    expect(requestedUrls).toEqual([
      "/api/projects/p1/waveform/assets/soundtrack.m4a",
      "/api/projects/p1/preview/assets/soundtrack.m4a",
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("never downloads video containers when video waveform stays 202 pending past its budget", async () => {
    vi.useFakeTimers();
    try {
      const requestedUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          requestedUrls.push(String(input));
          return Response.json({ pending: true, sha256: "f".repeat(64) }, { status: 202 });
        }),
      );
      const audioContext = vi.fn();
      vi.stubGlobal("AudioContext", audioContext);

      const promise = loadWaveform(
        "/api/projects/p1/preview/assets/clip.mp4",
        "/api/projects/p1/waveform/assets/clip.mp4",
        new AbortController().signal,
        "video",
      );
      const settled = expect(promise).rejects.toThrow("Waveform extraction timed out while pending");
      await vi.advanceTimersByTimeAsync(VIDEO_WAVEFORM_PENDING_BUDGET_MS + 100);
      await settled;

      expect(requestedUrls.every((url) => url.includes("/waveform/"))).toBe(true);
      expect(audioContext).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
