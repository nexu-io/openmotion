// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindPreviewLease } from "../lib/previewLease";
import { PREVIEW_BRIDGE_SOURCE, PREVIEW_BRIDGE_VERSION } from "../lib/previewAdapter";
import { usePlayerStore } from "../store/playerStore";
import { IsolatedPlayer } from "./IsolatedPlayer";

vi.mock("../lib/previewLease", () => ({ bindPreviewLease: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  usePlayerStore.getState().reset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mountPlayer({ suppressLoadingOverlay = false, trackAssets = false, deferGrant = false } = {}) {
  const origin = "https://preview.test";
  let grant = 0;
  let open!: () => void;
  const retry = vi.fn<() => Promise<void>>();
  vi.mocked(bindPreviewLease).mockImplementation((source, _, navigate) => {
    open = () => navigate(new URL(source.pathname + "?pt=grant-" + ++grant, origin));
    if (!deferGrant) open();
    retry.mockImplementation(async () => open());
    return { retry, dispose: vi.fn() };
  });
  const host = document.createElement("main");
  const root = createRoot(host);
  const ready = vi.fn();
  const error = vi.fn();
  const painted = vi.fn();
  const readyToShow = vi.fn();
  const compositionLoading = vi.fn();
  const render = (parked = false) => act(() => root.render(
    <IsolatedPlayer parked={parked} projectId="p" origin={origin} onLoad={ready} onPreviewError={error}
      onPainted={painted} onReadyToShowChange={readyToShow} onCompositionLoadingChange={compositionLoading}
      showInitialLoading suppressLoadingOverlay={suppressLoadingOverlay} trackAssets={trackAssets} />,
  ));
  render();
  const frame = host.querySelector("iframe")!;
  Object.defineProperty(frame, "contentWindow", { value: window });
  const notify = (type: string, details: Record<string, unknown> = {}) => act(() => {
    window.dispatchEvent(new MessageEvent("message", { origin, source: frame.contentWindow,
      data: { source: PREVIEW_BRIDGE_SOURCE, version: PREVIEW_BRIDGE_VERSION, projectId: "p", token: "grant-" + grant,
        type, duration: 5, retryAfterMs: 1000, ...details } }));
  });
  const status = () => host.querySelector('[role="status"]');
  const backdrop = () => host.querySelector('[data-testid="composition-loading-backdrop"]');
  return { retry, ready, error, painted, readyToShow, compositionLoading, notify, host, frame, render,
    status, backdrop, grant: () => act(open), unmount: () => act(() => root.unmount()) };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("covers a newly navigated frame even when the loading mark is suppressed", () => {
  const player = mountPlayer({ suppressLoadingOverlay: true });
  try {
    const cover = player.host.querySelector('[data-testid="composition-loading-overlay"]');
    expect(cover).not.toBeNull();
    expect(cover!.querySelector(".motion-preview-loading-mark")).toBeNull();
    player.notify("timeline-state", { firstFrame: "loading" });
    expect(player.host.contains(cover)).toBe(true);
    player.notify("timeline-state", { firstFrame: "ready" });
    advance(40);
    expect(player.host.contains(cover)).toBe(false);
  } finally { player.unmount(); }
});

it("reattaches the same painted document without renewing or letting parked events update Studio", () => {
  const player = mountPlayer();
  try {
    player.notify("timeline-state", { token: "grant-1", firstFrame: "ready" });
    advance(30);
    const frame = player.host.querySelector("iframe")!;
    expect(frame.dataset.clipPainted).toBe("true");
    const binds = vi.mocked(bindPreviewLease).mock.calls.length;
    const send = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    player.render(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: "pause" }), "https://preview.test");
    player.notify("timeline-state", { token: "grant-1", firstFrame: "loading" });
    player.notify("preview-build-busy");
    advance(5000);
    expect(player.ready).toHaveBeenCalledTimes(1);
    player.render(false);
    expect(player.host.querySelector("iframe")).toBe(frame);
    expect(bindPreviewLease).toHaveBeenCalledTimes(binds);
    expect(player.ready).toHaveBeenCalledTimes(2);
    expect(player.host.querySelector('[data-testid="composition-loading-overlay"]')).toBeNull();
  } finally { player.unmount(); }
});

it("retries only authenticated busy documents and stops retrying when ready", () => {
  const player = mountPlayer();
  try {
    player.notify("preview-build-busy", { token: "wrong-grant" });
    advance(2000);
    expect(player.retry).not.toHaveBeenCalled();
    player.notify("preview-build-busy");
    player.notify("preview-build-busy");
    advance(1499);
    expect(player.retry).not.toHaveBeenCalled();
    advance(1);
    expect(player.retry).toHaveBeenCalledTimes(1);
    player.notify("preview-build-busy", { token: "grant-1" });
    player.notify("timeline-state", { firstFrame: "ready" });
    player.notify("preview-build-busy");
    advance(20_000);
    expect(player.ready).toHaveBeenCalledTimes(1);
    expect(player.error).not.toHaveBeenCalled();
    expect(player.retry).toHaveBeenCalledTimes(1);
  } finally { player.unmount(); }
});

it("caps repeated overload, gives manual retry a fresh budget and cancels on unmount", () => {
  const player = mountPlayer();
  try {
    for (const delay of [1500, 3000, 6000]) {
      player.notify("preview-build-busy");
      advance(delay);
    }
    expect(player.retry).toHaveBeenCalledTimes(3);
    player.notify("preview-build-busy");
    advance(20_000);
    expect(player.error).toHaveBeenCalledOnce();
    act(() => player.host.querySelector("button")!.click());
    player.notify("preview-build-busy");
    advance(1500);
    expect(player.retry).toHaveBeenCalledTimes(5);
    player.notify("preview-build-busy");
  } finally { player.unmount(); }
  advance(20_000);
  expect(player.retry).toHaveBeenCalledTimes(5);
});


it("keeps the no-duration deadline after the status expires and gives a manual retry a fresh cover", () => {
  const player = mountPlayer({ trackAssets: true });
  const loading = () => player.host.querySelector('[data-testid="composition-loading-overlay"]');
  try {
    expect(loading()?.textContent).toContain("Preparing the first preview frame");
    player.notify("timeline-state", { firstFrame: "ready", duration: 0 });
    advance(3_000);
    expect(player.status()).toBeNull();
    expect(player.backdrop()).not.toBeNull();
    expect(player.ready).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().previewBooted).toBe(false);
    advance(12_000);
    expect(loading()).toBeNull();
    expect(player.backdrop()).toBeNull();
    expect(player.error).toHaveBeenCalledOnce();
    expect(player.host.textContent).toContain("Retry preview");
    act(() => player.host.querySelector("button")!.click());
    advance(2_999);
    expect(player.status()).not.toBeNull();
    player.notify("timeline-state", { firstFrame: "ready" });
    advance(40);
    expect(loading()).toBeNull();
  } finally { player.unmount(); }
});

it("publishes timeline metadata while waiting for a decodable visible frame", () => {
  const player = mountPlayer();
  const loading = () => player.host.querySelector('[data-testid="composition-loading-overlay"]');
  try {
    player.notify("timeline-state", { firstFrame: "loading" });
    advance(70);
    expect(player.ready).toHaveBeenCalledOnce();
    expect(loading()).not.toBeNull();
    player.notify("timeline-state", { firstFrame: "ready" });
    advance(40);
    expect(player.ready).toHaveBeenCalledOnce();
    expect(loading()).toBeNull();
  } finally { player.unmount(); }
});

it("offers retry on first-frame media errors before and after editing unlocks, ignoring old grants", () => {
  const player = mountPlayer({ trackAssets: true });
  try {
    player.notify("timeline-state", { firstFrame: "error" });
    expect(player.error).toHaveBeenCalledOnce();
    player.notify("timeline-state", { firstFrame: "ready" });
    expect(player.host.textContent).toContain("Retry preview");
    act(() => player.host.querySelector("button")!.click());
    player.notify("timeline-state", { token: "grant-1", firstFrame: "ready" });
    player.notify("timeline-state", { firstFrame: "loading" });
    advance(3_001);
    expect(player.backdrop()).not.toBeNull();
    player.notify("timeline-state", { firstFrame: "error" });
    expect(player.error).toHaveBeenCalledTimes(2);
    expect(player.host.textContent).toContain("Retry preview");
    expect(player.painted).not.toHaveBeenCalled();
    expect(player.readyToShow).not.toHaveBeenCalledWith(true);
  } finally { player.unmount(); }
});

it("retains the first-frame timeout for an untracked preview without an editor grace", () => {
  const player = mountPlayer();
  try {
    player.notify("timeline-state", { firstFrame: "loading" });
    advance(90_001);
    expect(player.error).toHaveBeenCalledOnce();
    expect(player.host.textContent).toContain("Retry preview");
  } finally { player.unmount(); }
});

it("tracks bridge asset-readiness updates when trackAssets is enabled", () => {
  const origin = "https://preview.test";
  let grant = 0;
  vi.mocked(bindPreviewLease).mockImplementation((source, _, navigate) => {
    navigate(new URL(source.pathname + "?pt=grant-" + ++grant, origin));
    return { retry: vi.fn(async () => {}), dispose: vi.fn() };
  });
  const host = document.createElement("main");
  const root = createRoot(host);
  act(() =>
    root.render(
      <IsolatedPlayer
        projectId="p"
        origin={origin}
        onLoad={vi.fn()}
        showInitialLoading
        trackAssets
        canEditWhileLoading
      />,
    ),
  );
  const frame = host.querySelector("iframe")!;
  Object.defineProperty(frame, "contentWindow", { value: window });
  try {
    expect(usePlayerStore.getState().assetReadinessPhase).toBe("loading");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin, source: frame.contentWindow,
        data: { source: PREVIEW_BRIDGE_SOURCE, version: PREVIEW_BRIDGE_VERSION, projectId: "p", token: "grant-" + grant,
          type: "asset-readiness", status: "loading", completed: 0, total: 0, failed: [], pendingAsset: "Opening shot.jpg" },
      }));
    });
    expect(usePlayerStore.getState().assetReadinessPendingAsset).toBe("Opening shot.jpg");
    expect(frame.dataset.clipPainted).toBeUndefined();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source: frame.contentWindow,
          data: {
            source: PREVIEW_BRIDGE_SOURCE,
            version: PREVIEW_BRIDGE_VERSION,
            projectId: "p",
            token: "grant-" + grant,
            type: "asset-readiness",
            status: "loading",
            completed: 3,
            total: 10,
            failed: [],
            pendingAsset: "intro.mp4",
          },
        }),
      );
    });
    expect(usePlayerStore.getState().assetReadinessPhase).toBe("loading");
    expect(usePlayerStore.getState().assetReadinessCompleted).toBe(3);
    expect(usePlayerStore.getState().assetReadinessTotal).toBe(10);
    expect(host.querySelector('[data-testid="composition-loading-overlay"]')?.textContent)
      .toContain("intro.mp4Downloading this file for playback. You can keep editing.");

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source: frame.contentWindow,
          data: {
            source: PREVIEW_BRIDGE_SOURCE,
            version: PREVIEW_BRIDGE_VERSION,
            projectId: "p",
            token: "grant-" + grant,
            type: "asset-readiness",
            status: "ready",
            completed: 10,
            total: 10,
            failed: [{ id: "img-1", label: "hero.png", kind: "image", reason: "error" }],
          },
        }),
      );
    });
    expect(usePlayerStore.getState().assetReadinessPhase).toBe("ready");
    expect(host.textContent).not.toContain("intro.mp4");
    expect(usePlayerStore.getState().assetReadinessCompleted).toBe(10);
    expect(usePlayerStore.getState().assetReadinessFailed).toEqual([
      { id: "img-1", label: "hero.png", kind: "image", reason: "error" },
    ]);
  } finally {
    act(() => root.unmount());
  }
});

it("resets the iframe document to about:blank on unmount to release cross-origin resources", () => {
  const player = mountPlayer();
  const frame = player.host.querySelector("iframe")!;
  expect(frame.src).toContain("https://preview.test/");
  player.unmount();
  expect(frame.src).toBe("about:blank");
});

it("keeps an inert shadow preview out of focus order and clears inert on promotion without remounting", () => {
  const origin = "https://preview.test";
  vi.mocked(bindPreviewLease).mockImplementation((source, _, navigate) => {
    navigate(new URL(source.pathname + "?pt=shadow-1", origin));
    return { retry: vi.fn(), dispose: vi.fn() };
  });
  const host = document.createElement("main");
  const root = createRoot(host);
  const onLoad = vi.fn();
  try {
    act(() =>
      root.render(
        <IsolatedPlayer
          projectId="p"
          origin={origin}
          onLoad={onLoad}
          inert
        />,
      ),
    );
    const container = host.firstElementChild as HTMLElement;
    const frameBefore = host.querySelector("iframe")!;
    expect(container.hasAttribute("inert")).toBe(true);
    expect(frameBefore.tabIndex).toBe(-1);

    // Promoting the shadow clears `inert` in place without remounting the iframe.
    act(() =>
      root.render(
        <IsolatedPlayer
          projectId="p"
          origin={origin}
          onLoad={onLoad}
        />,
      ),
    );
    const frameAfter = host.querySelector("iframe")!;
    expect(frameAfter).toBe(frameBefore);
    expect(container.hasAttribute("inert")).toBe(false);
    expect(frameAfter.getAttribute("tabindex")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it("expires the status while the initial grant is pending without restarting it on navigation", () => {
  const player = mountPlayer({ trackAssets: true, deferGrant: true });
  try {
    advance(2_999);
    expect(player.status()).not.toBeNull();
    advance(1);
    expect(player.status()).toBeNull();
    expect(player.backdrop()).not.toBeNull();
    player.grant();
    expect(player.frame.src).toContain("grant-1");
    expect(player.status()).toBeNull();
    expect(player.backdrop()).not.toBeNull();
    expect(player.painted).not.toHaveBeenCalled();
    expect(player.readyToShow).not.toHaveBeenCalledWith(true);
    expect(usePlayerStore.getState().previewBooted).toBe(false);
  } finally { player.unmount(); }
});

it("counts from mount, not duration, and keeps buffering and paint independent of the status", () => {
  const player = mountPlayer({ trackAssets: true });
  try {
    advance(2_500);
    player.notify("timeline-state", { firstFrame: "loading", buffering: true });
    expect(player.ready).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().mediaBuffering).toBe(true);
    advance(500);
    expect(player.status()).toBeNull();
    expect(player.backdrop()).not.toBeNull();
    // Keep waiting through the old duration-based soft-unlock point and reject missing/stale signals.
    advance(3_000);
    player.notify("asset-readiness", { status: "loading", completed: 1, total: 2, pendingAsset: "outro.mp4" });
    expect(usePlayerStore.getState().assetReadinessPendingAsset).toBe("outro.mp4");
    expect(player.status()).toBeNull();
    player.notify("timeline-state");
    player.notify("timeline-state", { token: "wrong-grant", firstFrame: "ready" });
    advance(40);
    expect(player.compositionLoading).toHaveBeenCalledWith(false);
    expect(player.frame.dataset.clipPainted).toBeUndefined();
    player.notify("timeline-state", { firstFrame: "ready", buffering: false });
    expect(usePlayerStore.getState().mediaBuffering).toBe(false);
    expect(player.painted).not.toHaveBeenCalled();
    expect(player.readyToShow).not.toHaveBeenCalledWith(true);
    expect(usePlayerStore.getState().previewBooted).toBe(true);
    advance(40);
    expect(player.backdrop()).toBeNull();
    expect(player.frame.dataset.clipPainted).toBe("true");
    expect(player.painted).toHaveBeenCalledOnce();
    expect(player.readyToShow).toHaveBeenLastCalledWith(true);
    expect(player.compositionLoading).toHaveBeenLastCalledWith(false);
    expect(usePlayerStore.getState().previewBooted).toBe(true);
    expect(usePlayerStore.getState().assetReadinessPhase).toBe("loading");
    player.notify("asset-readiness", { status: "ready", completed: 2, total: 2 });
    expect(usePlayerStore.getState().assetReadinessPhase).toBe("ready");
    expect(player.error).not.toHaveBeenCalled();
  } finally { player.unmount(); }
});

it("accepts a late first frame after editing unlocks and a hidden preview stops sending heartbeats", () => {
  const player = mountPlayer({ trackAssets: true });
  try {
    player.notify("timeline-state", { firstFrame: "loading" });
    advance(3_001);
    expect(usePlayerStore.getState().previewBooted).toBe(true);
    expect(player.compositionLoading).toHaveBeenLastCalledWith(false);
    player.notify("timeline-state", { firstFrame: "loading" });
    // The bridge stops posting timeline-state while its document is hidden.
    advance(120_000);
    expect(player.error).not.toHaveBeenCalled();
    expect(player.backdrop()).not.toBeNull();
    expect(player.readyToShow).not.toHaveBeenCalledWith(true);
    expect(player.painted).not.toHaveBeenCalled();
    player.notify("timeline-state", { firstFrame: "ready" });
    advance(40);
    expect(player.readyToShow).toHaveBeenCalledWith(true);
    expect(player.painted).toHaveBeenCalledOnce();
    expect(player.backdrop()).toBeNull();
  } finally { player.unmount(); }
});

it("unlocks immediately on an explicit Skip without reporting a painted frame", () => {
  const player = mountPlayer({ trackAssets: true });
  try {
    player.notify("timeline-state", { firstFrame: "loading" });
    expect(player.status()).not.toBeNull();
    expect(usePlayerStore.getState().previewBooted).toBe(false);
    act(() => usePlayerStore.getState().skipAssetReadiness());
    expect(player.compositionLoading).toHaveBeenLastCalledWith(false);
    expect(player.status()).toBeNull();
    expect(player.backdrop()).toBeNull();
    expect(player.painted).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().previewBooted).toBe(true);
  } finally { player.unmount(); }
});
