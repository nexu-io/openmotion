// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { setCachedCloudDisklessMode } from '../utils/cloudRuntime';
import { setCloudFeatureOverridesForTest } from '../utils/cloudFeatures';
import { MotionApp } from './MotionApp';
import { useWorkspaceChrome } from './WorkspaceFrame';
import { preloadAllWorkspacePages } from '../router/lazyPages';
import { AssetsPage } from './AssetsPage';
import { CaptionsPanel } from './CaptionsPanel';
import { TimelineCaptionActions } from './TimelineCaptionActions';
import { TimelineCaptionsMenu } from './TimelineCaptionsMenu';
import { ReviewPlayerControls } from './ReviewPlayerControls';
import { ReviewCommentsPanel } from './ReviewCommentsPanel';
import { useDockLayoutStore } from '../components/dock/dockLayoutStore';

const studioMocks = vi.hoisted(() => ({
  transcriptCalls: [] as unknown[],
  upload: vi.fn(async () => ['assets/recording.wav']),
  toast: vi.fn(),
  waitForSaves: vi.fn(async () => {}),
}));

vi.mock('./MotionProjectEditor', () => ({ preloadMotionProjectEditor: vi.fn() }));
vi.mock('./tracking', () => ({ trackMotion: vi.fn() }));
vi.mock('./ArtifactViewer', () => ({
  ArtifactViewer: ({ artifact }: { artifact: { projectId: string } }) => {
    const { registerEditor } = useWorkspaceChrome();
    useEffect(() => {
      registerEditor({ blocked: false, saveState: '', message: '', waitForSaves: async () => {} });
      return () => registerEditor(null);
    }, [registerEditor]);
    return <div data-project={artifact.projectId} />;
  },
}));
vi.mock('../contexts/StudioContext', () => ({
  useStudioShellContext: () => ({
    projectId: 'project-1',
    activeCompPath: 'index.html',
    setActiveCompPath: vi.fn(),
    waitForPendingDomEditSaves: studioMocks.waitForSaves,
    writeBlockedReason: null,
    previewIframeRef: { current: null },
    showToast: studioMocks.toast,
    renderQueue: { isRendering: false },
  }),
  useStudioPlaybackContext: () => ({
    timelineElements: [],
    refreshKey: 0,
  }),
}));
vi.mock('../contexts/FileManagerContext', () => ({
  useFileManagerContext: () => ({
    uploadProjectFiles: studioMocks.upload,
    refreshFileTree: vi.fn(async () => {}),
    fileTree: [],
  }),
}));
vi.mock('../contexts/DomEditContext', () => ({
  useDomEditContext: () => ({
    domEditSelectionRef: { current: null },
    buildDomSelectionFromTarget: vi.fn(),
    applyDomSelection: vi.fn(),
  }),
}));
vi.mock('./ResizablePane', () => ({ ResizablePane: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('./transcriptClient', () => ({
  downloadTranscript: vi.fn(),
  transcriptRequest: vi.fn(async (input: { command?: string }) => {
    studioMocks.transcriptCalls.push(input);
    if (input.command === 'caption_tracks') return { tracks: [] };
    return { documents: [], jobs: [], sources: [], models: [], defaultModel: null };
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectId = '11111111-1111-1111-1111-111111111111';
const catalog = {
  activeId: projectId,
  projects: [{ id: projectId, title: 'Cloud Project' }],
  sessions: [{ id: projectId, artifacts: [{ id: projectId, projectId, kind: 'motion-project', title: 'Cloud Project' }] }],
};
const integrationInfo = {
  name: 'OpenMotion',
  version: '1.2.3',
  previewUrl: 'https://cloud.example.com',
  dataDirectory: '',
  templateSource: 'repository',
  tools: [],
  transport: { type: 'streamable-http', url: 'https://cloud.example.com/mcp', auth: { mode: 'dev', oauth2: true, pat: true } },
};

let root: Root;
let container: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;

beforeAll(() => preloadAllWorkspacePages());

beforeEach(() => {
  localStorage.clear();
  studioMocks.transcriptCalls = [];
  studioMocks.toast.mockReset();
  setCloudFeatureOverridesForTest(null);
  setCachedCloudDisklessMode(true);
  useDockLayoutStore.setState({ visiblePanels: new Set(['captions', 'timeline', 'comments']) });

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, location.origin);
    if (url.pathname.endsWith('/projects') && !init?.method) return Response.json(catalog);
    if (url.pathname.includes('/sessions/')) return Response.json(catalog.sessions[0]);
    if (url.pathname.endsWith('/open')) return Response.json({ projectId, revision: 'r1' });
    if (url.pathname.endsWith('/models/catalog')) return Response.json({ provider: 'opendesign', mode: 'opendesign', models: [], defaults: {} });
    if (url.pathname.endsWith('/models/status')) return Response.json({ providers: [{ id: 'opendesign', label: 'OpenDesign', protocol: 'account', category: 'account', kinds: ['image', 'video', 'audio'], available: true, configured: true, enabled: true }], routes: {}, agents: [], capabilities: [] });
    if (url.pathname.endsWith('/integration')) return Response.json(integrationInfo);
    if (url.pathname.endsWith('/template-catalog')) return Response.json({ items: [{ id: 'product-promo', title: 'Product Promo', description: 'A reveal.', kind: 'builtin', tags: [] }], next: null, catalogVersion: 'test' });
    if (url.pathname.endsWith('/assets') || url.pathname.endsWith('/phase1/call')) {
      return Response.json({ assets: [], total: 0, nextOffset: null, jobs: [] });
    }
    return Response.json({ projectId, revision: 'r1', version: '1.2.3', state: 'signed-in', authMode: 'dev', user: { name: 'Dev' } });
  });
  vi.stubGlobal('fetch', fetcher);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setCloudFeatureOverridesForTest(null);
  setCachedCloudDisklessMode(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

async function mountApp(path: string, key = 0) {
  history.replaceState(null, '', path);
  await act(async () => root.render(<I18nProvider initialLocale="en"><MotionApp key={key} /></I18nProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

const calledUrls = () => fetcher.mock.calls.map(([input]) => new URL(String(input), location.origin).pathname);

describe('Cloud Phase 1 feature gates', () => {
  it('hides deferred P2 surfaces on Explore while keeping Image creation and core navigation intact', async () => {
    await mountApp('/explore');

    const header = container.querySelector('.om-app-header')!;
    const headerButtons = [...header.querySelectorAll('button')].map(el => el.getAttribute('aria-label') || el.textContent?.trim());
    expect(headerButtons).toContain('Explore');
    expect(headerButtons).toContain('Image');
    expect(headerButtons).toContain('Video');
    expect(headerButtons).toContain('Audio');
    expect(headerButtons).toContain('MCP');
    expect(headerButtons).toContain('Motion Studio');
    expect(headerButtons).toContain('Cinema Studio');
    expect(headerButtons).toContain('Workspace assets');

    expect(headerButtons).not.toContain('Workflows');
    expect(headerButtons).not.toContain('Design Studio');
    expect(headerButtons).not.toContain('Game Studio');
    expect(headerButtons).not.toContain('Brand Kit');

    // Explore body hides deferred sections while retaining Image creation
    expect(container.querySelector('[data-studio="image"]')).not.toBeNull();
    expect(container.querySelector('[data-studio="design"]')).toBeNull();
    expect(container.querySelector('[data-studio="game"]')).toBeNull();
    expect(container.querySelector('[data-scene="ai-influencer"]')).toBeNull();
    expect(container.querySelector('[data-slide-action="workflow"]')).toBeNull();

    const footer = container.querySelector('.om-capability-index')!;
    expect(footer.textContent).not.toContain('Workflows');
    expect(footer.textContent).not.toContain('Design Studio');
    expect(footer.textContent).not.toContain('Game Studio');
    expect(footer.textContent).not.toContain('Brand Kit');
    expect(footer.textContent).toContain('Motion Studio');
    expect(footer.textContent).toContain('Workspace assets');

    // No deferred backend API calls fired on Explore
    const urls = calledUrls();
    expect(urls.some(u => u.includes('/design/'))).toBe(false);
    expect(urls.some(u => u.includes('/scenarios'))).toBe(false);
    expect(urls.some(u => u.includes('/games'))).toBe(false);
    expect(urls.some(u => u.includes('/brand-kits'))).toBe(false);

    // Search omits disabled studios
    const searchTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Search workspace"]')!;
    await act(async () => searchTrigger.click());
    const searchPanel = document.querySelector('.om-workspace-search')!;
    expect(searchPanel.textContent).toContain('Motion Studio');
    expect(searchPanel.textContent).not.toContain('Design Studio');
    expect(searchPanel.textContent).not.toContain('Game Studio');
  });

  it('redirects /settings/local to /settings/providers, hides Local Agents, and renames Default models', async () => {
    await mountApp('/settings/local');

    expect(location.pathname).toBe('/settings/providers');
    const nav = container.querySelector('.om-settings-sections')!;
    expect(nav.textContent).not.toContain('Local Agents');
    expect(nav.textContent).not.toContain('Default Agent & models');
    expect(nav.textContent).toContain('Default models');
    expect(calledUrls().some(u => u.includes('/agents'))).toBe(false);
  });

  it.each([
    '/design/deck',
    '/scenarios',
    '/scenarios/black-friday',
    '/studios/game',
    '/brand-kit',
  ])('redirects direct cloud navigation from %s to /explore without hitting deferred endpoints', async blockedPath => {
    const historyLengthBefore = history.length;
    await mountApp(blockedPath);

    expect(location.pathname).toBe('/explore');
    expect(history.length).toBe(historyLengthBefore);
    const urls = calledUrls();
    expect(urls.some(u => u.includes('/design/'))).toBe(false);
    expect(urls.some(u => u.includes('/scenarios'))).toBe(false);
    expect(urls.some(u => u.includes('/games'))).toBe(false);
    expect(urls.some(u => u.includes('/brand-kits'))).toBe(false);
  });

  it('filters deferred Design Studio, Workflows, and Review Comments examples on /mcp-setup', async () => {
    await mountApp('/mcp-setup');

    const scenarioIds = [...container.querySelectorAll('[data-mcp-scenario]')].map(el => el.getAttribute('data-mcp-scenario'));
    expect(scenarioIds).toContain('motion-components');
    expect(scenarioIds).toContain('media');
    expect(scenarioIds).toContain('export');
    expect(scenarioIds.some(id => id?.startsWith('design-'))).toBe(false);
    expect(scenarioIds.some(id => id?.startsWith('scenario-'))).toBe(false);
    expect(scenarioIds).not.toContain('review-comments');

    const faqText = container.querySelector('#mcp-faq')?.textContent ?? '';
    expect(faqText).toContain('Can I transcribe recordings and make multilingual platform videos?');
    expect(faqText).not.toContain('How is a Brand Kit different from a Template?');
    expect(faqText).not.toContain('How does Design Studio work in Cloud Phase 1?');
    expect(faqText).not.toContain('How does my Agent run a workflow and save results to Assets?');
  });

  it('hides the Games tab and makes zero /games API calls in AssetsPage', async () => {
    await act(async () => root.render(<I18nProvider initialLocale="en"><AssetsPage active /></I18nProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

    const tabLabels = [...container.querySelectorAll('.om-asset-tabs button')].map(el => el.textContent?.trim());
    expect(tabLabels).toContain('All');
    expect(tabLabels).not.toContain('Games');
    expect(calledUrls().some(u => u.includes('/games'))).toBe(false);
  });

  it('hides Auto captions and Open transcript while keeping manual captions and SRT/VTT import', async () => {
    await act(async () => root.render(
      <I18nProvider initialLocale="en">
        <CaptionsPanel />
        <TimelineCaptionActions onAddToTimeline={vi.fn(async () => true)} />
        <TimelineCaptionsMenu />
      </I18nProvider>,
    ));

    const tabs = [...container.querySelectorAll('[role="tab"]')].map(el => el.textContent?.trim());
    expect(tabs).toEqual(['Add captions', 'Style']);
    expect(container.querySelector('button[aria-label="Open transcript"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Manual captions"]')).not.toBeNull();
    const buttons = [...container.querySelectorAll('button')].map(el => el.textContent?.trim());
    expect(buttons).toContain('Import SRT / VTT');
    expect(studioMocks.transcriptCalls.some((c: any) => c.command === 'list' || c.command === 'models')).toBe(false);

    const captionMenuTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Caption visibility"]')!;
    await act(async () => captionMenuTrigger.click());
    const popoverButtons = [...document.querySelectorAll('button')].map(el => el.textContent?.trim());
    expect(popoverButtons).toContain('Add captions');
    expect(popoverButtons).not.toContain('Auto captions');
  });

  it('renders ReviewPlayerControls and ReviewCommentsPanel as null without calling comment APIs', async () => {
    await act(async () => root.render(
      <I18nProvider initialLocale="en">
        <ReviewPlayerControls projectId="project-1" disabled={false} />
        <ReviewCommentsPanel />
      </I18nProvider>,
    ));

    expect(container.innerHTML).toBe('');
    expect(calledUrls().some(u => u.includes('/phase1/call'))).toBe(false);
  });
});
