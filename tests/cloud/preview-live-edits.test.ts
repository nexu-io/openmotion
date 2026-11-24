import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import { assembleBuiltinTemplate, BUILTIN_TEMPLATES } from '../../src/services/builtin-template-source.ts';
import { bundlePreviewInMemory } from '../../src/studio/engine/preview-bundler.ts';
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

test('only an author-reviewed script set opts into position and media timing updates', async () => {
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
