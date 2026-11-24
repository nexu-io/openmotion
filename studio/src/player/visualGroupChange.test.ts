// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { applyCanvasCommand } from "../../../packages/edit-core/canvas-commands";
import { stageGroupChange } from "../../../shared/preview-group";
import { PRESENTATION_TAGS } from "../../../shared/preview-timing";
import { diffPreviewChanges } from "./peerTimingPreview";

const source = '<main data-hf-id="stage" data-composition-id="main" id="stage"><div id="a" data-hf-id="a" class="clip" style="position:absolute;left:10px;top:20px">A</div>\n<div id="b" data-hf-id="b" class="clip" style="position:absolute;left:40px;top:30px">B</div><div id="c" data-hf-id="c">C</div></main>';
const grouped = applyCanvasCommand(source, { kind: "groupElements", groupId:"Group 1", targets:[{id:"a"},{id:"b"}],
  bbox:{left:10, top:20, width:100, height:50}, rebases:[{target:{id:"a"},left:0,top:0,track:0},{target:{id:"b"},left:30,top:10,track:1}] });
const ungrouped = applyCanvasCommand(grouped, {kind:"ungroupElements",target:{id:"group-1"}});

it("uses the core's box and exact child objects for wrap, rollback and unwrap", () => {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const a = doc.getElementById("a")!;
  for (const [from, to, parent] of [[source, grouped, "group-1"], [grouped, ungrouped, "stage"]] as const) {
    const delta = diffPreviewChanges(from, to)?.[0]?.group;
    expect(delta).toBeTruthy();
    const apply = stageGroupChange(doc, delta!, new Set(PRESENTATION_TAGS))!;
    expect(apply).not.toBeNull();
    const original = a.parentElement;
    apply(true);
    expect(a.parentElement?.id).toBe(parent);
    expect(doc.getElementById("a")).toBe(a);
    apply(false); expect(a.parentElement).toBe(original);
    apply(true);
  }
});

it("rejects a changed sibling, scripts and a changed member text", () => {
  for (const rewritten of [grouped.replace(">C<", ">D<"), grouped.replace(">A<", ">X<"), grouped + "<script>run()</script>"]) {
    expect(diffPreviewChanges(source, rewritten)).toBeNull();
  }
});

it("includes unchanged startup code in the full source comparison", () => {
  const script = '<script>window.__qaBoot = "alpha";</script>';
  expect(diffPreviewChanges(source + script, grouped + script)?.[0]?.group?.wrap).toBe(true);
  expect(diffPreviewChanges(source + script, grouped + script.replace("alpha","beta"))).toBeNull();
});
