// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetProjectSources, rememberSource } from "../../utils/confirmedTextSources";
import { markStudioWriteToken } from "../../utils/studioFileVersion";
import { trackStudioPendingEdit } from "../../utils/studioPendingEdits";
import { announcePreviewDocumentLoaded, previewContentGeneration, previewSourceRevision, sceneSwapFor } from "../sceneSwap";
import { createPreviewMessageHandler } from "../hooks/previewMessageRouter";
import { usePlayerStore, type TimelineElement } from "../store/playerStore";
import { hasPendingHistoryTimeline } from "../timelineRestorePending";
import { parseAuthoredTimeline } from "./authoredTimeline";
import { beginPeerTimelineUpdate, beginTimelineSourceRead, openTimelineSource, projectLocalTimelineEdit } from "./peerTimeline";

const path = "index.html";
const audio = (id: string, start: number, duration: number, offset: number, track: number) =>
  `<audio id="${id}" src="${id}.mp3" data-start="${start}" data-duration="${duration}" data-media-start="${offset}" data-track-index="${track}"></audio>`;
const page = (...rows: string[]) => `<div data-composition-id="root" data-duration="20">${rows.join("")}</div>`;
const row = (id: string, sourceFile = path): TimelineElement => ({
  id, domId: id, key: `${sourceFile}#${id}`, sourceFile, start: 0, duration: 10,
  track: 0, authoredTrack: 0, tag: "audio", sourceDuration: 90,
});
const original = page(audio("a", 0, 10, 0, 0));
let frame: HTMLIFrameElement;
let close: () => void;
beforeEach(() => {
  usePlayerStore.getState().beginTimelineSession("p");
  usePlayerStore.setState({ elements: [row("a"), row("generated")], duration: 20, currentTime: 8, isPlaying: true, timelineReady: true });
  frame = document.createElement("iframe");
  document.body.append(frame);
  close = openTimelineSource("p", path);
});
afterEach(() => { forgetProjectSources("p"); close(); frame.remove(); usePlayerStore.getState().reset(); });

it("installs confirmed rows before preview startup without enabling transport", () => {
  usePlayerStore.setState({ elements: [], duration: 0, timelineReady: false });
  rememberSource("p", path, { content: original, version: "v2" });
  beginTimelineSourceRead("p", path)(original, { version: "v1" });
  expect(usePlayerStore.getState().elements).toEqual([]);
  beginTimelineSourceRead("p", path)(original, { version: "v2" });
  expect(usePlayerStore.getState()).toMatchObject({ authoredTimelinePath: path, duration: 20, timelineReady: false,
    elements: [{ domId: "a", start: 0, duration: 10 }] });
});

it("releases the source document after reading media and nested composition timing", () => {
  const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
  try {
    const scenePath = "compositions/intro.html";
    const timeline = parseAuthoredTimeline(page(audio("voice", 2, 8, 1, 0),
      '<div data-composition-id="child" data-composition-src="child.html" data-start="4" data-duration="3"></div>'
    ), scenePath, "p");
    expect(timeline?.duration).toBe(20);
    expect(timeline?.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ domId: "voice", src: `${location.origin}/api/projects/p/preview/compositions/voice.mp3`, start: 2, duration: 8, playbackStart: 1 }),
      expect.objectContaining({ kind: "composition", compositionSrc: "child.html", start: 4, duration: 3 }),
    ]));
    expect(parseAuthoredTimeline(audio("outside", 0, 2, 0, 0), scenePath, "p")).toBeNull();
    for (const result of parse.mock.results) expect(result.value.documentElement).toBeNull();
  } finally { parse.mockRestore(); }
});

it("does not publish late opening rows into a different file or project", () => {
  usePlayerStore.setState({ elements: [], timelineReady: false });
  rememberSource("p", path, { content: original, version: "v1" });
  const late = beginTimelineSourceRead("p", path);
  const leaveClip = openTimelineSource("p", "compositions/next.html");
  late(original, { version: "v1" });
  expect(usePlayerStore.getState().elements).toEqual([]);
  leaveClip();
  usePlayerStore.getState().beginTimelineSession("different");
  late(original, { version: "v1" });
  expect(usePlayerStore.getState().authoredTimelinePath).toBeNull();
  expect(usePlayerStore.getState().elements).toEqual([]);
});

it.each([
  ["trim head", audio("a", 2, 8, 2, 0), { start: 2, duration: 8, playbackStart: 2 }],
  ["trim tail", audio("a", 0, 6, 0, 0), { start: 0, duration: 6 }],
  ["cross track", audio("a", 3, 10, 0, 3), { start: 3, authoredTrack: 3 }],
] as const)("shows a peer %s before replacing the preview", (_, authored, expected) => {
  beginTimelineSourceRead("p", path)(original);
  expect(beginPeerTimelineUpdate("p", path, frame)!(page(authored), frame)).toBe(true);
  expect(usePlayerStore.getState()).toMatchObject({ currentTime: 8, isPlaying: true, timelineReady: true });
  expect(usePlayerStore.getState().elements[0]).toMatchObject({ ...expected, sourceDuration: 90 });
  expect(usePlayerStore.getState().elements[1]).toMatchObject({ id: "generated", duration: 10 });
  expect(hasPendingHistoryTimeline(frame)).toBe(true);
});

it("applies a split and deletion while keeping the old isolated manifest out of the rows", () => {
  Object.defineProperty(frame, "contentDocument", { value: null });
  beginTimelineSourceRead("p", path)(original);
  const split = page(audio("a", 0, 5, 0, 0), audio("b", 5, 5, 5, 0));
  expect(beginPeerTimelineUpdate("p", path, frame)!(split, frame)).toBe(true);
  expect(usePlayerStore.getState().elements.map(row => row.id)).toEqual(["a", "generated", "b"]);
  expect(beginPeerTimelineUpdate("p", path, frame)!(page(), frame)).toBe(true);
  expect(usePlayerStore.getState().elements.map(row => row.id)).toEqual(["generated"]);

  const rediscover = vi.fn();
  const handler = createPreviewMessageHandler({ iframeRef: { current: frame },
    processTimelineMessageRef: { current: rediscover }, enrichMissingCompositionsRef: { current: rediscover },
    lastTimelineMessageRef: { current: 0 }, getAdapter: () => null, syncTimelineElements: rediscover,
  });
  const report = () => handler(new MessageEvent("message", {
    data: { source: "hf-preview", type: "timeline", clips: [], durationInFrames: 300 },
  }));
  report();
  expect(rediscover).not.toHaveBeenCalled();
  announcePreviewDocumentLoaded(frame);
  report();
  expect(rediscover).toHaveBeenCalled();
});

it("does not hold a newer preview which loaded while the source was being read", () => {
  beginTimelineSourceRead("p", path)(original);
  const apply = beginPeerTimelineUpdate("p", path, frame)!;
  announcePreviewDocumentLoaded(frame);
  expect(apply(page(audio("a", 3, 7, 3, 0)), frame)).toBe(true);
  expect(hasPendingHistoryTimeline(frame)).toBe(false);
});

it("ignores late reads and late digests across replacement or a scope switch", () => {
  const lateInitial = beginTimelineSourceRead("p", path);
  beginTimelineSourceRead("p", path)(original);
  const old = beginPeerTimelineUpdate("p", path, frame)!;
  const latest = beginPeerTimelineUpdate("p", path, frame)!;
  expect(latest(page(audio("a", 1, 9, 1, 0)), frame)).toBe(true);
  lateInitial(page());
  expect(old(original, frame)).toBe(false);
  const pending = beginPeerTimelineUpdate("p", path, frame)!;
  close();
  close = openTimelineSource("p", "nested.html");
  expect(beginPeerTimelineUpdate("p", path)).toBeNull();
  expect(pending(original, frame)).toBe(false);
  expect(usePlayerStore.getState().elements[0].duration).toBe(9);
  const nested = beginPeerTimelineUpdate("p", "nested.html")!;
  usePlayerStore.getState().beginTimelineSession("other");
  expect(nested(original, null)).toBe(false);
});

it("leaves a local edit alone if it starts or finishes while the peer read is in flight", async () => {
  const apply = beginPeerTimelineUpdate("p", path, frame)!;
  const { promise, resolve } = Promise.withResolvers<void>();
  trackStudioPendingEdit(promise);
  usePlayerStore.setState({ elements: [{ ...row("a"), duration: 3 }] });
  expect(apply(original, frame)).toBe(false);
  markStudioWriteToken("local-trim");
  resolve(); await promise;
  expect(apply(original, frame)).toBe(false);
  expect(usePlayerStore.getState().elements[0].duration).toBe(3);
});

it("can apply known source timing without a baseline and keeps unproven runtime rows", () => {
  expect(beginPeerTimelineUpdate("p", path)!(page(audio("a", 3, 7, 3, 4)), null)).toBe(true);
  expect(usePlayerStore.getState().elements[0]).toMatchObject({ start: 3, duration: 7, playbackStart: 3, authoredTrack: 4, sourceDuration: 90 });
  expect(usePlayerStore.getState().elements.map(row => row.id)).toEqual(["a", "generated"]);
});

it("targets the peer's freshly stamped clip after an undo restored an unstamped source", () => {
  usePlayerStore.setState({elements:[{...row('a'), hfId:'hf-old'}]});
  beginTimelineSourceRead('p',path)(original);
  const restamped = page(audio('a',3.875,10,0,0).replace('<audio ', '<audio data-hf-id="hf-peer" '));
  beginPeerTimelineUpdate('p',path,frame)!(restamped,frame);
  expect(usePlayerStore.getState().elements[0]).toMatchObject({key:'index.html#a', hfId:'hf-peer', start:3.875, sourceDuration:90});
  expect(hasPendingHistoryTimeline(frame)).toBe(true);
});


it("holds an unchanged projection until a swap started for the newest remote revision finishes", async () => {
  beginTimelineSourceRead("p", path)(original);
  beginPeerTimelineUpdate("p", path, frame)!(original, frame);
  const oldRevision = previewSourceRevision();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const swap = vi.fn(async () => { started.resolve(); await finish.promise; });
  Object.assign(frame.contentWindow!, { __hfSwapScenes: swap });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(original));
  try {
    const mounted = sceneSwapFor(frame)!("/preview", () => previewSourceRevision() === oldRevision);
    await started.promise;
    const newest = beginPeerTimelineUpdate("p", path, frame)!;
    expect(newest(page(audio("a", 4, 6, 4, 0)), frame)).toBe(true);
    finish.resolve();
    await expect(mounted).rejects.toMatchObject({ name: "AbortError" });
    expect(previewContentGeneration(frame)).toBe(0);
    expect(hasPendingHistoryTimeline(frame)).toBe(true);

    // A duplicate delivery can resolve to the same visible rows. The old frame
    // is still stale and only the latest generation can release the hold.
    const duplicate = beginPeerTimelineUpdate("p", path, frame)!;
    expect(duplicate(page(audio("a", 4, 6, 4, 0)), frame)).toBe(false);
    expect(hasPendingHistoryTimeline(frame)).toBe(true);
    const latest = previewSourceRevision();
    await sceneSwapFor(frame)!("/preview", () => previewSourceRevision() === latest);
    expect(previewContentGeneration(frame)).toBe(1);
    expect(hasPendingHistoryTimeline(frame)).toBe(false);
  } finally { fetch.mockRestore(); }
});

it("does not invalidate the preview for an SDK read or an unrelated notification", () => {
  const at = previewSourceRevision();
  beginTimelineSourceRead("p", path)(original);
  expect(beginPeerTimelineUpdate("p", "other.html", frame)).toBeNull();
  expect(previewSourceRevision()).toBe(at);
});

it("keeps a confirmed projection as the baseline when an SDK read finishes late", () => {
  beginTimelineSourceRead("p", path)(original);
  const split = beginPeerTimelineUpdate("p", path, frame)!;
  const lateSdkRead = beginTimelineSourceRead("p", path);
  const added = page(audio("a", 0, 10, 0, 0), audio("b", 3, 3, 0, 1));
  split(added, frame);
  lateSdkRead(original);
  expect(usePlayerStore.getState().elements.some(row => row.id === "b")).toBe(true);
  beginPeerTimelineUpdate("p", path, frame)!(original, frame);
  expect(usePlayerStore.getState().elements.some(row => row.id === "b")).toBe(false);
});

it("reuses root startup rows and parses each following version exactly once", () => {
  const initial = parseAuthoredTimeline(original, path, "p")!;
  beginTimelineSourceRead("p", path)(original, { rows: initial });
  const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
  try {
    const next = page(audio("a", 2, 8, 2, 0));
    beginPeerTimelineUpdate("p", path, frame)!(next, frame);
    beginTimelineSourceRead("p", path)(next); // SDK opens that same confirmed version
    const last = page(audio("a", 3, 7, 3, 0));
    beginPeerTimelineUpdate("p", path, frame)!(last, frame);
    expect(parse.mock.calls.map(call => call[0])).toEqual([next, last]);
  } finally { parse.mockRestore(); }
});

it("projects both split halves before the write and restores only that split on rejection", () => {
  const after = page(audio("a", 0, 4, 0, 0), audio("a-split", 4, 6, 4, 0));
  const rollback = projectLocalTimelineEdit("p", path, { before: original, after }, frame)!;
  const rows = () => usePlayerStore.getState().elements.map(e => [e.domId, e.duration]);
  expect(rows()).toEqual(expect.arrayContaining([["a", 4], ["a-split", 6], ["generated", 10]]));
  expect(hasPendingHistoryTimeline(frame)).toBe(true);
  rollback();
  expect(rows()).toEqual(expect.arrayContaining([["a", 10], ["generated", 10]]));
  expect(rows().some(([id]) => id === "a-split")).toBe(false);
  expect(hasPendingHistoryTimeline(frame)).toBe(false);
});

it("a late rejected cut cannot undo a newer peer projection or release its preview guard", () => {
  const after = page(audio("a", 0, 4, 0, 0), audio("a-split", 4, 6, 4, 0));
  const rollback = projectLocalTimelineEdit("p", path, { before: original, after }, frame)!;
  expect(beginPeerTimelineUpdate("p", path, frame)!(page(audio("a", 0, 7, 0, 0)), frame)).toBe(true);
  rollback();
  expect(usePlayerStore.getState().elements.find(e => e.domId === "a")?.duration).toBe(7);
  expect(usePlayerStore.getState().elements.some(e => e.domId === "a-split")).toBe(false);
  expect(hasPendingHistoryTimeline(frame)).toBe(true);
});
