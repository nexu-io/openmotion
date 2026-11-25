// @vitest-environment happy-dom

import { IDBFactory } from "fake-indexeddb";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockResizeObserver, reportResize } from "../../hooks/resizeObserverTestUtils";
import { setCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import {
  clearClientCompositionCaptureCacheForTest,
  peekCachedCompositionCapture,
  seedClientCompositionCaptureForTest,
  setCachedProjectRevision,
  setClientCompositionCaptureCapabilityForTest,
  updateCachedCompositionRevisions,
} from "../lib/clientCompositionCapture";
import { thumbnailScheduler } from "../lib/thumbnailScheduler";
import { usePlayerStore } from "../store/playerStore";
import { buildCompositionThumbnailUrl, CompositionThumbnail, compositionThumbnailRequest } from "./CompositionThumbnail";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

class MockImage {
  static instances: MockImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";

  constructor() {
    MockImage.instances.push(this);
  }
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalImage = globalThis.Image;
const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  globalThis.Image = MockImage as unknown as typeof Image;
  globalThis.fetch = vi.fn(async () => new Response(new Blob(["thumbnail"]), { status: 200 }));
  URL.createObjectURL = vi.fn(() => "blob:composition-thumbnail");
  URL.revokeObjectURL = vi.fn();
  MockImage.instances = [];
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  setCachedCloudDisklessMode(null);
  setClientCompositionCaptureCapabilityForTest(null);
  clearClientCompositionCaptureCacheForTest();
  vi.useRealTimers();
  thumbnailScheduler.invalidateProject("/api/projects/demo/preview");
  thumbnailScheduler.invalidateProject("demo");
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.Image = originalImage;
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  document.body.replaceChildren();
});

it("checks the cache after enqueue and cancels pending polls when the card is released", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const url = "/api/projects/demo/thumbnail/index.html?t=3";
  const task = compositionThumbnailRequest(url, "demo").load(controller.signal);
  const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(550);
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([url, url + "&cached=1"]);
  controller.abort();
  await rejected;
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

describe("buildCompositionThumbnailUrl", () => {
  it("includes selector and occurrence index for precise element thumbnails", () => {
    expect(
      buildCompositionThumbnailUrl({
        previewUrl: "/api/projects/demo/preview",
        seekTime: 1,
        duration: 2,
        selector: ".card",
        selectorIndex: 2,
        origin: "http://localhost:3000",
      }),
    ).toBe(
      "http://localhost:3000/api/projects/demo/thumbnail/index.html?t=2.00&v=v4&revision=0&selector=.card&selectorIndex=2",
    );
  });

  it("asks for source density only when a caller opts in", () => {
    const base = {
      previewUrl: "/api/projects/demo/preview",
      seekTime: 1,
      duration: 0,
      origin: "http://localhost:3000",
    };

    expect(buildCompositionThumbnailUrl(base)).not.toContain("output=");
    expect(buildCompositionThumbnailUrl({ ...base, output: "source" })).toContain("output=source");
  });

  it("includes the persisted content revision in the cache identity", () => {
    const url = buildCompositionThumbnailUrl({
      previewUrl: "/api/projects/demo/preview",
      origin: "http://localhost:3000",
      contentRevision: 7,
    });

    expect(new URL(url).searchParams.get("revision")).toBe("7");
  });
});

describe("CompositionThumbnail", () => {
  async function renderThumbnail(): Promise<MockImage> {
    root = createRoot(host);
    await act(async () => {
      root!.render(
        React.createElement(CompositionThumbnail, {
          previewUrl: "/api/projects/demo/preview",
          label: "",
          labelColor: "#fff",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const probe = MockImage.instances[0];
    if (!probe) throw new Error("Expected an image probe");
    return probe;
  }

  it("requests source-resolution captures for selected elements", async () => {
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(CompositionThumbnail, {
        previewUrl: "/api/projects/demo/preview",
        label: "",
        labelColor: "#fff",
        selector: ".cursor",
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/output=source.*selector=\.cursor/),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("renders visible tiles after the scheduled off-DOM probe loads", async () => {
    const probe = await renderThumbnail();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/projects/demo/thumbnail/index.html"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(probe.src).toBe("blob:composition-thumbnail");

    await act(async () => {
      probe.naturalWidth = 1920;
      probe.naturalHeight = 1080;
      probe.onload?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const tiles = [...host.querySelectorAll("img")];
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((tile) => !tile.classList.contains("hidden"))).toBe(true);
    // Pictures read untinted by default, like video filmstrips; the theme tokens own any dimming.
    expect(
      tiles.every((tile) => tile.style.opacity === "var(--timeline-composition-thumbnail-opacity)"),
    ).toBe(true);
    expect(tiles[0]?.parentElement?.parentElement?.style.mixBlendMode).toBe(
      "var(--timeline-composition-thumbnail-blend)",
    );
  });

  it.each([
    { name: "a wide", width: 2700, height: 1000, tileWidth: 108 },
    { name: "a square", width: 1000, height: 1000, tileWidth: 48 },
    { name: "a portrait", width: 1080, height: 1920, tileWidth: 48 },
  ])(
    "shows $name picture whole at the clip's measured height",
    async ({ width, height, tileWidth }) => {
      Object.defineProperty(host, "clientWidth", { configurable: true, value: 500 });
      Object.defineProperty(host, "clientHeight", { configurable: true, value: 40 });
      const probe = await renderThumbnail();

      await act(async () => {
        probe.naturalWidth = width;
        probe.naturalHeight = height;
        probe.onload?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const img = host.querySelector("img")!;
      expect(img.parentElement?.style.width).toBe(`${tileWidth}px`);
      // A tile held at its minimum width letterboxes the picture instead of cropping it.
      expect(img.classList.contains("object-contain")).toBe(true);
    },
  );

  it("re-tiles at the height the resize observer reports", async () => {
    const probe = await renderThumbnail();
    await act(async () => {
      probe.naturalWidth = 2700;
      probe.naturalHeight = 1000;
      probe.onload?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    act(() => reportResize(500, 40));
    act(() => vi.advanceTimersToNextFrame());

    expect(host.querySelector("img")?.parentElement?.style.width).toBe("108px");
  });

  it("aborts its scheduled off-DOM image probe when unmounted", async () => {
    const probe = await renderThumbnail();
    expect(host.querySelector("img")).toBeNull();
    expect(probe.src).toBe("blob:composition-thumbnail");

    await act(async () => {
      root?.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    root = null;

    expect(probe.onload).toBeNull();
    expect(probe.onerror).toBeNull();
    expect(probe.src).toBe("");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:composition-thumbnail");
  });

  it("releases the old request and ignores its late result when persisted content changes", async () => {
    const signals: AbortSignal[] = [];
    const resolveFetches: Array<(response: Response) => void> = [];
    globalThis.fetch = vi.fn((_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>((resolve) => resolveFetches.push(resolve));
    });
    root = createRoot(host);

    await act(async () => {
      root!.render(
        React.createElement(CompositionThumbnail, {
          previewUrl: "/api/projects/demo/preview",
          label: "",
          labelColor: "#fff",
          projectId: "demo",
          contentRevision: 0,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      root!.render(
        React.createElement(CompositionThumbnail, {
          previewUrl: "/api/projects/demo/preview",
          label: "",
          labelColor: "#fff",
          projectId: "demo",
          contentRevision: 1,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toContain(
      "revision=1",
    );

    await act(async () => {
      resolveFetches[0]?.(new Response(new Blob(["stale"]), { status: 200 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(MockImage.instances).toHaveLength(0);

    await act(async () => {
      resolveFetches[1]?.(new Response(new Blob(["fresh"]), { status: 200 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(MockImage.instances).toHaveLength(1);
    expect(MockImage.instances[0]?.src).toBe("blob:composition-thumbnail");
  });

  it("renders a single leading frame without cloning it across a wide clip", async () => {
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 900 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 44 });
    const probe = await renderThumbnail();

    await act(async () => {
      probe.naturalWidth = 1920;
      probe.naturalHeight = 1080;
      probe.onload?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelectorAll("img")).toHaveLength(1);
    expect(host.querySelector('[data-composition-strip="media"]')).not.toBeNull();
  });

  it("renders a single non-repeating text composition bar in cloud mode when no hero media exists", async () => {
    setCachedCloudDisklessMode(true);
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 640 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 44 });
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        content:
          '<template><div data-composition-id="welcome-reel" data-width="1920" data-height="1080">' +
          '<img src="assets/brand-mark.svg" style="width:42px;height:42px">' +
          '<canvas aria-label="Editable motion artwork montage"></canvas>' +
          "</div></template>",
      }),
    );

    root = createRoot(host);
    await act(async () => {
      root!.render(
        React.createElement(CompositionThumbnail, {
          previewUrl: "/api/projects/demo/preview/comp/compositions/reel.html",
          label: "",
          labelColor: "#fff",
          projectId: "demo",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelectorAll("img")).toHaveLength(0);
    const strip = host.querySelector('[data-composition-strip="text"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("Editable motion artwork montage");
    expect(strip?.textContent).toContain("reel");
    expect(strip?.textContent).not.toContain("reel.html");
  });
});

describe("CompositionThumbnail retained filmstrip during refresh", () => {
  function setupIsolatedCaptureEnv() {
    setCachedCloudDisklessMode(true);
    setClientCompositionCaptureCapabilityForTest(true);
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 40 });
    usePlayerStore.setState({
      assetReadinessPhase: "ready",
      previewBooted: true,
      isPlaying: false,
    });

    let urlSeq = 0;
    URL.createObjectURL = vi.fn(() => `blob:strip-${++urlSeq}`);
    URL.revokeObjectURL = vi.fn();

    const meta = document.createElement("meta");
    meta.name = "openmotion-preview-origin";
    meta.content = "https://preview.example.test";
    document.head.appendChild(meta);

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

    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const reqUrl = String(input);
      requestedUrls.push(reqUrl);
      if (reqUrl.includes("/preview-token")) {
        return Response.json({
          token: "tok-refresh",
          previewOrigin: "https://preview.example.test",
          assetLease: "lease-refresh",
        });
      }
      return Response.json({
        content:
          '<template><div data-composition-id="scene-a" data-width="1920" data-height="1080">' +
          '<canvas aria-label="Scene A text fallback"></canvas>' +
          "</div></template>",
      });
    }) as typeof fetch;

    let activeBridgeWin: { postMessage: ReturnType<typeof vi.fn> } | null = null;
    let pendingRequestId: string | null = null;
    const captureRequests: string[] = [];

    async function waitForCaptureRequest() {
      pendingRequestId = null;
      let iframe: HTMLIFrameElement | null = null;
      await vi.waitFor(() => {
        iframe = document.querySelector<HTMLIFrameElement>(
          'iframe[data-openmotion-thumb-capture="true"]',
        );
        expect(iframe?.src).toContain("pt=tok-refresh");
      });
      activeBridgeWin = {
        postMessage: vi.fn((msg: Record<string, unknown>) => {
          if (msg.type === "capture-frames") {
            const reqId = String(msg.requestId ?? "");
            pendingRequestId = reqId;
            captureRequests.push(reqId);
          }
        }),
      };
      Object.defineProperty(iframe!, "contentWindow", {
        configurable: true,
        value: activeBridgeWin,
      });
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example.test",
          source: activeBridgeWin as unknown as Window,
          data: {
            source: "openmotion-preview-bridge",
            version: 1,
            type: "timeline-state",
            projectId: "demo",
            token: "tok-refresh",
            duration: 6,
            width: 1920,
            height: 1080,
          },
        }),
      );
      await vi.waitFor(() => expect(pendingRequestId).toBeTruthy());
      return pendingRequestId!;
    }

    function sendProgressiveFrame(requestId: string, index: number, total: number) {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example.test",
          source: activeBridgeWin as unknown as Window,
          data: {
            source: "openmotion-preview-bridge",
            version: 1,
            type: "capture-frame",
            projectId: "demo",
            token: "tok-refresh",
            requestId,
            index,
            total,
            frame: new Uint8Array([9, index]).buffer,
            mimeType: "image/jpeg",
            width: 240,
            height: 135,
            aspect: 16 / 9,
          },
        }),
      );
    }

    function resolveCapture(requestId: string, frameCount: number) {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example.test",
          source: activeBridgeWin as unknown as Window,
          data: {
            source: "openmotion-preview-bridge",
            version: 1,
            type: "response",
            projectId: "demo",
            token: "tok-refresh",
            requestId,
            ok: true,
            result: {
              frames: Array.from({ length: frameCount }, (_, idx) => new Uint8Array([7, idx]).buffer),
              mimeType: "image/jpeg",
              width: 240,
              height: 135,
              aspect: 16 / 9,
            },
          },
        }),
      );
    }

    function failCapture(requestId: string, error = "Capture failed") {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example.test",
          source: activeBridgeWin as unknown as Window,
          data: {
            source: "openmotion-preview-bridge",
            version: 1,
            type: "response",
            projectId: "demo",
            token: "tok-refresh",
            requestId,
            ok: false,
            error,
          },
        }),
      );
    }

    function cleanup() {
      if (origSrcDescriptor) {
        Object.defineProperty(HTMLIFrameElement.prototype, "src", origSrcDescriptor);
      }
      meta.remove();
      document
        .querySelectorAll('iframe[data-openmotion-thumb-capture="true"]')
        .forEach((node) => node.remove());
    }

    return {
      requestedUrls,
      captureRequests,
      waitForCaptureRequest,
      sendProgressiveFrame,
      resolveCapture,
      failCapture,
      cleanup,
    };
  }

  it("keeps the existing filmstrip across refresh, LRU eviction, and mid-capture frames until the new strip finishes", async () => {
    const env = setupIsolatedCaptureEnv();
    try {
      const previewUrl = "/api/projects/demo/preview/comp/compositions/intro.html";
      const initial = seedClientCompositionCaptureForTest(
        {
          projectId: "demo",
          previewUrl,
          contentRevision: 0,
          frameCount: 8,
        },
        Array.from({ length: 8 }, (_, idx) => new Blob([`init-${idx}`])),
      );
      expect(initial.kind).toBe("filmstrip");
      const initialUrls = initial.kind === "filmstrip" ? [...initial.urls] : [];

      root = createRoot(host);
      await act(async () => {
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl,
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 0,
            clipDuration: 6,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const shownBefore = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(shownBefore.length).toBeGreaterThan(0);
      expect(shownBefore.every((src) => initialUrls.includes(src!))).toBe(true);

      // Trigger a refresh via contentRevision change while the new capture is in flight.
      await act(async () => {
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl,
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 1,
            clipDuration: 6,
          }),
        );
      });

      // Immediately during IDB check: no skeleton and no text fallback, still showing old strip.
      expect(host.querySelector('[data-composition-strip="text"]')).toBeNull();
      expect([...host.querySelectorAll("img")].every((img) => initialUrls.includes(img.getAttribute("src")!))).toBe(
        true,
      );

      const requestId = await env.waitForCaptureRequest();

      // Still holding the prior filmstrip while capture runs; poster file fetch was skipped.
      expect(env.requestedUrls.some((u) => u.includes("/files/"))).toBe(false);
      expect(host.querySelector('[data-composition-strip="text"]')).toBeNull();
      expect([...host.querySelectorAll("img")].every((img) => initialUrls.includes(img.getAttribute("src")!))).toBe(
        true,
      );

      // Even if LRU evicts the old entry from memoryStripCache mid-refresh, its object URLs stay valid.
      for (let i = 0; i < 70; i++) {
        seedClientCompositionCaptureForTest(
          {
            projectId: "other-project",
            previewUrl: `/api/projects/other-project/preview/comp/compositions/filler-${i}.html`,
            contentRevision: 0,
            frameCount: 2,
          },
          [new Blob(["x"]), new Blob(["y"])],
        );
      }
      for (const oldUrl of initialUrls) {
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(oldUrl);
      }

      // A single progressive hero frame during refresh must not overwrite the existing full filmstrip.
      await act(async () => {
        env.sendProgressiveFrame(requestId, 2, 4);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect([...host.querySelectorAll("img")].every((img) => initialUrls.includes(img.getAttribute("src")!))).toBe(
        true,
      );

      // Once the recalculated filmstrip finishes, swap atomically and release the evicted old URLs.
      await act(async () => {
        env.resolveCapture(requestId, 8);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const shownAfter = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(shownAfter.length).toBeGreaterThan(0);
      expect(shownAfter.some((src) => initialUrls.includes(src!))).toBe(false);
      for (const oldUrl of initialUrls) {
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldUrl);
      }
    } finally {
      env.cleanup();
    }
  });

  it("keeps the existing filmstrip when project revision changes or the clip remounts during refresh", async () => {
    const env = setupIsolatedCaptureEnv();
    try {
      const previewUrl = "/api/projects/demo/preview/comp/compositions/intro.html";
      setCachedProjectRevision("demo", "rev-a");
      const initial = seedClientCompositionCaptureForTest(
        {
          projectId: "demo",
          previewUrl,
          contentRevision: 0,
          frameCount: 8,
        },
        Array.from({ length: 8 }, (_, idx) => new Blob([`init-${idx}`])),
      );
      const initialUrls = initial.kind === "filmstrip" ? [...initial.urls] : [];

      // Advance project revision before mounting (simulates remount/reopen during refresh).
      setCachedProjectRevision("demo", "rev-b");
      root = createRoot(host);
      await act(async () => {
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl,
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 0,
            clipDuration: 6,
          }),
        );
      });

      expect(host.querySelector('[data-composition-strip="text"]')).toBeNull();
      const shownDuring = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(shownDuring.length).toBeGreaterThan(0);
      expect(shownDuring.every((src) => initialUrls.includes(src!))).toBe(true);

      const requestId = await env.waitForCaptureRequest();
      await act(async () => {
        env.resolveCapture(requestId, 8);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const shownAfter = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(shownAfter.some((src) => initialUrls.includes(src!))).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("never bleeds a retained filmstrip onto another clip and falls back cleanly on capture error", async () => {
    const env = setupIsolatedCaptureEnv();
    try {
      const introUrl = "/api/projects/demo/preview/comp/compositions/intro.html";
      const otherUrl = "/api/projects/demo/preview/comp/compositions/other.html";
      const initial = seedClientCompositionCaptureForTest(
        {
          projectId: "demo",
          previewUrl: introUrl,
          contentRevision: 0,
          frameCount: 8,
        },
        Array.from({ length: 8 }, (_, idx) => new Blob([`iso-${idx}`])),
      );
      const initialUrls = initial.kind === "filmstrip" ? [...initial.urls] : [];

      root = createRoot(host);
      await act(async () => {
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl: introUrl,
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 0,
            clipDuration: 6,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect([...host.querySelectorAll("img")].every((img) => initialUrls.includes(img.getAttribute("src")!))).toBe(
        true,
      );

      // Switching to a different composition clears the old strip immediately.
      await act(async () => {
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl: otherUrl,
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 0,
            clipDuration: 6,
          }),
        );
      });
      expect([...host.querySelectorAll("img")].some((img) => initialUrls.includes(img.getAttribute("src")!))).toBe(
        false,
      );

      // Switch back to introUrl at revision 1 and fail its capture -> falls back to poster text.
      await act(async () => {
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl: introUrl,
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 1,
            clipDuration: 6,
          }),
        );
      });
      const requestId = await env.waitForCaptureRequest();
      await act(async () => {
        env.failCapture(requestId);
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      expect(host.querySelectorAll("img")).toHaveLength(0);
      expect(host.querySelector('[data-composition-strip="text"]')).not.toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it("never re-captures when trimming, stretching, zooming, or bumping session revision while file version is unchanged, and re-captures only on real file-version change", async () => {
    const prevIndexedDb = globalThis.indexedDB;
    globalThis.indexedDB = new IDBFactory();
    const env = setupIsolatedCaptureEnv();
    try {
      const previewUrl = "/api/projects/demo/preview/comp/compositions/intro.html";
      setCachedProjectRevision("demo", "proj-rev-1", {
        "compositions/intro.html": '"sha256:intro-v1"',
      });

      root = createRoot(host);
      await act(async () => {
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl,
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 0,
            clipDuration: 6,
          }),
        );
      });
      const v1RequestId = await env.waitForCaptureRequest();
      await act(async () => {
        env.resolveCapture(v1RequestId, 8);
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      const v1 = peekCachedCompositionCapture({
        projectId: "demo",
        previewUrl,
        contentRevision: 0,
        frameCount: 8,
      });
      expect(v1?.kind).toBe("filmstrip");
      const v1Urls = v1?.kind === "filmstrip" ? [...v1.urls] : [];
      expect(v1Urls).toHaveLength(8);
      expect(env.captureRequests).toHaveLength(1);
      const initialCount = host.querySelectorAll("img").length;
      expect(initialCount).toBeGreaterThan(1);

      // Shrink clip to a single tile & ultra-short duration -> shows fewer tiles from the same cached strip, 0 captures.
      await act(async () => {
        reportResize(60, 40);
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl,
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 1,
            clipDuration: 0.3,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const shrunkImgs = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(shrunkImgs).toHaveLength(1);
      expect(shrunkImgs[0]).toBe(v1Urls[4]);
      expect(env.captureRequests).toHaveLength(1);

      // Stretch clip wide -> shows more tiles from the same cached strip, still 0 captures.
      await act(async () => {
        reportResize(640, 40);
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl,
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 2,
            clipDuration: 15,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const stretchedImgs = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(stretchedImgs.length).toBeGreaterThan(initialCount);
      expect(stretchedImgs.every((src) => v1Urls.includes(src!))).toBe(true);
      expect(env.captureRequests).toHaveLength(1);

      // Now update the composition's real persisted file version -> retains v1 while capturing v2 once.
      await act(async () => {
        updateCachedCompositionRevisions("demo", { "compositions/intro.html": '"patch:intro-v2"' });
      });
      expect([...host.querySelectorAll("img")].every((img) => v1Urls.includes(img.getAttribute("src")!))).toBe(true);
      const v2RequestId = await env.waitForCaptureRequest();
      await act(async () => {
        env.resolveCapture(v2RequestId, 8);
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      const v2Imgs = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(v2Imgs.length).toBeGreaterThan(0);
      expect(v2Imgs.some((src) => v1Urls.includes(src!))).toBe(false);
      expect(env.captureRequests).toHaveLength(2);
      // v1 RAM object URLs were revoked on v2 arrival to avoid memory leaks while v1 remains persisted in IDB.
      for (const oldUrl of v1Urls) {
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldUrl);
      }

      // Undo back to v1 -> recovers persisted v1 from IndexedDB with 0 additional captures.
      await act(async () => {
        updateCachedCompositionRevisions("demo", { "compositions/intro.html": '"sha256:intro-v1"' });
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      await vi.waitFor(() => {
        const currentImgs = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
        expect(currentImgs.length).toBeGreaterThan(0);
        expect(currentImgs.some((src) => v2Imgs.includes(src!))).toBe(false);
      });
      expect(env.captureRequests).toHaveLength(2);
      const undoneImgs = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(undoneImgs.some((src) => v1Urls.includes(src!))).toBe(false);
    } finally {
      clearClientCompositionCaptureCacheForTest();
      globalThis.indexedDB = prevIndexedDb;
      env.cleanup();
    }
  });

  it("automatically retries a failed composition capture once after 2s backoff and recovers", async () => {
    const env = setupIsolatedCaptureEnv();
    const retrySpy = vi.spyOn(thumbnailScheduler, "retryFailed");
    try {
      root = createRoot(host);
      await act(async () => {
        root!.render(
          React.createElement(CompositionThumbnail, {
            previewUrl: "/api/projects/demo/preview/comp/compositions/scene-a.html",
            label: "",
            labelColor: "#fff",
            projectId: "demo",
            contentRevision: 0,
            clipDuration: 6,
          }),
        );
      });

      const firstReqId = await env.waitForCaptureRequest();
      await act(async () => {
        env.failCapture(firstReqId);
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(retrySpy).not.toHaveBeenCalled();

      // After the 2s backoff window, CompositionThumbnail automatically calls retryFailed once.
      await vi.waitFor(
        () => expect(retrySpy).toHaveBeenCalledWith("demo", "compositions/scene-a.html"),
        { timeout: 3_500 },
      );
      expect(retrySpy).toHaveBeenCalledTimes(1);

      const secondReqId = await env.waitForCaptureRequest();
      await act(async () => {
        env.resolveCapture(secondReqId, 4);
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(host.querySelectorAll("img").length).toBeGreaterThan(0);
    } finally {
      retrySpy.mockRestore();
      env.cleanup();
    }
  });
});
