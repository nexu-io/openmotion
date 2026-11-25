import { Button } from 'open-design-ui/button';
import { useState } from 'react';
import type { ModelKind } from '../../../shared/provider-directory';
import { Popover } from '../components/ui/Popover';
import { Menu, MenuRadioGroup, MenuRadioItem } from '../components/ui/Menu';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { gatewayRequest } from './gatewayClient';
import { useProviderDirectory, notifyProvidersChanged } from './useProviderDirectory';
import { modelKindLabel, typeIcons } from './ModelEditor';
import { ModelAvatar, SettingsError, SettingsLoading } from './settingsPrimitives';
import { SettingsSurfaceBoundary } from './SettingsSurfaceBoundary';

const cloudModelKinds = ['image', 'video', 'audio'] as const;
type CloudModelKind = (typeof cloudModelKinds)[number];

export function ModelSwitcher({ openSettings, capability, label }: { openSettings?: () => void; capability?: ModelKind; label?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen} aria-label={t('Select model')} align="end" className="om-model-picker om-selection-panel" trigger={<Button variant="ghost" className="om-button h-auto" aria-label={t('Select model')} title={t('Select model')}><span>{label || t('Models')}</span><RemixIcon name="arrow-down-s-line" size={12} /></Button>}>
    {open && <SettingsSurfaceBoundary><ModelChoices capability={capability} close={() => setOpen(false)} openSettings={openSettings} /></SettingsSurfaceBoundary>}
  </Popover>;
}

function ModelChoices({ capability, close, openSettings }: { capability?: ModelKind; close: () => void; openSettings?: () => void }) {
  const { t, locale } = useI18n(), directory = useProviderDirectory(), toast = useToast();
  const initialKind: CloudModelKind = capability === 'video' || capability === 'audio' ? capability : 'image';
  const [query, setQuery] = useState(''), [kind, setKind] = useState<CloudModelKind>(initialKind), [busy, setBusy] = useState(false);
  const available = directory.data?.providers.filter(provider => provider.available) ?? [];
  const models = directory.data?.models.filter(model => model.kind === kind && model.enabled
    && (available.length === 0 || available.some(provider => provider.id === model.provider))
    && `${model.label} ${model.modelId} ${model.provider}`.toLowerCase().includes(query.toLowerCase())) ?? [];

  async function choose(model: string | null) {
    setBusy(true);
    try {
      const nextDefaults: Record<string, string | null> = {};
      for (const modality of cloudModelKinds) {
        const existing = directory.data?.defaults[modality];
        if (existing) nextDefaults[modality] = existing;
      }
      if (model === null) delete nextDefaults[kind];
      else nextDefaults[kind] = model;
      await gatewayRequest('models/defaults', 'PUT', nextDefaults);
      notifyProvidersChanged();
      close();
    } catch (error) {
      toast.showToast(error instanceof Error ? error.message : t('Could not select model'), 'error');
    } finally {
      setBusy(false);
    }
  }
  return <>
    <h2 className="om-subtitle">{t('Select model')}</h2>
    <label className="om-field"><RemixIcon name="search-line" size={16} /><input type="search" aria-label={t('Search models')} placeholder={t('Search models…')} value={query} onChange={event => setQuery(event.target.value)} /></label>
    {!capability && <div className="om-settings-actions">
      <Menu modal={false} trigger={<Button variant="ghost" className="om-button h-auto"><RemixIcon name={typeIcons[kind]} size={15} />{modelKindLabel(kind, t, locale)}<RemixIcon name="arrow-down-s-line" size={14} /></Button>}>
        <MenuRadioGroup value={kind} onValueChange={value => setKind(value as CloudModelKind)}>{cloudModelKinds.map(value => <MenuRadioItem closeOnClick key={value} value={value}><RemixIcon name={typeIcons[value]} size={15} />{modelKindLabel(value, t, locale)}</MenuRadioItem>)}</MenuRadioGroup>
      </Menu>
    </div>}
    {directory.error ? <SettingsError retry={directory.refresh} /> : !directory.data ? <SettingsLoading /> : <div className="om-model-choice-list">
      {models.map(model => <Button variant="plain" key={model.id} className="om-nav-item" aria-pressed={directory.data?.defaults[kind] === model.id} disabled={busy} onClick={() => void choose(model.id)}>
        <ModelAvatar name={model.label} modelId={model.modelId} provider={available.find(provider => provider.id === model.provider)} />
        <span className="om-model-choice-label"><strong>{model.label}</strong><small className="om-muted">{available.find(provider => provider.id === model.provider)?.label ?? 'OpenDesign'}</small></span>
        {directory.data?.defaults[kind] === model.id && <RemixIcon name="check-line" size={16} />}
      </Button>)}
      {!models.length && (
        <div className="om-empty om-muted">
          {t(!query.trim() && directory.data.models.length === 0
            ? 'No media models available yet. Check your OpenDesign plan or sync models in Settings.'
            : 'No enabled models. Refresh the OpenDesign model catalog in Settings.')}
        </div>
      )}
    </div>}
    {(openSettings || directory.data?.defaults[kind]) && (
      <div className="om-settings-row om-selection-footer">
        {openSettings && <Button variant="ghost" className="om-button h-auto" onClick={() => { close(); openSettings(); }}><RemixIcon name="settings-3-line" size={15} />{t('Model gateway')}</Button>}
        {directory.data?.defaults[kind] && <Button variant="ghost" className="om-button h-auto" disabled={busy} onClick={() => void choose(null)}>{t('Reset default')}</Button>}
      </div>
    )}
    <StudioToastViewport {...toast} />
  </>;
}
