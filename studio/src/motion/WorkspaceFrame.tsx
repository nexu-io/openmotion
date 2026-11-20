import { IconButton } from 'open-design-ui/icon-button';
import { Button } from 'open-design-ui/button';
import type { SkillCategory } from './skillCategories';
import { FieldInput } from "../components/ui/FormField";
import { DisclosureRow } from "../../../packages/design-system/react/DisclosureRow";
import { useProjectArchives, ProjectArchiveMenu, type ProjectArchiveActions } from './ProjectArchives';
import type { GalleryTemplate } from '../../../shared/catalog';
import type { McpClient } from './mcpClients';
import { CreativeNavigation } from './CreativeNavigation';
import { ExploreStudios } from './ExploreStudios';
import { creativeStudios, findMediaStudio, type CreativeStudio, type TechniqueStudio } from '../../../shared/studio-catalog';
import { DesignProjectEditor } from '../design/DesignProjectEditor';
import { DesignScenePage } from '../design/scenes/DesignScenePage';
import type { Modality } from '../../../shared/gateway';
import { motionStudio, scenesForStudio, studioDestination, studioDraftKey, type StudioDestination } from './creativeStudios';
import { ModelOverview } from './ModelOverview';
import { ModelHub } from './ModelHub';
import { CreativeWorkspace } from './CreativeWorkspace';
import { AssetsPage } from './AssetsPage';
import type { AssetDraft } from './AssetComposer';
import type { SkillParameters } from './skillCatalog';
import { MotionStudioPage } from './MotionStudioPage';
import { SkillsPage } from './SkillsPage';
import { reportBlackFridayEntry } from './templateLibraryTracking';
import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18n';
import { ConnectionDialog } from './ConnectionDialog';
import { MotionIcon } from './icons';
import { RemixIcon } from '../icons/RemixIcons';
import { navigateWorkspace, useWorkspace } from './useWorkspace';
import { prepareTemplateProject, TemplatePreparationBlockedError } from './templateHandoff';
import { Tooltip } from '../components/ui/Tooltip';
import { Dialog } from '@base-ui/react/dialog';
import { StudioConnectionToast } from '../components/StudioConnectionToast';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { isConnectionFailure } from '../components/ui/errorNoticeMessage';
import { preservePresentation, workspacePresentation } from '../../../shared/workspace-url';
import { trackMotion } from './tracking';
import { ApplicationHeader, WorkspaceUtilityActions } from './ApplicationChrome';
import { SettingsCenter, type SettingsSection } from './SettingsCenter';
import { SettingsSurfaceBoundary } from './SettingsSurfaceBoundary';
import { McpConnectionPage } from './McpConnectionPage';
import type { McpEntry } from './pageTracking';
import { WorkspaceProjectsButton } from './WorkspaceProjectsButton';
import { Skeleton } from '../components/ui/Skeleton';
import { readWorkspacePage, workspacePageHref, type WorkspacePage } from './workspacePageRouting';
import { WORKSPACE_LOCATION_CHANGED, workspaceHistoryIndex, writeWorkspaceHistory } from '../utils/workspaceHistory';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { BrandKitPage } from './BrandKitPage';
import { clickMethod, searchStarted, trackStudioClick } from './editorTracking';
import { reportCreativePageView, type CreativePage } from './exploreTracking';

// Settings shares the model-picker dependencies. Keep it in the loaded shell so
// an open editor never requests a removed Settings chunk after a local rebuild.

import { WorkspaceChromeContext, useWorkspaceChrome, type WorkspaceChrome, type EditorGuard } from './WorkspaceChromeContext';
export { useWorkspaceChrome, useOptionalWorkspaceChrome, type EditorGuard } from './WorkspaceChromeContext';

export function WorkspaceFrame({ children, waitForSaves, projectId, sessionId, blocked = false, message = '', saveState = '', onLibraryClose, onNavigate }: {
  children: ReactNode; waitForSaves: () => Promise<void>; projectId?: string; sessionId?: string; blocked?: boolean; message?: string; saveState?: string; onLibraryClose?: () => void; onNavigate?: () => void;
}) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(() => readWorkspacePage(location.search, location.hash));
  const { settings, assets: assetsOpen, skills: skillsOpen, templates: libraryRequested } = page;
  const detailOnly = Boolean(page.template) && !libraryRequested;
  const connectionsOpen = libraryRequested || detailOnly;
  const hostChrome = window.parent !== window && new URLSearchParams(location.search).get('hostChrome') === '1';
  const templatesPage = libraryRequested && !page.creators && !hostChrome;
  // Resource pages cover the editor without unmounting it.
  const pageOpen = templatesPage || page.motion || Boolean(page.designScene) || Boolean(page.modelOverview) || Boolean(page.modelHub) || Boolean(page.specialty) || page.explore || assetsOpen || skillsOpen || Boolean(page.studio);
  const lastExplore = useRef({ community: page.community, medium: page.medium });
  if (page.explore) lastExplore.current = { community: page.community, medium: page.medium };
  const [exploreVisited, setExploreVisited] = useState(page.explore);
  useEffect(() => { if (page.explore) setExploreVisited(true); }, [page.explore]);
  const skillBriefs = useRef(new Map<string, SkillParameters>());
  const studioDrafts = useRef(new Map<string, AssetDraft>());
  const [studioVisit, setStudioVisit] = useState(0);
  const libraryOpen = useRef(libraryRequested);
  const libraryClosed = useRef(onLibraryClose); libraryClosed.current = onLibraryClose;
  useEffect(() => {
    const sync = () => {
      const next = readWorkspacePage(location.search, location.hash);
      if (libraryOpen.current && !next.templates) libraryClosed.current?.();
      libraryOpen.current = next.templates;
      setPage(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    window.addEventListener(WORKSPACE_LOCATION_CHANGED, sync);
    return () => window.removeEventListener(WORKSPACE_LOCATION_CHANGED, sync);
  }, []);
  const navigatePage = useCallback((patch: Partial<WorkspacePage>, replace = false) => {
    writeWorkspaceHistory(workspacePageHref(location.href, patch), replace);
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
  const skillsTrigger = useRef<HTMLElement | null>(null);
  const skillsReturnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (skillsOpen) return;
    const trigger = skillsReturnFocus.current;
    skillsReturnFocus.current = null;
    skillsTrigger.current = null;
    if (page.explore && !page.templates) trigger?.focus({ preventScroll: true });
  }, [skillsOpen, page.explore, page.templates]);
  const cardPreview = useRef<{ template: GalleryTemplate; locale: string } | null>(null);
  const closeStandalonePreview = () => {
    // A card pushes one preview entry. Copied links start a new history session at index zero.
    if (onNavigate && (workspaceHistoryIndex() ?? 0) > 0) history.back();
    else writeWorkspaceHistory(workspacePageHref(location.href, { template: null }), true);
  };
  const collectionSkillTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (page.skill) return;
    if (page.templateCollection === 'black-friday') collectionSkillTrigger.current?.focus({ preventScroll: true });
    collectionSkillTrigger.current = null;
  }, [page.templateCollection, page.skill]);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1000);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1000);
  const [projectQuery, setProjectQuery] = useState('');
  const editorRoute = !settings && !pageOpen;
  const editorActive = editorRoute && !connectionsOpen;
  const motionTemplatesOpen = page.motion && !templatesPage && !settings;
  const workspaceRoute = editorRoute || motionTemplatesOpen;
  const workspaceActive = workspaceRoute && !connectionsOpen;
  useEffect(() => setSidebarOpen(workspaceRoute && !narrow), [workspaceRoute, narrow]);
  const navigationCollapsed = !workspaceActive;
  const toggleSidebar = useCallback(() => setSidebarOpen(open => !open), []);
  const openMotionTemplates = () => { navigatePage({ motion: true, templates: false }); if (narrow) setSidebarOpen(false); };
  const openEditor = () => { navigatePage({ motion: false, templates: false }); if (narrow) setSidebarOpen(false); };
  const [assetsVisited, setAssetsVisited] = useState(assetsOpen);
  useEffect(() => { if (assetsOpen) setAssetsVisited(true); }, [assetsOpen]);
  const openAssets = useCallback(() => { navigatePage({ assets: true, assetId: null, assetVersion: null, templates: false }); }, [navigatePage]);
  const openSkills = useCallback((skillCategory: SkillCategory | null = null, trigger?: HTMLElement) => {
    skillsTrigger.current = trigger ?? null;
    navigatePage({ skills: true, skill: null, skillCategory, templates: false });
  }, [navigatePage]);
  const openSettings = useCallback((section: SettingsSection) => {
    navigatePage({ settings: section, assets: false, skills: false, templates: false });
  }, [navigatePage]);
  const applicationRef = useRef<HTMLDivElement>(null);
  const openHome = useCallback(() => {
    navigatePage({ explore: true, community: null, medium: null, templates: false });
    requestAnimationFrame(() => applicationRef.current?.querySelector<HTMLButtonElement>('.om-app-brand')?.focus());
  }, [navigatePage]);
  useEffect(() => {
    const open = () => openSettings('local');
    window.addEventListener('motion:agents-open', open);
    return () => window.removeEventListener('motion:agents-open', open);
  }, [openSettings]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 999px)');
    const update = () => {
      // Close the desktop list in the same render that enables the modal drawer.
      if (query.matches) setSidebarOpen(false);
      setNarrow(query.matches);
    };
    query.addEventListener('change', update); return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); openSettings('general'); }
      if (workspaceActive && event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [workspaceActive, openSettings, toggleSidebar]);
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
    openLibrary: (trigger, template, collection) => {
      if (templatesPage && !page.creators && page.templateCollection === (collection ?? null) && !template) return;
      libraryTrigger.current = trigger ?? null;
      workspace.clearError();
      const openCollection = Boolean(collection) || !template;
      cardPreview.current = !openCollection && template ? { template, locale } : null;
      navigatePage({ templates: openCollection, template: template?.id ?? null, templateCollection: openCollection ? (collection ?? null) : null, creators: false, creator: null, ...(page.templateCollection === 'black-friday' && { skill: null }) });
    },
    openConnections: entry => { connectionEntry.current = entry; openSettings('mcp'); },
    openModelSettings: () => openSettings('providers'),
    openProviderSettings: provider => navigatePage({ settings: 'providers', provider, assets: false, skills: false, templates: false }),
    openAccountSettings: () => openSettings('account'),
    openSubscriptionSettings: () => openSettings('subscription'),
    openHome, openAssets, assetsOpen: assetsOpen && !settings && !templatesPage, openSkills, skillsOpen: skillsOpen && !settings, toggleSidebar, sidebarOpen, navigationCollapsed,
    projectNavigation: !hostChrome && workspaceActive ? <span className="motion-project-navigation-trigger" hidden={sidebarOpen && !narrow}>
      <WorkspaceProjectsButton applicationRef={applicationRef} expanded={sidebarOpen} previewEnabled={!narrow && !sidebarOpen} onToggle={toggleSidebar}>
        {close => <WorkspaceSidebar archives={archives} currentId={projectId} close={close} expand={() => { close(); toggleSidebar(); }} onNavigate={close} query={projectQuery} setQuery={setProjectQuery} openSettings={openSettings} templatesOpen={motionTemplatesOpen} openTemplates={openMotionTemplates} openEditor={openEditor} />}
      </WorkspaceProjectsButton>
    </span> : null,
    settingsOpen: Boolean(settings) || pageOpen };
  const openSkill = (skill: string) => {
    const specialty = creativeStudios.find((entry): entry is TechniqueStudio => entry.surface === 'techniques' && entry.techniques.some(id => id === skill));
    navigatePage({ ...(specialty ? { specialty } : { skills: true }), skill, templates: false, ...lastExplore.current });
  };
  const selectAssetRoute = useCallback((assetId: string | null, assetVersion: string | null) => {
    if (readWorkspacePage(location.search, location.hash).assets) navigatePage({ assetId, assetVersion });
  }, [navigatePage]);
  const openStudio = (studio: StudioDestination | null, seed?: string | AssetDraft) => {
    const skill = studio?.studio.surface === 'techniques' && typeof seed === 'object' ? page.skill : null;
    if (studio && seed) {
      studioDrafts.current.set(studioDraftKey(studio, skill), typeof seed === 'string'
        ? { modality: studio.scene.modality, prompt: seed, references: [] } : seed);
      setStudioVisit(number => number + 1);
    }
    navigatePage({ studio, skill, settings: null, assets: false, skills: false, templates: false, ...lastExplore.current });
  };
  const chooseStudio = (entry: CreativeStudio, kind?: Modality) => {
    if (entry.surface === 'techniques') navigatePage({ specialty: entry, skill: null, templates: false, ...lastExplore.current });
    else if (entry.surface === 'editor') navigatePage({ motion: true, templates: false, ...lastExplore.current });
    else if (page.studio?.studio.id === entry.id && (!kind || page.studio.scene.modality === kind)) {
      openStudio(studioDestination(entry, page.studio.scene.id, page.studio.model));
    } else openStudio(studioDestination(entry, scenesForStudio(entry).find(scene => scene.modality === kind)?.id));
  };
  const openModel = (modelOverview: string) => navigatePage({ modelOverview, templates: false, ...lastExplore.current });
  const openModelHub = (modelHub: string) => navigatePage({ modelHub, templates: false, ...lastExplore.current });
  const currentPage = templatesPage || page.explore || skillsOpen ? 'explore' : settings === 'mcp' ? 'mcp' : null;
  // One page view per arrival on Explore, the Motion Studio landing or a model overview.
  // Design, Cinema and Sound report from their own Studio form (AssetsPage), which knows the scene shown.
  const routeView = templatesPage ? null : page.explore ? 'explore' : page.motion ? 'motion' : page.modelOverview ? 'model:' + page.modelOverview : null;
  useEffect(() => {
    if (!routeView) return;
    const hasProject = Boolean(projectId);
    if (routeView === 'explore') reportCreativePageView('explore', hasProject, { community: page.community, medium: page.medium ?? 'all' });
    else if (routeView === 'motion') reportCreativePageView('creative_studio', hasProject, { studio: 'motion', landing: true });
    else reportCreativePageView('model_overview', hasProject, { model: page.modelOverview });
    // Only an arrival counts; filter changes within Explore are reported as clicks.
  }, [routeView]);
  // Where the top navigation is shown, so its clicks segment by the page the user was on.
  const navTrackingPage: CreativePage = templatesPage ? 'studio' : page.explore ? 'explore' : settings === 'mcp' ? 'mcp'
    : settings === 'brand-kit' ? 'brand_kit' : settings ? 'settings'
    : page.modelOverview ? 'model_overview' : page.modelHub ? 'model_hub' : page.studio || page.motion || page.designScene ? 'creative_studio' : skillsOpen || page.specialty ? 'skills' : assetsOpen ? 'assets' : 'studio';
  const returnToExplore = () => {
    const filters = page.motion || page.modelOverview || page.modelHub || page.specialty || page.studio || page.skills
      ? { community: page.community, medium: page.medium } : lastExplore.current;
    navigatePage({ explore: true, templates: false, ...filters });
  };
  const closeSkills = () => {
    skillsReturnFocus.current = skillsTrigger.current;
    returnToExplore();
  };
  const openPage = (target: 'explore' | 'mcp', client?: McpClient, example?: string) => {
    if (target === 'explore') { openHome(); return; }
    connectionEntry.current = 'app_header';
    navigatePage({ settings: 'mcp', templates: false, mcpExample: example ?? null, ...(client && { client, setup: 'agent' }) });
  };
  const galleryNavigation = !hostChrome && <CreativeNavigation trackingPage="studio" specialty={page.specialty} onChooseStudio={chooseStudio} currentPage={null} onOpenPage={openPage} destination={null} motionActive={false} onNavigate={openStudio} />;
  const library = connectionsOpen && <ConnectionDialog collection={page.templateCollection} onCollectionChange={templateCollection => navigatePage({ templateCollection }, true)}
    collectionSkillOpen={page.templateCollection === 'black-friday' && Boolean(page.skill)} detailOnly={detailOnly}
    initialTemplate={detailOnly && cardPreview.current?.locale === locale ? cardPreview.current.template : undefined}
    onBrowseTemplates={() => navigatePage({ templates: true, templateCollection: null, ...(page.templateCollection === 'black-friday' && { skill: null }), template: null })}
    onOpenSkill={(skill, trigger) => {
      if (!templatesPage) { openSkill(skill); return; }
      collectionSkillTrigger.current = trigger;
      navigatePage({ skill });
    }}
    inWorkspace={templatesPage} navigation={libraryRequested && !templatesPage ? galleryNavigation : undefined}
    open projectId={projectId} returnFocus={libraryTrigger.current} section="templates"
    creators={page.creators} creator={page.creator} onCreatorChange={creator => navigatePage({ templates: true, creators: true, creator, template: null })}
    templateId={page.template} onTemplateChange={template => {
      if (!detailOnly) navigatePage({ template });
      else if (template) writeWorkspaceHistory(workspacePageHref(location.href, { template }), true);
      else closeStandalonePreview();
    }}
    busy={libraryBusy} openingDisabled={switchingDisabled} error={workspace.error}
    onClose={detailOnly ? closeStandalonePreview : () => page.templateCollection === 'black-friday' ? returnToExplore() : navigatePage({ templates: false })}
    onPrepareTemplate={async (template, requestId) => {
    try { await beforeViewChange(); }
    catch (error) { throw new TemplatePreparationBlockedError(error instanceof Error ? error.message : t('Working…')); }
    return prepareTemplateProject(template, projectId, requestId);
  }} onOpenProject={id => workspace.open('projects', id)} onOpen={id => { if (!switchingDisabled) void (sessionId ? workspace.createArtifact(sessionId, id) : workspace.startSession(undefined, id)); }} />;
  const visibleSettings = templatesPage ? null : settings;
  return <WorkspaceChromeContext.Provider value={value}>
    <StudioToastViewport {...navigationToast} />
    <StudioConnectionToast reconnecting={reconnecting} />
    {archives.manager}
    <Dialog.Root open={sidebarOpen && narrow && workspaceActive} onOpenChange={setSidebarOpen}>
    <div ref={applicationRef} className="om-application" data-embedded={presentation.embedded} data-host-chrome={hostChrome} data-navigation-collapsed={navigationCollapsed}>
      <ApplicationHeader atExploreHome={page.explore && !page.community && !page.medium && !connectionsOpen}
        specialty={page.specialty} onChooseStudio={chooseStudio} openSettings={openSettings}
        openAsset={(assetId, assetVersion) => navigatePage({ assets: true, assetId, assetVersion, templates: false })}
        onCommunity={feed => navigatePage({ explore: true, community: feed.id, medium: null, templates: false })} onSkill={openSkill} currentPage={currentPage} trackingPage={navTrackingPage} onOpenPage={openPage} settings={visibleSettings} destination={templatesPage ? null : page.studio} motionActive={!templatesPage && (page.motion || editorActive)} designActive={!templatesPage && Boolean(page.designScene)} onNavigate={openStudio} />
      <div className="motion-workspace">
      <Dialog.Portal>
        <Dialog.Backdrop className="hf-overlay-backdrop motion-sidebar-backdrop" />
        <Dialog.Popup id="om-project-navigation" className="motion-sidebar-drawer" aria-label={t('Project list')} onKeyDown={event => event.stopPropagation()}>
          <WorkspaceSidebar archives={archives} currentId={projectId} close={() => setSidebarOpen(false)} query={projectQuery} setQuery={setProjectQuery} openSettings={openSettings} templatesOpen={motionTemplatesOpen} openTemplates={openMotionTemplates} openEditor={openEditor} />
        </Dialog.Popup>
      </Dialog.Portal>
      {!narrow && workspaceRoute && <div id="om-project-navigation" className="om-project-navigation om-collapsible" data-collapsed={!sidebarOpen || navigationCollapsed} aria-hidden={!sidebarOpen || navigationCollapsed} inert={!sidebarOpen || navigationCollapsed}>
        <WorkspaceSidebar archives={archives} currentId={projectId} close={() => setSidebarOpen(false)} query={projectQuery} setQuery={setProjectQuery} openSettings={openSettings} templatesOpen={motionTemplatesOpen} openTemplates={openMotionTemplates} openEditor={openEditor} />
      </div>}
      <div className="motion-workspace-content" hidden={!editorRoute} inert={!editorRoute}>
        {visibleNotice && <ErrorNotice key={noticeKey} message={notice}
          onDismiss={() => { setDismissedNotice(noticeKey); if (workspaceNotice) workspace.clearError(); }} />}
        {children}
      </div>
      {(exploreVisited || page.explore) && <div className="om-explore-host" hidden={!page.explore || templatesPage} inert={!page.explore || templatesPage}>
        <ExploreStudios initialTemplateCollection={page.templateCollection} onModel={openModel} onModelHub={openModelHub} onOpenBlackFriday={trigger => {
          reportBlackFridayEntry();
          value.openLibrary(trigger, undefined, 'black-friday');
        }} onCreators={trigger => { libraryTrigger.current = trigger; navigatePage({ templates: true, creators: true, creator: null, template: null }); }} onBrandKit={() => openSettings('brand-kit')} onMcp={(client, example) => openPage('mcp', client, example)} onSelectDesignScene={designScene => navigatePage({ designScene, designProject: null, templates: false, ...lastExplore.current })} onOpenDesignProject={id => navigatePage({ designScene: 'projects', designProject: id, templates: false, ...lastExplore.current })} filters={lastExplore.current} onChooseStudio={chooseStudio} active={page.explore && !connectionsOpen} onNavigate={openStudio} onSkill={openSkill} />
      </div>}
      {motionTemplatesOpen && <div className="om-explore-host"><MotionStudioPage active={!connectionsOpen} /></div>}
      {page.modelHub && !templatesPage && <div className="om-explore-host"><ModelHub id={page.modelHub} hasProject={Boolean(projectId)} onExplore={returnToExplore} onModel={openModel} onSettings={openSettings}
        onProvider={provider => navigatePage({ settings: 'providers', provider, templates: false })}
        onUse={() => chooseStudio(motionStudio)} /></div>}
      {page.modelOverview && !templatesPage && <div className="om-explore-host"><ModelOverview id={page.modelOverview} onExplore={returnToExplore}
        onProvider={provider => navigatePage({ settings: 'providers', provider: provider ?? null, templates: false })} onScene={openStudio} /></div>}
      <div className="om-workspace-layer" hidden={templatesPage} inert={templatesPage}><CreativeWorkspace onOpenBrandKit={hostChrome ? () => openSettings('brand-kit') : undefined} onSelectDesignScene={designScene => navigatePage({ designScene, designProject: null, templates: false, ...lastExplore.current })} skill={page.skill} onCollection={specialty => navigatePage({ specialty, templates: false })} onExplore={returnToExplore} drafts={studioDrafts} active={!connectionsOpen} destination={page.studio} visit={studioVisit} hasProject={Boolean(projectId)} onNavigate={studio => navigatePage({ studio, templates: false })} /></div>
      {page.designScene && !templatesPage && (
        <div className="om-assets-host" style={{ padding: 0 }}>
          {page.designProject
            ? <DesignProjectEditor
                projectId={page.designProject}
                onBack={() => navigatePage({ designScene: page.designScene, designProject: null, templates: false })}
                onOpenMcp={() => openPage('mcp')}
              />
            : <DesignScenePage
                scene={page.designScene}
                onSelectDesignScene={designScene => navigatePage({ designScene, designProject: null, templates: false })}
                onSelectImageScene={sceneId => openStudio(studioDestination(findMediaStudio('design')!, sceneId))}
                onChooseStudio={chooseStudio}
                onOpenProject={id => navigatePage({ designScene: page.designScene ?? 'projects', designProject: id, templates: false })}
                onExplore={returnToExplore}
                onOpenMcp={() => openPage('mcp')}
              />}
        </div>
      )}
      {(assetsVisited || assetsOpen) && <div className="om-assets-host" hidden={!assetsOpen || Boolean(settings) || templatesPage} inert={!assetsOpen || Boolean(settings) || templatesPage}><AssetsPage hasProject={Boolean(projectId)} active={assetsOpen && !settings && !templatesPage} routeId={page.assetId} routeVersion={page.assetVersion} onAssetRoute={selectAssetRoute} /></div>}
      {(skillsOpen || page.specialty) && !settings && !templatesPage && <div className="om-skills-host"><SkillsPage previewsEnabled={!connectionsOpen} briefs={skillBriefs.current} onCreate={openStudio} key={page.specialty?.id ?? 'skills'} studio={page.specialty ?? undefined} onExplore={returnToExplore} onClose={skillsOpen ? closeSkills : undefined} skillId={page.skill} routeCategory={page.skills ? page.skillCategory : undefined} onCategoryChange={skillCategory => navigatePage({ skillCategory }, true)} onSkillChange={skill => navigatePage({ skill })} hasProject={Boolean(projectId)} /></div>}
      {settings && !templatesPage && <SettingsSurfaceBoundary key={settings}>{settings === 'brand-kit'
        ? <BrandKitPage inWorkspace={!hostChrome} onClose={openHome} selectedId={page.brandKit} onSelect={brandKit => navigatePage({ brandKit })} previewsEnabled={!connectionsOpen} hasProject={Boolean(projectId)} /> : settings === 'mcp'
        ? <McpConnectionPage openProviders={value.openModelSettings} onBack={() => openPage('explore')} entry={connectionEntry.current} projectId={projectId ?? undefined} hasProject={Boolean(projectId)} previewsEnabled={!connectionsOpen} openLibrary={value.openLibrary} route={page} onRouteChange={navigatePage} />
        : <SettingsCenter hasProject={Boolean(projectId)} section={settings} onSection={openSettings} openConnections={value.openConnections} providerId={page.provider} onProviderChange={provider => navigatePage({ provider })} />}</SettingsSurfaceBoundary>}
      {(templatesPage || detailOnly) && library}
      {templatesPage && page.templateCollection === 'black-friday' && page.skill && <SkillsPage detailOnly skillId={page.skill}
        onSkillChange={skill => navigatePage({ skill })} />}
      </div>
    </div>
    </Dialog.Root>
    {!templatesPage && !detailOnly && library}
  </WorkspaceChromeContext.Provider>;
}

function WorkspaceSidebar({ archives, currentId, close, expand, query, setQuery, onNavigate, openSettings, templatesOpen, openTemplates, openEditor }: {
  archives: ProjectArchiveActions; currentId?: string; close: () => void; expand?: () => void; query: string; setQuery: (query: string) => void; onNavigate?: () => void;
  openSettings: (section: SettingsSection) => void;
  templatesOpen: boolean; openTemplates: () => void; openEditor: () => void;
}) {
  const { t } = useI18n();
  const { workspace, switchingDisabled } = useWorkspaceChrome();
  const projects = workspace.projects;
  const filtered = projects.filter(project => project.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const loadingProjects = !workspace.status && !workspace.error && projects.length === 0;
  return <aside className="motion-sidebar" aria-label={t('Workspace navigation')}>
    <div className="motion-sidebar-brand">
      <strong className="om-subtitle">{t('Workspace')}</strong>
      {/* Collapsing the docked navigation toggles it back with the workspace menu button, so this icon-only control keeps a state-aware tooltip in both states. */}
      <Tooltip label={t(expand ? 'Open project list' : 'Close project list')} wrap><IconButton variant="ghost" type="button" className="motion-icon-button" onClick={expand ?? close} aria-expanded={!expand} aria-controls="om-project-navigation" aria-label={t(expand ? 'Open project list' : 'Close project list')} icon={<MotionIcon name="sidebar" size={16} />} /></Tooltip>
    </div>
    <div className="motion-session-heading">
      <span>{t('Projects')}</span>
      <div className="motion-session-heading-actions">
        <Tooltip label={t(archives.busy === 'import' ? 'Importing…' : 'Import projects')}>
          <IconButton variant="ghost" type="button" className="motion-icon-button" disabled={archives.locked} onClick={archives.chooseImport} aria-label={t(archives.busy === 'import' ? 'Importing…' : 'Import projects')} icon={<RemixIcon name="upload-2-line" size={16} />} />
        </Tooltip>
        <Tooltip label={t('New project')}>
          <IconButton variant="ghost" type="button" className="motion-icon-button" aria-label={t('New project')} disabled={switchingDisabled} onClick={event => {
            void trackMotion('ui_click', { page_name: 'studio', area: 'workspace', element: 'new_creation', interaction_method: event.detail === 0 ? 'keyboard' : 'pointer' });
            void workspace.create();
            onNavigate?.();
          }} icon={<MotionIcon name="plus-thin" size={20} />} />
        </Tooltip>
      </div>
    </div>
    <label data-form-field="regular" className="motion-session-search"><MotionIcon name="search" /><FieldInput appearance="embedded" type="search" value={query} onChange={event => { if (searchStarted(query, event.target.value)) trackStudioClick('project_drawer', 'project_search', currentId); setQuery(event.target.value); }} placeholder={t('Search projects…')} aria-label={t('Search projects')} /></label>
    <nav className="motion-session-list" aria-label={t('Project list')} aria-busy={loadingProjects}>
      {loadingProjects && ['75%', '55%', '65%'].map(width => <div key={width} className="motion-session pointer-events-none" data-testid="project-list-skeleton" aria-hidden="true">
        <Skeleton style={{ width, height: 'var(--motion-space-16)' }} />
      </div>)}
      {workspace.status && !filtered.length && <p className="motion-session-empty">{t(query ? 'No matching projects' : 'Create a project with your Agent to start editing.')}</p>}
      {filtered.map(project => <DisclosureRow key={project.id} className="om-project-sidebar-row" active={!templatesOpen && currentId === project.id}
        action={<ProjectArchiveMenu projectId={project.id} title={project.title} archives={archives} />}>
        <Tooltip label={project.title} wrap><Button variant="plain" aria-label={project.title} className="motion-session om-disclosure-row-label" aria-current={!templatesOpen && currentId === project.id ? 'page' : undefined}
        disabled={switchingDisabled} onClick={event => {
          if (project.id === currentId) { if (templatesOpen) { openEditor(); onNavigate?.(); } return; }
          void trackMotion('ui_click', { page_name: 'studio', area: 'workspace', element: 'open_project', interaction_method: event.detail === 0 ? 'keyboard' : 'pointer' });
          void workspace.open('projects', project.id);
          onNavigate?.();
        }}>
        <span className="motion-session-dot" aria-hidden="true" /><span><strong>{project.title}</strong></span>
      </Button></Tooltip>
      </DisclosureRow>)}
    </nav>
    <div className="motion-sidebar-footer">
      <Button variant="plain" type="button" className="om-nav-item" aria-current={templatesOpen ? 'page' : undefined} onClick={() => { openTemplates(); onNavigate?.(); }}><RemixIcon name="movie-line" size={18} />{t('Motion templates')}</Button>
      <Button variant="plain" className="om-nav-item" type="button" onClick={archives.showManager}><RemixIcon name="folder-open-line" size={18} />{t('All projects')}</Button>
      <WorkspaceUtilityActions openSettings={section => { close(); openSettings(section); }} />
    </div>
  </aside>;
}

export function WorkspaceMenuButton() {
  const { t } = useI18n();
  const { toggleSidebar, sidebarOpen, navigationCollapsed, workspace } = useWorkspaceChrome();
  const visible = sidebarOpen && !navigationCollapsed;
  // Collapsing the docked navigation is a toggle, not a dismiss, so the icon-only
  // control keeps its tooltip in both states like the app-sidebar toggle.
  return <Tooltip label={t(visible ? 'Collapse project list' : 'Open project list')} wrap><IconButton variant="plain" className="motion-icon-button motion-workspace-menu" onClick={event => { if (!visible) trackStudioClick('header', 'open_project_drawer', workspace.status?.projectId, clickMethod(event)); toggleSidebar(); }} aria-expanded={visible} aria-label={t(visible ? 'Collapse project list' : 'Open project list')} icon={<MotionIcon name="sidebar" size={16} />} /></Tooltip>;
}
