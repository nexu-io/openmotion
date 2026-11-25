import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import { assembleBuiltinTemplate, BUILTIN_TEMPLATES } from '../../src/services/builtin-template-source.ts';
import { buildSubCompositionHtmlInMemory, bundlePreviewInMemory } from '../../src/studio/engine/preview-bundler.ts';
import { verifiedPreviewLiveEdits } from '../../src/studio/engine/preview-live-edits.ts';
import { InMemoryVirtualProject } from '../../src/studio/virtual-project-store.ts';
import { isLiveMediaMove } from '../../shared/preview-live-media.ts';
import type { PreviewChange } from '../../shared/preview-timing.ts';

test('a media move can extend the root but cannot include another kind of edit', () => {
  const audio: PreviewChange = { tag:'audio', hfId:'soundtrack', id:'', compositionId:null, attributes:[['data-start','0','2']] };
  const root: PreviewChange = { tag:'main', hfId:null, id:'', compositionId:'main', attributes:[['data-duration','37.3','39.3']] };
  assert.ok(isLiveMediaMove([audio]));
  assert.ok(isLiveMediaMove([root, audio]));
  assert.equal(isLiveMediaMove([root]), false);
  assert.equal(isLiveMediaMove([root, root, audio]), false);
  assert.equal(isLiveMediaMove([{...audio, tag:'video'}]), false);
  assert.equal(isLiveMediaMove([{...audio, attributes:[['data-playback-start','0','2']]}]), false);
  assert.equal(isLiveMediaMove([audio, {...root, styles:[['left','0px','20px']]}]), false);
});

async function welcomeFixture() {
  const template = await assembleBuiltinTemplate(BUILTIN_TEMPLATES[0]!);
  const initial = Object.fromEntries(template.files.filter(f => f.isProjectFile).map(f => {
    assert.ok(f.bytes);
    return [f.path, f.bytes] as const;
  }));
  function fixture(replacements: Record<string, string> = {}, templateId?: string) {
    const contents = {...initial, ...Object.fromEntries(Object.entries(replacements).map(([path, value]) => [path, Buffer.from(value)]))};
    return new InMemoryVirtualProject({ projectId: 'user-copy', templateId, projectName: 'Renamed template', revision: '1',
      files: Object.entries(contents).map(([path, bytes]) => ({path, blobScope:'workspace', sha256:createHash('sha256').update(bytes).digest('hex'),
        sizeBytes:bytes.length, mimeType:'application/octet-stream', isText:/\.(?:html|js|css)$/.test(path), updatedAt:new Date(0)})),
      textContents: Object.fromEntries(Object.entries(contents).filter(([path]) => /\.(?:html|js|css)$/.test(path)).map(([path, bytes]) => [path, bytes.toString()])),
    });
  }
  return {template, fixture};
}

test('only an author-reviewed script set opts into position and media timing updates', async () => {
  const {template, fixture} = await welcomeFixture();
  const project = fixture();
  const capabilities = {mediaTiming:true, position:true};
  assert.deepEqual(await verifiedPreviewLiveEdits(project), capabilities);
  const html = await bundlePreviewInMemory(project, {bridgeOrigin:'https://preview.test', studioOrigin:'https://studio.test',skipDeterministicFonts:true});
  const settings = JSON.parse(parseHTMLContent(html!).querySelector('script[data-openmotion-preview]')!.getAttribute('data-openmotion-preview')!);
  assert.deepEqual(settings.liveEdits, capabilities);
  const index = project.readText('index.html')!;
  const moved = index.replace('src="assets/soundtrack.m4a" data-start="0"', 'src="assets/soundtrack.m4a" data-start="2"');
  assert.notEqual(moved, index);
  assert.deepEqual(await verifiedPreviewLiveEdits(fixture({'index.html':moved})), capabilities);
  const legacy = { 'index.html': index.replace(/<meta name="openmotion-live-edits"[^>]*>/, '') };
  assert.deepEqual(await verifiedPreviewLiveEdits(fixture(legacy, template.id)), capabilities);
  assert.equal(await verifiedPreviewLiveEdits(fixture(legacy, 'unknown-template')), undefined);
  assert.equal(await verifiedPreviewLiveEdits(fixture({ ...legacy, 'assets/artwork.js': 'window.x=document.body.offsetLeft' }, template.id)), undefined);
  assert.equal(await verifiedPreviewLiveEdits(fixture({ 'index.html': index.replace('data-scripts-sha256', 'obsolete') }, template.id)), undefined);
  const changes: Record<string, string>[] = [
    {'index.html': index.replace(/<meta name="openmotion-live-edits"[^>]*>/, '')},
    {'index.html': index.replace('</body>', '<script>document.title=document.querySelector("audio").dataset.start</script></body>')},
    {'compositions/intro.html': '<template><script>window.titleX=document.body.offsetLeft</script></template>'},
    {'assets/artwork.js': 'window.titleX=document.body.offsetLeft'},
    {'compositions/new.html': '<img src="title.png" onload="changeTimeline()">'},
  ];
  for (const change of changes) assert.equal(await verifiedPreviewLiveEdits(fixture(change)), undefined);
});

test('preview silently stops recursive mounts while rendering each independent instance', async () => {
  const host = (path: string) => `<div data-composition-src="${path}" data-start="0" data-duration="2"></div>`;
  const root = (id: string, inner: string) => `<div data-composition-id="${id}" data-width="800" data-height="450" data-duration="2">${inner}</div>`;
  const scene = (id: string, inner: string) => `<template id="${id}-template">${root(id, inner)}</template>`;
  const textContents = {
    'index.html': '<html><head></head><body>' + root('main', '<b class="root-marker">Root</b>' + host('./index.html') + host('./a.html') + host('b.html')) + '</body></html>',
    'a.html': scene('a', '<span class="scene-a">Scene A</span>' + host('intro.html')),
    'b.html': scene('b', host('intro.html')),
    'intro.html': scene('intro', '<span class="greeting">Hello</span>' + host('intro.html') + host('a.html') + host('index.html')),
  };
  const project = new InMemoryVirtualProject({ projectId:'cycle', projectName:'Cycle', revision:'1', textContents,
    files:Object.entries(textContents).map(([path, content]) => ({path, blobScope:'workspace',
      sha256:createHash('sha256').update(content).digest('hex'), isText:true, mimeType:'text/html', sizeBytes:content.length, updatedAt:new Date(0)})) });
  const html = await bundlePreviewInMemory(project, {skipDeterministicFonts:true});
  const doc = parseHTMLContent(html!);
  assert.equal(doc.querySelectorAll('.root-marker').length, 1);
  assert.equal(doc.querySelectorAll('.greeting').length, 2);
  assert.equal(doc.querySelectorAll('.scene-a').length, 2);
  assert.equal(doc.querySelectorAll('[data-composition-src]').length, 0);
  assert.equal(project.readText('intro.html'), textContents['intro.html']);
});

test('a separately opened Welcome clip certifies only its reviewed startup scripts and styles', async () => {
  const { template, fixture } = await welcomeFixture();
  const project = fixture();
  const path = 'compositions/intro.html';
  const text = project.readText(path)!;
  const index = project.readText('index.html')!;
  const oldIndex = index.replace(/ data-standalone-inputs="[^"]*"/, '');
  const options = {bridgeOrigin: 'https://preview.test', skipDeterministicFonts: true};
  async function sources(changes: Record<string, string>, clip = path) {
    const project = fixture(changes, template.id);
    const html = await buildSubCompositionHtmlInMemory(project, clip, options);
    const meta = parseHTMLContent(html!).querySelector('script[data-openmotion-preview]')!;
    return JSON.parse(meta.getAttribute('data-openmotion-preview')!).htmlSources;
  }
  for (const clip of template.files.filter(f => f.path.startsWith('compositions/') && f.path.endsWith('.html'))) {
    assert.deepEqual(await sources({}, clip.path), [clip.path, 'index.html']);
  }
  // An old clone can change its title, position or color and still use the audited code.
  const edited = text.replace('id="intro-headline"', 'id="intro-headline" style="left:50px;color:#234;font-size:42px"')
    .replace('</h1>', ' edited</h1>');
  assert.notEqual(edited, text);
  assert.deepEqual(await sources({'index.html': oldIndex, [path]: edited, 'compositions/reel.html': '<script>fetch("another.html")</script>'}),
    [path, 'index.html']);
  assert.deepEqual(await sources({'index.html': oldIndex, [path]: '<template><p>New text</p></template>'}), [path, 'index.html']);
  const changes: Record<string, string>[] = [
    { 'index.html': oldIndex, 'assets/artwork.js': 'fetch("other.html")' },
    { 'assets/film.css': '@import "other.html";' },
    { [path]: text.replace('<script>', '<script>fetch("extra.html");') },
    { [path]: text.replace('</h1>', '<iframe src="other.html"></iframe></h1>') },
    { [path]: text.replace('</h1>', '<i style="background:url(other.html)"></i></h1>') },
    { [path]: text.replace('</h1>', '<img src="other.html"></h1>') },
    { [path]: text.replace('</h1>', '<div data-composition-src="extra.html"></div></h1>') },
  ];
  for (const change of changes) assert.equal(await sources(change), undefined);
});
