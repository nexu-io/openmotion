// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { createBridgePlaybackAdapter } from "./playbackAdapter";
import type { PreviewAdapter } from "./previewAdapter";

describe("createBridgePlaybackAdapter", () => {
  it("forwards transport commands and tracks bridge timeline state", () => {
    const send = vi.fn();
    const preview = {
      accepts: () => true,
      send,
    } as unknown as PreviewAdapter;
    const adapter = createBridgePlaybackAdapter(preview);

    adapter.play();
    adapter.seek(2.5, { keepPlaying: true });
    adapter.pause();
    expect(send.mock.calls.map(([type, payload]) => [type, payload])).toEqual([
      ["playback-control", { action: "play" }],
      ["playback-control", { action: "seek", time: 2.5 }],
      ["playback-control", { action: "pause" }],
    ]);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "timeline-state", currentTime: 4, duration: 12, isPlaying: true },
      }),
    );
    expect(adapter.getTime()).toBe(4);
    expect(adapter.getDuration()).toBe(12);
    expect(adapter.isPlaying()).toBe(true);

    adapter.dispose();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "timeline-state", currentTime: 8, duration: 12, isPlaying: false },
      }),
    );
    expect(adapter.getTime()).toBe(4);
  });
});
