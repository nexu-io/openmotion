import { Tooltip } from "../components/ui/Tooltip";
import { useState, type ReactNode } from 'react';
import { inputModalities, modelCapabilities, modelKinds, type DirectoryModel } from '../../../shared/provider-directory';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { Menu, MenuCheckboxItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../components/ui/Menu';
import { capabilityLabels, kindLabels } from './ModelEditor';

export function ModelCatalog({ models, render }: { models: DirectoryModel[]; render: (model: DirectoryModel) => ReactNode }) {
  const { t } = useI18n();
  const [query, setQuery] = useState(''), [filters, setFilters] = useState<string[]>([]), [sort, setSort] = useState('catalogue'), [grouped, setGrouped] = useState(true), [collapsed, setCollapsed] = useState<string[]>([]);
  const sections = [
    { title: 'Model type', values: modelKinds.map(kind => ({ id: `kind:${kind}`, label: kindLabels[kind] })) },
    { title: 'Model capabilities', values: modelCapabilities.map(value => ({ id: `cap:${value}`, label: capabilityLabels[value] })) },
    { title: 'Input modalities', values: inputModalities.map(value => ({ id: `input:${value}`, label: capabilityLabels[value] })) },
    { title: 'Status', values: [{ id: 'status:enabled', label: 'Enabled' }, { id: 'status:disabled', label: 'Disabled' }] },
    { title: 'Source', values: [{ id: 'source:builtin', label: 'Built-in' }, { id: 'source:live', label: 'Synced' }, { id: 'source:custom', label: 'Custom' }] },
  ];
  const toggle = (id: string) => setFilters(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const filtered = models.filter(model => {
    if (!`${model.label} ${model.modelId} ${model.group ?? ''}`.toLowerCase().includes(query.toLowerCase())) return false;
    return sections.every(section => { const selected = section.values.filter(value => filters.includes(value.id)); return !selected.length || selected.some(({ id }) => { const [type, value] = id.split(':'); return type === 'kind' ? model.kind === value : type === 'cap' ? model.capabilities?.some(item => item === value) : type === 'input' ? model.inputs?.some(item => item === value) : type === 'source' ? model.source === value : model.enabled === (value === 'enabled'); }); });
  }).sort((a, b) => sort === 'name' ? a.label.localeCompare(b.label) : sort === 'context' ? (b.contextWindow ?? 0) - (a.contextWindow ?? 0) : 0);
  const groups = Map.groupBy(filtered, model => grouped ? model.group || 'Ungrouped' : '');
  return <>
    {models.length > 0 && <><div className="om-model-filters"><label className="om-field"><RemixIcon name="search-line" size={15} /><input type="search" aria-label={t('Search models')} placeholder={t('Search models…')} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <Menu className="om-filter-menu" modal={false} aria-label={t('Filter models')} trigger={<button className="om-button" aria-label={t('Filter models')}><RemixIcon name="filter-3-line" size={15} />{t('Filter')}{filters.length ? ` · ${filters.length}` : ''}</button>}>{sections.map((section, i) => <div key={section.title}>{i > 0 && <MenuSeparator />}<div className="om-menu-caption">{t(section.title)}</div>{section.values.map(value => <MenuCheckboxItem key={value.id} checked={filters.includes(value.id)} closeOnClick={false} onCheckedChange={() => toggle(value.id)}>{t(value.label)}</MenuCheckboxItem>)}</div>)}</Menu>
      <Menu tooltip={t('Sort models')} modal={false} aria-label={t('Sort models')} trigger={<button className="motion-icon-button" aria-label={t('Sort models')}><RemixIcon name="equalizer-line" size={16} /></button>}><MenuRadioGroup value={sort} onValueChange={value => setSort(String(value))}>{[['catalogue', 'Catalogue order'], ['name', 'Name'], ['context', 'Context window']].map(([value, label]) => <MenuRadioItem key={value} value={value}>{t(label)}</MenuRadioItem>)}</MenuRadioGroup></Menu>
      <Tooltip label={t('Group models')} wrap><button className="motion-icon-button" aria-label={t('Group models')} aria-pressed={grouped} onClick={() => setGrouped(value => !value)}><RemixIcon name="folder-line" size={16} /></button></Tooltip>
      {grouped && <Tooltip label={t(collapsed.length === groups.size ? 'Expand all groups' : 'Collapse all groups')} wrap><button className="motion-icon-button" aria-label={t(collapsed.length === groups.size ? 'Expand all groups' : 'Collapse all groups')} onClick={() => setCollapsed(collapsed.length === groups.size ? [] : [...groups.keys()])}><RemixIcon name={collapsed.length === groups.size ? 'arrow-down-s-line' : 'arrow-up-line'} size={16} /></button></Tooltip>}
    </div><div className="om-settings-tags"><span className="om-muted">{filtered.length} / {models.length}</span>{filters.map(id => <button key={id} className="om-badge" aria-label={t('Remove {filter} filter', { filter: t(sections.flatMap(section => section.values).find(value => value.id === id)?.label ?? id) })} onClick={() => toggle(id)}>{t(sections.flatMap(section => section.values).find(value => value.id === id)?.label ?? id)}<RemixIcon name="close-line" size={12} /></button>)}{(filters.length > 0 || query) && <button className="om-button" onClick={() => { setFilters([]); setQuery(''); }}>{t('Clear filters')}</button>}</div></>}
    <div className="om-model-list">{[...groups].map(([group, values]) => <section key={group}>{grouped && <button className="om-nav-item om-model-group" aria-expanded={!collapsed.includes(group)} onClick={() => setCollapsed(current => current.includes(group) ? current.filter(value => value !== group) : [...current, group])}><RemixIcon name={collapsed.includes(group) ? 'arrow-right-s-line' : 'arrow-down-s-line'} size={14} /><span>{group === 'Ungrouped' ? t(group) : group}</span><small className="om-muted">{values.length}</small></button>}{(!grouped || !collapsed.includes(group)) && values.map(render)}</section>)}
      {!filtered.length && <div className="om-empty"><RemixIcon name="box-3-line" size={32} /><h3 className="om-subtitle">{t(models.length ? 'No matching models' : 'Choose your models')}</h3><p className="om-muted">{t(models.length ? 'Try another search or clear the filters.' : 'Sync the provider catalogue or add a model by its exact ID.')}</p></div>}
    </div>
  </>;
}
