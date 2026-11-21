import { Hono, type Context } from 'hono';
import type { AuthContext, PatScope, WorkspaceRole } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { ProjectType } from '../db/schema/projects.ts';
import type { AssetNamesService } from '../services/asset-names-service.ts';
import type { CatalogPort } from '../services/catalog-service.ts';
import type { ExportService } from '../services/export-service.ts';
import type { ProjectArchiveService } from '../services/project-archive-service.ts';
import { createOrCloneProject, formatProjectCreationHttpResponse } from '../services/project-creation.ts';
import type { ProjectFilesService } from '../services/project-files-service.ts';
import type { VersionHistoryService } from '../services/version-history-service.ts';
import type { WorkRoundsService } from '../services/work-rounds-service.ts';
import type { WorkspaceService } from '../services/workspace-service.ts';
import { assertAuthAccess } from '../studio/context.ts';
import { infoInMemory } from '../studio/engine/inspect.ts';

export interface ProductRouteVariables {
  auth: AuthContext;
}

export interface WorkspaceExportJobSummary {
  id: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
}

export interface ProjectsRouterDeps {
  readonly workspace: WorkspaceService;
  readonly files: ProjectFilesService;
  readonly history: VersionHistoryService;
  readonly assetNames: AssetNamesService;
  readonly workRounds: WorkRoundsService;
  readonly archives?: ProjectArchiveService;
  readonly catalog?: Pick<CatalogPort, 'cloneTemplateToProject'>;
  readonly exports?: Pick<ExportService, 'listProjectExports'>;
  readonly resolveAuth?: (c: Context<{ Variables: ProductRouteVariables }>) => AuthContext | Promise<AuthContext>;
}

async function resolveActiveExportJob(
  exportsService: Pick<ExportService, 'listProjectExports'> | undefined,
  auth: AuthContext,
  projectId: string,
): Promise<WorkspaceExportJobSummary | null> {
  if (!exportsService) return null;
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

async function requireAuth(
  c: Context<{ Variables: ProductRouteVariables }>,
  deps: { resolveAuth?: ProjectsRouterDeps['resolveAuth'] },
  requirements: { scope: PatScope; minRole?: WorkspaceRole },
): Promise<AuthContext> {
  const auth = deps.resolveAuth ? await deps.resolveAuth(c) : c.get('auth');
  if (!auth) {
    throw new CloudError('UNAUTHORIZED', 'Authentication is required.', { status: 401, applied: false });
  }
  assertAuthAccess(auth, requirements);
  return auth;
}

function handleError(c: Context, error: unknown): Response {
  if (isCloudError(error)) {
    return c.json(error.toJSON(), error.status as 400);
  }
  return c.json(
    { code: 'INTERNAL_ERROR', error: error instanceof Error ? error.message : 'Internal server error' },
    500,
  );
}

const READ_REQ = { scope: 'projects:read' } as const;
const WRITE_REQ = { scope: 'projects:write', minRole: 'editor' } as const;

export function createProjectsRouter(deps: ProjectsRouterDeps): Hono<{ Variables: ProductRouteVariables }> {
  const app = new Hono<{ Variables: ProductRouteVariables }>();
  app.onError((err, c) => handleError(c, err));

  // GET /motion-api/projects — List workspace projects & sessions.
  app.get('/motion-api/projects', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    return c.json(await deps.workspace.getCatalog(auth));
  });

  // POST /motion-api/projects — Create a new project in the workspace.
  app.post('/motion-api/projects', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      templateId?: string;
      locale?: string;
      projectType?: ProjectType;
      requirements?: string;
      namingLanguage?: string;
      sessionId?: string;
      requestId?: string;
      prompt?: string;
      instruction?: string;
      selectActive?: boolean;
    };

    const result = await createOrCloneProject(
      { workspace: deps.workspace, catalog: deps.catalog },
      auth,
      {
        title: body.title,
        templateId: body.templateId,
        locale: body.locale,
        projectType: body.projectType,
        requirements: body.requirements,
        namingLanguage: body.namingLanguage,
        sessionId: body.sessionId,
        requestId: body.requestId,
        initialPrompt: body.prompt ?? body.instruction,
        selectActive: body.selectActive,
      },
    );
    const formatted = formatProjectCreationHttpResponse(result);
    return c.json(formatted.body, formatted.status);
  });

  // POST /motion-api/preview/open — Verify target project before mounting Studio ArtifactViewer.
  app.post('/motion-api/preview/open', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const body = (await c.req.json().catch(() => ({}))) as { projectId?: string };
    let targetId = c.req.query('projectId') || body.projectId || '';
    if (!targetId) {
      const catalog = await deps.workspace.getCatalog(auth);
      targetId = catalog.activeId;
    }
    if (!targetId) {
      throw new CloudError('PROJECT_NOT_FOUND', 'No active project available to preview.', {
        status: 404,
        applied: false,
      });
    }
    const project = await deps.workspace.getProject(auth, targetId, { allowTrashed: false });
    const exportJob = await resolveActiveExportJob(deps.exports, auth, project.id);
    return c.json({
      ok: true,
      activeId: project.id,
      projectId: project.id,
      projectTitle: project.title,
      revision: project.revision,
      sessionId: project.sessionId,
      exportJob,
    });
  });

  // GET /motion-api/project & /motion-api/project/status — Active project status summary.
  const handleActiveProject = async (c: Context<{ Variables: ProductRouteVariables }>) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const catalog = await deps.workspace.getCatalog(auth);
    const requestedId = c.req.query('projectId') || catalog.activeId;
    if (!requestedId) {
      return c.json({
        activeId: '',
        projectId: '',
        projectTitle: '',
        revision: '',
        exportJob: null,
        project: null,
        projects: catalog.projects,
      });
    }
    const project = await deps.workspace.getProject(auth, requestedId, { allowTrashed: true });
    const virtual = await deps.files.loadVirtualProject(auth, requestedId);
    const assetNameInfo = await deps.assetNames.readAssetNames(auth, requestedId, {
      paths: virtual.listFiles().map((f) => f.path),
    });
    const info = infoInMemory(virtual);
    const exportJob = await resolveActiveExportJob(deps.exports, auth, project.id);

    return c.json({
      activeId: catalog.activeId,
      projectId: project.id,
      projectTitle: project.title,
      sessionId: project.sessionId,
      exportJob,
      project,
      revision: project.revision,
      versionId: project.currentVersionId,
      versionNumber: project.currentVersionNumber,
      historySeq: project.currentHistorySeq,
      files: virtual.listFiles().map((f) => ({
        path: f.path,
        size: f.sizeBytes,
        hash: f.sha256,
        mimeType: f.mimeType,
        isText: f.isText,
      })),
      assetNames: assetNameInfo.assetNames,
      namingLanguage: assetNameInfo.namingLanguage,
      info,
    });
  };
  app.get('/motion-api/project', handleActiveProject);
  app.get('/motion-api/project/status', handleActiveProject);

  // GET /motion-api/projects/:id — Detailed single-project state.
  app.get('/motion-api/projects/:id', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const projectId = c.req.param('id');
    const project = await deps.workspace.getProject(auth, projectId, { allowTrashed: true });
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const conversation = await deps.workspace.listProjectConversation(auth, projectId);
    const assetNameInfo = await deps.assetNames.readAssetNames(auth, projectId, {
      paths: virtual.listFiles().map((f) => f.path),
    });
    const info = infoInMemory(virtual);

    return c.json({
      ...project,
      files: virtual.listFiles().map((f) => ({
        path: f.path,
        size: f.sizeBytes,
        hash: f.sha256,
        mimeType: f.mimeType,
        isText: f.isText,
      })),
      assetNames: assetNameInfo.assetNames,
      namingLanguage: assetNameInfo.namingLanguage,
      conversation: conversation.messages,
      info,
    });
  });

  // PATCH /motion-api/projects/:id — Rename project.
  app.patch('/motion-api/projects/:id', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      expectedTitle?: string;
      requestId?: string;
    };
    const result = await deps.workspace.renameProject(auth, projectId, {
      title: body.title ?? '',
      expectedTitle: body.expectedTitle,
      requestId: body.requestId,
    });
    const catalog = await deps.workspace.getCatalog(auth);
    return c.json({ ...result, ...catalog });
  });

  // POST /motion-api/projects/:id/open — Select active project.
  app.post('/motion-api/projects/:id/open', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const project = await deps.workspace.selectProject(auth, c.req.param('id'));
    const exportJob = await resolveActiveExportJob(deps.exports, auth, project.id);
    return c.json({
      ok: true,
      activeId: project.id,
      projectId: project.id,
      projectTitle: project.title,
      revision: project.revision,
      sessionId: project.sessionId,
      exportJob,
      project,
    });
  });

  // POST /motion-api/projects/:id/trash — Move project to trash.
  app.post('/motion-api/projects/:id/trash', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as { requestId?: string };
    return c.json(await deps.workspace.trashProject(auth, c.req.param('id'), { requestId: body.requestId }));
  });

  // POST /motion-api/projects/:id/restore — Restore project from trash.
  app.post('/motion-api/projects/:id/restore', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as { requestId?: string };
    return c.json(await deps.workspace.restoreProject(auth, c.req.param('id'), { requestId: body.requestId }));
  });

  // POST /motion-api/projects/:id/duplicate — Duplicate project via CAS refs.
  app.post('/motion-api/projects/:id/duplicate', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    if (!deps.archives) {
      throw new CloudError('SERVICE_UNAVAILABLE', 'Project duplication service is not configured.', {
        status: 503,
        applied: false,
      });
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      requestId?: string;
      selectActive?: boolean;
    };
    const duplicated = await deps.archives.duplicateProject(auth, c.req.param('id'), body);
    return c.json(duplicated, duplicated.replayed ? 200 : 201);
  });

  // DELETE /motion-api/projects/:id — Permanently delete trashed project and decrement all CAS refs.
  app.delete('/motion-api/projects/:id', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const requestId = c.req.query('requestId') ?? c.req.header('x-request-id') ?? undefined;
    return c.json(await deps.workspace.deleteProjectPermanently(auth, c.req.param('id'), { requestId }));
  });

  // GET & POST /motion-api/projects/:id/conversation — Project session conversation.
  app.get('/motion-api/projects/:id/conversation', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    return c.json(await deps.workspace.listProjectConversation(auth, c.req.param('id')));
  });

  app.post('/motion-api/projects/:id/conversation', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const project = await deps.workspace.getProject(auth, c.req.param('id'), { allowTrashed: false });
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      role?: 'user' | 'assistant';
      content?: string;
    };
    const result = await deps.workspace.appendMessage(auth, project.sessionId, {
      id: body.id,
      role: body.role,
      content: body.content ?? '',
    });
    return c.json({ projectId: project.id, ...result }, result.replayed ? 200 : 201);
  });

  // GET / PUT / PATCH /motion-api/projects/:id/asset-names — PG-backed asset display names.
  app.get('/motion-api/projects/:id/asset-names', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    return c.json(await deps.assetNames.readAssetNames(auth, c.req.param('id')));
  });

  const handleUpdateAssetNames = async (c: Context<{ Variables: ProductRouteVariables }>) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as {
      assetNames?: Array<{ path: string; name: string; nameSource?: 'user' | 'agent' | 'source' }>;
      namingLanguage?: string;
      expectedRevision?: string;
      requestId?: string;
    };
    const projectId = c.req.param('id') ?? '';
    return c.json(
      await deps.assetNames.updateAssetNames(auth, projectId, {
        ...body,
        writeToken: c.req.header('x-hyperframes-write-token'),
      }),
    );
  };
  app.put('/motion-api/projects/:id/asset-names', handleUpdateAssetNames);
  app.patch('/motion-api/projects/:id/asset-names', handleUpdateAssetNames);

  // GET /motion-api/projects/:id/versions & POST .../restore
  app.get('/motion-api/projects/:id/versions', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const limitRaw = c.req.query('limit');
    const cursorRaw = c.req.query('cursor');
    return c.json(
      await deps.history.listVersions(auth, c.req.param('id'), {
        limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
        cursorVersionNumber: cursorRaw ? Number.parseInt(cursorRaw, 10) : undefined,
      }),
    );
  });

  app.post('/motion-api/projects/:id/versions/:versionId/restore', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as {
      expectedRevision?: string;
      expectedVersionId?: string;
      requestId?: string;
      label?: string;
    };
    return c.json(
      await deps.history.restoreVersion(auth, c.req.param('id'), {
        targetVersionId: c.req.param('versionId'),
        expectedRevision: body.expectedRevision,
        expectedVersionId: body.expectedVersionId,
        requestId: body.requestId,
        label: body.label,
        writeToken: c.req.header('x-hyperframes-write-token'),
      }),
    );
  });

  // GET / POST / PATCH /motion-api/projects/:id/work-rounds
  app.get('/motion-api/projects/:id/work-rounds', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const limitRaw = c.req.query('limit');
    const rounds = await deps.workRounds.list(
      auth,
      c.req.param('id'),
      limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
    );
    return c.json({ workRounds: rounds });
  });

  app.post('/motion-api/projects/:id/work-rounds', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      mode?: 'create' | 'modify';
      versionId?: string;
      versionNumber?: number;
      revision?: string;
      jobId?: string;
      generation?: Record<string, unknown>;
    };
    const created = await deps.workRounds.create(auth, {
      projectId: c.req.param('id'),
      title: body.title,
      mode: body.mode === 'create' ? 'create' : 'modify',
      versionId: body.versionId,
      versionNumber: body.versionNumber,
      revision: body.revision,
      jobId: body.jobId,
      generation: body.generation,
    });
    return c.json(created, 201);
  });

  app.get('/motion-api/projects/:id/work-rounds/:workId', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const found = await deps.workRounds.get(auth, c.req.param('id'), c.req.param('workId'));
    if (!found) return c.notFound();
    return c.json(found);
  });

  app.patch('/motion-api/projects/:id/work-rounds/:workId', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const projectId = c.req.param('id');
    const workId = c.req.param('workId');
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: 'saved' | 'failed' | 'exported' | 'studio_edited';
      versionId?: string;
      versionNumber?: number;
      revision?: string;
      jobId?: string;
      error?: string;
      source?: 'studio' | 'mcp' | 'api';
      generation?: Record<string, unknown>;
    };

    if (body.action === 'failed') {
      return c.json(await deps.workRounds.markFailed(auth, projectId, workId, body.error ?? 'Unknown error'));
    }
    if (body.action === 'exported') {
      return c.json(
        await deps.workRounds.markExported(auth, projectId, workId, {
          jobId: body.jobId,
          source: body.source,
        }),
      );
    }
    if (body.action === 'studio_edited') {
      return c.json(await deps.workRounds.markStudioEdited(auth, projectId, workId));
    }
    return c.json(
      await deps.workRounds.markSaved(auth, projectId, workId, {
        versionId: body.versionId,
        versionNumber: body.versionNumber,
        revision: body.revision,
        jobId: body.jobId,
        generation: body.generation,
      }),
    );
  });

  // POST /motion-api/projects/:id/preview-display & /reviews
  app.post('/motion-api/projects/:id/preview-display', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(await deps.workspace.recordPreviewDisplay(auth, c.req.param('id'), body));
  });

  app.post('/motion-api/projects/:id/reviews', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(await deps.workspace.recordReview(auth, c.req.param('id'), body), 201);
  });

  return app;
}
