// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thumbnailScheduler } from "../../player/lib/thumbnailScheduler";
import { TIMELINE_VIEWPORT_BUDGETS } from "../../player/lib/timelineViewportBudgets";
import { CompositionThumbnail } from "../../player/components/CompositionThumbnail";
import {
  clearClientCompositionCaptureCacheForTest,
  seedClientCompositionSpriteForTest,
  setCachedProjectRevision,
  setClientCompositionCaptureCapabilityForTest,
  updateCachedCompositionRevisions,
} from "../../player/lib/clientCompositionCapture";
import { hasIndexSharedRenderContextChanged } from "../../../../shared/preview-impact";
import { setCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import { clearCachedCompositionTimelinesForTest } from "../../player/lib/compositionTimelineCache";
import { usePlayerStore } from "../../player/store/playerStore";
import { renderPosterForNextOpen } from "../nle/PreviewPoster";
import { clearRememberedRootCoversForTest, CompositionsTab } from "./CompositionsTab";
import { mountCompositionsTab } from "./compositionsTabTestUtils";

class DecodingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 16;
  naturalHeight = 9;
  set src(value: string) {
    if (value) queueMicrotask(() => this.onload?.());
  }
}

let autoIntersect = true;
const observed: Array<{
  element: Element;
  callback: IntersectionObserverCallback;
  root?: Element | Document | null;
}> = [];
class ViewportObserver {
  constructor(
    private readonly callback: IntersectionObserverCallback,
    private readonly options?: IntersectionObserverInit,
  ) {}
  observe(element: Element) {
    observed.push({ element, callback: this.callback, root: this.options?.root });
    if (autoIntersect) this.enter();
  }
  enter() {
    const entry = { isIntersecting: true } as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
}

interface Render {
  url: URL;
  signal: AbortSignal;
  answer: (status?: number) => void;
}

const real = {
  IntersectionObserver: globalThis.IntersectionObserver,
  fetch: globalThis.fetch,
  Image: globalThis.Image,
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
};
let renders: Render[] = [];
let inFlight = 0;
let peak = 0;
let frames = 0;

beforeEach(() => {
  renders = [];
  [inFlight, peak, frames] = [0, 0, 0];
  globalThis.fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal ?? new AbortController().signal;
        peak = Math.max(peak, ++inFlight);
        const end = () => (inFlight -= 1);
        signal.addEventListener("abort", () => {
          end();
          reject(new DOMException("Aborted", "AbortError"));
        });
        const answer = (status = 200) => {
          end();
          resolve(new Response(new Blob(["png"]), { status }));
        };
        renders.push({ url: new URL(String(input), window.location.origin), signal, answer });
      }),
  ) as typeof fetch;
  globalThis.Image = DecodingImage as unknown as typeof Image;
  globalThis.IntersectionObserver = ViewportObserver as unknown as typeof IntersectionObserver;
  [autoIntersect, observed.length] = [true, 0];
  URL.createObjectURL = vi.fn(() => `blob:frame-${++frames}`);
  URL.revokeObjectURL = vi.fn();
  usePlayerStore.setState({ previewBooted: false });
});

afterEach(() => {
  setCachedCloudDisklessMode(null);
  setClientCompositionCaptureCapabilityForTest(null);
  clearClientCompositionCaptureCacheForTest();
  clearCachedCompositionTimelinesForTest();
  clearRememberedRootCoversForTest();
  usePlayerStore.setState({ elements: [] });
  Object.assign(globalThis, {
    fetch: real.fetch,
    Image: real.Image,
    IntersectionObserver: real.IntersectionObserver,
  });
  Object.assign(URL, { createObjectURL: real.create, revokeObjectURL: real.revoke });
});

const mount = (compositions?: string[]) => mountCompositionsTab(compositions && { compositions });
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));
const shown = (host: HTMLElement) => host.querySelector("img")?.getAttribute("src") ?? null;

async function nextRevisionShows(host: HTMLElement, revision: string, frame: string) {
  act(() => usePlayerStore.getState().bumpThumbnailRevisions(null));
  expect(renders.at(-1)!.url.searchParams.get("revision")).toBe(revision);
  renders.at(-1)!.answer();
  await settle();
  expect(shown(host)).toBe(frame);
}

describe("composition card thumbnails", () => {
  it("render through the shared scheduler when the preview is closed, and never point an image at the route", async () => {
    usePlayerStore.getState().reset();
    const host = mount();
    expect(usePlayerStore.getState().previewBooted).toBe(false);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ priority: "low" }));
    expect(renders.map((r) => [r.url.pathname, r.url.searchParams.get("t")])).toEqual([
      ["/api/projects/demo/thumbnail/compositions/headline.html", "3.00"],
    ]);
    expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeTruthy();
    renders[0]!.answer();
    await settle();
    expect(shown(host)).toBe("blob:frame-1");
    expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeTruthy();
    act(() => host.querySelector("img")!.dispatchEvent(new Event("load")));
    expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeNull();
    expect(host.querySelector("iframe")).toBeNull();

    act(() => usePlayerStore.getState().setTimelineReady(false));
    expect(shown(host)).toBe("blob:frame-1");
  });

  it("wait until a card is near the viewport, so an offscreen card never renders ahead of a visible one", () => {
    autoIntersect = false;
    mount(["compositions/above.html", "compositions/seen.html", "compositions/below.html"]);
    expect(renders).toHaveLength(0);

    const seen = observed.find((o) =>
      o.element.closest("[draggable]")?.textContent?.includes("seen"),
    )!;
    act(() =>
      seen.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(renders.map((r) => r.url.pathname)).toEqual([
      "/api/projects/demo/thumbnail/compositions/seen.html",
    ]);
    expect(seen.root).toBe(document.querySelector("[data-composition-list]"));
    act(() => seen.callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(renders[0]!.signal.aborted).toBe(true);
  });

  it("releases an offscreen card and reuses its cached frame on return", async () => {
    const host = mount();
    renders[0]!.answer();
    await settle();
    const entry = observed[0]!;
    const intersect = (isIntersecting: boolean) => act(() => entry.callback(
      [{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver,
    ));
    intersect(false);
    expect(thumbnailScheduler.getDiagnostics().leases).toBe(0);
    intersect(true);
    expect(shown(host)).toBe("blob:frame-1");
    expect(renders).toHaveLength(1);
  });

  it("keep showing the last frame, leased, until the next revision's frame is ready", async () => {
    const host = mount();
    renders[0]!.answer();
    await settle();
    act(() => usePlayerStore.getState().bumpThumbnailRevisions(null));
    expect(shown(host)).toBe("blob:frame-1");
    thumbnailScheduler.invalidateProject("demo");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:frame-1");

    renders.at(-1)!.answer();
    await settle();
    expect(shown(host)).toBe("blob:frame-2");
  });

  it("keep the last frame through a new revision even when the scheduler has evicted it", async () => {
    const host = mount();
    renders[0]!.answer();
    await settle();
    const fillers = Array.from({ length: 100 }, (_, i) =>
      thumbnailScheduler.acquire(
        {
          key: `filler-${i}`,
          projectId: "demo",
          sessionEpoch: 0,
          kind: "image",
          priority: "visible",
          load: async () => ({
            value: { kind: "image", url: `blob:filler-${i}`, aspect: 1 },
            weight: 1,
          }),
        },
        () => {},
      ),
    );
    while (
      thumbnailScheduler.getDiagnostics().queued + thumbnailScheduler.getDiagnostics().active >
      0
    ) {
      await settle();
    }
    for (const filler of fillers) filler.release();

    act(() => usePlayerStore.getState().bumpThumbnailRevisions(null));
    expect(renders.map((r) => r.url.searchParams.get("revision"))).toEqual(["0", "1"]);
    expect(shown(host)).toBe("blob:frame-1");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:frame-1");
  });

  it("share one render with the timeline's thumbnail of the same composition", () => {
    mount();
    const timeline = createRoot(document.body.appendChild(document.createElement("div")));
    try {
      act(() =>
        timeline.render(
          <CompositionThumbnail
            previewUrl="/api/projects/demo/preview/comp/compositions/headline.html"
            label=""
            labelColor=""
            projectId="demo"
            sessionEpoch={usePlayerStore.getState().timelineSessionEpoch}
            seekTime={3}
            duration={0}
          />,
        ),
      );
      expect(renders).toHaveLength(1);
    } finally {
      act(() => timeline.unmount());
    }
  });

  it("keep the cards and the poster render to the scheduler's cap, so Studio's own requests get a connection", async () => {
    const cap = TIMELINE_VIEWPORT_BUDGETS.concurrentCompositionFetches;
    mount(Array.from({ length: 6 }, (_, i) => `compositions/scene-${i}.html`));
    renderPosterForNextOpen("demo");
    expect(inFlight).toBe(cap);

    while (renders.some((r) => !r.signal.aborted)) {
      renders.shift()!.answer();
      await settle();
    }
    expect(renders).toHaveLength(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(7);
    expect(peak).toBe(cap);
  });

  it("abort a stale revision's render, and free its frame when the scheduler evicts it", async () => {
    const host = mount();
    const first = renders[0]!;
    await nextRevisionShows(host, "1", "blob:frame-1");
    expect(first.signal.aborted).toBe(true);
    await nextRevisionShows(host, "2", "blob:frame-2");

    thumbnailScheduler.invalidateProject("demo");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:frame-2");
  });

  it("tell a hover preview how large it shows, so its videos are not copied at source size", () => {
    vi.useFakeTimers();
    try {
      const host = mount();
      const card = host.querySelector<HTMLElement>('[aria-label^="Open composition"]')!;
      act(() => {
        card.dispatchEvent(
          new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
        );
      });
      act(() => vi.advanceTimersByTime(300));
      const frame = host.querySelector("iframe")!;
      const postMessage = vi.fn();
      Object.defineProperty(frame, "contentWindow", { value: { postMessage } });
      Object.defineProperty(frame, "offsetWidth", { value: 1920 });
      frame.getBoundingClientRect = () => ({ width: 80 }) as DOMRect;
      act(() => {
        frame.dispatchEvent(new Event("load"));
      });
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "set-display-scale", scale: 80 / 1920 }),
        "*",
      );

      // A module-script composition starts listening only after load, then says it is ready.
      postMessage.mockClear();
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: frame.contentWindow,
            data: { source: "hf-preview", type: "ready" },
          }),
        );
      });
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "set-display-scale", scale: 80 / 1920 }),
        "*",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("show a fallback with bottom-right error reload badge when the render fails, and recover on click or next revision", async () => {
    const host = mount();
    renders[0]!.answer(500);
    await settle();
    expect(host.textContent).not.toContain("Preview unavailable");
    expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeTruthy();

    const reloadBtn = host.querySelector<HTMLButtonElement>('[data-testid="item-load-error"]');
    expect(reloadBtn).not.toBeNull();

    // Clicking reload retries immediately in place without waiting for a revision bump.
    act(() => reloadBtn!.click());
    expect(renders).toHaveLength(2);
    renders[1]!.answer(200);
    await settle();
    expect(shown(host)).toBe("blob:frame-1");
    act(() => host.querySelector("img")!.dispatchEvent(new Event("load")));
    expect(host.querySelector('[data-testid="item-load-error"]')).toBeNull();
    await nextRevisionShows(host, "1", "blob:frame-2");
  });

  it("never flashes back to the loading placeholder or remounts the cover image when a revision updates", async () => {
    const host = mount();
    renders[0]!.answer();
    await settle();
    const imgBefore = host.querySelector("img")!;
    act(() => imgBefore.dispatchEvent(new Event("load")));
    expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeNull();
    expect(imgBefore.className).toContain("opacity-100");

    // Bump revision (simulating a timeline edit) and resolve the updated frame.
    act(() => usePlayerStore.getState().bumpThumbnailRevisions(null));
    expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeNull();
    expect(host.querySelector("img")).toBe(imgBefore);
    expect(imgBefore.className).toContain("opacity-100");

    renders.at(-1)!.answer();
    await settle();
    // Same DOM <img> updates in place without flashing opacity-0 or restoring the placeholder.
    expect(host.querySelector("img")).toBe(imgBefore);
    expect(imgBefore.getAttribute("src")).toBe("blob:frame-2");
    expect(imgBefore.className).toContain("opacity-100");
    expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeNull();
  });

  it("reuses the first child composition's cover for the Root card so editing index.html does not re-render a Root cover", async () => {
    const host = mountCompositionsTab({
      compositions: ["index.html", "compositions/scene-1.html", "compositions/scene-2.html"],
      masterCompositionPath: "index.html",
    });
    // Root card shares scene-1's thumbnail request — no separate request for index.html.
    expect(renders.map((r) => r.url.pathname)).toEqual([
      "/api/projects/demo/thumbnail/compositions/scene-1.html",
      "/api/projects/demo/thumbnail/compositions/scene-2.html",
    ]);
    renders[0]!.answer();
    renders[1]!.answer();
    await settle();

    const cards = [...host.querySelectorAll<HTMLElement>('[draggable="true"]')];
    expect(cards[0]?.textContent).toContain("Root");
    expect(cards[0]?.querySelector("img")?.getAttribute("src")).toBe("blob:frame-1");
    expect(cards[1]?.querySelector("img")?.getAttribute("src")).toBe("blob:frame-1");

    // Editing only index.html bumps index.html's revision without triggering a re-fetch for Root.
    act(() => usePlayerStore.getState().bumpThumbnailRevisions(["index.html"]));
    expect(renders).toHaveLength(2);
  });

  it("keeps the Root card pinned to the master timeline's earliest scene cover after clicking into another sub-composition", async () => {
    // Master timeline starts with intro.html at t=0, while choice.html comes first alphabetically.
    usePlayerStore.setState({
      elements: [
        { id: "c", tag: "div", start: 10, duration: 5, track: 0, compositionSrc: "compositions/choice.html" },
        { id: "i", tag: "div", start: 0, duration: 5, track: 0, compositionSrc: "compositions/intro.html" },
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      projectId: "demo",
      compositions: ["index.html", "compositions/choice.html", "compositions/intro.html"],
      masterCompositionPath: "index.html",
      onSelect: vi.fn(),
    };
    try {
      act(() => {
        root.render(<CompositionsTab {...props} activeComposition="index.html" />);
      });
      // First request is intro.html (shared by Root and intro), second is choice.html.
      expect(renders.map((r) => r.url.pathname)).toEqual([
        "/api/projects/demo/thumbnail/compositions/intro.html",
        "/api/projects/demo/thumbnail/compositions/choice.html",
      ]);
      renders[0]!.answer();
      renders[1]!.answer();
      await settle();

      const srcOf = (idx: number) =>
        host.querySelectorAll<HTMLElement>('[draggable="true"]')[idx]?.querySelector("img")?.getAttribute("src");
      expect(srcOf(0)).toBe("blob:frame-1"); // Root -> intro.html
      expect(srcOf(1)).toBe("blob:frame-2"); // choice.html
      expect(srcOf(2)).toBe("blob:frame-1"); // intro.html

      // Clicking choice.html replaces playerStore.elements with choice's inner elements (no compositionSrc).
      act(() => {
        usePlayerStore.setState({
          elements: [{ id: "choice-heading", tag: "h1", start: 0, duration: 4, track: 0 }],
        });
        root.render(<CompositionsTab {...props} activeComposition="compositions/choice.html" />);
      });
      await settle();

      // Root card must STAY on intro.html's cover (blob:frame-1), never jumping to choice.html (blob:frame-2).
      expect(srcOf(0)).toBe("blob:frame-1");
      expect(srcOf(1)).toBe("blob:frame-2");
      expect(srcOf(2)).toBe("blob:frame-1");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("uses the same placeholder if the poster image fails, and recovers on a new revision", async () => {
    const host = mount();
    renders[0]!.answer();
    await settle();
    act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(shown(host)).toBeNull();
    expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeTruthy();
    expect(host.textContent).not.toContain("Preview unavailable");
    await nextRevisionShows(host, "1", "blob:frame-2");
    act(() => host.querySelector("img")!.dispatchEvent(new Event("load")));
    expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeNull();
  });

  it("renders a zero-slice multi-frame sprite cover, cycles and scrubs on hover with 0 iframes, and respects reduced motion", () => {
    vi.useFakeTimers();
    setCachedCloudDisklessMode(true);
    setClientCompositionCaptureCapabilityForTest(true);
    const previewUrl = "/api/projects/demo/preview/comp/compositions/headline.html";
    seedClientCompositionSpriteForTest(
      {
        projectId: "demo",
        previewUrl,
        contentRevision: 0,
        frameCount: 8,
      },
      new Blob(["sprite-jpeg"], { type: "image/jpeg" }),
      { frameCount: 8, cols: 8, rows: 1, width: 160, height: 90, aspect: 16 / 9 },
    );

    const origMatchMedia = window.matchMedia;
    let reducedMotion = false;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

    try {
      const host = mount();
      // Static default: middle frame (index 4 of 8), no placeholder, no <img>, no network fetch.
      expect(renders).toHaveLength(0);
      expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeNull();
      expect(host.querySelector("img")).toBeNull();
      const spriteEl = () => host.querySelector<HTMLElement>("[data-sprite-frame]");
      expect(spriteEl()?.getAttribute("data-sprite-frame")).toBe("4");
      expect(spriteEl()?.getAttribute("data-sprite-url")).toBe("blob:frame-1");

      const card = host.querySelector<HTMLElement>('[aria-label^="Open composition"]')!;
      const thumbBox = spriteEl()!.parentElement!;
      thumbBox.getBoundingClientRect = () => ({ left: 100, width: 80, top: 0, height: 45 }) as DOMRect;

      // Hover starts cycling after 120ms and NEVER mounts an iframe (even past 300ms+).
      act(() => {
        card.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      });
      act(() => vi.advanceTimersByTime(120));
      expect(spriteEl()?.getAttribute("data-sprite-frame")).toBe("0");
      expect(host.querySelector('[data-testid="composition-hover-progress"]')).not.toBeNull();

      act(() => vi.advanceTimersByTime(360));
      expect(spriteEl()?.getAttribute("data-sprite-frame")).toBe("1");
      expect(host.querySelector("iframe")).toBeNull();

      // Pointer scrub across thumbnail maps horizontal position directly to frame index.
      act(() => {
        thumbBox.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 175 }));
      });
      expect(spriteEl()?.getAttribute("data-sprite-frame")).toBe("7");

      // Pointer leave resets back to static middle frame (index 4) and hides scrub bar.
      act(() => {
        card.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
      });
      expect(spriteEl()?.getAttribute("data-sprite-frame")).toBe("4");
      expect(host.querySelector('[data-testid="composition-hover-progress"]')).toBeNull();
      expect(host.querySelector("iframe")).toBeNull();

      // With prefers-reduced-motion: reduce, hover does not auto-cycle, while pointer scrub still works.
      reducedMotion = true;
      act(() => {
        card.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      });
      act(() => vi.advanceTimersByTime(600));
      expect(spriteEl()?.getAttribute("data-sprite-frame")).toBe("4");
      act(() => {
        thumbBox.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 112 }));
      });
      expect(spriteEl()?.getAttribute("data-sprite-frame")).toBe("1");
      expect(host.querySelector("iframe")).toBeNull();
    } finally {
      window.matchMedia = origMatchMedia;
      vi.useRealTimers();
    }
  });

  it("updates the Root card frame in 0ms when splitting/swapping clips on index.html and persists the trimmed window across sub-comp switches", () => {
    setCachedCloudDisklessMode(true);
    setClientCompositionCaptureCapabilityForTest(true);
    seedClientCompositionSpriteForTest(
      {
        projectId: "demo",
        previewUrl: "/api/projects/demo/preview/comp/compositions/catalog-scene.html",
        contentRevision: 0,
        frameCount: 8,
      },
      new Blob(["catalog-sprite"], { type: "image/jpeg" }),
      { frameCount: 8, cols: 8, rows: 1, width: 160, height: 90, aspect: 16 / 9 },
    );

    // 1. Full unsplit clip on index.html -> both Root and catalog-scene show default middle frame 4.
    usePlayerStore.setState({
      elements: [
        {
          id: "root",
          tag: "div",
          start: 0,
          duration: 42.967,
          playbackStart: 0,
          track: 0,
          compositionSrc: "compositions/catalog-scene.html",
        },
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      projectId: "demo",
      compositions: ["index.html", "compositions/catalog-scene.html"],
      masterCompositionPath: "index.html",
      onSelect: vi.fn(),
    };
    const frameOf = (idx: number) =>
      host
        .querySelectorAll<HTMLElement>('[draggable="true"]')
        [idx]?.querySelector("[data-sprite-frame]")
        ?.getAttribute("data-sprite-frame");
    try {
      act(() => {
        root.render(<CompositionsTab {...props} activeComposition="index.html" />);
      });
      expect(frameOf(0)).toBe("4");
      expect(frameOf(1)).toBe("4");

      // 2. Split & swap: second half (playbackStart=9.267, dur=33.7) moved to start=0.13!
      act(() => {
        usePlayerStore.setState({
          elements: [
            {
              id: "root",
              tag: "div",
              start: 33.83,
              duration: 9.267,
              playbackStart: 0,
              track: 0,
              compositionSrc: "compositions/catalog-scene.html",
            },
            {
              id: "root-split",
              tag: "div",
              start: 0.13,
              duration: 33.7,
              playbackStart: 9.267,
              track: 0,
              compositionSrc: "compositions/catalog-scene.html",
            },
          ],
        });
      });
      // Root card immediately updates to frame 2 (swapped opening window), while catalog-scene stays at 4.
      expect(frameOf(0)).toBe("2");
      expect(frameOf(1)).toBe("4");

      // 3. Switching into catalog-scene.html preserves Root card's trimmed frame 2.
      act(() => {
        usePlayerStore.setState({
          elements: [{ id: "inner", tag: "section", start: 0, duration: 42.967, track: 0 }],
        });
        root.render(<CompositionsTab {...props} activeComposition="compositions/catalog-scene.html" />);
      });
      expect(frameOf(0)).toBe("2");
      expect(frameOf(1)).toBe("4");

      // 4. Shared render context detector flags data-composition-variables edits without busting body-only edits.
      const baseHtml =
        '<html data-composition-variables=\'[{"id":"title","default":"Old"}]\'><head><title>T</title></head><body><div data-start="0"></div></body></html>';
      const bodyEditHtml = baseHtml.replace('data-start="0"', 'data-start="5"');
      const varEditHtml = baseHtml.replace('"Old"', '"New"');
      expect(hasIndexSharedRenderContextChanged(baseHtml, bodyEditHtml)).toBe(false);
      expect(hasIndexSharedRenderContextChanged(baseHtml, varEditHtml)).toBe(true);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("debounces post-edit refresh on a sub-composition card, keeps the prior cover without flashing, and captures 4 frames at interaction priority", async () => {
    vi.useFakeTimers();
    setCachedCloudDisklessMode(true);
    setClientCompositionCaptureCapabilityForTest(true);
    setCachedProjectRevision("demo", "proj-rev-1", {
      "compositions/headline.html": '"sha256:v1"|shared:head1:assets1',
    });
    const previewUrl = "/api/projects/demo/preview/comp/compositions/headline.html";
    seedClientCompositionSpriteForTest(
      { projectId: "demo", previewUrl, contentRevision: 0, frameCount: 8 },
      new Blob(["old-sprite"], { type: "image/jpeg" }),
      { frameCount: 8, cols: 8, rows: 1, width: 160, height: 90, aspect: 16 / 9 },
    );

    const acquireSpy = vi.spyOn(thumbnailScheduler, "acquire");
    // Answer remote filmstrip probe immediately with 204 miss so post-edit SnapDOM capture schedules.
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;

    try {
      const host = mountCompositionsTab({
        compositions: ["compositions/headline.html"],
        activeComposition: "compositions/headline.html",
      });
      expect(host.querySelector("[data-sprite-frame]")?.getAttribute("data-sprite-frame")).toBe("4");
      expect(acquireSpy).not.toHaveBeenCalled();

      // Simulate rapid edits to compositions/headline.html.
      act(() => {
        updateCachedCompositionRevisions("demo", { "compositions/headline.html": '"patch:edit-1"' });
      });
      act(() => vi.advanceTimersByTime(100));
      act(() => {
        updateCachedCompositionRevisions("demo", { "compositions/headline.html": '"patch:edit-2"' });
      });
      // Still debouncing: old sprite stays visible with 0 placeholder flash and 0 scheduler capture calls.
      expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeNull();
      expect(host.querySelector("[data-sprite-frame]")?.getAttribute("data-sprite-frame")).toBe("4");
      expect(acquireSpy).not.toHaveBeenCalled();

      // Advance past the 250ms debounce and flush the 204 miss promise.
      await act(async () => {
        vi.advanceTimersByTime(260);
        await Promise.resolve();
        await Promise.resolve();
      });

      const captureCall = acquireSpy.mock.calls.find(([req]) =>
        req.key.includes("kind=client-comp-capture"),
      );
      expect(captureCall).toBeDefined();
      expect(captureCall?.[0].key).toContain("frames=4");
      expect(captureCall?.[0].priority).toBe("interaction");
      expect(host.querySelector('[data-testid="composition-cover-placeholder"]')).toBeNull();
    } finally {
      acquireSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
