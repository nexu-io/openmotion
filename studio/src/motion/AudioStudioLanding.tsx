import { Button } from 'open-design-ui/button';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useCloudFeatureEnabled } from '../utils/cloudFeatures';
import { scenesForStudio, type StudioDestination } from './creativeStudios';
import soundStudioCover from './scene-art/ambient-piano.webp';
import type { SoundLiveTabId } from './soundTabs';
import { studioExamples } from './sceneShowcase';
import { StudioLandingHero } from './StudioLandingHero';

/** Sound Studio home with its banner and audio template grid. */
export function AudioStudioLanding({ destination, active, onPrompt, onCreate }: {
  destination: StudioDestination; active: boolean; onPrompt: (prompt: string, tab: SoundLiveTabId) => void; onCreate: () => void;
}) {
  const { t } = useI18n();
  const soundEffectsEnabled = useCloudFeatureEnabled('soundEffects');
  const { studio } = destination;
  // The home has no scene tabs: it lists every template in the studio that has an audio preview.
  const templates = scenesForStudio(studio).flatMap(scene =>
    studioExamples({ ...destination, scene })
      .filter(example => example.audio && (soundEffectsEnabled || example.kind !== 'Sound effect'))
      .map(example => ({ ...example, scene })),
  );
  const [playingSource, setPlayingSource] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => { if (!active) audio.current?.pause(); }, [active]);
  const togglePlayback = (source?: string) => {
    const element = audio.current;
    if (!element || !source) return;
    if (element.getAttribute('src') !== source) element.src = source;
    else if (!element.paused) { element.pause(); return; }
    void element.play().catch(() => {});
  };
  return <div className="om-gallery-results om-studio-landing om-audio-landing">
    <audio
      ref={audio}
      preload="none"
      hidden
      onPlaying={event => setPlayingSource(event.currentTarget.getAttribute('src'))}
      onPause={() => setPlayingSource(null)}
      onEnded={() => setPlayingSource(null)}
      onEmptied={() => setPlayingSource(null)}
      onError={() => setPlayingSource(null)}
    />
    <StudioLandingHero
      title={t(studio.title)}
      description={t('Create a voice, a soundtrack, an atmosphere.')}
      poster={soundStudioCover}
    >
      <Button variant="ghost" className="om-button h-auto" data-primary="media" onClick={onCreate}>
        <RemixIcon name="add-line" size={16} />{t('Generate audio')}
      </Button>
    </StudioLandingHero>
    <section className="om-studio-template-shelf" aria-label={t('Audio templates')}>
      <header><h2 className="om-title">{t('Audio templates')}</h2></header>
      <div className="om-studio-template-grid">
        {templates.map(item => {
          const isPlaying = playingSource === item.audio;
          return <article key={item.title} className="om-gallery-card om-audio-card">
            <div className="om-gallery-card-media">
              <Button variant="plain" className="motion-gallery-card-cover om-gallery-cover" aria-pressed={isPlaying} aria-label={t(item.title)} onClick={() => togglePlayback(item.audio)}>
                <div className="om-gallery-poster" data-loaded="true"><img src={item.poster} alt="" loading="lazy" decoding="async" /></div>
                <span className="om-gallery-card-shade" />
                <span className="om-gallery-card-top">{item.kind && <span>{t(item.kind)}</span>}{item.seconds && <span>{t('{value}s', { value: item.seconds })}</span>}</span>
                <span className="om-gallery-card-bottom">
                  <span className="om-gallery-card-caption"><strong>{t(item.title)}</strong>{item.model && <small>{t('Recommended model')} · {item.model}</small>}</span>
                  <span className="om-gallery-card-arrow"><RemixIcon name={isPlaying ? 'pause-fill' : 'play-fill'} size={18} /></span>
                </span>
              </Button>
            </div>
            <div className="om-audio-card-prompt">
              <p className="om-muted"><span>{t('Audio prompt')}</span>{t(item.prompt)}</p>
              <Button variant="ghost" className="om-button h-auto" onClick={() => onPrompt(t(item.prompt), item.kind === 'Sound effect' ? 'sfx' : item.scene.id === 'speech' ? 'speech' : 'music')}><RemixIcon name="add-line" size={15} />{t('Use prompt')}</Button>
            </div>
          </article>;
        })}
      </div>
    </section>
  </div>;
}
