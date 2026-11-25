import { Button } from 'open-design-ui/button';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { copyGamePublishLink, gamePublishActions, useGamePublishSession, type GamePublishSession } from './gamePublishStore';
import { GamePublishResultAction } from './GamePublishThread';
import { ENABLED_PUBLISH_PLATFORMS, GAME_PUBLISH_PLATFORMS, gamePublishPlatform, type GamePublishPlatform, type GamePublishPlatformId } from './platforms';
import { ChoiceTiles } from '../../components/ui/ChoiceTiles';
import { PlatformIcon } from '../../../../packages/design-system/react/PlatformIcon';
import { CompactLink, WechatProgress } from './WechatProgress';
import { PlatformProgress } from './PlatformStepControls';
import './gamePublish.css';

type Notify = (message: string, tone?: 'info' | 'error') => void;

/**
 * Right-hand publish panel, docked inside the Artifact viewer next to the game preview.
 * Fixed position and height; one step at a time. Real work (OpenDesign link, packages) reports
 * its real result; console steps record what the user says they did.
 */
export function GamePublishPanel({ artifactId, coverUrl, onNotify }: {
  artifactId: string;
  coverUrl?: string;
  onNotify?: Notify;
}) {
  const { t } = useI18n();
  const session = useGamePublishSession(artifactId);
  if (!session?.open) return null;
  const platform = gamePublishPlatform(session.platformId);
  const close = () => gamePublishActions.close(artifactId);

  const header = (title: string, back?: { label: string; onClick: () => void }) => (
    <header className="om-gp-head">
      {back && (
        <Button variant="plain" type="button" className="om-gp-back" onClick={back.onClick}>
          <RemixIcon name="arrow-left-s-line" size={15} />
          <span>{back.label}</span>
        </Button>
      )}
      <h2 className="om-gp-title">{title}</h2>
      <Button variant="plain" type="button" className="om-gp-close" aria-label={t('Close')} onClick={close}>
        <RemixIcon name="close-line" size={16} />
      </Button>
    </header>
  );

  // Same tiles as the video export panel: one square per platform with its mark. OpenDesign is not a tile: it is the
  // checked-by-default line under them (OpenDesignChoice), and every platform picked above also gets its link.
  const tiles = (list: readonly GamePublishPlatform[]) => (
    <ChoiceTiles<GamePublishPlatformId | ''>
      label={t('Choose a platform')}
      value=''
      className="om-gp-platforms"
      options={[
        ...list.map(item => ({
          value: item.id,
          label: t(item.name),
          icon: item.icon
            ? <PlatformIcon platform={item.icon} />
            : <span className="om-platform-icon om-gp-badge" aria-hidden="true">{item.badge}</span>,
        })),
      ]}
      onChange={id => {
        if (id) gamePublishActions.choose(artifactId, id);
      }}
    />
  );

  const enabled = GAME_PUBLISH_PLATFORMS.filter(item => ENABLED_PUBLISH_PLATFORMS.includes(item.id));

  let body: ReactNode;
  let foot: ReactNode;
  let head: ReactNode;

  if (platform?.id === 'wechat' && session.view !== 'list') {
    // WeChat is guided by the Agent in the conversation; the panel only shows where things stand.
    head = header(t(platform.name), { label: t('Platforms'), onClick: () => gamePublishActions.showList(artifactId) });
    body = <WechatProgress session={session} />;
    foot = (
      <>
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={close}>{t('Hide for now')}</Button>
        <span className="om-gp-spacer" />
      </>
    );
  } else if (session.view === 'list' || !platform) {
    head = header(t('Choose a platform'));
    body = (
      <>
        <div className="om-gp-hero">
          {coverUrl ? <img src={coverUrl} alt="" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} /> : <span className="om-gp-hero-placeholder"><RemixIcon name="gamepad-line" size={22} /></span>}
          <div>
            <strong>{session.gameTitle}</strong>
            <p>{t('Pick one to start. Steps are shown one at a time.')}</p>
          </div>
        </div>
        {tiles(enabled)}
        <OpenDesignChoice session={session} onNotify={onNotify} />
      </>
    );
  } else {
    // Other platforms are guided by the Agent in the conversation too; the panel only shows where things stand.
    head = header(t(platform.name), { label: t('Platforms'), onClick: () => gamePublishActions.showList(artifactId) });
    body = (
      <>
        <PlatformProgress session={session} />
        {session.view === 'result' && <GamePublishResultAction action={platform.resultAction} href={platform.resultHref} />}
      </>
    );
    foot = session.view === 'result' ? (
      <>
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={() => gamePublishActions.showList(artifactId)}>{t('Publish to another platform')}</Button>
        <span className="om-gp-spacer" />
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={close}>{t('Close')}</Button>
      </>
    ) : (
      <>
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={close}>{t('Hide for now')}</Button>
        <span className="om-gp-spacer" />
      </>
    );
  }

  return (
    <aside className="om-gp-panel" aria-label={t('Publish panel')}>
      {head}
      <div className="om-gp-body">{body}</div>
      {foot && <footer className="om-gp-foot">{foot}</footer>}
    </aside>
  );
}

/**
 * OpenDesign, one small line under the platform tiles, checked by default: every platform picked above also
 * publishes the OpenDesign play link. "Only OpenDesign" publishes the link on its own.
 */
function OpenDesignChoice({ session, onNotify }: { session: GamePublishSession; onNotify?: Notify }) {
  const { t } = useI18n();
  if (session.linkUrl) {
    return (
      <div className="om-gp-od-line" data-done>
        <RemixIcon name="checkbox-circle-fill" size={14} />
        <span className="om-gp-od-line-text">{t('Live on OpenDesign')}</span>
        <CompactLink url={session.linkUrl} onNotify={onNotify} />
      </div>
    );
  }
  return (
    <div className="om-gp-od-line" data-failed={session.linkError ? true : undefined}>
      <label className="om-gp-od-line-text">
        <input
          type="checkbox"
          checked={session.linkToo}
          disabled={session.linkPublishing}
          onChange={event => gamePublishActions.setLinkToo(session.artifactId, event.target.checked)}
        />
        <span>
          {session.linkPublishing ? t('Publishing on OpenDesign…')
            : session.linkError ? (session.linkError.authRequired ? t('Sign in to OpenDesign first, then try again.') : t('Publishing failed: {message}', { message: session.linkError.message }))
              : t('Also publish on OpenDesign')}
        </span>
      </label>
      {!session.linkPublishing && (
        <Button variant="plain" type="button" className="om-gp-text-btn" onClick={() => void gamePublishActions.publishLink(session.artifactId)}>
          {session.linkError ? t('Try again') : t('Only OpenDesign')}
        </Button>
      )}
    </div>
  );
}
