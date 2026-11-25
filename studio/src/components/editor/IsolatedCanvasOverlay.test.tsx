import { isStudioEditSaving, studioPendingEditBlocks } from "../../utils/studioPendingEdits";
// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as sources from "../../utils/confirmedTextSources";
import { IsolatedCanvasOverlay } from "./IsolatedCanvasOverlay";
import { observePreviewDocument, PREVIEW_BRIDGE_SOURCE, type PreviewBridgeMessage } from "../../player/lib/previewAdapter";
import { liveTime, usePlayerStore } from "../../player/store/playerStore";
import { announcePreviewPromoted } from "../../player/sceneSwap";
import { paintWithIsolatedSelection, type SelectionPaintReply } from "../../player/isolatedSelectionPaint";

const state = vi.hoisted(() => ({
  writeBlockedReason: null as string | null,
  domEditSelection: null as null | { id?: string; sourceFile?: string; isolatedClipOwner?: { id: string; sourceFile: string }; isolatedBounds: { x:number; y:number; width:number; height:number }; isolatedTarget?: { sourceFile:string; elementId:string } },
  previewIframeRef: { current: null as HTMLIFrameElement | null },
  compositionRect: { left: 10, top: 10, width: 200, height: 100 },
  commitDomEditPatchBatches: vi.fn(),
  applyDomSelection: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("../../contexts/DomEditContext", () => ({ useDomEditActionsContext: () => state, useDomEditSelectionContext: () => ({ ...state, domEditSelectionRef: selectionRef }) }));
vi.mock("../../contexts/StudioContext", () => ({
  useStudioShellContext: () => ({ ...state, projectId: "project-1" }),
}));
vi.mock("./PreviewOverlayProvider", () => ({ usePreviewOverlayContext: () => ({ state }) }));
vi.mock("../../i18n/I18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let host: HTMLElement, frame: HTMLIFrameElement, root: Root, canvas: HTMLElement;
let messages: PreviewBridgeMessage[];
const origin = "https://preview.test";
const result = { sourceFile: "compositions/title.html", sha256: "a".repeat(64),
  elementId: "title", left: 12, top: 34, makeRelative: true };
const selectionRef = { get current() { return state.domEditSelection; } };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const meta = document.createElement("meta");
  meta.name = "openmotion-preview-origin";
  meta.content = origin;
  document.head.append(meta);
  host = document.createElement("main");
  frame = document.createElement("iframe");
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: vi.fn() } });
  document.body.append(host);
  // Keep the test frame local while the adapter reads its production scoped URL.
  vi.spyOn(frame, "getAttribute").mockReturnValue(origin + "/api/projects/project-1/preview?pt=one");
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 100));
  state.previewIframeRef.current = frame;
  state.domEditSelection = null;
  state.writeBlockedReason = null;
  messages = [];
  state.compositionRect = { left: 10, top: 10, width: 200, height: 100 };
  state.commitDomEditPatchBatches.mockReset().mockResolvedValue({ durable: true, changed: true });
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(message => { messages.push(message); });
  root = createRoot(host);
  act(() => root.render(<IsolatedCanvasOverlay />));
  canvas = host.querySelector("div")!;
  canvas.setPointerCapture = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  state.previewIframeRef.current = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

function pointer(type: string, x: number, buttons = 0) {
  act(() => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons, clientX: x, clientY: 60,
  })));
}

it("allows inspecting another layer while a write conflict blocks dragging and resizing", () => {
  state.writeBlockedReason = "Resolve the external change";
  state.domEditSelection = { isolatedBounds: { x: .1, y: .2, width: .4, height: .3 } };
  act(() => root.render(<IsolatedCanvasOverlay />));
  expect(canvas.querySelector(".border-studio-accent")).toBeTruthy();
  expect(canvas.querySelector("[data-resize-corner]")).toBeNull();
  pointer("pointerdown", 60);
  pointer("pointermove", 80);
  pointer("pointerup", 80);
  expect(messages.map(message => message.type)).toEqual(["layer-select"]);
  expect(state.commitDomEditPatchBatches).not.toHaveBeenCalled();
});

async function reply(phase: string, result: unknown, gestureId?: unknown) {
  const request = messages.findLast(message => message.phase === phase && (!gestureId || message.gestureId === gestureId))!;
  expect(request).toBeDefined();
  await act(async () => {
    const event = new MessageEvent("message", { origin, source: frame.contentWindow,
      data: { ...request, source: PREVIEW_BRIDGE_SOURCE, type: "response", ok: true, result },
    });
    expect(event.source === frame.contentWindow).toBe(true);
    expect(event.origin).toBe(origin);
    window.dispatchEvent(event);
  });
}

it("keeps the released drag pending through a later selection click and its save receipt", async () => {
  const save = Promise.withResolvers<{ durable: boolean; changed: boolean }>();
  state.commitDomEditPatchBatches.mockReturnValueOnce(save.promise);
  pointer("pointerdown", 60);
  pointer("pointerup", 80);
  const drag = messages[0]!.gestureId;
  pointer("pointerdown", 80);
  pointer("pointerup", 80);
  expect(messages.map(message => message.phase)).toEqual(["start", "finish", "start", "cancel"]);
  expect(isStudioEditSaving()).toBe(true);
  await reply("finish", result, drag);
  expect(isStudioEditSaving()).toBe(true);
  expect(studioPendingEditBlocks(scope => scope.frame === frame && scope.paths.length === 1 && scope.paths[0] === result.sourceFile)).toBe(false);
  expect(studioPendingEditBlocks(scope => !scope.paths.includes(result.sourceFile))).toBe(true);
  await act(async () => { save.resolve({ durable: true, changed: true }); });
  expect(isStudioEditSaving()).toBe(false);
});

it("captures a scaled drag, commits once on release and uses the shown file version", async () => {
  pointer("pointerdown", 60);
  expect(messages[0]).toMatchObject({ phase: "start", x: 0.25, y: 0.5 });
  pointer("pointermove", 76);
  pointer("pointermove", 90);
  expect(state.commitDomEditPatchBatches).not.toHaveBeenCalled();
  expect(messages.at(-1)).toMatchObject({ phase: "move", dx: 0.15, dy: 0 });
  pointer("pointerup", 90);
  pointer("lostpointercapture", 90);
  await reply("start", null);
  await reply("finish", result);
  expect(state.commitDomEditPatchBatches).toHaveBeenCalledExactlyOnceWith([{
    box: expect.objectContaining({ left: 12, top: 34, makeRelative: true }),
    sourceFile: result.sourceFile, ifMatch: '"sha256:' + result.sha256 + '"',
    patches: [{ target: { id: "title" }, operations: [
      { type: "inline-style", property: "position", value: "relative" },
      { type: "inline-style", property: "left", value: "12px" },
      { type: "inline-style", property: "top", value: "34px" },
    ] }],
  }], { label: "Move layer", coalesceKey: messages[0]?.gestureId });
  expect(messages.at(-1)).toMatchObject({ phase: "commit", gestureId: messages[0]?.gestureId, changed: true });
});

it("persists a measured CSS translation without assigning layout coordinates", async () => {
  pointer("pointerdown", 60);
  pointer("pointermove", 90);
  pointer("pointerup", 90);
  await reply("start", null);
  await reply("finish", { ...result, translated: true, left: 12, top: 34 });
  const [batches] = state.commitDomEditPatchBatches.mock.calls[0]!;
  expect(batches[0]).toMatchObject({ patches: [{ target: { id: "title" },
    operations: [{ type: "inline-style", property: "translate", value: "12px 34px" }] }] });
  expect(batches[0]).not.toHaveProperty("box");
  expect(batches[0]).not.toHaveProperty("position");
});

it.each(["finish", "pick"])("accepts a delayed %s reply while the child scene settles", async phase => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    if (phase === "finish") {
      pointer("pointerdown", 60);
      await reply("start", null);
      pointer("pointerup", 90);
    } else {
      act(() => canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 60, clientY: 60 })));
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await reply(phase, result);
    expect(messages.at(-1)?.phase).toBe(phase === "finish" ? "commit" : "open");
    expect(state.showToast).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the first move when capture drops over the canvas with the button still held", async () => {
  vi.spyOn(document, "elementFromPoint").mockReturnValue(canvas);
  pointer("pointerdown", 60, 1);
  pointer("lostpointercapture", 90, 1);
  pointer("pointermove", 90, 1);
  pointer("pointerup", 90);
  expect(messages.map(message => message.phase)).toEqual(["start", "move", "finish"]);
  expect(canvas.setPointerCapture).toHaveBeenCalledTimes(2);
  await reply("start", null);
  await reply("finish", result);
  expect(state.commitDomEditPatchBatches).toHaveBeenCalledTimes(1);
});

it.each(["pointercancel", "lostpointercapture"])("cancels before release on %s", async type => {
  pointer("pointerdown", 60);
  pointer("pointermove", 90);
  pointer(type, 90);
  pointer("pointerup", 90);
  await reply("start", null);
  expect(messages.map(message => message.phase)).toEqual(["start", "move", "cancel"]);
  expect(state.commitDomEditPatchBatches).not.toHaveBeenCalled();
});

it.each(["replacement", "navigation"])("ignores a late finish after frame %s", async change => {
  pointer("pointerdown", 60);
  pointer("pointerup", 90);
  if (change === "replacement") state.previewIframeRef.current = document.createElement("iframe");
  else vi.mocked(frame.getAttribute).mockReturnValue(origin + "/api/projects/project-1/preview?pt=two");
  await reply("start", null);
  await reply("finish", result);
  expect(state.commitDomEditPatchBatches).not.toHaveBeenCalled();
});

it.each([false, true])("accepts a second pointerdown before the first measurement returns (batch %s)", async batch => {
  vi.spyOn(sources, "supportsOrderedTextEdits").mockReturnValue(batch);
  state.commitDomEditPatchBatches.mockResolvedValue({ durable: true, changed: true, savedCanvasVersion: '"patch:next"' });
  pointer("pointerdown", 60);
  pointer("pointerup", 80);
  pointer("pointerdown", 80);
  pointer("pointerup", 100);
  expect(messages.map(m => m.phase)).toEqual(["start", "finish", "start", "finish"]);
  const first = messages[0]!.gestureId;
  const second = messages[2]!.gestureId;
  await reply("finish", result, first);
  await reply("finish", { ...result, predecessor: first, left: 88 }, second);
  expect(state.commitDomEditPatchBatches).toHaveBeenCalledTimes(2);
  expect(state.commitDomEditPatchBatches.mock.calls[1]![0]).toMatchObject([{ ifMatch: batch ? '"sha256:' + result.sha256 + '"' : '"patch:next"', box: { left: 88 } }]);
});

it("keeps nested canvas input open on a server with single versioned writes", async () => {
  vi.spyOn(sources, "supportsProjectTextEdits").mockReturnValue(true);
  vi.spyOn(sources, "supportsOrderedTextEdits").mockReturnValue(false);
  const first = Promise.withResolvers<{durable: boolean; changed: boolean; savedCanvasVersion: string}>();
  state.commitDomEditPatchBatches.mockReturnValueOnce(first.promise);
  for (const left of [100, 130]) {
    pointer("pointerdown", 60);
    pointer("pointerup", 90);
    const starts = messages.filter(m => m.phase === "start");
    expect(starts.at(-1)).toMatchObject({ordered:true});
    await reply("finish", {...result, left, predecessor:starts.at(-2)?.gestureId}, starts.at(-1)!.gestureId);
  }
  expect(state.commitDomEditPatchBatches).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve({durable:true, changed:true, savedCanvasVersion:'"patch:next"'}));
  expect(state.commitDomEditPatchBatches.mock.calls[1]?.[0]).toMatchObject([{ifMatch:'"patch:next"', box:{left:130}}]);
  expect(state.showToast).not.toHaveBeenCalled();
});

it.each([false, true])("does not replace a reported conflict with a preview warning on dependent gestures (batch %s)", async batch => {
  vi.spyOn(sources, "supportsOrderedTextEdits").mockReturnValue(batch);
  vi.spyOn(sources, "supportsProjectTextEdits").mockReturnValue(true);
  const first = Promise.withResolvers<{durable: boolean; changed: boolean}>();
  state.commitDomEditPatchBatches.mockReturnValueOnce(first.promise);
  if (batch) state.commitDomEditPatchBatches.mockReturnValueOnce(first.promise);
  for (const left of [100, 130]) {
    pointer("pointerdown", 60);
    pointer("pointerup", 90);
    const starts = messages.filter(m => m.phase === "start");
    await reply("finish", {...result, left, predecessor:starts.at(-2)?.gestureId}, starts.at(-1)!.gestureId);
  }
  await act(async () => first.reject(new Error("Version conflict")));
  expect(state.commitDomEditPatchBatches).toHaveBeenCalledTimes(batch ? 2 : 1);
  expect(messages.filter(m => m.phase === "cancel")).toHaveLength(2);
  expect(state.showToast).not.toHaveBeenCalled();
});

it("hands consecutive ordered gestures to the project transport before any save acknowledgement", async () => {
  vi.spyOn(sources, "supportsOrderedTextEdits").mockReturnValue(true);
  const first = Promise.withResolvers<{ durable: boolean; changed: boolean }>();
  state.commitDomEditPatchBatches.mockReturnValueOnce(first.promise);
  for (const left of [120, 150, 180]) {
    pointer("pointerdown", 60);
    pointer("pointerup", 90);
    const starts = messages.filter(message => message.phase === "start");
    expect(starts.at(-1)).toMatchObject({ ordered: true });
    await reply("finish", { ...result, left, predecessor: starts.at(-2)?.gestureId }, starts.at(-1)!.gestureId);
  }
  expect(state.commitDomEditPatchBatches.mock.calls.map(call => call[0][0].box.left)).toEqual([120, 150, 180]);
  expect(state.showToast).not.toHaveBeenCalled();
  await act(async () => first.resolve({ durable: true, changed: true }));
});

it.each([false, true])("preserves an interactive document's drag through load until the actual document leaves (navigation %s)", async navigate => {
  observePreviewDocument(frame, "current", false);
  pointer("pointerdown", 60);
  pointer("pointermove", 90);
  act(() => {
    frame.dispatchEvent(new Event("load"));
    observePreviewDocument(frame, "retired", true);
    if (navigate) observePreviewDocument(frame, "current", true);
  });
  pointer("pointerup", 90);
  if (navigate) {
    expect(messages.at(-1)?.phase).toBe("cancel");
    expect(state.showToast).toHaveBeenCalledOnce();
  } else {
    await reply("finish", result);
    expect(state.commitDomEditPatchBatches).toHaveBeenCalledOnce();
    expect(state.showToast).not.toHaveBeenCalled();
  }
});

it("rejects a measurement returned after a same-URL document load", async () => {
  pointer("pointerdown", 60);
  pointer("pointerup", 90);
  act(() => frame.dispatchEvent(new Event("load")));
  await reply("finish", result);
  expect(state.commitDomEditPatchBatches).not.toHaveBeenCalled();
  expect(state.showToast).toHaveBeenCalledOnce();
});

it.each([false, true])("retains both completed drags across preview replacement (batch %s)", async batch => {
  vi.spyOn(sources, "supportsOrderedTextEdits").mockReturnValue(batch);
  const receipt = Promise.withResolvers<{ durable: boolean; savedCanvasVersion: string }>();
  state.commitDomEditPatchBatches.mockReturnValueOnce(receipt.promise);
  pointer("pointerdown", 60);
  pointer("pointerup", 90);
  await reply("start", null);
  await reply("finish", result);
  const predecessor = messages[0]!.gestureId;
  pointer("pointerdown", 70);
  pointer("pointerup", 98);
  await reply("start", null);
  await reply("finish", { ...result, predecessor, left: 110 });
  expect(state.commitDomEditPatchBatches).toHaveBeenCalledTimes(batch ? 2 : 1);
  state.previewIframeRef.current = document.createElement("iframe");
  await act(async () => receipt.resolve({ durable: true, savedCanvasVersion: '"patch:latest"' }));
  expect(state.commitDomEditPatchBatches).toHaveBeenCalledTimes(2);
  expect(state.commitDomEditPatchBatches.mock.calls[1]![0]).toMatchObject([{
    sourceFile: result.sourceFile, ifMatch: batch ? '"sha256:' + result.sha256 + '"' : '"patch:latest"', box: { left: 110 },
    patches: [{ target: { id: result.elementId } }],
  }]);
});

it.each([true, false])("reports a moved but unmeasurable target only when it is waiting for its source (%s)", async waiting => {
  pointer("pointerdown", 60);
  await reply("start", waiting ? { waitingForSource: true } : null);
  pointer("pointerup", 90);
  await reply("finish", null);
  expect(state.showToast).toHaveBeenCalledTimes(waiting ? 1 : 0);
  expect(state.commitDomEditPatchBatches).not.toHaveBeenCalled();
});

it("reports a moved gesture interrupted by the same frame loading another document", () => {
  pointer("pointerdown", 60);
  pointer("pointermove", 90);
  act(() => frame.dispatchEvent(new Event("load")));
  pointer("pointerup", 90);
  expect(state.showToast).toHaveBeenCalledOnce();
  expect(state.commitDomEditPatchBatches).not.toHaveBeenCalled();
});

async function openText() {
  act(() => canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 60, clientY: 60 })));
  const pick = messages.findLast(message => message.type === "inline-text" && message.phase === "pick")!;
  expect(pick).toMatchObject({ x: 0.25, y: 0.5 });
  await reply("pick", result);
  expect(messages.at(-1)).toMatchObject({ type: "inline-text", phase: "open", editId: pick.editId });
  return pick;
}

function finishText(pick: PreviewBridgeMessage, override: Record<string, unknown> = {}) {
  window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow, origin,
    data: { ...pick, source: PREVIEW_BRIDGE_SOURCE, type: "inline-text-finished",
      changed: true, html: "<b>Updated</b>", ...override },
  }));
}

it("persists one text edit against the file and element picked by the user", async () => {
  state.commitDomEditPatchBatches.mockResolvedValue({ changed: true, durable: true });
  const pick = await openText();
  await act(async () => {
    // A frame may supply the new markup. It cannot pick another write target on finish.
    finishText(pick, { sourceFile: "index.html", elementId: "other" });
    finishText(pick);
  });
  expect(state.commitDomEditPatchBatches).toHaveBeenCalledExactlyOnceWith([{
    sourceFile: result.sourceFile, ifMatch: '"sha256:' + result.sha256 + '"',
    patches: [{ target: { id: result.elementId }, operations: [{ type: "rich-text", property: "", value: "<b>Updated</b>" }] }],
  }], { label: "Edit text", coalesceKey: pick.editId });
  expect(messages.at(-1)).toMatchObject({ phase: "commit", editId: pick.editId });
});

it("never saves an unrequested text edit or a completion from a replaced document", async () => {
  const pick = await openText();
  await act(async () => finishText(pick, { editId: "unrequested" }));
  vi.mocked(frame.getAttribute).mockReturnValue(origin + "/api/projects/project-1/preview?pt=two");
  await act(async () => finishText(pick));
  expect(state.commitDomEditPatchBatches).not.toHaveBeenCalled();
});

it("keeps the selected element outlined across frame loads and layout changes until deselection", () => {
  state.domEditSelection = { isolatedBounds: { x: 0.12, y: 0.3, width: 0.32, height: 0.4 } };
  act(() => root.render(<IsolatedCanvasOverlay />));
  const style = (canvas.firstElementChild as HTMLElement).style;
  expect([style.left, style.top, style.width, style.height]).toEqual(["34px", "40px", "64px", "40px"]);
  act(() => frame.dispatchEvent(new Event("load")));
  state.compositionRect = { left: 30, top: 20, width: 300, height: 150 };
  act(() => root.render(<IsolatedCanvasOverlay />));
  expect([style.left, style.top, style.width, style.height]).toEqual(["66px", "65px", "96px", "60px"]);
  expect(messages).toHaveLength(0);
  state.domEditSelection = null;
  act(() => root.render(<IsolatedCanvasOverlay />));
  expect(canvas.firstElementChild).toBeNull();
});

it("applies the latest measured history bounds to the selected target without another inspection", async () => {
  const geometry = { x: -12.5, y: 30, width: 152, height: 78.5 };
  const measured = { applied: true, viewport: { width: 400, height: 200 }, geometry };
  const target = { sourceFile: result.sourceFile, elementId: result.elementId };
  state.domEditSelection = { isolatedTarget: target, isolatedBounds: { x: .1, y: .1, width: .4, height: .4 } };
  act(() => root.render(<IsolatedCanvasOverlay />));
  const older = Promise.withResolvers<SelectionPaintReply>();
  const paint = (request: Parameters<typeof paintWithIsolatedSelection>[4]) =>
    paintWithIsolatedSelection(frame, result.sourceFile, true, () => true, request);
  const late = paint(() => older.promise);
  const send = vi.fn().mockResolvedValue(measured);
  await act(async () => { expect(await paint(send)).toBe(true); });
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(target));
  expect(state.applyDomSelection).toHaveBeenCalledExactlyOnceWith({ ...state.domEditSelection,
    boundingBox: geometry, isolatedBounds: { x: -12.5 / 400, y: .15, width: .38, height: 78.5 / 200 },
  }, { preserveGroup: true, revealPanel: false, announce: false });
  older.resolve({ ...measured, geometry: { ...geometry, x: 99 } });
  await late;
  expect(state.applyDomSelection).toHaveBeenCalledTimes(1);
  expect(messages).toHaveLength(0);
});

it.each(["selection", "gesture"])('ignores a history measurement after a new %s takes ownership', async change => {
  const selection = { isolatedTarget: result, isolatedBounds: { x: .1, y: .1, width: .4, height: .4 } };
  state.domEditSelection = selection;
  act(() => root.render(<IsolatedCanvasOverlay />));
  const reply = Promise.withResolvers<SelectionPaintReply>();
  const paint = paintWithIsolatedSelection(frame, result.sourceFile, true, () => true, () => reply.promise);
  if (change === "gesture") { pointer("pointerdown", 60); pointer("pointerup", 60); }
  else {
    state.domEditSelection = { ...selection, isolatedTarget: { ...result, sourceFile: 'other.html' } };
    act(() => root.render(<IsolatedCanvasOverlay />));
  }
  reply.resolve({ applied: true, geometry: { x: 10, y: 25, width: 60, height: 50 }, viewport: { width: 100, height: 100 } });
  await paint;
  expect(state.applyDomSelection).not.toHaveBeenCalled();
});

it.each([false, true])("only shows handles within the selected clip's interval (descendant %s)", child => {
  const clip = { id: "card", domId: "card", sourceFile: "index.html", start: 1, duration: 2, tag: "div", track: 0 };
  const prior = usePlayerStore.getState().elements;
  const target = { sourceFile: clip.sourceFile, elementId: child ? "title" : clip.id };
  state.domEditSelection = { id: target.elementId, sourceFile: target.sourceFile, isolatedTarget: target,
    isolatedClipOwner: child ? { id: clip.id, sourceFile: clip.sourceFile } : undefined,
    isolatedBounds: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 } };
  try {
    act(() => { liveTime.notify(1); usePlayerStore.setState({ elements: [clip] }); root.render(<IsolatedCanvasOverlay />); });
    expect(canvas.querySelectorAll("[data-resize-corner]")).toHaveLength(4);
    act(() => liveTime.notify(3));
    expect(canvas.firstElementChild).toBeNull();
    act(() => liveTime.notify(2));
    expect(canvas.querySelectorAll("[data-resize-corner]")).toHaveLength(4);
    act(() => usePlayerStore.setState({ elements: [{ ...clip, start: 9 }] }));
    expect(canvas.firstElementChild).toBeNull();
    expect(state.domEditSelection?.id).toBe(target.elementId);
    expect(messages).toHaveLength(0);
  } finally {
    act(() => { liveTime.notify(0); usePlayerStore.setState({ elements: prior }); });
  }
});

it("resizes the selected source target after a replacement frame has forgotten its last hit", () => {
  const target = { sourceFile: "compositions/logo.html", elementId: "logo" };
  state.domEditSelection = { isolatedTarget: target, isolatedBounds: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 } };
  act(() => root.render(<IsolatedCanvasOverlay />));
  const corner = canvas.querySelector('[data-resize-corner="ne"]')!;
  act(() => corner.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true, button:0, isPrimary:true, pointerId:1, clientX:110, clientY:20})));
  expect(messages[0]).toMatchObject({ type:"canvas-drag", phase:"start", corner:"ne", target });
});

it("starts at an exposed selection or handle outside the frame and preserves in-frame picking", () => {
  const target = { sourceFile: "compositions/gallery.html", elementId: "gallery-wall" };
  state.domEditSelection = { isolatedTarget: target, isolatedBounds: { x: -.25, y: .1, width: 1.5, height: .6 } };
  act(() => root.render(<IsolatedCanvasOverlay />));
  const selected = canvas.querySelector<HTMLElement>("[data-isolated-selection]")!;
  function press(node: HTMLElement, clientX: number, clientY: number) {
    act(() => node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX, clientY })));
  }
  press(canvas, -50, 60);
  expect(messages).toHaveLength(0);
  press(selected, -10, 60);
  expect(messages.at(-1)).toMatchObject({ phase: "start", x: -.1, y: .5, target });
  pointer("pointercancel", -10);
  press(selected.querySelector<HTMLElement>('[data-resize-corner="se"]')!, 261, 82);
  expect(messages.at(-1)).toMatchObject({ phase: "start", corner: "se", x: 1.25, y: .7, target });
  pointer("pointermove", 271);
  expect(messages.at(-1)).toMatchObject({ phase: "move", dx: .05 });
  pointer("pointercancel", 271);
  press(selected, 60, 60);
  expect(messages.at(-1)).toMatchObject({ phase: "start", x: .25, y: .5 });
  expect(messages.at(-1)).not.toHaveProperty("target");
});

it("submits a compensated CSS resize as one edit with both dimensions", async () => {
  state.domEditSelection = { isolatedTarget: result, isolatedBounds: { x: .1, y: .1, width: .4, height: .4 } };
  act(() => root.render(<IsolatedCanvasOverlay />));
  const handle = canvas.querySelector<HTMLElement>('[data-resize-corner="nw"]')!;
  act(() => handle.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX: 30, clientY: 20,
  })));
  expect(messages[0]).toMatchObject({phase:"start", corner:"nw", cssResizeOffset:true});
  pointer("pointerup", 15);
  await reply("finish", {...result, corner:"nw", translated:true, width:100, height:70});
  const [batch] = state.commitDomEditPatchBatches.mock.calls[0]![0];
  expect(batch.box).toBeUndefined();
  expect(batch.patches[0].operations).toEqual([
    {type:"inline-style", property:"translate", value:"12px 34px"},
    {type:"inline-style", property:"width", value:"100px"},
    {type:"inline-style", property:"height", value:"70px"},
  ]);
});

it.each(["resize", "projected move"])("outlines the rendered size during a %s and ignores late geometry", async action => {
  state.domEditSelection = { isolatedTarget: result, isolatedBounds: { x: .1, y: .1, width: .4, height: .4 } };
  act(() => root.render(<IsolatedCanvasOverlay />));
  const handle = action === "resize" ? canvas.querySelector<HTMLElement>('[data-resize-corner="se"]')! : canvas;
  act(() => handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX: 110, clientY: 60 })));
  const start = messages[0]!;
  const viewport = { width: 200, height: 100 };
  const geometry = { x: 20, y: 10, width: 80, height: 40 };
  await reply("start", { geometry, viewport, liveResizeBounds: true });
  pointer("pointermove", 145);
  function bounds(width: number, gestureId = start.gestureId) {
    act(() => window.dispatchEvent(new MessageEvent("message", { origin, source: frame.contentWindow, data: {
      ...start, source: PREVIEW_BRIDGE_SOURCE, phase: "bounds", gestureId, geometry: { ...geometry, width }, viewport,
    } })));
  }
  const outline = canvas.querySelector<HTMLElement>("[data-isolated-selection]")!;
  bounds(98, "an-older-gesture");
  expect(outline.style.width).toBe("80px");
  bounds(97);
  expect(outline.style.width).toBe("97px");
  pointer("pointerup", 145);
  await reply("finish", { ...result, ...(action === "resize" && { corner: "se", width: 120, height: 70 }), geometry: { ...geometry, width: 99 }, viewport });
  bounds(92);
  expect(outline.style.width).toBe("99px");
  expect(state.commitDomEditPatchBatches).toHaveBeenCalledTimes(1);
});

it("shows the released bounds even when the initial pick arrives after pointerup", async () => {
  pointer("pointerdown", 60);
  pointer("pointermove", 72);
  pointer("pointerup", 90);
  await reply("start", { geometry: { x: 1, y: 2, width: 20, height: 10 }, viewport: { width: 200, height: 100 } });
  expect((canvas.firstElementChild as HTMLElement).style.left).toBe("41px");
  await reply("finish", result);
});

it.each(["rejection", "unmatched"])("rolls back only the failed gesture on %s", async outcome => {
  const saving = Promise.withResolvers<{ durable: boolean; changed: boolean }>();
  state.commitDomEditPatchBatches.mockReturnValueOnce(saving.promise);
  pointer("pointerdown", 60);
  pointer("pointerup", 90);
  await reply("start", null);
  await reply("finish", result);
  const first = messages[0]?.gestureId;
  expect(messages.map(message => message.phase)).toEqual(["start", "finish"]);

  pointer("pointerdown", 70);
  const second = messages.at(-1)?.gestureId;
  expect(second).not.toEqual(first);
  await reply("start", { geometry: { x: 1, y: 2, width: 20, height: 10 }, viewport: { width: 200, height: 100 } });
  await act(async () => {
    if (outcome === "rejection") saving.reject(new Error("save failed"));
    else saving.resolve({ durable: false, changed: false });
  });
  expect(messages.at(-1)).toMatchObject({ phase: "cancel", gestureId: first });
  expect(canvas.firstElementChild).not.toBeNull();
  pointer("pointermove", 80);
  expect(messages.at(-1)).toMatchObject({ phase: "move", gestureId: second });
});

it("cancels a finish with an invalid write target", async () => {
  pointer("pointerdown", 60);
  pointer("pointerup", 90);
  await reply("start", null);
  await reply("finish", { ...result, sourceFile: "../index.html" });
  expect(state.commitDomEditPatchBatches).not.toHaveBeenCalled();
  expect(messages.at(-1)).toMatchObject({ phase: "cancel", gestureId: messages[0]?.gestureId });
});

it("detaches the retired iframe load listener when a shadow preview is promoted", () => {
  const removeSpy = vi.spyOn(frame, "removeEventListener");
  pointer("pointerdown", 60);
  pointer("pointerup", 60);
  const replacement = document.createElement("iframe");
  act(() => {
    announcePreviewPromoted({ retired: frame, live: replacement });
  });
  expect(removeSpy).toHaveBeenCalledWith("load", expect.any(Function));
});
