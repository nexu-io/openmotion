import { Button } from 'open-design-ui/button';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { IntegrationHost } from '../../../shared/integration';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

const instructions = {
  codex: 'Run the command in your local terminal, then reload the Agent connection.',
  claude: 'Run the command in your local terminal, then reload the Agent connection.',
  deepseek: 'Merge the YAML into Harness, keep your other plugins, then reload the session.',
  mcp: 'Merge the JSON into MCP settings, keep the other servers, then reload.',
};

export function McpManualConfiguration({ host, value, onCopy, children, streamableHttp, desktop = false, oauth2 = false }: {
  host: IntegrationHost;
  streamableHttp: boolean;
  desktop?: boolean;
  oauth2?: boolean;
  value: string;
  onCopy: (value: string) => Promise<boolean>;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const codeId = useId();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const terminal = host === 'codex' || host === 'claude';
  const instruction = host === 'chatgpt'
    ? 'Add this Streamable HTTP URL in ChatGPT Settings -> Connectors and complete OAuth 2.1 authorization.'
    : streamableHttp && desktop
      ? 'Add this Streamable HTTP URL in Claude Desktop Settings -> Connectors -> Add custom connector and complete OAuth 2.1 authorization.'
      : streamableHttp && host === 'mcp'
        ? oauth2
          ? 'Merge this Streamable HTTP configuration into your client’s MCP settings, then sign in with OAuth 2.1 when prompted.'
          : 'Merge this Streamable HTTP configuration into your client’s MCP settings and provide your Personal Access Token as OPENMOTION_TOKEN.'
        : streamableHttp && terminal
          ? 'Run this command to register the Streamable HTTP MCP endpoint, then sign in with OAuth 2.1 or a Personal Access Token.'
          : instructions[host];
  const preview = terminal
    ? value.replace(/ +(?:--env |-- )[^\n]*/, ' …')
    : value.split('\n', streamableHttp ? 8 : 4).join('\n');

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyConfiguration() {
    const ok = await onCopy(value);
    setCopied(ok);
    if (!ok) setExpanded(true);
  }

  return (
    <>
      <div className="om-mcp-manual-head">
        <h2 className="om-mcp-manual-title">{t(instruction)}</h2>
        <Button
          type="button"
          variant="plain"
          className="om-mcp-manual-copy"
          aria-label={t('Copy configuration')}
          disabled={!value}
          onClick={() => void copyConfiguration()}
        >
          <RemixIcon name={copied ? 'check-line' : 'file-copy-line'} size={16} />
          {t(copied ? 'Copied' : 'Copy')}
        </Button>
      </div>
      <pre className="om-mcp-manual-code" id={codeId} data-preview={!expanded || undefined} tabIndex={expanded ? 0 : undefined}>
        <code>{expanded ? value : preview}</code>
      </pre>
      <div className="om-mcp-manual-footer-actions">
        <Button
          type="button"
          variant="plain"
          className="om-mcp-manual-link om-mcp-manual-expand"
          aria-expanded={expanded}
          aria-controls={codeId}
          onClick={() => setExpanded(current => !current)}
        >
          {t(expanded ? 'Hide full configuration' : 'View full configuration')}
          <RemixIcon name="arrow-down-s-line" size={16} />
        </Button>
        <div className="om-mcp-manual-resources">{children}</div>
      </div>
    </>
  );
}
