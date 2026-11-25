// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
import { applyTimelineCommand } from '../../../packages/edit-core/timeline-commands';
import { isLiveAudioTrim } from '../../../shared/preview-live-media';
import welcome from '../../../template-library/openmotion-welcome/index.html?raw';
import welcomeEditor from '../../../template-library/openmotion-welcome/compositions/editor.html?raw';
import { applyCommittedPeerChanges, diffMountedPreview, diffPreviewChanges, diffScriptedPreviewStyles, mountedPeerFileVersion, refreshPeerScenes, rememberPeerTimingDocument, tryApplyPeerChanges } from "./peerTimingPreview";

const source = '<!doctype html><main data-composition-id="root" data-duration="15"><audio id="a" data-start="2" data-duration="3"></audio><script>window.run(1)</script></main>';

describe("peer timing classification", () => {
  it('recognizes actual Welcome trim receipts and their inverses, including first-edit ID stamping', async ({onTestFinished}) => {
    const settings = window.happyDOM.settings;
    const previous = settings.handleDisabledFileLoadingAsSuccess;
    settings.handleDisabledFileLoadingAsSuccess = true;
    onTestFinished(() => { settings.handleDisabledFileLoadingAsSuccess = previous; });
    const stamped = ensureHfIds(welcome);
    const hfId = new DOMParser().parseFromString(stamped, 'text/html').querySelector('audio')!.getAttribute('data-hf-id')!;
    const trim = (source: string, start: number, duration: number) => applyTimelineCommand(source, {
      kind:'trimClips', changes:[{hfId, start, duration}],
    });
    const left = trim(stamped, 1, 36.3);
    const right = trim(left, 1, 33);
    for (const [before, after] of [[welcome, left], [left, right], [right, left], [left, welcome]] as const) {
      expect(isLiveAudioTrim((await diffMountedPreview(before, after)) ?? [])).toBe(true);
    }
    for (const edited of [left.replace('assets/soundtrack.m4a','new.m4a'), left.replace('gsap.timeline','changed.timeline')]) {
      expect(await diffMountedPreview(welcome, edited)).toBeNull();
    }
  });

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

  it('diffs the actual Welcome caption and pending geometry without hiding other changes in its template', async () => {
    const stamped = ensureHfIds(welcomeEditor);
    const caption = /Editable source\.<br data-hf-id="(hf-[a-z0-9]+)">Endless possibilities\./;
    const breakId = stamped.match(caption)?.[1];
    expect(breakId).toBeTruthy();
    const next = stamped.replace(caption, 'Receipt &amp; &lt;verified&gt;')
      .replace('id="editor-picture"', 'id="editor-picture" style="position:relative;left:16px;top:-8px;width:1160px;height:650px"')
      .replace('id="editor-name"', 'id="editor-name" style="position:relative;left:18px;top:5px"');
    const caps = { mounted: true, position: true };
    const changes = await diffMountedPreview(welcomeEditor, next, caps);
    expect(changes?.map(c => c.id)).toEqual(['editor-name', 'editor-picture', 'editor-caption']);
    expect(changes?.at(-1)?.text).toEqual([{ lines: ['Editable source.', 'Endless possibilities.'], breaks: [breakId] }, 'Receipt & <verified>']);
    expect(diffPreviewChanges(next, stamped, caps)?.at(-1)?.text).toEqual([...changes!.at(-1)!.text!].reverse());
    // Changed BR metadata, script, markup, CSS priority and unrelated source IDs require recovery.
    for (const unsafe of [stamped.replace(breakId!, 'hf-zzzz'), stamped.replace('<br ', '<br class="styled" '),
      next.replace('Receipt', '<em>Receipt</em>'), next.replace('16px', '16px !important'),
      next.replace('WelcomeArt.ready.then', 'OtherArt.ready.then'), next.replace('id="editor-name"', 'id="other-name"')]) {
      expect(diffPreviewChanges(stamped, unsafe, caps)).toBeNull();
    }
    for (const inserted of ['<br onclick="run()">', '<br style="display:none">', '<br id="meaningful">',
      '<!--comment--><br>', '<br>'.repeat(65), 'x'.repeat(4097)])
      expect(diffPreviewChanges(next, next.replace('Receipt &amp; &lt;verified&gt;', inserted), caps)).toBeNull();
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

  it("hot-resizes the CSS box of a mounted canvas on its first stamped edit", async () => {
    const before = '<template><div data-composition-id="scene"><canvas id="picture" width="1200" height="675"></canvas></div></template>';
    const after = ensureHfIds(before).replace('id="picture"', 'id="picture" style="width: 1100px; height: 600px"');
    const box = { mounted: true };
    expect(await diffMountedPreview(before, after, box)).toMatchObject([
      { id: "picture", tag: "canvas", styles: [["width", "", "1100px"], ["height", "", "600px"]] },
    ]);
    expect(await diffMountedPreview(after, before, box)).toMatchObject([
      { id: "picture", tag: "canvas", styles: [["width", "1100px", ""], ["height", "600px", ""]] },
    ]);
    expect(await diffMountedPreview(after.replace(/data-hf-id="[^"]+"/, 'data-hf-id="unrelated"'), before, box)).toBeNull();
    expect(await diffMountedPreview(before, after)).toBeNull();
    expect(await diffMountedPreview(before, after.replace('width="1200"', 'width="1100"'), box)).toBeNull();
    expect(await diffMountedPreview(before, after.replace("1100px", "95%"), box)).toBeNull();
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

  it("identifies a media speed change together with its shorter clip and following clip", () => {
    const before = '<main data-composition-id="film" data-duration="8"><video id="shot" data-start="0" data-duration="4"></video><div id="end" data-start="4"></div></main>';
    const after = before.replace('data-duration="8"', 'data-duration="6"')
      .replace('data-duration="4"', 'data-duration="2" data-playback-rate="2"')
      .replace('data-start="4"', 'data-start="2"');
    expect(diffPreviewChanges(before, after)).toMatchObject([
      { compositionId: "film", attributes: [["data-duration", "8", "6"]] },
      { id: "shot", attributes: [["data-duration", "4", "2"], ["data-playback-rate", null, "2"]] },
      { id: "end", attributes: [["data-start", "4", "2"]] },
    ]);
    expect(diffPreviewChanges(before, after.replace('rate="2"', 'rate="0"'))).toBeNull();
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

it("diffs an animated canvas resize in the authored declaration order only with CSS layout capabilities", () => {
  const before = '<style>@keyframes slide{to{left:24px;top:2px}}</style><canvas id="art" width="640" style="animation:slide 1s infinite"></canvas>';
  for (const geometry of ['translate: 15px -9px; width: 20px; height: 30px', 'height: 30px; width: 20px; translate: 15px -9px']) {
    const after = before.replace('1s infinite', '1s infinite; ' + geometry);
    const certified = {cssLayoutOffset: true};
    expect(diffPreviewChanges(before, after)).toBeNull();
    expect(diffPreviewChanges(before, after, certified)?.[0]?.styles?.map(([name]) => name)).toEqual(geometry.split('; ').map(s => s.split(':')[0]));
    expect(diffPreviewChanges(after, before, certified)).not.toBeNull();
    expect(diffPreviewChanges(before, after.replace('640', '1280'), certified)).toBeNull();
    expect(diffPreviewChanges(before, after.replace('24px', '48px'), certified)).toBeNull();
    expect(diffPreviewChanges(before, after.replace('15px -9px', '15% -9px'), certified)).toBeNull();
  }
});

it("accepts a peer paint and a measured local media box together without changing the canvas buffer", () => {
  const before = '<canvas id="picture" width="1200"></canvas>';
  const after = before.replace('id="picture"', 'id="picture" style="position:relative;left:16px;opacity:.52"');
  expect(diffPreviewChanges(before, after, {measured: true})).toMatchObject([{id:"picture", tag:"canvas"}]);
  expect(diffPreviewChanges(before, after.replace('width="1200"', 'width="1600"'), {measured: true})).toBeNull();
});

it("derives every changed element in a large source without changing the rest of the document", () => {
  const titles = Array.from({ length: 80 }, (_, i) => '<p id="title-' + i + '" style="color: red">hello</p>');
  const original = '<main>' + ' '.repeat(150 * 1024) + titles.join('') + '</main>';
  const next = original.replaceAll('color: red', 'color: blue');
  expect(diffPreviewChanges(original, next)).toHaveLength(titles.length);
  expect(diffPreviewChanges(original, next + '<script>boot()</script>')).toBeNull();
});

describe("committed peer paint outcomes", () => {
  const path = "scene.html";
  const update = { path, previous: { content: '<p id="title">First</p>', version: "v1" },
    current: { content: '<p id="title">Second</p>', version: "v2" } };

  function player(onRequest: (type: string, reply: (result: unknown, ok?: boolean) => void) => void) {
    const frame = document.createElement("iframe");
    const origin = "https://preview.test";
    frame.src = origin + "/api/projects/p/preview?pt=active";
    const requests: string[] = [];
    const postMessage = (message: { type: string; documentId: string; path: string }) => {
      requests.push(message.type);
      expect(message).toMatchObject({ documentId: "document", path });
      onRequest(message.type, (result, ok = true) => {
        window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin,
          data: { ...message, source: "openmotion-preview-bridge", type: "response", result, ok } }));
      });
    };
    Object.defineProperty(frame, "contentWindow", { value: { postMessage } });
    rememberPeerTimingDocument(frame, "active", "document", undefined, {}, false, { [path]: "v1" });
    return { frame, requests };
  }

  it.each([
    ["v2", "applied"], ["v1", "requires-scene-rebuild"], [null, "unconfirmed"],
  ] as const)("checks the mounted version once after a lost ACK (%s → %s)", async (version, outcome) => {
    const { frame, requests } = player((type, reply) => { if (type === "mounted-file-version") reply(version); });
    expect(await applyCommittedPeerChanges(frame, update, () => true)).toBe(outcome);
    expect(requests).toEqual(["peer-presentation", "mounted-file-version"]);
    expect(mountedPeerFileVersion(frame, path)).toBe(version === "v2" ? "v2" : "v1");
  });

  it("does not treat a failed version probe as a refusal", async () => {
    const { frame, requests } = player((_, reply) => reply(undefined, false));
    expect(await applyCommittedPeerChanges(frame, update, () => true)).toBe("unconfirmed");
    expect(requests).toEqual(["peer-presentation", "mounted-file-version"]);
  });

  it("allows recovery for an unsupported change or an explicit player refusal", async () => {
    const { frame, requests } = player((_, reply) => reply(false));
    const scripted = { ...update, current: { ...update.current, content: "<script>restart()</script>" } };
    expect(await applyCommittedPeerChanges(frame, scripted, () => true)).toBe("requires-scene-rebuild");
    expect(requests).toEqual([]);
    expect(await applyCommittedPeerChanges(frame, update, () => true)).toBe("requires-scene-rebuild");
    expect(requests).toEqual(["peer-presentation"]);
  });

  it("does not authorize recovery for an obsolete paint even when the probe finds its old base", async () => {
    let current = true;
    const { frame } = player((type, reply) => {
      if (type === "peer-presentation") reply(undefined, false);
      else { current = false; reply("v1"); }
    });
    expect(await applyCommittedPeerChanges(frame, update, () => current)).toBe("superseded");
  });

  it("does not paint or recover a replacement document after the source diff", async () => {
    const { frame, requests } = player((_, reply) => reply(true));
    const pending = applyCommittedPeerChanges(frame, update, () => true);
    rememberPeerTimingDocument(frame, "active", "replacement");
    expect(await pending).toBe("superseded");
    expect(requests).toEqual([]);
  });
});

it.each(["patch", "scene swap"])("records a superseded %s without letting a late reply overwrite the mounted version", async kind => {
  const frame = document.createElement("iframe");
  frame.src = "https://preview.test/api/projects/p/preview?pt=active";
  const child = { postMessage: vi.fn() };
  Object.defineProperty(frame, "contentWindow", { value: child });
  const path = kind === "scene swap" ? "scene.html" : "index.html";
  rememberPeerTimingDocument(frame, "active", "document", undefined, {}, true, { [path]: "v1" });
  const file = (version: string) => ({ content: '<p id="t">' + version + '</p>', version });
  let current = true;
  const send = (from: string, to: string) => kind === "scene swap"
    ? refreshPeerScenes(frame, [[path, to]], () => current)
    : applyCommittedPeerChanges(frame, { path, previous: file(from), current: file(to) }, () => current);
  const ack = (index: number) => {
    const sent = child.postMessage.mock.calls[index]![0];
    window.dispatchEvent(new MessageEvent("message", {source: child as unknown as Window,
      origin: "https://preview.test", data: {...sent, source: "openmotion-preview-bridge", type: "response", result: true}}));
  };
  const first = send("v1", "v2");
  await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(1));
  current = false;
  ack(0);
  expect(await first).toBe(kind === "scene swap" ? false : "superseded");
  expect(mountedPeerFileVersion(frame, path)).toBe("v2");
  current = true;
  const second = send("v2", "v3"), third = send("v3", "v4");
  await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(3));
  ack(2);
  expect(await third).toBe(kind === "scene swap" ? true : "applied");
  ack(1);
  const older = await second;
  if (kind === "patch") expect(older).toBe("superseded");
  expect(mountedPeerFileVersion(frame, path)).toBe("v4");
});
