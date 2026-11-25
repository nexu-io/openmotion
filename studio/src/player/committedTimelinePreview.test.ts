// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { beginStudioManualEditGesture, endStudioManualEditGesture, scopeStudioManualEditGesture } from "../components/editor/manualEditsDom";
import { beginStudioPendingEdit, trackStudioPendingEdit } from "../utils/studioPendingEdits";
import { forgetSource, rememberSource } from "../utils/confirmedTextSources";
import { usePlayerStore } from "./store/playerStore";
import { scheduleCommittedTimelinePreview } from "./committedTimelinePreview";
import { scheduleCommittedPreview } from "./committedPreview";
import { applyCommittedPeerChanges, hasPeerTimingDocument, mountedPeerFileVersion, refreshPeerScenes, type PeerApplyOutcome } from "./peerTimingPreview";
import { rememberPreviewHtmlSources } from "./lib/previewHtmlSources";
import { observePreviewDocument } from "./lib/previewAdapter";

vi.mock("./peerTimingPreview", () => ({
  reconcileMountedHistoryDraft: () => undefined,
  refreshPeerScenes: vi.fn(async () => false), mountedPeerFileVersion: vi.fn(() => undefined), tryRefreshParkedPeerScene: () => false,
  hasPeerTimingDocument: vi.fn(() => true), hasPeerLiveEdit: () => false,
  applyCommittedPeerChanges: vi.fn(async () => "applied"),
}));

const update = vi.mocked(applyCommittedPeerChanges);
const pid = "project-a";
const path = "index.html";
const source = (version: string) => ({ version, content: "<p>" + version + "</p>" });
function setup() {
  const frame = document.body.appendChild(document.createElement("iframe"));
  usePlayerStore.setState({ timelineProjectId: pid });
  const reload = vi.fn();
  const accepted = (from: string, to: string) => {
    rememberSource(pid, path, source(to));
    scheduleCommittedTimelinePreview(frame, pid, path, { [path]: {
      before: source(from).content, after: source(to).content,
    } }, source(from), reload);
  };
  return { frame, reload, accepted };
}
afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(mountedPeerFileVersion).mockReturnValue(undefined);
  vi.clearAllMocks();
});

it("applies a burst directly from the mounted revision to the last receipt, even if the final edit is a no-op", async () => {
  const { frame, reload, accepted } = setup();
  const last = beginStudioPendingEdit(null);
  accepted("v1", "v2");
  accepted("v2", "v3");
  accepted("v3", "v4");
  expect(update).not.toHaveBeenCalled();
  last.settle();
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update).toHaveBeenCalledWith(frame, { path, previous: source("v1"), current: source("v4") }, expect.any(Function));
  expect(reload).not.toHaveBeenCalled();
});

it("uses the last accepted receipt when the final write fails", async () => {
  const { accepted } = setup();
  const last = beginStudioPendingEdit(null);
  accepted("v1", "v2");
  last.settle(Promise.reject(new Error("save failed")));
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith(expect.anything(), {
    path, previous: source("v1"), current: source("v2"),
  }, expect.any(Function)));
});

it.each(["conflict", "script", "discontinuity"])("rebuilds just once on %s", async (reason) => {
  const { reload, accepted } = setup();
  const last = beginStudioPendingEdit(null);
  accepted("v1", "v2");
  accepted(reason === "discontinuity" ? "remote" : "v2", "v3");
  if (reason === "conflict") rememberSource(pid, path, source("remote"));
  if (reason === "script") vi.mocked(hasPeerTimingDocument).mockReturnValueOnce(false);
  last.settle();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(update).not.toHaveBeenCalled();
});

it.each(["project", "navigation", "same-url document"])("drops a queued receipt after a %s switch", async (reason) => {
  const { frame, reload, accepted } = setup();
  observePreviewDocument(frame, "old", false);
  const last = beginStudioPendingEdit(null);
  accepted("v1", "v2");
  if (reason === "project") usePlayerStore.setState({ timelineProjectId: "project-b" });
  else if (reason === "navigation") frame.setAttribute("src", "about:blank#other");
  else observePreviewDocument(frame, "new", false);
  last.settle();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(update).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("ignores a late failure for an older paint when a newer receipt supersedes it", async () => {
  const { reload, accepted } = setup();
  const old = Promise.withResolvers<PeerApplyOutcome>();
  update.mockImplementationOnce(() => old.promise);
  accepted("v1", "v2");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  accepted("v2", "v3");
  old.resolve("superseded");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]![1]).toEqual({path, previous: source("v1"), current: source("v3")});
  expect(reload).not.toHaveBeenCalled();
});

it("holds recovery behind new input and reconciles the settled revision when that input fails", async () => {
  const { reload, accepted } = setup();
  const old = Promise.withResolvers<PeerApplyOutcome>();
  update.mockImplementationOnce(() => old.promise);
  accepted("v1", "v2");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const next = beginStudioPendingEdit(null);
  old.resolve("superseded");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(reload).not.toHaveBeenCalled();
  next.settle(Promise.reject(new Error("save failed")));
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(reload).not.toHaveBeenCalled();
});

it("recovers only the unconfirmed file when two scenes were committed together", async () => {
  const {frame, reload} = setup();
  const files = ["compositions/a.html", "compositions/b.html"];
  const bases = new Map(files.map(file => [file, source("before")]));
  for (const file of files) rememberSource(pid, file, source("after"));
  update.mockResolvedValueOnce("requires-scene-rebuild").mockResolvedValueOnce("applied");
  scheduleCommittedTimelinePreview(frame, pid, path, Object.fromEntries(files.map(file =>
    [file, {before: source("before").content, after: source("after").content}])), undefined, reload, bases);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(update.mock.calls.map(call => call[1].path)).toEqual(files);
  expect(reload).toHaveBeenCalledWith([files[0]]);
});

it("does not reconcile over a second pointer drag before it starts its save", async () => {
  const {frame, reload, accepted} = setup();
  const gesture = beginStudioManualEditGesture(frame, "resize");
  accepted("v1", "v2");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(update).not.toHaveBeenCalled();
  accepted("v2", "v3");
  endStudioManualEditGesture(frame, gesture);
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]![1]).toEqual({path, previous: source("v1"), current: source("v3")});
  expect(reload).not.toHaveBeenCalled();
});

it("keeps a queued peer revision when an older timeline save receipt arrives during a gesture", async () => {
  const { frame, reload } = setup();
  const gesture = beginStudioManualEditGesture(frame, "resize");
  const previous = source("local"), current = source("peer");
  rememberSource(pid, path, current);
  scheduleCommittedPreview(frame, pid, [{ path, version: current.version, previous, read: async () => current }], reload);
  scheduleCommittedTimelinePreview(frame, pid, path, {
    [path]: { before: source("initial").content, after: previous.content, version: previous.version },
  }, source("initial"), reload);
  endStudioManualEditGesture(frame, gesture);
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith(frame, { path, previous, current }, expect.any(Function)));
  expect(reload).not.toHaveBeenCalled();
});

it("recovers the latest project state when a scene advances while a sibling paint is pending", async () => {
  const { frame, reload } = setup();
  const paths = ["compositions/stale.html", "compositions/sibling.html"];
  const previous = source("initial"), current = source("saved");
  const changes = paths.map(path => ({ path, previous, current }));
  for (const path of paths) rememberSource(pid, path, current);
  const paint = Promise.withResolvers<PeerApplyOutcome>();
  update.mockResolvedValueOnce("requires-scene-rebuild").mockImplementationOnce(() => paint.promise);
  scheduleCommittedPreview(frame, pid, changes, reload);
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  rememberSource(pid, paths[0], source("peer"));
  paint.resolve("applied");
  await vi.waitFor(() => expect(reload).toHaveBeenCalledWith([paths[0]]));
  expect(refreshPeerScenes).not.toHaveBeenCalled();
});

it("resumes at an intermediate version actually painted before a late ACK", async () => {
  const { accepted, reload } = setup();
  const old = Promise.withResolvers<PeerApplyOutcome>();
  update.mockImplementationOnce(() => old.promise);
  accepted("v1", "v2");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  accepted("v2", "v3");
  accepted("v3", "v4");
  vi.mocked(mountedPeerFileVersion).mockReturnValue("v2");
  old.resolve("superseded");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]![1]).toEqual({ path, previous: source("v2"), current: source("v4") });
  expect(reload).not.toHaveBeenCalled();
});

it("presents the versioned receipt when the source cache evicts the file before the frame is ready", async () => {
  const { frame, reload } = setup();
  const last = beginStudioPendingEdit(null);
  const file = "evicted.html", previous = source("v1"), current = source("v2");
  rememberSource(pid, file, current);
  scheduleCommittedTimelinePreview(frame, pid, file, {
    [file]: { before: previous.content, after: current.content, version: current.version },
  }, previous, reload);
  forgetSource(pid, file);
  last.settle();
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith(frame, { path: file, previous, current }, expect.any(Function)));
  expect(reload).not.toHaveBeenCalled();
});

it.each(["event first", "receipt first"])("uses the saved source and gesture when the same revision is announced twice (%s)", async order => {
  const { frame, reload } = setup();
  const hold = beginStudioPendingEdit(null);
  const previous = source("v1"), current = source("v2");
  const read = vi.fn(async () => current);
  const gesture = { gestureId: "drag-title" };
  rememberSource(pid, path, current);
  const event = () => scheduleCommittedPreview(frame, pid, [{ path, version: current.version, previous: current, read }], reload);
  const receipt = () => scheduleCommittedPreview(frame, pid, [{ path, previous, current }], reload, gesture);
  if (order === "event first") { event(); receipt(); } else { receipt(); event(); }
  hold.settle();
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update).toHaveBeenCalledWith(frame, { path, previous, current }, expect.any(Function), gesture);
  expect(read).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("keeps an in-flight update valid when a version notification repeats it", async () => {
  const { frame, reload, accepted } = setup();
  const paint = Promise.withResolvers<PeerApplyOutcome>();
  update.mockImplementationOnce(() => paint.promise);
  accepted("v1", "v2");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const isCurrent = update.mock.calls[0]![2];
  scheduleCommittedPreview(frame, pid, [{ path, version: "v2" }], reload);
  const stillCurrent = isCurrent();
  paint.resolve("applied");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(stillCurrent).toBe(true);
  expect(update).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
});

it("offers a mounted child with both source revisions to the DOM updater even without template capabilities", async () => {
  const { frame, reload } = setup();
  const file = "compositions/custom.html";
  vi.mocked(hasPeerTimingDocument).mockReturnValueOnce(false);
  vi.mocked(mountedPeerFileVersion).mockReturnValue("v1");
  const previous = source("v1"), current = source("v2");
  scheduleCommittedPreview(frame, pid, [{ path: file, previous, current }], reload);
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith(frame, { path: file, previous, current }, expect.any(Function)));
  expect(reload).not.toHaveBeenCalled();
});

const task = () => new Promise(resolve => setTimeout(resolve, 0));
function scopedSetup() {
  const { frame, reload } = setup();
  const a = "compositions/input.html", b = "compositions/peer.html";
  rememberPreviewHtmlSources(frame, pid, undefined, [a, b]);
  vi.mocked(mountedPeerFileVersion).mockReturnValue("base");
  const send = (path: string) => {
    const previous = source("base"), current = source("next");
    rememberSource(pid, path, current);
    scheduleCommittedPreview(frame, pid, [{path, previous, version: current.version, read: async () => current}], reload);
  };
  return { frame, reload, a, b, send };
}

it("wakes for a certified sibling while the earlier file waits from pointer-down through save", async () => {
  const { frame, reload, a, b, send } = scopedSetup();
  const gesture = beginStudioManualEditGesture(frame, "move");
  send(a);
  await task();
  send(b);
  await task();
  expect(update).not.toHaveBeenCalled(); // pick has not identified its target
  scopeStudioManualEditGesture(frame, gesture, [a]);
  const save = Promise.withResolvers<void>();
  trackStudioPendingEdit(save.promise, { frame, paths: [a] });
  await task();
  expect(update.mock.calls.map(call => call[1].path)).toEqual([b]);
  endStudioManualEditGesture(frame, gesture);
  await task();
  expect(update).toHaveBeenCalledTimes(1);
  save.resolve();
  await task();
  expect(update.mock.calls.map(call => call[1].path)).toEqual([b, a]);
  expect(reload).not.toHaveBeenCalled();
});

it.each(["index.html", "compositions/uncertified.html", "shared.css"])("holds %s and an unscoped pending save document-wide", async file => {
  const { frame, a, b, send } = scopedSetup();
  const gesture = beginStudioManualEditGesture(frame, "edit");
  scopeStudioManualEditGesture(frame, gesture, [a, file]);
  send(b);
  await task();
  expect(update).not.toHaveBeenCalled();
  const unknown = beginStudioPendingEdit(null);
  endStudioManualEditGesture(frame, gesture);
  await task();
  expect(update).not.toHaveBeenCalled();
  unknown.settle();
  await task();
  expect(update).toHaveBeenCalledTimes(1);
});

it.each(["unconfirmed", "requires-scene-rebuild"] as const)("a sibling %s waits for release before recovery, without resending the paint", async outcome => {
  const { frame, a, b, send, reload } = scopedSetup();
  const gesture = beginStudioManualEditGesture(frame, "resize");
  scopeStudioManualEditGesture(frame, gesture, [a]);
  update.mockResolvedValueOnce(outcome);
  send(b);
  await task();
  expect(update).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
  endStudioManualEditGesture(frame, gesture);
  await task();
  expect(update).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledWith([b]);
});

it("does not use the old sibling certificate alongside a queued root change", async () => {
  const { frame, a, b, send } = scopedSetup();
  const gesture = beginStudioManualEditGesture(frame, "resize");
  scopeStudioManualEditGesture(frame, gesture, [a]);
  send(b);
  send("index.html");
  await task();
  expect(update).not.toHaveBeenCalled();
  endStudioManualEditGesture(frame, gesture);
  await task();
  expect(update.mock.calls.map(call => call[1].path)).toEqual([b, "index.html"]);
});
