import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ExportExpectation } from '../../shared/export-spec.ts';
import { hasMinRole, hasScope, type AuthContext, type PatScope } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { JobProgressEvent } from '../contracts/events.ts';
import type { ExportFormat, ExportJobRecord, ExportService } from '../services/export-service.ts';

export interface ExportRoutesDeps {
  readonly exportService: ExportService;
  readonly getAuth?: (c: Context) => AuthContext | undefined;
  readonly sseKeepaliveMs?: number;
}

const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

function resolveAuth(c: Context, deps: ExportRoutesDeps): AuthContext {
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

async function readOptionalJsonBody(c: Context): Promise<Record<string, unknown>> {
  const contentLength = c.req.header('content-length');
  if (contentLength === '0') return {};
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('application/json')) return {};
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

function mapStudioProgressStatus(state: string): string {
  return state === 'completed' ? 'complete' : state;
}

function formatProgressPayload(job: ExportJobRecord): Record<string, unknown> {
  return {
    jobId: job.id,
    projectId: job.projectId,
    state: job.state,
    status: mapStudioProgressStatus(job.state),
    stage: job.stage ?? job.state,
    progress: job.progress,
    filename: job.outputName,
    ...(job.sizeBytes !== undefined ? { size: job.sizeBytes, bytes: job.sizeBytes } : {}),
    ...(job.durationMs !== undefined ? { durationMs: job.durationMs } : {}),
    ...(job.audioLoweredDb !== undefined ? { audioLoweredDb: job.audioLoweredDb } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.errorMessage ? { error: job.errorMessage } : {}),
    ts: Date.now(),
  };
}

function formatLiveProgressEvent(event: JobProgressEvent, fallbackFilename: string): Record<string, unknown> {
  const result = event.resultJson ?? {};
  return {
    jobId: event.jobId,
    projectId: event.projectId ?? null,
    state: event.state,
    status: mapStudioProgressStatus(event.state),
    stage: event.stage ?? event.state,
    progress: event.progress,
    filename: typeof result.outputName === 'string' ? result.outputName : fallbackFilename,
    ...(typeof result.bytes === 'number' ? { size: result.bytes, bytes: result.bytes } : {}),
    ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
    ...(typeof result.audioLoweredDb === 'number' ? { audioLoweredDb: result.audioLoweredDb } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(event.errorMessage ? { error: event.errorMessage } : {}),
    ts: event.ts,
  };
}

export function createExportRoutes(deps: ExportRoutesDeps): Hono {
  const app = new Hono();
  const { exportService } = deps;
  const keepaliveMs = deps.sseKeepaliveMs ?? 20_000;

  app.onError((error, c) => {
    if (isCloudError(error)) {
      return c.json(error.toJSON(), error.status as ContentfulStatusCode);
    }
    return c.json(
      {
        code: 'INTERNAL_ERROR',
        error: error instanceof Error ? error.message : 'Unexpected export error',
      },
      500,
    );
  });

  // POST /projects/:projectId/exports & /projects/:projectId/render — freeze snapshot + enqueue export_render
  const handleStartExport = async (c: Context) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'exports:write', true);
    const projectId = requireParam(c, 'projectId');
    const body = await readOptionalJsonBody(c);

    const started = await exportService.startExport(auth, projectId, {
      expectedRevision: body.expectedRevision as string | undefined,
      expectedVersionId: body.expectedVersionId as string | undefined,
      requestId: body.requestId as string | undefined,
      idempotencyKey: body.idempotencyKey as string | undefined,
      compositionPath: (body.compositionPath ?? body.composition) as string | undefined,
      outputName: (body.outputName ?? body.filename) as string | undefined,
      format: body.format as ExportFormat | undefined,
      phase1: typeof body.phase1 === 'boolean' ? body.phase1 : undefined,
      settings:
        body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
          ? (body.settings as Record<string, unknown>)
          : undefined,
      expected: body.expected as ExportExpectation | undefined,
      workId: body.workId as string | undefined,
      exportRoute: 'studio',
    });

    return c.json(
      {
        jobId: started.job.id,
        filename: started.job.outputName,
        createdAt: started.job.createdAt,
        status: mapStudioProgressStatus(started.job.state),
        state: started.job.state,
        replayed: started.replayed,
        snapshotVersionId: started.snapshotVersionId,
        job: started.job,
      },
      started.replayed ? 200 : 202,
    );
  };
  app.post('/projects/:projectId/exports', handleStartExport);
  app.post('/projects/:projectId/render', handleStartExport);

  // GET /projects/:projectId/exports & /projects/:projectId/renders — list project exports
  const handleListExports = async (c: Context) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'projects:read');
    const projectId = requireParam(c, 'projectId');
    const limitParam = c.req.query('limit');
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    const exportsList = await exportService.listProjectExports(auth, projectId, {
      ...(limit && Number.isFinite(limit) ? { limit } : {}),
    });
    return c.json({ exports: exportsList, renders: exportsList }, 200);
  };
  app.get('/projects/:projectId/exports', handleListExports);
  app.get('/projects/:projectId/renders', handleListExports);

  // GET & HEAD /projects/:projectId/renders/file/:filename
  // NOTE: Hono routes HEAD through GET handlers (`c.req.method === 'HEAD'`).
  // Answer HEAD directly from PG metadata (NEVER redirect HEAD to a GET-signed S3 URL!).
  app.get('/projects/:projectId/renders/file/:filename', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'projects:read');
    const projectId = requireParam(c, 'projectId');
    const filename = requireParam(c, 'filename');
    const meta = await exportService.getExportFileMetadataByName(auth, projectId, filename);
    if (c.req.method === 'HEAD') {
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
    const isDownload =
      c.req.query('download') !== undefined &&
      c.req.query('download') !== '0' &&
      c.req.query('download') !== 'false';
    const isFrame =
      !isDownload &&
      meta.mimeType.startsWith('video/') &&
      c.req.query('frame') !== undefined &&
      c.req.query('frame') !== '0' &&
      c.req.query('frame') !== 'false';
    const isRetry = isFrame && /^[1-9]\d*$/.test(c.req.query('retry') ?? '');
    const presigned = await exportService.presignExportFile(auth, meta.jobId, {
      disposition: isFrame ? 'inline' : 'attachment',
      frame: isFrame,
      bypassCacheWindow: isRetry,
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: presigned.url,
        'Cache-Control': isRetry ? 'no-store' : 'private, max-age=60',
        Vary: 'Origin, Cookie',
        ETag: meta.etag,
      },
    });
  });

  // GET /exports/:jobId — job status JSON
  app.get('/exports/:jobId', async (c) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'projects:read');
    const job = await exportService.getExport(auth, requireParam(c, 'jobId'));
    return c.json({ job }, 200);
  });

  // GET /exports/:jobId/progress & /render/:jobId/progress — SSE backed by om:job:{jobId}
  const handleProgressSse = async (c: Context) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'projects:read');
    const jobId = requireParam(c, 'jobId');
    const initial = await exportService.getExport(auth, jobId);

    const encoder = new TextEncoder();
    let unsubscribe: (() => Promise<void>) | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (unsubscribe) {
        const release = unsubscribe;
        unsubscribe = null;
        await release().catch(() => {});
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enqueueText = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            void cleanup();
          }
        };

        const closeStream = async () => {
          await cleanup();
          try {
            controller.close();
          } catch {
            // Stream already closed by client.
          }
        };

        enqueueText(`data: ${JSON.stringify(formatProgressPayload(initial))}\n\n`);
        if (TERMINAL_STATES.has(initial.state)) {
          await closeStream();
          return;
        }

        const abortHandler = () => {
          void closeStream();
        };
        c.req.raw.signal.addEventListener('abort', abortHandler, { once: true });

        try {
          unsubscribe = await exportService.subscribeJobProgress(jobId, (event) => {
            if (event.workspaceId !== auth.workspaceId) return;
            enqueueText(`data: ${JSON.stringify(formatLiveProgressEvent(event, initial.outputName))}\n\n`);
            if (TERMINAL_STATES.has(event.state)) {
              void closeStream();
            }
          });
        } catch (error) {
          c.req.raw.signal.removeEventListener('abort', abortHandler);
          await cleanup();
          controller.error(error);
          return;
        }

        // Re-check DB state after subscribing so a terminal transition during subscribe is never missed.
        const postSub = await exportService.getExport(auth, jobId).catch(() => null);
        if (postSub && TERMINAL_STATES.has(postSub.state) && !closed) {
          enqueueText(`data: ${JSON.stringify(formatProgressPayload(postSub))}\n\n`);
          await closeStream();
          return;
        }

        keepaliveTimer = setInterval(() => {
          enqueueText(': keepalive\n\n');
        }, keepaliveMs);
        keepaliveTimer.unref();
      },
      cancel() {
        void cleanup();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  };
  app.get('/exports/:jobId/progress', handleProgressSse);
  app.get('/render/:jobId/progress', handleProgressSse);

  // POST /exports/:jobId/cancel & /render/:jobId/cancel
  const handleCancel = async (c: Context) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'exports:write', true);
    const job = await exportService.cancelExport(auth, requireParam(c, 'jobId'));
    return c.json({ jobId: job.id, state: job.state, status: mapStudioProgressStatus(job.state), job }, 200);
  };
  app.post('/exports/:jobId/cancel', handleCancel);
  app.post('/render/:jobId/cancel', handleCancel);

  // DELETE /exports/:jobId & /render/:jobId
  const handleDelete = async (c: Context) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'exports:write', true);
    const result = await exportService.deleteExport(auth, requireParam(c, 'jobId'));
    return c.json({ ok: true, ...result }, 200);
  };
  app.delete('/exports/:jobId', handleDelete);
  app.delete('/render/:jobId', handleDelete);

  // GET & HEAD /exports/:jobId/download & /render/:jobId/download
  // Answer HEAD directly from PG metadata (NO S3 redirect); GET returns 302 Presigned GET (attachment).
  const handleDownloadFile = async (c: Context) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'projects:read');
    const jobId = requireParam(c, 'jobId');
    if (c.req.method === 'HEAD') {
      const meta = await exportService.getExportFileMetadata(auth, jobId);
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
    const presigned = await exportService.presignExportFile(auth, jobId, {
      disposition: 'attachment',
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: presigned.url,
        'Cache-Control': 'private, max-age=60',
        Vary: 'Origin, Cookie',
        ETag: presigned.metadata.etag,
      },
    });
  };
  app.get('/exports/:jobId/download', handleDownloadFile);
  app.get('/render/:jobId/download', handleDownloadFile);

  // GET & HEAD /exports/:jobId/view & /render/:jobId/view
  // Answer HEAD directly from PG metadata (NO S3 redirect); GET returns 302 Presigned GET (inline).
  const handleViewFile = async (c: Context) => {
    const auth = resolveAuth(c, deps);
    assertAuthorized(auth, 'projects:read');
    const jobId = requireParam(c, 'jobId');
    if (c.req.method === 'HEAD') {
      const meta = await exportService.getExportFileMetadata(auth, jobId);
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
    const isFrame = c.req.query('frame') !== undefined && c.req.query('frame') !== '0' && c.req.query('frame') !== 'false';
    const isRetry = isFrame && /^[1-9]\d*$/.test(c.req.query('retry') ?? '');
    const presigned = await exportService.presignExportFile(auth, jobId, {
      disposition: 'inline',
      frame: isFrame,
      bypassCacheWindow: isRetry,
    });
    const isVideoFrameRetry = isRetry && presigned.metadata.mimeType.startsWith('video/');
    return new Response(null, {
      status: 302,
      headers: {
        Location: presigned.url,
        'Cache-Control': isVideoFrameRetry ? 'no-store' : 'private, max-age=60',
        Vary: 'Origin, Cookie',
        ETag: presigned.metadata.etag,
      },
    });
  };
  app.get('/exports/:jobId/view', handleViewFile);
  app.get('/render/:jobId/view', handleViewFile);

  return app;
}
