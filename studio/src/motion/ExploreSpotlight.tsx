import { Button } from 'open-design-ui/button';
import { ExploreCoverImage } from './ExploreCoverImage';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { mediaEditorDestination, mediaLabels, motionStudio, type StudioDestination, type StudioScene } from './creativeStudios';
import { useCloudFeatureEnabled } from '../utils/cloudFeatures';
import { sceneExamples } from './sceneShowcase';
import { gemini4Spotlight as geminiHub } from './gemini4Spotlight';
import { motionSkills, motionStudioCover } from './skillCatalog';
import { skillPreviewSnapshot } from './skillCoverMedia';
import { useSkillPreview } from './useSkillPreview';
import { destinationTarget, reportCreativeClick } from './exploreTracking';
import type { ScenarioId } from '../../../shared/scenarios';
import aiInfluencerMarketing from './scene-art/ai-influencer-marketing.webp';
import './scenarioNavigation.css';

const track = (element: Parameters<typeof reportCreativeClick>[2], target: Parameters<typeof reportCreativeClick>[3]) => reportCreativeClick('explore', 'explore_spotlight', element, target);

/** Scenes the Explore feed leaves out because they are featured here; unchanged from main so the feed stays as it was. */
export const featuredSceneIds: readonly StudioScene['id'][] = ['text-to-video', 'text-to-image'];
/** Spotlight scenes open with their Studio's scene tabs. */
const spotlightScenes = [mediaEditorDestination('text-to-image')];
const slideDuration = 6000;
const blackFridayPoster = motionSkills.find(skill => skill.id === 'openmotion-sale-carousel')?.cover?.poster ?? '';
interface FeaturedSlide {
  id: string; title: string; subtitle: string; hint: string; icon: string; poster: string; clip?: string; credit?: string;
  scene?: { target: StudioDestination; prompt: string };
  /** Opens a model hub page instead of a studio. */
  hub?: string;
  /** Launches the matching end-to-end scenario workflow. */
  scenario?: ScenarioId;
}
const slides: FeaturedSlide[] = [{
  id: motionStudio.id, title: motionStudio.title, subtitle: 'Motion design', icon: motionStudio.icon,
  hint: 'Animate type and shapes, then edit their timing on the timeline.', poster: motionStudioCover?.poster ?? '', clip: motionStudioCover?.video,
  scenario: 'motion-full-chain',
}, {
  id: 'black-friday', title: 'Black Friday collection', subtitle: 'Template library', icon: 'film-line',
  hint: 'Browse Black Friday video references and Skills for your sale.', poster: blackFridayPoster,
  scenario: 'black-friday',
}, {
  id: 'hub-' + geminiHub.id, title: geminiHub.latestModel, subtitle: geminiHub.eyebrow, icon: 'sparkling-line', poster: geminiHub.poster, hub: geminiHub.id,
  hint: geminiHub.summary, scenario: 'gemini-4-neon',
}, ...spotlightScenes.map(target => {
  const { scene } = target;
  const { id } = scene;
  const example = sceneExamples[id][0];
  return { ...example, id, icon: scene.icon, subtitle: target.studio.title, hint: scene.hint, scene: { target, prompt: example.prompt }, scenario: 'design-full-chain' as ScenarioId };
}), {
  id: 'ai-influencer',
  title: 'Virtual Creator Episode',
  subtitle: 'Roles',
  icon: 'user-3-line',
  hint: 'Script, consistent persona visuals, bio page, voiceover, and talking video',
  poster: aiInfluencerMarketing,
  scenario: 'ai-influencer',
}];

function playClip(video: HTMLVideoElement, src: string) {
  // The pinned MP4 supports byte ranges. Let the player buffer it directly.
  if (!video.hasAttribute('src') || video.error) video.src = src;
  void video.play().catch(() => { /* Keep the poster if playback is blocked. */ });
}

function FeaturedClip({ src, playing, player, onManualPlayback }: {
  src: string; playing: boolean; player: RefObject<HTMLVideoElement | null>; onManualPlayback?: (playing: boolean) => void;
}) {
  const [ready, setReady] = useState(false);
  const [retryAsMp4, setRetryAsMp4] = useState(false);
  const fallback = useSkillPreview(src, retryAsMp4);
  useEffect(() => {
    const video = player.current;
    return () => {
      // Removing a playing video from the DOM alone need not stop its request.
      if (video?.hasAttribute('src')) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      onManualPlayback?.(false);
    };
  }, [player, src, onManualPlayback]);
  useEffect(() => {
    const video = player.current;
    if (!video) return;
    if (retryAsMp4 && !fallback) return;
    if (fallback && video.getAttribute('src') !== fallback) video.src = fallback;
    if (playing || (fallback && onManualPlayback)) playClip(video, fallback ?? src);
    else video.pause();
  }, [playing, player, src, retryAsMp4, fallback, onManualPlayback]);
  return <video ref={player} muted loop playsInline preload="none" aria-hidden="true" style={{ opacity: ready ? 1 : 0 }}
    onPlaying={() => setReady(true)} onPlay={() => onManualPlayback?.(true)} onPause={() => onManualPlayback?.(false)}
    onError={() => {
      setReady(false);
      onManualPlayback?.(false);
      if (src.startsWith(skillPreviewSnapshot)) setRetryAsMp4(true);
    }} />;
}

export function ExploreSpotlight({ active, onNavigate, onOpenMotionEditor, motionEditorDisabled, onOpenBlackFriday, onModelHub, onStartScenario }: {
  active: boolean; onNavigate: (target: StudioDestination, prompt: string) => void;
  onOpenMotionEditor: () => void; motionEditorDisabled: boolean;
  onOpenBlackFriday: (trigger: HTMLButtonElement) => void; onModelHub: (id: string) => void;
  onStartScenario?: (id: ScenarioId) => void;
}) {
  const { t } = useI18n();
  const designStudioEnabled = useCloudFeatureEnabled('designStudio');
  const visibleSlides = onStartScenario
    ? slides
    : slides.filter(slide => Boolean(slide.hub || slide.scene || slide.id === 'black-friday' || slide.id === motionStudio.id));
  const root = useRef<HTMLElement>(null);
  const [index, setIndex] = useState(0);
  const activeIndex = index % visibleSlides.length;
  const [paused, setPaused] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(false);
  const [readingSlide, setReadingSlide] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection;
  const [saveData, setSaveData] = useState(Boolean(connection?.saveData));
  const [manualPlayback, setManualPlayback] = useState(false);
  const clock = useRef({ index: 0, remaining: slideDuration });
  const playing = active && visible && !paused && !readingSlide && !manualPlayback;

  useEffect(() => {
    const change = () => setSaveData(Boolean(connection?.saveData));
    connection?.addEventListener?.('change', change);
    return () => connection?.removeEventListener?.('change', change);
  }, [connection]);

  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setPaused(preference.matches);
    preference.addEventListener('change', change);
    return () => preference.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let inView = false;
    const update = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(entries => {
      inView = entries[entries.length - 1].isIntersecting;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);

  useEffect(() => {
    if (clock.current.index !== activeIndex) clock.current = { index: activeIndex, remaining: slideDuration };
    if (!playing) return;
    const started = performance.now();
    const timer = window.setTimeout(() => setIndex((activeIndex + 1) % visibleSlides.length), clock.current.remaining);
    return () => {
      window.clearTimeout(timer);
      clock.current.remaining = Math.max(0, clock.current.remaining - (performance.now() - started));
    };
  }, [activeIndex, playing, visibleSlides.length]);


  return <section ref={root} className="om-discovery-hero om-feature-carousel" data-scene={visibleSlides[activeIndex].id} aria-label={t('Featured')}
    onFocus={() => setReadingSlide(true)} onBlur={event => setReadingSlide(event.currentTarget.contains(event.relatedTarget))}
    style={{ '--slide-duration': slideDuration + 'ms', '--slide-play-state': playing ? 'running' : 'paused' } as CSSProperties}>
    {visibleSlides.map((slide, i) => {
      const current = i === activeIndex;
      const scene = slide.scene;
      const blackFriday = slide.id === 'black-friday';
      const motionSlide = slide.id === motionStudio.id;
      const showWorkflowPrimary = Boolean(slide.scenario && onStartScenario);
      const subtitleLabel = !designStudioEnabled && scene?.target.studio.id === 'design'
        ? mediaLabels[scene.target.scene.modality]
        : slide.subtitle;
      // A hub slide is clickable as a whole; its button stays the keyboard entry.
      return <div key={slide.id} className="om-feature-slide" data-scene={slide.id} data-clickable={slide.hub ? 'true' : undefined} aria-hidden={!current} inert={!current}
        onClick={slide.hub ? event => { if ((event.target as Element).closest('button')) return; track('slide_action', { slide: slide.id, position: i }); onModelHub(slide.hub!); } : undefined}>
        <div className="om-feature-art" aria-hidden="true"><div className="om-feature-camera">
          <ExploreCoverImage src={slide.poster} eager={current} />
          {current && active && visible && slide.clip && <FeaturedClip key={saveData ? 'manual' : 'auto'} src={slide.clip} player={player}
            playing={!saveData && playing} onManualPlayback={saveData ? setManualPlayback : undefined} />}
        </div></div>
        {slide.credit && <small className="om-scene-credit">{slide.credit}</small>}
        <div className="om-discovery-hero-copy">
          <span><RemixIcon name={slide.icon} size={16} />{t(subtitleLabel)}</span>
          <h2>{t(slide.title)}</h2><p>{t(slide.hint)}</p>
          <div className="om-hero-actions">
            {showWorkflowPrimary && <Button variant="ghost" type="button" className="om-button h-auto" data-slide-action="workflow" data-primary="media" onClick={() => {
              track('slide_action', { slide: slide.id, position: i, navTarget: 'workflow' });
              onStartScenario!(slide.scenario!);
            }}>
              {t('Start workflow')}<RemixIcon name="arrow-right-line" size={16} />
            </Button>}
            {slide.hub ? <Button variant="ghost" type="button" className="om-button h-auto" data-slide-action="destination" data-primary={showWorkflowPrimary ? undefined : 'media'} onClick={() => { track('slide_action', { slide: slide.id, position: i }); onModelHub(slide.hub!); }}>
              {t('Try {model} now', { model: slide.title })}<RemixIcon name="arrow-right-line" size={16} />
            </Button> : blackFriday ? <Button variant="ghost" type="button" className="om-button h-auto" data-slide-action="destination" data-primary={showWorkflowPrimary ? undefined : 'media'} onClick={event => { track('slide_action', { slide: slide.id, position: i }); onOpenBlackFriday(event.currentTarget); }}>
              {t('View collection')}<RemixIcon name="arrow-right-line" size={16} />
            </Button> : scene ? <Button variant="ghost" type="button" className="om-button h-auto" data-slide-action="destination" data-primary={showWorkflowPrimary ? undefined : 'media'} onClick={() => {
              track('slide_action', { slide: slide.id, position: i, ...destinationTarget(scene.target) });
              onNavigate(scene.target, t(scene.prompt));
            }}>
              {t(scene.target.scene.label)}<RemixIcon name="arrow-right-line" size={16} />
            </Button> : motionSlide ? <Button variant="ghost" type="button" className="om-button h-auto" data-slide-action="destination" data-primary={showWorkflowPrimary ? undefined : 'media'} disabled={motionEditorDisabled} onClick={() => {
              track('slide_action', { slide: slide.id, position: i, studio: motionStudio.id });
              onOpenMotionEditor();
            }}>
              {t('Open in Motion Editor')}<RemixIcon name="arrow-right-line" size={16} />
            </Button> : null}
            {current && saveData && slide.clip && <Button variant="ghost" type="button" className="om-button h-auto" disabled={!active || !visible} onClick={() => {
              const video = player.current;
              if (!video) return;
              if (video.paused || video.error) playClip(video, slide.clip!); else video.pause();
            }}><RemixIcon name={manualPlayback ? 'pause-fill' : 'play-fill'} size={16} />{t(manualPlayback ? 'Pause' : 'Play')}</Button>}
          </div>
        </div>
      </div>;
    })}
    <div className="om-feature-controls om-media-pagination om-media-segments" role="group" aria-label={t('Featured')}>
      {visibleSlides.map((slide, i) => <Button variant="plain" type="button" key={slide.id} aria-label={t('Featured') + ' · ' + t(slide.title)} aria-current={i === activeIndex ? 'true' : undefined} onClick={() => { track('slide_select', { slide: slide.id, position: i }); setIndex(i); }}>
        <span className="om-media-track" />
      </Button>)}
    </div>
  </section>;
}
