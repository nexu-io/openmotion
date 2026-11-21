import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRuntimeInfo } from '../../../shared/agent-runtimes';
import type { Model } from '../../../shared/gateway';
import type { LocalAgent } from '../../../shared/local-agents';
import type {
  SuperAgentChat,
  SuperAgentEngine,
  SuperAgentPermissionMode,
  SuperAgentResourceAttachment,
  SuperAgentResourceCounts,
} from '../../../shared/super-agent';
import { assetMediaUrl, assetVersion } from '../../../shared/asset-library';
import { Popover } from '../components/ui/Popover';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { uploadLibraryAsset } from '../motion/assetClient';
import { WorkingIndicator } from '../motion/AssetCreationVisuals';
import { gatewayRequest } from '../motion/gatewayClient';
import { ModelAvatar, ProviderAvatar } from '../motion/settingsPrimitives';
import { inspectBridgeAgent, notifyRuntimesChanged } from '../motion/useAgentRuntimes';
import { notifyAgentsChanged } from '../motion/useLocalAgents';
import { ResourcePickerPanel, resourceIcon, resourceKey, type ResourceCategoryTab } from './ResourcePickerDialog';
import {
  findSuperAgentMode,
  ModeResourceShowcase,
  type SuperAgentCreationModeId,
} from './ModeResourceShowcase';
import {
  DEFAULT_MODE_COMPOSER_OPTIONS,
  formatModePromptPrefix,
  getModeComposerPlaceholder,
  ModeComposerControls,
  ModeComposerTopBar,
  type ModeComposerOptions,
} from './ModeComposerControls';
import { SimpleMarkdown } from './SimpleMarkdown';

const PRIMARY_STARTERS: {
  id: SuperAgentCreationModeId;
  tone: 'agent' | 'image' | 'video' | 'audio';
  icon: string;
  title: string;
}[] = [
  { id: 'image', tone: 'image', icon: 'image-line', title: 'Generate image' },
  { id: 'motion', tone: 'video', icon: 'movie-line', title: 'Make a video' },
  { id: 'media', tone: 'audio', icon: 'music-2-line', title: 'Cinema & audio' },
  { id: 'game', tone: 'agent', icon: 'sparkling-line', title: 'Build a game' },
];

const EXTRA_STARTERS: {
  id: SuperAgentCreationModeId;
  tone: 'agent' | 'image' | 'video' | 'audio';
  icon: string;
  title: string;
}[] = [
  { id: 'deck', tone: 'audio', icon: 'slideshow-line', title: 'Create slides' },
  { id: 'website', tone: 'image', icon: 'layout-line', title: 'Build a website' },
];

export type AgentSelection = {
  runtimeId?: string;
  engine: SuperAgentEngine;
  model: string;
  reasoning: string;
};

export function ConversationStream({
  active = true,
  chat,
  loading,
  loadFailed,
  sending,
  sidebarOpen,
  viewerOpen,
  counts,
  attachments,
  agents,
  agentsLoaded = true,
  runtimes,
  localDirectAvailable = true,
  selection,
  permissionMode,
  onRetryLoad,
  onOpenSidebar,
  onToggleViewer,
  onRenameChat,
  onChangeSelection,
  onChangePermissionMode,
  onSend,
  onStop,
  onApprove,
  onResourcesUploaded,
  onAttachmentsChange,
  onOpenArtifactId,
  onPreviewAttachment,
  onCopyText,
  onOpenAgentSettings,
  onOpenRuntimeSettings,
  onOpenModelSettings,
  onOpenMcp,
  onError,
}: {
  active?: boolean;
  chat: SuperAgentChat | null;
  loading: boolean;
  loadFailed: boolean;
  sending: boolean;
  sidebarOpen: boolean;
  viewerOpen: boolean;
  counts: SuperAgentResourceCounts | null;
  attachments: SuperAgentResourceAttachment[];
  agents: LocalAgent[];
  agentsLoaded?: boolean;
  runtimes?: AgentRuntimeInfo[];
  localDirectAvailable?: boolean;
  selection: AgentSelection;
  permissionMode: SuperAgentPermissionMode;
  onRetryLoad: () => void;
  onOpenSidebar: () => void;
  onToggleViewer: () => void;
  onRenameChat: (title: string) => Promise<void> | void;
  onChangeSelection: (next: AgentSelection) => void;
  onChangePermissionMode: (next: SuperAgentPermissionMode) => void;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onApprove: (approvalId: string, accepted: boolean) => void;
  onResourcesUploaded?: () => void;
  onAttachmentsChange: (next: SuperAgentResourceAttachment[]) => void;
  onOpenArtifactId: (artifactId: string) => void;
  onPreviewAttachment: (attachment: SuperAgentResourceAttachment) => void;
  onCopyText: (text: string) => void;
  onOpenAgentSettings: () => void;
  onOpenRuntimeSettings?: () => void;
  onOpenModelSettings?: () => void;
  onOpenMcp: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const cancelRenameRef = useRef(false);
  const [resourceMenuOpen, setResourceMenuOpen] = useState(false);
  const [resourceCategory, setResourceCategory] = useState<ResourceCategoryTab>('all');
  const [moreStartersOpen, setMoreStartersOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [browsingEngine, setBrowsingEngine] = useState<SuperAgentEngine>(selection.engine);
  const [inspectingEngine, setInspectingEngine] = useState<SuperAgentEngine | null>(null);
  const inspectedEnginesRef = useRef<Set<SuperAgentEngine>>(new Set());
  const [activeModeId, setActiveModeId] = useState<SuperAgentCreationModeId | null>(null);
  const [modeOptions, setModeOptions] = useState<ModeComposerOptions>(DEFAULT_MODE_COMPOSER_OPTIONS);
  const mediaModelsRef = useRef<Model[]>([]);
  const activeMode = findSuperAgentMode(activeModeId);
  const updateModeOptions = useCallback((patch: Partial<ModeComposerOptions>) => {
    setModeOptions(prev => ({ ...prev, ...patch }));
  }, []);
  const handleCatalogModelsChange = useCallback((models: Model[]) => {
    mediaModelsRef.current = models;
  }, []);

  useEffect(() => {
    setBrowsingEngine(selection.engine);
  }, [selection.engine]);

  useEffect(() => {
    if (!active) {
      setResourceMenuOpen(false);
      setMoreStartersOpen(false);
      setModelMenuOpen(false);
      setApprovalMenuOpen(false);
    }
  }, [active]);
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const activeRuntime = useMemo(() => {
    if (!runtimes?.length) return undefined;
    return runtimes.find(rt => rt.id === selection.runtimeId)
      ?? runtimes.find(rt => rt.status === 'online')
      ?? runtimes[0];
  }, [runtimes, selection.runtimeId]);

  const effectiveAgents = activeRuntime ? activeRuntime.agents : agents;
  const runtimeOnline = !activeRuntime || (activeRuntime.status !== 'offline' && activeRuntime.status !== 'disabled');

  const runnableEngines = useMemo(
    () => (runtimeOnline ? effectiveAgents.filter(item => item.installed && item.auth !== 'signed-out') : []),
    [effectiveAgents, runtimeOnline],
  );
  const activeAgent = effectiveAgents.find(item => item.id === selection.engine) ?? effectiveAgents[0];
  const selectedModelMeta = activeAgent?.models.find(m => m.id === selection.model);
  const reasoningEfforts = selectedModelMeta?.reasoning ?? [];
  const busy = chat?.state === 'running' || chat?.state === 'waiting';
  const canSubmit = Boolean(text.trim()) && !sending && !busy && !loading && runnableEngines.length > 0;

  const engineChoices = useMemo(() => {
    if (activeRuntime?.kind === 'remote-service') {
      return effectiveAgents.map(agent => ({
        id: agent.id as SuperAgentEngine,
        label: agent.label,
        agent: agent as LocalAgent | undefined,
        ready: Boolean(runtimeOnline && agent.installed && agent.auth !== 'signed-out'),
      }));
    }
    const installed = effectiveAgents.filter(item => item.installed || item.id === selection.engine);
    const list = installed.length > 0
      ? installed
      : effectiveAgents.filter(item => item.id === 'codex' || item.id === 'claude');
    if (list.length === 0) {
      return [
        { id: 'codex', label: 'Codex', agent: undefined as LocalAgent | undefined, ready: false },
        { id: 'claude', label: 'Claude Code', agent: undefined as LocalAgent | undefined, ready: false },
      ];
    }
    return list.map(agent => ({
      id: agent.id as SuperAgentEngine,
      label: agent.label,
      agent: agent as LocalAgent | undefined,
      ready: Boolean(runtimeOnline && agent.installed && agent.auth !== 'signed-out'),
    }));
  }, [activeRuntime?.kind, effectiveAgents, runtimeOnline, selection.engine]);

  const browsingChoice = engineChoices.find(item => item.id === browsingEngine) ?? engineChoices[0];

  useEffect(() => {
    if (!modelMenuOpen) return;
    if (activeRuntime?.kind === 'remote-service') return;
    if (activeRuntime?.kind === 'local-bridge' && activeRuntime.status !== 'online') return;
    const target = browsingChoice?.agent;
    const inspectKey = `${activeRuntime?.id ?? 'local'}:${browsingChoice?.id ?? ''}`;
    if (!target?.installed || target.checkedAt || target.models.length > 0 || inspectedEnginesRef.current.has(inspectKey)) {
      return;
    }
    inspectedEnginesRef.current.add(inspectKey);
    setInspectingEngine(browsingChoice.id);
    let cancelled = false;
    const req = activeRuntime?.kind === 'local-bridge'
      ? inspectBridgeAgent(activeRuntime.id, target.id).then(() => { if (!cancelled) notifyRuntimesChanged(); })
      : gatewayRequest(`settings/agents/${target.id}/inspect`, 'POST', {}).then(() => { if (!cancelled) notifyAgentsChanged(); });
    void req
      .catch(() => { /* keep fallback default option */ })
      .finally(() => {
        if (!cancelled) setInspectingEngine(current => (current === browsingChoice.id ? null : current));
      });
    return () => {
      cancelled = true;
    };
  }, [modelMenuOpen, activeRuntime?.id, activeRuntime?.kind, activeRuntime?.status, browsingChoice?.id, browsingChoice?.agent]);

  const activeProviderRef = { id: activeAgent?.icon ?? selection.engine, custom: false };
  const triggerPrimaryLabel = selectedModelMeta?.label
    ?? (selection.model !== 'default' ? selection.model : activeAgent?.label ?? selection.engine);
  const triggerSecondaryLabel = selection.reasoning !== 'default' && reasoningEfforts.includes(selection.reasoning)
    ? selection.reasoning
    : selection.model !== 'default'
      ? (activeAgent?.label ?? selection.engine)
      : t('Default');

  useEffect(() => {
    setRenaming(false);
    setActiveModeId(null);
    followRef.current = true;
  }, [chat?.id]);

  const toggleResourceAttachment = (item: SuperAgentResourceAttachment) => {
    const key = resourceKey(item);
    const exists = attachments.some(existing => resourceKey(existing) === key);
    if (exists) {
      onAttachmentsChange(attachments.filter(existing => resourceKey(existing) !== key));
    } else {
      onAttachmentsChange([...attachments, item].slice(0, 30));
    }
  };

  useEffect(() => {
    if (followRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [chat?.updatedAt, chat?.messages.length, chat?.approvals.length]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const promptBody = activeMode
      ? `${formatModePromptPrefix(activeMode, modeOptions, mediaModelsRef.current)} ${text.trim()}`
      : text.trim();
    const ok = await onSend(promptBody);
    if (ok) {
      setText('');
      setActiveModeId(null);
      followRef.current = true;
    }
  };

  const handleFilesUpload = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    try {
      const added: SuperAgentResourceAttachment[] = [];
      for (const file of Array.from(files)) {
        const asset = await uploadLibraryAsset(file);
        const current = assetVersion(asset);
        added.push({
          id: asset.id,
          kind: 'asset',
          title: asset.name,
          subtitle: current?.model || current?.source || asset.modality,
          modality: asset.modality,
          versionId: asset.currentVersionId,
          previewUrl: assetMediaUrl(asset.id, asset.currentVersionId),
        });
      }
      const next = [...attachments];
      for (const item of added) {
        if (!next.some(existing => resourceKey(existing) === resourceKey(item))) {
          next.push(item);
        }
      }
      onAttachmentsChange(next.slice(0, 30));
    } catch (error) {
      onError(error instanceof Error ? error.message : t('Could not upload file'));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  const artifactCount = chat?.artifacts.length ?? 0;

  return (
    <section
      className="om-sa-stream"
      data-mode={activeMode?.id || undefined}
      aria-label={t('Super Agent conversation')}
      onDragOver={event => {
        if (event.dataTransfer?.types?.includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDragging(false);
        }
      }}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        void handleFilesUpload(event.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="om-sa-drop-overlay" aria-hidden="true">
          <RemixIcon name="upload-2-line" size={28} />
          <strong>{t('Drop media files to attach to this conversation')}</strong>
        </div>
      )}

      <header className="om-sa-stream-head">
        <div className="om-sa-stream-head-left">
          {!sidebarOpen && (
            <Tooltip label={t('Open sidebar')}>
              <IconButton
                variant="ghost"
                className="motion-icon-button"
                aria-label={t('Open sidebar')}
                onClick={onOpenSidebar}
                icon={<RemixIcon name="side-bar-line" size={16} />}
              />
            </Tooltip>
          )}
          {chat && renaming ? (
            <form
              className="om-sa-head-rename"
              onSubmit={event => {
                event.preventDefault();
                const next = draftTitle.trim();
                setRenaming(false);
                if (next && next !== chat.title) void onRenameChat(next);
              }}
            >
              <RemixIcon name="chat-1-line" size={15} />
              <input
                autoFocus
                maxLength={100}
                value={draftTitle}
                aria-label={t('Conversation name')}
                onFocus={event => event.currentTarget.select()}
                onChange={event => setDraftTitle(event.target.value)}
                onBlur={() => {
                  if (cancelRenameRef.current) {
                    cancelRenameRef.current = false;
                    return;
                  }
                  const next = draftTitle.trim();
                  setRenaming(false);
                  if (next && next !== chat.title) void onRenameChat(next);
                }}
                onKeyDown={event => {
                  if (event.key === 'Escape') {
                    cancelRenameRef.current = true;
                    setRenaming(false);
                  }
                }}
              />
            </form>
          ) : (
            <Button
              variant="plain"
              type="button"
              className="om-sa-stream-title"
              disabled={!chat}
              onClick={() => {
                if (!chat) return;
                setDraftTitle(chat.title);
                setRenaming(true);
              }}
            >
              <RemixIcon name="chat-1-line" size={15} />
              <span>{chat ? chat.title : t('New conversation')}</span>
              {chat && <RemixIcon name="edit-line" size={12} />}
            </Button>
          )}
          {chat && chat.state !== 'idle' && (
            <span className="om-badge" data-active={chat.state === 'running' || undefined}>
              {t(chat.state === 'running' ? 'Working…' : chat.state === 'waiting' ? 'Approval needed' : chat.state === 'failed' ? 'Stopped' : 'Cancelled')}
            </span>
          )}
        </div>

        <div className="om-sa-stream-head-actions">
          <Tooltip label={artifactCount > 0 ? `${t('Artifact Viewer')} (${artifactCount})` : t('Artifact Viewer')}>
            <IconButton
              variant="plain"
              className="om-sa-head-icon-btn"
              aria-label={t('Artifact Viewer')}
              aria-pressed={viewerOpen}
              data-active={viewerOpen || undefined}
              onClick={onToggleViewer}
              icon={<RemixIcon name="layout-column-line" size={16} />}
            />
          </Tooltip>
        </div>
      </header>

      <div
        ref={listRef}
        className="om-sa-messages"
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
        }}
      >
        {loading ? (
          <div className="om-sa-loading" role="status" aria-label={t('Loading conversation…')}>
            <Skeleton style={{ width: '55%', height: 24 }} />
            <Skeleton style={{ width: '100%', height: 84 }} />
            <Skeleton style={{ width: '80%', height: 84 }} />
          </div>
        ) : loadFailed ? (
          <div className="om-empty om-sa-empty-state" role="alert">
            <RemixIcon name="error-warning-line" size={28} />
            <h2>{t('Could not load conversation')}</h2>
            <Button variant="ghost" className="om-button h-auto" onClick={onRetryLoad}>
              <RemixIcon name="refresh-line" size={15} />
              <span>{t('Retry')}</span>
            </Button>
          </div>
        ) : !chat?.messages.length ? (
          activeMode ? (
            <ModeResourceShowcase
              active={active}
              mode={activeMode}
              attachments={attachments}
              onToggleAttachment={toggleResourceAttachment}
              onPickPrompt={prompt => {
                setText(prompt);
                composerRef.current?.focus();
              }}
              onOpenAllResources={category => {
                setResourceCategory(category ?? 'all');
                setResourceMenuOpen(true);
              }}
              onClose={() => setActiveModeId(null)}
            />
          ) : (
          <div className="om-sa-home">
            <div className="om-sa-home-hero">
              <h2>{t('What can I create for you?')}</h2>
            </div>

            <div className="om-sa-starter-grid">
              {PRIMARY_STARTERS.map(card => (
                <Button
                  key={card.id}
                  variant="plain"
                  type="button"
                  className="om-sa-starter-card"
                  data-tone={card.tone}
                  onClick={() => {
                    setActiveModeId(card.id);
                    composerRef.current?.focus();
                  }}
                >
                  <span className="om-sa-starter-icon" data-tone={card.tone} aria-hidden="true">
                    <RemixIcon name={card.icon} size={20} />
                  </span>
                  <strong>{t(card.title)}</strong>
                </Button>
              ))}

              <Popover
                open={moreStartersOpen}
                onOpenChange={setMoreStartersOpen}
                side="bottom"
                align="end"
                aria-label={t('Explore more')}
                className="om-agent-settings-popover om-sa-more-popover"
                trigger={
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-starter-card om-sa-starter-card-more"
                    data-active={moreStartersOpen || undefined}
                  >
                    <span className="om-sa-starter-icon" aria-hidden="true">
                      <RemixIcon name="more-fill" size={20} />
                    </span>
                    <strong>{t('Explore more')}</strong>
                  </Button>
                }
              >
                <div className="om-sa-more-menu">
                  {EXTRA_STARTERS.map(card => (
                    <Button
                      key={card.id}
                      variant="plain"
                      type="button"
                      className="om-sa-more-item"
                      onClick={() => {
                        setMoreStartersOpen(false);
                        setActiveModeId(card.id);
                        composerRef.current?.focus();
                      }}
                    >
                      <span className="om-sa-starter-icon" data-tone={card.tone} aria-hidden="true">
                        <RemixIcon name={card.icon} size={16} />
                      </span>
                      <span>{t(card.title)}</span>
                    </Button>
                  ))}
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-more-item"
                    onClick={() => {
                      setMoreStartersOpen(false);
                      setResourceCategory('all');
                      setResourceMenuOpen(true);
                    }}
                  >
                    <span className="om-sa-starter-icon" aria-hidden="true">
                      <RemixIcon name="apps-2-line" size={16} />
                    </span>
                    <span>{t('Workspace resources')}</span>
                  </Button>
                </div>
              </Popover>
            </div>
          </div>
          )
        ) : (
          <div className="om-sa-message-list">
            {chat.messages.map(message => {
              if (message.role === 'tool') {
                const ev = message.toolEvent;
                return (
                  <details key={message.id} className="om-sa-tool-row">
                    <summary>
                      <span className="om-sa-tool-status" data-status={ev?.status ?? 'completed'}>
                        <RemixIcon
                          name={
                            ev?.status === 'running'
                              ? 'loader-4-line'
                              : ev?.status === 'failed'
                                ? 'error-warning-line'
                                : 'checkbox-circle-line'
                          }
                          size={15}
                        />
                      </span>
                      <span className="om-sa-tool-label">{t(ev?.label || message.text)}</span>
                      {ev?.summary && <span className="om-sa-tool-summary">{ev.summary}</span>}
                      {ev?.artifactId && (
                        <Button
                          variant="plain"
                          type="button"
                          className="om-sa-tool-view-btn"
                          onClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            onOpenArtifactId(ev.artifactId!);
                          }}
                        >
                          <span>{t('View in Viewer')}</span>
                          <RemixIcon name="arrow-right-up-line" size={13} />
                        </Button>
                      )}
                      <RemixIcon name="arrow-down-s-line" size={14} />
                    </summary>
                    <div className="om-sa-tool-body">
                      {ev?.inputPreview && (
                        <>
                          <span className="om-eyebrow">{t('Input')}</span>
                          <pre className="om-code-block">{ev.inputPreview}</pre>
                        </>
                      )}
                      {ev?.outputPreview && (
                        <>
                          <span className="om-eyebrow">{t('Output')}</span>
                          <pre className="om-code-block">{ev.outputPreview}</pre>
                        </>
                      )}
                    </div>
                  </details>
                );
              }

              return (
                <article key={message.id} className="om-sa-message" data-role={message.role}>
                  {message.role === 'assistant' && (
                    <span className="om-creation-icon om-sa-avatar" data-tone="agent" aria-hidden="true">
                      <RemixIcon name="sparkling-fill" size={16} />
                    </span>
                  )}
                  <div className="om-sa-message-body">
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="om-sa-msg-attachments">
                        {message.attachments.map(att => (
                          <Button
                            key={resourceKey(att)}
                            variant="plain"
                            type="button"
                            className="om-sa-attachment-chip"
                            onClick={() => onPreviewAttachment(att)}
                          >
                            <RemixIcon name={resourceIcon(att)} size={13} />
                            <span>{att.title}</span>
                          </Button>
                        ))}
                      </div>
                    )}
                    {message.role === 'user' ? (
                      <div className="om-sa-user-bubble">{message.text}</div>
                    ) : (
                      <div className="om-sa-assistant-content">
                        <SimpleMarkdown content={message.text} onCopyCode={onCopyText} />
                      </div>
                    )}
                  </div>
                </article>
              );
            })}

            {busy && !chat.approvals.length && (
              <div className="om-creation-thinking om-sa-thinking" role="status">
                <WorkingIndicator />
                <span>{t('Super Agent is working…')}</span>
              </div>
            )}

            {chat.error && (
              <div className="om-card om-sa-error-card" role="alert">
                <RemixIcon name="error-warning-line" size={18} />
                <div>
                  <strong>{t('Conversation paused')}</strong>
                  <p className="om-muted">{chat.error}</p>
                </div>
              </div>
            )}

            {chat.approvals.map(approval => (
              <section key={approval.id} className="om-creation-approval om-sa-approval">
                <div className="om-creation-row">
                  <span className="om-creation-icon" data-tone="audio">
                    <RemixIcon name="shield-check-line" size={18} />
                  </span>
                  <div>
                    <h3 className="om-subtitle">{t(approval.title)}</h3>
                    <p className="om-muted">{t('Review this action before it runs.')}</p>
                  </div>
                </div>
                <pre className="om-code-block">{approval.detail}</pre>
                <div className="om-asset-actions">
                  <Button
                    variant="ghost"
                    className="om-button h-auto"
                    disabled={sending}
                    onClick={() => onApprove(approval.id, false)}
                  >
                    {t('Decline')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="om-button h-auto"
                    data-primary
                    disabled={sending}
                    onClick={() => onApprove(approval.id, true)}
                  >
                    <RemixIcon name="check-line" size={15} />
                    <span>{t('Approve')}</span>
                  </Button>
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <div className="om-sa-composer-wrap">
        {agentsLoaded && !runnableEngines.length && (
          <div className="om-sa-agent-banner">
            <RemixIcon name="plug-line" size={15} />
            <span>
              {t(
                !localDirectAvailable || (activeRuntime && activeRuntime.kind !== 'local-direct')
                  ? 'Connect a local machine via the Bridge script or add a Custom Agent Service to run Super Agent.'
                  : 'Install and sign in to Codex or Claude Code to run Super Agent.',
              )}
            </span>
            <Button
              variant="ghost"
              className="om-button h-auto"
              onClick={
                !localDirectAvailable || (activeRuntime && activeRuntime.kind !== 'local-direct')
                  ? (onOpenRuntimeSettings ?? onOpenAgentSettings)
                  : onOpenAgentSettings
              }
            >
              {t(
                !localDirectAvailable || (activeRuntime && activeRuntime.kind !== 'local-direct')
                  ? 'Connect Agent Runtime'
                  : 'Configure Local Agent',
              )}
            </Button>
          </div>
        )}

        {activeMode && (
          <ModeComposerTopBar
            active={active}
            modeId={activeMode.id}
            options={modeOptions}
            disabled={busy || sending}
            onChange={updateModeOptions}
            onCatalogModelsChange={handleCatalogModelsChange}
            onOpenResourcePicker={category => {
              setResourceCategory(category);
              setResourceMenuOpen(true);
            }}
            onOpenModelSettings={() => {
              if (onOpenModelSettings) onOpenModelSettings();
              else onOpenAgentSettings();
            }}
          />
        )}

        <div className="om-sa-composer">
          {attachments.length > 0 && (
            <div className="om-sa-composer-chips">
              {attachments.map(att => (
                <span key={resourceKey(att)} className="om-sa-attachment-chip">
                  <RemixIcon name={resourceIcon(att)} size={13} />
                  <span>{att.title}</span>
                  <IconButton
                    variant="plain"
                    className="om-sa-chip-remove"
                    aria-label={t('Remove {title}', { title: att.title })}
                    onClick={() =>
                      onAttachmentsChange(attachments.filter(item => resourceKey(item) !== resourceKey(att)))
                    }
                    icon={<RemixIcon name="close-line" size={12} />}
                  />
                </span>
              ))}
              <Button
                variant="plain"
                type="button"
                className="om-sa-chip-clear"
                onClick={() => onAttachmentsChange([])}
              >
                {t('Clear')}
              </Button>
            </div>
          )}

          <textarea
            ref={composerRef}
            rows={2}
            value={text}
            disabled={loading}
            maxLength={20000}
            aria-label={t('Message Super Agent')}
            placeholder={getModeComposerPlaceholder(activeMode, modeOptions, t)}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />

          <input
            ref={uploadInputRef}
            type="file"
            multiple
            hidden
            onChange={event => void handleFilesUpload(event.target.files)}
          />

          <div className="om-sa-composer-bar">
            <div className="om-sa-composer-tools">
              <Popover
                open={resourceMenuOpen}
                onOpenChange={next => {
                  setResourceMenuOpen(next);
                  if (!next) setResourceCategory('all');
                }}
                side="top"
                align="start"
                aria-label={t('Attach workspace resources')}
                className="om-sa-resource-popover"
                trigger={
                  <IconButton
                    variant="plain"
                    className="om-sa-composer-icon-btn"
                    data-active={resourceMenuOpen || undefined}
                    aria-label={t('Attach workspace resources')}
                    disabled={uploading}
                    icon={<RemixIcon name={uploading ? 'loader-4-line' : 'add-line'} size={18} />}
                  />
                }
              >
                <ResourcePickerPanel
                  open={resourceMenuOpen}
                  initialCategory={resourceCategory}
                  selected={attachments}
                  onToggle={toggleResourceAttachment}
                  onClear={() => onAttachmentsChange([])}
                  onAddItems={added => {
                    const next = [...attachments];
                    for (const item of added) {
                      if (!next.some(existing => resourceKey(existing) === resourceKey(item))) {
                        next.push(item);
                      }
                    }
                    onAttachmentsChange(next.slice(0, 30));
                  }}
                  onUploaded={onResourcesUploaded}
                  onError={onError}
                />
              </Popover>

              {activeMode && (
                <span className="om-sa-active-mode-pill" data-tone={activeMode.tone}>
                  <RemixIcon name={activeMode.icon} size={13} />
                  <span>{t(activeMode.label)}</span>
                  <IconButton
                    variant="plain"
                    className="om-sa-chip-remove"
                    aria-label={t('Clear mode')}
                    onClick={() => setActiveModeId(null)}
                    icon={<RemixIcon name="close-line" size={12} />}
                  />
                </span>
              )}

              {activeMode && (
                <ModeComposerControls
                  active={active}
                  modeId={activeMode.id}
                  options={modeOptions}
                  disabled={busy || sending}
                  onChange={updateModeOptions}
                />
              )}

              <Popover
                open={modelMenuOpen}
                onOpenChange={setModelMenuOpen}
                side="top"
                align="start"
                aria-label={t('Agent & model')}
                className="om-agent-settings-popover om-sa-model-popover"
                trigger={
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-model-trigger"
                    disabled={busy || sending}
                  >
                    <span className="om-sa-model-avatar" data-engine={selection.engine} aria-hidden="true">
                      {selection.model !== 'default' ? (
                        <ModelAvatar name={triggerPrimaryLabel} modelId={selection.model} provider={activeProviderRef} />
                      ) : (
                        <ProviderAvatar name={activeAgent?.label ?? selection.engine} provider={activeProviderRef} />
                      )}
                    </span>
                    <span className="om-sa-model-trigger-name">{triggerPrimaryLabel}</span>
                    {triggerSecondaryLabel && (
                      <span className="om-sa-model-trigger-sub" data-engine={selection.engine}>{triggerSecondaryLabel}</span>
                    )}
                    {activeRuntime && activeRuntime.kind !== 'local-direct' && (
                      <span className="om-sa-runtime-chip">
                        <RemixIcon name={activeRuntime.kind === 'local-bridge' ? 'link-line' : 'plug-line'} size={11} />
                        <span>{activeRuntime.name}</span>
                      </span>
                    )}
                    <RemixIcon name="arrow-down-s-line" size={15} />
                  </Button>
                }
              >
                <div className="om-sa-model-menu">
                  {runtimes && (runtimes.length > 1 || (activeRuntime && activeRuntime.kind !== 'local-direct')) && (
                    <div className="om-sa-runtime-pills" role="group" aria-label={t('Execution runtime')}>
                      {runtimes.map(rt => {
                        const isRtActive = activeRuntime?.id === rt.id;
                        const icon = rt.kind === 'local-bridge' ? 'link-line' : rt.kind === 'remote-service' ? 'plug-line' : 'computer-line';
                        return (
                          <Button
                            key={rt.id}
                            variant="plain"
                            type="button"
                            className="om-sa-runtime-pill"
                            aria-pressed={isRtActive}
                            data-active={isRtActive || undefined}
                            disabled={rt.status === 'disabled'}
                            onClick={() => {
                              const nextEngine = rt.runnableAgentIds.includes(selection.engine)
                                ? selection.engine
                                : rt.runnableAgentIds[0] ?? rt.agents[0]?.id ?? selection.engine;
                              setBrowsingEngine(nextEngine);
                              onChangeSelection({
                                runtimeId: rt.id,
                                engine: nextEngine,
                                model: 'default',
                                reasoning: 'default',
                              });
                            }}
                          >
                            <RemixIcon name={icon} size={13} />
                            <span>{t(rt.name)}</span>
                            <span
                              className="om-sa-runtime-pill-dot"
                              data-online={rt.status === 'online' || undefined}
                              aria-hidden="true"
                            />
                          </Button>
                        );
                      })}
                    </div>
                  )}

                  <div className="om-sa-model-agent-select-wrap">
                    <Select
                      label={t('Local Agent')}
                      value={browsingChoice.id}
                      className="om-sa-model-agent-select"
                      options={engineChoices.map(choice => ({
                        value: choice.id,
                        label: choice.label,
                        icon: (
                          <span className="om-sa-model-avatar" data-engine={choice.id} aria-hidden="true">
                            <ProviderAvatar
                              name={choice.label}
                              provider={{ id: choice.agent?.icon ?? choice.id, custom: false }}
                            />
                          </span>
                        ),
                        description: choice.ready
                          ? undefined
                          : !runtimeOnline
                            ? t('Runtime offline')
                            : (!choice.agent?.installed ? t('Not installed') : t('Sign-in required')),
                      }))}
                      onCommit={nextId => {
                        const chosen = engineChoices.find(item => item.id === nextId);
                        setBrowsingEngine(nextId);
                        if (chosen?.ready && selection.engine !== nextId) {
                          onChangeSelection({
                            ...(activeRuntime ? { runtimeId: activeRuntime.id } : selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
                            engine: nextId,
                            model: 'default',
                            reasoning: 'default',
                          });
                        }
                      }}
                    />
                  </div>

                  {(() => {
                    const choice = browsingChoice;
                    const agentModels = choice.ready ? (choice.agent?.models ?? []) : [];
                    const providerRef = { id: choice.agent?.icon ?? choice.id, custom: false };
                    const isDefaultSelected = selection.engine === choice.id && selection.model === 'default';
                    const hasCustomSelected =
                      selection.engine === choice.id
                      && selection.model !== 'default'
                      && !agentModels.some(m => m.id === selection.model);

                    return (
                      <div className="om-sa-model-list" role="listbox" aria-label={choice.label}>
                        {!choice.ready ? (
                          <div className="om-sa-model-unavailable">
                            <p className="om-muted">
                              {!runtimeOnline
                                ? t('This runtime is currently offline.')
                                : !choice.agent?.installed
                                  ? t('Not installed')
                                  : t('Sign-in required')}
                            </p>
                          </div>
                        ) : (
                          <>
                            <Button
                              variant="plain"
                              type="button"
                              role="option"
                              aria-selected={isDefaultSelected}
                              data-active={isDefaultSelected || undefined}
                              className="om-sa-model-option"
                              onClick={() => onChangeSelection({
                                ...(activeRuntime ? { runtimeId: activeRuntime.id } : selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
                                engine: choice.id,
                                model: 'default',
                                reasoning: 'default',
                              })}
                            >
                              <span className="om-sa-model-option-main">
                                <span className="om-sa-model-avatar" data-engine={choice.id} aria-hidden="true">
                                  <ProviderAvatar name={choice.label} provider={providerRef} />
                                </span>
                                <span className="om-sa-model-option-text">
                                  <strong>{choice.label}</strong>
                                  <span className="om-sa-model-tag" data-tone="default">{t('Default')}</span>
                                </span>
                              </span>
                              {isDefaultSelected && <RemixIcon name="check-line" size={15} />}
                            </Button>

                            {hasCustomSelected && (
                              <Button
                                key={`${choice.id}:${selection.model}`}
                                variant="plain"
                                type="button"
                                role="option"
                                aria-selected
                                data-active
                                className="om-sa-model-option"
                                onClick={() => onChangeSelection({
                                  ...(activeRuntime ? { runtimeId: activeRuntime.id } : selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
                                  engine: choice.id,
                                  model: selection.model,
                                  reasoning: selection.reasoning,
                                })}
                              >
                                <span className="om-sa-model-option-main">
                                  <span className="om-sa-model-avatar" data-engine={choice.id} aria-hidden="true">
                                    <ModelAvatar name={selection.model} modelId={selection.model} provider={providerRef} />
                                  </span>
                                  <span className="om-sa-model-option-text">
                                    <strong>{selection.model}</strong>
                                    <span className="om-sa-model-tag" data-tone={choice.id}>{choice.label}</span>
                                  </span>
                                </span>
                                <RemixIcon name="check-line" size={15} />
                              </Button>
                            )}

                            {inspectingEngine === choice.id && !agentModels.length && (
                              <div className="om-sa-model-loading">
                                <Skeleton style={{ width: '100%', height: 32 }} />
                                <Skeleton style={{ width: '82%', height: 32 }} />
                              </div>
                            )}

                            {agentModels.map(model => {
                              const isSelected = selection.engine === choice.id && selection.model === model.id;
                              const hasReasoning = Boolean(model.reasoning?.length);
                              return (
                                <Button
                                  key={`${choice.id}:${model.id}`}
                                  variant="plain"
                                  type="button"
                                  role="option"
                                  aria-selected={isSelected}
                                  data-active={isSelected || undefined}
                                  className="om-sa-model-option"
                                  onClick={() => onChangeSelection({
                                    ...(activeRuntime ? { runtimeId: activeRuntime.id } : selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
                                    engine: choice.id,
                                    model: model.id,
                                    reasoning: 'default',
                                  })}
                                >
                                  <span className="om-sa-model-option-main">
                                    <span className="om-sa-model-avatar" data-engine={choice.id} aria-hidden="true">
                                      <ModelAvatar name={model.label} modelId={model.id} provider={providerRef} />
                                    </span>
                                    <span className="om-sa-model-option-text">
                                      <strong>{model.label}</strong>
                                      {hasReasoning ? (
                                        <span className="om-sa-model-tag" data-tone="reasoning">
                                          <RemixIcon name="sparkling-fill" size={10} />
                                        </span>
                                      ) : (
                                        <span className="om-sa-model-tag" data-tone={choice.id}>{choice.label}</span>
                                      )}
                                    </span>
                                  </span>
                                  {isSelected && <RemixIcon name="check-line" size={15} />}
                                </Button>
                              );
                            })}
                          </>
                        )}
                      </div>
                    );
                  })()}

                  {selection.engine === 'codex' && reasoningEfforts.length > 0 && (
                    <div className="om-sa-model-reasoning">
                      <span className="om-sa-popover-label">{t('Reasoning effort')}</span>
                      <div className="om-sa-popover-pills" role="group" aria-label={t('Reasoning effort')}>
                        {(['default', ...reasoningEfforts] as const).map(level => {
                          const activeLevel = (reasoningEfforts.includes(selection.reasoning) ? selection.reasoning : 'default') === level;
                          return (
                            <Button
                              key={level}
                              variant="plain"
                              type="button"
                              className="om-sa-popover-pill"
                              aria-pressed={activeLevel}
                              data-active={activeLevel || undefined}
                              onClick={() => onChangeSelection({ ...selection, reasoning: level })}
                            >
                              {level === 'default' ? t('Default') : level}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="om-sa-model-menu-foot">
                    <Button
                      variant="plain"
                      type="button"
                      className="om-sa-popover-link-row"
                      onClick={() => {
                        setModelMenuOpen(false);
                        (onOpenRuntimeSettings ?? onOpenAgentSettings)();
                      }}
                    >
                      <RemixIcon name="link-line" size={15} />
                      <span>{t('Runtimes & Cloud Bridge')}</span>
                      <RemixIcon name="arrow-right-up-line" size={14} />
                    </Button>
                    <Button
                      variant="plain"
                      type="button"
                      className="om-sa-popover-link-row"
                      onClick={() => {
                        setModelMenuOpen(false);
                        onOpenAgentSettings();
                      }}
                    >
                      <RemixIcon name="robot-line" size={15} />
                      <span>{t('Manage Local Agents')}</span>
                      <RemixIcon name="arrow-right-up-line" size={14} />
                    </Button>
                  </div>
                </div>
              </Popover>
            </div>

            <div className="om-sa-composer-send">
              <Popover
                open={approvalMenuOpen}
                onOpenChange={setApprovalMenuOpen}
                side="top"
                align="end"
                tooltip={t('Approval mode')}
                aria-label={t('Agent settings')}
                className="om-agent-settings-popover om-sa-settings-popover"
                trigger={
                  <IconButton
                    variant="plain"
                    className="om-sa-composer-icon-btn om-sa-settings-trigger"
                    data-active={permissionMode === 'auto' || undefined}
                    aria-label={t('Agent settings')}
                    disabled={busy || sending}
                    icon={<RemixIcon name="shield-check-line" size={17} />}
                  />
                }
              >
                <div className="om-sa-popover-body">
                  <div className="om-sa-popover-field">
                    <span className="om-sa-popover-label">{t('Approval mode')}</span>
                    <div className="om-sa-popover-segment" role="group" aria-label={t('Approval mode')}>
                      <Button
                        variant="plain"
                        type="button"
                        className="om-sa-popover-seg-btn"
                        aria-pressed={permissionMode === 'on-request'}
                        data-active={permissionMode === 'on-request' || undefined}
                        onClick={() => onChangePermissionMode('on-request')}
                      >
                        <RemixIcon name="shield-check-line" size={14} />
                        <span>{t('Ask before paid/shell actions')}</span>
                      </Button>
                      <Button
                        variant="plain"
                        type="button"
                        className="om-sa-popover-seg-btn"
                        aria-pressed={permissionMode === 'auto'}
                        data-active={permissionMode === 'auto' || undefined}
                        onClick={() => onChangePermissionMode('auto')}
                      >
                        <RemixIcon name="sparkling-line" size={14} />
                        <span>{t('Auto-approve tool runs')}</span>
                      </Button>
                    </div>
                  </div>
                  <div className="om-sa-popover-links">
                    <Button
                      variant="plain"
                      type="button"
                      className="om-sa-popover-link-row"
                      onClick={() => {
                        setApprovalMenuOpen(false);
                        onOpenAgentSettings();
                      }}
                    >
                      <span className="om-sa-tone-icon" data-tone="agent" aria-hidden="true">
                        <RemixIcon name="robot-line" size={15} />
                      </span>
                      <span>{t('Manage Local Agents')}</span>
                      <RemixIcon name="arrow-right-up-line" size={14} />
                    </Button>
                    <Button
                      variant="plain"
                      type="button"
                      className="om-sa-popover-link-row"
                      onClick={() => {
                        setApprovalMenuOpen(false);
                        onOpenMcp();
                      }}
                    >
                      <span className="om-sa-tone-icon" data-tone="video" aria-hidden="true">
                        <RemixIcon name="plug-line" size={15} />
                      </span>
                      <span>{t('MCP guide')}</span>
                      <RemixIcon name="arrow-right-up-line" size={14} />
                    </Button>
                  </div>
                </div>
              </Popover>

              {busy ? (
                <IconButton
                  variant="plain"
                  className="om-sa-send-btn"
                  data-stop
                  aria-label={t('Stop')}
                  disabled={sending}
                  onClick={onStop}
                  icon={<RemixIcon name="checkbox-blank-fill" size={14} />}
                />
              ) : (
                <IconButton
                  variant="plain"
                  className="om-sa-send-btn"
                  data-ready={canSubmit || undefined}
                  aria-label={t('Send')}
                  disabled={!canSubmit}
                  onClick={() => void handleSubmit()}
                  icon={<RemixIcon name={sending ? 'loader-4-line' : 'arrow-right-line'} size={18} />}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
