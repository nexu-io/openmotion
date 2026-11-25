// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore } from "../player/store/playerStore";
import type { TimelineElement } from "../player/store/timelineElement";
import { markStudioWriteToken } from "../utils/studioFileVersion";
import {
  beginStudioManualEditGesture,
  endStudioManualEditGesture,
} from "../components/editor/manualEdits";
import { mountReactHarness } from "./domSelectionTestHarness";
import { usePreviewPersistence } from "./usePreviewPersistence";
import { rememberPeerTimingDocument } from "../player/peerTimingPreview";
import { hasPendingHistoryTimeline } from "../player/timelineRestorePending";
import { rememberSource, forgetSource } from "../utils/confirmedTextSources";
import { parseAuthoredTimeline } from "../player/lib/authoredTimeline";
import { beginPeerTimelineUpdate, beginTimelineSourceRead, openTimelineSource } from "../player/lib/peerTimeline";
import { trackStudioPendingEdit } from "../utils/studioPendingEdits";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  usePlayerStore.getState().reset();
});

describe("undo that reloads the preview", () => {
  it("leaves the preview and GSAP caches alone for notes and reloads only affected compositions", async () => {
    const reloadPreview = vi.fn();
    const invalidateHistoryCompositions = vi.fn();
    let sync!: ReturnType<typeof usePreviewPersistence>["syncHistoryPreviewAfterApply"];
    function Harness() {
      sync = usePreviewPersistence({
        showToast: vi.fn(), readOptionalProjectFile: async () => "", writeProjectFile: vi.fn(),
        recordEdit: vi.fn(), previewIframeRef: { current: null }, activeCompPathRef: { current: "index.html" },
        reloadPreview, invalidateHistoryCompositions,
      }).syncHistoryPreviewAfterApply;
      return null;
    }
    mountReactHarness(<Harness />);
    await act(() => sync({ paths: ["qa-history-1.txt", "motion-assets.json"] }));
    expect(reloadPreview).not.toHaveBeenCalled();
    expect(invalidateHistoryCompositions).not.toHaveBeenCalled();
    await act(() => sync({ paths: ["qa-history-1.txt", "compositions/intro.html"] }));
    expect(invalidateHistoryCompositions).toHaveBeenLastCalledWith(["compositions/intro.html", "index.html"]);
    expect(reloadPreview).toHaveBeenCalledTimes(1);
    await act(() => sync({ paths: [".hyperframes/studio-motion.json", "theme.css"] }));
    expect(invalidateHistoryCompositions).toHaveBeenLastCalledWith(["index.html"]);
    expect(reloadPreview).toHaveBeenCalledTimes(2);
  });
  it("keeps the timeline's clips and selection until the reloaded preview reports its own", async () => {
    const clips = [{ id: "a" }, { id: "b" }] as unknown as TimelineElement[];
    usePlayerStore.getState().setElements(clips);
    usePlayerStore.getState().setTimelineReady(true);
    usePlayerStore.getState().setSelectedElementId("a");
    const reloadPreview = vi.fn();
    let sync: ReturnType<typeof usePreviewPersistence>["syncHistoryPreviewAfterApply"] | null =
      null;
    function Harness() {
      sync = usePreviewPersistence({
        showToast: () => {},
        readOptionalProjectFile: async () => "",
        writeProjectFile: async () => {},
        recordEdit: async () => {},
        previewIframeRef: { current: null },
        activeCompPathRef: { current: "index.html" },
        reloadPreview,
      }).syncHistoryPreviewAfterApply;
      return null;
    }
    mountReactHarness(<Harness />);

    // A nested composition's undo is not the active file's, so it reloads the preview.
    const files = { "compositions/sub.html": { previous: "<p>1</p>", restored: "<p>2</p>" } };
    await act(async () => sync!({ paths: Object.keys(files), files }));

    expect(reloadPreview).toHaveBeenCalledTimes(1);
    const player = usePlayerStore.getState();
    expect([player.elements, player.timelineReady, player.selectedElementId]).toEqual([
      clips,
      true,
      "a",
    ]);
  });
});

describe("undo that re-runs the top-level script over an element of a nested composition", () => {
  const script = (width: number) =>
    `var tl = gsap.timeline({ paused: true }); tl.to("#nwid", { width: ${width} }); window.__timelines["root"] = tl;`;
  const page = (width: number) =>
    `<html><body><div id="root" data-composition-id="root"></div><script>${script(width)}</script></body></html>`;
  const SUB = `<template><div data-composition-id="sub"><div id="nwid" data-hf-id="hf-n" style="left: 40px"></div></div></template>`;

  // The live preview: the top-level timeline tweened the nested element's width inline.
  function nestedPreview() {
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML =
      `<div id="root" data-composition-id="root"><div data-composition-file="compositions/sub.html">` +
      `<div id="nwid" data-hf-id="hf-n" style="left: 40px; width: 337px"></div></div></div>` +
      `<script>${script(400)}</script>`;
    const nwid = doc.getElementById("nwid")!;
    const contentWindow = {
      gsap: { timeline: vi.fn(), set: vi.fn() },
      __hfForceTimelineRebind: vi.fn(),
      __timelines: {
        root: {
          kill: vi.fn(),
          getChildren: () => [{ targets: () => [nwid], vars: { width: 400 } }],
        },
      } as Record<string, unknown>,
      __player: { getTime: () => 1, seek: vi.fn() },
      __hfStudioManualEditsApply: vi.fn(),
    };
    return {
      iframe: { contentWindow, contentDocument: doc } as unknown as HTMLIFrameElement,
      nwid,
    };
  }

  async function undo(fileOk: boolean, projectId: string | null = "p1", duringRead?: (target: Element) => void) {
    const { iframe, nwid } = nestedPreview();
    const reloadPreview = vi.fn();
    const fetch = vi.fn(async () => {
      duringRead?.(nwid);
      return { ok: fileOk, json: async () => ({ content: SUB }) };
    });
    vi.stubGlobal("fetch", fetch);
    if (projectId) usePlayerStore.getState().beginTimelineSession(projectId);
    else usePlayerStore.setState({ timelineProjectId: null });
    let sync: ReturnType<typeof usePreviewPersistence>["syncHistoryPreviewAfterApply"] | null =
      null;
    function Harness() {
      sync = usePreviewPersistence({
        showToast: () => {},
        readOptionalProjectFile: async () => "",
        writeProjectFile: async () => {},
        recordEdit: async () => {},
        previewIframeRef: { current: iframe },
        activeCompPathRef: { current: "index.html" },
        reloadPreview,
      }).syncHistoryPreviewAfterApply;
      return null;
    }
    mountReactHarness(<Harness />);
    const files = { "index.html": { previous: page(400), restored: page(450) } };
    await act(async () => sync!({ paths: Object.keys(files), files }));
    vi.unstubAllGlobals();
    return { nwid, reloadPreview, fetch };
  }

  it("restores the element from its own composition file", async () => {
    const { nwid, reloadPreview, fetch } = await undo(true);

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/files/compositions%2Fsub.html"), {
      credentials: "omit",
    });
    expect(reloadPreview).not.toHaveBeenCalled();
    expect(nwid.getAttribute("style")).toBe("left: 40px;");
  });

  it("does not apply an old restore after a project switch during a nested read", async () => {
    const { nwid, reloadPreview } = await undo(true, "p1", () => usePlayerStore.setState({ timelineProjectId: "another-project" }));
    expect(nwid.getAttribute("style")).toBe("left: 40px; width: 337px");
    expect(reloadPreview).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves a newer edit during a nested read (file readable: %s)", async (fileOk) => {
    const clips = [{ id: "newer-edit" }] as unknown as TimelineElement[];
    const { nwid, reloadPreview } = await undo(fileOk, "p1", target => {
      markStudioWriteToken("newer-edit-during-history-read");
      target.setAttribute("style", "left: 40px; width: 512px");
      usePlayerStore.getState().setElements(clips);
    });

    expect(nwid.getAttribute("style")).toBe("left: 40px; width: 512px");
    expect(usePlayerStore.getState().elements).toBe(clips);
    expect(reloadPreview).not.toHaveBeenCalled();
  });

  it("defers a restore if a new gesture starts while nested dependencies are being read", async () => {
    const { nwid, reloadPreview } = await undo(true, "p1", target => beginStudioManualEditGesture(target, "move"));
    expect(nwid.getAttribute("style")).toBe("left: 40px; width: 337px");
    expect(reloadPreview).not.toHaveBeenCalled();
    endStudioManualEditGesture(nwid);
    expect(reloadPreview).toHaveBeenCalledOnce();
  });

  it("reloads the preview in full when that file cannot be read", async () => {
    const { nwid, reloadPreview } = await undo(false);

    expect(reloadPreview).toHaveBeenCalledTimes(1);
    expect(nwid.getAttribute("style")).toBe("left: 40px; width: 337px");
  });

  it("reloads the preview in full when no project is open to read that file from", async () => {
    const { nwid, reloadPreview, fetch } = await undo(true, null);

    expect(fetch).not.toHaveBeenCalled();
    expect(reloadPreview).toHaveBeenCalledTimes(1);
    expect(nwid.getAttribute("style")).toBe("left: 40px; width: 337px");
  });
});

describe("undo that lands while a newer gesture holds an element", () => {
  const page = (left: number) =>
    `<html><body><div id="root" data-composition-id="root"><div id="box" data-hf-id="hf-b" style="left: ${left}px"></div></div></body></html>`;
  const files = { "index.html": { previous: page(0), restored: page(200) } };

  function heldPreview(held = true) {
    const doc = document.implementation.createHTMLDocument("");
    doc.head.innerHTML = `<meta name="hf-scene-parts" content='{"shared":"s1","scenes":{}}'>`;
    doc.body.innerHTML = `<div id="root" data-composition-id="root"><div id="box" data-hf-id="hf-b" style="left: 90px"></div></div>`;
    const box = doc.getElementById("box")!;
    if (held) beginStudioManualEditGesture(box, "move");
    const contentWindow = {
      __hfForceTimelineRebind: vi.fn(),
      __timelines: {},
      __player: { getTime: () => 1, seek: vi.fn() },
      __hfStudioManualEditsApply: vi.fn(),
    };
    const iframe = { contentWindow, contentDocument: doc } as unknown as HTMLIFrameElement;
    const reloadPreview = vi.fn();
    let hook: ReturnType<typeof usePreviewPersistence> | null = null;
    function Harness() {
      hook = usePreviewPersistence({
        showToast: () => {},
        readOptionalProjectFile: async () => "",
        writeProjectFile: async () => {},
        recordEdit: async () => {},
        previewIframeRef: { current: iframe },
        activeCompPathRef: { current: "index.html" },
        reloadPreview,
      });
      return null;
    }
    mountReactHarness(<Harness />);
    usePlayerStore.getState().setSelectedElementId("box");
    const sharedPart = () =>
      JSON.parse(doc.querySelector<HTMLMetaElement>('meta[name="hf-scene-parts"]')!.content).shared;
    return { box, win: contentWindow, reloadPreview, sharedPart, hook: () => hook! };
  }

  it("leaves the held element where the gesture drew it and reloads the preview once it ends", async () => {
    const { box, win, reloadPreview, sharedPart, hook } = heldPreview();

    await act(async () => hook().syncHistoryPreviewAfterApply({ paths: ["index.html"], files }));

    expect(box.style.left).toBe("90px");
    expect(win.__player.seek).not.toHaveBeenCalled();
    expect(win.__hfStudioManualEditsApply).not.toHaveBeenCalled();
    expect(reloadPreview).not.toHaveBeenCalled();
    endStudioManualEditGesture(box);
    expect(reloadPreview).toHaveBeenCalledTimes(1);
    // The scene swap must load the restored file again, not keep the part it showed before the undo.
    expect(sharedPart()).toBe("");
    expect(usePlayerStore.getState().selectedElementId).toBe("box");
  });

  it("does not paint a predicted undo under the gesture", () => {
    const { box, win, hook } = heldPreview();

    expect(hook().showHistoryRestoreNow(files)).toBeNull();
    expect(box.style.left).toBe("90px");
    expect(win.__player.seek).not.toHaveBeenCalled();
  });

  it("puts a refused predicted undo back through the preview reload once a gesture took the element", async () => {
    const { box, win, reloadPreview, hook } = heldPreview(false);
    const putBack = hook().showHistoryRestoreNow(files)!;
    beginStudioManualEditGesture(box, "move");
    win.__player.seek.mockClear();

    putBack();
    await act(async () => {});
    expect(reloadPreview).not.toHaveBeenCalled();
    endStudioManualEditGesture(box);

    expect(reloadPreview).toHaveBeenCalledTimes(1);
    expect(win.__player.seek).not.toHaveBeenCalled();
  });
});

it("paints soft-restored timing immediately and puts a refused prediction back without a runtime message", async () => {
  const page = (start: number) => `<html><body><div data-composition-id="root" data-duration="20"><div id="clip" data-hf-id="hf-clip" data-start="${start}" data-duration="4"></div></div></body></html>`;
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = new DOMParser().parseFromString(page(5), "text/html").body.innerHTML;
  const iframe = {
    contentDocument: doc,
    contentWindow: { __hfForceTimelineRebind: vi.fn(), __timelines: {}, __player: { seek: vi.fn() } },
  } as unknown as HTMLIFrameElement;
  usePlayerStore.setState({ elements: [{ id: "clip", key: "index.html#clip", domId: "clip", hfId: "hf-clip", sourceFile: "index.html", tag: "div", start: 5, duration: 4, track: 0 }], duration: 20 });
  const reload = vi.fn();
  let hook!: ReturnType<typeof usePreviewPersistence>;
  function Harness() {
    hook = usePreviewPersistence({ showToast: () => {}, readOptionalProjectFile: async () => "", writeProjectFile: async () => {}, recordEdit: async () => {}, previewIframeRef: { current: iframe }, activeCompPathRef: { current: null }, reloadPreview: reload });
    return null;
  }
  mountReactHarness(<Harness />);
  const files = { "index.html": { previous: page(5), restored: page(2) } };
  const putBack = hook.showHistoryRestoreNow(files)!;
  expect(putBack).not.toBeNull();
  expect(usePlayerStore.getState().elements[0].start).toBe(2);
  putBack();
  expect(usePlayerStore.getState().elements[0].start).toBe(5);
  await act(() => hook.syncHistoryPreviewAfterApply({ paths: ["index.html"], files }));
  expect(usePlayerStore.getState().elements[0].start).toBe(2);
  expect(reload).not.toHaveBeenCalled();
});

it("restores split/delete clip structure before the replacement preview has loaded", async () => {
  const page = (clips: string) => `<main data-composition-id="root" data-duration="10">${clips}</main>`;
  const a = '<audio id="a" data-start="0" data-duration="4"></audio>';
  const b = '<audio id="b" data-start="4" data-duration="4"></audio>';
  const iframe = document.createElement("iframe"); document.body.append(iframe);
  iframe.contentDocument!.body.innerHTML = page(a + b);
  const row = (id: string, start: number): TimelineElement => ({ id, key: `index.html#${id}`, sourceFile: "index.html", domId: id, tag: "audio", start, duration: 4, track: 0 });
  usePlayerStore.setState({ elements: [row("a", 0), row("b", 4)], duration: 10, timelineReady: true, currentTime: 2 });
  const reload = vi.fn();
  let hook!: ReturnType<typeof usePreviewPersistence>;
  function Harness() {
    hook = usePreviewPersistence({ showToast: () => {}, readOptionalProjectFile: async () => "", writeProjectFile: async () => {}, recordEdit: async () => {}, previewIframeRef: { current: iframe }, activeCompPathRef: { current: null }, reloadPreview: reload });
    return null;
  }
  mountReactHarness(<Harness />);
  await act(() => hook.syncHistoryPreviewAfterApply({ files: { "index.html": { previous: page(a + b), restored: page(a.replace('data-duration="4"', 'data-duration="8"')) } } }));
  expect(reload).toHaveBeenCalledOnce();
  expect(usePlayerStore.getState().elements.map(e => [e.id, e.duration])).toEqual([["a", 8]]);
  expect(usePlayerStore.getState()).toMatchObject({ timelineReady: true, currentTime: 2 });
  // The old preview is deliberately still split, awaiting its asynchronous replacement.
  expect(iframe.contentDocument!.querySelectorAll("audio")).toHaveLength(2);
});

it.each([3.334, 3.33])("projects a saved move at %s into a cross-origin timeline immediately and preserves a later drag on refusal", (start) => {
  const path = 'index.html', project = 'project-history-geometry';
  const html = (t: number) => `<main data-composition-id="root" data-duration="12"><audio id="song" data-start="${t}" data-duration="4"></audio></main>`;
  const iframe = document.body.appendChild(document.createElement('iframe'));
  Object.defineProperty(iframe, 'src', {value:`https://preview.test/api/projects/${project}/preview?pt=grant`});
  Object.defineProperty(iframe, 'contentDocument', {value:null});
  vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
  const mounted = '"sha256:' + 'a'.repeat(64) + '"';
  rememberPeerTimingDocument(iframe,'grant','test-document',undefined,{},false,{[path]:mounted});
  rememberSource(project,path,{content:html(1), version:mounted});
  const element = {id:'song', key:'index.html#song', sourceFile:path, domId:'song', tag:'audio', start, duration:4, track:0};
  usePlayerStore.setState({timelineProjectId:project, elements:[element], duration:12, currentTime:8});
  let hook!: ReturnType<typeof usePreviewPersistence>;
  function Harness() {
    hook = usePreviewPersistence({showToast:vi.fn(), readOptionalProjectFile:async () => '', writeProjectFile:vi.fn(), recordEdit:vi.fn(), previewIframeRef:{current:iframe}, activeCompPathRef:{current:path}, reloadPreview:vi.fn()});
    return null;
  }
  mountReactHarness(<Harness />);
  const files = {[path]:{previous:html(start),restored:html(1),versions:{previous:new Set([mounted]),restored:mounted}}};
  const rollback = hook.showHistoryRestoreNow(files,true)!;
  expect(usePlayerStore.getState().elements[0].start).toBe(1);
  expect(hasPendingHistoryTimeline(iframe)).toBe(true);
  usePlayerStore.getState().updateElement(element.key,{start:6});
  rollback();
  expect(usePlayerStore.getState().elements[0].start).toBe(6);
  expect(usePlayerStore.getState().currentTime).toBe(8);
  expect(hasPendingHistoryTimeline(iframe)).toBe(false);
  forgetSource(project,path);
});

describe("project history for a split title in an isolated preview", () => {
  const project = "split-title-history", path = "index.html";
  const title = (id: string, start: number, duration: number) =>
    `<h1 id="${id}" data-hf-id="hf-${id}" data-track-index="0" data-start="${start}" data-duration="${duration}">Title</h1>`;
  const page = (body: string) => `<main data-composition-id="root" data-duration="8">${body}</main>`;
  const whole = page(title("title", 0, 8));
  const split = page(title("title", 0, 3.17) + title("right", 3.17, 4.83));
  const runtimeRow: TimelineElement = { id: "generated", key: "index.html#generated", tag: "audio", start: 0, duration: 8, track: 1 };
  const intervals = () => usePlayerStore.getState().elements.filter(row => row.tag === "h1").map(row => [row.id, row.start, row.duration, row.track]);
  const wholeIntervals = [["title", 0, 8, 0]];
  const splitIntervals = [["title", 0, 3.17, 0], ["right", 3.17, 4.83, 0]];

  function setup(previous: string, restored: string) {
    const iframe = document.body.appendChild(document.createElement("iframe"));
    Object.defineProperty(iframe, "src", {value:`https://preview.test/api/projects/${project}/preview?pt=grant`});
    Object.defineProperty(iframe, "contentDocument", {value:null});
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const mounted = '"sha256:' + 'a'.repeat(64) + '"';
    rememberPeerTimingDocument(iframe, "grant", "split-document", undefined, {}, false, {[path]:mounted});
    const rows = parseAuthoredTimeline(previous, path, project)!.elements.map(row => ({ ...row, sourceDuration: 42 }));
    usePlayerStore.setState({ timelineProjectId:project, elements:[...rows, runtimeRow], duration:8 });
    const close = openTimelineSource(project, path);
    let hook!: ReturnType<typeof usePreviewPersistence>;
    function Harness() {
      hook = usePreviewPersistence({ showToast:vi.fn(), readOptionalProjectFile:async () => "", writeProjectFile:vi.fn(), recordEdit:vi.fn(), previewIframeRef:{current:iframe}, activeCompPathRef:{current:path}, reloadPreview:vi.fn() });
      return null;
    }
    mountReactHarness(<Harness />);
    const files = {[path]:{previous, restored, versions:{previous:new Set([mounted]), previousVersion:mounted, restored:'"restored"'}}};
    return { predict: () => hook.showHistoryRestoreNow(files, true)!, close };
  }

  it.each([
    { action: "undo", previous: split, restored: whole, before: splitIntervals, after: wholeIntervals },
    { action: "redo", previous: whole, restored: split, before: wholeIntervals, after: splitIntervals },
  ])("publishes the complete $action before acknowledgement and restores the original rows on refusal", ({previous, restored, before, after}) => {
    const {predict, close} = setup(previous, restored);
    const published = vi.fn();
    const unsubscribe = usePlayerStore.subscribe(published);
    const putBack = predict();
    expect(intervals()).toEqual(after);
    expect(published).toHaveBeenCalledTimes(1);
    // A separate edit may land while the server decides the prediction.
    usePlayerStore.getState().updateElement(runtimeRow.key!, {volume: 0.5});
    published.mockClear();
    putBack();
    expect(intervals()).toEqual(before);
    expect(published).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().elements.find(row => row.id === "generated")?.volume).toBe(0.5);
    expect(usePlayerStore.getState().elements.filter(row => row.tag === "h1").every(row => row.sourceDuration === 42)).toBe(true);
    unsubscribe();
    close();
  });

  it.each([
    {start: 4}, {text: {value: "Edited title"}}, {volume: 0.5},
  ])("defers the whole prediction when the removed half has a newer edit (%o)", edit => {
    const {predict, close} = setup(split, whole);
    usePlayerStore.getState().updateElement("index.html#right", edit);
    const rows = usePlayerStore.getState().elements;
    predict();
    expect(usePlayerStore.getState().elements).toBe(rows);
    close();
  });

  it("defers the whole prediction while a write is outstanding", async () => {
    const {predict, close} = setup(split, whole);
    const pending = Promise.withResolvers<void>();
    trackStudioPendingEdit(pending.promise);
    const rows = usePlayerStore.getState().elements;
    try {
      predict();
      expect(usePlayerStore.getState().elements).toBe(rows);
    } finally {
      pending.resolve();
      await pending.promise;
      close();
    }
  });

  it("drops a provisional redo's right half when a peer sends a different whole title", () => {
    const {predict, close} = setup(whole, split);
    const putBack = predict();
    expect(intervals()).toEqual(splitIntervals);
    beginTimelineSourceRead(project, path)(whole);
    putBack.supersede?.();
    beginPeerTimelineUpdate(project, path)!(page(title("title", 0, 7)), null);
    expect(intervals()).toEqual([["title", 0, 7, 0]]);
    expect(usePlayerStore.getState().elements).toContain(runtimeRow);
    close();
  });
});
