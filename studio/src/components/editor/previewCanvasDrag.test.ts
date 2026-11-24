// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { PREVIEW_INSPECTOR } from "../../../../src/studio/engine/preview-inspector";
import { PREVIEW_SOURCE_IDENTITY } from "../../../../src/studio/engine/preview-bridge";
import { PREVIEW_SCENE_GESTURES } from "../../../../src/studio/engine/preview-scene-gestures";
import { PREVIEW_CANVAS_DRAG } from "../../../../src/studio/engine/preview-canvas-drag";
import { canvasBoxOperations } from "../../../../packages/edit-core/canvas-box";

const originalHash = "a".repeat(64);

function createScene(declarative = false, position = false, tag = "div", cssLayoutOffset = false) {
  const makeElement = (id: string) => {
    const element = document.createElement(tag);
    element.id = id;
    document.body.append(element);
    vi.spyOn(element, "getBoundingClientRect").mockImplementation(() =>
      new DOMRect(parseFloat(element.style.left) || 0, parseFloat(element.style.top) || 0, parseFloat(element.style.width) || 20, parseFloat(element.style.height) || 10));
    return element;
  };
  const elements = ["one", "two"].map(makeElement);
  vi.spyOn(document, "elementFromPoint").mockImplementation(x => elements[x < 50 ? 0 : 1]!);
  // Execute the exact child-frame script with deterministic layout measurements.
  const { dispatch, inline, swap } = new Function("document", "getComputedStyle", "HTMLElement", "sourceVersions", "describe",
    "innerWidth", "innerHeight", "picked", "timingDocumentId", "compositionPath", "settings", "sourceFileForElement",
    PREVIEW_SOURCE_IDENTITY + PREVIEW_INSPECTOR + PREVIEW_CANVAS_DRAG + PREVIEW_SCENE_GESTURES + `
      let applyingSceneUpdate = null;
      function editInlineText(m) { return m.phase === 'pick' ? sourceVersions['one.html'] : null; }
      return { dispatch: sceneCanvasDrag, inline: sceneInlineText, swap(path, version, ready) {
        const host = document.getElementById('one');
        applyingSceneUpdate = { targets: new Map([[path,{host}]]), versions: {[path]:version},
          ready:ready.then(applied => {
            if (applied !== false) confirmCanvasVersion(path,version);
            applyingSceneUpdate = null;
            return applied !== false;
          }) };
      }};
    `)(
    document, (el: HTMLElement) => ({ position: el.style.position || "static", visibility: el.style.visibility, left: el.style.left, top: el.style.top, width: "20px", height: "10px", transform: el.style.transform || "none", display: el.style.display || "block", animationName: el.style.animationName, translate: el.style.translate || "none" }),
    HTMLElement, { "one.html": originalHash, "two.html": originalHash },
    (el: HTMLElement) => ({ sourceFile: el.id + ".html", elementId: el.id, geometry: el.getBoundingClientRect(),
      viewport: { width: 100, height: 100 } }), 100, 100, elements[0], declarative ? "frame" : undefined, "one.html", {liveEdits: {position, cssLayoutOffset}}, (el: HTMLElement) => el.id + ".html",
  );
  return { one: elements[0]!, two: elements[1]!, inline, swap, makeElement,
    gesture: (phase: string, gestureId: string, fields: Record<string, unknown> = {}) =>
      dispatch({ phase, gestureId, x: 0, y: 0, dx: 0.25, dy: 0.5, cssLayoutOffset: true, ...fields }) };
}

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it.each([ [true, false], [false, false], [true, true] ])("uses only a free translation on verified CSS layout animation (%s, %s)", (verified, ownsTranslate) => {
  const { one, gesture } = createScene(false, true, "div", verified);
  one.style.animationName = "slide";
  one.style.position = "absolute";
  one.style.translate = "3px 4px";
  Object.defineProperty(one, "getAnimations", { value: () => [{ effect: { target: one,
    getKeyframes: () => [{ left: "12px", ...(ownsTranslate && { translate: "2px" }) }] } }] });
  vi.mocked(one.getBoundingClientRect).mockImplementation(() => {
    const [x,y] = one.style.translate.split(" ").map(parseFloat);
    return new DOMRect(12 + x!, y, 20, 10);
  });
  if (!verified || ownsTranslate) {
    expect(gesture("start", "move")).toBeNull();
    expect(one.style.translate).toBe("3px 4px");
    return;
  }
  // An already-open Studio with an older bridge contract cannot persist this coordinate space.
  expect(gesture("start", "old-host", {cssLayoutOffset: false})).toBeNull();
  vi.stubGlobal("gsap", {getProperty: () => { throw Error("GSAP must not normalize the authored translate"); }});
  try {
    expect(gesture("start", "move")).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
  gesture("move", "move");
  expect(one.style.translate).toBe("28px 54px");
  const finish = gesture("finish", "move", {wholePath: true});
  expect(finish).toMatchObject({translated:true,left:28,top:54});
  expect(finish).not.toHaveProperty("position");
  expect(one.style.left).toBe("");
  expect(one.style.top).toBe("");
  gesture("cancel", "move");
  expect(one.style.translate).toBe("3px 4px");
});

it("moves immediately across pending saves and rolls back dependent measurements together", () => {
  const {one, gesture} = createScene(true);
  gesture("start", "first");
  gesture("finish", "first");
  expect(gesture("start", "second")).toBeTruthy();
  expect(gesture("finish", "second")).toMatchObject({ predecessor: "first", left: 50 });
  expect(gesture("start", "third")).toBeTruthy();
  gesture("move", "third");
  expect(one.style.left).toBe("75px");
  gesture("cancel", "first");
  expect(one.style.left).toBe("");
  expect(gesture("finish", "third")).toBeNull();
  expect(gesture("start", "retry")).toBeTruthy();
});

it.each(["text", "position", "deleted", "cancelled"])("settles a drag during a scene swap with a concurrent %s change", async change => {
  const {one, swap, gesture, makeElement} = createScene();
  one.style.position = "absolute";
  one.style.left = "80px";
  const version = "b".repeat(64);
  const {promise, resolve} = Promise.withResolvers<void>();
  swap("one.html", version, promise);
  expect(gesture("start", "active")).toBeTruthy();
  gesture("move", "active");
  expect(one.style.left).toBe("105px");
  const result = gesture("finish", "active");
  if (change === "cancelled") gesture("cancel", "active");
  one.remove();
  const next = makeElement(change === "deleted" ? "new" : "one");
  next.style.position = "absolute";
  next.style.left = change === "position" ? "180px" : "80px";
  next.textContent = "New title";
  resolve();
  if (change === "text") {
    expect(await result).toMatchObject({elementId:"one", left:105, sha256:version});
    expect(next.style.left).toBe("105px");
  } else {
    expect(await result).toBeNull();
    expect(next.style.left).toBe(change === "position" ? "180px" : "80px");
  }
  expect(next.textContent).toBe("New title");
});

it.each([false, true])("replays a CSS layout move only while the replacement keeps its translation basis (%s)", async changed => {
  const {one, makeElement, swap, gesture} = createScene(false, true, "div", true);
  function animate(element: HTMLElement, offset: string) {
    element.style.position = "absolute";
    element.style.animationName = "slide";
    element.style.translate = offset;
    Object.defineProperty(element, "getAnimations", {value: () => [{effect: {target:element, getKeyframes: () => [{left:"12px"}]}}]});
    vi.mocked(element.getBoundingClientRect).mockImplementation(() => {
      const [x, y] = element.style.translate.split(" ").map(parseFloat);
      return new DOMRect(12 + x!, y, 20, 10);
    });
  }
  animate(one, "3px 4px");
  const {promise, resolve} = Promise.withResolvers<void>();
  const version = "b".repeat(64);
  swap("one.html", version, promise);
  expect(gesture("start", "first", {ordered:true})).toBeTruthy();
  const first = gesture("finish", "first");
  expect(gesture("start", "second", {ordered:true})).toBeTruthy();
  const second = gesture("finish", "second");
  one.remove();
  const next = makeElement("one");
  animate(next, changed ? "40px 4px" : "3px 4px");
  resolve();
  if (changed) {
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(next.style.translate).toBe("40px 4px");
  } else {
    expect(await first).toMatchObject({translated:true, left:28, top:54, sha256:version});
    expect(await second).toMatchObject({translated:true, left:53, top:104});
    expect(next.style.translate).toBe("53px 104px");
  }
});

it.each(["before", "after", "across"])("keeps two ordered releases made %s the incoming host mounts", async timing => {
  const {one, swap, gesture, makeElement} = createScene();
  one.style.position = "absolute";
  const version = "b".repeat(64);
  const {promise, resolve} = Promise.withResolvers<void>();
  swap("one.html", version, promise);
  function replace() {
    one.remove();
    const next = makeElement("one");
    next.style.position = "absolute";
    vi.mocked(document.elementFromPoint).mockReturnValue(next);
    return next;
  }
  let next = timing === "after" ? replace() : one;
  expect(gesture("start", "first", {ordered:true})).toBeTruthy();
  const replies: string[] = [];
  const first = gesture("finish", "first").then((reply: unknown) => { replies.push("first"); return reply; });
  if (timing === "across") next = replace();
  expect(gesture("start", "second", {ordered:true})).toBeTruthy();
  const second = gesture("finish", "second").then((reply: unknown) => { replies.push("second"); return reply; });
  expect(next.style.left).toBe("50px");
  if (timing === "before") next = replace();
  resolve();
  expect(await first).toMatchObject({elementId:"one", left:25, sha256:version});
  expect(await second).toMatchObject({elementId:"one", left:50, sha256:version, predecessor:"first"});
  expect(next.style.left).toBe("50px");
  expect(replies).toEqual(["first", "second"]);
});

it("restores the visible release when the incoming host mounts without another pointer event", async () => {
  const {one, swap, gesture, makeElement} = createScene();
  one.style.position = "absolute";
  const { promise, resolve } = Promise.withResolvers<void>();
  swap("one.html", "b".repeat(64), promise);
  gesture("start", "first", {ordered:true});
  const first = gesture("finish", "first");
  one.remove();
  const next = makeElement("one");
  next.style.position = "absolute";
  await vi.waitFor(() => expect(next.style.left).toBe("25px"));
  resolve();
  expect(await first).toMatchObject({left:25});
});

it.each(["moved", "cancelled", "expired"])("cleans up a %s release spanning the two hosts", async reason => {
  const {one, swap, gesture, makeElement} = createScene();
  one.style.position = "absolute";
  const { promise, resolve } = Promise.withResolvers<boolean>();
  swap("one.html", "b".repeat(64), promise);
  gesture("start", "first", {ordered:true});
  const first = gesture("finish", "first");
  one.remove();
  const next = makeElement("one");
  next.style.position = "absolute";
  if (reason === "moved") next.style.left = "100px";
  vi.mocked(document.elementFromPoint).mockReturnValue(next);
  gesture("start", "second", {ordered:true});
  const second = gesture("finish", "second");
  if (reason === "cancelled") gesture("cancel", "first");
  resolve(reason !== "expired");
  expect(await first).toBeNull();
  if (reason === "moved") {
    expect(await second).toMatchObject({left:125});
    expect(next.style.left).toBe("125px");
    gesture("commit", "second");
  } else {
    expect(await second).toBeNull();
    expect(next.style.left).toBe("");
  }
  expect(gesture("start", "retry", {ordered:true})).toBeTruthy();
});

it.each(["same layer", "other layer", "cancelled"])("opens the inline caret after the swap only on the original hit (%s)", async state => {
  const {one, two, swap, inline, makeElement} = createScene();
  const version = "b".repeat(64);
  const {promise, resolve} = Promise.withResolvers<void>();
  swap("one.html", version, promise);
  const message = {phase:"pick", editId:"text", x:0, y:0};
  const result = inline(message);
  if (state === "cancelled") inline({...message, phase:"cancel"});
  one.remove();
  const next = makeElement("one");
  vi.mocked(document.elementFromPoint).mockReturnValue(state === "other layer" ? two : next);
  resolve();
  expect(await result).toBe(state === "same layer" ? version : null);
});

it("chains certified nested moves without requiring the active root", () => {
  const { two, gesture } = createScene(false, true);
  two.style.position = "absolute";
  expect(gesture("start", "first", { x: 1 })).toBeTruthy();
  gesture("finish", "first");
  expect(gesture("start", "second", { x: 1 })).toBeTruthy();
  expect(gesture("finish", "second")).toMatchObject({ predecessor: "first", left: 50 });
  gesture("cancel", "first");
  expect(two.style.left).toBe("");
});

it("holds the released layer, allows an unrelated source to move, and waits for a fresh digest on the saved source", () => {
  const { one, two, gesture } = createScene();
  expect(gesture("start", "first")).toBeTruthy();
  expect(gesture("finish", "first")).toMatchObject({ sourceFile: "one.html", sha256: originalHash, left: 25, top: 50 });
  expect(one.style.left).toBe("25px");
  expect(gesture("start", "same-source")).toEqual({ waitingForSource: true });
  expect(gesture("start", "second", { x: 1 })).toBeTruthy();
  gesture("move", "second");
  gesture("commit", "first", { changed: true });
  gesture("cancel", "first");
  expect(one.style.left).toBe("25px");
  expect(two.style.left).toBe("25px");
  gesture("cancel", "second");
  expect(two.style.left).toBe("");
  expect(gesture("start", "stale-source")).toEqual({ waitingForSource: true });
});

it("captures the playhead and final local translation once at gesture completion", () => {
  vi.stubGlobal("__player", {getTime: () => 2});
  vi.stubGlobal("gsap", {getProperty: (_: Element, axis: string) => axis === "x" ? 5 : 10});
  try {
    const {gesture} = createScene();
    gesture("start", "animated");
    expect(gesture("move", "animated")).toBeNull();
    expect(gesture("finish", "animated")).toMatchObject({position:{time:2, x:30, y:60}});
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rolls back only properties still owned by the failed gesture and permits a retry", () => {
  const { one, gesture } = createScene();
  one.style.setProperty("top", "4px", "important");
  one.style.position = "absolute";
  gesture("start", "first");
  gesture("finish", "first");
  one.style.left = "100px";
  gesture("cancel", "first");
  expect(one.style.left).toBe("100px");
  expect(one.style.top).toBe("4px");
  expect(one.style.getPropertyPriority("top")).toBe("important");
  expect(gesture("start", "retry")).toBeTruthy();
  expect(gesture("finish", "retry")).toMatchObject({ left: 125, top: 54, sha256: originalHash });
  gesture("cancel", "first");
  expect(one.style.left).toBe("125px");
  gesture("commit", "retry", { changed: false });
  expect(gesture("start", "after-noop")).toBeTruthy();
});


it("returns a whole-path delta when auto-keyframe is off, independently of the current tween translation", () => {
  const { gesture } = createScene();
  vi.stubGlobal("gsap", { getProperty: () => 80 });
  try {
    expect(gesture("start","path")).toBeTruthy();
    expect(gesture("finish","path",{wholePath:true})).toMatchObject({position:{time:0,delta:{x:25,y:50}}});
  } finally {
    vi.unstubAllGlobals();
  }
});

it("resizes the selected corner and rolls back a rejected gesture", () => {
  const { one, gesture } = createScene();
  expect(gesture("start", "s", {corner:"se"})).toBeTruthy();
  expect(gesture("finish", "s")).toMatchObject({corner:"se",width:45,height:60});
  expect(one.style.width).toBe("45px");
  expect(one.style.left).toBe("");
  gesture("cancel", "s");
  expect(one.style.width).toBe("");
  expect(gesture("start", "n", {corner:"nw"})).toBeTruthy();
  expect(gesture("finish","n",{dx:-.1,dy:-.05})).toMatchObject({corner:"nw",left:-10,top:-5,width:30,height:15});
});

it("keeps the opposite corner of a transformed layer fixed while dragging and after replay", () => {
  const { one, gesture } = createScene();
  const px = (value: string, fallback: number) => value ? parseFloat(value) : fallback;
  vi.mocked(one.getBoundingClientRect).mockImplementation(() => {
    const w = px(one.style.width, 20), h = px(one.style.height, 10);
    // A skewed element scaled around its center.
    const boundsW = 1.5 * w + .25 * h, boundsH = .2 * w + 1.25 * h;
    return new DOMRect(px(one.style.left, 0) + (w - boundsW) / 2,
      px(one.style.top, 0) + (h - boundsH) / 2, boundsW, boundsH);
  });
  const before = one.getBoundingClientRect();
  expect(gesture("start", "resize", { corner: "se" })).toBeTruthy();
  vi.mocked(one.getBoundingClientRect).mockClear();
  gesture("move", "resize", { dx: .2, dy: .12 });
  expect(one.getBoundingClientRect).not.toHaveBeenCalled();
  const during = one.getBoundingClientRect();
  expect(during.left).toBeCloseTo(before.left, 2);
  expect(during.top).toBeCloseTo(before.top, 2);
  expect(during.right).toBeCloseTo(before.right + 20, 2);
  expect(during.bottom).toBeCloseTo(before.bottom + 12, 2);
  const result = gesture("finish", "resize", { dx: .2, dy: .12 });
  expect(result.extraAxes).toBe("xy");
  one.removeAttribute("style");
  for (const op of canvasBoxOperations(result)) one.style.setProperty(op.property, op.value);
  expect(one.getBoundingClientRect().toJSON()).toEqual(during.toJSON());
});

it("keeps a projected corner under the pointer and persists the opposite corner correction", () => {
  const { one, gesture } = createScene();
  one.style.transform = "matrix3d(1,0,0,.002,0,1,0,0,0,0,1,0,0,0,0,1)";
  const layout = vi.mocked(one.getBoundingClientRect).mockImplementation(() => {
    const width = parseFloat(one.style.width) || 20, height = parseFloat(one.style.height) || 10;
    const depth = 1 + width * .002;
    // Projected corners have different depths as the plane grows around its center.
    return new DOMRect((parseFloat(one.style.left) || 0) + (width - width / depth) / 2,
      (parseFloat(one.style.top) || 0) + (height - height / depth) / 2, width / depth, height / depth);
  });
  const before = layout();
  expect(gesture("start", "projected", {corner: "se"})).toBeTruthy();
  layout.mockClear();
  gesture("move", "projected", {dx: .62, dy: .37});
  expect(layout.mock.calls.length).toBeLessThanOrEqual(4);
  const during = layout();
  expect(Math.abs(during.left - before.left)).toBeLessThan(.2);
  expect(Math.abs(during.top - before.top)).toBeLessThan(.2);
  expect(Math.abs(during.right - before.right - 62)).toBeLessThan(.2);
  expect(Math.abs(during.bottom - before.bottom - 37)).toBeLessThan(.2);

  const result = gesture("finish", "projected", {dx: .62, dy: .37});
  expect(result.extraAxes).toBe("xy");
  gesture("cancel", "projected");
  expect(layout().toJSON()).toEqual(before.toJSON());
  for (const op of canvasBoxOperations(result)) one.style.setProperty(op.property, op.value);
  expect(layout().toJSON()).toEqual(during.toJSON());
});

it.each([44.9, 45, 45.1])("keeps a small drag bounded at a %s degree rotation", angle => {
  const { one, gesture } = createScene();
  const cos = Math.cos(angle * Math.PI / 180), sin = Math.sin(angle * Math.PI / 180);
  vi.mocked(one.getBoundingClientRect).mockImplementation(() => {
    const w = parseFloat(one.style.width) || 20, h = parseFloat(one.style.height) || 10;
    return new DOMRect(parseFloat(one.style.left) || 0, parseFloat(one.style.top) || 0, cos*w+sin*h, sin*w+cos*h);
  });
  const before = one.getBoundingClientRect();
  expect(gesture("start", "diagonal", {corner:"se"})).toBeTruthy();
  const result = gesture("finish", "diagonal", {dx:.14,dy:.09});
  expect(result.width / 20).toBeCloseTo(result.height / 10, 3);
  expect(result.geometry.width - before.width).toBeCloseTo(11.5, 1);
  expect(result.geometry.height - before.height).toBeCloseTo(11.5, 1);
});

it("cannot resize an invisible target from a stale handle, including a target hidden mid-gesture", () => {
  const { one, gesture } = createScene(true);
  const corner = { corner: "se" };
  one.style.visibility = "hidden";
  expect(gesture("start", "hidden", corner)).toBeNull();
  one.style.visibility = "visible";
  expect(gesture("start", "moving", corner)).toBeTruthy();
  gesture("move", "moving");
  expect(one.style.width).not.toBe("");
  one.style.visibility = "hidden";
  expect(gesture("finish", "moving")).toBeNull();
  expect(one.style.width).toBe("");
});

it.each(["canvas", "img", "video", "span"])("respects intrinsic sizing for inline %s elements", tag => {
  const {one, gesture} = createScene(true, false, tag);
  one.style.display = "inline";
  const start = gesture("start", "corner", {corner:"se"});
  if (tag === "span") {
    expect(start).toBeNull();
    return;
  }
  expect(start).toBeTruthy();
  expect(gesture("finish", "corner")).toMatchObject({corner:"se", width:45, height:60});
});

it("measures ordered moves and resizes against the displayed box before any receipt", () => {
  const { one, gesture } = createScene(false, false, "canvas");
  one.style.position = "absolute";
  gesture("start", "move", { ordered: true });
  expect(gesture("finish", "move")).toMatchObject({ left: 25, sha256: originalHash });
  gesture("start", "size", { ordered: true, corner: "se" });
  expect(gesture("finish", "size")).toMatchObject({ width: 45, left: 25, sha256: originalHash });
  gesture("commit", "move", { changed: true });
  expect(one.style.width).toBe("45px");
  expect(one.style.left).toBe("25px");
});

it("starts a move or resize from the overhanging part of the selected live layer", () => {
  const { one, gesture } = createScene();
  one.style.position = "absolute";
  one.style.left = "-12px";
  const target = { sourceFile: "one.html", elementId: "one" };
  const start = (x: number, y: number, corner?: string, selected = target) => gesture("start", "outside", {x, y, corner, target: selected});

  expect(gesture("start", "background", { x: -0.08, y: 0.06 })).toBeNull();
  expect(start(-0.15, 0.06)).toBeNull();
  expect(start(-0.08, 0.18)).toBeNull();
  expect(start(-0.12, 0, "sw")).toBeNull();
  expect(start(-0.12, 0, "nw", { ...target, sourceFile: "other.html" })).toBeNull();
  expect(start(-0.08, 0.06)).toMatchObject({ target: { elementId: "one" }});
  expect(gesture("finish", "outside", { dx: 0.06, dy: 0 })).toMatchObject({ left: -6 });
  gesture("cancel", "outside");

  expect(start(-0.12, 0.1, "sw")).toMatchObject({ target: { elementId: "one" }});
  expect(gesture("finish", "outside", { dx: -0.05, dy: 0.05 })).toMatchObject({ left: -17, width: 25, height: 15 });
  gesture("cancel", "outside");
  expect(one.style.left).toBe("-12px");
});

it("checks the selected identity, lock and live box before an outside gesture", () => {
  const { one, two, gesture } = createScene();
  one.style.left = two.style.left = "95px";
  const start = (id: string, x = 1.05) => gesture("start", "move", { x, y: 0.05, target: { sourceFile: id + ".html", elementId: id }});
  expect(start("two")).toBeNull();
  expect(start("one", Infinity)).toBeNull();
  one.setAttribute("data-timeline-locked", "");
  expect(start("one")).toBeNull();
  one.removeAttribute("data-timeline-locked");
  one.style.visibility = "hidden";
  expect(start("one")).toBeNull();
  one.style.visibility = "visible";
  one.setAttribute("data-hf-parked-scene", "");
  expect(start("one")).toBeNull();
  one.remove();
  expect(start("one")).toBeNull();
});
