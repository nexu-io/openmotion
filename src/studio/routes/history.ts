import { Hono } from 'hono';
import { CloudError } from '../../contracts/errors.ts';
import type { HistoryActorKind } from '../../db/schema/project-files.ts';
import {
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import { formatFileVersion } from '../etag.ts';
import { isSha256Hex, isUuid } from '../../../shared/project-validation.ts';
import type { HistoryStepGuard } from '../../../shared/ordered-text-edits.ts';

function parseActorKind(raw: unknown): HistoryActorKind | undefined {
  if (raw === 'user' || raw === 'person') return 'user';
  if (raw === 'agent') return 'agent';
  if (raw === 'system' || raw === 'outside') return 'system';
  return undefined;
}

export function createStudioHistoryRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // GET /api/projects/:id/history — Unified PG history timeline (diskless, zero local history files).
  app.get('/api/projects/:id/history', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const result = await deps.history.listHistory(auth, projectId, c.req.query('view') === 'navigation' ? {} : undefined);
    return c.json(result);
  });

  // Older Studio clients ask to label a write after it lands. The commit already owns its label.
  app.post('/api/projects/:id/history/claim', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const { currentSeq: seq, canUndo, canRedo } = await deps.history.listHistory(auth, c.req.param('id'));
    return c.json({ claimed: null, seq, canUndo, canRedo });
  });

  // POST /api/projects/:id/history/checkpoint — Create explicit snapshot checkpoint.
  app.post('/api/projects/:id/history/checkpoint', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      label?: string;
      pinned?: boolean;
      actorKind?: string;
      actorName?: string;
    };
    const result = await deps.history.checkpoint(auth, projectId, {
      label: body.label,
      pinned: body.pinned,
      actorKind: parseActorKind(body.actorKind),
      actorName: body.actorName,
      writeToken: c.req.header('x-hyperframes-write-token'),
    });
    return c.json(result);
  });

  // A distinct guarded route also fails closed on older pods which ignore unknown request fields.
  app.on('POST', ['/api/projects/:id/history/step', '/api/projects/:id/history/step-guarded'], async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as ({ direction?: unknown } & Partial<HistoryStepGuard>) | null;
    const rawDir = typeof body?.direction === 'string' ? body.direction.toLowerCase() : undefined;
    const direction =
      rawDir === 'back' || rawDir === 'undo'
        ? 'back'
        : rawDir === 'forward' || rawDir === 'redo'
          ? 'forward'
          : null;
    if (!body || !direction) {
      throw new CloudError('INVALID_ARGUMENT', 'direction must be "back"|"undo" or "forward"|"redo".', {
        status: 400,
        applied: false,
      });
    }
    const { expectedVersionId, expectedRevision, expectedTargetVersionId, expectedTargetRevision } = body;
    let guard: HistoryStepGuard | undefined;
    if (c.req.path.endsWith('/step-guarded') || [expectedVersionId, expectedRevision, expectedTargetVersionId, expectedTargetRevision].some(value => value !== undefined)) {
      if (!isUuid(expectedVersionId) || !isUuid(expectedTargetVersionId) ||
          !isSha256Hex(expectedRevision) || !isSha256Hex(expectedTargetRevision)) {
        throw new CloudError('INVALID_ARGUMENT', 'Supply valid current and target version IDs and revisions for a guarded history step.', { status: 400, applied: false });
      }
      guard = { expectedVersionId, expectedRevision, expectedTargetVersionId, expectedTargetRevision };
    }
    const result = await deps.history.step(auth, projectId, direction, {
      guard,
      writeToken: c.req.header('x-hyperframes-write-token'),
    });
    return c.json(result);
  });

  // POST /api/projects/:id/history/undo — Older clients also use this endpoint for a single project step.
  app.post('/api/projects/:id/history/undo', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { direction?: string };
    const writeToken = c.req.header('x-hyperframes-write-token');

    const dir = body.direction === 'redo' || body.direction === 'forward' ? 'forward' : 'back';
    const result = await deps.history.step(auth, projectId, dir, { writeToken });
    return c.json(result);
  });

  // POST /api/projects/:id/history/restore — Non-destructive restore to point / versionId / seq.
  app.post('/api/projects/:id/history/restore', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      point?: string;
      targetVersionId?: string;
      versionId?: string;
      entryId?: string;
      seq?: number;
      expectedRevision?: string;
      expectedVersionId?: string;
      requestId?: string;
      label?: string;
    };

    const result = await deps.history.restoreVersion(auth, projectId, {
      targetVersionId: body.targetVersionId ?? body.versionId,
      point: body.point ?? body.entryId,
      seq: typeof body.seq === 'number' ? body.seq : undefined,
      expectedRevision: body.expectedRevision,
      expectedVersionId: body.expectedVersionId,
      requestId: body.requestId,
      label: body.label,
      writeToken: c.req.header('x-hyperframes-write-token'),
    });
    return c.json(result);
  });

  // POST /api/projects/:id/history/pin — Pin/unpin a history entry.
  app.post('/api/projects/:id/history/pin', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      entryId?: string;
      id?: string;
      pinned?: boolean;
    };
    const entryId = body.entryId ?? body.id;
    if (!entryId) {
      throw new CloudError('INVALID_ARGUMENT', 'entryId is required.', { status: 400, applied: false });
    }
    const result = await deps.history.pinEntry(auth, projectId, entryId, body.pinned !== false);
    return c.json(result);
  });

  // GET /api/projects/:id/history/peek/:point — Inspect historical point files (and optional ?path=).
  app.get('/api/projects/:id/history/peek/:point', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const point = c.req.param('point');
    const filePath = c.req.query('path') ?? undefined;
    const result = await deps.history.peekPoint(auth, projectId, point, filePath);
    return c.json(result);
  });

  // GET /api/projects/:id/history/peek?seq=N&path=... — Query-param variant for Spike 1 contract.
  app.get('/api/projects/:id/history/peek', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const point = c.req.query('point') ?? c.req.query('seq') ?? 'head';
    const filePath = c.req.query('path') ?? undefined;
    const result = await deps.history.peekPoint(auth, projectId, point, filePath);
    return c.json(result);
  });

  // GET /api/projects/:id/history/blob/:hash — Serve immutable historical CAS blob scoped to this project.
  app.get('/api/projects/:id/history/blob/:hash', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const hash = c.req.param('hash');
    const blob = await deps.history.readHistoryBlob(auth, projectId, hash);
    c.header('Content-Type', blob.mimeType);
    c.header('Content-Length', String(blob.buffer.byteLength));
    c.header('ETag', formatFileVersion(blob.blobScope, blob.sha256));
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(new Uint8Array(blob.buffer), 200);
  });

  // GET /api/projects/:id/history/blob?hash=... — Query-param variant.
  app.get('/api/projects/:id/history/blob', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const hash = c.req.query('hash') ?? '';
    const blob = await deps.history.readHistoryBlob(auth, projectId, hash);
    c.header('Content-Type', blob.mimeType);
    c.header('Content-Length', String(blob.buffer.byteLength));
    c.header('ETag', formatFileVersion(blob.blobScope, blob.sha256));
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(new Uint8Array(blob.buffer), 200);
  });

  // POST /api/projects/:id/history/window — Start an edit coalescing window.
  app.post('/api/projects/:id/history/window', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    return c.json(await deps.history.openWindow(auth, projectId));
  });

  // POST /api/projects/:id/history/window/:windowId/close — Close an edit coalescing window.
  app.post('/api/projects/:id/history/window/:windowId/close', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const windowId = c.req.param('windowId');
    return c.json(await deps.history.closeWindow(auth, projectId, windowId));
  });

  return app;
}
