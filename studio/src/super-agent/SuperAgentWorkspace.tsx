import { Dialog } from '@base-ui/react/dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LOCAL_DIRECT_RUNTIME_ID, type AgentRuntimeInfo } from '../../../shared/agent-runtimes';
import { assetMediaUrl } from '../../../shared/asset-library';
import { designRoutes } from '../../../shared/design-project';
import type {
  SuperAgentArtifact,
  SuperAgentChat,
  SuperAgentChatSummary,
  SuperAgentPermissionMode,
  SuperAgentResourceAttachment,
  SuperAgentResourceCatalog,
} from '../../../shared/super-agent';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { openAgentRuntimesSettings, useAgentRuntimes } from '../motion/useAgentRuntimes';
import { useLocalAgents } from '../motion/useLocalAgents';
import { ArtifactBrowserPane, NEW_VIEWER_TAB_ID, safeBrowserTabId } from './ArtifactBrowserPane';
import { ConversationSidebar } from './ConversationSidebar';
import { ConversationStream, type AgentSelection } from './ConversationStream';
import { resourceKey } from './ResourcePickerDialog';
import {
  approveSuperAgentAction,
  closeSuperAgentBrowserTab,
  createSuperAgentChat,
  deleteSuperAgentChat,
  fetchWorkspaceResources,
  getSuperAgentChat,
  listSuperAgentChats,
  startSuperAgentTurn,
  stopSuperAgentChat,
  subscribeSuperAgentChat,
  updateSuperAgentChat,
} from './superAgentClient';
import './superAgent.css';

function upsertSummary(
  list: SuperAgentChatSummary[],
  chat: SuperAgentChat,
): SuperAgentChatSummary[] {
  const summary: SuperAgentChatSummary = {
    id: chat.id,
    title: chat.title,
    ...(chat.pinned ? { pinned: true } : {}),
    engine: chat.engine,
    state: chat.state,
    artifactCount: chat.artifacts.length,
    messageCount: chat.messages.filter(m => m.role !== 'tool').length,
    updatedAt: chat.updatedAt,
    createdAt: chat.createdAt,
  };
  const next = list.filter(item => item.id !== chat.id);
  next.push(summary);
  next.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  return next;
}

function resourceToArtifactPatch(
  item: SuperAgentResourceAttachment,
): Partial<SuperAgentArtifact> | null {
  if (item.kind === 'design-project') {
    return {
      id: `design:${item.id}`,
      kind: 'design-project',
      title: item.title,
      subtitle: item.subtitle,
      projectId: item.id,
      scenario: item.scenario,
      entry: 'index.html',
      url: item.previewUrl || designRoutes.raw(item.id, 'index.html'),
    };
  }
  if (item.kind === 'motion-project') {
    return {
      id: `motion:${item.id}`,
      kind: 'motion-project',
      title: item.title,
      subtitle: item.subtitle || 'Motion Studio',
      projectId: item.id,
    };
  }
  if (item.kind === 'asset' && item.versionId) {
    const kind = item.modality === 'video' ? 'asset-video' : item.modality === 'audio' ? 'asset-audio' : 'asset-image';
    const url = assetMediaUrl(item.id, item.versionId);
    return {
      id: `asset:${item.id}:${item.versionId}`,
      kind,
      title: item.title,
      subtitle: item.subtitle,
      assetId: item.id,
      versionId: item.versionId,
      url,
      downloadUrl: `${url}?download=1`,
    };
  }
  if (item.kind === 'brand-kit') {
    return {
      id: `brand:${item.id}`,
      kind: 'brand-kit',
      title: item.title,
      subtitle: item.subtitle,
      kitId: item.id,
    };
  }
  return null;
}

function artifactToResourceAttachment(artifact: SuperAgentArtifact): SuperAgentResourceAttachment | null {
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
  return null;
}

export function SuperAgentWorkspace({
  active,
  chatId,
  onChatIdChange,
  onOpenDesignProject,
  onOpenMotionProject,
  onOpenAsset,
  onOpenBrandKit,
  onOpenAgentSettings,
  onOpenModelSettings,
  onOpenMcp,
}: {
  active: boolean;
  chatId: string | null;
  onChatIdChange: (id: string | null, replace?: boolean) => void;
  onOpenDesignProject: (projectId: string) => void;
  onOpenMotionProject: (projectId: string) => void;
  onOpenAsset: (assetId: string, versionId?: string) => void;
  onOpenBrandKit: (kitId?: string) => void;
  onOpenAgentSettings: () => void;
  onOpenModelSettings?: () => void;
  onOpenMcp: () => void;
}) {
  const { t } = useI18n();
  const { toasts, showToast, dismissToast } = useToast();
  const { data: agentDir, refresh: refreshAgents } = useLocalAgents();
  const { data: runtimesDir, refresh: refreshRuntimes } = useAgentRuntimes();
  const agents = agentDir?.agents ?? [];

  const availableRuntimes = useMemo<AgentRuntimeInfo[]>(() => {
    if (runtimesDir?.runtimes) {
      return runtimesDir.runtimes.map(rt =>
        rt.kind === 'local-direct' && agents.length > 0
          ? {
              ...rt,
              agents,
              runnableAgentIds: agents.filter(a => a.installed && a.auth !== 'signed-out').map(a => a.id),
            }
          : rt,
      );
    }
    return [
      {
        id: LOCAL_DIRECT_RUNTIME_ID,
        kind: 'local-direct',
        name: 'This computer',
        status: 'online',
        agents,
        runnableAgentIds: agents.filter(a => a.installed && a.auth !== 'signed-out').map(a => a.id),
      },
    ];
  }, [runtimesDir, agents]);

  const [conversations, setConversations] = useState<SuperAgentChatSummary[]>([]);
  const [loadingList, setLoadingList] = useState(() => Boolean(active));
  const [activeChat, setActiveChat] = useState<SuperAgentChat | null>(null);
  const [loadingChat, setLoadingChat] = useState(() => Boolean(active && chatId));
  const [loadFailed, setLoadFailed] = useState(false);
  const [chatRetry, setChatRetry] = useState(0);
  const [sending, setSending] = useState(false);

  const [resourcesCatalog, setResourcesCatalog] = useState<SuperAgentResourceCatalog | null>(null);
  const [attachments, setAttachments] = useState<SuperAgentResourceAttachment[]>([]);

  const [selection, setSelection] = useState<AgentSelection>({
    engine: 'codex',
    model: 'default',
    reasoning: 'default',
  });
  const [permissionMode, setPermissionMode] = useState<SuperAgentPermissionMode>('on-request');

  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 900px)').matches
      : false,
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const [viewerWidth, setViewerWidth] = useState<number | null>(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>(NEW_VIEWER_TAB_ID);

  const rootRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const lastArtifactStateRef = useRef<{ chatId: string | null; activeId?: string; sig: string }>({
    chatId: null,
    sig: '',
  });
  const prevBusyRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 900px)');
    const sync = () => {
      setNarrow(mq.matches);
      if (mq.matches) setSidebarOpen(false);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Sync engine/model selection with Settings → Local Agents default (both on initial load and after user changes it)
  const engineInitialized = useRef(false);
  const lastDefaultKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!agentDir || !agents.length) return;
    const def = agentDir.default;
    const nextKey = def ? `${def.agent}:${def.model || 'default'}:${def.reasoning || 'default'}` : '__none__';
    const prevKey = lastDefaultKeyRef.current;
    const defaultChangedByUser = prevKey !== null && nextKey !== prevKey;
    lastDefaultKeyRef.current = nextKey;

    if (def && agents.some(item => item.id === def.agent)) {
      const canAdopt = defaultChangedByUser || prevKey === null || !activeChat || activeChat.messages.length === 0;
      const busy = activeChat?.state === 'running' || activeChat?.state === 'waiting';
      if (canAdopt && !busy) {
        engineInitialized.current = true;
        setSelection({
          engine: def.agent,
          model: def.model?.trim() ? def.model : 'default',
          reasoning: def.reasoning?.trim() ? def.reasoning : 'default',
        });
        return;
      }
    }
    if (engineInitialized.current || activeChat) return;
    const runnable = agents.find(item => item.installed && item.auth !== 'signed-out');
    if (runnable) {
      engineInitialized.current = true;
      setSelection({
        engine: runnable.id,
        model: 'default',
        reasoning: 'default',
      });
    }
  }, [agentDir, agents, activeChat]);

  const refreshResources = useCallback(() => {
    void fetchWorkspaceResources({ limit: 48 })
      .then(setResourcesCatalog)
      .catch(() => { /* keep previous counts */ });
  }, []);

  const refreshConversations = useCallback(() => {
    setLoadingList(true);
    void listSuperAgentChats()
      .then(result => setConversations(result.conversations))
      .catch(() => { /* non-blocking sidebar refresh */ })
      .finally(() => setLoadingList(false));
  }, []);

  useEffect(() => {
    if (!runtimesDir) return;
    const online = runtimesDir.runtimes.filter(item => item.status === 'online');
    if (!online.length) return;
    const busy = activeChat?.state === 'running' || activeChat?.state === 'waiting';
    if (busy) return;

    const currentValid = selection.runtimeId && online.some(item => item.id === selection.runtimeId);
    if (currentValid) return;

    const preferred =
      (runtimesDir.defaultRuntimeId && online.find(item => item.id === runtimesDir.defaultRuntimeId))
      ?? (!runtimesDir.localDirectAvailable ? online.find(item => item.runnableAgentIds.length > 0) ?? online[0] : undefined);
    if (!preferred) return;

    const firstEngine = preferred.runnableAgentIds[0] ?? preferred.agents[0]?.id ?? selection.engine;
    setSelection({
      runtimeId: preferred.id,
      engine: firstEngine,
      model: 'default',
      reasoning: 'default',
    });
  }, [runtimesDir, activeChat, selection.runtimeId, selection.engine]);

  useEffect(() => {
    if (!active) return;
    refreshConversations();
    refreshResources();
    refreshAgents();
    refreshRuntimes();
  }, [active, refreshConversations, refreshResources, refreshAgents, refreshRuntimes]);

  // Apply chat snapshot and sync tabs / agent choices
  const applyChatSnapshot = useCallback((next: SuperAgentChat, isInitialLoad = false) => {
    setActiveChat(next);
    setConversations(prev => upsertSummary(prev, next));
    setPermissionMode(next.permissionMode);

    if (isInitialLoad && next.messages.length > 0) {
      setSelection({
        ...(next.runtimeId ? { runtimeId: next.runtimeId } : {}),
        engine: next.engine,
        model: next.model || 'default',
        reasoning: next.reasoning || 'default',
      });
    }

    const sig = next.artifacts.map(item => `${item.id}:${item.revision ?? item.updatedAt}`).join('|');
    const prev = lastArtifactStateRef.current;
    const chatSwitched = prev.chatId !== next.id;

    if (chatSwitched) {
      lastArtifactStateRef.current = { chatId: next.id, activeId: next.activeArtifactId, sig };
      const ids = next.artifacts.map(item => item.id);
      setOpenTabIds(ids);
      const initialActive = next.activeArtifactId && ids.includes(next.activeArtifactId)
        ? next.activeArtifactId
        : ids.at(-1) ?? NEW_VIEWER_TAB_ID;
      setActiveTabId(initialActive);
    } else if (sig !== prev.sig || next.activeArtifactId !== prev.activeId) {
      lastArtifactStateRef.current = { chatId: next.id, activeId: next.activeArtifactId, sig };
      const allIds = next.artifacts.map(item => item.id);
      setOpenTabIds(current => {
        const merged = current.filter(id => allIds.includes(id));
        for (const id of allIds) {
          if (!merged.includes(id)) merged.push(id);
        }
        return merged;
      });
      if (next.activeArtifactId) {
        setActiveTabId(next.activeArtifactId);
        setViewerOpen(true);
      }
    }

    const busy = next.state === 'running' || next.state === 'waiting';
    if (prevBusyRef.current && !busy) {
      refreshResources();
    }
    prevBusyRef.current = busy;
  }, [refreshResources]);

  // Load selected chat & subscribe to SSE when active
  useEffect(() => {
    if (!active) return;
    if (!chatId) {
      setActiveChat(null);
      setLoadingChat(false);
      setLoadFailed(false);
      setOpenTabIds([]);
      setActiveTabId(NEW_VIEWER_TAB_ID);
      lastArtifactStateRef.current = { chatId: null, sig: '' };
      return;
    }

    let cancelled = false;
    setLoadingChat(true);
    setLoadFailed(false);
    void getSuperAgentChat(chatId)
      .then(result => {
        if (!cancelled) applyChatSnapshot(result.conversation, true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingChat(false);
      });

    const unsubscribe = subscribeSuperAgentChat(chatId, next => {
      if (!cancelled) applyChatSnapshot(next, false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, chatId, chatRetry, applyChatSnapshot]);

  const ensureChatCreated = useCallback(async (): Promise<SuperAgentChat> => {
    if (activeChat) return activeChat;
    const created = await createSuperAgentChat({
      ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
      engine: selection.engine,
      model: selection.model !== 'default' ? selection.model : undefined,
      permissionMode,
    });
    applyChatSnapshot(created.conversation, true);
    onChatIdChange(created.conversation.id, true);
    return created.conversation;
  }, [activeChat, selection.runtimeId, selection.engine, selection.model, permissionMode, applyChatSnapshot, onChatIdChange]);

  const handleCreateConversation = async () => {
    try {
      const created = await createSuperAgentChat({
        ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
        engine: selection.engine,
        model: selection.model !== 'default' ? selection.model : undefined,
        permissionMode,
      });
      setAttachments([]);
      applyChatSnapshot(created.conversation, true);
      onChatIdChange(created.conversation.id);
      if (narrow) setSidebarOpen(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not create conversation'));
    }
  };

  const handleTogglePin = async (id: string, pinned: boolean) => {
    try {
      const updated = await updateSuperAgentChat(id, { pinned });
      setConversations(prev => upsertSummary(prev, updated.conversation));
      if (activeChat?.id === id) setActiveChat(updated.conversation);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not update conversation'));
    }
  };

  const handleRename = async (id: string, title: string) => {
    try {
      const updated = await updateSuperAgentChat(id, { title });
      setConversations(prev => upsertSummary(prev, updated.conversation));
      if (activeChat?.id === id) setActiveChat(updated.conversation);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not rename conversation'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      if (activeChat?.id === id) {
        for (const item of activeChat.artifacts) {
          if (item.kind === 'web') {
            void closeSuperAgentBrowserTab(id, safeBrowserTabId(item.id));
          }
        }
      }
      await deleteSuperAgentChat(id);
      setConversations(prev => prev.filter(item => item.id !== id));
      if (chatId === id) {
        onChatIdChange(null, true);
      }
      showToast(t('Conversation deleted'), 'info', 'feedback');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not delete conversation'));
    }
  };

  const handleChangePermissionMode = async (nextMode: SuperAgentPermissionMode) => {
    setPermissionMode(nextMode);
    if (!activeChat) return;
    try {
      const updated = await updateSuperAgentChat(activeChat.id, { permissionMode: nextMode });
      setActiveChat(updated.conversation);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not update approval mode'));
    }
  };

  const handleSend = async (text: string): Promise<boolean> => {
    setSending(true);
    try {
      const target = await ensureChatCreated();
      const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `sa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await startSuperAgentTurn(target.id, {
        requestId,
        text,
        ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
        engine: selection.engine,
        model: selection.model,
        reasoning: selection.reasoning,
        permissionMode,
        attachments,
      });
      applyChatSnapshot(result.conversation, false);
      setAttachments([]);
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not start Super Agent'));
      return false;
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    if (!activeChat) return;
    setSending(true);
    try {
      const result = await stopSuperAgentChat(activeChat.id);
      applyChatSnapshot(result.conversation, false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not stop Agent'));
    } finally {
      setSending(false);
    }
  };

  const handleApprove = async (approvalId: string, accepted: boolean) => {
    if (!activeChat) return;
    setSending(true);
    try {
      const result = await approveSuperAgentAction(activeChat.id, approvalId, accepted);
      applyChatSnapshot(result.conversation, false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Approval failed'));
    } finally {
      setSending(false);
    }
  };

  const handleOpenArtifactId = async (artifactId: string) => {
    setOpenTabIds(prev => (prev.includes(artifactId) ? prev : [...prev, artifactId]));
    setActiveTabId(artifactId);
    setViewerOpen(true);
    if (activeChat && activeChat.activeArtifactId !== artifactId) {
      void updateSuperAgentChat(activeChat.id, { activeArtifactId: artifactId })
        .then(res => {
          if (res?.conversation) setActiveChat(res.conversation);
        })
        .catch(() => { /* local tab already focused */ });
    }
  };

  const handleOpenWebUrl = async (url: string) => {
    try {
      const target = await ensureChatCreated();
      const res = await updateSuperAgentChat(target.id, {
        addArtifact: { kind: 'web', url },
      });
      applyChatSnapshot(res.conversation, false);
      setViewerOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not open web page'));
    }
  };

  const handleOpenResource = async (item: SuperAgentResourceAttachment) => {
    const patch = resourceToArtifactPatch(item);
    if (!patch) {
      setAttachments(prev =>
        prev.some(existing => resourceKey(existing) === resourceKey(item))
          ? prev
          : [...prev, item].slice(0, 30),
      );
      showToast(t('Attached "{title}" to prompt', { title: item.title }), 'info', 'feedback');
      return;
    }
    try {
      const target = await ensureChatCreated();
      const res = await updateSuperAgentChat(target.id, { addArtifact: patch });
      applyChatSnapshot(res.conversation, false);
      setViewerOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not preview resource'));
    }
  };

  const handleAttachArtifact = (artifact: SuperAgentArtifact) => {
    const att = artifactToResourceAttachment(artifact);
    if (!att) return;
    setAttachments(prev =>
      prev.some(existing => resourceKey(existing) === resourceKey(att))
        ? prev
        : [...prev, att].slice(0, 30),
    );
    showToast(t('Attached "{title}" to prompt', { title: att.title }), 'info', 'feedback');
  };

  const handleCloseTab = (tabId: string) => {
    const target = activeChat?.artifacts.find(item => item.id === tabId);
    if (target?.kind === 'web' && activeChat?.id) {
      void closeSuperAgentBrowserTab(activeChat.id, safeBrowserTabId(tabId));
    }
    setOpenTabIds(prev => {
      const next = prev.filter(id => id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(next.at(-1) ?? NEW_VIEWER_TAB_ID);
      }
      return next;
    });
  };

  const handleCopyText = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      showToast(t('Copied to clipboard'), 'info', 'feedback');
    } catch {
      showToast(t('Could not copy to clipboard'));
    }
  };

  const agentsLoaded = agentDir !== null || runtimesDir !== null;
  const openRuntimes = useCallback(() => {
    openAgentRuntimesSettings();
    onOpenAgentSettings();
  }, [onOpenAgentSettings]);

  const agentStatus = useMemo(() => {
    if (!agentsLoaded) {
      return { label: t('Local Agents'), detail: t('Checking Agent runtimes…'), ready: false, count: 0, loading: true };
    }
    const readyOnlineRuntimes = availableRuntimes.filter(rt => rt.status === 'online' && rt.runnableAgentIds.length > 0);
    const selectedRuntime = availableRuntimes.find(rt => rt.id === selection.runtimeId && rt.status === 'online');
    const targetRuntime = selectedRuntime ?? readyOnlineRuntimes[0] ?? availableRuntimes.find(rt => rt.status === 'online');
    const readyAgents = targetRuntime
      ? targetRuntime.agents.filter(item => item.installed && item.auth !== 'signed-out')
      : [];

    if (readyOnlineRuntimes.length > 0 && readyAgents.length > 0) {
      const activeFirst = [
        ...readyAgents.filter(item => item.id === selection.engine),
        ...readyAgents.filter(item => item.id !== selection.engine),
      ];
      const label = activeFirst.length <= 2
        ? activeFirst.map(a => a.label).join(' · ')
        : `${activeFirst[0].label} · +${activeFirst.length - 1}`;
      const detail =
        readyOnlineRuntimes.length > 1
          ? t('{count} runtimes connected', { count: readyOnlineRuntimes.length })
          : targetRuntime?.kind === 'local-bridge'
            ? t('Bridge · {name}', { name: targetRuntime.name })
            : targetRuntime?.kind === 'remote-service'
              ? t('Hosted · {name}', { name: targetRuntime.name })
              : t('Local Agent connected');
      return {
        label,
        detail,
        ready: true,
        count: readyAgents.length,
        loading: false,
      };
    }

    return {
      label: t('No Agent connected'),
      detail: runtimesDir && !runtimesDir.localDirectAvailable
        ? t('Connect local machine or service')
        : t('Configure Local Agent'),
      ready: false,
      count: 0,
      loading: false,
    };
  }, [availableRuntimes, agentsLoaded, selection.runtimeId, selection.engine, runtimesDir, t]);

  const startResize = (clientX: number) => {
    const currentWidth = viewerWidth
      ?? Math.round(rootRef.current?.querySelector<HTMLElement>('.om-sa-viewer-slot')?.getBoundingClientRect().width ?? 560);
    dragStartRef.current = { startX: clientX, startWidth: currentWidth };
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragStartRef.current;
      if (!drag) return;
      const maxWidth = Math.max(420, Math.floor((rootRef.current?.clientWidth ?? 1200) * 0.7));
      const delta = drag.startX - event.clientX;
      setViewerWidth(Math.max(340, Math.min(maxWidth, drag.startWidth + delta)));
    };
    const onUp = () => {
      dragStartRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const sidebarNode = (
    <ConversationSidebar
      conversations={conversations}
      activeId={chatId}
      loading={loadingList}
      agentStatus={agentStatus}
      onSelect={id => {
        onChatIdChange(id);
        if (narrow) setSidebarOpen(false);
      }}
      onCreate={() => void handleCreateConversation()}
      onTogglePin={(id, pinned) => void handleTogglePin(id, pinned)}
      onRename={(id, title) => handleRename(id, title)}
      onDelete={id => void handleDelete(id)}
      onCollapse={() => setSidebarOpen(false)}
      onOpenAgentSettings={() => {
        if (!agentStatus.ready && runtimesDir && !runtimesDir.localDirectAvailable) {
          openRuntimes();
        } else {
          onOpenAgentSettings();
        }
      }}
    />
  );

  return (
    <div
      ref={rootRef}
      className="om-super-agent"
      data-viewer-open={viewerOpen || undefined}
      data-viewer-expanded={viewerExpanded || undefined}
    >
      <StudioToastViewport toasts={toasts} dismissToast={dismissToast} />

      {!narrow && sidebarOpen && (
        <div className="om-sa-sidebar-slot">
          {sidebarNode}
        </div>
      )}

      {narrow && (
        <Dialog.Root open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <Dialog.Portal>
            <Dialog.Backdrop className="om-sa-dialog-backdrop" />
            <Dialog.Popup className="om-sa-sidebar-drawer" aria-label={t('Conversations')} onKeyDown={e => e.stopPropagation()}>
              {sidebarNode}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}

      {!(viewerOpen && viewerExpanded) && (
        <div className="om-sa-center-slot">
          <ConversationStream
            active={active}
            chat={activeChat}
            loading={loadingChat}
            loadFailed={loadFailed}
            sending={sending}
            sidebarOpen={!narrow && sidebarOpen}
            viewerOpen={viewerOpen}
            counts={resourcesCatalog?.counts ?? null}
            attachments={attachments}
            agents={agents}
            agentsLoaded={agentsLoaded}
            runtimes={availableRuntimes}
            localDirectAvailable={runtimesDir?.localDirectAvailable ?? true}
            selection={selection}
            permissionMode={permissionMode}
            onRetryLoad={() => setChatRetry(value => value + 1)}
            onOpenSidebar={() => setSidebarOpen(true)}
            onToggleViewer={() => {
              setViewerOpen(open => {
                const next = !open;
                if (!next) setViewerExpanded(false);
                return next;
              });
            }}
            onRenameChat={title => (activeChat ? handleRename(activeChat.id, title) : undefined)}
            onChangeSelection={setSelection}
            onChangePermissionMode={mode => void handleChangePermissionMode(mode)}
            onSend={handleSend}
            onStop={() => void handleStop()}
            onApprove={(approvalId, accepted) => void handleApprove(approvalId, accepted)}
            onResourcesUploaded={refreshResources}
            onAttachmentsChange={setAttachments}
            onOpenArtifactId={artifactId => void handleOpenArtifactId(artifactId)}
            onPreviewAttachment={att => void handleOpenResource(att)}
            onCopyText={code => void handleCopyText(code)}
            onOpenAgentSettings={onOpenAgentSettings}
            onOpenRuntimeSettings={openRuntimes}
            onOpenModelSettings={onOpenModelSettings}
            onOpenMcp={onOpenMcp}
            onError={message => showToast(message)}
          />
        </div>
      )}

      {viewerOpen && !viewerExpanded && !narrow && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('Resize Artifact Viewer')}
          aria-valuemin={340}
          aria-valuemax={960}
          aria-valuenow={viewerWidth ?? 560}
          className="om-sa-resizer"
          onPointerDown={event => {
            event.preventDefault();
            startResize(event.clientX);
          }}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setViewerWidth(v => Math.min(960, (v ?? 560) + 24));
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              setViewerWidth(v => Math.max(340, (v ?? 560) - 24));
            }
          }}
        />
      )}

      {viewerOpen && (
        <div
          className="om-sa-viewer-slot"
          style={viewerExpanded || narrow || viewerWidth === null ? undefined : { width: viewerWidth, flexBasis: viewerWidth, flexGrow: 0, flexShrink: 0 }}
        >
          <ArtifactBrowserPane
            active={active}
            chatId={activeChat?.id ?? null}
            artifacts={activeChat?.artifacts ?? []}
            openTabIds={openTabIds}
            activeTabId={activeTabId}
            expanded={viewerExpanded}
            workspaceItems={resourcesCatalog?.items ?? []}
            onSelectTab={id => void handleOpenArtifactId(id)}
            onCloseTab={handleCloseTab}
            onNewTab={() => setActiveTabId(NEW_VIEWER_TAB_ID)}
            onOpenWebUrl={url => void handleOpenWebUrl(url)}
            onOpenArtifact={id => void handleOpenArtifactId(id)}
            onOpenResource={item => void handleOpenResource(item)}
            onToggleExpand={() => setViewerExpanded(v => !v)}
            onClosePane={() => {
              setViewerExpanded(false);
              setViewerOpen(false);
            }}
            onAttachArtifact={handleAttachArtifact}
            onOpenInDesignStudio={onOpenDesignProject}
            onOpenInMotionStudio={onOpenMotionProject}
            onOpenInAssets={onOpenAsset}
            onOpenInBrandKit={onOpenBrandKit}
          />
        </div>
      )}
    </div>
  );
}
