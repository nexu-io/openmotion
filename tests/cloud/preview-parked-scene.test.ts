import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTMLContent } from '@hyperframes/core/compiler';
import { PREVIEW_SOURCE_IDENTITY } from '../../src/studio/engine/preview-bridge.ts';
import { bundlePreviewInMemory } from '../../src/studio/engine/preview-bundler.ts';
import { PREVIEW_PARKED_SCENE } from '../../src/studio/engine/preview-parked-scene.ts';
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
  const settings = {projectId: 'p', compositionPath: 'index.html'};
  const fresh = { ...settings, sourceVersions: { ...oldVersions, [file]: after }};
  const nextParts = parts('new intro');
  if (batch) {
    fresh.sourceVersions[other] = digest('updated outro');
    nextParts.scenes.outro = 'new outro';
  }
  function templ(fragment: string | null) {
    const body = separateReceipts && fragment ? document.querySelector('[data-composition-file="' + fragment + '"]')!.outerHTML : '';
    return `<html><head><meta name="hf-scene-parts" content='${JSON.stringify(nextParts)}'><script data-openmotion-preview='${JSON.stringify(fresh)}'></script></head><body>${body}</body></html>`;
  }
  const counts = { reads: 0, swaps: 0, confirms: 0 };
  const request = { documentId: 'frame-1', path: file, fileVersion: version, expiresAt: Date.now() + 3000 };
  if (batch && !separateReceipts) Object.assign(request, {files: [[file, version], [other, '"sha256:' + fresh.sourceVersions[other] + '"']]});
  let duringRead = () => {};
  const reads: (string | null)[] = [];
  const currentVersions = { ...oldVersions };
  const refresh = runInNewContext(PREVIEW_SOURCE_IDENTITY + PREVIEW_PARKED_SCENE + '\nrefreshParkedScene;', {
    settings, compositionPath: 'index.html', styleDocumentId: 'frame-1', sourceVersions: currentVersions, projectId: 'p',
    document, location: {href: 'https://preview.example/current?pt=test'}, URL, AbortSignal,
    drag: null, pendingDrags: new Map(), inlineText: null,
    DOMParser: class { parseFromString(html: string) { return parseHTMLContent(html); } },
    fetch: async (url: string) => {
      const fragment = new URL(url).searchParams.get('sceneFile');
      if (!separateReceipts) assert.equal(fragment, batch ? null : file);
      reads.push(fragment);
      counts.reads++;
      duringRead();
      return new Response(templ(fragment));
    },
    window: { __hfSwapScenes: async (html: string) => {
      if (separateReceipts) {
        const swapped = parseHTMLContent(html);
        assert.deepEqual(Array.from(swapped.querySelectorAll('section'), el => el.getAttribute('data-composition-file')), [file, other]);
      } else assert.equal(html, templ(null));
      counts.swaps++;
    } },
    confirmCanvasVersion: (path: string, value: string) => { assert.ok(path === file || batch && path === other); assert.equal(value, fresh.sourceVersions[path]); currentVersions[path] = value; counts.confirms++; },
  });
  return { document, counts, request, fresh, nextParts, reads, run: (message = request) => refresh(message), onRead: (fn: () => void) => {duringRead = fn;} };
}

it('updates the parked template through the runtime only after validating the fresh file and all other scenes', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.deepEqual(f.counts, {reads: 1, swaps: 1, confirms: 1});
});

it('mounts two cold scenes from one compilation after checking both file versions', async () => {
  const f = fixture(true);
  assert.equal(await f.run(), true);
  assert.deepEqual(f.counts, {reads: 1, swaps: 1, confirms: 2});
  const stale = fixture(true);
  stale.fresh.sourceVersions[other] = digest('concurrent edit');
  assert.equal(await stale.run(), false);
  assert.deepEqual(stale.counts, {reads: 1, swaps: 0, confirms: 0});
});

it('reuses both compact scene bodies when two independent saves arrive in adjacent receipts', async () => {
  const f = fixture(true, true);
  const sibling = { ...f.request, path: other, fileVersion: '"sha256:' + f.fresh.sourceVersions[other] + '"' };
  assert.deepEqual(await Promise.all([f.run(), f.run(sibling)]), [true, true]);
  assert.deepEqual(f.reads, [file, other]);
  assert.deepEqual(f.counts, {reads: 2, swaps: 1, confirms: 2});
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
