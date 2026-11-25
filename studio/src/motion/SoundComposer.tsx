import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useEffect, useId, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  buildCapabilityParameters,
  buildCapabilityPrompt,
  defaultCapabilities,
  defaultCapabilityControlChoice,
  findCapability,
  resolveCapabilityOptions,
} from '../../../shared/capability-registry';
import type { GenerationJob, Model } from '../../../shared/gateway';
import { generationOptions, resolveGenerationParameters } from '../../../shared/generation-options';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import type { AssetDraft } from './AssetComposer';
import { assetRequest } from './assetClient';
import { supportsScene } from './creativeStudios';
import type { StudioCreation } from './CreativeWorkspace';
import { CreationModelPicker } from './GenerationModelPickers';
import { emptyParameters, requestParameters, type ParameterDraft } from './GenerationParameters';
import * as tracking from './pageTracking';
import { SoundAdvancedParameters, SoundParameters } from './SoundParameters';
import {
  SOUND_MUSIC_TAGS,
  SOUND_SFX_TAGS,
  SOUND_SPEECH_SCRIPTS,
  estimateSpeechSeconds,
  hasPromptTag,
  togglePromptTag,
} from './soundPresets';
import { isSfxModel, type SoundLiveTabId, type SoundTabId } from './soundTabs';
import type { VoicePreviewController } from './voicePreviews';
import { useWorkspaceChrome } from './WorkspaceFrame';

export function resolveSoundModels(studio: StudioCreation, tabId: SoundLiveTabId) {
  const gateway = studio.catalog.catalog;
  const scene = studio.destination.scene;
  const modelId = studio.destination.model;
  const allForScene = gateway?.models.filter(model => model.modality === 'audio' && supportsScene(model, scene)) ?? [];

  // Keep dedicated SFX endpoints out of Music and never silently fall back SFX to Music generators.
  const compatible = tabId === 'sfx'
    ? allForScene.filter(model => isSfxModel(model) || model.id === modelId)
    : tabId === 'music'
      ? allForScene.filter(model => !isSfxModel(model) || model.id === modelId)
      : allForScene;

  const available = compatible.filter(model =>
    gateway?.status.providers.some(provider => provider.id === model.provider && provider.available),
  );
  const preferred = modelId
    ? compatible.find(model => model.id === modelId)
    : available.find(model => model.id === gateway?.status.routes.audio) ?? available[0] ?? compatible[0];
  const selected = available.find(model => model.id === preferred?.id);
  const selectedProvider = selected ? gateway?.status.providers.find(provider => provider.id === selected.provider) : undefined;
  const preferredProvider = preferred ? gateway?.status.providers.find(provider => provider.id === preferred.provider) : undefined;
  return { gateway, compatible, available, preferred, selected, selectedProvider, preferredProvider };
}

const INPUT_LABEL: Record<SoundTabId, string> = {
  music: 'Prompt',
  sfx: 'Sound cue',
  speech: 'Script',
  'voice-clone': 'Script',
  'voice-changer': 'Notes (optional)',
  dubbing: 'Notes (optional)',
  stems: 'Notes (optional)',
};

const INPUT_PLACEHOLDER: Record<SoundTabId, string> = {
  music: 'Mood, instruments, tempo, or scene…',
  sfx: 'Whoosh, UI click, impact, or ambience…',
  speech: 'Write or paste narration…',
  'voice-clone': 'Write or paste the lines to speak in the cloned voice…',
  'voice-changer': 'Optional style or pacing notes…',
  dubbing: 'Optional glossary, speaker notes, or translation hints…',
  stems: 'Optional stem or denoise notes…',
};

const SUBMIT_LABEL: Record<SoundTabId, string> = {
  music: 'Generate music',
  sfx: 'Generate sound effect',
  speech: 'Generate speech',
  'voice-clone': 'Generate cloned speech',
  'voice-changer': 'Convert voice',
  dubbing: 'Generate dubbed track',
  stems: 'Separate stems',
};

export function SoundComposer({
  active,
  tabId,
  capabilityTabId,
  studio,
  draft,
  setDraft,
  parameterDrafts,
  setParameterDrafts,
  promptRef,
  voicePreview,
  onPickReference,
  onUploadReference,
  onCreated,
  onError,
}: {
  active: boolean;
  tabId: SoundLiveTabId;
  capabilityTabId?: SoundTabId;
  studio: StudioCreation;
  draft: AssetDraft;
  setDraft: Dispatch<SetStateAction<AssetDraft>>;
  parameterDrafts: Record<string, ParameterDraft>;
  setParameterDrafts: Dispatch<SetStateAction<Record<string, ParameterDraft>>>;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  voicePreview?: VoicePreviewController;
  onPickReference?: () => void;
  onUploadReference?: () => void;
  onCreated: (job: GenerationJob) => void;
  onError: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const { openModelSettings, openProviderSettings, openAccountSettings, openSubscriptionSettings } = useWorkspaceChrome();
  const effectiveTab: SoundTabId = capabilityTabId ?? tabId;
  const modelId = studio.destination.model;
  const promptId = useId();
  const { failed, retry } = studio.catalog;
  const { gateway, compatible, available, preferred, selected, selectedProvider, preferredProvider } = resolveSoundModels(studio, tabId);
  const runtimeCapabilities = gateway?.capabilities ?? defaultCapabilities;
  const activeCapability = effectiveTab !== 'sfx' ? findCapability(effectiveTab, runtimeCapabilities) : undefined;
  const capabilityControls = activeCapability?.input.controls ?? [];
  const capabilityOptions = draft.capabilityOptions ?? {};
  const minReferences = activeCapability?.input.minReferences ?? 0;
  const maxReferences = activeCapability?.input.maxReferences ?? 0;
  const promptRequired = activeCapability ? activeCapability.input.promptRequired : true;
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const unconfiguredPreferred = Boolean(gateway && preferred && !selected && preferredProvider && !preferredProvider.available);
  const accountNotIncluded = selected?.provider === 'account' && selectedProvider?.mediaEntitlement === 'not-included';
  const previewModel = selected ?? preferred;
  const parameters = previewModel ? parameterDrafts[previewModel.id] ?? emptyParameters : emptyParameters;
  const currentSpeed = typeof parameters.values.speed === 'number'
    ? parameters.values.speed
    : typeof previewModel?.defaults?.speed === 'number'
      ? previewModel.defaults.speed
      : 1;
  const estimatedSeconds = effectiveTab === 'speech' ? estimateSpeechSeconds(draft.prompt, currentSpeed) : 0;
  const promptReady = Boolean(draft.prompt.trim()) || !promptRequired;
  const referencesReady = draft.references.length >= minReferences && (maxReferences === 0 || draft.references.length <= maxReferences);
  const canSubmit = Boolean(selected && promptReady && referencesReady && !busy);
  const cjkLocale = locale === 'zh-CN' || locale === 'ja';
  const tags = tabId === 'sfx' ? SOUND_SFX_TAGS : SOUND_MUSIC_TAGS;
  const showStarterChips = effectiveTab === 'music' || effectiveTab === 'sfx' || effectiveTab === 'speech';

  const submit = async () => {
    if (!selected || !promptReady || !referencesReady || busy) return;
    setBusy(true);
    const studioContext = { studio: studio.destination.studio.id, scene: effectiveTab, model: selected.id };
    try {
      const parsed = requestParameters(parameters, selected, draft.references.length > 0);
      const effectiveVoice = selected.mode === 'text-to-speech' && !parsed.voice
        ? resolveGenerationParameters(selected, parsed, draft.references.length > 0).voice
          ?? (selected.generationOptions ?? generationOptions(selected))?.fields.find(f => f.key === 'voice')?.default
        : undefined;
      const baseParams = typeof effectiveVoice === 'string' && effectiveVoice.trim()
        ? { ...parsed, voice: effectiveVoice }
        : parsed;
      const effectiveCapabilityOptions = activeCapability
        ? resolveCapabilityOptions(activeCapability, capabilityOptions)
        : capabilityOptions;
      const submitParams = activeCapability
        ? buildCapabilityParameters(activeCapability, effectiveCapabilityOptions, baseParams)
        : baseParams;
      const submittedPrompt = activeCapability
        ? buildCapabilityPrompt(activeCapability.id, draft.prompt, effectiveCapabilityOptions, runtimeCapabilities) || activeCapability.title
        : draft.prompt;
      const result = await assetRequest<{ job: GenerationJob }>({
        action: 'generate',
        requestId: crypto.randomUUID(),
        modality: 'audio',
        prompt: submittedPrompt,
        model: selected.id,
        mode: selected.mode,
        parameters: submitParams,
        ...(activeCapability ? { capabilityId: activeCapability.id } : {}),
        ...(Object.keys(effectiveCapabilityOptions).length ? { capabilityOptions: effectiveCapabilityOptions } : {}),
        references: draft.references.map(item => item.reference),
      });
      if (mounted.current) {
        setDraft(current => current === draft ? { ...current, model: selected.id, parameters: submitParams } : current);
        onCreated(result.job);
      }
      tracking.reportAssetGenerationSubmit('audio', 'success', draft.references.length, false, studioContext);
    } catch (error) {
      tracking.reportAssetGenerationSubmit('audio', 'failure', draft.references.length, false, studioContext);
      if (mounted.current) onError((error as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const handleParamChange = (model: Model, value: ParameterDraft) => {
    setParameterDrafts(current => ({ ...current, [model.id]: value }));
    try {
      setDraft(current => ({ ...current, model: model.id, parameters: requestParameters(value, model, false) }));
    } catch {
      /* Retain invalid JSON in the local editor until corrected. */
    }
  };

  const settingsButton = (
    <Tooltip label={t('Model providers')}>
      <IconButton
        type="button"
        variant="plain"
        className="om-nav-item om-sound-reset-icon"
        aria-label={t('Model providers')}
        onClick={openModelSettings}
        icon={<RemixIcon name="settings-3-line" size={14} />}
      />
    </Tooltip>
  );

  const providerHeading = (
    <div className="om-creation-row">
      <span className="om-eyebrow">{t('Provider')}</span>
      {settingsButton}
    </div>
  );

  const fallbackModelHeading = (
    <div className="om-creation-row">
      <span className="om-eyebrow">{t('Model')}</span>
      {settingsButton}
    </div>
  );

  return (
    <aside
      className="om-asset-composer om-creation-surface om-sound-composer"
      data-active={active}
      data-scene={effectiveTab}
      aria-label={t('Audio generator')}
    >
      <div className="om-sound-composer-scroll">
        {maxReferences > 0 && (
          <section className="om-sound-block" aria-label={t('Source media')}>
            <span className="om-sound-field-label">{t('Source media')}</span>
            {draft.references.length > 0 && (
              <div className="om-scene-source-files">
                {draft.references.map(item => (
                  <Button
                    key={`${item.reference.assetId}/${item.reference.versionId}`}
                    type="button"
                    variant="plain"
                    className="om-nav-item"
                    aria-label={t('Remove reference: {name}', { name: item.name })}
                    onClick={() => setDraft(current => ({
                      ...current,
                      references: current.references.filter(ref => ref !== item),
                    }))}
                  >
                    <RemixIcon name="music-2-line" size={15} />
                    <span>{item.name}</span>
                    <RemixIcon name="close-line" size={14} />
                  </Button>
                ))}
              </div>
            )}
            {draft.references.length < maxReferences && (
              <div className="om-source-actions">
                {onPickReference && (
                  <Button type="button" variant="ghost" className="om-button h-auto" onClick={onPickReference}>
                    <RemixIcon name="folder-open-line" size={16} />
                    <span>{t('Choose an asset')}</span>
                  </Button>
                )}
                {onUploadReference && (
                  <Button type="button" variant="plain" className="om-nav-item" onClick={onUploadReference}>
                    <RemixIcon name="upload-2-line" size={15} />
                    <span>{t('Upload audio or video')}</span>
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        {capabilityControls.length > 0 && (
          <section className="om-sound-block om-relight-controls" aria-label={t(activeCapability?.title ?? 'Options')}>
            {capabilityControls.map(control => (
              <div className="om-relight-field" key={control.key}>
                <span className="om-sound-field-label">{t(control.label)}</span>
                <Select
                  label={t(control.label)}
                  value={capabilityOptions[control.key] ?? defaultCapabilityControlChoice(control).value}
                  options={control.choices.map(choice => ({ value: choice.value, label: t(choice.label) }))}
                  onCommit={value => setDraft(current => ({
                    ...current,
                    capabilityOptions: { ...current.capabilityOptions, [control.key]: value },
                  }))}
                />
              </div>
            ))}
          </section>
        )}

        <section className="om-sound-block om-sound-prompt-block">
          <div className="om-sound-prompt-header">
            <label className="om-sound-field-label" htmlFor={promptId}>
              {t(INPUT_LABEL[effectiveTab])}
            </label>
            <div className="om-sound-prompt-meta">
              {effectiveTab === 'speech' && estimatedSeconds > 0 && (
                <span className="om-badge om-sound-estimate" title={t('Estimated speaking duration')}>
                  ~{estimatedSeconds}s
                </span>
              )}
              {draft.prompt.length >= 1000 && (
                <span className="om-eyebrow om-sound-char-count">{draft.prompt.length.toLocaleString()} / 20k</span>
              )}
              {draft.prompt.length > 0 && (
                <Button
                  type="button"
                  variant="plain"
                  className="om-nav-item om-sound-clear-btn"
                  disabled={busy}
                  onClick={() => {
                    setDraft(current => ({ ...current, prompt: '' }));
                    promptRef.current?.focus();
                  }}
                >
                  {t('Clear')}
                </Button>
              )}
            </div>
          </div>

          <textarea
            ref={promptRef}
            id={promptId}
            className="om-sound-textarea"
            maxLength={20000}
            aria-label={t('Asset prompt')}
            placeholder={t(INPUT_PLACEHOLDER[effectiveTab])}
            value={draft.prompt}
            onChange={event => setDraft(current => ({ ...current, prompt: event.target.value }))}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit) {
                event.preventDefault();
                void submit();
              }
            }}
          />

          {showStarterChips && (
          <div className="om-sound-prompt-tools">
            {effectiveTab === 'speech' ? (
              <div className="om-sound-tag-rail" role="group" aria-label={t('Script starters')}>
                {SOUND_SPEECH_SCRIPTS.map(item => {
                  const localizedScript = t(item.script);
                  return (
                    <Button
                      type="button"
                      variant="plain"
                      key={item.id}
                      className="om-sound-tag"
                      disabled={busy}
                      onClick={() => {
                        setDraft(current => ({ ...current, prompt: localizedScript }));
                        promptRef.current?.focus();
                      }}
                    >
                      <RemixIcon name="add-line" size={12} />
                      <span>{t(item.title)}</span>
                    </Button>
                  );
                })}
              </div>
            ) : (
              <div className="om-sound-tag-rail" role="group" aria-label={t(tabId === 'sfx' ? 'Sound cue tags' : 'Style & mood tags')}>
                {tags.map(tag => {
                  const phrase = t(tag.phrase);
                  const pressed = hasPromptTag(draft.prompt, phrase);
                  return (
                    <Button
                      type="button"
                      variant="plain"
                      key={tag.id}
                      className="om-sound-tag"
                      aria-pressed={pressed}
                      disabled={busy}
                      onClick={() => {
                        setDraft(current => ({ ...current, prompt: togglePromptTag(current.prompt, phrase, cjkLocale) }));
                        promptRef.current?.focus();
                      }}
                    >
                      <RemixIcon name={pressed ? 'check-line' : 'add-line'} size={12} />
                      <span>{t(tag.label)}</span>
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
          )}
        </section>

        {previewModel && effectiveTab !== 'stems' && (
          <SoundParameters
            key={`primary:${previewModel.id}`}
            tabId={tabId}
            model={previewModel}
            draft={parameters}
            disabled={busy}
            voicePreview={voicePreview}
            onChange={value => handleParamChange(previewModel, value)}
          />
        )}

        <section className="om-sound-block om-sound-model-block">
          <div className="om-creation-model">
            {gateway && !failed && compatible.length > 0 ? (
              <CreationModelPicker
                models={compatible}
                providers={gateway.status.providers}
                selected={preferred}
                providerHeading={providerHeading}
                modelHeading={<span className="om-eyebrow">{t('Model')}</span>}
                disabled={busy}
                onChoose={model => studio.chooseModel(model)}
                onManageProviders={openModelSettings}
                onConfigureProvider={providerId => providerId === 'account'
                  ? (openAccountSettings ?? openModelSettings)()
                  : openProviderSettings ? openProviderSettings(providerId) : openModelSettings()}
              />
            ) : (
              <>
                {fallbackModelHeading}
                {failed ? (
                  <Button type="button" variant="ghost" className="om-button h-auto" onClick={retry}>
                    <RemixIcon name="refresh-line" size={16} />
                    {t('Retry loading models')}
                  </Button>
                ) : !gateway ? (
                  <Skeleton className="om-asset-model-skeleton" />
                ) : (
                  <div className="om-creation-setup">
                    <RemixIcon name="plug-line" size={18} />
                    <p className="om-muted">
                      {t(tabId === 'sfx'
                        ? 'Configure a sound-effects provider such as fal.'
                        : 'Configure a provider or sign in to use media models.')}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      className="om-button h-auto"
                      onClick={() => tabId === 'sfx' && openProviderSettings ? openProviderSettings('fal') : openModelSettings()}
                    >
                      {tabId === 'sfx' ? t('Configure {provider}', { provider: 'fal' }) : t('Model providers')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          {unconfiguredPreferred && (
            <div className="om-creation-setup" role="status">
              <RemixIcon name="plug-line" size={18} />
              <p className="om-muted">
                {t('{provider} needs setup before generating.', { provider: preferredProvider!.label ?? preferredProvider!.id })}
              </p>
              <Button
                type="button"
                variant="ghost"
                className="om-button h-auto"
                onClick={() => preferredProvider!.id === 'account'
                  ? (openAccountSettings ?? openModelSettings)()
                  : openProviderSettings ? openProviderSettings(preferredProvider!.id) : openModelSettings()}
              >
                {preferredProvider!.id === 'account'
                  ? t('Sign in with OpenDesign')
                  : t('Configure {provider}', { provider: preferredProvider!.label ?? preferredProvider!.id })}
              </Button>
            </div>
          )}

          {gateway && !available.length && compatible.length > 0 && !unconfiguredPreferred && (
            <Button type="button" variant="ghost" className="om-button h-auto" onClick={openModelSettings}>
              {t('Configure a provider or sign in to use media models.')}
            </Button>
          )}

          {accountNotIncluded && (
            <div className="om-creation-setup" role="status">
              <RemixIcon name="bank-card-line" size={18} />
              <p className="om-muted">{t('Signed in; multimodal generation requires OpenDesign Plus or above')}</p>
              <Button
                type="button"
                variant="ghost"
                className="om-button h-auto"
                onClick={() => (openSubscriptionSettings ?? openAccountSettings ?? openModelSettings)()}
              >
                {t('Manage subscription')}
              </Button>
            </div>
          )}

          {gateway && modelId && !selected && !unconfiguredPreferred && (
            <p className="om-muted" role="status">
              <strong>{gateway.models.find(model => model.id === modelId)?.label ?? modelId} · </strong>
              {t('This task’s model is unavailable. Choose a model to continue.')}
            </p>
          )}
        </section>

        {previewModel && (
          <SoundAdvancedParameters
            key={`advanced:${previewModel.id}`}
            model={previewModel}
            draft={parameters}
            disabled={busy}
            onChange={value => handleParamChange(previewModel, value)}
          />
        )}
      </div>

      <div className="om-creation-submit om-sound-submit">
        <Button
          type="button"
          variant="plain"
          className="om-button om-creation-submit-button"
          data-primary
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          <RemixIcon
            name={busy ? 'loader-4-line' : 'sparkling-fill'}
            size={17}
            className={busy ? 'om-busy-icon' : undefined}
          />
          <span>{t(SUBMIT_LABEL[effectiveTab])}</span>
          {!busy && <kbd className="om-sound-kbd" aria-hidden="true">⌘↵</kbd>}
        </Button>
      </div>
    </aside>
  );
}
