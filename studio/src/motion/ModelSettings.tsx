import { Button } from 'open-design-ui/button';
import { useState, type MouseEvent } from 'react';
import type { DirectoryModel, ProviderConnection } from '../../../shared/provider-directory';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { activeAccountOffer, buildSubscriptionUrl, MULTIMODAL_CAPABILITIES } from './accountOffer';
import { gatewayRequest, type CloudApiError } from './gatewayClient';
import * as tracking from './pageTracking';
import { notifyProvidersChanged, useProviderDirectory, type CloudProviderDirectory } from './useProviderDirectory';
import { ProviderAvatar, ModelAvatar, SettingsError, SettingsLoading } from './settingsPrimitives';
import { kindLabels, modelKindLabel } from './ModelEditor';
import { modelDisplayLabel, modelMediaCapabilities, shouldShowInlineModelId } from './modelMediaCapabilities';
import { ModelCatalog } from './ModelCatalog';

export { kindLabels, modelKindLabel } from './ModelEditor';

/** Sidebar/status helper preserved for compatibility with existing callers and tests. */
export function providerListStatus(provider: { configured: boolean; enabled: boolean; available: boolean }): 'available' | 'disabled' | null {
  if (provider.available) return 'available';
  return provider.configured && !provider.enabled ? 'disabled' : null;
}

export function ModelSettings({
  onClose,
  openAccount,
  openSubscription,
}: {
  onClose?: () => void;
  openAccount?: () => void;
  openSubscription?: () => void;
  initialCategory?: string;
  providerId?: string | null;
  onProviderChange?: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const directory = useProviderDirectory();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const data = directory.data;
  const provider = data?.providers.find(item => item.id === 'opendesign') ?? data?.providers[0];
  const models = data?.models ?? [];
  const isMockGateway = data?.gatewayMode === 'mock';

  async function syncCatalog() {
    setBusy(true);
    try {
      await gatewayRequest('models/catalog?refresh=true');
      notifyProvidersChanged();
      toast.showToast(t('Models synced'), 'info');
    } catch (error) {
      toast.showToast(error instanceof Error ? error.message : t('Could not sync models'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function setDefaultModel(model: DirectoryModel, selected: boolean) {
    if (!['image', 'video', 'audio'].includes(model.kind)) return;
    setBusy(true);
    try {
      const nextDefaults: Record<string, string | undefined> = {
        image: data?.defaults.image,
        video: data?.defaults.video,
        audio: data?.defaults.audio,
        [model.kind]: selected ? undefined : model.id,
      };
      await gatewayRequest('models/defaults', 'PUT', nextDefaults);
      notifyProvidersChanged();
      toast.showToast(t('Default model updated'), 'info');
    } catch (error) {
      const apiErr = error as CloudApiError;
      if (apiErr.status === 403) {
        toast.showToast(t('Workspace admin permission is required to change default models.'), 'error');
      } else {
        toast.showToast(error instanceof Error ? error.message : t('Could not save settings'), 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="om-settings-page" aria-label={t('Model gateway')}>
      {directory.error ? <SettingsError retry={directory.refresh} /> : !data || !provider ? <SettingsLoading /> : (
        <>
          <header className="om-settings-row">
            <div className="om-provider-heading">
              <ProviderAvatar name={provider.label} provider={provider} />
              <div>
                <h1 className="om-title">{t('OpenDesign Model Gateway')}</h1>
                <span className="om-muted">{t('Unified platform media generation · No BYOK API keys required')}</span>
              </div>
            </div>
            <div className="om-settings-actions">
              {openAccount && (
                <Button variant="ghost" className="om-button h-auto" onClick={openAccount}>
                  {t('Manage account')}
                </Button>
              )}
              <Button variant="ghost" className="om-button h-auto" data-primary disabled={busy} onClick={() => void syncCatalog()}>
                <RemixIcon name="refresh-line" size={15} />
                {t(busy ? 'Working…' : 'Sync models')}
              </Button>
            </div>
          </header>

          {isMockGateway && (
            <section className="om-card om-card-stack" role="status" data-mock-gateway="true">
              <div className="om-settings-row">
                <h2 className="om-subtitle">{t('Local Mock Model Gateway')}</h2>
                <span className="om-badge" data-active="true">MODEL_GATEWAY_MODE=mock</span>
              </div>
              <p className="om-muted">
                {t('Media generation returns deterministic local fixture assets (PNG image, MP4 video, WAV audio) without external API calls or billing. Configure MODEL_GATEWAY_MODE=opendesign with platform credentials for live models.')}
              </p>
            </section>
          )}

          <GatewayStatusCard provider={provider} data={data} openAccount={models.length > 0 ? openAccount : undefined} />

          <section className="om-model-section" aria-label={t('Models')}>
            <div className="om-settings-row">
              <h2 className="om-subtitle">{t('Available models')} <span className="om-muted">{models.length}</span></h2>
            </div>
            {models.length > 0 ? (
              <ModelCatalog
                models={models}
                render={model => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    provider={provider}
                    selected={data.defaults[model.kind] === model.id}
                    busy={busy}
                    onSelect={selected => void setDefaultModel(model, selected)}
                  />
                )}
              />
            ) : (
              <EmptyModelCatalogCard consoleUrl={data.consoleUrl} openAccount={openSubscription ?? openAccount} />
            )}
          </section>

          {onClose && (
            <Button variant="ghost" className="om-button h-auto" onClick={onClose}>
              {t('Back to editor')}
            </Button>
          )}
        </>
      )}
      <StudioToastViewport {...toast} />
    </section>
  );
}

function GatewayStatusCard({
  provider,
  data,
  openAccount,
}: {
  provider: ProviderConnection;
  data: CloudProviderDirectory;
  openAccount?: () => void;
}) {
  const { t, locale } = useI18n();
  const billing = data.billing;
  return (
    <div className="om-card om-card-stack">
      <div className="om-settings-row">
        <div className="om-settings-tags">
          {provider.kinds.map(kind => <span className="om-badge" key={kind}>{modelKindLabel(kind, t, locale)}</span>)}
          <span className="om-badge" data-active={provider.available}>
            {t(provider.available ? 'Available' : 'Unavailable')}
          </span>
          {billing?.plan && <span className="om-badge">{billing.plan}</span>}
        </div>
        {openAccount && !provider.available && (
          <Button variant="ghost" className="om-button h-auto" data-primary onClick={openAccount}>
            {t('Check account & plan')}
          </Button>
        )}
      </div>
      <p className="om-muted">
        {t(provider.reason || 'All media models are provisioned and billed centrally through your OpenDesign workspace.')}
      </p>
    </div>
  );
}

function EmptyModelCatalogCard({
  consoleUrl,
  openAccount,
}: {
  consoleUrl?: string;
  openAccount?: () => void;
}) {
  const { t } = useI18n();
  const offer = activeAccountOffer();
  const openUpgrade = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.detail === 0 && event.button === 0) {
      event.currentTarget.href = buildSubscriptionUrl(consoleUrl, 'openmotion_manage_subscription');
    }
    tracking.reportSettingsClick('provider_detail', 'view_plans');
  };
  return (
    <section className="om-card om-plan-guide" data-empty-models="true">
      <div className="om-plan-guide-head">
        <h3 className="om-title">{t('No media models available yet')}</h3>
        <span className="om-badge" data-active="true">{t('Plus and above')}</span>
      </div>
      <p className="om-muted">
        {t('Your OpenDesign workspace currently has no available image, video or audio models. Upgrade to Plus to unlock multimodal generation, then sync models.')}
      </p>
      <ul className="om-account-capabilities" aria-label={t('Multimodal')}>
        {MULTIMODAL_CAPABILITIES.map(item => (
          <li key={item.label}><RemixIcon name={item.icon} size={16} />{t(item.label)}</li>
        ))}
      </ul>
      {offer && (
        <p className="om-account-offer">
          <RemixIcon name="sparkling-fill" size={15} />
          <strong>{t(offer.title)}</strong>
          {offer.detail && <span>{t(offer.detail)}</span>}
        </p>
      )}
      <div className="om-settings-actions">
        <a
          className="om-button"
          data-primary
          href={buildSubscriptionUrl(consoleUrl, 'openmotion_manage_subscription')}
          target="_blank"
          rel="noreferrer"
          onPointerDown={event => {
            event.currentTarget.href = buildSubscriptionUrl(consoleUrl, 'openmotion_manage_subscription');
          }}
          onClick={openUpgrade}
          onAuxClick={event => { if (event.button === 1) openUpgrade(event); }}
        >
          <RemixIcon name="sparkling-line" size={16} />{t('Upgrade to Plus')}<RemixIcon name="external-link-line" size={15} />
        </a>
        {openAccount && (
          <Button variant="ghost" className="om-button h-auto" onClick={openAccount}>
            {t('Check account & plan')}
          </Button>
        )}
      </div>
    </section>
  );
}

function ModelRow({
  model,
  provider,
  selected,
  busy,
  onSelect,
}: {
  model: DirectoryModel;
  provider: ProviderConnection;
  selected: boolean;
  busy: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const canSetDefault = ['image', 'video', 'audio'].includes(model.kind);
  const displayLabel = modelDisplayLabel(model);
  const showModelId = shouldShowInlineModelId(displayLabel, model.modelId, provider.protocol);
  const idHint = !showModelId && model.modelId.trim() && model.modelId.trim() !== displayLabel.trim() ? model.modelId : undefined;
  const capabilityHints = modelMediaCapabilities(model, t);
  return (
    <div className="om-model-row" data-selected={selected || undefined}>
      <ModelAvatar name={displayLabel} modelId={model.modelId} provider={provider} />
      <div className="om-model-name">
        <div className="om-model-title">
          <strong title={idHint}>{displayLabel}</strong>
          {showModelId && <small className="om-muted om-model-id">{model.modelId}</small>}
        </div>
        {capabilityHints.length > 0 && <small className="om-muted om-model-capabilities">{capabilityHints.join(' · ')}</small>}
      </div>
      <span className="om-badge om-model-kind-badge">{modelKindLabel(model.kind, t, locale)}</span>
      {canSetDefault && (
        <Button
          variant="ghost"
          className="om-button h-auto om-model-default-button"
          data-active={selected || undefined}
          aria-pressed={selected}
          disabled={busy || !model.enabled || !provider.available}
          aria-label={t('Use {model} as default', { model: displayLabel })}
          onClick={() => onSelect(selected)}
        >
          {selected ? <><RemixIcon name="check-line" size={14} />{t('Default')}</> : t('Use model')}
        </Button>
      )}
    </div>
  );
}
