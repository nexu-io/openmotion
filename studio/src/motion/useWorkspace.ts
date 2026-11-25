import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18n';
import { confirmedRoute, projectHref, requestedProject, sessionHref, type OpenedPreview, type WorkspaceRoute } from './workspaceRouting';
import { availableSession, type CreativeSession, type CreationMode } from '../../../shared/session';
import { preservePresentation } from '../../../shared/workspace-url';
import { isNotFoundSpaPath, isStandaloneSpaPath } from '../../../shared/spa-routes';
import { activeWorkspaceInterval, subscribeProjectActivity, watchWorkspaceRead } from './workspaceRefresh';
import { getStudioSaveSnapshot, subscribeStudioSaves } from '../utils/studioSaveState';
import { diagnosticFetch } from './diagnosticRequests';
import { setDiagnosticsAuthState } from './diagnostics';
import { initializeWorkspaceHistory, WORKSPACE_LOCATION_CHANGED, workspaceHistoryIndex, workspaceHistorySession, writeWorkspaceHistory } from '../utils/workspaceHistory';
import { readWorkspacePage } from './workspacePageRouting';
import {
  classifyAuthHttpError,
  clearAuthPendingDraft,
  notifyAuthRecovery,
  readAuthPendingDraft,
  saveAuthPendingDraft,
  type AuthRecoveryDetail,
} from './authRecoveryStore';
import { clearPrivateSwrCache, readSwrCache, writeSwrCache } from './swrCache';

const WORKSPACE_CATALOG_CACHE_KEY = 'workspace-catalog';

export type SavedProject = { id: string; title: string; titleKey?: 'OpenMotion Sample Video' | null; templateId?: string; createdAt?: number; openedAt?: number; trashedAt?: number };
type Job = { id: string; state: 'pending' | 'running' | 'completed' | 'failed'; error?: string };
export type WorkspaceStatus = { revision: string; projectId: string; projectTitle: string; exportJob: Job | null; sessionId?: string;
  historyRestoreError?: { requestId: string; message: string } | null };
export type ProjectCatalog = { activeId: string; projects: SavedProject[]; sessions?: CreativeSession[]; activeSessionId?: string };
const workspaceStatusPath = '/project/status?view=summary';

export type MotionApiRequestInit = RequestInit & {
  suppressAuthRecovery?: boolean;
};

export async function motionApi<T>(path: string, init?: MotionApiRequestInit, projectId?: string): Promise<T> {
  const { suppressAuthRecovery, ...fetchInit } = init ?? {};
  const response = await diagnosticFetch('/motion-api' + path
    + (projectId ? (path.includes('?') ? '&' : '?') + 'projectId=' + encodeURIComponent(projectId) : ''), fetchInit);
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error body.
  }
  if (fetchInit.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (!response.ok) {
    if (response.status === 401) clearPrivateSwrCache();
    const message = typeof data.error === 'string' ? data.error : 'Workspace connection failed';
    const error = new Error(message) as Error & {
      status?: number;
      code?: string;
      errorCode?: string;
      sessionExpired?: boolean;
      authRecovery?: AuthRecoveryDetail;
    };
    error.status = response.status;
    if (typeof data.code === 'string') error.code = data.code;
    if (typeof data.errorCode === 'string') error.errorCode = data.errorCode;
    if (typeof data.sessionExpired === 'boolean') error.sessionExpired = data.sessionExpired;
    const authRecovery = classifyAuthHttpError(response.status, data, message);
    if (authRecovery) error.authRecovery = authRecovery;
    const method = (fetchInit.method ?? 'GET').toUpperCase();
    const isMutating = method !== 'GET' && method !== 'HEAD';
    if (authRecovery && (authRecovery.kind === 'auth_unavailable' || (!suppressAuthRecovery && isMutating))) {
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
  options?: {
    externalHistoryGuard?: boolean;
    allowUnscopedStatusFallback?: boolean;
    /** Skip the unscoped `/project/status` probe on non-editor pages until `/projects` confirms authentication. */
    deferUnscopedStatusUntilCatalog?: boolean;
    onStaleProjectId?: (projectId: string) => void;
  },
) {
  const externalHistoryGuard = Boolean(options?.externalHistoryGuard);
  const allowUnscopedStatusFallbackRef = useRef(Boolean(options?.allowUnscopedStatusFallback));
  allowUnscopedStatusFallbackRef.current = Boolean(options?.allowUnscopedStatusFallback);
  const onStaleProjectIdRef = useRef(options?.onStaleProjectId);
  onStaleProjectIdRef.current = options?.onStaleProjectId;
  const { t } = useI18n();
  const [staleProjectId, setStaleProjectId] = useState<string | null>(null);
  useEffect(() => {
    setStaleProjectId(previous => (previous && previous !== projectId ? null : previous));
  }, [projectId]);
  const effectiveProjectId = projectId && projectId !== staleProjectId ? projectId : undefined;
  const initialCachedCatalog = useRef<ProjectCatalog | null | undefined>(undefined);
  if (initialCachedCatalog.current === undefined) {
    const cached = readSwrCache<ProjectCatalog>('private', WORKSPACE_CATALOG_CACHE_KEY);
    initialCachedCatalog.current = cached && Array.isArray(cached.projects) ? cached : null;
  }
  const [projects, setProjects] = useState<SavedProject[]>(() => initialCachedCatalog.current?.projects ?? []);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => initialCachedCatalog.current?.activeId ?? null);
  const displayedProjects = useMemo(() => projects.map(project => project.id === 'project' && project.titleKey === 'OpenMotion Sample Video'
    ? { ...project, title: t(project.titleKey) } : project), [projects, t]);
  const [sessions, setSessions] = useState<CreativeSession[]>(() =>
    [...(initialCachedCatalog.current?.sessions ?? [])].sort((a, b) => (b.openedAt ?? b.createdAt ?? 0) - (a.openedAt ?? a.createdAt ?? 0)),
  );
  const visibleSessions = useMemo(() => {
    const trashed = new Set(projects.filter(project => project.trashedAt).map(project => project.id));
    return sessions.flatMap(session => availableSession(session, trashed) ?? []);
  }, [projects, sessions]);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(() => Boolean(initialCachedCatalog.current));
  const [catalogVerified, setCatalogVerified] = useState(false);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const identityGenerationRef = useRef(0);
  const catalogControllerRef = useRef<AbortController | null>(null);
  const statusControllerRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [navigationError, setNavigationError] = useState<{ message: string } | null>(null);
  const [connectionCheck, setConnectionCheck] = useState(0);
  const [statusRead, setStatusRead] = useState({ attempt: 0, error: '' });
  const [catalogRead, setCatalogRead] = useState({ attempt: 0, error: '' });
  const connectionError = statusRead.error || catalogRead.error;
  const checkingConnection = statusRead.attempt < connectionCheck || catalogRead.attempt < connectionCheck;
  const retryConnection = useCallback(() => setConnectionCheck(value => value + 1), []);
  const refreshWorkspaceCatalog = useRef<((delay: number) => void) | null>(null);
  const refreshWorkspaceStatus = useRef<((delay: number) => void) | null>(null);
  const knownCatalog = useRef<readonly SavedProject[] | null>(null);
  const acting = useRef(false);
  const pendingSession = useRef<{ key: string; id: string } | null>(null);
  // Once a project is known, resolving its session does not change the read scope.
  const sessionWithoutProject = effectiveProjectId ? undefined : sessionId;
  useEffect(() => {
    acting.current = false;
    setBusy(false);
    setStatus(null);
    setError('');
    setNavigationError(null);
    setStatusRead(previous => previous.error ? { ...previous, error: '' } : previous);
    if (effectiveProjectId && knownCatalog.current && !knownCatalog.current.some(project => project.id === effectiveProjectId)) {
      refreshWorkspaceCatalog.current?.(0);
    }
  }, [effectiveProjectId, sessionWithoutProject]);
  const request = useCallback(<T,>(path: string, init?: RequestInit) => motionApi<T>(path, init, effectiveProjectId), [effectiveProjectId]);
  const updateCatalog = useCallback((catalog: ProjectCatalog) => {
    // The catalog keeps project order; opening a project must not move its sidebar row.
    const ordered = catalog.projects;
    knownCatalog.current = ordered;
    setActiveProjectId(catalog.activeId);
    setProjects(previous => JSON.stringify(previous) === JSON.stringify(ordered) ? previous : ordered);
    const nextSessions = [...(catalog.sessions ?? [])].sort((a, b) => (b.openedAt ?? b.createdAt ?? 0) - (a.openedAt ?? a.createdAt ?? 0));
    setSessions(previous => JSON.stringify(previous) === JSON.stringify(nextSessions) ? previous : nextSessions);
    writeSwrCache('private', WORKSPACE_CATALOG_CACHE_KEY, {
      activeId: catalog.activeId,
      projects: ordered,
      sessions: nextSessions,
      activeSessionId: catalog.activeSessionId,
    });
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
  // The project list belongs to the workspace. Keep its in-flight read and refresh
  // schedule when switching between projects in the same mounted workspace.
  const editingProject = Boolean(effectiveProjectId);
  useEffect(() => {
    const controller = new AbortController();
    catalogControllerRef.current = controller;
    const generation = identityGenerationRef.current;
    const openedAt = Date.now();
    const isStale = () => controller.signal.aborted || generation !== identityGenerationRef.current;
    const refreshCatalog = watchWorkspaceRead(controller.signal, async () => {
      let catalog: ProjectCatalog;
      try {
        catalog = await motionApi<ProjectCatalog>('/projects', { signal: controller.signal, priority: editingProject ? 'low' : 'auto' });
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        if (status === 401) {
          if (!isStale()) {
            setDiagnosticsAuthState(false);
            setAuthRequired(true);
            setCatalogLoaded(false);
            setCatalogVerified(false);
            setCatalogRead({ attempt: connectionCheck, error: '' });
          }
          return Infinity;
        }
        throw err;
      }
      if (isStale()) return Infinity;
      setDiagnosticsAuthState(true);
      setAuthRequired(false);
      setCatalogLoaded(true);
      setCatalogVerified(true);
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
    }, error => { if (!isStale()) setCatalogRead({ attempt: connectionCheck, error }); });

    refreshWorkspaceCatalog.current = refreshCatalog;
    return () => {
      controller.abort();
      if (catalogControllerRef.current === controller) catalogControllerRef.current = null;
      refreshWorkspaceCatalog.current = null;
    };
  }, [editingProject, sessionWithoutProject, updateCatalog, connectionCheck, navigate, accountEpoch]);

  const deferUnscopedStatus = Boolean(
    options?.deferUnscopedStatusUntilCatalog && !effectiveProjectId && !sessionWithoutProject,
  );
  const statusReadAllowed = !deferUnscopedStatus || catalogVerified;

  useEffect(() => {
    const handleAccountChanged = () => {
      identityGenerationRef.current++;
      catalogControllerRef.current?.abort();
      statusControllerRef.current?.abort();
      knownCatalog.current = null;
      setProjects([]);
      setActiveProjectId(null);
      setSessions([]);
      setStatus(null);
      setAuthRequired(false);
      setCatalogLoaded(false);
      setCatalogVerified(false);
      setStatusRead(previous => previous.error ? { ...previous, error: '' } : previous);
      setCatalogRead(previous => previous.error ? { ...previous, error: '' } : previous);
      setAccountEpoch(value => value + 1);
    };
    window.addEventListener('motion:account-changed', handleAccountChanged);
    return () => window.removeEventListener('motion:account-changed', handleAccountChanged);
  }, []);

  useEffect(() => {
    if (!statusReadAllowed) return;
    const controller = new AbortController();
    statusControllerRef.current = controller;
    const generation = identityGenerationRef.current;
    const isStale = () => controller.signal.aborted || generation !== identityGenerationRef.current;
    const refreshStatus = watchWorkspaceRead(controller.signal, async () => {
      let data: WorkspaceStatus;
      try {
        data = await request<WorkspaceStatus>(workspaceStatusPath, { signal: controller.signal });
      } catch (err) {
        const statusCode = (err as { status?: number } | null)?.status;
        if (statusCode === 401) {
          if (!isStale()) {
            setAuthRequired(true);
            setStatus(null);
            setStatusRead({ attempt: connectionCheck, error: '' });
          }
          return Infinity;
        }
        if (
          effectiveProjectId
          && allowUnscopedStatusFallbackRef.current
          && (statusCode === 404 || statusCode === 400 || statusCode === 403)
        ) {
          if (!isStale()) {
            setStaleProjectId(effectiveProjectId);
            setStatusRead({ attempt: connectionCheck, error: '' });
            onStaleProjectIdRef.current?.(effectiveProjectId);
          }
          return Infinity;
        }
        throw err;
      }
      if (isStale()) return Infinity;
      if (effectiveProjectId && data.projectId !== effectiveProjectId && !acting.current && !allowUnscopedStatusFallbackRef.current) {
        throw new Error('项目状态与当前页面不匹配，请重新打开对应项目。');
      }
      setAuthRequired(false);
      setStatus(data);
      const exporting = data.exportJob?.state === 'pending' || data.exportJob?.state === 'running';
      // Save notifications and render events handle changes in the active editor.
      // Keep a bounded reconciliation for missed events and non-editor views.
      return exporting ? activeWorkspaceInterval : 120_000;
    }, error => { if (!isStale()) setStatusRead({ attempt: connectionCheck, error }); });
    refreshWorkspaceStatus.current = refreshStatus;

    // Local writes and server-backed history both update the project save store.
    let savedAt = getStudioSaveSnapshot(effectiveProjectId ?? null).savedAt;
    const unsubscribeSaves = subscribeStudioSaves(() => {
      const next = getStudioSaveSnapshot(effectiveProjectId ?? null).savedAt;
      if (next === savedAt) return;
      savedAt = next;
      refreshStatus(activeWorkspaceInterval);
    });
    const unsubscribeActivity = subscribeProjectActivity((id, event) => {
      if (id !== effectiveProjectId) return;
      if (event === 'catalog-changed') { refreshWorkspaceCatalog.current?.(0); return; }
      if (event === 'reconnected') {
        refreshStatus(0);
        refreshWorkspaceCatalog.current?.(0);
      } else if (event === 'render-updated') refreshStatus(activeWorkspaceInterval);
    });
    return () => {
      controller.abort();
      if (statusControllerRef.current === controller) statusControllerRef.current = null;
      refreshWorkspaceStatus.current = null;
      unsubscribeSaves();
      unsubscribeActivity();
    };
  }, [effectiveProjectId, request, connectionCheck, sessionWithoutProject, statusReadAllowed, accountEpoch]);

  const transition = useCallback(async (path?: string, options?: { instruction?: string; mode?: string; templateId?: string; projectId?: string; requestId?: string }, route: { session?: boolean; revealArtifact?: boolean; existing?: OpenTarget } = {}) => {
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
        if (opened.projectId) setActiveProjectId(opened.projectId);
        navigate(href, false, resolved ?? undefined);
        return true;
      }
      const current = await request<WorkspaceStatus>(workspaceStatusPath);
      if (effectiveProjectId && current.projectId !== effectiveProjectId) throw new Error('当前项目已切换，请刷新后重试。');
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
          projectId: options?.projectId ?? effectiveProjectId,
        });
        notifyAuthRecovery({ kind: 'auth_required', status: 401, message: apiErr.message, draft });
      }
      setError((err as Error).message);
      return false;
    }
    finally { acting.current = false; setBusy(false); }
  }, [waitForSaves, effectiveProjectId, request, navigate]);
  const open = useCallback((kind: 'templates' | 'projects', id: string) => transition(`/${kind}/${encodeURIComponent(id)}/open`, undefined, { existing: kind === 'projects' ? { projectId: id } : undefined }), [transition]);
  const followActiveProject = useCallback((id: string) => navigate(projectHref(id), true), [navigate]);
  const create = useCallback((instruction?: string, requestId?: string) => {
    const payload: { instruction?: string; requestId?: string } = {};
    if (instruction?.trim()) payload.instruction = instruction.trim();
    if (requestId) payload.requestId = requestId;
    return transition('/projects', Object.keys(payload).length > 0 ? payload : undefined);
  }, [transition]);
  const home = useCallback(() => transition(), [transition]);
  const startSession = useCallback(async (instruction?: string, templateId?: string, mode: CreationMode = 'motion', requestId?: string) => {
    if (acting.current) return false;
    acting.current = true; setBusy(true); setError('');
    let createdId: string | undefined;
    const options = { mode, ...(instruction?.trim() ? { instruction: instruction.trim() } : {}), ...(templateId ? { templateId } : {}) };
    const key = JSON.stringify(options);
    const preserved = readAuthPendingDraft();
    const preservedId =
      requestId ??
      (preserved && preserved.templateId === templateId && preserved.instruction === (instruction?.trim() || undefined)
        ? preserved.idempotencyKey
        : undefined);
    if (pendingSession.current?.key !== key || (requestId && pendingSession.current.id !== requestId)) {
      pendingSession.current = { key, id: preservedId ?? crypto.randomUUID() };
    }
    try {
      await waitForSaves();
      const created = await motionApi<{ sessionId: string; session: CreativeSession }>('/sessions', { method: 'POST', ...jsonBody({ ...options, id: pendingSession.current.id }) });
      createdId = created.sessionId;
      try { localStorage.removeItem('motion.home.draft.v1'); } catch {}
      clearAuthPendingDraft();
      const existing = created.session?.artifacts.find(item => item.id === created.session.activeArtifactId) ?? created.session?.artifacts[0];
      if (existing) { navigate(sessionHref(createdId, existing.projectId, true)); return true; }
      const current = await request<WorkspaceStatus>(workspaceStatusPath);
      const next = await request<WorkspaceStatus>(`/sessions/${createdId}/artifacts`, {
        method: 'POST',
        ...jsonBody({
          expectedRevision: current.revision,
          expectedProjectId: current.projectId,
          requestId: pendingSession.current.id,
          ...(templateId ? { templateId, projectType: 'template' } : {}),
        }),
      });
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
  const createArtifact = useCallback((id: string, templateId?: string, requestId?: string) => {
    const payload: { templateId?: string; requestId?: string } = {};
    if (templateId) payload.templateId = templateId;
    if (requestId) payload.requestId = requestId;
    return transition(`/sessions/${encodeURIComponent(id)}/artifacts`, Object.keys(payload).length > 0 ? payload : undefined, { session: true });
  }, [transition]);
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
  return { projects: activeProjects, activeProjectId, trashedProjects, sessions: visibleSessions, session: currentSession, status, authRequired, catalogLoaded, catalogVerified, busy, actingRef: acting, navigationError, connectionError, error: error || connectionError, errorSource: error ? 'operation' as const : 'connection' as const, checkingConnection, retryConnection, open, followActiveProject, create, home, rename, startSession, openSession, createArtifact, renameSession, clearError };
}
