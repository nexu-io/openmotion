import { useState } from 'react';
import { inputModalities, modelCapabilities, modelKinds, type DirectoryModel, type ModelKind, type ProviderConnection } from '../../../shared/provider-directory';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { SettingsDialog } from './settingsPrimitives';

export const kindLabels: Record<ModelKind, string> = { text: 'Language', image: 'Image', video: 'Video', audio: 'Audio', embedding: 'Embedding', reranker: 'Reranker' };
export const typeIcons: Record<ModelKind, string> = { text: 'text', image: 'image-line', video: 'film-line', audio: 'music-2-line', embedding: 'stack-line', reranker: 'equalizer-line' };
const capabilityIcons = { reasoning: 'flashlight-line', tools: 'plug-line', vision: 'eye-line', audio: 'music-2-line', video: 'film-line' };
export const capabilityLabels = { reasoning: 'Reasoning', tools: 'Tools', vision: 'Vision', audio: 'Audio', video: 'Video' };
const limits = [
  { key: 'contextWindow', label: 'Context window', presets: [128000, 200000, 262144, 400000, 524288, 1000000] },
  { key: 'maxInputTokens', label: 'Max input tokens', presets: [128000, 200000, 256000, 512000, 1000000] },
  { key: 'maxOutputTokens', label: 'Max output tokens', presets: [16384, 32768, 65536, 128000, 256000] },
] as const;

export function ModelEditor({ provider, model, onClose, save, onError }: { provider: ProviderConnection; model?: DirectoryModel; onClose: () => void; save: (input: unknown) => Promise<boolean>; onError: (message: string) => void }) {
  const { t } = useI18n();
  const [id, setId] = useState(model?.modelId ?? ''), [label, setLabel] = useState(model?.label ?? ''), [group, setGroup] = useState(model?.group ?? '');
  const [kind, setKind] = useState<ModelKind>(model?.kind ?? (provider.protocol === 'media' ? 'image' : 'text'));
  const [capabilities, setCapabilities] = useState(model?.capabilities ?? []), [inputs, setInputs] = useState(model?.inputs ?? []);
  const [tokens, setTokens] = useState(Object.fromEntries(limits.map(({ key }) => [key, model?.[key]?.toString() ?? ''])));
  const [defaults, setDefaults] = useState(JSON.stringify(model?.defaults ?? {}, null, 2)), [advanced, setAdvanced] = useState(Boolean(model)), [busy, setBusy] = useState(false);
  const field = (title: string, value: string, change: (value: string) => void, required = false, disabled = false) => <label className="om-label">{t(title)}<span className="om-field"><input aria-label={t(title)} value={value} onChange={e => change(e.target.value)} required={required} disabled={disabled} autoComplete="off" spellCheck={false} /></span></label>;
  return <SettingsDialog title={t(model ? 'Edit model' : 'Add model')} onClose={onClose}><form className="om-provider-form" onSubmit={async event => {
    event.preventDefault();
    let parameters: unknown;
    try { parameters = JSON.parse(defaults); if (!parameters || Array.isArray(parameters) || typeof parameters !== 'object') throw new Error(); }
    catch { onError(t('Default parameters must be a JSON object')); return; }
    setBusy(true);
    try { if (await save({ id: model?.id, modelId: id.trim(), label: label.trim() || id.trim(), kind, group, capabilities, inputs, ...Object.fromEntries(limits.map(({ key }) => [key, tokens[key] ? Number(tokens[key]) : null])), defaults: parameters })) onClose(); }
    finally { setBusy(false); }
  }}>
    {field('Model ID', id, setId, true, Boolean(model))}
    {field('Display name', label, setLabel)}
    {field('Group name', group, setGroup)}
    <button className="om-button om-disclosure" type="button" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>{t('More settings')}<RemixIcon name={advanced ? 'arrow-up-line' : 'arrow-down-s-line'} size={15} /></button>
    {advanced && <div className="om-card-stack">
      <div className="om-card om-card-stack">
        <div className="om-label">{t('Model type')}<div className="om-settings-tags">{modelKinds.filter(value => provider.protocol !== 'media' || ['image', 'video', 'audio'].includes(value)).map(value => <button type="button" className="om-button" key={value} aria-pressed={kind === value} disabled={Boolean(model) && ['media', 'agent', 'account'].includes(provider.protocol) && kind !== value} onClick={() => setKind(value)}><RemixIcon name={typeIcons[value]} size={14} />{t(kindLabels[value])}</button>)}</div></div>
        <div className="om-label">{t('Model capabilities')}<div className="om-settings-tags">{modelCapabilities.map(value => <button type="button" className="om-button" key={value} aria-pressed={capabilities.includes(value)} onClick={() => setCapabilities(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])}><RemixIcon name={capabilityIcons[value]} size={14} />{t(capabilityLabels[value])}</button>)}</div></div>
        <div className="om-label">{t('Input modalities')}<div className="om-settings-tags">{inputModalities.map(value => <button type="button" className="om-button" key={value} aria-pressed={inputs.includes(value)} onClick={() => setInputs(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])}><RemixIcon name={capabilityIcons[value]} size={14} />{t(capabilityLabels[value])}</button>)}</div></div>
      </div>
      <div className="om-card om-card-stack">{limits.map(({ key, label: title, presets }) => <label className="om-label" key={key}>{t(title)}<span className="om-settings-tags">{presets.map(value => <button key={value} type="button" className="om-button" aria-label={`${t(title)}: ${value}`} aria-pressed={tokens[key] === String(value)} onClick={() => setTokens(current => ({ ...current, [key]: String(value) }))}>{value >= 1000000 ? `${value / 1000000}M` : `${[262144, 524288, 16384, 32768, 65536].includes(value) ? value / 1024 : value / 1000}K`}</button>)}</span><span className="om-field"><input aria-label={t(title)} type="number" min="1" max="100000000" step="1" value={tokens[key]} onChange={event => setTokens(current => ({ ...current, [key]: event.target.value }))} /></span></label>)}<p className="om-muted">{t('Token limits describe this model. They do not change the provider’s actual limits.')}</p></div>
      <label className="om-label">{t('Default request parameters (JSON)')}<span className="om-field om-code-field"><textarea aria-label={t('Default request parameters (JSON)')} rows={5} spellCheck={false} value={defaults} onChange={event => setDefaults(event.target.value)} /></span><small className="om-muted">{t('Use the provider’s parameter names. Per-request values override these defaults. Language model settings are saved for integrations; local Agents manage their own parameters.')}</small></label>
    </div>}
    <div className="om-dialog-actions"><button className="om-button" type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="om-button" data-primary disabled={busy || !id.trim()}>{t(busy ? 'Saving…' : model ? 'Save model' : 'Add model')}</button></div>
  </form></SettingsDialog>;
}
