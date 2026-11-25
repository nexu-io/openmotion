import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { hasMinRole, hasScope, type AuthContext } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { CatalogTemplateKind } from '../db/schema/blobs-assets.ts';
import type { Logger } from '../infra/logger.ts';
import {
  normalizeCatalogAssetPath,
  type CatalogHead,
  type CatalogPort,
  type ResolvedCatalogAsset,
} from '../services/catalog-service.ts';

export type CatalogRouteEnv = {
  Variables: {
    auth?: AuthContext;
    authContext?: AuthContext;
  };
};

export interface CatalogRoutesDeps {
  catalog: CatalogPort;
  logger?: Logger;
  /** Mount prefix for catalog endpoints. Defaults to `'/api'`. Pass `''` when mounted at `/api` or `'/motion-api'`. */
  basePath?: string;
  /** Optional custom AuthContext extractor (defaults to `c.get('auth') ?? c.get('authContext')`). */
  getAuthContext?: (c: Context<CatalogRouteEnv>) => AuthContext | undefined;
}

const cloneBodySchema = z
  .object({
    title: z.string().min(1).max(100).optional(),
    sessionId: z.string().uuid().optional(),
    requirements: z.string().max(20_000).optional(),
    instruction: z.string().max(20_000).optional(),
    namingLanguage: z.string().min(2).max(16).optional(),
    requestId: z.string().min(1).max(100).optional(),
    locale: z.string().min(2).max(16).optional(),
    activateWorkspace: z.boolean().optional(),
    workspaceId: z.string().optional(),
    expectedRevision: z.string().optional(),
    expectedProjectId: z.string().optional(),
  })
  .strict();

function normalizeBasePath(raw?: string): string {
  if (!raw || raw === '/') return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseOptionalInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CloudError('INVALID_ARGUMENT', `Query parameter '${name}' must be an integer`, {
      status: 400,
      applied: false,
    });
  }
  return parsed;
}

function parseOptionalKind(value: string | undefined): CatalogTemplateKind | undefined {
  if (!value || value === 'all') return undefined;
  if (value === 'builtin' || value === 'prism') return value;
  throw new CloudError('INVALID_ARGUMENT', `Invalid template kind '${value}'`, {
    status: 400,
    applied: false,
  });
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new CloudError('INVALID_PATH', 'Malformed percent-encoding in asset path', {
      status: 400,
      applied: false,
    });
  }
}

function matchesBaseSuffix(segments: readonly string[], beforeIndex: number, baseSegments: readonly string[]): boolean {
  if (baseSegments.length === 0) return true;
  if (beforeIndex < baseSegments.length) return false;
  for (let offset = 0; offset < baseSegments.length; offset++) {
    if (segments[beforeIndex - baseSegments.length + offset] !== baseSegments[offset]) {
      return false;
    }
  }
  return true;
}

function extractWildcardAssetPath(
  requestUrl: string,
  base: string,
  mode: 'templates-source' | 'template-source',
  expectedId: string,
): string {
  const pathname = new URL(requestUrl).pathname;
  const rawPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const segments = rawPath.split('/');
  const baseSegments = base ? base.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean) : [];

  let tailStart = -1;
  if (mode === 'templates-source') {
    for (let i = 0; i + 3 <= segments.length; i++) {
      if (
        segments[i] === 'templates' &&
        segments[i + 2] === 'source' &&
        matchesBaseSuffix(segments, i, baseSegments) &&
        safeDecodeSegment(segments[i + 1]) === expectedId
      ) {
        tailStart = i + 3;
        break;
      }
    }
  } else {
    for (let i = 0; i + 2 <= segments.length; i++) {
      if (
        segments[i] === 'template-source' &&
        matchesBaseSuffix(segments, i, baseSegments) &&
        safeDecodeSegment(segments[i + 1]) === expectedId
      ) {
        tailStart = i + 2;
        break;
      }
    }
  }

  if (tailStart < 0 || tailStart >= segments.length) {
    throw new CloudError('INVALID_PATH', 'Missing template source asset path', { status: 400, applied: false });
  }

  const rawSegments = segments.slice(tailStart);
  const decodedSegments: string[] = [];
  for (const segment of rawSegments) {
    const decoded = safeDecodeSegment(segment);
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new CloudError('INVALID_PATH', 'Catalog asset path contains invalid segments or traversal', {
        status: 400,
        applied: false,
      });
    }
    decodedSegments.push(decoded);
  }

  return normalizeCatalogAssetPath(decodedSegments.join('/'));
}

const CATALOG_PUBLIC_CACHE_CONTROL = 'public, max-age=300, s-maxage=300';
const CATALOG_LIST_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
const CATALOG_PUBLIC_VARY = 'Origin';

function matchesIfNoneMatch(headerValue: string | null | undefined, etag: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === '*') return true;
  const normalizedTarget = etag.replace(/^W\//i, '');
  return trimmed.split(',').some((candidate) => {
    const token = candidate.trim();
    return token === etag || token.replace(/^W\//i, '') === normalizedTarget;
  });
}

function buildPublicJsonResponse(payload: unknown, ifNoneMatch?: string | null): Response {
  const body = JSON.stringify(payload);
  const etag = `"sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}"`;
  if (matchesIfNoneMatch(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': CATALOG_LIST_CACHE_CONTROL,
        Vary: CATALOG_PUBLIC_VARY,
      },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ETag: etag,
      'Cache-Control': CATALOG_LIST_CACHE_CONTROL,
      Vary: CATALOG_PUBLIC_VARY,
    },
  });
}

function buildHeadResponse(head: CatalogHead): Response {
  if ('kind' in head) return buildAssetResponse(head);
  const headers = new Headers({
    'Content-Type': head.mimeType,
    'Content-Length': String(head.sizeBytes),
    ETag: head.etag,
    'Accept-Ranges': 'bytes',
    'Cache-Control': CATALOG_PUBLIC_CACHE_CONTROL,
    Vary: CATALOG_PUBLIC_VARY,
  });
  return new Response(null, { status: 200, headers });
}

function buildAssetResponse(resolved: ResolvedCatalogAsset, ifNoneMatch?: string): Response {
  if (resolved.kind === 'redirect') {
    const headers = new Headers({
      Location: resolved.location,
      'Cache-Control': resolved.cacheControl,
      Vary: resolved.vary,
    });
    if (resolved.etag) {
      headers.set('ETag', resolved.etag);
    }
    return new Response(null, { status: 302, headers });
  }

  if (matchesIfNoneMatch(ifNoneMatch, resolved.etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: resolved.etag,
        'Cache-Control': resolved.cacheControl,
        Vary: resolved.vary,
      },
    });
  }

  const headers = new Headers({
    'Content-Type': resolved.mimeType,
    'Content-Length': String(resolved.sizeBytes),
    ETag: resolved.etag,
    'Cache-Control': resolved.cacheControl,
    Vary: resolved.vary,
  });
  if (resolved.contentDisposition) {
    headers.set('Content-Disposition', resolved.contentDisposition);
  }
  return new Response(new Uint8Array(resolved.body), { status: 200, headers });
}

function resolveRequiredAuth(
  c: Context<CatalogRouteEnv>,
  getter?: (ctx: Context<CatalogRouteEnv>) => AuthContext | undefined,
): AuthContext {
  const auth = getter ? getter(c) : (c.get('auth') ?? c.get('authContext'));
  if (!auth) {
    throw new CloudError('UNAUTHORIZED', 'Authentication is required for this operation', {
      status: 401,
      applied: false,
    });
  }
  return auth;
}

/**
 * Hono sub-router for Template Catalog CAS endpoints:
 * - Listing & search (`GET /api/templates`, `GET /api/template-catalog`)
 * - Template detail (`GET /api/templates/:id`)
 * - `HEAD` directly from PostgreSQL metadata (never redirects `HEAD` to GET-signed S3 URLs)
 * - `GET` `302` presigned poster/preview/source endpoints (with `Cache-Control: public, max-age=300, s-maxage=300`, `Vary: Origin`)
 * - Zero-copy clone into tenant workspace (`POST /api/templates/:id/clone` and `/open`)
 */
export function createCatalogRoutes(deps: CatalogRoutesDeps): Hono<CatalogRouteEnv> {
  const app = new Hono<CatalogRouteEnv>();
  const base = normalizeBasePath(deps.basePath ?? '/api');
  const { catalog, logger, getAuthContext } = deps;

  app.onError((error, c) => {
    if (isCloudError(error)) {
      return c.json(error.toJSON(), error.status as ContentfulStatusCode);
    }
    logger?.error('Unhandled catalog route error', { error, path: c.req.path });
    return c.json({ code: 'INTERNAL_ERROR', error: 'Internal server error' }, 500);
  });

  // 1. Template listing (legacy /api/templates + query filters)
  app.get(`${base}/templates`, async (c) => {
    const query = c.req.query('query') ?? '';
    const category = c.req.query('category') ?? 'all';
    const locale = c.req.query('locale') || undefined;
    const kind = parseOptionalKind(c.req.query('kind'));
    const offset = parseOptionalInt(c.req.query('offset'), 0, 'offset');
    const limit = parseOptionalInt(c.req.query('limit'), 60, 'limit');
    const grouped = c.req.query('grouped') === 'true';
    const covered = c.req.query('covered') === 'true';

    const page = await catalog.listTemplates({
      category,
      query,
      offset,
      limit,
      grouped,
      covered,
      locale,
      kind,
    });
    return buildPublicJsonResponse({ templates: page.items, ...page }, c.req.header('if-none-match'));
  });

  // 2. Paginated / searchable catalog (Studio & web /api/template-catalog)
  app.get(`${base}/template-catalog`, async (c) => {
    const query = c.req.query('query') ?? '';
    const category = c.req.query('category') ?? 'featured';
    const locale = c.req.query('locale') || undefined;
    const kind = parseOptionalKind(c.req.query('kind'));
    const offset = parseOptionalInt(c.req.query('offset'), 0, 'offset');
    const limit = parseOptionalInt(c.req.query('limit'), 6, 'limit');
    const grouped = c.req.query('grouped') === 'true';
    const covered = c.req.query('covered') === 'true';

    const page = await catalog.listTemplates({
      category,
      query,
      offset,
      limit,
      grouped,
      covered,
      locale,
      kind,
    });
    return buildPublicJsonResponse(page, c.req.header('if-none-match'));
  });

  // 3. Poster GET & HEAD
  // NOTE: Hono dispatches HEAD requests through GET routes with `c.req.method === 'HEAD'`.
  // Answering HEAD directly from PG metadata avoids redirecting HEAD to a GET-signed S3 URL.
  app.get(`${base}/templates/:id/poster`, async (c) => {
    const id = c.req.param('id');
    if (c.req.method === 'HEAD') {
      return buildHeadResponse(await catalog.headPosterAsset(id));
    }
    const resolved = await catalog.resolvePosterAsset(id);
    return buildAssetResponse(resolved, c.req.header('if-none-match'));
  });

  // 4. Preview GET & HEAD (302 presigned on GET; PG metadata on HEAD)
  app.get(`${base}/templates/:id/preview`, async (c) => {
    const id = c.req.param('id');
    if (c.req.method === 'HEAD') {
      return buildHeadResponse(await catalog.headPreviewAsset(id));
    }
    const resolved = await catalog.resolvePreviewAsset(id);
    return buildAssetResponse(resolved, c.req.header('if-none-match'));
  });

  // 5. Source asset GET & HEAD under both `/templates/:id/source/*` and legacy `/template-source/:id/*`
  const handleSourceAsset = async (
    c: Context<CatalogRouteEnv>,
    mode: 'templates-source' | 'template-source',
  ) => {
    const rawId = c.req.param('id') ?? '';
    const assetPath = extractWildcardAssetPath(c.req.url, base, mode, rawId);
    if (c.req.method === 'HEAD') {
      return buildHeadResponse(await catalog.headTemplateAsset(rawId, assetPath));
    }
    const resolved = await catalog.resolveSourceAsset(rawId, assetPath, {
      raw: c.req.query('raw') === '1',
      stage: c.req.query('stage') === '1',
      download: c.req.query('download') === '1',
      forceRedirect: c.req.query('redirect') === '1',
      locale: c.req.query('locale') || undefined,
    });
    return buildAssetResponse(resolved, c.req.header('if-none-match'));
  };

  app.get(`${base}/templates/:id/source/*`, (c) => handleSourceAsset(c, 'templates-source'));
  app.get(`${base}/template-source/:id/*`, (c) => handleSourceAsset(c, 'template-source'));

  // 6. Template detail
  app.get(`${base}/templates/:id`, async (c) => {
    const locale = c.req.query('locale') || undefined;
    const detail = await catalog.getTemplate(c.req.param('id'), { locale });
    return buildPublicJsonResponse({ template: detail, ...detail }, c.req.header('if-none-match'));
  });

  // 7. Zero-copy clone into workspace project (enforces AuthContext + workspace_id isolation)
  const handleClone = async (c: Context<CatalogRouteEnv>) => {
    const auth = resolveRequiredAuth(c, getAuthContext);
    if (!hasScope(auth, 'projects:write')) {
      throw new CloudError('INSUFFICIENT_SCOPE', 'Scope projects:write is required to clone templates', {
        status: 403,
        applied: false,
      });
    }
    if (!hasMinRole(auth, 'editor')) {
      throw new CloudError('FORBIDDEN', 'Editor role or higher is required to clone templates', {
        status: 403,
        applied: false,
      });
    }

    let rawBody: unknown = {};
    const contentLength = c.req.header('content-length');
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json') || (contentLength && Number(contentLength) > 0)) {
      try {
        const text = await c.req.text();
        rawBody = text.trim() ? JSON.parse(text) : {};
      } catch {
        throw new CloudError('INVALID_ARGUMENT', 'Request body must be valid JSON', {
          status: 400,
          applied: false,
        });
      }
    }

    const parsed = cloneBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new CloudError('INVALID_ARGUMENT', `Invalid clone request body: ${details}`, {
        status: 400,
        applied: false,
      });
    }

    const body = parsed.data;
    // Strict tenant isolation: never allow caller payload to target a different workspace.
    if (body.workspaceId !== undefined && body.workspaceId !== auth.workspaceId) {
      throw new CloudError('WORKSPACE_FORBIDDEN', 'Body workspaceId does not match authenticated workspace', {
        status: 403,
        applied: false,
      });
    }

    const cloned = await catalog.cloneTemplateToProject(auth, {
      templateId: c.req.param('id') ?? '',
      title: body.title,
      sessionId: body.sessionId,
      requirements: body.requirements ?? body.instruction,
      namingLanguage: body.namingLanguage,
      requestId: body.requestId,
      locale: body.locale,
      activateWorkspace: body.activateWorkspace,
    });

    return c.json(
      {
        project: cloned,
        ...cloned,
        projectId: cloned.projectId,
        projectTitle: cloned.title,
        revision: cloned.revision,
        sessionId: cloned.sessionId,
        exportJob: null,
      },
      cloned.replayed ? 200 : 201,
    );
  };

  app.post(`${base}/templates/:id/clone`, handleClone);
  app.post(`${base}/templates/:id/open`, handleClone);

  return app;
}
