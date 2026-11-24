import { isolatedPreviewOrigin, preparePreviewLease, type PreparedPreviewLease } from "../player/lib/previewLease";
import { InitialPreviewLeaseContext, useStudioHost } from "./StudioHost";
import { Button } from 'open-design-ui/button';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInRouterContext, useLocation } from 'react-router';
import { useI18n } from '../i18n/I18n';
import { WorkspaceFrame, WorkspaceMenuButton, useWorkspaceChrome } from './WorkspaceFrame';
import { requestedProject, validWorkspaceProject, type WorkspaceRoute } from './workspaceRouting';
import { resolveWorkspaceRoute } from './resolveWorkspaceRoute';
import { preloadMotionProjectEditor } from './MotionProjectEditor';
import { ArtifactViewer } from './ArtifactViewer';
import { EditorOpeningGateHost } from './editorOpeningGate';
import { RecoveryScreen } from '../components/RecoveryScreen';
import { trackMotion } from './tracking';
import { writeWorkspaceHistory } from '../utils/workspaceHistory';
import { editorProjectIdFromPath, isNotFoundSpaPath, isStandaloneSpaPath } from '../../../shared/spa-routes';
import { StudioRouterProvider } from '../router/createAppRouter';
import { readWorkspacePage } from './workspacePageRouting';

const noPendingSaves = async () => {};

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
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  const onNavigate = useCallback((targetHref?: string, opened?: WorkspaceRoute) => {
    const target = targetHref ? new URL(targetHref, location.origin) : new URL(location.href);
    const nextPage = readWorkspacePage(target.search, target.hash, target.pathname);
    setReady(opened ?? null);
    setError('');
    setLibraryOnly(nextPage.templates);
    setRoute({
      projectId: editorProjectIdFromPath(target.pathname) ?? requestedProject(target.search, target.hash),
      sessionId: target.searchParams.get('session'),
    });
  }, []);
  const view = useRef({ id: crypto.randomUUID(), started: performance.now(), sent: false });
  useEffect(() => {
    if (view.current.sent || (!ready && !error && !libraryOnly)) return;
    view.current.sent = true;
    const embedded = new URLSearchParams(location.search).get('embed') === '1';
    if (ready || libraryOnly) void trackMotion('page_view', { page_name: 'studio', view_id: view.current.id, embedded, has_project: Boolean(ready?.artifact) });
    if (error) void trackMotion('studio_load_result', { load_id: view.current.id, outcome: 'failure', embedded,
      duration_ms: Math.min(86_400_000, Math.round(performance.now() - view.current.started)) });
  }, [projectId, sessionId, ready, error, libraryOnly]);
  useEffect(() => {
    if (ready || settingsPage) return;
    const controller = new AbortController();
    let previewLease: PreparedPreviewLease | undefined;
    if (projectId && validWorkspaceProject(projectId) && (sessionId === null || validWorkspaceProject(sessionId))
      && new URLSearchParams(location.search).get('templates') !== '1') {
      preloadMotionProjectEditor();
      host?.preloadEditorHost?.();
      const origin = isolatedPreviewOrigin();
      if (origin) previewLease = preparePreviewLease(projectId, origin, controller.signal);
    }
    setError('');
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
      setError((err as Error).message);
    });
    return () => controller.abort();
  }, [route, attempt, libraryOnly, settingsPage, host]);
  const closeLibrary = () => {
    setLibraryOnly(false);
  };
  const shellLoading = !ready && !error && !libraryOnly && !settingsPage;
  return <WorkspaceFrame waitForSaves={noPendingSaves} projectId={ready?.artifact?.projectId ?? (error ? undefined : projectId ?? undefined)}
    sessionId={libraryOnly ? undefined : ready?.sessionId ?? sessionId ?? undefined} onNavigate={onNavigate}
    blocked={shellLoading} onLibraryClose={libraryOnly ? closeLibrary : undefined}>
    <div className="motion-project-surface">
      <EditorOpeningGateHost
        shellLoading={shellLoading}
        suppressed={Boolean(error) || libraryOnly || settingsPage}
        targetProjectId={ready?.artifact?.projectId ?? null}
      >
        {error ? <><div className="motion-home-navigation"><WorkspaceMenuButton /></div><RecoveryScreen title={t('Could not open project')} message={error}><Button variant="ghost" className="om-button h-auto" data-primary onClick={() => retry(value => value + 1)}>{t('Retry')}</Button><a className="om-button" href="/editor">{t('Open active project')}</a></RecoveryScreen></>
          : ready ? ready.artifact ? (
            <InitialPreviewLeaseContext.Provider value={previewScope}>
              <ArtifactViewer key={ready.artifact.projectId} artifact={ready.artifact} />
            </InitialPreviewLeaseContext.Provider>
          ) : <div className="motion-route-state"><WorkspaceMenuButton />{t('Create a project with your Agent to start editing.')}</div>
          : libraryOnly ? <TemplateLibraryLanding /> : null}
      </EditorOpeningGateHost>
    </div>
  </WorkspaceFrame>;
}

function TemplateLibraryLanding() {
  const { t } = useI18n();
  const { openLibrary } = useWorkspaceChrome();
  return <div className="motion-route-state"><WorkspaceMenuButton /><h1>{t('Template library')}</h1>
    <Button variant="plain" className="motion-button" onClick={event => openLibrary(event.currentTarget)}>{t('View all templates')}</Button>
  </div>;
}
