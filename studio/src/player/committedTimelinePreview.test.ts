// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { beginStudioManualEditGesture, endStudioManualEditGesture } from "../components/editor/manualEditsDom";
import { beginStudioPendingEdit } from "../utils/studioPendingEdits";
import { forgetSource, rememberSource } from "../utils/confirmedTextSources";
import { usePlayerStore } from "./store/playerStore";
import { scheduleCommittedTimelinePreview } from "./committedTimelinePreview";
import { hasPeerTimingDocument, mountedPeerFileVersion, tryApplyPeerChanges } from "./peerTimingPreview";

vi.mock("./peerTimingPreview", () => ({
  refreshPeerScenes: vi.fn(async () => false), mountedPeerFileVersion: vi.fn(() => undefined), tryRefreshParkedPeerScene: () => false,
  hasPeerTimingDocument: vi.fn(() => true), hasPeerLiveEdit: () => false,
  tryApplyPeerChanges: vi.fn(async () => true),
}));

const update = vi.mocked(tryApplyPeerChanges);
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

it.each(["project", "navigation"])("drops a queued receipt after a %s switch", async (reason) => {
  const { frame, reload, accepted } = setup();
  const last = beginStudioPendingEdit(null);
  accepted("v1", "v2");
  if (reason === "project") usePlayerStore.setState({ timelineProjectId: "project-b" });
  else frame.setAttribute("src", "about:blank#other");
  last.settle();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(update).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("ignores a late failure for an older paint when a newer receipt supersedes it", async () => {
  const { reload, accepted } = setup();
  const old = Promise.withResolvers<boolean>();
  update.mockImplementationOnce(() => old.promise);
  accepted("v1", "v2");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  accepted("v2", "v3");
  old.resolve(false);
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]![1]).toEqual({path, previous: source("v1"), current: source("v3")});
  expect(reload).not.toHaveBeenCalled();
});

it("holds recovery behind new input and reconciles the settled revision when that input fails", async () => {
  const { reload, accepted } = setup();
  const old = Promise.withResolvers<boolean>();
  update.mockImplementationOnce(() => old.promise);
  accepted("v1", "v2");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const next = beginStudioPendingEdit(null);
  old.resolve(false);
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
  update.mockImplementationOnce(async () => false).mockImplementationOnce(async () => true);
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

it("resumes at an intermediate version actually painted before a late ACK", async () => {
  const { accepted, reload } = setup();
  const old = Promise.withResolvers<boolean>();
  update.mockImplementationOnce(() => old.promise);
  accepted("v1", "v2");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  accepted("v2", "v3");
  accepted("v3", "v4");
  vi.mocked(mountedPeerFileVersion).mockReturnValue("v2");
  old.resolve(false);
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
