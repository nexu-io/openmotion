import { Dialog } from '@base-ui/react/dialog';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { type LibraryAsset } from '../../../shared/asset-library';
import { buildSuperAgentHandoff } from '../../../shared/capability-hub';
import { isEditableTemplate, matchesTemplateCategory, templateCategoryLabel, type GalleryTemplate } from '../../../shared/catalog';
import type { DesignScenarioId } from '../../../shared/design-project';
import { prepareSearchDocument, rankPreparedSearchResults, rankSearchResults } from '../../../shared/fuzzy-search';
import type { Modality } from '../../../shared/gateway';
import { scenarioDefinitions, type ScenarioId } from '../../../shared/scenarios';
import { creativeStudios, exploreCommunities, studioScenes, type CreativeStudio, type ExploreCommunity } from '../../../shared/studio-catalog';
import { superAgentIntentMeta, type SuperAgentChatSummary, type SuperAgentResourceAttachment } from '../../../shared/super-agent';
import { formatTemplatePrompt } from '../../../shared/template-prompts';
import { Skeleton } from '../components/ui/Skeleton';
import { Tooltip } from '../components/ui/Tooltip';
import { designClient } from '../design/designClient';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { fetchWorkspaceResources, listSuperAgentChats } from '../super-agent/superAgentClient';
import { copyTextToClipboard } from '../utils/clipboard';
import { WORKSPACE_LOCATION_CHANGED } from '../utils/workspaceHistory';
import * as tracking from './pageTracking';
import { creationKinds } from './AssetCreationVisuals';
import { WorkspaceSearchPreview } from './WorkspaceSearchPreview';
import { useOptionalWorkspaceChrome } from './WorkspaceChromeContext';
import { assetRequest } from './assetClient';
import { mediaLabels, modelDestination, sceneDestination, studioIconTone, supportsScene, type StudioDestination } from './creativeStudios';
import { ModelAvatar } from './settingsPrimitives';
import { motionSkills } from './skillCatalog';
import { prepareTemplateSearchIndex, rankTemplateSearch } from './templateSearch';
import { useCoveredTemplates } from './useCoveredTemplates';
import { useMediaCatalog } from './useMediaCatalog';
import type { DesignSceneTarget, SettingsSection } from './workspacePageRouting';
import {
  designScenarioLabel,
  formatRelativeSearchTime,
  POPULAR_SEARCH_TOPICS_EN,
  POPULAR_SEARCH_TOPICS_ZH,
  SEARCH_SCOPES,
  searchHighlightPattern,
  selectRecommendedTemplates,
  type SearchPaletteItem,
  type SearchResultGroup,
  type SearchScope,
} from './workspaceSearchTypes';
import './workspace-search.css';

function searchIcon(name: string, tone: Modality | 'agent') {
  return (
    <span className="om-creation-icon" data-tone={tone} aria-hidden="true">
      <RemixIcon name={name} size={16} />
    </span>
  );
}

function CommandThumb({ src, fallbackIcon, tone }: { src?: string; fallbackIcon: string; tone: Modality | 'agent' }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return searchIcon(fallbackIcon, tone);
  return (
    <span className="om-command-thumb" aria-hidden="true">
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </span>
  );
}

function normalizePreviewUrl(url?: string): string | undefined {
  return url ? url.replace(/^\/api\//, '/motion-api/') : undefined;
}

function highlight(text: string, pattern: RegExp | null): ReactNode {
  return pattern
    ? text.split(pattern).map((part, index) =>
        index % 2 ? <mark className="om-match-highlight" key={index}>{part}</mark> : part)
    : text;
}

const assetPageSize = 24;

function useAssetMatches(query: string, offset: number) {
  const [result, setResult] = useState<{ query: string; offset: number; assets?: LibraryAsset[]; nextOffset?: number | null }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!query) return;
    let current = true;
    const timer = window.setTimeout(async () => {
      try {
        const page = await assetRequest<{ assets: LibraryAsset[]; nextOffset: number | null }>({ action: 'list', query, offset, limit: assetPageSize });
        if (current) setResult({ query, offset, ...page });
      } catch {
        if (current) setResult({ query, offset });
      }
    }, 180);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, offset, attempt]);
  return {
    result: result?.query === query && result.offset === offset ? result : undefined,
    retry: () => {
      setResult(undefined);
      setAttempt(value => value + 1);
    },
  };
}

function AiSparkleIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="om-command-ai-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="om-ai-sparkle-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--motion-creative-agent)" />
          <stop offset="45%" stopColor="var(--motion-creative-video)" />
          <stop offset="80%" stopColor="var(--motion-creative-image)" />
          <stop offset="100%" stopColor="var(--motion-creative-audio)" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.25c.45 4.25 1.85 6.4 6.25 7.25-4.4.85-5.8 3-6.25 7.25-.45-4.25-1.85-6.4-6.25-7.25 4.4-.85 5.8-3 6.25-7.25Z"
        fill="url(#om-ai-sparkle-grad)"
      />
      <path
        d="M18.6 15.1c.22 1.75.85 2.62 2.65 2.95-1.8.33-2.43 1.2-2.65 2.95-.22-1.75-.85-2.62-2.65-2.95 1.8-.33 2.43-1.2 2.65-2.95Z"
        fill="url(#om-ai-sparkle-grad)"
      />
      <circle cx="5.2" cy="18.2" r="1.45" fill="var(--motion-creative-audio)" />
    </svg>
  );
}

function shortcutKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl+K';
  return /Mac|iP(?:hone|ad|od)/i.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl+K';
}

function submitShortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl+↵';
  return /Mac|iP(?:hone|ad|od)/i.test(navigator.platform || navigator.userAgent) ? '⌘↵' : 'Ctrl+↵';
}

function buildSemanticSearchPrompt(rawQuery: string, locale: string): string {
  const q = rawQuery.trim();
  if (locale.startsWith('zh')) {
    return `用户通过全局搜索提交了自然语言需求：“${q}”。请先理解其创作意图，调用 openmotion_workspace_resources 检索工作区内的全部动效模板、设计模板、Skills、工作流、游戏、品牌套件、资产与工作室入口，推荐最匹配的方案与对应产品入口；如果用户意图偏向直接创作，请结合最合适的模板或 Skill 直接开始生成或引导下一步。`;
  }
  return `The user submitted this natural-language query from global search: "${q}". Understand their intent, search openmotion_workspace_resources across all Motion & Design templates, Skills, workflows, games, brand kits, assets, and Studio entries, recommend the best matching resources and product entries, and offer or start creating directly when appropriate.`;
}

export type WorkspaceSearchProps = {
  onChoose?: () => void;
  onSkill: (id: string) => void;
  onScene: (scene: StudioDestination) => void;
  onStudio: (studio: CreativeStudio) => void;
  onAsset: (id: string, version: string) => void;
  onCommunity: (community: ExploreCommunity) => void;
  destination: StudioDestination | null;
  onLibrary: () => void;
  onAccount: () => void;
  onNewAgentChat?: () => void;
  onAgentChat?: (chatId: string) => void;
  onOpenDesignScene?: (scene: DesignSceneTarget) => void;
  onOpenDesignProject?: (id: string, scenario?: DesignSceneTarget) => void;
  onOpenMotionProject?: (id: string) => void;
  onOpenGame?: (gameId: string) => void;
  onOpenBrandKit?: (kitId?: string | null) => void;
  onOpenMcp?: () => void;
  onOpenSettings?: (section: SettingsSection) => void;
  onOpenScenario?: (id: ScenarioId) => void;
  onOpenScenarioHub?: () => void;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
};

export function WorkspaceSearch({
  onSkill,
  onScene,
  onStudio,
  onAsset,
  onCommunity,
  destination,
  onLibrary,
  onAccount,
  onChoose,
  onNewAgentChat,
  onAgentChat,
  onOpenDesignScene,
  onOpenDesignProject,
  onOpenMotionProject,
  onOpenGame,
  onOpenBrandKit,
  onOpenMcp,
  onOpenSettings,
  onOpenScenario,
  onOpenScenarioHub,
  onNotify,
}: WorkspaceSearchProps) {
  const { t, locale } = useI18n();
  const chrome = useOptionalWorkspaceChrome();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [committedInput, setCommittedInput] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [scope, setScope] = useState<SearchScope>('all');
  const [offset, setOffset] = useState(0);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [creatingDesign, setCreatingDesign] = useState(false);

  const [chats, setChats] = useState<SuperAgentChatSummary[]>([]);
  const [initialResources, setInitialResources] = useState<SuperAgentResourceAttachment[]>([]);
  const [queriedResources, setQueriedResources] = useState<{ query: string; locale: string; items: SuperAgentResourceAttachment[] }>();
  const [resourcesLoading, setResourcesLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const searchIdRef = useRef<string | undefined>(undefined);
  const flatItemsCountRef = useRef(0);

  const applyInputImmediate = useCallback((value: string) => {
    composingRef.current = false;
    setIsComposing(false);
    setInput(value);
    setCommittedInput(value);
    setOffset(0);
    setActiveKey(null);
  }, []);

  const rawQuery = open ? committedInput.trim() : '';
  const query = useDeferredValue(rawQuery);
  const isQueryPending = open && (isComposing || rawQuery !== query);
  const shortcutLabel = useMemo(() => shortcutKeyLabel(), []);
  const aiSubmitShortcut = useMemo(() => submitShortcutLabel(), []);
  const covered = useCoveredTemplates(locale, open, { showFirstPage: true });
  const coveredTemplates = useMemo(
    () => covered.catalog ?? covered.firstPage?.items ?? [],
    [covered.catalog, covered.firstPage],
  );
  const catalog = useMediaCatalog(Boolean(query) || (open && (scope === 'tools' || scope === 'all')));
  const assets = useAssetMatches(query, offset);

  const choose = useCallback((action: () => void) => {
    setOpen(false);
    onChoose?.();
    action();
  }, [onChoose]);

  // Global Cmd/Ctrl+K toggle (yields when inside another modal <dialog open>)
  useEffect(() => {
    if (onChoose) return;
    const onGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'k' || event.defaultPrevented) return;
      if (!open && document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (!open) tracking.reportCommandPaletteOpened('keyboard');
      setOpen(prev => !prev);
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [onChoose, open]);

  // Dismiss when navigating via URL history / router changes
  useEffect(() => {
    const closeOnNavigate = () => setOpen(false);
    window.addEventListener(WORKSPACE_LOCATION_CHANGED, closeOnNavigate);
    window.addEventListener('popstate', closeOnNavigate);
    return () => {
      window.removeEventListener(WORKSPACE_LOCATION_CHANGED, closeOnNavigate);
      window.removeEventListener('popstate', closeOnNavigate);
    };
  }, []);

  // Load Super Agent chats & initial discovery resources when opened
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listSuperAgentChats()
      .then(res => {
        if (cancelled || !Array.isArray(res?.conversations)) return;
        const sorted = [...res.conversations].sort(
          (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt,
        );
        setChats(sorted);
      })
      .catch(() => {});

    void Promise.allSettled([
      fetchWorkspaceResources({ kind: 'projects', limit: 20, locale }),
      fetchWorkspaceResources({ kind: 'design-template', limit: 20, locale }),
      fetchWorkspaceResources({ kind: 'brand-kit', limit: 16, locale }),
    ]).then(results => {
      if (cancelled) return;
      const merged: SuperAgentResourceAttachment[] = [];
      const seen = new Set<string>();
      for (const entry of results) {
        if (entry.status !== 'fulfilled' || !Array.isArray(entry.value?.items)) continue;
        for (const item of entry.value.items) {
          const key = `${item.kind}:${item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }
      }
      setInitialResources(merged);
    });

    return () => {
      cancelled = true;
    };
  }, [open, locale]);

  // Query backend multilingual workspace resource catalog when typing (debounced + abortable)
  useEffect(() => {
    if (!open || !query) {
      setResourcesLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setResourcesLoading(true);
    const timer = window.setTimeout(() => {
      void fetchWorkspaceResources({ kind: 'all', query, limit: 100, locale, signal: controller.signal })
        .then(res => {
          if (!cancelled && Array.isArray(res?.items)) {
            setQueriedResources({ query, locale, items: res.items });
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setResourcesLoading(false);
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, locale]);

  const activeQueriedResources = queriedResources?.query === query && queriedResources.locale === locale
    ? queriedResources.items
    : null;
  const resourcePool = query ? (activeQueriedResources ?? []) : initialResources;

  const providers = useMemo(
    () => new Map(catalog.catalog?.status.providers.map(provider => [provider.id, provider.label])),
    [catalog.catalog?.status.providers],
  );
  const pattern = useMemo(() => searchHighlightPattern(query), [query]);

  const designStudio = useMemo(() => creativeStudios.find(s => s.id === 'design')!, []);
  const motionStudioEntry = useMemo(() => creativeStudios.find(s => s.id === 'motion')!, []);
  const gameStudioEntry = useMemo(() => creativeStudios.find(s => s.id === 'game') ?? motionStudioEntry, [motionStudioEntry]);
  const canAskSuperAgent = Boolean(chrome?.openInSuperAgent || onNewAgentChat);

  const openNewSuperAgentChat = useCallback((prompt = '', autoSend = false) => {
    if (prompt.trim() && chrome?.openInSuperAgent) {
      chrome.openInSuperAgent({ prompt: prompt.trim(), newChat: true, autoSend });
      return;
    }
    if (onNewAgentChat) {
      onNewAgentChat();
      return;
    }
    chrome?.openInSuperAgent?.({ prompt: prompt.trim(), newChat: true, autoSend });
  }, [chrome, onNewAgentChat]);

  const submitQueryToSuperAgent = useCallback((rawText: string) => {
    const trimmed = rawText.trim();
    choose(() => {
      if (!trimmed) {
        openNewSuperAgentChat('', false);
        return;
      }
      openNewSuperAgentChat(buildSemanticSearchPrompt(trimmed, locale), true);
    });
  }, [choose, locale, openNewSuperAgentChat]);

  const allQuickActions = useMemo((): SearchPaletteItem[] => [
    {
      key: 'action:new-chat',
      id: 'new-chat',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('New Super Agent chat'),
      detail: t('Start a fresh Super Agent conversation with workspace context'),
      iconName: 'sparkling-line',
      tone: 'agent',
      searchAliases: ['Super Agent', 'AI', 'New chat', '新建对话', '对话', '智能体'],
      icon: searchIcon('sparkling-line', 'agent'),
      open: () => openNewSuperAgentChat(),
    },
    {
      key: 'action:templates',
      id: 'templates',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('Browse Motion templates'),
      detail: t('Explore editable templates and reference clips'),
      iconName: 'movie-line',
      tone: 'video',
      searchAliases: ['Motion templates', 'Templates', '模板库', '动效模板', '视频模板'],
      icon: searchIcon('movie-line', 'video'),
      open: () => chrome?.openLibrary(),
    },
    {
      key: 'action:design-studio',
      id: 'design-studio',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('Open Design Studio'),
      detail: t('Create interactive sites, apps, slides, or documents'),
      iconName: 'layout-line',
      tone: 'image',
      searchAliases: ['Design Studio', 'Website', 'App', 'Deck', 'Prototype', '设计工作室', '网页', '原型', 'PPT'],
      icon: searchIcon('layout-line', 'image'),
      open: () => onOpenDesignScene ? onOpenDesignScene('prototype') : onStudio(designStudio),
    },
    {
      key: 'action:game-studio',
      id: 'game-studio',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('Open Game Studio'),
      detail: t('Create your own game in minutes'),
      iconName: 'gamepad-line',
      tone: 'agent',
      searchAliases: ['Game Studio', 'Games', 'Playable web games', '2D', '3D', '游戏工作室', '游戏', '小游戏', '网页游戏'],
      icon: searchIcon('gamepad-line', 'agent'),
      open: () => onStudio(gameStudioEntry),
    },
    {
      key: 'action:assets',
      id: 'assets',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('Workspace assets'),
      detail: t('Browse saved images, videos, and audio files'),
      iconName: 'folder-open-line',
      tone: 'audio',
      searchAliases: ['Assets', 'Files', 'Media', '资产', '素材库', '文件'],
      icon: searchIcon('folder-open-line', 'audio'),
      open: onLibrary,
    },
    {
      key: 'action:new-motion',
      id: 'new-motion',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('New Motion project'),
      detail: t('Create an editable timeline project'),
      iconName: 'scissors-line',
      tone: 'video',
      searchAliases: ['New project', 'Motion Studio', 'Timeline', '新建项目', '时间轴', '剪辑'],
      icon: searchIcon('scissors-line', 'video'),
      open: () => {
        if (chrome && !chrome.switchingDisabled) void chrome.workspace.create();
        else onStudio(motionStudioEntry);
      },
    },
    {
      key: 'action:workflows',
      id: 'workflows',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('Start a Workflow'),
      detail: t('Run a step-by-step creation workflow'),
      iconName: 'route-line',
      tone: 'agent',
      searchAliases: ['Workflows', 'Scenario', '工作流', '流程', '主题创作'],
      icon: searchIcon('route-line', 'agent'),
      open: () => onOpenScenarioHub ? onOpenScenarioHub() : chrome?.openHome(),
    },
    {
      key: 'action:brand-kits',
      id: 'brand-kits',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('Brand Kits'),
      detail: t('Manage brand colors, fonts, and logos'),
      iconName: 'palette-line',
      tone: 'image',
      searchAliases: ['Brand Kit', 'Colors', 'Logo', 'Fonts', '品牌套件', '品牌色', '标志'],
      icon: searchIcon('palette-line', 'image'),
      open: () => onOpenBrandKit ? onOpenBrandKit(null) : onOpenSettings ? onOpenSettings('brand-kit') : onAccount(),
    },
    {
      key: 'action:mcp',
      id: 'mcp',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('Connect MCP Agent'),
      detail: t('Configure Claude Code, Codex, DeepSeek, or MCP clients'),
      iconName: 'plug-line',
      tone: 'agent',
      searchAliases: ['MCP', 'Claude Code', 'Codex', 'DeepSeek', '连接', '客户端'],
      icon: searchIcon('plug-line', 'agent'),
      open: () => onOpenMcp ? onOpenMcp() : chrome?.openConnections('app_header'),
    },
    {
      key: 'action:providers',
      id: 'providers',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('Model providers'),
      detail: t('Configure AI image, video, and audio providers'),
      iconName: 'robot-line',
      tone: 'video',
      searchAliases: ['Model providers', 'API Key', 'BYOK', '模型供应商', '模型配置'],
      icon: searchIcon('robot-line', 'video'),
      open: () => onOpenSettings ? onOpenSettings('providers') : chrome?.openModelSettings(),
    },
    {
      key: 'action:account',
      id: 'account',
      kind: 'action',
      scope: 'actions',
      group: 'Quick actions',
      label: t('Account'),
      detail: t('Manage your profile, preferences, and workspace'),
      iconName: 'user-3-line',
      tone: 'agent',
      searchAliases: ['Account', 'Settings', 'Preferences', '账户', '设置', '偏好'],
      icon: searchIcon('user-3-line', 'agent'),
      open: onAccount,
    },
  ], [
    t,
    openNewSuperAgentChat,
    chrome,
    onOpenDesignScene,
    onStudio,
    designStudio,
    gameStudioEntry,
    motionStudioEntry,
    onOpenScenarioHub,
    onLibrary,
    onOpenBrandKit,
    onOpenSettings,
    onAccount,
    onOpenMcp,
  ]);

  const toMotionTemplateItem = useCallback((template: GalleryTemplate, groupTitle: string): SearchPaletteItem => {
    const editable = isEditableTemplate(template);
    const categoryLabel = template.collection ? templateCategoryLabel(template) : '';
    const metaParts = [
      template.duration != null ? `${Number(template.duration.toFixed(1))}s` : '',
      template.ratio ?? '',
    ].filter(Boolean);
    return {
      key: `motion-template:${template.id}`,
      id: template.id,
      kind: 'motion-template',
      scope: 'templates',
      group: groupTitle,
      label: template.title,
      detail: template.authorName || template.author || (categoryLabel ? t(categoryLabel) : undefined),
      description: template.description,
      badge: t(editable ? 'Editable project' : 'Reference creation'),
      meta: metaParts.join(' · ') || undefined,
      thumbUrl: normalizePreviewUrl(template.posterUrl),
      tags: template.tags ?? [],
      template,
      icon: <CommandThumb key={template.posterUrl || template.id} src={normalizePreviewUrl(template.posterUrl)} fallbackIcon="film-line" tone="video" />,
      open: () => chrome?.openLibrary(undefined, template),
    };
  }, [chrome, t]);

  const toChatItem = useCallback((chat: SuperAgentChatSummary): SearchPaletteItem => {
    const intent = superAgentIntentMeta(chat.intent);
    const tone = intent.tone === 'coding' || intent.tone === 'neutral' ? 'agent' : intent.tone;
    return {
      key: `chat:${chat.id}`,
      id: chat.id,
      kind: 'chat',
      scope: 'chats',
      group: 'Super Agent chats',
      label: chat.title,
      detail: `${t(intent.label)} · ${t('{count} messages', { count: chat.messageCount })}`,
      badge: chat.pinned ? t('Pinned chat') : undefined,
      meta: formatRelativeSearchTime(chat.updatedAt, t),
      pinned: chat.pinned,
      chat,
      icon: searchIcon(intent.icon, tone),
      open: () => {
        if (onAgentChat) onAgentChat(chat.id);
        else chrome?.openInSuperAgent?.({ prompt: '', newChat: false });
      },
    };
  }, [t, onAgentChat, chrome]);

  const toResourceItem = useCallback((resource: SuperAgentResourceAttachment): SearchPaletteItem | null => {
    if (resource.kind === 'design-template') {
      const scenario = (resource.scenario as DesignSceneTarget | undefined) ?? 'prototype';
      const scenarioLabel = resource.scenario ? t(designScenarioLabel(resource.scenario)) : '';
      const categorySuffix = resource.subtitle?.includes(' · ')
        ? resource.subtitle.split(' · ').slice(1).join(' · ')
        : (resource.subtitle && resource.subtitle !== resource.scenario ? resource.subtitle : '');
      return {
        key: `design-template:${resource.id}`,
        id: resource.id,
        kind: 'design-template',
        scope: 'templates',
        group: 'Design templates',
        label: resource.title,
        detail: [scenarioLabel, categorySuffix].filter(Boolean).join(' · ') || t('Design Studio'),
        tags: resource.tags,
        resource,
        icon: searchIcon('layout-line', 'image'),
        open: () => onOpenDesignScene ? onOpenDesignScene(scenario) : onStudio(designStudio),
      };
    }
    if (resource.kind === 'design-project') {
      const scenario = (resource.scenario as DesignSceneTarget | undefined) ?? 'projects';
      const projectScenario = resource.scenario || resource.subtitle;
      return {
        key: `design-project:${resource.id}`,
        id: resource.id,
        kind: 'design-project',
        scope: 'files',
        group: 'Projects',
        label: resource.title,
        detail: projectScenario ? `${t('Design Studio')} · ${t(designScenarioLabel(projectScenario))}` : t('Design Studio'),
        resource,
        icon: searchIcon('layout-2-line', 'image'),
        open: () => onOpenDesignProject
          ? onOpenDesignProject(resource.id, scenario)
          : onOpenDesignScene?.('projects'),
      };
    }
    if (resource.kind === 'motion-project') {
      return {
        key: `motion-project:${resource.id}`,
        id: resource.id,
        kind: 'motion-project',
        scope: 'files',
        group: 'Projects',
        label: resource.title,
        detail: resource.subtitle || t('Motion Studio'),
        motionProject: { id: resource.id, title: resource.title },
        resource,
        icon: searchIcon('clapperboard-line', 'video'),
        open: () => {
          if (onOpenMotionProject) onOpenMotionProject(resource.id);
          else if (chrome && !chrome.switchingDisabled) void chrome.workspace.open('projects', resource.id);
        },
      };
    }
    if (resource.kind === 'game-project') {
      const thumb = normalizePreviewUrl(resource.previewUrl);
      return {
        key: `game-project:${resource.id}`,
        id: resource.id,
        kind: 'game-project',
        scope: 'files',
        group: 'Games',
        label: resource.title,
        detail: resource.subtitle || t('Games'),
        thumbUrl: thumb,
        tags: resource.tags,
        resource,
        icon: searchIcon('gamepad-line', 'agent'),
        open: () => onOpenGame
          ? onOpenGame(resource.id)
          : onStudio(creativeStudios.find(s => s.id === 'game') ?? motionStudioEntry),
      };
    }
    if (resource.kind === 'brand-kit') {
      const thumb = normalizePreviewUrl(resource.previewUrl);
      return {
        key: `brand-kit:${resource.id}`,
        id: resource.id,
        kind: 'brand-kit',
        scope: 'files',
        group: 'Brand Kits',
        label: resource.title,
        detail: resource.subtitle || t('Brand Kit'),
        thumbUrl: thumb,
        swatches: resource.swatches,
        tags: resource.tags,
        resource,
        icon: searchIcon('palette-line', 'image'),
        open: () => onOpenBrandKit
          ? onOpenBrandKit(resource.id.startsWith('catalog:') ? null : resource.id)
          : onOpenSettings?.('brand-kit'),
      };
    }
    if (resource.kind === 'design-skill') {
      return {
        key: `design-skill:${resource.id}`,
        id: resource.id,
        kind: 'design-skill',
        scope: 'tools',
        group: 'Skills',
        label: resource.title,
        detail: resource.subtitle || t('Design Studio'),
        tags: resource.tags,
        resource,
        icon: searchIcon('sparkling-line', 'image'),
        open: () => onOpenDesignScene
          ? onOpenDesignScene((resource.scenario as DesignScenarioId | undefined) ?? 'prototype')
          : onStudio(designStudio),
      };
    }
    return null;
  }, [
    t,
    onOpenDesignScene,
    onStudio,
    designStudio,
    onOpenDesignProject,
    onOpenMotionProject,
    chrome,
    onOpenGame,
    motionStudioEntry,
    onOpenBrandKit,
    onOpenSettings,
  ]);

  const indexedQuickActions = useMemo(
    () => allQuickActions.map(action => ({
      item: action,
      doc: prepareSearchDocument({
        id: action.id,
        title: action.label,
        subtitle: action.detail,
        tags: action.tags,
        aliases: action.searchAliases,
      }),
    })),
    [allQuickActions],
  );

  const indexedChats = useMemo(
    () => chats.map(chat => ({
      item: chat,
      doc: prepareSearchDocument({
        id: chat.id,
        title: chat.title,
        subtitle: superAgentIntentMeta(chat.intent).label,
        tags: [t(superAgentIntentMeta(chat.intent).label), chat.engine, 'super agent', 'chat', '对话'],
      }),
    })),
    [chats, t],
  );

  const indexedTemplates = useMemo(
    () => prepareTemplateSearchIndex(coveredTemplates, t),
    [coveredTemplates, t],
  );

  const indexedStudios = useMemo(
    () => creativeStudios.map(studio => ({
      item: studio,
      doc: prepareSearchDocument({
        id: studio.id,
        title: t(studio.title),
        aliases: [studio.title, studio.id],
      }),
    })),
    [t],
  );

  const indexedCommunities = useMemo(
    () => exploreCommunities.map(feed => ({
      item: feed,
      doc: prepareSearchDocument({
        id: feed.id,
        title: t(feed.label),
        aliases: [feed.label, feed.id],
      }),
    })),
    [t],
  );

  const indexedScenes = useMemo(
    () => studioScenes.map(scene => ({
      item: scene,
      doc: prepareSearchDocument({
        id: scene.id,
        title: t(scene.label),
        subtitle: t(mediaLabels[scene.modality]),
        description: t(scene.hint),
        aliases: [scene.label, scene.hint, scene.modality, mediaLabels[scene.modality]],
      }),
    })),
    [t],
  );

  const indexedWorkflows = useMemo(
    () => scenarioDefinitions.map(wf => ({
      item: wf,
      doc: prepareSearchDocument({
        id: wf.id,
        title: t(wf.title),
        subtitle: t(wf.subtitle),
        tags: [wf.category, t(wf.category), ...wf.steps.map(step => step.title)],
        aliases: [wf.title, wf.subtitle],
      }),
    })),
    [t],
  );

  const indexedSkills = useMemo(
    () => motionSkills.map(skill => ({
      item: skill,
      doc: prepareSearchDocument({
        id: skill.id,
        title: t(skill.title),
        subtitle: t(skill.category),
        description: t(skill.useWhen),
        tags: [skill.category, skill.technique, skill.name],
        aliases: [skill.title, skill.tagline, t(skill.tagline)],
      }),
    })),
    [t],
  );

  const indexedModels = useMemo(() => {
    const supported = (catalog.catalog?.models ?? []).filter(model =>
      studioScenes.some(scene => supportsScene(model, scene)),
    );
    return supported.map(model => {
      const providerLabel = providers.get(model.provider) ?? model.provider;
      return {
        item: model,
        doc: prepareSearchDocument({
          id: model.id,
          title: model.label,
          subtitle: providerLabel,
          tags: [model.modality, model.mode, t(mediaLabels[model.modality])],
          aliases: [model.modelId, model.provider],
          description: model.description,
        }),
      };
    });
  }, [catalog.catalog?.models, providers, t]);

  const { groups, scopeCounts } = useMemo(() => {
    const quickActionMatches = query
      ? rankPreparedSearchResults(indexedQuickActions, query).map(({ item }) => item)
      : scope === 'actions' ? allQuickActions : allQuickActions.slice(0, 5);

    const chatMatches = query
      ? rankPreparedSearchResults(indexedChats, query).map(({ item }) => toChatItem(item))
      : (scope === 'chats' ? chats : chats.slice(0, 3)).map(toChatItem);

    const rankedMotionTemplates = query ? rankTemplateSearch(indexedTemplates, query) : [];
    const motionTemplateItems = query
      ? rankedMotionTemplates
          .slice(0, 24)
          .map(({ item }) => toMotionTemplateItem(item, 'Motion templates'))
      : (scope === 'templates'
          ? coveredTemplates.filter(item => matchesTemplateCategory(item, 'featured') || isEditableTemplate(item)).slice(0, 24)
          : selectRecommendedTemplates(coveredTemplates, 6)
        ).map(template => toMotionTemplateItem(template, scope === 'templates' ? 'Motion templates' : 'Recommended templates'));

    const designTemplateItems = resourcePool
      .filter(item => item.kind === 'design-template')
      .slice(0, scope === 'templates' || query ? 20 : 4)
      .map(toResourceItem)
      .filter((item): item is SearchPaletteItem => Boolean(item));

    const projectItems: SearchPaletteItem[] = [];
    const seenProjectKeys = new Set<string>();
    const addProjectItem = (item: SearchPaletteItem | null) => {
      if (!item || seenProjectKeys.has(item.key)) return;
      seenProjectKeys.add(item.key);
      projectItems.push(item);
    };
    // Include live Motion projects from WorkspaceChrome when available
    if (chrome?.workspace.projects.length) {
      const localMotion = query
        ? rankSearchResults(chrome.workspace.projects, query, project => ({ id: project.id, title: project.title, extra: ['motion project', '项目'] })).map(r => r.item)
        : chrome.workspace.projects;
      for (const proj of localMotion) {
        addProjectItem({
          key: `motion-project:${proj.id}`,
          id: proj.id,
          kind: 'motion-project',
          scope: 'files',
          group: 'Projects',
          label: proj.title,
          detail: t('Motion Studio'),
          motionProject: { id: proj.id, title: proj.title },
          icon: searchIcon('clapperboard-line', 'video'),
          open: () => {
            if (onOpenMotionProject) onOpenMotionProject(proj.id);
            else if (!chrome.switchingDisabled) void chrome.workspace.open('projects', proj.id);
          },
        });
      }
    }
    for (const res of resourcePool) {
      if (res.kind === 'design-project' || res.kind === 'motion-project') {
        addProjectItem(toResourceItem(res));
      }
    }

    const gameItems = resourcePool
      .filter(item => item.kind === 'game-project')
      .slice(0, scope === 'files' ? 16 : 6)
      .map(toResourceItem)
      .filter((item): item is SearchPaletteItem => Boolean(item));

    const brandKitItems = resourcePool
      .filter(item => item.kind === 'brand-kit')
      .slice(0, scope === 'files' ? 16 : 5)
      .map(toResourceItem)
      .filter((item): item is SearchPaletteItem => Boolean(item));

    const assetItems: SearchPaletteItem[] = (assets.result?.assets ?? []).map(asset => ({
      key: `asset:${asset.id}:${asset.currentVersionId}`,
      id: asset.id,
      kind: 'asset',
      scope: 'files',
      group: 'Workspace assets',
      label: asset.name,
      detail: t(mediaLabels[asset.modality]),
      modality: asset.modality,
      asset,
      icon: searchIcon(creationKinds.find(kind => kind.id === asset.modality)!.icon, asset.modality),
      open: () => onAsset(asset.id, asset.currentVersionId),
    }));

    const studioItems: SearchPaletteItem[] = (query
      ? rankPreparedSearchResults(indexedStudios, query).map(({ item }) => item)
      : creativeStudios
    ).map(studio => ({
      key: `studio:${studio.id}`,
      id: studio.id,
      kind: 'studio',
      scope: 'studios',
      group: 'Studios',
      // Exact ariaLabel & no detail ensures textContent equals strictly t(studio.title)
      ariaLabel: t(studio.title),
      label: t(studio.title),
      studio,
      icon: searchIcon(studio.icon, studioIconTone(studio)),
      open: () => onStudio(studio),
    }));

    const communityItems: SearchPaletteItem[] = (query
      ? rankPreparedSearchResults(indexedCommunities, query).map(({ item }) => item)
      : exploreCommunities
    ).map(feed => ({
      key: `community:${feed.id}`,
      id: feed.id,
      kind: 'community',
      scope: 'studios',
      group: 'Communities',
      // Keep exact localized label for existing Explore collection navigation tests
      ariaLabel: t(feed.label),
      label: t(feed.label),
      community: feed,
      icon: searchIcon('apps-2-line', 'video'),
      open: () => onCommunity(feed),
    }));

    const sceneItems: SearchPaletteItem[] = (query || scope === 'studios')
      ? (query ? rankPreparedSearchResults(indexedScenes, query).map(({ item }) => item) : studioScenes).map(scene => ({
          key: `scene:${scene.id}`,
          id: scene.id,
          kind: 'scene',
          scope: 'studios',
          group: 'Scenes',
          label: t(scene.label),
          detail: t(mediaLabels[scene.modality]),
          description: t(scene.hint),
          scene,
          icon: searchIcon(scene.icon, scene.modality),
          open: () => onScene(sceneDestination(scene, destination)),
        }))
      : [];

    const workflowItems: SearchPaletteItem[] = (
      query
        ? rankPreparedSearchResults(indexedWorkflows, query).map(({ item }) => item)
        : scope === 'tools' ? scenarioDefinitions : scenarioDefinitions.slice(0, 4)
    ).map(wf => ({
      key: `workflow:${wf.id}`,
      id: wf.id,
      kind: 'workflow',
      scope: 'tools',
      group: 'Workflows',
      label: t(wf.title),
      detail: t(wf.subtitle),
      description: t(wf.subtitle),
      meta: t('{count} steps', { count: wf.steps.length }),
      badge: t('Workflows'),
      workflow: wf,
      icon: searchIcon(wf.icon, 'agent'),
      open: () => onOpenScenario ? onOpenScenario(wf.id) : onOpenScenarioHub?.(),
    }));

    const rankedSkills = query ? rankPreparedSearchResults(indexedSkills, query) : [];
    const skillItems: SearchPaletteItem[] = (query || scope === 'tools')
      ? (query ? rankedSkills.map(({ item }) => item) : motionSkills).map(skill => ({
          key: `skill:${skill.id}`,
          id: skill.id,
          kind: 'skill',
          scope: 'tools',
          group: 'Skills',
          label: t(skill.title),
          detail: t(skill.category),
          description: t(skill.useWhen),
          badge: 'Skill',
          tags: [skill.category, skill.technique],
          skill,
          icon: searchIcon('puzzle-line', 'agent'),
          open: () => onSkill(skill.id),
        }))
      : [];

    const designSkillItems = resourcePool
      .filter(item => item.kind === 'design-skill')
      .map(toResourceItem)
      .filter((item): item is SearchPaletteItem => Boolean(item));

    const modelItems: SearchPaletteItem[] = (query || scope === 'tools')
      ? (query ? rankPreparedSearchResults(indexedModels, query).map(({ item }) => item) : indexedModels.map(({ item }) => item)).map(model => {
          const providerLabel = providers.get(model.provider) ?? model.provider;
          return {
            key: `model:${model.id}`,
            id: model.id,
            kind: 'model',
            scope: 'tools',
            group: 'Models',
            label: model.label,
            detail: providerLabel,
            description: model.description,
            modality: model.modality,
            ariaLabel: [model.label, providerLabel, t(mediaLabels[model.modality])].filter(Boolean).join(', '),
            model,
            providerLabel,
            icon: (
              <ModelAvatar
                name={model.label}
                modelId={model.modelId}
                provider={{ id: model.provider, custom: false }}
              />
            ),
            open: () => onScene(modelDestination(model, destination)),
          };
        })
      : [];

    const promoteSkills = Boolean(
      query
      && rankedSkills.length > 0
      && (rankedMotionTemplates.length === 0 || rankedSkills[0].score > rankedMotionTemplates[0].score * 1.35),
    );
    const skillsGroup: SearchResultGroup = { id: 'skills', title: 'Skills', ariaLabel: t('Skills'), items: [...skillItems, ...designSkillItems] };
    const allGroups: SearchResultGroup[] = [
      { id: 'quick-actions', title: 'Quick actions', ariaLabel: t('Quick actions'), items: quickActionMatches },
      { id: 'chats', title: 'Super Agent chats', ariaLabel: t('Super Agent chats'), items: chatMatches },
      ...(promoteSkills ? [skillsGroup] : []),
      { id: 'motion-templates', title: scope === 'templates' || query ? 'Motion templates' : 'Recommended templates', ariaLabel: t(scope === 'templates' || query ? 'Motion templates' : 'Recommended templates'), items: motionTemplateItems },
      { id: 'design-templates', title: 'Design templates', ariaLabel: t('Design templates'), items: designTemplateItems },
      { id: 'projects', title: 'Projects', ariaLabel: t('Projects'), items: query ? projectItems : projectItems.slice(0, scope === 'files' ? 20 : 5) },
      { id: 'games', title: 'Games', ariaLabel: t('Games'), items: gameItems },
      { id: 'brand-kits', title: 'Brand Kits', ariaLabel: t('Brand Kits'), items: brandKitItems },
      { id: 'assets', title: 'Workspace assets', ariaLabel: t('Workspace assets'), items: assetItems },
      { id: 'studios', title: 'Studios', ariaLabel: t('Studios'), items: studioItems },
      { id: 'communities', title: 'Communities', ariaLabel: t('Communities'), items: communityItems },
      { id: 'scenes', title: 'Scenes', ariaLabel: t('Scenes'), items: sceneItems },
      { id: 'workflows', title: 'Workflows', ariaLabel: t('Workflows'), items: workflowItems },
      ...(!promoteSkills ? [skillsGroup] : []),
      { id: 'models', title: 'Models', ariaLabel: t('Models'), items: modelItems },
    ];

    const counts: Record<SearchScope, number> = {
      all: 0,
      actions: 0,
      chats: 0,
      templates: 0,
      studios: 0,
      files: 0,
      tools: 0,
    };
    for (const group of allGroups) {
      for (const item of group.items) {
        counts.all += 1;
        counts[item.scope] += 1;
      }
    }

    const filteredGroups = allGroups
      .map(group => ({
        ...group,
        items: scope === 'all' ? group.items : group.items.filter(item => item.scope === scope),
      }))
      .filter(group => group.items.length > 0);

    return { groups: filteredGroups, scopeCounts: counts };
  }, [
    allQuickActions,
    assets.result?.assets,
    chats,
    chrome,
    coveredTemplates,
    destination,
    indexedChats,
    indexedCommunities,
    indexedModels,
    indexedQuickActions,
    indexedScenes,
    indexedSkills,
    indexedStudios,
    indexedTemplates,
    indexedWorkflows,
    onAsset,
    onCommunity,
    onOpenMotionProject,
    onOpenScenario,
    onOpenScenarioHub,
    onScene,
    onSkill,
    onStudio,
    providers,
    query,
    resourcePool,
    scope,
    t,
    toChatItem,
    toMotionTemplateItem,
    toResourceItem,
  ]);

  const flatItems = useMemo(() => groups.flatMap(group => group.items), [groups]);
  flatItemsCountRef.current = flatItems.length;
  const activeItem = useMemo(
    () => flatItems.find(item => item.key === activeKey) ?? flatItems[0] ?? null,
    [flatItems, activeKey],
  );

  // One settled search event per Cmd+K query (500ms after typing stops).
  useEffect(() => {
    searchIdRef.current = undefined;
    if (!open || !query) return;
    const timer = window.setTimeout(() => {
      const id = tracking.newTrackingId();
      searchIdRef.current = id;
      tracking.reportCommandPaletteSearch(id, query, flatItemsCountRef.current, scope);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [open, query, scope, locale]);

  // Scroll highlighted row into view when using keyboard navigation
  useEffect(() => {
    if (!open || !activeKey) return;
    const container = resultsRef.current;
    if (!container) return;
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(activeKey) : activeKey.replace(/"/g, '\\"');
    const row = container.querySelector<HTMLElement>(`[data-result-key="${escaped}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeKey]);

  const loading = Boolean(query && ((!catalog.catalog && !catalog.failed) || !assets.result || resourcesLoading));
  const isSearching = Boolean(isQueryPending || loading);
  const popularTopics = locale.startsWith('zh') ? POPULAR_SEARCH_TOPICS_ZH : POPULAR_SEARCH_TOPICS_EN;

  const notify = useCallback((msg: string, tone: 'info' | 'error' = 'info') => {
    onNotify?.(msg, tone);
  }, [onNotify]);

  const positionOf = useCallback(
    (key: string) => Math.max(1, flatItems.findIndex(entry => entry.key === key) + 1),
    [flatItems],
  );

  const openResultItem = useCallback((item: SearchPaletteItem, method: 'pointer' | 'keyboard') => {
    tracking.reportCommandPaletteSelect(item, positionOf(item.key), scope, searchIdRef.current, 'open', method);
    choose(item.open);
  }, [choose, positionOf, scope]);

  const handleEditTemplate = useCallback((template: GalleryTemplate) => {
    if (!chrome || chrome.switchingDisabled) return;
    tracking.reportCommandPaletteSelect({ kind: 'motion-template', id: template.id }, positionOf(`motion-template:${template.id}`), scope, searchIdRef.current, 'edit_template');
    choose(() => {
      void chrome.workspace.open('templates', template.id);
    });
  }, [chrome, choose, positionOf, scope]);

  const handleCopyTemplatePrompt = useCallback(async (template: GalleryTemplate) => {
    tracking.reportCommandPaletteSelect({ kind: 'motion-template', id: template.id }, positionOf(`motion-template:${template.id}`), scope, searchIdRef.current, 'copy_prompt');
    const prompt = formatTemplatePrompt(template, locale);
    const ok = await copyTextToClipboard(prompt);
    if (ok) notify(t('Prompt copied'), 'info');
    else notify(t('Could not copy to clipboard'), 'error');
  }, [locale, notify, positionOf, scope, t]);

  const handleCreateDesignFromTemplate = useCallback(async (resource: SuperAgentResourceAttachment) => {
    if (creatingDesign) return;
    tracking.reportCommandPaletteSelect({ kind: 'design-template', id: resource.id }, positionOf(`design-template:${resource.id}`), scope, searchIdRef.current, 'create_design');
    setCreatingDesign(true);
    try {
      const scenario: DesignScenarioId = resource.scenario && resource.scenario !== 'projects'
        ? (resource.scenario as DesignScenarioId)
        : 'prototype';
      const created = await designClient.createProject({
        scenario,
        templateId: resource.id,
        title: resource.title,
      });
      choose(() => {
        if (onOpenDesignProject) onOpenDesignProject(created.project.id, created.project.scenario);
        else onOpenDesignScene?.('projects');
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : t('Could not create project'), 'error');
    } finally {
      setCreatingDesign(false);
    }
  }, [creatingDesign, choose, onOpenDesignProject, onOpenDesignScene, notify, positionOf, scope, t]);

  const handleUseInSuperAgent = useCallback((item: SearchPaletteItem) => {
    tracking.reportCommandPaletteSelect(item, positionOf(item.key), scope, searchIdRef.current, 'use_in_super_agent');
    let ref: Parameters<typeof buildSuperAgentHandoff>[0] | null = null;
    if (item.kind === 'motion-template' && item.template) {
      ref = {
        kind: 'motion-template',
        id: item.template.id,
        title: item.template.title,
        subtitle: item.template.subtitle,
        previewUrl: item.template.posterUrl,
        workflow: isEditableTemplate(item.template) ? 'template' : 'recreate',
        tags: item.template.tags,
      };
    } else if (item.kind === 'design-template' && item.resource) {
      ref = {
        kind: 'design-template',
        id: item.resource.id,
        title: item.resource.title,
        subtitle: item.resource.subtitle,
        scenario: item.resource.scenario,
        previewUrl: item.resource.previewUrl,
        tags: item.resource.tags,
      };
    } else if (item.kind === 'brand-kit' && item.resource) {
      ref = {
        kind: 'brand-kit',
        id: item.resource.id,
        title: item.resource.title,
        subtitle: item.resource.subtitle,
        swatches: item.resource.swatches,
        catalog: item.resource.id.startsWith('catalog:'),
      };
    } else if (item.kind === 'asset' && item.asset) {
      ref = {
        kind: 'asset',
        id: item.asset.id,
        title: item.asset.name,
        modality: item.asset.modality,
        versionId: item.asset.currentVersionId,
      };
    } else if (item.kind === 'workflow' && item.workflow) {
      ref = {
        kind: 'workflow',
        id: item.workflow.id,
        title: t(item.workflow.title),
        subtitle: t(item.workflow.subtitle),
        category: item.workflow.category,
      };
    } else if (item.kind === 'skill' && item.skill) {
      ref = {
        kind: 'skill',
        id: item.skill.id,
        title: t(item.skill.title),
        subtitle: t(item.skill.category),
      };
    } else if (item.kind === 'design-skill' && item.resource) {
      ref = {
        kind: 'design-skill',
        id: item.resource.id,
        title: item.resource.title,
        subtitle: item.resource.subtitle,
        scenario: item.resource.scenario,
      };
    } else if (item.kind === 'model' && item.model) {
      ref = {
        kind: 'model',
        id: item.model.id,
        title: item.model.label,
        provider: item.model.provider,
        modelId: item.model.modelId,
        modality: item.model.modality,
        description: item.model.description,
        mode: item.model.mode,
      };
    } else if (item.kind === 'game-project' && item.resource) {
      ref = {
        kind: 'game-project',
        id: item.resource.id,
        title: item.resource.title,
        subtitle: item.resource.subtitle,
        coverUrl: item.resource.previewUrl,
      };
    } else if (item.kind === 'motion-project' && item.motionProject) {
      choose(() => {
        openNewSuperAgentChat(`Open Motion Studio project "${item.motionProject!.title}" (${item.motionProject!.id}) and help me edit or refine it.`);
      });
      return;
    } else if (item.kind === 'design-project' && item.resource) {
      choose(() => {
        openNewSuperAgentChat(`Inspect Design Studio project "${item.resource!.title}" (${item.resource!.id}) and help me iterate on it.`);
      });
      return;
    }

    if (!ref) return;
    const payload = buildSuperAgentHandoff(ref, { locale, newChat: true, autoSend: false });
    choose(() => {
      if (chrome?.openInSuperAgent) chrome.openInSuperAgent(payload);
      else openNewSuperAgentChat(payload.prompt);
    });
  }, [chrome, choose, locale, openNewSuperAgentChat, positionOf, scope, t]);

  const handlePaletteKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
      event.stopPropagation();
    }
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canAskSuperAgent) {
      event.preventDefault();
      submitQueryToSuperAgent(input);
      return;
    }
    if (!flatItems.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const currentIndex = activeItem ? flatItems.findIndex(item => item.key === activeItem.key) : -1;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (currentIndex + delta + flatItems.length) % flatItems.length;
      setActiveKey(flatItems[nextIndex].key);
      return;
    }
    if (event.key === 'Enter' && activeItem && document.activeElement === inputRef.current) {
      event.preventDefault();
      openResultItem(activeItem, 'keyboard');
    }
  };

  const triggerButton = (
    <Button
      variant="plain"
      type="button"
      onClick={() => {
        tracking.reportCommandPaletteOpened('pointer');
        setOpen(true);
      }}
      className={onChoose ? 'om-nav-item om-workspace-search-trigger' : 'om-nav-item om-workspace-search-trigger om-header-icon'}
      aria-label={t('Search workspace')}
    >
      <RemixIcon name="search-line" size={17} />
      {onChoose && t('Search workspace')}
    </Button>
  );

  return (
    <>
      {onChoose ? triggerButton : (
        <Tooltip label={`${t('Search workspace')} (${shortcutLabel})`}>
          {triggerButton}
        </Tooltip>
      )}

      <Dialog.Root
        open={open}
        onOpenChange={nextOpen => {
          setOpen(nextOpen);
          if (!nextOpen) setActiveKey(null);
        }}
      >
        {open && <Dialog.Portal>
          <Dialog.Backdrop className="hf-overlay-backdrop om-command-backdrop" />
          <Dialog.Popup
            aria-label={t('Search workspace')}
            className="om-dialog om-workspace-search om-command-palette"
            onKeyDown={handlePaletteKeyDown}
          >
            <div className="om-command-header" data-searching={isSearching || undefined}>
              <RemixIcon
                className={isSearching ? 'om-command-search-icon om-command-spin' : 'om-command-search-icon'}
                name={isSearching ? 'loader-4-line' : 'search-line'}
                size={18}
              />
              <input
                ref={inputRef}
                autoFocus
                type="search"
                maxLength={180}
                value={input}
                onCompositionStart={() => {
                  composingRef.current = true;
                  setIsComposing(true);
                }}
                onCompositionEnd={event => {
                  const next = event.currentTarget.value;
                  composingRef.current = false;
                  setIsComposing(false);
                  setInput(next);
                  setCommittedInput(next);
                  setOffset(0);
                  setActiveKey(null);
                }}
                onChange={event => {
                  const next = event.target.value;
                  setInput(next);
                  if (!composingRef.current && !(event.nativeEvent as InputEvent).isComposing) {
                    setCommittedInput(next);
                    setOffset(0);
                    setActiveKey(null);
                  }
                }}
                placeholder={t('Search templates, Super Agent chats, actions, files…')}
                aria-label={t('Search workspace')}
                className="om-command-input"
              />
              <div className="om-command-header-actions">
                {input && (
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('Clear query')}
                    onClick={() => {
                      applyInputImmediate('');
                      inputRef.current?.focus();
                    }}
                    icon={<RemixIcon name="close-line" size={14} />}
                  />
                )}
                {canAskSuperAgent && (
                  <Tooltip label={t('Submit query to Super Agent for semantic search, recommendations, and creation')}>
                    <Button
                      variant="plain"
                      type="button"
                      size="sm"
                      className="om-command-ai-btn"
                      data-has-query={Boolean(input.trim()) || undefined}
                      onClick={() => submitQueryToSuperAgent(input)}
                    >
                      <AiSparkleIcon size={15} />
                      <span className="om-command-ai-label">{t('Ask AI')}</span>
                      <kbd className="om-command-ai-kbd" aria-hidden="true">{aiSubmitShortcut}</kbd>
                    </Button>
                  </Tooltip>
                )}
                <kbd className="om-command-kbd" aria-hidden="true">Esc</kbd>
              </div>
              {isSearching && <span className="om-command-progress" aria-hidden="true" />}
            </div>

            <div className="om-command-body">
              <div
                ref={resultsRef}
                className="om-search-results"
                aria-busy={isSearching}
                data-stale={isQueryPending || undefined}
              >
                {groups.map(group => (
                  <section key={group.id} aria-label={group.ariaLabel}>
                    <h2 className="om-eyebrow">{t(group.title)}</h2>
                    {group.items.map(row => {
                      const isRowActive = activeItem?.key === row.key;
                      const isExactSimpleRow = row.kind === 'studio' || row.kind === 'community';
                      return (
                        <Button
                          variant="plain"
                          type="button"
                          className="om-nav-item om-command-row"
                          key={row.key}
                          data-result-key={row.key}
                          data-active={isRowActive || undefined}
                          aria-label={row.ariaLabel ?? [row.label, row.detail, row.modality && t(mediaLabels[row.modality])].filter(Boolean).join(', ')}
                          onMouseEnter={() => setActiveKey(row.key)}
                          onFocus={() => setActiveKey(row.key)}
                          onClick={() => openResultItem(row, 'pointer')}
                        >
                          {row.icon}
                          <span className="om-search-result-copy">
                            <strong>{highlight(row.label, pattern)}</strong>
                            {!isExactSimpleRow && row.detail && (
                              <small className="om-muted">{highlight(row.detail, pattern)}</small>
                            )}
                          </span>
                          {row.meta && !isExactSimpleRow && (
                            <span className="om-command-row-meta">{row.meta}</span>
                          )}
                          {row.modality && (
                            <span className="om-badge" data-tone={row.modality}>{t(mediaLabels[row.modality])}</span>
                          )}
                        </Button>
                      );
                    })}
                  </section>
                ))}

                {loading && groups.length === 0 ? (
                  <div className="om-command-skeleton-list" aria-hidden="true">
                    <Skeleton className="om-command-skeleton-row" />
                    <Skeleton className="om-command-skeleton-row" />
                    <Skeleton className="om-command-skeleton-row" />
                  </div>
                ) : loading ? (
                  <Skeleton className="om-creative-model-skeleton" />
                ) : null}

                {query && (catalog.failed || (assets.result && !assets.result.assets)) && (
                  <div className="om-command-retry-bar">
                    {catalog.failed && (
                      <Button type="button" variant="ghost" className="om-button" onClick={catalog.retry}>
                        {t('Retry loading models')}
                      </Button>
                    )}
                    {assets.result && !assets.result.assets && (
                      <Button type="button" variant="ghost" className="om-button" onClick={assets.retry}>
                        {t('Retry loading assets')}
                      </Button>
                    )}
                  </div>
                )}

                {query && (offset > 0 || assets.result?.nextOffset != null) && (
                  <div className="om-asset-pagination">
                    <Button
                      type="button"
                      variant="ghost"
                      className="om-button h-auto"
                      disabled={!offset}
                      onClick={() => setOffset(Math.max(0, offset - assetPageSize))}
                    >
                      {t('Previous')}
                    </Button>
                    <span className="om-muted">{Math.floor(offset / assetPageSize) + 1}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      className="om-button h-auto"
                      disabled={assets.result?.nextOffset == null}
                      onClick={() => {
                        if (assets.result?.nextOffset != null) setOffset(assets.result.nextOffset);
                      }}
                    >
                      {t('Next')}
                    </Button>
                  </div>
                )}

                {query && !loading && !catalog.failed && assets.result?.assets && groups.length === 0 && (
                  <div className="om-command-empty">
                    <p className="om-muted">{t('No matches')}</p>
                    <div className="om-command-topic-group">
                      <span className="om-eyebrow">{t('Try popular topics')}</span>
                      <div className="om-command-topics">
                        {popularTopics.map(topic => (
                          <Button
                            key={topic}
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="om-command-topic-chip"
                            onClick={() => {
                              tracking.reportCommandPaletteTopic(searchIdRef.current);
                              setScope('all');
                              applyInputImmediate(topic);
                              inputRef.current?.focus();
                            }}
                          >
                            {topic}
                          </Button>
                        ))}
                      </div>
                    </div>
                    {canAskSuperAgent && (
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          tracking.reportCommandPaletteAskAgent(searchIdRef.current);
                          choose(() => openNewSuperAgentChat(query));
                        }}
                      >
                        <RemixIcon name="sparkling-line" size={14} />
                        <span>{t('Ask Super Agent to create "{query}"', { query })}</span>
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <WorkspaceSearchPreview
                item={activeItem}
                creatingDesign={creatingDesign}
                canAskSuperAgent={canAskSuperAgent}
                onOpenItem={item => openResultItem(item, 'pointer')}
                onEditTemplate={handleEditTemplate}
                onCopyTemplatePrompt={template => { void handleCopyTemplatePrompt(template); }}
                onCreateDesignFromTemplate={resource => { void handleCreateDesignFromTemplate(resource); }}
                onUseInSuperAgent={handleUseInSuperAgent}
                onNewAgentChat={canAskSuperAgent ? () => choose(() => openNewSuperAgentChat()) : undefined}
              />
            </div>

            <div className="om-command-footer">
              <div
                className="om-command-scopes"
                role="tablist"
                aria-label={t('Search scopes')}
                onKeyDown={event => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  event.stopPropagation();
                  const index = SEARCH_SCOPES.findIndex(tab => tab.id === scope);
                  const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + SEARCH_SCOPES.length) % SEARCH_SCOPES.length;
                  const nextScope = SEARCH_SCOPES[nextIndex].id;
                  setScope(nextScope);
                  setActiveKey(null);
                  tracking.reportCommandPaletteScope(nextScope, scopeCounts[nextScope] ?? 0);
                }}
              >
                {SEARCH_SCOPES.map(tab => (
                  <Button
                    key={tab.id}
                    variant="plain"
                    type="button"
                    role="tab"
                    aria-selected={scope === tab.id}
                    className="om-nav-item om-command-scope-tab"
                    onClick={() => {
                      setScope(tab.id);
                      setActiveKey(null);
                      tracking.reportCommandPaletteScope(tab.id, scopeCounts[tab.id] ?? 0);
                    }}
                  >
                    <RemixIcon name={tab.icon} size={13} />
                    <span>{t(tab.label)}</span>
                    {query && scopeCounts[tab.id] > 0 && (
                      <span className="om-command-tab-count">{scopeCounts[tab.id]}</span>
                    )}
                  </Button>
                ))}
              </div>
              <div className="om-command-hints" aria-hidden="true">
                <span><kbd className="om-command-kbd">↑↓</kbd> {t('Navigate')}</span>
                <span><kbd className="om-command-kbd">↵</kbd> {t('Open')}</span>
                <span><kbd className="om-command-kbd">Esc</kbd> {t('Close')}</span>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>}
      </Dialog.Root>
    </>
  );
}
