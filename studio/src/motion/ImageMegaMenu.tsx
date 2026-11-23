import { useId, useState, type ReactNode } from 'react';
import { Button } from 'open-design-ui/button';
import { defaultCapabilities, findCapability, listCapabilitiesForChannel, type CapabilityDefinition } from '../../../shared/capability-registry';
import type { Model } from '../../../shared/gateway';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { capabilityScene, sceneDestination, studioScenes, supportsScene, type StudioDestination, type StudioScene } from './creativeStudios';
import { sceneExamples } from './sceneShowcase';
import { editImageScene, imageMenuModels, imageModelBadge, imageScene, type ModelFamily } from './imageMenuModels';
import { ModelAvatar } from './settingsPrimitives';
import type { useMediaCatalog } from './useMediaCatalog';
import lunarStill from './scene-art/lunar-shot-still.webp';
import sofaCutout from './scene-art/sofa-cutout.webp';
import speakerRoom from './scene-art/speaker-room.webp';
import speakerStudio from './scene-art/speaker-studio.webp';

export function MegaMenuColumn({ title, items, footer, visible = 5 }: { title: string; items: ReactNode[]; footer?: ReactNode; visible?: number }) {
  const { t } = useI18n();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  // Avoid hiding a lone orphan row behind a "More" toggle; only fold when 2+ items overflow.
  const collapsible = items.length > visible + 1;
  const shown = collapsible ? items.slice(0, visible) : items;
  return <section aria-label={title}>
    <h2>{title}</h2>
    <div className="om-media-mega-items">{shown}</div>
    {collapsible && <>
      <div id={id} className="om-media-mega-items" hidden={!expanded}>{expanded && items.slice(visible)}</div>
      <Button variant="plain" className="om-nav-item om-media-mega-more" aria-label={t('More {category}', { category: title })}
        aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {t('More')}<RemixIcon name="arrow-down-s-line" size={15} />
      </Button>
    </>}
    {footer}
  </section>;
}

function MenuBadge({ label }: { label: string }) {
  const { t } = useI18n();
  return <span className="om-image-menu-badge" data-tone={label === 'New' ? 'new' : label === 'Popular' ? 'top' : 'soon'}>{t(label)}</span>;
}

/** Model entries list every model once; ones without a configured provider still open and ask for setup on the page. */
export function ModelMenuColumn({ families, onOpen }: { families: ModelFamily[]; onOpen: (model: Model) => void }) {
  const { t } = useI18n();
  const items = families.length > 0 ? families.map(family => {
    const badge = imageModelBadge(family.representative);
    return <Button key={family.key} variant="plain" className="om-nav-item om-media-mega-row" data-ready={family.ready || undefined} onClick={() => onOpen(family.representative)}>
      <ModelAvatar name={family.label} modelId={family.representative.modelId} provider={{ id: family.representative.provider, custom: family.representative.source === 'custom' }} />
      <span className="om-media-mega-label">{family.label}</span>
      {badge && <MenuBadge label={badge} />}
    </Button>;
  }) : [<p key="empty" className="om-muted om-media-mega-empty">{t('No models yet. Add a provider to see its models.')}</p>];
  return <MegaMenuColumn title={t('Models')} items={items} />;
}

const findScene = (id: StudioScene['id']) => studioScenes.find(scene => scene.id === id)!;
const removeBackgroundScene = findScene('remove-background');
const sceneCards = [imageScene, editImageScene] as const;

function ImageMenuArt({ scene }: { scene: typeof sceneCards[number]['id'] }) {
  const demo = scene === 'text-to-image' ? 'image' : 'edit';
  return <span className={`om-scene-tile-art om-media-demo om-${demo}-demo`} aria-hidden="true">
    <span className="om-media-demo-frame">
      {demo === 'image' ? <>
        <img src={sceneExamples[scene][0].poster} alt="" />
        <span className="om-image-demo-input">
          <span className="om-image-demo-lines"><i /><i /><i /></span>
          <span className="om-image-demo-send">↑</span>
        </span>
      </> : <>
        <img src={speakerStudio} alt="" /><img className="om-edit-demo-result" src={speakerRoom} alt="" />
      </>}
    </span>
    {demo === 'edit' && <span className="om-edit-demo-sparkle"><RemixIcon name="sparkling-fill" size={15} /></span>}
  </span>;
}

function capabilityTargetScene(cap: CapabilityDefinition): StudioScene {
  return studioScenes.find(scene => scene.id === cap.id) ?? capabilityScene(cap);
}

export function ImageMegaMenu({ catalog, destination, onNavigate }: {
  catalog?: ReturnType<typeof useMediaCatalog>['catalog'];
  destination: StudioDestination | null;
  onNavigate: (destination: StudioDestination) => void;
}) {
  const { t } = useI18n();
  const capabilities = catalog?.capabilities ?? defaultCapabilities;
  const rows = imageMenuModels(catalog?.models ?? [], catalog?.status.providers ?? []);
  const pinned = catalog?.models.find(model => model.id === destination?.model);
  // Non-feature image scenes keep a compatible pinned model; feature scenes open without a pin so OpenDesign defaults apply.
  const openScene = (scene: StudioScene) => onNavigate(sceneDestination(scene, destination, pinned && supportsScene(pinned, scene) ? pinned.id : null));
  const openFeature = (scene: StudioScene) => onNavigate(sceneDestination(scene, destination, null));

  const upscaleCap = findCapability('upscale-4k', capabilities);
  const upscaleLive = Boolean(upscaleCap && upscaleCap.status === 'live' && upscaleCap.channels.gui);

  const imageFeatureCaps = listCapabilitiesForChannel(capabilities, 'gui', {
    modality: 'image',
    includeComingSoon: true,
  }).filter(cap => !['text-to-image', 'image-edit', 'remove-background', 'shot-image', 'upscale-4k'].includes(cap.id));
  const liveFeatureCaps = imageFeatureCaps.filter(cap => cap.status === 'live');
  const upcomingFeatureCaps = imageFeatureCaps.filter(cap => cap.status === 'coming_soon');

  return <div className="om-media-mega">
    <div className="om-media-menu-grid om-media-mega-entries">
      {sceneCards.map(scene => <Button variant="plain" key={scene.id} className="om-scene-tile"
        aria-current={destination?.scene.id === scene.id ? 'page' : undefined} onClick={() => openScene(scene)}>
        <ImageMenuArt scene={scene.id} /><strong>{t(scene.label)}</strong>
      </Button>)}
      <Button variant="plain" className="om-scene-tile" aria-current={destination?.scene.id === removeBackgroundScene.id ? 'page' : undefined} onClick={() => openFeature(removeBackgroundScene)}>
        <span className="om-scene-tile-art om-media-demo om-remove-bg-demo" aria-hidden="true"><img src={sofaCutout} alt="" /></span>
        <strong>{t(removeBackgroundScene.label)}</strong>
      </Button>
      <Button variant="plain" className={upscaleLive ? 'om-scene-tile' : 'om-scene-tile om-scene-tile-disabled'}
        disabled={!upscaleLive} aria-disabled={!upscaleLive || undefined}
        aria-current={upscaleLive && destination?.scene.id === upscaleCap!.id ? 'page' : undefined}
        onClick={upscaleLive ? () => openFeature(capabilityTargetScene(upscaleCap!)) : undefined}>
        <span className="om-scene-tile-art om-upscale-demo">
          {!upscaleLive && <MenuBadge label="Soon" />}
          <span className="om-upscale-split" aria-hidden="true">
            <img className="om-upscale-low" src={lunarStill} alt="" />
            <img className="om-upscale-high" src={lunarStill} alt="" />
            <span className="om-upscale-divider" />
            <span className="om-upscale-tag" data-side="low">HD</span>
            <span className="om-upscale-tag" data-side="high">4K</span>
          </span>
        </span>
        <strong>{t('4K upscale')}</strong>
      </Button>
    </div>
    <div className="om-media-mega-columns">
      <MegaMenuColumn title={t('Features')} items={[
        ...liveFeatureCaps.map(cap => {
          const target = capabilityTargetScene(cap);
          return <Button key={cap.id} variant="plain" className="om-nav-item om-media-mega-row"
            aria-current={destination?.scene.id === target.id ? 'page' : undefined} onClick={() => openFeature(target)}>
            <span className="om-image-menu-icon"><RemixIcon name={cap.icon} size={16} /></span>
            <span className="om-media-mega-label">{t(cap.title)}</span>
          </Button>;
        }),
        ...upcomingFeatureCaps.map(cap => <Button key={cap.id} variant="plain" className="om-nav-item om-media-mega-row" disabled aria-disabled="true">
          <span className="om-image-menu-icon"><RemixIcon name={cap.icon} size={16} /></span>
          <span className="om-media-mega-label">{t(cap.title)}</span>
          <MenuBadge label="Soon" />
        </Button>),
      ]} />
      <ModelMenuColumn families={rows} onOpen={model => onNavigate(sceneDestination(imageScene, destination, model.id))} />
    </div>
  </div>;
}
