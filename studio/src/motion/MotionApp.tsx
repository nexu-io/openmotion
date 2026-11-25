import { isolatedPreviewOrigin, preparePreviewLease, type PreparedPreviewLease } from "../player/lib/previewLease";
import { EditorOpeningHeadContext, InitialPreviewLeaseContext, useStudioHost } from "./StudioHost";
import { Button } from 'open-design-ui/button';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInRouterContext, useLocation } from 'react-router';
import { useI18n } from '../i18n/I18n';
import { WorkspaceFrame, WorkspaceMenuButton, useWorkspaceChrome } from './WorkspaceFrame';
import { requestedProject, validWorkspaceProject, type WorkspaceRoute } from './workspaceRouting';
import { parseProjectIdFromHash } from '../utils/projectRouting';
import { resolveWorkspaceRoute } from './resolveWorkspaceRoute';
import { preloadMotionProjectEditor } from './MotionProjectEditor';
import { ArtifactViewer } from './ArtifactViewer';
import { EditorOpeningGateHost } from './editorOpeningGate';
import { RecoveryScreen } from '../components/RecoveryScreen';
import { RemixIcon } from '../icons/RemixIcons';
import { trackMotion } from './tracking';
import { writeWorkspaceHistory } from '../utils/workspaceHistory';
import { editorProjectIdFromPath, isNotFoundSpaPath, isStandaloneSpaPath } from '../../../shared/spa-routes';
import { StudioRouterProvider } from '../router/createAppRouter';
import { readWorkspacePage } from './workspacePageRouting';
import { buildLoginUrl } from './AccountSettings';
import type { AuthRecoveryDetail } from './authRecoveryStore';
import { isDesktopApp, startDesktopBrowserLogin } from '../utils/platformHost';

const noPendingSaves = async () => {};

type MotionRouteError =
  | { kind: 'auth_required'; sessionExpired: boolean }
  | { kind: 'auth_unavailable' }
  | { kind: 'workspace_not_found' }
  | { kind: 'generic'; message: string };

function classifyRouteError(err: unknown): MotionRouteError {
  const apiErr = err as Error & {
    status?: number;
    authRecovery?: AuthRecoveryDetail;
  };
  const message = apiErr?.message || 'Workspace connection failed';
  if (apiErr?.authRecovery?.kind === 'auth_required') {
    return { kind: 'auth_required', sessionExpired: Boolean(apiErr.authRecovery.sessionExpired) };
  }
  if (apiErr?.authRecovery?.kind === 'auth_unavailable') {
    return { kind: 'auth_unavailable' };
  }
  if (apiErr?.status === 404 && /not found in this workspace/i.test(message)) {
    return { kind: 'workspace_not_found' };
  }
  return { kind: 'generic', message };
}

/** Resolve the native service before mounting any editor that could read or save files. */
export function MotionApp() {
  const inRouter = useInRouterContext();
  if (!inRouter) {
    return (
      <StudioRouterProvider>
        <MotionAppContent />
      </StudioRouterProvider>
    );
  }
  return <MotionAppContent />;
}

function MotionAppContent() {
  const { t } = useI18n();
  const host = useStudioHost();
  const routerLocation = useLocation();
  const [route, setRoute] = useState(() => ({
    projectId: editorProjectIdFromPath(routerLocation.pathname) ?? requestedProject(routerLocation.search, routerLocation.hash),
    sessionId: new URLSearchParams(routerLocation.search).get('session'),
  }));
  const { projectId, sessionId } = route;
  const notFoundPage = isNotFoundSpaPath(routerLocation.pathname, routerLocation.search, routerLocation.hash);
  const settingsPage = notFoundPage || isStandaloneSpaPath(routerLocation.pathname, routerLocation.search, routerLocation.hash);
  const [libraryOnly, setLibraryOnly] = useState(
    () =>
      readWorkspacePage(routerLocation.search, routerLocation.hash, routerLocation.pathname).templates &&
      projectId === null &&
      !sessionId,
  );
  const [ready, setReady] = useState<(WorkspaceRoute & { previewLease?: PreparedPreviewLease }) | null>(null);
  const previewScope = useMemo(() => {
    if (ready?.previewLease) return ready.previewLease;
    const id = ready?.artifact?.projectId;
    const origin = isolatedPreviewOrigin();
    return id && origin ? preparePreviewLease(id, origin) : undefined;
  }, [ready]);
  const [routeError, setRouteError] = useState<MotionRouteError | null>(null);
  const [attempt, retry] = useState(0);
  const onNavigate = useCallback((targetHref?: string, opened?: WorkspaceRoute) => {
    const target = targetHref ? new URL(targetHref, location.origin) : new URL(location.href);
    const nextPage = readWorkspacePage(target.search, target.hash, target.pathname);
    setReady(opened ?? null);
    setRouteError(null);
    setLibraryOnly(nextPage.templates);
    setRoute({
      projectId: editorProjectIdFromPath(target.pathname) ?? requestedProject(target.search, target.hash),
      sessionId: target.searchParams.get('session'),
    });
  }, []);
  const view = useRef({ id: crypto.randomUUID(), started: performance.now(), sent: false });
  useEffect(() => {
    if (view.current.sent || (!ready && !routeError && !libraryOnly)) return;
    view.current.sent = true;
    const embedded = new URLSearchParams(location.search).get('embed') === '1';
    if (ready || libraryOnly) void trackMotion('page_view', { page_name: 'studio', view_id: view.current.id, embedded, has_project: Boolean(ready?.artifact) });
    if (routeError && routeError.kind !== 'auth_required') {
      void trackMotion('studio_load_result', {
        load_id: view.current.id,
        outcome: 'failure',
        embedded,
        duration_ms: Math.min(86_400_000, Math.round(performance.now() - view.current.started)),
      });
    }
  }, [projectId, sessionId, ready, routeError, libraryOnly]);
  useEffect(() => {
    const onAccountChanged = () => {
      setReady(null);
      setRouteError(null);
      retry(value => value + 1);
    };
    window.addEventListener('motion:account-changed', onAccountChanged);
    return () => window.removeEventListener('motion:account-changed', onAccountChanged);
  }, []);
  useEffect(() => {
    if (ready || settingsPage) return;
    const controller = new AbortController();
    let previewLease: PreparedPreviewLease | undefined;
    setRouteError(null);
    async function resolve() {
      const resolved = await resolveWorkspaceRoute(projectId, sessionId, libraryOnly, controller.signal);
      if (!resolved || controller.signal.aborted) return;
      if (resolved.artifact) {
        const url = new URL(location.href);
        const encodedProject = encodeURIComponent(resolved.artifact.projectId);
        url.pathname = `/editor/${encodedProject}`;
        url.searchParams.delete('page');
        url.searchParams.delete('project');
        url.searchParams.set('session', resolved.sessionId);
        if (!url.hash.startsWith(`#project/${encodedProject}`)) url.hash = `project/${encodedProject}`;
        writeWorkspaceHistory(url, true);
      }
      setReady({ ...resolved, previewLease });
    }
    void resolve().catch(err => {
      if (controller.signal.aborted) return;
      controller.abort();
      setRouteError(classifyRouteError(err));
    });
    if (projectId && validWorkspaceProject(projectId) && (sessionId === null || validWorkspaceProject(sessionId))
      && new URLSearchParams(location.search).get('templates') !== '1') {
      // Start the small route and grant requests before the editor chunks fill the connection.
      const origin = isolatedPreviewOrigin();
      if (origin) previewLease = preparePreviewLease(projectId, origin, controller.signal);
      preloadMotionProjectEditor();
      void host?.preloadEditorHost?.().catch(() => {}); // The mounted host retries the import.
    }
    return () => controller.abort();
  }, [route, attempt, libraryOnly, settingsPage, host]);
  const closeLibrary = () => {
    setLibraryOnly(false);
  };
  const onInvalidProject = useCallback((staleId: string) => {
    setRoute(previous => (previous.projectId === staleId ? { ...previous, projectId: null } : previous));
    setReady(previous => (previous?.artifact?.projectId === staleId ? null : previous));
    if (typeof window === 'undefined') return;
    const url = new URL(location.href);
    if (!isStandaloneSpaPath(url.pathname, url.search, url.hash) && !isNotFoundSpaPath(url.pathname, url.search, url.hash)) {
      return;
    }
    let changed = false;
    if (url.searchParams.get('project') === staleId) {
      url.searchParams.delete('project');
      changed = true;
    }
    if (parseProjectIdFromHash(url.hash) === staleId) {
      url.hash = '';
      changed = true;
    }
    if (changed) {
      writeWorkspaceHistory(url, true);
    }
  }, []);
  const shellLoading = !ready && !routeError && !libraryOnly && !settingsPage;
  return <WorkspaceFrame waitForSaves={noPendingSaves} projectId={ready?.artifact?.projectId ?? (routeError ? undefined : projectId ?? undefined)}
    sessionId={libraryOnly ? undefined : ready?.sessionId ?? sessionId ?? undefined} onNavigate={onNavigate}
    onInvalidProject={onInvalidProject}
    blocked={shellLoading} onLibraryClose={libraryOnly ? closeLibrary : undefined}>
    <div className="motion-project-surface">
      <EditorOpeningGateHost
        shellLoading={shellLoading}
        suppressed={Boolean(routeError) || libraryOnly || settingsPage}
        targetProjectId={ready?.artifact?.projectId ?? null}
      >
        {routeError?.kind === 'auth_required' ? (
          <ProjectAuthRequiredScreen sessionExpired={routeError.sessionExpired} />
        ) : routeError?.kind === 'auth_unavailable' ? (
          <ProjectAuthUnavailableScreen onRetry={() => retry(value => value + 1)} />
        ) : routeError?.kind === 'workspace_not_found' ? (
          <ProjectWorkspaceNotFoundScreen onRetry={() => retry(value => value + 1)} />
        ) : routeError ? (
          <>
            <div className="motion-home-navigation"><WorkspaceMenuButton /></div>
            <RecoveryScreen title={t('Could not open project')} message={routeError.message}>
              <Button variant="ghost" className="om-button h-auto" data-primary onClick={() => retry(value => value + 1)}>{t('Retry')}</Button>
              <a className="om-button" href="/editor">{t('Open active project')}</a>
            </RecoveryScreen>
          </>
        ) : ready ? ready.artifact ? (
            <InitialPreviewLeaseContext.Provider value={previewScope}>
              <EditorOpeningHeadContext.Provider value={ready.openingHead}>
                <ArtifactViewer key={ready.artifact.projectId} artifact={ready.artifact} />
              </EditorOpeningHeadContext.Provider>
            </InitialPreviewLeaseContext.Provider>
          ) : <div className="motion-route-state"><WorkspaceMenuButton />{t('Create a project with your Agent to start editing.')}</div>
          : libraryOnly ? <TemplateLibraryLanding /> : null}
      </EditorOpeningGateHost>
    </div>
  </WorkspaceFrame>;
}

function ProjectAuthRequiredScreen({ sessionExpired }: { sessionExpired: boolean }) {
  const { t } = useI18n();
  const handleSignIn = () => {
    const loginUrl = buildLoginUrl();
    if (isDesktopApp()) {
      void startDesktopBrowserLogin({ loginUrl });
      return;
    }
    window.location.assign(loginUrl);
  };
  return (
    <>
      <div className="motion-home-navigation"><WorkspaceMenuButton /></div>
      <section className="om-recovery-screen" data-testid="project-auth-required">
        <div className="om-recovery-surface">
          <div className="om-recovery-content">
            <RemixIcon name="lock-line" size={32} />
            <h1 className="om-title">
              {t(sessionExpired ? 'Sign in again to open this project' : 'Sign in to open this project')}
            </h1>
            <p className="om-muted">
              {t(
                sessionExpired
                  ? 'Your session has expired. Sign in again to open this project.'
                  : 'Sign in with OpenDesign to open this project.',
              )}
            </p>
            <div className="om-recovery-actions">
              <Button variant="ghost" className="om-button h-auto" data-primary onClick={handleSignIn}>
                <RemixIcon name="login-box-line" size={16} />
                {t(sessionExpired ? 'Sign in again' : 'Sign in with OpenDesign')}
              </Button>
              <a className="om-button" href="/explore">{t('Explore')}</a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function ProjectAuthUnavailableScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="motion-home-navigation"><WorkspaceMenuButton /></div>
      <section className="om-recovery-screen" data-testid="project-auth-unavailable">
        <div className="om-recovery-surface">
          <div className="om-recovery-content">
            <RemixIcon name="wifi-off-line" size={32} />
            <p className="om-muted">
              {t('Temporarily unable to verify your login status. Your session and drafts are preserved — please retry shortly.')}
            </p>
            <div className="om-recovery-actions">
              <Button variant="ghost" className="om-button h-auto" data-primary onClick={onRetry}>
                {t('Retry')}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function ProjectWorkspaceNotFoundScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  const { openAccountSettings } = useWorkspaceChrome();
  return (
    <>
      <div className="motion-home-navigation"><WorkspaceMenuButton /></div>
      <section className="om-recovery-screen" data-testid="project-workspace-not-found">
        <div className="om-recovery-surface">
          <div className="om-recovery-content">
            <span className="motion-loading-mark om-recovery-mark" aria-hidden="true" />
            <h1 className="om-title">{t('Project not in current workspace')}</h1>
            <p className="om-muted">
              {t('This project is not in your current workspace. Switch workspaces or accounts in Account settings, then try again.')}
            </p>
            <div className="om-recovery-actions">
              {openAccountSettings && (
                <Button variant="ghost" className="om-button h-auto" data-primary onClick={openAccountSettings}>
                  {t('Account settings')}
                </Button>
              )}
              <Button variant="ghost" className="om-button h-auto" onClick={onRetry}>
                {t('Retry')}
              </Button>
              <a className="om-button" href="/explore">{t('Explore')}</a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function TemplateLibraryLanding() {
  const { t } = useI18n();
  const { openLibrary } = useWorkspaceChrome();
  return <div className="motion-route-state"><WorkspaceMenuButton /><h1>{t('Template library')}</h1>
    <Button variant="plain" className="motion-button" onClick={event => openLibrary(event.currentTarget)}>{t('View all templates')}</Button>
  </div>;
}
