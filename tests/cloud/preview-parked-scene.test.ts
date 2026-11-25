import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTMLContent } from '@hyperframes/core/compiler';
import { PREVIEW_SOURCE_IDENTITY } from '../../src/studio/engine/preview-bridge.ts';
import { bundlePreviewInMemory } from '../../src/studio/engine/preview-bundler.ts';
import { PREVIEW_PARKED_SCENE } from '../../src/studio/engine/preview-parked-scene.ts';
import { PREVIEW_SCENE_GESTURES } from '../../src/studio/engine/preview-scene-gestures.ts';
import { previewSceneFragment } from '../../src/studio/engine/preview-scene-fragment.ts';
import { InMemoryVirtualProject } from '../../src/studio/virtual-project-store.ts';

const file = 'compositions/intro.html';
const other = 'compositions/outro.html';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const after = digest('new intro');
const version = `"sha256:${after}"`;
const oldVersions = { [file]: digest('old intro'), [other]: digest('outro') };
const parts = (intro: string) => ({ shared: 'same main', scenes: { intro, outro: 'same outro' } });
const parked = `<section data-composition-file="${file}" data-hf-scene="intro" data-hf-parked-scene></section>`;

it('keeps ordered scene scripts, styles and font declarations while omitting the shell and ambiguous instances', () => {
  const host = `<section data-composition-file="${file}" data-hf-scene="intro"><span>Title</span><script data-hf-scene="intro">inside()</script></section>`;
  const compile = (scenes: string) => `<html><head><meta name="hf-scene-parts" content="{}"><script data-openmotion-preview="{}" src="/bridge.js"></script>
    <style data-hf-scene-fonts>@font-face{font-family:Heading}</style><style data-hf-scene="intro">h1{color:red}</style>
    <script>unrelated()</script></head><body>${scenes}<script data-hf-scene="intro">after()</script></body></html>`;
  const html = previewSceneFragment(compile(host), file)!;
  const fragment = parseHTMLContent(html);
  assert.equal(fragment.querySelector('[data-hf-scene-fonts]')?.textContent, '@font-face{font-family:Heading}');
  assert.equal(fragment.querySelector('style[data-hf-scene]')?.textContent, 'h1{color:red}');
  assert.deepEqual(Array.from(fragment.querySelectorAll('script[data-hf-scene]'), el => el.textContent), ['inside()', 'after()']);
  assert.ok(!html.includes('unrelated()') && !html.includes('/bridge.js'));
  assert.equal(previewSceneFragment(compile(host + host), file), null);
});

function fixture(batch = false, separateReceipts = false) {
  const document = parseHTMLContent(`<html><head></head><body>${parked}</body></html>`);
  if (batch) {
    const second = document.querySelector('section')!.cloneNode(true) as Element;
    second.setAttribute('data-hf-scene', 'outro');
    second.setAttribute('data-composition-file', other);
    document.body.append(second);
  }
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'hf-scene-parts');
  meta.setAttribute('content', JSON.stringify(parts('old intro')));
  document.head.append(meta);
  const settings = {projectId: 'p', compositionPath: 'index.html', independentSceneFiles: batch ? [file, other] : undefined};
  const fresh = { ...settings, sourceVersions: { ...oldVersions, [file]: after }};
  const nextParts = parts('new intro');
  if (batch) {
    fresh.sourceVersions[other] = digest('updated outro');
    nextParts.scenes.outro = 'new outro';
  }
  function templ(fragment: string) {
    const body = document.querySelector('[data-composition-file="' + fragment + '"]')!.outerHTML;
    return `<html><head><meta name="hf-scene-parts" content='${JSON.stringify(nextParts)}'><script data-openmotion-preview='${JSON.stringify(fresh)}'></script></head><body>${body}</body></html>`;
  }
  const counts = { reads: 0, swaps: 0, confirms: 0 };
  const request = { documentId: 'frame-1', path: file, fileVersion: version, expiresAt: Date.now() + 3000 };
  if (batch && !separateReceipts) Object.assign(request, {files: [[file, version], [other, '"sha256:' + fresh.sourceVersions[other] + '"']]});
  let duringRead = () => {};
  const reads: (string | null)[] = [];
  const currentVersions = { ...oldVersions };
  let duringSwap: (() => Promise<void>) | undefined;
  const siblingText = document.createElement('span');
  const bridge = runInNewContext(PREVIEW_SOURCE_IDENTITY + PREVIEW_PARKED_SCENE + PREVIEW_SCENE_GESTURES + '\n({refreshParkedScene, sceneInlineText, rememberScenePlacement})', {
    canvasPointHit: () => siblingText,
    describe: () => ({sourceFile: other}),
    inspectorElement: () => siblingText,
    editInlineText: () => currentVersions[other],
    settings, compositionPath: 'index.html', styleDocumentId: 'frame-1', sourceVersions: currentVersions, projectId: 'p',
    document, location: {href: 'https://preview.example/current?pt=test'}, URL, AbortSignal,
    drag: null, pendingDrags: new Map(), inlineText: null,
    MutationObserver: class { observe() {} disconnect() {} },
    DOMParser: class { parseFromString(html: string) { return parseHTMLContent(html); } },
    fetch: async (url: string) => {
      const fragment = new URL(url).searchParams.get('sceneFile');
      assert.ok(fragment, 'scene recovery must not download the full project HTML');
      reads.push(fragment);
      counts.reads++;
      duringRead();
      return new Response(templ(fragment));
    },
    window: { __hfParkedSceneMarkup() {}, __hfSwapScenes: async (html: string) => {
      const swapped = parseHTMLContent(html);
      assert.deepEqual(Array.from(swapped.body.children, el => el.getAttribute('data-composition-file')), batch ? [file, other] : [file]);
      counts.swaps++;
      await duringSwap?.();
    } },
    confirmCanvasVersion: (path: string, value: string) => { assert.ok(path === file || batch && path === other); assert.equal(value, fresh.sourceVersions[path]); currentVersions[path] = value; counts.confirms++; },
  });
  return { document, counts, request, fresh, nextParts, reads, currentVersions, run: (message = request) => bridge.refreshParkedScene(message),
    placeSibling: (version: string) => {
      document.querySelector('[data-composition-file="' + other + '"]')!.append(siblingText);
      bridge.rememberScenePlacement(siblingText, other, '#title', {tag:'span', styles:[['left','0px','20px']]}, version);
      currentVersions[other] = version;
    },
    pickSibling: () => bridge.sceneInlineText({phase: 'pick', editId: 'text-1', x: 0, y: 0}),
    onSwap: (fn: () => Promise<void>) => { duringSwap = fn; }, onRead: (fn: () => void) => {duringRead = fn;} };
}

it('updates the parked template through the runtime only after validating the fresh file and all other scenes', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.deepEqual(f.counts, {reads: 1, swaps: 1, confirms: 1});
});

it('mounts a batch from compact scene fragments after checking both file versions', async () => {
  const f = fixture(true);
  assert.equal(await f.run(), true);
  assert.deepEqual(f.reads, [file, other]);
  assert.deepEqual(f.counts, {reads: 2, swaps: 1, confirms: 2});
  const stale = fixture(true);
  stale.fresh.sourceVersions[other] = digest('concurrent edit');
  assert.equal(await stale.run(), false);
  assert.deepEqual(stale.counts, {reads: 1, swaps: 0, confirms: 0});
});

it('includes the compiled body of an independently placed sibling when its source is already confirmed', async () => {
  const f = fixture(true, true);
  f.placeSibling(f.fresh.sourceVersions[other]);
  assert.equal(await f.run(), true);
  assert.deepEqual(f.reads, [file, other]);
  assert.deepEqual(f.counts, {reads: 2, swaps: 1, confirms: 2});
});

it('does not confirm either file when the runtime refuses to restart one of the scene scripts', async () => {
  const f = fixture(true);
  f.onSwap(async () => { throw new Error('scene intro cannot be swapped: its script uses .then('); });
  assert.equal(await f.run(), false);
  assert.deepEqual(f.reads, [file, other]);
  assert.deepEqual(f.currentVersions, oldVersions);
  assert.equal(f.counts.confirms, 0);
});

it('does not waive a changed sibling fingerprint for a stale placement, unknown edit or uncertified file', async () => {
  for (const reason of ['stale placement', 'missing placement', 'uncertified', 'changed independence']) {
    const f = fixture(true, true);
    if (reason !== 'missing placement') f.placeSibling(reason === 'stale placement' ? digest('stale') : f.fresh.sourceVersions[other]);
    f.currentVersions[other] = f.fresh.sourceVersions[other];
    if (reason === 'uncertified') f.fresh.independentSceneFiles!.pop(); // Both compilations only certify the first file.
    if (reason === 'changed independence') f.fresh.independentSceneFiles = [file];
    assert.equal(await f.run(), false, reason);
    assert.deepEqual(f.counts, {reads: 1, swaps: 0, confirms: 0});
  }
});

it('reuses both compact scene bodies when two independent saves arrive in adjacent receipts', async () => {
  const f = fixture(true, true);
  const sibling = { ...f.request, path: other, fileVersion: '"sha256:' + f.fresh.sourceVersions[other] + '"' };
  assert.deepEqual(await Promise.all([f.run(), f.run(sibling)]), [true, true]);
  assert.deepEqual(f.reads, [file, other]);
  assert.deepEqual(f.counts, {reads: 2, swaps: 1, confirms: 2});
});

it('binds an edit in a discovered sibling to the versions confirmed after the shared swap', async () => {
  const f = fixture(true, true);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.onSwap(() => { entered.resolve(); return release.promise; });
  const first = f.run();
  await entered.promise;
  const selection = f.pickSibling();
  const sibling = f.run({ ...f.request, path: other, fileVersion: '"sha256:' + f.fresh.sourceVersions[other] + '"' });
  assert.ok(selection && typeof selection.then === 'function');
  assert.deepEqual(f.counts, { reads: 2, swaps: 1, confirms: 0 });
  release.resolve();
  assert.deepEqual(await Promise.all([first, sibling, selection]), [true, true, f.fresh.sourceVersions[other]]);
  assert.deepEqual(f.counts, { reads: 2, swaps: 1, confirms: 2 });
});

it('leaves the original scene and its version intact if the sibling changes between compact reads', async () => {
  const f = fixture(true, true);
  f.onRead(() => { if (f.counts.reads === 2) f.fresh.sourceVersions[other] = digest('another outro'); });
  assert.equal(await f.run(), false);
  assert.deepEqual(f.reads, [file, other]);
  assert.deepEqual(f.counts, {reads: 2, swaps: 0, confirms: 0});
});

it('checks for a parked child without fetching or replacing a visible scene', async () => {
  const f = fixture();
  Object.assign(f.request, { parkedOnly: true });
  const host = f.document.querySelector('section')!;
  host.removeAttribute('data-hf-parked-scene');
  assert.equal(await f.run(), false);
  assert.deepEqual(f.counts, { reads: 0, swaps: 0, confirms: 0 });
  host.setAttribute('data-hf-parked-scene', '');
  assert.equal(await f.run(), true);
  assert.deepEqual(f.counts, { reads: 1, swaps: 1, confirms: 1 });
});

it('updates an active child through the same runtime lifecycle as a parked child', async () => {
  const f = fixture();
  f.document.querySelector('section')!.removeAttribute('data-hf-parked-scene');
  assert.equal(await f.run(), true);
  assert.deepEqual(f.counts, {reads: 1, swaps: 1, confirms: 1});
});

it('keeps the visible frame intact when a changed scene must execute its script and seek', async () => {
  for (const batch of [false, true]) {
    const f = fixture(batch, batch);
    const host = f.document.querySelector(`[data-composition-file="${batch ? other : file}"]`)!;
    host.removeAttribute('data-hf-parked-scene');
    host.innerHTML = '<script>startTimeline()</script>';
    assert.equal(await f.run(), false);
    assert.deepEqual(f.counts, {reads: 1, swaps: 0, confirms: 0});
  }
});

it('confirms an unchanged compiled scene even when its shown content runs a script', async () => {
  const f = fixture();
  const host = f.document.querySelector('section')!;
  host.removeAttribute('data-hf-parked-scene');
  host.innerHTML = '<script>startTimeline()</script>';
  f.nextParts.scenes.intro = 'old intro';
  assert.equal(await f.run(), true);
  assert.deepEqual(f.counts, {reads: 1, swaps: 0, confirms: 1});
});

it('swaps hidden, prewarmed scenes and visible scenes containing only data', async () => {
  for (const hidden of [false, true]) {
    const f = fixture();
    const host = f.document.querySelector('section')!;
    host.removeAttribute('data-hf-parked-scene');
    if (hidden) {
      host.setAttribute('data-hf-clip-hidden', '');
      host.style.visibility = 'hidden';
    }
    host.innerHTML = hidden ? '<script src="animation.js"></script>' : '<script type="application/json">{}</script>';
    assert.equal(await f.run(), true);
    assert.equal(f.counts.swaps, 1);
  }
});

it('checks nested scene visibility, including clips revealed by a transition', async () => {
  for (const visibility of ['visible', 'hidden']) {
    const f = fixture();
    const host = f.document.querySelector('section')!;
    host.removeAttribute('data-hf-parked-scene');
    host.setAttribute('data-hf-clip-hidden', '');
    host.style.visibility = visibility;
    host.innerHTML = '<section data-hf-scene="nested" data-composition-file="nested.html"></section>';
    f.document.body.insertAdjacentHTML('beforeend', '<script data-hf-scene="nested">startTimeline()</script>');
    const hidden = visibility === 'hidden';
    assert.equal(await f.run(), hidden);
    assert.equal(f.counts.swaps, Number(hidden));
  }
});

it('leaves missing, repeated and remounting targets to normal preview recovery', async () => {
  for (const state of ['missing', 'duplicate', 'remounting']) {
    const f = fixture();
    const host = f.document.querySelector('section')!;
    if (state === 'missing') host.remove();
    if (state === 'duplicate') host.after(host.cloneNode(true));
    if (state === 'remounting') f.onRead(() => host.replaceWith(host.cloneNode(true)));
    assert.equal(await f.run(), false, state);
    assert.deepEqual(f.counts, {reads: state === 'remounting' ? 1 : 0, swaps: 0, confirms: 0});
  }
});

it('refuses a stale revision, a changed shared shell, or another changed scene or HTML file', async () => {
  for (const conflict of ['revision', 'shell', 'scene', 'file']) {
    const f = fixture();
    if (conflict === 'revision') f.request.fileVersion = '"stale"';
    if (conflict === 'shell') f.nextParts.shared = 'new shell';
    if (conflict === 'scene') f.nextParts.scenes.outro = 'new outro';
    if (conflict === 'file') f.fresh.sourceVersions[other] = digest('new outro');
    assert.equal(await f.run(), false, conflict);
    assert.deepEqual(f.counts, {reads: 1, swaps: 0, confirms: 0});
  }
});

it('keeps the shared film fingerprint independent of a child file receipt but sensitive to authored shared changes', async () => {
  async function render(text: string, heading: string) {
    const index = `<html><body><div data-composition-id="main" data-duration="3"><h1>${heading}</h1><div data-composition-id="intro" data-composition-src="${file}" data-duration="3"></div></div></body></html>`;
    const scene = `<html><body><div data-composition-id="intro" data-duration="3"><p>${text}</p></div></body></html>`;
    const textContents = { 'index.html': index, [file]: scene };
    const project = new InMemoryVirtualProject({projectId: 'p', projectName: 'test', revision: digest(scene + index), textContents,
      files: Object.entries(textContents).map(([path, html]) => ({path, sha256: digest(html), blobScope:'workspace',
        sizeBytes: Buffer.byteLength(html), mimeType: 'text/html', isText: true, updatedAt: new Date()}))});
    const html = await bundlePreviewInMemory(project, {bridgeOrigin:'https://preview.test', baseHref:'https://preview.test/api/projects/p/preview/~assets/variant/', skipDeterministicFonts:true});
    const doc = parseHTMLContent(html!);
    return JSON.parse(doc.querySelector('meta[name="hf-scene-parts"]')!.getAttribute('content')!);
  }
  const before = await render('old intro', 'same title');
  const after = await render('new intro', 'same title');
  assert.equal(before.shared, after.shared);
  assert.notDeepEqual(before.scenes, after.scenes);
  assert.notEqual((await render('new intro', 'new title')).shared, after.shared);
});

it('retains only confirmed placement across real park/remount pairs and releases it on undo or replacement', () => {
  const document = parseHTMLContent('<html><body><main></main></body></html>');
  const root = document.querySelector('main')!;
  const sourceVersions = { [file]: 'a' };
  const pending: { confirmedVersion: string }[] = [];
  let disconnected = 0;
  let notify!: (records: { addedNodes: Element[]; removedNodes: Element[] }[]) => void;
  class Observer {
    constructor(callback: typeof notify) { notify = callback; }
    observe() {}
    disconnect() { disconnected++; }
  }
  const tracker = runInNewContext(PREVIEW_PARKED_SCENE + '\n({rememberScenePlacement, advanceScenePlacements, forgetScenePlacement})', {
    window: { __hfParkedSceneMarkup() {} }, document, sourceVersions, pendingForSource: () => pending,
    MutationObserver: Observer, sourceFileForElement: () => file,
  });
  const makeHost = (left: string) => {
    const host = document.createElement('section');
    host.setAttribute('data-hf-scene', 'intro');
    host.setAttribute('data-composition-file', file);
    host.innerHTML = '<h1 id="title">Title</h1>';
    const node = host.querySelector('h1')!;
    node.style.left = left;
    return { host, node };
  };
  let active = makeHost('10px');
  root.append(active.host);
  const move = (before: string, after: string, from: string, to: string) => {
    tracker.advanceScenePlacements(file, before, after);
    tracker.rememberScenePlacement(active.node, file, '#title', { tag: 'h1', styles: [['left', from, to]] }, after);
    sourceVersions[file] = after;
  };
  const mount = (left: string, parked = true, scene = 'intro', source = file, duplicate = false) => {
    const previous = document.createElement('section');
    previous.setAttribute('data-hf-scene', scene);
    if (parked) previous.setAttribute('data-hf-parked-scene', '');
    const latest = makeHost(left);
    if (duplicate) latest.host.append(latest.node.cloneNode(true));
    latest.host.setAttribute('data-hf-scene', scene);
    latest.host.setAttribute('data-composition-file', source);
    root.replaceChildren(latest.host);
    active = latest;
    notify([{ removedNodes: [previous], addedNodes: [latest.host] }]);
    return latest.node.style.left;
  };
  move('a', 'b', '10px', '30px');
  assert.equal(mount('10px', true, 'intro', file, true), '10px');
  move('b', 'c', '30px', '45px');
  assert.equal(mount('10px'), '45px');
  assert.equal(mount('10px'), '45px');
  assert.equal(mount('10px', true, 'second-instance'), '45px');
  assert.equal(mount('10px', true, 'unrelated', other), '10px');
  assert.equal(mount('12px'), '12px');
  // A replacement of a live host, even with the same file and element id, is not an unpark.
  assert.equal(mount('10px', false), '10px');
  sourceVersions[file] = 'another-version';
  assert.equal(mount('10px'), '10px');
  sourceVersions[file] = '';
  pending.push({ confirmedVersion: 'c' });
  assert.equal(mount('10px'), '45px');
  // Remote undo back to the source template drops the last override and its observer.
  move('c', 'd', '45px', '10px');
  assert.equal(disconnected, 1);
  assert.equal(mount('10px'), '10px');
  move('d', 'e', '10px', '55px');
  tracker.rememberScenePlacement(active.node, file, '#title', {
    tag: 'h1', styles: [['width', '', '280px'], ['height', '', '64px']],
  }, 'e');
  assert.equal(mount('10px'), '55px');
  assert.equal(active.node.style.width, '280px');
  assert.equal(active.node.style.height, '64px');
  // A new template owns every node in its scene, including reused element ids.
  tracker.forgetScenePlacement(file);
  assert.equal(disconnected, 2);
  assert.equal(mount('10px'), '10px');
});
