import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthContext, PatScope, WorkspaceRole } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { ProjectArchiveService } from '../services/project-archive-service.ts';
import { assertAuthAccess } from '../studio/context.ts';
import { PRESIGNED_REDIRECT_HEADERS, buildContentDisposition } from '../studio/etag.ts';
import { PROJECT_ARCHIVE_LIMITS } from '../../shared/project-archive.ts';
import type { ProductRouteVariables } from './projects.ts';

export interface ArchivesRouterDeps {
  readonly archives: ProjectArchiveService;
  readonly resolveAuth?: (c: Context<{ Variables: ProductRouteVariables }>) => AuthContext | Promise<AuthContext>;
}

const READ_REQ = { scope: 'projects:read' } as const;
const WRITE_REQ = { scope: 'projects:write', minRole: 'editor' } as const;
const archiveDownloadHeaders = {
  ...PRESIGNED_REDIRECT_HEADERS,
  Vary: `${PRESIGNED_REDIRECT_HEADERS.Vary}, Authorization, X-OpenMotion-Workspace-Id`,
};

async function requireAuth(
  c: Context<{ Variables: ProductRouteVariables }>,
  deps: ArchivesRouterDeps,
  requirements: { scope: PatScope; minRole?: WorkspaceRole },
): Promise<AuthContext> {
  const auth = deps.resolveAuth ? await deps.resolveAuth(c) : c.get('auth');
  if (!auth) {
    throw new CloudError('UNAUTHORIZED', 'Authentication is required.', { status: 401, applied: false });
  }
  assertAuthAccess(auth, requirements);
  return auth;
}

export function createArchivesRouter(deps: ArchivesRouterDeps): Hono<{ Variables: ProductRouteVariables }> {
  const app = new Hono<{ Variables: ProductRouteVariables }>();

  app.onError((err, c) => {
    if (isCloudError(err)) {
      return c.json(err.toJSON(), err.status as 400);
    }
    return c.json(
      { code: 'INTERNAL_ERROR', error: err instanceof Error ? err.message : 'Internal server error' },
      500,
    );
  });

  // POST /motion-api/project-archives/export — Export workspace projects to S3 ZIP archive.
  app.post('/motion-api/project-archives/export', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as {
      requestId?: string;
      projectIds?: string[];
      all?: boolean;
      expectedRevisions?: Record<string, string>;
    };
    const result = await deps.archives.exportProjects(auth, {
      requestId: body.requestId ?? randomUUID(),
      projectIds: body.projectIds,
      all: body.all,
      expectedRevisions: body.expectedRevisions,
    });
    return c.json(result);
  });

  // POST /motion-api/project-archives/import — Import a ZIP archive (multipart form or raw ZIP body).
  app.post(
    '/motion-api/project-archives/import',
    bodyLimit({
      maxSize: PROJECT_ARCHIVE_LIMITS.bytes,
      onError: (c) => c.json({ code: 'INVALID_ARGUMENT', error: 'Project archive exceeds 500 MB limit.' }, 413),
    }),
    async (c) => {
      const auth = await requireAuth(c, deps, WRITE_REQ);
      const contentType = c.req.header('content-type') ?? '';
      let zipBytes: Buffer;
      let requestId: string;
      let filename: string | undefined;

      if (contentType.includes('multipart/form-data')) {
        const form = await c.req.formData();
        const file = form.get('file');
        if (!(file instanceof File)) {
          throw new CloudError('INVALID_ARGUMENT', 'Multipart upload must include a "file" field.', {
            status: 400,
            applied: false,
          });
        }
        zipBytes = Buffer.from(await file.arrayBuffer());
        filename = file.name || undefined;
        const formReqId = form.get('requestId');
        requestId =
          typeof formReqId === 'string' && formReqId.trim()
            ? formReqId.trim()
            : c.req.header('x-request-id') ?? randomUUID();
      } else {
        zipBytes = Buffer.from(await c.req.arrayBuffer());
        requestId = c.req.query('requestId') ?? c.req.header('x-request-id') ?? randomUUID();
        filename = c.req.query('filename') ?? undefined;
      }

      const result = await deps.archives.importProjects(auth, {
        requestId,
        zipBytes,
        filename,
      });
      return c.json(result, result.replayed ? 200 : 201);
    },
  );

  // GET & HEAD /motion-api/project-archives/:archiveId/file
  // Hono v4 dispatches HEAD via GET; answer HEAD directly via headArchive without redirecting HEAD!
  app.get('/motion-api/project-archives/:archiveId/file', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const archiveId = c.req.param('archiveId');
    const filename = c.req.query('filename') ?? undefined;

    if (c.req.method === 'HEAD') {
      const head = await deps.archives.headArchive(auth, archiveId);
      if (!head) return c.body(null, 404);
      const downloadName = filename ?? `openmotion-archive-${archiveId.slice(0, 8)}.zip`;
      c.header('Content-Type', head.contentType ?? 'application/zip');
      c.header('Content-Length', String(head.contentLength));
      c.header('Accept-Ranges', 'bytes');
      c.header('Content-Disposition', buildContentDisposition('attachment', downloadName));
      c.header('Cache-Control', archiveDownloadHeaders['Cache-Control']);
      c.header('Vary', archiveDownloadHeaders.Vary);
      return c.body(null, 200);
    }

    const download = await deps.archives.presignArchiveDownload(auth, archiveId, filename);
    if (!download) return c.notFound();

    return new Response(null, {
      status: 302,
      headers: {
        Location: download.url,
        ...archiveDownloadHeaders,
      },
    });
  });

  return app;
}
