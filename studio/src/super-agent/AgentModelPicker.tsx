import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRuntimeInfo } from '../../../shared/agent-runtimes';
import type { AgentModel, LocalAgent } from '../../../shared/local-agents';
import type { SuperAgentEngine } from '../../../shared/super-agent';
import { Popover } from '../components/ui/Popover';
import { Skeleton } from '../components/ui/Skeleton';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { ModelAvatar, ProviderAvatar } from '../motion/settingsPrimitives';
import type { AgentSelection } from './ConversationStream';

export type EngineChoice = {
  id: SuperAgentEngine;
  label: string;
  agent: LocalAgent | undefined;
  ready: boolean;
};

type FavoriteModelEntry = {
  engine: SuperAgentEngine;
  model: string;
};

type AgentMemoryEntry = {
  model: string;
  reasoning: string;
};

const FAVORITES_STORAGE_KEY = 'om.superAgent.favoriteModels.v1';
const AGENT_MEMORY_STORAGE_KEY = 'om.superAgent.agentMemory.v1';
const FAVORITES_TAB_ID = '__favorites__';

const REASONING_LABEL_MAP: Record<string, string> = {
  default: 'Default',
  off: 'Off',
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra',
  extra: 'Extra',
  max: 'Max',
};

export function formatReasoningLabel(level: string, t: (key: string) => string): string {
  const normalized = (level || 'default').trim().toLowerCase();
  const mapped = REASONING_LABEL_MAP[normalized];
  if (mapped) return t(mapped);
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function matchSupportedReasoning(levels: readonly string[] | undefined, candidate: string | undefined): string | null {
  if (!levels?.length || !candidate || candidate === 'default') return null;
  if (levels.includes(candidate)) return candidate;
  const lower = candidate.toLowerCase();
  const ci = levels.find(item => item.toLowerCase() === lower);
  if (ci) return ci;
  if (lower === 'xhigh' || lower === 'extra') {
    const alias = levels.find(item => {
      const l = item.toLowerCase();
      return l === 'xhigh' || l === 'extra' || l === 'max';
    });
    if (alias) return alias;
  }
  if (lower === 'none' || lower === 'off') {
    const alias = levels.find(item => {
      const l = item.toLowerCase();
      return l === 'none' || l === 'off';
    });
    if (alias) return alias;
  }
  return null;
}

export function resolveReasoningForModel(
  nextModel: AgentModel | undefined,
  currentReasoning: string,
  rememberedReasoning?: string,
): string {
  const levels = nextModel?.reasoning;
  if (!levels?.length) return 'default';
  const fromCurrent = matchSupportedReasoning(levels, currentReasoning);
  if (fromCurrent) return fromCurrent;
  const fromMemory = matchSupportedReasoning(levels, rememberedReasoning);
  if (fromMemory) return fromMemory;
  return 'default';
}

function readFavoriteModels(): FavoriteModelEntry[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is FavoriteModelEntry => Boolean(item && typeof item.engine === 'string' && typeof item.model === 'string'))
      .slice(0, 40);
  } catch {
    return [];
  }
}

function writeFavoriteModels(items: FavoriteModelEntry[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(items.slice(0, 40)));
  } catch {
    // Ignore storage quota / private mode failures
  }
}

function readAgentMemory(): Record<string, AgentMemoryEntry> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(AGENT_MEMORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, AgentMemoryEntry>;
  } catch {
    return {};
  }
}

function writeAgentMemory(map: Record<string, AgentMemoryEntry>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(AGENT_MEMORY_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota / private mode failures
  }
}

function favoriteKey(engine: string, model: string): string {
  return `${engine}\0${model}`;
}

export function AgentModelPicker({
  open,
  onOpenChange,
  disabled,
  selection,
  activeAgent,
  activeRuntime,
  runtimes,
  runtimeOnline,
  engineChoices,
  browsingEngine,
  inspectingEngine,
  onBrowseEngine,
  onChangeSelection,
  onOpenRuntimeSettings,
  onOpenAgentSettings,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  disabled?: boolean;
  selection: AgentSelection;
  activeAgent: LocalAgent | undefined;
  activeRuntime: AgentRuntimeInfo | undefined;
  runtimes?: AgentRuntimeInfo[];
  runtimeOnline: boolean;
  engineChoices: EngineChoice[];
  browsingEngine: SuperAgentEngine;
  inspectingEngine: SuperAgentEngine | null;
  onBrowseEngine: (engine: SuperAgentEngine) => void;
  onChangeSelection: (next: AgentSelection) => void;
  onOpenRuntimeSettings?: () => void;
  onOpenAgentSettings: () => void;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<string>(() => browsingEngine);
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState<FavoriteModelEntry[]>(() => readFavoriteModels());
  const [agentMemory, setAgentMemory] = useState<Record<string, AgentMemoryEntry>>(() => readAgentMemory());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setActiveTab(selection.engine || browsingEngine);
      setSearch('');
    }
    wasOpenRef.current = open;
  }, [open, selection.engine, browsingEngine]);

  const favoriteSet = useMemo(
    () => new Set(favorites.map(item => favoriteKey(item.engine, item.model))),
    [favorites],
  );

  const selectedModelMeta = activeAgent?.models.find(m => m.id === selection.model);
  const selectedModelReasoning = selectedModelMeta?.reasoning ?? [];
  const activeReasoningMatched = matchSupportedReasoning(selectedModelReasoning, selection.reasoning);

  const activeProviderRef = { id: activeAgent?.icon ?? selection.engine, custom: false };
  const triggerPrimaryLabel = selectedModelMeta?.label
    ?? (selection.model !== 'default' ? selection.model : activeAgent?.label ?? selection.engine);
  const triggerSecondaryLabel = activeReasoningMatched
    ? formatReasoningLabel(activeReasoningMatched, t)
    : selection.model !== 'default'
      ? (activeAgent?.label ?? selection.engine)
      : t('Default');
  const triggerSecondaryTone = activeReasoningMatched ? 'reasoning' : selection.engine;

  const currentRuntimePatch = activeRuntime
    ? { runtimeId: activeRuntime.id }
    : selection.runtimeId
      ? { runtimeId: selection.runtimeId }
      : {};

  const persistChoiceMemory = (engine: SuperAgentEngine, model: string, reasoning: string) => {
    setAgentMemory(prev => {
      const next = { ...prev, [engine]: { model, reasoning } };
      writeAgentMemory(next);
      return next;
    });
  };

  const toggleFavorite = (engine: SuperAgentEngine, model: string) => {
    setFavorites(prev => {
      const key = favoriteKey(engine, model);
      const exists = prev.some(item => favoriteKey(item.engine, item.model) === key);
      const next = exists
        ? prev.filter(item => favoriteKey(item.engine, item.model) !== key)
        : [{ engine, model }, ...prev].slice(0, 40);
      writeFavoriteModels(next);
      return next;
    });
  };

  const selectModel = (
    choice: EngineChoice,
    model: AgentModel | null,
    options?: { closeWhenNoReasoning?: boolean },
  ) => {
    const modelId = model ? model.id : 'default';
    const isSameModel = selection.engine === choice.id && selection.model === modelId;
    const remembered = agentMemory[choice.id];
    const nextReasoning = model
      ? resolveReasoningForModel(
          model,
          selection.reasoning,
          remembered?.model === model.id ? remembered.reasoning : remembered?.reasoning,
        )
      : 'default';

    onChangeSelection({
      ...currentRuntimePatch,
      engine: choice.id,
      model: modelId,
      reasoning: nextReasoning,
    });
    persistChoiceMemory(choice.id, modelId, nextReasoning);

    const hasReasoning = Boolean(model?.reasoning?.length);
    if (isSameModel || (!hasReasoning && options?.closeWhenNoReasoning !== false)) {
      onOpenChange(false);
    }
  };

  const selectThinkingLevel = (engine: SuperAgentEngine, modelId: string, level: string) => {
    onChangeSelection({
      ...currentRuntimePatch,
      engine,
      model: modelId,
      reasoning: level,
    });
    persistChoiceMemory(engine, modelId, level);
    onOpenChange(false);
  };

  const isFavoritesTab = activeTab === FAVORITES_TAB_ID;
  const activeRailChoice = !isFavoritesTab
    ? engineChoices.find(item => item.id === activeTab) ?? engineChoices.find(item => item.id === browsingEngine) ?? engineChoices[0]
    : undefined;

  const query = search.trim().toLowerCase();

  // Favorites / Cross-agent model entries when viewing Favorites tab
  const favoriteRows = useMemo(() => {
    if (!isFavoritesTab) return [];
    const byEngine = new Map(engineChoices.map(c => [c.id, c]));
    if (query) {
      const matches: Array<{ choice: EngineChoice; model: AgentModel }> = [];
      for (const choice of engineChoices) {
        if (!choice.ready) continue;
        for (const model of choice.agent?.models ?? []) {
          if (
            model.label.toLowerCase().includes(query)
            || model.id.toLowerCase().includes(query)
            || choice.label.toLowerCase().includes(query)
          ) {
            matches.push({ choice, model });
          }
        }
      }
      return matches;
    }
    const saved: Array<{ choice: EngineChoice; model: AgentModel }> = [];
    for (const fav of favorites) {
      const choice = byEngine.get(fav.engine);
      if (!choice?.ready) continue;
      const found = choice.agent?.models.find(m => m.id === fav.model);
      if (found) saved.push({ choice, model: found });
    }
    return saved;
  }, [isFavoritesTab, engineChoices, favorites, query]);

  // Right-hand Thinking Level target: always bound to the active selected model when it supports reasoning
  const thinkingTarget = useMemo<{
    engine: SuperAgentEngine;
    model: AgentModel;
    levels: string[];
    activeLevel: string;
  } | null>(() => {
    if (selectedModelMeta?.reasoning?.length) {
      return {
        engine: selection.engine,
        model: selectedModelMeta,
        levels: selectedModelMeta.reasoning,
        activeLevel: activeReasoningMatched ?? 'default',
      };
    }
    return null;
  }, [selectedModelMeta, selection.engine, activeReasoningMatched]);

  const hasThinkingColumn = Boolean(thinkingTarget);

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      side="top"
      align="start"
      initialFocus={false}
      aria-label={t('Agent & model')}
      className="om-agent-settings-popover om-sa-model-popover"
      trigger={
        <Button
          variant="plain"
          type="button"
          className="om-sa-model-trigger"
          disabled={disabled}
          title={
            activeReasoningMatched
              ? `${activeAgent?.label ?? selection.engine} · ${triggerPrimaryLabel} · ${formatReasoningLabel(activeReasoningMatched, t)}`
              : `${activeAgent?.label ?? selection.engine} · ${triggerPrimaryLabel}`
          }
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
            <span className="om-sa-model-trigger-sub" data-tone={triggerSecondaryTone}>
              {triggerSecondaryLabel}
            </span>
          )}
          {activeRuntime && activeRuntime.kind !== 'local-direct' && (
            <span className="om-sa-runtime-chip">
              <RemixIcon name={activeRuntime.kind === 'local-bridge' ? 'link' : 'plug-line'} size={11} />
              <span>{t(activeRuntime.name)}</span>
            </span>
          )}
          <RemixIcon name="arrow-down-s-line" size={15} />
        </Button>
      }
    >
      <div className="om-sa-model-menu" data-has-thinking={hasThinkingColumn || undefined}>
        {runtimes && (runtimes.length > 1 || (activeRuntime && activeRuntime.kind !== 'local-direct')) && (
          <div className="om-sa-runtime-pills" role="group" aria-label={t('Execution runtime')}>
            {runtimes.map(rt => {
              const isRtActive = activeRuntime?.id === rt.id;
              const icon = rt.kind === 'local-bridge' ? 'link' : rt.kind === 'remote-service' ? 'plug-line' : 'computer-line';
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
                    onBrowseEngine(nextEngine);
                    setActiveTab(nextEngine);
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

        <div className="om-sa-model-grid" data-has-thinking={hasThinkingColumn || undefined}>
          {/* Left rail: Favorites + Installed Agents */}
          <div className="om-sa-model-rail" role="tablist" aria-label={t('Local Agent')}>
            <Button
              variant="plain"
              type="button"
              role="tab"
              aria-selected={isFavoritesTab}
              aria-label={t('Favorites')}
              title={t('Favorites')}
              data-active={isFavoritesTab || undefined}
              className="om-sa-model-rail-btn"
              onClick={() => {
                setActiveTab(FAVORITES_TAB_ID);
                setSearch('');
              }}
            >
              <RemixIcon name={isFavoritesTab ? 'bookmark-fill' : 'bookmark-line'} size={16} />
            </Button>

            <span className="om-sa-model-rail-sep" aria-hidden="true" />

            {engineChoices.map(choice => {
              const isTabActive = !isFavoritesTab && activeRailChoice?.id === choice.id;
              const isCurrentEngine = selection.engine === choice.id;
              const statusHint = choice.ready
                ? choice.label
                : `${choice.label} · ${
                    !runtimeOnline
                      ? t('Runtime offline')
                      : !choice.agent?.installed
                        ? t('Not installed')
                        : t('Sign-in required')
                  }`;
              return (
                <Button
                  key={choice.id}
                  variant="plain"
                  type="button"
                  role="tab"
                  aria-selected={isTabActive}
                  aria-label={choice.label}
                  title={statusHint}
                  data-active={isTabActive || undefined}
                  data-current={isCurrentEngine || undefined}
                  data-unready={!choice.ready || undefined}
                  className="om-sa-model-rail-btn"
                  onClick={() => {
                    setActiveTab(choice.id);
                    setSearch('');
                    onBrowseEngine(choice.id);
                  }}
                >
                  <span className="om-sa-model-rail-avatar" data-engine={choice.id} aria-hidden="true">
                    <ProviderAvatar
                      name={choice.label}
                      provider={{ id: choice.agent?.icon ?? choice.id, custom: false }}
                    />
                  </span>
                </Button>
              );
            })}
          </div>

          {/* Middle column: Search + Model list */}
          <div className="om-sa-model-col">
            <div className="om-sa-model-search">
              <RemixIcon name="search-line" size={14} />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                aria-label={t('Search models…')}
                placeholder={t('Search models…')}
                onChange={event => setSearch(event.target.value)}
              />
              {search && (
                <IconButton
                  variant="plain"
                  className="om-sa-model-search-clear"
                  aria-label={t('Clear')}
                  onClick={() => {
                    setSearch('');
                    searchInputRef.current?.focus();
                  }}
                  icon={<RemixIcon name="close-line" size={12} />}
                />
              )}
            </div>

            {isFavoritesTab ? (
              <div className="om-sa-model-list" role="listbox" aria-label={t('Favorites')}>
                {favoriteRows.length === 0 ? (
                  <div className="om-sa-model-unavailable">
                    <p className="om-muted">
                      {query
                        ? t('No matching models')
                        : t('Bookmark models to switch across Agents in one click.')}
                    </p>
                  </div>
                ) : (
                  favoriteRows.map(({ choice, model }) => {
                    const isSelected = selection.engine === choice.id && selection.model === model.id;
                    const isFav = favoriteSet.has(favoriteKey(choice.id, model.id));
                    const providerRef = { id: choice.agent?.icon ?? choice.id, custom: false };
                    const hasReasoning = Boolean(model.reasoning?.length);
                    return (
                      <div
                        key={`${choice.id}:${model.id}`}
                        className="om-sa-model-row"
                        data-active={isSelected || undefined}
                      >
                        <Button
                          variant="plain"
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className="om-sa-model-row-main"
                          onClick={() => selectModel(choice, model)}
                        >
                          <span className="om-sa-model-avatar" data-engine={choice.id} aria-hidden="true">
                            <ModelAvatar name={model.label} modelId={model.id} provider={providerRef} />
                          </span>
                          <span className="om-sa-model-option-text">
                            <strong>{model.label}</strong>
                            <span className="om-sa-model-tag" data-tone={choice.id}>{choice.label}</span>
                            {hasReasoning && (
                              <span className="om-sa-model-tag" data-tone="reasoning" aria-hidden="true">
                                <RemixIcon name="sparkling-fill" size={10} />
                              </span>
                            )}
                          </span>
                        </Button>
                        <div className="om-sa-model-row-end">
                          <IconButton
                            variant="plain"
                            className="om-sa-model-fav-btn"
                            data-favorited={isFav || undefined}
                            aria-label={t(isFav ? 'Remove from favorites' : 'Add to favorites')}
                            aria-pressed={isFav}
                            onClick={event => {
                              event.stopPropagation();
                              toggleFavorite(choice.id, model.id);
                            }}
                            icon={<RemixIcon name={isFav ? 'bookmark-fill' : 'bookmark-line'} size={13} />}
                          />
                          {isSelected && <RemixIcon name="check-line" size={14} className="om-sa-model-check" />}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            ) : activeRailChoice ? (() => {
              const choice = activeRailChoice;
              const allModels = choice.ready ? (choice.agent?.models ?? []) : [];
              const filteredModels = query
                ? allModels.filter(m =>
                    m.label.toLowerCase().includes(query)
                    || m.id.toLowerCase().includes(query),
                  )
                : allModels;
              const providerRef = { id: choice.agent?.icon ?? choice.id, custom: false };
              const isDefaultSelected = selection.engine === choice.id && selection.model === 'default';
              const showDefaultRow = !query || choice.label.toLowerCase().includes(query) || 'default'.includes(query);
              const hasCustomSelected =
                !query
                && selection.engine === choice.id
                && selection.model !== 'default'
                && !allModels.some(m => m.id === selection.model);

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
                      {showDefaultRow && (
                        <div className="om-sa-model-row" data-active={isDefaultSelected || undefined}>
                          <Button
                            variant="plain"
                            type="button"
                            role="option"
                            aria-selected={isDefaultSelected}
                            className="om-sa-model-row-main"
                            onClick={() => selectModel(choice, null)}
                          >
                            <span className="om-sa-model-avatar" data-engine={choice.id} aria-hidden="true">
                              <ProviderAvatar name={choice.label} provider={providerRef} />
                            </span>
                            <span className="om-sa-model-option-text">
                              <strong>{choice.label}</strong>
                              <span className="om-sa-model-tag" data-tone="default">{t('Default')}</span>
                            </span>
                          </Button>
                          {isDefaultSelected && (
                            <div className="om-sa-model-row-end">
                              <RemixIcon name="check-line" size={14} className="om-sa-model-check" />
                            </div>
                          )}
                        </div>
                      )}

                      {hasCustomSelected && (
                        <div className="om-sa-model-row" data-active>
                          <Button
                            variant="plain"
                            type="button"
                            role="option"
                            aria-selected
                            className="om-sa-model-row-main"
                            onClick={() => onOpenChange(false)}
                          >
                            <span className="om-sa-model-avatar" data-engine={choice.id} aria-hidden="true">
                              <ModelAvatar name={selection.model} modelId={selection.model} provider={providerRef} />
                            </span>
                            <span className="om-sa-model-option-text">
                              <strong>{selection.model}</strong>
                              <span className="om-sa-model-tag" data-tone={choice.id}>{choice.label}</span>
                            </span>
                          </Button>
                          <div className="om-sa-model-row-end">
                            <RemixIcon name="check-line" size={14} className="om-sa-model-check" />
                          </div>
                        </div>
                      )}

                      {inspectingEngine === choice.id && !allModels.length && (
                        <div className="om-sa-model-loading">
                          <Skeleton style={{ width: '100%', height: 32 }} />
                          <Skeleton style={{ width: '82%', height: 32 }} />
                        </div>
                      )}

                      {filteredModels.map(model => {
                        const isSelected = selection.engine === choice.id && selection.model === model.id;
                        const isFav = favoriteSet.has(favoriteKey(choice.id, model.id));
                        const hasReasoning = Boolean(model.reasoning?.length);
                        return (
                          <div
                            key={`${choice.id}:${model.id}`}
                            className="om-sa-model-row"
                            data-active={isSelected || undefined}
                          >
                            <Button
                              variant="plain"
                              type="button"
                              role="option"
                              aria-selected={isSelected}
                              className="om-sa-model-row-main"
                              onClick={() => selectModel(choice, model)}
                            >
                              <span className="om-sa-model-avatar" data-engine={choice.id} aria-hidden="true">
                                <ModelAvatar name={model.label} modelId={model.id} provider={providerRef} />
                              </span>
                              <span className="om-sa-model-option-text">
                                <strong>{model.label}</strong>
                                {hasReasoning && (
                                  <span className="om-sa-model-tag" data-tone="reasoning" aria-hidden="true">
                                    <RemixIcon name="sparkling-fill" size={10} />
                                  </span>
                                )}
                              </span>
                            </Button>
                            <div className="om-sa-model-row-end">
                              <IconButton
                                variant="plain"
                                className="om-sa-model-fav-btn"
                                data-favorited={isFav || undefined}
                                aria-label={t(isFav ? 'Remove from favorites' : 'Add to favorites')}
                                aria-pressed={isFav}
                                onClick={event => {
                                  event.stopPropagation();
                                  toggleFavorite(choice.id, model.id);
                                }}
                                icon={<RemixIcon name={isFav ? 'bookmark-fill' : 'bookmark-line'} size={13} />}
                              />
                              {isSelected && <RemixIcon name="check-line" size={14} className="om-sa-model-check" />}
                            </div>
                          </div>
                        );
                      })}

                      {query && !showDefaultRow && filteredModels.length === 0 && (
                        <div className="om-sa-model-unavailable">
                          <p className="om-muted">{t('No matching models')}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })() : null}
          </div>

          {/* Right column: Thinking Level selector for ANY Agent model that supports reasoning */}
          {thinkingTarget && (
            <div className="om-sa-model-thinking-col" aria-label={t('Thinking level')}>
              <div className="om-sa-model-thinking-head">
                <span className="om-sa-popover-label">{t('Thinking level')}</span>
                <span className="om-sa-model-thinking-badge" title={thinkingTarget.model.label}>
                  {thinkingTarget.model.label}
                </span>
              </div>
              <div className="om-sa-model-thinking-list" role="listbox" aria-label={t('Thinking level')}>
                {(['default', ...thinkingTarget.levels] as const).map(level => {
                  const isLevelActive = thinkingTarget.activeLevel === level;
                  return (
                    <Button
                      key={level}
                      variant="plain"
                      type="button"
                      role="option"
                      aria-selected={isLevelActive}
                      data-active={isLevelActive || undefined}
                      className="om-sa-model-thinking-option"
                      onClick={() => selectThinkingLevel(thinkingTarget.engine, thinkingTarget.model.id, level)}
                    >
                      <span>{formatReasoningLabel(level, t)}</span>
                      {isLevelActive && <RemixIcon name="check-line" size={14} />}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="om-sa-model-menu-foot">
          <Button
            variant="plain"
            type="button"
            className="om-sa-model-foot-btn"
            onClick={() => {
              onOpenChange(false);
              (onOpenRuntimeSettings ?? onOpenAgentSettings)();
            }}
          >
            <RemixIcon name="computer-line" size={14} />
            <span>{t('Connected Computers')}</span>
            <RemixIcon name="arrow-right-up-line" size={13} />
          </Button>
          <Button
            variant="plain"
            type="button"
            className="om-sa-model-foot-btn"
            onClick={() => {
              onOpenChange(false);
              onOpenAgentSettings();
            }}
          >
            <RemixIcon name="robot-line" size={14} />
            <span>{t('Manage Local Agents')}</span>
            <RemixIcon name="arrow-right-up-line" size={13} />
          </Button>
        </div>
      </div>
    </Popover>
  );
}
