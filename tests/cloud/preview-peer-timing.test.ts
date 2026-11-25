import assert from 'node:assert/strict';
import type { PreviewLiveEdits } from '../../shared/preview-timing.ts';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import { PREVIEW_BRIDGE_SCRIPT } from '../../src/studio/engine/preview-bridge.ts';

const sha = (n: number) => String(n).repeat(64);
const etag = (n: number) => '"sha256:' + sha(n) + '"';
const root = { compositionId: 'root', tag: 'main', attributes: [['data-duration', '15', '14']] };
const clip = { id: 'clip', tag: 'audio', attributes: [['data-start', '2', '3'], ['data-media-start', null, '1']] };

function preview(canRebindTiming = true, liveEdits?: PreviewLiveEdits, smallMountedSources?: string[]) {
  const document = parseHTMLContent('<html><body><main data-composition-id="root" data-hf-authored-duration="15"><audio id="clip" data-start="2"></audio><div id="title" style="left:10px">Hello</div></main></body></html>');
  const script = document.createElement('script');
  script.setAttribute('data-openmotion-preview', JSON.stringify({
    projectId: 'p', compositionPath: 'index.html', sourceVersions: { 'index.html': sha(1), 'scenes/intro.html': sha(3) }, studioOrigin: 'https://studio.test', canRebindTiming, liveEdits, smallMountedSources,
  }));
  Object.defineProperty(document, 'currentScript', { value: script });
  const replies: { result?: unknown; type?: string; timelineVersion?: string }[] = [];
  const parent = { postMessage: (reply: typeof replies[number]) => replies.push(reply) };
  const hooks: string[] = [];
  const player = { getTime: () => 4, isPlaying: () => true, seek: (time: number) => hooks.push('seek:' + time), play: () => hooks.push('play') };
  let handle!: (event: unknown) => void;
  const window = { parent, __player: player,
    __hfForceTimelineRebind: () => { hooks.push('rebind'); },
    addEventListener: (event: string, handler: typeof handle) => { if (event === 'message') handle = handler; },
  };
  runInNewContext(PREVIEW_BRIDGE_SCRIPT, { window, document, URL, HTMLElement: document.defaultView?.HTMLElement, CSS: { escape: (s: string) => s }, crypto: { randomUUID: () => 'document-1' },
    setInterval() {}, location: { href: 'https://preview.test/api/projects/p/preview?pt=grant' } });
  function send(overrides: Record<string, unknown> = {}, origin = 'https://studio.test', source = parent) {
    replies.length = 0;
    handle({ source, origin, data: { source: 'openmotion-studio', version: 1, type: 'peer-timing', projectId: 'p',
      token: 'grant', requestId: 'request', documentId: 'document-1', path: 'index.html', before: etag(1), after: etag(2),
      expiresAt: Date.now() + 350, changes: [root, clip], ...overrides } });
    return replies[0]?.result;
  }
  return { send, document, hooks, window, replies };
}

it('applies a complete version once, preserves the media node and rebinds at the playhead', () => {
  const { send, document, hooks } = preview();
  const audio = document.getElementById('clip')!;
  assert.equal(send(), true);
  assert.deepEqual(hooks, ['seek:4', 'rebind', 'play']);
  assert.equal(document.querySelector('main')!.getAttribute('data-hf-authored-duration'), '14');
  assert.equal(document.getElementById('clip'), audio);
  assert.equal(audio.getAttribute('data-media-start'), '1');
  assert.equal(send(), false);
  const reverse = { before: etag(2), after: '"patch:' + sha(3) + '"',
    changes: [{ id: 'clip', tag: 'audio', attributes: [['data-media-start', '1', null]] }] };
  assert.equal(send(reverse), true);
  assert.equal(audio.hasAttribute('data-media-start'), false);
  assert.equal(send({ ...reverse, before: reverse.after, after: etag(4), changes: [clip] }), false);
});

it('removes only the identified direct visual leaf and restores it if the player cannot rebind', () => {
  function setup(canRebind = true) {
    const frame = preview(canRebind);
    const target = frame.document.getElementById('title')!;
    target.setAttribute('data-hf-id', 'title-hf');
    target.classList.add('clip');
    const change = { hfId: 'title-hf', id: 'title', tag: 'div', attributes: [], removeFromComposition: 'root' };
    return { ...frame, target, change };
  }
  const { send, document, change, hooks } = setup();
  assert.equal(send({ changes: [{ ...change, removeFromComposition: 'other' }] }), false);
  assert.equal(send({ changes: [{ ...change, id: 'other' }] }), false);
  assert.equal(send({ changes: [change, root] }), true);
  assert.equal(document.getElementById('title'), null);
  assert.deepEqual(hooks, ['seek:4', 'rebind', 'play']);
  assert.equal(setup(false).send({ changes: [change] }), false);
  const rolledBack = setup();
  const next = rolledBack.target.nextSibling;
  rolledBack.window.__hfForceTimelineRebind = () => { throw new Error('rebind failed'); };
  assert.equal(rolledBack.send({ changes: [rolledBack.change, root] }), false);
  assert.equal(rolledBack.document.getElementById('title'), rolledBack.target);
  assert.equal(rolledBack.target.nextSibling, next);
  assert.equal(rolledBack.target.parentElement?.getAttribute('data-hf-authored-duration'), '15');
});

it('adds a direct visual leaf at its verified sibling and rolls it back if playing cannot resume', () => {
  const change = { id: 'copy', hfId: 'copy-hf', tag: 'div', attributes: [], insert: {
    owner: 'root', next: 'title-hf', whitespace: ['', '\n', ''], text: 'Copy',
    attrs: [['class', 'clip'], ['data-start', '4'], ['data-duration', '2'], ['style', 'background:#ddd;z-index:2']],
  } };
  const frame = preview();
  const title = frame.document.getElementById('title')!;
  title.setAttribute('data-hf-id', 'title-hf');
  const audio = frame.document.getElementById('clip');
  for (const invalid of [
    { ...change, insert: { ...change.insert, next: 'unknown' } },
    { ...change, insert: { ...change.insert, attrs: [...change.insert.attrs, ['src', 'asset']] } },
    { ...change, insert: { ...change.insert, whitespace: ['old', '', ''] } },
    { ...change, tag: 'video' },
  ]) assert.equal(frame.send({ changes: [invalid] }), false);
  assert.equal(frame.send({ before: etag(3), changes: [change] }), false);
  assert.equal(preview(false).send({ changes: [change] }), false);

  const rebind = frame.window.__hfForceTimelineRebind;
  frame.window.__hfForceTimelineRebind = () => { throw new Error('failed'); };
  assert.equal(frame.send({ changes: [change, root] }), false);
  assert.equal(frame.document.getElementById('copy'), null);
  assert.equal(title.previousSibling, audio);
  frame.window.__hfForceTimelineRebind = rebind;
  assert.equal(frame.send({ changes: [change, root] }), true);
  const added = frame.document.getElementById('copy')!;
  assert.equal(added.nextElementSibling, title);
  assert.equal(added.textContent, 'Copy');
  assert.equal(added.getAttribute('data-hf-id'), 'copy-hf');
  assert.equal(frame.document.getElementById('clip'), audio);
  assert.deepEqual(frame.hooks.slice(-3), ['seek:4', 'rebind', 'play']);
  frame.send({ type: 'handshake', timelineOnly: true });
  assert.equal(frame.replies.find(message => message.type === 'timeline-state')?.timelineVersion, etag(2));

});

it('projects a local structural draft, confirms without rebinding, and discards a rejected draft at the current playhead', () => {
  const message = { changes: [{ id: 'copy', hfId: 'copy-hf', tag: 'div', attributes: [], insert: {
    owner: 'root', next: null, whitespace: ['', '', ''], text: 'Copy',
    attrs: [['class', 'clip'], ['data-start', '4'], ['data-duration', '2']],
  } }] };
  const write = { ...message, structureDraftId: 'first', after: etag(1) };
  const frame = preview();
  assert.equal(frame.send(write), true);
  const painted = frame.document.getElementById('copy');
  assert.ok(painted);
  assert.deepEqual(frame.hooks, ['seek:4', 'rebind', 'play']);
  assert.equal(frame.send({ ...message, before: etag(2), after: etag(3) }), false);
  assert.equal(frame.send({ discardDraftId: 'other' }), false);
  assert.equal(frame.send(message), true);
  assert.equal(frame.document.getElementById('copy'), painted);
  assert.deepEqual(frame.hooks, ['seek:4', 'rebind', 'play']);
  assert.equal(frame.send({ discardDraftId: 'first' }), false);
  assert.equal(frame.send({ changes: [root], before: etag(2), after: etag(3) }), true);

  const rejected = preview();
  assert.equal(rejected.send(write), true);
  rejected.window.__player.getTime = () => 7;
  assert.equal(rejected.send({ discardDraftId: 'first' }), true);
  assert.equal(rejected.document.getElementById('copy'), null);
  assert.deepEqual(rejected.hooks.slice(-3), ['seek:7', 'rebind', 'play']);
  assert.equal(rejected.send(message), true);

  const raced = preview();
  assert.equal(raced.send(write), true);
  assert.equal(raced.send({ changes: [root] }), true);
  assert.equal(raced.document.getElementById('copy'), null);
  assert.equal(raced.send({ discardDraftId: 'first' }), false);

  const netZero = preview();
  assert.equal(netZero.send(write), true);
  assert.equal(netZero.send({ changes: [] }), false);
  assert.ok(netZero.document.getElementById('copy'));
  assert.equal(netZero.send({ changes: [], sameContent: true }), true);
  assert.equal(netZero.document.getElementById('copy'), null);
  assert.equal(netZero.send({ ...message, before: etag(2), after: etag(3) }), true);
});

it('updates text and placement on the same live nodes without seeking or replacing media', () => {
  const { send, document, hooks } = preview();
  const node = document.getElementById('title')!;
  const text = node.firstChild;
  const change = { id: 'title', tag: 'div', attributes: [], text: ['Hello', 'Hi!'],
    styles: [['left', '10px', '40px'], ['top', '', '12px'], ['font-size', '', '52px']] };
  const message = { type: 'peer-presentation', changes: [change] };
  assert.equal(send({ ...message, changes: [change, { ...change, text: ['stale', 'new'] }] }), false);
  assert.equal(node.textContent, 'Hello');
  assert.equal(node.style.left, '10px');
  assert.equal(send(message), true);
  assert.equal(node.firstChild, text);
  assert.equal(node.textContent, 'Hi!');
  assert.equal(node.style.left, '40px');
  assert.equal(node.style.top, '12px');
  assert.equal(node.style.fontSize, '52px');
  assert.deepEqual(hooks, []);
  assert.equal(send(message), false);
});

it('rebinds declarative track flags and gain without replacing media or accepting unrelated attributes', () => {
  const { document, send } = preview();
  const audio = document.getElementById('clip')!;
  const state = (attributes: unknown) => ({ changes: [{ id: 'clip', tag: 'audio', attributes }] });
  for (const invalid of [[['muted', null, 'false']], [['data-volume', null, '2']], [['src', null, 'other.wav']]]) {
    assert.equal(send(state(invalid)), false);
  }
  const message = state([['data-timeline-locked', null, ''], ['data-hidden', null, ''], ['muted', null, ''], ['data-volume', null, '0.5']]);
  const locked = preview();
  assert.equal(locked.send(state([['data-timeline-locked', null, ''], ['muted', null, '']])), true);
  assert.deepEqual(locked.hooks, []);
  assert.equal(preview(false, { mediaTiming: true }).send(message), false);
  assert.equal(send(message), true);
  assert.equal(document.getElementById('clip'), audio);
  assert.ok(audio.hasAttribute('muted') && audio.hasAttribute('data-timeline-locked') && audio.hasAttribute('data-hidden'));
  assert.equal(audio.getAttribute('data-volume'), '0.5');
  assert.equal(send({ before: etag(2), after: etag(3), ...state([['data-volume', '0.9', '1']]) }), false);
});

it('applies a solid fill without installing a new image URL through the live bridge', () => {
  const { document, send } = preview();
  const tile = document.getElementById('title')!;
  const fill = (image: string) => ({
    type: 'peer-presentation',
    changes: [{ id:'title', tag:'div', attributes:[], styles:[['background-color', '', 'red'], ['background-image', '', image]] }],
  });
  assert.equal(send(fill('url(asset.png)')), false);
  assert.equal(tile.style.getPropertyValue('background-color') || '', '');
  assert.equal(send(fill('none')), true);
  assert.equal(tile.style.getPropertyValue('background-color'), 'red');
  assert.equal(tile.style.getPropertyValue('background-image'), 'none');
});

it('updates font, verified pixel translation and text in the active file of a live document', () => {
  const message = (offset: string) => ({ type: 'peer-presentation', changes: [{ id: 'title', tag: 'div', attributes: [],
    text: ['Hello', 'Changed'], styles: [['font-family', '', 'Sample'], ['translate', '', offset]], captureOriginalTranslate: true }] });
  const { document, send, hooks } = preview();
  assert.equal(send(message('50% 12px')), false);
  assert.equal(send(message('30px 12px')), true);
  assert.equal(document.getElementById('title')!.style.getPropertyValue('font-family'), 'Sample');
  assert.equal(document.getElementById('title')!.style.getPropertyValue('translate'), '30px 12px');
  assert.equal(document.getElementById('title')!.getAttribute('data-hf-studio-original-inline-translate'), '');
  assert.equal(send({ type: 'peer-presentation', before: etag(2), after: etag(3), changes: [{ id: 'title', tag: 'div',
    attributes: [], styles: [['translate', '30px 12px', '']], captureOriginalTranslate: false }] }), true);
  assert.equal(document.getElementById('title')!.getAttribute('data-hf-studio-original-inline-translate'), null);
  assert.deepEqual(hooks, []);
  assert.equal(preview(false, { position: true }).send(message('30px 12px')), true);
});

it('shows a confirmed nested style on the old scripted document while keeping its loaded revision for rebuild', () => {
  const { send, document, hooks } = preview(false);
  const path = 'scenes/intro.html';
  document.querySelector('main')!.setAttribute('data-composition-file', path);
  const change = { id: 'title', tag: 'div', attributes: [], styles: [['font-size', '', '54px']] };
  const message = { type: 'peer-presentation', temporary: true, path, before: etag(3), after: etag(4), changes: [change] };
  assert.equal(send({ ...message, temporary: false }), false);
  assert.equal(send({ ...message, before: etag(1) }), false);
  assert.equal(send({ ...message, path: 'index.html', before: etag(1) }), false);
  assert.equal(send({ ...message, changes: [{ ...change, text: ['Hello', 'changed'] }] }), false);
  assert.equal(send({ ...message, changes: [{ ...change, attributes: [['data-duration', null, '9']] }] }), false);
  assert.equal(send(message), true);
  assert.equal(document.getElementById('title')!.style.fontSize, '54px');
  assert.equal(send({ ...message, before: etag(4), after: etag(5),
    changes: [{ ...change, styles: [['font-size', '54px', '56px']] }] }), false);
  assert.deepEqual(hooks, []);
});

it('only moves the existing canvas box when the project certifies a placement change', () => {
  const path = 'scenes/intro.html';
  const message = (property: string) => ({
    type: 'peer-presentation', path, before: etag(3), after: etag(4),
    changes: [{ tag: 'canvas', id: 'reel', attributes: [], styles: [[property, '', '32px']] }],
  });
  for (const certified of [false, true]) {
    const { send, document, hooks } = preview(false, certified ? { position: true } : undefined);
    const owner = document.querySelector('main')!;
    owner.setAttribute('data-composition-file', path);
    const canvas = document.createElement('canvas');
    canvas.id = 'reel';
    canvas.setAttribute('width', '1920');
    owner.appendChild(canvas);
    assert.equal(send(message('width')), false);
    assert.equal(send(message('left')), certified);
    assert.equal(canvas.style.left || '', certified ? '32px' : '');
    assert.equal(canvas.getAttribute('width'), '1920');
    assert.equal(document.getElementById('reel'), canvas);
    assert.deepEqual(hooks, []);
  }
});

it('resizes a mounted media box without replacing its drawing buffer, image or decoder', () => {
  const path = 'scenes/intro.html';
  for (const tag of ['canvas', 'img', 'video']) {
    const { send, document, hooks } = preview(false, undefined, [path]);
    const host = document.querySelector('main')!;
    host.setAttribute('data-composition-file', path);
    const node = document.createElement(tag);
    node.id = 'picture';
    node.setAttribute('width', '1200');
    host.append(node);
    const change = { id: 'picture', tag, attributes: [], styles: [['width', '', '1100px'], ['height', '', '600px']] };
    const message = { type: 'peer-presentation', path, before: etag(3), after: etag(4), changes: [change] };
    assert.equal(send({ ...message, before: etag(2) }), false);
    assert.equal(send(message), true);
    assert.equal(document.getElementById('picture'), node);
    assert.equal(node.getAttribute('width'), '1200');
    assert.equal(node.style.width, '1100px');
    assert.deepEqual(hooks, []);
  }
});

it('hot-resizes a nested CSS-animated canvas once on its verified revision, including the opposite-corner translation', () => {
  const path = 'scenes/intro.html';
  const changes = [{ id: 'drawing', tag: 'canvas', attributes: [], styles: [
    ['translate', '', '12px -9px'], ['width', '', '92px'], ['height', '', '43px'],
  ] }];
  for (const [timing, cssOffset, accepted] of [[false, false, false], [true, false, true], [false, true, true]]) {
    const { send, document, hooks } = preview(timing, cssOffset ? { cssLayoutOffset: true } : { position: true }, [path]);
    const host = document.querySelector('main')!;
    host.setAttribute('data-composition-file', path);
    const node = document.createElement('canvas');
    node.id = 'drawing';
    node.setAttribute('width', '1920');
    host.append(node);
    const msg = { type: 'peer-presentation', path, before: etag(3), after: etag(4), changes };
    assert.equal(send({...msg, changes: [{...changes[0], styles: [['translate', '', '50%'], ['width', '', '92px']]}]}), false);
    assert.equal(send({...msg, before: etag(2)}), false);
    assert.equal(send(msg), accepted);
    assert.equal(node.style.getPropertyValue('translate') || '', accepted ? '12px -9px' : '');
    assert.equal(node.style.getPropertyValue('width') || '', accepted ? '92px' : '');
    assert.equal(node.getAttribute('width'), '1920');
    assert.equal(document.getElementById('drawing'), node);
    assert.deepEqual(hooks, []);
    assert.equal(send(msg), false);
    if (accepted) {
      const undo = changes.map(c => ({...c, styles: c.styles.map(([name, from, to]) => [name, to, from])}));
      assert.equal(send({...msg, before: etag(4), after: etag(5), changes: undo}), true);
      assert.equal(node.style.getPropertyValue('translate') || '', '');
      assert.equal(node.style.getPropertyValue('width') || '', '');
    }
  }
});

it('keeps a mounted scripted child and its runtime descendants through verified pixel moves and resizes', () => {
  const path = 'scenes/intro.html';
  const { send, document, hooks } = preview(false, undefined, [path]);
  const host = document.querySelector('main')!;
  host.setAttribute('data-composition-file', path);
  const node = document.getElementById('title')!;
  const glyph = document.createElement('span');
  node.replaceChildren(glyph);
  const change = { id: 'title', tag: 'div', attributes: [], styles: [['left', '10px', '20px'], ['width', '', '84px']] };
  const message = { type: 'peer-presentation', path, before: etag(3), after: etag(4), changes: [change] };
  const overridden = preview(false);
  overridden.document.querySelector('main')!.setAttribute('data-composition-file', path);
  assert.equal(overridden.send(message), false);
  const duplicate = node.cloneNode(true);
  host.appendChild(duplicate);
  assert.equal(send(message), false);
  host.removeChild(duplicate);
  host.setAttribute('data-hf-parked-scene', '');
  assert.equal(send(message), false);
  host.removeAttribute('data-hf-parked-scene');
  node.style.width = '19px'; // A running script owns a different live value.
  assert.equal(send(message), false);
  assert.equal(node.style.left, '10px');
  node.style.removeProperty('width');
  assert.equal(send({ ...message, changes: [{ ...change, styles: [['width', '', '50%']] }] }), false);
  assert.equal(send(message), true);
  assert.equal(document.getElementById('title'), node);
  assert.equal(node.firstChild, glyph);
  assert.equal(node.style.width, '84px');
  assert.deepEqual(hooks, []);
});

it('advances a certified child placement through consecutive versions without restarting its animations', () => {
  const { send, document, hooks } = preview(false, { position: true });
  const path = 'scenes/intro.html';
  document.querySelector('main')!.setAttribute('data-composition-file', path);
  const move = (from: string, to: string) => [{ id: 'title', tag: 'div', attributes: [], styles: [['left', from, to]] }];
  const message = { type: 'peer-presentation', path, before: etag(3), after: etag(4), changes: move('10px', '18px') };
  assert.equal(send({ ...message, changes: move('10px', '50%') }), false);
  assert.equal(send({ ...message, changes: [{ ...move('10px', '18px')[0], text: ['Hello', 'other'] }] }), false);
  assert.equal(send(message), true);
  assert.equal(send(message), false);
  assert.equal(send({ ...message, before: etag(4), after: etag(5), changes: move('18px', '22px') }), true);
  assert.equal(document.getElementById('title')!.style.left, '22px');
  assert.deepEqual(hooks, []);
});

it('limits scripted media timing rebinding to audio moves and the active root duration', () => {
  const { send, document } = preview(false, { mediaTiming: true });
  document.getElementById('title')!.setAttribute('data-composition-id', 'child');
  const audio = { id: 'clip', tag: 'audio', attributes: [['data-start', '2', '3']] };
  assert.equal(send({ changes: [audio, { compositionId: 'child', tag: 'div', attributes: [['data-duration', null, '4']] }] }), false);
  assert.equal(document.getElementById('clip')!.getAttribute('data-start'), '2');
  assert.equal(send({ changes: [clip] }), false);
  assert.equal(send({ changes: [root, audio] }), true);
  assert.equal(document.getElementById('clip')!.getAttribute('data-start'), '3');
});

it('confirms an optimistic inspector value only for the writer and only on its displayed base', () => {
  const { send, document } = preview();
  const node = document.getElementById('title')!;
  const message = { type: 'peer-presentation', changes: [{
    id: 'title', tag: 'div', attributes: [], styles: [['left', '10px', '30px']],
  }] };
  node.style.left = '30px';
  assert.equal(send(message), false);
  assert.equal(send({ ...message, localSave: true, before: etag(3) }), false);
  node.style.left = '50px';
  assert.equal(send({ ...message, localSave: true }), false);
  assert.equal(node.style.left, '50px');
  node.style.left = '30px';
  assert.equal(send({ ...message, localSave: true }), true);
  assert.equal(node.style.left, '30px');
});

it('refuses expired, stale, unauthenticated, structural, ambiguous or incomplete work without a partial write', () => {
  const { send, document, hooks } = preview();
  const current = document.querySelector('main')!;
  assert.equal(send({}, 'https://elsewhere.test'), undefined);
  assert.equal(send({ token: 'wrong' }), undefined);
  assert.equal(send({ projectId: 'another' }), undefined);
  assert.equal(send({ documentId: 'retired-document' }), false);
  assert.equal(send({ path: 'other.html' }), false);
  assert.equal(send({ expiresAt: 0 }), false);
  assert.equal(send({ before: etag(9) }), false);
  assert.equal(send({ changes: [root, { ...clip, attributes: [['src', null, '/file']] }] }), false);
  assert.equal(send({ changes: [root, { ...clip, attributes: [['data-start', '8', '9']] }] }), false);
  const duplicate = document.getElementById('clip')!.cloneNode(false);
  current.appendChild(duplicate);
  assert.equal(send(), false);
  assert.equal(current.getAttribute('data-hf-authored-duration'), '15');
  assert.equal(current.hasAttribute('data-duration'), false);
  assert.deepEqual(hooks, []);
});

it('returns false and restores the old fields if runtime rebind fails', () => {
  const { window, document, send } = preview();
  const rebind = window.__hfForceTimelineRebind;
  window.__hfForceTimelineRebind = () => { throw new Error('runtime rejected'); };
  assert.equal(send(), false);
  assert.equal(document.querySelector('main')!.getAttribute('data-hf-authored-duration'), '15');
  assert.equal(document.getElementById('clip')!.getAttribute('data-start'), '2');
  window.__hfForceTimelineRebind = rebind;
  assert.equal(send(), true);
});

it('enables the fast path only for declarative documents with no user startup code to rerun', async () => {
  const { bundlePreviewInMemory } = await import('../../src/studio/engine/preview-bundler.ts');
  const { InMemoryVirtualProject } = await import('../../src/studio/virtual-project-store.ts');
  const { parseHTMLContent } = await import('@hyperframes/core/compiler/html-document');
  async function build(start: number, extra = '', otherFiles: Record<string, string> = {}) {
    const index = '<!doctype html><html><head></head><body><main data-composition-id="main" data-duration="6" data-width="900" data-height="500">' +
      '<div id="title" data-start="' + start + '" data-duration="2">Label</div>' + extra + '</main></body></html>';
    const sources = { 'index.html': index, ...otherFiles };
    const project = new InMemoryVirtualProject({ projectId: 'p', projectName: 'p', revision: sha(start),
      files: Object.entries(sources).map(([path, html]) => ({ path, blobScope: 'workspace', sha256: sha(start), sizeBytes: html.length, mimeType: 'text/html', isText: true, updatedAt: new Date() })),
      textContents: sources });
    const html = await bundlePreviewInMemory(project, { skipDeterministicFonts: true, bridgeOrigin: 'https://preview.test', studioOrigin: 'https://studio.test' });
    const doc = parseHTMLContent(html!);
    const settings = JSON.parse(doc.querySelector('script[data-openmotion-preview]')!.getAttribute('data-openmotion-preview')!);
    return { doc, allowed: settings.canRebindTiming === true };
  }
  const startup = '<script>document.querySelector("#title").textContent = document.querySelector("#title").dataset.start;</script>';
  for (const start of [2, 3]) {
    const { doc, allowed } = await build(start, startup);
    assert.equal(allowed, false);
    const title = doc.getElementById('title')!;
    runInNewContext('document.querySelector("#title").textContent = document.querySelector("#title").dataset.start;', { document: doc });
    assert.equal(title.textContent, String(start));
  }
  assert.equal((await build(2)).allowed, true);
  for (const script of ['window.__projectTitle = "hello";', "globalThis.__buildNumber = 17; window.__enabled = true;"]) {
    assert.equal((await build(2, '<script>' + script + '</script>')).allowed, true, script);
  }
  for (const script of ['window.__title = document.title', 'window.__player = "broken"', 'window.__proto__ = null',
    'window.location = "/other"', 'window.__x = 1; setTimeout(render)', 'window[key] = 1', 'window.__x = Math.random()']) {
    assert.equal((await build(2, '<script>' + script + '</script>')).allowed, false, script);
  }
  assert.equal((await build(2, '<canvas id="decoration"></canvas>')).allowed, true);
  assert.equal((await build(2, '<canvas id="decoration"></canvas>' + startup)).allowed, false);
  assert.equal((await build(2, '<canvas onclick="paint()"></canvas>')).allowed, false);
  assert.equal((await build(2, '<img onload="paint()" src="p.png">')).allowed, false);
  assert.equal((await build(2, '<div data-composition-src="scene.html"></div>')).allowed, false);
  assert.equal((await build(2, '', { '.hyperframes/studio-manual-edits.json': '{}' })).allowed, false);
});

it('advances a net-zero batch without touching playback and rejects its stale receipts', () => {
  const { send, hooks } = preview();
  assert.equal(send({ changes: [] }), false);
  assert.equal(send({ changes: [], sameContent: true }), true);
  assert.deepEqual(hooks, []);
  assert.equal(send(), false);
  assert.equal(send({ before: etag(2), after: etag(3) }), true);
});

it('displays the latest control while earlier file versions settle, preserving playback', () => {
  const { send, document, hooks } = preview();
  const title = document.getElementById('title')!;
  const project = (enabled: boolean, settled: boolean) => send({
    type: 'timeline-controls', attr: 'data-hidden',
    changes: [{ sourceFile: 'index.html', elementId: 'title', value: enabled ? '' : null, settled }],
  });
  project(true, false);
  assert.equal(title.hasAttribute('data-hidden'), true);
  assert.deepEqual(hooks, ['seek:4', 'play']);
  project(false, false);
  const confirm = (before: number, after: number, from: string | null, to: string | null) => send({
    before: etag(before), after: etag(after),
    changes: [{ id: 'title', tag: 'div', attributes: [['data-hidden', from, to]] }],
  });
  assert.equal(confirm(1, 2, null, ''), true);
  assert.equal(title.hasAttribute('data-hidden'), false);
  project(false, true);
  assert.equal(confirm(2, 3, '', null), true);
  project(true, true); // A receipt alone cannot start a gesture in a replacement document.
  assert.equal(title.hasAttribute('data-hidden'), false);
});

it('paints an entire verified bulk edit on the existing nodes or leaves them all unchanged', () => {
  const { send, document } = preview();
  const owner = document.querySelector('main')!;
  const nodes = Array.from({length: 100}, (_, i) => {
    const node = document.createElement('div');
    node.id = 'bulk-' + i;
    node.textContent = 'old';
    owner.appendChild(node);
    return node;
  });
  const changes = nodes.map(node => ({ id: node.id, tag: 'div', attributes: [], text: ['old', 'new'] }));
  const duplicate = nodes.at(-1)!.cloneNode(true);
  owner.appendChild(duplicate);
  assert.equal(send({ type: 'peer-presentation', changes }), false);
  assert.ok(nodes.every(node => node.textContent === 'old'));
  owner.removeChild(duplicate);
  assert.equal(send({ type: 'peer-presentation', changes }), true);
  assert.ok(nodes.every(node => document.getElementById(node.id) === node && node.textContent === 'new'));
});

it('keeps unrelated live handlers and reports the real root baseline in a scripted document', () => {
  const { send, document, replies, hooks } = preview(false);
  send({type: 'handshake'});
  const ready = replies.find(message => message.type === 'preview-ready') as
    {mountedVersions: Record<string, string>; liveEdits: PreviewLiveEdits} | undefined;
  assert.equal(ready?.mountedVersions['index.html'], etag(1));
  assert.equal(ready?.liveEdits.presentation, true);
  const title = document.getElementById('title')!;
  let events = 0;
  title.addEventListener('edit-check', () => events++);
  const message = { type: 'peer-presentation', changes: [{id: 'title', tag: 'div', attributes: [], text: ['Hello', 'Hi']}] };
  assert.equal(send(message), true);
  assert.equal(document.getElementById('title'), title);
  title.dispatchEvent(new document.defaultView!.Event('edit-check'));
  assert.equal(events, 1);
  assert.equal(title.textContent, 'Hi');
  assert.deepEqual(hooks, []);
  title.textContent = 'Owned by a script';
  const next = {...message, before: etag(2), after: etag(3), changes: [{...message.changes[0]!, text: ['Hi', 'Next']}]};
  assert.equal(send(next), false);
  assert.equal(title.textContent, 'Owned by a script');
  assert.equal(send({...next, changes:[root]}), false);
});
