import { useEffect, useRef, useState } from 'react';
import { brand, designSystemAsset } from '../../../packages/design-system/index.js';
import { BrandLogo } from '../../../packages/design-system/react/BrandLogo';
import { manualConnection, setupPrompt, setupGuideUrl, templatePrompt, type IntegrationHost } from '../../../shared/integration';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { Tabs, TabsList, Tab, TabPanel } from '../components/ui/Tabs';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { ProviderAvatar, SettingsError, SettingsLoading } from './settingsPrimitives';
import { useIntegrationInfo } from './useIntegrationInfo';
import { GITHUB_REPOSITORY } from './githubRepository';
import { McpTemplateShowcase } from './McpTemplateShowcase';
import { useCommunityLink } from './CommunityLink';
import { mcpCapabilities, mcpBenefits, mcpFaq, mcpWorkflowComparison, mcpClientComparison } from './mcpCapabilities';
import { readWorkspacePage, type WorkspacePage } from './workspacePageRouting';
import './McpConnectionPage.css';

const clients: { id: string; name: string; brand: string; host: IntegrationHost }[] = [
  { id: 'codex', name: 'Codex', brand: 'codex', host: 'codex' },
  { id: 'claude', name: 'Claude Code', brand: 'claude-code', host: 'claude' },
  { id: 'cursor', name: 'Cursor', brand: 'cursor-agent', host: 'mcp' },
  { id: 'deepseek', name: 'DeepSeek Harness', brand: 'deepseek', host: 'deepseek' },
  { id: 'desktop', name: 'Claude Desktop', brand: 'claude-code', host: 'mcp' },
  { id: 'chatgpt', name: 'ChatGPT', brand: 'openai', host: 'chatgpt' },
  { id: 'mcp', name: 'Other MCP clients', brand: 'mcp', host: 'mcp' },
];

export function McpConnectionPage({ openLibrary, openProviders, previewsEnabled = true, route, onRouteChange }: { openLibrary: (trigger?: HTMLElement, templateId?: string) => void; openProviders: () => void; previewsEnabled?: boolean; route?: WorkspacePage; onRouteChange?: (patch: Partial<WorkspacePage>) => void }) {
  const { t, locale } = useI18n(), toast = useToast();
  const community = useCommunityLink();
  const { info, failed, retry } = useIntegrationInfo();
  const [localRoute, setLocalRoute] = useState(() => readWorkspacePage(location.search));
  const { client: clientId, setup: setupMode } = route ?? localRoute;
  const changeRoute = (patch: Partial<WorkspacePage>) => {
    if (onRouteChange) onRouteChange(patch);
    else setLocalRoute(previous => ({ ...previous, ...patch }));
  };
  const setClientId = (client: string) => changeRoute({ client: clients.find(item => item.id === client)?.id as WorkspacePage['client'] ?? 'codex' });
  const client = clients.find(item => item.id === clientId) ?? clients[0];
  const page = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const scrollTo = (id: string) => page.current?.querySelector<HTMLElement>(`#${id}`)?.scrollIntoView({ block: 'start' });
  const supported = client.host !== 'chatgpt';
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const prompt = setupPrompt(info, client.host, language).replace('MCP / CLI', client.name);
  const manual = info ? manualConnection(info, client.host, language) : '';
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast.showToast(t('Copied to clipboard'), 'info', 'feedback'); }
    catch { toast.showToast(t('Could not copy. Select and copy the text manually.'), 'error', 'feedback'); }
  }
  const copyCreation = (text: string, includeSetup = true) => copy(includeSetup ? `${prompt}\n\n${t(text)}` : t(text));
  const copyButton = (text: string, label = 'Copy prompt') => <button className="om-button" disabled={!text || !supported} onClick={() => void copy(text)}><RemixIcon name="file-copy-line" size={16} />{t(label)}</button>;
  return <main ref={page} className="om-mcp-page" aria-labelledby="mcp-title" onKeyDown={event => event.stopPropagation()}>
    <div className="om-mcp-content">
      <section className="om-mcp-hero om-mcp-section">
        <div className="om-mcp-art" aria-hidden="true">
          <div className="om-mcp-art-tile om-mcp-art-left"><ProviderAvatar name="ChatGPT" provider={{ id: 'openai', custom: false }} /></div>
          <div className="om-mcp-art-tile om-mcp-art-center"><img src={designSystemAsset(brand.loadingMark)} alt="" /></div>
          <div className="om-mcp-art-tile om-mcp-art-right"><ClientAvatar client={client} /></div>
        </div>
        <p className="om-mcp-eyebrow">OPENMOTION × MCP</p>
        <h1 id="mcp-title" ref={heading} tabIndex={-1}>{t('Create in {agent}', { agent: t(client.name) })}<br /><span>{t('Make it move with OpenMotion.')}</span></h1>
        <p className="om-mcp-lead">{t('Create through MCP in your Agent. Keep projects, assets and versions in OpenMotion, ready to edit and reuse.')}</p>
        <Tabs value={client.id} onValueChange={value => setClientId(String(value))}>
          <TabsList className="om-mcp-client-tabs" aria-label={t('Agent client')}>{clients.map(item => <Tab value={item.id} key={item.id}><ClientAvatar client={item} /><span>{t(item.name)}</span></Tab>)}</TabsList>
          {clients.map(item => <TabPanel value={item.id} key={item.id}>
            <div className="om-mcp-setup-tray">
              {!supported ? <div className="om-card om-mcp-unavailable"><RemixIcon name="information-line" size={28} /><h2>{t('Remote connection unavailable')}</h2><p>{t('ChatGPT cloud cannot connect to this local workspace. Choose a local Agent above.')}</p><pre className="om-code-block">{manual}</pre><button className="om-button" onClick={() => setClientId('codex')}>{t('Use a local Agent')}</button></div> : <div className="om-mcp-setup-grid">
                <article className="om-card om-mcp-step">
                  <h2><span className="om-mcp-step-number">1</span>{t('Connect your Agent')}</h2>
                  <Tabs value={setupMode} onValueChange={value => changeRoute({ setup: value === 'manual' ? 'manual' : 'agent' })}><TabsList aria-label={t('Setup method')}><Tab value="agent">{t('Let your Agent set it up')}</Tab><Tab value="manual">{t('Manual setup')}</Tab></TabsList>
                    <TabPanel value="agent" className="om-mcp-instruction"><p className="om-muted">{t('Copy this instruction to your Agent to install and connect OpenMotion.')}</p><pre className="om-code-block">{prompt}</pre><div className="om-mcp-actions">{copyButton(prompt, 'Copy connection instruction')}<a className="om-button" href={setupGuideUrl(info)} target="_blank" rel="noreferrer">{t('Connection guide')}<RemixIcon name="external-link-line" size={14} /></a></div></TabPanel>
                    <TabPanel value="manual" className="om-mcp-instruction">{failed ? <SettingsError retry={retry} /> : !info ? <SettingsLoading /> : <><p className="om-muted">{t(client.host === 'mcp' ? 'Merge this configuration into your client’s local MCP settings. Preserve your other servers, then reload the connection.' : 'Run this command in a local terminal, then reload the Agent connection.')}</p><pre className="om-code-block">{manual}</pre><div className="om-mcp-actions">{copyButton(manual, 'Copy configuration')}<a className="om-button" href={`/connect/config?host=${client.host}`} download>{t('Download configuration')}</a></div></>}</TabPanel>
                  </Tabs>
                </article>
                <article className="om-card om-mcp-step"><h2><span className="om-mcp-step-number">2</span>{t('Start creating in {agent}', { agent: t(client.name) })}</h2><p className="om-muted">{t('Tell your Agent what you want to make. Start with an idea, your material or a template.')}</p>
                  <div className="om-mcp-starters">{mcpCapabilities.slice(0, 4).map(capability => <button className="om-nav-item" key={capability.id} onClick={() => void copyCreation(capability.prompt, capability.id !== 'media')}><RemixIcon name={capability.icon} size={18} />{t(capability.title)}</button>)}</div>
                  <button className="om-button" data-primary onClick={event => openLibrary(event.currentTarget)}><RemixIcon name="clapperboard-line" size={16} />{t('Explore templates')}<RemixIcon name="arrow-right-line" size={16} /></button>
                </article>
              </div>}
            </div>
          </TabPanel>)}
        </Tabs>
      </section>

      <McpTemplateShowcase scroller={page} enabled={previewsEnabled} canCopy={Boolean(info && supported)} openLibrary={openLibrary} onCopy={template => { if (info) void copy(`${prompt}\n\n${templatePrompt(info, client.host, template, locale)}`); }} />

      <section className="om-mcp-section"><h2>{t('Give your Agent a workspace worth keeping')}</h2><div className="om-mcp-benefit-grid">{mcpBenefits.map((item, index) => <article key={item.title} className="om-mcp-feature" data-featured={index === 0}><RemixIcon name={item.icon} size={26} /><h3>{t(item.title)}</h3><p>{t(item.description)}</p></article>)}</div></section>
      <section className="om-mcp-section" id="mcp-capabilities"><h2>{t('Your visual MCP guide')}</h2><p className="om-muted">{t('Choose a task and copy its example into your connected Agent. Projects and assets stay in your workspace; media generation uses your configured providers.')}</p><div className="om-mcp-capability-grid">{mcpCapabilities.map(item => <article className="om-mcp-feature" key={item.id}><RemixIcon name={item.icon} size={24} /><h3>{t(item.title)}</h3><p>{t(item.description)}</p><button className="om-text-link" disabled={!supported} onClick={() => void copyCreation(item.prompt, item.id !== 'media')}>{t('Copy an example')}<RemixIcon name="file-copy-line" size={14} /></button></article>)}</div>
        <details className="om-mcp-tool-details"><summary>{t('Tools exposed by this installation')}{info && ` · ${info.tools.length}`}</summary><div className="om-mcp-tool-list">{info?.tools.map(tool => <div key={tool.name}><code>{tool.name}</code><p className="om-muted">{t(tool.name === 'openmotion_assets' ? 'Compatibility name for the original nine asset actions. Use openmotion_assets_use to read media content.' : mcpCapabilities.find(item => (item.tools as readonly string[]).includes(tool.name))?.description || tool.description)}</p></div>)}</div></details>
      </section>
      <section className="om-mcp-section" id="mcp-comparison"><div className="om-mcp-section-heading"><div><p className="om-mcp-eyebrow">{t('From a conversation to a reusable project')}</p><h2>{t('Choose the workflow that fits your idea')}</h2><p className="om-muted">{t('Create through MCP, refine in Studio, and keep the project and assets for your next version.')}</p></div></div><ComparisonTable label="Workflow comparison" columns={['Capability', 'OpenMotion + Agent', 'Direct model API', 'Studio by hand']} rows={mcpWorkflowComparison} featured /></section>
      <section className="om-mcp-section" id="mcp-clients"><h2>{t('What each client can do')}</h2><p className="om-muted">{t('Local connection, generation and inline presentation are different capabilities.')}</p><ComparisonTable label="Client compatibility" columns={['Capability', 'Codex / Claude Code / Cursor / DeepSeek', 'Desktop / other MCP clients', 'ChatGPT Cloud']} rows={mcpClientComparison} /><p className="om-mcp-footnote">{t('Support here describes this local installation. Your Agent must expose the tools and resources; media generation also needs an available provider.')}</p></section>
      <section className="om-mcp-section" id="mcp-connections"><h2>{t('MCP, Skills or local API?')}</h2><div className="om-mcp-capability-grid">{[
        ['plug-line', 'MCP', 'MCP connects compatible Agents to your local workspace. Use the same tools to create and edit projects, discover templates and import assets.', 'docs/mcp-phase1-tools.md'],
        ['file-text-line', 'Production Skills', 'Give your Agent the creative workflow, reference guides and verification rules. Installed Skills and MCP resources share the maintained guidance.', 'docs/skills.md'],
        ['code-s-slash-line', 'Local API & CLI', 'For local development and automation. Use the documented application boundary and project safeguards; no hosted public API is provided here.', 'docs/agent-adapters.md'],
      ].map(([icon, title, body, doc]) => <article className="om-mcp-feature" key={title}><RemixIcon name={icon} size={24} /><h3>{t(title)}</h3><p>{t(body)}</p><a className="om-text-link" href={`${GITHUB_REPOSITORY}/blob/main/${doc}`} target="_blank" rel="noreferrer">{t('Documentation')}<RemixIcon name="external-link-line" size={14} /></a></article>)}</div></section>
      <section className="om-mcp-section om-mcp-policy-grid"><div><h2>{t('Costs & limits')}</h2><ul>{['Connecting does not run a model or start a render. Agent subscriptions and media-provider charges are separate.', 'Generation depends on provider access, model support and available quota. There is no universal free-generation allowance or fixed completion time.', 'Use the same generation or export job to check progress. Cancellation depends on the task and provider; it does not guarantee a refund.'].map(text => <li key={text}>{t(text)}</li>)}</ul><button className="om-button" onClick={openProviders}><RemixIcon name="sparkling-line" size={16} />{t('Manage providers')}</button></div><div><h2>{t('Privacy & permissions')}</h2><ul>{['The local Agent receives access to workspace tools. Keep your existing MCP servers and connect the correct installation.', 'Provider credentials are stored outside projects and injected by the local service. Never paste API keys into a conversation.', 'Cloud generation sends the required prompt and reference material to the selected provider. Projects and local exports remain in your workspace.'].map(text => <li key={text}>{t(text)}</li>)}</ul></div></section>
      <section className="om-mcp-section om-mcp-faq" id="mcp-faq"><div className="om-mcp-faq-intro"><p className="om-mcp-eyebrow">{t('A little more clarity')}</p><h2>{t('Frequently asked questions')}</h2><p className="om-muted">{t('Connect, create, save and reuse—all in one guide.')}</p><div className="om-mcp-contact"><h3>{t('Contact us')}</h3><p>{t('Need a hand or have an idea? Talk with the community or send us feedback.')}</p><a className="om-text-link" href={community.href} target="_blank" rel="noopener noreferrer">{community.label}<RemixIcon name="arrow-right-line" size={16} /></a><a className="om-text-link" href={`${GITHUB_REPOSITORY}/issues/new/choose`} target="_blank" rel="noreferrer">{t('Report an issue')}<RemixIcon name="external-link-line" size={14} /></a></div></div><div>{mcpFaq.map(([question, answer]) => <details key={question}><summary>{t(question)}<RemixIcon name="arrow-down-s-line" size={18} /></summary><p className="om-muted">{t(answer)}</p></details>)}</div></section>
      <footer className="om-mcp-footer">
        <div className="om-mcp-footer-intro"><BrandLogo /><p className="om-mcp-eyebrow">{t('The fullstack agentic video editor')}</p><h2>{t('Create in your Agent. Build on it in OpenMotion.')}</h2><p>{t('Connect with MCP. Keep editable projects, finished videos and assets together, ready for your next idea.')}</p><div className="om-mcp-actions"><button className="om-button" data-primary onClick={() => scrollTo('mcp-title')}>{t('Connect your Agent')}<RemixIcon name="arrow-right-line" size={16} /></button><a className="om-button" href={community.href} target="_blank" rel="noopener noreferrer">{community.label}</a></div></div>
        <nav className="om-mcp-footer-links" aria-label={t('MCP resources')}>
          <div><h3>{t('Create')}</h3><button onClick={event => openLibrary(event.currentTarget)}>{t('Template library')}</button><button onClick={() => scrollTo('mcp-capabilities')}>{t('Motion & animation')}</button><button onClick={openProviders}>{t('Images, video, music and voice')}</button><button onClick={() => scrollTo('mcp-comparison')}>{t('Compare workflows')}</button></div>
          <div><h3>{t('Connect')}</h3><button onClick={() => scrollTo('mcp-title')}>{t('Agent setup')}</button><button onClick={() => scrollTo('mcp-clients')}>{t('Client compatibility')}</button><a href={`${GITHUB_REPOSITORY}/blob/main/docs/skills.md`} target="_blank" rel="noreferrer">{t('Production Skills')}</a><a href={`${GITHUB_REPOSITORY}/blob/main/docs/mcp-phase1-tools.md`} target="_blank" rel="noreferrer">{t('MCP tool reference')}</a></div>
          <div><h3>{t('Resources')}</h3><a href={`${GITHUB_REPOSITORY}/tree/main/docs`} target="_blank" rel="noreferrer">{t('Documentation')}</a><a href={GITHUB_REPOSITORY} target="_blank" rel="noreferrer">GitHub</a><button onClick={() => scrollTo('mcp-faq')}>{t('Frequently asked questions')}</button><a href={`${GITHUB_REPOSITORY}/issues/new/choose`} target="_blank" rel="noreferrer">{t('Contact us')}</a></div>
        </nav>
      </footer>

    </div><StudioToastViewport {...toast} />
  </main>;
}

function ComparisonTable({ label, columns, rows, featured = false }: { label: string; columns: readonly string[]; rows: readonly (readonly string[])[]; featured?: boolean }) {
  const { t } = useI18n();
  return <div className="om-mcp-table-wrap" tabIndex={0} role="region" aria-label={t(label)}><table className="om-mcp-table" data-featured={featured}><thead><tr>{columns.map(column => <th key={column} scope="col">{t(column)}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, i) => i === 0 ? <th scope="row" key={i}>{t(cell)}</th> : <td key={i}>{featured && i === 1 && <RemixIcon name="check-line" size={16} />}{t(cell)}</td>)}</tr>)}</tbody></table></div>;
}

function ClientAvatar({ client }: { client: typeof clients[number] }) {
  return client.id === 'mcp'
    ? <span className="om-avatar" aria-hidden="true"><RemixIcon name="plug-line" size={24} /></span>
    : <ProviderAvatar name={client.name} provider={{ id: client.brand, custom: false }} />;
}
