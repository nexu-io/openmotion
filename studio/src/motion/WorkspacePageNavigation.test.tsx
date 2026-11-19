// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { gemini4Videos } from './gemini4Videos';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StudioCreation } from './CreativeWorkspace';
import { MotionApp } from './MotionApp';
import { I18nProvider } from '../i18n/I18n';
import { useWorkspaceChrome } from './WorkspaceFrame';
import { readWorkspacePage, settingsSections } from './workspacePageRouting';
import { workspaceHistoryIndex, writeWorkspaceHistory } from '../utils/workspaceHistory';

const editor = vi.hoisted(() => ({ mounts: 0, fail: false, wait: async () => {} }));
vi.mock('./AssetsPage', () => ({ AssetsPage: ({ studio }: { studio?: StudioCreation }) => <input aria-label="Asset draft" defaultValue={studio?.initialDraft?.prompt ?? 'Asset prompt'} /> }));
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
async function accountAction(label: string) {
  await click('Account menu');
  const item = [...document.querySelectorAll<HTMLElement>('.om-account-menu [role="menuitem"]')].find(node => node.querySelector('.om-menu-label')?.textContent === label);
  expect(item, label).toBeTruthy();
  await act(async () => item!.click());
}
async function openMcp() {
  await click('MCP');
}
const traverse = async (delta: number) => { await act(async () => { history.go(delta); await new Promise(resolve => setTimeout(resolve, 0)); }); };
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
    if (url.pathname.endsWith('/template-catalog')) return Response.json({ items: [{ id: 'product-promo', title: 'Product Promo', description: 'A slow product reveal.', kind: 'builtin', tags: [] }], next: null, catalogVersion: 'test' });
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
  await accountAction('Settings'); expect(page().settings).toBe('general');
  await click('Appearance'); expect(page().settings).toBe('appearance');
  await openMcp(); expect(page().settings).toBe('mcp');
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

it('keeps one history entry per page and returns to the resolved editor after a reload', async () => {
  history.replaceState(null, '', '/?page=editor');
  const initialLength = history.length;
  await mount();
  const home = location.href;
  expect(new URL(home).searchParams.get('project')).toBe(first);
  expect(history.length).toBe(initialLength);

  await openMcp();
  await accountAction('Settings');
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

it('uses browser history across settings, reloads and new navigation branches', async () => {
  await mount();
  const header = container.querySelector('.om-app-header')!;
  expect(header.querySelector('button[aria-label="Back"], button[aria-label="Forward"]')).toBeNull();
  await openMcp(); await accountAction('Settings');
  await traverse(-1); expect(page().settings).toBe('mcp');
  await mount(1);
  await traverse(1); expect(page().settings).toBe('general');
  await traverse(-1); await traverse(-1);
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(first);
  await traverse(1); expect(page().settings).toBe('mcp');
  await accountAction('Help'); await traverse(1); expect(page().settings).toBe('help');
});

it('uses browser history between the template gallery, its preview and the originating page', async () => {
  const detail = 'dialog[aria-label="Template preview"]';
  await mount(); await openMcp(); await click('Explore templates');
  const header = container.querySelector('dialog[aria-label="Template library"] header')!;
  expect(header.querySelector('button[aria-label="Back"], button[aria-label="Forward"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-template-id="product-promo"] button')!.click());
  expect(container.querySelector(`${detail} > header`)).toBeNull();
  expect(container.querySelector(`${detail} button[aria-label="Close template preview"]`)).not.toBeNull();
  expect(container.querySelector(`${detail} button[aria-label="Previous template"]`)).not.toBeNull();
  expect(container.querySelector(`${detail} button[aria-label="Next template"]`)).not.toBeNull();
  await traverse(-1); expect(page().template).toBeNull();
  await traverse(1); expect(page().template).toBe('product-promo');
  await traverse(-1); await traverse(-1);
  expect(page()).toMatchObject({ settings: 'mcp', templates: false });
});

it('restores template details from a copied link and closes back to the originating MCP page', async () => {
  await mount(); await openMcp(); await click('Claude Code'); await click('Explore templates');
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
  await mount(); await openMcp(); await click('Claude Code');
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
  await mount(); await openMcp(); await click('Motion Studio'); await click('Open editor');
  await click('Second project');
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(second);
  editor.fail = true;
  await traverse(-1); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(new URLSearchParams(location.search).get('project')).toBe(second);
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(second);
  expect(document.querySelector('[data-feedback-layer] [role=alert]')).not.toBeNull();
  editor.fail = false;
  await traverse(-1); expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(first);
  await traverse(-1); expect(page().motion).toBe(true);
  await traverse(2); expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(second);
});

it('opens settings without starting the retained project and resolves it only on entering the editor', async () => {
  history.replaceState(null, '', firstUrl.replace('#', '&page=mcp#'));
  await mount();
  expect(container.querySelector('#mcp-title')).not.toBeNull();
  expect(container.querySelector('[data-project]')).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => url.includes('/preview/open'))).toBe(false);
  await click('Back to home');
  expect(page().explore).toBe(true);
  expect(container.querySelector('.om-app-rail, [data-project]')).toBeNull();
  await click('Motion Studio'); await click('Open editor');
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
  const folder = container.querySelector<HTMLButtonElement>('.om-app-header-actions [aria-label="Workspace assets"]')!;
  expect(folder).toBeTruthy();
  expect(container.querySelector('.om-app-rail :is([aria-label="Workspace assets"], [aria-label="MCP · Connect Agent"])')).toBeNull();
  await act(async () => folder.click());
  expect(folder.getAttribute('aria-current')).toBe('page');
  expect(page().assets).toBe(true);
  const assetDraft = container.querySelector<HTMLInputElement>('[aria-label="Asset draft"]')!;
  assetDraft.value = 'Keep asset prompt';
  await click('Explore'); await click('Brand Kit');
  expect(page()).toMatchObject({ assets: false, settings: 'brand-kit' });
  expect(container.querySelector<HTMLElement>('.om-assets-host')?.hidden).toBe(true);
  await click('New Brand Kit');
  expect(page().brandKit).toBe('new');
  await click('All brand kits'); await click('Close Brand Kit'); await click('Workspace assets');
  expect(page()).toMatchObject({ assets: true, settings: null, brandKit: null });
  expect(container.querySelector('[aria-label="Asset draft"]')).toBe(assetDraft);
  expect(assetDraft.value).toBe('Keep asset prompt');
  await accountAction('Settings');
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

it('switches studios and restores a scene through history while retaining the editor', async () => {
  await mount();
  const draft = container.querySelector<HTMLInputElement>('[aria-label="Editor draft"]')!;
  await click('Design Studio');
  expect(page().studio?.scene.id).toBe('text-to-image');
  await click('Image editing');
  expect(page().studio?.scene.id).toBe('image-edit');
  await click('Cinema Studio');
  expect(page().studio?.scene.id).toBe('text-to-video');
  await traverse(-1);
  expect(page().studio?.scene.id).toBe('image-edit');
  await click('Motion Studio');
  expect(page().motion).toBe(true);
  expect(container.querySelector('main[aria-label="Motion Studio"]')).toBeTruthy();
  expect(container.querySelector<HTMLElement>('.motion-workspace-content')?.hidden).toBe(true);
  await click('Open editor');
  expect(page().motion).toBe(false);
  expect(container.querySelector('[aria-label="Editor draft"]')).toBe(draft);
  expect(location.hash).toContain('t=12');
});

it('opens a model from the audio menu in the correct workspace without changing the default route', async () => {
  const speech = { id: 'voice:read/v2', provider: 'voice', modelId: 'read/v2', label: 'Narrator', modality: 'audio', mode: 'text-to-speech' };
  const fallback = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (input: string, init?: RequestInit) => {
    const path = new URL(input, location.origin).pathname;
    if (path === '/motion-api/models') return Response.json({ models: [speech], nextOffset: null });
    if (path === '/motion-api/models/capabilities') return Response.json({ providers: [{ id: 'voice', available: true }], routes: {} });
    return fallback(input, init);
  });
  await mount();
  await click('Audio scenes and models');
  const model = document.querySelector<HTMLButtonElement>('.om-creative-model-list button');
  expect(model?.textContent).toContain('Narrator');
  await act(async () => model!.click());
  expect(page().modelOverview).toBe(speech.id);
  const scene = container.querySelector<HTMLButtonElement>('.om-explore-host:not([hidden]) .om-scene-tile')!;
  await act(async () => scene.click());
  expect(page().studio).toMatchObject({ model: speech.id, scene: { id: 'speech', modality: 'audio' } });
  expect(fetcher.mock.calls.some(([path]) => String(path).includes('default-model'))).toBe(false);
  expect(document.querySelector('.om-creative-menu')).toBeNull();
});

it('opens a Cinema still from Explore and restores its studio when changing history', async () => {
  await mount();
  await click('Explore');
  expect(page().explore).toBe(true);
  await click('Next');
  await click('Shot still');
  expect(page().studio).toMatchObject({ studio: { id: 'cinema' }, scene: { id: 'shot-image', modality: 'image' } });
  expect(container.querySelector('.om-studio-bar h1')?.textContent).toBe('Cinema Studio');
  await click('Image to video');
  expect(page().studio?.scene.id).toBe('image-to-video');
  await traverse(-1);
  expect(page().studio?.scene.id).toBe('shot-image');
  await traverse(-1);
  expect(page().explore).toBe(true);
  await click('Agent client');
  const client = [...document.querySelectorAll<HTMLButtonElement>('.om-creative-client-menu button')].find(button => button.textContent === 'Claude Code')!;
  await act(async () => client.click());
  expect(page()).toMatchObject({ explore: false, settings: 'mcp', client: 'claude' });
  expect(container.querySelector('.om-creative-strip a')?.getAttribute('href')).toContain('page=api');
  await act(async () => container.querySelector<HTMLAnchorElement>('.om-creative-strip a')!.click());
  await click('openmotion_media_use');
  expect(location.search).toContain('tool=openmotion_media_use');
  expect(container.querySelector('.om-code-block')?.textContent).toContain('modality');
});

it('filters Explore by media and opens a reusable editing preset or template detail', async () => {
  await mount(); await click('Explore');
  const filter = container.querySelectorAll<HTMLButtonElement>('.om-explore-feed .om-choice-tabs button');
  await act(async () => filter[3].click());
  const scenes = container.querySelectorAll<HTMLButtonElement>('.om-feed-group [data-scene]');
  expect([...scenes].map(button => button.dataset.scene)).toEqual(['music', 'speech']);
  await act(async () => filter[0].click());
  await click('Next');
  await click('Next');
  expect(container.querySelector('.om-discovery-hero')?.getAttribute('data-scene')).toBe('hub-gemini-4');
  await click('Preview template Product Promo');
  expect(page()).toMatchObject({ explore: true, templates: true, template: 'product-promo' });
  await traverse(-1);
  const preset = [...container.querySelectorAll<HTMLButtonElement>('.om-scene-tile')].find(button => button.textContent?.includes('Scored shortlist before shorts'));
  await act(async () => preset!.click());
  expect(page()).toMatchObject({ specialty: { id: 'shorts' }, skill: 'openmotion-shortlist-shorts' });
});

it('opens the Gemini 4 hub from the third Explore slide and returns with browser Back', async () => {
  await mount();
  await click('Explore');
  await click('Next'); await click('Next');
  expect(container.querySelector('.om-feature-slide:not([inert]) h2')?.textContent).toBe('Gemini 4 Neon');
  await click('Try Gemini 4 Neon now');
  expect(page()).toMatchObject({ explore: false, modelHub: 'gemini-4' });
  expect(location.search).toContain('page=model-hub');
  expect(location.search).toContain('hub=gemini-4');
  expect(container.querySelector('.om-model-hub-hero h1')?.textContent).toBe('Gemini 4 Neon');
  const wall = () => [...container.querySelectorAll<HTMLButtonElement>('.om-hub-video .om-gallery-cover')];
  expect(wall()).toHaveLength(gemini4Videos.length);
  await act(async () => wall()[0].click());
  const detail = () => document.querySelector<HTMLDialogElement>('dialog.om-hub-video-detail')!;
  const count = () => detail().textContent?.match(/(\d+) \/ \d+/)?.[1];
  expect(count()).toBe('1');
  expect(detail().querySelector<HTMLAnchorElement>('a[aria-label="Source"]')?.href).toMatch(/^https:\/\/x\.com\//);
  const firstTitle = detail().querySelector('.om-media-detail-title')?.textContent;
  await act(async () => detail().querySelector<HTMLButtonElement>('button[aria-label="Next template"]')!.click());
  expect(count()).toBe('2');
  expect(detail().querySelector('.om-media-detail-title')?.textContent).not.toBe(firstTitle);
  expect(detail().querySelector('button[aria-label="Copy contribution brief"]')).toBeTruthy();
  await act(async () => detail().querySelector<HTMLButtonElement>('button[aria-label="Close template preview"]')!.click());
  expect(document.querySelector('dialog.om-hub-video-detail')).toBeNull();
  expect(page().modelHub).toBe('gemini-4');
  const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.om-hub-videos nav button')].find(node => node.textContent === label)!;
  expect(tab('Made in code')).toBeUndefined();
  expect(tab('Gemini 4 Neon')).toBeUndefined();
  await act(async () => tab('3D scene').click());
  expect(wall().length).toBeGreaterThan(0);
  expect(wall().length).toBeLessThan(gemini4Videos.length);
  expect(wall().every(card => card.querySelector('.om-gallery-avatar'))).toBe(true);
  await act(async () => tab('All').click());
  expect(wall()).toHaveLength(gemini4Videos.length);
  await click('Back to Explore');
  expect(page()).toMatchObject({ explore: true, modelHub: null });
  await act(async () => container.querySelector<HTMLElement>('.om-feature-slide:not([inert]) h2')!.click());
  expect(page()).toMatchObject({ explore: false, modelHub: 'gemini-4' });
  await traverse(-1);
  expect(page().explore).toBe(true);
});


it('opens Motion Studio from the Explore spotlight and resumes the timeline on request', async () => {
  await mount();
  const draft = container.querySelector('[aria-label="Editor draft"]');
  await click('Explore');
  expect(container.querySelector('.om-feature-slide:not([inert]) h2')?.textContent).toBe('Motion Studio');
  await click('Open in Motion Studio');
  expect(page()).toMatchObject({ explore: false, motion: true });
  const template = container.querySelector<HTMLButtonElement>('.om-studio-template-shelf [data-template-id="product-promo"] button')!;
  await act(async () => template.click());
  expect(page()).toMatchObject({ motion: true, templates: true, template: 'product-promo' });
  await traverse(-1);
  await click('Open editor');
  expect(container.querySelector<HTMLElement>('.motion-workspace-content')?.hidden).toBe(false);
  expect(container.querySelector('[aria-label="Editor draft"]')).toBe(draft);
  await traverse(-1);
  expect(page().motion).toBe(true);
  await traverse(-1);
  expect(page().explore).toBe(true);
});

it('shows every Studio in Discover and opens the selected example or technique', async () => {
  await mount(); await click('Explore');
  const collections = () => [...container.querySelectorAll<HTMLElement>('.om-studio-collection')].map(section => section.dataset.studio);
  expect(collections()).toEqual(['motion', 'design', 'cinema', 'sound', 'shorts', 'marketing', 'explainer', '3d']);
  const select = async (selector: string) => {
    const item = container.querySelector<HTMLButtonElement>(selector);
    expect(item, selector).toBeTruthy();
    await act(async () => item!.click());
  };
  await select('.om-studio-collection [data-playback-id="motion/openmotion-liquid-glass-logo"]');
  expect(page()).toMatchObject({ skills: true, skill: 'openmotion-liquid-glass-logo' });
  await traverse(-1);
  await select('.om-studio-collection[data-studio="design"] [data-scene="image-edit"]');
  expect(page().studio).toMatchObject({ studio: { id: 'design' }, scene: { id: 'image-edit' } });
  expect(container.querySelector<HTMLInputElement>('[aria-label="Asset draft"]')?.value).toContain('Keep the product and its lettering');
  await traverse(-1);
  await select('.om-studio-collection[data-studio="marketing"] .om-scene-tile');
  expect(page()).toMatchObject({ specialty: { id: 'marketing' }, skill: 'openmotion-flat-lay-product' });
  await traverse(-1);
  await select('.om-explore-feed .om-choice-tabs button:last-child');
  expect(collections()).toEqual(['sound']);
  await select('.om-studio-collection[data-studio="sound"] [data-scene="speech"]');
  expect(page().studio).toMatchObject({ studio: { id: 'sound' }, scene: { id: 'speech' } });
  await traverse(-1);
  expect(collections()).toEqual(['sound']);
});

it('rotates the visible Explore spotlight and plays visible Skill previews without hovering', async () => {
  const observed = new Map<Element, (visible: boolean) => void>();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
    observe(target: Element) {
      observed.set(target, visible => this.callback([{ target, isIntersecting: visible, intersectionRatio: Number(visible) }]));
    }
    disconnect() {}
  });
  await mount(); await click('Explore');
  const hero = container.querySelector<HTMLElement>('.om-feature-carousel')!;
  const cards = ['.om-feed-group', '.om-studio-collection-cards'].map(section =>
    container.querySelector<HTMLElement>(section + ' [data-playback-id]')!);
  vi.useFakeTimers();
  try {
    await act(async () => { observed.get(hero)!(true); cards.forEach(card => observed.get(card)!(true)); });
    expect(hero.dataset.scene).toBe('motion');
    expect(hero.querySelector('video[src]')?.getAttribute('src')).toMatch(/^blob:/);
    for (const card of cards) expect(card.querySelector('video[src]')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(hero.dataset.scene).toBe('black-friday');
    expect(hero.querySelectorAll('.om-feature-slide:not([inert])')).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(2500); });
    await click('Pause');
    act(() => { vi.advanceTimersByTime(6000); });
    expect(hero.dataset.scene).toBe('black-friday');
    await click('Play');
    act(() => { vi.advanceTimersByTime(3500); });
    expect(hero.dataset.scene).toBe('hub-gemini-4');
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(hero.dataset.scene).toBe('text-to-video');
    expect(hero.querySelector('video[src]')?.getAttribute('src')).toMatch(/^blob:/);
    act(() => { observed.get(hero)!(false); cards.forEach(card => observed.get(card)!(false)); });
    expect(hero.querySelector('video[src]')).toBeNull();
    for (const card of cards) expect(card.querySelector('video[src]')).toBeNull();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(hero.dataset.scene).toBe('text-to-video');
    await act(async () => hero.querySelector<HTMLButtonElement>('.om-media-segments [aria-label="Featured · Product portrait"]')!.click());
    expect(hero.dataset.scene).toBe('text-to-image');
  } finally { vi.useRealTimers(); }
});

it('opens Black Friday from the second Explore slide and reuses the native Skill detail in the collection', async () => {
  await mount();
  await click('Explore');
  const hero = container.querySelector<HTMLElement>('.om-feature-carousel')!;
  const segments = hero.querySelectorAll<HTMLButtonElement>('.om-media-segments button');
  expect(segments[1].getAttribute('aria-label')).toBe('Featured · Black Friday collection');
  await act(async () => segments[1].click());
  await click('View collection');
  expect(page()).toMatchObject({ explore: true, templates: true, blackFriday: true });
  expect(container.querySelector('[aria-label="Video purpose"]')).toBeNull();
  const skill = container.querySelector<HTMLButtonElement>('[data-black-friday] .om-skill-gallery-card')!;
  await act(async () => skill.click());
  expect(page().skill).toBe('openmotion-sale-countdown');
  expect(container.querySelector('.om-collection-skill aside .om-skill-form')).toBeTruthy();
  expect(container.querySelector('.om-collection-skill aside .om-skill-prompt')).toBeTruthy();
  const close = button('Close skill');
  expect(document.activeElement).toBe(close);
  await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(page()).toMatchObject({ explore: true, templates: true, blackFriday: true, skill: null });
  expect(document.activeElement).toBe(skill);
  expect(container.querySelector('[data-black-friday] .om-skill-gallery-card')).toBe(skill);
  await click('Back to Explore');
  expect(page()).toMatchObject({ explore: true, templates: false, blackFriday: false });
  expect(hero.dataset.scene).toBe('black-friday');
  await click('Template library');
  expect(container.querySelector('[aria-label="Video purpose"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="Video purpose"] [aria-label="Black Friday collection"]')).toBeNull();
});

it('carries a community template brief and an audio example into the matching studio without submitting generation', async () => {
  await mount(); await click('Explore'); await click('Product films');
  expect(page().community).toBe('product-films');
  await click('Try as a video prompt');
  expect(page().studio?.scene.id).toBe('text-to-video');
  expect(container.querySelector<HTMLInputElement>('.om-creative-workspace input')?.value).toBe('A slow product reveal.');
  await traverse(-1);
  expect(page().community).toBe('product-films');
  await click('Discover');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-feed-group [data-scene="speech"]')!.click());
  expect(page().studio?.scene.id).toBe('speech');
  expect(container.querySelector<HTMLInputElement>('.om-creative-workspace input')?.value).toContain('Every idea deserves');
  expect(fetcher.mock.calls.some(([, options]) => options?.body && String(options.body).includes('"action":"generate"'))).toBe(false);
});

it('recovers template discovery and appends only new cards without replacing earlier results', async () => {
  const fallback = fetcher.getMockImplementation()!;
  const template = (id: string) => ({ id, title: id, description: 'A product reveal.', kind: 'builtin', tags: [] });
  let failures = 0;
  fetcher.mockImplementation(async (input: string, options?: RequestInit) => {
    const url = new URL(input, location.origin);
    if (!url.pathname.endsWith('/template-catalog')) return fallback(input, options);
    if (failures++ === 0) return new Response(null, { status: 503 });
    const offset = Number(url.searchParams.get('offset'));
    return Response.json({ offset, items: (offset ? ['second', 'third', 'third'] : ['first', 'second']).map(template), next: offset ? null : 2 });
  });
  await mount(); await click('Explore');
  expect(container.querySelector('.om-explore-features')?.textContent).toContain('Templates could not be loaded.');
  expect(container.querySelector('.om-feed-group [data-scene="music"]')).not.toBeNull();
  await click('Retry');
  const card = container.querySelector('[data-template-id="second"]');
  expect(card).not.toBeNull();
  await click('More community templates');
  expect(container.querySelector('[data-template-id="second"]')).toBe(card);
  expect([...container.querySelectorAll('.om-feed-group [data-template-id]')].map(node => node.getAttribute('data-template-id'))).toEqual(['second', 'third']);
  expect(button('More community templates')).toBeUndefined();
});

it('returns from a 3D technique to the same community feed and keeps its scroll position', async () => {
  await mount(); await click('Explore'); await click('3D motion');
  const feed = container.querySelector<HTMLElement>('.om-explore')!;
  feed.scrollTop = 326;
  await act(async () => feed.querySelector<HTMLButtonElement>('.om-scene-tile')!.click());
  expect(page()).toMatchObject({ specialty: { id: '3d' }, skill: 'three-js', community: '3d-motion' });
  expect(container.querySelector('.om-specialty-intro button')?.textContent).toBe('Create a 3D-style clip');
  expect([...container.querySelectorAll('.om-skills-grid [data-skill-id]')].map(node => node.getAttribute('data-skill-id'))).toEqual(page().specialty!.techniques.slice(1));
  expect(button('3D showcase')).toBeTruthy();
  expect(container.querySelector('.om-skill-detail')).not.toBeNull();
  await click('Create a shot from this brief');
  expect(page()).toMatchObject({ studio: { studio: { id: '3d' }, scene: { id: 'text-to-video' } }, skill: 'three-js' });
  expect(container.querySelector<HTMLInputElement>('[aria-label="Asset draft"]')?.value).toContain('A rotating 3D globe');
  await click('Back to 3D Studio');
  expect(page()).toMatchObject({ specialty: { id: '3d' }, skill: 'three-js' });
  await click('Back to Explore');
  expect(page()).toMatchObject({ explore: true, community: '3d-motion', specialty: null, skill: null });
  expect(container.querySelector('.om-explore')).toBe(feed);
  expect(feed.scrollTop).toBe(326);
});

it('lists each primary destination once in order, with only scene and model choices under Image', async () => {
  await mount();
  const nav = container.querySelector('.om-app-header nav.om-creative-navigation')!;
  const destinations = [...nav.querySelectorAll('button:not([aria-expanded]),a')].map(node => node.getAttribute('aria-label') ?? node.textContent?.trim());
  expect(destinations).toEqual(['Explore', 'Image', 'Video', 'Audio', 'MCP', 'API', 'Design Studio', 'Motion Studio', 'Cinema Studio', 'Sound Studio', 'Shorts Studio', 'Marketing Studio', 'Explainer Studio', '3D Studio']);
  const badges = [...nav.querySelectorAll('button[aria-describedby]')].map(node =>
    [node.getAttribute('aria-label'), document.getElementById(node.getAttribute('aria-describedby')!)?.textContent]);
  expect(badges).toEqual([['Design Studio', 'New'], ['Motion Studio', 'Top'], ['Cinema Studio', 'Hot']]);
  await click('Image scenes and models');
  const menu = document.querySelector('.om-creative-menu')!;
  expect([...menu.querySelectorAll('h2')].map(el => el.textContent)).toEqual(['Scenes', 'Models']);
  const still = [...menu.querySelectorAll('button')].find(node => node.textContent?.startsWith('Shot still'))!;
  await act(async () => still.click());
  expect(page().studio).toMatchObject({ studio: { id: 'cinema' }, scene: { id: 'shot-image' } });
});

it.each([
  ['Image', 'design', 'text-to-image'],
  ['Video', 'cinema', 'text-to-video'],
  ['Audio', 'sound', 'music'],
])('opens the %s generator directly and restores the originating page through browser history', async (label, studio, scene) => {
  await mount(); await click('Explore');
  await click(label);
  expect(page().studio).toMatchObject({ studio: { id: studio }, scene: { id: scene } });
  expect(page().studio?.landing).toBeUndefined();
  expect(document.querySelector('.om-creative-menu')).toBeNull();
  expect(button(label).getAttribute('aria-current')).toBe('location');
  expect(button(label + ' scenes and models').getAttribute('aria-expanded')).toBe('false');
  await traverse(-1);
  expect(page().explore).toBe(true);
});

it('retains the active model and scene on same-modality entry and switches a Cinema still to video', async () => {
  history.replaceState(null, '', firstUrl.replace('#', '&page=create&scene=speech&model=voice%3Anarrator#'));
  await mount(); await click('Audio');
  expect(page().studio).toMatchObject({ studio: { id: 'sound' }, scene: { id: 'speech' }, model: 'voice:narrator' });
  await click('Cinema Studio'); await click('Shot still');
  await click('Video');
  expect(page().studio).toMatchObject({ studio: { id: 'cinema' }, scene: { id: 'text-to-video' }, model: null });
});

it('pairs an explicit scene with a compatible model, continues in its studio and returns to the same Explore collection', async () => {
  const read = fetcher.getMockImplementation()!;
  const still = { id: 'camera:still', provider: 'camera', modelId: 'still', label: 'No references', modality: 'image', mode: 'text-to-image' };
  const edit = { ...still, id: 'camera:edit', modelId: 'edit', label: 'Edit with reference', supportsImageReference: true };
  fetcher.mockImplementation(async (input: string, init?: RequestInit) => {
    const path = new URL(input, location.origin).pathname;
    if (path === '/motion-api/models') return Response.json({ models: [still, edit], nextOffset: null });
    if (path === '/motion-api/models/capabilities') return Response.json({ providers: [{ id: 'camera', available: true }], routes: { image: still.id } });
    return read(input, init);
  });
  await mount(); await click('Explore'); await click('Product films');
  await click('Image scenes and models'); await click('Models for Image editing');
  const matches = document.querySelectorAll<HTMLButtonElement>('.om-creative-model-list .om-creative-option');
  expect(matches).toHaveLength(1);
  await act(async () => matches[0].click());
  expect(page()).toMatchObject({ community: 'product-films', studio: { landing: true, model: edit.id, scene: { id: 'image-edit' } } });
  expect(container.querySelector('.om-studio-bar h1')?.textContent).toBe('Image editing');
  await click('Open in Design Studio');
  expect(new URLSearchParams(location.search).get('page')).toBe('design');
  expect(page().studio?.model).toBe(edit.id);
  await traverse(-1);
  expect(page().studio?.landing).toBe(true);
  await click('Back to Explore');
  expect(page()).toMatchObject({ explore: true, community: 'product-films' });
});

it('opens a technique from the full Explore skill index in its dedicated studio', async () => {
  await mount(); await click('Explore');
  const index = container.querySelector('.om-index-skills')!;
  const category = [...index.querySelectorAll('button')].find(node => node.textContent === 'Motion techniques')!;
  await act(async () => category.click());
  const { motionSkills } = await import('./skillCatalog');
  const techniques = motionSkills.filter(skill => skill.category === 'Motion techniques');
  const links = [...index.querySelectorAll<HTMLButtonElement>('.om-index-skill-links button')];
  expect(links).toHaveLength(techniques.length);
  await act(async () => links[techniques.findIndex(skill => skill.id === 'three-js')].click());
  expect(page()).toMatchObject({ specialty: { id: '3d' }, skill: 'three-js' });
  await traverse(-1);
  expect(page().explore).toBe(true);
  expect(index.querySelector('.om-index-skill-links')).not.toBeNull();
});

it.each([
  ['Shorts Studio', 'Create a short clip', 'shorts', 'text-to-video'],
  ['Marketing Studio', 'Create a product image', 'marketing', 'text-to-image'],
  ['Marketing Studio', 'Create an ad clip', 'marketing', 'text-to-video'],
  ['Explainer Studio', 'Create an explainer clip', 'explainer', 'text-to-video'],
  ['3D Studio', 'Create a 3D-style clip', '3d', 'text-to-video'],
])('opens %s through %s without selecting a Skill', async (title, action, id, scene) => {
  await mount();
  await click(title);
  await click(action);
  expect(page()).toMatchObject({ studio: { studio: { id }, scene: { id: scene } }, specialty: null, skill: null });
  await click('Back to ' + title);
  expect(page()).toMatchObject({ specialty: { id }, studio: null, skill: null });
});
