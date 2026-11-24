// @vitest-environment happy-dom
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
import { patchTimelineChangesInSource } from "../../hooks/timelineEditingHelpers";
import { applyPatchByTarget } from "../../utils/sourcePatcher";
import { expect, it, vi } from "vitest";
import { rememberPeerTimingDocument, tryApplyPeerChanges } from "../peerTimingPreview";
import { isCurrentIsolatedManifest } from "../lib/isolatedTimelineManifest";
import { PREVIEW_BRIDGE_SOURCE, PREVIEW_BRIDGE_VERSION } from "../lib/previewAdapter";
import { buildTimelineElementsFromClips } from "./timelineSyncHydration";
import { createPreviewMessageHandler, type ClipManifestMessage } from "./previewMessageRouter";

it("keeps live resize bounds out of timeline refreshes", () => {
  const frame = document.createElement("iframe");
  const origin = "https://preview.test";
  frame.src = origin + "/api/projects/p/preview?pt=active";
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: vi.fn() } });
  const enrich = vi.fn();
  const route = createPreviewMessageHandler({ iframeRef: { current: frame },
    processTimelineMessageRef: { current: vi.fn() }, enrichMissingCompositionsRef: { current: enrich },
    lastTimelineMessageRef: { current: 0 }, getAdapter: () => null, syncTimelineElements: vi.fn() });
  const send = (type: string) => route(new MessageEvent("message", { source: frame.contentWindow, origin,
    data: { source: PREVIEW_BRIDGE_SOURCE, version: PREVIEW_BRIDGE_VERSION, projectId: "p", token: "active", type, phase: "bounds" } }));
  send("canvas-drag");
  expect(enrich).not.toHaveBeenCalled();
  send("timeline-state");
  expect(enrich).toHaveBeenCalledOnce();
});

it("keeps authored identity across runtime notifications and only accepts it from the current frame", () => {
  const origin = "https://preview.test";
  const child = { postMessage: vi.fn() };
  const iframe = document.createElement("iframe");
  Object.defineProperty(iframe, "contentWindow", { value: child });
  iframe.src = origin + "/api/projects/p/preview?pt=active";
  const process = vi.fn<(message: ClipManifestMessage) => void>();
  const route = createPreviewMessageHandler({ iframeRef: { current: iframe },
    processTimelineMessageRef: { current: process }, enrichMissingCompositionsRef: { current: vi.fn() },
    lastTimelineMessageRef: { current: 0 }, getAdapter: () => null, syncTimelineElements: vi.fn() });
  const clip = { id: "voice", kind: "audio", tagName: "audio", start: 0, duration: 2, track: 1 };
  const send = (data: unknown) => route(new MessageEvent("message", { origin, source: iframe.contentWindow, data }));
  send({ source: "hf-preview", type: "timeline", clips: [clip], durationInFrames: 60 });
  expect(process).not.toHaveBeenCalled();
  expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "handshake", timelineOnly: true }), origin);
  const payload = { source: PREVIEW_BRIDGE_SOURCE, version: PREVIEW_BRIDGE_VERSION, type: "timeline-state", projectId: "p",
    clips: [{ ...clip, authored: { sourceFile: "parts/scene.html", hfId: "source-voice", hidden: true, timelineLocked: true, muted: true, volume: 0.42 } }],
    durationInFrames: 60 };
  send({ ...payload, token: "older" });
  expect(process).not.toHaveBeenCalled();
  send({ ...payload, token: "active" });
  const clips = process.mock.calls[0]![0].clips;
  expect(isCurrentIsolatedManifest(iframe, clips)).toBe(true);
  expect(buildTimelineElementsFromClips(clips, null)[0]).toMatchObject({
    sourceFile: "parts/scene.html", hfId: "source-voice", selector: '[data-hf-id="source-voice"]',
    timelineLocked: true, hidden: true, muted: true, volume: 0.42,
  });
  iframe.src = origin + "/api/projects/p/preview?pt=replacement";
  expect(isCurrentIsolatedManifest(iframe, clips)).toBe(false);
});

it("rejects a delayed clip list from before a confirmed rebind of the same document", async () => {
  const origin = "https://preview.test";
  const frame = document.createElement("iframe");
  frame.src = origin + "/api/projects/p/preview?pt=active";
  const envelope = { source: PREVIEW_BRIDGE_SOURCE, version: PREVIEW_BRIDGE_VERSION, projectId: "p", token: "active" };
  const event = (data: object) => new MessageEvent("message", { source: frame.contentWindow, origin, data: { ...envelope, ...data } });
  Object.defineProperty(frame, "contentWindow", { value: { postMessage({ requestId }: { requestId: string }) {
    window.dispatchEvent(event({ type: "response", requestId, result: true }));
  } } });
  rememberPeerTimingDocument(frame, "active", undefined, "doc", { mediaTiming: true });
  const source = '<audio id="sound" data-start="0"></audio>';
  expect(await tryApplyPeerChanges(frame, { path: "index.html", previous: { content: source, version: "old" },
    current: { content: source.replace('"0"', '"2"'), version: "new" } }, () => true)).toBe(true);
  // A duplicate ready handshake still identifies the very same mounted player.
  rememberPeerTimingDocument(frame, "active", undefined, "doc", { mediaTiming: true });
  const process = vi.fn();
  const route = createPreviewMessageHandler({ iframeRef: { current: frame }, processTimelineMessageRef: { current: process },
    enrichMissingCompositionsRef: { current: vi.fn() }, lastTimelineMessageRef: { current: 0 }, getAdapter: () => null, syncTimelineElements: vi.fn() });
  const list = { type: "timeline-state", timelinePath: "index.html", clips: [{ id: "sound", start: 0, duration: 2 }], durationInFrames: 60 };
  route(event({ ...list, timelineVersion: "old" }));
  expect(process).not.toHaveBeenCalled();
  route(event({ ...list, timelineVersion: "new" }));
  expect(process).toHaveBeenCalledTimes(1);
  rememberPeerTimingDocument(frame, "active", undefined, "replacement", { mediaTiming: true });
  route(event({ ...list, timelineVersion: "different" }));
  expect(process).toHaveBeenCalledTimes(2);
});

it.each(["new", "old"])("checks the mounted file after losing the paint reply (%s)", async (mounted) => {
  const frame = document.createElement("iframe");
  const origin = "https://preview.test";
  frame.src = origin + "/api/projects/p/preview?pt=active";
  const messages: string[] = [];
  const envelope = { source: PREVIEW_BRIDGE_SOURCE, version: PREVIEW_BRIDGE_VERSION, projectId: "p", token: "active" };
  Object.defineProperty(frame, "contentWindow", { value: { postMessage({ type, requestId }: { type: string; requestId: string }) {
    messages.push(type);
    if (type === "mounted-file-version") {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin,
        data: { ...envelope, type: "response", requestId, result: mounted } }));
    }
  } } });
  rememberPeerTimingDocument(frame, "active", "doc");
  const content = '<audio id="sound" data-start="0"></audio>';
  const applied = await tryApplyPeerChanges(frame, { path: "index.html", previous: { content, version: "old" },
    current: { content: content.replace('"0"', '"2"'), version: "new" } }, () => true);
  expect(applied).toBe(mounted === "new");
  expect(messages).toEqual(["peer-timing", "mounted-file-version"]);
});

it("patches an anonymous legacy clip using exactly the same hf-id as its preview", () => {
  const source = '<html><body><img data-start="0" data-duration="4"></body></html>';
  const hfId = ensureHfIds(source).match(/<img[^>]*data-hf-id="([^"]+)"/)?.[1];
  expect(hfId).toBeTruthy();
  const element = { id: "runtime-clip", hfId, tag: "img", start: 0, duration: 4, track: 0 };
  const patched = patchTimelineChangesInSource(source, "index.html", [{ element,
    buildPatches: (current, target) => applyPatchByTarget(current, target, { type: "attribute", property: "duration", value: "2" }),
  }]);
  expect(patched).toContain('data-duration="2"');
  expect(patched).toContain(`data-hf-id="${hfId}"`);
  expect(patchTimelineChangesInSource(source, "index.html", [{ element, buildPatches: current => current }])).toBe(source);
});

it("uses the same audible-video rule for the isolated gain dialog and same-origin timeline", () => {
  const clip = { id: "footage", kind: "video" as const, tagName: "video", start: 0, duration: 2, track: 0,
    authored: { domId: "footage", sourceFile: "index.html", hidden: false, muted: false, timelineLocked: false, volume: 1.35 } };
  expect(buildTimelineElementsFromClips([clip], null)[0]).toMatchObject({ hasAudio: true, volume: 1.35 });
  expect(buildTimelineElementsFromClips([{ ...clip, authored: { ...clip.authored, hasAudioAttr: "false" } }], null)[0]?.hasAudio).toBeUndefined();
});
