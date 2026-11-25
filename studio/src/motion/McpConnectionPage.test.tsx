// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import englishReadme from '../../../README.md?raw';
import chineseReadme from '../../../README.zh-CN.md?raw';
import { I18nProvider, languages, translate, type Locale } from '../i18n/I18n';
import { McpConnectionPage } from './McpConnectionPage';
import { setCachedCloudDisklessMode } from '../utils/cloudRuntime';
import { formatMcpAgentPrompt, localizedMcpExample, mcpHeroBeats, mcpShowcaseModules } from './mcpShowcaseData';
import { mcpGalleryCards } from './mcpGallery';
import { buildCloudIntegrationInfo, containerIntegration, manualConnection, setupPrompt, type IntegrationInfo } from '../../../shared/integration';

// Reporting is covered separately. Its lazy initialization/retries must not
// add transport requests to this page's discovery and read-only assertions.
vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'disabled') }));
vi.mock('./useWorkspace', () => ({ motionApi: async (path: string, options: RequestInit) => {
  const response = await fetch('/motion-api' + path, options);
  if (!response.ok) throw new Error('Unavailable');
  return response.json();
} }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const info = { name: 'OpenMotion', version: '1.2.3', previewUrl: 'http://127.0.0.1:4567', dataDirectory: '/fixture/data', templateSource: 'repository',
  transport: { type: 'stdio', command: 'node', args: ['/fixture/mcp.ts'], cwd: '/fixture', env: { MOTION_DATA_DIR: '/fixture/data' } }, tools: [{ name: 'openmotion_media_use', description: 'Media Use' }] };
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') || node.textContent?.trim()) === name)!;
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(node => node.textContent === name)!;
async function mount(locale: Locale = 'en', projectId?: string) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const openLibrary = vi.fn(), openProviders = vi.fn();
  await act(async () => root!.render(<I18nProvider initialLocale={locale}><McpConnectionPage projectId={projectId} openLibrary={openLibrary} openProviders={openProviders} /></I18nProvider>));
  return { openLibrary, openProviders };
}

it.each(languages.filter(({ locale }) => locale !== 'en'))('localizes MCP copy in $label without changing setup targets', ({ locale }) => {
  const t = (message: string) => translate(locale, message);
  expect(t('Manual setup')).not.toBe('Manual setup');
  for (const module of mcpShowcaseModules) expect(t(module.title)).not.toBe(module.title);
  for (const label of ['Juicy Splash Poster', 'Ink Ribbon', 'Faceless explainer']) expect(t(label)).not.toBe(label);
  const examples = [
    ...mcpHeroBeats,
    ...mcpShowcaseModules.flatMap(module => module.slides),
    ...mcpGalleryCards,
  ];
  for (const { content } of examples) {
    const localized = localizedMcpExample(content, t);
    expect(localized.title, content.title).not.toBe(content.title);
    expect(localized.prompt, content.title).not.toBe(content.prompt);
  }

  const copyLanguage = locale === 'zh-CN' ? 'zh-CN' : 'en';
  for (const discovery of [info, containerIntegration(info as IntegrationInfo, 'openmotion')]) {
    const prompt = setupPrompt(discovery as IntegrationInfo, 'codex', copyLanguage, (message, values) => translate(locale, message, values));
    expect(prompt).not.toBe(setupPrompt(discovery as IntegrationInfo, 'codex', 'en'));
    expect(prompt).toContain('Codex');
    expect(prompt).toContain('https://github.com/nexu-io/openmotion#quick-start');
    expect(prompt).toContain('openmotion_get_project');
  }
});

it.each(['en', 'zh-CN'] as const)('copies a workspace-bound review read plan and exposes raw-data/action guidance in %s', async locale => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount(locale, 'review-project');
  const card = document.querySelector('[data-mcp-scenario="review-comments"]')!;
  const details = card.querySelector('details')!;
  await act(async () => details.querySelector('summary')!.click());
  expect(details.open).toBe(true);
  expect(details.textContent).toContain('HTML/CSS/JS');
  expect(details.textContent).toContain(locale === 'en' ? 'not screenshots' : '不是画面截图');
  const trigger = card.querySelector('button')!;
  await act(async () => trigger.click());
  const instruction = copy.mock.calls[0][0];
  for (const value of ['Project ID: review-project', info.dataDirectory, info.previewUrl, 'file.nextOffset', 'expectedCommentRevision=latestComment.revision', 'operation="delete"']) expect(instruction).toContain(value);
  const requests = JSON.parse(instruction.split('Read requests (JSON):\n')[1].split('\n\n')[0]);
  expect(requests[2]).toEqual({ name: 'openmotion_manage_project', arguments: { action: 'comments', operation: 'list', projectId: 'review-project' } });
  expect(instruction).toContain('ask which IDs');
  copy.mockRejectedValue(new Error('Clipboard unavailable'));
  await act(async () => trigger.click());
  expect(card.querySelector('textarea')?.value).toBe(instruction);
});

it('does not copy a review handoff without workspace discovery and recovers from discovery failure', async () => {
  let failed = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('template-catalog') ? Response.json({ items: [] }) : failed ? new Response('', { status: 503 }) : Response.json(info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount();
  const card = document.querySelector('[data-mcp-scenario="review-comments"]')!;
  const trigger = card.querySelector<HTMLButtonElement>('.om-text-link')!;
  expect(trigger.disabled).toBe(true);
  expect(copy).not.toHaveBeenCalled();
  failed = false;
  await act(async () => card.querySelector<HTMLButtonElement>('button')!.click());
  expect(trigger.disabled).toBe(false);
  await act(async () => trigger.click());
  expect(copy.mock.calls[0][0]).toContain('Identify the project with me');
});

it('loads Docker discovery through the real hook and enables container setup, copying and downloads', async () => {
  const docker = containerIntegration(info as IntegrationInfo, 'openmotion');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : docker)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount();
  await act(async () => button('Copy setup instructions for Codex').click());
  expect(copy).toHaveBeenLastCalledWith(expect.stringContaining('existing OpenMotion Docker deployment'));
  expect(copy).toHaveBeenLastCalledWith(expect.stringContaining('deploy/README.md'));
  expect(copy).toHaveBeenLastCalledWith(expect.stringContaining('welcome and video cards'));
  for (const [client, host] of [['Codex', 'codex'], ['Claude Code', 'claude'], ['DeepSeek Harness', 'deepseek'], ['Other MCP clients', 'mcp']] as const) {
    await act(async () => tab(client).click());
    expect(document.body.textContent).not.toContain('Could not load settings');
    expect(button('Manual setup').getAttribute('aria-expanded')).toBe('false');
    await act(async () => button('Manual setup').click());
    expect([...document.querySelectorAll('a')].find(link => link.textContent?.trim() === 'Connection guide')?.href).toContain('deploy/README.md');
    const code = document.querySelector('.om-mcp-manual-code')!;
    expect(code.textContent).not.toContain('docker');
    const full = manualConnection(docker, host, 'en');
    expect(button('Copy configuration').disabled).toBe(false);
    await act(async () => button('Copy configuration').click());
    expect(copy).toHaveBeenLastCalledWith(full);
    expect(code.textContent).not.toBe(full);
    await act(async () => button('View full configuration').click());
    expect(code.textContent).toBe(full);
    expect(document.querySelector('a[download]')?.getAttribute('href')).toBe('/connect/config?host=' + host);
  }
});

it.each(['en', 'zh-CN'] as const)('explains optional in-client MCP Apps and Studio playback in %s', async locale => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : info)));
  await mount(locale);
  const faq = [...document.querySelectorAll<HTMLDetailsElement>('.om-mcp-faq details')]
    .find(item => item.querySelector('summary')?.textContent?.includes(locale === 'en' ? 'Can I see templates' : '看模板'))!;
  expect(faq).toBeDefined();
  await act(async () => faq.querySelector('summary')!.click());
  expect(faq.open).toBe(true);
  expect(faq.textContent).toContain('MCP Apps');
  expect(faq.textContent).toContain('Studio');
});

it.each(['zh-CN', 'en', 'ja'] as const)('links the FAQ and footer to the README community for %s', async locale => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(info)));
  await mount(locale);
  const readme = locale === 'zh-CN' ? chineseReadme : englishReadme;
  const channel = locale === 'zh-CN' ? '飞书群' : 'Discord';
  for (const selector of ['.om-mcp-contact', '.om-mcp-footer-intro']) {
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>(`${selector} a`)).find(item => item.textContent?.includes(channel));
    expect(link).toBeDefined();
    expect(readme).toContain(`[${channel}](${link!.href})`);
    expect(link!.target).toBe('_blank');
  }
});

it('switches client-specific setup, copies example prompts and performs no mutations', async () => {
  await (await import('./reporting')).loadReportingTransport();
  const fetcher = vi.fn(async () => Response.json(info));
  vi.stubGlobal('fetch', fetcher);
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const { openLibrary } = await mount();
  expect(document.querySelector('h1')?.textContent).toContain('Codex');
  expect([...document.querySelectorAll('.om-mcp-client-dock [role=tab]')].map(button => button.textContent)).toEqual([
    'Codex', 'Claude Code', 'Claude Desktop', 'Cursor', 'DeepSeek Harness', 'Other MCP clients',
  ]);
  const otherClients = tab('Other MCP clients');
  await act(async () => otherClients.click());
  const dockPlug = otherClients.querySelector('svg path');
  expect(dockPlug).not.toBeNull();
  expect(document.querySelector('#mcp-title .om-mcp-generic-icon svg path')?.getAttribute('d')).toBe(dockPlug?.getAttribute('d'));
  await act(async () => tab('Codex').click());
  await act(async () => button('Manual setup').click());
  expect(button('Manual setup').getAttribute('aria-expanded')).toBe('true');
  await act(async () => tab('Claude Code').click());
  expect(button('Manual setup').getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('h1')?.textContent).toContain('Claude');
  expect(button('Copy setup instructions for Claude Code')).toBeDefined();
  await act(async () => tab('Claude Desktop').click());
  expect(tab('Claude Desktop').getAttribute('aria-selected')).toBe('true');
  expect(tab('Claude Desktop').querySelector('img')?.getAttribute('src')).toContain('/providers/claude-color.svg');
  expect(tab('Claude Code').querySelector('img')?.getAttribute('src')).toContain('/providers/claudecode-color.svg');
  expect(document.querySelector('h1')?.textContent).toContain('Claude Desktop');
  await act(async () => tab('Claude Code').click());
  await act(async () => button('Manual setup').click());
  expect(document.querySelector('pre')?.textContent).toContain('claude mcp add');
  expect(document.querySelector('a[download]')?.getAttribute('href')).toBe('/connect/config?host=claude');
  await act(async () => tab('Claude Desktop').click());
  expect(button('Configure Claude Desktop').getAttribute('aria-expanded')).toBe('false');
  await act(async () => button('Configure Claude Desktop').click());
  expect(button('Configure Claude Desktop').getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelector('.om-mcp-manual-title')?.textContent).toBe('Merge the JSON into MCP settings, keep the other servers, then reload.');
  expect(document.querySelector('pre')?.textContent).toContain('"mcpServers"');
  expect(document.querySelector('pre')?.textContent).not.toContain('/fixture/data');
  await act(async () => tab('DeepSeek Harness').click());
  expect(document.querySelectorAll('.om-mcp-hero-cta-row > *')).toHaveLength(2);
  await act(async () => button('Manual setup').click());
  expect(document.querySelector('.om-mcp-manual-note a')?.getAttribute('href')).toContain('/integrations/dsh');
  await act(async () => tab('Claude Code').click());
  const galleryCopy = document.querySelector<HTMLButtonElement>('.om-mcp-demo-actions button')!;
  expect(galleryCopy.textContent).toBe('Copy prompt');
  await act(async () => galleryCopy.click());
  const example = copy.mock.calls[0][0];
  expect(example).toMatch(/^@OpenDesign Adapt template "Glean Agents Launch"/);
  expect(example).toContain('[OpenMotion template: motion-f6f244d1-c549-4081-8a5d-f0e1e3660044]');
  expect(example).not.toContain('openmotion#quick-start');
  for (const actions of document.querySelectorAll('.om-mcp-demo-actions')) {
    expect(actions.querySelectorAll('button')).toHaveLength(1);
  }
  await act(async () => button('Copy setup instructions for Claude Code').click());
  expect(copy.mock.calls[1][0]).toContain('Claude Code');
  expect(copy.mock.calls[1][0]).toContain('https://github.com/nexu-io/openmotion#quick-start');
  expect(copy.mock.calls[1][0]).not.toContain('127.0.0.1');
  expect(copy.mock.calls[1][0]).not.toContain(example);
  const feedback = [...document.querySelectorAll('.motion-feedback-layer [role=status]')].map(status => status.textContent);
  expect(feedback).toContain('Copied. Paste into Claude Code to finish setup.');
  expect(document.querySelector('.om-mcp-content [role=status]')).toBeNull();
  await act(async () => button('All 30+ templates').click()); expect(openLibrary).toHaveBeenCalledOnce();
  expect([...document.querySelectorAll('.om-mcp-entitlement-strip button')].map(node => node.textContent)).toEqual(['Claim now']);
  expect(tab('ChatGPT')).toBeUndefined();
  expect(document.querySelectorAll('#showcase .om-mcp-carousel-module')).toHaveLength(3);
  expect(document.querySelectorAll('#mcp-faq .om-mcp-faq-acc')).toHaveLength(6);
  expect(document.querySelector('#dev-drawer')?.getAttribute('data-open')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
  for (const [, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) expect(init?.method ?? 'GET').toBe('GET');
});

it('explains unavailable remote connections for existing ChatGPT links', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(info)));
  const previousUrl = location.href;
  history.replaceState(null, '', '?page=mcp&host=chatgpt');
  try { await mount(); } finally { history.replaceState(null, '', previousUrl); }
  expect(document.body.textContent).toContain('Remote connection unavailable');
  expect(document.querySelector<HTMLButtonElement>('.om-mcp-demo-actions button')?.disabled).toBe(false);
  expect(document.querySelector('a[download]')).toBeNull();

});

it('preserves cloud connection, manual download and project-file guidance on the redesigned page', async () => {
  const cloud = buildCloudIntegrationInfo({ publicOrigin: 'https://motion.example.com', version: '1', workspaceId: 'w', authMode: 'oidc', tools: info.tools });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(cloud)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  setCachedCloudDisklessMode(true);
  try {
    const { openProviders } = await mount('en', 'project');
    expect(document.querySelector('[data-mcp-endpoint]')?.textContent).toContain('https://motion.example.com/mcp');
    expect(document.querySelectorAll('[data-mcp-gallery-card]')).toHaveLength(10);
    expect(document.querySelector('[data-mcp-scenario="review-comments"]')).toBeNull();
    expect(document.querySelector('[data-mcp-scenario="scenario-workflows"]')).toBeNull();
    await act(async () => tab('ChatGPT').click());
    await act(async () => button('Manual setup').click());
    const download = document.querySelector<HTMLAnchorElement>('a[download="openmotion-chatgpt.json"]');
    expect(download?.getAttribute('href')).toContain('https%3A%2F%2Fmotion.example.com%2Fmcp');
    expect(button('Manage API tokens (PAT)')).toBeDefined();
    await act(async () => (document.querySelector('#dev-drawer > button') as HTMLButtonElement).click());
    const card = document.querySelector('[data-mcp-scenario="project-file"]')!;
    await act(async () => card.querySelector('button')!.click());
    expect(copy.mock.calls[0][0]).toContain('openmotion_get_project({"projectId":"project","file":{"path":"index.html","mode":"sync"');
    await act(async () => tab('Costs & local permissions').click());
    await act(async () => button('Model gateway').click());
    expect(openProviders).toHaveBeenCalledOnce();
  } finally {
    setCachedCloudDisklessMode(null);
  }
});

it('explains the HTTPS requirement on an HTTP-only ChatGPT workspace', async () => {
  const cloud = buildCloudIntegrationInfo({ publicOrigin: 'http://127.0.0.1:4173', version: '1', workspaceId: 'w', authMode: 'dev', tools: info.tools });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(cloud)));
  await mount();
  await act(async () => tab('ChatGPT').click());
  expect(document.querySelector('.om-mcp-unavailable h2')?.textContent).toBe('HTTPS required for ChatGPT Cloud');
  expect(document.querySelector('a[download]')).toBeNull();
  await act(async () => button('Use Codex instead').click());
  expect(tab('Codex').getAttribute('aria-selected')).toBe('true');
});

it('keeps example prompts available while setup discovery is unavailable and can retry', async () => {
  let broken = true;
  vi.stubGlobal('fetch', vi.fn(async () => broken ? Response.json({}, { status: 503 }) : Response.json(info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount();
  expect(button('Copy setup instructions for Codex').disabled).toBe(false);
  await act(async () => button('Copy setup instructions for Codex').click());
  expect(copy).toHaveBeenCalledWith(expect.stringContaining('https://github.com/nexu-io/openmotion#quick-start'));
  expect(copy.mock.calls[0][0]).not.toContain('127.0.0.1');
  expect(document.querySelector('.motion-feedback-layer [role=status]')?.textContent).toBe('Copied. Paste into Codex to finish setup.');
  expect(document.querySelector('.om-mcp-hero-top')?.textContent).not.toContain('Copied. Paste into Codex');
  copy.mockRejectedValueOnce(new Error('Clipboard unavailable'));
  await act(async () => button('Copy setup instructions for Codex').click());
  const instruction = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Connection instruction"]');
  expect(instruction?.readOnly).toBe(true);
  expect(instruction?.value).toBe(copy.mock.calls[1][0]);
  await act(async () => tab('Claude Code').click());
  expect(document.querySelector('textarea[aria-label="Connection instruction"]')).toBeNull();
  await act(async () => tab('Codex').click());
  await act(async () => button('Manual setup').click());
  expect(document.body.textContent).toContain('Could not load settings');
  expect(document.querySelector('a[download]')).toBeNull();
  expect(document.querySelectorAll('[data-mcp-gallery-card]')).toHaveLength(12);
  expect(document.body.textContent).toContain('Your visual MCP guide');
  broken = false;
  for (const retry of [...document.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent === 'Retry')) await act(async () => retry.click());
  expect(button('Copy setup instructions for Codex').disabled).toBe(false);
  expect(document.querySelectorAll('[data-mcp-gallery-card]')).toHaveLength(12);
});

it('aborts pending setup discovery when leaving the page', async () => {
  const reads: { path: string; signal: AbortSignal | null | undefined }[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname;
    // Tracking initialization can retry between tests; it is not owned by this page.
    if (path === '/motion-api/tracking') return Promise.resolve(Response.json({ enabled: false }));
    reads.push({ path, signal: init.signal });
    return new Promise(() => {});
  }));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount();
  expect(reads.map(read => read.path)).toEqual(['/motion-api/account/integration']);
  for (const { path, signal } of reads) expect(signal?.aborted, path).toBe(false);
  expect(button('Copy setup instructions for Codex').disabled).toBe(false);
  await act(async () => button('Copy setup instructions for Codex').click());
  expect(copy).toHaveBeenCalledWith(expect.stringContaining('https://github.com/nexu-io/openmotion#quick-start'));
  expect(document.querySelector('a[download]')).toBeNull();
  act(() => root!.unmount()); root = undefined;
  for (const { path, signal } of reads) expect(signal?.aborted, path).toBe(true);
});

it('shows all twelve curated examples, filters by section and previews video, brand showcase and prompt', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard unavailable'));
  await mount();
  const gallery = document.querySelector('#gallery')!;
  expect(gallery.querySelectorAll('[data-mcp-gallery-card]')).toHaveLength(12);
  for (const [label, count] of [
    ['Product & AI launches (4)', 4],
    ['Brand & visual motion (3)', 3],
    ['Top Skills (3)', 3],
    ['Official Brand Kits (2)', 2],
  ] as const) {
    await act(async () => tab(label).click());
    expect(gallery.querySelectorAll('[data-mcp-gallery-card]')).toHaveLength(count);
  }
  expect([...gallery.querySelectorAll('.om-mcp-demo-kind')].map(label => label.textContent)).toEqual(['Brand Kit', 'Brand Kit']);
  expect(gallery.querySelector('.om-mcp-demo-duration')).toBeNull();
  await act(async () => button('Preview Apple official Brand Kit').click());
  const brandPreview = document.querySelector('[role=dialog]')!;
  expect(brandPreview.textContent).toContain('Apple official Brand Kit');
  expect(brandPreview.querySelector('iframe')?.getAttribute('src')).toContain('/motion-api/brand-kits/catalog/apple/showcase');
  await act(async () => button('Close').click());

  await act(async () => tab('Product & AI launches (4)').click());
  const gleanCover = button('Preview Glean Agents · Enterprise workflow launch');
  expect(gleanCover.querySelector('.om-mcp-demo-duration')?.textContent).toBe('1:01');
  await act(async () => gleanCover.click());
  const preview = document.querySelector('[role=dialog]')!;
  expect(preview.textContent).toContain('Glean Agents · Enterprise workflow launch');
  expect(preview.querySelector('video')?.getAttribute('src')).toContain('https://r.open-design.ai/files/');
  await act(async () => [...preview.querySelectorAll('button')].find(node => node.textContent === 'Copy Prompt')!.click());
  expect(preview.querySelector('textarea')?.value).toBe(copy.mock.calls[0][0]);
  expect([...preview.querySelectorAll('footer button')].map(node => node.textContent)).toEqual(['Copy Prompt']);
  await act(async () => preview.querySelector<HTMLButtonElement>('.om-mcp-demo-dismiss')!.click());
  expect(document.querySelector('[role=dialog]')).toBeNull();
});

it.each(['en', 'zh-CN'] as const)('copies the complete media onboarding flow in %s', async locale => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount(locale);
  const card = [...document.querySelectorAll('article')].find(node => node.querySelector('h3')?.textContent === (locale === 'en' ? 'Generate images, video, music and voice' : '生成图片、视频、音乐与配音'))!;
  await act(async () => card.querySelector('button')!.click());
  const instruction = copy.mock.calls[0][0];
  expect(instruction).toContain('entry=agent_media_handbook');
  for (const entry of ['agent_media_upgrade_go', 'agent_media_upgrade_free', 'agent_media_signed_out']) {
    expect(instruction).toContain(entry);
  }
  expect(instruction).not.toContain('agent_media_key_rejected');
  expect(instruction).toContain('target=providers');
  expect(instruction).toContain(locale === 'en' ? 'Subscription & usage > Manage subscription for OpenDesign Plus or above' : '订阅与用量 > 管理订阅');
  expect(instruction).not.toContain('install.md');
  expect(instruction).not.toContain('quick-start');
  expect(instruction).toContain(locale === 'en' ? 'inspect again' : '重新 inspect');
  expect(instruction).toContain(locale === 'en' ? 'original request' : '恢复原始请求');
  expect(document.querySelector('.motion-feedback-layer [role=status]')?.textContent).toContain(locale === 'en' ? 'Copied to clipboard' : '已复制');
});

it.each(['en', 'zh-CN'] as const)('copies the maintained platform workflow with explicit source selection in %s', async locale => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount(locale);
  const card = [...document.querySelectorAll<HTMLElement>('.om-mcp-feature')].find(node => node.textContent?.includes(locale === 'en' ? 'Prepare a platform version' : '制作平台适配版本'))!;
  await act(async () => card.querySelector('button')!.click());
  const { platformExportExample } = await import('./mcpCapabilities');
  expect(copy.mock.calls[0][0]).toBe(platformExportExample(locale, info));
  expect(copy.mock.calls[0][0]).toContain('/fixture/data');
  expect(copy.mock.calls[0][0]).not.toContain('Project ID:');
  copy.mockRejectedValue(new Error('Denied'));
  await act(async () => card.querySelector('button')!.click());
  expect(card.querySelector('textarea')?.value).toBe(copy.mock.calls[1][0]);
  expect(document.querySelector('.motion-feedback-layer')).not.toBeNull();
});

it.each(['en', 'zh-CN', 'ja'] as const)('copies the asset naming scenario in %s with shared project safeguards', async locale => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount(locale);
  const title = { en: 'Name project assets', 'zh-CN': '整理素材名称', ja: '素材名を整理' }[locale];
  const card = [...document.querySelectorAll('article')].find(node => node.querySelector('h3')?.textContent === title)!;
  expect(card).toBeDefined();
  await act(async () => card.querySelector('button')!.click());
  expect(copy).toHaveBeenCalledOnce();
  const instruction = copy.mock.calls[0][0];
  for (const token of ['openmotion_get_project', 'namingLanguage', 'openmotion_edit_project', 'assetNames']) expect(instruction).toContain(token);
  if (locale === 'zh-CN') expect(instruction).toContain('保留已有可读名称');
});

it.each([
  ['en', 'Prefer the host’s video preview', 'never both for the same video'],
  ['zh-CN', '优先使用宿主自带的视频预览', '同一成片不同时展示两种预览'],
  ['ja', 'ホストの動画プレビューを優先', '同じ動画を両方に表示しません'],
] as const)('renders native-first final-video guidance in the real handbook component for %s', async (locale, priority, exclusive) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : info)));
  await mount(locale);
  const faq = [...document.querySelectorAll<HTMLDetailsElement>('.om-mcp-faq details')]
    .find(item => item.textContent?.includes(priority))!;
  expect(faq).toBeDefined();
  await act(async () => faq.querySelector('summary')!.click());
  expect(faq.open).toBe(true);
  expect(faq.textContent).toContain(exclusive);
  expect(faq.textContent).toContain('Codex');
  expect(faq.textContent).toContain('OpenMotion');
});

it.each(['en', 'zh-CN'] as const)('copies the Black Friday campaign workflow handoff with workspace context in %s', async locale => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount(locale);
  expect(document.querySelector('[data-mcp-scenario="scenario-workflows"]')).not.toBeNull();
  expect(document.querySelector('[data-mcp-scenario="design-embed-assets"]')).not.toBeNull();
  const card = document.querySelector('[data-mcp-scenario="scenario-black-friday"]')!;
  expect(card).not.toBeNull();
  expect(card.querySelector('h3')?.textContent).toBe(locale === 'en' ? 'Run the Black Friday campaign workflow' : '运行黑五电商活动工作流');
  await act(async () => card.querySelector('button')!.click());
  expect(copy).toHaveBeenCalledOnce();
  const instruction = copy.mock.calls[0][0];
  for (const token of ['openmotion_assets_use', 'action=scenario', 'openmotion_design_project', 'openmotion_design_edit', 'import_asset', 'openmotion_create_project', 'openmotion_open_preview', info.dataDirectory, info.previewUrl, `Reply and write visible copy in: ${locale}`]) {
    expect(instruction).toContain(token);
  }
  expect(document.querySelector('.motion-feedback-layer [role=status]')?.textContent).toContain(locale === 'en' ? 'Copied' : '已复制');
  copy.mockRejectedValue(new Error('Clipboard blocked'));
  await act(async () => card.querySelector('button')!.click());
  expect(card.querySelector('textarea')?.value).toBe(instruction);
});

it('uses a different case for every workflow step and feature slide', () => {
  const cases = [...mcpHeroBeats, ...mcpShowcaseModules.flatMap(module => module.slides)];
  const caseIds = cases.map(item => formatMcpAgentPrompt('Preview', item.target));
  const media = cases.map(item => item.video ?? item.image);
  expect(new Set(caseIds).size).toBe(cases.length);
  expect(new Set(media).size).toBe(cases.length);
});

it('plays the workflow clips through, then resumes rotation after manual selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(info)));
  vi.useFakeTimers();
  try {
    await mount();
    const steps = document.querySelectorAll<HTMLButtonElement>('.om-mcp-stage-step');
    const video = () => document.querySelector<HTMLVideoElement>('.om-mcp-stage-slide[data-active] video')!;
    await act(async () => steps[2].click());
    expect(video().getAttribute('aria-label')).toBe('BIOJUSS product showcase reel');

    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(steps[2].getAttribute('aria-pressed')).toBe('true');
    await act(async () => { video().dispatchEvent(new Event('ended')); });
    expect(steps[3].getAttribute('aria-pressed')).toBe('true');
    expect(video().loop).toBe(false);

    await act(async () => { video().dispatchEvent(new Event('ended')); });
    expect(steps[0].getAttribute('aria-pressed')).toBe('true');
    expect(video().getAttribute('aria-label')).toBe('Selecting the Figma Motion template and writing a product launch brief');
    await act(async () => { video().dispatchEvent(new Event('ended')); });
    expect(steps[1].getAttribute('aria-pressed')).toBe('true');
    await act(async () => { vi.advanceTimersByTime(5500); });
    expect(steps[2].getAttribute('aria-pressed')).toBe('true');
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ['.om-mcp-stage-col', '.om-mcp-stage-prompt-copy'],
  ['#band-ecom', '.om-mcp-carousel-primary'],
])('offers the complete failed clipboard payload below %s and clears it on retry', async (section, selector) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  copy.mockRejectedValueOnce(new Error('Clipboard unavailable'));
  await mount();
  const scope = document.querySelector(section)!;
  const trigger = scope.querySelector<HTMLButtonElement>(selector)!;
  await act(async () => trigger.click());
  const fallback = scope.querySelector('textarea');
  expect(fallback?.readOnly).toBe(true);
  expect(fallback?.value).toBe(copy.mock.calls[0][0]);
  expect(fallback?.value).toMatch(/\[OpenMotion template: motion-[\w-]+\]/);
  await act(async () => trigger.click());
  expect(copy.mock.calls[1][0]).toBe(copy.mock.calls[0][0]);
  expect(scope.querySelector('textarea')).toBeNull();
});

it('renders the 4-step hero stage, 3 feature carousels, standalone 6-item FAQ and collapsed developer drawer', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount('zh-CN');
  expect(document.querySelector('.om-mcp-demo-actions button')?.textContent).toBe('复制 Prompt');
  expect(document.querySelectorAll('.om-mcp-stage-step')).toHaveLength(4);
  const step2 = document.querySelectorAll<HTMLButtonElement>('.om-mcp-stage-step')[1];
  await act(async () => step2.click());
  expect(document.querySelector('.om-mcp-stage-prompt-text')?.textContent).toContain('Framer 3.0');
  await act(async () => button('复制 prompt').click());
  expect(copy).toHaveBeenLastCalledWith(expect.stringContaining('@OpenDesign 基于「Framer 3.0 品牌与产品发布」'));

  const modules = document.querySelectorAll('#showcase .om-mcp-carousel-module');
  expect(modules).toHaveLength(3);
  const firstMod = modules[0];
  await act(async () => firstMod.querySelectorAll<HTMLButtonElement>('.om-mcp-carousel-tab')[1].click());
  expect(firstMod.querySelector('.om-mcp-carousel-title')?.textContent).toContain('Harvey II');
  await act(async () => firstMod.querySelector<HTMLButtonElement>('.om-mcp-carousel-primary')!.click());
  expect(copy).toHaveBeenLastCalledWith(expect.stringContaining('@OpenDesign 用「Harvey II」模板'));
  expect(copy).toHaveBeenLastCalledWith(expect.stringContaining('[OpenMotion template: motion-4cab572a-4d2a-4058-8a06-84cf3fda0df0]'));
  expect(firstMod.querySelector('.om-mcp-carousel-actions')?.textContent).toBe('已复制');

  const quickFaqItems = document.querySelectorAll<HTMLDetailsElement>('#mcp-faq .om-mcp-faq-acc');
  expect(quickFaqItems).toHaveLength(6);
  expect([...quickFaqItems].every(item => !item.open)).toBe(true);
  await act(async () => quickFaqItems[0].querySelector('summary')!.click());
  expect(quickFaqItems[0].open).toBe(true);

  const drawer = document.querySelector('#dev-drawer')!;
  expect(drawer.getAttribute('data-open')).toBeNull();
  await act(async () => drawer.querySelector<HTMLButtonElement>('.om-mcp-dev-toggle')!.click());
  expect(drawer.getAttribute('data-open')).toBe('true');
});

it('wires real /motion-api/connections OAuth evidence and Check sign-in refresh to DesktopConnectPanel', async () => {
  const { buildCloudIntegrationInfo } = await import('../../../shared/integration');
  const { HOST_CAPABILITIES, hostErr, hostOk } = await import('../../../shared/desktop-contract');
  const cloud = buildCloudIntegrationInfo({
    publicOrigin: 'https://motion.open-design.ai',
    version: '1.2.3',
    workspaceId: 'ws-prod',
    authMode: 'oidc',
    oauth2Enabled: true,
    patEnabled: true,
    tools: info.tools,
  });

  let connectionsResponse: () => Response = () => new Response('', { status: 401 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('template-catalog')) return Response.json({ items: [] });
      if (url.includes('/motion-api/connections')) return connectionsResponse();
      return Response.json(cloud);
    }),
  );

  window.__OPENMOTION_HOST__ = {
    info: vi.fn(async () => ({
      hostKind: 'desktop' as const,
      shellVersion: '1.0.0',
      contractVersion: '1.0.0',
      platform: 'darwin' as const,
      arch: 'arm64',
      releaseChannel: 'stable' as const,
      isPackaged: true,
    })),
    capabilities: vi.fn(async () => [
      { name: HOST_CAPABILITIES.ATOM_DETECT, version: '1.0.0', status: 'available' as const, methods: ['run'] },
      { name: HOST_CAPABILITIES.ATOM_EXEC, version: '1.0.0', status: 'available' as const, methods: ['run'] },
    ]),
    invoke: vi.fn(async capability => {
      if (capability === HOST_CAPABILITIES.ATOM_DETECT) {
        return hostOk({
          platform: 'darwin',
          arch: 'arm64',
          agents: [
            { agentId: 'codex', installed: true, version: 'v0.30.0', mcpConfigured: true },
            { agentId: 'claude', installed: true, version: 'v1.5.0', mcpConfigured: true },
          ],
          engine: { installed: false, running: false, port: 0, providerKind: 'none' },
          detectedAt: '2026-01-01T00:00:00Z',
        });
      }
      return hostErr('UNSUPPORTED', 'Unsupported');
    }) as NonNullable<Window['__OPENMOTION_HOST__']>['invoke'],
    subscribe: () => () => {},
  };

  try {
    await mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const codexRow = document.querySelector('[data-agent-id="codex"]')!;
    const claudeRow = document.querySelector('[data-agent-id="claude"]')!;
    // Unauthenticated / 401 fails silently and never claims Authorized & ready.
    expect(codexRow.getAttribute('data-connection-state')).toBe('configured');
    expect(claudeRow.getAttribute('data-connection-state')).toBe('configured');
    expect(codexRow.textContent).toContain('Config written');
    expect(codexRow.textContent).not.toContain('Authorized & ready');

    // Return an active OAuth token WITHOUT a tool call yet for Codex: must stay configured, NOT authorized.
    connectionsResponse = () =>
      Response.json({
        connections: [
          { clientName: 'Codex CLI', workspaceId: 'ws-prod', activeTokenCount: 1, lastUsedAt: null },
          { clientName: 'Claude Code', workspaceId: 'ws-prod', activeTokenCount: 0, lastUsedAt: null },
          { clientName: 'Claude Code', workspaceId: 'ws-other', activeTokenCount: 2, lastUsedAt: '2026-01-01T00:00:00Z' },
        ],
      });

    const checkSignIn = [...codexRow.querySelectorAll<HTMLButtonElement>('button')].find(
      node => node.textContent?.trim() === 'Check sign-in',
    )!;
    expect(checkSignIn).toBeDefined();
    await act(async () => checkSignIn.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(codexRow.getAttribute('data-connection-state')).toBe('configured');
    expect(codexRow.textContent).toContain('awaiting first tool call');
    expect(codexRow.textContent).not.toContain('Authorized & ready');
    expect(claudeRow.getAttribute('data-connection-state')).toBe('configured');

    // Once Codex completes a read-only MCP tool call (`lastUsedAt` populated), it upgrades to Authorized & ready.
    connectionsResponse = () =>
      Response.json({
        connections: [
          { clientName: 'Codex CLI', workspaceId: 'ws-prod', activeTokenCount: 1, lastUsedAt: '2026-11-23T08:00:00Z' },
          { clientName: 'Claude Code', workspaceId: 'ws-prod', activeTokenCount: 0, lastUsedAt: null },
        ],
      });

    await act(async () => checkSignIn.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(codexRow.getAttribute('data-connection-state')).toBe('authorized');
    expect(codexRow.textContent).toContain('Authorized & ready');
    expect(claudeRow.getAttribute('data-connection-state')).toBe('configured');
    expect(claudeRow.textContent).not.toContain('Authorized & ready');

    // Revoked token with historical lastUsedAt OR omitted activeTokenCount MUST downgrade back to configured!
    connectionsResponse = () =>
      Response.json({
        connections: [
          { clientName: 'Codex CLI', workspaceId: 'ws-prod', activeTokenCount: 0, lastUsedAt: '2026-11-23T08:00:00Z' },
          { clientName: 'Claude Code', workspaceId: 'ws-prod', lastUsedAt: '2026-11-23T08:00:00Z' },
        ],
      });

    const claudeCheckSignIn = [...claudeRow.querySelectorAll<HTMLButtonElement>('button')].find(
      node => node.textContent?.trim() === 'Check sign-in',
    )!;
    expect(claudeCheckSignIn).toBeDefined();
    await act(async () => claudeCheckSignIn.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(codexRow.getAttribute('data-connection-state')).toBe('configured');
    expect(codexRow.textContent).not.toContain('Authorized & ready');
    expect(claudeRow.getAttribute('data-connection-state')).toBe('configured');
    expect(claudeRow.textContent).not.toContain('Authorized & ready');
  } finally {
    delete window.__OPENMOTION_HOST__;
  }
});
