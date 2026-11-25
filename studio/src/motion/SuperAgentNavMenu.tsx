import { Button } from 'open-design-ui/button';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import audioCover from './scene-art/super-agent/audio.webp';
import gameCover from './scene-art/super-agent/game.webp';
import imageCover from './scene-art/super-agent/image.webp';
import videoCover from './scene-art/super-agent/video.webp';
import type { SuperAgentRouteMode } from './workspacePageRouting';

const featuredModes = [
  { mode: 'game', label: 'Build a game', poster: gameCover },
  { mode: 'image', label: 'Generate image', poster: imageCover },
  { mode: 'motion', label: 'Generate video', poster: videoCover },
  { mode: 'audio', label: 'Create audio', poster: audioCover },
] as const;

const moreModes = [
  { mode: 'coding', label: 'Coding', icon: 'code-s-slash-line' },
  { mode: 'media', label: 'Cinema Video', icon: 'clapperboard-line' },
  { mode: 'deck', label: 'Create slides', icon: 'slideshow-line' },
  { mode: 'website', label: 'Build a website', icon: 'layout-line' },
] as const;

export function SuperAgentNavMenu({ onSelect }: { onSelect: (mode: SuperAgentRouteMode) => void }) {
  const { t } = useI18n();
  return <div className="om-agent-nav-menu">
    <h2>{t('Super Agent')}</h2>
    <div className="om-media-menu-grid om-media-mega-entries">
      {featuredModes.map(({ mode, label, poster }) => (
        <Button type="button" variant="plain" key={mode} className="om-scene-tile" onClick={() => onSelect(mode)}>
          <span className="om-scene-tile-art">
            <img src={poster} alt="" decoding="async" />
            {mode === 'game' && <span className="om-badge" data-nav-badge="New" lang="en">New</span>}
          </span>
          <strong>{t(label)}</strong>
        </Button>
      ))}
    </div>
    <section className="om-agent-nav-more" aria-label={t('More features')}>
      <h3>{t('More features')}</h3>
      <div className="om-agent-nav-list">
        {moreModes.map(({ mode, label, icon }) => (
          <Button type="button" variant="plain" key={mode} className="om-nav-item" onClick={() => onSelect(mode)}>
            <RemixIcon name={icon} size={16} />
            {t(label)}
          </Button>
        ))}
      </div>
    </section>
    <Button type="button" variant="plain" className="om-audio-menu-spotlight" onClick={() => onSelect('game')}>
      <span className="om-audio-menu-spotlight-copy">
        <span className="om-badge" data-nav-badge="New" lang="en">New</span>
        <strong className="om-audio-menu-spotlight-title">{t('Build a minigame in minutes')}</strong>
        <span className="om-audio-menu-spotlight-desc">{t('Turn one sentence into a game you can play in your browser')}</span>
      </span>
      <span className="om-audio-menu-spotlight-cta">
        <span>{t('Try now')}</span>
        <RemixIcon name="arrow-right-s-line" size={16} />
      </span>
    </Button>
  </div>;
}
