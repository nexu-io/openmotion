import { Button } from 'open-design-ui/button';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { Skeleton } from '../components/ui/Skeleton';
import { MediaPreviewPlayer } from '../components/nle/MediaPreviewPlayer';
import { type StudioDestination } from './creativeStudios';
import { studioExamples, sceneLayout, type SceneExample } from './sceneShowcase';
import { skillPreviewSnapshot } from './skillCatalog';
import { useSkillPreview } from './useSkillPreview';
import { isXVideoUrl, xVideoDocument } from './xVideoEmbed';
import sofaCutout from './scene-art/sofa-cutout.webp';
import sofaRelight from './scene-art/sofa-relight.webp';

function SceneComparisonGuide({ src, width, height, alt, title, description, wide }: {
  src: string; width: number; height: number; alt: string; title: string; description: string; wide?: boolean;
}) {
  const { t } = useI18n();
  const titleId = useId();
  return <section className="om-scene-guide om-scene-comparison" aria-labelledby={titleId}>
    <div className="om-scene-comparison-media" data-wide={wide || undefined}>
      <img src={src} width={width} height={height} alt={t(alt)} />
    </div>
    <div className="om-guide-heading">
      <h2 id={titleId} className="om-title">{t(title)}</h2>
      <p className="om-muted">{t(description)}</p>
    </div>
  </section>;
}

function ExampleMedia({ example, enabled, videoGuide = false }: { example: SceneExample; enabled: boolean; videoGuide?: boolean }) {
  const { t } = useI18n();
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [requestedClip, setRequestedClip] = useState<string>();
  const [inView, setInView] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));
  const archivedClip = example.clip?.startsWith(skillPreviewSnapshot);
  const xHostedClip = Boolean(example.clip && isXVideoUrl(example.clip));
  const autoplay = videoGuide && !reducedMotion;
  const clip = useSkillPreview(example.clip, enabled && !failed && !xHostedClip && (!archivedClip || requestedClip === example.clip), setFailed);
  useEffect(() => { if (!enabled) setRequestedClip(undefined); }, [enabled]);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const pref = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(pref.matches);
    pref.addEventListener('change', onChange);
    return () => pref.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    if (!example.audio || !enabled || failed) return;
    // The bundled demo is small. A blob URL supports seeking even on static hosts without byte ranges.
    const controller = new AbortController();
    let url: string | undefined;
    fetch(example.audio, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(response => {
        if (!response.ok) throw new Error('Audio preview unavailable');
        return response.blob();
      }).then(blob => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setAudioUrl(url);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      setAudioUrl('');
    };
  }, [example.audio, enabled, failed]);
  useEffect(() => {
    const sync = () => {
      const media = video.current ?? stage.current?.querySelector<HTMLMediaElement>('audio, video');
      if (!media) return;
      if (!enabled || document.hidden || !inView) {
        media.pause();
      } else if (autoplay && media instanceof HTMLVideoElement) {
        void media.play().catch(() => { /* Static poster remains visible when autoplay is blocked. */ });
      }
    };
    const element = stage.current;
    const observer = element && typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      const visible = Boolean(entries[0]?.isIntersecting);
      setInView(visible);
      if (!visible) element.querySelector<HTMLMediaElement>('audio, video')?.pause();
    }) : null;
    if (element) observer?.observe(element);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }, [enabled, inView, autoplay, clip]);
  const mediaStyle = !example.audio && example.posterAspect
    ? { '--poster-aspect': String(example.posterAspect) } as CSSProperties
    : undefined;
  return <div ref={stage} className="om-scene-example-media" style={mediaStyle}>
    {xHostedClip && example.clip && enabled ? (
      <iframe
        key={example.clip}
        className="om-hub-lightbox-video"
        srcDoc={xVideoDocument(example.clip, example.poster, true, autoplay)}
        sandbox="allow-scripts"
        allow="autoplay; fullscreen"
        title={t(example.title)}
      />
    ) : clip && !failed ? <video ref={video} controls playsInline muted={videoGuide} loop={autoplay} autoPlay={!videoGuide && archivedClip} preload="none" poster={example.poster} src={clip} aria-label={t(example.title)} onError={() => setFailed(true)} /> : !example.audio && <img src={example.poster} alt="" referrerPolicy="no-referrer" />}
    {enabled && archivedClip && !clip && !failed && <Button variant="plain" type="button" className="om-button om-scene-preview-action"
      disabled={requestedClip === example.clip} onClick={() => setRequestedClip(example.clip)}>
      {requestedClip !== example.clip && <RemixIcon name="play-fill" size={14} />}
      {t(requestedClip === example.clip ? 'Loading…' : 'Play')}
    </Button>}
    {example.audio && !failed && enabled && <div className="om-scene-audio">
      <div className="om-sound-sleeve" aria-hidden="true"><img src={example.poster} alt="" /></div>
      <div className="om-sound-track"><h3 className="om-subtitle">{t('OpenMotion welcome soundtrack')}</h3>
        {audioUrl ? <MediaPreviewPlayer kind="audio" url={audioUrl} name={t('OpenMotion welcome soundtrack')} waveform={example.waveform}
          autoPlay={false} onError={() => setFailed(true)} />
          : <div className="om-sound-loading" role="status" aria-label={t('Loading…')}><Skeleton /></div>}
      </div>
    </div>}
    {failed && <Button variant="plain" className="om-button om-scene-preview-action" onClick={() => setFailed(false)}>{t('Retry preview')}</Button>}
    {example.credit && <small className="om-scene-credit">{example.credit}</small>}
  </div>;
}

export function StudioIdeas({ destination, onPrompt, active = true, modelName, currentPrompt, featuredExample }: {
  destination: StudioDestination;
  onPrompt: (prompt: string) => void;
  active?: boolean;
  modelName?: string;
  currentPrompt?: string;
  featuredExample?: { title: string; prompt: string; poster: string; clip?: string; posterAspect?: number };
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(0);
  const { scene } = destination;
  if (featuredExample) {
    const remixExample: SceneExample = {
      title: featuredExample.title,
      prompt: featuredExample.prompt,
      poster: featuredExample.poster,
      clip: featuredExample.clip,
      posterAspect: featuredExample.posterAspect,
    };
    return <section className="om-scene-guide om-scene-hero" data-remix-guide="true">
      <div className="om-scene-hero-stage">
        <ExampleMedia key={remixExample.poster} example={remixExample} enabled={active} videoGuide={scene.modality === 'video'} />
      </div>
      <div className="om-guide-heading">
        <h2 className="om-title">{remixExample.title}</h2>
        <p className="om-muted">{remixExample.prompt}</p>
      </div>
    </section>;
  }
  if (scene.id === 'remove-background') return (
    <SceneComparisonGuide src={sofaCutout} width={1004} height={688}
      alt="An armchair before and after background removal"
      title="Remove the background in one click"
      description="For images with multiple subjects, describe what to keep, for example “Keep the sofa and coffee table.”" />
  );
  if (scene.id === 'relight') return (
    <SceneComparisonGuide src={sofaRelight} width={1280} height={715} wide
      alt="An armchair shown under three lighting setups"
      title="Relight with flexible lighting controls"
      description="Adjust light direction, color temperature, and mood to make any photo look its best." />
  );
  const options = studioExamples(destination);
  const idea = options[selected] ?? options[0];
  const [heroBefore, heroAfter] = t('Start creating with {model}').split('{model}');
  const designImage = destination.studio.id === 'design';
  const canvas = sceneLayout(scene) === 'canvas';
  const ideaPrompt = t(idea.prompt);
  const applied = Boolean(currentPrompt && currentPrompt.trim() === ideaPrompt.trim());
  const exampleActionLabel = t(applied ? 'Example applied' : 'Use this example');
  return canvas ? <section className="om-canvas-ideas">
    <div className="om-canvas-deck" role="group" aria-label={t('Try an idea')}>{options.map((item, index) =>
      <Button variant="plain" key={item.title} aria-label={t(item.title)} aria-pressed={index === selected} data-current={index === selected} onClick={() => { setSelected(index); if (!designImage) onPrompt(t(item.prompt)); }}>
        <img src={item.poster} alt="" style={{ objectPosition: item.posterPosition }} />{item.credit && <small className="om-scene-credit">{item.credit}</small>}
      </Button>)}</div>
    <h2 className="om-title">{modelName ? <>{heroBefore}<strong>{modelName}</strong>{heroAfter}</> : t(scene.label)}</h2>
    <p className="om-muted">{t('Describe a scene, subject, mood, or style and bring it to life')}</p>
    <Button variant="plain" className="om-canvas-pill om-canvas-idea-prompt" data-applied={applied || undefined} aria-label={designImage ? undefined : t('Use prompt')} title={ideaPrompt} onClick={() => onPrompt(ideaPrompt)}>
      <RemixIcon name={applied ? 'check-line' : 'add-line'} size={15} />{designImage ? exampleActionLabel : t(idea.title)}
    </Button>
  </section> : <section className="om-scene-guide om-scene-hero">
    <div className="om-scene-hero-stage">
      {scene.id === 'speech'
        ? <blockquote className="om-speech-script"><RemixIcon name="voiceprint-line" size={28} /><p>{ideaPrompt}</p></blockquote>
        : <ExampleMedia key={idea.title} example={idea} enabled={active} videoGuide={destination.studio.id === 'cinema' && scene.modality === 'video'} />}
    </div>
    <div className="om-guide-heading">
      <h2 className="om-title">{t(idea.title)}</h2>
      {scene.id !== 'speech' && <p className="om-muted">{ideaPrompt}</p>}
    </div>
    <Button variant="plain" className="om-canvas-pill om-canvas-idea-prompt" data-applied={applied || undefined} title={ideaPrompt} onClick={() => onPrompt(ideaPrompt)}>
      <RemixIcon name={applied ? 'check-line' : 'add-line'} size={15} />{exampleActionLabel}
    </Button>
  </section>;
}
