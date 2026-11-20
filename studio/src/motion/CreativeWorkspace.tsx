import { WorkspaceBack } from './WorkspaceBack';
import { StudioComingSoon } from './StudioComingSoon';
import { studioComingSoon } from './creativeStudios';
import { Button } from 'open-design-ui/button';
import type { StudioScene, TechniqueStudio } from '../../../shared/studio-catalog';
import type { ReactNode, RefObject } from 'react';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { WorkspaceResourceActions } from './WorkspaceResourceActions';
import { BackToExploreButton } from './BackToExploreButton';
import { AssetsPage } from './AssetsPage';
import type { AssetDraft } from './AssetComposer';
import { useMediaCatalog } from './useMediaCatalog';
import { destinationTarget, reportCreativeClick } from './exploreTracking';
import { scenesForStudio, studioIconTone, studioDestination, studioDraftKey, supportsScene, type StudioDestination } from './creativeStudios';
import { DesignSceneTabs, type DesignTabId } from '../design/scenes/DesignSceneTabs';

export type StudioCreation = {
  destination: StudioDestination;
  catalog: ReturnType<typeof useMediaCatalog>;
  initialDraft?: AssetDraft;
  remember: (draft: AssetDraft) => void;
  useAsFirstFrame?: (reference: AssetDraft['references'][number]) => void;
  chooseModel: (model: string) => void;
};

export function CreativeWorkspace({ destination, skill, visit, onNavigate, onOpenStudio, breadcrumb, onBackToExplore, onExplore, onCollection, onOpenBrandKit, onSelectDesignScene, projectNavigation, hasProject, active, drafts }: {
  onOpenBrandKit?: () => void;
  onSelectDesignScene?: (scene: DesignTabId) => void;
  projectNavigation?: ReactNode;
  onOpenStudio: (next: StudioDestination) => void; breadcrumb?: ReactNode; onBackToExplore?: () => void;
  skill: string | null; onCollection: (studio: TechniqueStudio) => void; onExplore: () => void; drafts: RefObject<Map<string, AssetDraft>>; destination: StudioDestination | null; active: boolean; visit: number; onNavigate: (next: StudioDestination) => void; hasProject: boolean;
}) {
  const { t } = useI18n();
  const comingSoon = studioComingSoon(destination?.studio);
  const catalog = useMediaCatalog(active && Boolean(destination) && !comingSoon);
  if (!destination) return null;
  const { scene, studio } = destination;
  if (comingSoon) return <div className="om-assets-host om-creative-workspace"><WorkspaceBack fallback={onExplore} /><StudioComingSoon studio={studio} /></div>;
  const draftKey = studioDraftKey(destination, skill);
  const firstFrameScene = studio.scenes.find(id => id === 'image-to-video');
  const useAsFirstFrame = scene.modality === 'image' && firstFrameScene ? (reference: AssetDraft['references'][number]) => {
    const next = studioDestination(studio, firstFrameScene);
    const key = studioDraftKey(next, skill);
    const previous = drafts.current.get(key);
    drafts.current.set(key, { ...previous, modality: 'video', prompt: previous?.prompt ?? '', references: [reference] });
    onOpenStudio(next);
  } : undefined;
  const pinned = catalog.catalog?.models.find(model => model.id === destination.model);
  const selectScene = (item: StudioScene) => {
    if (item.id === scene.id) return;
    const next = { studio, scene: item, model: pinned && supportsScene(pinned, item) ? pinned.id : null };
    reportCreativeClick('creative_studio', 'studio_bar', 'scene_tab', destinationTarget(next));
    onNavigate(next);
  };
  const headingIconClass = studio.id === 'design' && !destination.landing ? 'om-creation-icon' : 'om-studio-heading-icon';
  const heading = <h1 className="om-subtitle">
    <span className={headingIconClass} data-tone={destination.landing ? scene.modality : studioIconTone(studio)}>
      <RemixIcon name={destination.landing ? scene.icon : studio.icon} size={18} />
    </span>
    {destination.landing ? t(scene.label) : t(studio.title)}
  </h1>;
  return <div className="om-assets-host om-creative-workspace">
    {breadcrumb}
    <header className="om-studio-bar">
      {onBackToExplore ? <BackToExploreButton onClick={onBackToExplore} /> : !breadcrumb && studio.surface === 'techniques' &&
        <WorkspaceBack inline onBack={() => reportCreativeClick('creative_studio', 'studio_bar', 'open_skills', destinationTarget(destination))} fallback={() => onCollection(studio)} />}
      {projectNavigation ? <div className="om-design-project-heading">{projectNavigation}{heading}</div> : heading}
      {destination.landing ? <Button variant="plain" className="om-button" onClick={() => { reportCreativeClick('creative_studio', 'studio_bar', 'open_in_studio', destinationTarget(destination)); onOpenStudio(studioDestination(studio, scene.id, destination.model)); }}>
        {t('Open in {studio}', { studio: t(studio.title) })}<RemixIcon name="arrow-right-line" size={15} />
      </Button> : studio.id === 'design' && onSelectDesignScene
        ? <DesignSceneTabs activeTab={scene.id} onSelectImageScene={selectScene} onSelectDesignScene={onSelectDesignScene} />
        : <nav className="om-asset-tabs" aria-label={t('Scenes')}>{scenesForStudio(studio).map(item => <Button variant="plain" className="om-nav-item" key={item.id}
          aria-current={item.id === scene.id ? 'page' : undefined} onClick={() => selectScene(item)}>{t(item.label)}</Button>)}</nav>}
      {onOpenBrandKit && <div className="om-control-row om-studio-library-link"><WorkspaceResourceActions onBrandKit={onOpenBrandKit} /></div>}
    </header>
    <AssetsPage key={draftKey + visit} active={active} hasProject={hasProject} studio={{ destination, catalog, useAsFirstFrame, initialDraft: drafts.current.get(draftKey),
      remember: draft => drafts.current.set(draftKey, draft), chooseModel: model => onNavigate({ ...destination, model }) }} />
  </div>;
}
