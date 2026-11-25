// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_ASSET_READINESS } from "../../../../src/studio/engine/preview-asset-readiness";
import {
  assetLabelFromUrl,
  isDisplayablePreviewAssetName,
  isNonRetryableHttpStatus,
  trackDocumentAssetReadiness,
  withRetryQueryParam,
  type PreviewAssetProgress,
} from "./previewAssetReadiness";

function makeDocument(): Document {
  return document.implementation.createHTMLDocument("composition");
}

function makeImg(doc: Document, src: string, opts: { lazy?: boolean; complete?: boolean; naturalWidth?: number } = {}) {
  const img = doc.createElement("img");
  img.setAttribute("src", src);
  if (opts.lazy) img.loading = "lazy";
  let complete = opts.complete ?? false;
  let naturalWidth = opts.naturalWidth ?? 0;
  Object.defineProperty(img, "complete", { get: () => complete, configurable: true });
  Object.defineProperty(img, "naturalWidth", { get: () => naturalWidth, configurable: true });
  doc.body.appendChild(img);
  return {
    img,
    succeed: () => {
      complete = true;
      naturalWidth = 640;
      img.dispatchEvent(new Event("load"));
    },
    fail: () => {
      complete = true;
      naturalWidth = 0;
      img.dispatchEvent(new Event("error"));
    },
  };
}

function makeMedia(
  doc: Document,
  tag: "audio" | "video",
  src: string,
  opts: { readyState?: number; hidden?: boolean; preload?: "" | "none" | "metadata" | "auto" } = {},
) {
  const el = doc.createElement(tag) as HTMLMediaElement;
  el.setAttribute("src", src);
  if (opts.preload) el.preload = opts.preload;
  if (opts.hidden) el.setAttribute("data-hf-clip-hidden", "");
  let readyState = opts.readyState ?? 0;
  let networkState = 0;
  const loadSpy = vi.fn(() => {
    networkState = 2;
  });
  Object.defineProperty(el, "readyState", { get: () => readyState, configurable: true });
  Object.defineProperty(el, "networkState", { get: () => networkState, configurable: true });
  el.load = loadSpy;
  doc.body.appendChild(el);
  return {
    el,
    loadSpy,
    resolve: (state = tag === "audio" ? 4 : 2) => {
      readyState = state;
      el.dispatchEvent(new Event(tag === "audio" ? "canplay" : "loadeddata"));
    },
    fail: () => {
      el.dispatchEvent(new Event("error"));
    },
  };
}

describe("previewAssetReadiness helpers", () => {
  it("classifies 4xx except 408/429 as non-retryable", () => {
    expect(isNonRetryableHttpStatus(404)).toBe(true);
    expect(isNonRetryableHttpStatus(403)).toBe(true);
    expect(isNonRetryableHttpStatus(410)).toBe(true);
    expect(isNonRetryableHttpStatus(408)).toBe(false);
    expect(isNonRetryableHttpStatus(429)).toBe(false);
    expect(isNonRetryableHttpStatus(503)).toBe(false);
  });

  it("adds or replaces _omRetry cleanly and skips data/blob URLs", () => {
    expect(withRetryQueryParam("/api/projects/p/preview/a.png", 1, "http://127.0.0.1:4173/")).toBe(
      "/api/projects/p/preview/a.png?_omRetry=1",
    );
    expect(withRetryQueryParam("/api/projects/p/preview/a.png?_omRetry=1", 2, "http://127.0.0.1:4173/")).toBe(
      "/api/projects/p/preview/a.png?_omRetry=2",
    );
    expect(withRetryQueryParam("data:image/png;base64,AA==", 1)).toBeNull();
    expect(withRetryQueryParam("blob:http://127.0.0.1/abc", 1)).toBeNull();
  });

  it("extracts readable labels from URLs", () => {
    expect(assetLabelFromUrl("/api/projects/p/preview/assets/sarah%20avatar.jpg?v=1", "fallback")).toBe(
      "sarah avatar.jpg",
    );
    expect(assetLabelFromUrl("data:image/png;base64,abc", "image-1")).toBe("image-1");
  });

  it("emits the same safe pending filename through both trackers", () => {
    const sources = [
      ["https://assets.test/private/湖边%20sunset.jpg?sig=test#fragment", "湖边 sunset.jpg"],
      ["/images/scene.png/", undefined],
      ["data:image/png;base64,abc", undefined],
      ["blob:https://assets.test/cover.png", undefined],
      ["/api/a7dc6126-f1bf-464b-aafb-a4376ef483af.png", undefined],
      ["/assets/77c19dfb544025ba562c61caf71bf43d.mp3", undefined],
      ["/assets/Kg917SBkGLYrfk5VxM4q.png", undefined],
      ["/assets/image-1.png", undefined],
      ["/download?filename=cover.png", undefined],
      ["/assets/private%2Fcover.png", undefined],
      ["/assets/private%252Fcover.png", undefined],
      ["/assets/cover%3Fsignature%3Dsecret.jpg", undefined],
      ["/assets/leaves%E2%80%AEgnp.jpg", undefined],
      ["/assets/private%255Ccover.png", undefined],
      ["/assets/private%3Fsig%3Dsecret.png", undefined],
      ["/assets/cover%E2%80%AEgpj.png", undefined],
    ] as const;
    const embeddedTracker = new Function("document", "window", `${PREVIEW_ASSET_READINESS}\nreturn createAssetTracker();`);
    for (const [src, expected] of sources) {
      const doc = makeDocument();
      makeImg(doc, src);
      let snapshot: PreviewAssetProgress | undefined;
      const tracker = trackDocumentAssetReadiness(doc, window, progress => { snapshot = progress; });
      const embedded = embeddedTracker(doc, window);
      try {
        expect(snapshot?.pendingAsset, src).toBe(expected);
        expect(embedded.snapshot(), src).toEqual(snapshot);
        expect(isDisplayablePreviewAssetName(src), src).toBe(false);
        if (expected) expect(isDisplayablePreviewAssetName(expected)).toBe(true);
      } finally {
        tracker.dispose();
        embedded.dispose();
      }
    }
  });

  it.each(["audio", "video"] as const)("uses the project %s filename when the resolved URL is opaque", tag => {
    const doc = makeDocument();
    const name = tag === "audio" ? "片头音乐.m4a" : "片头动画.mp4";
    const { el } = makeMedia(doc, tag, `/assets/${encodeURIComponent(name)}`);
    Object.defineProperty(el, "currentSrc", { value: "https://storage.test/objects/abcdef0123456789?sig=private" });
    let progress: PreviewAssetProgress | undefined;
    const tracker = trackDocumentAssetReadiness(doc, window, next => { progress = next; });
    const embedded = new Function("document", "window", `${PREVIEW_ASSET_READINESS}\nreturn createAssetTracker();`)(doc, window);
    try {
      expect(progress?.pendingAsset).toBe(name);
      expect(embedded.snapshot()).toEqual(progress);
    } finally {
      tracker.dispose();
      embedded.dispose();
    }
  });

  it.each([
    ["img", "Portrait.jpg", "proxy", "Portrait.jpg"],
    ["img", "opaque", "Gallery%20cover.jpg", "Gallery cover.jpg"],
    ["srcset", "Fallback.jpg", "Selected.jpg", "Selected.jpg"],
    ["srcset", "Fallback.jpg", "proxy", undefined],
    ["source", "Opening%20scene.mp4", "proxy", "Opening scene.mp4"],
    ["source", "opaque", "Selected.mp4", "Selected.mp4"],
    ["sources", "Unselected.mp4", "Selected.mp4", "Selected.mp4"],
    ["sources", "Unselected.mp4", "proxy", undefined],
  ] as const)("names %s with src=%s and currentSrc=%s without guessing a candidate", (kind, src, selected, expected) => {
    const doc = makeDocument();
    const el = kind === "img" || kind === "srcset" ? makeImg(doc, src).img : makeMedia(doc, "video", src).el;
    if (kind === "srcset") el.setAttribute("srcset", "opaque 2x");
    if (kind === "source" || kind === "sources") {
      el.removeAttribute("src");
      el.innerHTML = `<source src="${src}">` + (kind === "sources" ? '<source src="opaque">' : '');
    }
    const currentSrc = selected === "proxy" ? `derived/${"b".repeat(64)}/proxy.mp4?sig=secret` : selected;
    Object.defineProperty(el, "currentSrc", { value: `https://storage.test/${currentSrc}` });
    let progress: PreviewAssetProgress | undefined;
    const tracker = trackDocumentAssetReadiness(doc, window, next => { progress = next; });
    const embedded = new Function("document", "window", `${PREVIEW_ASSET_READINESS}\nreturn createAssetTracker();`)(doc, window);
    try {
      expect(progress?.pendingAsset).toBe(expected);
      expect(embedded.snapshot()).toEqual(progress);
    } finally {
      tracker.dispose();
      embedded.dispose();
    }
  });
});

describe("trackDocumentAssetReadiness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("immediately settles when a composition references no external assets", () => {
    const doc = makeDocument();
    const updates: PreviewAssetProgress[] = [];
    const tracker = trackDocumentAssetReadiness(doc, window, (p) => updates.push(p));
    try {
      expect(updates.at(-1)).toEqual({ status: "ready", completed: 0, total: 0, failed: [] });
    } finally {
      tracker.dispose();
    }
  });

  it("promotes lazy images, tracks audio, and limits concurrent video preloads", () => {
    const doc = makeDocument();
    const lazyImg = makeImg(doc, "/assets/hero.png", { lazy: true });
    const audio = makeMedia(doc, "audio", "/assets/bgm.mp3", { preload: "none" });
    const hiddenAudio = makeMedia(doc, "audio", "/assets/split-hidden.mp3", { preload: "none", hidden: true });
    const videos = [1, 2, 3, 4].map((n) => makeMedia(doc, "video", `/assets/clip-${n}.mp4`, { preload: "none" }));

    const updates: PreviewAssetProgress[] = [];
    const tracker = trackDocumentAssetReadiness(doc, window, (p) => updates.push(p), {
      maxConcurrentVideos: 2,
    });
    try {
      expect(lazyImg.img.loading).toBe("eager");
      expect(audio.el.preload).toBe("auto");
      expect(hiddenAudio.el.preload).toBe("none");
      // Only first 2 videos start preloading initially (concurrency cap = 2).
      expect(videos[0].el.preload).toBe("auto");
      expect(videos[1].el.preload).toBe("auto");
      expect(videos[2].el.preload).toBe("none");
      expect(videos[3].el.preload).toBe("none");
      expect(updates.at(-1)).toMatchObject({ status: "loading", completed: 0, total: 6, pendingAsset: "hero.png" });

      lazyImg.succeed();
      expect(updates.at(-1)?.pendingAsset).toBe("bgm.mp3");
      audio.resolve(4);
      expect(updates.at(-1)?.pendingAsset).toBe("clip-1.mp4");
      videos[0].resolve(2);
      // Finishing video 0 starts video 2.
      expect(videos[2].el.preload).toBe("auto");
      expect(videos[3].el.preload).toBe("none");

      videos[1].resolve(2);
      expect(videos[3].el.preload).toBe("auto");
      videos[2].resolve(2);
      videos[3].resolve(2);

      expect(updates.at(-1)).toEqual({ status: "ready", completed: 6, total: 6, failed: [] });
    } finally {
      tracker.dispose();
    }
  });

  it("retries transient image errors with backoff and succeeds without failing the editor", async () => {
    const doc = makeDocument();
    const img = makeImg(doc, "/assets/flaky.jpg");
    const fetchMock = vi.fn(async () => ({ status: 503, type: "basic" }) as Response);
    const updates: PreviewAssetProgress[] = [];
    const tracker = trackDocumentAssetReadiness(doc, window, (p) => updates.push(p), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      retryDelaysMs: [500, 1500],
    });
    try {
      img.fail();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(updates.at(-1)?.status).toBe("loading");

      await vi.advanceTimersByTimeAsync(500);
      expect(img.img.getAttribute("src")).toContain("_omRetry=1");
      img.succeed();

      expect(updates.at(-1)).toEqual({ status: "ready", completed: 1, total: 1, failed: [] });
    } finally {
      tracker.dispose();
    }
  });

  it("fast-fails 404 assets without wasting retry backoff and never blocks remaining assets", async () => {
    const doc = makeDocument();
    const missing = makeImg(doc, "/assets/missing.jpg");
    const ok = makeImg(doc, "/assets/ok.jpg");
    const fetchMock = vi.fn(async () => ({ status: 404, type: "basic" }) as Response);
    const updates: PreviewAssetProgress[] = [];
    const tracker = trackDocumentAssetReadiness(doc, window, (p) => updates.push(p), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      retryDelaysMs: [500, 1500],
    });
    try {
      missing.fail();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(updates.at(-1)).toMatchObject({
        status: "loading",
        completed: 1,
        total: 2,
        pendingAsset: "ok.jpg",
        failed: [{ label: "missing.jpg", kind: "image", reason: "error" }],
      });

      ok.succeed();
      expect(updates.at(-1)).toMatchObject({
        status: "ready",
        completed: 2,
        total: 2,
        failed: [{ label: "missing.jpg", kind: "image", reason: "error" }],
      });
    } finally {
      tracker.dispose();
    }
  });

  it("settles timed-out assets after 10s and supports manual retry recovery", async () => {
    const doc = makeDocument();
    const slow = makeImg(doc, "/assets/slow.png");
    const updates: PreviewAssetProgress[] = [];
    const tracker = trackDocumentAssetReadiness(doc, window, (p) => updates.push(p), {
      itemTimeoutMs: 10_000,
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(updates.at(-1)).toMatchObject({
        status: "ready",
        completed: 1,
        total: 1,
        failed: [{ label: "slow.png", kind: "image", reason: "timeout" }],
      });

      const retryPromise = tracker.retryFailed();
      expect(slow.img.getAttribute("src")).toContain("_omRetry=3");
      slow.succeed();
      const remaining = await retryPromise;
      expect(remaining).toEqual([]);
      expect(updates.at(-1)).toEqual({ status: "ready", completed: 1, total: 1, failed: [] });
    } finally {
      tracker.dispose();
    }
  });

  it("allows skipping wait immediately while remaining clean on dispose", () => {
    const doc = makeDocument();
    makeImg(doc, "/assets/large.png");
    const updates: PreviewAssetProgress[] = [];
    const tracker = trackDocumentAssetReadiness(doc, window, (p) => updates.push(p));
    try {
      expect(updates.at(-1)?.status).toBe("loading");
      tracker.skip();
      expect(updates.at(-1)).toMatchObject({ status: "ready", skipped: true });
      expect(updates.at(-1)).not.toHaveProperty("pendingAsset");
    } finally {
      tracker.dispose();
    }
  });

  it("keeps the item deadline active and aborts a stalled same-origin HEAD probe for images", async () => {
    const doc = makeDocument();
    const stalled = makeImg(doc, "/assets/stalled.png");
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const updates: PreviewAssetProgress[] = [];
    const tracker = trackDocumentAssetReadiness(doc, window, (p) => updates.push(p), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      itemTimeoutMs: 4_000,
    });
    try {
      stalled.fail();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(capturedSignal?.aborted).toBe(false);
      expect(updates.at(-1)?.status).toBe("loading");

      await vi.advanceTimersByTimeAsync(4_000);
      expect(capturedSignal?.aborted).toBe(true);
      expect(updates.at(-1)).toEqual({
        status: "ready",
        completed: 1,
        total: 1,
        failed: [{ id: "img-0", label: "stalled.png", kind: "image", reason: "timeout" }],
      });
    } finally {
      tracker.dispose();
    }
  });

  it("times out a stalled HEAD probe on video error and frees the video concurrency slot", async () => {
    const doc = makeDocument();
    const stalledVideo = makeMedia(doc, "video", "/assets/stalled.mp4", { preload: "none" });
    const queuedVideo = makeMedia(doc, "video", "/assets/next.mp4", { preload: "none" });
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const updates: PreviewAssetProgress[] = [];
    const tracker = trackDocumentAssetReadiness(doc, window, (p) => updates.push(p), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      itemTimeoutMs: 3_000,
      maxConcurrentVideos: 1,
    });
    try {
      expect(stalledVideo.el.preload).toBe("auto");
      expect(queuedVideo.el.preload).toBe("none");

      stalledVideo.fail();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(capturedSignal?.aborted).toBe(false);
      expect(queuedVideo.el.preload).toBe("none");

      await vi.advanceTimersByTimeAsync(3_000);
      expect(capturedSignal?.aborted).toBe(true);
      // Slot is released immediately so the queued video begins preloading.
      expect(queuedVideo.el.preload).toBe("auto");
      expect(updates.at(-1)).toMatchObject({
        status: "loading",
        completed: 1,
        total: 2,
        failed: [{ id: "video-0", label: "stalled.mp4", kind: "video", reason: "timeout" }],
      });

      queuedVideo.resolve(2);
      expect(updates.at(-1)).toEqual({
        status: "ready",
        completed: 2,
        total: 2,
        failed: [{ id: "video-0", label: "stalled.mp4", kind: "video", reason: "timeout" }],
      });
    } finally {
      tracker.dispose();
    }
  });
});
