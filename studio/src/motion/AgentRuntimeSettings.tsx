import { Button } from 'open-design-ui/button';
import { useState } from 'react';
import {
  AGENT_SERVICE_PROTOCOL,
  type AgentRuntimeDirectory,
  type AgentRuntimeInfo,
  type AgentServiceProbeResult,
  type BridgeSetupBundle,
  type RemoteServiceAuthType,
} from '../../../shared/agent-runtimes';
import { Select } from '../components/ui/Select';
import type { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { SettingsError, SettingsLoading } from './settingsPrimitives';
import {
  createAgentService,
  createBridgeToken,
  deleteAgentService,
  inspectBridgeAgent,
  revokeBridgeToken,
  setDefaultRuntime,
  testAgentService,
  updateAgentService,
} from './useAgentRuntimes';

type ScriptTab = 'curl' | 'node' | 'local';

export function AgentRuntimeSettings({
  directory,
  error,
  onRefresh,
  showToast,
}: {
  directory: AgentRuntimeDirectory | null;
  error?: boolean;
  onRefresh: () => void;
  showToast: ReturnType<typeof useToast>['showToast'];
}) {
  const { t } = useI18n();
  const [machineLabel, setMachineLabel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [bundle, setBundle] = useState<BridgeSetupBundle | null>(null);
  const [scriptTab, setScriptTab] = useState<ScriptTab>('curl');
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addingService, setAddingService] = useState(false);
  const [svcName, setSvcName] = useState('');
  const [svcEndpoint, setSvcEndpoint] = useState('');
  const [svcAuthType, setSvcAuthType] = useState<RemoteServiceAuthType>('bearer');
  const [svcHeaderName, setSvcHeaderName] = useState('X-API-Key');
  const [svcSecret, setSvcSecret] = useState('');
  const [testingDraft, setTestingDraft] = useState(false);
  const [savingService, setSavingService] = useState(false);
  const [probePreview, setProbePreview] = useState<AgentServiceProbeResult | null>(null);

  if (error) return <SettingsError retry={onRefresh} />;
  if (!directory) return <SettingsLoading />;

  const bridgeRuntimes = directory.runtimes.filter(item => item.kind === 'local-bridge');
  const remoteServices = directory.runtimes.filter(item => item.kind === 'remote-service');
  const onlineCount = directory.runtimes.filter(item => item.status === 'online').length;
  const unusedTokens = directory.tokens.filter(
    token => !bridgeRuntimes.some(bridge => bridge.tokenId === token.id),
  );

  const modeBadgeLabel =
    directory.deploymentMode === 'cloud'
      ? 'Cloud control plane'
      : directory.deploymentMode === 'hybrid'
        ? 'Hybrid runtime mode'
        : 'Local mode';

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('Copied to clipboard'), 'info');
    } catch {
      showToast(t('Could not copy. Select and copy the text manually.'), 'error');
    }
  }

  async function handleGenerateBundle() {
    setGenerating(true);
    try {
      const next = await createBridgeToken(machineLabel.trim() || undefined);
      setBundle(next);
      setMachineLabel('');
      showToast(t('Bridge script ready. Run the command on your computer to connect local Agents.'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not generate connect script'), 'error');
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevokeToken(tokenId: string) {
    setBusyId(tokenId);
    try {
      await revokeBridgeToken(tokenId);
      if (bundle?.tokenId === tokenId) setBundle(null);
      showToast(t('Bridge token revoked'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not revoke bridge token'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRescanBridge(runtime: AgentRuntimeInfo) {
    const targetAgent =
      runtime.agents.find(a => a.installed && (a.id === 'codex' || a.id === 'claude'))
      ?? runtime.agents.find(a => a.installed)
      ?? runtime.agents[0];
    if (!targetAgent) return;
    setBusyId(runtime.id);
    try {
      await inspectBridgeAgent(runtime.id, targetAgent.id);
      showToast(t('Refreshed local Agent status on {name}', { name: runtime.name }), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not rescan local machine'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetDefault(runtimeId: string | null) {
    setBusyId(runtimeId || 'clear-default');
    try {
      await setDefaultRuntime(runtimeId);
      showToast(t('Default runtime updated'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not update default runtime'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleTestDraft() {
    setTestingDraft(true);
    setProbePreview(null);
    try {
      const result = await testAgentService({
        endpoint: svcEndpoint,
        authType: svcAuthType,
        ...(svcAuthType === 'api-key' ? { headerName: svcHeaderName } : {}),
        ...(svcAuthType !== 'none' && svcSecret.trim() ? { apiKey: svcSecret.trim() } : {}),
      });
      setProbePreview(result);
    } catch (err) {
      setProbePreview({
        ok: false,
        agents: [],
        error: err instanceof Error ? err.message : t('Could not reach Agent service'),
      });
    } finally {
      setTestingDraft(false);
    }
  }

  async function handleSaveService() {
    setSavingService(true);
    try {
      await createAgentService({
        name: svcName.trim() || 'Custom Agent Service',
        endpoint: svcEndpoint.trim(),
        authType: svcAuthType,
        ...(svcAuthType === 'api-key' ? { headerName: svcHeaderName.trim() || 'X-API-Key' } : {}),
        ...(svcAuthType !== 'none' && svcSecret.trim() ? { apiKey: svcSecret.trim() } : {}),
      });
      setAddingService(false);
      setSvcName('');
      setSvcEndpoint('');
      setSvcSecret('');
      setProbePreview(null);
      showToast(t('Custom Agent service added'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not save Agent service'), 'error');
    } finally {
      setSavingService(false);
    }
  }

  async function handleTestSavedService(runtime: AgentRuntimeInfo) {
    setBusyId(runtime.id);
    try {
      const result = await testAgentService(runtime.id);
      if (result.ok) {
        showToast(
          t('Service online · {count} agent(s) discovered', { count: result.agents.length }),
          'info',
        );
      } else {
        showToast(result.error || t('Agent service unreachable'), 'error');
      }
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not test Agent service'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleService(runtime: AgentRuntimeInfo) {
    setBusyId(runtime.id);
    try {
      await updateAgentService(runtime.id, { enabled: runtime.enabled === false });
      showToast(
        t(runtime.enabled === false ? 'Agent service enabled' : 'Agent service disabled'),
        'info',
      );
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not update Agent service'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemoveService(runtime: AgentRuntimeInfo) {
    setBusyId(runtime.id);
    try {
      await deleteAgentService(runtime.id);
      showToast(t('Agent service removed'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not remove Agent service'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  const activeCommand = bundle
    ? scriptTab === 'curl'
      ? bundle.curlCommand
      : scriptTab === 'node'
        ? bundle.nodeCommand
        : bundle.localCommand
    : '';

  return (
    <div className="om-provider-detail-inner om-runtime-page">
      <header className="om-settings-row">
        <div className="om-provider-heading">
          <span className="om-creation-icon" data-tone="agent" aria-hidden="true">
            <RemixIcon name="link-line" size={18} />
          </span>
          <div>
            <h1 className="om-title">{t('Agent Runtimes & Cloud Bridge')}</h1>
            <p className="om-muted">
              {t('Connect local computers to cloud workspaces via outbound bridge scripts, or register self-hosted Agent services.')}
            </p>
          </div>
        </div>
        <div className="om-settings-actions">
          <span className="om-badge" data-active={onlineCount > 0}>
            {t(modeBadgeLabel)}
          </span>
          <Button variant="ghost" className="om-button h-auto" onClick={onRefresh}>
            <RemixIcon name="refresh-line" size={14} />
            {t('Refresh')}
          </Button>
        </div>
      </header>

      {/* Card 1: Connect Local Machine (Bridge Script) */}
      <section className="om-card om-card-stack">
        <div className="om-settings-row">
          <div>
            <h2 className="om-subtitle">1 · {t('Connect Local Machine (Bridge Script)')}</h2>
            <p className="om-muted">
              {t('Run a lightweight outbound bridge script on any laptop or workstation to discover local CLI Agents (Codex, Claude Code, Kimi, Cursor…) and execute cloud Super Agent tasks safely without opening inbound ports or uploading credentials.')}
            </p>
          </div>
        </div>

        <div className="om-runtime-generate-row">
          <label className="om-field om-runtime-label-input">
            <RemixIcon name="computer-line" size={15} />
            <input
              type="text"
              maxLength={80}
              value={machineLabel}
              onChange={event => setMachineLabel(event.target.value)}
              placeholder={t('Machine label (e.g. MacBook Pro · Studio)')}
              aria-label={t('Machine label')}
            />
          </label>
          <Button
            variant="ghost"
            className="om-button h-auto"
            data-primary
            disabled={generating}
            onClick={() => void handleGenerateBundle()}
          >
            <RemixIcon name="terminal-box-line" size={15} />
            {t(generating ? 'Generating…' : 'Generate connect script')}
          </Button>
        </div>

        {bundle && (
          <div className="om-runtime-bundle">
            <div className="om-settings-row">
              <div className="om-runtime-script-tabs" role="tablist" aria-label={t('Bridge launch method')}>
                {([
                  ['curl', 'One-line install'],
                  ['node', 'Node.js script'],
                  ['local', 'Local checkout'],
                ] as const).map(([id, label]) => (
                  <Button
                    key={id}
                    variant="plain"
                    type="button"
                    role="tab"
                    aria-selected={scriptTab === id}
                    className="om-nav-item om-runtime-script-tab"
                    onClick={() => setScriptTab(id)}
                  >
                    {t(label)}
                  </Button>
                ))}
              </div>
              <span className="om-badge">{bundle.serverUrl}</span>
            </div>

            <pre className="om-code-block">{activeCommand}</pre>

            <div className="om-settings-actions">
              <Button
                variant="ghost"
                className="om-button h-auto"
                data-primary
                onClick={() => void handleCopy(activeCommand)}
              >
                <RemixIcon name="copy-line" size={14} />
                {t('Copy command')}
              </Button>
              <a
                className="om-button"
                href={bundle.scriptUrl}
                download="openmotion-agent-bridge.mjs"
              >
                <RemixIcon name="external-link-line" size={14} />
                {t('Download script (.mjs)')}
              </a>
              <span className="om-muted om-runtime-token-note">
                <RemixIcon name="shield-check-line" size={14} />
                {t('Bridge token is shown once and stored as a SHA-256 hash.')}
              </span>
            </div>
          </div>
        )}

        {(bridgeRuntimes.length > 0 || unusedTokens.length > 0) && (
          <div className="om-runtime-list">
            {bridgeRuntimes.map(bridge => {
              const installedCount = bridge.agents.filter(a => a.installed).length;
              const runnableLabels = bridge.agents
                .filter(a => a.installed && a.auth !== 'signed-out')
                .slice(0, 4)
                .map(a => a.label);
              return (
                <div key={bridge.id} className="om-runtime-row">
                  <div className="om-runtime-row-main">
                    <div className="om-runtime-row-title">
                      <span
                        className="om-runtime-dot"
                        data-online={bridge.status === 'online' || undefined}
                        aria-hidden="true"
                      />
                      <strong>{bridge.name}</strong>
                      <span className="om-badge" data-active={bridge.status === 'online'}>
                        {t(bridge.status === 'online' ? 'Online' : 'Offline')}
                      </span>
                      {directory.defaultRuntimeId === bridge.id && (
                        <span className="om-badge" data-active>{t('Default')}</span>
                      )}
                    </div>
                    <small className="om-muted">
                      {[
                        bridge.platform && bridge.arch ? `${bridge.platform}/${bridge.arch}` : bridge.platform,
                        t('{count} Agents installed', { count: installedCount }),
                        runnableLabels.length ? runnableLabels.join(', ') : undefined,
                      ].filter(Boolean).join(' · ')}
                    </small>
                  </div>
                  <div className="om-settings-actions">
                    {bridge.status === 'online' && directory.defaultRuntimeId !== bridge.id && (
                      <Button
                        variant="ghost"
                        className="om-button h-auto"
                        disabled={busyId === bridge.id}
                        onClick={() => void handleSetDefault(bridge.id)}
                      >
                        {t('Set default')}
                      </Button>
                    )}
                    {bridge.status === 'online' && (
                      <Button
                        variant="ghost"
                        className="om-button h-auto"
                        disabled={busyId === bridge.id}
                        onClick={() => void handleRescanBridge(bridge)}
                      >
                        <RemixIcon name="refresh-line" size={14} />
                        {t('Rescan')}
                      </Button>
                    )}
                    {bridge.tokenId && (
                      <Button
                        variant="ghost"
                        className="om-button h-auto"
                        disabled={busyId === bridge.tokenId}
                        onClick={() => void handleRevokeToken(bridge.tokenId!)}
                      >
                        <RemixIcon name="delete-bin-line" size={14} />
                        {t('Revoke')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}

            {unusedTokens.map(token => (
              <div key={token.id} className="om-runtime-row">
                <div className="om-runtime-row-main">
                  <div className="om-runtime-row-title">
                    <span className="om-runtime-dot" aria-hidden="true" />
                    <strong>{token.label}</strong>
                    <span className="om-badge">{t('Waiting for connection')}</span>
                  </div>
                  <small className="om-muted">
                    {t('Token prefix')}: {token.prefix}…
                  </small>
                </div>
                <div className="om-settings-actions">
                  <Button
                    variant="ghost"
                    className="om-button h-auto"
                    disabled={busyId === token.id}
                    onClick={() => void handleRevokeToken(token.id)}
                  >
                    <RemixIcon name="delete-bin-line" size={14} />
                    {t('Revoke')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Card 2: Self-Hosted / Custom Agent Services */}
      <section className="om-card om-card-stack">
        <div className="om-settings-row">
          <div>
            <h2 className="om-subtitle">2 · {t('Custom & Self-Hosted Agent Services')}</h2>
            <p className="om-muted">
              {t('Register external Agent runtimes implementing the {protocol} HTTP+SSE protocol for cloud scaling or custom internal Agents.', { protocol: AGENT_SERVICE_PROTOCOL })}
            </p>
          </div>
          <Button
            variant="ghost"
            className="om-button h-auto"
            onClick={() => {
              setAddingService(value => !value);
              setProbePreview(null);
            }}
          >
            <RemixIcon name={addingService ? 'close-line' : 'add-line'} size={14} />
            {t(addingService ? 'Cancel' : 'Add Agent Service')}
          </Button>
        </div>

        {addingService && (
          <form
            className="om-runtime-service-form"
            onSubmit={event => {
              event.preventDefault();
              void handleSaveService();
            }}
          >
            <div className="om-agent-choice-fields">
              <label className="om-label">
                <span>{t('Service name')}</span>
                <span className="om-field">
                  <input
                    type="text"
                    required
                    maxLength={80}
                    value={svcName}
                    onChange={event => setSvcName(event.target.value)}
                    placeholder={t('e.g. Internal Cluster Agent')}
                    aria-label={t('Service name')}
                  />
                </span>
              </label>
              <label className="om-label">
                <span>{t('Service endpoint')}</span>
                <span className="om-field">
                  <input
                    type="url"
                    required
                    value={svcEndpoint}
                    onChange={event => setSvcEndpoint(event.target.value)}
                    placeholder="https://agent.example.com"
                    aria-label={t('Service endpoint')}
                  />
                </span>
              </label>
              <div className="om-label">
                <span>{t('Authentication')}</span>
                <Select
                  label={t('Authentication')}
                  value={svcAuthType}
                  onCommit={value => setSvcAuthType(value as RemoteServiceAuthType)}
                  options={[
                    { value: 'bearer', label: t('Bearer token') },
                    { value: 'api-key', label: t('API key header') },
                    { value: 'none', label: t('None (trusted network)') },
                  ]}
                />
              </div>
              {svcAuthType !== 'none' && (
                <label className="om-label">
                  <span>{t('Credential / API key')}</span>
                  <span className="om-field">
                    <input
                      type="password"
                      value={svcSecret}
                      onChange={event => setSvcSecret(event.target.value)}
                      placeholder={t('Stored privately on the server')}
                      aria-label={t('Credential / API key')}
                    />
                  </span>
                </label>
              )}
              {svcAuthType === 'api-key' && (
                <label className="om-label">
                  <span>{t('Header name')}</span>
                  <span className="om-field">
                    <input
                      type="text"
                      value={svcHeaderName}
                      onChange={event => setSvcHeaderName(event.target.value)}
                      placeholder="X-API-Key"
                      aria-label={t('Header name')}
                    />
                  </span>
                </label>
              )}
            </div>

            {probePreview && (
              <div className="om-runtime-probe-result" data-ok={probePreview.ok || undefined}>
                <RemixIcon name={probePreview.ok ? 'check-line' : 'close-line'} size={15} />
                <span>
                  {probePreview.ok
                    ? t('Connected ({protocol}) · {count} agent(s) discovered', {
                        protocol: probePreview.protocol || AGENT_SERVICE_PROTOCOL,
                        count: probePreview.agents.length,
                      })
                    : probePreview.error || t('Connection failed')}
                </span>
              </div>
            )}

            <div className="om-settings-actions">
              <Button
                variant="ghost"
                type="button"
                className="om-button h-auto"
                disabled={testingDraft || !svcEndpoint.trim()}
                onClick={() => void handleTestDraft()}
              >
                <RemixIcon name="refresh-line" size={14} />
                {t(testingDraft ? 'Testing…' : 'Test connection')}
              </Button>
              <Button
                variant="ghost"
                type="submit"
                className="om-button h-auto"
                data-primary
                disabled={savingService || !svcEndpoint.trim()}
              >
                <RemixIcon name="check-line" size={14} />
                {t(savingService ? 'Saving…' : 'Save service')}
              </Button>
            </div>
          </form>
        )}

        {remoteServices.length > 0 && (
          <div className="om-runtime-list">
            {remoteServices.map(service => (
              <div key={service.id} className="om-runtime-row">
                <div className="om-runtime-row-main">
                  <div className="om-runtime-row-title">
                    <span
                      className="om-runtime-dot"
                      data-online={service.status === 'online' || undefined}
                      aria-hidden="true"
                    />
                    <strong>{service.name}</strong>
                    <span className="om-badge" data-active={service.status === 'online'}>
                      {t(
                        service.status === 'online'
                          ? 'Online'
                          : service.status === 'disabled'
                            ? 'Disabled'
                            : 'Offline',
                      )}
                    </span>
                    {directory.defaultRuntimeId === service.id && (
                      <span className="om-badge" data-active>{t('Default')}</span>
                    )}
                  </div>
                  <small className="om-muted">
                    {service.endpoint} · {t('{count} Agents', { count: service.agents.length })}
                    {service.error ? ` · ${service.error}` : ''}
                  </small>
                </div>
                <div className="om-settings-actions">
                  {service.enabled !== false && directory.defaultRuntimeId !== service.id && (
                    <Button
                      variant="ghost"
                      className="om-button h-auto"
                      disabled={busyId === service.id}
                      onClick={() => void handleSetDefault(service.id)}
                    >
                      {t('Set default')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="om-button h-auto"
                    disabled={busyId === service.id}
                    onClick={() => void handleTestSavedService(service)}
                  >
                    <RemixIcon name="refresh-line" size={14} />
                    {t('Test')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="om-button h-auto"
                    disabled={busyId === service.id}
                    onClick={() => void handleToggleService(service)}
                  >
                    {t(service.enabled === false ? 'Enable' : 'Disable')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="om-button h-auto"
                    disabled={busyId === service.id}
                    onClick={() => void handleRemoveService(service)}
                  >
                    <RemixIcon name="delete-bin-line" size={14} />
                    {t('Remove')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <details className="om-runtime-protocol-doc">
          <summary className="om-muted">
            <RemixIcon name="code-s-slash-line" size={14} />{' '}
            {t('Self-hosted Agent Service Protocol ({protocol})', { protocol: AGENT_SERVICE_PROTOCOL })}
          </summary>
          <pre className="om-code-block">{`GET  /health                     -> { ok: true, protocol: "${AGENT_SERVICE_PROTOCOL}", version }
GET  /v1/agents                  -> { agents: [{ id, label, models: [{ id, label, reasoning? }] }] }
POST /v1/runs                    -> SSE stream: thread.started | message.delta | tool.call | artifact.upsert | turn.completed | turn.failed
POST /v1/runs/:runId/tool-results -> { callId, ok, contentItems, structuredContent }
POST /v1/runs/:runId/cancel      -> { ok: true }`}</pre>
        </details>
      </section>

      {/* Card 3: Active Runtimes Overview */}
      <section className="om-card om-card-stack">
        <div className="om-settings-row">
          <h2 className="om-subtitle">3 · {t('Active Execution Runtimes')}</h2>
          {directory.defaultRuntimeId && (
            <Button
              variant="ghost"
              className="om-button h-auto"
              onClick={() => void handleSetDefault(null)}
            >
              {t('Reset default')}
            </Button>
          )}
        </div>
        {!directory.localDirectAvailable && (
          <p className="om-muted">
            {t('Direct local CLI execution is disabled in Cloud control-plane mode. Super Agent executes tasks through your connected local Bridge machines or Custom Agent Services.')}
          </p>
        )}
        <div className="om-runtime-list">
          {directory.runtimes.map(runtime => (
            <div key={runtime.id} className="om-runtime-row">
              <div className="om-runtime-row-main">
                <div className="om-runtime-row-title">
                  <RemixIcon
                    name={
                      runtime.kind === 'local-bridge'
                        ? 'link-line'
                        : runtime.kind === 'remote-service'
                          ? 'plug-line'
                          : 'computer-line'
                    }
                    size={15}
                  />
                  <strong>{t(runtime.name)}</strong>
                  <span className="om-badge" data-active={runtime.status === 'online'}>
                    {t(
                      runtime.kind === 'local-direct'
                        ? 'Local direct'
                        : runtime.kind === 'local-bridge'
                          ? 'Bridge'
                          : 'Hosted service',
                    )}
                  </span>
                </div>
                <small className="om-muted">
                  {t('{ready} ready / {total} agents', {
                    ready: runtime.runnableAgentIds.length,
                    total: runtime.agents.length,
                  })}
                </small>
              </div>
              <div className="om-settings-actions">
                {directory.defaultRuntimeId === runtime.id ? (
                  <span className="om-badge" data-active>{t('Default runtime')}</span>
                ) : runtime.status === 'online' ? (
                  <Button
                    variant="ghost"
                    className="om-button h-auto"
                    onClick={() => void handleSetDefault(runtime.id)}
                  >
                    {t('Set default')}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
