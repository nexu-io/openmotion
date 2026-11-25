import type { CreativeSession } from '../../../shared/session';
import { getCachedCloudDisklessMode, ensureCloudDisklessMode } from '../utils/cloudRuntime';
import { isolatedPreviewOrigin } from '../player/lib/previewLease';
import { motionApi, type ProjectCatalog } from './useWorkspace';
import { confirmedRoute, validWorkspaceProject, type OpenedPreview, type WorkspaceRoute } from './workspaceRouting';

function checkCatalogProject(catalog: ProjectCatalog, projectId: string) {
  if (!catalog.projects.some(project => project.id === projectId && !project.trashedAt)) {
    throw new Error('项目不存在，请从左侧列表选择一个项目。');
  }
}

async function openPreview(projectId: string, signal: AbortSignal) {
  const opened = await motionApi<OpenedPreview>('/preview/open', { method: 'POST', signal, priority: 'high' }, projectId);
  signal.throwIfAborted();
  if (opened.projectId !== undefined && opened.projectId !== projectId) throw new Error('项目状态与当前页面不匹配，请重新打开对应项目。');
  return opened;
}

/** Native hosts use their catalog as the existence guard before opening a preview. */
export async function resolveWorkspaceProject(id: string, signal: AbortSignal, catalog?: ProjectCatalog) {
  if (!validWorkspaceProject(id)) throw new Error('项目链接无效');
  const projects = catalog ?? await motionApi<ProjectCatalog>('/projects', { signal });
  checkCatalogProject(projects, id);
  signal.throwIfAborted();
  return openPreview(id, signal);
}

export async function resolveWorkspaceRoute(projectId: string | null, sessionId: string | null, libraryOnly: boolean,
  signal: AbortSignal): Promise<WorkspaceRoute | null> {
  if (projectId !== null && !validWorkspaceProject(projectId)) throw new Error('项目链接无效');
  if (sessionId !== null && !validWorkspaceProject(sessionId)) throw new Error('会话不存在');
  if (libraryOnly && projectId === 'project') return null;

  let opened: OpenedPreview | undefined;
  // Cloud checks workspace membership and trash state in the same project lookup.
  // Config detection starts before React mounts and stays cached for subsequent switches.
  const cloud = Boolean(isolatedPreviewOrigin() || getCachedCloudDisklessMode() ||
    ((projectId || sessionId) && await ensureCloudDisklessMode()));
  signal.throwIfAborted();
  if (cloud && projectId) {
    opened = await openPreview(projectId, signal);
    if (opened.projectId !== projectId) throw new Error('项目状态与当前页面不匹配，请重新打开对应项目。');
    const route = confirmedRoute(opened, projectId, sessionId);
    if (route) return typeof opened.revision === 'string' && opened.revision.trim()
      ? { ...route, openingHead: { projectId, revision: opened.revision } } : route;
  }

  let catalog: ProjectCatalog;
  try {
    catalog = await motionApi<ProjectCatalog>('/projects', { signal });
  } catch (error) {
    // A project-less legacy template overlay can browse without a private workspace.
    if (libraryOnly && !projectId && !sessionId && (error as { status?: number }).status === 401) return null;
    throw error;
  }
  signal.throwIfAborted();
  const target = projectId ?? (sessionId ? null : catalog.activeId);
  if (libraryOnly && target === 'project') return null;
  const summary = sessionId ? catalog.sessions?.find(item => item.id === sessionId) :
    catalog.sessions?.find(item => item.artifacts.some(artifact => artifact.projectId === target));
  const id = sessionId ?? summary?.id;
  if (!id || !validWorkspaceProject(id)) throw new Error('会话不存在');
  // The catalog contains viewer identities. A legacy or unresolved session (including
  // one with only trashed artifacts) still gets its own authoritative detail response.
  const useSummary = cloud && summary && (target !== null || !summary.artifacts.length ||
    summary.artifacts.some(item => item.id === summary.activeArtifactId));
  const session = useSummary ? summary : await motionApi<CreativeSession>(`/sessions/${id}`, { signal });
  signal.throwIfAborted();
  if (!session.artifacts.length && projectId === null) return { sessionId: id };
  const artifact = target === null
    ? session.artifacts.find(item => item.id === session.activeArtifactId) ?? session.artifacts[0]
    : session.artifacts.find(item => item.projectId === target);
  if (!artifact) throw new Error('该产物不属于此会话');
  if (opened) checkCatalogProject(catalog, artifact.projectId);
  else opened = await resolveWorkspaceProject(artifact.projectId, signal, catalog);
  return confirmedRoute(opened, artifact.projectId, id) ?? { sessionId: id, artifact };
}
