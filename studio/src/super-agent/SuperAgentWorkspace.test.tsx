// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SuperAgentChat, SuperAgentChatSummary, SuperAgentResourceCatalog } from '../../../shared/super-agent';
import { NearScreenIntersectionObserver } from '../hooks/intersectionObserverTestUtils';
import { I18nProvider } from '../i18n/I18n';
import { ApplicationHeader } from '../motion/ApplicationChrome';
import { WorkspaceChromeContext } from '../motion/WorkspaceChromeContext';
import { SUPER_AGENT_API } from '../../../shared/super-agent';
import { SuperAgentWorkspace } from './SuperAgentWorkspace';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../motion/WebBrowser', () => ({
  WebBrowser: ({ url }: { url: string }) => <div data-testid="mock-web-browser">{url}</div>,
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  close() {}
}

const CHAT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const sampleResources: SuperAgentResourceCatalog = {
  counts: {
    assets: 2,
    brandKits: 1,
    officialBrandKits: 152,
    motionTemplates: 10,
    designTemplates: 20,
    skills: 5,
    designSkills: 4,
    designProjects: 1,
    motionProjects: 1,
    mediaProvidersAvailable: 1,
  },
  generatedAt: Date.now(),
  items: [
    {
      id: 'dproj-1',
      kind: 'design-project',
      title: 'Neon Arcade',
      subtitle: 'prototype',
      scenario: 'prototype',
      previewUrl: '/motion-api/design/raw/dproj-1/index.html',
    },
    {
      id: 'asset-img-1',
      kind: 'asset',
      title: 'Hero Backdrop',
      subtitle: 'image',
      modality: 'image',
      versionId: 'v1',
      previewUrl: '/motion-api/assets/asset-img-1/versions/v1/media',
    },
    {
      id: 'catalog:vercel',
      kind: 'brand-kit',
      title: 'Vercel',
      subtitle: 'Developer Tools · Official Brand Kit',
      swatches: ['#000000', '#ffffff'],
    },
  ],
};

const sampleChat: SuperAgentChat = {
  id: CHAT_ID,
  title: 'Neon Arcade Build',
  engine: 'codex',
  model: 'gpt-5',
  permissionMode: 'on-request',
  createdAt: 1000,
  updatedAt: 2000,
  state: 'waiting',
  messages: [
    {
      id: 'm1',
      role: 'user',
      text: 'Build me a playable neon game',
      createdAt: 1001,
      attachments: [sampleResources.items[2]],
    },
    {
      id: 'm2',
      role: 'tool',
      text: 'openmotion_design_project: Neon Arcade',
      createdAt: 1002,
      toolEvent: {
        callId: 'c1',
        tool: 'openmotion_design_project',
        label: 'Created HTML design project',
        status: 'completed',
        summary: 'Neon Arcade',
        artifactId: 'design:dproj-1',
        startedAt: 1002,
        finishedAt: 1003,
      },
    },
    {
      id: 'm3',
      role: 'assistant',
      text: 'Created **Neon Arcade** for you.',
      createdAt: 1004,
    },
  ],
  artifacts: [
    {
      id: 'design:dproj-1',
      kind: 'design-project',
      title: 'Neon Arcade',
      subtitle: 'prototype',
      projectId: 'dproj-1',
      scenario: 'prototype',
      entry: 'index.html',
      revision: 'rev-1',
      url: '/motion-api/design/raw/dproj-1/index.html?rev=rev-1',
      createdAt: 1003,
      updatedAt: 1003,
    },
    {
      id: 'asset:asset-img-1:v1',
      kind: 'asset-image',
      title: 'Hero Backdrop',
      subtitle: 'image',
      assetId: 'asset-img-1',
      versionId: 'v1',
      url: '/motion-api/assets/asset-img-1/versions/v1/media',
      downloadUrl: '/motion-api/assets/asset-img-1/versions/v1/media?download=1',
      createdAt: 1005,
      updatedAt: 1005,
    },
  ],
  activeArtifactId: 'design:dproj-1',
  approvals: [
    {
      id: 'appr-1',
      kind: 'generation',
      title: 'Generate media asset',
      detail: '{"prompt":"neon spaceship"}',
    },
  ],
};

let container: HTMLDivElement;
let root: Root;
let originalFetch: typeof fetch;
let originalEventSource: typeof EventSource | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  originalFetch = globalThis.fetch;
  originalEventSource = globalThis.EventSource;
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.startsWith('/motion-api/settings/agents')) {
      return json({
        agents: [
          {
            id: 'codex',
            label: 'Codex',
            icon: 'codex',
            installed: true,
            auth: 'signed-in',
            models: [{ id: 'gpt-5', label: 'GPT-5', reasoning: ['low', 'medium', 'high'] }],
          },
        ],
      });
    }
    if (url.startsWith(`${SUPER_AGENT_API}/resources`)) {
      return json(sampleResources);
    }
    if (url === `${SUPER_AGENT_API}/chats`) {
      const summaries: SuperAgentChatSummary[] = [
        {
          id: CHAT_ID,
          title: sampleChat.title,
          engine: 'codex',
          state: sampleChat.state,
          artifactCount: sampleChat.artifacts.length,
          messageCount: 2,
          updatedAt: sampleChat.updatedAt,
          createdAt: sampleChat.createdAt,
        },
      ];
      return json({ conversations: summaries });
    }
    if (url === `${SUPER_AGENT_API}/chats/${CHAT_ID}` && (!init?.method || init.method === 'GET')) {
      return json({ conversation: sampleChat });
    }
    if (url === `${SUPER_AGENT_API}/chats/${CHAT_ID}` && init?.method === 'PATCH') {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      return json({ conversation: { ...sampleChat, ...body } });
    }
    if (url === `${SUPER_AGENT_API}/chats/${CHAT_ID}/approve` && init?.method === 'POST') {
      const next: SuperAgentChat = { ...sampleChat, state: 'running', approvals: [] };
      return json({ conversation: next });
    }
    if (url === '/motion-api/design/projects/dproj-1') {
      return json({
        project: {
          id: 'dproj-1',
          title: 'Neon Arcade',
          scenario: 'prototype',
          entry: 'index.html',
          designSystemId: null,
          templateId: null,
          source: 'blank',
          createdAt: 1000,
          updatedAt: 2000,
          trashedAt: null,
          revision: 'rev-1',
          versionId: null,
          versionLabel: null,
          files: [{ path: 'index.html', size: 120, sha256: 'abc', kind: 'html' }],
          path: '/tmp/dproj-1',
          previewUrl: '/motion-api/design/raw/dproj-1/index.html',
          editorUrl: '/?page=design',
          openComments: 0,
        },
      });
    }
    if (url === '/motion-api/design/projects/dproj-1/files/index.html') {
      return json({ path: 'index.html', content: '<!doctype html><canvas id="game"></canvas>', revision: 'rev-1', size: 42, nextOffset: null });
    }
    return json({});
  }) as any;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  (globalThis as any).EventSource = originalEventSource;
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));
  });
}

it('renders Super Agent empty home, opens Resource Picker, and applies selected attachments to the composer', async () => {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={null}
          onChatIdChange={vi.fn()}
          onOpenDesignProject={vi.fn()}
          onOpenMotionProject={vi.fn()}
          onOpenAsset={vi.fn()}
          onOpenBrandKit={vi.fn()}
          onOpenAgentSettings={vi.fn()}
          onOpenMcp={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();

  expect(document.body.textContent).toContain('What can I create for you?');
  expect(document.body.textContent).toContain('Generate image');
  expect(document.body.textContent).toContain('Make a video');
  expect(document.body.textContent).toContain('Cinema & audio');
  expect(document.body.textContent).toContain('Explore more');

  // No standalone Resources entry button in the stream header
  const standaloneResBtn = [...document.querySelectorAll('.om-sa-stream-head button')].find(
    b => b.getAttribute('aria-label') === 'Resources',
  );
  expect(standaloneResBtn).toBeUndefined();

  // Open resources directly via the composer plus icon and click a resource to attach it straight into the composer
  const plusBtn = [...document.querySelectorAll('button')].find(
    b => b.getAttribute('aria-label') === 'Attach workspace resources',
  ) as HTMLButtonElement;
  expect(plusBtn).toBeTruthy();
  await act(async () => plusBtn.click());
  await flush();

  const neonRow = [...document.querySelectorAll('.om-sa-resource-row')].find(
    b => b.textContent?.includes('Neon Arcade'),
  ) as HTMLButtonElement;
  expect(neonRow).toBeTruthy();
  await act(async () => neonRow.click());
  await flush();

  expect(document.querySelector('.om-sa-composer-chips')?.textContent).toContain('Neon Arcade');
});

it('displays active conversation, tool steps, approvals, and multi-tab Artifact Viewer with Preview/Code switching', async () => {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={CHAT_ID}
          onChatIdChange={vi.fn()}
          onOpenDesignProject={vi.fn()}
          onOpenMotionProject={vi.fn()}
          onOpenAsset={vi.fn()}
          onOpenBrandKit={vi.fn()}
          onOpenAgentSettings={vi.fn()}
          onOpenMcp={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();

  // Artifact Viewer stays closed by default on initial load / refresh and opens manually
  expect(document.querySelector('.om-sa-viewer')).toBeNull();
  const viewerToggle = [...document.querySelectorAll('button')].find(
    b => b.getAttribute('aria-label') === 'Artifact Viewer',
  ) as HTMLButtonElement;
  expect(viewerToggle).toBeTruthy();
  await act(async () => viewerToggle.click());
  await flush();

  const viewer = document.querySelector('.om-sa-viewer')!;
  expect(viewer).toBeTruthy();
  const iframe = viewer.querySelector('iframe');
  expect(iframe?.getAttribute('src')).toContain('/motion-api/design/raw/dproj-1/index.html');

  // Switch Design Project Artifact to Code tab and verify CodeViewer renders index.html
  const codeBtn = [...viewer.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Code') as HTMLButtonElement;
  await act(async () => codeBtn.click());
  await flush();
  expect(viewer.textContent).toContain('<canvas id="game"></canvas>');

  // Click second artifact tab (Hero Backdrop image)
  const imgTab = [...viewer.querySelectorAll('[role="tab"]')].find(t => t.textContent?.includes('Hero Backdrop')) as HTMLButtonElement;
  await act(async () => imgTab.click());
  await flush();
  expect(viewer.querySelector('.om-sa-image-checkerboard img')?.getAttribute('src')).toContain('/motion-api/assets/asset-img-1');

  // Approve pending action
  const approveBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Approve') as HTMLButtonElement;
  expect(approveBtn).toBeTruthy();
  await act(async () => approveBtn.click());
  await flush();
  expect(document.querySelector('.om-sa-approval')).toBeNull();
});

it('renders Super Agent inside the top navigation bar beside MCP and activates it on click', async () => {
  const onOpenPage = vi.fn();
  const noop = () => {};
  const chromeValue: any = {
    workspace: { status: 'ready', busy: false, error: '', errorSource: null, activeProjectId: 'p1', projects: [], open: noop, clearError: noop },
    switchingDisabled: false,
    saveState: '',
    registerEditor: noop,
    beforeViewChange: async () => {},
    openLibrary: noop,
    openConnections: noop,
    openModelSettings: noop,
    openProviderSettings: noop,
    openAccountSettings: noop,
    openSubscriptionSettings: noop,
    openHome: noop,
    openAssets: noop,
    assetsOpen: false,
    openSkills: noop,
    skillsOpen: false,
    toggleSidebar: noop,
    sidebarOpen: false,
    navigationCollapsed: false,
    projectNavigation: null,
    settingsOpen: false,
  };

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <WorkspaceChromeContext.Provider value={chromeValue}>
          <ApplicationHeader
            atExploreHome
            onSkill={noop}
            settings={null}
            openSettings={noop}
            openAsset={noop}
            onCommunity={noop}
            onChooseStudio={noop}
            currentPage="agent"
            trackingPage="explore"
            onOpenPage={onOpenPage}
            destination={null}
            motionActive={false}
            onNavigate={noop}
          />
        </WorkspaceChromeContext.Provider>
      </I18nProvider>,
    );
  });

  expect(document.querySelector('.om-mode-switcher')).toBeNull();
  const nav = document.querySelector('nav.om-creative-navigation')!;
  expect(nav).toBeTruthy();
  const agentBtn = nav.querySelector('button.om-super-agent-nav-link') as HTMLButtonElement;
  expect(agentBtn).toBeTruthy();
  expect(agentBtn.getAttribute('aria-current')).toBe('page');

  await act(async () => agentBtn.click());
  expect(onOpenPage).toHaveBeenCalledWith('agent');
});

it('suspends active viewer iframes when inactive, uses throttled thumb previews in game showcase, and releases web tabs on close', async () => {
  const flush = () => act(async () => { await Promise.resolve(); });
  const webChat: SuperAgentChat = {
    ...sampleChat,
    artifacts: [
      ...sampleChat.artifacts,
      {
        id: 'web:example',
        kind: 'web',
        title: 'Example Web',
        url: 'https://example.com',
        createdAt: 1006,
        updatedAt: 1006,
      },
    ],
  };

  const baseFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
  const deleteCalls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'DELETE' && url.includes('/browser/')) {
      deleteCalls.push(url);
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    if (url === `${SUPER_AGENT_API}/chats/${CHAT_ID}` && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ conversation: webChat }), { status: 200 });
    }
    return baseFetch(input, init);
  });

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={CHAT_ID}
          onChatIdChange={vi.fn()}
          onOpenDesignProject={vi.fn()}
          onOpenMotionProject={vi.fn()}
          onOpenAsset={vi.fn()}
          onOpenBrandKit={vi.fn()}
          onOpenAgentSettings={vi.fn()}
          onOpenMcp={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();

  // Open Artifact Viewer manually, then verify active workspace renders the Design project iframe.
  const viewerToggle = [...document.querySelectorAll('button')].find(
    b => b.getAttribute('aria-label') === 'Artifact Viewer',
  ) as HTMLButtonElement;
  expect(viewerToggle).toBeTruthy();
  await act(async () => viewerToggle.click());
  await flush();
  expect(document.querySelector('.om-sa-viewer iframe')).toBeTruthy();

  // Deactivating SuperAgentWorkspace suspends the heavy viewer iframe while preserving tabs.
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active={false}
          chatId={CHAT_ID}
          onChatIdChange={vi.fn()}
          onOpenDesignProject={vi.fn()}
          onOpenMotionProject={vi.fn()}
          onOpenAsset={vi.fn()}
          onOpenBrandKit={vi.fn()}
          onOpenAgentSettings={vi.fn()}
          onOpenMcp={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
  expect(document.querySelector('.om-sa-viewer iframe')).toBeNull();
  expect(document.querySelectorAll('.om-sa-viewer [role="tab"]').length).toBeGreaterThanOrEqual(2);

  // Returning to active restores the iframe cleanly and closing the web tab deletes its server session.
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={CHAT_ID}
          onChatIdChange={vi.fn()}
          onOpenDesignProject={vi.fn()}
          onOpenMotionProject={vi.fn()}
          onOpenAsset={vi.fn()}
          onOpenBrandKit={vi.fn()}
          onOpenAgentSettings={vi.fn()}
          onOpenMcp={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
  expect(document.querySelector('.om-sa-viewer iframe')).toBeTruthy();

  const webTab = [...document.querySelectorAll('.om-sa-viewer-tab')].find(tab => tab.textContent?.includes('Example Web'));
  expect(webTab).toBeTruthy();
  const closeTabBtn = webTab!.querySelector<HTMLButtonElement>('.om-sa-viewer-tab-close')!;
  await act(async () => closeTabBtn.click());
  await flush();
  expect(deleteCalls.some(url => url.endsWith('/browser/web-example'))).toBe(true);

  // Opening a new conversation & clicking Interactive HTML Game uses ScaledPreviewThumb (?thumb=1) instead of raw unthrottled iframes.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${SUPER_AGENT_API}/resources`)) {
      return new Response(
        JSON.stringify({
          ...sampleResources,
          items: [
            {
              id: 'webgl-shader',
              kind: 'design-template',
              title: 'WebGL Shader',
              subtitle: 'webgl',
              scenario: 'webgl',
              previewUrl: '/motion-api/design/catalog/templates/webgl-shader/preview/index.html',
            },
          ],
        }),
        { status: 200 },
      );
    }
    return baseFetch(input, init);
  });

  vi.stubGlobal('IntersectionObserver', NearScreenIntersectionObserver);
  try {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <SuperAgentWorkspace
            active
            chatId={null}
            onChatIdChange={vi.fn()}
            onOpenDesignProject={vi.fn()}
            onOpenMotionProject={vi.fn()}
            onOpenAsset={vi.fn()}
            onOpenBrandKit={vi.fn()}
            onOpenAgentSettings={vi.fn()}
            onOpenMcp={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const gameBtn = [...document.querySelectorAll('button')].find(
      b => b.textContent?.includes('Build a game') || b.textContent?.includes('Interactive HTML Game'),
    )!;
    await act(async () => gameBtn.click());
    await flush();
    await flush();

    const thumb = document.querySelector('.om-sa-showcase-iframe-wrap .om-design-card-thumb');
    expect(thumb).toBeTruthy();
    expect(thumb!.querySelector('iframe')?.getAttribute('src')).toContain('?thumb=1');
  } finally {
    vi.unstubAllGlobals();
  }
});
