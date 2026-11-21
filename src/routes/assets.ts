import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AssetListInput } from '../../shared/asset-library.ts';
import { hasMinRole, hasScope, type AuthContext, type PatScope } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { AssetModality, UploadTicketPurpose } from '../db/schema/blobs-assets.ts';
import type { AssetLibraryService } from '../services/asset-library-service.ts';

export interface AssetRoutesDeps {
  readonly assetService: AssetLibraryService;
  readonly getAuth?: (c: Context) => AuthContext | undefined;
}

function resolveAuth(c: Context, deps: AssetRoutesDeps): AuthContext {
  const ctx = deps.getAuth ? deps.getAuth(c) : ((c.get as (key: string) => unknown)('auth') as AuthContext | undefined);
  if (!ctx || !ctx.workspaceId) {
    throw new CloudError('UNAUTHORIZED', 'Authentication required', { status: 401 });
  }
  return ctx;
}

function assertAuthorized(ctx: AuthContext, scope: PatScope, write = false): void {
  if (!hasScope(ctx, scope)) {
    throw new CloudError('INSUFFICIENT_SCOPE', `Missing required scope: ${scope}`, { status: 403 });
  }
  if (write && !hasMinRole(ctx, 'editor')) {
    throw new CloudError('FORBIDDEN', 'Workspace editor role or higher is required', { status: 403 });
  }
}

function requireParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) {
    throw new CloudError('INVALID_ARGUMENT', `Missing route parameter: ${name}`, { status: 400 });
  }
  return value;
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new CloudError('INVALID_ARGUMENT', 'Request body must be a JSON object', { status: 400 });
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (isCloudError(error)) throw error;
    throw new CloudError('INVALID_ARGUMENT', 'Invalid JSON request body', { status: 400 });
  }
}

export function createAssetRoutes(deps: AssetRoutesDeps): Hono {
  const app = new Hono();
  const { assetService } = deps;

  app.onError((error, c) => {
    if (isCloudError(error)) {
      return c.json(error.toJSON(), error.status as ContentfulStatusCode);
    }
    return c.json(
      {
        code: 'INTERNAL_ERROR',
        error: error instanceof Error ? error.message : 'Unexpected asset error',
      },
      500,
    );
  });

  // GET / — list workspace library assets
  app.get('/', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:read');

    const query = c.req.query();
    const listInput: AssetListInput = {
      ...(query.modality ? { modality: query.modality as AssetModality } : {}),
      ...(query.source ? { source: query.source as 'upload' | 'generated' } : {}),
      ...(query.query !== undefined ? { query: query.query } : {}),
      ...(query.trash !== undefined ? { trash: query.trash === 'true' || query.trash === '1' } : {}),
      ...(query.sort ? { sort: query.sort as 'newest' | 'oldest' | 'name' } : {}),
      ...(query.offset !== undefined ? { offset: Number(query.offset) } : {}),
      ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
    };

    const result = await assetService.listAssets(auth, listInput);
    return c.json(result, 200);
  });

  // POST /uploads/tickets — mint presigned PUT upload ticket (+ optional companion font license staging key)
  app.post('/uploads/tickets', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:write', true);
    const body = await readJsonBody(c);

    const ticket = await assetService.createUploadTicket(auth, {
      purpose: body.purpose as UploadTicketPurpose | undefined,
      filename: body.filename as string,
      mimeType: body.mimeType as string,
      sizeBytes: Number(body.sizeBytes ?? body.bytes),
      expectedModality: body.expectedModality as AssetModality | undefined,
      expectedSha256: body.expectedSha256 as string | undefined,
      allowInstantCommit: body.allowInstantCommit === true,
      multipart: body.multipart === true,
      partSize: body.partSize !== undefined ? Number(body.partSize) : undefined,
      targetProjectId: body.targetProjectId as string | undefined,
      targetAssetId: body.targetAssetId as string | undefined,
      targetPath: body.targetPath as string | undefined,
      requestId: body.requestId as string | undefined,
      licenseFilename: body.licenseFilename as string | undefined,
      licenseBytes: body.licenseBytes !== undefined ? Number(body.licenseBytes) : undefined,
    });
    return c.json(ticket, ticket.instantCommitted ? 200 : 201);
  });

  // POST /uploads/:uploadId/parts — list uploaded parts (resume) and mint presigned S3 UploadPart URLs
  app.post('/uploads/:uploadId/parts', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:write', true);
    const uploadId = requireParam(c, 'uploadId');
    let body: Record<string, unknown> = {};
    const contentLength = c.req.header('content-length');
    if (contentLength !== '0' && c.req.header('content-type')?.includes('application/json')) {
      body = await readJsonBody(c);
    }
    const partNumbers = Array.isArray(body.partNumbers)
      ? body.partNumbers.map((n) => Number(n))
      : undefined;
    const result = await assetService.prepareMultipartParts(auth, uploadId, { partNumbers });
    return c.json(result, 200);
  });

  // POST /uploads/:uploadId/complete-multipart — assemble uploaded S3 parts into staging object before /confirm
  app.post('/uploads/:uploadId/complete-multipart', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:write', true);
    const uploadId = requireParam(c, 'uploadId');
    let body: Record<string, unknown> = {};
    const contentLength = c.req.header('content-length');
    if (contentLength !== '0' && c.req.header('content-type')?.includes('application/json')) {
      body = await readJsonBody(c);
    }
    const parts = Array.isArray(body.parts)
      ? (body.parts as Array<{ partNumber: number; etag: string }>)
      : undefined;
    const result = await assetService.completeMultipartTicket(auth, uploadId, { parts });
    return c.json(result, 200);
  });

  // DELETE /uploads/:uploadId — abort an in-progress single/multipart upload ticket and clean up staging
  app.delete('/uploads/:uploadId', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:write', true);
    const uploadId = requireParam(c, 'uploadId');
    const result = await assetService.abortUploadTicket(auth, uploadId);
    return c.json(result, 200);
  });

  // POST /uploads/:uploadId/confirm (and /complete alias) — validate ownership and enqueue upload_commit
  const handleConfirmUpload = async (c: Context) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:write', true);
    const uploadId = requireParam(c, 'uploadId');
    let body: Record<string, unknown> = {};
    const contentLength = c.req.header('content-length');
    if (contentLength !== '0' && c.req.header('content-type')?.includes('application/json')) {
      body = await readJsonBody(c);
    }

    const result = await assetService.confirmUploadTicket(auth, uploadId, {
      name: body.name as string | undefined,
      parentVersionId: body.parentVersionId as string | undefined,
      requestId: body.requestId as string | undefined,
      expectedSha256: body.expectedSha256 as string | undefined,
    });
    return c.json(result, result.replayed ? 200 : 202);
  };
  app.post('/uploads/:uploadId/confirm', handleConfirmUpload);
  app.post('/uploads/:uploadId/complete', handleConfirmUpload);

  // POST /import-url — SSRF-checked public HTTPS import into media-ingest (url_fetch)
  app.post('/import-url', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:write', true);
    const body = await readJsonBody(c);

    const result = await assetService.importFromPublicUrl(auth, {
      url: body.url as string,
      name: body.name as string,
      requestId: body.requestId as string,
      targetProjectId: body.targetProjectId as string | undefined,
      targetAssetId: body.targetAssetId as string | undefined,
      parentVersionId: body.parentVersionId as string | undefined,
      itemId: body.itemId as string | undefined,
      expectedModality: body.expectedModality as AssetModality | undefined,
    });
    return c.json(result, result.replayed ? 200 : 202);
  });

  // GET /:assetId — asset details + versions
  app.get('/:assetId', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:read');
    const assetId = c.req.param('assetId');
    const versionId = c.req.query('versionId') || undefined;
    const result = await assetService.getAsset(auth, assetId, versionId);
    return c.json(result, 200);
  });

  // PATCH /:assetId — rename, soft-trash/restore, or switch currentVersionId
  app.patch('/:assetId', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:write', true);
    const assetId = c.req.param('assetId');
    const body = await readJsonBody(c);
    const asset = await assetService.updateAsset(auth, assetId, {
      ...(body.name !== undefined ? { name: body.name as string } : {}),
      ...(body.trashed !== undefined ? { trashed: body.trashed as boolean } : {}),
      ...(body.currentVersionId !== undefined ? { currentVersionId: body.currentVersionId as string } : {}),
    });
    return c.json({ asset }, 200);
  });

  // DELETE /:assetId — soft delete by default, or permanent hard delete (?permanent=true) decrementing CAS refcounts
  app.delete('/:assetId', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:write', true);
    const assetId = c.req.param('assetId');
    const permanent = c.req.query('permanent') === 'true' || c.req.query('permanent') === '1';
    const result = await assetService.deleteAsset(auth, assetId, { permanent });
    return c.json(result, 200);
  });

  // DELETE /:assetId/versions/:versionId — delete a version and decrement CAS refcount
  app.delete('/:assetId/versions/:versionId', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:write', true);
    const assetId = c.req.param('assetId');
    const versionId = c.req.param('versionId');
    const result = await assetService.deleteAssetVersion(auth, assetId, versionId);
    return c.json(result, 200);
  });

  // GET & HEAD /:assetId/versions/:versionId/file
  // NOTE: Hono dispatches HEAD through GET handlers (`c.req.method === 'HEAD'`).
  // Answer HEAD directly from PG metadata (NEVER redirect HEAD to a GET-signed S3 URL!).
  app.get('/:assetId/versions/:versionId/file', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:read');
    const assetId = requireParam(c, 'assetId');
    const versionId = requireParam(c, 'versionId');

    if (c.req.method === 'HEAD') {
      const meta = await assetService.getAssetVersionMetadata(auth, { assetId, versionId }, { allowTrash: true });
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': meta.mimeType,
          'Content-Length': String(meta.sizeBytes),
          'Accept-Ranges': 'bytes',
          ETag: meta.etag,
          'Cache-Control': 'private, max-age=60',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    const download = c.req.query('download') !== undefined && c.req.query('download') !== '0' && c.req.query('download') !== 'false';
    const presigned = await assetService.presignAssetVersionGet(
      auth,
      { assetId, versionId },
      { download, allowTrash: true },
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: presigned.url,
        'Cache-Control': 'private, max-age=60',
        Vary: 'Origin, Cookie',
        ETag: presigned.metadata.etag,
      },
    });
  });

  // GET & HEAD /:assetId/versions/:versionId/thumbnail
  app.get('/:assetId/versions/:versionId/thumbnail', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'assets:read');
    const assetId = requireParam(c, 'assetId');
    const versionId = requireParam(c, 'versionId');
    const spec = c.req.query('spec') || 'w320';

    if (c.req.method === 'HEAD') {
      const resolved = await assetService.resolveAssetThumbnail(
        auth,
        { assetId, versionId },
        { spec, enqueueOnMiss: false, skipPresign: true },
      );
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': resolved.contentType,
          'Content-Length': String(resolved.contentLength),
          'Accept-Ranges': 'bytes',
          ETag: resolved.etag,
          'Cache-Control': 'private, max-age=60',
        },
      });
    }

    const widthParam = c.req.query('w') ?? c.req.query('width');
    const width = widthParam ? Number(widthParam) : undefined;
    const resolved = await assetService.resolveAssetThumbnail(
      auth,
      { assetId, versionId },
      { spec, ...(width && Number.isFinite(width) ? { width } : {}) },
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: resolved.url,
        'Cache-Control': 'private, max-age=60',
        Vary: 'Origin, Cookie',
        ETag: resolved.etag,
      },
    });
  });

  return app;
}
