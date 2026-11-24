// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePlayerStore } from "../../player/store/playerStore";
import { createPreviewAdapter } from "../../player/lib/previewAdapter";
import { rememberIsolatedManifest } from "../../player/lib/isolatedTimelineManifest";
import { TimelinePane } from "./TimelinePane";

vi.mock("../../player", async () => ({
  Timeline: () => <div data-tracks="" />,
  usePlayerStore: (await import("../../player/store/playerStore")).usePlayerStore,
}));
const playback = {
  compositionLoading: false,
  frame: { current: null as HTMLIFrameElement | null },
  url: "/api/projects/current/preview",
};
vi.mock("./NLEContext", () => ({ useNLEContext: () => ({
  projectId: "current", compositionStack: [{ id: "master", previewUrl: playback.url }], iframeRef: playback.frame, timelineDisabled: playback.compositionLoading, timelineSessionEpoch: 1,
}) }));
vi.mock("../../contexts/TimelineEditContext", () => ({ useTimelineEditContext: () => ({}) }));
vi.mock("../../motion/MotionTimelineMedia", () => ({ MotionTimelineMedia: () => null }));
vi.mock("./AudioMeterStrip", () => ({ AudioMeterStrip: () => null }));

it("keeps the current project's timeline controls and empty drop zone inert until its own timeline is ready", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    const store = usePlayerStore.getState();
    store.beginTimelineSession("previous");
    store.setTimelineReady(true);
    act(() => root.render(<TimelinePane timelineToolbar={<button>Edit</button>} />));
    const pane = host.querySelector("[data-studio-timeline]")!;
    const controls = host.querySelector("button")!;
    expect(host.querySelector("[data-tracks]")).toBeNull();
    expect(pane.getAttribute("aria-busy")).toBe("true");
    expect(controls.closest("[inert]")).not.toBeNull();
    act(() => store.beginTimelineSession("current"));
    const tracks = host.querySelector("[data-tracks]")!;
    expect(tracks.closest("[inert]")).not.toBeNull();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    act(() => store.setTimelineReady(true));
    expect(controls.closest("[inert]")).toBeNull();
    expect(tracks.closest("[inert]")).toBeNull();
    expect(pane.hasAttribute("aria-busy")).toBe(false);
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    usePlayerStore.getState().reset();
  }
});

it("unlocks verified timeline rows before the first frame, only for the displayed composition", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const store = usePlayerStore.getState();
  const frame = document.createElement("iframe");
  frame.src = "https://preview.example/api/projects/current/preview";
  playback.frame.current = frame;
  playback.compositionLoading = true;
  try {
    store.beginTimelineSession("current");
    store.setTimelineReady(true);
    act(() => root.render(<TimelinePane />));
    const tracks = host.querySelector("[data-tracks]")!;
    expect(tracks.closest("[inert]")).not.toBeNull();
    const manifest: NonNullable<typeof store.clipManifest> = [];
    rememberIsolatedManifest(manifest, createPreviewAdapter({ iframe: frame }));
    act(() => store.setClipManifest(manifest));
    expect(tracks.closest("[inert]")).toBeNull();
    playback.url += "/comp/compositions/other.html";
    act(() => root.render(<TimelinePane />));
    expect(tracks.closest("[inert]")).not.toBeNull();
  } finally {
    act(() => root.unmount());
    playback.frame.current = null;
    playback.url = "/api/projects/current/preview";
    playback.compositionLoading = false;
    store.reset();
  }
});
