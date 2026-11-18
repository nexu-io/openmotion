import { useProjectArchives, ProjectArchiveMenu, type ProjectArchiveActions } from './ProjectArchives';
import { AssetsPage } from './AssetsPage';
import { SkillsPage } from './SkillsPage';
import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18n';
import { ConnectionDialog } from './ConnectionDialog';
import { MotionIcon } from './icons';
import { RemixIcon } from '../icons/RemixIcons';
import { navigateWorkspace, useWorkspace } from './useWorkspace';
import { Tooltip } from '../components/ui/Tooltip';
import { Dialog } from '@base-ui/react/dialog';
import { StudioConnectionToast } from '../components/StudioConnectionToast';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { isConnectionFailure } from '../components/ui/errorNoticeMessage';
import { preservePresentation, workspacePresentation } from '../../../shared/workspace-url';
import { trackMotion } from './tracking';
import { ApplicationHeader, ApplicationRail } from './ApplicationChrome';
import { SettingsCenter, type SettingsSection } from './SettingsCenter';
import { SettingsSurfaceBoundary } from './SettingsSurfaceBoundary';
import { McpConnectionPage } from './McpConnectionPage';
import type { McpEntry } from './pageTracking';
import { WorkspaceHomeButton } from './WorkspaceHomeButton';
import { Skeleton } from '../components/ui/Skeleton';
import { readWorkspacePage, workspacePageHref, type WorkspacePage } from './workspacePageRouting';
import { WORKSPACE_LOCATION_CHANGED, writeWorkspaceHistory } from '../utils/workspaceHistory';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { BrandKitPage } from './BrandKitPage';
import { clickMethod, searchStarted, trackStudioClick } from './editorTracking';

// Settings shares the model-picker dependencies. Keep it in the loaded shell so
// an open editor never requests a removed Settings chunk after a local rebuild.

import { WorkspaceChromeContext, useWorkspaceChrome, type WorkspaceChrome, type EditorGuard } from './WorkspaceChromeContext';
export { useWorkspaceChrome, useOptionalWorkspaceChrome, type EditorGuard } from './WorkspaceChromeContext';

export function WorkspaceFrame({ children, waitForSaves, projectId, sessionId, blocked = false, message = '', saveState = '', onLibraryClose, onNavigate }: {
  children: ReactNode; waitForSaves: () => Promise<void>; projectId?: string; sessionId?: string; blocked?: boolean; message?: string; saveState?: string; onLibraryClose?: () => void; onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState(() => readWorkspacePage(location.search));
  const { settings, assets: assetsOpen, skills: skillsOpen, templates: connectionsOpen } = page;
  // Skills is a full page like Assets: it covers the editor without unmounting it.
  const pageOpen = assetsOpen || skillsOpen;
  const libraryOpen = useRef(connectionsOpen);
  const libraryClosed = useRef(onLibraryClose); libraryClosed.current = onLibraryClose;
  useEffect(() => {
    const sync = () => {
      const next = readWorkspacePage(location.search);
      if (libraryOpen.current && !next.templates) libraryClosed.current?.();
      libraryOpen.current = next.templates;
      setPage(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    window.addEventListener(WORKSPACE_LOCATION_CHANGED, sync);
    return () => window.removeEventListener(WORKSPACE_LOCATION_CHANGED, sync);
  }, []);
  const navigatePage = useCallback((patch: Partial<WorkspacePage>) => {
    writeWorkspaceHistory(workspacePageHref(location.href, patch));
  }, []);
  const presentation = workspacePresentation(location.search);
  const guard = useRef<EditorGuard | null>(null);
  const [editorState, setEditorState] = useState<Pick<EditorGuard, 'blocked' | 'saveState' | 'message'> | null>(null);
  const registerEditor = useCallback((value: EditorGuard | null) => {
    guard.current = value;
    setEditorState(previous => previous?.blocked === value?.blocked && previous?.saveState === value?.saveState && previous?.message === value?.message ? previous : value);
  }, []);
  const beforeViewChange = useCallback(async () => {
    if (guard.current?.blocked) throw new Error(guard.current.message || t('Working…'));
    await (guard.current?.waitForSaves ?? waitForSaves)();
  }, [waitForSaves, t]);
  const navigate = useCallback((url: string, replace = false) => {
    if (!onNavigate) { navigateWorkspace(url, replace); return; }
    const target = preservePresentation(url, location.search);
    writeWorkspaceHistory(target, replace);
    onNavigate();
  }, [onNavigate]);
  const workspace = useWorkspace(beforeViewChange, projectId, sessionId, navigate);
  const navigationToast = useToast();
  useEffect(() => {
    if (!workspace.navigationError) return;
    const id = navigationToast.showToast(workspace.navigationError.message, 'error', 'feedback');
    return () => navigationToast.dismissToast(id);
  }, [workspace.navigationError, navigationToast.showToast, navigationToast.dismissToast]);
  const connectionEntry = useRef<McpEntry>('direct_link');
  // A later visit through history or a pasted link has no control behind it.
  useEffect(() => { if (settings !== 'mcp') connectionEntry.current = 'direct_link'; }, [settings]);
  const libraryTrigger = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1000);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1000);
  const [projectQuery, setProjectQuery] = useState('');
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => {
    try { return localStorage.getItem('motion.workspace.navigation.v1') === 'collapsed'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('motion.workspace.navigation.v1', navigationCollapsed ? 'collapsed' : 'expanded'); }
    catch { /* Navigation remains usable when browser storage is unavailable. */ }
  }, [navigationCollapsed]);
  const toggleSidebar = useCallback(() => {
    if (navigationCollapsed) { setNavigationCollapsed(false); setSidebarOpen(true); }
    else setSidebarOpen(open => !open);
  }, [navigationCollapsed]);
  const [assetsVisited, setAssetsVisited] = useState(assetsOpen);
  useEffect(() => { if (assetsOpen) setAssetsVisited(true); }, [assetsOpen]);
  const openAssets = useCallback(() => { navigatePage({ assets: true, skills: false, settings: null, templates: false }); }, [navigatePage]);
  const openSkills = useCallback(() => { navigatePage({ skills: true, assets: false, settings: null, templates: false }); }, [navigatePage]);
  const openSettings = useCallback((section: SettingsSection) => {
    navigatePage({ settings: section, assets: false, skills: false, templates: false }); if (narrow) setSidebarOpen(false);
  }, [narrow, navigatePage]);
  const homeRef = useRef<HTMLDivElement>(null);
  const openHome = useCallback(() => {
    navigatePage({ settings: null, assets: false, skills: false, templates: false });
    setNavigationCollapsed(false);
    setSidebarOpen(true);
    // Returning home keeps the current editor mounted. The mobile drawer owns
    // its focus; on desktop, move focus off the departing settings controls.
    if (!narrow) requestAnimationFrame(() => homeRef.current?.querySelector<HTMLButtonElement>('.om-app-rail [aria-pressed="true"]')?.focus());
  }, [narrow, navigatePage]);
  const toggleHome = useCallback(() => {
    if (settings || pageOpen) openHome();
    else toggleSidebar();
  }, [settings, pageOpen, openHome, toggleSidebar]);
  useEffect(() => {
    const open = () => openSettings('local');
    window.addEventListener('motion:agents-open', open);
    return () => window.removeEventListener('motion:agents-open', open);
  }, [openSettings]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 999px)');
    const update = () => { setNarrow(query.matches); if (query.matches) setSidebarOpen(false); };
    query.addEventListener('change', update); return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); openSettings('general'); }
      if (event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); navigatePage({ settings: null, assets: false, skills: false, templates: false }); toggleSidebar(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [openSettings, toggleSidebar, navigatePage]);
  const libraryBusy = workspace.busy || blocked || Boolean(editorState?.blocked);
  const switchingDisabled = libraryBusy || !workspace.status;
  const archives = useProjectArchives(workspace, beforeViewChange, switchingDisabled, () => { if (narrow) setSidebarOpen(false); });
  const reconnecting = Boolean(workspace.connectionError && isConnectionFailure(workspace.connectionError));
  const workspaceNotice = workspace.errorSource === 'connection' && reconnecting ? '' : workspace.error;
  const notice = workspaceNotice || message || editorState?.message || "";
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const noticeKey = `${workspaceNotice ? workspace.errorSource : 'editor'}:${notice || ''}`;
  // Hiding a notice never clears an editor's write guard. New errors reset the dismissal.
  const visibleNotice = notice && dismissedNotice !== noticeKey;
  if (!notice && dismissedNotice !== null) setDismissedNotice(null);
  const value: WorkspaceChrome = { workspace, switchingDisabled, saveState: editorState?.saveState || saveState, registerEditor, beforeViewChange,
    openLibrary: (trigger, templateId) => { libraryTrigger.current = trigger ?? null; workspace.clearError(); navigatePage({ templates: true, template: templateId ?? null }); },
    openConnections: entry => { connectionEntry.current = entry; openSettings('mcp'); },
    openModelSettings: () => openSettings('providers'),
    openHome, openAssets, assetsOpen: assetsOpen && !settings, openSkills, skillsOpen: skillsOpen && !settings, toggleSidebar, sidebarOpen, navigationCollapsed,
    toggleNavigation: () => setNavigationCollapsed(collapsed => !collapsed), settingsOpen: Boolean(settings) || pageOpen };
  return <WorkspaceChromeContext.Provider value={value}>
    <StudioToastViewport {...navigationToast} />
    <StudioConnectionToast reconnecting={reconnecting} />
    {archives.manager}
    <Dialog.Root open={sidebarOpen && narrow && !settings && !pageOpen && !navigationCollapsed} onOpenChange={setSidebarOpen}>
    <div ref={homeRef} className="om-application" data-embedded={presentation.embedded} data-host-chrome={window.parent !== window && new URLSearchParams(location.search).get('hostChrome') === '1'} data-navigation-collapsed={navigationCollapsed}>
      <ApplicationHeader settings={settings} />
      <ApplicationRail settings={settings} openSettings={openSettings} home={<WorkspaceHomeButton
        applicationRef={homeRef}
        active={!settings && !pageOpen} expanded={sidebarOpen && !settings && !pageOpen && !navigationCollapsed}
        previewEnabled={!narrow && !sidebarOpen && !settings && !pageOpen && !navigationCollapsed && !connectionsOpen}
        onToggle={toggleHome}>
        {close => <WorkspaceSidebar archives={archives} currentId={projectId} close={close} expand={() => { close(); toggleSidebar(); }} onNavigate={close} query={projectQuery} setQuery={setProjectQuery} />}
      </WorkspaceHomeButton>} />
      <div className="motion-workspace">
      <Dialog.Portal>
        <Dialog.Backdrop className="hf-overlay-backdrop motion-sidebar-backdrop" />
        <Dialog.Popup id="om-project-navigation" className="motion-sidebar-drawer" aria-label={t('Project list')} onKeyDown={event => event.stopPropagation()}>
          <WorkspaceSidebar archives={archives} currentId={projectId} close={() => setSidebarOpen(false)} query={projectQuery} setQuery={setProjectQuery} />
        </Dialog.Popup>
      </Dialog.Portal>
      {!narrow && !settings && !pageOpen && <div id="om-project-navigation" className="om-project-navigation om-collapsible" data-collapsed={!sidebarOpen || navigationCollapsed} aria-hidden={!sidebarOpen || navigationCollapsed} inert={!sidebarOpen || navigationCollapsed}>
        <WorkspaceSidebar archives={archives} currentId={projectId} close={() => setSidebarOpen(false)} query={projectQuery} setQuery={setProjectQuery} />
      </div>}
      <div className="motion-workspace-content" hidden={Boolean(settings) || pageOpen} inert={Boolean(settings) || pageOpen}>
        {visibleNotice && <ErrorNotice key={noticeKey} message={notice}
          onDismiss={() => { setDismissedNotice(noticeKey); if (workspaceNotice) workspace.clearError(); }} />}
        {children}
      </div>
      {(assetsVisited || assetsOpen) && <div className="om-assets-host" hidden={!assetsOpen || Boolean(settings)} inert={!assetsOpen || Boolean(settings)}><AssetsPage hasProject={Boolean(projectId)} active={assetsOpen && !settings} /></div>}
      {skillsOpen && !settings && <div className="om-skills-host"><SkillsPage skillId={page.skill} onSkillChange={skill => navigatePage({ skill })} hasProject={Boolean(projectId)} /></div>}
      {settings && <SettingsSurfaceBoundary key={settings}>{settings === 'brand-kit'
        ? <BrandKitPage onClose={() => navigatePage({ settings: null })} selectedId={page.brandKit} onSelect={brandKit => navigatePage({ brandKit })} previewsEnabled={!connectionsOpen} hasProject={Boolean(projectId)} /> : settings === 'mcp'
        ? <McpConnectionPage entry={connectionEntry.current} hasProject={Boolean(projectId)} previewsEnabled={!connectionsOpen} openLibrary={value.openLibrary} openProviders={value.openModelSettings} route={page} onRouteChange={navigatePage} />
        : <SettingsCenter hasProject={Boolean(projectId)} navigationCollapsed={navigationCollapsed} section={settings} onSection={openSettings} openConnections={value.openConnections} providerId={page.provider} onProviderChange={provider => navigatePage({ provider })} />}</SettingsSurfaceBoundary>}
      </div>
    </div>
    </Dialog.Root>
    {connectionsOpen && <ConnectionDialog open projectId={projectId} returnFocus={libraryTrigger.current} section="templates" templateId={page.template} onTemplateChange={template => navigatePage({ template })} busy={libraryBusy} openingDisabled={switchingDisabled} error={workspace.error} onClose={() => navigatePage({ templates: false })} onOpen={id => { if (!switchingDisabled) void (sessionId ? workspace.createArtifact(sessionId, id) : workspace.startSession(undefined, id)); }} />}
  </WorkspaceChromeContext.Provider>;
}

function WorkspaceSidebar({ archives, currentId, close, expand, query, setQuery, onNavigate }: {
  archives: ProjectArchiveActions; currentId?: string; close: () => void; expand?: () => void; query: string; setQuery: (query: string) => void; onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const { workspace, switchingDisabled } = useWorkspaceChrome();
  const projects = workspace.projects;
  const filtered = projects.filter(project => project.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const loadingProjects = !workspace.status && !workspace.error && projects.length === 0;
  return <aside className="motion-sidebar" aria-label={t('Workspace navigation')}>
    <div className="motion-sidebar-brand">
      <strong className="om-subtitle">{t('Home')}</strong>
      {/* Collapsing the docked navigation toggles it back with the workspace menu button, so this icon-only control keeps a state-aware tooltip in both states. */}
      <Tooltip label={t(expand ? 'Open project list' : 'Close project list')} wrap><button type="button" className="motion-icon-button" onClick={expand ?? close} aria-expanded={!expand} aria-controls="om-project-navigation" aria-label={t(expand ? 'Open project list' : 'Close project list')}><MotionIcon name="sidebar" size={16} /></button></Tooltip>
    </div>
    <div className="motion-session-heading">
      <span>{t('Projects')}</span>
      <Tooltip label={t('New project')}>
        <button type="button" className="motion-icon-button" aria-label={t('New project')} disabled={switchingDisabled} onClick={event => {
          void trackMotion('ui_click', { page_name: 'studio', area: 'workspace', element: 'new_creation', interaction_method: event.detail === 0 ? 'keyboard' : 'pointer' });
          void workspace.create();
          onNavigate?.();
        }}>
          <MotionIcon name="plus" size={16} />
        </button>
      </Tooltip>
    </div>
    <label className="motion-session-search"><MotionIcon name="search" /><input type="search" value={query} onChange={event => { if (searchStarted(query, event.target.value)) trackStudioClick('project_drawer', 'project_search', currentId); setQuery(event.target.value); }} placeholder={t('Search projects…')} aria-label={t('Search projects')} /></label>
    <nav className="motion-session-list" aria-label={t('Project list')} aria-busy={loadingProjects}>
      {loadingProjects && ['75%', '55%', '65%'].map(width => <div key={width} className="motion-session pointer-events-none" data-testid="project-list-skeleton" aria-hidden="true">
        <Skeleton style={{ width, height: 'var(--motion-space-16)' }} />
      </div>)}
      {workspace.status && !filtered.length && <p className="motion-session-empty">{t(query ? 'No matching projects' : 'Create a project with your Agent to start editing.')}</p>}
      {filtered.map(project => <div key={project.id} className="om-project-sidebar-row om-nav-row" data-active={currentId === project.id}><Tooltip label={project.title} wrap><button aria-label={project.title} className="motion-session om-nav-row-link" aria-current={currentId === project.id ? 'page' : undefined}
        disabled={switchingDisabled} onClick={event => {
          if (project.id === currentId) return;
          void trackMotion('ui_click', { page_name: 'studio', area: 'workspace', element: 'open_project', interaction_method: event.detail === 0 ? 'keyboard' : 'pointer' });
          void workspace.open('projects', project.id);
          onNavigate?.();
        }}>
        <span className="motion-session-dot" aria-hidden="true" /><span><strong>{project.title}</strong></span>
      </button></Tooltip><ProjectArchiveMenu projectId={project.id} title={project.title} archives={archives} /></div>)}
    </nav>
    <div className="motion-sidebar-footer">
      <button className="om-nav-item" type="button" onClick={archives.showManager}><RemixIcon name="folder-open-line" size={18} />{t('All projects')}</button>
      <button className="om-nav-item" type="button" disabled={archives.locked} onClick={archives.chooseImport}><RemixIcon name="upload-2-line" size={18} />{t(archives.busy === 'import' ? 'Importing…' : 'Import projects')}</button>
    </div>
  </aside>;
}

export function WorkspaceMenuButton() {
  const { t } = useI18n();
  const { toggleSidebar, sidebarOpen, navigationCollapsed, workspace } = useWorkspaceChrome();
  const visible = sidebarOpen && !navigationCollapsed;
  // Collapsing the docked navigation is a toggle, not a dismiss, so the icon-only
  // control keeps its tooltip in both states like the app-sidebar toggle.
  return <Tooltip label={t(visible ? 'Collapse project list' : 'Open project list')} wrap><button className="motion-icon-button motion-workspace-menu" onClick={event => { if (!visible) trackStudioClick('header', 'open_project_drawer', workspace.status?.projectId, clickMethod(event)); toggleSidebar(); }} aria-expanded={visible} aria-label={t(visible ? 'Collapse project list' : 'Open project list')}><MotionIcon name="sidebar" size={16} /></button></Tooltip>;
}
