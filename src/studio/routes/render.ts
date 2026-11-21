import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  encoderJobOptions,
  parseEncoderOptions,
  type EncoderOptionsBody,
} from '@hyperframes/studio-server/encoder-options';
import { CloudError } from '../../contracts/errors.ts';
import type { JobProgressEvent } from '../../contracts/events.ts';
import type { JobState } from '../../contracts/jobs.ts';
import { asInsert, asUpdate } from '../../db/helpers.ts';
import { jobs } from '../../db/schema/jobs.ts';
import { cancelChannel, jobChannel } from '../../infra/redis.ts';
import { assertTenantScopedKey } from '../../infra/storage.ts';
import { isUuid } from '../../../shared/project-validation.ts';
import { renderFilenameStem } from '../../../shared/render-name.ts';
import {
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import {
  PRESIGNED_REDIRECT_HEADERS,
  buildContentDisposition,
  formatVersionFromSha256,
  getMimeType,
} from '../etag.ts';
import { assertValidUuid, loadProjectOrThrow } from '../../services/project-files-service.ts';

type RenderFormat = 'mp4' | 'mov' | 'webm' | 'gif';

const ACTIVE_JOB_STATES: readonly JobState[] = ['queued', 'running', 'cancelling'];

function mapJobStateToStudioStatus(state: JobState): string {
  switch (state) {
    case 'queued':
    case 'running':
      return 'rendering';
    case 'cancelling':
      return 'cancelling';
    case 'completed':
      return 'complete';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function isTerminalState(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function readResultSizeBytes(result: Record<string, unknown>): number | undefined {
  const candidate = result.bytes ?? result.sizeBytes;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function readResultFilename(
  result: Record<string, unknown>,
  input: Record<string, unknown>,
  jobId: string,
): string {
  return (
    (typeof result.outputName === 'string' && result.outputName) ||
    (typeof result.filename === 'string' && result.filename) ||
    (typeof input.outputName === 'string' && input.outputName) ||
    `render-${jobId.slice(0, 8)}.mp4`
  );
}

function formatRenderAttempt(row: typeof jobs.$inferSelect): Record<string, unknown> {
  const input = (row.inputPayload ?? {}) as Record<string, unknown>;
  const result = (row.resultJson ?? {}) as Record<string, unknown>;
  const filename = readResultFilename(result, input, row.id);
  const sizeBytes = readResultSizeBytes(result);

  const durationMs =
    row.startedAt && row.terminalAt
      ? Math.max(0, row.terminalAt.getTime() - row.startedAt.getTime())
      : undefined;

  return {
    id: row.id,
    jobId: row.id,
    nativeJobId: row.id,
    requestId: row.requestId ?? undefined,
    filename,
    status: mapJobStateToStudioStatus(row.state),
    state: row.state,
    progress: Number(row.progress ?? 0),
    stage: row.stage ?? undefined,
    createdAt: row.createdAt.getTime(),
    ...(durationMs !== undefined ? { durationMs } : {}),
    fileAvailable: row.state === 'completed' && typeof result.s3Key === 'string' && result.s3Key.length > 0,
    ...(row.errorMessage ? { error: row.errorMessage } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(sizeBytes !== undefined ? { bytes: sizeBytes, sizeBytes } : {}),
    ...(typeof result.sha256 === 'string' ? { sha256: result.sha256 } : {}),
  };
}

function parseFormat(raw: unknown): RenderFormat {
  if (raw === 'mov' || raw === 'webm' || raw === 'gif') return raw;
  return 'mp4';
}

function resolveRenderArtifactMeta(
  workspaceId: string,
  row: typeof jobs.$inferSelect,
): { s3Key: string; filename: string; contentType: string; sizeBytes: number; sha256?: string } | null {
  if (row.state !== 'completed' || !row.resultJson) return null;
  const result = row.resultJson as Record<string, unknown>;
  const rawKey = typeof result.s3Key === 'string' ? result.s3Key : null;
  if (!rawKey) return null;
  const s3Key = assertTenantScopedKey(workspaceId, rawKey);
  const input = (row.inputPayload ?? {}) as Record<string, unknown>;
  const filename = readResultFilename(result, input, row.id);
  const contentType =
    (typeof result.mimeType === 'string' && result.mimeType) ||
    (typeof result.contentType === 'string' && result.contentType) ||
    getMimeType(filename);
  const sizeBytes = readResultSizeBytes(result) ?? 0;
  const sha256 = typeof result.sha256 === 'string' ? result.sha256 : undefined;
  return { s3Key, filename, contentType, sizeBytes, sha256 };
}

export function createStudioRenderRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // POST /api/projects/:id/render — Create export job in PG & enqueue to render-export queue.
  app.post('/api/projects/:id/render', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'exports:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as EncoderOptionsBody & {
      format?: string;
      quality?: string;
      fps?: number;
      compositionPath?: string;
      composition?: string;
      variables?: unknown;
      requestId?: string;
      telemetryOptOut?: boolean;
    };

    const compositionPath =
      typeof body.compositionPath === 'string' && body.compositionPath.trim()
        ? body.compositionPath.trim()
        : typeof body.composition === 'string' && body.composition.trim()
          ? body.composition.trim()
          : undefined;

    const variables =
      body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)
        ? (body.variables as Record<string, unknown>)
        : undefined;

    const format = parseFormat(body.format);
    const parsedEncoder = parseEncoderOptions(body, format);
    if (parsedEncoder.ok === false) {
      return c.json({ error: parsedEncoder.error }, 400);
    }

    const requestId =
      typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.requestId)
        ? body.requestId
        : undefined;

    const project = await loadProjectOrThrow(deps.db, auth.workspaceId, projectId, { allowTrashed: false });
    if (!project.currentVersionId) {
      throw new CloudError('INVALID_ARGUMENT', 'Project does not have a committed version to render.', {
        status: 400,
        applied: false,
      });
    }

    // Idempotent replay when caller retries the same requestId.
    if (requestId) {
      const existing = await deps.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.workspaceId, auth.workspaceId),
            eq(jobs.kind, 'export_render'),
            eq(jobs.idempotencyKey, requestId),
          ),
        );
      if (existing[0]) {
        const formatted = formatRenderAttempt(existing[0]);
        return c.json({
          ...formatted,
          replayed: true,
        });
      }
    }

    // Enforce single active export per project (also backed by DB unique partial index uq_jobs_active_export_per_project).
    const activeRows = await deps.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, auth.workspaceId),
          eq(jobs.projectId, project.id),
          eq(jobs.kind, 'export_render'),
          inArray(jobs.state, [...ACTIVE_JOB_STATES]),
        ),
      );
    if (activeRows.length > 0) {
      return c.json(
        {
          code: 'EXPORT_BUSY',
          applied: false,
          error: 'An export is already in progress. Check the original task.',
          activeJobId: activeRows[0].id,
        },
        409,
      );
    }

    let workId: string | null = null;
    if (body.telemetryOptOut !== true && deps.workRounds) {
      const latest = await deps.workRounds.latestGenerated(auth, project.id).catch(() => null);
      workId = latest?.id ?? null;
    }

    const jobId = randomUUID();
    const now = new Date();
    const stem = renderFilenameStem(project.title);
    const filename = `${stem}-${jobId.slice(0, 6)}.${format}`;
    const settings: Record<string, unknown> = {
      format,
      ...(typeof body.quality === 'string' ? { quality: body.quality } : {}),
      ...(typeof body.fps === 'number' && Number.isFinite(body.fps) ? { fps: body.fps } : {}),
      ...encoderJobOptions(parsedEncoder.options),
      ...(parsedEncoder.options.gifLoop !== undefined ? { gifLoop: parsedEncoder.options.gifLoop } : {}),
      ...(variables ? { variables } : {}),
    };

    try {
      await deps.db.insert(jobs).values(
        asInsert(jobs, {
          id: jobId,
          workspaceId: auth.workspaceId,
          projectId: project.id,
          kind: 'export_render',
          state: 'queued',
          stage: 'queued',
          progress: 0,
          versionId: project.currentVersionId,
          revision: project.revision.trim(),
          workId,
          requestId: requestId ?? null,
          idempotencyKey: requestId ?? null,
          inputPayload: {
            outputName: filename,
            format,
            compositionPath: compositionPath ?? 'index.html',
            ...(variables ? { variables } : {}),
            settings,
          },
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (error) {
      // Handle unique partial index race (`23505` on uq_jobs_active_export_per_project),
      // whether thrown directly by `pg` or wrapped as `error.cause` by Drizzle.
      const errObj = error as { code?: string; cause?: { code?: string } } | null;
      const pgCode = errObj?.code ?? errObj?.cause?.code;
      if (pgCode === '23505') {
        return c.json(
          {
            code: 'EXPORT_BUSY',
            applied: false,
            error: 'An export is already in progress. Check the original task.',
          },
          409,
        );
      }
      throw error;
    }

    if (deps.queues) {
      try {
        await deps.queues.enqueueRenderExport('export_render', {
          jobId,
          workspaceId: auth.workspaceId,
          projectId: project.id,
          versionId: project.currentVersionId,
          revision: project.revision.trim(),
          compositionPath,
          outputName: filename,
          format,
          phase1: true,
          settings,
        });
      } catch (err) {
        const failNow = new Date();
        await deps.db
          .update(jobs)
          .set(
            asUpdate(jobs, {
              state: 'failed',
              stage: 'enqueue',
              errorCode: 'QUEUE_ENQUEUE_FAILED',
              errorMessage: err instanceof Error ? err.message : 'Failed to enqueue export render job',
              terminalAt: failNow,
              updatedAt: failNow,
            }),
          )
          .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)));
        throw err;
      }
    }

    return c.json({
      id: jobId,
      jobId,
      nativeJobId: jobId,
      filename,
      createdAt: now.getTime(),
      status: 'rendering',
      state: 'queued',
      progress: 0,
      stage: 'queued',
      settings,
    });
  });

  // GET /api/projects/:id/renders — List non-deleted export render attempts for a project.
  app.get('/api/projects/:id/renders', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    await loadProjectOrThrow(deps.db, auth.workspaceId, projectId, { allowTrashed: true });

    const rows = await deps.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, auth.workspaceId),
          eq(jobs.projectId, projectId),
          eq(jobs.kind, 'export_render'),
          isNull(jobs.deletedAt),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(100);

    return c.json({ renders: rows.map(formatRenderAttempt) });
  });

  // GET /api/render/:jobId/progress — SSE progress stream backed by PG replay + Redis `om:job:{jobId}`.
  app.get('/api/render/:jobId/progress', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const jobId = c.req.param('jobId');
    if (!isUuid(jobId)) return c.notFound();

    const rows = await deps.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, auth.workspaceId),
          eq(jobs.id, jobId),
          isNull(jobs.deletedAt),
        ),
      );
    const job = rows[0];
    if (!job) return c.notFound();

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify(formatRenderAttempt(job)),
      });

      if (isTerminalState(job.state) || !deps.eventBus) {
        return;
      }

      let done = false;
      let resolveDone: (() => void) | null = null;
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      const initialInput = (job.inputPayload ?? {}) as Record<string, unknown>;
      const unsubscribe = await deps.eventBus.subscribe(jobChannel(jobId), (payload) => {
        if (done || stream.aborted) return;
        const evt = payload as Partial<JobProgressEvent>;
        if (evt.workspaceId && evt.workspaceId !== auth.workspaceId) return;
        const result = (evt.resultJson ?? {}) as Record<string, unknown>;
        const filename = readResultFilename(result, initialInput, jobId);
        const sizeBytes = readResultSizeBytes(result);
        const durationMs =
          typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) && result.durationMs >= 0
            ? result.durationMs
            : undefined;
        const mapped = {
          id: jobId,
          jobId,
          filename,
          status: evt.state ? mapJobStateToStudioStatus(evt.state) : 'rendering',
          state: evt.state ?? 'running',
          progress: typeof evt.progress === 'number' ? evt.progress : 0,
          stage: evt.stage,
          error: evt.errorMessage,
          fileAvailable: evt.state === 'completed',
          ...(sizeBytes !== undefined ? { bytes: sizeBytes, sizeBytes } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(typeof result.sha256 === 'string' ? { sha256: result.sha256 } : {}),
        };
        void stream.writeSSE({ event: 'progress', data: JSON.stringify(mapped) }).catch(() => {});
        if (evt.state && isTerminalState(evt.state)) {
          done = true;
          resolveDone?.();
        }
      });

      const keepalive = setInterval(() => {
        if (done || stream.aborted) return;
        void stream.write(': keepalive\n\n').catch(() => {});
      }, 20_000);

      stream.onAbort(() => {
        done = true;
        resolveDone?.();
      });

      try {
        await donePromise;
      } finally {
        clearInterval(keepalive);
        await unsubscribe().catch(() => {});
      }
    });
  });

  // POST /api/render/:jobId/cancel — Request cooperative render cancellation via PG + Redis.
  app.post('/api/render/:jobId/cancel', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'exports:write', minRole: 'editor' });
    const jobId = c.req.param('jobId');
    assertValidUuid(jobId, 'jobId');

    const rows = await deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId), isNull(jobs.deletedAt)));
    const job = rows[0];
    if (!job) return c.notFound();

    let nextState: JobState = job.state;
    const now = new Date();
    if (job.state === 'queued') {
      nextState = 'cancelled';
      await deps.db
        .update(jobs)
        .set(asUpdate(jobs, { state: 'cancelled', terminalAt: now, updatedAt: now }))
        .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)));
    } else if (job.state === 'running') {
      nextState = 'cancelling';
      await deps.db
        .update(jobs)
        .set(asUpdate(jobs, { state: 'cancelling', updatedAt: now }))
        .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)));
    }

    if (deps.eventBus && (job.state === 'queued' || job.state === 'running')) {
      void deps.eventBus
        .publish(cancelChannel(jobId), {
          jobId,
          workspaceId: auth.workspaceId,
          requestedAt: Date.now(),
        })
        .catch(() => {});
    }

    return c.json({
      jobId,
      status: mapJobStateToStudioStatus(nextState),
      state: nextState,
    });
  });

  // DELETE /api/render/:jobId — Soft-delete a confirmed terminal render attempt.
  app.delete('/api/render/:jobId', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'exports:write', minRole: 'editor' });
    const jobId = c.req.param('jobId');
    assertValidUuid(jobId, 'jobId');

    const rows = await deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId), isNull(jobs.deletedAt)));
    const job = rows[0];
    if (!job) return c.notFound();

    if (!isTerminalState(job.state)) {
      return c.json({ error: 'Render has no confirmed terminal state' }, 409);
    }

    await deps.db
      .update(jobs)
      .set(asUpdate(jobs, { deletedAt: new Date(), updatedAt: new Date() }))
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)));

    return c.json({ ok: true, deleted: true });
  });

  // GET & HEAD /api/render/:jobId/:action{view|download}
  // Hono v4 dispatches HEAD via GET; answer HEAD DIRECTLY from PG metadata — NEVER 302 to GET-signed S3 URL!
  app.get('/api/render/:jobId/:action{view|download}', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const jobId = c.req.param('jobId');
    if (!isUuid(jobId)) return c.req.method === 'HEAD' ? c.body(null, 404) : c.notFound();

    const rows = await deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId), isNull(jobs.deletedAt)));
    const job = rows[0];
    if (!job) return c.req.method === 'HEAD' ? c.body(null, 404) : c.notFound();

    const artifact = resolveRenderArtifactMeta(auth.workspaceId, job);
    if (!artifact) return c.req.method === 'HEAD' ? c.body(null, 404) : c.notFound();

    const action = c.req.param('action');

    if (c.req.method === 'HEAD') {
      c.header('Content-Type', artifact.contentType);
      c.header('Content-Length', String(artifact.sizeBytes));
      c.header('Accept-Ranges', 'bytes');
      if (artifact.sha256) {
        c.header('ETag', formatVersionFromSha256(artifact.sha256));
      }
      if (action === 'download') {
        c.header('Content-Disposition', buildContentDisposition('attachment', artifact.filename));
      }
      c.header('Cache-Control', PRESIGNED_REDIRECT_HEADERS['Cache-Control']);
      c.header('Vary', PRESIGNED_REDIRECT_HEADERS.Vary);
      return c.body(null, 200);
    }

    const url = await deps.storage.presignGet(artifact.s3Key, {
      expiresInSec: 300,
      responseContentType: artifact.contentType,
      responseContentDisposition: buildContentDisposition(
        action === 'download' ? 'attachment' : 'inline',
        artifact.filename,
      ),
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        ...(artifact.sha256 ? { ETag: formatVersionFromSha256(artifact.sha256) } : {}),
        ...PRESIGNED_REDIRECT_HEADERS,
      },
    });
  });

  // HEAD & GET /api/projects/:id/renders/file/:filename — Filename lookup over PG completed renders.
  const lookupRenderByFilename = async (workspaceId: string, projectId: string, filename: string) => {
    if (!isUuid(projectId) || /[\/\\\x00]/.test(filename) || !/\.(mp4|mov|webm|gif)$/i.test(filename)) return null;
    const rows = await deps.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, workspaceId),
          eq(jobs.projectId, projectId),
          eq(jobs.kind, 'export_render'),
          eq(jobs.state, 'completed'),
          isNull(jobs.deletedAt),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(100);
    for (const row of rows) {
      const artifact = resolveRenderArtifactMeta(workspaceId, row);
      if (artifact && artifact.filename === filename) return artifact;
    }
    return null;
  };

  app.get('/api/projects/:id/renders/file/:filename', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const artifact = await lookupRenderByFilename(auth.workspaceId, c.req.param('id'), c.req.param('filename'));
    if (!artifact) return c.req.method === 'HEAD' ? c.body(null, 404) : c.notFound();

    const isDownload = c.req.query('download') === '1' || c.req.query('download') === 'true';

    if (c.req.method === 'HEAD') {
      c.header('Content-Type', artifact.contentType);
      c.header('Content-Length', String(artifact.sizeBytes));
      c.header('Accept-Ranges', 'bytes');
      if (artifact.sha256) c.header('ETag', formatVersionFromSha256(artifact.sha256));
      if (isDownload) {
        c.header('Content-Disposition', buildContentDisposition('attachment', artifact.filename));
      }
      c.header('Cache-Control', PRESIGNED_REDIRECT_HEADERS['Cache-Control']);
      c.header('Vary', PRESIGNED_REDIRECT_HEADERS.Vary);
      return c.body(null, 200);
    }

    const url = await deps.storage.presignGet(artifact.s3Key, {
      expiresInSec: 300,
      responseContentType: artifact.contentType,
      responseContentDisposition: buildContentDisposition(
        isDownload ? 'attachment' : 'inline',
        artifact.filename,
      ),
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        ...PRESIGNED_REDIRECT_HEADERS,
      },
    });
  });

  return app;
}
