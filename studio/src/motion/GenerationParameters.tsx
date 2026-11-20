import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { modelReferenceLimit, type Model } from '../../../shared/gateway';
import { compatibleImageResolutions, resolveGenerationParameters, usesInputImageRatio, type GenerationOption } from '../../../shared/generation-options';
import { Popover } from '../components/ui/Popover';
import { Select } from '../components/ui/Select';
import { Slider } from 'open-design-ui/slider';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';

export type ParameterDraft = { values: Record<string, unknown>; advanced: string };
export const emptyParameters: ParameterDraft = { values: {}, advanced: '{}' };
/** Map shot preferences to choices the current provider actually publishes. */
export function shotParameters(model: Model, preferences?: { aspect: string; duration?: number }): ParameterDraft {
  if (!preferences) return emptyParameters;
  const values: Record<string, unknown> = {};
  for (const field of model.generationOptions?.fields ?? []) {
    const value = field.presentation === 'ratio' ? preferences.aspect : field.key === 'duration' ? preferences.duration : undefined;
    if (value !== undefined && field.choices?.some(choice => choice.value === value && !choice.requires)) values[field.key] = value;
  }
  return { values, advanced: '{}' };
}
export function requestParameters(draft: ParameterDraft, model?: Model, hasInputImage = false): Record<string, unknown> {
  const extra = JSON.parse(draft.advanced);
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('Model parameters must be a JSON object');
  const values = { ...draft.values };
  // Retain the inactive text-to-video choice in the editor, but keep explicit JSON instructions for validation.
  if (model && parameterInputImageRatio(model, draft, hasInputImage)) delete values.ratio;
  // Quick controls are explicit overrides; deleting a quick override restores advanced/default values.
  const parameters = { ...extra, ...values };
  if (model) resolveGenerationParameters(model, parameters, hasInputImage);
  return parameters;
}
export function parameterInputImageRatio(model: Model, draft: ParameterDraft, hasInputImage: boolean): boolean {
  let parameters = draft.values;
  try { parameters = requestParameters(draft); } catch { /* Keep the reference constraint visible while JSON is being edited. */ }
  return modelReferenceLimit(model) > 0 && usesInputImageRatio(model, hasInputImage, parameters);
}
export function GenerationParameters({ model, draft, hasInputImage = false, onChange }: { model: Model; draft: ParameterDraft; hasInputImage?: boolean; onChange: (draft: ParameterDraft) => void }) {
  const { t } = useI18n();
  let extra: Record<string, unknown> = {};
  try { extra = requestParameters({ ...draft, values: {} }); } catch { /* The raw editor remains editable; submission reports parse errors through Toast. */ }
  const inputImageRatio = parameterInputImageRatio(model, draft, hasInputImage);
  const fields = (model.generationOptions?.fields ?? []).filter(field => !inputImageRatio || field.key !== 'ratio');
  const aspectField = fields.find(field => field.key === 'aspect_ratio');
  const activeAspectRatio = draft.values.aspect_ratio ?? extra.aspect_ratio ?? model.defaults?.aspect_ratio ?? aspectField?.default;
  const allowedResolutions = compatibleImageResolutions(model, activeAspectRatio, hasInputImage);
  const effectiveDefault = (field: GenerationOption) => {
    if (field.key === 'resolution' && allowedResolutions) {
      return typeof field.default === 'string' && allowedResolutions.includes(field.default) ? field.default : allowedResolutions[0];
    }
    return field.default;
  };
  const value = (field: GenerationOption) => draft.values[field.key] ?? extra[field.key] ?? model.defaults?.[field.key] ?? effectiveDefault(field);
  const choicesFor = (field: GenerationOption) => {
    const choices = field.choices ?? [];
    if (field.key !== 'resolution' || !allowedResolutions) return choices;
    const current = value(field);
    return choices.filter(c => allowedResolutions.includes(String(c.value)) || c.value === current);
  };
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
    if (field.key === 'aspect_ratio') {
      const nextAllowed = compatibleImageResolutions(model, value ?? extra.aspect_ratio ?? model.defaults?.aspect_ratio ?? aspectField?.default, hasInputImage);
      if (nextAllowed && typeof values.resolution === 'string' && !nextAllowed.includes(values.resolution)) delete values.resolution;
    }
    onChange({ ...draft, values });
  };
  const summary = [...(inputImageRatio ? [t('Follows first frame')] : []), ...fields.filter(f => f.kind !== 'text' && f.key !== 'seed' && f.presentation !== 'count' && value(f) !== undefined).map(label)].slice(0, 3).join(' · ');
  const constraints = Object.assign({}, ...fields.map(f => f.choices?.find(c => c.value === value(f))?.requires)) as Record<string, string | number>;
  const count = fields.find(f => f.presentation === 'count');
  return <div className="om-generation-settings">
    <Popover side="top" align="start" aria-label={t('Generation settings')} className="om-generation-popover" trigger={<Button variant="plain" className="om-nav-item om-generation-summary"><RemixIcon name="equalizer-line" size={17} /><span>{summary || t('Generation settings')}</span><RemixIcon name="arrow-down-s-line" size={15} /></Button>}>
      <div className="om-creation-row"><strong>{t('Generation settings')}</strong><Button variant="plain" className="om-nav-item" onClick={() => onChange(emptyParameters)}>{t('Reset')}</Button></div>
      <p className="om-eyebrow">{model.label}</p>
      {inputImageRatio && <p className="om-muted">{t('Aspect ratio follows the first frame.')}</p>}
      {model.generationOptions?.delivery === 'prompt' && <p className="om-muted">{t('Creative preferences sent to Codex. The Agent chooses the final output settings.')}</p>}
      {!fields.length && <p className="om-muted">{t('This model uses provider-specific parameters. Add them in Advanced parameters.')}</p>}
      <div className="om-generation-fields">{fields.map(field => <div className="om-generation-field" key={field.key}>
        <div className="om-creation-row"><label className="om-label" htmlFor={`generation-${field.key}`}>{t(field.label)}{field.required ? ' *' : ''}</label>{Object.hasOwn(draft.values, field.key) && <IconButton variant="plain" className="om-nav-item" aria-label={t('Reset {name}', { name: t(field.label) })} onClick={() => set(field, undefined)} icon={<RemixIcon name="refresh-line" size={14} />} />}</div>
        {field.kind === 'choice' && (field.presentation === 'ratio' ? <div className="om-generation-ratios" role="group" aria-label={t(field.label)}>{field.choices?.map(option => {
          const match = option.label.match(/(\d+):(\d+)/), ratio = match ? Number(match[1]) / Number(match[2]) : 1;
          return <Button variant="plain" key={String(option.value)} className="om-option-tile" disabled={constraints[field.key] !== undefined && constraints[field.key] !== option.value} aria-pressed={value(field) === option.value} onClick={() => set(field, option.value)}>{match ? <span className="om-ratio-outline" style={{ width: 22 * Math.min(ratio, 1), height: 22 / Math.max(ratio, 1) }} /> : <RemixIcon name="ruler-line" size={20} />}<span>{t(option.label)}</span></Button>;
        })}</div> : (() => {
          const fieldChoices = choicesFor(field);
          return <Select label={t(field.label)} value={value(field) === undefined ? '__auto' : String(value(field))} onCommit={v => set(field, v === '__auto' ? undefined : fieldChoices.find(c => String(c.value) === v)!.value)} options={[{ value: '__auto', label: t('Model default') }, ...fieldChoices.map(c => ({ value: String(c.value), label: t(c.label) }))]} />;
        })())}
        {field.kind === 'boolean' && <button className="om-switch" role="switch" aria-label={t(field.label)} aria-checked={Boolean(value(field))} onClick={() => set(field, !value(field))}><span /></button>}
        {field.kind === 'number' && <div className="om-generation-number"><label className="om-field"><input id={`generation-${field.key}`} aria-label={t(field.label)} type="number" min={field.min} max={field.max} step={field.step} placeholder={t('Auto')} value={typeof value(field) === 'number' ? value(field) as number : ''} onChange={e => set(field, e.target.value === '' ? undefined : Number(e.target.value))} /></label>{field.min !== undefined && field.max !== undefined && <Slider label={t(field.label)} min={field.min} max={field.max} step={field.step} value={Number(value(field) ?? field.min)} onCommit={v => set(field, v)} />}</div>}
        {field.kind === 'text' && <label className="om-field"><input id={`generation-${field.key}`} aria-label={t(field.label)} value={String(value(field) ?? '')} onChange={e => set(field, e.target.value || undefined)} /></label>}
      </div>)}</div>
      <details className="om-creation-options"><summary className="om-nav-item"><RemixIcon name="code-s-slash-line" size={15} />{t('Advanced parameters')}<RemixIcon name="arrow-down-s-line" size={14} /></summary><p className="om-muted">{t('Provider JSON. Quick controls override matching fields.')}</p><label className="om-field"><textarea aria-label={t('Model parameters')} rows={4} value={draft.advanced} onChange={e => onChange({ ...draft, advanced: e.target.value })} /></label></details>
    </Popover>
    {count && <Popover side="top" align="end" aria-label={t('Output count')} trigger={<Button variant="plain" className="om-nav-item"><RemixIcon name="stack-line" size={16} />×{label(count)}</Button>}><label className="om-label">{t('Output count')}<div className="om-field"><input aria-label={t('Output count')} type="number" min={1} step={1} value={Number(value(count) ?? 1)} onChange={e => set(count, e.target.value === '' ? undefined : Number(e.target.value))} /></div></label></Popover>}
  </div>;
}
