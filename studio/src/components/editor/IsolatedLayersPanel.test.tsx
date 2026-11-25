// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PREVIEW_SOURCE_IDENTITY } from "../../../../src/studio/engine/preview-bridge";
import { PREVIEW_LAYERS } from "../../../../src/studio/engine/preview-layers";
import { IsolatedLayersPanel } from "./IsolatedLayersPanel";
import { PREVIEW_BRIDGE_SOURCE } from "../../player/lib/previewAdapter";

vi.mock("../../contexts/DomEditContext", () => ({ useDomEditActionsContext: () => ({ commitDomEditPatchBatches: vi.fn() }) }));
vi.mock("../../contexts/StudioContext", () => ({ useStudioShellContext: () => ({ projectId: "demo", showToast: vi.fn() }) }));
vi.mock("../nle/useCanvasZOrderTimelineMirror", () => ({ useLayerReorderTimelineMirror: () => vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.restoreAllMocks();
});

it("enumerates the authored hierarchy, distinguishes repeated IDs, and rejects detached and expired handles", () => {
  document.body.innerHTML = '<main data-composition-id="main"><section data-hf-group="titles" data-hf-id="group"><span class="animated-letter">runtime-only</span><div><p id="dupe">First</p></div><p id="dupe">Second</p></section><script id="runtime"></script></main>';
  const post = vi.fn();
  const bridge = new Function("describe", "post", "let picked;" + PREVIEW_SOURCE_IDENTITY + PREVIEW_LAYERS +
    "\nreturn { tree: previewLayerTree, select: selectPreviewLayer };")(
    (el: Element) => ({ text: el.textContent }), post);
  bridge.tree({ subscription: "one", limit: 80 });
  const rows = post.mock.calls[0][1].rows;
  expect(rows.map((row: { label: string; depth: number; childCount: number }) =>
    [row.label, row.depth, row.childCount])).toEqual([["titles", 0, 2], ["dupe", 1, 0], ["dupe", 1, 0]]);
  expect(rows[1].key).not.toBe(rows[2].key);
  expect(bridge.select({ subscription: "one", key: rows[2].key })).toBe(true);
  expect(post).toHaveBeenLastCalledWith("select-element", expect.objectContaining({ selection: { text: "Second" } }));
  const point = vi.spyOn(document, "elementFromPoint").mockReturnValue(document.querySelector("p"));
  expect(bridge.select({ x: .25, y: .5 })).toBe(true);
  expect(post).toHaveBeenLastCalledWith("select-element", expect.objectContaining({ selection: { text: "First" } }));
  expect(bridge.select({ x: -1, y: .5 })).toBe(false);
  expect(point).toHaveBeenCalledTimes(1);
  document.querySelector("p")!.remove();
  expect(bridge.select({ subscription: "one", key: rows[1].key })).toBe(false);
  bridge.tree({ subscription: "two", limit: 1 });
  expect(post.mock.lastCall![1].rows).toHaveLength(1);
  expect(bridge.select({ subscription: "one", key: rows[0].key })).toBe(false);
  bridge.tree({ subscription: "two", close: true });
  expect(bridge.select({ subscription: "two", key: rows[0].key })).toBe(false);
});

it("uses verified rows and selection receipts, preserves collapse, and unsubscribes when the panel closes", () => {
  const meta = document.createElement("meta");
  meta.name = "openmotion-preview-origin";
  const origin = meta.content = "https://preview.test";
  document.head.append(meta);
  const frame = document.createElement("iframe");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  vi.spyOn(frame, "getAttribute").mockReturnValue(origin + "/api/projects/demo/preview?pt=lease");
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<IsolatedLayersPanel iframe={frame} />));
  const subscribe = post.mock.calls[0][0];
  const row = { kind: "group", label: "Box", key: "one", depth: 0, childCount: 1, isCompHost: false, z: 0 };
  const rows = [row, { ...row, label: "Title", key: "two", childCount: 0, depth: 1, kind: "text" }];
  const deliver = (fields: object, eventOrigin = origin) => act(() => {
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: eventOrigin,
      data: { ...subscribe, source: PREVIEW_BRIDGE_SOURCE, ...fields } }));
  });
  deliver({ rows }, "https://unrelated.test");
  deliver({ rows, subscription: "retired" });
  expect(host.querySelector("[data-layer-index]")).toBeNull();
  deliver({ rows });
  expect(host.querySelectorAll("[data-layer-index]")).toHaveLength(2);
  const title = host.querySelector<HTMLElement>('[data-layer-index="1"]')!;
  act(() => title.click());
  expect(post.mock.lastCall![0]).toMatchObject({ type: "layer-select", key: "two", subscription: subscribe.subscription });
  expect(title.getAttribute("aria-pressed")).toBe("false");
  deliver({ type: "select-element", layerKey: "two" });
  expect(title.getAttribute("aria-pressed")).toBe("true");
  act(() => host.querySelector<HTMLElement>("[aria-expanded]")!.click());
  deliver({ rows });
  expect(host.querySelectorAll("[data-layer-index]")).toHaveLength(1);
  act(() => root.unmount());
  expect(post.mock.lastCall![0]).toMatchObject({ type: "layer-tree", close: true, subscription: subscribe.subscription });
});
