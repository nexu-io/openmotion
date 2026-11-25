// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { serializeBeats } from "@hyperframes/core/beats";
import { useMusicBeatAnalysis } from "./useMusicBeatAnalysis";
import { notifyExternalFileReload } from "./externalFileReloadBus";
import { usePlayerStore } from "../player/store/playerStore";
import { observeSourceRead, trackSourceReadStream } from "../utils/confirmedTextSources";
import { setCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { getStudioSaveSnapshot } from "../utils/studioSaveState";
import { applyTextPatch } from "../../../shared/text-patch";
import type { OrderedTextEditOperation } from "../../../shared/ordered-text-edits";

const asset = "assets/drums.mp3";
const grid = "beats/" + asset + ".json";
const project = "observed-grid";
const version = (n: number) => '"patch:' + String(n).padStart(64, "0") + '"';
const assetMetadata: Record<string, {version: string}> = { [asset]: { version: version(1) } };
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
    readOptionalProjectFile, writeProjectFile, assetMetadata,
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setCachedCloudDisklessMode(null);
});

it("reuses a verified missing or present beat grid across clip switches and retries after changes or a failed read", async () => {
  class Stream extends EventTarget { static OPEN = 1; readyState = 1; }
  vi.stubGlobal("EventSource", Stream);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stream = new Stream();
  const project = "welcome-sidecar";
  const stop = trackSourceReadStream(project, stream as unknown as EventSource);
  stream.dispatchEvent(new Event("open"));
  const store = usePlayerStore.getState();
  store.beginTimelineSession(project);
  store.markPreviewBooted();
  store.setElements([]);
  const track = { id: "music", tag: "audio", src: asset, duration: 5, start: 0, track: 1 };
  const enter = () => act(async () => store.setElements([track]));
  const leave = () => act(async () => store.setElements([]));
  function Probe() { useMusicBeatAnalysis(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await enter(); await leave(); await enter();
    expect(readOptionalProjectFile).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().beatAnalysis).toBeNull();

    await leave();
    stream.dispatchEvent(new Event("file-change"));
    readOptionalProjectFile.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await enter(); await leave();
    const content = serializeBeats([0.75], [1], asset);
    readOptionalProjectFile.mockImplementationOnce(async (_path, observe) => {
      observe({ content, version: version(8) }); return content;
    });
    await enter(); await leave(); await enter();
    expect(readOptionalProjectFile).toHaveBeenCalledTimes(3);
    expect(usePlayerStore.getState().beatAnalysis?.beatTimes).toEqual([0.75]);

    await leave();
    assetMetadata[asset] = { version: version(9) };
    await enter();
    expect(readOptionalProjectFile).toHaveBeenCalledTimes(4);
    expect(usePlayerStore.getState().beatAnalysis).toBeNull();

    await leave();
    stream.dispatchEvent(new Event("error"));
    await enter(); await leave(); await enter();
    expect(readOptionalProjectFile).toHaveBeenCalledTimes(6);
    await leave();
    store.beginTimelineSession("another-project");
    store.markPreviewBooted();
    await enter();
    expect(readOptionalProjectFile).toHaveBeenCalledTimes(7);
  } finally {
    stop?.();
    assetMetadata[asset] = { version: version(1) };
    await act(async () => root.unmount());
  }
});

it("reads only cold media metadata, discards a replaced audio base, and accepts edits on the refreshed grid", async () => {
  const cold = "replaced-beat-asset";
  const track = "assets/new.mp3", path = "beats/" + track + ".json";
  setCachedCloudDisklessMode(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldMedia = version(20), newMedia = version(21), remoteGrid = version(22);
  const peerGrid = serializeBeats([0.25], [0.9], track);
  let replaced = false;
  const batches: OrderedTextEditOperation[][] = [], metadataReads: string[] = [];
  const fetch = vi.fn(async (url: string, request?: RequestInit) => {
    if (request?.method !== "POST") {
      expect(url).toBe("/api/projects/" + cold + "/files/" + encodeURIComponent(track) + "?view=metadata");
      const version = replaced ? newMedia : oldMedia;
      metadataReads.push(version);
      return Response.json({ version });
    }
    expect(url).toBe("/api/projects/" + cold + "/text-edits/batch");
    const operations: OrderedTextEditOperation[] = JSON.parse(String(request.body)).operations;
    batches.push(operations);
    const op = operations[0]!;
    if (!replaced) {
      replaced = true;
      return Response.json({ committed: [], failed: {
        id: op.id, status: 409, code: "VERSION_CONFLICT", message: "Media changed", path: track, currentVersion: newMedia,
      } });
    }
    return Response.json({ committed: [{ id: op.id, versions: { [path]: version(23) }, changedPaths: [path] }] });
  });
  vi.stubGlobal("fetch", fetch);
  readOptionalProjectFile.mockImplementationOnce(async (_path, observe) => {
    observe({ content: "", version: null }); return "";
  }).mockImplementationOnce(async (_path, observe) => {
    observe({ content: peerGrid, version: remoteGrid }); return peerGrid;
  });
  const store = usePlayerStore.getState();
  store.beginTimelineSession(cold);
  store.markPreviewBooted();
  store.setElements([{ id: "track", tag: "audio", start: 0, duration: 5, track: 1, src: track }]);
  function Probe() { useMusicBeatAnalysis(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    const src = analyze.mock.calls.at(-1)![0];
    expect(usePlayerStore.getState().beatAnalysis?.beatTimes).toEqual([1]);
    const edit = (time: number) => usePlayerStore.getState().commitBeatEdits({src, added: [{ time, strength: 0.5 }], removed: []}, "Add beat");
    await act(async () => {
      edit(2);
      await vi.waitFor(() => expect(getStudioSaveSnapshot(cold).pending).toBe(0));
    });
    await vi.waitFor(() => expect(usePlayerStore.getState().beatAnalysis?.beatTimes).toEqual([0.25]));
    act(() => edit(3));
    await vi.waitFor(() => expect(getStudioSaveSnapshot(cold).pending).toBe(0));
    expect(getStudioSaveSnapshot(cold).failed).toBe(false);
    expect(metadataReads).toEqual([oldMedia, newMedia]);
    expect(batches).toHaveLength(2);
    expect(batches[0]![0]).toMatchObject({ files: [{ path, baseVersion: null }], dependencies: { [track]: oldMedia } });
    expect(batches[1]![0]).toMatchObject({ files: [{ path, baseVersion: remoteGrid }], dependencies: { [track]: newMedia } });
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps every completed beat gesture while creation is unconfirmed, then applies a peer grid without decoding the audio again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observeSourceRead(project, "index.html", new Response("", { headers: {
    "X-OpenMotion-Text-Edits": "1", "X-OpenMotion-Ordered-Edits": "1",
  } }), {});
  let sequence = 1;
  let savedGrid = "";
  const savedTimes: number[][] = [];
  const batches: OrderedTextEditOperation[][] = [];
  const release = Promise.withResolvers<void>();
  const post = vi.fn(async (url: string, request: RequestInit) => {
    expect(url).toBe("/api/projects/" + project + "/text-edits/batch");
    const operations: OrderedTextEditOperation[] = JSON.parse(String(request.body)).operations;
    batches.push(operations);
    if (batches.length === 1) await release.promise;
    return Response.json({ committed: operations.map(op => {
      const file = op.files[0]!;
      savedGrid = 'content' in file ? file.content : applyTextPatch(savedGrid, file.patch);
      savedTimes.push(JSON.parse(savedGrid).beats.map((beat: { time: number }) => beat.time));
      return { id: op.id, versions: { [grid]: version(++sequence) }, changedPaths: [grid] };
    }) });
  });
  vi.stubGlobal("fetch", post);
  const store = usePlayerStore.getState();
  store.beginTimelineSession(project);
  store.markPreviewBooted();
  store.setElements([{ id: "track", tag: "audio", start: 0, duration: 5, track: 1, src: asset }]);

  function Probe() { useMusicBeatAnalysis(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    expect(usePlayerStore.getState().beatAnalysis?.beatTimes).toEqual([1]);
    const src = analyze.mock.calls.at(-1)?.[0];
    expect(typeof src).toBe("string");
    function add(time: number) {
      usePlayerStore.getState().commitBeatEdits({ src: src!, added: [{ time, strength: 0.5 }], removed: [] }, "Add beat");
    }
    act(() => add(2));
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    act(() => { add(3); add(4); });
    expect(usePlayerStore.getState().beatEdits?.added.map(beat => beat.time)).toEqual([4]);
    expect(getStudioSaveSnapshot(project).pending).toBe(3);
    expect(post).toHaveBeenCalledOnce();
    release.resolve();
    await vi.waitFor(() => expect(getStudioSaveSnapshot(project).pending).toBe(0));
    expect(batches.map(batch => batch.length)).toEqual([1, 2]);
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(batches.flat().map(op => op.files[0]!.baseVersion))
      .toEqual([null, version(2), { after: batches[1]![0]!.id }]);
    for (const op of batches.flat()) {
      expect(op).toMatchObject({ dependencies: { [asset]: version(1) }, beatAssets: [asset] });
    }
    expect(savedTimes).toEqual([[1, 2], [1, 3], [1, 4]]);

    const peer = vi.fn(async () => ({ content: serializeBeats([0.5], [1], asset), version: version(5), missing: false }));
    await act(async () => { notifyExternalFileReload("unrelated.html", peer); });
    expect(peer).not.toHaveBeenCalled();
    await act(async () => { notifyExternalFileReload(grid, peer); });
    expect(peer).toHaveBeenCalledWith(project, grid);
    expect(usePlayerStore.getState().beatAnalysis?.beatTimes).toEqual([0.5]);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(readOptionalProjectFile).toHaveBeenCalledTimes(1);
    expect(writeProjectFile).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await act(async () => root.unmount());
  }
});
