import { Button } from 'open-design-ui/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18n';
import { WorkspaceFrame, WorkspaceMenuButton, useWorkspaceChrome } from './WorkspaceFrame';
import { motionApi, type ProjectCatalog } from './useWorkspace';
import { requestedProject, validWorkspaceProject } from './workspaceRouting';
import type { SessionDetail, SessionArtifact } from '../../../shared/session';
import { ArtifactViewer } from './ArtifactViewer';
import { EditorLoading, readEditorLoadingLayout, type EditorLoadingLayout } from './EditorLoading';
import { RecoveryScreen } from '../components/RecoveryScreen';
import { trackMotion } from './tracking';
import { WORKSPACE_LOCATION_CHANGED, writeWorkspaceHistory } from '../utils/workspaceHistory';
import { isWorkspaceSettingsPage } from '../../../shared/workspace-url';

const noPendingSaves = async () => {};

export async function resolveWorkspaceProject(id: string, signal: AbortSignal) {
  if (!validWorkspaceProject(id)) throw new Error('项目链接无效');
  const catalog = await motionApi<ProjectCatalog>('/projects', { signal });
  if (!catalog.projects.some(project => project.id === id)) throw new Error('项目不存在，请从左侧列表选择一个项目。');
  signal.throwIfAborted();
  await motionApi('/preview/open', { method: 'POST', signal }, id);
}

/** Resolve the native service before mounting any editor that could read or save files. */
export function MotionApp() {
  const { t } = useI18n();
  const [route, setRoute] = useState(() => ({ projectId: requestedProject(location.search, location.hash), sessionId: new URLSearchParams(location.search).get('session') }));
  const { projectId, sessionId } = route;
  const [settingsPage, setSettingsPage] = useState(() => isWorkspaceSettingsPage(location.search, location.hash));
  useEffect(() => {
    const sync = () => setSettingsPage(isWorkspaceSettingsPage(location.search, location.hash));
    window.addEventListener(WORKSPACE_LOCATION_CHANGED, sync);
    return () => window.removeEventListener(WORKSPACE_LOCATION_CHANGED, sync);
  }, []);
  const [libraryOnly, setLibraryOnly] = useState(() => new URLSearchParams(location.search).get('templates') === '1' && projectId === null && !sessionId);
  const [ready, setReady] = useState<{ sessionId: string; artifact?: SessionArtifact } | null>(null);
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  const surface = useRef<HTMLDivElement>(null);
  const [loadingLayout, setLoadingLayout] = useState<EditorLoadingLayout | null>(null);
  const onNavigate = useCallback(() => {
    const layout = readEditorLoadingLayout(surface.current);
    if (layout) setLoadingLayout(layout);
    setReady(null);
    setError('');
    setLibraryOnly(new URLSearchParams(location.search).get('templates') === '1');
    setRoute({ projectId: requestedProject(location.search, location.hash), sessionId: new URLSearchParams(location.search).get('session') });
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
    setError('');
    async function resolve() {
      const catalog = await motionApi<ProjectCatalog>('/projects', { signal: controller.signal });
      controller.signal.throwIfAborted();
      const targetProject = projectId ?? (sessionId ? null : catalog.activeId);
      // The first-run placeholder has no native source yet. Browsing must not create it.
      // Existing projects can prepare behind the modal without changing the active project.
      if (libraryOnly && targetProject === 'project') return;
      const id = sessionId ?? catalog.sessions?.find(item => item.artifacts.some(artifact => artifact.projectId === targetProject))?.id;
      if (!id || !validWorkspaceProject(id)) throw new Error('会话不存在');
      const session = await motionApi<SessionDetail>(`/sessions/${id}`, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!session.artifacts.length && projectId === null) { setReady({ sessionId: id }); return; }
      const artifact = session.artifacts.find(item => item.projectId === targetProject) ?? (targetProject === null ? session.artifacts.find(item => item.id === session.activeArtifactId) ?? session.artifacts[0] : undefined);
      if (!artifact) throw new Error('该产物不属于此会话');
      await resolveWorkspaceProject(artifact.projectId, controller.signal);
      if (controller.signal.aborted) return;
      const url = new URL(location.href); url.searchParams.set('session', id); url.searchParams.set('project', artifact.projectId);
      if (!url.hash.startsWith(`#project/${artifact.projectId}`)) url.hash = `project/${artifact.projectId}`;
      writeWorkspaceHistory(url, true);
      setReady({ sessionId: id, artifact });
    }
    void resolve().catch(err => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [route, attempt, libraryOnly, settingsPage]);
  const closeLibrary = () => {
    setLibraryOnly(false);
  };
  return <WorkspaceFrame waitForSaves={noPendingSaves} projectId={ready?.artifact?.projectId ?? (error ? undefined : projectId ?? undefined)}
    sessionId={libraryOnly ? undefined : ready?.sessionId ?? sessionId ?? undefined} onNavigate={onNavigate}
    blocked={!ready && !error && !libraryOnly && !settingsPage} onLibraryClose={libraryOnly ? closeLibrary : undefined}>
    <div ref={surface} className="motion-project-surface">
    {error ? <><div className="motion-home-navigation"><WorkspaceMenuButton /></div><RecoveryScreen title={t('Could not open project')} message={error}><Button variant="ghost" className="om-button h-auto" data-primary onClick={() => retry(value => value + 1)}>{t('Retry')}</Button><a className="om-button" href="/?page=editor">{t('Open active project')}</a></RecoveryScreen></>
      : ready ? ready.artifact ? <ArtifactViewer key={ready.artifact.projectId} artifact={ready.artifact} loadingLayout={loadingLayout} /> : <div className="motion-route-state"><WorkspaceMenuButton />{t('Create a project with your Agent to start editing.')}</div>
      : libraryOnly ? <TemplateLibraryLanding /> : <EditorLoading layout={loadingLayout} />}
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
