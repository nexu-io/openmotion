import { Collapsible } from '@base-ui/react/collapsible';
import { Button } from 'open-design-ui/button';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { integrationConfig, isStreamableHttpTransport, manualConnection, setupGuideUrl, setupPrompt, transcriptExamplePrompt, type IntegrationInfo } from '../../../shared/integration';
import { clipMoveExample, projectEditExample } from '../../../shared/clip-move-guide';
import { projectFileExample } from '../../../shared/project-file-guide';
import { reviewCommentsPrompt } from '../../../shared/review-comments';
import { findScenario, scenarioAgentPrompt } from '../../../shared/scenarios';
import { findTechniqueStudio } from '../../../shared/studio-catalog';
import { brand, designSystemAsset } from '../../../packages/design-system/index.js';
import { Tabs, TabsIndicator, TabsList, Tab } from '../components/ui/Tabs';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useCloudFeatureEnabled } from '../utils/cloudFeatures';
import { useCommunityLink } from './CommunityLink';
import { HorizontalRail } from './HorizontalRail';
import { McpClientAvatar } from './McpClientAvatar';
import { McpDeveloperDrawer } from './McpDeveloperDrawer';
import { McpFeatureCarousels } from './McpFeatureCarousels';
import { McpHeroAmbientCanvas } from './McpHeroAmbientCanvas';
import { McpHeroShowcaseStage } from './McpHeroShowcaseStage';
import { McpManualConfiguration } from './McpManualConfiguration';
import { McpSiteFooter } from './McpSiteFooter';
import { McpTemplateShowcase } from './McpTemplateShowcase';
import { McpTiltCard } from './McpTiltCard';
import { mcpBenefits, mcpCapabilities, mcpFaq, mcpScenarios, platformExportExample, searchRecoveryExample } from './mcpCapabilities';
import { mcpClients as clients, supportsConnection, supportsLocalConnection, type McpClient } from './mcpClients';
import { readMcpGalleryPosition } from './mcpGallery';
import { mcpAdvantagePillars, mcpQuickFaq, type McpCaseTarget } from './mcpShowcaseData';
import * as tracking from './pageTracking';
import { SettingsError, SettingsLoading } from './settingsPrimitives';
import { localizedSkillPrompt, motionSkills, skillShotPrompt, studioSkillDefaults } from './skillCatalog';
import { useIntegrationInfo } from './useIntegrationInfo';
import { readWorkspacePage, type WorkspacePage } from './workspacePageRouting';
import type { WorkspaceChrome } from './WorkspaceChromeContext';
import './McpConnectionPage.css';

const cloudFaqQuestions = new Set<string>([
  'Which Agents are supported?',
  'Does connecting start generation or spend credits?',
  'Do I need an OpenMotion API key or third-party BYOK keys?',
  'Can ChatGPT Cloud connect to this workspace?',
  'How do I import my own files into a cloud project?',
  'Can I transcribe recordings and make multilingual platform videos?',
]);
const cloudQuickFaq = mcpFaq
  .filter(([question]) => cloudFaqQuestions.has(question))
  .map(([questionKey, answerKey]) => ({ id: questionKey, questionKey, answerKey }));

const DSH_PLUGIN_URL = 'https://github.com/nexu-io/openmotion/tree/main/integrations/dsh';

function buildCursorDeeplink(info: IntegrationInfo | null): string | null {
  if (!info || info.transport.type !== 'stdio' || info.deployment?.type === 'docker') return null;
  const payload = {
    command: info.transport.command,
    args: info.transport.args,
    env: info.transport.env,
  };
  try {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=openmotion&config=${encodeURIComponent(btoa(binary))}`;
  } catch {
    return null;
  }
}

export function McpConnectionPage({
  openLibrary: openLibraryRaw,
  openProviders: openProvidersRaw,
  previewsEnabled = true,
  route,
  onRouteChange,
  entry = 'direct_link',
  hasProject = false,
  projectId,
  breadcrumb,
  inSettings = false,
}: {
  openLibrary: WorkspaceChrome['openLibrary'];
  openProviders: (provider?: string) => void;
  previewsEnabled?: boolean;
  route?: WorkspacePage;
  onRouteChange?: (patch: Partial<WorkspacePage>) => void;
  entry?: tracking.McpEntry;
  hasProject?: boolean;
  projectId?: string;
  breadcrumb?: ReactNode;
  inSettings?: boolean;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const community = useCommunityLink();
  const { info, failed, retry } = useIntegrationInfo();
  const brandKitEnabled = useCloudFeatureEnabled('brandKit');
  const httpTransport = isStreamableHttpTransport(info?.transport) ? info.transport : null;
  const primaryClients = httpTransport ? clients : clients.filter(supportsLocalConnection);
  const [manualScenario, setManualScenario] = useState<{ id: string; text: string } | null>(null);
  const [localRoute, setLocalRoute] = useState(() => readWorkspacePage(location.search, location.hash, location.pathname));
  const [setupResult, setSetupResult] = useState<{
    clientId: McpClient;
    fallbackPrompt?: string;
    copied?: boolean;
  } | null>(null);

  const { client: clientId, setup: setupMode } = route ?? localRoute;
  const changeRoute = (patch: Partial<WorkspacePage>) => {
    if (onRouteChange) onRouteChange(patch);
    else setLocalRoute(previous => ({ ...previous, ...patch }));
  };
  const setClientId = (nextClient: McpClient) => changeRoute({ client: nextClient, setup: 'agent' });
  const client = clients.find(item => item.id === clientId) ?? clients[0];
  const clientKey = client.id as tracking.McpClient;
  const manualOpen = setupMode === 'manual';
  const manualPanelId = useId();
  const desktop = client.id === 'desktop';
  const agent = t(client.name);
  const feedback = setupResult?.clientId === client.id ? setupResult : null;
  const setupCopied = feedback?.copied;

  // One page view per opening, with the control that opened it and the client tab it opened on.
  useEffect(() => { tracking.reportMcpPageView(entry, clientKey, hasProject); }, []);

  useEffect(() => {
    if (!setupResult?.copied) return;
    const timer = window.setTimeout(() => {
      setSetupResult(current => current === setupResult ? { ...setupResult, copied: false } : current);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [setupResult]);

  const click = (
    area: Parameters<typeof tracking.reportMcpClick>[0],
    element: Parameters<typeof tracking.reportMcpClick>[1],
    fields: Parameters<typeof tracking.reportMcpClick>[2] = {},
  ) => tracking.reportMcpClick(area, element, { mcp_client: clientKey, ...fields });

  const openLibrary = (area: 'mcp_templates' | 'mcp_footer') => (trigger?: HTMLElement) => {
    click(area, 'open_library');
    openLibraryRaw(trigger);
  };
  const openSkill = (area: 'mcp_templates' | 'mcp_footer', skillId: string) => {
    click(area, 'open_detail', { capability: skillId });
    changeRoute({ settings: null, skills: true, skill: skillId, templates: false, template: null });
  };
  const openCaseTarget = (target: Exclude<McpCaseTarget, { kind: 'template' }>) => {
    const area = 'mcp_templates';
    if (target.kind === 'skill') {
      openSkill(area, target.skillId);
      return;
    }
    click(area, 'open_detail', { capability: target.brandKitId });
    changeRoute({ settings: 'brand-kit', brandKit: 'official', templates: false, template: null });
  };
  const openProviders = (area: 'mcp_resources' | 'mcp_footer') => () => {
    click(area, 'manage_providers');
    openProvidersRaw();
  };
  const docLink = (area: 'mcp_resources' | 'mcp_footer', doc: 'mcp_tools' | 'skills' | 'agent_adapters' | 'docs_home' | 'repository') => () =>
    click(area, 'view_documentation', { doc_id: doc });

  const page = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [galleryPosition] = useState(readMcpGalleryPosition);
  const example = (route ?? localRoute).mcpExample;

  useEffect(() => {
    if (galleryPosition) {
      const cover = page.current?.querySelector<HTMLElement>(`[data-mcp-gallery-card="${galleryPosition.cardId}"] .om-mcp-demo-cover`);
      if (cover) {
        cover.focus({ preventScroll: true });
        cover.scrollIntoView({ block: 'center' });
        return;
      }
    }
    const gallery = location.hash === '#gallery' && page.current?.querySelector<HTMLElement>('#mcp-templates');
    if (gallery) {
      gallery.scrollIntoView({ block: 'start' });
      return;
    }
    const card = example && document.getElementById('mcp-example-' + example);
    if (card && page.current?.contains(card)) {
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'center' });
    } else if (!inSettings) {
      heading.current?.focus({ preventScroll: true });
    }
  }, [example, galleryPosition, inSettings]);

  const scrollTo = (id: string) => {
    click('mcp_footer', 'scroll_to_section', { section_id: id });
    const section = page.current?.querySelector<HTMLElement>(`#${id}`);
    if (!section) return;
    const target = section.querySelector<HTMLElement>('h2, button') ?? section;
    if (target.matches('h1, h2')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start' });
  };

  const supported = supportsConnection(client, info);
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const prompt = setupPrompt(info, client.host, language, t).replace('MCP / CLI', agent);
  const examplePrompt = supported ? prompt : setupPrompt(info, 'mcp', language, t).replace('MCP / CLI', t('your Agent'));
  const manual = info ? manualConnection(info, client.host, language) : '';
  const cursorDeeplink = client.id === 'cursor' ? buildCursorDeeplink(info) : null;
  const cloudConfig = info && httpTransport && supported ? integrationConfig(info, client.host) : null;
  const downloadConfig = cloudConfig
    ? { href: `data:${cloudConfig.contentType},${encodeURIComponent(cloudConfig.text)}`, filename: cloudConfig.filename }
    : { href: `/connect/config?host=${client.host}`, filename: true as const };

  type CopyReport = {
    kind: Parameters<typeof tracking.reportMcpCopyResult>[0];
    capability?: string;
    template?: string;
    includesSetup?: boolean;
  };

  async function copy(text: string, report: CopyReport, successMessage = t('Copied to clipboard')) {
    const extra = { setup: setupMode, capability: report.capability, template: report.template, includesSetup: report.includesSetup };
    try {
      await navigator.clipboard.writeText(text);
      toast.showToast(successMessage, 'info', 'feedback');
      tracking.reportMcpCopyResult(report.kind, 'clipboard_written', clientKey, extra);
      return true;
    } catch {
      toast.showToast(t('Could not copy. Select and copy the text manually.'), 'error', 'feedback');
      tracking.reportMcpCopyResult(report.kind, 'failed', clientKey, extra);
      return false;
    }
  }

  const copyCreation = (text: string, includeSetup: boolean, kind: 'starter' | 'capability_example', capability: string) =>
    copy(includeSetup ? `${examplePrompt}\n\n${t(text)}` : t(text), { kind, capability, includesSetup: includeSetup });

  const copyCapability = async (item: (typeof mcpCapabilities)[number] | (typeof mcpScenarios)[number]) => {
    let instruction: string;
    const studio = findTechniqueStudio(item.id === 'spatial-scene' ? '3d' : item.id);
    if (studio) {
      const skill = motionSkills.find(entryItem => entryItem.id === studio.techniques[0])!;
      instruction = localizedSkillPrompt(skill, studioSkillDefaults(studio.id), locale, setupGuideUrl(info), t, Boolean(httpTransport)) + '\n\n' + t(item.prompt);
    } else if (item.id === 'studio-shot') {
      const explainer = findTechniqueStudio('explainer')!;
      const starterSkill = motionSkills.find(entryItem => entryItem.id === explainer.techniques[0])!;
      instruction = [examplePrompt, t(item.prompt), skillShotPrompt(starterSkill, studioSkillDefaults(explainer.id), t)].join('\n\n');
    } else if (item.id === 'review-comments') {
      instruction = reviewCommentsPrompt({ projectId, dataDirectory: info?.dataDirectory, previewUrl: info?.previewUrl });
    } else if (item.id === 'project-file') {
      instruction = [examplePrompt, t(item.prompt), projectFileExample(projectId)].join('\n\n');
    } else if (item.id === 'clip-move' || item.id === 'project-edit') {
      instruction = [examplePrompt, t(item.prompt), item.id === 'clip-move' ? clipMoveExample : projectEditExample].join('\n\n');
    } else if (item.id === 'transcript') {
      instruction = `${examplePrompt}\n\n${transcriptExamplePrompt(info, locale)}`;
    } else if (item.id === 'scenario-black-friday') {
      instruction = `${examplePrompt}\n\n${scenarioAgentPrompt(findScenario('black-friday')!, { locale, integration: info })}`;
    } else if (item.id === 'scenario-workflows' || item.id === 'scenario-agent-writeback') {
      instruction = `${examplePrompt}\n\n${t(item.prompt)}`;
    } else if (item.id === 'anime-opening') {
      instruction = [examplePrompt, t(item.prompt)].join('\n\n');
    } else if (item.id === 'search-recovery') {
      instruction = `${examplePrompt}\n\n${searchRecoveryExample(t)}`;
    } else if (item.id === 'platform-export') {
      instruction = platformExportExample(locale, info ?? undefined);
    } else {
      await copyCreation(item.prompt, item.id !== 'media', 'capability_example', item.id);
      return;
    }
    setManualScenario(null);
    try {
      await navigator.clipboard.writeText(instruction);
      toast.showToast(t('Copied. Paste into your Agent.'), 'info', 'feedback');
      tracking.reportMcpCopyResult('capability_example', 'clipboard_written', clientKey, {
        capability: item.id,
        includesSetup: item.id !== 'platform-export' && item.id !== 'review-comments',
      });
    } catch {
      setManualScenario({ id: item.id, text: instruction });
      toast.showToast(t('Could not copy. Select and copy the text manually.'), 'error', 'feedback');
      tracking.reportMcpCopyResult('capability_example', 'failed', clientKey, {
        capability: item.id,
        includesSetup: item.id !== 'platform-export' && item.id !== 'review-comments',
      });
    }
  };

  function handleSelectPrimaryTab(value: string) {
    const nextId = primaryClients.find(item => item.id === value)?.id;
    if (!nextId) return;
    if (client.id === nextId) return;
    setClientId(nextId);
    setSetupResult(null);
    click('mcp_client', 'client_tab', { mcp_client: nextId });
  }

  async function handlePrimarySetup() {
    if (!supported) return;
    if (desktop) {
      handleToggleManual();
      return;
    }
    if (cursorDeeplink) {
      const link = document.createElement('a');
      link.href = cursorDeeplink;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.showToast(t('Cursor install prompt triggered. If Cursor did not open, click Manual setup to copy the JSON.'), 'info', 'feedback');
      return;
    }
    const copyMessage = client.id === 'mcp'
      ? t('Copied. Paste into your Agent to finish setup.')
      : t('Copied. Paste into {agent} to finish setup.', { agent });
    const copied = await copy(prompt, { kind: 'connection_instruction' }, copyMessage);
    setSetupResult({ clientId: client.id, copied, fallbackPrompt: copied ? undefined : prompt });
  }

  function handleToggleManual() {
    const nextSetup = manualOpen ? 'agent' : 'manual';
    click('mcp_setup', 'setup_method', { setup_method: nextSetup });
    changeRoute({ setup: nextSetup });
  }

  const heroClientDisplay = client.id === 'mcp' ? t('MCP client') : agent;
  const primaryCtaLabel = desktop
    ? t('Configure {agent}', { agent })
    : cursorDeeplink
      ? t('Install OpenDesign in {agent}', { agent })
      : client.id === 'mcp'
        ? t('Copy Agent setup instruction')
        : t('Copy setup instructions for {agent}', { agent });
  const primaryCtaIcon = desktop ? 'arrow-down-s-line' : cursorDeeplink ? 'arrow-right-up-line' : 'file-copy-line';

  const [heroLine1Before, heroLine1After = ''] = t('In {agent}', { agent: '__AGENT__' }).split('__AGENT__');
  const [heroLine2Before, heroLine2After = ''] = t('Create editable videos with {brand}', { brand: '__BRAND__' }).split('__BRAND__');
  const [entitlementBefore, entitlementAfter] = t('Sign in with OpenDesign to view {details}.', { details: '__DETAILS__' }).split('__DETAILS__');
  const Container = inSettings ? 'section' : 'main';

  return (
    <Tabs
      value={client.id}
      onValueChange={handleSelectPrimaryTab}
      render={
        <Container
          ref={page}
          className="om-mcp-page"
          data-in-settings={inSettings || undefined}
          aria-labelledby="mcp-title"
          onKeyDown={event => event.stopPropagation()}
        />
      }
    >
      {breadcrumb}

      {!inSettings && (
        <div className="om-mcp-entitlement-strip">
          <span className="om-mcp-entitlement-dot" aria-hidden="true" />
          <span>{entitlementBefore}<strong>{t('available models and usage')}</strong>{entitlementAfter}</span>
          <Button variant="plain" className="om-mcp-entitlement-cta" onClick={() => {
            click('mcp_resources', 'sign_in');
            changeRoute({ settings: 'account', assets: false, skills: false, templates: false });
          }}>
            {t('Claim now')}
            <RemixIcon name="arrow-right-s-line" size={15} aria-hidden="true" />
          </Button>
        </div>
      )}

      {/* Full-bleed Hero Ambient Matrix Zone: 5-Tab Client Dock + Spacious H1 + Dual Equal-Height CTA */}
      <div className="om-mcp-ambient-wrap">
        <McpHeroAmbientCanvas clientId={clientId} />

        <div className="om-mcp-client-subbar">
          <HorizontalRail label="Agent client" viewportClassName="om-mcp-client-viewport" selection={client.id} plainArrows>
            <TabsList className="om-mcp-client-dock" aria-label={t('Agent client')}>
              {primaryClients.map(item => (
                <Tab value={item.id} key={item.id} className="om-mcp-client-tab">
                  <span className="om-mcp-client-ico"><McpClientAvatar client={item} inDock /></span>
                  <span>{t(item.name)}</span>
                </Tab>
              ))}
              <TabsIndicator className="om-mcp-tab-indicator" aria-hidden="true" />
            </TabsList>
          </HorizontalRail>
        </div>

        <div className="om-mcp-content om-mcp-hero-inner">
          <section className="om-mcp-hero-top" aria-label={t('Agent setup')}>
            <h1 id="mcp-title" ref={heading} tabIndex={-1} className="om-mcp-hero-h1">
              <span className="om-mcp-h1-line">
                {heroLine1Before.trim() ? <span>{heroLine1Before.trim()}</span> : null}
                <span className="om-mcp-h1-logo" aria-hidden="true"><McpClientAvatar client={client} /></span>
                <span className="om-mcp-h1-agent">{heroClientDisplay}</span>
                {heroLine1After.trim() ? <span>{heroLine1After.trim()}</span> : null}
              </span>
              <span className="om-mcp-h1-line">
                {heroLine2Before.trim() ? <span>{heroLine2Before.trim()}</span> : null}
                <span className="om-mcp-h1-logo om-mcp-h1-od" aria-hidden="true">
                  <img src={designSystemAsset(brand.loadingMark)} alt="" />
                </span>
                <span>OpenDesign</span>
                {heroLine2After.trim() ? <span>{heroLine2After.trim()}</span> : null}
              </span>
            </h1>

            {httpTransport && (
              <div className="om-settings-tags justify-center" data-mcp-endpoint>
                <span className="om-badge" data-active="true">Streamable HTTP · {httpTransport.url}</span>
                <span className="om-badge">
                  {httpTransport.auth.mode === 'dev'
                    ? t('Local Dev Mode')
                    : [httpTransport.auth.oauth2 && 'OAuth 2.1', httpTransport.auth.pat && 'PAT'].filter(Boolean).join(' · ')}
                </span>
              </div>
            )}

            {!supported ? (
              <div className="om-card om-mcp-unavailable om-mcp-unavailable-hero">
                <RemixIcon name="information-line" size={28} />
                <h2>{t(httpTransport ? 'HTTPS required for ChatGPT Cloud' : 'Remote connection unavailable')}</h2>
                <p>{t(httpTransport
                  ? 'ChatGPT Cloud requires a public HTTPS Streamable HTTP /mcp endpoint with OAuth 2.1 enabled. Use Codex, Claude Code, Cursor or DeepSeek Harness with this local HTTP endpoint, or deploy OpenMotion behind HTTPS.'
                  : 'ChatGPT cloud cannot connect to this local workspace. Choose a local Agent above.')}</p>
                <pre className="om-code-block">{manual}</pre>
                <Button
                  variant="ghost"
                  className="om-button h-auto"
                  onClick={() => {
                    click('mcp_setup', 'use_local_agent');
                    setClientId('codex');
                  }}
                >
                  {t(httpTransport ? 'Use Codex instead' : 'Use a local Agent')}
                </Button>
              </div>
            ) : (
              <>
                <div className="om-mcp-hero-cta-row">
                  <Button
                    variant="plain"
                    className="om-mcp-btn-primary"
                    aria-label={primaryCtaLabel}
                    aria-expanded={desktop ? manualOpen : undefined}
                    aria-controls={desktop ? manualPanelId : undefined}
                    data-copied={setupCopied || undefined}
                    onClick={() => void handlePrimarySetup()}
                  >
                    <span>{setupCopied ? t('Copied to clipboard') : primaryCtaLabel}</span>
                    {!setupCopied && <RemixIcon name={primaryCtaIcon} size={16} />}
                  </Button>
                  {!desktop && (
                    <Button
                      variant="plain"
                      className="om-mcp-btn-secondary"
                      aria-expanded={manualOpen}
                      aria-controls={manualPanelId}
                      onClick={handleToggleManual}
                    >
                      {t('Manual setup')}
                    </Button>
                  )}
                </div>

                {feedback?.fallbackPrompt && (
                  <div className="om-mcp-manual-pop">
                    <textarea
                      className="om-field w-full"
                      aria-label={t('Connection instruction')}
                      rows={5}
                      readOnly
                      value={feedback.fallbackPrompt}
                      onFocus={event => event.currentTarget.select()}
                    />
                  </div>
                )}

                <Collapsible.Root open={manualOpen}>
                  <Collapsible.Panel id={manualPanelId} className="om-mcp-manual-reveal" inert={!manualOpen}>
                    <div className="om-mcp-manual-pop">
                      {failed ? (
                        <SettingsError retry={retry} />
                      ) : !info ? (
                        <SettingsLoading />
                      ) : (
                        <McpManualConfiguration
                          key={client.id}
                          host={client.host}
                          streamableHttp={Boolean(httpTransport)}
                          value={manual}
                          onCopy={value => copy(value, { kind: 'manual_config' })}
                        >
                          <a
                            className="om-mcp-manual-link"
                            href={downloadConfig.href}
                            download={downloadConfig.filename}
                            onClick={() => click('mcp_setup', 'download_config', { setup_method: 'manual' })}
                          >
                            {t('Download configuration')}
                          </a>
                          <a
                            className="om-mcp-manual-link"
                            href={setupGuideUrl(info)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={() => click('mcp_setup', 'connection_guide', { setup_method: 'manual' })}
                          >
                            <span>{t('Connection guide')}</span>
                            <RemixIcon name="arrow-right-up-line" size={14} />
                          </a>
                          {httpTransport?.auth.pat && (
                            <Button
                              variant="plain"
                              className="om-mcp-manual-link"
                              onClick={() => changeRoute({ settings: 'account', assets: false, skills: false, templates: false })}
                            >
                              {t('Manage API tokens (PAT)')}
                            </Button>
                          )}
                        </McpManualConfiguration>
                      )}

                      {!httpTransport && client.host === 'deepseek' && (
                        <div className="om-mcp-manual-note">
                          <span>{t('Optional: embed the Studio editor right inside DeepSeek Harness with the standalone host plugin (remove the plain MCP entry above first).')}</span>
                          <a href={DSH_PLUGIN_URL} target="_blank" rel="noreferrer">
                            <span>{t('DSH workspace plugin')}</span>
                            <RemixIcon name="arrow-right-up-line" size={14} />
                          </a>
                        </div>
                      )}

                      {!httpTransport && client.id === 'desktop' && (
                        <div className="om-mcp-manual-note">
                          <span>{t('Note: Claude Desktop has no local terminal access — keep your local OpenDesign service running before merging this JSON.')}</span>
                        </div>
                      )}
                    </div>
                  </Collapsible.Panel>
                </Collapsible.Root>
              </>
            )}
          </section>
        </div>
      </div>

      {/* Main Content Container */}
      <div className="om-mcp-content">
        {/* Hero Lower: Left 4-Step Rail + Right Visual Stage + Full-Width Prompt Bar */}
        <McpHeroShowcaseStage
          enabled={previewsEnabled}
          onCopyPrompt={text => copy(text, { kind: 'starter', capability: 'hero-stage', includesSetup: false })}
        />

        {/* 3 Higgsfield-Style Centered Cinematic Feature Carousels */}
        <McpFeatureCarousels
          enabled={previewsEnabled}
          brandKitEnabled={brandKitEnabled}
          onCopy={(slideId, text) => copy(text, { kind: 'capability_example', capability: slideId, includesSetup: false })}
        />

        {/* 12-Card Scenario Template Gallery */}
        <McpTemplateShowcase
          enabled={previewsEnabled}
          brandKitEnabled={brandKitEnabled}
          initialCategory={galleryPosition?.category ?? 'all'}
          openLibrary={openLibrary('mcp_templates')}
          onOpenTarget={openCaseTarget}
          onCategory={value => click('mcp_templates', 'category_select', { option: value })}
          onPreview={id => click('mcp_templates', 'open_detail', { capability: id })}
          onCopy={(id, instruction) => copy(instruction, { kind: 'capability_example', capability: id, includesSetup: false })}
        />

        {/* 3 Advantage Pillar Cards */}
        <section className="om-mcp-section" id="why" aria-labelledby="mcp-why-heading">
          <div className="om-mcp-sec-head">
            <h2 id="mcp-why-heading">{t('Why choose OpenDesign MCP')}</h2>
          </div>
          <div className="om-mcp-pillars">
            {mcpAdvantagePillars.map(pillar => (
              <McpTiltCard key={pillar.num}>
                <article className="om-mcp-pillar">
                  <div className="om-mcp-pillar-num">{pillar.num}</div>
                  <h3>{t(httpTransport && pillar.num === '03' ? mcpBenefits[2].title : pillar.titleKey)}</h3>
                  <p>{t(httpTransport && pillar.num === '03' ? mcpBenefits[2].description : pillar.bodyKey)}</p>
                </article>
              </McpTiltCard>
            ))}
          </div>
        </section>

        {/* Standalone 6-Item High-Frequency FAQ Accordion */}
        <section className="om-mcp-section" id="mcp-faq" aria-labelledby="mcp-faq-heading">
          <div className="om-mcp-faq-layout">
            <div className="om-mcp-faq-intro">
              <h2 id="mcp-faq-heading">{t('Frequently asked questions')}</h2>
              <p>{t(httpTransport
                ? 'Connect, create, save and reuse—all in one guide.'
                : 'Quick answers on setup, billing boundaries, local privacy and editable multi-track projects.')}</p>
              <div className="om-mcp-contact">
                <a className="om-text-link" href={community.href} target="_blank" rel="noopener noreferrer" onClick={() => click('mcp_faq', 'community')}>
                  {community.label}
                  <RemixIcon name="arrow-right-up-line" size={14} />
                </a>
                <a className="om-text-link" data-quiet href={`https://github.com/nexu-io/openmotion/issues/new/choose`} target="_blank" rel="noreferrer" onClick={() => click('mcp_faq', 'report_issue')}>
                  {t('Report an issue')}
                  <RemixIcon name="arrow-right-up-line" size={14} />
                </a>
              </div>
            </div>

            <div className="om-mcp-faq-acc-list">
              {(httpTransport ? cloudQuickFaq : mcpQuickFaq).map((item, idx) => (
                <details
                  key={item.id}
                  className="om-mcp-faq-acc"
                  onToggle={event => {
                    if (event.currentTarget.open) click('mcp_faq', 'faq_open', { faq_index: idx + 1 });
                  }}
                >
                  <summary>
                    <span>{t(item.questionKey)}</span>
                    <RemixIcon name="arrow-down-s-line" size={18} />
                  </summary>
                  <p className="om-mcp-faq-ans">{t(item.answerKey)}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Collapsed Developer Technical Reference Drawer (zero info loss) */}
        <McpDeveloperDrawer
          info={info}
          failed={failed}
          retry={retry}
          supported={supported}
          deepLinkExample={example}
          manualScenario={manualScenario}
          onCopyCapability={copyCapability}
          onOpenProviders={openProviders('mcp_resources')}
          onDocLink={doc => docLink('mcp_resources', doc)()}
          onToggleTools={expanded => click('mcp_capabilities', 'tool_list_open', { expanded })}
          onFaqOpen={faqIndex => click('mcp_faq', 'faq_open', { faq_index: faqIndex })}
        />
      </div>

      {!inSettings && (
        <McpSiteFooter
          community={community}
          onScrollTo={scrollTo}
          onOpenSkill={skillId => openSkill('mcp_footer', skillId)}
          onOpenLibrary={openLibrary('mcp_footer')}
          onOpenProviders={openProviders('mcp_footer')}
          onCommunityClick={() => click('mcp_footer', 'community')}
          onDocClick={doc => docLink('mcp_footer', doc)()}
          onReportIssue={() => click('mcp_footer', 'report_issue')}
        />
      )}

      <StudioToastViewport {...toast} />
    </Tabs>
  );
}
