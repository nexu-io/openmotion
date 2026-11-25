import { Button } from 'open-design-ui/button';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { gamePublishDevTool } from './devTools';
import { downloadPackage, formatBytes, type GamePackageCheck } from './gamePackage';
import { copyGamePublishLink, gamePublishActions, stepBlocked, useGamePublishSession, type GamePublishSession } from './gamePublishStore';
import { GamePublishResultAction } from './GamePublishThread';
import { playableNetwork } from './playableNetworks';
import { ENABLED_PUBLISH_PLATFORMS, GAME_PUBLISH_PLATFORMS, gamePublishPlatform, type GamePublishPlatform, type GamePublishPlatformId } from './platforms';
import { ChoiceTiles } from '../../components/ui/ChoiceTiles';
import { PlatformIcon } from '../../../../packages/design-system/react/PlatformIcon';
import { CompactLink, WechatProgress } from './WechatProgress';
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

  const statusLine = (
    <div className="om-gp-status" data-tone={session.status.tone} role="status">
      <span className="om-gp-status-dot" aria-hidden="true" />
      <span className="om-gp-status-text">{t(session.status.key, session.status.vars)}</span>
      {session.chatId && <span className="om-gp-status-hint">{t('Details in the conversation')}</span>}
    </div>
  );

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
  let showStatus = true;

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
    showStatus = false;
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
    showStatus = false;
  } else if (session.view === 'step') {
    head = header(t(platform.name), { label: t('Platforms'), onClick: () => gamePublishActions.showList(artifactId) });
    const step = platform.steps[session.stepIndex];
    const blocked = stepBlocked(session, step);
    body = (
      <>
        <StepBar session={session} platform={platform} />
        <h3 className="om-gp-h3">{t(step.title)}</h3>
        <p className="om-gp-muted">{t(step.why)}</p>
        {step.kind !== 'package' && step.kind !== 'link' && step.todo.length > 0 && !step.pick && !step.fields && (
          <ol className="om-gp-todo">{step.todo.map(item => <li key={item}>{t(item)}</li>)}</ol>
        )}
        {step.fields?.map(field => (
          <label key={field.label} className="om-gp-field">
            <span className="om-gp-field-label">{t(field.label)}</span>
            <input
              className="om-gp-input"
              inputMode="url"
              value={session.inputs[field.label] ?? ''}
              placeholder={field.placeholder ? t(field.placeholder) : undefined}
              onChange={event => gamePublishActions.setInput(artifactId, field.label, event.target.value)}
            />
          </label>
        ))}
        {step.pick && (
          <div className="om-gp-chips" role="radiogroup" aria-label={t(step.title)}>
            {step.pick.map(option => (
              <Button key={option} variant="plain" type="button" role="radio" aria-checked={session.picked === option} className="om-gp-chip" data-selected={session.picked === option || undefined} onClick={() => gamePublishActions.pick(artifactId, option)}>
                {option}
              </Button>
            ))}
          </div>
        )}
        {step.kind === 'package' && <PackageStep session={session} />}
        {step.kind === 'link' && <LinkStep session={session} onNotify={onNotify} />}
        {step.links && (
          <div className="om-gp-links">
            {step.links.map(link => (
              <a key={link.label} className="om-gp-link" href={link.href} target="_blank" rel="noopener noreferrer">{t(link.label)} <RemixIcon name="external-link-line" size={12} /></a>
            ))}
          </div>
        )}
        {session.stepProblem && <p className="om-gp-need">{t(session.stepProblem)}</p>}
      </>
    );
    foot = (
      <>
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={close}>{t('Hide for now')}</Button>
        <span className="om-gp-spacer" />
        <Button variant="plain" type="button" className="om-gp-primary" disabled={blocked} onClick={() => gamePublishActions.completeStep(artifactId)}>
          {t(step.cta)}
        </Button>
      </>
    );
  } else {
    head = header(t(platform.name));
    body = (
      <>
        <StepBar session={session} platform={platform} />
        <div className="om-gp-result">
          <RemixIcon name="checkbox-circle-fill" size={30} className="om-gp-result-icon" />
          <strong>{t(platform.resultTitle)}</strong>
          <span className="om-gp-muted">{t(platform.resultDetail)}</span>
          {session.linkUrl && <span className="om-gp-muted">{t('Live on OpenDesign')} · <CompactLink url={session.linkUrl} onNotify={onNotify} /></span>}
          <GamePublishResultAction action={platform.resultAction} href={platform.resultHref} />
        </div>
      </>
    );
    foot = (
      <>
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={() => gamePublishActions.showList(artifactId)}>{t('Publish to another platform')}</Button>
        <span className="om-gp-spacer" />
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={close}>{t('Close')}</Button>
      </>
    );
  }

  return (
    <aside className="om-gp-panel" aria-label={t('Publish panel')}>
      {head}
      <div className="om-gp-body">{body}</div>
      {showStatus && statusLine}
      {foot && <footer className="om-gp-foot">{foot}</footer>}
      {session.view === 'step' && session.toolCheck?.state === 'missing' && <DevToolDialog session={session} />}
    </aside>
  );
}

/** Step n of N with a short bar, for platforms guided by the panel. */
function StepBar({ session, platform }: { session: GamePublishSession; platform: GamePublishPlatform }) {
  const { t } = useI18n();
  const total = platform.steps.length;
  const current = Math.min(session.stepIndex + 1, total);
  return (
    <div className="om-gp-progress" aria-label={t('Publish steps')}>
      <span className="om-gp-progress-label">{session.view === 'result' ? t('All {total} steps done', { total }) : t('Step {current} of {total}', { current, total })}</span>
      <ol className="om-gp-progress-bar">
        {platform.steps.map((step, index) => (
          <li key={step.short} title={t(step.short)} data-state={index < session.stepIndex || session.view === 'result' ? 'done' : index === session.stepIndex ? 'current' : 'todo'} />
        ))}
      </ol>
    </div>
  );
}

function CheckRow({ check }: { check: GamePackageCheck }) {
  const { t } = useI18n();
  const icon = check.tone === 'ok' ? 'checkbox-circle-fill' : check.tone === 'warn' ? 'error-warning-line' : 'alert-fill';
  return (
    <div className="om-gp-check" data-tone={check.tone}>
      <RemixIcon name={icon} size={14} />
      <span className="om-gp-check-label">{t(check.label)}</span>
      <span className="om-gp-check-value">{t(check.value, check.vars)}</span>
    </div>
  );
}

/** Real package: built from the game's files, checked, downloaded by the browser. */
function PackageStep({ session }: { session: GamePublishSession }) {
  const { t } = useI18n();
  const pkg = session.package;
  const network = pkg?.target === 'playable' ? playableNetwork(session.picked) : undefined;
  if (!pkg || pkg.state === 'building') {
    return (
      <div className="om-gp-wait">
        <RemixIcon name="loader-4-line" size={24} className="om-gp-spin" />
        <span className="om-gp-muted">{t('Building the package')}</span>
      </div>
    );
  }
  if (pkg.state === 'failed' || !pkg.result) {
    return (
      <div className="om-gp-checks">
        <p className="om-gp-error">{t('Could not build the package: {message}', { message: pkg.error ?? '' })}</p>
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={() => void gamePublishActions.buildPackage(session.artifactId)}>{t('Try again')}</Button>
      </div>
    );
  }
  const { result } = pkg;
  return (
    <>
      <div className="om-gp-checks">
        <div className="om-gp-checks-head">
          <strong>{network?.name ?? result.fileName}</strong>
          <span className="om-gp-checks-meta">{formatBytes(result.bytes)}</span>
        </div>
        {result.checks.map(check => <CheckRow key={`${check.label}:${check.value}`} check={check} />)}
      </div>
      <div className="om-gp-download">
        <Button variant="plain" type="button" className="om-gp-secondary" onClick={() => downloadPackage(result)}>
          <RemixIcon name="download-2-line" size={14} />
          <span>{t('Download {file}', { file: result.fileName })}</span>
        </Button>
        {network && (
          <p className="om-gp-muted">{t('Upload it in {console} and preview it there before the ad goes live.', { console: t(network.console.label) })}</p>
        )}
        {network?.console.href && (
          <a className="om-gp-link" href={network.console.href} target="_blank" rel="noopener noreferrer">
            {t('Open {console}', { console: t(network.console.label) })} <RemixIcon name="external-link-line" size={12} />
          </a>
        )}
      </div>
    </>
  );
}

/** Step that needs the real OpenDesign link (Telegram). */
function LinkStep({ session, onNotify }: { session: GamePublishSession; onNotify?: Notify }) {
  const { t } = useI18n();
  if (session.linkUrl) {
    return (
      <div className="om-gp-checks">
        <div className="om-gp-check" data-tone="ok">
          <RemixIcon name="checkbox-circle-fill" size={14} />
          <span className="om-gp-check-label">{t('Live on OpenDesign')}</span>
          <span className="om-gp-check-value"><CompactLink url={session.linkUrl} onNotify={onNotify} /></span>
        </div>
      </div>
    );
  }
  return (
    <div className="om-gp-checks">
      {session.linkError && <p className="om-gp-error">{t('Publishing failed: {message}', { message: session.linkError.message })}</p>}
      <Button variant="plain" type="button" className="om-gp-secondary" disabled={session.linkPublishing} onClick={() => void gamePublishActions.publishLink(session.artifactId)}>
        {session.linkPublishing ? t('Publishing on OpenDesign…') : session.linkError ? t('Try again') : t('Publish on OpenDesign')}
      </Button>
    </div>
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

/**
 * Shown when the chosen platform needs a local developer tool. OpenDesign cannot check the
 * machine yet, so it links to the official download and continues when the user says it is installed.
 */
function DevToolDialog({ session }: { session: GamePublishSession }) {
  const { t } = useI18n();
  const tool = gamePublishDevTool(session.toolCheck?.toolId);
  if (!tool) return null;
  return (
    <div className="om-gp-dialog-scrim">
      <div className="om-gp-dialog" role="dialog" aria-modal="true" aria-labelledby="om-gp-dialog-title">
        <div className="om-gp-dialog-icon"><RemixIcon name="download-2-line" size={20} /></div>
        <h3 id="om-gp-dialog-title" className="om-gp-h3">{t('This platform needs {tool}', { tool: t(tool.name) })}</h3>
        <p className="om-gp-muted">{t(tool.why)}</p>
        {tool.alternative && <p className="om-gp-muted">{t(tool.alternative)}</p>}
        <div className="om-gp-dialog-actions">
          <a className="om-gp-primary" href={tool.downloadHref} target="_blank" rel="noopener noreferrer">
            <RemixIcon name="download-2-line" size={14} /> {t('Download')}
          </a>
          <Button variant="plain" type="button" className="om-gp-secondary" onClick={() => gamePublishActions.confirmDevTool(session.artifactId)}>
            {t('I installed it, continue')}
          </Button>
          <Button variant="plain" type="button" className="om-gp-text-button" onClick={() => gamePublishActions.skipDevTool(session.artifactId)}>
            {t('Later')}
          </Button>
        </div>
      </div>
    </div>
  );
}
