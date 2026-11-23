// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SuperAgentChat, SuperAgentChatSummary, SuperAgentResourceCatalog } from '../../../shared/super-agent';
import { NearScreenIntersectionObserver } from '../hooks/intersectionObserverTestUtils';
import { I18nProvider } from '../i18n/I18n';
import { translate } from '../i18n/messages';
import { ApplicationHeader } from '../motion/ApplicationChrome';
import { WorkspaceChromeContext } from '../motion/WorkspaceChromeContext';
import { SUPER_AGENT_API } from '../../../shared/super-agent';
import { buildSuperAgentHandoff } from '../../../shared/capability-hub';
import { queueSuperAgentHandoff } from '../motion/superAgentHandoff';
import { clampSuperAgentViewerWidth, SuperAgentWorkspace } from './SuperAgentWorkspace';
import { ExecutionTimeline, SuperAgentLiveProgressDock } from './ExecutionTimeline';
import { SimpleMarkdown } from './SimpleMarkdown';
import { DEFAULT_MODE_COMPOSER_OPTIONS, getModeComposerPlaceholder } from './ModeComposerControls';
import { SUPER_AGENT_MODES } from './ModeResourceShowcase';
import { clearSuperAgentCache, peekCachedSuperAgentChat } from './superAgentClient';
import { setClientCacheOverrideForTest } from '../utils/clientCacheMode';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../motion/WebBrowser', async () => {
  const React = await import('react');
  const WebBrowser = React.forwardRef(function MockWebBrowser(
    { url, onState }: { url: string; onState?: (state: any) => void },
    ref: React.ForwardedRef<any>,
  ) {
    const imgRef = React.useRef<HTMLImageElement>(null);
    React.useEffect(() => {
      onState?.({
        url,
        title: 'Local App',
        canGoBack: true,
        canGoForward: false,
        loading: false,
        colorScheme: 'auto',
        zoom: 1,
        consoleCount: 0,
        errorCount: 0,
      });
    }, [url]);
    React.useImperativeHandle(ref, () => ({
      command: async (action: string, value?: unknown) => ({
        url,
        title: 'Local App',
        canGoBack: true,
        canGoForward: false,
        loading: false,
        colorScheme: action === 'set-color-scheme' ? value : 'auto',
        zoom: action === 'set-zoom' && typeof value === 'number' ? value : 1,
        consoleCount: 0,
        errorCount: 0,
      }),
      inspectAt: async () => ({
        element: {
          tagName: 'button',
          selector: '#hero-btn',
          label: 'Launch',
          htmlPreview: '<button id="hero-btn">Launch</button>',
          styles: { display: 'inline-flex', backgroundColor: 'rgb(0, 0, 0)' },
          rect: { x: 40, y: 50, width: 120, height: 40 },
          viewport: { width: 1280, height: 800 },
          pageUrl: url,
          componentName: 'HeroButton',
          sourceFile: 'src/HeroButton.tsx',
          sourceLine: 24,
        },
        viewport: { width: 1280, height: 800 },
        pageUrl: url,
        pageTitle: 'Local App',
      }),
      screenshot: async () => ({
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        mimeType: 'image/png',
        width: 1280,
        height: 800,
        pageUrl: url,
        pageTitle: 'Local App',
      }),
      getViewport: () => ({ width: 1280, height: 800 }),
      getRenderedImage: () => imgRef.current,
      clearConsole: async () => undefined,
    }));
    return (
      <div data-testid="mock-web-browser">
        <img ref={imgRef} alt={url} />
        {url}
      </div>
    );
  });
  return { WebBrowser };
});

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
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('motion.super-agent.read-result.')) localStorage.removeItem(key);
  }
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
  expect([...container.querySelectorAll('.om-sa-starter-card strong')].map(node => node.textContent)).toEqual([
    'Build a game', 'Generate image', 'Make a video', 'Create audio', 'Create slides', 'Explore more',
  ]);

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

it('keeps background task status in one slot and shows a dot only for an unread result', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const task: SuperAgentChatSummary = {
    id: CHAT_ID,
    title: 'Background task',
    intent: 'game',
    engine: 'codex',
    pinned: true,
    state: 'running',
    artifactCount: 1,
    messageCount: 2,
    lastTurnId: 'turn-1',
    updatedAt: 1000,
    createdAt: 1000,
  };
  const fallbackFetch = globalThis.fetch;
  const getTask = vi.fn(() => new Response(JSON.stringify({
    conversation: {
      ...sampleChat, ...task, artifacts: [], approvals: [],
      requestReceipts: [{ requestId: task.lastTurnId, inputHash: 'test' }],
    },
  })));
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === `${SUPER_AGENT_API}/chats`) return new Response(JSON.stringify({ conversations: [task] }));
    if (url === `${SUPER_AGENT_API}/chats/${task.id}`) return getTask();
    return fallbackFetch(input, init);
  };

  const onChatIdChange = vi.fn();
  const render = (chatId: string | null, key = 'workspace', active = true) => act(async () => {
    root.render(
      <I18nProvider key={key} initialLocale="en">
        <SuperAgentWorkspace
          active={active}
          chatId={chatId}
          onChatIdChange={onChatIdChange}
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

  try {
    clearSuperAgentCache();
    setClientCacheOverrideForTest(true);
    await render(null);
    const pinnedRow = () => container.querySelector<HTMLButtonElement>('.om-sa-chat-group[aria-label="Pinned"] .om-sa-chat-row-btn')!;
    const row = pinnedRow();
    const status = row.lastElementChild!;
    expect(status.matches('.om-sa-chat-status[data-state="running"]')).toBe(true);
    expect(status.querySelector('[data-remix-icon="loader-4-line"]')).toBeTruthy();
    expect(row.querySelector('.om-sa-chat-dot')).toBeNull();
    expect(row.querySelector('.om-sa-chat-count')).toBeNull();

    task.state = 'waiting';
    task.updatedAt++;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(status.matches('.om-badge[data-state="waiting"]')).toBe(true);
    expect(status.textContent).toBe('Approval needed');
    expect(peekCachedSuperAgentChat(CHAT_ID)?.state).toBe('waiting');
    expect(status.querySelector('svg')).toBeNull();
    expect(row.querySelector('.om-sa-chat-dot')).toBeNull();

    task.state = 'idle';
    task.updatedAt++;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(row.lastElementChild).toBe(status);
    expect(status.getAttribute('data-state')).toBe('completed');
    expect(peekCachedSuperAgentChat(CHAT_ID)?.state).toBe('idle');
    expect(status.querySelector('.om-sa-chat-dot')).toBeTruthy();
    expect(status.querySelector('svg')).toBeNull();
    expect(row.querySelector('.om-sa-chat-icon-wrap .om-sa-chat-dot')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(getTask).toHaveBeenCalledTimes(2);
    await render(null, 'workspace', false);
    await render(null);
    expect(pinnedRow().querySelector('.om-sa-chat-dot')).toBeTruthy();
    expect(getTask).toHaveBeenCalledTimes(2);
    clearSuperAgentCache();
    setClientCacheOverrideForTest(null);

    await act(async () => row.click());
    expect(onChatIdChange).toHaveBeenCalledWith(CHAT_ID);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await render(CHAT_ID);
    expect(pinnedRow().querySelector('.om-sa-chat-dot')).toBeTruthy();
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(pinnedRow().querySelector('.om-sa-chat-dot')).toBeNull();

    task.title = 'Renamed task';
    task.updatedAt++;
    await render(null, 'reloaded');
    expect(pinnedRow().querySelector('.om-sa-chat-dot')).toBeNull();

    task.lastTurnId = 'turn-2';
    task.updatedAt++;
    await render(null, 'new-result');
    expect(pinnedRow().querySelector('.om-sa-chat-dot')).toBeTruthy();

    task.state = 'failed';
    task.updatedAt++;
    await render(CHAT_ID, 'stopped-result');
    expect(pinnedRow().querySelector('.om-sa-chat-status-badge[data-state="failed"]')?.textContent).toBe('Stopped');
    expect(container.querySelector('.om-sa-head-status-badge')?.textContent).toBe('Stopped');
    expect(pinnedRow().querySelector('.om-sa-chat-dot')).toBeNull();
  } finally {
    clearSuperAgentCache();
    setClientCacheOverrideForTest(null);
    vi.useRealTimers();
  }
});

it('localizes creation mode introductions, prompt ideas, and composer guidance in Chinese', () => {
  const t = (key: string) => translate('zh-CN', key);
  for (const mode of SUPER_AGENT_MODES) {
    const copy = [
      t(mode.label),
      t(mode.title),
      t(mode.subtitle),
      getModeComposerPlaceholder(mode, DEFAULT_MODE_COMPOSER_OPTIONS, t),
      ...mode.quickIdeas.flatMap(idea => [t(idea.title), t(idea.prompt)]),
    ];
    for (const label of copy) expect(label).toMatch(/[\u3400-\u9fff]/u);
  }
});

it('shows Chinese image controls and keeps the draft when switching creation modes', async () => {
  const onChangeRequestedMode = vi.fn();
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="zh-CN">
        <SuperAgentWorkspace
          active
          chatId={null}
          requestedMode="image"
          onChangeRequestedMode={onChangeRequestedMode}
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

  expect(container.querySelector('.om-sa-mode-hero-copy h2')?.textContent).toBe('创作图像素材');
  expect(container.querySelector('[role="tablist"]')?.textContent).toContain('多图融合');
  const example = container.querySelector<HTMLButtonElement>('.om-sa-showcase-card')!;
  expect(example.textContent).toContain('GPT Image 2.6 · 图片');
  const composer = container.querySelector<HTMLTextAreaElement>('textarea')!;
  expect(composer.placeholder).toBe('描述你想生成的图像，或说明如何修改参考图…');
  await act(async () => example.click());
  expect(composer.value).toMatch(/[\u3400-\u9fff]/u);

  const trigger = container.querySelector<HTMLButtonElement>('.om-sa-mode-param-trigger')!;
  await act(async () => trigger.click());

  const parameters = document.querySelector('[aria-label="图像参数"]');
  expect(parameters?.textContent).toContain('高质量 · 2K');
  expect(parameters?.textContent).toContain('生成数量');
  for (const count of [1, 2, 4]) expect(parameters?.textContent).toContain(`${count} 张图片`);

  await act(async () => trigger.click());
  const draft = composer.value;
  const modeSelect = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="创作模式"]')!;
  expect(modeSelect.textContent).toBe('图像创作');
  await act(async () => modeSelect.click());
  const modes = [...document.querySelectorAll<HTMLElement>('.om-sa-creation-mode-menu [role="option"]')];
  expect(modes.map(option => option.textContent)).toEqual([
    '游戏工作室', '图像创作', '动态视频', '音频与音效', '幻灯片与文档', '电影镜头', '编程任务', '网站与应用',
  ]);
  const audio = modes[3];
  await act(async () => audio.click());
  expect(onChangeRequestedMode).toHaveBeenCalledWith('audio');
  expect(container.querySelector('.om-sa-stream')?.getAttribute('data-mode')).toBe('audio');
  expect(modeSelect.textContent).toBe('音频与音效');
  expect(composer.value).toBe(draft);
});

it.each(['motion', 'media'] as const)('keeps the %s dropdown limited to video models and supports editable templates', async requestedMode => {
  const fallbackFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/motion-api/models/capabilities') {
      return new Response(JSON.stringify({ routes: { video: 'fixture-video' }, providers: [] }));
    }
    if (url.startsWith('/motion-api/models?')) {
      return new Response(JSON.stringify({
        models: [
          { id: 'alternate-video', modelId: 'alternate-video', label: 'Alternate Video', provider: 'fixture', modality: 'video', mode: 'text-to-video' },
          { id: 'fixture-video', modelId: 'fixture-video', label: 'Fixture Video', provider: 'fixture', modality: 'video', mode: 'text-to-video' },
        ],
        nextOffset: null,
      }));
    }
    if (url.startsWith(`${SUPER_AGENT_API}/resources`)) {
      return new Response(JSON.stringify({
        ...sampleResources,
        items: [{ id: 'motion-template', kind: 'motion-template', title: 'Editable timeline' }],
      }));
    }
    return fallbackFetch(input, init);
  };

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={null}
          requestedMode={requestedMode}
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

  const bar = container.querySelector('.om-sa-composer-top-bar')!;
  const trigger = bar.querySelector<HTMLButtonElement>('.om-sa-composer-top-pill')!;
  const label = () => trigger.querySelector('.om-sa-composer-top-pill-label')?.textContent;
  const parameters = () => container.querySelector('.om-sa-mode-param-trigger')?.textContent;
  expect(bar.querySelectorAll('.om-sa-composer-top-pill')).toHaveLength(1);
  expect(label()).toBe('Fixture Video');
  expect(trigger.hasAttribute('data-active')).toBe(true);
  expect(trigger.querySelector('.om-sa-mode-param-avatar .om-avatar')).toBeTruthy();

  await act(async () => trigger.click());
  const options = [...document.querySelectorAll<HTMLButtonElement>('.om-sa-mode-model-row')];
  expect(options.map(option => option.querySelector('strong')?.textContent)).toEqual(['Auto (Recommended)', 'Alternate Video', 'Fixture Video']);
  expect(options[0].getAttribute('aria-selected')).toBe(String(requestedMode === 'media'));

  await act(async () => options[1].click());
  expect(label()).toBe('Alternate Video');
  expect(parameters()).toContain('5s');

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Attach workspace resources"]')!.click());
  await flush();
  await act(async () => document.querySelector<HTMLButtonElement>('.om-sa-resource-row')!.click());
  expect(label()).toBe('Alternate Video');
  expect(parameters()).toContain('30fps');
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
  await vi.waitFor(async () => {
    await flush();
    expect(document.querySelector('.om-sa-viewer iframe')).toBeTruthy();
  }, { timeout: 5000 });

  const viewer = document.querySelector('.om-sa-viewer')!;
  const iframe = viewer.querySelector('iframe');
  expect(iframe?.getAttribute('src')).toContain('/motion-api/design/raw/dproj-1/index.html');

  // Switch Design Project Artifact to Code view via the compact icon dropdown and verify CodeViewer renders index.html
  const viewModeBtn = viewer.querySelector('.om-sa-view-mode-trigger') as HTMLButtonElement;
  expect(viewModeBtn).toBeTruthy();
  await act(async () => viewModeBtn.click());
  await flush();
  const codeBtn = [...document.querySelectorAll('.om-sa-view-mode-popover button')].find(b => b.textContent?.trim() === 'Code') as HTMLButtonElement;
  expect(codeBtn).toBeTruthy();
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
            onOpenAgentStart={noop}
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
  await vi.waitFor(async () => {
    await flush();
    expect(document.querySelector('.om-sa-viewer iframe')).toBeTruthy();
  }, { timeout: 5000 });

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

  // Opening a new conversation & clicking Build a website uses ScaledPreviewThumb (?thumb=1) instead of raw unthrottled iframes.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${SUPER_AGENT_API}/resources`)) {
      return new Response(
        JSON.stringify({
          ...sampleResources,
          items: [
            {
              id: 'proto-landing',
              kind: 'design-template',
              title: 'Interactive Landing',
              subtitle: 'prototype',
              scenario: 'prototype',
              previewUrl: '/motion-api/design/catalog/templates/proto-landing/preview/index.html',
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

    const moreBtn = [...document.querySelectorAll('button')].find(
      b => b.textContent?.includes('Explore more'),
    )!;
    await act(async () => moreBtn.click());
    await flush();

    const webBtn = [...document.querySelectorAll('button')].find(
      b => b.textContent?.includes('Build a website'),
    )!;
    await act(async () => webBtn.click());
    await flush();
    await flush();

    const thumb = document.querySelector('.om-sa-showcase-iframe-wrap .om-design-card-thumb');
    expect(thumb).toBeTruthy();
    expect(thumb!.querySelector('iframe')?.getAttribute('src')).toContain('?thumb=1');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('clamps Artifact Viewer width against docked sidebar and center stream across viewport widths', () => {
  // 1280px screen with 240px docked sidebar + 1px resizer leaves 1039px; min center 300px caps viewer at 739px
  expect(clampSuperAgentViewerWidth(950, 1280, 240)).toBe(739);
  expect(clampSuperAgentViewerWidth(560, 1280, 240)).toBe(560);
  expect(clampSuperAgentViewerWidth(200, 1280, 240)).toBe(320);

  // 1000px mid-width screen with drawer sidebar (0 docked width): 72% cap = min(719, 699) = 699
  expect(clampSuperAgentViewerWidth(900, 1000, 0)).toBe(699);

  // Tight split (< 620 available) falls back to 55% proportional split without overflowing
  expect(clampSuperAgentViewerWidth(600, 600, 0)).toBe(329);
  expect(clampSuperAgentViewerWidth(100, 600, 0)).toBe(329);
  expect(clampSuperAgentViewerWidth(400, 420, 0)).toBe(240);
});

it('renders ExecutionTimeline live status, grouped Work Log with diffs/commands, deliverables, and enhanced SimpleMarkdown', async () => {
  const onCopyText = vi.fn();
  const onOpenArtifactId = vi.fn();
  const onOpenWebUrl = vi.fn();

  const timelineChat: SuperAgentChat = {
    id: CHAT_ID,
    title: 'Timeline Demo',
    engine: 'antigravity',
    permissionMode: 'auto',
    createdAt: 1000,
    updatedAt: 5000,
    state: 'idle',
    lastTurnDurationMs: 3200,
    lastTurnUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    artifacts: [
      {
        id: 'design:d-99',
        kind: 'design-project',
        title: 'Landing Card',
        subtitle: 'prototype',
        projectId: 'd-99',
        createdAt: 2000,
        updatedAt: 4200,
      },
    ],
    approvals: [],
    messages: [
      { id: 'u1', role: 'user', text: 'Inspect and build card', createdAt: 1000 },
      { id: 'r1', role: 'reasoning', text: 'Planning file edits first', status: 'completed', durationMs: 850, createdAt: 1200 },
      {
        id: 't1',
        role: 'tool',
        text: 'Executed command',
        createdAt: 1500,
        toolEvent: {
          callId: 'c1',
          tool: 'run_command',
          label: 'Checked Node',
          status: 'completed',
          category: 'command',
          command: 'node -v',
          exitCode: 0,
          outputPreview: 'v26.11.1',
          durationMs: 120,
          startedAt: 1500,
          finishedAt: 1620,
        },
      },
      {
        id: 't2',
        role: 'tool',
        text: 'Edited styles.css',
        createdAt: 2000,
        toolEvent: {
          callId: 'c2',
          tool: 'Edit',
          label: 'Edited styles.css',
          status: 'completed',
          category: 'file_edit',
          fileOp: {
            action: 'edit',
            path: 'styles.css',
            addedLines: 2,
            removedLines: 1,
            diffPreview: '-color: red;\n+color: blue;\n+gap: 8px;',
          },
          durationMs: 90,
          startedAt: 2000,
          finishedAt: 2090,
        },
      },
      {
        id: 'a1',
        role: 'assistant',
        text: [
          '## Summary',
          '',
          '| Step | Status |',
          '| --- | --- |',
          '| Node | v26.11.1 |',
          '',
          '- [x] Updated `file:///tmp/styles.css`',
          '',
          'See [Example Docs](https://example.com/docs).',
        ].join('\n'),
        createdAt: 4200,
      },
    ],
  };

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ExecutionTimeline
          chat={timelineChat}
          busy={false}
          sending={false}
          engineLabel="Antigravity"
          onOpenArtifactId={onOpenArtifactId}
          onPreviewAttachment={vi.fn()}
          onOpenWebUrl={onOpenWebUrl}
          onCopyText={onCopyText}
          onApprove={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();

  expect(document.body.textContent).toContain('Worked for 3.2s · 3 steps');
  expect(document.body.textContent).toContain('Files changed (1)');
  expect(document.body.textContent).toContain('Antigravity · 3.2s · 150 tokens');
  expect(document.querySelector('.om-sa-md-table')).toBeTruthy();
  expect(document.querySelector('.om-sa-md-task')).toBeTruthy();

  // Completed turn auto-collapses the Work Log while showing FilesChangedCard below assistant summary
  expect(document.querySelector('.om-sa-work-items')).toBeNull();
  const assistantEl = document.querySelector('.om-sa-assistant-content')!;
  const filesChangedEl = document.querySelector('.om-sa-files-changed')!;
  expect(assistantEl.compareDocumentPosition(filesChangedEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(filesChangedEl.textContent).toContain('styles.css');
  expect(filesChangedEl.querySelector('.om-sa-diff-pre')).toBeNull();
  await act(async () => {
    filesChangedEl.querySelector<HTMLButtonElement>('.om-sa-file-row-trigger')!.click();
  });
  await flush();
  expect(filesChangedEl.querySelector('.om-sa-diff-pre')?.textContent).toContain('+gap: 8px;');

  // Expand Work Log and verify command + diff lines
  const workBtn = document.querySelector<HTMLButtonElement>('.om-sa-work-summary-btn')!;
  await act(async () => workBtn.click());
  await flush();
  expect(document.body.textContent).toContain('Thought for 850ms');
  expect(document.body.textContent).toContain('Checked Node');
  expect(document.body.textContent).toContain('exit 0');

  // Deliverable card & guided actions & viewer link button & file chip
  const deliverableBtn = document.querySelector<HTMLButtonElement>('.om-sa-deliverable-main')!;
  await act(async () => deliverableBtn.click());
  expect(onOpenArtifactId).toHaveBeenCalledWith('design:d-99');
  const deliverableActions = document.querySelector('.om-sa-deliverable-actions');
  expect(deliverableActions?.textContent).toContain('Preview');
  expect(deliverableActions?.textContent).toContain('Share');
  expect(deliverableActions?.textContent).toContain('Export');

  const viewerLinkBtn = document.querySelector<HTMLButtonElement>('.om-sa-link-viewer-btn')!;
  await act(async () => viewerLinkBtn.click());
  expect(onOpenWebUrl).toHaveBeenCalledWith('https://example.com/docs');

  const fileChip = document.querySelector<HTMLButtonElement>('.om-sa-file-chip')!;
  await act(async () => fileChip.click());
  expect(onCopyText).toHaveBeenCalledWith('/tmp/styles.css');

  // Verify live active state + plan rendering
  const liveChat: SuperAgentChat = {
    ...timelineChat,
    state: 'running',
    lastTurnDurationMs: undefined,
    turnActivity: {
      phase: 'tool',
      label: 'Running node -v',
      activeToolName: 'run_command',
      startedAt: Date.now() - 1500,
      updatedAt: Date.now(),
      plan: [
        { content: 'Check Node version', status: 'in_progress' },
        { content: 'Write report', status: 'pending' },
      ],
    },
  };

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ExecutionTimeline
          chat={liveChat}
          busy
          sending={false}
          engineLabel="Antigravity"
          onOpenArtifactId={onOpenArtifactId}
          onPreviewAttachment={vi.fn()}
          onCopyText={onCopyText}
          onApprove={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Running node -v');
  expect(document.querySelector('.om-sa-plan-card')?.textContent).toContain('Check Node version');

  // Long user prompt defaults to collapsed, expands on click, and collapses cleanly via top pill
  const longPromptChat: SuperAgentChat = {
    ...timelineChat,
    messages: [
      {
        id: 'u-long',
        role: 'user',
        text: Array.from({ length: 12 }, (_, i) => `Brief line ${i + 1}: detailed requirement specification for game loop.`).join('\n'),
        attachments: [{ kind: 'game-project', id: 'g-1', title: 'Make an original game in the spirit of Little Prince' }],
        createdAt: 1000,
      },
    ],
  };
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ExecutionTimeline
          chat={longPromptChat}
          busy={false}
          sending={false}
          engineLabel="Antigravity"
          onOpenArtifactId={onOpenArtifactId}
          onPreviewAttachment={vi.fn()}
          onCopyText={onCopyText}
          onApprove={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
  const bubble = document.querySelector('.om-sa-user-bubble-collapsible')!;
  expect(bubble.hasAttribute('data-collapsed')).toBe(true);
  expect(bubble.textContent).toContain('Show full prompt');
  expect(bubble.textContent).toContain('12 lines');

  await act(async () => {
    bubble.querySelector<HTMLButtonElement>('.om-sa-user-bubble-toggle')!.click();
  });
  await flush();
  expect(bubble.hasAttribute('data-expanded')).toBe(true);
  expect(bubble.querySelector('.om-sa-user-collapse-pill')?.textContent).toContain('Collapse');

  await act(async () => {
    bubble.querySelector<HTMLButtonElement>('.om-sa-user-collapse-pill')!.click();
  });
  await flush();
  expect(bubble.hasAttribute('data-collapsed')).toBe(true);

  // Direct SimpleMarkdown strikethrough + hr + bare link rendering
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SimpleMarkdown content={'~~old~~\n\n---\n\nVisit https://openmotion.example.com'} onCopyCode={onCopyText} />
      </I18nProvider>,
    );
  });
  await flush();
  expect(document.querySelector('.om-sa-md-del')?.textContent).toBe('old');
  expect(document.querySelector('.om-sa-md-hr')).toBeTruthy();
  expect(document.querySelector<HTMLAnchorElement>('.om-sa-link')?.href).toBe('https://openmotion.example.com/');
});

it('enters pure Coding mode from Explore more and renders sidebar/header intent icons', async () => {
  const createdId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  let capturedTurnBody: Record<string, any> | null = null;

  const chatsList: SuperAgentChatSummary[] = [
    {
      id: CHAT_ID,
      title: 'Fix parser bug',
      intent: 'coding',
      engine: 'codex',
      state: 'running',
      artifactCount: 0,
      messageCount: 1,
      updatedAt: 4000,
      createdAt: 1000,
    },
    {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      title: 'Landing Prototype',
      intent: 'website',
      engine: 'codex',
      state: 'idle',
      artifactCount: 1,
      messageCount: 2,
      updatedAt: 3000,
      createdAt: 1000,
    },
    {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      title: 'Promo Reel',
      intent: 'video',
      engine: 'codex',
      state: 'failed',
      artifactCount: 0,
      messageCount: 2,
      updatedAt: 2000,
      createdAt: 1000,
    },
    {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      title: 'Explain OAuth tokens',
      intent: 'chat',
      pinned: true,
      engine: 'codex',
      state: 'idle',
      artifactCount: 0,
      messageCount: 2,
      updatedAt: 1000,
      createdAt: 1000,
    },
  ];

  const codingChat: SuperAgentChat = {
    ...sampleChat,
    id: CHAT_ID,
    title: 'Fix parser bug',
    intent: 'coding',
    state: 'running',
    artifacts: [],
  };

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.startsWith('/motion-api/settings/agents')) {
      return json({
        agents: [{ id: 'codex', label: 'Codex', icon: 'codex', installed: true, auth: 'signed-in', models: [{ id: 'gpt-5', label: 'GPT-5' }] }],
      });
    }
    if (url.startsWith(`${SUPER_AGENT_API}/resources`)) return json(sampleResources);
    if (url === `${SUPER_AGENT_API}/chats` && (!init?.method || init.method === 'GET')) {
      return json({ conversations: chatsList });
    }
    if (url === `${SUPER_AGENT_API}/chats` && init?.method === 'POST') {
      return json({ conversation: { ...codingChat, id: createdId, state: 'idle', title: 'New conversation', messages: [] } });
    }
    if (url === `${SUPER_AGENT_API}/chats/${createdId}/turn` && init?.method === 'POST') {
      capturedTurnBody = init.body ? JSON.parse(String(init.body)) : null;
      return json({
        conversation: {
          ...codingChat,
          id: createdId,
          title: 'Inspect package.json',
          intent: 'coding',
          workingDir: capturedTurnBody?.workingDir,
          messages: [{ id: 'u-1', role: 'user', text: capturedTurnBody?.text, createdAt: Date.now() }],
        },
      });
    }
    if (url === `${SUPER_AGENT_API}/chats/${CHAT_ID}`) {
      return json({ conversation: codingChat });
    }
    return json({});
  }) as any;

  // Verify the Coding entry, pure coding workspace, and submit payload.
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

  // Sidebar rows keep their intent icons and place status indicators according to the task state.
  expect(document.querySelector('.om-sa-chat-icon[data-intent="coding"][data-tone="coding"]')).toBeTruthy();
  expect(document.querySelector('.om-sa-chat-status[data-state="running"] svg')).toBeTruthy();
  expect(document.querySelector('.om-sa-chat-status[data-state="running"] .om-sa-chat-dot')).toBeNull();
  expect(document.querySelector('.om-sa-chat-icon[data-intent="website"][data-tone="agent"]')).toBeTruthy();
  expect(document.querySelector('.om-sa-chat-status[data-state="completed"] .om-sa-chat-dot')).toBeTruthy();
  expect(document.querySelector('.om-sa-chat-icon[data-intent="video"][data-tone="video"]')).toBeTruthy();
  expect(document.querySelector('.om-sa-chat-status-badge[data-state="failed"]')?.textContent).toBe('Stopped');
  expect(document.querySelector('.om-sa-chat-icon[data-intent="chat"][data-tone="neutral"]')).toBeTruthy();

  const more = container.querySelector<HTMLButtonElement>('.om-sa-starter-card-more')!;
  await act(async () => more.click());
  const items = [...document.querySelectorAll<HTMLButtonElement>('.om-sa-more-menu .om-sa-more-item')];
  expect(items.map(item => item.textContent)).toEqual(['Cinema Video', 'Coding', 'Build a website']);
  await act(async () => items[1].click());
  await flush();

  expect(document.body.textContent).toContain('Code, debug & ship');
  expect(document.querySelector('.om-sa-showcase-panel')).toBeNull();
  expect(document.body.textContent).toContain('Workspace folder');
  expect(document.body.textContent).toContain('General coding');
  expect(document.querySelector('.om-sa-stream-title-icon[data-tone="coding"]')).toBeTruthy();

  // Set working folder via popover
  const folderBtn = [...document.querySelectorAll('.om-sa-composer-top-pill')].find(
    el => el.textContent?.includes('Workspace folder'),
  ) as HTMLButtonElement;
  await act(async () => folderBtn.click());
  await flush();
  const folderInput = document.querySelector<HTMLInputElement>('.om-sa-mode-url-input')!;
  await act(async () => {
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    proto.call(folderInput, '/tmp/my-repo');
    folderInput.dispatchEvent(new Event('input', { bubbles: true }));
    folderInput.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const applyBtn = [...document.querySelectorAll('.om-sa-popover-pill')].find(
    el => el.textContent === 'Apply',
  ) as HTMLButtonElement;
  await act(async () => applyBtn.click());
  await flush();

  // Submit prompt and verify clean coding turn payload (no [Mode: ...] noise)
  const textarea = document.querySelector<HTMLTextAreaElement>('.om-sa-composer textarea')!;
  await act(async () => {
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    proto.call(textarea, 'Inspect package.json');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
  const sendBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  await act(async () => sendBtn.click());
  await flush();

  expect(capturedTurnBody).toBeTruthy();
  expect(capturedTurnBody?.mode).toBe('coding');
  expect(capturedTurnBody?.workingDir).toBe('/tmp/my-repo');
  expect(capturedTurnBody?.text).toBe('Inspect package.json');

  // 2. Active coding chat renders coding intent icon in header
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
  expect(document.querySelector('.om-sa-stream-title-icon[data-tone="coding"]')).toBeTruthy();
});

it('auto-sends queued game handoffs from Game Studio, renders gamepad-line icon, and views/codes game artifacts', async () => {
  const GAME_CHAT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const GAME_ID = 'game-star-99';
  let createBody: any = null;
  let turnBody: any = null;
  const onOpenGameStudio = vi.fn();

  const gameChat: SuperAgentChat = {
    id: GAME_CHAT_ID,
    title: 'Neon wave dodger',
    intent: 'game',
    engine: 'codex',
    model: 'gpt-5',
    permissionMode: 'on-request',
    createdAt: 1000,
    updatedAt: 2000,
    state: 'idle',
    messages: [
      { id: 'm1', role: 'user', text: 'Build Neon wave dodger', createdAt: 1001 },
      { id: 'm2', role: 'assistant', text: 'Ready to play in the Artifact Viewer.', createdAt: 1002 },
    ],
    artifacts: [
      {
        id: `game:${GAME_ID}`,
        kind: 'game-project',
        title: 'Star Dodge',
        subtitle: 'shooter · Game Studio',
        projectId: GAME_ID,
        scenario: 'portrait',
        revision: 'rev-game-1',
        url: `/motion-api/games/${GAME_ID}/play/index.html`,
        createdAt: 1002,
        updatedAt: 1002,
      },
    ],
    activeArtifactId: `game:${GAME_ID}`,
    approvals: [],
  };

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.startsWith('/motion-api/settings/agents')) {
      return json({
        agents: [{ id: 'codex', label: 'Codex', icon: 'codex', installed: true, auth: 'signed-in', models: [{ id: 'gpt-5', label: 'GPT-5' }] }],
      });
    }
    if (url.startsWith('/motion-api/agent-runtimes')) {
      return json({
        localDirectAvailable: true,
        runtimes: [
          {
            id: 'local-direct',
            kind: 'local-direct',
            name: 'This computer',
            status: 'online',
            agents: [
              { id: 'codex', label: 'Codex', icon: 'codex', installed: true, auth: 'signed-in', models: [{ id: 'gpt-5', label: 'GPT-5' }] },
            ],
            runnableAgentIds: ['codex'],
          },
        ],
      });
    }
    if (url.startsWith(`${SUPER_AGENT_API}/resources`)) return json(sampleResources);
    if (url === `${SUPER_AGENT_API}/chats` && (!init?.method || init.method === 'GET')) {
      return json({
        conversations: [
          {
            id: GAME_CHAT_ID,
            title: 'Star Dodge',
            intent: 'game',
            engine: 'codex',
            state: 'idle',
            artifactCount: 1,
            messageCount: 2,
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
      });
    }
    if (url === `${SUPER_AGENT_API}/chats` && init?.method === 'POST') {
      createBody = init.body ? JSON.parse(String(init.body)) : {};
      return json({
        conversation: { ...gameChat, messages: [], artifacts: [], activeArtifactId: undefined },
      });
    }
    if (url === `${SUPER_AGENT_API}/chats/${GAME_CHAT_ID}/turn` && init?.method === 'POST') {
      turnBody = init.body ? JSON.parse(String(init.body)) : {};
      return json({ conversation: gameChat });
    }
    if (url === `${SUPER_AGENT_API}/chats/${GAME_CHAT_ID}`) {
      return json({ conversation: gameChat });
    }
    if (url === `/motion-api/games/${GAME_ID}/files`) {
      return json({
        files: [
          { path: 'vendor/three-helper.js', bytes: 128 },
          { path: 'design/plan.md', bytes: 48 },
          { path: 'logic.js', bytes: 32 },
          { path: 'index.html', bytes: 64 },
        ],
      });
    }
    if (url.startsWith(`/motion-api/games/${GAME_ID}/play/index.html`)) {
      return new Response('<!doctype html><canvas id="dodge"></canvas>', { status: 200 });
    }
    if (url.startsWith(`/motion-api/games/${GAME_ID}/play/logic.js`)) {
      return new Response('console.log("star dodge");', { status: 200 });
    }
    return json({});
  }) as any;

  queueSuperAgentHandoff(buildSuperAgentHandoff(
    {
      kind: 'game-project',
      id: GAME_ID,
      title: 'Neon wave dodger',
      subtitle: 'shooter · Single player',
      genre: 'shooter',
    },
    {
      prompt: 'Brief: Neon wave dodger',
      autoSend: true,
      newChat: true,
    },
  ));

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={null}
          onChatIdChange={vi.fn()}
          onOpenDesignProject={vi.fn()}
          onOpenMotionProject={vi.fn()}
          onOpenGameStudio={onOpenGameStudio}
          onOpenAsset={vi.fn()}
          onOpenBrandKit={vi.fn()}
          onOpenAgentSettings={vi.fn()}
          onOpenMcp={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
  await flush();

  // Auto-dispatched queued game handoff with game intent & attachment
  expect(createBody?.intent).toBe('game');
  expect(turnBody?.mode).toBe('game');
  expect(turnBody?.attachments?.[0]?.id).toBe(GAME_ID);

  // Sidebar & header display recognizable gamepad-line icon
  const sidebarIconSvg = document.querySelector('.om-sa-chat-icon[data-intent="game"] svg');
  expect(sidebarIconSvg?.getAttribute('data-remix-icon')).toBe('gamepad-line');
  const headerIconSvg = document.querySelector('.om-sa-stream-title-icon svg');
  expect(headerIconSvg?.getAttribute('data-remix-icon')).toBe('gamepad-line');

  // Viewer opens game iframe in portrait viewport & supports Code inspection + Open in Game Studio
  const viewer = document.querySelector('.om-sa-viewer')!;
  expect(viewer).toBeTruthy();
  // Share belongs in the active tab toolbar (emphasized), never in the outer browser window tab strip
  expect(viewer.querySelector('.om-sa-viewer-tabs-bar .om-web-publish-trigger')).toBeNull();
  const toolbarShareBtn = viewer.querySelector('.om-sa-viewer-toolbar .om-sa-share-trigger');
  expect(toolbarShareBtn).toBeTruthy();
  expect(toolbarShareBtn?.textContent?.trim()).toBe('Share');
  // User's own game does not clutter the toolbar with an Attach to Chat button
  expect(viewer.querySelector('.om-sa-viewer-toolbar .om-sa-game-use-btn')).toBeNull();
  // Non-web game tab omits disabled Back/Forward browser history arrows
  expect(viewer.querySelector('.om-sa-nav-btns button[aria-label="Back"]')).toBeNull();
  expect(viewer.querySelector('.om-sa-nav-btns button[aria-label="Forward"]')).toBeNull();
  expect(viewer.querySelector('.om-sa-nav-btns button[aria-label="Reload"]')).toBeTruthy();
  const stage = viewer.querySelector('.om-sa-iframe-stage');
  expect(stage?.getAttribute('data-viewport')).toBe('mobile');
  const iframe = viewer.querySelector('iframe');
  expect(iframe?.getAttribute('src')).toContain(`/motion-api/games/${GAME_ID}/play/index.html`);

  // Responsive viewport dropdown switches Game preview viewports without adding a secondary bar
  const deviceBtn = viewer.querySelector('button[aria-label="Viewport presets"]') as HTMLButtonElement;
  expect(deviceBtn).toBeTruthy();
  await act(async () => deviceBtn.click());
  await flush();
  expect(viewer.querySelector('.om-sa-device-bar')).toBeNull();
  const deviceMenu = document.querySelector('.om-sa-device-menu');
  expect(deviceMenu).toBeTruthy();
  const desktopPresetBtn = [...deviceMenu!.querySelectorAll('button')].find(b => b.textContent?.includes('Desktop')) as HTMLButtonElement;
  expect(desktopPresetBtn).toBeTruthy();
  await act(async () => desktopPresetBtn.click());
  await flush();
  expect(stage?.getAttribute('data-viewport')).toBe('desktop');
  expect(document.querySelector('.om-sa-device-menu')).toBeNull();

  const viewModeBtn = viewer.querySelector('.om-sa-view-mode-trigger') as HTMLButtonElement;
  expect(viewModeBtn).toBeTruthy();
  await act(async () => viewModeBtn.click());
  await flush();
  const codeBtn = [...document.querySelectorAll('.om-sa-view-mode-popover button')].find(b => b.textContent?.trim() === 'Code') as HTMLButtonElement;
  expect(codeBtn).toBeTruthy();
  await act(async () => codeBtn.click());
  await vi.waitFor(async () => {
    await flush();
    expect(viewer.textContent).toContain('<canvas id="dodge"></canvas>');
  }, { timeout: 5000 });
  expect(viewer.textContent).toContain('index.html');
  expect(viewer.querySelector('.om-sa-code-sidebar')).toBeTruthy();
  expect(viewer.querySelector('button[aria-label="Copy"]')).toBeTruthy();
  // vendor/ folder is collapsed by default while design/ is expanded
  const folders = [...viewer.querySelectorAll('details.om-sa-code-folder')] as HTMLDetailsElement[];
  const designFolder = folders.find(el => el.textContent?.includes('design'));
  const vendorFolder = folders.find(el => el.textContent?.includes('vendor'));
  expect(designFolder?.hasAttribute('open')).toBe(true);
  expect(vendorFolder?.hasAttribute('open')).toBe(false);

  const menuBtn = viewer.querySelector('button[aria-label="Browser options"]') as HTMLButtonElement;
  expect(menuBtn).toBeTruthy();
  await act(async () => menuBtn.click());
  await flush();
  const openStudioBtn = [...document.querySelectorAll('.om-sa-browser-menu button')].find(b => b.textContent?.includes('Open in Game Studio')) as HTMLButtonElement;
  expect(openStudioBtn).toBeTruthy();
  await act(async () => openStudioBtn.click());
  expect(onOpenGameStudio).toHaveBeenCalledWith(GAME_ID);
});

it('supports web preview device toolbar, browser options menu, and visual element annotation into composer', async () => {
  const WEB_CHAT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const webChat: SuperAgentChat = {
    id: WEB_CHAT_ID,
    title: 'Local Vite Preview',
    engine: 'codex',
    model: 'gpt-5',
    intent: 'coding',
    permissionMode: 'auto',
    createdAt: 1000,
    updatedAt: 2000,
    state: 'idle',
    messages: [],
    artifacts: [
      {
        id: 'web-local-1',
        kind: 'web',
        title: 'localhost:5173',
        subtitle: 'Local dev server',
        url: 'http://localhost:5173/',
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
    activeArtifactId: 'web-local-1',
    approvals: [],
  };

  let lastTurnBody: any = null;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/settings/agents')) {
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
    if (url.includes('/settings/runtimes')) return json({ runtimes: [] });
    if (url.includes(`${SUPER_AGENT_API}/resources`)) return json(sampleResources);
    if (url === `${SUPER_AGENT_API}/chats`) return json({ conversations: [{ ...webChat }] });
    if (url === `${SUPER_AGENT_API}/chats/${WEB_CHAT_ID}`) return json({ conversation: webChat });
    if (url === `${SUPER_AGENT_API}/chats/${WEB_CHAT_ID}/annotations` && init?.method === 'POST') {
      return json({
        id: 'shot-1',
        screenshotUrl: `/motion-api/super-agent/chats/${WEB_CHAT_ID}/annotations/shot-1.png`,
        screenshotPath: '/tmp/shot-1.png',
      });
    }
    if (url === `${SUPER_AGENT_API}/chats/${WEB_CHAT_ID}/turn` && init?.method === 'POST') {
      lastTurnBody = init.body ? JSON.parse(String(init.body)) : null;
      return json({ conversation: webChat });
    }
    return json({});
  }) as any;

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={WEB_CHAT_ID}
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
  await flush();

  const viewerToggle = [...document.querySelectorAll('button')].find(
    b => b.getAttribute('aria-label') === 'Artifact Viewer',
  ) as HTMLButtonElement;
  expect(viewerToggle).toBeTruthy();
  await act(async () => viewerToggle.click());
  for (let i = 0; i < 30 && !document.querySelector('.om-sa-viewer'); i++) {
    await flush();
  }

  const viewer = document.querySelector('.om-sa-viewer')!;
  expect(viewer).toBeTruthy();
  for (let i = 0; i < 20 && !viewer.querySelector('[data-testid="mock-web-browser"]'); i++) {
    await flush();
  }
  expect(viewer.querySelector('[data-testid="mock-web-browser"]')).toBeTruthy();

  // Live WebBrowser title updates the tab title and Web tabs avoid duplicating External Link in toolbar
  expect(viewer.querySelector('.om-sa-viewer-tab-btn')?.textContent).toContain('Local App');
  expect(viewer.querySelector('.om-sa-context-actions a[aria-label="Open in external browser"]')).toBeNull();

  // Open Viewport presets dropdown and switch to Mobile preset
  const deviceBtn = viewer.querySelector('button[aria-label="Viewport presets"]') as HTMLButtonElement;
  expect(deviceBtn).toBeTruthy();
  await act(async () => deviceBtn.click());
  await flush();
  expect(viewer.querySelector('.om-sa-device-bar')).toBeNull();
  const mobilePreset = [...document.querySelectorAll('.om-sa-device-menu-item')].find(b => b.textContent?.includes('Mobile')) as HTMLButtonElement;
  expect(mobilePreset).toBeTruthy();
  await act(async () => mobilePreset.click());
  await flush();
  expect(viewer.querySelector('.om-sa-web-stage-main')?.getAttribute('data-framed')).toBe('true');
  // Re-open dropdown to verify active mobile dimensions and Rotate viewport option
  await act(async () => deviceBtn.click());
  await flush();
  expect(document.querySelector('.om-sa-device-menu')?.textContent).toContain('390 × 844');
  expect(document.querySelector('.om-sa-device-menu')?.textContent).toContain('Rotate viewport');
  await act(async () => deviceBtn.click());
  await flush();

  // Open Browser options menu and inspect items (including Open in new window)
  const menuBtn = viewer.querySelector('button[aria-label="Browser options"]') as HTMLButtonElement;
  expect(menuBtn).toBeTruthy();
  await act(async () => menuBtn.click());
  await flush();
  const menu = document.querySelector('.om-sa-browser-menu')!;
  expect(menu).toBeTruthy();
  expect(menu.parentElement?.matches('[data-menu-panel].motion-positioned-menu')).toBe(true);
  expect(menu.matches('[data-menu-panel]')).toBe(false);
  expect(menu.textContent).toContain('Hard reload');
  expect(menu.textContent).toContain('Appearance');
  expect(menu.textContent).toContain('Clear cookies');
  expect(menu.textContent).toContain('Clear cache');
  expect(menu.textContent).toContain('Open external');
  await act(async () => menuBtn.click());
  await flush();

  // Activate annotation overlay
  const annotBtn = viewer.querySelector('button[aria-label="Annotate elements, regions, and drawings"]') as HTMLButtonElement;
  expect(annotBtn).toBeTruthy();
  await act(async () => annotBtn.click());
  await flush();

  const overlay = viewer.querySelector('.om-sa-annot-layer')!;
  expect(overlay).toBeTruthy();
  expect(overlay.textContent).toContain('Select');
  expect(overlay.textContent).toContain('Region');
  expect(overlay.textContent).toContain('Draw');
  expect(overlay.textContent).toContain('Erase');

  // Mock layout geometry for element picking on the overlay
  const img = viewer.querySelector('[data-testid="mock-web-browser"] img') as HTMLElement;
  const layerEl = overlay as HTMLElement;
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  layerEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });

  const backdrop = overlay.querySelector('.om-sa-annot-backdrop') as HTMLElement;
  await act(async () => {
    backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 60, clientY: 60 }));
    backdrop.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 60, clientY: 60 }));
  });
  await flush();
  await flush();

  const noteInput = viewer.querySelector('.om-sa-annot-input') as HTMLInputElement;
  expect(noteInput).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(noteInput, 'Make button rounded');
    noteInput.dispatchEvent(new Event('input', { bubbles: true }));
    noteInput.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const attachBtn = viewer.querySelector('.om-sa-annot-attach-btn') as HTMLButtonElement;
  expect(attachBtn).toBeTruthy();
  await act(async () => attachBtn.click());
  await flush();
  await flush();

  // Verify annotation chip attached in composer, click opens preview Popover, and send button enabled without textarea text
  const chip = document.querySelector('.om-sa-composer-chips .om-sa-attachment-chip[data-kind="browser-annotation"]');
  expect(chip).toBeTruthy();
  expect(chip?.textContent).toContain('Make button rounded');

  const chipTrigger = chip!.querySelector('.om-sa-chip-main') as HTMLButtonElement;
  expect(chipTrigger).toBeTruthy();
  await act(async () => chipTrigger.click());
  await flush();
  const previewPopover = document.querySelector('.om-sa-annot-preview-popover');
  expect(previewPopover).toBeTruthy();
  expect(previewPopover?.querySelector('img.om-sa-annot-preview-img')).toBeTruthy();
  expect(previewPopover?.textContent).toContain('#hero-btn');
  const previewJumpBtn = [...previewPopover!.querySelectorAll('button')].find(b => b.textContent?.includes('Preview')) as HTMLButtonElement;
  expect(previewJumpBtn).toBeTruthy();
  await act(async () => previewJumpBtn.click());
  await flush();
  expect(document.querySelector('.om-sa-annot-preview-popover')).toBeNull();
  expect(document.querySelector('.om-sa-composer-chips .om-sa-attachment-chip[data-kind="browser-annotation"]')).toBeTruthy();

  const sendBtn = document.querySelector('.om-sa-send-btn') as HTMLButtonElement;
  expect(sendBtn).toBeTruthy();
  expect(sendBtn.disabled).toBe(false);
  await act(async () => sendBtn.click());
  await flush();
  await flush();

  expect(lastTurnBody).toBeTruthy();
  expect(lastTurnBody.attachments?.[0]?.kind).toBe('browser-annotation');
  expect(lastTurnBody.attachments?.[0]?.annotation?.element?.selector).toBe('#hero-btn');
  expect(lastTurnBody.attachments?.[0]?.annotation?.comment).toBe('Make button rounded');
});

it('switches Super Agent Game mode into Game Studio UI, supports style/orientation/multiplayer pickers, and scaffolds playable game chats', async () => {
  const GAME_CHAT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const CREATED_GAME_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  let createGameBody: any = null;
  let createChatBody: any = null;
  let turnBody: any = null;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const createdChat: SuperAgentChat = {
    id: GAME_CHAT_ID,
    title: 'Neon Arena',
    engine: 'codex',
    model: 'gpt-5',
    intent: 'game',
    permissionMode: 'auto',
    createdAt: 1000,
    updatedAt: 2000,
    state: 'running',
    messages: [],
    artifacts: [],
    approvals: [],
  };

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/settings/agents')) {
      return json({
        agents: [
          {
            id: 'codex',
            label: 'Codex',
            icon: 'codex',
            installed: true,
            auth: 'signed-in',
            models: [{ id: 'gpt-5', label: 'GPT-5', reasoning: ['medium'] }],
          },
        ],
      });
    }
    if (url.includes('/motion-api/agent-runtimes')) {
      return json({
        runtimes: [
          {
            id: 'local-direct',
            kind: 'local-direct',
            name: 'This computer',
            status: 'online',
            agents: [{ id: 'codex', label: 'Codex', icon: 'codex', installed: true, auth: 'signed-in', models: [] }],
            runnableAgentIds: ['codex'],
          },
        ],
      });
    }
    if (url.includes(`${SUPER_AGENT_API}/resources`)) {
      return json({ counts: { assets: 0, brandKits: 0, motionTemplates: 0, designTemplates: 0, skills: 0, designSkills: 0, motionProjects: 0, designProjects: 0, gameProjects: 0 }, items: [] });
    }
    if (url === `${SUPER_AGENT_API}/chats` && method === 'GET') return json({ conversations: [] });
    if (url === `${SUPER_AGENT_API}/chats` && method === 'POST') {
      createChatBody = JSON.parse(String(init?.body ?? '{}'));
      return json({ conversation: createdChat });
    }
    if (url === `${SUPER_AGENT_API}/chats/${GAME_CHAT_ID}/turn` && method === 'POST') {
      turnBody = JSON.parse(String(init?.body ?? '{}'));
      return json({ conversation: { ...createdChat, state: 'running' } });
    }
    if (url === `${SUPER_AGENT_API}/chats/${GAME_CHAT_ID}`) return json({ conversation: createdChat });
    if (url.endsWith('/motion-api/games') && method === 'GET') return json({ games: [] });
    if (url.endsWith('/motion-api/games') && method === 'POST') {
      createGameBody = JSON.parse(String(init?.body ?? '{}'));
      return json({
        game: {
          id: CREATED_GAME_ID,
          title: 'Neon Co-op',
          description: createGameBody.prompt,
          genre: createGameBody.genre ?? 'shooter',
          style: createGameBody.style ?? null,
          setting: createGameBody.setting ?? null,
          multiplayer: Boolean(createGameBody.multiplayer),
          maxPlayers: createGameBody.multiplayer ? 4 : 1,
          orientation: createGameBody.orientation ?? 'landscape',
          status: 'draft',
          cover: null,
          playUrl: `/api/games/${CREATED_GAME_ID}/play/index.html`,
          plays: 0,
          likes: 0,
          dislikes: 0,
          reaction: 0,
          favorite: false,
          source: 'mine',
          remixOf: null,
          controls: '',
          createdAt: '2026-11-22T00:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        },
        agentInstruction: 'Use openmotion_game_* tools to build Neon Co-op.',
      });
    }
    return json({});
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const flush = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

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
            onOpenGameStudio={vi.fn()}
            onOpenAsset={vi.fn()}
            onOpenBrandKit={vi.fn()}
            onOpenAgentSettings={vi.fn()}
            onOpenMcp={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    // Enter Game Studio mode inside Super Agent
    const gameStarter = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Build a game'))!;
    expect(gameStarter).toBeTruthy();
    await act(async () => gameStarter.click());
    await flush();

    // Verifies Game Studio hero, 6 genre strip buttons, top controls, and game market template cards
    expect(container.textContent).toContain('Create your own game in minutes');
    expect(container.querySelectorAll('.om-sa-game-genre-card').length).toBe(6);
    expect(container.querySelectorAll('.om-sa-game-showcase-card').length).toBeGreaterThan(0);

    const topBar = container.querySelector('.om-sa-composer-top-bar')!;
    expect(topBar).toBeTruthy();
    expect(topBar.textContent).toContain('Shooter');
    expect(topBar.textContent).toContain('Style');
    expect(topBar.textContent).toContain('Setting');
    expect(topBar.textContent).toContain('Landscape');
    expect(topBar.textContent).toContain('Single player');

    // Open Style popover and pick Pixel art
    const styleTrigger = [...topBar.querySelectorAll('button')].find(b => b.textContent?.includes('Style')) as HTMLButtonElement;
    await act(async () => styleTrigger.click());
    await flush();
    const pixelOption = [...document.querySelectorAll('.om-sa-game-art-option')].find(b => b.textContent?.includes('Pixel art')) as HTMLButtonElement;
    expect(pixelOption).toBeTruthy();
    await act(async () => pixelOption.click());
    await flush();

    // Open Orientation dropdown and select Portrait (9:16)
    const orientationTrigger = [...topBar.querySelectorAll('button')].find(b => b.textContent?.includes('Landscape')) as HTMLButtonElement;
    expect(orientationTrigger.getAttribute('aria-haspopup')).toBe('listbox');
    await act(async () => orientationTrigger.click());
    await flush();
    const portraitOption = [...document.querySelectorAll('.om-sa-game-choice-row')].find(b => b.textContent?.includes('Portrait')) as HTMLButtonElement;
    expect(portraitOption).toBeTruthy();
    expect(portraitOption.textContent).toContain('9:16');
    await act(async () => portraitOption.click());
    await flush();
    expect(topBar.textContent).toContain('Portrait');
    // Portrait defaults to a playable ad, like Game Studio.
    expect(topBar.textContent).toContain('Playable ad');

    // Open Players dropdown: portrait offers Single player, Multiplayer and Playable ad; select Multiplayer
    const playersTrigger = [...topBar.querySelectorAll('button')].find(b => b.textContent?.includes('Playable ad')) as HTMLButtonElement;
    expect(playersTrigger.getAttribute('aria-haspopup')).toBe('listbox');
    await act(async () => playersTrigger.click());
    await flush();
    const playerRows = [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Players"] .om-sa-game-choice-row')];
    expect(playerRows.map(row => row.querySelector('strong')?.textContent)).toEqual(['Single player', 'Multiplayer', 'Playable ad']);
    expect(playerRows.find(row => row.textContent?.includes('Playable ad'))?.getAttribute('aria-selected')).toBe('true');
    const multiplayerOption = playerRows.find(row => row.querySelector('strong')?.textContent === 'Multiplayer')!;
    expect(multiplayerOption).toBeTruthy();
    await act(async () => multiplayerOption.click());
    await flush();
    expect(topBar.textContent).toContain('Multiplayer');

    // Switching back to portrait selects Playable ad again; then pick Multiplayer for the send below.
    const pickRow = async (pill: string, row: string) => {
      const trigger = [...topBar.querySelectorAll('button')].find(b => b.textContent?.includes(pill)) as HTMLButtonElement;
      await act(async () => trigger.click()); await flush();
      const option = [...document.querySelectorAll('.om-sa-game-choice-row')].find(b => b.querySelector('strong')?.textContent === row) as HTMLButtonElement;
      await act(async () => option.click()); await flush();
    };
    await pickRow('Portrait', 'Landscape');
    await pickRow('Landscape', 'Portrait');
    expect(topBar.textContent).toContain('Playable ad');
    await pickRow('Playable ad', 'Multiplayer');
    expect(topBar.textContent).toContain('Multiplayer');

    // Send brief -> creates Game Studio project and starts Super Agent game turn
    const textarea = container.querySelector('.om-sa-composer textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'Co-op pixel shooter in space');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendBtn = container.querySelector('.om-sa-send-btn') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    await act(async () => sendBtn.click());
    await flush();

    expect(createGameBody).toEqual({
      prompt: 'Co-op pixel shooter in space',
      genre: 'shooter',
      style: 'pixel',
      setting: null,
      multiplayer: true,
      orientation: 'portrait',
      playableAd: false,
    });
    expect(createChatBody?.intent).toBe('game');
    expect(turnBody?.mode).toBe('game');
    expect(turnBody?.attachments?.some((att: any) => att.kind === 'game-project' && att.id === CREATED_GAME_ID)).toBe(true);
    expect(turnBody?.text).toBe('Co-op pixel shooter in space');
    expect(turnBody?.hiddenInstructions).toContain('openmotion_present_artifact');
    expect(turnBody?.contextTags?.map((tag: any) => tag.label)).toEqual([
      'Game',
      'Shooter',
      'Pixel art',
      '9:16',
      'Multiplayer',
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('supports unified Phase 2 Game preview console drawer ("Fix with Agent"), element picking, and Draw strokes', async () => {
  const GAME_CHAT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const GAME_ID = '11111111-1111-1111-1111-111111111111';
  const gameChat: SuperAgentChat = {
    id: GAME_CHAT_ID,
    title: 'Orbit Defender',
    engine: 'codex',
    model: 'gpt-5',
    intent: 'game',
    permissionMode: 'auto',
    createdAt: 1000,
    updatedAt: 2000,
    state: 'idle',
    messages: [],
    artifacts: [
      {
        id: `game:${GAME_ID}`,
        kind: 'game-project',
        title: 'Orbit Defender',
        subtitle: 'shooter · Game Studio',
        projectId: GAME_ID,
        scenario: 'landscape',
        revision: '1',
        url: `/motion-api/games/${GAME_ID}/play/index.html`,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
    activeArtifactId: `game:${GAME_ID}`,
    approvals: [],
  };

  const turns: any[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/settings/agents')) {
      return json({
        agents: [
          {
            id: 'codex',
            label: 'Codex',
            icon: 'codex',
            installed: true,
            auth: 'signed-in',
            models: [{ id: 'gpt-5', label: 'GPT-5', reasoning: ['medium'] }],
          },
        ],
      });
    }
    if (url.includes('/settings/runtimes')) return json({ runtimes: [] });
    if (url.includes(`${SUPER_AGENT_API}/resources`)) return json(sampleResources);
    if (url === `${SUPER_AGENT_API}/chats`) return json({ conversations: [{ ...gameChat }] });
    if (url === `${SUPER_AGENT_API}/chats/${GAME_CHAT_ID}`) return json({ conversation: gameChat });
    if (url === `${SUPER_AGENT_API}/chats/${GAME_CHAT_ID}/annotations` && init?.method === 'POST') {
      return json({
        id: 'game-shot-1',
        screenshotUrl: `/motion-api/super-agent/chats/${GAME_CHAT_ID}/annotations/game-shot-1.png`,
        screenshotPath: '/tmp/game-shot-1.png',
      });
    }
    if (url === `${SUPER_AGENT_API}/chats/${GAME_CHAT_ID}/preview-snapshot` && init?.method === 'POST') {
      return json({
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        pageUrl: `/motion-api/games/${GAME_ID}/play/index.html`,
      });
    }
    if (url === `${SUPER_AGENT_API}/chats/${GAME_CHAT_ID}/turn` && init?.method === 'POST') {
      turns.push(init.body ? JSON.parse(String(init.body)) : null);
      return json({ conversation: gameChat });
    }
    return json({});
  }) as any;

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={GAME_CHAT_ID}
          onChatIdChange={vi.fn()}
          onOpenDesignProject={vi.fn()}
          onOpenMotionProject={vi.fn()}
          onOpenGameStudio={vi.fn()}
          onOpenAsset={vi.fn()}
          onOpenBrandKit={vi.fn()}
          onOpenAgentSettings={vi.fn()}
          onOpenMcp={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();

  const viewerToggle = [...document.querySelectorAll('button')].find(
    b => b.getAttribute('aria-label') === 'Artifact Viewer',
  ) as HTMLButtonElement;
  await act(async () => viewerToggle.click());
  for (let i = 0; i < 30 && !document.querySelector('.om-sa-viewer iframe'); i++) {
    await flush();
  }

  const viewer = document.querySelector('.om-sa-viewer')!;
  const iframe = viewer.querySelector('iframe') as HTMLIFrameElement;
  expect(iframe).toBeTruthy();
  const bridgeToken = new URL(iframe.getAttribute('src')!, 'http://localhost').searchParams.get('omBridge')!;
  expect(bridgeToken).toBeTruthy();

  // Dispatch runtime error & warning from sandboxed game bridge
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'om:preview-console', token: bridgeToken, level: 'error', text: 'ReferenceError: boss is undefined', timestamp: 1 },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'om:preview-console', token: bridgeToken, level: 'warn', text: 'Low FPS warning', timestamp: 2 },
    }));
  });
  await flush();

  expect(viewer.querySelector('.om-sa-console-toolbar-badge')?.textContent).toBe('1');
  const consoleBtn = viewer.querySelector('button[aria-label="Open console"]') as HTMLButtonElement;
  await act(async () => consoleBtn.click());
  await flush();

  const drawer = viewer.querySelector('.om-sa-console-drawer')!;
  expect(drawer.textContent).toContain('ReferenceError: boss is undefined');
  const errorsFilter = [...drawer.querySelectorAll('.om-sa-console-filter-btn')].find(b => b.textContent === 'Errors') as HTMLButtonElement;
  await act(async () => errorsFilter.click());
  await flush();
  expect(drawer.textContent).not.toContain('Low FPS warning');

  const fixBtn = [...drawer.querySelectorAll('button')].find(b => b.textContent?.includes('Fix with Agent')) as HTMLButtonElement;
  await act(async () => fixBtn.click());
  await flush();
  expect(turns.length).toBe(1);
  expect(turns[0].attachments?.[0]?.annotation?.mode).toBe('console');
  expect(turns[0].attachments?.[0]?.annotation?.consoleErrors?.[0]).toContain('boss is undefined');

  // Toggle Annotate -> verify Select (picked via bridge) and Draw freehand stroke
  const annotBtn = viewer.querySelector('button[aria-label="Annotate elements, regions, and drawings"]') as HTMLButtonElement;
  await act(async () => annotBtn.click());
  await flush();

  const overlay = viewer.querySelector('.om-sa-annot-layer') as HTMLElement;
  expect(overlay.textContent).toContain('Select');
  const frameEl = viewer.querySelector('.om-sa-iframe-frame') as HTMLElement;
  frameEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'om:preview-pick',
        token: bridgeToken,
        element: {
          tagName: 'canvas',
          selector: '#game-canvas',
          label: 'GameCanvas',
          htmlPreview: '<canvas id="game-canvas"></canvas>',
          styles: { display: 'block' },
          rect: { x: 10, y: 10, width: 300, height: 200 },
          viewport: { width: 800, height: 600 },
        },
        viewport: { width: 800, height: 600 },
        rect: { x: 10, y: 10, width: 300, height: 200 },
      },
    }));
  });
  await flush();
  expect(viewer.querySelector('.om-sa-annot-badge')?.textContent).toContain('#game-canvas');

  // Clear element pin, switch to Draw mode, draw a stroke, and Attach
  const clearDraftBtn = [...overlay.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Clear') as HTMLButtonElement;
  await act(async () => clearDraftBtn.click());
  const drawBtn = [...overlay.querySelectorAll('button')].find(b => b.textContent?.includes('Draw')) as HTMLButtonElement;
  await act(async () => drawBtn.click());
  await flush();

  const backdrop = overlay.querySelector('.om-sa-annot-backdrop') as HTMLElement;
  backdrop.setPointerCapture = vi.fn();

  await act(async () => {
    backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 50, clientY: 60 }));
  });
  await act(async () => {
    backdrop.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 120, clientY: 140 }));
  });
  await act(async () => {
    backdrop.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 120, clientY: 140 }));
  });
  await flush();

  const noteInput = viewer.querySelector('.om-sa-annot-input') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(noteInput, 'Add explosion glow here');
    noteInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const attachBtn = viewer.querySelector('.om-sa-annot-attach-btn') as HTMLButtonElement;
  await act(async () => attachBtn.click());
  for (let i = 0; i < 80 && !document.querySelector('.om-sa-composer-chips .om-sa-attachment-chip[data-kind="browser-annotation"]'); i++) {
    await flush();
  }

  const chip = document.querySelector('.om-sa-composer-chips .om-sa-attachment-chip[data-kind="browser-annotation"]');
  expect(chip?.textContent).toContain('Add explosion glow here');

  const sendBtn = document.querySelector('.om-sa-send-btn') as HTMLButtonElement;
  await act(async () => sendBtn.click());
  await flush();
  expect(turns.length).toBe(2);
  expect(turns[1].attachments?.[0]?.annotation?.mode).toBe('draw');
  expect(turns[1].attachments?.[0]?.annotation?.strokeCount).toBe(1);
  expect(turns[1].attachments?.[0]?.annotation?.strokeBounds).toBeTruthy();
});

it('auto-opens and re-opens the right Artifact Viewer tab whenever a game artifact is presented via presentedAt', async () => {
  const GAME_CHAT_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const GAME_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const baseChat: SuperAgentChat = {
    id: GAME_CHAT_ID,
    title: 'Celestial Star Journey',
    engine: 'codex',
    model: 'gpt-5',
    intent: 'game',
    permissionMode: 'auto',
    createdAt: 1000,
    updatedAt: 2000,
    state: 'running',
    messages: [
      { id: 'u-1', role: 'user', text: 'Build Celestial Star Journey', createdAt: 1000 },
    ],
    artifacts: [],
    approvals: [],
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/settings/agents')) {
      return json({
        agents: [{ id: 'codex', label: 'Codex', detected: true, binary: '/usr/local/bin/codex', models: [{ id: 'gpt-5', label: 'GPT-5' }] }],
        defaultAgent: 'codex',
      });
    }
    if (url.endsWith('/super-agent/resources')) return json(sampleResources);
    if (url.endsWith('/super-agent/chats')) return json({ conversations: [{ ...baseChat, messageCount: 1, artifactCount: 0 }] });
    if (url.endsWith(`/super-agent/chats/${GAME_CHAT_ID}`)) return json({ conversation: baseChat });
    if (url.includes(`/games/${GAME_ID}/files`)) return json({ files: [{ path: 'index.html', bytes: 64 }] });
    if (url.includes('/api/account')) return json({ signedIn: false });
    return json({});
  }) as any;

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={GAME_CHAT_ID}
          onChatIdChange={vi.fn()}
          onOpenDesignProject={vi.fn()}
          onOpenMotionProject={vi.fn()}
          onOpenGameStudio={vi.fn()}
          onOpenAsset={vi.fn()}
          onOpenBrandKit={vi.fn()}
          onOpenAgentSettings={vi.fn()}
          onOpenMcp={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
  await flush();

  // While building with no ready artifact, the Artifact Viewer stays closed.
  expect(document.querySelector('.om-sa-viewer')).toBeNull();

  const sse = MockEventSource.instances.at(-1)!;
  expect(sse).toBeTruthy();
  const emitChat = async (next: SuperAgentChat) => {
    const listeners = sse.listeners.get('chat') ?? [];
    await act(async () => {
      for (const fn of listeners) {
        fn({ data: JSON.stringify(next) } as MessageEvent);
      }
    });
    await flush();
  };

  // Once the game finishes and calls unified presentation (presentedAt = 5000), viewer auto-opens with the game tab.
  const presentedOnce: SuperAgentChat = {
    ...baseChat,
    state: 'idle',
    updatedAt: 5000,
    activeArtifactId: `game:${GAME_ID}`,
    artifacts: [
      {
        id: `game:${GAME_ID}`,
        kind: 'game-project',
        title: 'Celestial Star Journey',
        subtitle: 'story · Game Studio',
        projectId: GAME_ID,
        scenario: 'landscape',
        revision: 'rev-1',
        url: `/motion-api/games/${GAME_ID}/play/index.html`,
        createdAt: 5000,
        updatedAt: 5000,
        presentedAt: 5000,
      },
    ],
  };
  await emitChat(presentedOnce);

  let viewer = document.querySelector('.om-sa-viewer')!;
  expect(viewer).toBeTruthy();
  let iframe = viewer.querySelector('iframe');
  expect(iframe?.getAttribute('src')).toContain(`/motion-api/games/${GAME_ID}/play/index.html`);
  expect(iframe?.getAttribute('src')).toContain('p=5000');

  // User closes the Artifact Viewer pane manually.
  const closeBtn = viewer.querySelector('button[aria-label="Close viewer"]') as HTMLButtonElement;
  expect(closeBtn).toBeTruthy();
  await act(async () => closeBtn.click());
  await flush();
  expect(document.querySelector('.om-sa-viewer')).toBeNull();

  // Passive revision update mid-turn (presentedAt unchanged) must NOT unexpectedly reopen the closed viewer.
  await emitChat({
    ...presentedOnce,
    state: 'running',
    updatedAt: 6000,
    artifacts: [
      {
        ...presentedOnce.artifacts[0],
        revision: 'rev-2',
        updatedAt: 6000,
      },
    ],
  });
  expect(document.querySelector('.om-sa-viewer')).toBeNull();

  // Explicit presentation / turn-end completion advances presentedAt -> automatically re-opens the side pane and reloads iframe.
  await emitChat({
    ...presentedOnce,
    state: 'idle',
    updatedAt: 7000,
    artifacts: [
      {
        ...presentedOnce.artifacts[0],
        revision: 'rev-2',
        updatedAt: 7000,
        presentedAt: 7000,
      },
    ],
  });
  viewer = document.querySelector('.om-sa-viewer')!;
  expect(viewer).toBeTruthy();
  iframe = viewer.querySelector('iframe');
  expect(iframe?.getAttribute('src')).toContain('p=7000');
});

it.each([
  ['New task', '.om-sa-new-chat-btn'],
  ['the Super Agent sidebar title', 'button[aria-label="Super Agent · Back to home"]'],
])('clicking %s resets to a clean draft without creating a persisted chat until submission', async (_label, selector) => {
  const onChatIdChange = vi.fn();
  const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={CHAT_ID}
          onChatIdChange={onChatIdChange}
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

  const button = document.querySelector<HTMLButtonElement>(selector)!;
  expect(button).toBeTruthy();

  fetchSpy.mockClear();
  await act(async () => button.click());
  await flush();

  const createCalls = fetchSpy.mock.calls.filter(
    ([input, init]) => String(input) === `${SUPER_AGENT_API}/chats` && init?.method === 'POST',
  );
  expect(createCalls).toHaveLength(0);
  expect(onChatIdChange).toHaveBeenCalledWith(null);
  expect(document.body.textContent).toContain('What can I create for you?');
  expect(document.querySelector('.om-sa-viewer')).toBeNull();
});

it('renders persistent live progress dock, ticking step timers, and Continue recovery card for stopped or failed runs', async () => {
  const onContinue = vi.fn();

  // 1. Live progress dock with determinate plan progress & streaming reasoning/tool timers
  const baseChat: SuperAgentChat = {
    id: CHAT_ID,
    title: 'Build Racing Game Studio Project',
    intent: 'game',
    engine: 'antigravity',
    permissionMode: 'on-request',
    createdAt: Date.now() - 20_000,
    updatedAt: Date.now(),
    state: 'idle',
    messages: [],
    artifacts: [],
    approvals: [],
  };

  const liveChat: SuperAgentChat = {
    ...baseChat,
    state: 'running',
    updatedAt: Date.now(),
    lastTurnDurationMs: undefined,
    turnActivity: {
      phase: 'thinking',
      label: 'Antigravity',
      startedAt: Date.now() - 12_400,
      updatedAt: Date.now(),
      plan: [
        { content: 'Read workflow guide', status: 'completed' },
        { content: 'Build racing game canvas', status: 'in_progress' },
        { content: 'Verify and present', status: 'pending' },
      ],
    },
    messages: [
      { id: 'u-1', role: 'user', text: 'Build a racing game', createdAt: Date.now() - 15_000 },
      {
        id: 't-1',
        role: 'tool',
        text: 'openmotion_game_write_files',
        createdAt: Date.now() - 4_000,
        toolEvent: {
          callId: 'call-write',
          tool: 'openmotion_game_write_files',
          label: 'Write game files',
          status: 'running',
          category: 'file_write',
          startedAt: Date.now() - 3_200,
        },
      },
      {
        id: 'r-1',
        role: 'reasoning',
        text: 'Preparing track physics and HUD...',
        status: 'streaming',
        createdAt: Date.now() - 2_300,
      },
    ],
  };

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <div>
          <ExecutionTimeline
            chat={liveChat}
            busy
            sending={false}
            hideInlineStatus
            engineLabel="Antigravity"
            onOpenArtifactId={vi.fn()}
            onPreviewAttachment={vi.fn()}
            onCopyText={vi.fn()}
            onApprove={vi.fn()}
            onContinue={onContinue}
          />
          <SuperAgentLiveProgressDock
            chat={liveChat}
            busy
            sending={false}
            engineLabel="Antigravity"
          />
        </div>
      </I18nProvider>,
    );
  });
  await flush();

  const dock = document.querySelector('.om-sa-progress-dock')!;
  expect(dock).toBeTruthy();
  expect(dock.textContent).toContain('Thinking…');
  expect(dock.textContent).toContain('1/3 tasks');
  const progressBar = dock.querySelector('.om-sa-progress-bar') as HTMLElement;
  expect(progressBar.getAttribute('data-determinate')).toBe('true');
  expect(progressBar.style.width).toBe('33%');
  expect(document.querySelector('.om-sa-work-summary-timer')).toBeTruthy();
  expect(document.querySelector('.om-sa-reasoning-label')?.textContent).toMatch(/Thinking… · \d+(?:\.\d+)?s/);

  // 2. Cancelled mid-run turn renders recovery card with step summary and Continue button
  const cancelledChat: SuperAgentChat = {
    ...baseChat,
    state: 'cancelled',
    error: undefined,
    lastTurnDurationMs: 116_000,
    messages: [
      { id: 'u-1', role: 'user', text: 'Build a racing game', createdAt: 1000 },
      {
        id: 't-done',
        role: 'tool',
        text: 'openmotion_read_workflow',
        createdAt: 2000,
        toolEvent: {
          callId: 'c-done',
          tool: 'openmotion_read_workflow',
          label: 'Read workflow guidance',
          status: 'completed',
          category: 'mcp',
          startedAt: 2000,
          finishedAt: 3200,
          durationMs: 1200,
        },
      },
      {
        id: 'r-done',
        role: 'reasoning',
        text: 'Considering 2D widescreen racing...',
        status: 'completed',
        durationMs: 54_000,
        createdAt: 3500,
      },
    ],
  };

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ExecutionTimeline
          chat={cancelledChat}
          busy={false}
          sending={false}
          engineLabel="Antigravity"
          onOpenArtifactId={vi.fn()}
          onPreviewAttachment={vi.fn()}
          onCopyText={vi.fn()}
          onApprove={vi.fn()}
          onContinue={onContinue}
        />
      </I18nProvider>,
    );
  });
  await flush();

  const interruptedCard = document.querySelector('.om-sa-interrupted-card')!;
  expect(interruptedCard).toBeTruthy();
  expect(interruptedCard.textContent).toContain('Stopped before finishing');
  expect(interruptedCard.textContent).toContain('2 steps');
  const continueBtn = interruptedCard.querySelector('.om-sa-continue-btn') as HTMLButtonElement;
  expect(continueBtn.textContent).toContain('Continue');
  await act(async () => continueBtn.click());
  expect(onContinue).toHaveBeenCalledTimes(1);

  // 3. Failed turn with chat.error also offers Continue inside .om-sa-error-card
  const failedChat: SuperAgentChat = {
    ...cancelledChat,
    state: 'failed',
    error: 'Server restarted while the Agent was running. Click Continue to resume from where it left off.',
  };

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ExecutionTimeline
          chat={failedChat}
          busy={false}
          sending={false}
          engineLabel="Antigravity"
          onOpenArtifactId={vi.fn()}
          onPreviewAttachment={vi.fn()}
          onCopyText={vi.fn()}
          onApprove={vi.fn()}
          onContinue={onContinue}
        />
      </I18nProvider>,
    );
  });
  await flush();

  const errorCard = document.querySelector('.om-sa-error-card')!;
  expect(errorCard).toBeTruthy();
  expect(errorCard.textContent).toContain('Server restarted while the Agent was running.');
  const errorContinueBtn = errorCard.querySelector('.om-sa-continue-btn') as HTMLButtonElement;
  expect(errorContinueBtn).toBeTruthy();
  await act(async () => errorContinueBtn.click());
  expect(onContinue).toHaveBeenCalledTimes(2);
});

it('auto-enters Game mode when opened from Game Studio, plays games in Artifact Viewer without creating empty chats, and supports remix selection', async () => {
  let chatCreateCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    if (url.includes('/motion-api/super-agent/chats') && method === 'POST') {
      chatCreateCalls += 1;
    }
    if (url.includes('/motion-api/super-agent/chats')) return jsonResponse({ conversations: [] });
    if (url.includes('/motion-api/super-agent/resources')) return jsonResponse({ items: [], counts: { assets: 0, designProjects: 0, motionProjects: 0, brandKits: 0, templates: 0, skills: 0, total: 0 } });
    if (url.includes('/motion-api/settings/agents')) return jsonResponse({ agents: [{ id: 'codex', label: 'Codex', installed: true, auth: 'signed-in', models: [] }] });
    if (url.includes('/motion-api/settings/agent-runtimes')) return jsonResponse({ localDirectAvailable: true, runtimes: [] });
    if (url.includes('/motion-api/games')) return jsonResponse({ games: [] });
    return jsonResponse({});
  }));

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={null}
          requestedMode="game"
          requestedGameId="community-little-prince"
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
  await flush();

  // Auto-switched into Game mode with fanned hero, search input, sort combobox, and masonry waterfall
  expect(container.querySelector('.om-sa-stream')?.getAttribute('data-mode')).toBe('game');
  expect(container.querySelectorAll('.om-sa-game-fan-card').length).toBeGreaterThan(0);
  expect(container.querySelectorAll('.om-sa-game-fan-actions .om-sa-game-tile-play').length).toBe(1);
  expect(container.querySelector('.om-sa-game-search input')).toBeTruthy();
  expect(container.querySelector('.om-sa-game-sort [role="combobox"]')).toBeTruthy();
  expect(container.querySelectorAll('.om-sa-game-tile').length).toBeGreaterThan(0);

  // requestedGameId opens immediately in the right-hand Artifact Viewer without creating an empty chat
  const viewer = container.querySelector('.om-sa-viewer');
  expect(viewer).toBeTruthy();
  expect(viewer?.textContent).toContain('The Little Prince: Star Journey');
  expect(chatCreateCalls).toBe(0);

  // Clicking "Remix" inside the Artifact Viewer selects the playing game into the Agent composer
  const viewerUseBtn = viewer?.querySelector('.om-sa-game-use-btn') as HTMLButtonElement;
  expect(viewerUseBtn).toBeTruthy();
  expect(viewerUseBtn.textContent).toContain('Remix');
  await act(async () => viewerUseBtn.click());
  await flush();
  expect(container.querySelector('.om-sa-composer-chips')?.textContent).toContain('The Little Prince: Star Journey');

  // Top fanned Hero carousel rotates smoothly via Next/Previous controls and side-card clicks
  const initialCenterLabel = container.querySelector('.om-sa-game-fan-item[data-slot="0"] .om-sa-game-fan-card')?.getAttribute('aria-label');
  const nextFanBtn = container.querySelector('.om-sa-game-fan-nav[data-side="next"]') as HTMLButtonElement;
  expect(nextFanBtn).toBeTruthy();
  await act(async () => nextFanBtn.click());
  await flush();
  const nextCenterLabel = container.querySelector('.om-sa-game-fan-item[data-slot="0"] .om-sa-game-fan-card')?.getAttribute('aria-label');
  expect(nextCenterLabel).not.toBe(initialCenterLabel);

  // Clicking the center Hero card selects it into the Agent composer (not jarring auto-play)
  const fanCenterCard = container.querySelector('.om-sa-game-fan-item[data-slot="0"] .om-sa-game-fan-card') as HTMLButtonElement;
  expect(fanCenterCard).toBeTruthy();
  await act(async () => fanCenterCard.click());
  await flush();
  expect(container.querySelector('.om-sa-composer-chips')?.textContent).toContain('Remix ·');

  // Clicking a bottom masonry card cover selects it into the composer. The Try game button opens the viewer.
  const listCoverBtn = container.querySelector('.om-sa-game-tile .om-sa-game-tile-cover') as HTMLButtonElement;
  expect(listCoverBtn).toBeTruthy();
  await act(async () => listCoverBtn.click());
  await flush();
  expect(container.querySelector('.om-sa-composer-chips')?.textContent).toContain('Remix ·');

  const listPlayBtn = container.querySelector('.om-sa-game-tile .om-sa-game-tile-play') as HTMLButtonElement;
  expect(listPlayBtn).toBeTruthy();
  expect(listPlayBtn.textContent).toContain('Try game');
  await act(async () => listPlayBtn.click());
  await flush();
  expect(container.querySelector('.om-sa-viewer')).toBeTruthy();
});

it('consumes Cloud deploy requests across viewer remounts and aborts deploy when opening a game fails', async () => {
  let failPatch = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/motion-api/web-publish/')) {
      return new Response(
        JSON.stringify({
          targetKind: 'game',
          targetId: 'community-little-prince',
          projectId: 'community-little-prince',
          accountSignedIn: false,
          accountState: 'signed-out',
          publications: [],
          deployments: [],
          active: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/motion-api/settings/account')) {
      return new Response(JSON.stringify({ state: 'signed-out' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === `${SUPER_AGENT_API}/chats/${CHAT_ID}` && init?.method === 'PATCH' && failPatch) {
      return new Response(JSON.stringify({ error: 'Network unavailable' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(input, init);
  }) as any;

  // 1) Deploy once, close viewer (unmounts WebPublishPopover), then Play another game -> popover must NOT auto-open again
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={null}
          requestedMode="game"
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
  await flush();

  const deployBtn = container.querySelector('.om-sa-game-fan-actions .om-sa-game-tile-deploy') as HTMLButtonElement;
  expect(deployBtn).toBeTruthy();
  await act(async () => deployBtn.click());
  await flush();
  expect(document.querySelector('.om-web-publish-popover')).toBeTruthy();

  // Close the viewer so WebPublishPopover unmounts
  const closeViewerBtn = container.querySelector('button[aria-label="Close viewer"]') as HTMLButtonElement;
  expect(closeViewerBtn).toBeTruthy();
  await act(async () => closeViewerBtn.click());
  await flush();
  expect(container.querySelector('.om-sa-viewer')).toBeNull();
  expect(document.querySelector('.om-web-publish-popover')).toBeNull();

  // Click Play on a masonry game card -> viewer remounts, but Cloud share popover must stay closed
  const playBtn = container.querySelector('.om-sa-game-tile .om-sa-game-tile-play') as HTMLButtonElement;
  expect(playBtn).toBeTruthy();
  await act(async () => playBtn.click());
  await flush();
  expect(container.querySelector('.om-sa-viewer')).toBeTruthy();
  expect(document.querySelector('.om-web-publish-popover')).toBeNull();

  // 2) With an active chat that has game A selected, failing PATCH on Cloud deploy for game B must NOT open game A's popover
  const emptyGameChat: SuperAgentChat = {
    ...sampleChat,
    messages: [],
    artifacts: [
      {
        id: 'game:game-a',
        kind: 'game-project',
        title: 'Game A',
        projectId: 'game-a',
        url: '/motion-api/games/game-a/play/index.html',
        createdAt: 1000,
        updatedAt: 1000,
      },
    ],
    activeArtifactId: 'game:game-a',
  };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${SUPER_AGENT_API}/chats/${CHAT_ID}` && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ conversation: emptyGameChat }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return prevFetch(input, init);
  }) as any;

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={CHAT_ID}
          requestedMode="game"
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
  await flush();

  failPatch = true;
  const deployGameBBtn = container.querySelector('.om-sa-game-tile .om-sa-game-tile-deploy') as HTMLButtonElement;
  expect(deployGameBBtn).toBeTruthy();
  await act(async () => deployGameBBtn.click());
  await flush();
  expect(document.querySelector('.om-web-publish-popover')).toBeNull();
});

it('keeps Skill handoff instructions out of visible user messages and renders human-readable approval cards with collapsed technical details', async () => {
  let turnBody: any = null;
  let approveBody: any = null;
  const APPROVAL_CHAT_ID = '66666666-6666-4666-8666-666666666666';
  const rawScriptDetail = JSON.stringify({
    command: 'python3 - <<\'OPENMOTION_SCORE\'\nfrom pathlib import Path\ndestination = Path("欢快背景音乐.wav")\nOPENMOTION_SCORE',
    availableDecisions: ['accept', 'cancel'],
  }, null, 2);

  let currentChat: SuperAgentChat = {
    id: APPROVAL_CHAT_ID,
    title: '2024小游戏',
    intent: 'game',
    engine: 'codex',
    permissionMode: 'on-request',
    createdAt: 1000,
    updatedAt: 2000,
    state: 'idle',
    messages: [],
    artifacts: [],
    approvals: [],
  };

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

    if (url.startsWith('/motion-api/settings/agents')) {
      return json({ agents: [{ id: 'codex', label: 'Codex', installed: true, auth: 'signed-in', models: [] }] });
    }
    if (url.startsWith('/motion-api/settings/agent-runtimes')) {
      return json({
        localDirectAvailable: true,
        defaultRuntimeId: 'local:direct',
        runtimes: [{
          id: 'local:direct',
          kind: 'local-direct',
          name: 'This computer',
          status: 'online',
          agents: [{ id: 'codex', label: 'Codex', installed: true, auth: 'signed-in', models: [] }],
          runnableAgentIds: ['codex'],
        }],
      });
    }
    if (url.startsWith(`${SUPER_AGENT_API}/resources`)) {
      return json({
        counts: { assets: 0, brandKits: 0, officialBrandKits: 0, motionTemplates: 0, designTemplates: 0, skills: 0, designSkills: 0, designProjects: 0, motionProjects: 0, mediaProvidersAvailable: 0, workflows: 0, models: 0, games: 0 },
        items: [],
        generatedAt: Date.now(),
      });
    }
    if (url === `${SUPER_AGENT_API}/chats` && method === 'GET') {
      return json({ conversations: [] });
    }
    if (url === `${SUPER_AGENT_API}/chats` && method === 'POST') {
      return json({ conversation: currentChat });
    }
    if (url === `${SUPER_AGENT_API}/chats/${APPROVAL_CHAT_ID}` && method === 'GET') {
      return json({ conversation: currentChat });
    }
    if (url === `${SUPER_AGENT_API}/chats/${APPROVAL_CHAT_ID}/turn` && method === 'POST') {
      turnBody = JSON.parse(String(init?.body || '{}'));
      currentChat = {
        ...currentChat,
        state: 'waiting',
        messages: [
          {
            id: 'msg-u1',
            role: 'user',
            text: turnBody.text,
            createdAt: 2001,
            attachments: turnBody.attachments,
            contextTags: turnBody.contextTags,
          },
        ],
        approvals: [
          {
            id: 'appr-audio-1',
            kind: 'command',
            title: 'Command approval',
            detail: rawScriptDetail,
          },
        ],
      };
      return json({ conversation: currentChat });
    }
    if (url === `${SUPER_AGENT_API}/chats/${APPROVAL_CHAT_ID}/approve` && method === 'POST') {
      approveBody = JSON.parse(String(init?.body || '{}'));
      currentChat = {
        ...currentChat,
        state: 'idle',
        permissionMode: approveBody.alwaysAllow ? 'auto' : currentChat.permissionMode,
        approvals: [],
      };
      return json({ conversation: currentChat });
    }
    return json({});
  }) as any;

  queueSuperAgentHandoff(buildSuperAgentHandoff(
    { kind: 'game-project', id: 'game-2024', title: '我想做一个2024小游戏', genre: 'casual' },
    {
      prompt: '我想做一个2024小游戏',
      hiddenInstructions: 'Use the openmotion-game Skill to build game game-2024. Read openmotion://workflow/game/start.',
      contextTags: [
        { kind: 'mode', label: 'Game', icon: 'gamepad-line', tone: 'agent' },
        { kind: 'param', label: 'Casual' },
        { kind: 'param', label: '9:16' },
        { kind: 'param', label: 'Single player' },
      ],
      locale: 'zh-CN',
      autoSend: true,
      newChat: true,
    },
  ));

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
  await flush();

  // Hidden Skill instructions go to the backend turn payload, never into the visible user bubble
  expect(turnBody?.text).toBe('我想做一个2024小游戏');
  expect(turnBody?.hiddenInstructions).toContain('openmotion-game Skill');
  const userBubble = container.querySelector('.om-sa-user-bubble');
  expect(userBubble?.textContent).toContain('我想做一个2024小游戏');
  expect(userBubble?.textContent).not.toContain('openmotion-game Skill');
  expect(userBubble?.textContent).not.toContain('openmotion://workflow/game/start');

  // Mode + parameter tags render cleanly above the user bubble, while duplicate draft game chip is suppressed
  const tagLabels = [...container.querySelectorAll('.om-sa-context-tag')].map(el => el.textContent?.trim());
  expect(tagLabels).toEqual(['Game', 'Casual', '9:16', 'Single player']);
  expect(container.querySelectorAll('.om-sa-msg-attachments .om-sa-attachment-chip').length).toBe(0);

  // Approval card renders plain-language summary + target chip, with technical details collapsed by default
  const approvalCard = container.querySelector('.om-sa-approval')!;
  expect(approvalCard).toBeTruthy();
  expect(approvalCard.querySelector('.om-sa-approval-title')?.textContent).toBe('Create audio file');
  expect(approvalCard.querySelector('.om-sa-approval-target')?.textContent).toBe('欢快背景音乐.wav');
  expect(approvalCard.querySelector('.om-sa-approval-summary')?.textContent).toContain('欢快背景音乐.wav');
  const detailsEl = approvalCard.querySelector('details.om-sa-approval-details') as HTMLDetailsElement;
  expect(detailsEl).toBeTruthy();
  expect(detailsEl.open).toBe(false);
  expect(detailsEl.querySelector('.om-sa-approval-pre')?.textContent).not.toContain('availableDecisions');

  // Clicking "Always allow" sends alwaysAllow: true and clears the card
  const alwaysAllowBtn = [...approvalCard.querySelectorAll('button')].find(
    b => b.textContent?.trim() === 'Always allow',
  ) as HTMLButtonElement;
  expect(alwaysAllowBtn).toBeTruthy();
  await act(async () => alwaysAllowBtn.click());
  await flush();
  expect(approveBody).toEqual({
    approvalId: 'appr-audio-1',
    accepted: true,
    alwaysAllow: true,
  });
  expect(container.querySelector('.om-sa-approval')).toBeNull();
});

it('FilesChangedCard renders collapsible folder tree, inline diff/image preview, and Open in Code Viewer', async () => {
  const onCopyText = vi.fn();
  const onOpenChangedFile = vi.fn();
  const treeChat: SuperAgentChat = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Action Shooter',
    intent: 'game',
    engine: 'antigravity',
    permissionMode: 'auto',
    projectDir: '/tmp/workspace/games/game-9',
    projectKind: 'game',
    createdAt: 1000,
    updatedAt: 4500,
    state: 'idle',
    artifacts: [
      {
        id: 'game:game-9',
        kind: 'game-project',
        title: 'Action Shooter',
        projectId: 'game-9',
        createdAt: 2000,
        updatedAt: 3000,
      },
    ],
    turnChangedFiles: {
      u1: [
        { action: 'create', path: 'design/plan.md', addedLines: 4, diffPreview: '+# Plan', artifactId: 'game:game-9' },
        { action: 'create', path: 'design/assets.csv', addedLines: 2, diffPreview: '+name,type', artifactId: 'game:game-9' },
        { action: 'create', path: 'design/verification.md', addedLines: 3, diffPreview: '+# Verified', artifactId: 'game:game-9' },
        { action: 'create', path: 'assets/icon.svg', addedLines: 1, diffPreview: '+<svg/>', artifactId: 'game:game-9', previewUrl: '/motion-api/games/game-9/play/assets/icon.svg' },
        { action: 'create', path: 'assets/cover.png', binary: true, sizeBytes: 12400, artifactId: 'game:game-9', previewUrl: '/motion-api/games/game-9/play/assets/cover.png' },
        { action: 'create', path: 'index.html', addedLines: 10, diffPreview: '+<!doctype html>', artifactId: 'game:game-9' },
        { action: 'create', path: 'style.css', addedLines: 8, diffPreview: '+body { margin: 0; }', artifactId: 'game:game-9' },
        { action: 'edit', path: 'client.js', addedLines: 5, removedLines: 1, diffPreview: '-old()\n+new()', artifactId: 'game:game-9' },
        { action: 'create', path: 'logic.js', addedLines: 12, diffPreview: '+export const meta = {};', artifactId: 'game:game-9' },
      ],
    },
    approvals: [],
    messages: [
      { id: 'u1', role: 'user', text: 'Build action game', createdAt: 1000 },
      { id: 'a1', role: 'assistant', text: 'Done.', createdAt: 4000, status: 'completed' },
    ],
  };

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ExecutionTimeline
          chat={treeChat}
          busy={false}
          sending={false}
          engineLabel="Antigravity"
          onOpenArtifactId={vi.fn()}
          onOpenChangedFile={onOpenChangedFile}
          onPreviewAttachment={vi.fn()}
          onCopyText={onCopyText}
          onApprove={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();

  const card = container.querySelector('.om-sa-files-changed')!;
  expect(card.textContent).toContain('Files changed (9)');
  expect(card.textContent).toContain('+45');
  expect(card.textContent).toContain('-1');

  const folderNames = [...card.querySelectorAll('.om-sa-file-folder-name')].map(el => el.textContent);
  expect(folderNames).toEqual(['assets', 'design']);
  expect(card.textContent).toContain('index.html');
  expect(card.textContent).toContain('cover.png');
  expect(card.textContent).toContain('assets.csv');

  // Collapse all folders via header action, then re-expand
  const collapseAllBtn = card.querySelector<HTMLButtonElement>('.om-sa-files-head-action-btn')!;
  expect(collapseAllBtn.textContent).toContain('Collapse all');
  await act(async () => collapseAllBtn.click());
  await flush();
  expect(card.textContent).not.toContain('cover.png');
  expect(card.textContent).not.toContain('plan.md');
  expect(card.querySelector('.om-sa-files-head-action-btn')?.textContent).toContain('Expand all');

  await act(async () => collapseAllBtn.click());
  await flush();
  expect(card.textContent).toContain('cover.png');

  // Collapse a single folder (assets)
  const assetsFolderBtn = [...card.querySelectorAll<HTMLButtonElement>('.om-sa-file-folder-trigger')].find(
    el => el.textContent?.includes('assets'),
  )!;
  await act(async () => assetsFolderBtn.click());
  await flush();
  expect(card.textContent).not.toContain('cover.png');
  expect(card.textContent).toContain('plan.md');
  await act(async () => assetsFolderBtn.click());
  await flush();

  // Clicking binary image opens inline preview drawer
  const coverBtn = [...card.querySelectorAll<HTMLButtonElement>('.om-sa-file-row-trigger')].find(
    el => el.title === 'assets/cover.png',
  )!;
  await act(async () => coverBtn.click());
  await flush();
  const imgPreview = card.querySelector<HTMLImageElement>('.om-sa-file-preview-img');
  expect(imgPreview?.getAttribute('src')).toBe('/motion-api/games/game-9/play/assets/cover.png');

  // Clicking "Open in Code Viewer" invokes callback with index.html
  const openViewerBtn = [...card.querySelectorAll<HTMLButtonElement>('.om-sa-file-copy-btn')].find(
    btn => btn.getAttribute('aria-label') === 'Open in Code Viewer' && btn.closest('.om-sa-file-change-row')?.textContent?.includes('index.html'),
  )!;
  expect(openViewerBtn).toBeTruthy();
  await act(async () => openViewerBtn.click());
  await flush();
  expect(onOpenChangedFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'index.html', artifactId: 'game:game-9' }));

  // Project directory footer button copies canonical directory
  const dirFootBtn = card.querySelector<HTMLButtonElement>('.om-sa-files-dir-btn')!;
  expect(dirFootBtn.textContent).toContain('/tmp/workspace/games/game-9');
  await act(async () => dirFootBtn.click());
  expect(onCopyText).toHaveBeenCalledWith('/tmp/workspace/games/game-9');

  // Card header toggles full collapse
  const cardHeadBtn = card.querySelector<HTMLButtonElement>('.om-sa-files-changed-head-btn')!;
  await act(async () => cardHeadBtn.click());
  await flush();
  expect(card.querySelector('.om-sa-files-changed-list')).toBeNull();
});

it('SuperAgentWorkspace shows task project directory in header and opens changed file in Code Viewer', async () => {
  const GAME_TREE_CHAT_ID = '22222222-2222-4222-8222-222222222222';
  const chatPayload: SuperAgentChat = {
    id: GAME_TREE_CHAT_ID,
    title: 'Neon Runner',
    intent: 'game',
    engine: 'antigravity',
    permissionMode: 'auto',
    projectDir: '/tmp/data/games/game-neon-1',
    projectKind: 'game',
    createdAt: 1000,
    updatedAt: 5000,
    state: 'idle',
    artifacts: [
      {
        id: 'game:game-neon-1',
        kind: 'game-project',
        title: 'Neon Runner',
        projectId: 'game-neon-1',
        url: '/motion-api/games/game-neon-1/play/index.html',
        revision: 'rev-1',
        createdAt: 2000,
        updatedAt: 3000,
      },
    ],
    activeArtifactId: 'game:game-neon-1',
    turnChangedFiles: {
      u1: [
        { action: 'create', path: 'index.html', addedLines: 5, diffPreview: '+<!doctype html>', artifactId: 'game:game-neon-1' },
        { action: 'create', path: 'style.css', addedLines: 3, diffPreview: '+.hud { color: red; }', artifactId: 'game:game-neon-1' },
      ],
    },
    approvals: [],
    messages: [
      { id: 'u1', role: 'user', text: 'Create Neon Runner', createdAt: 1000 },
      { id: 'a1', role: 'assistant', text: 'Ready!', createdAt: 4000, status: 'completed' },
    ],
  };

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('/motion-api/settings/agents')) {
      return json({ agents: [{ id: 'antigravity', label: 'Antigravity', installed: true, auth: 'signed-in', models: [] }] });
    }
    if (url.startsWith('/motion-api/settings/agent-runtimes')) {
      return json({ localDirectAvailable: true, defaultRuntimeId: 'local:direct', runtimes: [] });
    }
    if (url.startsWith(`${SUPER_AGENT_API}/resources`)) {
      return json({
        counts: { assets: 0, brandKits: 0, officialBrandKits: 0, motionTemplates: 0, designTemplates: 0, skills: 0, designSkills: 0, designProjects: 0, motionProjects: 0, mediaProvidersAvailable: 0, workflows: 0, models: 0, games: 1 },
        items: [],
        generatedAt: Date.now(),
      });
    }
    if (url === `${SUPER_AGENT_API}/chats`) {
      return json({ conversations: [{ ...chatPayload, artifactCount: 1, messageCount: 2 }] });
    }
    if (url === `${SUPER_AGENT_API}/chats/${GAME_TREE_CHAT_ID}`) {
      return json({ conversation: chatPayload });
    }
    if (url.includes('/motion-api/games/catalog')) {
      return json({ games: [{ id: 'game-neon-1', title: 'Neon Runner', status: 'ready', source: 'mine', genre: 'arcade', multiplayer: false }] });
    }
    if (url.includes('/motion-api/games/game-neon-1/files')) {
      return json({ files: [{ path: 'index.html', bytes: 64 }, { path: 'style.css', bytes: 42 }] });
    }
    if (url.includes('/motion-api/games/game-neon-1/play/style.css')) {
      return new Response('.hud { color: red; }', { status: 200, headers: { 'Content-Type': 'text/css' } });
    }
    if (url.includes('/motion-api/games/game-neon-1/play/index.html')) {
      return new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    return json({});
  }) as any;

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <SuperAgentWorkspace
          active
          chatId={GAME_TREE_CHAT_ID}
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
  await flush();

  const dirHeaderBtn = container.querySelector<HTMLButtonElement>('.om-sa-head-dir-btn')!;
  expect(dirHeaderBtn).toBeTruthy();
  expect(dirHeaderBtn.textContent).toContain('games/game-neon-1');
  await act(async () => dirHeaderBtn.click());
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/data/games/game-neon-1');

  // Click Open in Code Viewer on style.css
  const openStyleBtn = [...container.querySelectorAll<HTMLButtonElement>('.om-sa-file-copy-btn')].find(
    btn => btn.getAttribute('aria-label') === 'Open in Code Viewer' && btn.closest('.om-sa-file-change-row')?.textContent?.includes('style.css'),
  )!;
  expect(openStyleBtn).toBeTruthy();
  await act(async () => openStyleBtn.click());
  await flush();
  await flush();
  await flush();

  const selectedTab = [...container.querySelectorAll<HTMLElement>('.om-sa-code-file-row')].find(
    el => el.getAttribute('aria-selected') === 'true',
  );
  expect(selectedTab?.textContent).toContain('style.css');
  expect(container.textContent).toContain('.hud { color: red; }');
});
