import { Button } from 'open-design-ui/button';
import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { gamePublishDevTool } from './devTools';
import { copyGamePublishLink, gamePublishActions, useGamePublishThread, useWechatPublishForChat, type GamePublishThreadEntry } from './gamePublishStore';
import { CompactLink, WechatInlineControls } from './WechatProgress';
import { gamePublishPlatform } from './platforms';
import './gamePublish.css';

type Notify = (message: string, tone?: 'info' | 'error') => void;

/**
 * Publish activity in the conversation: the user's actions, real work as it finishes, "Your turn"
 * cards and result cards. Reads the same store as the right-hand publish panel, so the user can
 * finish a step from either place. Local only — these entries are not sent to the Agent.
 */
export function GamePublishThread({ chatId, onOpenPanel, onNotify }: {
  chatId: string | null | undefined;
  onOpenPanel: (artifactId: string) => void;
  onNotify?: Notify;
}) {
  const { t } = useI18n();
  const entries = useGamePublishThread(chatId);
  const wechat = useWechatPublishForChat(chatId);
  const endRef = useRef<HTMLDivElement>(null);
  const lastEntry = entries.at(-1);
  const progressKey = lastEntry ? `${lastEntry.id}:${lastEntry.kind === 'agent' ? lastEntry.lines.length : 0}` : '';
  // Keep the newest publish activity in view, like new Agent messages.
  useEffect(() => {
    if (progressKey) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [progressKey]);
  if (!entries.length && !wechat) return null;
  return (
    <div className="om-gp-thread" aria-label={t('Publish activity')}>
      {entries.map(entry => <ThreadEntry key={entry.id} entry={entry} onOpenPanel={onOpenPanel} onNotify={onNotify} />)}
      {wechat && <WechatInlineControls session={wechat} />}
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
  if (entry.kind === 'need') return <NeedCard entry={entry} onOpenPanel={onOpenPanel} />;
  if (entry.kind === 'tool') {
    const tool = gamePublishDevTool(entry.toolId);
    if (!tool) return null;
    if (entry.state === 'ok') {
      return <div className="om-gp-user">{t('You confirmed {tool} is installed', { tool: t(tool.name) })}</div>;
    }
    if (entry.state === 'skipped') {
      return <div className="om-gp-user">{t('Later: {tool} is not installed yet', { tool: t(tool.name) })}</div>;
    }
    return (
      <div className="om-gp-card">
        <div className="om-gp-card-eyebrow">{t('Needed · {tool}', { tool: t(tool.name) })}</div>
        <p>{t(tool.why)}</p>
        <div className="om-gp-card-actions">
          <a className="om-gp-secondary" href={tool.downloadHref} target="_blank" rel="noopener noreferrer"><RemixIcon name="download-2-line" size={14} /> {t('Download')}</a>
          {/* WeChat publishing works without the tool, so the card offers the same choice as the panel. */}
          {entry.platformId === 'wechat' ? (
            <Button variant="plain" type="button" className="om-gp-primary" onClick={() => { onOpenPanel(entry.artifactId); gamePublishActions.dismissDevTool(entry.artifactId); }}>{t('Continue without it')}</Button>
          ) : (
            <Button variant="plain" type="button" className="om-gp-primary" onClick={() => { onOpenPanel(entry.artifactId); gamePublishActions.confirmDevTool(entry.artifactId); }}>{t('I installed it, continue')}</Button>
          )}
        </div>
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

/** "Your turn" card for platforms guided by the panel. WeChat is guided by the Agent in the conversation instead. */
function NeedCard({ entry, onOpenPanel }: { entry: Extract<GamePublishThreadEntry, { kind: 'need' }>; onOpenPanel: (artifactId: string) => void }) {
  const { t } = useI18n();
  const platform = gamePublishPlatform(entry.platformId);
  const step = platform?.steps[entry.stepIndex];
  if (!platform || !step) return null;
  const ref = { platformId: entry.platformId, stepIndex: entry.stepIndex };
  const openStep = () => { onOpenPanel(entry.artifactId); gamePublishActions.resumeStep(entry.artifactId, ref); };
  const where = { name: t(platform.name), current: entry.stepIndex + 1, total: platform.steps.length };
  if (entry.closed) {
    return (
      <div className="om-gp-history" data-abandoned={entry.outcome !== 'done' || undefined}>
        <RemixIcon name={entry.outcome === 'done' ? 'check-line' : 'close-line'} size={13} />
        <span>{t(entry.outcome === 'done' ? 'Done: {title}' : 'Not finished: {title}', { title: t(step.title) })}</span>
      </div>
    );
  }
  return (
    <div className="om-gp-card">
      <div className="om-gp-card-eyebrow">{t('Your turn · {name} step {current} of {total}', where)}</div>
      <p>{t(step.why)}</p>
      <ol>{step.todo.map(item => <li key={item}>{t(item)}</li>)}</ol>
      <div className="om-gp-card-actions">
        {step.pick ? (
          <Button variant="plain" type="button" className="om-gp-primary" onClick={openStep}>{t('Choose in the panel')}</Button>
        ) : (
          <>
            <Button variant="plain" type="button" className="om-gp-primary" onClick={() => gamePublishActions.completeStep(entry.artifactId, ref)}>{t(step.cta)}</Button>
            <Button variant="plain" type="button" className="om-gp-secondary" onClick={openStep}>{t('Open in the panel')}</Button>
          </>
        )}
      </div>
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
