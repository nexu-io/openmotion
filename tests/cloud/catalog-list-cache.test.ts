import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createCatalogRoutes } from '../../src/routes/catalog.ts';
import { serveStaticAsset } from '../../src/entrypoints/api.ts';
import type { CatalogService } from '../../src/services/catalog-service.ts';

test('public catalog list and detail endpoints emit Cache-Control, ETag, and 304 Not Modified', async () => {
  const samplePage = {
    items: [
      {
        id: 'product-launch',
        title: 'Product Launch',
        kind: 'builtin',
        tags: ['launch'],
        author: 'OpenMotion',
        hasHtmlProject: true,
      },
    ],
    total: 1,
    next: null,
    catalogVersion: 'cat-v42',
  };
  const sampleDetail = {
    id: 'product-launch',
    title: 'Product Launch',
    kind: 'builtin',
  };
  const fakeCatalog = {
    listTemplates: async () => samplePage,
    getTemplate: async () => sampleDetail,
  } as unknown as CatalogService;

  const app = new Hono();
  app.route('/motion-api', createCatalogRoutes({ catalog: fakeCatalog, basePath: '' }));

  for (const endpoint of [
    '/motion-api/template-catalog?category=all&limit=60&offset=0&locale=en',
    '/motion-api/templates?category=all&limit=60&offset=0&locale=en',
    '/motion-api/templates/product-launch?locale=en',
  ]) {
    const first = await app.request(endpoint);
    assert.equal(first.status, 200);
    const cacheControl = first.headers.get('cache-control') ?? '';
    assert.match(cacheControl, /public/);
    assert.match(cacheControl, /max-age=60/);
    assert.match(cacheControl, /stale-while-revalidate=600/);
    assert.equal(first.headers.get('vary'), 'Origin');
    const etag = first.headers.get('etag');
    assert.ok(etag && etag.startsWith('"sha256:'), `Expected sha256 ETag on ${endpoint}`);

    // Exact ETag match returns 304.
    const second = await app.request(endpoint, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
    assert.equal(second.headers.get('etag'), etag);

    // Proxy-weakened W/"..." ETag match also returns 304.
    const third = await app.request(endpoint, { headers: { 'If-None-Match': `W/${etag}` } });
    assert.equal(third.status, 304);
  }
});

test('serveStaticAsset emits extended cache headers and ETag/304 for /design-system/* fonts and CSS', async () => {
  const fontPath = '/design-system/fonts/AlbertSans-VariableFont_wght.woff2';
  const fontRes = await serveStaticAsset(fontPath);
  assert.ok(fontRes, 'Expected design-system WOFF2 font response');
  assert.equal(fontRes.status, 200);
  assert.match(fontRes.headers.get('cache-control') ?? '', /public, max-age=86400, stale-while-revalidate=604800/);
  const fontEtag = fontRes.headers.get('etag');
  assert.ok(fontEtag && fontEtag.startsWith('"sha256:'));

  const font304 = await serveStaticAsset(fontPath, undefined, false, { ifNoneMatch: fontEtag });
  assert.ok(font304);
  assert.equal(font304.status, 304);
  assert.equal(font304.headers.get('etag'), fontEtag);

  const cssPath = '/design-system/fonts.css';
  const cssRes = await serveStaticAsset(cssPath);
  assert.ok(cssRes, 'Expected design-system CSS response');
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get('cache-control') ?? '', /public, max-age=3600, stale-while-revalidate=86400/);
  const cssEtag = cssRes.headers.get('etag');
  assert.ok(cssEtag && cssEtag.startsWith('"sha256:'));

  const css304 = await serveStaticAsset(cssPath, undefined, false, { ifNoneMatch: `W/${cssEtag}` });
  assert.ok(css304);
  assert.equal(css304.status, 304);
});
