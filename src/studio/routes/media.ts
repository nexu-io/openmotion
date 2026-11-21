import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { CloudError, featureDeferredP2 } from '../../contracts/errors.ts';
import type { JobProgressEvent } from '../../contracts/events.ts';
import type { VideoSpriteManifest } from '../../contracts/storage.ts';
import { asInsert, asUpdate } from '../../db/helpers.ts';
import { jobs } from '../../db/schema/jobs.ts';
import {
  buildImageThumbnailJobId,
  buildMediaProbeJobId,
  buildVideoSpriteJobId,
  buildWaveformPeaksJobId,
} from '../../infra/queues.ts';
import { jobChannel } from '../../infra/redis.ts';
import {
  assertTenantScopedKey,
  compThumbnailKey,
  derivedAssetKey,
  thumbnailKey,
  workspaceBlobKey,
} from '../../infra/storage.ts';
import { isUuid } from '../../../shared/project-validation.ts';
import {
  extractWildcardPath,
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import { PRESIGNED_REDIRECT_HEADERS, formatVersionFromSha256 } from '../etag.ts';
import { loadProjectOrThrow, normalizeSafeProjectPath } from '../../services/project-files-service.ts';

function isProbeableMediaAsset(mimeType: string | null | undefined, filePath: string): boolean {
  const mime = (mimeType ?? '').trim().toLowerCase().split(';')[0] ?? '';
  if (mime === 'image/svg+xml' || filePath.toLowerCase().endsWith('.svg')) {
    return false;
  }
  return mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('image/');
}

function buildCompThumbCacheKey(
  revision: string,
  compositionPath: string,
  timeSec: number,
  width: number,
  height: number,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ revision, compositionPath, timeSec, width, height }))
    .digest('hex')
    .slice(0, 32);
}

function parseNonNegNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseIntRange(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function createStudioMediaRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // GET /api/projects/:id/media/metadata?path=... — Serve cached ffprobe/Sharp metadata from PG (zero ffprobe on web pod).
  app.get('/api/projects/:id/media/metadata', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const rawPath = c.req.query('path') ?? '';
    if (!rawPath) {
      throw new CloudError('INVALID_ARGUMENT', 'Query parameter "path" is required.', {
        status: 400,
        applied: false,
      });
    }
    const safePath = normalizeSafeProjectPath(rawPath);
    const file = await deps.files.getFile(auth, projectId, safePath);
    if (!file) {
      return c.json({ error: 'Media file not found', path: safePath }, 404);
    }

    if (file.metadata) {
      return c.json({
        path: file.path,
        sha256: file.sha256,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        pending: false,
        metadata: file.metadata,
        width: file.metadata.width ?? null,
        height: file.metadata.height ?? null,
        duration: file.metadata.durationSec ?? null,
        durationSec: file.metadata.durationSec ?? null,
        fps: file.metadata.fps ?? null,
        codec: file.metadata.codec ?? null,
        hasAudio: file.metadata.hasAudio ?? null,
        hasVideo: file.metadata.hasVideo ?? null,
      });
    }

    if (!isProbeableMediaAsset(file.mimeType, file.path)) {
      return c.json({
        path: file.path,
        sha256: file.sha256,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        pending: false,
        metadata: null,
        width: null,
        height: null,
        duration: null,
        durationSec: null,
        fps: null,
        codec: null,
        hasAudio: null,
        hasVideo: null,
      });
    }

    if (deps.queues) {
      const s3Key =
        file.blobScope === 'workspace'
          ? workspaceBlobKey(auth.workspaceId, file.sha256)
          : `catalog/blobs/${file.sha256}`;
      void deps.queues
        .enqueueMediaIngest(
          'media_probe',
          {
            workspaceId: auth.workspaceId,
            blobScope: file.blobScope,
            sha256: file.sha256,
            s3Key,
            projectId,
          },
          { jobId: buildMediaProbeJobId(auth.workspaceId, file.sha256) },
        )
        .catch(() => {});
    }

    return c.json(
      {
        path: file.path,
        sha256: file.sha256,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        pending: true,
        metadata: null,
      },
      202,
    );
  });

  // GET /api/projects/:id/waveform/* and /peaks/* — Serve cached waveform peaks JSON from S3 or enqueue job.
  const handleWaveformPeaks = async (c: Context<{ Variables: StudioVariables }>, marker: string) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id') ?? '';
    const rawPath = extractWildcardPath(c.req.url, marker);
    const safePath = normalizeSafeProjectPath(rawPath);
    const file = await deps.files.getFile(auth, projectId, safePath);
    if (!file) return c.json({ error: 'Media file not found', path: safePath }, 404);

    if (file.metadata?.hasAudio === false) {
      const durationSec = typeof file.metadata.durationSec === 'number' ? file.metadata.durationSec : 0;
      c.header('Cache-Control', 'private, max-age=3600');
      c.header('ETag', formatVersionFromSha256(file.sha256));
      return c.json(
        {
          peaks: [],
          bins: [],
          binSeconds: 0,
          samples: 0,
          sampleRate: 8000,
          duration: durationSec,
          hasAudio: false,
        },
        200,
      );
    }

    const samples = parseIntRange(c.req.query('samples'), 16, 16384, 2048);
    const derivedKey = assertTenantScopedKey(
      auth.workspaceId,
      file.metadata?.waveformPeaksKey || derivedAssetKey(auth.workspaceId, file.sha256, 'waveform-peaks.json'),
    );
    const cached = await deps.storage.headObject(derivedKey);
    if (cached) {
      const buf = await deps.storage.getObjectBuffer(derivedKey);
      c.header('Content-Type', 'application/json; charset=utf-8');
      c.header('Cache-Control', 'private, max-age=3600');
      c.header('ETag', formatVersionFromSha256(file.sha256));
      return c.body(buf.toString('utf8'), 200);
    }

    if (deps.queues) {
      void deps.queues
        .enqueueMediaIngest(
          'extract_waveform_peaks',
          {
            workspaceId: auth.workspaceId,
            blobScope: file.blobScope,
            sha256: file.sha256,
            projectId,
            samples,
          },
          { jobId: buildWaveformPeaksJobId(auth.workspaceId, file.sha256) },
        )
        .catch(() => {});
    }

    return c.json({ pending: true, path: safePath, sha256: file.sha256 }, 202);
  };

  app.get('/api/projects/:id/waveform/*', (c) => handleWaveformPeaks(c, '/waveform/'));
  app.get('/api/projects/:id/peaks/*', (c) => handleWaveformPeaks(c, '/peaks/'));

  // GET /api/projects/:id/sprite/* — Serve cached multi-frame video sprite manifest JSON or enqueue generate_video_sprite.
  app.get('/api/projects/:id/sprite/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id') ?? '';
    const rawPath = extractWildcardPath(c.req.url, '/sprite/');
    const safePath = normalizeSafeProjectPath(rawPath);
    const file = await deps.files.getFile(auth, projectId, safePath);
    if (!file) return c.json({ error: 'Media file not found', path: safePath }, 404);

    if (file.metadata?.sprite?.status === 'failed') {
      return c.json({ unavailable: true, path: safePath, sha256: file.sha256 }, 404);
    }

    const manifestKey = assertTenantScopedKey(
      auth.workspaceId,
      file.metadata?.sprite?.manifestKey || derivedAssetKey(auth.workspaceId, file.sha256, 'sprite-manifest.json'),
    );
    const cached = await deps.storage.headObject(manifestKey);
    if (cached) {
      const buf = await deps.storage.getObjectBuffer(manifestKey);
      const manifest = JSON.parse(buf.toString('utf8')) as VideoSpriteManifest;
      const encodedAssetPath = safePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const hydratedManifest = {
        ...manifest,
        pending: false,
        path: safePath,
        sha256: file.sha256,
        sheets: (manifest.sheets ?? []).map((sheet) => ({
          ...sheet,
          url: `/api/projects/${encodeURIComponent(projectId)}/sprite-sheet/${sheet.index}/${encodedAssetPath}`,
        })),
      };
      c.header('Cache-Control', 'private, max-age=3600');
      c.header('ETag', formatVersionFromSha256(file.sha256));
      return c.json(hydratedManifest, 200);
    }

    if (deps.queues) {
      void deps.queues
        .enqueueMediaIngest(
          'generate_video_sprite',
          {
            workspaceId: auth.workspaceId,
            blobScope: file.blobScope,
            sha256: file.sha256,
            projectId,
            ...(typeof file.metadata?.durationSec === 'number' ? { durationSec: file.metadata.durationSec } : {}),
            ...(typeof file.metadata?.width === 'number' ? { width: file.metadata.width } : {}),
            ...(typeof file.metadata?.height === 'number' ? { height: file.metadata.height } : {}),
          },
          { jobId: buildVideoSpriteJobId(auth.workspaceId, file.sha256) },
        )
        .catch(() => {});
    }

    return c.json({ pending: true, path: safePath, sha256: file.sha256 }, 202);
  });

  // GET & HEAD /api/projects/:id/sprite-sheet/:sheetIndex/* — Serve WebP sprite sheet image via 302 presigned S3 URL.
  app.get('/api/projects/:id/sprite-sheet/:sheetIndex/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id') ?? '';
    const sheetIndexRaw = c.req.param('sheetIndex') ?? '';
    if (!/^\d{1,2}$/.test(sheetIndexRaw)) {
      return c.req.method === 'HEAD' ? c.body(null, 400) : c.json({ error: 'Invalid sprite sheet index' }, 400);
    }
    const sheetIndex = Number.parseInt(sheetIndexRaw, 10);
    if (!Number.isInteger(sheetIndex) || sheetIndex < 0 || sheetIndex > 15) {
      return c.req.method === 'HEAD' ? c.body(null, 400) : c.json({ error: 'Sprite sheet index out of range' }, 400);
    }

    const marker = `/sprite-sheet/${sheetIndexRaw}/`;
    const rawPath = extractWildcardPath(c.req.url, marker);
    const safePath = normalizeSafeProjectPath(rawPath);
    const file = await deps.files.getFile(auth, projectId, safePath);
    if (!file) {
      return c.req.method === 'HEAD' ? c.body(null, 404) : c.json({ error: 'Media file not found', path: safePath }, 404);
    }

    const sheetKey = assertTenantScopedKey(
      auth.workspaceId,
      derivedAssetKey(auth.workspaceId, file.sha256, `sprite-${sheetIndex}.webp`),
    );
    const head = await deps.storage.headObject(sheetKey);
    if (!head) {
      return c.req.method === 'HEAD' ? c.body(null, 404) : c.json({ error: 'Sprite sheet not found', path: safePath }, 404);
    }

    if (c.req.method === 'HEAD') {
      c.header('Content-Type', head.contentType ?? 'image/webp');
      c.header('Content-Length', String(head.contentLength));
      c.header('Accept-Ranges', 'bytes');
      c.header('Cache-Control', PRESIGNED_REDIRECT_HEADERS['Cache-Control']);
      c.header('Vary', PRESIGNED_REDIRECT_HEADERS.Vary);
      return c.body(null, 200);
    }

    const url = await deps.storage.presignGet(sheetKey, {
      expiresInSec: 300,
      responseContentType: 'image/webp',
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        ...PRESIGNED_REDIRECT_HEADERS,
      },
    });
  });

  // GET & HEAD /api/projects/:id/image-thumbnail/* — Direct 200 on HEAD; 302 presigned GET on hit or enqueue media_ingest.
  app.get('/api/projects/:id/image-thumbnail/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const rawPath = extractWildcardPath(c.req.url, '/image-thumbnail/');
    const safePath = normalizeSafeProjectPath(rawPath);
    const file = await deps.files.getFile(auth, projectId, safePath);
    if (!file) {
      return c.req.method === 'HEAD'
        ? c.body(null, 404)
        : c.json({ error: 'Image file not found', path: safePath }, 404);
    }

    const width = parseIntRange(c.req.query('w') ?? c.req.query('width'), 16, 2048, 320);
    const spec = `w${width}`;
    const thumbKey = assertTenantScopedKey(auth.workspaceId, thumbnailKey(auth.workspaceId, file.sha256, spec));
    const head = await deps.storage.headObject(thumbKey);
    if (head) {
      if (c.req.method === 'HEAD') {
        c.header('Content-Type', head.contentType ?? 'image/jpeg');
        c.header('Content-Length', String(head.contentLength));
        c.header('Accept-Ranges', 'bytes');
        c.header('Cache-Control', PRESIGNED_REDIRECT_HEADERS['Cache-Control']);
        c.header('Vary', PRESIGNED_REDIRECT_HEADERS.Vary);
        return c.body(null, 200);
      }
      const url = await deps.storage.presignGet(thumbKey, {
        expiresInSec: 300,
        responseContentType: 'image/jpeg',
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: url,
          ...PRESIGNED_REDIRECT_HEADERS,
        },
      });
    }

    if (c.req.query('cached') === '1') {
      return c.body(null, 204);
    }
    if (c.req.method === 'HEAD') {
      return c.body(null, 404);
    }

    if (deps.queues) {
      void deps.queues
        .enqueueMediaIngest(
          'image_thumbnail',
          {
            workspaceId: auth.workspaceId,
            blobScope: file.blobScope,
            sha256: file.sha256,
            projectId,
            spec,
            width,
          },
          { jobId: buildImageThumbnailJobId(auth.workspaceId, file.sha256, spec) },
        )
        .catch(() => {});
    }

    return c.json({ pending: true, path: safePath, spec }, 202);
  });

  // GET & HEAD /api/projects/:id/thumbnail and /thumbnail/* — Direct 200 on HEAD; 302 on GET hit, 204 on ?cached=1 miss.
  const handleCompositionThumbnail = async (c: Context<{ Variables: StudioVariables }>) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id') ?? '';
    const project = await loadProjectOrThrow(deps.db, auth.workspaceId, projectId, { allowTrashed: true });

    const rawComp = extractWildcardPath(c.req.url, '/thumbnail/');
    const compPath = rawComp ? normalizeSafeProjectPath(rawComp) : 'index.html';
    const timeSec = parseNonNegNumber(c.req.query('t') ?? c.req.query('time'), 0);
    const width = parseIntRange(c.req.query('w') ?? c.req.query('width'), 32, 1920, 320);
    const height = parseIntRange(c.req.query('h') ?? c.req.query('height'), 32, 1080, 180);
    const revision = project.revision.trim();

    const cacheKey = buildCompThumbCacheKey(revision, compPath, timeSec, width, height);
    const s3Key = assertTenantScopedKey(
      auth.workspaceId,
      compThumbnailKey(auth.workspaceId, project.id, cacheKey),
    );

    const head = await deps.storage.headObject(s3Key);
    if (head) {
      if (c.req.method === 'HEAD') {
        c.header('Content-Type', head.contentType ?? 'image/png');
        c.header('Content-Length', String(head.contentLength));
        c.header('Accept-Ranges', 'bytes');
        c.header('Cache-Control', PRESIGNED_REDIRECT_HEADERS['Cache-Control']);
        c.header('Vary', PRESIGNED_REDIRECT_HEADERS.Vary);
        return c.body(null, 200);
      }
      const url = await deps.storage.presignGet(s3Key, {
        expiresInSec: 300,
        responseContentType: 'image/png',
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: url,
          ...PRESIGNED_REDIRECT_HEADERS,
        },
      });
    }

    if (c.req.query('cached') === '1') {
      return c.body(null, 204);
    }
    if (c.req.method === 'HEAD') {
      return c.body(null, 404);
    }

    if (deps.queues) {
      await deps.queues.enqueueRenderExport('render_thumbnail', {
        workspaceId: auth.workspaceId,
        projectId: project.id,
        versionId: project.currentVersionId ?? undefined,
        revision,
        compositionPath: compPath,
        cacheKey,
        timeSec,
        width,
        height,
      });
    }

    return c.json({ pending: true, cacheKey, compositionPath: compPath }, 202);
  };

  app.get('/api/projects/:id/thumbnail', handleCompositionThumbnail);
  app.get('/api/projects/:id/thumbnail/*', handleCompositionThumbnail);

  // POST /api/projects/:id/loudness/normalize — Enqueue loudness normalization job on worker-media.
  app.post('/api/projects/:id/loudness/normalize', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      sourcePath?: string;
      path?: string;
      targetPath?: string;
      targetLufs?: number;
    } | null;

    const sourcePath = body?.sourcePath ?? body?.path;
    if (!sourcePath) {
      throw new CloudError('INVALID_ARGUMENT', 'sourcePath is required for loudness normalization.', {
        status: 400,
        applied: false,
      });
    }
    const file = await deps.files.getFile(auth, projectId, sourcePath);
    if (!file) return c.json({ error: 'Audio source file not found', path: sourcePath }, 404);

    const targetPath = normalizeSafeProjectPath(
      body?.targetPath || `assets/normalized-${randomUUID().slice(0, 8)}.wav`,
      true,
    );
    const targetLufs =
      typeof body?.targetLufs === 'number' && body.targetLufs >= -36 && body.targetLufs <= -5
        ? body.targetLufs
        : -16;

    const jobId = randomUUID();
    const now = new Date();
    await deps.db.insert(jobs).values(
      asInsert(jobs, {
        id: jobId,
        workspaceId: auth.workspaceId,
        projectId,
        kind: 'media_ingest',
        state: 'queued',
        stage: 'loudness_normalize',
        progress: 0,
        inputPayload: { sourcePath: file.path, sha256: file.sha256, targetPath, targetLufs },
        createdAt: now,
        updatedAt: now,
      }),
    );

    if (deps.queues) {
      try {
        await deps.queues.enqueueMediaIngest('loudness_normalize', {
          jobId,
          workspaceId: auth.workspaceId,
          projectId,
          blobScope: file.blobScope,
          sha256: file.sha256,
          targetPath,
          targetLufs,
        });
      } catch (err) {
        const failNow = new Date();
        await deps.db
          .update(jobs)
          .set(
            asUpdate(jobs, {
              state: 'failed',
              errorCode: 'QUEUE_ENQUEUE_FAILED',
              errorMessage: err instanceof Error ? err.message : 'Failed to enqueue loudness_normalize job',
              terminalAt: failNow,
              updatedAt: failNow,
            }),
          )
          .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)));
        throw err;
      }
    }

    return c.json({ ok: true, jobId, status: 'queued', targetPath, targetLufs }, 202);
  });

  // POST /api/projects/:id/media/remove-background — Explicitly deferred to P2 (501 FEATURE_DEFERRED_P2).
  app.post('/api/projects/:id/media/remove-background', async (c) => {
    await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    throw featureDeferredP2('remove_background');
  });

  // GET /api/media-jobs/:jobId/progress — SSE progress for async media-ingest jobs.
  app.get('/api/media-jobs/:jobId/progress', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const jobId = c.req.param('jobId');
    if (!isUuid(jobId)) return c.notFound();

    const rows = await deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)));
    const job = rows[0];
    if (!job) return c.notFound();

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({
          jobId: job.id,
          state: job.state,
          stage: job.stage,
          progress: Number(job.progress ?? 0),
          result: job.resultJson ?? null,
          error: job.errorMessage ?? null,
        }),
      });

      if (
        job.state === 'completed' ||
        job.state === 'failed' ||
        job.state === 'cancelled' ||
        !deps.eventBus
      ) {
        return;
      }

      let done = false;
      let resolveDone: (() => void) | null = null;
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      const unsubscribe = await deps.eventBus.subscribe(jobChannel(jobId), (payload) => {
        if (done || stream.aborted) return;
        const evt = payload as Partial<JobProgressEvent>;
        if (evt.workspaceId && evt.workspaceId !== auth.workspaceId) return;
        void stream
          .writeSSE({
            event: 'progress',
            data: JSON.stringify({
              jobId,
              state: evt.state ?? 'running',
              stage: evt.stage ?? null,
              progress: evt.progress ?? 0,
              result: evt.resultJson ?? null,
              error: evt.errorMessage ?? null,
            }),
          })
          .catch(() => {});
        if (evt.state === 'completed' || evt.state === 'failed' || evt.state === 'cancelled') {
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

  return app;
}
