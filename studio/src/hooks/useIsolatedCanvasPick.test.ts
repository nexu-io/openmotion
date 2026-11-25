// @vitest-environment happy-dom
import React, { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { inspectIsolatedElement } from "../components/editor/isolatedInspector";
import { announcePreviewScenesSwapped } from "../player/sceneSwap";
import { installReactActEnvironment, makeSelection, mountReactHarness } from "./domSelectionTestHarness";
import { useIsolatedCanvasPick } from "./useIsolatedCanvasPick";

vi.mock("../components/editor/isolatedInspector", () => ({ inspectIsolatedElement: vi.fn() }));
vi.mock("../player/lib/projectPreviewAdapter", () => ({ projectPreviewAdapter: () => ({ accepts: () => true }) }));
installReactActEnvironment();
afterEach(() => { vi.resetAllMocks(); document.body.replaceChildren(); });

function harness() {
  const frame = document.createElement("iframe");
  const selectionSequence = { current: 0 };
  const apply = vi.fn();
  const props = { projectId: "one", activeCompPath: "index.html", isMasterView: false, captionEditMode: false,
    previewIframe: frame, previewIframeRef: { current: frame }, selectionSequence, apply };
  function Harness({ projectId = "one" }: { projectId?: string }) {
    useIsolatedCanvasPick({ ...props, projectId });
    return null;
  }
  const root = mountReactHarness(React.createElement(Harness));
  const send = (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { data })); });
  return { apply, frame, selectionSequence,
    pick: (elementId: string) => send({ type: "select-element", inspect: true, selection: { sourceFile: "index.html", elementId } }),
    ready: (sourceReady = "index.html") => send({ type: "inspect-element", sourceReady }),
    switchProject: () => act(() => root.render(React.createElement(Harness, {projectId: "two"}))),
    cleanup: () => act(() => root.unmount()),
  };
}

it("resolves only the last click when its own source version returns", async () => {
  const h = harness();
  try {
    const read = vi.mocked(inspectIsolatedElement).mockResolvedValue(undefined);
    await h.pick("first");
    await h.pick("second");
    await h.ready("unrelated.html");
    expect(read).toHaveBeenCalledTimes(2);
    const current = makeSelection("second", document.createElement("div"));
    read.mockResolvedValue(current);
    await h.ready();
    await h.ready();
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.lastCall?.[1].elementId).toBe("second");
    expect(h.apply.mock.calls).toEqual([[current]]);
  } finally { h.cleanup(); }
});

it("discards picks superseded by an explicit selection or by switching projects", async () => {
  const h = harness();
  try {
    const read = vi.mocked(inspectIsolatedElement).mockResolvedValue(undefined);
    await h.pick("before-clear");
    h.selectionSequence.current++;
    await h.ready();
    await h.pick("before-project-switch");
    h.switchProject();
    await act(async () => { announcePreviewScenesSwapped(h.frame); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.apply).not.toHaveBeenCalled();
  } finally { h.cleanup(); }
});
