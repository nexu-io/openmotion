import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { DEFAULT_PAT_SCOPES, type AuthContext } from '../../src/contracts/auth.ts';
import type {
  BlobScope,
  HeadObjectResult,
  ObjectStreamResult,
  PresignGetOptions,
  PresignPutOptions,
  StoragePort,
} from '../../src/contracts/storage.ts';
import {
  assertTenantScopedKey,
  catalogCompFilmstripKey,
  isCatalogCasKey,
  isImmutableCasKey,
  projectCompFilmstripKey,
  projectCompThumbsPrefix,
} from '../../src/infra/storage.ts';
import {
  clearBuiltinFilmstripCacheForTest,
  getBuiltinCompositionFilmstrip,
} from '../../src/services/builtin-filmstrip-store.ts';
import {
  assembleBuiltinTemplate,
  BUILTIN_TEMPLATES,
  WELCOME_TEMPLATE_ID,
} from '../../src/services/builtin-template-source.ts';
import { handleStudioError, type DisklessStudioDeps } from '../../src/studio/context.ts';
import {
  COMPOSITION_FILMSTRIP_VERSION,
  computeCompositionFilmstripDepsDigest,
  computeCompositionFilmstripRenderKey,
  computeLegacyV1CompositionFilmstripDepsDigest,
  embedFilmstripComment,
  extractFilmstripMeta,
  extractIndexHeadMarkup,
  preloadTransitiveReferencedCodeAssets,
  FILMSTRIP_HEADER_ASPECT,
  FILMSTRIP_HEADER_FRAMES,
  FILMSTRIP_HEADER_HEIGHT,
  FILMSTRIP_HEADER_RENDER_KEY,
  FILMSTRIP_HEADER_SCOPE,
  FILMSTRIP_HEADER_SHA256,
  FILMSTRIP_HEADER_SOURCE,
  FILMSTRIP_HEADER_WIDTH,
  MAX_FILMSTRIP_JPEG_BYTES,
  parseJpegSofDimensions,
} from '../../src/studio/engine/composition-filmstrip-sprite.ts';
import { createStudioCompositionFilmstripsRoutes } from '../../src/studio/routes/composition-filmstrips.ts';
import { listVirtualCompositions, type VirtualFileRecord } from '../../src/studio/virtual-project-store.ts';

const WID_A = '11111111-1111-4111-8111-111111111111';
const WID_B = '22222222-2222-4222-8222-222222222222';
const PID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHA_SCENE = 'a'.repeat(64);
const SHA_OTHER = 'b'.repeat(64);
const SHA_PATCH = 'c'.repeat(64);

async function makeTestSpriteJpeg(
  frameCount: number,
  frameWidth = 160,
  frameHeight = 90,
): Promise<Buffer> {
  return sharp({
    create: {
      width: frameCount * frameWidth,
      height: frameHeight,
      channels: 3,
      background: { r: 32, g: 64, b: 128 },
    },
  })
    .jpeg({ quality: 75 })
    .toBuffer();
}

class MemoryStorage implements StoragePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  putCount = 0;

  async putObject(
    key: string,
    body: Buffer | Uint8Array | Readable | string,
    contentType: string,
  ): Promise<void> {
    this.putCount += 1;
    const buf = Buffer.isBuffer(body)
      ? Buffer.from(body)
      : typeof body === 'string'
        ? Buffer.from(body, 'utf8')
        : body instanceof Uint8Array
          ? Buffer.from(body)
          : Buffer.alloc(0);
    this.objects.set(key, { body: buf, contentType });
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    if (this.objects.has(key)) return { uploaded: false };
    await this.putObject(key, body, contentType);
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(found.body);
  }

  async getObjectStream(key: string): Promise<ObjectStreamResult> {
    const buf = await this.getObjectBuffer(key);
    return { stream: Readable.from([buf]), contentLength: buf.byteLength, contentType: 'image/jpeg' };
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    const etag = `"${createHash('sha256').update(found.body).digest('hex')}"`;
    return { contentLength: found.body.byteLength, contentType: found.contentType, etag };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(prefix)) {
        this.objects.delete(k);
        count++;
      }
    }
    return count;
  }

  async presignPut(key: string, _options: PresignPutOptions): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async presignGet(key: string, _options?: PresignGetOptions): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    workspaceId: WID_A,
    userId: USER_A,
    role: 'editor',
    scopes: [...DEFAULT_PAT_SCOPES],
    authMode: 'dev',
    authMethod: 'dev_bypass',
    ...overrides,
  };
}

function makeRouteApp(
  storage: MemoryStorage,
  projectLookup: (
    auth: AuthContext,
    projectId: string,
  ) => { files: VirtualFileRecord[]; texts?: ReadonlyMap<string, string> } | null,
  authResolver: (req: Request) => AuthContext,
) {
  const deps = {
    storage,
    files: {
      listFiles: async (auth: AuthContext, projectId: string) =>
        projectLookup(auth, projectId)?.files ?? [],
      getFile: async (auth: AuthContext, projectId: string, filePath: string) =>
        projectLookup(auth, projectId)?.files.find((f) => f.path === filePath) ?? null,
      readTextFile: async (auth: AuthContext, projectId: string, filePath: string) => {
        const proj = projectLookup(auth, projectId);
        const rec = proj?.files.find((f) => f.path === filePath);
        const content = proj?.texts?.get(filePath);
        if (!rec || content === undefined) return null;
        return {
          path: rec.path,
          content,
          version: `"${rec.blobScope}:${rec.sha256}"`,
          sha256: rec.sha256,
          blobScope: rec.blobScope,
        };
      },
    },
    resolveAuth: (c: { req: { raw: Request } }) => authResolver(c.req.raw),
  } as unknown as DisklessStudioDeps;
  const app = createStudioCompositionFilmstripsRoutes(deps);
  app.onError((err, c) => handleStudioError(c, err));
  return app;
}

describe('Composition filmstrip sprite codec & storage security', () => {
  it('embeds and extracts validated OMFS1 metadata inside standard JPEG bytes', async () => {
    const raw = await makeTestSpriteJpeg(8, 160, 90);
    assert.deepEqual(parseJpegSofDimensions(raw), { width: 1280, height: 90 });
    assert.equal(extractFilmstripMeta(raw), null);

    const tagged = embedFilmstripComment(raw, {
      version: 1,
      frameCount: 8,
      frameWidth: 160,
      frameHeight: 90,
      aspect: 16 / 9,
    });
    assert.ok(tagged);
    const meta = extractFilmstripMeta(tagged);
    assert.deepEqual(meta, {
      version: 1,
      frameCount: 8,
      frameWidth: 160,
      frameHeight: 90,
      aspect: 1.7778,
    });

    // Re-embedding replaces prior OMFS1 comment cleanly instead of duplicating it.
    const retagged = embedFilmstripComment(tagged, {
      version: 1,
      frameCount: 8,
      frameWidth: 160,
      frameHeight: 90,
      aspect: 1.7778,
    });
    assert.ok(retagged);
    assert.equal(retagged.byteLength, tagged.byteLength);
    assert.deepEqual(extractFilmstripMeta(retagged), meta);
  });

  it('rejects non-JPEG data, mismatched SOF dimensions, and out-of-range metadata', async () => {
    const raw4 = await makeTestSpriteJpeg(4, 160, 90);
    assert.equal(
      embedFilmstripComment(raw4, { version: 1, frameCount: 8, frameWidth: 160, frameHeight: 90, aspect: 16 / 9 }),
      null,
    );
    assert.equal(
      embedFilmstripComment(Buffer.from('not-a-jpeg'), {
        version: 1,
        frameCount: 1,
        frameWidth: 160,
        frameHeight: 90,
        aspect: 16 / 9,
      }),
      null,
    );
    assert.equal(
      embedFilmstripComment(raw4, { version: 1, frameCount: 0, frameWidth: 160, frameHeight: 90, aspect: 16 / 9 }),
      null,
    );
    assert.equal(
      embedFilmstripComment(raw4, { version: 1, frameCount: 4, frameWidth: 160, frameHeight: 91, aspect: 16 / 9 }),
      null,
    );
  });

  it('scopes catalog filmstrip keys to read-only allowCatalog guards and binds depsSha256 and explicit version', () => {
    const key = catalogCompFilmstripKey(SHA_SCENE, SHA_OTHER, COMPOSITION_FILMSTRIP_VERSION);
    assert.equal(key, `catalog/filmstrips/v${COMPOSITION_FILMSTRIP_VERSION}/${SHA_SCENE}/${SHA_OTHER}/strip.jpg`);
    const v2Key = catalogCompFilmstripKey(SHA_SCENE, SHA_OTHER, 2);
    assert.equal(v2Key, `catalog/filmstrips/v2/${SHA_SCENE}/${SHA_OTHER}/strip.jpg`);
    assert.equal(isCatalogCasKey(key), true);
    assert.equal(isCatalogCasKey(v2Key), true);
    assert.equal(isImmutableCasKey(key), true);
    assert.equal(assertTenantScopedKey(WID_A, key, { allowCatalog: true }), key);
    assert.throws(() => assertTenantScopedKey(WID_A, key), { code: 'WORKSPACE_FORBIDDEN' });
    assert.throws(() => assertTenantScopedKey(WID_A, key, { allowCatalog: false }), {
      code: 'WORKSPACE_FORBIDDEN',
    });
    assert.throws(() => catalogCompFilmstripKey(SHA_SCENE, SHA_OTHER, 0), { code: 'INVALID_PATH' });
    // Legacy key without depsSha256 is no longer accepted as a catalog CAS key.
    assert.equal(isCatalogCasKey(`catalog/filmstrips/${SHA_SCENE}/strip-v1.jpg`), false);
  });

  it('ships valid pre-baked 8-frame filmstrips for every built-in template composition', async () => {
    clearBuiltinFilmstripCacheForTest();
    let verifiedCount = 0;
    for (const def of BUILTIN_TEMPLATES) {
      const assembled = await assembleBuiltinTemplate(def);
      const projectFiles = assembled.files.filter((f) => f.isProjectFile && f.bytes !== null);
      const texts = new Map<string, string>();
      const records: VirtualFileRecord[] = projectFiles.map((f) => {
        const isText = /\.(?:html?|css|js|mjs|json|svg|txt)$/i.test(f.path);
        if (isText) texts.set(f.path, f.bytes!.toString('utf8'));
        return {
          path: f.path,
          blobScope: 'catalog',
          sha256: f.sha256,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          isText,
          updatedAt: new Date(0),
          metadata: f.metadata,
        };
      });
      const indexHead = extractIndexHeadMarkup(texts.get('index.html'));
      const allComps = listVirtualCompositions(records);
      const targetComps = allComps.filter((p) => p !== 'index.html');
      const comps = targetComps.length > 0 ? targetComps : allComps;
      for (const compPath of comps) {
        const file = projectFiles.find((f) => f.path === compPath);
        assert.ok(file, `Missing file ${compPath} in ${def.id}`);
        const loaded = await getBuiltinCompositionFilmstrip(file.sha256);
        assert.ok(
          loaded,
          `Missing pre-baked filmstrip for ${def.id}/${compPath} (${file.sha256}). Run npm run templates:filmstrips`,
        );
        const { depsSha256 } = computeCompositionFilmstripDepsDigest({
          compPath,
          files: records,
          indexHead,
          readText: (filePath) => texts.get(filePath) ?? null,
        });
        assert.equal(loaded.depsSha256, depsSha256);
        assert.equal(loaded.meta.frameCount, 8);
        assert.equal(loaded.meta.frameWidth, 160);
        assert.ok(loaded.bytes.byteLength > 1000 && loaded.bytes.byteLength <= MAX_FILMSTRIP_JPEG_BYTES);
        verifiedCount += 1;
      }
    }
    assert.ok(verifiedCount >= 12, `Expected at least 12 built-in scenes, got ${verifiedCount}`);
    assert.equal(await getBuiltinCompositionFilmstrip('not-a-sha'), null);
    assert.equal(await getBuiltinCompositionFilmstrip('0'.repeat(64)), null);
  });
});

describe('Studio composition filmstrip HTTP routes', () => {
  it('serves pre-baked built-in scenes with 0 S3 writes, survives index body edits, and invalidates on CSS/asset/head edits', async () => {
    const welcome = await assembleBuiltinTemplate(
      BUILTIN_TEMPLATES.find((t) => t.id === WELCOME_TEMPLATE_ID)!,
    );
    const projectFiles = welcome.files.filter((f) => f.isProjectFile && f.bytes !== null);
    const texts = new Map<string, string>();
    const files: VirtualFileRecord[] = projectFiles.map((f) => {
      const isText = /\.(?:html?|css|js|mjs|json|svg|txt)$/i.test(f.path);
      if (isText) texts.set(f.path, f.bytes!.toString('utf8'));
      return {
        path: f.path,
        blobScope: 'catalog',
        sha256: f.sha256,
        sizeBytes: f.sizeBytes,
        mimeType: f.mimeType,
        isText,
        updatedAt: new Date(0),
        metadata: f.metadata,
      };
    });
    const introFile = files.find((f) => f.path === 'compositions/intro.html')!;
    const storage = new MemoryStorage();
    const app = makeRouteApp(
      storage,
      (_auth, projectId) => (projectId === PID_A ? { files, texts } : null),
      () => makeAuth(),
    );

    const getRes = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
    );
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('content-type'), 'image/jpeg');
    assert.equal(getRes.headers.get(FILMSTRIP_HEADER_SOURCE), 'builtin');
    assert.equal(getRes.headers.get(FILMSTRIP_HEADER_FRAMES), '8');
    assert.equal(getRes.headers.get(FILMSTRIP_HEADER_SHA256), introFile.sha256);
    const initialRenderKey = getRes.headers.get(FILMSTRIP_HEADER_RENDER_KEY);
    assert.ok(initialRenderKey && /^[a-f0-9]{64}$/.test(initialRenderKey));
    assert.equal(getRes.headers.get('cache-control'), 'private, no-cache');
    const etag = getRes.headers.get('etag');
    assert.ok(etag && etag.includes(PID_A) && etag.includes(initialRenderKey));
    const body = Buffer.from(await getRes.arrayBuffer());
    assert.ok(extractFilmstripMeta(body)?.frameCount === 8);

    const headRes = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
      { method: 'HEAD' },
    );
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get(FILMSTRIP_HEADER_SOURCE), 'builtin');
    assert.equal((await headRes.arrayBuffer()).byteLength, 0);

    const notModRes = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
      { headers: { 'if-none-match': etag } },
    );
    assert.equal(notModRes.status, 304);

    // Client PUT for an already pre-baked built-in scene skips duplicate S3 storage.
    const raw8 = await makeTestSpriteJpeg(8, 160, 90);
    const putRes = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: introFile.sha256,
          [FILMSTRIP_HEADER_RENDER_KEY]: initialRenderKey,
          [FILMSTRIP_HEADER_SCOPE]: 'catalog',
          [FILMSTRIP_HEADER_FRAMES]: '8',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw8),
      },
    );
    assert.equal(putRes.status, 200);
    assert.deepEqual(await putRes.json(), {
      stored: false,
      reason: 'already_cached',
      source: 'builtin',
      frameCount: 8,
      sha256: introFile.sha256,
      renderKey: initialRenderKey,
    });
    assert.equal(storage.putCount, 0);

    // Moving/trimming/splitting a clip edits only index.html <body> (same <head>) -> STILL hits built-in 0ms.
    const indexIdx = files.findIndex((f) => f.path === 'index.html');
    const origIndexHtml = texts.get('index.html')!;
    const movedBodyHtml = origIndexHtml.replace('</body>', '<!-- clip moved --></body>');
    texts.set('index.html', movedBodyHtml);
    files[indexIdx] = {
      ...files[indexIdx]!,
      blobScope: 'patch',
      sha256: createHash('sha256').update(movedBodyHtml).digest('hex'),
    };
    const afterBodyMove = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
    );
    assert.equal(afterBodyMove.status, 200);
    assert.equal(afterBodyMove.headers.get(FILMSTRIP_HEADER_SOURCE), 'builtin');
    assert.equal(afterBodyMove.headers.get(FILMSTRIP_HEADER_RENDER_KEY), initialRenderKey);

    // Editing a shared CSS / image asset (without touching intro.html) MUST invalidate the built-in sprite.
    const sharedAssetIdx = files.findIndex(
      (f) => f.path !== 'index.html' && !f.path.endsWith('.html'),
    );
    assert.ok(sharedAssetIdx >= 0, 'Expected at least one shared non-HTML asset in Welcome template');
    files[sharedAssetIdx] = {
      ...files[sharedAssetIdx]!,
      blobScope: 'workspace',
      sha256: SHA_OTHER,
    };
    const afterCssEdit = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
    );
    assert.equal(afterCssEdit.status, 204);
    const updatedRenderKey = afterCssEdit.headers.get(FILMSTRIP_HEADER_RENDER_KEY);
    assert.ok(updatedRenderKey && updatedRenderKey !== initialRenderKey);

    // Stale PUT carrying the pre-CSS-edit renderKey is rejected with 409 Conflict.
    const staleDepPut = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: introFile.sha256,
          [FILMSTRIP_HEADER_RENDER_KEY]: initialRenderKey,
          [FILMSTRIP_HEADER_SCOPE]: 'catalog',
          [FILMSTRIP_HEADER_FRAMES]: '8',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw8),
      },
    );
    assert.equal(staleDepPut.status, 409);

    // Fresh PUT with the updated renderKey writes ONLY to this project's comp-thumbs keyspace.
    const freshDepPut = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: introFile.sha256,
          [FILMSTRIP_HEADER_RENDER_KEY]: updatedRenderKey,
          [FILMSTRIP_HEADER_SCOPE]: 'catalog',
          [FILMSTRIP_HEADER_FRAMES]: '8',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw8),
      },
    );
    assert.equal(freshDepPut.status, 200);
    assert.equal(
      storage.objects.has(projectCompFilmstripKey(WID_A, PID_A, updatedRenderKey)),
      true,
    );

    // Editing index.html <head> also rotates the renderKey and misses until recaptured.
    const editedHeadHtml = movedBodyHtml.replace('</head>', '<style>body{background:#111}</style></head>');
    texts.set('index.html', editedHeadHtml);
    files[indexIdx] = {
      ...files[indexIdx]!,
      blobScope: 'patch',
      sha256: createHash('sha256').update(editedHeadHtml).digest('hex'),
    };
    const afterHeadEdit = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
    );
    assert.equal(afterHeadEdit.status, 204);
    assert.notEqual(afterHeadEdit.headers.get(FILMSTRIP_HEADER_RENDER_KEY), updatedRenderKey);
  });

  it('serves S3 catalog filmstrips read-only only when dependencies are catalog and never allows client PUT to write catalog/*', async () => {
    const storage = new MemoryStorage();
    const raw8 = await makeTestSpriteJpeg(8, 160, 90);
    const tagged8 = embedFilmstripComment(raw8, {
      version: 1,
      frameCount: 8,
      frameWidth: 160,
      frameHeight: 90,
      aspect: 16 / 9,
    })!;

    let cssScope: BlobScope = 'catalog';
    let cssSha = SHA_OTHER;
    let includeCss = true;
    const buildFiles = (): VirtualFileRecord[] => [
      {
        path: 'compositions/prism.html',
        blobScope: 'catalog',
        sha256: SHA_SCENE,
        sizeBytes: 512,
        mimeType: 'text/html; charset=utf-8',
        isText: true,
        updatedAt: new Date(0),
      },
      ...(includeCss
        ? [
            {
              path: 'assets/film.css',
              blobScope: cssScope,
              sha256: cssSha,
              sizeBytes: 128,
              mimeType: 'text/css',
              isText: true,
              updatedAt: new Date(0),
            } satisfies VirtualFileRecord,
          ]
        : []),
    ];
    const app = makeRouteApp(
      storage,
      (_auth, projectId) => (projectId === PID_A ? { files: buildFiles() } : null),
      () => makeAuth(),
    );

    const { depsSha256: initialDepsSha } = computeCompositionFilmstripDepsDigest({
      compPath: 'compositions/prism.html',
      files: buildFiles(),
      indexHead: null,
    });
    const initialCatalogKey = catalogCompFilmstripKey(
      SHA_SCENE,
      initialDepsSha,
      COMPOSITION_FILMSTRIP_VERSION,
    );

    const miss = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/prism.html`,
    );
    assert.equal(miss.status, 204);
    assert.equal(miss.headers.get(FILMSTRIP_HEADER_SHA256), SHA_SCENE);
    assert.equal(miss.headers.get(FILMSTRIP_HEADER_SCOPE), 'catalog');
    const renderKey = miss.headers.get(FILMSTRIP_HEADER_RENDER_KEY)!;
    assert.ok(/^[a-f0-9]{64}$/.test(renderKey));

    const raw4 = await makeTestSpriteJpeg(4, 160, 90);
    const put = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/prism.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKey,
          [FILMSTRIP_HEADER_SCOPE]: 'catalog',
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(put.status, 200);
    assert.equal(storage.objects.has(initialCatalogKey), false);
    assert.equal(storage.objects.has(projectCompFilmstripKey(WID_A, PID_A, renderKey)), true);

    // Once trusted worker populates catalog/filmstrips/v1/{fileSha}/{depsSha}/strip.jpg, GET prefers catalog while deps match.
    await storage.putObject(initialCatalogKey, tagged8, 'image/jpeg');
    const hit = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/prism.html`,
    );
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get(FILMSTRIP_HEADER_SOURCE), 'catalog');
    assert.equal(hit.headers.get(FILMSTRIP_HEADER_FRAMES), '8');

    // Deleting a catalog dependency leaves all remaining files catalog-scoped, but rotates depsSha256
    // so the old catalog sprite is NOT served and a fresh workspace PUT is accepted instead of returning already_cached.
    includeCss = false;
    const missAfterDelete = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/prism.html`,
    );
    assert.equal(missAfterDelete.status, 204);
    const deletedDepsRenderKey = missAfterDelete.headers.get(FILMSTRIP_HEADER_RENDER_KEY)!;
    assert.notEqual(deletedDepsRenderKey, renderKey);

    const repairPut = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/prism.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: deletedDepsRenderKey,
          [FILMSTRIP_HEADER_SCOPE]: 'catalog',
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(repairPut.status, 200);
    const repairBody = (await repairPut.json()) as { stored: boolean; source: string };
    assert.equal(repairBody.stored, true);
    assert.equal(repairBody.source, 'workspace');

    // Restoring and editing assets/film.css to workspace scope also stops serving the catalog S3 sprite.
    includeCss = true;
    cssScope = 'workspace';
    cssSha = SHA_PATCH;
    const missAfterCss = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/prism.html`,
    );
    assert.equal(missAfterCss.status, 204);
  });

  it('enforces strict tenant & project isolation, upgrade-only writes, render-key protection, and input validation', async () => {
    const storage = new MemoryStorage();
    let currentScope: BlobScope = 'workspace';
    let currentSha = SHA_SCENE;

    const app = makeRouteApp(
      storage,
      (auth, projectId) => {
        if (
          (auth.workspaceId === WID_A && (projectId === PID_A || projectId === PID_B)) ||
          (auth.workspaceId === WID_B && projectId === PID_B)
        ) {
          return {
            files: [
              {
                path: 'compositions/custom.html',
                blobScope: currentScope,
                sha256: currentSha,
                sizeBytes: 1024,
                mimeType: 'text/html; charset=utf-8',
                isText: true,
                updatedAt: new Date(0),
              },
              {
                path: 'assets/photo.jpg',
                blobScope: 'workspace',
                sha256: SHA_OTHER,
                sizeBytes: 2048,
                mimeType: 'image/jpeg',
                isText: false,
                updatedAt: new Date(0),
              },
            ],
          };
        }
        return null;
      },
      (req) => {
        const ws = req.headers.get('x-test-ws') ?? WID_A;
        const role = (req.headers.get('x-test-role') as AuthContext['role']) ?? 'editor';
        const scopes = role === 'viewer' ? (['projects:read'] as const) : DEFAULT_PAT_SCOPES;
        return makeAuth({ workspaceId: ws, role, scopes: [...scopes] });
      },
    );

    // Non-HTML asset returns 404.
    const nonHtml = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/assets/photo.jpg`,
    );
    assert.equal(nonHtml.status, 404);

    // Probe to obtain authoritative renderKey.
    const probeA = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
    );
    assert.equal(probeA.status, 204);
    const renderKeyA = probeA.headers.get(FILMSTRIP_HEADER_RENDER_KEY)!;
    assert.ok(/^[a-f0-9]{64}$/.test(renderKeyA));

    // Viewer cannot PUT (403).
    const raw4 = await makeTestSpriteJpeg(4, 160, 90);
    const viewerPut = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'x-test-role': 'viewer',
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeyA,
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(viewerPut.status, 403);

    // Missing render key -> 400; stale sha256 or stale render key -> 409 Conflict.
    const missingRenderKey = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(missingRenderKey.status, 400);

    const stalePut = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_OTHER,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeyA,
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(stalePut.status, 409);

    // Wrong Content-Type -> 415; mismatched dimensions -> 400; oversized -> 413.
    const wrongType = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/png',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeyA,
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(wrongType.status, 415);

    const wrongDims = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeyA,
          [FILMSTRIP_HEADER_FRAMES]: '8',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(wrongDims.status, 400);

    const tooBig = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeyA,
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(MAX_FILMSTRIP_JPEG_BYTES + 16),
      },
    );
    assert.equal(tooBig.status, 413);

    // Valid 4-frame PUT by Project A succeeds.
    const put4 = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeyA,
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(put4.status, 200);
    assert.equal((await put4.json()).stored, true);

    // Project A hits 200; Project B in the SAME workspace (even with identical scene bytes!) strictly misses
    // with 204 and writes to its own project-scoped S3 key without cross-project sharing or blocking.
    const hitA = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
    );
    assert.equal(hitA.status, 200);
    assert.equal(hitA.headers.get(FILMSTRIP_HEADER_FRAMES), '4');
    assert.equal(hitA.headers.get(FILMSTRIP_HEADER_SOURCE), 'workspace');

    const missSameWsOtherProject = await app.request(
      `http://studio.local/api/projects/${PID_B}/composition-filmstrip/compositions/custom.html`,
    );
    assert.equal(missSameWsOtherProject.status, 204);
    const renderKeySameWsB = missSameWsOtherProject.headers.get(FILMSTRIP_HEADER_RENDER_KEY)!;

    // Upgrade Project A to 8 frames first, then verify Project B in the SAME workspace can still store its own 4-frame sprite.
    const raw8 = await makeTestSpriteJpeg(8, 160, 90);
    const upgrade = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeyA,
          [FILMSTRIP_HEADER_FRAMES]: '8',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw8),
      },
    );
    assert.equal(upgrade.status, 200);
    assert.equal((await upgrade.json()).stored, true);

    // Downgrade on Project A (2 < 8) is skipped.
    const raw2 = await makeTestSpriteJpeg(2, 160, 90);
    const downgrade = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeyA,
          [FILMSTRIP_HEADER_FRAMES]: '2',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw2),
      },
    );
    assert.equal(downgrade.status, 200);
    assert.equal((await downgrade.json()).stored, false);

    // Project B in WID_A can independently write 4 frames (not blocked by Project A's 8 frames).
    const putSameWsB = await app.request(
      `http://studio.local/api/projects/${PID_B}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_SCENE,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeySameWsB,
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(putSameWsB.status, 200);
    assert.equal((await putSameWsB.json()).stored, true);
    assert.equal(storage.objects.has(projectCompFilmstripKey(WID_A, PID_B, renderKeySameWsB)), true);

    // Different workspace WID_B strictly misses with 204 (tenant isolation).
    const missOtherWs = await app.request(
      `http://studio.local/api/projects/${PID_B}/composition-filmstrip/compositions/custom.html`,
      { headers: { 'x-test-ws': WID_B } },
    );
    assert.equal(missOtherWs.status, 204);

    // Patch scope produces a distinct renderKey and project-scoped S3 object.
    currentScope = 'patch';
    currentSha = SHA_PATCH;
    const probePatch = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
    );
    assert.equal(probePatch.status, 204);
    const renderKeyPatch = probePatch.headers.get(FILMSTRIP_HEADER_RENDER_KEY)!;
    assert.notEqual(renderKeyPatch, renderKeyA);

    const putPatch = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/custom.html`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'image/jpeg',
          [FILMSTRIP_HEADER_SHA256]: SHA_PATCH,
          [FILMSTRIP_HEADER_RENDER_KEY]: renderKeyPatch,
          [FILMSTRIP_HEADER_SCOPE]: 'patch',
          [FILMSTRIP_HEADER_FRAMES]: '4',
          [FILMSTRIP_HEADER_WIDTH]: '160',
          [FILMSTRIP_HEADER_HEIGHT]: '90',
        },
        body: new Uint8Array(raw4),
      },
    );
    assert.equal(putPatch.status, 200);
    assert.equal(
      storage.objects.has(projectCompFilmstripKey(WID_A, PID_A, renderKeyPatch)),
      true,
    );
  });

  it('reads only reachable nested compositions when computing renderKey for a scene with data-composition-src', async () => {
    const storage = new MemoryStorage();
    const readPaths: string[] = [];
    const files: VirtualFileRecord[] = [
      {
        path: 'index.html',
        blobScope: 'workspace',
        sha256: SHA_SCENE,
        sizeBytes: 64,
        mimeType: 'text/html; charset=utf-8',
        isText: true,
        updatedAt: new Date(0),
      },
      {
        path: 'compositions/parent.html',
        blobScope: 'workspace',
        sha256: SHA_SCENE,
        sizeBytes: 128,
        mimeType: 'text/html; charset=utf-8',
        isText: true,
        updatedAt: new Date(0),
      },
      {
        path: 'compositions/child.html',
        blobScope: 'workspace',
        sha256: SHA_OTHER,
        sizeBytes: 128,
        mimeType: 'text/html; charset=utf-8',
        isText: true,
        updatedAt: new Date(0),
      },
      {
        path: 'compositions/unrelated-sibling.html',
        blobScope: 'patch',
        sha256: SHA_PATCH,
        sizeBytes: 128,
        mimeType: 'text/html; charset=utf-8',
        isText: true,
        updatedAt: new Date(0),
      },
    ];
    const texts = new Map<string, string>([
      ['index.html', '<html><head><title>Test</title></head><body></body></html>'],
      ['compositions/parent.html', '<div data-composition-src="child.html"></div>'],
      ['compositions/child.html', '<div>Child</div>'],
      ['compositions/unrelated-sibling.html', '<div>Unrelated</div>'],
    ]);

    const deps = {
      storage,
      files: {
        listFiles: async () => files,
        readTextFile: async (_auth: AuthContext, _projectId: string, filePath: string) => {
          readPaths.push(filePath);
          const rec = files.find((f) => f.path === filePath);
          const content = texts.get(filePath);
          if (!rec || content === undefined) return null;
          return {
            path: rec.path,
            content,
            version: `"${rec.blobScope}:${rec.sha256}"`,
            sha256: rec.sha256,
            blobScope: rec.blobScope,
          };
        },
      },
      resolveAuth: () => makeAuth(),
    } as unknown as DisklessStudioDeps;
    const app = createStudioCompositionFilmstripsRoutes(deps);
    app.onError((err, c) => handleStudioError(c, err));

    const res = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/parent.html`,
    );
    assert.equal(res.status, 204);
    assert.deepEqual(readPaths, ['index.html', 'compositions/parent.html', 'compositions/child.html']);
    assert.equal(readPaths.includes('compositions/unrelated-sibling.html'), false);
  });

  it('keeps builtin and legacy v1 catalog filmstrips warm when unrelated audio or unreferenced media are uploaded', async () => {
    const welcome = await assembleBuiltinTemplate(
      BUILTIN_TEMPLATES.find((t) => t.id === WELCOME_TEMPLATE_ID)!,
    );
    const projectFiles = welcome.files.filter((f) => f.isProjectFile && f.bytes !== null);
    const texts = new Map<string, string>();
    const files: VirtualFileRecord[] = projectFiles.map((f) => {
      const isText = /\.(?:html?|css|js|mjs|json|svg|txt)$/i.test(f.path);
      if (isText) texts.set(f.path, f.bytes!.toString('utf8'));
      return {
        path: f.path,
        blobScope: 'catalog',
        sha256: f.sha256,
        sizeBytes: f.sizeBytes,
        mimeType: f.mimeType,
        isText,
        updatedAt: new Date(0),
        metadata: f.metadata,
      };
    });

    const storage = new MemoryStorage();
    const app = makeRouteApp(
      storage,
      (_auth, projectId) => (projectId === PID_A ? { files, texts } : null),
      () => makeAuth(),
    );

    const before = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
    );
    assert.equal(before.status, 200);
    assert.equal(before.headers.get(FILMSTRIP_HEADER_SOURCE), 'builtin');
    const beforeRenderKey = before.headers.get(FILMSTRIP_HEADER_RENDER_KEY);

    // Upload a brand-new BGM audio track AND an unreferenced image/video to workspace -> ZERO invalidation!
    files.push(
      {
        path: 'assets/user-bgm.mp3',
        blobScope: 'workspace',
        sha256: SHA_OTHER,
        sizeBytes: 4096,
        mimeType: 'audio/mpeg',
        isText: false,
        updatedAt: new Date(0),
      },
      {
        path: 'assets/unreferenced-banner.png',
        blobScope: 'workspace',
        sha256: SHA_PATCH,
        sizeBytes: 8192,
        mimeType: 'image/png',
        isText: false,
        updatedAt: new Date(0),
      },
      {
        path: 'assets/unreferenced-clip.mp4',
        blobScope: 'workspace',
        sha256: SHA_SCENE,
        sizeBytes: 16384,
        mimeType: 'video/mp4',
        isText: false,
        updatedAt: new Date(0),
      },
    );

    const afterUploads = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
    );
    assert.equal(afterUploads.status, 200);
    assert.equal(afterUploads.headers.get(FILMSTRIP_HEADER_SOURCE), 'builtin');
    assert.equal(afterUploads.headers.get(FILMSTRIP_HEADER_RENDER_KEY), beforeRenderKey);

    // Editing a visual asset referenced by assets/film.css (`assets/sky.webp`) MUST invalidate cleanly.
    const skyIdx = files.findIndex((f) => f.path === 'assets/sky.webp');
    assert.ok(skyIdx >= 0);
    files[skyIdx] = { ...files[skyIdx]!, blobScope: 'workspace', sha256: SHA_PATCH };
    const afterSkyEdit = await app.request(
      `http://studio.local/api/projects/${PID_A}/composition-filmstrip/compositions/intro.html`,
    );
    assert.equal(afterSkyEdit.status, 204);
    assert.notEqual(afterSkyEdit.headers.get(FILMSTRIP_HEADER_RENDER_KEY), beforeRenderKey);

    // Pre-existing v1 S3 catalog sprites still hit read-only even after uploading workspace BGM/unused PNG.
    const catalogFiles: VirtualFileRecord[] = [
      {
        path: 'index.html',
        blobScope: 'catalog',
        sha256: SHA_OTHER,
        sizeBytes: 64,
        mimeType: 'text/html',
        isText: true,
        updatedAt: new Date(0),
      },
      {
        path: 'compositions/scene.html',
        blobScope: 'catalog',
        sha256: SHA_SCENE,
        sizeBytes: 64,
        mimeType: 'text/html',
        isText: true,
        updatedAt: new Date(0),
      },
    ];
    const catalogTexts = new Map<string, string>([
      ['index.html', '<html><head><title>Legacy</title></head><body></body></html>'],
      ['compositions/scene.html', '<div>Legacy Scene</div>'],
    ]);
    const legacyV1 = computeLegacyV1CompositionFilmstripDepsDigest({
      compPath: 'compositions/scene.html',
      files: catalogFiles,
      indexHead: extractIndexHeadMarkup(catalogTexts.get('index.html')),
      readText: (p) => catalogTexts.get(p) ?? null,
    });
    const raw8 = await makeTestSpriteJpeg(8, 160, 90);
    const tagged8 = embedFilmstripComment(raw8, {
      version: 1,
      frameCount: 8,
      frameWidth: 160,
      frameHeight: 90,
      aspect: 16 / 9,
    })!;
    await storage.putObject(
      catalogCompFilmstripKey(SHA_SCENE, legacyV1.depsSha256, COMPOSITION_FILMSTRIP_VERSION),
      tagged8,
      'image/jpeg',
    );
    const catalogWithUploads: VirtualFileRecord[] = [
      ...catalogFiles,
      {
        path: 'assets/user-voiceover.wav',
        blobScope: 'workspace',
        sha256: SHA_PATCH,
        sizeBytes: 2048,
        mimeType: 'audio/wav',
        isText: false,
        updatedAt: new Date(0),
      },
      {
        path: 'assets/unused-extra.jpg',
        blobScope: 'workspace',
        sha256: SHA_PATCH,
        sizeBytes: 2048,
        mimeType: 'image/jpeg',
        isText: false,
        updatedAt: new Date(0),
      },
    ];
    const legacyApp = makeRouteApp(
      storage,
      (_auth, projectId) => (projectId === PID_B ? { files: catalogWithUploads, texts: catalogTexts } : null),
      () => makeAuth(),
    );
    const legacyHit = await legacyApp.request(
      `http://studio.local/api/projects/${PID_B}/composition-filmstrip/compositions/scene.html`,
    );
    assert.equal(legacyHit.status, 200);
    assert.equal(legacyHit.headers.get(FILMSTRIP_HEADER_SOURCE), 'catalog');

    // Pre-existing v1 workspace S3 sprites also hit read-only until superseded by an edit.
    const wsFiles: VirtualFileRecord[] = [
      {
        path: 'compositions/custom-v1.html',
        blobScope: 'workspace',
        sha256: SHA_PATCH,
        sizeBytes: 64,
        mimeType: 'text/html',
        isText: true,
        updatedAt: new Date(0),
      },
    ];
    const wsLegacyDeps = computeLegacyV1CompositionFilmstripDepsDigest({
      compPath: 'compositions/custom-v1.html',
      files: wsFiles,
      indexHead: null,
    }).depsSha256;
    const wsLegacyRenderKey = computeCompositionFilmstripRenderKey({
      compPath: 'compositions/custom-v1.html',
      fileSha256: SHA_PATCH,
      blobScope: 'workspace',
      depsSha256: wsLegacyDeps,
    });
    await storage.putObject(
      projectCompFilmstripKey(WID_A, PID_B, wsLegacyRenderKey),
      tagged8,
      'image/jpeg',
    );
    const wsApp = makeRouteApp(
      storage,
      (_auth, projectId) => (projectId === PID_B ? { files: wsFiles } : null),
      () => makeAuth(),
    );
    const wsLegacyHit = await wsApp.request(
      `http://studio.local/api/projects/${PID_B}/composition-filmstrip/compositions/custom-v1.html`,
    );
    assert.equal(wsLegacyHit.status, 200);
    assert.equal(wsLegacyHit.headers.get(FILMSTRIP_HEADER_SOURCE), 'workspace');

    // Verify projectCompThumbsPrefix builds tenant-scoped cleanup prefixes safely.
    assert.equal(
      projectCompThumbsPrefix(WID_A, PID_A),
      `workspaces/${WID_A}/comp-thumbs/${PID_A}/`,
    );
    assert.throws(() => projectCompThumbsPrefix('not-a-uuid', PID_A), { code: 'INVALID_PATH' });
  });

  it('tracks transitive JS/CSS refs, filenames with spaces, and image-set() consistently', async () => {
    const files: VirtualFileRecord[] = [
      {
        path: 'index.html',
        blobScope: 'workspace',
        sha256: '1'.repeat(64),
        sizeBytes: 64,
        mimeType: 'text/html',
        isText: true,
        updatedAt: new Date(0),
      },
      {
        path: 'compositions/scene.html',
        blobScope: 'workspace',
        sha256: '2'.repeat(64),
        sizeBytes: 120,
        mimeType: 'text/html',
        isText: true,
        updatedAt: new Date(0),
      },
      {
        path: 'assets/app.js',
        blobScope: 'workspace',
        sha256: '3'.repeat(64),
        sizeBytes: 80,
        mimeType: 'application/javascript',
        isText: true,
        updatedAt: new Date(0),
      },
      {
        path: 'assets/theme.css',
        blobScope: 'workspace',
        sha256: '4'.repeat(64),
        sizeBytes: 90,
        mimeType: 'text/css',
        isText: true,
        updatedAt: new Date(0),
      },
      {
        path: 'assets/hero banner.png',
        blobScope: 'workspace',
        sha256: '5'.repeat(64),
        sizeBytes: 1024,
        mimeType: 'image/png',
        isText: false,
        updatedAt: new Date(0),
      },
      {
        path: 'assets/bg-2x.webp',
        blobScope: 'workspace',
        sha256: '6'.repeat(64),
        sizeBytes: 1024,
        mimeType: 'image/webp',
        isText: false,
        updatedAt: new Date(0),
      },
    ];
    const texts = new Map<string, string>([
      ['index.html', '<html><head></head><body></body></html>'],
      ['compositions/scene.html', '<div data-composition-id="s"><script src="../assets/app.js"></script></div>'],
      ['assets/app.js', 'const css = "./theme.css"; const img = "./hero banner.png";'],
      ['assets/theme.css', '.hero { background: image-set("./bg-2x.webp" 2x); }'],
    ]);
    const loaded = await preloadTransitiveReferencedCodeAssets({
      files,
      indexHead: '',
      htmlSources: new Map([['compositions/scene.html', texts.get('compositions/scene.html')!]]),
      loadCodeText: async (p) => texts.get(p) ?? null,
    });
    assert.equal(loaded.has('assets/app.js'), true);
    assert.equal(loaded.has('assets/theme.css'), true);

    const readText = (p: string) => texts.get(p) ?? null;
    const digest1 = computeCompositionFilmstripDepsDigest({
      compPath: 'compositions/scene.html',
      files,
      indexHead: '',
      readText,
    }).depsSha256;
    // Editing the space-containing image OR image-set() webp MUST change depsSha256.
    const editedSpaceImg = files.map((f) =>
      f.path === 'assets/hero banner.png' ? { ...f, sha256: '7'.repeat(64) } : f,
    );
    const digest2 = computeCompositionFilmstripDepsDigest({
      compPath: 'compositions/scene.html',
      files: editedSpaceImg,
      indexHead: '',
      readText,
    }).depsSha256;
    assert.notEqual(digest2, digest1);

    const editedWebp = files.map((f) =>
      f.path === 'assets/bg-2x.webp' ? { ...f, sha256: '8'.repeat(64) } : f,
    );
    const digest3 = computeCompositionFilmstripDepsDigest({
      compPath: 'compositions/scene.html',
      files: editedWebp,
      indexHead: '',
      readText,
    }).depsSha256;
    assert.notEqual(digest3, digest1);
  });
});
