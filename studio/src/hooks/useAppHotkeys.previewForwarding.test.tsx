// @vitest-environment happy-dom

import React, { act, useRef } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../components/editor/domEditing";
import { usePlayerStore } from "../player/store/playerStore";
import { useCaptionStore } from "../captions/store";
import { registerCaptionIframe } from "../captions/components/CaptionOverlayUtils";
import { buildCaptionModel } from "../captions/parser";
import { useAppHotkeys } from "./useAppHotkeys";
import { mountReactHarness } from "./domSelectionTestHarness";
import { trackStudioEvent } from "../utils/studioTelemetry";

vi.mock("../utils/studioTelemetry", () => ({ trackStudioEvent: vi.fn() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const domDelete = vi.fn(async () => undefined);
const historyUndo = vi.fn(async () => ({ ok: false }));
const historyRedo = vi.fn(async () => ({ ok: false }));
const settle = vi.fn(async () => undefined);
let root: Root | null = null;
let sync: ((iframe: HTMLIFrameElement | null) => void) | null = null;

function selection(): DomEditSelection {
  const element = document.createElement("section");
  element.id = "card";
  return {
    element,
    id: "card",
    selector: "#card",
    selectorIndex: 0,
    sourceFile: "index.html",
  } as unknown as DomEditSelection;
}

function Harness() {
  const selectionRef = useRef<DomEditSelection | null>(selection());
  const hotkeys = useAppHotkeys({
    projectId: "current",
    handleTimelineElementsDelete: vi.fn(async () => undefined),
    handleTimelineElementSplit: vi.fn(async () => undefined),
    handleDomEditElementDelete: domDelete,
    domEditSelectionRef: selectionRef,
    clearDomSelectionRef: useRef<() => void>(() => undefined),
    editHistory: {
      projectWide: true,
      canUndo: true,
      canRedo: true,
      undo: historyUndo,
      redo: historyRedo,
      state: { undo: [], redo: [] },
    },
    readOptionalProjectFile: vi.fn(async () => ""),
    readProjectFile: vi.fn(async () => ""),
    writeProjectFile: vi.fn(async () => undefined),
    showToast: vi.fn(),
    syncHistoryPreviewAfterApply: vi.fn(async () => undefined),
    settlePendingEdits: settle,
    handleCopy: vi.fn(() => false),
    handlePaste: vi.fn(() => false),
    handleCut: vi.fn(() => false),
    onResetKeyframes: vi.fn(() => false),
    onDeleteSelectedKeyframes: vi.fn(),
    onAfterUndoRedo: vi.fn(),
  } as unknown as Parameters<typeof useAppHotkeys>[0]);
  sync = hotkeys.syncPreviewHotkeys;
  return null;
}

beforeEach(() => {
  usePlayerStore.getState().beginTimelineSession("current");
  usePlayerStore.getState().setTimelineReady(true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  usePlayerStore.getState().reset();
  domDelete.mockClear();
  historyUndo.mockClear();
  historyRedo.mockClear();
  settle.mockReset();
  settle.mockImplementation(async () => undefined);
  vi.mocked(trackStudioEvent).mockClear();
});

describe("preview iframe hotkey forwarding", () => {
  it("still delivers Delete after the preview reloads", () => {
    // A reload keeps the iframe element (no ref callback) and the same
    // WindowProxy (an identity check sees no change) but replaces the window
    // holding the listeners. Attaching once left Delete dead inside the canvas
    // after the first reload — and clicking the canvas is what puts focus there.
    root = mountReactHarness(<Harness />);

    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    act(() => sync?.(iframe));

    // The reload: same element, a window that has lost its listeners.
    act(() => sync?.(iframe));

    const inner = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!inner) throw new Error("expected an iframe window");
    inner.document.body.dispatchEvent(
      new inner.KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );

    expect(domDelete).toHaveBeenCalledTimes(1);
  });

  it("blocks editing shortcuts from the visible canvas until its timeline is ready", () => {
    const inner = mountWithPreview();
    usePlayerStore.getState().setTimelineReady(false);
    const pressDelete = () => inner.document.body.dispatchEvent(new inner.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    pressDelete();
    expect(domDelete).not.toHaveBeenCalled();
    usePlayerStore.getState().setTimelineReady(true);
    pressDelete();
    expect(domDelete).toHaveBeenCalledTimes(1);
  });

  it("allows timeline-owned Backspace deletion once authoredTimelinePath is loaded even before timelineReady", () => {
    const timelineDelete = vi.fn(async () => undefined);
    const clip = { id: "clip-1", key: "clip-1", tag: "video", start: 0, duration: 4, track: 0 };
    function AuthoredHarness() {
      const selectionRef = useRef<DomEditSelection | null>(selection());
      const hotkeys = useAppHotkeys({
        projectId: "current",
        handleTimelineElementsDelete: timelineDelete,
        handleTimelineElementSplit: vi.fn(async () => undefined),
        handleDomEditElementDelete: domDelete,
        domEditSelectionRef: selectionRef,
        clearDomSelectionRef: useRef<() => void>(() => undefined),
        editHistory: {
          projectWide: true,
          canUndo: true,
          canRedo: true,
          undo: historyUndo,
          redo: historyRedo,
          state: { undo: [], redo: [] },
        },
        readOptionalProjectFile: vi.fn(async () => ""),
        readProjectFile: vi.fn(async () => ""),
        writeProjectFile: vi.fn(async () => undefined),
        showToast: vi.fn(),
        syncHistoryPreviewAfterApply: vi.fn(async () => undefined),
        settlePendingEdits: settle,
        handleCopy: vi.fn(() => false),
        handlePaste: vi.fn(() => false),
        handleCut: vi.fn(() => false),
        onResetKeyframes: vi.fn(() => false),
        onDeleteSelectedKeyframes: vi.fn(),
        onAfterUndoRedo: vi.fn(),
      } as unknown as Parameters<typeof useAppHotkeys>[0]);
      sync = hotkeys.syncPreviewHotkeys;
      return null;
    }

    root = mountReactHarness(<AuthoredHarness />);
    usePlayerStore.setState({
      timelineReady: false,
      authoredTimelinePath: "timeline.json",
      elements: [clip],
      selectedElementId: "clip-1",
      selectedElementIds: new Set(["clip-1"]),
      selectionOrigin: "canvas",
    });

    // Canvas-owned Delete stays blocked until timelineReady flips true.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    expect(domDelete).not.toHaveBeenCalled();
    expect(timelineDelete).not.toHaveBeenCalled();

    // Timeline-owned Backspace works as soon as authoredTimelinePath makes the timeline interactive.
    usePlayerStore.getState().setSelectionOrigin("timeline");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    expect(timelineDelete).toHaveBeenCalledTimes(1);
    expect(timelineDelete).toHaveBeenCalledWith([clip]);
    expect(domDelete).not.toHaveBeenCalled();
  });

  function mountWithPreview(): Window & typeof globalThis {
    root = mountReactHarness(<Harness />);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    act(() => sync?.(iframe));
    const inner = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!inner) throw new Error("expected an iframe window");
    return inner;
  }

  async function press(inner: Window & typeof globalThis, init: KeyboardEventInit) {
    await act(async () => {
      inner.document.body.dispatchEvent(
        new inner.KeyboardEvent("keydown", { ...init, bubbles: true }),
      );
    });
  }

  it("blocks a previous project's ready timeline even when the timeline dock is hidden", async () => {
    const inner = mountWithPreview();
    usePlayerStore.getState().beginTimelineSession("previous");
    usePlayerStore.getState().setTimelineReady(true);
    await press(inner, { key: "z", ctrlKey: true });
    await press(inner, { key: "Delete" });
    expect(historyUndo).not.toHaveBeenCalled();
    expect(domDelete).not.toHaveBeenCalled();
  });

  it("undoes a visible caption draft before stepping cloud project history", async () => {
    const inner = mountWithPreview();
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    Object.defineProperty(iframe, "offsetParent", {value: document.body});
    const unregister = registerCaptionIframe({current: iframe});
    const prior = useCaptionStore.getState();
    const model = buildCaptionModel([], { width: 640, height: 360, duration: 5 });
    const changed = { ...model };
    try {
      useCaptionStore.setState({ isEditMode: true, model: changed, past: [model], future: [] });
      await press(inner, {key: "z", ctrlKey: true});
      expect(useCaptionStore.getState().model).toBe(model);
      expect(historyUndo).not.toHaveBeenCalled();
      await press(inner, {key: "z", ctrlKey: true});
      expect(historyUndo).toHaveBeenCalledOnce();
    } finally {
      unregister();
      useCaptionStore.setState(prior);
    }
  });

  it("takes one tracked undo step per Cmd+Z pressed inside the preview", async () => {
    await press(mountWithPreview(), { key: "z", ctrlKey: true });

    expect(historyUndo).toHaveBeenCalledTimes(1);
    expect(trackStudioEvent).toHaveBeenCalledTimes(1);
    expect(trackStudioEvent).toHaveBeenCalledWith("keyboard_shortcut", { action: "undo" });
  });

  it("settles pending edits, failed ones included, before Cmd+Z steps the history", async () => {
    let settled!: () => void;
    settle.mockImplementation(
      () => new Promise<undefined>((resolve) => (settled = () => resolve(undefined))),
    );
    await press(mountWithPreview(), { key: "z", ctrlKey: true });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(historyUndo).not.toHaveBeenCalled();
    await act(async () => settled());
    expect(historyUndo).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Shift+Cmd+Z", { key: "Z", metaKey: true, shiftKey: true }],
    ["Ctrl+Y", { key: "y", ctrlKey: true }],
  ])("takes one tracked redo step per %s pressed inside the preview", async (_, init) => {
    await press(mountWithPreview(), init);

    expect(historyRedo).toHaveBeenCalledTimes(1);
    expect(trackStudioEvent).toHaveBeenCalledTimes(1);
    expect(trackStudioEvent).toHaveBeenCalledWith("keyboard_shortcut", { action: "redo" });
  });

  it("stops handling preview keys once the app unmounts", async () => {
    root = mountReactHarness(<Harness />);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const inner = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!inner) throw new Error("expected an iframe window");
    const add = vi.spyOn(inner, "addEventListener");
    const remove = vi.spyOn(inner, "removeEventListener");
    act(() => sync?.(iframe));
    act(() => root?.unmount());
    root = null;

    await press(inner, { key: "z", ctrlKey: true });

    expect(historyUndo).not.toHaveBeenCalled();
    // happy-dom removes a listener whatever its capture flag; a browser does not, so pin the flag.
    expect(add).toHaveBeenCalled();
    expect(remove.mock.calls).toEqual(add.mock.calls);
  });
});
