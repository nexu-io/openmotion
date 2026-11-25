// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { serializeBeats } from "@hyperframes/core/beats";
import { useMusicBeatAnalysis } from "./useMusicBeatAnalysis";
import { notifyExternalFileReload } from "./externalFileReloadBus";
import { usePlayerStore } from "../player/store/playerStore";
import { serializeStudioFileMutation } from "../utils/studioFileMutationCoordinator";
import { observeSourceRead } from "../utils/confirmedTextSources";

const asset = "assets/drums.mp3";
const grid = "beats/" + asset + ".json";
const project = "observed-grid";
const version = (n: number) => '"patch:' + String(n).padStart(64, "0") + '"';
const readOptionalProjectFile = vi.fn(async (_path: string, observe: (base: { content: string; version: string | null }) => void) => {
  observe({ content: "", version: null });
  return "";
});
const writeProjectFile = vi.fn();
const analyze = vi.hoisted(() => vi.fn(async (_url: string) => ({ beatTimes: [1], beatStrengths: [0.6] })));
vi.mock("@hyperframes/core/beats", async importOriginal => ({
  ...await importOriginal<typeof import("@hyperframes/core/beats")>(),
  analyzeMusicFromUrl: analyze,
}));
vi.mock("../contexts/FileManagerContext", () => ({
  useFileManagerContextOptional: () => ({
    readOptionalProjectFile, writeProjectFile, assetMetadata: { [asset]: { version: version(1) } },
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("debounces first creation, advances the guarded version, and applies a peer grid without decoding the audio again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  observeSourceRead(project, "index.html", new Response("", { headers: { "X-OpenMotion-Text-Edits": "1" } }), {});
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ versions: { [grid]: version(2) }, changedPaths: [grid] }))
    .mockResolvedValueOnce(Response.json({ versions: { [grid]: version(3) }, changedPaths: [grid] }));
  vi.stubGlobal("fetch", fetch);
  const store = usePlayerStore.getState();
  store.beginTimelineSession(project);
  store.markPreviewBooted();
  store.setElements([{ id: "track", tag: "audio", start: 0, duration: 5, track: 1, src: asset }]);

  function Probe() { useMusicBeatAnalysis(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    expect(usePlayerStore.getState().beatAnalysis?.beatTimes).toEqual([1]);
    const src = analyze.mock.calls[0]?.[0];
    expect(typeof src).toBe("string");
    function add(time: number) {
      usePlayerStore.getState().commitBeatEdits({ src: src!, added: [{ time, strength: 0.5 }], removed: [] }, "Add beat");
    }
    act(() => { add(2); add(3); });
    await act(async () => { await vi.advanceTimersByTimeAsync(349); });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await serializeStudioFileMutation(writeProjectFile, grid, async () => {});
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = (n: number) => JSON.parse(fetch.mock.calls[n]![1].body);
    expect(body(0)).toMatchObject({ files: [{ path: grid, baseVersion: null }], dependencies: { [asset]: version(1) }, beatAssets: [asset] });
    expect(JSON.parse(body(0).files[0].content).beats.map((b: { time: number }) => b.time)).toEqual([1, 3]);

    act(() => add(4));
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await serializeStudioFileMutation(writeProjectFile, grid, async () => {});
    expect(body(1).files[0].baseVersion).toBe(version(2));

    const peer = vi.fn(async () => ({ content: serializeBeats([0.5], [1], asset), version: version(4), missing: false }));
    await act(async () => { notifyExternalFileReload("unrelated.html", peer); });
    expect(peer).not.toHaveBeenCalled();
    await act(async () => { notifyExternalFileReload(grid, peer); });
    expect(peer).toHaveBeenCalledWith(project, grid);
    expect(usePlayerStore.getState().beatAnalysis?.beatTimes).toEqual([0.5]);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(readOptionalProjectFile).toHaveBeenCalledTimes(1);
    expect(writeProjectFile).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
