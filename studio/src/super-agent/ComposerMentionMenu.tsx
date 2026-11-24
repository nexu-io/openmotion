import { Popover as BasePopover } from '@base-ui/react/popover';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  formatAttachmentBytes,
  type SuperAgentArtifact,
  type SuperAgentChatSummary,
  type SuperAgentResourceAttachment,
  type SuperAgentResourceCatalog,
} from '../../../shared/super-agent';
import { Skeleton } from '../components/ui/Skeleton';
import { ensureLocaleLoaded, translate, useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import {
  ResourceThumbImage,
  resourceDisplaySubtitle,
  resourceDisplayTitle,
  resourceIcon,
  resourceImagePreviewUrl,
  resourceKey,
  resourceKindLabel,
  type ResourceCategoryTab,
} from './ResourcePickerDialog';
import { fetchSuperAgentWorkspaceFiles, fetchWorkspaceResources } from './superAgentClient';

export type MentionMenuCategory =
  | 'all'
  | 'file'
  | 'chat'
  | 'asset'
  | 'brand-kit'
  | 'template'
  | 'skills'
  | 'projects'
  | 'model';

export function mapResourceTabToMentionCategory(tab: ResourceCategoryTab): MentionMenuCategory {
  switch (tab) {
    case 'motion-template':
    case 'design-template':
      return 'template';
    case 'workflow':
    case 'skills':
      return 'skills';
    case 'asset':
      return 'asset';
    case 'brand-kit':
      return 'brand-kit';
    case 'projects':
      return 'projects';
    case 'model':
      return 'model';
    default:
      return 'all';
  }
}

export type ComposerCommandId = 'compact' | 'export-logs' | 'feedback';

export type ComposerMentionMenuHandle = {
  move: (delta: -1 | 1) => void;
  confirm: () => boolean;
};

type MenuActionEntry = {
  entryType: 'action';
  id: 'upload-files' | 'upload-folder';
  label: string;
  subtitle: string;
  icon: string;
};

type MenuCommandEntry = {
  entryType: 'command';
  id: ComposerCommandId;
  label: string;
  description: string;
  icon: string;
};

type MenuResourceEntry = {
  entryType: 'item';
  id: string;
  item: SuperAgentResourceAttachment;
  score: number;
};

type MenuEntry = MenuActionEntry | MenuCommandEntry | MenuResourceEntry;

type MenuSection = {
  id: string;
  title: string;
  topScore: number;
  entries: MenuEntry[];
};

function artifactToMentionItem(artifact: SuperAgentArtifact): SuperAgentResourceAttachment | null {
  if (artifact.kind === 'workspace-file' && artifact.filePath) {
    return {
      id: artifact.id.startsWith('file:') ? artifact.id.slice('file:'.length) : artifact.id,
      kind: 'file',
      title: artifact.title,
      subtitle: artifact.subtitle || artifact.filePath,
      filePath: artifact.filePath,
      rootKey: artifact.rootKey,
      artifactId: artifact.id,
      sizeBytes: artifact.sizeBytes,
      mimeType: artifact.mimeType,
      previewUrl: artifact.url,
    };
  }
  if (artifact.assetId && (artifact.kind === 'asset-image' || artifact.kind === 'asset-video' || artifact.kind === 'asset-audio')) {
    return {
      id: artifact.assetId,
      kind: 'asset',
      title: artifact.title,
      subtitle: artifact.subtitle,
      modality: artifact.kind === 'asset-video' ? 'video' : artifact.kind === 'asset-audio' ? 'audio' : 'image',
      versionId: artifact.versionId,
      previewUrl: artifact.url,
    };
  }
  if (artifact.kind === 'brand-kit' && artifact.kitId) {
    return {
      id: artifact.kitId,
      kind: 'brand-kit',
      title: artifact.title,
      subtitle: artifact.subtitle,
    };
  }
  if (artifact.kind === 'design-project' && artifact.projectId) {
    return {
      id: artifact.projectId,
      kind: 'design-project',
      title: artifact.title,
      subtitle: artifact.subtitle,
      scenario: artifact.scenario,
      previewUrl: artifact.url,
    };
  }
  if (artifact.kind === 'motion-project' && artifact.projectId) {
    return {
      id: artifact.projectId,
      kind: 'motion-project',
      title: artifact.title,
      subtitle: artifact.subtitle,
    };
  }
  if (artifact.kind === 'game-project' && artifact.projectId) {
    return {
      id: artifact.projectId,
      kind: 'game-project',
      title: artifact.title,
      subtitle: artifact.subtitle,
    };
  }
  return null;
}

function matchesSearchTerms(item: SuperAgentResourceAttachment, terms: string[], translatedTitle?: string): boolean {
  if (!terms.length) return true;
  const hay = [
    item.title,
    translatedTitle,
    item.subtitle,
    item.filePath,
    item.id,
    item.scenario,
    ...(item.tags ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every(term => hay.includes(term));
}

function scoreMentionMatch(item: SuperAgentResourceAttachment, queryLower: string, terms: string[]): number {
  let score = 0;
  if (queryLower) {
    const titleLower = item.title.toLowerCase();
    const dotIdx = item.kind === 'file' ? titleLower.lastIndexOf('.') : -1;
    const stem = dotIdx > 0 ? titleLower.slice(0, dotIdx) : titleLower;
    if (titleLower === queryLower || stem === queryLower) {
      score = 1000;
    } else if (titleLower.startsWith(queryLower)) {
      score = 600;
    } else if (titleLower.includes(queryLower)) {
      score = 350;
    } else if (terms.length > 1 && terms.every(t => titleLower.includes(t))) {
      score = 280;
    } else if (item.filePath) {
      const pathLower = item.filePath.toLowerCase();
      const base = pathLower.slice(pathLower.lastIndexOf('/') + 1);
      if (base.startsWith(queryLower)) score = 300;
      else if (base.includes(queryLower)) score = 200;
      else if (pathLower.includes(queryLower)) score = 100;
    }
    if (score === 0 && terms.length > 0) {
      const meta = [item.filePath, item.subtitle, item.scenario, ...(item.tags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (terms.every(t => meta.includes(t))) score = 100;
    }
  }
  if (item.kind === 'file') score += 30;
  if (item.filePath) {
    score -= Math.min(80, item.filePath.length * 0.4);
  }
  return score;
}

export const ComposerMentionMenu = forwardRef<
  ComposerMentionMenuHandle,
  {
    open: boolean;
    source: 'at' | 'plus' | 'slash';
    anchorRef: React.RefObject<HTMLElement | null>;
    query: string;
    category?: MentionMenuCategory;
    currentChatId?: string | null;
    workingDir?: string;
    activeArtifacts?: SuperAgentArtifact[];
    conversations?: SuperAgentChatSummary[];
    selected: SuperAgentResourceAttachment[];
    onQueryChange: (query: string) => void;
    onCategoryChange?: (category: MentionMenuCategory) => void;
    onSelectItem: (item: SuperAgentResourceAttachment) => void;
    onUploadFiles: () => void;
    onUploadFolder: () => void;
    onRunCommand?: (command: ComposerCommandId) => void;
    onClose: (refocusComposer?: boolean) => void;
  }
>(function ComposerMentionMenu(
  {
    open,
    source,
    anchorRef,
    query,
    category = 'all',
    currentChatId,
    workingDir,
    activeArtifacts = [],
    conversations = [],
    selected,
    onQueryChange,
    onSelectItem,
    onUploadFiles,
    onUploadFolder,
    onRunCommand,
    onClose,
  },
  ref,
) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const [catalog, setCatalog] = useState<SuperAgentResourceCatalog | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<SuperAgentResourceAttachment[]>([]);
  const [loadingResources, setLoadingResources] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [listScrolling, setListScrolling] = useState(false);
  const [listFadeBottom, setListFadeBottom] = useState(false);

  const syncListFade = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const hasMoreBelow = el.scrollHeight - el.clientHeight - el.scrollTop > 4;
    setListFadeBottom(prev => (prev === hasMoreBelow ? prev : hasMoreBelow));
  }, []);

  const handleListScroll = useCallback(() => {
    syncListFade();
    setListScrolling(true);
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = null;
      setListScrolling(false);
    }, 750);
  }, [syncListFade]);

  useEffect(() => () => {
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
  }, []);

  useEffect(() => {
    lastPointerRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!open || source !== 'plus') return;
    const raf = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open, source]);

  useEffect(() => {
    if (!open || source === 'slash' || (category !== 'all' && category !== 'file')) {
      setLoadingFiles(false);
      return;
    }
    let cancelled = false;
    setLoadingFiles(true);
    const run = () => {
      fetchSuperAgentWorkspaceFiles({
        chatId: currentChatId,
        workingDir,
        query: query.trim() || undefined,
        limit: category === 'file' ? 80 : 32,
      })
        .then(items => {
          if (!cancelled) setWorkspaceFiles(items);
        })
        .catch(() => {
          if (!cancelled) setWorkspaceFiles([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingFiles(false);
        });
    };
    const timer = query.trim() ? window.setTimeout(run, 90) : (run(), undefined);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, source, category, currentChatId, workingDir, query]);

  useEffect(() => {
    if (!open || source === 'slash' || category === 'file' || category === 'chat') {
      setLoadingResources(false);
      return;
    }
    let cancelled = false;
    setLoadingResources(true);
    const apiKind =
      category === 'template'
        ? 'templates'
        : category === 'brand-kit' || category === 'asset' || category === 'projects' || category === 'model'
          ? category
          : 'all';
    const searchQuery = query.trim();
    const run = () => {
      void Promise.all([
        fetchWorkspaceResources({
          kind: apiKind,
          query: searchQuery || undefined,
          limit: category === 'all' ? 160 : 120,
        }),
        /\p{Script=Han}/u.test(searchQuery) ? ensureLocaleLoaded('zh-CN').catch(() => {}) : undefined,
      ])
        .then(([next]) => {
          if (!cancelled) setCatalog(next);
        })
        .catch(() => {
          if (!cancelled) setCatalog(null);
        })
        .finally(() => {
          if (!cancelled) setLoadingResources(false);
        });
    };
    const timer = query.trim() ? window.setTimeout(run, 90) : (run(), undefined);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, source, category, query]);

  const selectedKeys = useMemo(() => new Set(selected.map(resourceKey)), [selected]);
  const queryLower = useMemo(() => query.trim().toLowerCase(), [query]);
  const terms = useMemo(
    () => (queryLower ? queryLower.split(/\s+/).filter(Boolean) : []),
    [queryLower],
  );

  const sections = useMemo<MenuSection[]>(() => {
    if (!open) return [];
    const built: MenuSection[] = [];
    const perSectionCap = category === 'all' ? 6 : 80;
    const hasSearch = terms.length > 0;

    const toResourceSection = (
      id: string,
      title: string,
      prefix: string,
      items: SuperAgentResourceAttachment[],
      cap: number,
    ): MenuSection | null => {
      if (items.length === 0) return null;
      const scored: MenuResourceEntry[] = items.map(item => ({
        entryType: 'item',
        id: `${prefix}:${resourceKey(item)}`,
        item,
        score: hasSearch ? scoreMentionMatch(item, queryLower, terms) : 0,
      }));
      if (hasSearch) {
        scored.sort((a, b) => b.score - a.score);
      }
      const sliced = scored.slice(0, cap);
      const topScore = sliced[0]?.score ?? 0;
      return { id, title, topScore, entries: sliced };
    };

    let commandsSection: MenuSection | null = null;
    if (onRunCommand && (source === 'slash' || category === 'all')) {
      const commandDefs: Array<{
        id: ComposerCommandId;
        label: string;
        description: string;
        icon: string;
        keywords: string;
      }> = [
        {
          id: 'compact',
          label: t('Compact'),
          description: t('Compact older conversation history'),
          icon: 'refresh-line',
          keywords: 'compact compress history context summary 压缩 上下文 历史',
        },
        {
          id: 'export-logs',
          label: t('Export'),
          description: t('Download this session log as a ZIP archive'),
          icon: 'download-2-line',
          keywords: 'export log logs zip download archive diagnostic 导出 日志',
        },
        {
          id: 'feedback',
          label: t('Feedback'),
          description: t('Record feedback about this session'),
          icon: 'chat-1-line',
          keywords: 'feedback report bug issue comment 反馈 问题',
        },
      ];
      const commandEntries: MenuCommandEntry[] = [];
      for (const cmd of commandDefs) {
        const searchText = `${cmd.label} ${cmd.description} ${cmd.keywords}`.toLowerCase();
        if (!hasSearch || terms.every(term => searchText.includes(term))) {
          commandEntries.push({
            entryType: 'command',
            id: cmd.id,
            label: cmd.label,
            description: cmd.description,
            icon: cmd.icon,
          });
        }
      }
      if (commandEntries.length > 0) {
        commandsSection = { id: 'commands', title: t('Commands'), topScore: -1, entries: commandEntries };
      }
    }

    if (source === 'slash') {
      return commandsSection ? [commandsSection] : [];
    }

    let addSection: MenuSection | null = null;
    if (category === 'all' || category === 'file') {
      const actionEntries: MenuActionEntry[] = [];
      const uploadText = `${t('Upload files…')} upload file attach`.toLowerCase();
      const folderText = `${t('Attach folder…')} folder directory attach`.toLowerCase();
      if (!hasSearch || terms.every(term => uploadText.includes(term))) {
        actionEntries.push({
          entryType: 'action',
          id: 'upload-files',
          label: t('Upload files…'),
          subtitle: t('Markdown, code, JSON, PDF, images, or media'),
          icon: 'upload-2-line',
        });
      }
      if (!hasSearch || terms.every(term => folderText.includes(term))) {
        actionEntries.push({
          entryType: 'action',
          id: 'upload-folder',
          label: t('Attach folder…'),
          subtitle: t('Import all readable files from a local folder'),
          icon: 'folder-add-line',
        });
      }
      if (actionEntries.length > 0) {
        addSection = { id: 'add', title: t('Add'), topScore: -1, entries: actionEntries };
      }
    }

    if (category === 'all' && activeArtifacts.length > 0) {
      const openTabItems = activeArtifacts
        .map(artifactToMentionItem)
        .filter((item): item is SuperAgentResourceAttachment => Boolean(item && matchesSearchTerms(item, terms)));
      const tabSec = toResourceSection('tabs', t('Open tabs'), 'tab', openTabItems, 6);
      if (tabSec) built.push(tabSec);
    }

    if (category === 'all' || category === 'file') {
      const filteredFiles = workspaceFiles.filter(item => matchesSearchTerms(item, terms));
      const fileSec = toResourceSection('files', t('Files & folders'), 'file', filteredFiles, category === 'all' ? 8 : 80);
      if (fileSec) built.push(fileSec);
    }

    if (category === 'all' || category === 'chat') {
      const chatItems: SuperAgentResourceAttachment[] = conversations
        .filter(c => c.id !== currentChatId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((c): SuperAgentResourceAttachment => ({
          id: c.id,
          chatId: c.id,
          kind: 'chat',
          title: c.title || t('New conversation'),
          subtitle: t('{count} messages', { count: c.messageCount }),
          updatedAt: c.updatedAt,
          tags: [c.intent || 'chat', c.engine],
        }))
        .filter(item => matchesSearchTerms(item, terms));
      const chatSec = toResourceSection('chats', t('Conversations'), 'chat', chatItems, category === 'all' ? 5 : 60);
      if (chatSec) built.push(chatSec);
    }

    const matchChineseTitles = /\p{Script=Han}/u.test(queryLower);
    const catalogItems = (catalog?.items ?? []).filter(item => matchesSearchTerms(
      item, terms, matchChineseTitles ? resourceDisplayTitle(item, title => translate('zh-CN', title)) : undefined,
    ));

    if (category === 'all' || category === 'skills') {
      const skills = catalogItems.filter(item => item.kind === 'skill' || item.kind === 'design-skill' || item.kind === 'workflow');
      const sec = toResourceSection('skills', t('Skills & Workflows'), 'skill', skills, perSectionCap);
      if (sec) built.push(sec);
    }

    if (category === 'all' || category === 'brand-kit' || category === 'model') {
      const wantBrands = category === 'all' || category === 'brand-kit';
      const wantModels = category === 'all' || category === 'model';
      const brandsAndModels = catalogItems.filter(
        item => (wantBrands && item.kind === 'brand-kit') || (wantModels && item.kind === 'model'),
      );
      const sec = toResourceSection(
        'brand-models',
        category === 'model' ? t('Models') : category === 'brand-kit' ? t('Brand Kits') : t('Brand Kits & Models'),
        'bm',
        brandsAndModels,
        perSectionCap,
      );
      if (sec) built.push(sec);
    }

    if (category === 'all' || category === 'template') {
      const templates = catalogItems.filter(item => item.kind === 'design-template' || item.kind === 'motion-template');
      const sec = toResourceSection('templates', t('Templates'), 'tpl', templates, perSectionCap);
      if (sec) built.push(sec);
    }

    if (category === 'all' || category === 'asset' || category === 'projects') {
      const wantAssets = category === 'all' || category === 'asset';
      const wantProjects = category === 'all' || category === 'projects';
      const assetsAndProjects = catalogItems.filter(
        item =>
          (wantAssets && item.kind === 'asset')
          || (wantProjects
            && (item.kind === 'design-project' || item.kind === 'motion-project' || item.kind === 'game-project')),
      );
      const sec = toResourceSection(
        'assets-projects',
        category === 'asset' ? t('Assets') : category === 'projects' ? t('Projects') : t('Assets & Projects'),
        'ap',
        assetsAndProjects,
        perSectionCap,
      );
      if (sec) built.push(sec);
    }

    if (category === 'all' && hasSearch && built.length > 1) {
      built.sort((a, b) => b.topScore - a.topScore);
    }

    if (commandsSection) {
      built.unshift(commandsSection);
    }
    if (addSection) {
      built.unshift(addSection);
    }

    return built;
  }, [open, source, category, queryLower, terms, activeArtifacts, workspaceFiles, conversations, currentChatId, catalog, onRunCommand, t]);

  const flatEntries = useMemo(
    () => sections.flatMap(sec => sec.entries),
    [sections],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [open, query, category]);

  useEffect(() => {
    if (flatEntries.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
      return;
    }
    if (activeIndex >= flatEntries.length) {
      setActiveIndex(flatEntries.length - 1);
    }
  }, [flatEntries.length, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const node = itemRefs.current[activeIndex];
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) {
      setListScrolling(false);
      setListFadeBottom(false);
      return;
    }
    const raf = window.requestAnimationFrame(syncListFade);
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return () => window.cancelAnimationFrame(raf);
    }
    const ro = new ResizeObserver(syncListFade);
    ro.observe(el);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [open, flatEntries.length, syncListFade]);

  const anyRefreshing =
    (category === 'file' && loadingFiles)
    || (category === 'all' && (loadingResources || loadingFiles))
    || (category !== 'all' && category !== 'file' && category !== 'chat' && loadingResources);
  const isLoading = flatEntries.length === 0 && anyRefreshing;

  const triggerEntry = useCallback(
    (entry: MenuEntry | undefined): boolean => {
      if (!entry) return false;
      if (entry.entryType === 'action') {
        if (entry.id === 'upload-files') onUploadFiles();
        else onUploadFolder();
        return true;
      }
      if (entry.entryType === 'command') {
        onRunCommand?.(entry.id);
        return true;
      }
      onSelectItem(entry.item);
      return true;
    },
    [onSelectItem, onUploadFiles, onUploadFolder, onRunCommand],
  );

  const confirmActive = useCallback((): boolean => {
    if (flatEntries.length > 0) {
      return triggerEntry(flatEntries[activeIndex]);
    }
    if (!anyRefreshing) {
      onClose(true);
      return true;
    }
    return false;
  }, [flatEntries, activeIndex, anyRefreshing, triggerEntry, onClose]);

  useImperativeHandle(
    ref,
    () => ({
      move(delta) {
        if (!flatEntries.length) return;
        setActiveIndex(prev => (prev + delta + flatEntries.length) % flatEntries.length);
      },
      confirm() {
        return confirmActive();
      },
    }),
    [flatEntries, confirmActive],
  );

  const handlePopupKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (flatEntries.length) setActiveIndex(prev => (prev + 1) % flatEntries.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (flatEntries.length) setActiveIndex(prev => (prev - 1 + flatEntries.length) % flatEntries.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const targetEl = event.target as HTMLElement | null;
        if (
          targetEl?.getAttribute('role') === 'tab'
          || targetEl?.closest('.om-sa-mention-search-clear, .om-sa-mention-menu-close')
        ) {
          return;
        }
        event.preventDefault();
        confirmActive();
      }
    },
    [flatEntries.length, confirmActive, onClose],
  );

  let runningFlatIndex = -1;

  return (
    <BasePopover.Root
      open={open}
      modal={false}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) return;
        const target = details.event?.target as HTMLElement | null;
        if (details.reason === 'outside-press' && target) {
          if (target.closest('[data-mention-trigger="plus"]')) {
            details.cancel();
            return;
          }
          if (source === 'at' && anchorRef.current?.contains(target)) {
            details.cancel();
            return;
          }
        }
        if (details.reason === 'focus-out') {
          const nextFocus =
            details.event && 'relatedTarget' in details.event
              ? (details.event.relatedTarget as HTMLElement | null)
              : null;
          if (nextFocus && anchorRef.current?.contains(nextFocus)) {
            details.cancel();
            return;
          }
        }
        onClose(details.reason === 'escape-key');
      }}
    >
      <BasePopover.Portal>
        <BasePopover.Positioner
          anchor={anchorRef}
          positionMethod="fixed"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
          className="om-sa-mention-positioner"
        >
          <BasePopover.Popup
            ref={rootRef}
            initialFocus={false}
            finalFocus={false}
            aria-label={t('Insert context or mention')}
            className="hf-floating-motion om-sa-mention-menu"
            data-source={source}
            onKeyDown={handlePopupKeyDown}
          >
            {source === 'plus' && (
              <div className="om-sa-mention-menu-head">
                <div className="om-sa-mention-search">
                  <RemixIcon name="search-line" size={14} />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    placeholder={t('Search files, chats, templates, skills, Brand Kits…')}
                    aria-label={t('Search context to mention')}
                    onChange={event => onQueryChange(event.target.value)}
                  />
                  {query && (
                    <IconButton
                      variant="plain"
                      className="om-sa-mention-search-clear"
                      aria-label={t('Clear search')}
                      onClick={() => onQueryChange('')}
                      icon={<RemixIcon name="close-line" size={13} />}
                    />
                  )}
                </div>
                <IconButton
                  variant="plain"
                  className="om-sa-mention-menu-close"
                  aria-label={t('Close menu')}
                  onClick={() => onClose(true)}
                  icon={<RemixIcon name="close-line" size={15} />}
                />
              </div>
            )}

            <div
              ref={listRef}
              className="om-sa-mention-list"
              data-scrolling={listScrolling || undefined}
              data-fade-bottom={listFadeBottom || undefined}
              onScroll={handleListScroll}
              role="listbox"
              aria-label={t('Mentionable items')}
              aria-activedescendant={flatEntries.length > 0 ? `om-sa-mention-opt-${activeIndex}` : undefined}
            >
              {isLoading ? (
                <div className="om-sa-mention-loading">
                  <Skeleton style={{ width: '100%', height: 34 }} />
                  <Skeleton style={{ width: '100%', height: 34 }} />
                  <Skeleton style={{ width: '82%', height: 34 }} />
                </div>
              ) : sections.length === 0 ? (
                <div className="om-empty om-sa-mention-empty">
                  <p className="om-muted">{t('No matching files, conversations, or resources.')}</p>
                </div>
              ) : (
                sections.map(section => (
                  <div key={section.id} className="om-sa-mention-section">
                    <div className="om-sa-mention-section-label">{section.title}</div>
                    {section.entries.map(entry => {
                      runningFlatIndex += 1;
                      const flatIdx = runningFlatIndex;
                      const isActive = flatIdx === activeIndex;

                      if (entry.entryType === 'action') {
                        return (
                          <Button
                            key={entry.id}
                            id={`om-sa-mention-opt-${flatIdx}`}
                            ref={el => {
                              itemRefs.current[flatIdx] = el;
                            }}
                            variant="plain"
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            data-active={isActive || undefined}
                            className="om-sa-mention-row"
                            onMouseDown={event => event.preventDefault()}
                            onPointerMove={event => {
                              const prev = lastPointerRef.current;
                              if (prev && prev.x === event.clientX && prev.y === event.clientY) return;
                              lastPointerRef.current = { x: event.clientX, y: event.clientY };
                              if (activeIndex !== flatIdx) setActiveIndex(flatIdx);
                            }}
                            onClick={() => triggerEntry(entry)}
                          >
                            <span className="om-sa-mention-row-thumb" data-kind="action" aria-hidden="true">
                              <RemixIcon name={entry.icon} size={14} />
                            </span>
                            <span className="om-sa-mention-row-main">
                              <strong>{entry.label}</strong>
                              <small>{entry.subtitle}</small>
                            </span>
                            <span className="om-sa-mention-row-trailing" aria-hidden="true">
                              {isActive && <kbd className="om-sa-mention-kbd">↵</kbd>}
                            </span>
                          </Button>
                        );
                      }

                      if (entry.entryType === 'command') {
                        return (
                          <Button
                            key={entry.id}
                            id={`om-sa-mention-opt-${flatIdx}`}
                            ref={el => {
                              itemRefs.current[flatIdx] = el;
                            }}
                            variant="plain"
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            data-active={isActive || undefined}
                            data-entry-type="command"
                            className="om-sa-mention-row"
                            onMouseDown={event => event.preventDefault()}
                            onPointerMove={event => {
                              const prev = lastPointerRef.current;
                              if (prev && prev.x === event.clientX && prev.y === event.clientY) return;
                              lastPointerRef.current = { x: event.clientX, y: event.clientY };
                              if (activeIndex !== flatIdx) setActiveIndex(flatIdx);
                            }}
                            onClick={() => triggerEntry(entry)}
                          >
                            <span className="om-sa-mention-row-thumb" data-kind="command" aria-hidden="true">
                              <RemixIcon name={entry.icon} size={14} />
                            </span>
                            <span className="om-sa-mention-row-main om-sa-mention-row-command">
                              <strong>{entry.label}</strong>
                              <small className="om-sa-mention-cmd-desc">{entry.description}</small>
                            </span>
                          </Button>
                        );
                      }

                      const { item } = entry;
                      const isPicked = selectedKeys.has(resourceKey(item));
                      const thumbUrl = resourceImagePreviewUrl(item);
                      const fallbackThumb = item.swatches?.length ? (
                        <span className="om-sa-resource-swatches">
                          {item.swatches.slice(0, 4).map((swatch, idx) => (
                            <span key={idx} style={{ background: swatch }} />
                          ))}
                        </span>
                      ) : (
                        <RemixIcon name={resourceIcon(item)} size={14} />
                      );
                      const sub =
                        item.kind === 'file' || item.kind === 'folder'
                          ? [
                              item.filePath && item.rootKey !== 'upload' ? item.filePath : item.subtitle,
                              item.kind === 'file' ? formatAttachmentBytes(item.sizeBytes) : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')
                          : resourceDisplaySubtitle(item, t);
                      const kindTag = category === 'all' ? t(resourceKindLabel(item.kind)) : '';

                      return (
                        <Button
                          key={entry.id}
                          id={`om-sa-mention-opt-${flatIdx}`}
                          ref={el => {
                            itemRefs.current[flatIdx] = el;
                          }}
                          variant="plain"
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          data-active={isActive || undefined}
                          data-selected={isPicked || undefined}
                          className="om-sa-mention-row"
                          onMouseDown={event => event.preventDefault()}
                          onPointerMove={event => {
                            const prev = lastPointerRef.current;
                            if (prev && prev.x === event.clientX && prev.y === event.clientY) return;
                            lastPointerRef.current = { x: event.clientX, y: event.clientY };
                            if (activeIndex !== flatIdx) setActiveIndex(flatIdx);
                          }}
                          onClick={() => triggerEntry(entry)}
                        >
                          <span className="om-sa-mention-row-thumb" data-kind={item.kind} aria-hidden="true">
                            <ResourceThumbImage src={thumbUrl} fallback={fallbackThumb} />
                          </span>
                          <span className="om-sa-mention-row-main">
                            <strong>{resourceDisplayTitle(item, t)}</strong>
                            {sub && <small>{sub}</small>}
                          </span>
                          {kindTag && <span className="om-sa-mention-row-kind">{kindTag}</span>}
                          <span className="om-sa-mention-row-trailing" aria-hidden="true">
                            {isPicked && <RemixIcon name="check-line" size={14} />}
                            {isActive && <kbd className="om-sa-mention-kbd">↵</kbd>}
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
});
