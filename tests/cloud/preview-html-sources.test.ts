import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { parseHTMLContent } from '@hyperframes/core/compiler';
import { buildSubCompositionHtmlInMemory, bundlePreviewInMemory } from '../../src/studio/engine/preview-bundler.ts';
import { staticPreviewHtmlSources } from '../../src/studio/engine/preview-html-sources.ts';
import { InMemoryVirtualProject } from '../../src/studio/virtual-project-store.ts';

const scene = (body: string, id = 'main') =>
  `<html><head></head><body><main data-composition-id="${id}" data-duration="3">${body}</main></body></html>`;
const mount = (path: string, id: string) => `<div data-composition-id="${id}" data-composition-src="${path}"></div>`;

async function previewConfig(files: Record<string, string>, { clip, variables }: { clip?: string; variables?: Record<string, unknown> } = {}) {
  const project = new InMemoryVirtualProject({
    projectId: 'probe', projectName: 'Probe', revision: 'a'.repeat(64), textContents: files,
    files: Object.entries(files).map(([path, content]) => ({ path, blobScope: 'workspace', sha256: 'a'.repeat(64),
      sizeBytes: Buffer.byteLength(content), mimeType: 'text/html', isText: true, updatedAt: new Date() })),
  });
  const options = { bridgeOrigin: 'https://preview.test', skipDeterministicFonts: true, variables };
  const html = clip ? await buildSubCompositionHtmlInMemory(project, clip, options) : await bundlePreviewInMemory(project, options);
  const config = parseHTMLContent(html!).querySelector('script[data-openmotion-preview]')!.getAttribute('data-openmotion-preview');
  return JSON.parse(config!);
}

async function htmlSources(files: Record<string, string>) {
  return (await previewConfig(files)).htmlSources;
}

it('keeps placement on assembled CSS-only scenes and preserves script and unresolved-scene fallback', async () => {
  const entry = scene(mount('child.html', 'child'));
  const child = (extra = '') => scene('<h1 id="title">Move</h1><aside><ul><li><strong>Rich text</strong><br>works</li></ul></aside><style>@keyframes spin { to { transform: rotate(20deg) } }</style>' + extra, 'child');
  const cssOnly = await previewConfig({ 'index.html': entry, 'child.html': child(), 'unused.html': child() });
  assert.deepEqual(cssOnly.smallMountedSources, ['child.html']);
  const large = await previewConfig({ 'index.html': entry, 'child.html': child('x'.repeat(150 * 1024)) });
  assert.deepEqual(large.smallMountedSources, ['child.html']);
  assert.deepEqual(cssOnly.liveEdits, { position: true });
  assert.ok(!cssOnly.canRebindTiming);
  const scripted = await previewConfig({ 'index.html': entry, 'child.html': child('<script>observe()</script>') });
  assert.deepEqual(scripted.smallMountedSources, ['child.html']);
  assert.equal(scripted.liveEdits?.position, undefined);
  const authored = { 'index.html': entry, 'child.html': child('<script>observe()</script>') };
  assert.equal((await previewConfig(authored, { variables: { title: 'overridden' } })).smallMountedSources, undefined);
  for (const manifest of ['.hyperframes/studio-motion.json', '.hyperframes/studio-manual-edits.json']) {
    assert.equal((await previewConfig({ ...authored, [manifest]: '{}' })).smallMountedSources, undefined);
  }
  const digest = createHash('sha256').update(JSON.stringify('mediaTiming')).digest('hex');
  const declared = entry.replace('<head>', `<head><meta name="openmotion-live-edits" content="mediaTiming" data-scripts-sha256="${digest}">`);
  const withMedia = await previewConfig({ 'index.html': declared, 'child.html': child() });
  assert.deepEqual(withMedia.liveEdits, { position: true, mediaTiming: true });
  for (const extra of ['<script>window.place=document.body.offsetLeft</script>', '<img onload="layout()">',
    '<iframe src="extra.html"></iframe>', mount('missing.html', 'missing')]) {
    assert.equal((await previewConfig({ 'index.html': entry, 'child.html': child(extra) })).liveEdits, undefined, extra);
  }
});

it('records only the HTML actually assembled, including descendants resolved relative to their owner', async () => {
  const files = {
    'index.html': scene(mount('compositions/intro.html', 'intro')),
    'compositions/intro.html': scene(mount('title.html', 'title'), 'intro'),
    'compositions/title.html': scene('<h1>Hello</h1>', 'title'),
    'unused.html': scene('<script>loadSomething()</script>'),
  };
  assert.deepEqual(await htmlSources(files), ['index.html', 'compositions/intro.html', 'compositions/title.html']);
  assert.deepEqual(await htmlSources({ ...files, 'index.html': scene('<aside>Solo</aside>') }), ['index.html']);
});

it('retains full refresh for dynamic or unknown inputs, including those inside a nested template', async () => {
  for (const dynamic of ['<script>fetch("more.html")</script>', '<img src="image.png" onload="loadMore()">',
    '<iframe src="frame.html"></iframe>', '<style>@import "style.css"</style>', '<img src="photo.html">']) {
    const child = `<template><section data-composition-id="child">${dynamic}</section></template>`;
    assert.equal(await htmlSources({ 'index.html': scene(mount('child.html', 'child')), 'child.html': child }), undefined);
  }
  assert.equal(await htmlSources({ 'index.html': scene(mount('missing.html', 'missing')) }), undefined);
});

it('tracks referenced HTML through static RGB and HSL color declarations', async () => {
  const files = {
    'index.html': scene('<style>.card{color:RGB(255, 0, 1);background:hsl(210 60% 40% / 50%)}</style>' + mount('child.html', 'child')),
    'child.html': scene('<span style="color:rgba(2,3,4,.5);background:hsla(.5turn 30% 40% / 1)">Title</span>', 'child'),
    'unused.html': scene('<p>Unused</p>'),
  };
  assert.deepEqual(await htmlSources(files), ['index.html', 'child.html']);
});

it('keeps full refresh for mixed and unrecognized CSS even when it also contains numeric colors', () => {
  for (const value of [
    'rgb(1 2 3) url("a.png")', 'image-set("a.png" 1x)', 'color-mix(in srgb,rgb(1 2 3),hsl(0 40% 50%))',
    'rgb(var(--r) 2 3)', '--paint-rgb(1 2 3)', 'unknown\u00a0rgb(1 2 3)', 'rgb(1 2 3) /* hsl(0 40% 50%) */',
    String.raw`u\72l(a.png)`, '"rgb(1 2 3)"', 'rgb(1 2 3);@import "theme.css"',
  ]) {
    const nested = parseHTMLContent(scene(`<template><span></span><style>.a{background:${value}}</style></template>`));
    assert.equal(staticPreviewHtmlSources('index.html', nested, '/runtime.js').paths(), undefined, value);
  }
});

it('scopes a standalone clip to its own markup and inherited head only if all HTML inputs are known', async () => {
  const path = 'compositions/a.html';
  const clip = (body = '<p>A</p>', head = '') => previewConfig({
    'index.html': scene(mount('compositions/b.html', 'b')).replace('<head>', '<head>' + head),
    [path]: scene(body, 'a'),
  }, { clip: path });
  assert.deepEqual((await clip()).htmlSources, [path, 'index.html']);
  assert.equal((await clip(mount('nested.html', 'child'))).htmlSources, undefined);
  assert.equal((await clip('<script>fetch("c.html")</script>')).htmlSources, undefined);
  assert.equal((await clip('<p>A</p>', '<script>fetch("more.html")</script>')).htmlSources, undefined);
});
