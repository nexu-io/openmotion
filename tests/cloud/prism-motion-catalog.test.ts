import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { PrismMotionCatalog, parsePrismMotionPublication, type PrismEnvironment } from '../../src/services/prism-motion-catalog.ts';

async function loadPrismMotionTemplates(environment: PrismEnvironment, fetchImpl: typeof fetch) {
  let error: unknown;
  const catalog = new PrismMotionCatalog(environment, {
    publicOrigin: 'https://cms-test.example', fetchImpl, onRefreshError: cause => { error = cause; },
  });
  await catalog.getTemplates();
  await setImmediate();
  if (error) throw error;
  return catalog.getTemplates();
}

const resourceId = '1500c9af-186b-457f-b74d-a58113f657d8';
const publicationId = '121e747a-bb51-48d6-a44b-56ea20d07c98';
const sha = 'a'.repeat(64);
const url = 'https://r.open-design.ai/files/' + sha;
const guide = 'https://r.open-design.ai/files/' + 'b'.repeat(64);
function template(id: string, title: string) {
  return {
    templateId: id, sortOrder: 2, original: { templateName: title, author: 'Motion' }, brand: 'OpenMotion',
    motionGuideUrl: guide, files: [] as Array<{ path: string; sha256: string; bytes: number; url: string }>, indexUrl: null as string | null,
  };
}
function fixture() {
  const project = template('editable', '可编辑');
  project.indexUrl = url;
  project.files = [{ path: 'index.html', sha256: sha, bytes: 23, url }];
  return {
    mainVersion: 'v2', resourceId, environment: 'dev', channel: 'default',
    version: '0.1.0', versionId: 'ver_' + '1'.repeat(32), generation: 7, publicationId, defaultLocale: 'zh-CN',
    content: {
      'zh-CN': { templates: [project, template('reference','参考')], brands: [{ name: 'OpenMotion', logoUrl: url }] },
      en: { templates: [{ ...project, original: { templateName: 'Editable', author: 'Motion' }, motionGuideUrl: url }] },
    },
  };
}

function delivery() {
  const { mainVersion: _version, content, ...identity } = fixture();
  const prefix = `/resources/${resourceId}/channels/default/versions/0.1.0`;
  const payloads = new Map<string, Buffer>();
  const contents = Object.entries(content).map(([locale, value]) => {
    const contentUrl = `${prefix}/${locale}.json`;
    const bytes = Buffer.from(JSON.stringify(value));
    payloads.set(contentUrl, bytes);
    return { locale, contentUrl, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { manifest: { ...identity, manifestVersion: 'v4', contentPublicationId: publicationId, mainUrl: prefix + '/main.json', contents }, payloads };
}

test('reads the canonical publication, normalizing editable projects, references and localized guides', async () => {
  const requests: string[] = [];
  const { manifest, payloads } = delivery();
  const result = await loadPrismMotionTemplates('dev', async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.redirect, 'error');
    assert(init?.signal instanceof AbortSignal);
    const path = new URL(String(input)).pathname;
    return path.endsWith('/manifest.json') ? Response.json(manifest) : new Response(payloads.get(path)!.toString());
  });
  const origin = 'https://cms-test.example';
  assert.deepEqual(requests, [origin + '/resources/' + resourceId + '/channels/default/manifest.json', ...manifest.contents.map(e => origin + e.contentUrl)]);
  const [project, reference] = result;
  assert.equal(project.catalogVersion, 'prism:dev:' + publicationId);
  assert.equal(project.metadata.version, '0.1.0');
  assert.equal(project.metadata.generation, 7);
  assert.deepEqual(project.metadata.brands, { OpenMotion: url });
  assert.deepEqual(project.metadata.locales, {
    'zh-CN': { original: { templateName: '可编辑', author: 'Motion' }, motionGuideUrl: guide, motionDocumentUrl: undefined, conversionNotes: undefined },
    en: { original: { templateName: 'Editable', author: 'Motion' }, motionGuideUrl: url, motionDocumentUrl: undefined, conversionNotes: undefined },
  });
  assert.equal(project.hasHtmlProject, true);
  assert.deepEqual(project.files[0], {
    path: 'index.html', sha256: sha, sizeBytes: 23, mimeType: 'text/html; charset=utf-8',
    isAvailable: false, isProjectFile: true, metadata: null, bytes: null, remoteUrl: url,
  });
  assert.equal(reference.hasHtmlProject, false);
  assert.deepEqual(reference.files, []);
  assert.equal(Object.hasOwn(reference.metadata.locales as object, 'en'), false);
});

test('fails on cross-environment content, the wrong resource or channel and incomplete default data', () => {
  const data = fixture();
  assert.throws(() => parsePrismMotionPublication(data, 'prod'), /environment/);
  for (const invalid of [{ channel: 'other' }, { resourceId: publicationId }, { mainVersion: 'v1' }, { publicationId: '42' }, { defaultLocale: 'ja' }]) {
    assert.throws(() => parsePrismMotionPublication({ ...data, ...invalid }, 'dev'));
  }
});

test('rejects reserved or duplicated template IDs and conflicting, incomplete, or untrusted file lists', () => {
  const changes: Array<(d: ReturnType<typeof fixture>) => void> = [
    d => { d.content['zh-CN'].templates[1].templateId = 'openmotion-welcome'; },
    d => { d.content.en.templates.push(d.content.en.templates[0]); },
    d => { d.content['zh-CN'].templates[0].files.push(d.content['zh-CN'].templates[0].files[0]); },
    d => { d.content['zh-CN'].templates[0].files[0].path = '../index.html'; },
    d => { d.content['zh-CN'].templates[0].files.push({ path: 'dist/gsap.min.js', sha256: sha, bytes: 23, url }); },
    d => { d.content['zh-CN'].templates[0].files[0].url = url.replace('open-design.ai','other.test'); },
    d => { d.content['zh-CN'].templates[0].files[0].url = guide; },
    d => { d.content['zh-CN'].templates[0].files[0].bytes = 60 * 1024 * 1024; },
    d => { d.content['zh-CN'].templates[0].indexUrl = guide; },
    d => { d.content.en.templates[0].motionGuideUrl += '?token=unused'; },
  ];
  for (const change of changes) {
    const data = fixture();
    change(data);
    assert.throws(() => parsePrismMotionPublication(data, 'dev'));
  }

  const withVendorDist = fixture();
  withVendorDist.content['zh-CN'].templates[0].files.push({
    path: 'vendor/gsap-3.14.2/dist/gsap.min.js', sha256: sha, bytes: 23, url,
  });
  const parsed = parsePrismMotionPublication(withVendorDist, 'dev');
  assert.ok(parsed[0].files.some(file => file.path === 'vendor/gsap-3.14.2/dist/gsap.min.js'));
});

test('rejects a failed download and cancels a streamed publication that exceeds the bound', async () => {
  await assert.rejects(loadPrismMotionTemplates('dev', async () => new Response(null, { status: 503 })), /503/);
  const chunk = new Uint8Array(1024 * 1024);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(loadPrismMotionTemplates('dev', async () => new Response(stream)), /exceeds/);
  assert.equal(cancelled, true);
});

test('rejects publication mixups or untrusted locale URLs before fetching any content', async () => {
  const changes: Array<(m: ReturnType<typeof delivery>['manifest']) => void> = [
    m => { m.environment = 'prod'; }, m => { m.contents.push(m.contents[0]); },
    m => { m.contents[0].contentUrl = 'https://not-prism.example/data.json'; },
    m => { m.mainUrl = m.mainUrl.replace('/default/', '/other/'); },
    m => { m.contents[0].byteLength = 64 * 1024 * 1024; },
    m => { m.contents = m.contents.filter(entry => entry.locale !== m.defaultLocale); },
  ];
  for (const change of changes) {
    const { manifest } = delivery();
    change(manifest);
    let requests = 0;
    await assert.rejects(loadPrismMotionTemplates('dev', async () => {
      requests++;
      return Response.json(manifest);
    }));
    assert.equal(requests, 1);
  }
});

test('verifies every locale against the single manifest before accepting the publication', async () => {
  for (const change of ['digest', 'length']) {
    const { manifest, payloads } = delivery();
    if (change === 'digest') manifest.contents[0].sha256 = '0'.repeat(64);
    else manifest.contents[0].byteLength++;
    await assert.rejects(loadPrismMotionTemplates('dev', async input => {
      const path = new URL(String(input)).pathname;
      return path.endsWith('/manifest.json') ? Response.json(manifest) : new Response(payloads.get(path)!.toString());
    }), /mismatch/);
  }
});

function fakeCms(environment: PrismEnvironment = 'dev', extra: { firstLoadWaitMs?: number } = {}) {
  const data = delivery();
  data.manifest.environment = environment;
  const requests: string[] = [];
  let now = 0;
  let hold: Promise<void> | undefined;
  let fail = false;
  const errors: unknown[] = [];
  const catalog = new PrismMotionCatalog(environment, {
    publicOrigin: environment === 'dev' ? 'https://cms-test.example' : undefined,
    now: () => now, ttlMs: 100, retryMs: 10, onRefreshError: error => errors.push(error), ...extra,
    fetchImpl: async input => {
      const url = new URL(String(input));
      requests.push(url.href);
      if (hold) await hold;
      if (fail) return new Response(null, { status: 503 });
      if (url.pathname.endsWith('/manifest.json')) return Response.json(data.manifest);
      return new Response(data.payloads.get(url.pathname)!.toString());
    },
  });
  return {
    catalog, data, requests, errors,
    advance(ms: number) { now += ms; },
    pause() {
      const gate = Promise.withResolvers<void>();
      hold = gate.promise;
      return () => { hold = undefined; gate.resolve(); };
    },
    fail(value: boolean) { fail = value; },
  };
}

test('concurrent cold callers share one download; stale reads use the previous snapshot during the manifest check', async () => {
  const cms = fakeCms();
  const release = cms.pause();
  const cold = Array.from({ length: 20 }, () => cms.catalog.getTemplates());
  assert.equal(cms.requests.length, 1);
  assert((await Promise.all(cold)).every(items => items.length === 0));
  release();
  await setImmediate();
  const snapshot = await cms.catalog.getTemplates();
  assert.equal(snapshot.length, 2);
  assert.equal(cms.requests.length, 3);
  cms.advance(99);
  assert.equal(await cms.catalog.getTemplates(), snapshot);
  assert.equal(cms.requests.length, 3);
  cms.advance(1);
  const finishCheck = cms.pause();
  const stale = await Promise.all(Array.from({ length: 20 }, () => cms.catalog.getTemplates()));
  assert(stale.every(items => items === snapshot));
  assert.equal(cms.requests.length, 4);
  finishCheck();
  await setImmediate();
  assert.equal(await cms.catalog.getTemplates(), snapshot);
  assert.equal(cms.requests.length, 4, 'unchanged publication must not re-download locale content');
});

test('callers that require the publication wait for the in-flight first load; a failed load still rejects', async () => {
  const cms = fakeCms();
  const release = cms.pause();
  const browsing = cms.catalog.getTemplates();
  const required = [cms.catalog.getTemplates({ requirePublication: true }), cms.catalog.getTemplates({ requirePublication: true })];
  assert.deepEqual(await browsing, []);
  release();
  const loaded = await Promise.all(required);
  assert(loaded.every(items => items.length === 2 && items === loaded[0]));
  assert.equal(cms.requests.length, 3, 'waiting callers share the single first download');

  const solo = fakeCms();
  const releaseSolo = solo.pause();
  const first = solo.catalog.getTemplates({ requirePublication: true });
  releaseSolo();
  assert.equal((await first).length, 2, 'the call that starts the first load also waits for it');

  const unavailable = { code: 'SERVICE_UNAVAILABLE', status: 503 };
  const down = fakeCms();
  down.fail(true);
  await assert.rejects(down.catalog.getTemplates({ requirePublication: true }), unavailable);
  assert.equal(down.requests.length, 1);
  assert.match(String(down.errors[0]), /503/);
  await assert.rejects(down.catalog.getTemplates({ requirePublication: true }), unavailable);
  assert.equal(down.requests.length, 1, 'a failed load backs off instead of retrying on every request');

  const hung = fakeCms('dev', { firstLoadWaitMs: 20 });
  const releaseHung = hung.pause();
  await assert.rejects(hung.catalog.getTemplates({ requirePublication: true }), unavailable, 'a hung first load is bounded, not awaited until the fetch timeout');
  releaseHung();
});

test('publishes a changed edition only after every language has been verified; failed refreshes back off', async () => {
  const cms = fakeCms();
  await cms.catalog.getTemplates();
  await setImmediate();
  const original = await cms.catalog.getTemplates();
  cms.advance(100);
  cms.data.manifest.publicationId = '121e747a-bb51-48d6-a44b-56ea20d07c99';
  const locale = cms.data.manifest.contents[1];
  const correct = locale.sha256;
  locale.sha256 = '0'.repeat(64);
  assert.equal(await cms.catalog.getTemplates(), original);
  await setImmediate();
  assert.equal(cms.errors.length, 1);
  const failedRequests = cms.requests.length;
  cms.advance(9);
  assert.equal(await cms.catalog.getTemplates(), original);
  assert.equal(cms.requests.length, failedRequests);
  locale.sha256 = correct;
  cms.advance(1);
  assert.equal(await cms.catalog.getTemplates(), original);
  await setImmediate();
  const updated = await cms.catalog.getTemplates();
  assert.notEqual(updated, original);
  assert.equal(updated[0].catalogVersion, `prism:dev:${cms.data.manifest.publicationId}`);
  assert.equal(cms.requests.length - failedRequests, 3);
});

test('a failed initial read can be retried and caches never cross their deployment environment', async () => {
  const dev = fakeCms('dev'), prod = fakeCms('prod');
  dev.fail(true);
  assert.deepEqual(await Promise.all([dev.catalog.getTemplates(), dev.catalog.getTemplates()]), [[], []]);
  await setImmediate();
  assert.match(String(dev.errors[0]), /503/);
  assert.equal(dev.requests.length, 1);
  dev.fail(false);
  assert.deepEqual(await dev.catalog.getTemplates(), []);
  assert.equal(dev.requests.length, 1);
  dev.advance(10);
  await Promise.all([dev.catalog.getTemplates(), prod.catalog.getTemplates()]);
  await setImmediate();
  const [devResult, prodResult] = await Promise.all([dev.catalog.getTemplates(), prod.catalog.getTemplates()]);
  assert.equal(devResult[0].catalogVersion, 'prism:dev:' + publicationId);
  assert.equal(prodResult[0].catalogVersion, 'prism:prod:' + publicationId);
  assert(dev.requests.every(url => new URL(url).hostname === 'cms-test.example'));
  assert(prod.requests.every(url => new URL(url).hostname === 'r.open-design.ai'));
});

test('requires an explicit HTTPS origin in the test environment', () => {
  assert.throws(() => new PrismMotionCatalog('dev'), /PRISM_PUBLIC_ORIGIN/);
  for (const publicOrigin of ['http://cms.example', 'https://user@cms.example', 'https://cms.example/path']) {
    assert.throws(() => new PrismMotionCatalog('dev', { publicOrigin }), /HTTPS origin/);
  }
});
