import { Hono, type Context } from 'hono';
import type { AuthContext, PatScope, WorkspaceRole } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { CatalogPort } from '../services/catalog-service.ts';
import type { ExportService } from '../services/export-service.ts';
import { createOrCloneProject, formatProjectCreationHttpResponse } from '../services/project-creation.ts';
import { DEFAULT_SESSION_TITLE, type WorkspaceService } from '../services/workspace-service.ts';
import { assertAuthAccess } from '../studio/context.ts';
import { artifactViewers, creationModes } from '../../shared/session.ts';
import type { ProductRouteVariables, WorkspaceExportJobSummary } from './projects.ts';

export interface SessionsRouterDeps {
  readonly workspace: WorkspaceService;
  readonly catalog?: Pick<CatalogPort, 'getTemplate' | 'cloneTemplateToProject'>;
  readonly exports?: Pick<ExportService, 'listProjectExports'>;
  readonly resolveAuth?: (c: Context<{ Variables: ProductRouteVariables }>) => AuthContext | Promise<AuthContext>;
}

async function resolveSessionExportJob(
  exportsService: Pick<ExportService, 'listProjectExports'> | undefined,
  auth: AuthContext,
  projectId: string | undefined,
): Promise<WorkspaceExportJobSummary | null> {
  if (!exportsService || !projectId) return null;
  try {
    const list = await exportsService.listProjectExports(auth, projectId, { limit: 5 });
    const active = list.find((job) => job.state === 'queued' || job.state === 'running');
    if (!active) return null;
    return {
      id: active.id,
      state: active.state === 'queued' ? 'pending' : 'running',
      ...(active.errorMessage ? { error: active.errorMessage } : {}),
    };
  } catch {
    return null;
  }
}

const READ_REQ = { scope: 'projects:read' } as const;
const WRITE_REQ = { scope: 'projects:write', minRole: 'editor' } as const;

async function requireAuth(
  c: Context<{ Variables: ProductRouteVariables }>,
  deps: SessionsRouterDeps,
  requirements: { scope: PatScope; minRole?: WorkspaceRole },
): Promise<AuthContext> {
  const auth = deps.resolveAuth ? await deps.resolveAuth(c) : c.get('auth');
  if (!auth) {
    throw new CloudError('UNAUTHORIZED', 'Authentication is required.', { status: 401, applied: false });
  }
  assertAuthAccess(auth, requirements);
  return auth;
}

export function createSessionsRouter(deps: SessionsRouterDeps): Hono<{ Variables: ProductRouteVariables }> {
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

  // GET /motion-api/modes — Supported creation modes & artifact viewers.
  app.get('/motion-api/modes', (c) => {
    return c.json({ modes: creationModes, viewers: artifactViewers });
  });

  // GET /motion-api/sessions — List workspace sessions.
  app.get('/motion-api/sessions', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const catalog = await deps.workspace.getCatalog(auth);
    return c.json({
      activeSessionId: catalog.activeSessionId ?? null,
      sessions: catalog.sessions ?? [],
    });
  });

  // POST /motion-api/sessions — Create a creative session.
  app.post('/motion-api/sessions', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      title?: string;
      mode?: string;
      templateId?: string;
      locale?: string;
      prompt?: string;
      instruction?: string;
    };
    const templateId =
      typeof body.templateId === 'string' && body.templateId.trim() ? body.templateId.trim() : undefined;
    let resolvedTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
    if (!resolvedTitle && templateId && deps.catalog) {
      try {
        const template = await deps.catalog.getTemplate(templateId, { locale: body.locale });
        if (template.title?.trim()) {
          resolvedTitle = template.title.trim();
        }
      } catch (error) {
        if (!isCloudError(error) || error.code !== 'NOT_FOUND') {
          throw error;
        }
      }
    }
    const created = await deps.workspace.createSession(auth, {
      id: body.id,
      title: resolvedTitle,
      mode: body.mode,
      templateId,
      prompt: body.prompt ?? body.instruction,
    });
    return c.json({ sessionId: created.id, session: created, ...created }, 201);
  });

  // GET /motion-api/sessions/:id — Session detail including artifacts and messages.
  app.get('/motion-api/sessions/:id', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    return c.json(await deps.workspace.getSession(auth, c.req.param('id')));
  });

  // PATCH /motion-api/sessions/:id — Rename session.
  app.patch('/motion-api/sessions/:id', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    const renamed = await deps.workspace.renameSession(auth, c.req.param('id'), body.title ?? '');
    const catalog = await deps.workspace.getCatalog(auth);
    return c.json({ ...renamed, ...catalog });
  });

  // POST /motion-api/sessions/:id/open — Activate session and its active artifact.
  app.post('/motion-api/sessions/:id/open', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as { projectId?: string };
    const opened = await deps.workspace.openSession(auth, c.req.param('id'), body.projectId);
    const activeArtifact =
      (body.projectId ? opened.artifacts.find((item) => item.projectId === body.projectId) : undefined) ??
      opened.artifacts.find((item) => item.id === opened.activeArtifactId) ??
      opened.artifacts[0];
    const project = activeArtifact
      ? await deps.workspace.getProject(auth, activeArtifact.projectId, { allowTrashed: true })
      : null;
    const exportJob = await resolveSessionExportJob(deps.exports, auth, project?.id);
    return c.json({
      ok: true,
      session: opened,
      sessionId: opened.id,
      projectId: project?.id ?? '',
      projectTitle: project?.title ?? '',
      revision: project?.revision ?? '',
      exportJob,
    });
  });

  // GET /motion-api/sessions/:id/messages — List session messages.
  app.get('/motion-api/sessions/:id/messages', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const detail = await deps.workspace.getSession(auth, c.req.param('id'));
    return c.json({ sessionId: detail.id, messages: detail.messages });
  });

  // POST /motion-api/sessions/:id/messages — Append a session message (idempotent on caller UUID `id`).
  app.post('/motion-api/sessions/:id/messages', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const sessionId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      role?: 'user' | 'assistant';
      content?: string;
    };
    const appended = await deps.workspace.appendMessage(auth, sessionId, {
      id: body.id,
      role: body.role,
      content: body.content ?? '',
    });
    const detail = await deps.workspace.getSession(auth, sessionId);
    return c.json({ ...detail, ...appended }, appended.replayed ? 200 : 201);
  });

  // POST /motion-api/sessions/:id/artifacts — Create a new motion project artifact inside an existing session.
  app.post('/motion-api/sessions/:id/artifacts', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const sessionId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      templateId?: string;
      locale?: string;
      requirements?: string;
      namingLanguage?: string;
      requestId?: string;
      prompt?: string;
      instruction?: string;
      selectActive?: boolean;
    };
    const session = await deps.workspace.getSession(auth, sessionId);
    const requestedTemplateId =
      typeof body.templateId === 'string' && body.templateId.trim() ? body.templateId.trim() : undefined;
    const inheritedTemplateId =
      !requestedTemplateId && session.artifacts.length === 0 && session.templateId ? session.templateId : undefined;
    const effectiveTemplateId = requestedTemplateId ?? inheritedTemplateId;
    const explicitTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
    const sessionFallbackTitle =
      session.artifacts.length === 0 && session.title && session.title !== DEFAULT_SESSION_TITLE
        ? session.title
        : undefined;
    const title = explicitTitle ?? sessionFallbackTitle;

    const result = await createOrCloneProject(
      { workspace: deps.workspace, catalog: deps.catalog },
      auth,
      {
        sessionId,
        title,
        templateId: effectiveTemplateId,
        templateInherited: Boolean(inheritedTemplateId),
        locale: body.locale,
        requirements: body.requirements,
        namingLanguage: body.namingLanguage,
        requestId: body.requestId,
        initialPrompt: body.prompt ?? body.instruction,
        selectActive: body.selectActive,
      },
    );
    const formatted = formatProjectCreationHttpResponse(result);
    return c.json(formatted.body, formatted.status);
  });

  return app;
}
