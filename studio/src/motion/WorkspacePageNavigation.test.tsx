// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MotionApp } from './MotionApp';
import { I18nProvider } from '../i18n/I18n';
import { useWorkspaceChrome } from './WorkspaceFrame';
import { readWorkspacePage, settingsSections } from './workspacePageRouting';
import { workspaceHistoryIndex, writeWorkspaceHistory } from '../utils/workspaceHistory';

const editor = vi.hoisted(() => ({ mounts: 0, fail: false, wait: async () => {} }));
vi.mock('./AssetsPage', () => ({ AssetsPage: () => <input aria-label="Asset draft" defaultValue="Asset prompt" /> }));
vi.mock('./tracking', () => ({ trackMotion: vi.fn() }));
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: ({ artifact }: { artifact: { projectId: string } }) => {
  const { registerEditor } = useWorkspaceChrome();
  useEffect(() => {
    editor.mounts++;
    registerEditor({ blocked: false, saveState: '', message: '', waitForSaves: async () => {
      await editor.wait(); if (editor.fail) throw new Error('Unsaved edit');
    } });
    return () => registerEditor(null);
  }, [registerEditor]);
  return <input aria-label="Editor draft" data-project={artifact.projectId} defaultValue="Uncommitted text" />;
} }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const first = '11111111-1111-1111-1111-111111111111', second = '22222222-2222-2222-2222-222222222222';
const firstUrl = `/?session=${first}&project=${first}&embed=1#project/${first}?v=1&t=12&tab=design&rc=0`;
const artifacts = [first, second].map(projectId => ({ id: projectId, projectId, kind: 'motion-project', title: projectId === first ? 'First project' : 'Second project' }));
const catalog = { activeId: first, projects: artifacts.map(item => ({ id: item.projectId, title: item.title })), sessions: artifacts.map(item => ({ id: item.id, artifacts: [item] })) };
const provider = { id: 'account', label: 'OpenDesign', protocol: 'account', category: 'account', kinds: ['text'], configured: false, enabled: false, available: false };
const info = { name: 'OpenMotion', version: '1.2.3', previewUrl: 'http://localhost', dataDirectory: '/fixture', templateSource: 'repository', tools: [], transport: { type: 'stdio', command: 'node', args: ['/fixture/mcp.ts'], env: { MOTION_DATA_DIR: '/fixture' } } };
let root: Root, container: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
const page = () => readWorkspacePage(location.search);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)!;
const click = async (label: string) => { expect(button(label), label).toBeTruthy(); await act(async () => button(label).click()); };
const traverse = async (delta: number) => { await act(async () => { history.go(delta); await new Promise(resolve => setTimeout(resolve, 0)); }); };
const historyButton = (label: string, scope = '.om-app-header') => container.querySelector<HTMLButtonElement>(`${scope} .om-history-navigation button[aria-label="${label}"]`)!;
const clickHistory = async (label: string, scope?: string) => { await act(async () => { historyButton(label, scope).click(); await new Promise(resolve => setTimeout(resolve, 0)); }); };
async function mount(key = 0) { await act(async () => root.render(<I18nProvider initialLocale="en"><MotionApp key={key} /></I18nProvider>)); }
beforeEach(() => {
  localStorage.clear(); history.replaceState(null, '', firstUrl);
  editor.mounts = 0; editor.fail = false; editor.wait = async () => {};
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, location.origin), projectId = url.searchParams.get('projectId') ?? first;
    if (url.pathname.endsWith('/projects') && !init?.method) return Response.json(catalog);
    if (url.pathname.includes('/sessions/')) return Response.json(catalog.sessions.find(item => url.pathname.endsWith(item.id)));
    if (url.pathname.includes('/projects/') && url.pathname.endsWith('/open')) return Response.json({ projectId: url.pathname.split('/').at(-2), revision: 'r' });
    // The OpenAI preset carries media kinds, so it stays visible in the provider list.
    if (url.pathname.endsWith('/settings/providers')) return Response.json({ providers: [provider, { ...provider, id: 'openai', label: 'OpenAI', protocol: 'openai', category: 'multimodal', kinds: ['text', 'image', 'audio'] }], models: [], defaults: {} });
    if (url.pathname.endsWith('/integration')) return Response.json(info);
    if (url.pathname.endsWith('/brand-kits')) return Response.json({ kits: [] });
    if (url.pathname.endsWith('/brand-kits/catalog')) return Response.json({ schemaVersion: 1, entries: [] });
    if (url.pathname.endsWith('/template-catalog')) return Response.json({ items: [{ id: 'product-promo', title: 'Product Promo', kind: 'builtin', tags: [] }], next: null, catalogVersion: 'test' });
    return Response.json({ projectId, revision: 'r', version: '1.2.3', agents: [], defaults: {}, state: 'signed-out' });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

it.each(settingsSections)('restores a copied %s page on a fresh mount', async section => {
  const query = section === 'mcp' ? 'page=mcp&host=claude&setup=manual' : `page=settings&section=${section}`;
  history.replaceState(null, '', firstUrl.replace('#', `&${query}#`));
  for (const key of [0, 1]) {
    await mount(key);
    expect(page().settings).toBe(section);
    expect(container.querySelector<HTMLElement>('.motion-workspace-content')?.hidden).toBe(true);
    if (section === 'mcp') {
      expect(container.querySelector('#mcp-title')?.textContent).toContain('Claude Code');
      expect(container.querySelector('[role=tab][data-state=active]') || container.querySelector('a[download]')).toBeTruthy();
      expect(container.querySelector('a[download]')?.getAttribute('href')).toBe('/connect/config?host=claude');
    } else if (section === 'brand-kit') expect(document.querySelector('.om-gallery-collection-tabs [aria-current=page]')?.textContent).toContain('Official collection');
    else expect(container.querySelector('.om-settings-sections [aria-current=page]')?.textContent).toBeTruthy();
    expect(location.hash).toContain('t=12');
  }
});

it('keeps the Brand Kit collection in browser history and copied URLs', async () => {
  history.replaceState(null, '', firstUrl.replace('#', '&page=brand-kit#'));
  const activeTab = () => document.querySelector('.om-gallery-collection-tabs [aria-current=page]')?.textContent;
  await mount();
  expect(activeTab()).toBe('Official collection');
  await click('My brand kits');
  expect(page().brandKit).toBe('mine');
  expect(activeTab()).toBe('My brand kits');
  await traverse(-1);
  expect(activeTab()).toBe('Official collection');
  await traverse(1);
  expect(activeTab()).toBe('My brand kits');
  await mount(1);
  expect(activeTab()).toBe('My brand kits');
});

it('navigates settings, MCP tabs and history without remounting or flushing the editor', async () => {
  await mount(); const draft = container.querySelector<HTMLInputElement>('[aria-label="Editor draft"]')!;
  draft.value = 'Keep this edit'; const wait = vi.fn(async () => {}); editor.wait = wait;
  await click('Settings'); expect(page().settings).toBe('general');
  await click('Appearance'); expect(page().settings).toBe('appearance');
  await click('MCP · Connect Agent'); expect(page().settings).toBe('mcp');
  await click('Claude Code'); await click('Manual setup');
  expect(page()).toMatchObject({ client: 'claude', setup: 'manual' });
  await traverse(-1); expect(page().setup).toBe('agent');
  expect(container.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Claude Code');
  await traverse(-1); expect(page().client).toBe('codex');
  await traverse(-1); expect(page().settings).toBe('appearance');
  await traverse(1); expect(page().settings).toBe('mcp');
  await click('Close settings'); expect(page().settings).toBeNull();
  expect(container.querySelector('input[aria-label="Editor draft"]')).toBe(draft);
  expect(draft.value).toBe('Keep this edit'); expect(editor.mounts).toBe(1); expect(wait).not.toHaveBeenCalled();
  expect(location.search).toContain('embed=1'); expect(location.hash).toContain('t=12');
});

it('keeps one history entry per page and returns to the resolved home after a reload', async () => {
  history.replaceState(null, '', '/');
  const initialLength = history.length;
  await mount();
  const home = location.href;
  expect(new URL(home).searchParams.get('project')).toBe(first);
  expect(history.length).toBe(initialLength);

  await click('MCP · Connect Agent');
  await click('Settings');
  await click('Appearance');
  expect(history.length).toBe(initialLength + 3);
  const entry = workspaceHistoryIndex();
  await click('Appearance');
  // The editor can update its playhead while hidden. This must update only the
  // current entry, preserving the page stack and its position through a reload.
  await act(async () => writeWorkspaceHistory(`#project/${first}?v=1&t=42`, true));
  expect(history.length).toBe(initialLength + 3);
  expect(workspaceHistoryIndex()).toBe(entry);
  await mount(1);
  expect(page().settings).toBe('appearance');

  await traverse(-1); expect(page().settings).toBe('general');
  await traverse(-1); expect(page().settings).toBe('mcp');
  await traverse(-1);
  expect(location.href).toBe(home);
  expect(page().settings).toBeNull();
  expect(container.querySelector<HTMLElement>('.motion-workspace-content')?.hidden).toBe(false);
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(first);
  await traverse(1); expect(page().settings).toBe('mcp');
  await traverse(1); expect(page().settings).toBe('general');
  await traverse(1); expect(page().settings).toBe('appearance');
  expect(location.hash).toContain('t=42');
  expect(history.length).toBe(initialLength + 3);
});

it('restores provider details and returns to the providers list through history', async () => {
  await mount(); await click('Model providers');
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.om-provider-item')].find(node => node.textContent?.includes('OpenAI'))!.click());
  expect(page().provider).toBe('openai');
  await mount(1); expect(container.querySelector('.om-provider-items [aria-current=page]')?.textContent).toContain('OpenAI');
  expect(container.querySelector('.om-provider-settings')?.getAttribute('data-detail')).toBe('true');
  await traverse(-1); expect(page().provider).toBeNull();
  expect(container.querySelector('.om-provider-settings')?.getAttribute('data-detail')).toBe('false');
});

it('uses the header controls for visited pages, preserves Forward on reload and drops abandoned destinations', async () => {
  await mount();
  expect(historyButton('Back').getAttribute('aria-label')).toBe('Back');
  expect(historyButton('Back').hasAttribute('title')).toBe(false);
  expect(historyButton('Forward').getAttribute('aria-label')).toBe('Forward');
  expect(historyButton('Forward').hasAttribute('title')).toBe(false);
  expect(historyButton('Back').disabled).toBe(true);
  expect(historyButton('Forward').disabled).toBe(true);
  await click('MCP · Connect Agent'); await click('Settings');
  expect(historyButton('Back').disabled).toBe(false);
  await clickHistory('Back'); expect(page().settings).toBe('mcp');
  expect(historyButton('Forward').disabled).toBe(false);
  await mount(1);
  expect(historyButton('Forward').disabled).toBe(false);
  await clickHistory('Forward'); expect(page().settings).toBe('general');
  expect(historyButton('Forward').disabled).toBe(true);
  await clickHistory('Back'); await clickHistory('Back');
  expect(historyButton('Back').disabled).toBe(true);
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(first);
  await clickHistory('Forward'); expect(page().settings).toBe('mcp');
  await click('Help'); expect(historyButton('Forward').disabled).toBe(true);
});

it('keeps gallery history controls while headerless template previews retain browser navigation', async () => {
  const library = 'dialog[aria-label="Template library"] > div > header';
  const detail = 'dialog[aria-label="Template preview"]';
  await mount(); await click('MCP · Connect Agent'); await click('Explore templates');
  expect(historyButton('Back', library).hasAttribute('title')).toBe(false);
  await act(async () => { historyButton('Back', library).focus(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(container.querySelector('dialog[aria-label="Template library"] [role="tooltip"]')?.textContent).toBe('Back');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-template-id="product-promo"] button')!.click());
  expect(container.querySelector(`${detail} > header`)).toBeNull();
  expect(container.querySelector(`${detail} .om-history-navigation`)).toBeNull();
  expect(container.querySelector(`${detail} button[aria-label="Close template preview"]`)).not.toBeNull();
  expect(container.querySelector(`${detail} button[aria-label="Previous template"]`)).not.toBeNull();
  expect(container.querySelector(`${detail} button[aria-label="Next template"]`)).not.toBeNull();
  expect(historyButton('Back').getAttribute('aria-label')).toBe('Back');
  expect(historyButton('Back').hasAttribute('title')).toBe(false);
  await traverse(-1); expect(page().template).toBeNull();
  expect(historyButton('Forward', library).disabled).toBe(false);
  await clickHistory('Forward', library); expect(page().template).toBe('product-promo');
  await traverse(-1); await clickHistory('Back', library);
  expect(page()).toMatchObject({ settings: 'mcp', templates: false });
});

it('restores template details from a copied link and closes back to the originating MCP page', async () => {
  await mount(); await click('MCP · Connect Agent'); await click('Claude Code'); await click('Explore templates');
  expect(page()).toMatchObject({ templates: true, settings: 'mcp' });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-template-id="product-promo"] button')!.click());
  expect(page().template).toBe('product-promo');
  await mount(1);
  expect(container.querySelector('dialog[aria-label="Template preview"] h2')?.textContent).toBe('Product Promo');
  await traverse(-1); expect(page().template).toBeNull();
  expect(container.querySelector<HTMLDialogElement>('dialog[aria-label="Template preview"]')?.open).toBe(false);
  await traverse(1); expect(container.querySelector<HTMLDialogElement>('dialog[aria-label="Template preview"]')?.open).toBe(true);
  await click('Close template preview'); await click('Close template library');
  expect(page()).toMatchObject({ templates: false, template: null, settings: 'mcp', client: 'claude' });
  expect(container.querySelector('#mcp-title')?.textContent).toContain('Claude Code');
});

it('keeps an MCP showcase selection in the URL through history and reloads', async () => {
  await mount(); await click('MCP · Connect Agent'); await click('Claude Code');
  const draft = container.querySelector<HTMLInputElement>('[aria-label="Editor draft"]');
  await click('Preview template Product Promo');
  expect(page()).toMatchObject({ templates: true, template: 'product-promo', settings: 'mcp', client: 'claude' });
  expect(container.querySelector('dialog[aria-label="Template preview"] h2')?.textContent).toBe('Product Promo');
  await traverse(-1);
  expect(page()).toMatchObject({ templates: false, template: null, settings: 'mcp', client: 'claude' });
  expect(container.querySelector('dialog[aria-label="Template library"]')).toBeNull();
  expect(container.querySelector('[aria-label="Editor draft"]')).toBe(draft);
  expect(editor.mounts).toBe(1);
  await traverse(1);
  expect(container.querySelector('dialog[aria-label="Template preview"] h2')?.textContent).toBe('Product Promo');
  await mount(1);
  expect(container.querySelector('dialog[aria-label="Template preview"] h2')?.textContent).toBe('Product Promo');
  await click('Close template preview'); await click('Close template library');
  expect(page()).toMatchObject({ templates: false, template: null, settings: 'mcp', client: 'claude' });
});

it('keeps project rows in place while switching, updating selection and reloading', async () => {
  const original = fetcher.getMockImplementation()!;
  const opened: Record<string, number> = { [first]: 20, [second]: 10 };
  let activeId = first, clock = 20;
  fetcher.mockImplementation(async (input: string, init?: RequestInit) => {
    const url = new URL(input, location.origin);
    if (url.pathname.endsWith('/projects') && !init?.method) return Response.json({
      ...catalog, activeId,
      projects: catalog.projects.map(project => ({ ...project, openedAt: opened[project.id] })),
      sessions: catalog.sessions.map(session => ({ ...session, openedAt: opened[session.id] })),
    });
    if (url.pathname.includes('/projects/') && url.pathname.endsWith('/open') && init?.method === 'POST') {
      activeId = url.pathname.split('/').at(-2)!;
      opened[activeId] = ++clock;
      return Response.json({ projectId: activeId, revision: 'r' });
    }
    return original(input, init);
  });
  const rows = () => [...container.querySelectorAll('.motion-session-list button strong')].map(node => node.textContent);
  const selected = () => container.querySelector('.motion-session-list button[aria-current="page"] strong')?.textContent;
  await mount();
  const initialOrder = rows();
  expect(initialOrder).toEqual(['First project', 'Second project']);
  expect(selected()).toBe('First project');
  for (const [title, projectId] of [['Second project', second], ['First project', first]]) {
    await click(title);
    expect(rows()).toEqual(initialOrder);
    expect(selected()).toBe(title);
    expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(projectId);
  }
  const switches = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  const completedSwitches = switches().length;
  await click('First project');
  expect(switches()).toHaveLength(completedSwitches);
  expect(rows()).toEqual(initialOrder);
  await mount(1);
  expect(rows()).toEqual(initialOrder);
  expect(selected()).toBe('First project');
});

it('restores a rejected project history entry without losing the later Forward destination', async () => {
  await mount(); await click('MCP · Connect Agent'); await click('Back to home');
  await click('Second project');
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(second);
  editor.fail = true;
  await clickHistory('Back'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(new URLSearchParams(location.search).get('project')).toBe(second);
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(second);
  expect(document.querySelector('[data-feedback-layer] [role=alert]')).not.toBeNull();
  editor.fail = false;
  await traverse(-1); expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(first);
  await traverse(-1); expect(page().settings).toBe('mcp');
  await traverse(2); expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(second);
});

it('opens settings without starting the retained project and resolves it only on returning home', async () => {
  history.replaceState(null, '', firstUrl.replace('#', '&page=mcp#'));
  await mount();
  expect(container.querySelector('#mcp-title')).not.toBeNull();
  expect(container.querySelector('[data-project]')).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => url.includes('/preview/open'))).toBe(false);
  await click('Back to home');
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(first);
  expect(fetcher.mock.calls.some(([url]) => url.includes('/preview/open'))).toBe(true);
});

it('ignores an older pending history navigation after the user returns to the current project', async () => {
  await mount(); await click('Second project');
  let finish!: () => void;
  editor.wait = () => new Promise(resolve => { finish = resolve; });
  await traverse(-1);
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(second);
  await traverse(1);
  await act(async () => finish());
  expect(new URLSearchParams(location.search).get('project')).toBe(second);
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(second);
});

it('reports a missing bookmarked template and recovers without changing the retained page', async () => {
  history.replaceState(null, '', firstUrl.replace('#', '&page=mcp&templates=1&template=missing#'));
  await mount();
  expect(container.textContent).toContain('This template is no longer available.');
  await act(async () => container.querySelector<HTMLButtonElement>('dialog[aria-label="Template library"] [role=alert] button')!.click());
  expect(page()).toMatchObject({ settings: 'mcp', templates: true, template: null });
  expect(container.textContent).not.toContain('This template is no longer available.');
});


it('keeps Assets and editor drafts mounted across page history and restores the Assets deep link', async () => {
  await mount();
  const draft = container.querySelector<HTMLInputElement>('[aria-label="Editor draft"]')!;
  draft.value = 'Keep editor draft';
  await click('Workspace assets');
  expect(page().assets).toBe(true);
  const assetDraft = container.querySelector<HTMLInputElement>('[aria-label="Asset draft"]')!;
  assetDraft.value = 'Keep asset prompt';
  await click('Brand Kit');
  expect(page()).toMatchObject({ assets: false, settings: 'brand-kit' });
  expect(container.querySelector<HTMLElement>('.om-assets-host')?.hidden).toBe(true);
  await click('New Brand Kit');
  expect(page().brandKit).toBe('new');
  await click('Template library');
  await click('Close template library');
  expect(page()).toMatchObject({ settings: 'brand-kit', brandKit: 'new', templates: false });
  await click('Workspace assets');
  expect(page()).toMatchObject({ assets: true, settings: null, brandKit: null });
  expect(container.querySelector('[aria-label="Asset draft"]')).toBe(assetDraft);
  expect(assetDraft.value).toBe('Keep asset prompt');
  await click('Settings');
  expect(page().assets).toBe(false);
  expect(container.querySelector<HTMLElement>('.om-assets-host')?.hidden).toBe(true);
  await traverse(-1);
  expect(page().assets).toBe(true);
  expect(container.querySelector('[aria-label="Asset draft"]')).toBe(assetDraft);
  expect(assetDraft.value).toBe('Keep asset prompt');
  await click('Back to home');
  expect(page().assets).toBe(false);
  expect(container.querySelector('[aria-label="Editor draft"]')).toBe(draft);
  expect(draft.value).toBe('Keep editor draft');
  expect(editor.mounts).toBe(1);
  history.replaceState(null, '', firstUrl.replace('#', '&page=assets#'));
  await mount(1);
  expect(page().assets).toBe(true);
  expect(container.querySelector<HTMLElement>('.om-assets-host')?.hidden).toBe(false);
});
