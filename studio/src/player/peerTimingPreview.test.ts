// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
import { diffPreviewChanges, diffScriptedPreviewStyles, rememberPeerTimingDocument, tryApplyPeerChanges } from "./peerTimingPreview";

const source = '<!doctype html><main data-composition-id="root" data-duration="15"><audio id="a" data-start="2" data-duration="3"></audio><script>window.run(1)</script></main>';

describe("peer timing classification", () => {
  it("identifies a single visual clip deletion and the new composition end together", () => {
    const clip = '<div class="clip" data-hf-id="first" data-start="0" data-duration="3">First</div>';
    const remaining = '<div class="clip" data-hf-id="last" data-start="5" data-duration="2">Last</div>';
    const previous = '<main data-composition-id="root" data-duration="12">' + clip + remaining + '</main>';
    const current = previous.replace(clip, '').replace('"12"', '"7"');
    expect(diffPreviewChanges(previous, current)).toMatchObject([
      { hfId: "first", removeFromComposition: "root", attributes: [] },
      { compositionId: "root", attributes: [["data-duration", "12", "7"]] },
    ]);
    for (const [from, to] of [
      ['<main ', '<script>setup()</script><main '], ['data-start="5"', 'data-start="first + 1"'],
      [clip, clip.replace('>First', '><span>First</span>')], [clip, clip.replaceAll('div', 'video')],
    ] as const) {
      expect(diffPreviewChanges(previous.replace(from, to), current.replace(from, to))).toBeNull();
    }
    expect(diffPreviewChanges(previous, current.replace(remaining, ''))).toBeNull();
    expect(diffPreviewChanges(previous, current.replace('class="clip"', 'class="changed"'))).toBeNull();
  });

  it("inserts one plain visual leaf and changes its sibling timing in the same revision", () => {
    const leaf = '<div id="intro" class="clip" data-hf-id="first" data-start="0" data-duration="3">Hi</div>';
    const previous = '<main data-composition-id="root">\n' + leaf + '</main>';
    const clone = leaf.replace('id="intro"', 'id="copy"').replace('"first"', '"copy-hf"').replace('>Hi', ' style="background:#ffeedd;z-index:2">Hi');
    const current = previous.replace(leaf, clone + '\n  ' + leaf.replace('"3"', '"2"'));
    expect(diffPreviewChanges(previous, current)).toMatchObject([
      { id: "copy", insert: { owner: "root", next: "first", text: "Hi", whitespace: ["\n", "\n", "\n  "] } },
      { id: "intro", attributes: [["data-duration", "3", "2"]] },
    ]);
    for (const unsupported of [current.replace('>Hi', '><b>Hi</b>'),
      current.replace('id="copy"', 'id="intro"'), current.replace('background:#ffeedd', 'background:url(asset.png)'),
      current.replace('id="copy"', 'id="copy" onclick="setup()"'), current.replace('id="copy"', 'id="copy" data-composition-src="other.html"'),
      current.replace('id="intro"', 'id="changed"'), current + '<script>setup()</script>']) {
      expect(diffPreviewChanges(previous, unsupported)).toBeNull();
    }
  });

  it("includes root and media in a single verified set and requires stable identities", () => {
    const next = source.replace('"15"', '"14"').replace('data-start="2"', 'data-start="3" data-media-start="1"');
    expect(diffPreviewChanges(source, next)?.map(change => [change.id || change.compositionId, change.attributes])).toEqual([
      ["root", [["data-duration", "15", "14"]]],
      ["a", [["data-start", "2", "3"], ["data-media-start", null, "1"]]],
    ]);
    expect(diffPreviewChanges(source.replace('id="a"', ''), next.replace('id="a"', ''))).toBeNull();
  });

  it("accepts direct text, inspector styles and a two-axis move on one identified element", () => {
    const before = '<div id="title" style="left: 10px; top: 20px; color: red">Hello</div>';
    const after = '<div id="title" style="left: 40px; top: 32px; color: red; font-size: 52px; text-align: center">Hi!</div>';
    expect(diffPreviewChanges(before, after)).toMatchObject([{
      id: "title", attributes: [], text: ["Hello", "Hi!"],
      styles: [["left", "10px", "40px"], ["top", "20px", "32px"], ["font-size", "", "52px"], ["text-align", "", "center"]],
    }]);
    for (const unsupported of [after.replace("center", "center !important"), after.replace("red", "red; z-index: 2"),
      after.replace("Hi!", "<b>Hi!</b>"), after.replace('id="title"', 'id="other"')]) {
      expect(diffPreviewChanges(before, unsupported)).toBeNull();
    }
    expect(diffPreviewChanges('<script id="x">a()</script>', '<script id="x">b()</script>')).toBeNull();
  });

  it("recognizes only the exact IDs mounted by the preview bundler on the first nested edit", async () => {
    const before = '<template><div data-composition-id="intro"><p id="title">Hi</p></div></template>';
    const next = ensureHfIds(before).replace('id="title"', 'id="title" style="font-size: 54px"');
    expect(await diffScriptedPreviewStyles(before, next)).toMatchObject([{ id: "title", styles: [["font-size", "", "54px"]] }]);
    expect(diffPreviewChanges(before, next)).toBeNull();
    expect(await diffScriptedPreviewStyles(before, next.replace(/data-hf-id="[^"]+"/, 'data-hf-id="unrelated"'))).toBeNull();
    const partial = '<main data-composition-id="scene"><p id="title" data-hf-id="existing">Hi</p></main>';
    const stamped = ensureHfIds(partial).replace('id="title"', 'id="title" style="font-size: 52px"');
    expect(await diffScriptedPreviewStyles(partial, stamped)).toMatchObject([{ hfId: "existing", id: "title" }]);
  });

  it("includes the containing-block change on the first drag of a static layer", () => {
    const before = '<div id="title" style="color:red">Title</div>';
    const after = '<div id="title" style="color:red;position:relative;left:30px;top:12px">Title</div>';
    expect(diffPreviewChanges(before, after)?.[0]?.styles).toEqual([
      ["position", "", "relative"], ["left", "", "30px"], ["top", "", "12px"],
    ]);
  });

  it("validates media attributes, bounds, and boolean track state", () => {
    const base = '<audio id="clip" data-start="0"></audio>';
    const edit = (attributes: string) => base.replace('id="clip"', `id="clip" ${attributes}`);
    expect(diffPreviewChanges(base, edit('data-volume="0.5" muted=""'))?.[0]?.attributes).toEqual([
      ["muted", null, ""], ["data-volume", null, "0.5"],
    ]);
    for (const invalid of ['data-volume="4"', 'data-hidden="false"', 'muted="false"']) {
      expect(diffPreviewChanges(base, edit(invalid))).toBeNull();
    }
    expect(diffPreviewChanges('<div id="clip"></div>', '<div id="clip" muted></div>')).toBeNull();
  });

  it("clears a fill image in place while loading a new image through the asset pipeline", () => {
    const before = '<div id="tile" style="background-color:red"></div>';
    const filled = '<div id="tile" style="background-color:blue;background-image:none"></div>';
    expect(diffPreviewChanges(before, filled)?.[0]?.styles).toEqual([
      ["background-color", "red", "blue"], ["background-image", "", "none"],
    ]);
    expect(diffPreviewChanges(filled, filled.replace("none", "url(asset.png)"))).toBeNull();
  });

  it("recognizes text, color, and an edit-core translation together and preserves font declarations", () => {
    const before = '<style>@font-face { font-family: Sample; src:url(sample.woff2) }</style><h1 id="title">Old</h1>';
    const after = before.replace('id="title"', 'id="title" style="font-family:Sample;color:red;translate:30px 12px"').replace('Old', 'New');
    expect(diffPreviewChanges(before, after)).toMatchObject([{
      id: "title", text: ["Old", "New"],
      styles: [["font-family", "", "Sample"], ["color", "", "red"], ["translate", "", "30px 12px"]],
    }]);
    expect(diffPreviewChanges(before, after.replace("sample.woff2", "other.woff2"))).toBeNull();
    expect(diffPreviewChanges(before, after.replace("30px 12px", "50% 12px"))).toBeNull();
    const marked = after.replace('id="title"', 'data-hf-studio-original-inline-translate="" id="title"');
    expect(diffPreviewChanges(before, marked)?.[0]?.captureOriginalTranslate).toBe(true);
    expect(diffPreviewChanges(marked, before)?.[0]?.captureOriginalTranslate).toBe(false);
    expect(diffPreviewChanges(before, marked.replace('translate=""', 'translate="90px"'))).toBeNull();
  });

  it("moves a canvas element without altering its drawing buffer, CSS size or script", () => {
    const before = '<template><canvas id="reel" width="1920" height="1080"></canvas><script>draw();</script></template>';
    const after = before.replace('id="reel"', 'id="reel" style="left: 45px; top: 12px"');
    expect(diffPreviewChanges(before, after)?.[0]?.styles).toEqual([["left", "", "45px"], ["top", "", "12px"]]);
    const firstMove = after.replace("left: 45px", "position: relative; left: 45px");
    expect(diffPreviewChanges(before, firstMove)?.[0]?.styles).toEqual([["position", "", "relative"], ["left", "", "45px"], ["top", "", "12px"]]);
    expect(diffPreviewChanges(firstMove, before)?.[0]?.styles).toContainEqual(["position", "relative", ""]);
    for (const changed of [firstMove.replace("relative", "absolute"), after.replace('width="1920"', 'width="1280"'), after.replace('45px;', '45px; width: 50px;'), after.replace('draw();', 'drawNext();')]) {
      expect(diffPreviewChanges(before, changed)).toBeNull();
    }
  });

  it("falls back for a changed tween, markup, source, label, style or expression in the same edit", () => {
    const trimmed = source.replace('data-start="2"', 'data-start="3"');
    for (const next of [trimmed.replace('run(1)', 'run(2)'), trimmed.replace('</audio>', '</audio><b></b>'),
      trimmed.replace('id="a"', 'id="b"'), trimmed.replace('id="a"', 'id="a" src="asset.m4a"'),
      trimmed.replace('id="a"', 'id="a" style="z-index:2"'), trimmed.replace('"3"', '"=clip.start"')]) {
      expect(diffPreviewChanges(source, next)).toBeNull();
    }
    expect(diffPreviewChanges('<template>' + source + '</template>', '<template>' + trimmed.replace('run(1)', 'run(2)') + '</template>')).toBeNull();
  });
});

it("keeps an unverified font change visible while the certified project's script rebuilds", async () => {
  const frame = document.createElement("iframe");
  frame.src = "https://preview.test/api/projects/p/preview?pt=active";
  const postMessage = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage } });
  rememberPeerTimingDocument(frame, "active", undefined, "document", { position: true });
  const previous = '<p id="title" style="font-size:10px">Hello</p>';
  const result = await tryApplyPeerChanges(frame, { path: "scene.html",
    previous: { content: previous, version: "first" }, current: { content: previous.replace("10px", "12px"), version: "second" },
  }, () => true, "keep-visible");
  expect(result).toBe(false);
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "peer-presentation", temporary: true }), "https://preview.test");
});
