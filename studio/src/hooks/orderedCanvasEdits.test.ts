// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { OrderedTextEditOperation } from "../../../shared/ordered-text-edits";
import { applyTextPatch } from "../../../shared/text-patch";
import { parseGsapAnimationsFromHtml } from "../../../packages/edit-core/gsap-mutations";
import { rememberSource, observeEditAssets } from "../utils/confirmedTextSources";
import { projectedTimelineText } from "../utils/orderedTimelineEdits";
import { setCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { makeSelection } from "./domSelectionTestHarness";
import { saveOrderedGsapEdit } from "./orderedGsapEdits";
import { savePreparedDomEdit } from "./orderedDomEdit";
import { saveLayerOrder } from "./orderedLayerReorder";
import { submitIsolatedCanvasEdit } from "./submitIsolatedCanvasEdit";
import * as committedPreview from "../player/committedPreview";

afterEach(() => {
  setCachedCloudDisklessMode(null);
  vi.unstubAllGlobals();
});

const path = "index.html";
function delayedCloud(project: string, initial: string) {
  setCachedCloudDisklessMode(true);
  if (!initial.includes("data-composition-id="))
    initial = '<main data-composition-id="main" data-duration="8">' + initial + "</main>";
  rememberSource(project, path, { content: initial, version: "v0" });
  const gate = Promise.withResolvers<void>();
  let source = initial;
  const operations: OrderedTextEditOperation[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (!String(url).endsWith("/text-edits/batch")) throw new Error("unexpected request " + url);
    const packet: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
    operations.push(...packet);
    await gate.promise;
    return Response.json({
      committed: packet.map((op) => {
        const file = op.files[0]!;
        source = "patch" in file ? applyTextPatch(source, file.patch) : file.content;
        return { id: op.id, versions: { [path]: op.id }, changedPaths: [path] };
      }),
    });
  });
  return { operations, release: gate.resolve, source: () => source };
}

it("reuses the source read by a cold canvas edit when presenting its receipt", async () => {
  const project = "cold-canvas-preview", path = "scene.html", html = '<div id="picture"></div>';
  setCachedCloudDisklessMode(true);
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push(String(url));
    if (String(url).endsWith("/files/scene.html")) return Response.json({ content: html, version: "v0" }, {
      headers: { "X-OpenMotion-Text-Edits": "1", "X-OpenMotion-Ordered-Edits": "1" },
    });
    const [op] = JSON.parse(String(init.body)).operations;
    return Response.json({ committed: [{ id: op.id, versions: { [path]: "v1" }, changedPaths: [path] }] });
  });
  const frame = document.createElement("iframe");
  const present = vi.spyOn(committedPreview, "scheduleCommittedPreview").mockImplementation(() => {});
  try {
    await submitIsolatedCanvasEdit(project, [{kind: "moveCanvasElement", compositionPath: path,
      target: { id: "picture" }, delta: { x: 12, y: 0 }}], { [path]: "v0" }, undefined, { current: frame }, () => {});
    expect(sent).toHaveLength(2);
    expect(present.mock.calls[0]?.[2]).toMatchObject([{ path, previous: { content: html, version: "v0" }, current: { version: "v1" } }]);
  } finally {
    present.mockRestore();
  }
});

it("keeps a newer confirmed peer revision when the canvas write response arrives late", async () => {
  const project = "peer-before-canvas-receipt";
  const server = delayedCloud(project, '<div id="picture"></div>');
  const frame = document.createElement("iframe");
  const present = vi.spyOn(committedPreview, "scheduleCommittedPreview").mockImplementation(() => {});
  try {
    const save = submitIsolatedCanvasEdit(project, [{ kind: "moveCanvasElement", compositionPath: path,
      target: { id: "picture" }, delta: { x: 12, y: 0 } }], { [path]: "v0" }, undefined, { current: frame }, () => {});
    await vi.waitFor(() => expect(server.operations).toHaveLength(1));
    rememberSource(project, path, { content: '<div id="picture">Peer edit</div>', version: "peer" });
    server.release();
    expect((await save).changedPaths).toEqual([path]);
    expect(present).not.toHaveBeenCalled();
  } finally {
    server.release();
    present.mockRestore();
  }
});

it("adds a target id with its tween and projects another animation before the first response", async () => {
  const project = "ordered-gsap-burst";
  const markup =
    '<body><div data-composition-id="scene"><p data-hf-id="one">One</p><p data-hf-id="two">Two</p></div></body>';
  const server = delayedCloud(project, markup);
  const doc = new DOMParser().parseFromString(markup, "text/html");
  const paint = vi.fn();
  const history = vi.fn(async () => {});
  const save = (key: string) => {
    const el = doc.querySelector<HTMLElement>('[data-hf-id="' + key + '"]')!;
    const selection = { ...makeSelection(key, el), hfId: key };
    return saveOrderedGsapEdit(
      project,
      path,
      selection,
      [
        {
          type: "add",
          targetSelector: "#unused",
          method: "to",
          position: 0,
          duration: 2,
          properties: { opacity: 0.4 },
        },
      ],
      { label: "Add " + key, ensureTargetId: "card-" + key },
      undefined,
      history,
      paint,
      () => {},
    );
  };
  const first = save("one"),
    second = save("two");
  try {
    await vi.waitFor(() => expect(paint).toHaveBeenCalledTimes(2));
    expect(doc.getElementById("card-one")).toBeTruthy();
    expect(doc.getElementById("card-two")).toBeTruthy();
    expect(history).not.toHaveBeenCalled();
    const local = await projectedTimelineText(project, path);
    expect(
      parseGsapAnimationsFromHtml(local!).animations.map((animation) => animation.targetSelector),
    ).toEqual(["#card-one", "#card-two"]);
  } finally {
    server.release();
    await Promise.all([first, second]);
  }
  expect(server.operations.map((op) => op.files[0]!.baseVersion)).toEqual([
    "v0",
    { after: server.operations[0]!.id },
  ]);
  expect(parseGsapAnimationsFromHtml(server.source()).animations).toHaveLength(2);
  expect(history).toHaveBeenCalledTimes(2);
});

it("applies a linked speed change once and guards replacement media by its observed asset version", async () => {
  const project = "ordered-media-properties";
  const source =
    '<video id="v" data-hf-id="v" src="v.mp4" data-start="0" data-duration="8" data-link="pair"></video>' +
    '<audio id="a" data-hf-id="a" src="v.mp4" data-start="0" data-duration="8" data-link="pair"></audio>';
  const server = delayedCloud(project, source);
  observeEditAssets(project, { "new.mp4": { version: "new-asset", mimeType: "video/mp4" } });
  const view = {
    frame: { current: null },
    projectId: { current: project },
    activePath: path,
    refresh: vi.fn(),
  };
  const history = vi.fn(async () => {});
  const speed = { kind: "setClipSpeed", hfId: "v", rate: 2, includeLinked: true } as const;
  const media = {
    kind: "replaceAsset",
    hfId: "v",
    assetPath: "new.mp4",
    expectedAssetPath: "v.mp4",
  } as const;
  const first = savePreparedDomEdit(
    project,
    { ...speed, compositionPath: path },
    "v0",
    {
      projectEdit: speed,
      prepareContent: () => {
        throw new Error("rate applied twice");
      },
      validateContent: () => {},
    },
    { label: "Speed", windowId: "s" },
    history,
    view,
  );
  const second = savePreparedDomEdit(
    project,
    { ...media, compositionPath: path },
    "v0",
    { projectEdit: media },
    { label: "Replace media", windowId: "r" },
    history,
    view,
  );
  try {
    const doc = new DOMParser().parseFromString((await projectedTimelineText(project, path))!, "text/html");
    for (const el of doc.querySelectorAll("video,audio")) {
      expect(el.getAttribute("data-playback-rate")).toBe("2");
      expect(el.getAttribute("data-duration")).toBe("4");
    }
    expect(doc.querySelector("video")?.getAttribute("src")).toBe("new.mp4");
    expect(history).not.toHaveBeenCalled();
  } finally {
    server.release();
    await Promise.all([first, second]);
  }
  expect(server.operations[1].dependencies).toEqual({ "new.mp4": "new-asset" });
  expect(server.operations[1].files[0].baseVersion).toEqual({ after: server.operations[0].id });
});

it("commits a layer's canvas and timeline order as one operation", async () => {
  const project = "atomic-canvas-lane";
  const source = '<div id="a" data-hf-id="a" data-start="0" data-duration="2" data-track-index="0"></div>';
  const server = delayedCloud(project, source);
  const element = {
    id: "a",
    hfId: "a",
    sourceFile: path,
    tag: "div",
    start: 0,
    track: 0,
    duration: 2,
  } as import("../player/store/timelineElement").TimelineElement;
  const history = vi.fn(async () => {});
  const save = saveLayerOrder(
    project,
    [
      {
        compositionPath: path,
        kind: "editElements",
        patches: [
          { target: { hfId: "a" }, operations: [{ type: "inline-style", property: "z-index", value: "4" }] },
        ],
      },
    ],
    { [path]: "v0" },
    [{ element, updates: { start: 0, track: 3 } }],
    path,
    {
      label: "Reorder layers",
      coalesceKey: "z1",
      recordEdit: history,
      frame: { current: null },
      refresh: vi.fn(),
    },
  );
  try {
    const doc = new DOMParser().parseFromString((await projectedTimelineText(project, path))!, "text/html");
    const layer = doc.getElementById("a")!;
    expect(layer.style.zIndex).toBe("4");
    expect(layer.getAttribute("data-track-index")).toBe("3");
    expect(history).not.toHaveBeenCalled();
  } finally {
    server.release();
    await save;
  }
  expect(server.operations).toHaveLength(1);
  expect(history).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "keeps the inspector edit in the next animation's visible document (earlier packet already in flight %s)",
  async (inFlight) => {
    const { tryStudioCommandPatches } = await import("../utils/studioTextEdits");
    const project = "mixed-inspector-animation-" + inFlight;
    const source = '<main data-composition-id="scene"><p id="one" data-hf-id="one">One</p></main>';
    const server = delayedCloud(project, source);
    const el = new DOMParser().parseFromString(source, "text/html").querySelector<HTMLElement>("p")!;
    const selection = { ...makeSelection("one", el), hfId: "one" };
    const paint = vi.fn();
    const first = tryStudioCommandPatches(
      project,
      [
        {
          compositionPath: path,
          kind: "editElements",
          patches: [
            {
              target: { hfId: "one" },
              operations: [{ type: "inline-style", property: "color", value: "red" }],
            },
          ],
        },
      ],
      { [path]: "v0" },
    );
    if (inFlight) await vi.waitFor(() => expect(server.operations).toHaveLength(1));
    const next = saveOrderedGsapEdit(
      project,
      path,
      selection,
      [
        {
          type: "add",
          method: "to",
          targetSelector: "#one",
          properties: { opacity: 0.5 },
          position: 0,
          duration: 1,
        },
      ],
      { label: "Add animation" },
      undefined,
      async () => {},
      paint,
      () => {},
    );
    try {
      await vi.waitFor(() => expect(paint).toHaveBeenCalledOnce());
      const draft = paint.mock.calls[0][0].after;
      const visible = new DOMParser().parseFromString(draft, "text/html");
      expect(visible.getElementById(selection.id!)?.style.color).toBe("red");
      expect(parseGsapAnimationsFromHtml(draft).animations).toHaveLength(1);
      expect(selection.element).toBe(el);
    } finally {
      server.release();
      await Promise.all([first, next]);
    }
    expect(server.operations[1].files[0].baseVersion).toEqual(
      inFlight ? server.operations[0].id : { after: server.operations[0].id },
    );
    expect(server.source()).toContain("red");
    expect(parseGsapAnimationsFromHtml(server.source()).animations).toHaveLength(1);
  },
);

it("presents the final inspector bytes to the animation preview even when the inspector owns the last receipt", async () => {
  const { tryStudioCommandPatches } = await import("../utils/studioTextEdits");
  const project = "mixed-animation-inspector";
  const source = '<main data-composition-id="scene"><p id="one" data-hf-id="one">One</p></main>';
  const server = delayedCloud(project, source);
  const target = new DOMParser().parseFromString(source, "text/html").getElementById("one")!;
  const confirm = vi.fn();
  const animation = saveOrderedGsapEdit(
    project,
    path,
    { ...makeSelection("one", target), hfId: "one" },
    [
      {
        type: "add",
        method: "to",
        targetSelector: "#one",
        properties: { opacity: 0.5 },
        duration: 1,
        position: 0,
      },
    ],
    { label: "Add animation" },
    undefined,
    async () => {},
    () => {},
    confirm,
  );
  const style = tryStudioCommandPatches(
    project,
    [
      {
        compositionPath: path,
        kind: "editElements",
        patches: [
          {
            target: { hfId: "one" },
            operations: [{ type: "inline-style", property: "color", value: "blue" }],
          },
        ],
      },
    ],
    { [path]: "v0" },
  );
  try {
    const draft = (await projectedTimelineText(project, path))!;
    expect(draft).toContain("blue");
    expect(parseGsapAnimationsFromHtml(draft).animations).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
  } finally {
    server.release();
    await Promise.all([animation, style]);
  }
  expect(confirm).toHaveBeenCalledOnce();
  expect(confirm.mock.calls[0][0].after).toBe(server.source());
});
