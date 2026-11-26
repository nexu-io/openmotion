// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoFrameThumbnail } from "./VideoFrameThumbnail";
import {
  getCachedVideoFrame,
  MAX_CACHED_BYTES,
  MAX_THUMBNAIL_EDGE,
  resetVideoFrameThumbnailLoaderForTests,
  resolveVideoFrameUrl,
} from "./videoFrameThumbnailLoader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The component builds its thumbnail from document.createElement("video"/"canvas"),
// so both are faked here. The video fake records load() calls and keeps listener
// sets, letting a test re-fire an event handler after cleanup removed it — the
// exact shape of the error→cleanup→error loop this suite guards against.
interface FakeVideo {
  crossOrigin: string;
  muted: boolean;
  playsInline: boolean;
  preload: string;
  duration: number;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  loadCalls: number;
  _src: string;
  src: string;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  getAttribute(name: string): string | null;
  load(): void;
  dispatch(type: string): void;
}

function makeVideo(): FakeVideo {
  const listeners = new Map<string, Set<() => void>>();
  const video: FakeVideo = {
    crossOrigin: "",
    muted: false,
    playsInline: false,
    preload: "",
    duration: 10,
    readyState: 0,
    videoWidth: 640,
    videoHeight: 360,
    currentTime: 0,
    loadCalls: 0,
    _src: "",
    src: "",
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    getAttribute(name) {
      return name === "src" ? video.src : null;
    },
    load() {
      video.loadCalls++;
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
  Object.defineProperty(video, "src", {
    get: () => video._src,
    set: (v: string) => {
      video._src = v;
    },
  });
  return video;
}

let toDataUrlImpl: () => string = () => "data:image/jpeg;base64,AAAA";
const canvas = {
  width: 0,
  height: 0,
  getContext: () => ({ drawImage: () => {} }),
  toDataURL: () => toDataUrlImpl(),
};

describe("VideoFrameThumbnail", () => {
  let videos: FakeVideo[];
  let root: Root;
  let container: HTMLDivElement;
  let originalIntersectionObserver: typeof globalThis.IntersectionObserver;

  beforeEach(() => {
    resetVideoFrameThumbnailLoaderForTests();
    toDataUrlImpl = () => "data:image/jpeg;base64,AAAA";
    originalIntersectionObserver = globalThis.IntersectionObserver;
    videos = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag === "video") {
        const v = makeVideo();
        videos.push(v);
        return v as unknown as HTMLVideoElement;
      }
      if (tag === "canvas") return canvas as unknown as HTMLCanvasElement;
      return original(tag);
    }) as typeof document.createElement);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetVideoFrameThumbnailLoaderForTests();
    globalThis.IntersectionObserver = originalIntersectionObserver;
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const render = (props: { src: string; fallbackLabel?: string }) => {
    act(() => root.render(<VideoFrameThumbnail {...props} />));
    return videos[videos.length - 1];
  };

  it("renders the fallback label when the video errors", () => {
    render({ src: "missing.mp4", fallbackLabel: "VIDEO" });
    const video = videos[0];
    expect(video.src).toBe("missing.mp4");
    expect(video.loadCalls).toBe(1);

    act(() => video.dispatch("error"));

    expect(container.textContent).toContain("VIDEO");
    // cleanup ran once: detached the error listener and reset the media element
    expect(video.src).toBe("");
    expect(video.loadCalls).toBe(2);
  });

  it("does not loop when the cleared src fires a synthetic error", () => {
    render({ src: "missing.mp4", fallbackLabel: "VIDEO" });
    const video = videos[0];
    act(() => video.dispatch("error"));
    expect(video.loadCalls).toBe(2);

    // The empty src makes the browser fire `error` again; the detached handler
    // must stay detached — repeated dispatches must not touch load() anymore.
    act(() => {
      video.dispatch("error");
      video.dispatch("error");
      video.dispatch("error");
    });

    expect(video.loadCalls).toBe(2);
    expect(container.textContent).toContain("VIDEO");
  });

  it("keeps the extracted frame and stays inert after a post-seek synthetic error", () => {
    render({ src: "clip.mp4" });
    const video = videos[0];

    act(() => video.dispatch("loadedmetadata"));
    expect(video.currentTime).toBe(1); // 10% of a 10s clip

    act(() => video.dispatch("seeked"));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(video.src).toBe("");
    expect(video.loadCalls).toBe(2);

    act(() => {
      video.dispatch("error");
      video.dispatch("error");
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(video.loadCalls).toBe(2);
  });

  it("shows a still, full-size placeholder while the frame loads", () => {
    render({ src: "clip.mp4" });
    const placeholder = container.querySelector("[data-thumbnail-loading]");
    expect(placeholder).not.toBeNull();
    expect(placeholder?.className).not.toMatch(/\banimate-/);
    expect(placeholder?.classList.contains("w-full")).toBe(true);
    expect(placeholder?.classList.contains("h-full")).toBe(true);
  });

  it("retries with a fresh video element when src changes and clears the previous version's frame", () => {
    toDataUrlImpl = () => "data:image/jpeg;base64,V1FRAME";
    render({ src: "/motion-api/assets/a1/versions/v1/file", fallbackLabel: "Preview unavailable" });
    const v1 = videos[0];
    expect(v1.src).toBe("/motion-api/assets/a1/versions/v1/file?frame=1");

    act(() => v1.dispatch("loadedmetadata"));
    act(() => v1.dispatch("seeked"));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,V1FRAME");

    // Switching to V2 must immediately drop V1's frame so V2 never shows stale V1 imagery.
    toDataUrlImpl = () => "data:image/jpeg;base64,V2FRAME";
    act(() => root.render(<VideoFrameThumbnail src="/motion-api/assets/a1/versions/v2/file" fallbackLabel="Preview unavailable" />));
    expect(videos.length).toBe(2);
    expect(videos[1].src).toBe("/motion-api/assets/a1/versions/v2/file?frame=1");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-thumbnail-loading]")).not.toBeNull();

    // Even if V2 errors, it must show the fallback label rather than V1's frame.
    act(() => videos[1].dispatch("error"));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Preview unavailable");
  });

  it("isolates cloud storage redirect URLs with ?frame=1 and leaves non-cloud URLs untouched", () => {
    expect(resolveVideoFrameUrl("/motion-api/assets/a1/versions/v1/file")).toBe(
      "/motion-api/assets/a1/versions/v1/file?frame=1",
    );
    expect(resolveVideoFrameUrl("/motion-api/assets/a1/versions/v1/file", 2)).toBe(
      "/motion-api/assets/a1/versions/v1/file?frame=1&retry=2",
    );
    expect(resolveVideoFrameUrl("/api/render/job-1/view?project=p1")).toBe(
      "/api/render/job-1/view?project=p1&frame=1",
    );
    expect(resolveVideoFrameUrl("/api/projects/p1/renders/file/out.mp4")).toBe(
      "/api/projects/p1/renders/file/out.mp4?frame=1",
    );
    expect(resolveVideoFrameUrl("clip.mp4")).toBe("clip.mp4");
    expect(resolveVideoFrameUrl("blob:https://example.test/1234")).toBe("blob:https://example.test/1234");
    expect(resolveVideoFrameUrl("https://cdn.example.com/motion-api/assets/a1/versions/v1/file")).toBe(
      "https://cdn.example.com/motion-api/assets/a1/versions/v1/file",
    );
  });

  it("serves cached frames instantly across remounts (search filter / reopen)", () => {
    const src = "/motion-api/assets/cat/versions/v1/file";
    render({ src });
    act(() => videos[0].dispatch("loadedmetadata"));
    act(() => videos[0].dispatch("seeked"));
    expect(videos.length).toBe(1);

    // Unmount and remount (simulating search filter or sidebar/version history render).
    act(() => root.render(<div />));
    act(() => root.render(<VideoFrameThumbnail src={src} fallbackLabel="Preview unavailable" />));

    expect(videos.length).toBe(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
  });

  it("deduplicates concurrent mounts for the same version and caps concurrent extractions to 4", () => {
    const sharedSrc = "/motion-api/assets/shared/versions/v1/file";
    act(() => {
      root.render(
        <div>
          <VideoFrameThumbnail src={sharedSrc} />
          <VideoFrameThumbnail src={sharedSrc} />
          <VideoFrameThumbnail src="/motion-api/assets/a2/versions/v1/file" />
          <VideoFrameThumbnail src="/motion-api/assets/a3/versions/v1/file" />
          <VideoFrameThumbnail src="/motion-api/assets/a4/versions/v1/file" />
          <VideoFrameThumbnail src="/motion-api/assets/a5/versions/v1/file" />
        </div>,
      );
    });

    // Two mounts for sharedSrc share 1 video, and a5 waits in the concurrency queue (max 4 active).
    expect(videos.length).toBe(4);
    expect(videos.map((v) => v.src)).toEqual([
      "/motion-api/assets/shared/versions/v1/file?frame=1",
      "/motion-api/assets/a2/versions/v1/file?frame=1",
      "/motion-api/assets/a3/versions/v1/file?frame=1",
      "/motion-api/assets/a4/versions/v1/file?frame=1",
    ]);

    // Completing sharedSrc updates both mounted copies and starts the queued 5th item.
    act(() => videos[0].dispatch("loadedmetadata"));
    act(() => videos[0].dispatch("seeked"));

    expect(container.querySelectorAll("img").length).toBe(2);
    expect(videos.length).toBe(5);
    expect(videos[4].src).toBe("/motion-api/assets/a5/versions/v1/file?frame=1");
  });

  it("recovers automatically via backoff retry and after returning online", () => {
    vi.useFakeTimers();
    const src = "/motion-api/assets/cat/versions/v1/file";
    render({ src, fallbackLabel: "Preview unavailable" });

    // Initial attempt fails -> shows fallback immediately and schedules retry 1 after 1000ms.
    act(() => videos[0].dispatch("error"));
    expect(container.textContent).toContain("Preview unavailable");
    expect(videos.length).toBe(1);

    // Retry 1 fires with ?frame=1&retry=1 and fails too.
    act(() => vi.advanceTimersByTime(1_000));
    expect(videos.length).toBe(2);
    expect(videos[1].src).toBe("/motion-api/assets/cat/versions/v1/file?frame=1&retry=1");
    act(() => videos[1].dispatch("error"));

    // Retry 2 fires after 3000ms and fails too -> exhausts automatic backoff retries.
    act(() => vi.advanceTimersByTime(3_000));
    expect(videos.length).toBe(3);
    expect(videos[2].src).toBe("/motion-api/assets/cat/versions/v1/file?frame=1&retry=2");
    act(() => videos[2].dispatch("error"));

    // No unbounded retries after exhaustion.
    act(() => vi.advanceTimersByTime(10_000));
    expect(videos.length).toBe(3);
    expect(container.textContent).toContain("Preview unavailable");

    // Returning online triggers recovery and heals the card into the extracted frame.
    act(() => window.dispatchEvent(new Event("online")));
    expect(videos.length).toBe(4);
    expect(videos[3].src).toBe("/motion-api/assets/cat/versions/v1/file?frame=1&retry=3");
    act(() => videos[3].dispatch("loadedmetadata"));
    act(() => videos[3].dispatch("seeked"));

    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(container.textContent).not.toContain("Preview unavailable");
  });

  it("recovers when a failed card re-enters the viewport", () => {
    vi.useFakeTimers();
    const observers: Array<{ callback: IntersectionObserverCallback }> = [];
    globalThis.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];
    } as unknown as typeof IntersectionObserver;

    const src = "/motion-api/assets/b1125/versions/v1/file";
    render({ src, fallbackLabel: "Preview unavailable" });
    // First paint begins extraction immediately (capped by shared concurrency queue).
    expect(videos.length).toBe(1);

    // Exhaust automatic backoff retries while in view.
    act(() => videos[0].dispatch("error"));
    act(() => vi.advanceTimersByTime(1_000));
    act(() => videos[1].dispatch("error"));
    act(() => vi.advanceTimersByTime(3_000));
    act(() => videos[2].dispatch("error"));
    expect(container.textContent).toContain("Preview unavailable");

    // Scrolls offscreen and back onscreen -> triggers a single fresh recovery extraction.
    act(() => observers.at(-1)!.callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    act(() => observers.at(-1)!.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(videos.length).toBe(4);
    act(() => videos[3].dispatch("loadedmetadata"));
    act(() => videos[3].dispatch("seeked"));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
  });

  it("handles zero-duration videos via loadeddata and treats tainted/empty canvas captures as recoverable failures", () => {
    vi.useFakeTimers();
    render({ src: "short.mp4", fallbackLabel: "Preview unavailable" });
    const v0 = videos[0];
    v0.duration = 0;
    v0.readyState = 1;
    toDataUrlImpl = () => {
      throw new DOMException("Tainted canvas", "SecurityError");
    };

    act(() => v0.dispatch("loadedmetadata"));
    expect(v0.currentTime).toBe(0);
    act(() => v0.dispatch("loadeddata"));
    expect(container.textContent).toContain("Preview unavailable");

    // Next retry succeeds cleanly once canvas capture works.
    toDataUrlImpl = () => "data:image/jpeg;base64,RECOVERED";
    act(() => vi.advanceTimersByTime(1_000));
    const v1 = videos[1];
    v1.duration = Number.NaN;
    v1.readyState = 2;
    act(() => v1.dispatch("loadedmetadata"));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,RECOVERED");
  });

  it("downscales high-resolution videos to MAX_THUMBNAIL_EDGE while keeping smaller videos unscaled", () => {
    // 4K landscape -> clamped proportionally to MAX_THUMBNAIL_EDGE wide.
    render({ src: "/motion-api/assets/uhd/versions/v1/file" });
    videos[0].videoWidth = 3840;
    videos[0].videoHeight = 2160;
    act(() => videos[0].dispatch("loadedmetadata"));
    act(() => videos[0].dispatch("seeked"));
    expect(canvas.width).toBe(MAX_THUMBNAIL_EDGE);
    expect(canvas.height).toBe(Math.round(MAX_THUMBNAIL_EDGE * (2160 / 3840)));

    // 4K portrait -> clamped proportionally to MAX_THUMBNAIL_EDGE tall.
    render({ src: "/motion-api/assets/uhd/versions/v2/file" });
    videos[1].videoWidth = 2160;
    videos[1].videoHeight = 3840;
    act(() => videos[1].dispatch("loadedmetadata"));
    act(() => videos[1].dispatch("seeked"));
    expect(canvas.height).toBe(MAX_THUMBNAIL_EDGE);
    expect(canvas.width).toBe(Math.round(MAX_THUMBNAIL_EDGE * (2160 / 3840)));

    // Standard 640x360 stays unscaled.
    render({ src: "/motion-api/assets/sd/versions/v1/file" });
    videos[2].videoWidth = 640;
    videos[2].videoHeight = 360;
    act(() => videos[2].dispatch("loadedmetadata"));
    act(() => videos[2].dispatch("seeked"));
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
  });

  it("evicts oldest cached frames when accumulated byte size exceeds MAX_CACHED_BYTES", () => {
    const chunkLen = Math.floor(MAX_CACHED_BYTES * 0.45);
    const makePayload = (tag: string) => `data:image/jpeg;base64,${tag}${"A".repeat(chunkLen)}`;

    toDataUrlImpl = () => makePayload("1");
    render({ src: "/motion-api/assets/mem/versions/v1/file" });
    act(() => videos[0].dispatch("loadedmetadata"));
    act(() => videos[0].dispatch("seeked"));

    toDataUrlImpl = () => makePayload("2");
    render({ src: "/motion-api/assets/mem/versions/v2/file" });
    act(() => videos[1].dispatch("loadedmetadata"));
    act(() => videos[1].dispatch("seeked"));

    // Both v1 and v2 fit under 90% of MAX_CACHED_BYTES; touch v1 so v2 becomes oldest.
    expect(getCachedVideoFrame("/motion-api/assets/mem/versions/v1/file")).not.toBeNull();
    expect(getCachedVideoFrame("/motion-api/assets/mem/versions/v2/file")).not.toBeNull();
    expect(getCachedVideoFrame("/motion-api/assets/mem/versions/v1/file")).not.toBeNull();

    // Inserting v3 pushes total over MAX_CACHED_BYTES -> evicts LRU entry (v2) while keeping v1 and v3.
    toDataUrlImpl = () => makePayload("3");
    render({ src: "/motion-api/assets/mem/versions/v3/file" });
    act(() => videos[2].dispatch("loadedmetadata"));
    act(() => videos[2].dispatch("seeked"));

    expect(getCachedVideoFrame("/motion-api/assets/mem/versions/v2/file")).toBeNull();
    expect(getCachedVideoFrame("/motion-api/assets/mem/versions/v1/file")).not.toBeNull();
    expect(getCachedVideoFrame("/motion-api/assets/mem/versions/v3/file")).not.toBeNull();
  });
});
