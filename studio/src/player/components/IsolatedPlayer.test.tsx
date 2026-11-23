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
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mountPlayer(showInitialLoading = true) {
  const origin = "https://preview.test";
  let grant = 0;
  const retry = vi.fn<() => Promise<void>>();
  vi.mocked(bindPreviewLease).mockImplementation((source, _, navigate) => {
    const open = () => navigate(new URL(source.pathname + "?pt=grant-" + ++grant, origin));
    open();
    retry.mockImplementation(async () => open());
    return { retry, dispose: vi.fn() };
  });
  const host = document.createElement("main");
  const root = createRoot(host);
  const ready = vi.fn();
  const error = vi.fn();
  act(() => root.render(<IsolatedPlayer projectId="p" origin={origin} onLoad={ready} onPreviewError={error} showInitialLoading={showInitialLoading} />));
  const frame = host.querySelector("iframe")!;
  Object.defineProperty(frame, "contentWindow", { value: window });
  const notify = (type: string, token = "grant-" + grant, firstFrame?: string) => act(() => {
    window.dispatchEvent(new MessageEvent("message", { origin, source: frame.contentWindow,
      data: { source: PREVIEW_BRIDGE_SOURCE, version: PREVIEW_BRIDGE_VERSION, projectId: "p", token,
        type, firstFrame, duration: 5, retryAfterMs: 1000 } }));
  });
  return { retry, ready, error, notify, host, unmount: () => act(() => root.unmount()) };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("retries only authenticated busy documents and stops retrying when ready", () => {
  const player = mountPlayer();
  try {
    player.notify("preview-build-busy", "wrong-grant");
    advance(2000);
    expect(player.retry).not.toHaveBeenCalled();
    player.notify("preview-build-busy");
    player.notify("preview-build-busy");
    advance(1499);
    expect(player.retry).not.toHaveBeenCalled();
    advance(1);
    expect(player.retry).toHaveBeenCalledTimes(1);
    player.notify("preview-build-busy", "grant-1");
    player.notify("timeline-state");
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


it("keeps loading local through a timeout and manual retry, then uncovers the first valid frame", () => {
  const player = mountPlayer();
  const loading = () => player.host.querySelector('[data-testid="composition-loading-overlay"]');
  try {
    expect(loading()?.textContent).toContain("Loading composition");
    player.notify("timeline-state", "wrong-grant");
    expect(loading()).not.toBeNull();
    advance(15_001);
    expect(loading()).toBeNull();
    expect(player.host.textContent).toContain("Retry preview");
    act(() => player.host.querySelector("button")!.click());
    expect(loading()).not.toBeNull();
    player.notify("timeline-state");
    advance(40);
    expect(loading()).toBeNull();
  } finally { player.unmount(); }
});

it("publishes timeline metadata while waiting for a decodable visible frame", () => {
  const player = mountPlayer();
  const loading = () => player.host.querySelector('[data-testid="composition-loading-overlay"]');
  try {
    player.notify("timeline-state", undefined, "loading");
    advance(70);
    expect(player.ready).toHaveBeenCalledOnce();
    expect(loading()).not.toBeNull();
    player.notify("timeline-state", undefined, "ready");
    advance(40);
    expect(player.ready).toHaveBeenCalledOnce();
    expect(loading()).toBeNull();
  } finally { player.unmount(); }
});

it("offers retry on first-frame media failure or a stalled first frame, ignoring late messages for the old load", () => {
  const player = mountPlayer();
  try {
    player.notify("timeline-state", undefined, "loading");
    advance(90_001);
    expect(player.error).toHaveBeenCalledOnce();
    player.notify("timeline-state", undefined, "ready");
    expect(player.host.textContent).toContain("Retry preview");
    act(() => player.host.querySelector("button")!.click());
    player.notify("timeline-state", "grant-1", "ready");
    expect(player.host.querySelector('[data-testid="composition-loading-overlay"]')).not.toBeNull();
    player.notify("timeline-state", undefined, "error");
    expect(player.error).toHaveBeenCalledTimes(2);
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
        loadingUi="host"
      />,
    ),
  );
  const frame = host.querySelector("iframe")!;
  Object.defineProperty(frame, "contentWindow", { value: window });
  try {
    expect(usePlayerStore.getState().assetReadinessPhase).toBe("loading");
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
          },
        }),
      );
    });
    expect(usePlayerStore.getState().assetReadinessPhase).toBe("loading");
    expect(usePlayerStore.getState().assetReadinessCompleted).toBe(3);
    expect(usePlayerStore.getState().assetReadinessTotal).toBe(10);

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
    expect(usePlayerStore.getState().assetReadinessCompleted).toBe(10);
    expect(usePlayerStore.getState().assetReadinessFailed).toEqual([
      { id: "img-1", label: "hero.png", kind: "image", reason: "error" },
    ]);
  } finally {
    act(() => root.unmount());
  }
});
