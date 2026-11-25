// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupMounted, mountHost, trackedRoot } from "../../components/ui/mountHost.testHelpers";
import {
  clearClientCompositionCaptureCacheForTest,
  seedClientCompositionCaptureForTest,
  seedClientCompositionSpriteForTest,
  setCachedProjectRevision,
} from "../lib/clientCompositionCapture";
import { thumbnailScheduler } from "../lib/thumbnailScheduler";
import { usePlayerStore } from "../store/playerStore";
import { PreviewCompositionLoading } from "./PreviewCompositionLoading";

import { CachedCompositionPoster } from "./CachedCompositionPoster";

const poster = (projectId: string, compositionPath = "index.html") => <CachedCompositionPoster projectId={projectId} compositionPath={compositionPath} />;
const filename = "夜の街 — opening shot.mp4";
const title = "Preparing preview assets";
const firstFrameTitle = "Preparing the first preview frame";
const genericHint = "The preview will appear when it is ready.";
const editingHint = "You can keep editing while the preview loads.";
const downloadHint = "Downloading this file for playback.";

afterEach(() => {
  cleanupMounted();
  clearClientCompositionCaptureCacheForTest();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("updates the same live status when the player starts a generation after mount", () => {
  const generation = { current: 0 };
  const host = mountHost(<PreviewCompositionLoading assetGeneration={generation} />);
  const status = host.querySelector('[role="status"]')!;
  const label = document.getElementById(status.getAttribute("aria-labelledby")!)!;
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(label.textContent).toBe(firstFrameTitle);
  expect(label.nextElementSibling?.textContent).toBe(genericHint);
  expect(label.closest(".sr-only")).toBeNull();

  act(() => {
    generation.current = usePlayerStore.getState().beginAssetReadinessLoad();
    usePlayerStore.getState().updateAssetReadiness({
      status: "loading", total: 2, completed: 1, failed: [], pendingAsset: filename,
    }, generation.current);
  });
  expect(label.textContent).toBe(title);
  expect(label.nextElementSibling?.textContent).toBe(filename);
  expect(label.nextElementSibling?.closest(".sr-only")).toBeNull();

  act(() => usePlayerStore.getState().skipAssetReadiness());
  expect(status.textContent).toBe(`${firstFrameTitle}${genericHint}`);
  expect(label.nextElementSibling?.textContent).toBe(genericHint);
});

it.each([
  { current: undefined, phase: "loading", name: filename },
  { current: 2, phase: "loading", name: filename },
  { current: 1, phase: "ready", name: filename },
  { current: 1, phase: "loading", name: "   " },
] as const)("uses the generic status for $current, $phase, '$name'", ({ current, phase, name }) => {
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPhase: phase, assetReadinessPendingAsset: name });
  const host = mountHost(<PreviewCompositionLoading canEditWhileLoading assetGeneration={current === undefined ? undefined : { current }} />);
  expect(host.textContent).toBe(`${firstFrameTitle}${editingHint}`);
  expect(host.querySelector('[dir="auto"]')).toBeNull();
});

it("keeps the status and download hint screen-reader-only during a quiet switch", () => {
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPendingAsset: filename });
  const host = mountHost(<PreviewCompositionLoading showMark={false} assetGeneration={{ current: 1 }} />);
  const status = host.querySelector('[role="status"]')!;
  expect(status.querySelector(".motion-preview-loading-mark")).toBeNull();
  expect(status.querySelector(".sr-only")?.textContent).toBe(`${title}${filename}${downloadHint}`);
});

it.each([true, false])("uses Studio theme tokens for the entire cover with showMark=%s", showMark => {
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPendingAsset: filename });
  const host = mountHost(<PreviewCompositionLoading showMark={showMark} assetGeneration={{ current: 1 }} />);
  const status = host.querySelector('[role="status"]')!;
  expect(status.classList.contains("inset-0")).toBe(true);
  expect(status.classList.contains("bg-[var(--motion-canvas)]")).toBe(true);
  expect(status.classList.contains("text-[color:var(--motion-strong)]")).toBe(true);
  const file = status.querySelector('[dir="auto"]')!;
  expect(file.classList.contains("text-[color:var(--motion-text)]")).toBe(true);
  expect(file.nextElementSibling?.classList.contains("text-[color:var(--motion-muted)]")).toBe(true);
});

it.each([true, false, undefined])("describes the download when edit eligibility is %s", canEditWhileLoading => {
  const longName = "很长的文件名".repeat(50) + ".mp4";
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPendingAsset: longName });
  const host = mountHost(<PreviewCompositionLoading canEditWhileLoading={canEditWhileLoading} assetGeneration={{ current: 1 }} />);
  const file = host.querySelector('[dir="auto"]')!;
  expect(file.textContent).toBe(longName);
  expect(file.getAttribute("title")).toBe(longName);
  expect(file.classList.contains("truncate")).toBe(true);
  expect(file.nextElementSibling?.textContent).toBe(canEditWhileLoading ? `${downloadHint} You can keep editing.` : downloadHint);
});

describe("after three seconds on the stage", () => {
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const backdrop = '[data-testid="composition-loading-backdrop"]';
  const clip = "compositions/夜の街 opening.html";
  const seedCover = (projectId: string, path = "index.html", contentRevision = 0) => {
    const value = seedClientCompositionCaptureForTest({
      projectId, previewUrl: `/api/projects/${projectId}/preview/comp/${path.split("/").map(encodeURIComponent).join("/")}`,
      contentRevision, frameCount: 1,
    }, [new Blob(["cover"], { type: "image/jpeg" })]);
    if (value.kind !== "image") throw new Error("Expected a single captured cover");
    return value.url;
  };
  const setup = () => {
    const host = document.createElement("div");
    const root = trackedRoot(host);
    const render = (props: ComponentProps<typeof PreviewCompositionLoading>) => act(() => root.render(<PreviewCompositionLoading {...props} />));
    return { host, render };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/cover-${++sequence}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it.each([true, false])("replaces the status on its original deadline, including quiet switches (showMark=%s)", showMark => {
    const { host, render } = setup();
    const generation = { current: 1 };
    render({ showMark, assetGeneration: generation });
    advance(2_500);
    act(() => usePlayerStore.setState({ duration: 10, assetReadinessGeneration: 1, assetReadinessPendingAsset: filename }));
    render({ showMark, assetGeneration: generation, canEditWhileLoading: true });
    advance(499);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(filename);
    advance(1);
    const canvas = host.querySelector(backdrop)!;
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.classList.contains("bg-[var(--motion-canvas)]")).toBe(true);
    expect(canvas.classList.contains("pointer-events-none")).toBe(true);
    expect(host.querySelector('[role="status"], [aria-live], .motion-preview-loading-mark')).toBeNull();
    expect(host.textContent).toBe("");
    act(() => usePlayerStore.setState({ duration: 20, assetReadinessPendingAsset: "late.mp4" }));
    render({ showMark: !showMark, assetGeneration: generation });
    expect(host.querySelector(backdrop)).toBe(canvas);
    expect(host.textContent).toBe("");
  });

  it("cancels the deadline when the player removes the cover early", () => {
    mountHost(<PreviewCompositionLoading />);
    expect(vi.getTimerCount()).toBe(1);
    cleanupMounted();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("borrows the root cover already in memory at the deadline and releases its URL on unmount", () => {
    const host = mountHost(<PreviewCompositionLoading showMark={false} loadingPoster={poster("p")} />);
    advance(2_900);
    const url = seedCover("p");
    expect(host.querySelector("img")).toBeNull();
    advance(100);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(url);
    seedCover("p", "index.html", 1); // Supersede the cache entry while the backdrop holds it.
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
    cleanupMounted();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("never carries a cover to another project, clip or file version", () => {
    const { host, render } = setup();
    setCachedProjectRevision("a", "v1", { [clip]: "file-1" });
    const url = seedCover("a", clip);
    render({ loadingPoster: poster("a", clip) });
    advance(3_000);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(url);
    render({ loadingPoster: poster("b", clip) });
    expect(host.querySelector("img")).toBeNull();
    render({ loadingPoster: poster("a", "other.html") });
    expect(host.querySelector("img")).toBeNull();
    render({ loadingPoster: poster("a", clip) });
    expect(host.querySelector("img")?.getAttribute("src")).toBe(url);
    act(() => setCachedProjectRevision("a", "v2", { [clip]: "file-2" }));
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(backdrop)).not.toBeNull();
  });

  it("uses the current clip's thumbnail revision when it has no persisted file version", () => {
    const path = "parts/scene.html";
    usePlayerStore.getState().bumpThumbnailRevisions([path]);
    const url = seedCover("p", path, 1);
    const host = mountHost(<PreviewCompositionLoading loadingPoster={poster("p", path)} />);
    advance(3_000);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(url);
    act(() => usePlayerStore.getState().bumpThumbnailRevisions([path]));
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(backdrop)).not.toBeNull();
  });

  it("falls back silently on image error or a cache miss without requesting another thumbnail", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const acquire = vi.spyOn(thumbnailScheduler, "acquire");
    const url = seedCover("p");
    const host = mountHost(<PreviewCompositionLoading loadingPoster={poster("p")} />);
    advance(3_000);
    const img = host.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(url);
    act(() => { img.dispatchEvent(new Event("error")); });
    expect(host.querySelector("img")).toBeNull();
    act(() => usePlayerStore.getState().bumpThumbnailRevisions(null));
    expect(host.querySelector("img, [role=status], [role=alert]")).toBeNull();
    expect(host.querySelector(backdrop)).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("renders a zero-slice sprite cover via SpriteFrame at the middle frame", () => {
    const spriteVal = seedClientCompositionSpriteForTest(
      {
        projectId: "p-sprite",
        previewUrl: "/api/projects/p-sprite/preview/comp/index.html",
        contentRevision: 0,
        frameCount: 8,
      },
      new Blob(["sprite"], { type: "image/jpeg" }),
      { frameCount: 8, cols: 8, rows: 1, width: 160, height: 90, aspect: 16 / 9 },
    );
    expect(spriteVal.kind).toBe("sprite");
    const host = mountHost(<PreviewCompositionLoading showMark={false} loadingPoster={poster("p-sprite")} />);
    advance(3_000);
    const spriteEl = host.querySelector<HTMLElement>("[data-sprite-frame]");
    expect(spriteEl).not.toBeNull();
    expect(spriteEl?.getAttribute("data-sprite-frame")).toBe("4");
    expect(host.querySelector("img")).toBeNull();
  });
});
