import { WorkspaceBack } from './WorkspaceBack';
import { StudioComingSoon } from './StudioComingSoon';
import { studioComingSoon } from './creativeStudios';
import { Button } from 'open-design-ui/button';
import type { TechniqueStudio } from '../../../shared/studio-catalog';
import type { ReactNode, RefObject } from 'react';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { WorkspaceResourceActions } from './WorkspaceResourceActions';
import { BackToExploreButton } from './BackToExploreButton';
import { AssetsPage } from './AssetsPage';
import type { CinemaTemplate } from './cinemaTemplates';
import type { AssetDraft } from './AssetComposer';
import { useMediaCatalog } from './useMediaCatalog';
import { destinationTarget, reportCreativeClick } from './exploreTracking';
import { mediaEditorDestination, mediaLabels, sceneFeature, scenesForStudio, studioIconTone, studioDestination, studioDraftKey, supportsScene, type StudioDestination, type StudioScene } from './creativeStudios';
import { DesignSceneTabs, type DesignTabId } from '../design/scenes/DesignSceneTabs';
import { SoundSceneTabs } from './SoundSceneTabs';
import { findSoundTab, isSfxModel, type SoundTabId } from './soundTabs';

export type StudioCreation = {
  destination: StudioDestination;
  catalog: ReturnType<typeof useMediaCatalog>;
  initialDraft?: AssetDraft;
  draftKey?: string;
  soundTab?: SoundTabId;
  selectSoundTab?: (tabId: SoundTabId, nextDraft?: AssetDraft, model?: string | null) => void;
  remember: (draft: AssetDraft) => void;
  useAsFirstFrame?: (reference: AssetDraft['references'][number]) => void;
  reuseInScene?: (sceneId: StudioScene['id'], draft: AssetDraft, model?: string | null) => void;
  chooseModel: (model: string) => void;
  /** Opens the scene's generation page, optionally with a prompt already filled in. */
  openCreate?: (prompt?: string, scene?: StudioScene['id']) => void;
};

export function CreativeWorkspace({ destination, soundTab, skill, visit, onNavigate, onOpenStudio, breadcrumb, onBackToExplore, onExplore, onCollection, onOpenBrandKit, onSelectDesignScene, hasProject, active, drafts, cinemaTemplate }: {
  cinemaTemplate?: CinemaTemplate;
  onOpenBrandKit?: () => void;
  onSelectDesignScene?: (scene: DesignTabId) => void;
  soundTab?: SoundTabId | null;
  onOpenStudio: (next: StudioDestination) => void; breadcrumb?: ReactNode; onBackToExplore?: () => void;
  skill: string | null; onCollection: (studio: TechniqueStudio) => void; onExplore: () => void; drafts: RefObject<Map<string, AssetDraft>>; destination: StudioDestination | null; active: boolean; visit: number; onNavigate: (next: StudioDestination, nextSoundTab?: SoundTabId | null) => void; hasProject: boolean;
}) {
  const { t, locale } = useI18n();
  const comingSoon = studioComingSoon(destination?.studio);
  const catalog = useMediaCatalog(active && Boolean(destination) && !comingSoon);
  if (!destination) return null;
  const { scene, studio } = destination;
  if (comingSoon) return <div className="om-assets-host om-creative-workspace"><WorkspaceBack fallback={onExplore} /><StudioComingSoon studio={studio} /></div>;
  const isSoundStudio = studio.id === 'sound';
  const activeSoundTab: SoundTabId | undefined = isSoundStudio
    ? (destination.landing ? (scene.id === 'speech' ? 'speech' : 'music') : (soundTab ?? (scene.id === 'speech' ? 'speech' : 'music')))
    : undefined;
  const draftKey = activeSoundTab ? `sound/${activeSoundTab}` : studioDraftKey(destination, skill) + (cinemaTemplate ? '/' + cinemaTemplate.id : '');
  const initialDraft: AssetDraft | undefined = drafts.current.get(draftKey) ?? (cinemaTemplate && {
    modality: 'video',
    prompt: (locale === 'zh-CN' ? cinemaTemplate.zh : cinemaTemplate.en).prompt,
    preferredModel: cinemaTemplate.model.id,
    shotPreferences: { aspect: cinemaTemplate.aspect, duration: cinemaTemplate.duration },
    references: [],
  });
  const firstFrameScene = studio.scenes.find(id => id === 'image-to-video');
  const useAsFirstFrame = scene.modality === 'image' ? (reference: AssetDraft['references'][number]) => {
    const next = destination.landing || !firstFrameScene ? mediaEditorDestination('image-to-video') : studioDestination(studio, firstFrameScene);
    const key = studioDraftKey(next, skill);
    const previous = drafts.current.get(key);
    drafts.current.set(key, { ...previous, modality: 'video', prompt: previous?.prompt ?? '', references: [reference] });
    onOpenStudio(next);
  } : undefined;
  const reuseInScene = (sceneId: StudioScene['id'], nextDraft: AssetDraft, model: string | null = null) => {
    const next = destination.landing || destination.mediaTab ? mediaEditorDestination(sceneId, model) : studioDestination(studio, sceneId, model);
    drafts.current.set(studioDraftKey(next, skill), nextDraft);
    onNavigate(next);
  };
  const pinned = catalog.catalog?.models.find(model => model.id === destination.model);
  const openCreate = destination.home ? (prompt?: string, sceneId?: StudioScene['id']) => {
    const target = scenesForStudio(studio).find(item => item.id === (sceneId ?? scene.id)) ?? scene;
    const next: StudioDestination = { ...studioDestination(studio, target.id, destination.model), mediaTab: true };
    if (prompt !== undefined) {
      const targetTab = target.id === 'speech' ? 'speech' : 'music';
      const key = `sound/${targetTab}`;
      const previous = drafts.current.get(key);
      drafts.current.set(key, { ...previous, modality: next.scene.modality, prompt, references: previous?.references ?? [] });
    }
    onNavigate(next, null);
  } : undefined;
  const selectSoundTab = isSoundStudio ? (tabId: SoundTabId, nextDraft?: AssetDraft, model?: string | null) => {
    const tabDef = findSoundTab(tabId);
    if (!tabDef) return;
    if (nextDraft) drafts.current.set(`sound/${tabId}`, nextDraft);
    const targetScene = scenesForStudio(studio).find(item => item.id === tabDef.backingScene) ?? scene;
    const keepPinned = model !== undefined
      ? model
      : pinned && supportsScene(pinned, targetScene) && (tabId === 'sfx' ? isSfxModel(pinned) : tabId === 'music' ? !isSfxModel(pinned) : true)
        ? pinned.id
        : null;
    const next: StudioDestination = { studio, scene: targetScene, model: keepPinned, ...(destination.mediaTab ? { mediaTab: true as const } : {}) };
    reportCreativeClick('creative_studio', 'studio_bar', 'scene_tab', destinationTarget(next));
    onNavigate(next, tabId === 'music' || tabId === 'speech' ? null : tabId);
  } : undefined;
  const showSoundBar = isSoundStudio && !destination.landing && !destination.home;
  return <div className="om-assets-host om-creative-workspace">
    {breadcrumb}
    {destination.home ? (onBackToExplore ? <BackToExploreButton onClick={onBackToExplore} /> : !breadcrumb && <WorkspaceBack fallback={onExplore} />) : <>
    <header className="om-studio-bar" data-sound-bar={showSoundBar || undefined}>
      {!showSoundBar && (onBackToExplore ? <BackToExploreButton onClick={onBackToExplore} />
        : !breadcrumb && !destination.landing && studio.id === 'cinema' ? <WorkspaceBack inline fallback={onExplore} />
        : !breadcrumb && studio.surface === 'techniques' && <WorkspaceBack inline onBack={() => reportCreativeClick('creative_studio', 'studio_bar', 'open_skills', destinationTarget(destination))} fallback={() => onCollection(studio)} />)}
      {showSoundBar ? (
        <h1 className="sr-only">{destination.mediaTab ? t(mediaLabels[scene.modality]) : t(studio.title)}</h1>
      ) : (
        <h1 className="om-subtitle"><span className="om-studio-heading-icon" data-tone={destination.landing ? scene.modality : studioIconTone(studio)}><RemixIcon name={destination.landing ? scene.icon : studio.icon} size={18} /></span>{destination.landing ? t(scene.label) : destination.mediaTab ? t(mediaLabels[scene.modality]) : t(studio.title)}</h1>
      )}
      {destination.landing ? <nav className="om-asset-tabs" aria-label={t('Scenes')}>{scenesForStudio(studio).map(item => <Button variant="plain" className="om-nav-item" key={item.id}
        aria-current={item.id === scene.id ? 'page' : undefined} onClick={() => {
        if (item.id === scene.id) return;
        // Feature scenes open without a pin so their defaults apply, as in the Image menu.
        const next = mediaEditorDestination(item, !sceneFeature(item) && pinned && supportsScene(pinned, item) ? pinned.id : null);
        reportCreativeClick('creative_studio', 'studio_bar', 'scene_tab', destinationTarget(next));
        onNavigate(next);
      }}>{t(item.label)}</Button>)}</nav> : isSoundStudio && activeSoundTab && selectSoundTab ? (
        <nav className="om-asset-tabs om-sound-studio-tabs" aria-label={t('Scenes')}>
          <SoundSceneTabs activeTab={activeSoundTab} onSelectTab={tabId => selectSoundTab(tabId)} />
        </nav>
      ) : <nav className="om-asset-tabs" aria-label={t('Scenes')}>{scenesForStudio(studio).map(item => <Button variant="plain" className="om-nav-item" key={item.id}
        aria-current={item.id === scene.id ? 'page' : undefined} onClick={() => {
        if (item.id === scene.id) return;
        const next = { studio, scene: item, model: pinned && supportsScene(pinned, item) ? pinned.id : null };
        reportCreativeClick('creative_studio', 'studio_bar', 'scene_tab', destinationTarget(next));
        onNavigate(next);
      }}>{t(item.label)}</Button>)}{studio.id === 'design' && onSelectDesignScene && <DesignSceneTabs activeTab={null} onSelectDesignScene={onSelectDesignScene} />}</nav>}
      {onOpenBrandKit && <div className="om-control-row om-studio-library-link"><WorkspaceResourceActions onBrandKit={onOpenBrandKit} /></div>}
    </header>
    </>}
    <AssetsPage key={isSoundStudio ? `sound/${visit}${destination.home ? ':home' : ''}` : draftKey + visit} active={active} hasProject={hasProject} studio={{ destination, catalog, draftKey, soundTab: activeSoundTab, selectSoundTab, useAsFirstFrame, reuseInScene, initialDraft,
      remember: draft => drafts.current.set(draftKey, draft), chooseModel: model => onNavigate({ ...destination, model }, activeSoundTab === 'music' || activeSoundTab === 'speech' ? null : activeSoundTab), openCreate }} />
  </div>;
}
