import { IconButton } from 'open-design-ui/icon-button';
import { Button } from 'open-design-ui/button';
import { Tooltip } from '../components/ui/Tooltip';
import { copyTextToClipboard } from '../utils/clipboard';
import { useState } from 'react';
import {
  hostNames,
  integrationConfig,
  integrationHost,
  integrationHosts,
  isStreamableHttpTransport,
  manualConnection,
  setupPrompt,
  setupGuideUrl,
  supportsChatgptCloud,
} from '../../../shared/integration';
import { useI18n } from '../i18n/I18n';
import { Select } from '../components/ui/Select';
import { RemixIcon } from '../icons/RemixIcons';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useIntegrationInfo } from './useIntegrationInfo';
import { SettingsDialog, SettingsLoading } from './settingsPrimitives';

/** Connect an external client to this workspace over Streamable HTTP MCP; never grants access itself. */
export function AgentConnectionDialog({ onClose, returnFocus }: { onClose: () => void; returnFocus?: HTMLElement | null }) {
  const { t, locale } = useI18n(), toast = useToast();
  const [host, setHost] = useState(() => integrationHost(new URLSearchParams(location.search).get('host')));
  const { info, failed, retry } = useIntegrationInfo();
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const prompt = setupPrompt(info, host, language);
  const manual = info ? manualConnection(info, host, language) : '';
  const supported = host !== 'chatgpt' || supportsChatgptCloud(info);
  const isHttp = isStreamableHttpTransport(info?.transport);
  const downloadConfig = (() => {
    if (!info || !supported) return null;
    if (isStreamableHttpTransport(info.transport)) {
      const cfg = integrationConfig(info, host);
      return { href: `data:${cfg.contentType},${encodeURIComponent(cfg.text)}`, filename: cfg.filename };
    }
    return { href: `/connect/config?host=${host}`, filename: undefined as string | undefined };
  })();

  async function copy(value: string) {
    try {
      if (!(await copyTextToClipboard(value))) throw new Error('Clipboard copy failed');
      toast.showToast(t('Copied to clipboard'), 'info', 'feedback');
    } catch { toast.showToast(t('Could not copy. Select and copy the text manually.'), 'error', 'feedback'); }
  }

  return <SettingsDialog title={t('Connect Agent')} onClose={onClose} returnFocus={returnFocus}>
    <div className="om-agent-connection">
      <p className="om-muted">{t('Choose your Agent, then paste the Streamable HTTP MCP connection instruction into its conversation.')}</p>
      <div className="om-label"><span>{t('Agent client')}</span><Select label={t('Agent client')} value={host} onCommit={value => setHost(integrationHost(value))} options={integrationHosts.map(value => ({ value, label: hostNames[value] }))} /></div>
      {info && (
        <div className="om-settings-row">
          <div className="om-settings-tags">
            <span className="om-badge">{t('Workspace reachable')} · v{info.version}</span>
            {isHttp && info.transport.type === 'streamable-http' && <span className="om-badge">{info.transport.url}</span>}
          </div>
          <Tooltip label={t('Refresh status')}>
            <IconButton variant="ghost" className="motion-icon-button" aria-label={t('Refresh status')} onClick={retry} icon={<RemixIcon name="refresh-line" size={16} />} />
          </Tooltip>
        </div>
      )}
      <div className="om-card om-card-stack">
        <h3 className="om-subtitle">{t(!supported ? 'HTTPS required for ChatGPT Cloud' : 'Connect from your Agent')}</h3>
        <p className="om-muted">
          {t(!supported
            ? 'ChatGPT Cloud requires a public HTTPS Streamable HTTP /mcp endpoint with OAuth 2.1 enabled. Choose another Agent above or deploy behind HTTPS.'
            : 'Send this instruction to your Agent to register the Streamable HTTP /mcp server and verify your workspace.')}
        </p>
        <pre className="om-code-block">{prompt}</pre>
        {supported && (
          <Button variant="ghost" className="om-button h-auto" data-primary onClick={() => void copy(prompt)}>
            <RemixIcon name="file-copy-line" size={15} />{t('Copy connection instruction')}
          </Button>
        )}
        <a className="om-text-link" href={setupGuideUrl(info)} target="_blank" rel="noreferrer">
          {t('Connection guide')}<RemixIcon name="external-link-line" size={14} />
        </a>
      </div>
      {supported && (
        <details key={host}>
          <summary className="om-muted">{t('Manual setup')}</summary>
          {failed ? (
            <div className="om-card om-card-stack" role="alert">
              <h3 className="om-subtitle">{t('Could not reach this workspace')}</h3>
              <p className="om-muted">{t('Check your connection and try again.')}</p>
              <Button variant="ghost" className="om-button h-auto" onClick={retry}>{t('Retry')}</Button>
            </div>
          ) : !info ? <SettingsLoading /> : (
            <>
              <pre className="om-code-block">{manual}</pre>
              <div className="om-settings-actions">
                <Button variant="ghost" className="om-button h-auto" onClick={() => void copy(manual)}>{t('Copy configuration')}</Button>
                {downloadConfig && <a className="om-button" href={downloadConfig.href} download={downloadConfig.filename ?? true}>{t('Download configuration')}</a>}
                <a className="om-text-link" href={setupGuideUrl(info)} target="_blank" rel="noreferrer">
                  {t('Connection guide')}<RemixIcon name="external-link-line" size={14} />
                </a>
              </div>
            </>
          )}
        </details>
      )}
      <p className="om-muted">{t('Workspace status confirms this app is reachable. Your Agent verifies its connection after setup.')}</p>
    </div>
    <StudioToastViewport {...toast} />
  </SettingsDialog>;
}
