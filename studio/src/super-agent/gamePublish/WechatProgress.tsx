import { Button } from 'open-design-ui/button';
import qrcode from 'qrcode-generator';
import { useMemo, useRef } from 'react';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { copyGamePublishLink, gamePublishActions, type GamePublishSession } from './gamePublishStore';
import { WECHAT_STEPS } from './platforms';
import type { WechatPublishStatus, WechatStepKey } from './wechatClient';
import './gamePublish.css';

type StepState = WechatPublishStatus['steps'][number]['status'];
type ShownState = 'done' | 'confirmed' | 'current' | 'blocked' | 'unknown' | 'todo';

const STATE_LABEL: Record<ShownState, string> = {
  done: 'Done', confirmed: 'You confirmed', current: 'In progress', blocked: 'Needs a fix', unknown: 'Check in WeChat', todo: 'Not started',
};
const STATE_ICON: Partial<Record<ShownState, string>> = {
  done: 'checkbox-circle-fill', confirmed: 'checkbox-circle-line', current: 'arrow-right-fill', blocked: 'alert-fill', unknown: 'error-warning-line',
};

/**
 * WeChat publishing, right-hand panel: only where things stand. Every instruction comes from the Agent in the
 * conversation; this reads the same progress record its openmotion_game_wechat calls write.
 */
export function WechatProgress({ session }: { session: GamePublishSession }) {
  const { t } = useI18n();
  const wechat = session.wechat;
  const status = wechat?.status;
  if (!status) {
    return (
      <div className="om-gp-overview">
        <p className="om-gp-overview-now" role="status">
          {wechat?.error
            ? <span className="om-gp-error">{t('Could not read the progress from OpenDesign on this computer. Make sure OpenDesign is running. ({message})', { message: wechat.error })}</span>
            : <span className="om-gp-muted"><RemixIcon name="loader-4-line" size={13} className="om-gp-spin" /> {t('Reading the progress')}</span>}
        </p>
      </div>
    );
  }
  const byKey = new Map(status.steps.map(step => [step.key, step]));
  const shown = (key: WechatStepKey, byUser?: boolean): ShownState => {
    const state: StepState | undefined = byKey.get(key)?.status;
    if (state === 'done') return byUser ? 'confirmed' : 'done';
    if (state === 'blocked') return 'blocked';
    if (state === 'unknown') return 'unknown';
    return status.current === key ? 'current' : 'todo';
  };
  const main = WECHAT_STEPS.filter(step => !step.later);
  const optional = WECHAT_STEPS.filter(step => step.later);
  const currentIndex = WECHAT_STEPS.findIndex(step => step.key === status.current);
  const current = WECHAT_STEPS[currentIndex];
  const line = !current
    ? t('Released on WeChat')
    : current.later
      ? t('Going live (optional) · {current} of {total} · {name}', { current: currentIndex - main.length + 1, total: optional.length, name: t(current.name) })
      : t('Step {current} of {total} · {name}', { current: currentIndex + 1, total: main.length, name: t(current.name) });
  const mainDone = main.every(step => byKey.get(step.key)?.status === 'done');

  const item = (step: (typeof WECHAT_STEPS)[number], number?: number) => {
    const s = shown(step.key, step.byUser);
    const icon = STATE_ICON[s];
    return (
      <li key={step.key} className="om-gp-overview-item" data-state={s} aria-current={s === 'current' ? 'step' : undefined}>
        {icon ? <RemixIcon name={icon} size={14} /> : <span className="om-gp-overview-dot" aria-hidden="true" />}
        <span className="om-gp-overview-name">{number ? `${number}. ` : ''}{t(step.name)}</span>
        <span className="om-gp-overview-state">{t(STATE_LABEL[s])}</span>
      </li>
    );
  };

  return (
    <div className="om-gp-overview">
      <p className="om-gp-overview-now" role="status">
        <strong>{line}</strong>
        <span className="om-gp-muted"> · {t('The Agent guides you in the conversation')}</span>
      </p>
      <OpenDesignProgress session={session} />
      <ol className="om-gp-overview-list">{main.map((step, index) => item(step, index + 1))}</ol>

      <h3 className="om-gp-group">{mainDone ? t('Going live') : t('Going live (optional)')}</h3>
      <ol className="om-gp-overview-list">{optional.map(step => item(step))}</ol>
    </div>
  );
}

/** The OpenDesign link (selected by default on the platform list), above the platform's steps. */
export function OpenDesignProgress({ session }: { session: GamePublishSession }) {
  const { t } = useI18n();
  if (!session.linkToo && !session.linkUrl && !session.linkPublishing && !session.linkError) return null;
  const state: ShownState = session.linkUrl ? 'done' : session.linkError ? 'blocked' : session.linkPublishing ? 'current' : 'todo';
  const icon = session.linkPublishing ? 'loader-4-line' : STATE_ICON[state];
  return (
    <ol className="om-gp-overview-list">
      <li className="om-gp-overview-item" data-state={state}>
        {icon ? <RemixIcon name={icon} size={14} className={session.linkPublishing ? 'om-gp-spin' : undefined} /> : <span className="om-gp-overview-dot" aria-hidden="true" />}
        <span className="om-gp-overview-name">OpenDesign · {t('Play link')}</span>
        <span className="om-gp-overview-state">{session.linkUrl ? t('Done') : session.linkError ? t('Needs a fix') : session.linkPublishing ? t('Publishing…') : t('Not started')}</span>
      </li>
    </ol>
  );
}

/**
 * A published OpenDesign link as two actions, Open (new tab) and Copy link (the full URL). The URL itself is never
 * shown as text.
 */
export function CompactLink({ url, onNotify }: { url: string; onNotify?: (message: string, tone?: 'info' | 'error') => void }) {
  const { t } = useI18n();
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return (
    <span className="om-gp-compact-link">
      <span className="om-gp-compact-link-row">
        <a className="om-gp-text-btn" href={full} target="_blank" rel="noopener noreferrer">{t('Open')}</a>
        <Button variant="plain" type="button" className="om-gp-text-btn" onClick={() => void copyGamePublishLink(full, onNotify, t)}>{t('Copy link')}</Button>
      </span>
    </span>
  );
}

/** QR code for the OpenDesign game link. */
export function LinkQr({ url, size = 132 }: { url: string; size?: number }) {
  const { t } = useI18n();
  const src = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(url);
    code.make();
    return code.createDataURL(4, 8);
  }, [url]);
  return (
    <figure className="om-gp-qr-real" style={{ width: size }}>
      <img src={src} alt={t('QR code for the game link')} width={size} height={size} />
      <figcaption className="om-gp-muted">{t('Scan with WeChat to open the game in WeChat')}</figcaption>
    </figure>
  );
}

/**
 * In the conversation, under the Agent's messages: the two WeChat steps the Agent cannot do through chat.
 * The key file goes straight from the browser to the local service (never into a message or the Agent's context);
 * the preview code is an image of what WeChat returned. Rendered by the page, not sent to the Agent.
 */
export function WechatInlineControls({ session }: { session: GamePublishSession }) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const wechat = session.wechat;
  const status = wechat?.status;
  if (!status) return null;
  const showKey = status.current === 'key' && Boolean(status.appid);
  // Only after WeChat refused the saved key (wrong file, or a key for another AppID); otherwise there is nothing to replace.
  const canReplaceKey = Boolean(status.appid && status.hasKey && status.keyRejected);
  const showQr = Boolean(status.preview) && (status.current === 'preview' || status.current === 'upload');
  if (!showKey && !showQr && !canReplaceKey) return null;
  return (
    <div className="om-gp-inline">
      {(showKey || canReplaceKey) && (
        <div className="om-gp-inline-row">
          <input
            ref={fileRef}
            type="file"
            accept=".key,.pem,text/plain"
            hidden
            onChange={async event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) await gamePublishActions.saveWechatKey(session.artifactId, await file.text());
            }}
          />
          {canReplaceKey && !showKey && <span className="om-gp-error">{t('WeChat did not accept the saved key. Choose the .key file for this AppID again.')}</span>}
          <Button variant="plain" type="button" className="om-gp-secondary" disabled={wechat?.keySaving} onClick={() => fileRef.current?.click()}>
            <RemixIcon name="upload-2-line" size={14} />
            <span>{wechat?.keySaving ? t('Saving…') : showKey ? t('Choose the .key file') : t('Use a different .key file')}</span>
          </Button>
          {showKey && <span className="om-gp-muted">{t('Saved only on this computer, never in the conversation.')}</span>}
          {wechat?.keyError && <p className="om-gp-error">{t('Could not save the key: {message}', { message: wechat.keyError })}</p>}
        </div>
      )}
      {showQr && status.preview && (
        <figure className="om-gp-qr-real">
          <img src={`${status.preview.qrcodeUrl}?t=${encodeURIComponent(status.preview.createdAt)}`} alt={t('WeChat preview code')} width={160} height={160} />
          <figcaption className="om-gp-muted">{t('Only administrators, developers and testers can open it. It expires.')}</figcaption>
        </figure>
      )}
    </div>
  );
}
