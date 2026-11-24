import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyCanvasCommand } from "../../packages/edit-core/canvas-commands.ts";
import { parseGsapAnimationsFromHtml } from "../../packages/edit-core/gsap-mutations.ts";

const source =
  '<div data-composition-id="stage" data-duration="6"><div id="a" style="translate: 3px 4px">A</div><div id="b">B</div></div>';
const target = { id: "a" };

test("turning off a media loop removes the attribute and still rejects invalid layout values", () => {
  const operations = [{ type: "html-attribute" as const, property: "loop", value: null }];
  const media = '<audio id="a" loop="true" muted></audio>';
  const result = applyCanvasCommand(media, { kind: "editElements", patches: [{ target, operations }] });
  assert.doesNotMatch(result, /\bloop\b/);
  assert.match(result, /\bmuted\b/);
  assert.throws(() => applyCanvasCommand(media, {
    kind: "editElements",
    patches: [{ target, operations: [{ type: "inline-style", property: "width", value: "10px", childIndex: NaN }] }],
  }), /Invalid layout value/);
});

const move = {
  kind: "moveCanvasElement",
  target,
  x: 20,
  y: 30,
  time: 2,
} as const;

test("canvas drags preserve the authored baseline and reject unresolved batch targets", () => {
  const result = applyCanvasCommand(source, move);
  assert.match(result, /translate:\s*20px 30px/);
  assert.match(result, /data-hf-studio-original-inline-translate="3px 4px"/);
  assert.throws(
    () =>
      applyCanvasCommand(source, {
        kind: "editElements",
        patches: [
          {
            target,
            operations: [
              { type: "text-content", property: "", value: "changed" },
            ],
          },
          {
            target: { id: "absent" },
            operations: [
              { type: "inline-style", property: "color", value: "red" },
            ],
          },
        ],
      }),
    /not found/,
  );
});

test("same drag edits an owned tween at composition time and refuses an ambiguous shared tween", () => {
  const animation = (selector: string) =>
    source.replace(
      '</div><div id="b">',
      '</div><script>const tl=gsap.timeline();tl.fromTo("' +
        selector +
        '",{x:0,y:0},{x:40,y:40,ease:"none",duration:4},0);</script><div id="b">',
    );
  const result = applyCanvasCommand(animation("#a"), move);
  const tween = parseGsapAnimationsFromHtml(result).animations.find(
    (a) => a.keyframes,
  );
  assert.deepEqual(
    tween?.keyframes?.keyframes.find((k) => k.percentage === 50)?.properties,
    { x: 20, y: 30 },
  );
  assert.match(result, /translate:\s*3px 4px/);
  assert.throws(
    () => applyCanvasCommand(animation("#a,#b"), move),
    /multiple elements/,
  );
});

test("moving the welcome headline preserves its runtime letter animation", () => {
  const intro = readFileSync(new URL("../../template-library/openmotion-welcome/compositions/intro.html", import.meta.url), "utf8");
  const result = applyCanvasCommand(intro, {
    ...move,
    target: { id: "intro-headline", hfId: "hf-933r", selector: '[data-hf-id="hf-933r"]' },
    time: 0.967,
  });
  const headline = result.match(/<div\b[^>]*\bid="intro-headline"[^>]*>/)?.[0] ?? "";
  assert.match(headline, /translate:\s*20px 30px/);
  assert.equal(result.match(/<script>[\s\S]*?<\/script>/)?.[0], intro.match(/<script>[\s\S]*?<\/script>/)?.[0]);
});

test("duplicate, group and ungroup use the same source transforms as Studio", () => {
  const copy = applyCanvasCommand(source, {
    kind: "duplicateElement",
    target,
    newId: "copy",
  });
  assert.match(copy, /id="copy"/);
  const bbox = { left: 0, top: 0, width: 80, height: 40 };
  const grouped = applyCanvasCommand(source, {
    kind: "groupElements",
    groupId: "pair",
    targets: [target, { id: "b" }],
    bbox,
    rebases: [],
  });
  assert.match(grouped, /id="pair"/);
  const flat = applyCanvasCommand(grouped, {
    kind: "ungroupElements",
    target: { id: "pair" },
  });
  assert.doesNotMatch(flat, /id="pair"/);
  assert.match(flat, /id="a"/);
  assert.match(flat, /id="b"/);
});

test("canvas rejects incomplete selections, ambiguous IDs and edits to locked layers", () => {
  const root = '<html><body><main data-composition-id="stage">';
  const locked =
    root +
    '<section data-timeline-locked><div id="a">A</div></section><div id="b">B</div><script>const tl=gsap.timeline();tl.to("#a",{x:50,duration:1},0);</script></main></body></html>';
  const tween = parseGsapAnimationsFromHtml(locked).animations[0];
  assert.throws(() => applyCanvasCommand(locked, move), /unlock/i);
  assert.throws(
    () =>
      applyCanvasCommand(locked, {
        kind: "editAnimation",
        mutations: [
          {
            type: "update-property",
            animationId: tween.id,
            property: "x",
            value: 30,
          },
        ],
      }),
    /unlock/i,
  );
  assert.throws(
    () =>
      applyCanvasCommand(locked, {
        kind: "editElements",
        patches: [
          {
            target: { id: "a" },
            operations: [
              { type: "inline-style", property: "color", value: "blue" },
            ],
          },
        ],
      }),
    /unlock/i,
  );
  assert.throws(
    () =>
      applyCanvasCommand(source, {
        kind: "groupElements",
        targets: [target, { id: "missing" }],
        groupId: "group",
        bbox: { left: 0, top: 0, width: 20, height: 20 },
        rebases: [],
      }),
    /not found/i,
  );
  assert.throws(
    () =>
      applyCanvasCommand(locked, {
        kind: "deleteCanvasElements",
        targets: [{ id: "b" }, target],
      }),
    /unlock/i,
  );
  assert.throws(
    () => applyCanvasCommand(source, { ...move, target: {} }),
    /choose a canvas element/i,
  );
  const repeats =
    root +
    '<div data-hf-id="a"><span data-hf-id="same"></span></div><div data-hf-id="b"><span data-hf-id="same"></span></div></main></body></html>';
  assert.throws(
    () => applyCanvasCommand(repeats, { ...move, target: { hfId: "same" } }),
    /ambiguous/i,
  );
  assert.doesNotMatch(
    applyCanvasCommand(source, {
      kind: "deleteCanvasElements",
      targets: [target, { id: "b" }],
    }),
    /id="[ab]"/,
  );
});

test("headless drags accept measured endpoints when the tween inherits its destination", () => {
  const html = '<html><body><div id="a">A</div><script>const tl=gsap.timeline();tl.from("#a",{x:10,y:10,duration:4},0);</script></body></html>';
  assert.throws(() => applyCanvasCommand(html, move), /measured.*ease/);
  const result = applyCanvasCommand(html, { ...move, samples:{ease:"none",end:{x:80,y:60}} });
  const frames = parseGsapAnimationsFromHtml(result).animations.find(a => a.keyframes)?.keyframes?.keyframes;
  assert.deepEqual(frames?.find(k=>k.percentage===50)?.properties,{x:20,y:30});
  assert.deepEqual(frames?.find(k=>k.percentage===100)?.properties,{x:80,y:60});
});

test("canvas deletion of a mixed selection updates timeline length and the remaining linked partner", () => {
  const source = '<html><body><main data-composition-id="stage" data-duration="10"><video data-link="av" id="v" data-start="0" data-duration="10"></video><audio id="a" data-link="av" data-start="0" data-duration="4"></audio><span id="title">Title</span></main></body></html>';
  const targets = [{selector:'video[data-link="av"]'},{id:"title"}];
  const result = applyCanvasCommand(source,{kind:"deleteCanvasElements",targets});
  assert.doesNotMatch(result, /<video|data-link=|id="title"/);
  assert.match(result, /<main[^>]+data-duration="4"/);
  assert.match(result, /<audio/);
  assert.throws(()=>applyCanvasCommand(source.replace('<audio','<audio data-timeline-locked'), {kind:"deleteCanvasElements",targets}),/unlock/i);
});

test("Studio whole-path drags and headless deltas translate every keyframe without changing playhead mode", () => {
  const html = '<html><body><div id="a">A</div><script>const tl=gsap.timeline();tl.fromTo("#a",{x:0,y:0},{x:130,y:32,duration:7,ease:"none"},0);</script></body></html>';
  const delta = {x:34.767,y:20.664};
  const before = parseGsapAnimationsFromHtml(html).animations[0]!;
  const ui = applyCanvasCommand(html,{kind:"editAnimation",mutations:[{type:"shift-animation-path",animationId:before.id,deltaX:delta.x,deltaY:delta.y}]});
  const shift = {kind:"moveCanvasElement",target,delta} as const;
  assert.equal(applyCanvasCommand(html,shift),ui);
  assert.equal(applyCanvasCommand(html,{...shift,mode:"wholePath",time:0}),ui);
  const frames = (s:string) => parseGsapAnimationsFromHtml(s).animations.find(a=>a.keyframes)?.keyframes?.keyframes.map(k=>k.properties);
  assert.deepEqual(frames(ui),[delta,{x:164.767,y:52.664}]);
  const playhead = applyCanvasCommand(html,{kind:"moveCanvasElement",mode:"playhead",target,time:0,...delta});
  assert.deepEqual(frames(playhead),[delta,{x:130,y:32}]);
  assert.throws(()=>applyCanvasCommand(html,{...shift,x:30} as never),/either/);
  assert.match(applyCanvasCommand(source,{kind:"moveCanvasElement",target,delta:{x:10,y:-3}}), /translate:\s*13px 1px/);
});


test("dragging an instantaneous animation preserves zero duration while omitted duration uses the GSAP default", () => {
  const scene = (call: string) => '<html><body><div id="a"></div><script>const tl=gsap.timeline();tl.' + call + ';</script></body></html>';
  const shift = (html: string) => parseGsapAnimationsFromHtml(
    applyCanvasCommand(html, {kind:"moveCanvasElement",target,delta:{x:2,y:3}})
  ).animations;
  const [hold] = shift(scene('to("#a",{x:12,y:15,duration:0,immediateRender:true},2)'));
  assert.equal(hold.method, "to");
  assert.equal(hold.position, 2);
  assert.equal(hold.duration, 0);
  assert.equal(hold.keyframes, undefined);
  assert.deepEqual(hold.properties, {x:14,y:18});
  assert.equal(hold.extras?.immediateRender, "__raw:true");

  const [instant] = shift(scene('fromTo("#a",{x:0,y:1},{x:12,y:15,duration:0},2)'));
  assert.equal(instant.duration,0);
  assert.deepEqual(instant.fromProperties,{x:2,y:4});
  assert.deepEqual(instant.properties,{x:14,y:18});

  const implicit = shift(scene('to("#a",{x:12,y:15},2)')).find(anim => anim.keyframes)!;
  assert.equal(implicit.duration, 0.5);
  assert.equal(implicit.position, 2);
  const zeroKeys = shift(scene('to("#a",{duration:0,keyframes:{"0%":{x:1,y:2},"100%":{x:12,y:15}}},2)')).find(anim => anim.keyframes)!;
  assert.equal(zeroKeys.duration, 0);
});

test("a whole-layer drag moves the welcome editor window identically from Studio and a headless delta", () => {
  const html = readFileSync(new URL("../../template-library/openmotion-welcome/compositions/editor.html", import.meta.url), "utf8");
  const target = { id: "editor-window", hfId: "hf-ns1j" };
  const move = { kind: "moveCanvasElement", mode: "wholePath", target, delta: { x: 17.5, y: -9 } } as const;
  const result = applyCanvasCommand(html, move);
  assert.equal(applyCanvasCommand(html, { ...move, time: 4.3666667, staticBox: { left: 137.5, top: 71, makeRelative: false } }), result);
  assert.match(result.match(/<div[^>]*id="editor-window"[^>]*>/)![0], /left:\s*137\.5px/);
  assert.match(result.match(/<div[^>]*id="editor-window"[^>]*>/)![0], /top:\s*71px/);
  assert.equal(result.match(/<script>[\s\S]*?<\/script>/)![0], html.match(/<script>[\s\S]*?<\/script>/)![0]);
  const further = applyCanvasCommand(result, move);
  assert.match(further.match(/<div[^>]*id="editor-window"[^>]*>/)![0], /left:\s*155px/);
});

test("a playhead on a rounded GSAP endpoint resolves its owner and genuine overlapping tracks remain ambiguous", () => {
  const tweens = (second: number) => '<html><head><style>#a {position:absolute;left:1px;top:2px}</style></head><body><div id="a" style="translate:2px 3px;transform:rotate(15deg) scale(1.1)">A</div><script>const tl=gsap.timeline();tl.fromTo("#a",{x:0,y:1},{x:3,y:4,duration:0.4,ease:"none"},0);tl.fromTo("#a",{x:3,y:4},{x:9,y:5,duration:0.6,ease:"none"},' + second + ');</script></body></html>';
  const source = tweens(3.7666666667);
  const result = applyCanvasCommand(source, { ...move, mode:"playhead", time:4.3666667 });
  const end = parseGsapAnimationsFromHtml(result).animations.find(a => a.keyframes)?.keyframes?.keyframes.at(-1);
  assert.deepEqual(end?.properties, { x: 20, y: 30 });
  const both = tweens(0);
  assert.throws(() => applyCanvasCommand(both, { ...move, time:0.2 }), /Multiple position tweens/);
  const shifted = applyCanvasCommand(both, { kind:"moveCanvasElement", target, delta:{x:10,y:20} });
  assert.match(shifted, /translate:\s*2px 3px/);
  assert.match(shifted, /transform:\s*rotate\(15deg\) scale\(1\.1\)/);
  assert.equal(shifted.match(/<script>[\s\S]*?<\/script>/)![0], both.match(/<script>[\s\S]*?<\/script>/)![0]);
});

test("a whole-layer drag on a shared tween preserves its peers and requires measurements for a responsive inset", () => {
  const html = '<html><head><style>.item{position:absolute;left:10%;top:0px}</style></head><body><div id="a" class="item"></div><div id="b" class="item"></div><script>const tl=gsap.timeline();tl.to(".item",{x:80,duration:1},0);</script></body></html>';
  const command = { kind:"moveCanvasElement",target,delta:{x:5,y:7} } as const;
  assert.throws(() => applyCanvasCommand(html, command), /measured layer box/);
  const measured = applyCanvasCommand(html, {...command, staticBox:{left:25,top:7,makeRelative:false}});
  assert.match(measured.match(/<div[^>]*id="a"[^>]*>/)![0], /left:\s*25px/);
  assert.doesNotMatch(measured.match(/<div[^>]*id="b"[^>]*>/)![0], /style=/);
  assert.equal(measured.match(/<script>[\s\S]*?<\/script>/)![0], html.match(/<script>[\s\S]*?<\/script>/)![0]);
});

test("headless layout inference rejects viewport styles, competing edges, logical insets, and priority overrides", () => {
  const target = { id: "window" };
  const command = { kind: "moveCanvasElement", target, delta: { x: 3, y: 7 } } as const;
  for (const extra of [
    '<link rel="stylesheet" href="theme.css">',
    '<style media="(width < 900px)">#window{left:3px}</style>',
    '<style>@media (width < 900px){#window{left:4px}}</style>',
    '<style>#window{inset-inline-end:2px}</style>',
    '<style>#window{right:2px}</style>',
    '<style>#window{top:12px!important}</style>',
  ]) {
    const source = '<html><head><style>#window{position:absolute;left:10px;top:9px}</style>' + extra +
      '</head><body><div id="window"></div><script>const tl=gsap.timeline();tl.to("#window",{x:5,duration:1},0);tl.to("#window",{x:12,duration:1},2);</script></body></html>';
    assert.throws(() => applyCanvasCommand(source, command), /measured layer box/, extra);
  }
});
