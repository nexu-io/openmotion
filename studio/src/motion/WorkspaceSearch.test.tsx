// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import type { GalleryTemplate } from '../../../shared/catalog';
import type { SuperAgentChatSummary, SuperAgentResourceAttachment } from '../../../shared/super-agent';
import { I18nProvider } from '../i18n/I18n';
import { fetchWorkspaceResources, listSuperAgentChats } from '../super-agent/superAgentClient';
import { copyTextToClipboard } from '../utils/clipboard';
import { WorkspaceSearch } from './WorkspaceSearch';
import { WorkspaceChromeContext, type WorkspaceChrome } from './WorkspaceChromeContext';
import * as pageTracking from './pageTracking';
import { assetRequest } from './assetClient';
import { useCoveredTemplates } from './useCoveredTemplates';

vi.mock('./assetClient', () => ({ assetRequest: vi.fn() }));
vi.mock('./useMediaCatalog', () => ({
  useMediaCatalog: () => ({
    catalog: {
      status: { providers: [{ id: 'atlascloud', label: 'Atlas Cloud' }] },
      models: [{
        id: 'atlascloud:bytedance/seedance-2.0/text-to-video',
        modelId: 'bytedance/seedance-2.0/text-to-video',
        label: 'Seedance 2.0',
        provider: 'atlascloud',
        modality: 'video',
        mode: 'text-to-video',
      }],
    },
    failed: false,
  }),
}));
vi.mock('./useCoveredTemplates', () => ({ useCoveredTemplates: vi.fn() }));
vi.mock('../super-agent/superAgentClient', () => ({
  listSuperAgentChats: vi.fn(),
  fetchWorkspaceResources: vi.fn(),
}));
vi.mock('../utils/clipboard', () => ({ copyTextToClipboard: vi.fn() }));

beforeEach(() => {
  vi.mocked(useCoveredTemplates).mockReturnValue({
    catalog: null,
    firstPage: null,
    failed: false,
    retry: vi.fn(),
  });
  vi.mocked(listSuperAgentChats).mockResolvedValue({ conversations: [] });
  vi.mocked(fetchWorkspaceResources).mockResolvedValue({
    counts: {
      assets: 0,
      brandKits: 0,
      officialBrandKits: 0,
      motionTemplates: 0,
      designTemplates: 0,
      skills: 0,
      designSkills: 0,
      designProjects: 0,
      motionProjects: 0,
      mediaProvidersAvailable: 0,
    },
    items: [],
    generatedAt: 0,
  });
  vi.mocked(copyTextToClipboard).mockResolvedValue(true);
});

it('retries a workspace search, pages asset matches and opens the selected version', async () => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onAsset = vi.fn(), noop = vi.fn();
  vi.mocked(assetRequest).mockRejectedValueOnce(new Error('offline')).mockImplementation(async ({ offset }) => ({
    assets: [{ id: 'asset-' + offset, name: 'Orbit ' + offset, modality: 'image', currentVersionId: 'version-' + offset }],
    nextOffset: offset === 0 ? 24 : null,
  }));
  const click = async (button: Element) => act(async () => (button as HTMLButtonElement).click());
  const tick = async () => act(async () => { await vi.advanceTimersByTimeAsync(200); });
  const byText = (text: string) => [...document.querySelectorAll('button')].find(node => node.textContent === text)!;
  try {
    await act(async () => root.render(<WorkspaceSearch onSkill={noop} destination={null} onAsset={onAsset} onStudio={noop} onScene={noop} onAccount={noop} onLibrary={noop} onCommunity={noop} />));
    await click(container.querySelector('button')!);
    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'orbit');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tick();
    expect(document.body.textContent).not.toContain('No matches');
    await click(byText('Retry loading assets')); await tick();
    expect(document.body.textContent).toContain('Orbit 0');
    await click(byText('Next')); await tick();
    expect(document.body.textContent).toContain('Orbit 24');
    expect(document.body.textContent).not.toContain('Orbit 0');
    await click(document.querySelector('.om-search-results [aria-label="Workspace assets"] button')!);
    expect(onAsset).toHaveBeenCalledWith('asset-24', 'version-24');
    expect(document.querySelector('.om-workspace-search input')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
  }
});

it('shows the model identity, serving provider and matched text while keeping the whole row actionable', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(assetRequest).mockResolvedValue({ assets: [], nextOffset: null });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const onScene = vi.fn(), noop = vi.fn();
  try {
    await act(async () => root.render(<WorkspaceSearch onSkill={noop} destination={null} onAsset={noop} onStudio={noop} onScene={onScene} onAccount={noop} onLibrary={noop} onCommunity={noop} />));
    await act(async () => container.querySelector('button')!.click());
    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'see 2.0 cloud');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const row = document.querySelector<HTMLButtonElement>('.om-search-results [aria-label="Models"] button')!;
    expect(row.getAttribute('aria-label')).toBe('Seedance 2.0, Atlas Cloud, Video');
    expect(row.querySelector('img')?.getAttribute('src')).toContain('bytedance-color.svg');
    expect([...row.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['See', '2.0', 'Cloud']);
    expect(row.querySelector('.om-badge')?.getAttribute('data-tone')).toBe('video');
    await act(async () => row.click());
    expect(onScene).toHaveBeenCalledWith(expect.objectContaining({ model: 'atlascloud:bytedance/seedance-2.0/text-to-video' }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('finds a Studio by its localized or English name and opens the same destination', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(assetRequest).mockResolvedValue({ assets: [], nextOffset: null });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const onStudio = vi.fn(), noop = vi.fn();
  try {
    await act(async () => root.render(<I18nProvider initialLocale="zh-CN"><WorkspaceSearch destination={null}
      onSkill={noop} onAsset={noop} onStudio={onStudio} onScene={noop} onAccount={noop} onLibrary={noop} onCommunity={noop} />
    </I18nProvider>));
    for (const term of ['营销', 'Marketing']) {
      await act(async () => container.querySelector('button')!.click());
      const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, term);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const row = document.querySelector<HTMLButtonElement>('.om-search-results button[aria-label="营销工作室"]');
      expect(row?.textContent).toBe('营销工作室');
      await act(async () => row!.click());
      expect(onStudio).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'marketing' }));
    }
    expect(onStudio).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('toggles with Cmd/Ctrl+K, surfaces Super Agent New Chat & searches chats with Enter jump', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(assetRequest).mockResolvedValue({ assets: [], nextOffset: null });
  const sampleChats: SuperAgentChatSummary[] = [
    {
      id: 'chat-launch-1',
      title: 'Product Launch Hero Video',
      intent: 'video',
      pinned: true,
      engine: 'codex',
      state: 'idle',
      artifactCount: 2,
      messageCount: 6,
      updatedAt: Date.now() - 120_000,
      createdAt: Date.now() - 600_000,
    },
    {
      id: 'chat-web-2',
      title: 'SaaS Landing Page Prototype',
      intent: 'website',
      engine: 'claude',
      state: 'idle',
      artifactCount: 1,
      messageCount: 4,
      updatedAt: Date.now() - 3_600_000,
      createdAt: Date.now() - 7_200_000,
    },
  ];
  vi.mocked(listSuperAgentChats).mockResolvedValue({ conversations: sampleChats });

  const onNewAgentChat = vi.fn(), onAgentChat = vi.fn(), noop = vi.fn();
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);

  const setInput = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  try {
    await act(async () => root.render(
      <WorkspaceSearch
        destination={null}
        onSkill={noop}
        onAsset={noop}
        onStudio={noop}
        onScene={noop}
        onAccount={noop}
        onLibrary={noop}
        onCommunity={noop}
        onNewAgentChat={onNewAgentChat}
        onAgentChat={onAgentChat}
      />,
    ));

    // Cmd+K opens palette
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('.om-command-palette')).not.toBeNull();

    // Quick action: New Super Agent chat
    const newChatBtn = document.querySelector<HTMLButtonElement>('[data-result-key="action:new-chat"]')!;
    expect(newChatBtn).not.toBeNull();
    await act(async () => newChatBtn.click());
    expect(onNewAgentChat).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.om-command-palette')).toBeNull();

    // Ctrl+K reopens; filter chats and jump via Enter
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    await setInput('SaaS Landing');
    const chatRow = document.querySelector<HTMLButtonElement>('[data-result-key="chat:chat-web-2"]')!;
    expect(chatRow).not.toBeNull();
    await act(async () => {
      chatRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    // Press ArrowDown until activeKey targets chat-web-2, or Enter when active
    const palette = document.querySelector<HTMLElement>('.om-command-palette')!;
    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    input.focus();
    const targetKey = 'chat:chat-web-2';
    for (let i = 0; i < 10 && document.querySelector('.om-command-row[data-active="true"]')?.getAttribute('data-result-key') !== targetKey; i++) {
      await act(async () => {
        palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
    }
    expect(document.querySelector('.om-command-preview-title')?.textContent).toBe('SaaS Landing Page Prototype');
    expect(document.querySelector('.om-command-preview')?.textContent).toContain('4 messages');
    await act(async () => {
      palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onAgentChat).toHaveBeenCalledWith('chat-web-2');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('recommends templates, supports Chinese fuzzy template search, live preview actions, scope tabs, and zero-result recovery', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(assetRequest).mockResolvedValue({ assets: [], nextOffset: null });

  const templates: GalleryTemplate[] = [
    {
      id: 'hf-reference-aroll-careerwithriya',
      title: '主播口播节奏剪辑',
      subtitle: 'A-roll Cuts',
      description: 'Fast talking head reel with dynamic captions and hook cuts.',
      collection: 'reference',
      kind: 'prism',
      hasHtmlProject: true,
      tags: ['口播', 'a-roll', 'talking head'],
      duration: 14.5,
      ratio: '9:16',
      posterUrl: '/poster-talking.jpg',
      previewUrl: '/preview-talking.mp4',
      author: 'Riya',
      searchAliases: ['Talking head hook rhythm', 'a-roll'],
    },
    {
      id: 'hf-moment-M945',
      title: '科技知识科普信息图',
      subtitle: 'Motion graphics',
      description: 'Animated infographic explainer for science concepts.',
      collection: 'moment',
      kind: 'reference',
      tags: ['科普', 'explainer'],
      duration: 18,
      ratio: '16:9',
      posterUrl: '/poster-science.jpg',
      author: 'MotionLab',
      searchAliases: ['Science explainer infographic'],
    },
  ];
  vi.mocked(useCoveredTemplates).mockReturnValue({
    catalog: templates,
    firstPage: null,
    failed: false,
    retry: vi.fn(),
  });
  const resources: SuperAgentResourceAttachment[] = [
    {
      id: 'landing-saas',
      kind: 'design-template',
      title: '现代产品落地页',
      subtitle: 'Responsive website',
      scenario: 'prototype',
      previewUrl: '/motion-api/design/catalog/templates/landing-saas/preview/index.html',
      tags: ['电商', '官网'],
    },
  ];
  vi.mocked(fetchWorkspaceResources).mockImplementation(async ({ query: q } = {}) => ({
    counts: {
      assets: 0,
      brandKits: 0,
      officialBrandKits: 0,
      motionTemplates: 2,
      designTemplates: 1,
      skills: 0,
      designSkills: 0,
      designProjects: 0,
      motionProjects: 0,
      mediaProvidersAvailable: 0,
    },
    items: q ? resources.filter(r => JSON.stringify(r).toLowerCase().includes(q.toLowerCase())) : resources,
    generatedAt: 0,
  }));

  const openLibrary = vi.fn();
  const openTemplateProject = vi.fn(async () => true);
  const openInSuperAgent = vi.fn();
  const chromeValue = {
    workspace: { projects: [], open: openTemplateProject, create: vi.fn(), status: null, busy: false, error: '', errorSource: 'operation', clearError: vi.fn(), activeProjectId: undefined, connectionError: null, navigationError: null },
    switchingDisabled: false,
    saveState: '',
    openLibrary,
    openConnections: vi.fn(),
    openModelSettings: vi.fn(),
    openHome: vi.fn(),
    openAssets: vi.fn(),
    openInSuperAgent,
    assetsOpen: false,
    openSkills: vi.fn(),
    skillsOpen: false,
    toggleSidebar: vi.fn(),
    sidebarOpen: false,
    navigationCollapsed: false,
    registerEditor: vi.fn(),
    beforeViewChange: async () => {},
  } as unknown as WorkspaceChrome;

  const onNotify = vi.fn(), noop = vi.fn();
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);

  const setInput = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  try {
    await act(async () => root.render(
      <I18nProvider initialLocale="zh-CN">
        <WorkspaceChromeContext.Provider value={chromeValue}>
          <WorkspaceSearch
            destination={null}
            onSkill={noop}
            onAsset={noop}
            onStudio={noop}
            onScene={noop}
            onAccount={noop}
            onLibrary={noop}
            onCommunity={noop}
            onNotify={onNotify}
          />
        </WorkspaceChromeContext.Provider>
      </I18nProvider>,
    ));

    await act(async () => container.querySelector('button')!.click());
    await act(async () => { await Promise.resolve(); });

    // Recommended templates shown on initial empty state
    expect(document.querySelector('.om-search-results [aria-label="推荐模板"]')).not.toBeNull();
    expect(document.querySelector('[data-result-key="motion-template:hf-reference-aroll-careerwithriya"]')).not.toBeNull();

    // Filter via Chinese query 口播 and inspect preview panel
    await setInput('口播');
    const matchedTemplateRow = document.querySelector<HTMLButtonElement>('[data-result-key="motion-template:hf-reference-aroll-careerwithriya"]')!;
    expect(matchedTemplateRow).not.toBeNull();

    const palette = document.querySelector<HTMLElement>('.om-command-palette')!;
    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    input.focus();
    for (let i = 0; i < 6 && document.querySelector('.om-command-row[data-active="true"]')?.getAttribute('data-result-key') !== 'motion-template:hf-reference-aroll-careerwithriya'; i++) {
      await act(async () => {
        palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
    }
    expect(document.querySelector('.om-command-preview-title')?.textContent).toBe('主播口播节奏剪辑');
    expect(document.querySelector('.om-command-preview')?.textContent).toContain('9:16');

    // Preview Copy prompt button works
    const copyBtn = [...document.querySelectorAll<HTMLButtonElement>('.om-command-preview-actions button')].find(btn => btn.textContent?.includes('复制 prompt'))!;
    expect(copyBtn).toBeTruthy();
    await act(async () => copyBtn.click());
    expect(vi.mocked(copyTextToClipboard)).toHaveBeenCalledWith(expect.stringContaining('hf-reference-aroll-careerwithriya'));
    expect(onNotify).toHaveBeenCalledWith('已复制提示词', 'info');

    // Preview Open & edit button launches editable template
    const editBtn = [...document.querySelectorAll<HTMLButtonElement>('.om-command-preview-actions button')].find(btn => btn.textContent?.includes('打开并编辑'))!;
    await act(async () => editBtn.click());
    expect(openTemplateProject).toHaveBeenCalledWith('templates', 'hf-reference-aroll-careerwithriya');

    // Reopen and verify zero-result recovery topic chips
    await act(async () => container.querySelector('button')!.click());
    await setInput('zzzznonexistentterm');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
    const topicChip = document.querySelector<HTMLButtonElement>('.om-command-topic-chip')!;
    expect(topicChip).not.toBeNull();
    await act(async () => topicChip.click());
    expect(document.querySelector<HTMLInputElement>('.om-workspace-search input')!.value).toBe('口播');
    expect(document.querySelector('[data-result-key="motion-template:hf-reference-aroll-careerwithriya"]')).not.toBeNull();

    // Switch scope tab to Studios and confirm templates are filtered out while Studios stay visible
    const studioTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent?.includes('工作室'))!;
    await act(async () => studioTab.click());
    expect(document.querySelector('[data-result-key="motion-template:hf-reference-aroll-careerwithriya"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('defers filtering and suppresses Enter navigation during Chinese IME composition, then commits cleanly on compositionend', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(assetRequest).mockResolvedValue({ assets: [], nextOffset: null });
  const templates: GalleryTemplate[] = [
    {
      id: 'hf-reference-aroll-careerwithriya',
      title: '主播口播节奏剪辑',
      subtitle: 'A-roll Cuts',
      description: 'Fast talking head reel with dynamic captions.',
      collection: 'reference',
      kind: 'prism',
      hasHtmlProject: true,
      tags: ['口播', 'a-roll'],
      duration: 14.5,
      ratio: '9:16',
      posterUrl: '/poster-talking.jpg',
      author: 'Riya',
    },
  ];
  vi.mocked(useCoveredTemplates).mockReturnValue({
    catalog: templates,
    firstPage: null,
    failed: false,
    retry: vi.fn(),
  });
  const onNewAgentChat = vi.fn(), noop = vi.fn();
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <I18nProvider initialLocale="zh-CN">
        <WorkspaceSearch
          destination={null}
          onSkill={noop}
          onAsset={noop}
          onStudio={noop}
          onScene={noop}
          onAccount={noop}
          onLibrary={noop}
          onCommunity={noop}
          onNewAgentChat={onNewAgentChat}
        />
      </I18nProvider>,
    ));
    await act(async () => container.querySelector('button')!.click());
    await act(async () => { await Promise.resolve(); });

    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    const palette = document.querySelector<HTMLElement>('.om-command-palette')!;
    input.focus();

    // Start IME composition and type intermediate pinyin "koub"
    await act(async () => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'koub');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Header progress bar should show and results stay marked stale without triggering remote search or closing on Enter
    expect(document.querySelector('.om-search-results')?.getAttribute('data-stale')).toBe('true');
    expect(document.querySelector('.om-command-progress')).not.toBeNull();
    await act(async () => {
      palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onNewAgentChat).not.toHaveBeenCalled();
    expect(document.querySelector('.om-command-palette')).not.toBeNull();

    // Commit Chinese text via compositionend
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '口播');
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '口播' }));
    });
    expect(document.querySelector('.om-search-results')?.getAttribute('data-stale')).toBeNull();
    expect(document.querySelector('[data-result-key="motion-template:hf-reference-aroll-careerwithriya"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('preserves video asset preview src when switching from a playing Motion template to a video asset', async () => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const templates: GalleryTemplate[] = [
    {
      id: 'tpl-clip',
      title: 'Orbit Intro Clip',
      subtitle: 'Motion',
      description: 'Orbit animation',
      collection: 'reference',
      kind: 'prism',
      hasHtmlProject: true,
      tags: ['orbit'],
      duration: 8,
      ratio: '16:9',
      posterUrl: '/poster-orbit.jpg',
      previewUrl: '/preview-orbit.mp4',
      author: 'Studio',
    },
  ];
  vi.mocked(useCoveredTemplates).mockReturnValue({
    catalog: templates,
    firstPage: null,
    failed: false,
    retry: vi.fn(),
  });
  vi.mocked(assetRequest).mockResolvedValue({
    assets: [{ id: 'asset-vid-1', name: 'Orbit Video Asset', modality: 'video', currentVersionId: 'ver-1' }],
    nextOffset: null,
  });

  const noop = vi.fn();
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <WorkspaceSearch
        destination={null}
        onSkill={noop}
        onAsset={noop}
        onStudio={noop}
        onScene={noop}
        onAccount={noop}
        onLibrary={noop}
        onCommunity={noop}
      />,
    ));
    await act(async () => container.querySelector('button')!.click());
    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'orbit');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });

    const templateRow = document.querySelector<HTMLButtonElement>('[data-result-key="motion-template:tpl-clip"]')!;
    await act(async () => {
      templateRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      templateRow.focus();
    });
    const playBtn = document.querySelector<HTMLButtonElement>('.om-command-stage-play')!;
    expect(playBtn).not.toBeNull();
    await act(async () => playBtn.click());
    expect(document.querySelector<HTMLVideoElement>('.om-command-stage video')?.getAttribute('src')).toBe('/preview-orbit.mp4');

    // Switch directly to the video asset while template playback was active
    const assetRow = document.querySelector<HTMLButtonElement>('[data-result-key="asset:asset-vid-1:ver-1"]')!;
    expect(assetRow).not.toBeNull();
    await act(async () => {
      assetRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      assetRow.focus();
    });
    const assetVideo = document.querySelector<HTMLVideoElement>('.om-command-stage-asset video')!;
    expect(assetVideo).not.toBeNull();
    expect(assetVideo.getAttribute('src')).toContain('asset-vid-1');
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
  }
});

it('submits any natural-language query directly to Super Agent via the colorful Ask AI button or Cmd/Ctrl+Enter', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(assetRequest).mockResolvedValue({ assets: [], nextOffset: null });
  const openInSuperAgent = vi.fn();
  const chromeValue = {
    workspace: { projects: [], open: vi.fn(), create: vi.fn(), status: null, busy: false, error: '', errorSource: 'operation', clearError: vi.fn(), activeProjectId: undefined, connectionError: null, navigationError: null },
    switchingDisabled: false,
    saveState: '',
    openLibrary: vi.fn(),
    openConnections: vi.fn(),
    openModelSettings: vi.fn(),
    openHome: vi.fn(),
    openAssets: vi.fn(),
    openInSuperAgent,
    assetsOpen: false,
    openSkills: vi.fn(),
    skillsOpen: false,
    toggleSidebar: vi.fn(),
    sidebarOpen: false,
    navigationCollapsed: false,
    registerEditor: vi.fn(),
    beforeViewChange: async () => {},
  } as unknown as WorkspaceChrome;
  const noop = vi.fn();
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <I18nProvider initialLocale="zh-CN">
        <WorkspaceChromeContext.Provider value={chromeValue}>
          <WorkspaceSearch
            destination={null}
            onSkill={noop}
            onAsset={noop}
            onStudio={noop}
            onScene={noop}
            onAccount={noop}
            onLibrary={noop}
            onCommunity={noop}
          />
        </WorkspaceChromeContext.Provider>
      </I18nProvider>,
    ));
    await act(async () => container.querySelector('button')!.click());
    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '做一个科技感发布会开场视频');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const aiBtn = document.querySelector<HTMLButtonElement>('.om-command-ai-btn')!;
    expect(aiBtn).not.toBeNull();
    expect(aiBtn.textContent).toContain('问 AI');
    await act(async () => aiBtn.click());
    expect(openInSuperAgent).toHaveBeenCalledWith(expect.objectContaining({
      newChat: true,
      autoSend: true,
      prompt: expect.stringContaining('做一个科技感发布会开场视频'),
    }));

    // Reopen and verify Cmd+Enter works even on zero-result query
    await act(async () => container.querySelector('button')!.click());
    const input2 = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    const palette2 = document.querySelector<HTMLElement>('.om-command-palette')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input2, '像王家卫电影一样的霓虹短片');
      input2.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      palette2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    });
    expect(openInSuperAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      newChat: true,
      autoSend: true,
      prompt: expect.stringContaining('像王家卫电影一样的霓虹短片'),
    }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('reports updated scope and position when sending a template to Super Agent after switching query and scope', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(assetRequest).mockResolvedValue({ assets: [], nextOffset: null });
  const templates: GalleryTemplate[] = [
    {
      id: 'tpl-first-promo',
      title: 'Alpha Promo',
      subtitle: 'Promo',
      description: 'First promo template.',
      collection: 'reference',
      kind: 'prism',
      hasHtmlProject: true,
      tags: ['promo'],
      duration: 10,
      ratio: '16:9',
      author: 'Studio',
    },
    {
      id: 'tpl-second-promo',
      title: 'Beta Promo',
      subtitle: 'Promo',
      description: 'Second promo template.',
      collection: 'reference',
      kind: 'prism',
      hasHtmlProject: true,
      tags: ['promo'],
      duration: 12,
      ratio: '16:9',
      author: 'Studio',
    },
  ];
  vi.mocked(useCoveredTemplates).mockReturnValue({
    catalog: templates,
    firstPage: null,
    failed: false,
    retry: vi.fn(),
  });
  const selectSpy = vi.spyOn(pageTracking, 'reportCommandPaletteSelect');
  const openInSuperAgent = vi.fn(), noop = vi.fn();
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <I18nProvider initialLocale="en">
        <WorkspaceChromeContext.Provider value={{
          openLibrary: noop,
          openInSuperAgent,
          workspace: { projects: [], open: vi.fn() },
          switchingDisabled: false,
        } as unknown as WorkspaceChrome}>
          <WorkspaceSearch
            destination={null}
            onSkill={noop}
            onAsset={noop}
            onStudio={noop}
            onScene={noop}
            onAccount={noop}
            onLibrary={noop}
            onCommunity={noop}
          />
        </WorkspaceChromeContext.Provider>
      </I18nProvider>,
    ));

    await act(async () => container.querySelector('button')!.click());
    const input = document.querySelector<HTMLInputElement>('.om-workspace-search input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'promo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const templatesTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent?.includes('Templates'))!;
    await act(async () => templatesTab.click());

    const palette = document.querySelector<HTMLElement>('.om-command-palette')!;
    const secondRow = document.querySelector<HTMLButtonElement>('[data-result-key="motion-template:tpl-second-promo"]')!;
    expect(secondRow).not.toBeNull();
    await act(async () => {
      palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    const useInAgentBtn = [...document.querySelectorAll<HTMLButtonElement>('.om-command-preview-actions button')]
      .find(btn => btn.textContent?.includes('Super Agent'))!;
    expect(useInAgentBtn).not.toBeNull();
    await act(async () => useInAgentBtn.click());

    expect(selectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'motion-template', id: 'tpl-second-promo' }),
      2,
      'templates',
      undefined,
      'use_in_super_agent',
    );
  } finally {
    selectSpy.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  }
});
