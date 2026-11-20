import { WorkspaceBack } from './WorkspaceBack';
import { StudioComingSoon } from './StudioComingSoon';
import { studioComingSoon } from './creativeStudios';
import { Button } from 'open-design-ui/button';
import { findMediaStudio, type TechniqueStudio } from '../../../shared/studio-catalog';
import type { RefObject } from 'react';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { WorkspaceResourceActions } from './WorkspaceResourceActions';
import { AssetsPage } from './AssetsPage';
import type { AssetDraft } from './AssetComposer';
import { useMediaCatalog } from './useMediaCatalog';
import { destinationTarget, reportCreativeClick } from './exploreTracking';
import { scenesForStudio, studioIconTone, studioDestination, studioDraftKey, supportsScene, type StudioDestination } from './creativeStudios';
import { DesignScenePage } from '../design/scenes/DesignScenePage';
import { DesignSceneTabs, type DesignTabId } from '../design/scenes/DesignSceneTabs';

export type StudioCreation = {
  destination: StudioDestination;
  catalog: ReturnType<typeof useMediaCatalog>;
  initialDraft?: AssetDraft;
  remember: (draft: AssetDraft) => void;
  useAsFirstFrame?: (reference: AssetDraft['references'][number]) => void;
  chooseModel: (model: string) => void;
};

export function CreativeWorkspace({ destination, designScene, skill, visit, onNavigate, onExplore, onCollection, onOpenBrandKit, onSelectDesignScene, onOpenDesignProject, onOpenMcp, hasProject, active, drafts }: {
  onOpenBrandKit?: () => void;
  designScene?: DesignTabId | null;
  onSelectDesignScene?: (scene: DesignTabId) => void;
  onOpenDesignProject?: (projectId: string) => void;
  onOpenMcp?: () => void;
  skill: string | null; onCollection: (studio: TechniqueStudio) => void; onExplore: () => void; drafts: RefObject<Map<string, AssetDraft>>; destination: StudioDestination | null; active: boolean; visit: number; onNavigate: (next: StudioDestination) => void; hasProject: boolean;
}) {
  const { t } = useI18n();
  const comingSoon = studioComingSoon(destination?.studio);
  const catalog = useMediaCatalog(active && Boolean(destination) && !comingSoon);
  const designMediaStudio = findMediaStudio('design')!;
  if (!destination && !designScene) return null;
  const studio = destination?.studio ?? designMediaStudio;
  const scene = destination?.scene ?? null;
  if (comingSoon) return <div className="om-assets-host om-creative-workspace"><WorkspaceBack fallback={onExplore} /><StudioComingSoon studio={studio} /></div>;
  const draftKey = destination ? studioDraftKey(destination, skill) : '';
  const firstFrameScene = studio.scenes.find(id => id === 'image-to-video');
  const useAsFirstFrame = destination && scene?.modality === 'image' && firstFrameScene ? (reference: AssetDraft['references'][number]) => {
    const next = studioDestination(studio, firstFrameScene);
    const key = studioDraftKey(next, skill);
    const previous = drafts.current.get(key);
    drafts.current.set(key, { ...previous, modality: 'video', prompt: previous?.prompt ?? '', references: [reference] });
    onNavigate(next);
  } : undefined;
  const pinned = destination ? catalog.catalog?.models.find(model => model.id === destination.model) : undefined;
  return <div className="om-assets-host om-creative-workspace">
    <header className="om-studio-bar">
      <WorkspaceBack
        inline
        onBack={() => reportCreativeClick(
          'creative_studio',
          'studio_bar',
          studio.surface === 'techniques' ? 'open_skills' : 'back_to_explore',
          destination ? destinationTarget(destination) : { studio: 'design', scene: designScene ?? undefined, model: null },
        )}
        fallback={studio.surface === 'techniques' ? () => onCollection(studio) : onExplore}
      />
      <h1 className="om-subtitle"><span className="om-studio-heading-icon" data-tone={destination?.landing && scene ? scene.modality : studioIconTone(studio)}><RemixIcon name={destination?.landing && scene ? scene.icon : studio.icon} size={18} /></span>{destination?.landing && scene ? t(scene.label) : t(studio.title)}</h1>
      {destination?.landing && scene ? <Button variant="plain" className="om-button" onClick={() => { reportCreativeClick('creative_studio', 'studio_bar', 'open_in_studio', destinationTarget(destination)); onNavigate(studioDestination(studio, scene.id, destination.model)); }}>
        {t('Open in {studio}', { studio: t(studio.title) })}<RemixIcon name="arrow-right-line" size={15} />
      </Button> : <nav className="om-asset-tabs" aria-label={t('Scenes')}>{scenesForStudio(studio).map(item => <Button type="button" variant="plain" className="om-nav-item" key={item.id}
        aria-current={scene?.id === item.id ? 'page' : undefined} onClick={() => {
        if (scene?.id === item.id) return;
        const next = { studio, scene: item, model: pinned && supportsScene(pinned, item) ? pinned.id : null };
        reportCreativeClick('creative_studio', 'studio_bar', 'scene_tab', destinationTarget(next));
        onNavigate(next);
      }}>{t(item.label)}</Button>)}{studio.id === 'design' && onSelectDesignScene && <DesignSceneTabs activeTab={designScene ?? null} onSelectDesignScene={onSelectDesignScene} />}</nav>}
      {onOpenBrandKit && <div className="om-control-row om-studio-library-link"><WorkspaceResourceActions onBrandKit={onOpenBrandKit} /></div>}
    </header>
    {designScene && onSelectDesignScene && onOpenDesignProject && onOpenMcp
      ? <DesignScenePage
          scene={designScene}
          onSelectDesignScene={onSelectDesignScene}
          onOpenProject={onOpenDesignProject}
          onOpenMcp={onOpenMcp}
        />
      : destination && <AssetsPage key={draftKey + visit} active={active} hasProject={hasProject} studio={{ destination, catalog, useAsFirstFrame, initialDraft: drafts.current.get(draftKey),
          remember: draft => drafts.current.set(draftKey, draft), chooseModel: model => onNavigate({ ...destination, model }) }} />}
  </div>;
}
