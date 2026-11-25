import { Button } from 'open-design-ui/button';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { copyGamePublishLink, gamePublishActions, useGamePublishSession, type GamePublishSession } from './gamePublishStore';
import { GamePublishResultAction } from './GamePublishThread';
import { ENABLED_PUBLISH_PLATFORMS, GAME_PUBLISH_PLATFORMS, gamePublishPlatform, type GamePublishPlatform, type GamePublishPlatformId } from './platforms';
import { ChoiceTiles } from '../../components/ui/ChoiceTiles';
import { PlatformIcon } from '../../../../packages/design-system/react/PlatformIcon';
import { LinkQr, WechatProgress } from './WechatProgress';
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

  // Same tiles as the video export panel: one square per destination with its mark. The OpenDesign link is a
  // destination like the others (a play link anyone can open), not a setting attached to them.
  const OPENDESIGN = 'opendesign' as const;
  const tiles = (list: readonly GamePublishPlatform[]) => (
    <ChoiceTiles<GamePublishPlatformId | typeof OPENDESIGN | ''>
      label={t('Choose a platform')}
      value={session.linkUrl ? OPENDESIGN : ''}
      className="om-gp-platforms"
      options={[
        { value: OPENDESIGN, label: 'OpenDesign', icon: <span className="om-platform-icon om-gp-od-icon" aria-hidden="true"><RemixIcon name="global-line" size={18} /></span> },
        ...list.map(item => ({
          value: item.id,
          label: t(item.name),
          icon: item.icon
            ? <PlatformIcon platform={item.icon} />
            : <span className="om-platform-icon om-gp-badge" style={{ background: item.color, color: '#fff' /* third-party brand badge */ }} aria-hidden="true">{item.badge}</span>,
        })),
      ]}
      onChange={id => {
        if (id === OPENDESIGN) void gamePublishActions.publishLink(artifactId);
        else if (id) gamePublishActions.choose(artifactId, id);
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
        <OpenDesignLinkOption session={session} onNotify={onNotify} />
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

/** Default-on option: publishing to any platform also publishes the game on OpenDesign. */
function OpenDesignLinkOption({ session, onNotify }: { session: GamePublishSession; onNotify?: Notify }) {
  const { t } = useI18n();
  if (session.linkUrl) {
    return (
      <div className="om-gp-option" data-done>
        <RemixIcon name="checkbox-circle-fill" size={16} className="om-gp-result-icon" />
        <span className="om-gp-option-text">
          <strong>{t('Live on OpenDesign')}</strong>
          <small>{session.linkUrl}</small>
        </span>
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={() => void copyGamePublishLink(session.linkUrl, onNotify, t)}>{t('Copy link')}</Button>
        <LinkQr url={session.linkUrl} />
      </div>
    );
  }
  if (session.linkError) {
    return (
      <div className="om-gp-option" data-failed>
        <RemixIcon name="alert-fill" size={16} className="om-gp-result-icon" />
        <span className="om-gp-option-text">
          <strong>{t('Publishing on OpenDesign failed')}</strong>
          <small>{session.linkError.authRequired ? t('Sign in to OpenDesign first, then try again.') : session.linkError.message}</small>
        </span>
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={() => void gamePublishActions.publishLink(session.artifactId)}>{t('Try again')}</Button>
      </div>
    );
  }
  if (session.linkPublishing) {
    return (
      <div className="om-gp-option">
        <RemixIcon name="loader-4-line" size={16} className="om-gp-spin" />
        <span className="om-gp-option-text"><strong>{t('Publishing on OpenDesign…')}</strong></span>
      </div>
    );
  }
  return null;
}
