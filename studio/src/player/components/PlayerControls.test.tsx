// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveTime, usePlayerStore } from "../store/playerStore";
import { registerRetryFailedAssetsHandler } from "../store/readinessSlice";
import { PlayerControls } from "./PlayerControls";
import { StudioHostContext } from "../../motion/StudioHost";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('../../utils/studioTelemetry', () => ({ trackStudioEvent: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
const onSeek = vi.fn();

function seekBar(): HTMLInputElement {
  const input = host.querySelector('input[aria-label="Seek preview"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("Preview seek bar is missing");
  return input;
}

beforeEach(async () => {
  onSeek.mockClear();
  usePlayerStore.setState({
    isPlaying: true,
    currentTime: 2,
    duration: 30,
    timeDisplayMode: "time",
    timelineReady: true,
    assetReadinessPhase: "ready",
    assetReadinessFailed: [],
    assetReadinessRetrying: false,
    mediaBuffering: false,
    previewLoadError: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(React.createElement(PlayerControls, { onTogglePlay: () => {}, onSeek })),
  );
});

describe("PlayerControls preview seeking", () => {
  it("exposes real fullscreen in the MVP alongside playback controls", async () => {
    const fullscreen = vi.fn();
    await act(async () => root.render(<StudioHostContext.Provider value={{ mvpEditor: true }}>
      <PlayerControls onTogglePlay={() => {}} onSeek={onSeek} onToggleFullscreen={fullscreen} />
    </StudioHostContext.Provider>));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Enter fullscreen"]')!.click());
    expect(fullscreen).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-studio-control="playback"]')).not.toBeNull();
    expect(seekBar().disabled).toBe(false);
  });
  it("shows the current position and follows the playback clock", () => {
    const input = seekBar();
    expect(input.type).toBe("range");
    expect(input.valueAsNumber).toBe(2);
    expect(input.max).toBe("30");
    expect(input.disabled).toBe(false);

    liveTime.notify(12.5);
    expect(input.valueAsNumber).toBe(12.5);
    expect(input.getAttribute("aria-valuetext")).toBe("00:12 of 00:30");
  });

  it("seeks continuously and reaches both ends of the preview", () => {
    const input = seekBar();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("Native range value setter is missing");
    for (const time of [8.25, 15.5, 30, 0]) {
      act(() => {
        setValue.call(input, String(time));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(onSeek).toHaveBeenLastCalledWith(time);
    }
    expect(onSeek).toHaveBeenCalledTimes(4);
  });

  it("updates its duration and resets its position for a new composition", async () => {
    await act(async () => usePlayerStore.setState({ duration: 5, currentTime: 0 }));
    expect(seekBar().max).toBe("5");
    expect(seekBar().valueAsNumber).toBe(0);
    expect(seekBar().getAttribute("aria-valuetext")).toBe("00:00 of 00:05");
  });

  it("disables seeking until the preview is ready or has a duration", async () => {
    await act(async () => usePlayerStore.setState({ timelineReady: false }));
    expect(seekBar().disabled).toBe(true);
    await act(async () => usePlayerStore.setState({ timelineReady: true, duration: 0 }));
    expect(seekBar().disabled).toBe(true);
  });

  it("respects the disabled prop in fullscreen", async () => {
    await act(async () =>
      root.render(
        React.createElement(PlayerControls, {
          onTogglePlay: () => {},
          onSeek,
          disabled: true,
          isFullscreen: true,
        }),
      ),
    );
    expect(seekBar().disabled).toBe(true);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("PlayerControls timecode", () => {
  it("rewrites the timecode only when the shown text changes", async () => {
    const timecode = host.querySelector("button.font-mono > span");
    expect(timecode?.textContent).toBe("00:02");
    const writes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => writes.push(...records));
    observer.observe(timecode as Node, { childList: true, characterData: true, subtree: true });

    for (let frame = 1; frame <= 30; frame++) liveTime.notify(2 + frame / 120);
    await Promise.resolve();
    expect(writes).toHaveLength(0);

    liveTime.notify(3.01);
    await Promise.resolve();
    expect(timecode?.textContent).toBe("00:03");
    expect(writes.length).toBeGreaterThan(0);
    observer.disconnect();
  });
});

describe("PlayerControls buffering and asset-failure recovery", () => {
  it("shows a subtle buffering indicator while playing unbuffered media and clears once ready or paused", async () => {
    expect(host.querySelector('[data-testid="player-buffering-indicator"]')).toBeNull();

    await act(async () => usePlayerStore.setState({ mediaBuffering: true }));
    expect(host.querySelector('[data-testid="player-buffering-indicator"]')?.textContent).toContain("Buffering");

    await act(async () => usePlayerStore.setState({ isPlaying: false }));
    expect(host.querySelector('[data-testid="player-buffering-indicator"]')).toBeNull();

    await act(async () => usePlayerStore.setState({ isPlaying: true, mediaBuffering: false }));
    expect(host.querySelector('[data-testid="player-buffering-indicator"]')).toBeNull();
  });

  it("exposes a persistent retry pill when composition assets fail and triggers in-place retry", async () => {
    const gen = usePlayerStore.getState().beginAssetReadinessLoad();
    const retrySpy = vi.fn(async () => {
      usePlayerStore.getState().updateAssetReadiness(
        { status: "ready", completed: 2, total: 2, failed: [] },
        gen,
      );
      return [];
    });
    registerRetryFailedAssetsHandler(gen, retrySpy);

    await act(async () => {
      usePlayerStore.getState().updateAssetReadiness(
        {
          status: "ready",
          completed: 2,
          total: 2,
          failed: [{ id: "img-0", label: "hero.png", kind: "image", reason: "error" }],
        },
        gen,
      );
    });

    const pill = host.querySelector<HTMLButtonElement>('[data-testid="player-asset-retry-pill"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain("1 asset failed");

    await act(async () => {
      pill!.click();
      await Promise.resolve();
    });
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="player-asset-retry-pill"]')).toBeNull();
    registerRetryFailedAssetsHandler(gen, null);
  });
});
