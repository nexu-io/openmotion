import { Hono, type Context } from 'hono';
import type { BlobScope } from '../../contracts/storage.ts';
import {
  assertTenantScopedKey,
  catalogCompFilmstripKey,
  projectCompFilmstripKey,
} from '../../infra/storage.ts';
import { isSha256Hex } from '../../../shared/project-validation.ts';
import { getBuiltinCompositionFilmstrip } from '../../services/builtin-filmstrip-store.ts';
import { normalizeSafeProjectPath } from '../../services/project-files-service.ts';
import type { VirtualFileRecord } from '../virtual-project-store.ts';
import {
  COMPOSITION_FILMSTRIP_VERSION,
  computeCompositionFilmstripDepsDigest,
  computeCompositionFilmstripRenderKey,
  embedFilmstripComment,
  extractFilmstripMeta,
  extractIndexHeadMarkup,
  extractNestedCompositionRefs,
  FILMSTRIP_HEADER_ASPECT,
  FILMSTRIP_HEADER_FRAMES,
  FILMSTRIP_HEADER_HEIGHT,
  FILMSTRIP_HEADER_RENDER_KEY,
  FILMSTRIP_HEADER_SCOPE,
  FILMSTRIP_HEADER_SHA256,
  FILMSTRIP_HEADER_SOURCE,
  FILMSTRIP_HEADER_WIDTH,
  isHtmlCompositionPath,
  MAX_FILMSTRIP_JPEG_BYTES,
  validateFilmstripMeta,
  type CompositionFilmstripMeta,
} from '../engine/composition-filmstrip-sprite.ts';
import {
  extractWildcardPath,
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';

type FilmstripCacheSource = 'builtin' | 'catalog' | 'workspace';

function isHtmlCompositionFile(file: { isText: boolean; path: string }): boolean {
  return file.isText && isHtmlCompositionPath(file.path);
}

interface ResolvedCompositionIdentity {
  readonly file: VirtualFileRecord;
  readonly fileSha: string;
  readonly depsSha256: string;
  readonly renderKey: string;
  readonly allDepsCatalog: boolean;
}

function projectFilmstripS3Key(workspaceId: string, projectId: string, renderKey: string): string {
  return assertTenantScopedKey(workspaceId, projectCompFilmstripKey(workspaceId, projectId, renderKey));
}

async function readValidatedS3Filmstrip(
  deps: DisklessStudioDeps,
  s3Key: string,
): Promise<{ bytes: Buffer; meta: CompositionFilmstripMeta } | null> {
  try {
    const head = await deps.storage.headObject(s3Key);
    if (!head || head.contentLength <= 0 || head.contentLength > MAX_FILMSTRIP_JPEG_BYTES) {
      return null;
    }
    const bytes = await deps.storage.getObjectBuffer(s3Key, MAX_FILMSTRIP_JPEG_BYTES);
    const meta = extractFilmstripMeta(bytes);
    if (!meta) return null;
    return { bytes, meta };
  } catch {
    return null;
  }
}

function parseStrictPositiveInt(raw: string | undefined): number {
  if (!raw || !/^\d{1,4}$/.test(raw.trim())) return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
}

function parseOptionalPositiveFloat(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const parsed = Number.parseFloat(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; status: 400 | 413 }> {
  const declaredLen = request.headers.get('content-length');
  if (declaredLen !== null) {
    const parsed = Number(declaredLen);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      return { ok: false, status: 413 };
    }
  }
  const reader = request.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await request.arrayBuffer());
    if (buf.byteLength === 0) return { ok: false, status: 400 };
    if (buf.byteLength > maxBytes) return { ok: false, status: 413 };
    return { ok: true, buffer: buf };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 413 };
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) return { ok: false, status: 400 };
  return { ok: true, buffer: Buffer.concat(chunks, total) };
}

export function createStudioCompositionFilmstripsRoutes(
  deps: DisklessStudioDeps,
): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  async function resolveCompositionIdentity(
    auth: Parameters<DisklessStudioDeps['files']['listFiles']>[0],
    projectId: string,
    safePath: string,
  ): Promise<ResolvedCompositionIdentity | null> {
    const files = await deps.files.listFiles(auth, projectId);
    const file = files.find((f) => f.path === safePath) ?? null;
    if (!file || !isHtmlCompositionFile(file)) {
      return null;
    }
    const fileSha = file.sha256.trim();

    let indexHead: string | null = null;
    if (files.some((f) => f.path === 'index.html')) {
      try {
        const indexRes = await deps.files.readTextFile(auth, projectId, 'index.html');
        if (indexRes) indexHead = extractIndexHeadMarkup(indexRes.content);
      } catch {
        indexHead = null;
      }
    }

    // Load HTML text only for `safePath` and its reachable transitive `data-composition-src`
    // subgraph so unrelated sibling scenes are never read on every filmstrip lookup.
    const htmlCache = new Map<string, string | null>();
    if (safePath !== 'index.html') {
      const byPath = new Map(files.map((f) => [f.path, f]));
      const htmlPathsToCheck = [safePath];
      const visited = new Set<string>(htmlPathsToCheck);
      while (htmlPathsToCheck.length > 0) {
        const current = htmlPathsToCheck.shift()!;
        let content: string | null = null;
        try {
          const read = await deps.files.readTextFile(auth, projectId, current);
          content = read?.content ?? null;
        } catch {
          content = null;
        }
        htmlCache.set(current, content);
        for (const target of extractNestedCompositionRefs(current, content, byPath)) {
          const targetFile = byPath.get(target);
          if (targetFile && isHtmlCompositionFile(targetFile) && !visited.has(target)) {
            visited.add(target);
            htmlPathsToCheck.push(target);
          }
        }
      }
    }

    const { depsSha256, allDepsCatalog } = computeCompositionFilmstripDepsDigest({
      compPath: safePath,
      files,
      indexHead,
      readText: (filePath) => htmlCache.get(filePath) ?? null,
    });
    const renderKey = computeCompositionFilmstripRenderKey({
      compPath: safePath,
      fileSha256: fileSha,
      blobScope: file.blobScope,
      depsSha256,
    });

    return { file, fileSha, depsSha256, renderKey, allDepsCatalog };
  }

  async function resolveFilmstripHit(
    workspaceId: string,
    projectId: string,
    identity: ResolvedCompositionIdentity,
  ): Promise<{ bytes: Buffer; meta: CompositionFilmstripMeta; source: FilmstripCacheSource } | null> {
    if (identity.file.blobScope === 'catalog') {
      const builtin = await getBuiltinCompositionFilmstrip(identity.fileSha, deps.runtimeRoot);
      if (builtin && builtin.depsSha256 === identity.depsSha256) {
        return { bytes: builtin.bytes, meta: builtin.meta, source: 'builtin' };
      }
      if (identity.allDepsCatalog) {
        const catalogKey = assertTenantScopedKey(
          workspaceId,
          catalogCompFilmstripKey(identity.fileSha, identity.depsSha256, COMPOSITION_FILMSTRIP_VERSION),
          { allowCatalog: true },
        );
        const catalogHit = await readValidatedS3Filmstrip(deps, catalogKey);
        if (catalogHit) {
          return { ...catalogHit, source: 'catalog' };
        }
      }
    }

    const projectKey = projectFilmstripS3Key(workspaceId, projectId, identity.renderKey);
    const workspaceHit = await readValidatedS3Filmstrip(deps, projectKey);
    if (workspaceHit) {
      return { ...workspaceHit, source: 'workspace' };
    }
    return null;
  }

  const handleGetFilmstrip = async (c: Context<{ Variables: StudioVariables }>) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id') ?? '';
    const rawPath = extractWildcardPath(c.req.url, '/composition-filmstrip/');
    const safePath = normalizeSafeProjectPath(rawPath || 'index.html');
    const identity = await resolveCompositionIdentity(auth, projectId, safePath);
    if (!identity) {
      return c.req.method === 'HEAD'
        ? c.body(null, 404)
        : c.json({ error: 'Composition file not found', path: safePath }, 404);
    }
    const { file, fileSha, renderKey } = identity;
    if (!isSha256Hex(fileSha)) {
      c.header('Cache-Control', 'no-store');
      return c.body(null, 204);
    }

    const hit = await resolveFilmstripHit(auth.workspaceId, projectId, identity);
    if (!hit) {
      c.header('Cache-Control', 'no-store');
      c.header(FILMSTRIP_HEADER_SHA256, fileSha);
      c.header(FILMSTRIP_HEADER_RENDER_KEY, renderKey);
      c.header(FILMSTRIP_HEADER_SCOPE, file.blobScope);
      return c.body(null, 204);
    }

    const etag = `"omfs-v${COMPOSITION_FILMSTRIP_VERSION}:${projectId}:${file.blobScope}:${renderKey}:${hit.meta.frameCount}"`;
    c.header('Content-Type', 'image/jpeg');
    c.header('Content-Length', String(hit.bytes.byteLength));
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    c.header('Vary', 'Cookie, Authorization');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header(FILMSTRIP_HEADER_FRAMES, String(hit.meta.frameCount));
    c.header(FILMSTRIP_HEADER_WIDTH, String(hit.meta.frameWidth));
    c.header(FILMSTRIP_HEADER_HEIGHT, String(hit.meta.frameHeight));
    c.header(FILMSTRIP_HEADER_ASPECT, hit.meta.aspect.toFixed(4));
    c.header(FILMSTRIP_HEADER_SHA256, fileSha);
    c.header(FILMSTRIP_HEADER_RENDER_KEY, renderKey);
    c.header(FILMSTRIP_HEADER_SCOPE, file.blobScope);
    c.header(FILMSTRIP_HEADER_SOURCE, hit.source);

    if (c.req.header('if-none-match')?.trim() === etag) {
      return c.body(null, 304);
    }
    if (c.req.method === 'HEAD') {
      return c.body(null, 200);
    }
    return c.body(new Uint8Array(hit.bytes), 200);
  };

  const handlePutFilmstrip = async (c: Context<{ Variables: StudioVariables }>) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id') ?? '';
    const rawPath = extractWildcardPath(c.req.url, '/composition-filmstrip/');
    const safePath = normalizeSafeProjectPath(rawPath || 'index.html');
    const identity = await resolveCompositionIdentity(auth, projectId, safePath);
    if (!identity) {
      return c.json({ error: 'Composition file not found', path: safePath }, 404);
    }
    const { file, fileSha, depsSha256, renderKey, allDepsCatalog } = identity;

    const expectedSha = c.req.header(FILMSTRIP_HEADER_SHA256)?.trim() ?? '';
    if (!isSha256Hex(expectedSha)) {
      return c.json({ error: 'Valid x-openmotion-filmstrip-sha256 header is required' }, 400);
    }
    const expectedRenderKey = c.req.header(FILMSTRIP_HEADER_RENDER_KEY)?.trim() ?? '';
    if (!isSha256Hex(expectedRenderKey)) {
      return c.json({ error: 'Valid x-openmotion-filmstrip-render-key header is required' }, 400);
    }
    const expectedScope = c.req.header(FILMSTRIP_HEADER_SCOPE)?.trim();
    if (
      expectedSha !== fileSha ||
      expectedRenderKey !== renderKey ||
      (expectedScope && expectedScope !== file.blobScope)
    ) {
      return c.json(
        {
          stored: false,
          reason: 'version_mismatch',
          currentSha256: fileSha,
          currentRenderKey: renderKey,
          currentScope: file.blobScope,
        },
        409,
      );
    }

    const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'image/jpeg') {
      return c.json({ error: 'Content-Type must be image/jpeg' }, 415);
    }

    const rawAspect = parseOptionalPositiveFloat(c.req.header(FILMSTRIP_HEADER_ASPECT));
    if (rawAspect !== undefined && Number.isNaN(rawAspect)) {
      return c.json({ error: 'Invalid x-openmotion-filmstrip-aspect header' }, 400);
    }
    const meta = validateFilmstripMeta({
      frameCount: parseStrictPositiveInt(c.req.header(FILMSTRIP_HEADER_FRAMES)),
      frameWidth: parseStrictPositiveInt(c.req.header(FILMSTRIP_HEADER_WIDTH)),
      frameHeight: parseStrictPositiveInt(c.req.header(FILMSTRIP_HEADER_HEIGHT)),
      aspect: rawAspect,
    });
    if (!meta) {
      return c.json({ error: 'Invalid filmstrip dimension or frame count headers' }, 400);
    }

    const bodyResult = await readBoundedRequestBody(c.req.raw, MAX_FILMSTRIP_JPEG_BYTES);
    if ('status' in bodyResult) {
      return c.json(
        {
          error:
            bodyResult.status === 413
              ? `Filmstrip sprite exceeds maximum size of ${MAX_FILMSTRIP_JPEG_BYTES} bytes`
              : 'Filmstrip body is required',
        },
        bodyResult.status,
      );
    }

    const canonicalBytes = embedFilmstripComment(bodyResult.buffer, meta);
    if (!canonicalBytes) {
      return c.json(
        { error: 'Filmstrip body must be a valid JPEG matching declared frame dimensions' },
        400,
      );
    }

    // Do not duplicate an equal-or-higher resolution pre-baked catalog filmstrip into project S3
    // when the project's rendered dependencies still match that pre-baked catalog sprite.
    if (file.blobScope === 'catalog') {
      const builtin = await getBuiltinCompositionFilmstrip(fileSha, deps.runtimeRoot);
      if (builtin && builtin.depsSha256 === depsSha256 && builtin.meta.frameCount >= meta.frameCount) {
        return c.json(
          {
            stored: false,
            reason: 'already_cached',
            source: 'builtin',
            frameCount: builtin.meta.frameCount,
            sha256: fileSha,
            renderKey,
          },
          200,
        );
      }
      if (allDepsCatalog) {
        const catalogKey = assertTenantScopedKey(
          auth.workspaceId,
          catalogCompFilmstripKey(fileSha, depsSha256, COMPOSITION_FILMSTRIP_VERSION),
          { allowCatalog: true },
        );
        const catalogHit = await readValidatedS3Filmstrip(deps, catalogKey);
        if (catalogHit && catalogHit.meta.frameCount >= meta.frameCount) {
          return c.json(
            {
              stored: false,
              reason: 'already_cached',
              source: 'catalog',
              frameCount: catalogHit.meta.frameCount,
              sha256: fileSha,
              renderKey,
            },
            200,
          );
        }
      }
    }

    // Client write-backs strictly target this project's tenant-scoped comp-thumbs keyspace (never catalog/*).
    const projectKey = projectFilmstripS3Key(auth.workspaceId, projectId, renderKey);
    const existing = await readValidatedS3Filmstrip(deps, projectKey);
    if (existing && existing.meta.frameCount >= meta.frameCount) {
      return c.json(
        {
          stored: false,
          reason: 'already_cached',
          source: 'workspace',
          frameCount: existing.meta.frameCount,
          sha256: fileSha,
          renderKey,
        },
        200,
      );
    }

    await deps.storage.putObject(projectKey, canonicalBytes, 'image/jpeg', canonicalBytes.byteLength);
    return c.json(
      {
        stored: true,
        source: 'workspace',
        frameCount: meta.frameCount,
        bytes: canonicalBytes.byteLength,
        sha256: fileSha,
        renderKey,
      },
      200,
    );
  };

  app.get('/api/projects/:id/composition-filmstrip', handleGetFilmstrip);
  app.get('/api/projects/:id/composition-filmstrip/*', handleGetFilmstrip);
  app.put('/api/projects/:id/composition-filmstrip', handlePutFilmstrip);
  app.put('/api/projects/:id/composition-filmstrip/*', handlePutFilmstrip);

  return app;
}
