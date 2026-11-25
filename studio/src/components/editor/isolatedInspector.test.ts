// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { PREVIEW_SOURCE_IDENTITY } from "../../../../src/studio/engine/preview-bridge";
import { PREVIEW_INSPECTOR } from "../../../../src/studio/engine/preview-inspector";
import type { PreviewAdapter } from "../../player/lib/previewAdapter";
import { inspectIsolatedElement } from "./isolatedInspector";
import { planIsolatedLayerReorder } from "./isolatedLayerReorder";

const sha256 = "b".repeat(64);
function mountInspector(html: string, sourceVersion: string, post = vi.fn()) {
  document.body.innerHTML = html;
  return new Function("sourceFileForElement","describe","sourceVersions","picked","inlineVariableOwner","post",
    PREVIEW_SOURCE_IDENTITY + PREVIEW_INSPECTOR + "\nreturn {request: inspectPreviewElement, notify: notifyInspectorSourceReady};")(
      (el: HTMLElement) => el.closest("[data-file]")?.getAttribute("data-file") || "index.html",
      (el: HTMLElement) => ({ sourceFile: "index.html", elementId: el.id, geometry: { x: 1, y: 2, width: 4, height: 5 }, viewport: { width: 100, height: 50 } }),
      { "index.html": sourceVersion }, null, () => null, post);
}
function inspect(html: string, lookup: {elementId: string; sourceFile?: string}, sourceVersion = sha256) {
  const {request} = mountInspector(html, sourceVersion);
  const adapter = { request: vi.fn(async (_command, payload) => request(payload)) } as unknown as PreviewAdapter;
  return inspectIsolatedElement(adapter, lookup, false);
}
afterEach(() => document.body.replaceChildren());

it("keeps untransformed layout offsets for grouping, separately from the displayed rectangle", async () => {
  const mocks = [
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 4 }] as unknown as DOMRectList),
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(15),
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(30),
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100),
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(50),
  ];
  try {
    const selection = await inspect('<div id="t"></div>', { elementId: "t" });
    expect(selection?.boundingBox).toEqual({ x: 1, y: 2, width: 4, height: 5 });
    expect(selection?.isolatedLayoutBox).toEqual({ x: 15, y: 30, width: 100, height: 50 });
    expect(selection?.isolatedBounds).toEqual({ x: 0.01, y: 0.04, width: 0.04, height: 0.1 });
  } finally {
    for (const mock of mocks) mock.mockRestore();
  }
});

it("projects only the requested authored layer, with caret text and presentation facts in an inert document", async () => {
  const selection = await inspect('<h1 id="t" style="color:red" onclick="ignored()">A &amp; B</h1>', {elementId:"t"});
  expect(selection?.textFields[0]).toMatchObject({ source: "self", value: "A & B" });
  expect(selection?.inlineStyles.color).toBe("red");
  expect(selection?.element.ownerDocument.defaultView).toBeNull();
  expect(selection?.element.getAttribute("onclick")).toBeNull();
  expect(selection?.isolatedTarget?.sha256).toBe(sha256);
  expect(await inspect('<p id="t">first</p><p id="t">second</p>', {elementId:"t"})).toBeNull();
  expect(await inspect('<p id="t">word</p>', {elementId:"t",sourceFile:"missing.html"})).toBeNull();
});

it("reads the intrinsic duration from loaded preview media", async () => {
  const duration = vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(2.375);
  try {
    const selection = await inspect('<video id="clip"></video>', {elementId: "clip"});
    expect(selection?.intrinsicMediaDuration).toBe(2.375);
    expect(selection?.dataAttributes["source-duration"]).toBeUndefined();
  } finally {
    duration.mockRestore();
  }
});

it("distinguishes a mounted target awaiting its saved version from a removed target", async () => {
  const html = '<h1 id="title">Title</h1>';
  const target = { elementId: "title" };
  expect(await inspect(html, target, "")).toBeUndefined();
  expect((await inspect(html, target))?.id).toBe("title");
  expect(await inspect('<p id="other">Other</p>', target)).toBeNull();
});

it("wakes the host once only when a requested source becomes readable", () => {
  const post = vi.fn();
  const {request, notify} = mountInspector('<h1 id="title">Title</h1>', "", post);
  notify("index.html");
  expect(request({elementId: "title"})).toBeUndefined();
  notify("another.html");
  expect(post).not.toHaveBeenCalled();
  notify("index.html");
  notify("index.html");
  expect(post.mock.calls).toEqual([["inspect-element", { sourceReady: "index.html" }]]);
});

it("accepts a preview produced from a patch revision without a content digest", async () => {
  const version = '"patch:' + 'c'.repeat(64) + '"';
  const selection = await inspect('<h1 id="p">Title</h1>', {elementId:"p"}, version);
  expect(selection?.isolatedTarget?.fileVersion).toBe(version);
  expect(selection?.isolatedTarget?.sha256).toBeUndefined();
});

it("keeps empty shapes out of text editing and preserves media controls without copying resource URLs", async () => {
  expect((await inspect('<p id="p"></p>', {elementId:"p"}))?.textFields[0]?.value).toBe("");
  expect((await inspect('<h1 id="p">One<br>two</h1>', {elementId:"p"}))?.textFields[0]).toMatchObject({
    value: "One\ntwo", preserveLineBreaks: true });
  expect((await inspect('<div id="shape"></div>',{elementId:"shape"}))?.textFields).toEqual([]);
  const selection = await inspect('<video id="v" loop muted src="https://preview.example/asset?pt=temp" data-volume=".5"></video>',{elementId:"v"});
  expect(selection?.tagName).toBe("video");
  expect(selection?.element.hasAttribute("loop")).toBe(true);
  expect(selection?.element.hasAttribute("muted")).toBe(true);
  expect(selection?.element.hasAttribute("src")).toBe(false);
  expect(selection?.dataAttributes.volume).toBe(".5");
});

it("computes layer drag patches with the native z resolver and refuses a locked or cross-parent destination", () => {
  const family = ["a","b","c"].map((element, domIndex) => ({ element, domIndex, zIndex: domIndex, locked: false,
    makeRelative: true, elementId: element, sourceFile: "index.html", sha256 }));
  const plan = planIsolatedLayerReorder(family, ["c","b","a"], 2, 0);
  expect(plan?.batches).toMatchObject([{ sourceFile: "index.html", ifMatch: '"sha256:'+sha256+'"',
    patches: [{ target: {id:"a"}, operations: [{property:"position",value:"relative"},{property:"z-index",value:"3"}] }] }]);
  expect(planIsolatedLayerReorder(family, ["other-parent","a"], 1, 0)).toBeNull();
  family[0].locked = true;
  expect(planIsolatedLayerReorder(family, ["c","b","a"], 2, 0)).toBeNull();
});

it("returns the timed clip owning a selected descendant", async () => {
  const selected = await inspect('<main><div id="card" data-hf-id="hf-card" class="clip"><span id="title">Name</span></div></main>', { elementId: "title" });
  expect(selected?.isolatedClipOwner).toEqual({ id: "card", hfId: "hf-card", sourceFile: "index.html" });
});
