import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18n';
import { confirmedRoute, projectHref, requestedProject, sessionHref, type OpenedPreview, type WorkspaceRoute } from './workspaceRouting';
import { availableSession, type CreativeSession, type CreationMode } from '../../../shared/session';
import { preservePresentation } from '../../../shared/workspace-url';
import { isNotFoundSpaPath, isStandaloneSpaPath } from '../../../shared/spa-routes';
import { activeWorkspaceInterval, subscribeProjectActivity, watchWorkspaceRead } from './workspaceRefresh';
import { getStudioSaveSnapshot, subscribeStudioSaves } from '../utils/studioSaveState';
import { diagnosticFetch } from './diagnosticRequests';
import { initializeWorkspaceHistory, WORKSPACE_LOCATION_CHANGED, workspaceHistoryIndex, workspaceHistorySession, writeWorkspaceHistory } from '../utils/workspaceHistory';
import { readWorkspacePage } from './workspacePageRouting';
import {
  classifyAuthHttpError,
  clearAuthPendingDraft,
  notifyAuthRecovery,
  readAuthPendingDraft,
  saveAuthPendingDraft,
} from './authRecoveryStore';

export type SavedProject = { id: string; title: string; titleKey?: 'OpenMotion Sample Video' | null; templateId?: string; createdAt?: number; openedAt?: number; trashedAt?: number };
type Job = { id: string; state: 'pending' | 'running' | 'completed' | 'failed'; error?: string };
export type WorkspaceStatus = { revision: string; projectId: string; projectTitle: string; exportJob: Job | null; sessionId?: string;
  historyRestoreError?: { requestId: string; message: string } | null };
export type ProjectCatalog = { activeId: string; projects: SavedProject[]; sessions?: CreativeSession[]; activeSessionId?: string };
const workspaceStatusPath = '/project/status?view=summary';

export async function motionApi<T>(path: string, init?: RequestInit, projectId?: string): Promise<T> {
  const response = await diagnosticFetch('/motion-api' + path
    + (projectId ? (path.includes('?') ? '&' : '?') + 'projectId=' + encodeURIComponent(projectId) : ''), init);
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error body.
  }
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : 'Workspace connection failed';
    const error = new Error(message) as Error & { status?: number; code?: string; errorCode?: string };
    error.status = response.status;
    if (typeof data.code === 'string') error.code = data.code;
    if (typeof data.errorCode === 'string') error.errorCode = data.errorCode;
    const authRecovery = classifyAuthHttpError(response.status, data, message);
    const method = (init?.method ?? 'GET').toUpperCase();
    const isMutating = method !== 'GET' && method !== 'HEAD';
    if (authRecovery && (authRecovery.kind === 'auth_unavailable' || isMutating)) {
      notifyAuthRecovery(authRecovery);
    }
    throw error;
  }
  return data as T;
}
export function navigateWorkspace(url: string, replace = false) {
  // A document navigation releases every old edit session, observer and upload handler.
  const target = preservePresentation(url, location.search);
  if (replace) window.location.replace(target);
  else window.location.assign(target);
}
const jsonBody = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

type Navigate = (url: string, replace?: boolean, opened?: WorkspaceRoute) => void;
type OpenTarget = { projectId?: string; sessionId?: string };

export function useWorkspace(
  waitForSaves: () => Promise<void>,
  projectId?: string,
  sessionId?: string,
  navigate: Navigate = navigateWorkspace,
  options?: { externalHistoryGuard?: boolean },
) {
  const externalHistoryGuard = Boolean(options?.externalHistoryGuard);
  const { t } = useI18n();
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const displayedProjects = useMemo(() => projects.map(project => project.id === 'project' && project.titleKey === 'OpenMotion Sample Video'
    ? { ...project, title: t(project.titleKey) } : project), [projects, t]);
  const [sessions, setSessions] = useState<CreativeSession[]>([]);
  const visibleSessions = useMemo(() => {
    const trashed = new Set(projects.filter(project => project.trashedAt).map(project => project.id));
    return sessions.flatMap(session => availableSession(session, trashed) ?? []);
  }, [projects, sessions]);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [navigationError, setNavigationError] = useState<{ message: string } | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [connectionCheck, setConnectionCheck] = useState(0);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const retryConnection = useCallback(() => { setCheckingConnection(true); setConnectionCheck(value => value + 1); }, []);
  const acting = useRef(false);
  const pendingSession = useRef<{ key: string; id: string } | null>(null);
  // Once a project is known, resolving its session does not change the read scope.
  const sessionWithoutProject = projectId ? undefined : sessionId;
  useEffect(() => {
    acting.current = false;
    setBusy(false);
    setStatus(null);
    setError('');
    setNavigationError(null);
    setConnectionError('');
  }, [projectId, sessionWithoutProject]);
  const request = useCallback(<T,>(path: string, init?: RequestInit) => motionApi<T>(path, init, projectId), [projectId]);
  const updateCatalog = useCallback((catalog: ProjectCatalog) => {
    // The catalog keeps project order; opening a project must not move its sidebar row.
    const ordered = catalog.projects;
    setActiveProjectId(catalog.activeId);
    setProjects(previous => JSON.stringify(previous) === JSON.stringify(ordered) ? previous : ordered);
    const nextSessions = [...(catalog.sessions ?? [])].sort((a, b) => (b.openedAt ?? b.createdAt ?? 0) - (a.openedAt ?? a.createdAt ?? 0));
    setSessions(previous => JSON.stringify(previous) === JSON.stringify(nextSessions) ? previous : nextSessions);
  }, []);
  useEffect(() => {
    if (navigate === navigateWorkspace || externalHistoryGuard) return;
    initializeWorkspaceHistory();
    let previousUrl = location.href, previousIndex = workspaceHistoryIndex(), previousSession = workspaceHistorySession();
    let cancelled = false, generation = 0;
    let restoringUrl: string | null = null;
    const accepted = () => { previousUrl = location.href; previousIndex = workspaceHistoryIndex(); previousSession = workspaceHistorySession(); generation++; };
    const restore = async () => {
      const target = location.href, targetIndex = workspaceHistoryIndex(), attempt = ++generation;
      if (target === restoringUrl) {
        restoringUrl = null;
        writeWorkspaceHistory(target, true);
        return;
      }
      const previous = new URL(previousUrl), next = new URL(target);
      const sameProject = requestedProject(next.search, next.hash, next.pathname) === requestedProject(previous.search, previous.hash, previous.pathname)
        && next.searchParams.get('session') === previous.searchParams.get('session');
      try {
        if (acting.current) throw new Error(t('Switching projects. Please try again shortly.'));
        // Page switches preserve the mounted editor. Leaving a busy template
        // library or replacing the project still uses the existing save guard.
        if (!sameProject || (readWorkspacePage(previous.search, previous.hash, previous.pathname).templates && !readWorkspacePage(next.search, next.hash, next.pathname).templates)) await waitForSaves();
        if (cancelled || attempt !== generation || location.href !== target) return;
        setNavigationError(null);
        if (sameProject) writeWorkspaceHistory(target, true);
        else navigate(target, true);
      } catch (err) {
        if (cancelled || attempt !== generation || location.href !== target) return;
        // Restore our entry without truncating Forward history. Older/external
        // entries have no index, so replace only that unknown entry as a fallback.
        if (previousSession === workspaceHistorySession() && previousIndex !== null && targetIndex !== null && previousIndex !== targetIndex) {
          restoringUrl = previousUrl;
          history.go(previousIndex - targetIndex);
        }
        else writeWorkspaceHistory(previousUrl, true);
        setNavigationError({ message: (err as Error).message });
      }
    };
    window.addEventListener(WORKSPACE_LOCATION_CHANGED, accepted);
    window.addEventListener('popstate', restore);
    return () => { cancelled = true; window.removeEventListener(WORKSPACE_LOCATION_CHANGED, accepted); window.removeEventListener('popstate', restore); };
  }, [navigate, projectId, sessionId, waitForSaves, externalHistoryGuard]);
  useEffect(() => {
    const controller = new AbortController();
    let statusError: string | undefined, catalogError: string | undefined;
    const settled = () => {
      setConnectionError(statusError || catalogError || '');
      if (statusError !== undefined && catalogError !== undefined) setCheckingConnection(false);
    };
    const openedAt = Date.now();
    const refreshStatus = watchWorkspaceRead(controller.signal, async () => {
      const data = await request<WorkspaceStatus>(workspaceStatusPath, { signal: controller.signal });
      if (controller.signal.aborted) return Infinity;
      if (projectId && data.projectId !== projectId && !acting.current) {
        throw new Error('项目状态与当前页面不匹配，请重新打开对应项目。');
      }
      setStatus(data);
      const exporting = data.exportJob?.state === 'pending' || data.exportJob?.state === 'running';
      // Save notifications and render events handle changes in the active editor.
      // Keep a bounded reconciliation for missed events and non-editor views.
      return exporting ? activeWorkspaceInterval : 120_000;
    }, error => { statusError = error; settled(); });

    const refreshCatalog = watchWorkspaceRead(controller.signal, async () => {
      const catalog = await motionApi<ProjectCatalog>('/projects', { signal: controller.signal });
      if (controller.signal.aborted) return Infinity;
      updateCatalog(catalog);
      const awaitingArtifact = sessionWithoutProject
        && !isStandaloneSpaPath(location.pathname, location.search, location.hash)
        && !isNotFoundSpaPath(location.pathname, location.search, location.hash);
      if (awaitingArtifact) {
        const saved = catalog.sessions?.find(item => item.id === sessionWithoutProject);
        const session = saved && availableSession(saved, new Set(catalog.projects.filter(project => project.trashedAt).map(project => project.id)));
        const generated = session?.artifacts.find(item => item.id === session.activeArtifactId) ?? session?.artifacts.at(-1);
        if (generated && !acting.current) {
          navigate(sessionHref(sessionWithoutProject!, generated.projectId, true), true);
          return Infinity;
        }
        // Poll quickly for the first result, then cap the cost of an empty draft.
        return Date.now() - openedAt < 30_000 ? activeWorkspaceInterval : 15_000;
      }
      return 60_000;
    }, error => { catalogError = error; settled(); });

    // Local writes and server-backed history both update the project save store.
    let savedAt = getStudioSaveSnapshot(projectId ?? null).savedAt;
    const unsubscribeSaves = subscribeStudioSaves(() => {
      const next = getStudioSaveSnapshot(projectId ?? null).savedAt;
      if (next === savedAt) return;
      savedAt = next;
      refreshStatus(activeWorkspaceInterval);
    });
    const unsubscribeActivity = subscribeProjectActivity((id, event) => {
      if (id !== projectId) return;
      if (event === 'catalog-changed') { refreshCatalog(0); return; }
      if (event === 'reconnected') {
        refreshStatus(0);
        refreshCatalog(0);
      } else if (event === 'render-updated') refreshStatus(activeWorkspaceInterval);
    });
    return () => { controller.abort(); unsubscribeSaves(); unsubscribeActivity(); };
  }, [projectId, sessionWithoutProject, updateCatalog, request, connectionCheck, navigate]);

  const transition = useCallback(async (path?: string, options?: { instruction?: string; mode?: string; templateId?: string; projectId?: string }, route: { session?: boolean; revealArtifact?: boolean; existing?: OpenTarget } = {}) => {
    if (acting.current) return false;
    acting.current = true; setBusy(true); setError('');
    try {
      await waitForSaves();
      if (!path) { navigate('/'); return true; }
      // A supporting cloud server checks the source and activates the target in one request.
      if (route.existing && navigate !== navigateWorkspace && document.head.querySelector('meta[name="openmotion-runtime"][data-editor-open="1"]')) {
        const opened = await request<OpenedPreview>(path + '?view=editor', { method: 'POST', ...jsonBody(options ?? {}) });
        const target = route.existing;
        if ((target.projectId && target.projectId !== opened.projectId) || (target.sessionId && target.sessionId !== opened.sessionId)) {
          throw new Error('项目状态与当前页面不匹配，请重新打开对应项目。');
        }
        const resolved = opened.projectId
          ? confirmedRoute(opened, opened.projectId, target.sessionId ?? null)
          : target.sessionId && opened.artifact === null ? { sessionId: target.sessionId } : null;
        if (!opened.sessionId && !opened.projectId) throw new Error('项目链接无效');
        const href = opened.sessionId
          ? sessionHref(opened.sessionId, opened.projectId, Boolean(route.session && opened.projectId && (route.revealArtifact ?? true)))
          : projectHref(opened.projectId!);
        clearAuthPendingDraft();
        navigate(href, false, resolved ?? undefined);
        return true;
      }
      const current = await request<WorkspaceStatus>(workspaceStatusPath);
      if (projectId && current.projectId !== projectId) throw new Error('当前项目已切换，请刷新后重试。');
      const next = await request<WorkspaceStatus>(path, {
        method: 'POST', ...jsonBody({ expectedRevision: current.revision, expectedProjectId: current.projectId, ...options }),
      });
      if (options?.instruction) { try { localStorage.removeItem('motion.home.draft.v1'); } catch {} }
      clearAuthPendingDraft();
      navigate(route.session && next.sessionId ? sessionHref(next.sessionId, next.projectId, route.revealArtifact ?? true) : projectHref(next.projectId));
      return true;
    } catch (err) {
      const apiErr = err as Error & { status?: number; errorCode?: string; code?: string };
      if (apiErr.status === 401 && (apiErr.errorCode === 'auth_required' || apiErr.code === 'UNAUTHORIZED')) {
        const draft = saveAuthPendingDraft({
          action: options?.templateId ? 'use_template' : 'create_project',
          templateId: options?.templateId,
          instruction: options?.instruction,
          projectId: options?.projectId ?? projectId,
        });
        notifyAuthRecovery({ kind: 'auth_required', status: 401, message: apiErr.message, draft });
      }
      setError((err as Error).message);
      return false;
    }
    finally { acting.current = false; setBusy(false); }
  }, [waitForSaves, projectId, request, navigate]);
  const open = useCallback((kind: 'templates' | 'projects', id: string) => transition(`/${kind}/${encodeURIComponent(id)}/open`, undefined, { existing: kind === 'projects' ? { projectId: id } : undefined }), [transition]);
  const followActiveProject = useCallback((id: string) => navigate(projectHref(id), true), [navigate]);
  const create = useCallback((instruction?: string) => transition('/projects', instruction?.trim() ? { instruction: instruction.trim() } : undefined), [transition]);
  const home = useCallback(() => transition(), [transition]);
  const startSession = useCallback(async (instruction?: string, templateId?: string, mode: CreationMode = 'motion') => {
    if (acting.current) return false;
    acting.current = true; setBusy(true); setError('');
    let createdId: string | undefined;
    const options = { mode, ...(instruction?.trim() ? { instruction: instruction.trim() } : {}), ...(templateId ? { templateId } : {}) };
    const key = JSON.stringify(options);
    const preserved = readAuthPendingDraft();
    const preservedId =
      preserved && preserved.templateId === templateId && preserved.instruction === (instruction?.trim() || undefined)
        ? preserved.idempotencyKey
        : undefined;
    if (pendingSession.current?.key !== key) pendingSession.current = { key, id: preservedId ?? crypto.randomUUID() };
    try {
      await waitForSaves();
      const created = await motionApi<{ sessionId: string; session: CreativeSession }>('/sessions', { method: 'POST', ...jsonBody({ ...options, id: pendingSession.current.id }) });
      createdId = created.sessionId;
      try { localStorage.removeItem('motion.home.draft.v1'); } catch {}
      clearAuthPendingDraft();
      const existing = created.session?.artifacts.find(item => item.id === created.session.activeArtifactId) ?? created.session?.artifacts[0];
      if (existing) { navigate(sessionHref(createdId, existing.projectId, true)); return true; }
      const current = await request<WorkspaceStatus>(workspaceStatusPath);
      const next = await request<WorkspaceStatus>(`/sessions/${createdId}/artifacts`, { method: 'POST', ...jsonBody({ expectedRevision: current.revision, expectedProjectId: current.projectId }) });
      navigate(sessionHref(createdId, next.projectId, true)); return true;
    } catch (err) {
      const apiErr = err as Error & { status?: number; errorCode?: string; code?: string };
      if (apiErr.status === 401 && (apiErr.errorCode === 'auth_required' || apiErr.code === 'UNAUTHORIZED')) {
        const draft = saveAuthPendingDraft({
          action: templateId ? 'use_template' : 'start_session',
          idempotencyKey: pendingSession.current?.id,
          templateId,
          instruction: instruction?.trim() || undefined,
        });
        notifyAuthRecovery({ kind: 'auth_required', status: 401, message: apiErr.message, draft });
      }
      if (createdId) {
        try { sessionStorage.setItem(`opendesign.session-error:${createdId}`, (err as Error).message); } catch {}
        navigate(sessionHref(createdId)); return true;
      }
      setError((err as Error).message); return false;
    }
    finally { acting.current = false; setBusy(false); }
  }, [waitForSaves, request, navigate]);
  const openSession = useCallback((id: string, artifactProjectId?: string) => transition(`/sessions/${encodeURIComponent(id)}/open`, artifactProjectId ? { projectId: artifactProjectId } : undefined, { session: true, revealArtifact: Boolean(artifactProjectId), existing: { sessionId: id, projectId: artifactProjectId } }), [transition]);
  const createArtifact = useCallback((id: string, templateId?: string) => transition(`/sessions/${encodeURIComponent(id)}/artifacts`, templateId ? { templateId } : undefined, { session: true }), [transition]);
  const renameItem = useCallback(async (id: string, title: string, kind: 'projects' | 'sessions') => {
    if (acting.current) return false;
    acting.current = true; setBusy(true); setError('');
    try {
      updateCatalog(await motionApi<ProjectCatalog>(`/${kind}/${encodeURIComponent(id)}`, { method: 'PATCH', ...jsonBody({ title }) }));
      return true;
    } catch (err) { setError((err as Error).message); return false; }
    finally { acting.current = false; setBusy(false); }
  }, [updateCatalog]);
  const rename = useCallback((id: string, title: string) => renameItem(id, title, 'projects'), [renameItem]);
  const renameSession = useCallback((id: string, title: string) => renameItem(id, title, 'sessions'), [renameItem]);
  const clearError = useCallback(() => { setError(''); }, []);
  const activeProjects = useMemo(() => displayedProjects.filter(project => !project.trashedAt), [displayedProjects]);
  const trashedProjects = useMemo(() => displayedProjects.filter(project => Boolean(project.trashedAt)), [displayedProjects]);
  const currentSession = useMemo(() => visibleSessions.find(item => item.id === sessionId), [visibleSessions, sessionId]);
  return { projects: activeProjects, activeProjectId, trashedProjects, sessions: visibleSessions, session: currentSession, status, busy, actingRef: acting, navigationError, connectionError, error: error || connectionError, errorSource: error ? 'operation' as const : 'connection' as const, checkingConnection, retryConnection, open, followActiveProject, create, home, rename, startSession, openSession, createArtifact, renameSession, clearError };
}
