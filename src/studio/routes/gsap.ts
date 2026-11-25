import { Hono, type Context } from 'hono';
import { CloudError, isCloudError } from '../../contracts/errors.ts';
import { normalizeSafeProjectPath } from '../../services/project-files-service.ts';
import {
  extractWildcardPath,
  getAuthContext,
  getSemanticEditAuth,
  studioWriteHistory,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import {
  applyGsapMutationsInMemory,
  parseGsapAnimationsFromHtml,
  type GsapMutationBody,
} from '../engine/gsap-mutations.ts';
import { createWriteToken, formatFileVersion, formatVersionFromSha256, sha256Hex } from '../etag.ts';

function resolveGsapFilePath(url: string, markers: readonly string[]): string {
  for (const marker of markers) {
    const raw = extractWildcardPath(url, marker);
    if (raw) return normalizeSafeProjectPath(raw, true);
  }
  return 'index.html';
}

export function createStudioGsapRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // GET /api/projects/:id/gsap-mutation-capabilities — Advertise atomic ownership pair support.
  app.get('/api/projects/:id/gsap-mutation-capabilities', async (c) => {
    await getAuthContext(c, deps, { scope: 'projects:read' });
    return c.json({ atomicOwnershipPairs: true });
  });

  // GET /api/projects/:id/gsap-animations/* — Parse GSAP timeline script with strong ETag caching.
  const handleGetGsapAnimations = async (c: Context<{ Variables: StudioVariables }>) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id') ?? '';
    const filePath = resolveGsapFilePath(c.req.url, ['/gsap-animations/']);
    const file = await deps.files.getFile(auth, projectId, filePath);
    if (!file) {
      return c.json({ error: 'Composition file not found', path: filePath }, 404);
    }

    const version = formatFileVersion(file.blobScope, file.sha256);
    if (!file.isText) {
      throw new CloudError('INVALID_ARGUMENT', `File "${file.path}" is binary and cannot be read as text.`, {
        status: 415, applied: false, details: { why: 'binary', path: file.path, version },
      });
    }
    const etag = `${version.slice(0, -1)}:gsap-animations:v1"`;
    c.header('ETag', etag);
    if (c.req.header('if-none-match')?.trim() === etag) {
      return c.body(null, 304);
    }

    const content = await deps.files.readTextBlob(auth.workspaceId, file.blobScope, file.sha256);
    const parsed = parseGsapAnimationsFromHtml(content);
    c.header('Cache-Control', 'no-cache');
    return c.json({
      ...parsed,
      path: filePath,
      version,
    });
  };
  app.get('/api/projects/:id/gsap-animations', handleGetGsapAnimations);
  app.get('/api/projects/:id/gsap-animations/*', handleGetGsapAnimations);

  // Shared handler for single & batch GSAP AST mutations.
  const handleMutate = async (
    c: Context<{ Variables: StudioVariables }>,
    isBatch: boolean,
  ) => {
    const auth = await getSemanticEditAuth(c, deps);
    const projectId = c.req.param('id') ?? '';
    const filePath = resolveGsapFilePath(c.req.url, [
      '/gsap-mutations-batch/',
      '/gsap-mutation-batch/',
      '/gsap-mutations/',
      '/gsap-mutation/',
    ]);

    const body = (await c.req.json().catch(() => null)) as
      | (GsapMutationBody & { mutations?: GsapMutationBody[] })
      | null;
    if (!body || typeof body !== 'object') {
      throw new CloudError('INVALID_ARGUMENT', 'GSAP mutation body must be a JSON object.', {
        status: 400,
        applied: false,
      });
    }

    const mutations: GsapMutationBody[] = isBatch
      ? Array.isArray(body.mutations)
        ? body.mutations
        : []
      : Array.isArray(body.mutations)
        ? body.mutations
        : [body];

    if (mutations.length === 0) {
      throw new CloudError('INVALID_ARGUMENT', 'At least one GSAP mutation is required.', {
        status: 400,
        applied: false,
      });
    }

    const current = await deps.files.readTextFile(auth, projectId, filePath);
    if (!current) {
      return c.json({ error: 'Composition file not found', path: filePath }, 404);
    }

    const res = applyGsapMutationsInMemory(current.content, mutations);
    if (res.ok === false) {
      return c.json({ ok: false, error: res.error }, res.status as 400);
    }

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = current.version;

    if (res.mutated) {
      const ifMatch = c.req.header('if-match') ?? current.version;
      try {
        const committed = await deps.files.commitChanges(auth, {
          projectId,
          ops: [{ op: 'upsert_text', path: filePath, content: res.after, stampHfIds: true }],
          filePreconditions: [{ path: filePath, ifMatch }],
          source: 'studio',
          ...studioWriteHistory(c.req.raw.headers, `Updated GSAP timeline in ${filePath}`),
          writeToken,
        });
        version = committed.versionsByPath[filePath] ?? formatVersionFromSha256(sha256Hex(res.after));
      } catch (error) {
        if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
          return c.json({ error: 'file conflict', code: 'VERSION_MISMATCH', path: filePath }, 409);
        }
        throw error;
      }
    }

    c.header('ETag', version);
    return c.json({
      ok: true,
      changed: res.changed,
      mutated: res.mutated,
      mutationChanges: res.mutationChanges,
      skippedSelectors: res.skippedSelectors,
      parsed: res.parsed,
      before: res.before,
      after: res.after,
      scriptText: res.scriptText,
      path: filePath,
      version,
      writeToken,
      backupPath: null,
    });
  };

  app.post('/api/projects/:id/gsap-mutations', (c) => handleMutate(c, false));
  app.post('/api/projects/:id/gsap-mutations/*', (c) => handleMutate(c, false));
  app.post('/api/projects/:id/gsap-mutation', (c) => handleMutate(c, false));
  app.post('/api/projects/:id/gsap-mutation/*', (c) => handleMutate(c, false));
  app.post('/api/projects/:id/gsap-mutations-batch', (c) => handleMutate(c, true));
  app.post('/api/projects/:id/gsap-mutations-batch/*', (c) => handleMutate(c, true));
  app.post('/api/projects/:id/gsap-mutation-batch', (c) => handleMutate(c, true));
  app.post('/api/projects/:id/gsap-mutation-batch/*', (c) => handleMutate(c, true));

  // POST /api/projects/:id/gsap-mutation-rollback/* — Compare-and-swap rollback (`expected` -> `restore`).
  const handleRollback = async (c: Context<{ Variables: StudioVariables }>) => {
    const auth = await getSemanticEditAuth(c, deps);
    const projectId = c.req.param('id') ?? '';
    const filePath = resolveGsapFilePath(c.req.url, ['/gsap-mutation-rollback/']);
    const body = (await c.req.json().catch(() => null)) as {
      expected?: unknown;
      restore?: unknown;
    } | null;

    if (!body || typeof body.expected !== 'string' || typeof body.restore !== 'string') {
      throw new CloudError('INVALID_ARGUMENT', 'Rollback requires string fields "expected" and "restore".', {
        status: 400,
        applied: false,
      });
    }

    let expectedEtag = formatVersionFromSha256(sha256Hex(body.expected));
    const observed = await deps.files.getFile(auth, projectId, filePath);
    if (observed?.blobScope === 'patch') {
      const text = await deps.files.readTextBlob(auth.workspaceId, observed.blobScope, observed.sha256);
      if (text !== body.expected) return c.json({ error: 'The file changed before rollback.' }, 409);
      expectedEtag = formatFileVersion(observed.blobScope, observed.sha256);
    }
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));

    try {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [{ op: 'upsert_text', path: filePath, content: body.restore }],
        filePreconditions: [{ path: filePath, ifMatch: expectedEtag }],
        source: 'studio',
        ...studioWriteHistory(c.req.raw.headers, `Rolled back GSAP edit in ${filePath}`),
        writeToken,
      });
      const version = committed.versionsByPath[filePath] ?? formatVersionFromSha256(sha256Hex(body.restore));
      c.header('ETag', version);
      return c.json({
        ok: true,
        restored: true,
        conflict: false,
        path: filePath,
        version,
        writeToken,
      });
    } catch (error) {
      if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
        return c.json({ ok: true, restored: false, conflict: true, path: filePath });
      }
      throw error;
    }
  };

  app.post('/api/projects/:id/gsap-mutation-rollback', handleRollback);
  app.post('/api/projects/:id/gsap-mutation-rollback/*', handleRollback);

  return app;
}
