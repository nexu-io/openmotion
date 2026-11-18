import { Menu, MenuRadioGroup, MenuRadioItem } from '../components/ui/Menu';
import { IconButton } from '../components/ui/IconButton';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { assetKinds, type AssetKind, type useAssetBrowser } from './AssetBrowser';

export function AssetGalleryToolbar({ browser, onKindChange, voices = false, onVoices }: {
  browser: ReturnType<typeof useAssetBrowser>;
  onKindChange: (kind: AssetKind) => void; voices?: boolean; onVoices?: () => void;
}) {
  const { t } = useI18n();
  const { kind, query, setQuery, source, setSource, sort, setSort } = browser;
  const sources = [{ value: 'all', label: t('All sources') }, { value: 'generated', label: t('AI generated') }, { value: 'upload', label: t('Local upload') }];
  const sorts = [{ value: 'newest', label: t('Newest') }, { value: 'oldest', label: t('Oldest first') }, { value: 'name', label: t('Name') }];
  return <div className="om-asset-gallery-toolbar">
    <div className="om-asset-gallery-browse">
      <nav className="om-asset-tabs" aria-label={t('Asset types')}>
        {assetKinds.map(item => <button key={item.id} className="om-nav-item" aria-current={!voices && kind === item.id ? 'page' : undefined} onClick={() => onKindChange(item.id)}>{t(item.id === 'all' ? 'All' : item.label)}</button>)}
        {onVoices && <button className="om-nav-item" aria-current={voices ? 'page' : undefined} onClick={onVoices}>{t('Voices')}</button>}
      </nav>
      <span className="om-divider om-asset-toolbar-divider" aria-hidden="true" />
      <div className="om-asset-gallery-options">
        {!voices && <Menu modal={false} aria-label={t('Source')} trigger={<button className="om-nav-item" data-compact aria-label={t('Source')}>{sources.find(item => item.value === source)?.label}<RemixIcon name="arrow-down-s-line" size={14} /></button>}>
          <MenuRadioGroup value={source} onValueChange={value => setSource(String(value))}>{sources.map(item => <MenuRadioItem key={item.value} value={item.value} closeOnClick>{item.label}</MenuRadioItem>)}</MenuRadioGroup>
        </Menu>}
        <Menu modal={false} aria-label={t('Sort')} trigger={<button className="om-nav-item" data-compact aria-label={t('Sort')}>{sorts.find(item => item.value === sort)?.label}<RemixIcon name="arrow-down-s-line" size={14} /></button>}>
          <MenuRadioGroup value={sort} onValueChange={value => setSort(String(value))}>{sorts.map(item => <MenuRadioItem key={item.value} value={item.value} closeOnClick>{item.label}</MenuRadioItem>)}</MenuRadioGroup>
        </Menu>
      </div>
    </div>
    <div className="om-asset-gallery-tools">
      <label className="om-field om-asset-search"><RemixIcon name="search-line" size={16} /><input type="search" aria-label={t('Search library assets')} placeholder={t('Search library assets')} value={query} onChange={event => setQuery(event.target.value)} maxLength={200} /></label>
      <Tooltip label={t('Trash')}><IconButton size="lg" variant={kind === 'trash' ? 'secondary' : 'ghost'} aria-label={t('Trash')} aria-pressed={kind === 'trash'} icon={<RemixIcon name="delete-bin-line" size={16} />} onClick={() => onKindChange('trash')} /></Tooltip>
    </div>
    {(query || source !== 'all') && <div className="om-asset-gallery-clear"><button className="om-nav-item" onClick={() => { setQuery(''); setSource('all'); }}>{t('Clear filters')}</button></div>}
  </div>;
}
