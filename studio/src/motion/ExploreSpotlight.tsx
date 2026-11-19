import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { motionStudio, sceneDestination, studioScenes, type StudioDestination, type StudioScene } from './creativeStudios';
import { sceneExamples } from './sceneShowcase';
import { findModelHub } from './modelHubs';
import { motionSkills } from './skillCatalog';
import { useSkillPreview } from './useSkillPreview';

export const featuredSceneIds: readonly StudioScene['id'][] = ['text-to-video', 'text-to-image'];
const slideDuration = 6000;
const motionCover = motionSkills.find(skill => skill.id === 'openmotion-bubble-field')?.cover;
const motionPoster = motionCover?.poster ?? '';
const motionClip = motionCover?.video;
const blackFridayPoster = motionSkills.find(skill => skill.id === 'openmotion-sale-carousel')?.cover?.poster ?? '';
interface FeaturedSlide {
  id: string; title: string; subtitle: string; hint: string; icon: string; poster: string; clip?: string; credit?: string;
  scene?: { target: StudioDestination; prompt: string };
  /** Opens a model hub page instead of a studio. */
  hub?: string;
}
const geminiHub = findModelHub('gemini-4')!;
const slides: FeaturedSlide[] = [{
  id: motionStudio.id, title: motionStudio.title, subtitle: 'Motion design', icon: motionStudio.icon,
  hint: 'Animate type and shapes, then edit their timing on the timeline.', poster: motionPoster, clip: motionClip,
}, {
  id: 'black-friday', title: 'Black Friday collection', subtitle: 'Template library', icon: 'film-line',
  hint: 'Browse Black Friday video references and Skills for your sale.', poster: blackFridayPoster,
}, {
  id: 'hub-' + geminiHub.id, title: geminiHub.latestModel, subtitle: geminiHub.eyebrow, icon: 'sparkling-line', poster: geminiHub.poster, hub: geminiHub.id,
  hint: 'Google’s newest frontier model writes whole animations in code. The hottest Gemini 4 videos on X are all here.',
}, ...featuredSceneIds.map(id => {
  const scene = studioScenes.find(entry => entry.id === id)!;
  const example = sceneExamples[id][0], target = sceneDestination(scene);
  return { ...example, id, icon: scene.icon, subtitle: target.studio.title, hint: scene.hint, scene: { target, prompt: example.prompt } };
})];

function FeaturedClip({ src, poster, playing }: { src: string; poster: string; playing: boolean }) {
  const player = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(playing);
  const videoSource = useSkillPreview(src, (started || playing) && !failed);
  useEffect(() => { if (playing) setStarted(true); }, [playing]);
  useEffect(() => {
    const video = player.current;
    if (!video) return;
    if (playing) void video.play().catch(() => { /* The poster remains available if autoplay is blocked. */ });
    else video.pause();
  }, [playing, videoSource]);
  return videoSource && !failed ? <video ref={player} src={videoSource} poster={poster} muted loop playsInline preload="none" aria-hidden="true" onError={() => setFailed(true)} /> : null;
}

export function ExploreSpotlight({ active, onNavigate, onOpenMotion, onOpenBlackFriday, onModelHub }: {
  active: boolean; onNavigate: (target: StudioDestination, prompt: string) => void; onOpenMotion: () => void; onOpenBlackFriday: (trigger: HTMLButtonElement) => void; onModelHub: (id: string) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLElement>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(false);
  const [readingSlide, setReadingSlide] = useState(false);
  const clock = useRef({ index: 0, remaining: slideDuration });
  const playing = active && visible && !paused && !readingSlide;

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
    if (clock.current.index !== index) clock.current = { index, remaining: slideDuration };
    if (!playing) return;
    const started = performance.now();
    const timer = window.setTimeout(() => setIndex((index + 1) % slides.length), clock.current.remaining);
    return () => {
      window.clearTimeout(timer);
      clock.current.remaining = Math.max(0, clock.current.remaining - (performance.now() - started));
    };
  }, [index, playing]);

  const step = (delta: number) => setIndex(current => (current + delta + slides.length) % slides.length);
  return <section ref={root} className="om-discovery-hero om-feature-carousel" data-scene={slides[index].id} aria-label={t('Featured')}
    style={{ '--slide-duration': slideDuration + 'ms', '--slide-play-state': playing ? 'running' : 'paused' } as CSSProperties}>
    {slides.map((slide, i) => {
      const current = i === index;
      const scene = slide.scene;
      const blackFriday = slide.id === 'black-friday';
      // A hub slide is clickable as a whole; its button stays the keyboard entry.
      return <div key={slide.id} className="om-feature-slide" data-scene={slide.id} data-clickable={slide.hub ? 'true' : undefined} aria-hidden={!current} inert={!current}
        onClick={slide.hub ? event => { if (!(event.target as Element).closest('button')) onModelHub(slide.hub!); } : undefined}>
        <div className="om-feature-art" aria-hidden="true"><div className="om-feature-camera">
          <img src={slide.poster} alt="" />
          {current && active && visible && slide.clip && <FeaturedClip src={slide.clip} poster={slide.poster} playing={playing} />}
        </div></div>
        {slide.credit && <small className="om-scene-credit">{slide.credit}</small>}
        <div className="om-discovery-hero-copy" onFocus={() => setReadingSlide(true)} onBlur={() => setReadingSlide(false)}>
          <span><RemixIcon name={slide.icon} size={16} />{t(slide.subtitle)}</span>
          <h2>{t(slide.title)}</h2><p>{t(slide.hint)}</p>
          {slide.hub ? <button className="om-button" data-primary="media" onClick={() => onModelHub(slide.hub!)}>
            {t('Try {model} now', { model: slide.title })}<RemixIcon name="arrow-right-line" size={16} />
          </button> : blackFriday ? <button className="om-button" data-primary="media" onClick={event => onOpenBlackFriday(event.currentTarget)}>
            {t('View collection')}<RemixIcon name="arrow-right-line" size={16} />
          </button> : <button className="om-button" data-primary="media" onClick={scene ? () => onNavigate(scene.target, t(scene.prompt)) : onOpenMotion}>
            {scene ? t(scene.target.scene.label) : t('Open in {studio}', { studio: t(motionStudio.title) })}<RemixIcon name="arrow-right-line" size={16} />
          </button>}
        </div>
      </div>;
    })}
    <div className="om-feature-controls om-media-pagination">
      <button type="button" aria-label={t(paused ? 'Play' : 'Pause')} onClick={() => setPaused(!paused)}><RemixIcon name={paused ? 'play-fill' : 'pause-fill'} size={16} /></button>
      <div className="om-media-segments">
        {slides.map((slide, i) => <button type="button" key={slide.id} aria-label={t('Featured') + ' · ' + t(slide.title)} aria-current={i === index ? 'true' : undefined} onClick={() => setIndex(i)}>
          <span className="om-media-track">{i === index && <span className="om-media-progress" style={{ animationPlayState: playing ? 'running' : 'paused' }} />}</span>
        </button>)}
      </div>
      <button type="button" aria-label={t('Previous')} onClick={() => step(-1)}><RemixIcon name="arrow-right-s-line" mirrored size={16} /></button>
      <button type="button" aria-label={t('Next')} onClick={() => step(1)}><RemixIcon name="arrow-right-s-line" size={16} /></button>
    </div>
  </section>;
}
