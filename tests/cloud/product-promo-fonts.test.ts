import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseHTMLContent } from '@hyperframes/core/compiler';
import { isTextProjectPath } from '../../shared/project-validation.ts';
import { getBuiltinTemplateSource } from '../../src/services/builtin-template-source.ts';
import { bundlePreviewInMemory, buildSubCompositionHtmlInMemory } from '../../src/studio/engine/preview-bundler.ts';
import { lintProjectInMemory } from '../../src/studio/engine/lint-project.ts';
import { InMemoryVirtualProject } from '../../src/studio/virtual-project-store.ts';

it('loads the vendored Inter font for the isolated Product Promo master and standalone scene', async () => {
  const template = await getBuiltinTemplateSource('product-promo');
  assert.ok(template);
  const files = template.files.filter(f => f.isProjectFile).map(f => ({
    ...f, isText: isTextProjectPath(f.path), blobScope: 'catalog' as const, updatedAt: new Date(0),
  }));
  const projectOptions = {
    projectId: 'promo', projectName: 'Product Promo', revision: template.catalogVersion, files,
    textContents: new Map(files.filter(f => f.isText).map(f => [f.path, f.bytes!.toString('utf8')])),
  };
  const project = new InMemoryVirtualProject(projectOptions);
  const requests: string[] = [];
  const options = {
    bridgeOrigin: 'https://preview.test', studioOrigin: 'https://studio.test',
    baseHref: 'https://preview.test/api/projects/promo/preview/~assets/lease/',
    fetchImpl: async (url: RequestInfo | URL) => { requests.push(String(url)); return new Response(null, { status: 404 }); },
  };
  const preflight = await lintProjectInMemory(project);
  assert.equal(preflight.totalWarnings + preflight.totalErrors, 0);
  const fonts = files.filter(f => f.mimeType.startsWith('font/'));
  assert.equal(fonts.length, 1, 'all authored weights share one download');
  const [font] = fonts;
  assert.equal(font.mimeType, 'font/woff2');
  for (const html of [await bundlePreviewInMemory(project, options),
    await buildSubCompositionHtmlInMemory(project, 'compositions/scene2-4-canvas.html', options)]) {
    const doc = parseHTMLContent(html!);
    const css = Array.from(doc.querySelectorAll('style'), el => el.textContent).join('\n');
    const face = css.match(/@font-face\s*\{[^}]+\}/g);
    assert.ok(face && face.length === 1);
    assert.match(face[0], /font-weight:\s*300 900/);
    const src = /url\(([^)]+)\)/.exec(face[0])![1];
    const base = doc.querySelector('base')!.getAttribute('href')!;
    assert.equal(new URL(src, base).href, new URL(font.path, options.baseHref).href);
  }
  assert.deepEqual(requests, [], 'project-declared Inter should not trigger remote font preparation');
  const missing = new InMemoryVirtualProject({ ...projectOptions, files: files.filter(f => f !== font) });
  const broken = await lintProjectInMemory(missing);
  assert.ok(broken.findings.some(f => f.code === 'missing_stylesheet_asset' && f.file === 'vendor/fonts/inter.css'));
});
