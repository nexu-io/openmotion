import type { Model } from '../../../shared/gateway';
import type { GenerationOption } from '../../../shared/generation-options';
import { Popover } from '../components/ui/Popover';
import { Select } from '../components/ui/Select';
import { Slider } from '../components/ui/Slider';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';

export type ParameterDraft = { values: Record<string, unknown>; advanced: string };
export const emptyParameters: ParameterDraft = { values: {}, advanced: '{}' };
export function requestParameters(draft: ParameterDraft): Record<string, unknown> {
  const extra = JSON.parse(draft.advanced);
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('Model parameters must be a JSON object');
  // Quick controls are explicit overrides; deleting a quick override restores advanced/default values.
  return { ...extra, ...draft.values };
}
export function GenerationParameters({ model, draft, onChange }: { model: Model; draft: ParameterDraft; onChange: (draft: ParameterDraft) => void }) {
  const { t } = useI18n();
  let extra: Record<string, unknown> = {};
  try { extra = requestParameters({ ...draft, values: {} }); } catch { /* The raw editor remains editable; submission reports parse errors through Toast. */ }
  const fields = model.generationOptions?.fields ?? [];
  const value = (field: GenerationOption) => draft.values[field.key] ?? extra[field.key] ?? model.defaults?.[field.key] ?? field.default;
  const label = (field: GenerationOption) => {
    const v = value(field), option = field.choices?.find(c => c.value === v);
    if (v === undefined) return t('Auto');
    if (typeof v === 'object') return t('Custom');
    if (typeof v === 'boolean') return t(v ? 'On' : 'Off');
    return t(option?.label ?? String(v));
  };
  const set = (field: GenerationOption, value: unknown) => {
    const values = { ...draft.values };
    if (value === undefined) delete values[field.key]; else values[field.key] = value;
    Object.assign(values, field.choices?.find(c => c.value === value)?.requires);
    onChange({ ...draft, values });
  };
  const summary = fields.filter(f => f.kind !== 'text' && f.key !== 'seed' && f.presentation !== 'count' && value(f) !== undefined).slice(0, 3).map(label).join(' · ');
  const constraints = Object.assign({}, ...fields.map(f => f.choices?.find(c => c.value === value(f))?.requires)) as Record<string, string | number>;
  const count = fields.find(f => f.presentation === 'count');
  return <div className="om-generation-settings">
    <Popover side="top" align="start" aria-label={t('Generation settings')} className="om-generation-popover" trigger={<button className="om-nav-item om-generation-summary"><RemixIcon name="equalizer-line" size={17} /><span>{summary || t('Generation settings')}</span><RemixIcon name="arrow-down-s-line" size={15} /></button>}>
      <div className="om-creation-row"><strong>{t('Generation settings')}</strong><button className="om-nav-item" onClick={() => onChange(emptyParameters)}>{t('Reset')}</button></div>
      <p className="om-eyebrow">{model.label}</p>
      {model.generationOptions?.delivery === 'prompt' && <p className="om-muted">{t('Creative preferences sent to Codex. The Agent chooses the final output settings.')}</p>}
      {!fields.length && <p className="om-muted">{t('This model uses provider-specific parameters. Add them in Advanced parameters.')}</p>}
      <div className="om-generation-fields">{fields.map(field => <div className="om-generation-field" key={field.key}>
        <div className="om-creation-row"><label className="om-label" htmlFor={`generation-${field.key}`}>{t(field.label)}{field.required ? ' *' : ''}</label>{Object.hasOwn(draft.values, field.key) && <button className="om-nav-item" aria-label={t('Reset {name}', { name: t(field.label) })} onClick={() => set(field, undefined)}><RemixIcon name="refresh-line" size={14} /></button>}</div>
        {field.kind === 'choice' && (field.presentation === 'ratio' ? <div className="om-generation-ratios" role="group" aria-label={t(field.label)}>{field.choices?.map(option => {
          const match = option.label.match(/(\d+):(\d+)/), ratio = match ? Number(match[1]) / Number(match[2]) : 1;
          return <button key={String(option.value)} className="om-option-tile" disabled={constraints[field.key] !== undefined && constraints[field.key] !== option.value} aria-pressed={value(field) === option.value} onClick={() => set(field, option.value)}>{match ? <span className="om-ratio-outline" style={{ width: 22 * Math.min(ratio, 1), height: 22 / Math.max(ratio, 1) }} /> : <RemixIcon name="ruler-line" size={20} />}<span>{t(option.label)}</span></button>;
        })}</div> : <Select label={t(field.label)} value={value(field) === undefined ? '__auto' : String(value(field))} onCommit={v => set(field, v === '__auto' ? undefined : field.choices!.find(c => String(c.value) === v)!.value)} options={[{ value: '__auto', label: t('Model default') }, ...field.choices!.map(c => ({ value: String(c.value), label: t(c.label) }))]} />)}
        {field.kind === 'boolean' && <button className="om-switch" role="switch" aria-label={t(field.label)} aria-checked={Boolean(value(field))} onClick={() => set(field, !value(field))}><span /></button>}
        {field.kind === 'number' && <div className="om-generation-number"><label className="om-field"><input id={`generation-${field.key}`} aria-label={t(field.label)} type="number" min={field.min} max={field.max} step={field.step} placeholder={t('Auto')} value={typeof value(field) === 'number' ? value(field) as number : ''} onChange={e => set(field, e.target.value === '' ? undefined : Number(e.target.value))} /></label>{field.min !== undefined && field.max !== undefined && <Slider label={t(field.label)} min={field.min} max={field.max} step={field.step} value={Number(value(field) ?? field.min)} onCommit={v => set(field, v)} />}</div>}
        {field.kind === 'text' && <label className="om-field"><input id={`generation-${field.key}`} aria-label={t(field.label)} value={String(value(field) ?? '')} onChange={e => set(field, e.target.value || undefined)} /></label>}
      </div>)}</div>
      <details className="om-creation-options"><summary className="om-nav-item"><RemixIcon name="code-s-slash-line" size={15} />{t('Advanced parameters')}<RemixIcon name="arrow-down-s-line" size={14} /></summary><p className="om-muted">{t('Provider JSON. Quick controls override matching fields.')}</p><label className="om-field"><textarea aria-label={t('Model parameters')} rows={4} value={draft.advanced} onChange={e => onChange({ ...draft, advanced: e.target.value })} /></label></details>
    </Popover>
    {count && <Popover side="top" align="end" aria-label={t('Output count')} trigger={<button className="om-nav-item"><RemixIcon name="stack-line" size={16} />×{label(count)}</button>}><label className="om-label">{t('Output count')}<div className="om-field"><input aria-label={t('Output count')} type="number" min={1} step={1} value={Number(value(count) ?? 1)} onChange={e => set(count, e.target.value === '' ? undefined : Number(e.target.value))} /></div></label></Popover>}
  </div>;
}
