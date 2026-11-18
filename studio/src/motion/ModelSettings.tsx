import * as tracking from './pageTracking';
import { Tooltip } from "../components/ui/Tooltip";
import { useEffect, useId, useRef, useState } from 'react';
import { type DirectoryModel, type ProviderConnection, type ProviderDirectory } from '../../../shared/provider-directory';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../components/ui/Menu';
import { Select } from '../components/ui/Select';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { gatewayRequest } from './gatewayClient';
import { notifyProvidersChanged, useProviderDirectory } from './useProviderDirectory';
import { ProviderAvatar, ModelAvatar, SettingsDialog, SettingsError, SettingsLoading, Toggle } from './settingsPrimitives';

import { ModelEditor, kindLabels, capabilityLabels } from './ModelEditor';
import { ModelCatalog } from './ModelCatalog';
import { apiKeyError, apiUrlError, providerNameError } from './settingsValidation';
export { kindLabels } from './ModelEditor';
const categories = [{ id: 'all', label: 'All providers' }, { id: 'configured', label: 'Configured' }, { id: 'multimodal', label: 'Multimodal' }, { id: 'language', label: 'Language' }, { id: 'media', label: 'Media' }, { id: 'local', label: 'Local' }, { id: 'custom', label: 'Custom' }];
type Change = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

/** Sidebar status: a dot only when the provider can actually run; configured-but-switched-off reads as Disabled. Unconfigured providers stay unmarked. */
export function providerListStatus(provider: { configured: boolean; enabled: boolean; available: boolean }): 'available' | 'disabled' | null {
  if (provider.available) return 'available';
  return provider.configured && !provider.enabled ? 'disabled' : null;
}

export function ModelSettings({ onClose, openAccount, initialCategory = 'all', providerId, onProviderChange }: { onClose?: () => void; openAccount?: () => void; initialCategory?: string; providerId?: string | null; onProviderChange?: (id: string | null) => void }) {
  const { t } = useI18n(), directory = useProviderDirectory(), toast = useToast();
  const [localSelected, setSelected] = useState(initialCategory === 'local' ? 'codex' : 'account'), [query, setQuery] = useState(''), [category, setCategory] = useState(initialCategory);
  const requestedProvider = providerId === undefined ? localSelected : providerId ?? 'account';
  const [status, setStatus] = useState('all'), [protocol, setProtocol] = useState('all');
  const [adding, setAdding] = useState(false), [localDetailOpen, setDetailOpen] = useState(false);
  const detailOpen = providerId === undefined ? localDetailOpen : Boolean(providerId);
  const data = directory.data;
  const visibleProviders = data?.providers.filter(provider => {
    const models = data.models.filter(model => model.provider === provider.id);
    const textOnly = provider.kinds.length > 0 && provider.kinds.every(kind => kind === 'text') && models.every(model => model.kind === 'text');
    // New custom connections need to remain configurable before their first model sync.
    return !textOnly || provider.custom && !models.length;
  }) ?? [];
  const selected = visibleProviders.some(provider => provider.id === requestedProvider) ? requestedProvider : 'account';
  const providers = visibleProviders.filter(provider => {
    const matches = category === 'all' || category === 'configured' && provider.configured || category === 'multimodal' && provider.kinds.length > 1
      || category === 'language' && provider.kinds.includes('text') || category === 'media' && provider.kinds.some(kind => ['image', 'video', 'audio', 'transcription'].includes(kind))
      || category === 'local' && provider.category === 'local' || category === 'custom' && provider.custom;
    return matches && (status === 'all' || status === 'enabled' && provider.enabled || status === 'disabled' && !provider.enabled || status === 'configured' && provider.configured || status === 'unconfigured' && !provider.configured) && (protocol === 'all' || provider.protocol === protocol) && `${t(provider.label)} ${provider.label} ${provider.id}`.toLowerCase().includes(query.toLowerCase());
  }) ?? [];
  const provider = visibleProviders.find(provider => provider.id === selected);
  const select = (id: string) => {
    const item = visibleProviders.find(provider => provider.id === id);
    if (item) tracking.reportSettingsClick('provider_list', 'select_provider', { provider: item });
    setSelected(id); setDetailOpen(true); onProviderChange?.(id);
  };
  const renderProvider = (item: ProviderConnection) => <Tooltip label={`${t(item.label)} · ${t(item.category === 'account' ? 'Your account' : item.custom ? 'Custom provider' : item.kinds.length > 1 ? 'Multimodal' : kindLabels[item.kinds[0]])}`} wrap key={item.id}><button aria-label={`${t(item.label)} · ${t(item.category === 'account' ? 'Your account' : item.custom ? 'Custom provider' : item.kinds.length > 1 ? 'Multimodal' : kindLabels[item.kinds[0]])}${providerListStatus(item) ? ` · ${t(providerListStatus(item) === 'available' ? 'Available' : 'Disabled')}` : ''}`} className="om-nav-item om-provider-item" data-status={providerListStatus(item)} onClick={() => select(item.id)} aria-current={item.id === selected ? 'page' : undefined}>
        <ProviderAvatar name={item.label} provider={item} /><span className="om-provider-item-name">{t(item.region ?? item.label)}<small className="sr-only">{t(item.category === 'account' ? 'Your account' : item.custom ? 'Custom provider' : item.kinds.length > 1 ? 'Multimodal' : kindLabels[item.kinds[0]])}</small></span>
        {providerListStatus(item) === 'available' ? <span className="om-status-dot" role="img" aria-label={t('Available')} /> : providerListStatus(item) === 'disabled' ? <span className="om-badge">{t('Disabled')}</span> : null}
      </button></Tooltip>;
  const closeDetail = () => { setDetailOpen(false); onProviderChange?.(null); };
  return <section className="om-provider-settings" data-detail={detailOpen} aria-label={t('Model providers')}>
    <aside className="om-provider-list">
      <div className="om-provider-search"><label className="om-field"><RemixIcon name="search-line" size={16} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search providers…')} aria-label={t('Search providers')} /></label>
        <Menu tooltip={t('Filter providers')} className="om-filter-menu" modal={false} aria-label={t('Filter providers')} trigger={<button className="motion-icon-button" aria-label={t('Filter providers')}><RemixIcon name="filter-3-line" size={17} /></button>}>
          <MenuRadioGroup value={category} onValueChange={value => { tracking.reportSettingsClick('provider_list', 'provider_filter'); setCategory(String(value)); }}>{categories.map(item => <MenuRadioItem value={item.id} key={item.id}>{t(item.label)}</MenuRadioItem>)}</MenuRadioGroup><MenuSeparator /><div className="om-menu-caption">{t('Status')}</div><MenuRadioGroup value={status} onValueChange={value => setStatus(String(value))}>{[['all', 'All statuses'], ['enabled', 'Enabled'], ['disabled', 'Disabled'], ['configured', 'Configured'], ['unconfigured', 'Not configured']].map(([id, label]) => <MenuRadioItem key={id} value={id}>{t(label)}</MenuRadioItem>)}</MenuRadioGroup><MenuSeparator /><div className="om-menu-caption">{t('API protocol')}</div><MenuRadioGroup value={protocol} onValueChange={value => setProtocol(String(value))}>{[['all', 'All protocols'], ['openai', 'OpenAI compatible'], ['anthropic', 'Anthropic'], ['google', 'Google Gemini'], ['media', 'Media'], ['account', 'Your account'], ['agent', 'Local Agent']].map(([id, label]) => <MenuRadioItem key={id} value={id}>{t(label)}</MenuRadioItem>)}</MenuRadioGroup>
        </Menu>
      </div>
      <div className="om-provider-list-caption"><span className="om-eyebrow">{t(categories.find(item => item.id === category)?.label ?? 'All providers')} · {providers.length}</span>{(category !== 'all' || query || status !== 'all' || protocol !== 'all') && <Tooltip label={t('Clear filters')} wrap><button className="motion-icon-button" aria-label={t('Clear filters')} onClick={() => { setQuery(''); setCategory('all'); setStatus('all'); setProtocol('all'); }}><RemixIcon name="close-line" size={14} /></button></Tooltip>}</div>
      <div className="om-settings-tags om-provider-filter-tags">{status !== 'all' && <button className="om-badge" onClick={() => setStatus('all')}>{t(({ enabled: 'Enabled', disabled: 'Disabled', configured: 'Configured', unconfigured: 'Not configured' } as Record<string, string>)[status])}<RemixIcon name="close-line" size={12} /></button>}{protocol !== 'all' && <button className="om-badge" onClick={() => setProtocol('all')}>{protocol}<RemixIcon name="close-line" size={12} /></button>}</div>
      <div className="om-provider-list-state">{directory.error ? <SettingsError retry={directory.refresh} /> : !directory.data ? <SettingsLoading /> : null}</div>
      <nav aria-label={t('Providers')} className="om-provider-items">{providers.map((item, index) => item.group ? providers.findIndex(other => other.group === item.group) === index && <section className="om-provider-group" aria-label={item.group} key={item.group}>
        <div className="om-provider-group-title om-eyebrow">{item.group}</div><div className="om-provider-group-items">{providers.filter(other => other.group === item.group).map(renderProvider)}</div>
      </section> : renderProvider(item))}{directory.data && !providers.length && <p className="om-empty om-muted">{t('No matching providers')}</p>}</nav>
      <button className="om-button om-add-provider" onClick={() => { tracking.reportSettingsClick('provider_list', 'add_provider'); setAdding(true); }}><RemixIcon name="add-line" size={16} />{t('Add provider')}</button>
    </aside>
    <div className="om-provider-detail">
      <button className="om-button om-provider-back" onClick={closeDetail}><RemixIcon name="arrow-left-line" size={16} />{t('Providers')}</button>
      {directory.error ? <SettingsError retry={directory.refresh} /> : !directory.data ? <SettingsLoading /> : provider ? <ProviderDetail key={provider.id} provider={provider} data={directory.data} openAccount={openAccount} showToast={toast.showToast} onRemoved={() => { setSelected('account'); closeDetail(); }} /> : <div className="om-empty">{t('Select a provider')}</div>}
    </div>
    {adding && <AddProvider onClose={() => setAdding(false)} onAdded={id => { setAdding(false); setCategory('all'); setQuery(''); select(id); notifyProvidersChanged(); toast.showToast(t('Provider added'), 'info'); }} showToast={toast.showToast} />}
    {onClose && <button className="om-button" onClick={onClose}>{t('Back to editor')}</button>}
    <StudioToastViewport {...toast} />
  </section>;
}

function useProviderValidation(label: string | undefined, baseUrl: string | undefined, apiKey: string, provider?: ProviderConnection) {
  const [validated, setValidated] = useState(false), [focusRequest, setFocusRequest] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const errors = { label: label === undefined ? undefined : providerNameError(label), baseUrl: baseUrl === undefined ? undefined : apiUrlError(baseUrl, provider?.protocol === 'media'), apiKey: apiKeyError(apiKey) };
  if (provider?.protocol !== 'media' && provider?.credentialSource === 'stored' && !apiKey.trim() && baseUrl !== undefined && !errors.baseUrl) {
    let storedOrigin: string | undefined;
    try { storedOrigin = new URL(provider.baseUrl).origin; } catch { /* An unset or malformed stored URL has no origin to compare. */ }
    if (storedOrigin && new URL(baseUrl).origin !== storedOrigin) {
      errors.apiKey = 'Enter the API key again when changing the API origin.';
    }
  }
  useEffect(() => {
    if (!focusRequest) return;
    const field = formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
    field?.focus(); field?.scrollIntoView({ block: 'nearest' });
  }, [focusRequest]);
  return { formRef, reset: () => setValidated(false), errors: validated ? errors : { label: undefined, baseUrl: undefined, apiKey: undefined }, validate: () => {
    setValidated(true);
    if (Object.values(errors).some(Boolean)) { setFocusRequest(value => value + 1); return false; }
    return true;
  } };
}

function ProviderDetail({ provider, data, openAccount, showToast, onRemoved }: { provider: ProviderConnection; data: ProviderDirectory; openAccount?: () => void; showToast: ReturnType<typeof useToast>['showToast']; onRemoved: () => void }) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState(''), [baseUrl, setBaseUrl] = useState(provider.baseUrl), [label, setLabel] = useState(provider.label);
  const [busy, setBusy] = useState(false), [visible, setVisible] = useState(false), [addModel, setAddModel] = useState(false), [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState<DirectoryModel | null>(null);
  const models = data.models.filter(model => model.provider === provider.id);

  const fixedOrigin = provider.baseUrlEditable === false;
  const validation = useProviderValidation(provider.custom ? label : undefined, fixedOrigin ? undefined : baseUrl, apiKey, provider);
  const keyErrorId = useId();
  useEffect(() => { setBaseUrl(provider.baseUrl); setLabel(provider.label); }, [provider.baseUrl, provider.label]);
  const change: Change = async (action, message) => {
    setBusy(true);
    const reported = tracking.providerAction(message);
    try { await action(); notifyProvidersChanged(); showToast(t(message), 'info'); if (reported) tracking.reportProviderSetting(provider, reported, 'success'); return true; }
    catch (error) { if (reported) tracking.reportProviderSetting(provider, reported, 'failure'); showToast(error instanceof Error ? error.message : t('Could not save settings'), 'error'); return false; }
    finally { setBusy(false); }
  };
  return <div className="om-provider-detail-inner">
    <header className="om-settings-row"><div className="om-provider-heading"><ProviderAvatar name={provider.label} provider={provider} /><div><h1 className="om-title">{t(provider.label)}</h1><span className="om-muted">{t(provider.category === 'account' ? 'Your account' : provider.custom ? 'Custom provider' : 'Built-in provider')}</span></div></div>
      {provider.protocol !== 'account' && !provider.setupRequired && <Toggle label={t('Enable provider')} checked={provider.enabled} disabled={busy || !provider.configured && provider.protocol !== 'agent'} onChange={enabled => void change(() => gatewayRequest(`settings/providers/${provider.id}`, 'PUT', { enabled }), 'Provider updated')} />}
    </header>
    <div className="om-settings-tags">{provider.kinds.map(kind => <span className="om-badge" key={kind}>{t(kindLabels[kind])}</span>)}<span className="om-badge" data-active={provider.configured}>{t(provider.configured ? 'Configured' : 'Not configured')}</span></div>
    {provider.protocol === 'account' ? <div className="om-card om-account-callout"><RemixIcon name="account-circle-line" size={28} /><div><h2 className="om-subtitle">{t(provider.configured ? 'Your OpenDesign models, in OpenMotion' : 'One account. Your models, together.')}</h2><p className="om-muted">{t(provider.configured ? 'Account models and your own providers can be selected side by side.' : 'Sign in with OpenDesign to sync your models, subscription and usage.')}</p>{provider.configured && provider.reason && <p className="om-muted">{t(provider.reason)}</p>}<button className="om-button" data-primary onClick={openAccount}>{t(provider.configured ? 'Manage account' : 'Sign in with OpenDesign')}</button></div></div>
      : provider.protocol === 'agent' ? <div className="om-card om-card-stack"><h2 className="om-subtitle">{t('Local Agent')}</h2><p className="om-muted">{t(provider.reason)}</p><p className="om-muted">{t('Uses your installed Agent and its own sign-in. No API key is copied.')}</p><button className="om-button" disabled={busy} onClick={() => void change(() => gatewayRequest(`settings/providers/${provider.id}/sync`, 'POST', {}), 'Agent status refreshed')}>{t('Refresh status')}</button></div>
      : provider.setupRequired ? <div className="om-card om-card-stack"><h2 className="om-subtitle">{t('Dedicated integration required')}</h2><p className="om-muted">{t(provider.reason)}</p>{provider.website && <a className="om-button" href={provider.website} target="_blank" rel="noreferrer">{t('Provider website')}<RemixIcon name="external-link-line" size={14} /></a>}</div>
      : <form noValidate ref={validation.formRef} className="om-provider-form" onSubmit={event => { event.preventDefault(); if (!validation.validate()) return; void change(async () => {
        await gatewayRequest(`settings/providers/${provider.id}`, 'PUT', { ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(!fixedOrigin ? { baseUrl: baseUrl.trim() } : {}), ...(provider.custom ? { label } : {}) }); validation.reset(); setApiKey(''); setVisible(false);
      }, 'Provider settings saved'); }}>
        {provider.custom && <TextField label={t('Provider name')} value={label} onChange={setLabel} error={validation.errors.label} required />}
        <label className="om-label">{t('API key')}<span className="om-field"><input type={visible ? 'text' : 'password'} aria-label={`${provider.label} API key`} aria-invalid={Boolean(validation.errors.apiKey) || undefined} aria-describedby={validation.errors.apiKey ? keyErrorId : undefined} autoComplete="off" spellCheck={false} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={t(provider.configured ? 'Key saved · enter to replace' : 'Paste your API key')} /><Tooltip label={t(visible ? 'Hide API key' : 'Show API key')} wrap><button type="button" className="motion-icon-button" aria-label={t(visible ? 'Hide API key' : 'Show API key')} onClick={() => setVisible(value => !value)}><RemixIcon name={visible ? 'eye-off-line' : 'eye-line'} size={16} /></button></Tooltip></span><small id={keyErrorId} className="om-field-error" role={validation.errors.apiKey ? 'alert' : undefined}>{validation.errors.apiKey ? t(validation.errors.apiKey) : null}</small></label>
        <div className="om-settings-row"><span className="om-muted">{t(provider.credentialSource === 'environment' ? 'Using environment key' : 'Keys stay on this computer and are never returned by the API.')}</span>{provider.website && <a href={provider.website} target="_blank" rel="noreferrer" className="om-text-link">{t('Get API key')}<RemixIcon name="external-link-line" size={13} /></a>}</div>
        {fixedOrigin && provider.region && <div className="om-label">{t('API base URL')}<span className="om-muted">{provider.baseUrl}</span></div>}
        {!fixedOrigin && <TextField label={t('API base URL')} value={baseUrl} onChange={setBaseUrl} error={validation.errors.baseUrl} type="url" required placeholder="https://api.example.com/v1" />}
        <div className="om-settings-row"><div className="om-settings-actions"><button className="om-button" data-primary disabled={busy || !apiKey.trim() && baseUrl === provider.baseUrl && label === provider.label}>{t(busy ? 'Saving…' : 'Save settings')}</button>
          {provider.credentialSource === 'stored' && <button className="om-button" type="button" disabled={busy} onClick={() => void change(async () => { await gatewayRequest(`settings/providers/${provider.id}`, 'PUT', { apiKey: null }); setApiKey(''); }, 'Saved key removed')}>{t('Remove saved key')}</button>}</div>
          {provider.docs && <a className="om-text-link" href={provider.docs} target="_blank" rel="noreferrer">{t('Usage guide')}<RemixIcon name="external-link-line" size={13} /></a>}
        </div>
      </form>}
    <section className="om-model-section" aria-label={t('Models')}>
      <div className="om-settings-row"><h2 className="om-subtitle">{t('Models')} <span className="om-muted">{models.length}</span></h2><div className="om-settings-actions"><button className="om-button" disabled={busy || !provider.configured || provider.setupRequired} onClick={() => void change(() => gatewayRequest(`settings/providers/${provider.id}/sync`, 'POST', {}), 'Models synced')}><RemixIcon name="refresh-line" size={15} />{t(busy ? 'Working…' : 'Sync models')}</button>
        {!['agent', 'account'].includes(provider.protocol) && !provider.setupRequired && <Tooltip label={t('Add model')} wrap><button className="om-button" aria-label={t('Add model')} onClick={() => setAddModel(true)}><RemixIcon name="add-line" size={17} /></button></Tooltip>}</div></div>
      <ModelCatalog models={models} render={model => <ModelRow key={model.id} model={model} provider={provider} selected={data.defaults[model.kind] === model.id} busy={busy} change={change} edit={() => setEditing(model)} />} />
    </section>
    {provider.custom && <div className="om-settings-row om-provider-remove"><span className="om-muted">{t('Remove this provider and its saved models from this workspace.')}</span><button className="om-button" disabled={busy} onClick={() => setRemoving(true)}>{t('Delete provider')}</button></div>}
    {removing && <SettingsDialog title={t('Delete provider')} onClose={() => setRemoving(false)}><p className="om-muted">{t('This removes the saved key and models. Existing project media is kept.')}</p><div className="om-settings-actions"><button className="om-button" onClick={() => setRemoving(false)}>{t('Cancel')}</button><button className="om-button" data-primary disabled={busy} onClick={() => void change(() => gatewayRequest(`settings/providers/${provider.id}`, 'DELETE'), 'Provider deleted').then(ok => { if (ok) onRemoved(); })}>{t('Delete')}</button></div></SettingsDialog>}
    {editing && <ModelEditor provider={provider} model={editing} onClose={() => setEditing(null)} save={input => change(() => gatewayRequest('settings/models', 'PATCH', input), 'Model updated')} />}
    {addModel && <ModelEditor provider={provider} onClose={() => setAddModel(false)} save={input => change(() => gatewayRequest(`settings/providers/${provider.id}/models`, 'POST', input), 'Model added')} />}
  </div>;
}

function ModelRow({ model, provider, selected, busy, change, edit }: { model: DirectoryModel; provider: ProviderConnection; selected: boolean; busy: boolean; change: Change; edit: () => void }) {
  const { t } = useI18n();
  const executable = !['image', 'video', 'audio'].includes(model.kind) || ['media', 'agent', 'account'].includes(provider.protocol) || provider.protocol === 'openai' && ['image', 'audio'].includes(model.kind);
  return <div className="om-model-row"><ModelAvatar name={model.label} modelId={model.modelId} provider={provider} /><div className="om-model-name"><strong>{model.label}</strong><small className="om-muted">{model.modelId}</small><div className="om-settings-tags om-model-metadata">{[...(model.capabilities ?? []), ...(model.inputs ?? [])].map(value => <span className="om-badge" key={value}>{t(capabilityLabels[value])}</span>)}{model.contextWindow && <span className="om-muted">{Intl.NumberFormat().format(model.contextWindow)} {t('context tokens')}</span>}</div></div><span className="om-badge">{t(kindLabels[model.kind])}</span>
    <button className="om-button" disabled={busy || !model.enabled || !provider.available || !executable} aria-label={t('Use {model} as default', { model: model.label })} onClick={() => void change(() => gatewayRequest('settings/default-model', 'PUT', { kind: model.kind, model: selected ? null : model.id }), 'Default model updated')}>{selected ? <><RemixIcon name="check-line" size={14} />{t('Default')}</> : t('Use model')}</button>
    <Menu tooltip={t('Model options')} modal={false} trigger={<button className="motion-icon-button" aria-label={t('Model options')}><RemixIcon name="more-2-line" size={16} /></button>}><MenuItem onClick={edit}>{t('Edit model')}</MenuItem>{!['media', 'agent', 'account'].includes(provider.protocol) && <><MenuSeparator /><MenuItem onClick={() => void change(() => gatewayRequest('settings/models', 'PUT', { id: model.id, enabled: !model.enabled }), 'Model updated')}>{t(model.enabled ? 'Disable model' : 'Enable model')}</MenuItem><MenuItem onClick={() => void change(() => gatewayRequest('settings/models', 'PUT', { id: model.id, enabled: null }), 'Model removed')}>{t('Remove model')}</MenuItem></>}</Menu>
  </div>;
}
function TextField({ label, value, onChange, type = 'text', required, placeholder, error }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean; placeholder?: string; error?: string }) {
  const id = useId(), { t } = useI18n();
  return <label className="om-label">{label}<span className="om-field"><input type={type} required={required} aria-label={label} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? id : undefined} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} /></span><small id={id} className="om-field-error" role={error ? 'alert' : undefined}>{error ? t(error) : null}</small></label>;
}
function AddProvider({ onClose, onAdded, showToast }: { onClose: () => void; onAdded: (id: string) => void; showToast: ReturnType<typeof useToast>['showToast'] }) {
  const { t } = useI18n();
  const [label, setLabel] = useState(''), [apiKey, setApiKey] = useState(''), [baseUrl, setBaseUrl] = useState(''), [protocol, setProtocol] = useState('openai'), [busy, setBusy] = useState(false);
  const validation = useProviderValidation(label, baseUrl, apiKey);
  return <SettingsDialog title={t('Add custom provider')} onClose={onClose}><form noValidate ref={validation.formRef} className="om-provider-form" onSubmit={event => { event.preventDefault(); if (!validation.validate()) return; setBusy(true); void gatewayRequest<{ id: string }>('settings/providers', 'POST', { label, apiKey: apiKey.trim() || undefined, baseUrl, protocol }).then(({ id }) => { tracking.reportProviderSetting({ id, custom: true }, 'add_provider', 'success'); setApiKey(''); onAdded(id); }).catch(error => { tracking.reportProviderSetting({ id: '', custom: true }, 'add_provider', 'failure'); showToast(error.message, 'error'); }).finally(() => setBusy(false)); }}>
    <div className="om-provider-avatar-preview"><ProviderAvatar name={label || 'P'} /></div>
    <TextField label={t('Provider name')} value={label} onChange={setLabel} error={validation.errors.label} required placeholder={t('My provider')} />
    <TextField label={t('API key')} value={apiKey} onChange={setApiKey} error={validation.errors.apiKey} type="password" placeholder={t('Paste your API key')} />
    <div className="om-label">{t('API protocol')}<Select label={t('API protocol')} value={protocol} onCommit={setProtocol} options={[{ value: 'openai', label: 'OpenAI compatible', icon: <ProviderAvatar name="OpenAI" provider={{ id: 'openai', custom: false }} /> }, { value: 'anthropic', label: 'Anthropic', icon: <ProviderAvatar name="Anthropic" provider={{ id: 'anthropic', custom: false }} /> }, { value: 'google', label: 'Google Gemini', icon: <ProviderAvatar name="Gemini" provider={{ id: 'gemini', custom: false }} /> }]} /></div>
    <TextField label={t('API base URL')} value={baseUrl} onChange={setBaseUrl} error={validation.errors.baseUrl} type="url" required placeholder="https://api.example.com/v1" />
    <small className="om-muted">{t('Include the API version or path prefix used by your provider.')}</small>
    {baseUrl && <p className="om-inset om-muted om-endpoint-preview">{t('Model catalogue')}: {baseUrl.replace(/\/+$/, '')}/models</p>}
    <div className="om-dialog-actions"><button type="button" className="om-button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="om-button" data-primary disabled={busy}>{t(busy ? 'Adding…' : 'Add provider')}</button></div>
  </form></SettingsDialog>;
}
