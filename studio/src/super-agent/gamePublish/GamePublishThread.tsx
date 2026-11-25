import { Button } from 'open-design-ui/button';
import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { copyGamePublishLink, gamePublishActions, useGamePublishThread, usePublishForChat, type GamePublishThreadEntry } from './gamePublishStore';
import { CompactLink, WechatInlineControls } from './WechatProgress';
import { PlatformInlineControls } from './PlatformStepControls';
import './gamePublish.css';

type Notify = (message: string, tone?: 'info' | 'error') => void;

/**
 * Publish activity in the conversation, rendered by the page under the Agent's messages: real work as it finishes
 * (the OpenDesign link, package builds) and the controls of the current step. The Agent itself guides each step;
 * these entries are not sent to it.
 */
export function GamePublishThread({ chatId, onOpenPanel, onNotify }: {
  chatId: string | null | undefined;
  onOpenPanel: (artifactId: string) => void;
  onNotify?: Notify;
}) {
  const { t } = useI18n();
  const entries = useGamePublishThread(chatId);
  const active = usePublishForChat(chatId);
  const endRef = useRef<HTMLDivElement>(null);
  const lastEntry = entries.at(-1);
  const progressKey = lastEntry ? `${lastEntry.id}:${lastEntry.kind === 'agent' ? lastEntry.lines.length : 0}` : '';
  // Keep the newest publish activity in view, like new Agent messages.
  useEffect(() => {
    if (progressKey) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [progressKey]);
  if (!entries.length && !active) return null;
  return (
    <div className="om-gp-thread" aria-label={t('Publish activity')}>
      {entries.map(entry => <ThreadEntry key={entry.id} entry={entry} onOpenPanel={onOpenPanel} onNotify={onNotify} />)}
      {active && (active.platformId === 'wechat' ? <WechatInlineControls session={active} /> : <PlatformInlineControls session={active} onNotify={onNotify} />)}
      <div ref={endRef} />
    </div>
  );
}

function ThreadEntry({ entry, onOpenPanel, onNotify }: { entry: GamePublishThreadEntry; onOpenPanel: (artifactId: string) => void; onNotify?: Notify }) {
  const { t } = useI18n();
  if (entry.kind === 'user') {
    return <div className="om-gp-user">{t(entry.key, entry.name ? { name: t(entry.name) } : undefined)}</div>;
  }
  if (entry.kind === 'agent') {
    return (
      <div className="om-gp-agent">
        <div className="om-gp-agent-title">{t(entry.title, entry.name ? { name: t(entry.name) } : undefined)}</div>
        {entry.lines.map((line, index) => (
          <div key={index} className="om-gp-line" data-done={line.done || undefined} data-failed={!line.done || undefined}>
            <RemixIcon name={line.done ? 'check-line' : 'close-line'} size={13} />
            <span>{t(line.text, line.vars)}</span>
          </div>
        ))}
        {!entry.lines.length && (
          <div className="om-gp-line"><RemixIcon name="loader-4-line" size={13} className="om-gp-spin" /><span>{t('Working…')}</span></div>
        )}
      </div>
    );
  }
  if (entry.kind === 'link-failed') {
    return (
      <div className="om-gp-result-card" data-failed>
        <RemixIcon name="alert-fill" size={22} className="om-gp-result-icon" />
        <strong>{t('Publishing on OpenDesign failed')}</strong>
        <span className="om-gp-muted">{entry.authRequired ? t('Sign in to OpenDesign first, then try again.') : entry.message}</span>
        {!entry.closed && <Button variant="plain" type="button" className="om-gp-primary" onClick={() => void gamePublishActions.publishLink(entry.artifactId)}>{t('Try again')}</Button>}
      </div>
    );
  }
  return (
    <div className="om-gp-result-card">
      <RemixIcon name="checkbox-circle-fill" size={22} className="om-gp-result-icon" />
      <strong>{t(entry.title)}</strong>
      {entry.link
        ? <CompactLink url={entry.detail} onNotify={onNotify} />
        : <>
          <span className="om-gp-muted">{t(entry.detail, entry.vars)}</span>
          <GamePublishResultAction action={entry.action} href={entry.href} />
        </>}
    </div>
  );
}

/** Result-card button: opens the platform's official page. */
export function GamePublishResultAction({ action, href }: { action?: string; href?: string }) {
  const { t } = useI18n();
  if (!action || !href) return null;
  return (
    <a className="om-gp-primary" href={href} target="_blank" rel="noopener noreferrer">
      {t(action)} <RemixIcon name="external-link-line" size={12} />
    </a>
  );
}
