// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import {
  acquireCachedCompositionCaptureFromIdb,
  clearClientCompositionCaptureCacheForTest,
  createClientCompositionCaptureRequest,
  peekCachedCompositionCapture,
  setCachedProjectRevision,
  setClientCompositionCaptureCapabilityForTest,
} from "./clientCompositionCapture";
import {
  buildCompositionFilmstripUrl,
  clearRemoteCompositionFilmstripStateForTest,
  computeRemoteSpriteFrameDimensions,
  fetchRemoteCompositionFilmstrip,
  setRemoteFilmstripCodecForTest,
  subsampleFilmstripFrames,
  uploadRemoteCompositionFilmstripIfEligible,
} from "./remoteCompositionFilmstrip";
import { usePlayerStore } from "../store/playerStore";

const SHA_A = "a".repeat(64);
const RENDER_KEY_A = "d".repeat(64);

afterEach(() => {
  setCachedCloudDisklessMode(null);
  setClientCompositionCaptureCapabilityForTest(null);
  clearClientCompositionCaptureCacheForTest();
  clearRemoteCompositionFilmstripStateForTest();
  vi.restoreAllMocks();
});

describe("remoteCompositionFilmstrip", () => {
  it("builds filmstrip cache URLs from composition preview paths and subsamples frames cleanly", () => {
    expect(
      buildCompositionFilmstripUrl(
        "proj-1",
        "/api/projects/proj-1/preview/comp/compositions/intro.html",
        "rev-1",
        2,
      ),
    ).toBe("/api/projects/proj-1/composition-filmstrip/compositions/intro.html?rev=rev-1&cr=2");
    expect(buildCompositionFilmstripUrl("proj-1", "/api/projects/proj-1/preview")).toBe(
      "/api/projects/proj-1/composition-filmstrip/index.html",
    );
    expect(buildCompositionFilmstripUrl("proj-1", "/unrelated/path")).toBeNull();

    const frames = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(subsampleFilmstripFrames(frames, 1)).toEqual([4]);
    expect(subsampleFilmstripFrames(frames, 2)).toEqual([0, 7]);
    expect(subsampleFilmstripFrames(frames, 4)).toEqual([0, 2, 5, 7]);
    expect(subsampleFilmstripFrames(frames, 8)).toEqual(frames);
  });

  it("hydrates RAM + cover cache from a Tier 1.5 remote 8-frame sprite hit with 1 deduplicated GET and 0 SnapDOM iframes", async () => {
    setCachedCloudDisklessMode(true);
    setCachedProjectRevision("proj-remote", "rev-1");
    let urlSeq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:remote-${++urlSeq}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const decodeSprite = vi.fn(async (_blob: Blob, meta: { frameCount: number }) =>
      Array.from({ length: meta.frameCount }, (_, i) => new Blob([`frame-${i}`], { type: "image/jpeg" })),
    );
    setRemoteFilmstripCodecForTest({
      decodeSprite,
      packSprite: vi.fn(async () => null),
    });

    const origFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => {
      return new Response(new Blob(["fake-sprite-jpeg"], { type: "image/jpeg" }), {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "x-openmotion-filmstrip-frames": "8",
          "x-openmotion-filmstrip-width": "160",
          "x-openmotion-filmstrip-height": "90",
          "x-openmotion-filmstrip-aspect": "1.7778",
          "x-openmotion-filmstrip-sha256": SHA_A,
          "x-openmotion-filmstrip-scope": "catalog",
          "x-openmotion-filmstrip-source": "builtin",
        },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const previewUrl = "/api/projects/proj-remote/preview/comp/compositions/intro.html";
      // Concurrent 4-frame timeline request + 1-frame sidebar cover request share ONE remote GET & decode.
      const [stripLease, coverLease] = await Promise.all([
        acquireCachedCompositionCaptureFromIdb({
          projectId: "proj-remote",
          previewUrl,
          contentRevision: 0,
          frameCount: 4,
        }),
        acquireCachedCompositionCaptureFromIdb({
          projectId: "proj-remote",
          previewUrl,
          contentRevision: 0,
          frameCount: 1,
        }),
      ]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(decodeSprite).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
        "/api/projects/proj-remote/composition-filmstrip/compositions/intro.html",
      );
      expect(stripLease?.value.kind).toBe("filmstrip");
      expect(coverLease?.value.kind).toBe("image");
      if (stripLease?.value.kind === "filmstrip") {
        expect(stripLease.value.urls).toHaveLength(8);
      }

      // Zooming in/out across 1, 2, 4, 8 frames now hits RAM synchronously in 0ms without re-fetching.
      expect(peekCachedCompositionCapture({ projectId: "proj-remote", previewUrl, contentRevision: 0, frameCount: 8 })?.kind).toBe("filmstrip");
      expect(peekCachedCompositionCapture({ projectId: "proj-remote", previewUrl, contentRevision: 0, frameCount: 4 })?.kind).toBe("filmstrip");
      expect(peekCachedCompositionCapture({ projectId: "proj-remote", previewUrl, contentRevision: 0, frameCount: 2 })?.kind).toBe("filmstrip");
      expect(peekCachedCompositionCapture({ projectId: "proj-remote", previewUrl, contentRevision: 0, frameCount: 1 })?.kind).toBe("image");
      expect(document.querySelectorAll('iframe[data-openmotion-thumb-capture="true"]')).toHaveLength(0);

      stripLease?.release();
      coverLease?.release();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("records a 204 miss sha256 and asynchronously PUTs a packed sprite after Tier 2 SnapDOM capture finishes", async () => {
    setCachedCloudDisklessMode(true);
    setClientCompositionCaptureCapabilityForTest(true);
    setCachedProjectRevision("proj-wb", "rev-wb");
    usePlayerStore.setState({
      assetReadinessPhase: "ready",
      assetReadinessSkipped: false,
      editorInputLocked: false,
      isPlaying: false,
    });

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

    const packSprite = vi.fn(async (blobs: readonly Blob[], frameWidth: number, frameHeight: number) => ({
      blob: new Blob(["packed-sprite"], { type: "image/jpeg" }),
      frameCount: blobs.length,
      frameWidth,
      frameHeight,
    }));
    setRemoteFilmstripCodecForTest({
      decodeSprite: vi.fn(async () => null),
      packSprite,
    });

    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:wb-${Math.random()}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const putRequests: Array<{ url: string; headers: Record<string, string> }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/composition-filmstrip/") && method === "GET") {
        return new Response(null, {
          status: 204,
          headers: {
            "x-openmotion-filmstrip-sha256": SHA_A,
            "x-openmotion-filmstrip-render-key": RENDER_KEY_A,
            "x-openmotion-filmstrip-scope": "workspace",
          },
        });
      }
      if (url.includes("/composition-filmstrip/") && method === "PUT") {
        const hdrs: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          hdrs[k.toLowerCase()] = v;
        });
        putRequests.push({ url, headers: hdrs });
        return Response.json({ stored: true, frameCount: 4 });
      }
      if (url.includes("/preview-token")) {
        return Response.json({
          token: "tok-wb",
          previewOrigin: "https://preview.example.test",
          assetLease: "lease-wb",
        });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const previewUrl = "/api/projects/proj-wb/preview/comp/compositions/custom.html";

      // 1. Tier 1.5 probes and receives 204 miss with authoritative sha256.
      const miss = await acquireCachedCompositionCaptureFromIdb({
        projectId: "proj-wb",
        previewUrl,
        contentRevision: 0,
        frameCount: 4,
      });
      expect(miss).toBeNull();

      // 2. Selector captures must NEVER hit the remote filmstrip route.
      const selectorMiss = await acquireCachedCompositionCaptureFromIdb({
        projectId: "proj-wb",
        previewUrl,
        contentRevision: 0,
        frameCount: 4,
        selector: "#hero",
      });
      expect(selectorMiss).toBeNull();

      // 3. Tier 2 SnapDOM finishes 4 frames -> packs & PUTs sprite to workspace S3 cache.
      const req = createClientCompositionCaptureRequest({
        projectId: "proj-wb",
        previewUrl,
        sessionEpoch: 1,
        contentRevision: 0,
        frameCount: 4,
        duration: 6,
      });
      const pending = req.load(new AbortController().signal);

      let iframe: HTMLIFrameElement | null = null;
      await vi.waitFor(() => {
        iframe = document.querySelector<HTMLIFrameElement>('iframe[data-openmotion-thumb-capture="true"]');
        expect(iframe?.src).toContain("pt=tok-wb");
      });

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
                    projectId: "proj-wb",
                    token: "tok-wb",
                    requestId: msg.requestId,
                    ok: true,
                    result: {
                      frames: Array.from({ length: 4 }, (_, idx) => new Uint8Array([1, idx]).buffer),
                      mimeType: "image/jpeg",
                      width: 160,
                      height: 90,
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
            projectId: "proj-wb",
            token: "tok-wb",
            duration: 6,
            width: 1920,
            height: 1080,
          },
        }),
      );

      const loaded = await pending;
      expect(loaded.value.kind).toBe("filmstrip");

      await vi.waitFor(() => expect(putRequests).toHaveLength(1));
      expect(packSprite).toHaveBeenCalledTimes(1);
      expect(putRequests[0]!.url).toBe("/api/projects/proj-wb/composition-filmstrip/compositions/custom.html");
      expect(putRequests[0]!.headers["content-type"]).toBe("image/jpeg");
      expect(putRequests[0]!.headers["x-openmotion-filmstrip-sha256"]).toBe(SHA_A);
      expect(putRequests[0]!.headers["x-openmotion-filmstrip-render-key"]).toBe(RENDER_KEY_A);
      expect(putRequests[0]!.headers["x-openmotion-filmstrip-scope"]).toBe("workspace");
      expect(putRequests[0]!.headers["x-openmotion-filmstrip-frames"]).toBe("4");
      expect(putRequests[0]!.headers["x-openmotion-filmstrip-width"]).toBe("160");
      expect(putRequests[0]!.headers["x-openmotion-filmstrip-height"]).toBe("90");
      loaded.dispose?.();
    } finally {
      if (origSrcDescriptor) Object.defineProperty(HTMLIFrameElement.prototype, "src", origSrcDescriptor);
      globalThis.fetch = origFetch;
      meta.remove();
    }
  });

  it("preserves portrait aspect ratio with uniform scaling in the real sprite packer", async () => {
    // 9:16 portrait (240x427) scales uniformly by 160/240 -> 160x285 (never squashed to 160x213).
    expect(computeRemoteSpriteFrameDimensions(240, 427)).toEqual({ frameWidth: 160, frameHeight: 285 });
    // Ultra-tall 1:5 (100x500) scales uniformly by 320/500 -> 64x320.
    expect(computeRemoteSpriteFrameDimensions(100, 500)).toEqual({ frameWidth: 64, frameHeight: 320 });
    // Standard 16:9 landscape (240x135) -> 160x90.
    expect(computeRemoteSpriteFrameDimensions(240, 135)).toEqual({ frameWidth: 160, frameHeight: 90 });

    const drawnCalls: Array<{ dx: number; dy: number; dw: number; dh: number }> = [];
    const createdCanvases: Array<{ width: number; height: number }> = [];
    const origCreateElement = document.createElement.bind(document);
    const origCreateImageBitmap = globalThis.createImageBitmap;
    const origFetch = globalThis.fetch;

    const fakeBitmap = { width: 240, height: 427, close: vi.fn() };
    globalThis.createImageBitmap = vi.fn(async () => fakeBitmap) as unknown as typeof createImageBitmap;
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName.toLowerCase() === "canvas") {
        let width = 0;
        let height = 0;
        const fakeCanvas = {
          get width() {
            return width;
          },
          set width(v: number) {
            width = v;
            if (v > 0 && height > 0) createdCanvases.push({ width, height });
          },
          get height() {
            return height;
          },
          set height(v: number) {
            height = v;
            if (width > 0 && v > 0) createdCanvases.push({ width, height });
          },
          getContext: () => ({
            drawImage: (_src: unknown, dx: number, dy: number, dw: number, dh: number) => {
              drawnCalls.push({ dx, dy, dw, dh });
            },
          }),
          toBlob: (cb: (blob: Blob | null) => void) => {
            cb(new Blob(["packed-portrait-jpeg"], { type: "image/jpeg" }));
          },
        };
        return fakeCanvas as unknown as HTMLCanvasElement;
      }
      return origCreateElement(tagName);
    }) as typeof document.createElement);

    const putHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return new Response(null, {
          status: 204,
          headers: {
            "x-openmotion-filmstrip-sha256": SHA_A,
            "x-openmotion-filmstrip-render-key": RENDER_KEY_A,
            "x-openmotion-filmstrip-scope": "workspace",
          },
        });
      }
      const hdrs: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        hdrs[k.toLowerCase()] = v;
      });
      putHeaders.push(hdrs);
      return Response.json({ stored: true, frameCount: 4 });
    }) as unknown as typeof fetch;

    try {
      const previewUrl = "/api/projects/proj-portrait/preview/comp/compositions/reel.html";
      const miss = await fetchRemoteCompositionFilmstrip({
        projectId: "proj-portrait",
        previewUrl,
        compRev: "rev-p",
        contentRevision: 0,
      });
      expect(miss.status).toBe("miss");

      const uploaded = await uploadRemoteCompositionFilmstripIfEligible({
        projectId: "proj-portrait",
        previewUrl,
        compRev: "rev-p",
        contentRevision: 0,
        blobs: Array.from({ length: 4 }, (_, i) => new Blob([`p-${i}`], { type: "image/jpeg" })),
        width: 240,
        height: 427,
        aspect: 240 / 427,
        duration: 6,
      });
      expect(uploaded).toBe(true);
      expect(createdCanvases).toContainEqual({ width: 160 * 4, height: 285 });
      expect(drawnCalls).toEqual([
        { dx: 0, dy: 0, dw: 160, dh: 285 },
        { dx: 160, dy: 0, dw: 160, dh: 285 },
        { dx: 320, dy: 0, dw: 160, dh: 285 },
        { dx: 480, dy: 0, dw: 160, dh: 285 },
      ]);
      expect(putHeaders).toHaveLength(1);
      expect(putHeaders[0]!["x-openmotion-filmstrip-width"]).toBe("160");
      expect(putHeaders[0]!["x-openmotion-filmstrip-height"]).toBe("285");
      expect(putHeaders[0]!["x-openmotion-filmstrip-render-key"]).toBe(RENDER_KEY_A);
    } finally {
      globalThis.createImageBitmap = origCreateImageBitmap;
      globalThis.fetch = origFetch;
    }
  });
});
