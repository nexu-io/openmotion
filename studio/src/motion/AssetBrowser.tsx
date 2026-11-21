import { Button } from 'open-design-ui/button';
import { CreationEmblem, creationKinds } from './AssetCreationVisuals';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { assetMediaUrl, assetVersion, type AssetReference, type LibraryAsset, type AssetVersion } from '../../../shared/asset-library';
import type { AudioKind } from '../../../shared/audio-kind';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { Skeleton } from '../components/ui/Skeleton';
import { VideoFrameThumbnail } from '../components/ui/VideoFrameThumbnail';
import { MediaDurationBadge } from '../components/sidebar/MediaDurationBadge';
import { Select } from '../components/ui/Select';
import { Tooltip } from '../components/ui/Tooltip';
import { AssetAudioPreview } from './AssetAudioPreview';
import { AssetHoverVideo } from './AssetHoverVideo';
import { releaseMediaElement } from '../utils/releaseMediaElement';
import { SettingsDialog } from './settingsPrimitives';
import { assetRequest } from './assetClient';
export const assetKinds = [{ id: 'all', label: 'All assets', icon: 'folder-open-line' }, { id: 'image', label: 'Images', icon: 'image-line' }, { id: 'video', label: 'Videos', icon: 'movie-line' }, { id: 'audio', label: 'Audio', icon: 'music-2-line' }] as const;
export type AssetKind = typeof assetKinds[number]['id'] | 'trash';
export const AssetPreview = memo(function AssetPreview({ asset, version = assetVersion(asset)!, controls = false, previewing = false, autoPlay = false }: { asset: LibraryAsset; version?: AssetVersion; controls?: boolean; previewing?: boolean; autoPlay?: boolean }) {
  return <AssetPreviewContent key={`${asset.id}/${version.id}`} asset={asset} version={version} controls={controls} previewing={previewing} autoPlay={autoPlay} />;
});
function AssetPreviewContent({ asset, version, controls, previewing, autoPlay }: { asset: LibraryAsset; version: AssetVersion; controls: boolean; previewing: boolean; autoPlay: boolean }) {
  const { t } = useI18n(), [failed, setFailed] = useState(false), [loaded, setLoaded] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const src = assetMediaUrl(asset.id, version.id);
  useEffect(() => { const element = video.current; return () => releaseMediaElement(element); }, [src, controls, failed]);
  useLayoutEffect(() => { if (image.current?.complete && image.current.naturalWidth > 0) setLoaded(true); }, [src]);
  // Transparent results sit on a checkerboard so their cut-out edges stay visible.
  const transparent = asset.modality === 'image' && version.parameters?.background === 'transparent';
  return <div className="om-asset-preview om-media-surface" data-kind={asset.modality} data-transparent={transparent || undefined}>
    {failed ? <div className="om-empty"><RemixIcon name="error-warning-line" size={24} /><span>{t('Preview unavailable')}</span>{controls && <Button variant="ghost" className="om-button h-auto" onClick={e => { e.stopPropagation(); setFailed(false); }}>{t('Retry')}</Button>}</div>
      : asset.modality === 'image' ? <>{!loaded && <Skeleton className="om-asset-poster-skeleton" />}<img ref={image} className={transparent ? 'motion-color-checkerboard' : undefined} src={src} alt={asset.name} width={version.width} height={version.height} loading={controls ? 'eager' : 'lazy'} decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} /></>
      : controls ? asset.modality === 'video' ? <video ref={video} src={src} controls autoPlay={autoPlay} playsInline preload="metadata" onError={() => setFailed(true)} /> : <AssetAudioPreview src={src} autoPlay={autoPlay} onError={() => setFailed(true)} />
      : <>{asset.modality === 'video' ? <><VideoFrameThumbnail src={src} fallbackLabel={t('Preview unavailable')} />{previewing && <AssetHoverVideo src={src} />}</> : <div className="om-asset-media-symbol"><RemixIcon name="music-2-line" size={40} /></div>}<MediaDurationBadge duration={version.duration} className="absolute top-2 right-2" /></>}
  </div>;
}
function AssetTitle({ name }: { name: string }) {
  const ref = useRef<HTMLElement>(null), [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts?.addEventListener('loadingdone', measure);
    return () => { observer.disconnect(); document.fonts?.removeEventListener('loadingdone', measure); };
  }, [name]);
  return <Tooltip label={name} disabled={!overflow} wrap withinDialog><strong ref={ref}>{name}</strong></Tooltip>;
}
/** The gallery and detail filmstrip share one loaded collection and filter state. */
export function useAssetBrowser({ kind, revision = 0, active = true, lockedSource }: { kind: AssetKind; revision?: number; active?: boolean; lockedSource?: 'generated' | 'upload' }) {
  const [query, setQuery] = useState(''), [sourceState, setSource] = useState('all'), [sort, setSort] = useState('newest');
  const [audioKind, setAudioKind] = useState<'all' | AudioKind>('all');
  const source = lockedSource ?? sourceState;
  const [result, setResult] = useState<{ key: string; assets: LibraryAsset[]; total: number; nextOffset: number | null }>();
  const [error, setError] = useState(false), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0), [page, setPage] = useState(0);
  const effectiveAudioKind = kind === 'audio' ? audioKind : 'all';
  const signature = `${kind}|${effectiveAudioKind}|${query}|${source}|${sort}|${revision}`;
  const requestKey = `${signature}|${page}`;
  // Keep the last settled collection visible while a new filter or tab request
  // is in flight. Skeleton cards are reserved for the initial load, so tab
  // changes do not flash a second loading surface over the existing gallery.
  const data = result;
  const stale = Boolean(data && data.key !== requestKey);
  const [previous, setPrevious] = useState(signature);
  if (previous !== signature) { setPrevious(signature); setPage(0); }
  useEffect(() => {
    if (!active) return;
    let cancelled = false; setLoading(true); setError(false);
    const timer = setTimeout(() => {
      void assetRequest<{ assets: LibraryAsset[]; total: number; nextOffset: number | null }>({
        action: 'list',
        ...(kind !== 'all' && kind !== 'trash' ? { modality: kind } : {}),
        ...(kind === 'audio' && effectiveAudioKind !== 'all' ? { audioKind: effectiveAudioKind } : {}),
        trash: kind === 'trash',
        query,
        ...(source !== 'all' ? { source } : {}),
        sort,
        offset: page * 40,
        limit: 40,
      })
        .then(result => { if (!cancelled) setResult({ ...result, key: requestKey }); }).catch(() => { if (!cancelled) setError(true); }).finally(() => { if (!cancelled) setLoading(false); });
    }, query ? 180 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, kind, effectiveAudioKind, query, source, sort, page, revision, retry, requestKey]);
  return { kind, audioKind: effectiveAudioKind, setAudioKind, query, setQuery, source, setSource, sort, setSort, data, stale, loading: loading || (stale && !error), error, page, setPage, retry: () => setRetry(v => v + 1) };
}
type BrowserActions = {
  onOpen: (asset: LibraryAsset) => void;
  onCreate?: (kind: 'image' | 'video' | 'audio') => void;
  compact?: boolean;
  selectedId?: string;
  selectedIds?: ReadonlySet<string>;
  onLoadedAssets?: (assets: LibraryAsset[]) => void;
};
export function AssetBrowser({ kind, revision, active, ...actions }: BrowserActions & { kind: AssetKind; revision?: number; active?: boolean }) {
  const browser = useAssetBrowser({ kind, revision, active });
  return <AssetBrowserContent browser={browser} {...actions} />;
}
export function AssetBrowserContent({ browser, onOpen, onCreate, compact = false, selectedId, selectedIds, onLoadedAssets, toolbar, emptyContent, leadingTiles, hoverPreview = false }: BrowserActions & { browser: ReturnType<typeof useAssetBrowser>; toolbar?: ReactNode; emptyContent?: ReactNode; leadingTiles?: ReactNode; hoverPreview?: boolean }) {
  const { t } = useI18n();
  const { kind, query, setQuery, source, setSource, sort, setSort, data, stale, loading, error, page, setPage, retry } = browser;
  const [previewId, setPreviewId] = useState<string>();
  const canPreview = hoverPreview && !compact && !loading;
  useEffect(() => {
    onLoadedAssets?.(data?.assets ?? []);
  }, [data?.assets, onLoadedAssets]);
  useEffect(() => {
    if (!canPreview) { setPreviewId(undefined); return; }
    if (!previewId) return;
    const stop = () => setPreviewId(undefined);
    const hidden = () => { if (document.hidden) stop(); };
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    document.addEventListener('visibilitychange', hidden);
    document.addEventListener('scroll', stop, true);
    window.addEventListener('blur', stop);
    window.addEventListener('resize', stop);
    preference.addEventListener('change', stop);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      document.removeEventListener('scroll', stop, true);
      window.removeEventListener('blur', stop);
      window.removeEventListener('resize', stop);
      preference.removeEventListener('change', stop);
    };
  }, [canPreview, previewId]);
  const preview = (asset: LibraryAsset) => {
    if (canPreview && asset.modality === 'video' && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) setPreviewId(asset.id);
  };
  return <section data-compact={compact} aria-label={t('Asset library')}>
    {toolbar ?? <div className="om-asset-filters om-control-row">
      <label className="om-field om-asset-search"><RemixIcon name="search-line" size={16} /><input type="search" aria-label={t('Search assets')} placeholder={t('Search assets...')} value={query} onChange={e => setQuery(e.target.value)} maxLength={200} /></label>
      {!compact && <><Select label={t('Source')} value={source} onCommit={setSource} options={[{ value: 'all', label: t('All sources') }, { value: 'generated', label: t('AI generated') }, { value: 'upload', label: t('Local upload') }]} />
      <Select label={t('Sort')} value={sort} onCommit={setSort} options={[{ value: 'newest', label: t('Newest first') }, { value: 'oldest', label: t('Oldest first') }, { value: 'name', label: t('Name') }]} /></>}
      {(query || source !== 'all') && <Button variant="plain" className="om-nav-item" onClick={() => { setQuery(''); setSource('all'); }}>{t('Clear filters')}</Button>}
    </div>}
    <div className="om-asset-results" aria-busy={loading} inert={stale && !error}>
      {error && !leadingTiles ? <div className="om-empty"><RemixIcon name="error-warning-line" size={32} /><p>{t('Could not load assets')}</p><Button variant="ghost" className="om-button h-auto" onClick={retry}>{t('Retry')}</Button></div>
        : !data && !leadingTiles ? <div className="om-asset-grid">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="om-asset-loading-card" />)}</div>
        : !data?.assets.length && !leadingTiles && emptyContent && !query && source === 'all' ? emptyContent
        : !data?.assets.length && !leadingTiles && onCreate && !query && source === 'all' && kind !== 'trash' ? <div className="om-asset-welcome"><span className="om-creation-kicker">{t('YOUR NEXT CREATION STARTS HERE')}</span><h2 className="om-title">{t('One idea. Endless possibilities.')}</h2><p className="om-muted">{t('Upload your own media or create an image, video or audio asset.')}</p><div className="om-asset-starters">{creationKinds.filter(k => kind === 'all' || kind === k.id).map(item => <Button variant="plain" className="om-creation-suggestion om-asset-starter" key={item.id} onClick={() => onCreate(item.id)}><CreationEmblem kind={item.id} /><strong>{t(item.title)}</strong><span className="om-muted">{t(item.hint)}</span><span className="om-asset-starter-action">{t(item.action)}<RemixIcon name="arrow-right-line" size={16} /></span></Button>)}</div></div>
        : !data?.assets.length && !leadingTiles ? <div className="om-empty om-asset-empty"><RemixIcon name={kind === 'trash' ? 'delete-bin-line' : 'image-line'} size={40} /><h2 className="om-subtitle">{t(query || source !== 'all' ? 'No matching assets' : kind === 'trash' ? 'Trash is empty' : 'Your next idea starts here')}</h2><p className="om-muted">{t(kind === 'trash' ? 'Assets moved to trash can be restored.' : 'Upload your own media or create an image, video or audio asset.')}</p></div>
        : <>{data && data.total > 0 && <p className="om-muted">{t('{count} assets', { count: data.total })}</p>}<div className="om-asset-grid">{leadingTiles}{data?.assets.map(asset => <div key={asset.id} className="om-asset-tile om-card"><Button variant="plain" className="om-nav-item om-asset-open" onClick={() => onOpen(asset)} aria-label={asset.name} aria-current={selectedId === asset.id || selectedIds?.has(asset.id) ? 'true' : undefined}
          onPointerEnter={event => { if (event.pointerType !== 'touch') preview(asset); }} onPointerLeave={() => setPreviewId(undefined)} onPointerCancel={() => setPreviewId(undefined)}
          onFocus={event => { if (event.currentTarget.matches(':focus-visible')) preview(asset); }} onBlur={() => setPreviewId(undefined)}>
          <AssetPreview asset={asset} previewing={canPreview && previewId === asset.id} /><span className="om-asset-tile-caption"><AssetTitle name={asset.name} />{!compact && <span className="om-muted">{t(assetVersion(asset)?.source === 'upload' ? 'Local upload' : 'AI generated')} · V{asset.versions.findIndex(v => v.id === asset.currentVersionId) + 1}</span>}</span>
        </Button></div>)}</div>{data && (page > 0 || data.nextOffset !== null) && <div className="om-asset-pagination"><Button variant="ghost" className="om-button h-auto" disabled={!page || loading} onClick={() => setPage(v => v - 1)}>{t('Previous')}</Button><span className="om-muted">{page + 1}</span><Button variant="ghost" className="om-button h-auto" disabled={data.nextOffset === null || loading} onClick={() => setPage(v => v + 1)}>{t('Next')}</Button></div>}</>}
    </div>
  </section>;
}
export function AssetPicker({
  onClose,
  onPick,
  onPickMany,
  multiple = false,
  title = 'Choose an asset',
  confirmLabel = 'Use selected version',
  busyLabel = 'Working…',
  busy = false,
  revision = 0,
  imageOnly = false,
}: {
  imageOnly?: boolean;
  multiple?: boolean;
  onClose: () => void;
  onPick?: (reference: AssetReference, asset: LibraryAsset) => void;
  onPickMany?: (items: { reference: AssetReference; asset: LibraryAsset }[]) => void;
  title?: string;
  confirmLabel?: string;
  busyLabel?: string;
  busy?: boolean;
  revision?: number;
}) {
  const { t } = useI18n(), [kind, setKind] = useState<AssetKind>(imageOnly ? 'image' : 'all'), [selected, setSelected] = useState<LibraryAsset>(), [version, setVersion] = useState('');
  const [selectedMap, setSelectedMap] = useState<Map<string, LibraryAsset>>(() => new Map());
  const [loadedAssets, setLoadedAssets] = useState<LibraryAsset[]>([]);
  const selectedIds = useMemo(() => new Set(selectedMap.keys()), [selectedMap]);
  const selectedList = useMemo(() => Array.from(selectedMap.values()), [selectedMap]);
  const allLoadedSelected = loadedAssets.length > 0 && loadedAssets.every(asset => selectedMap.has(asset.id));

  const pick = useCallback((asset: LibraryAsset) => {
    if (busy) return;
    if (multiple) {
      setSelectedMap(prev => {
        const next = new Map(prev);
        if (next.has(asset.id)) {
          next.delete(asset.id);
        } else {
          next.set(asset.id, asset);
          if (next.size === 1) setVersion(asset.currentVersionId);
        }
        return next;
      });
      return;
    }
    setSelected(asset);
    setVersion(asset.currentVersionId);
  }, [busy, multiple]);

  const toggleSelectAllLoaded = useCallback(() => {
    if (busy || loadedAssets.length === 0) return;
    setSelectedMap(prev => {
      const next = new Map(prev);
      if (loadedAssets.every(asset => next.has(asset.id))) {
        for (const asset of loadedAssets) next.delete(asset.id);
      } else {
        for (const asset of loadedAssets) next.set(asset.id, asset);
      }
      if (next.size === 1) {
        const [only] = next.values();
        setVersion(only.currentVersionId);
      }
      return next;
    });
  }, [busy, loadedAssets]);

  return <SettingsDialog title={t(title)} onClose={onClose}><div className="om-asset-picker">
    {!imageOnly && (
      <div className="om-asset-picker-toolbar">
        <div className="om-asset-tabs">{assetKinds.map(item => <Button variant="plain" key={item.id} className="om-nav-item" disabled={busy} aria-pressed={kind === item.id} onClick={() => setKind(item.id)}>{t(item.label)}</Button>)}</div>
        {multiple && (
          <div className="om-asset-picker-bulk">
            <Button variant="secondary" size="sm" type="button" disabled={busy || loadedAssets.length === 0} onClick={toggleSelectAllLoaded}>
              {t(allLoadedSelected ? 'Deselect all' : 'Select all ({count})', { count: loadedAssets.length })}
            </Button>
            {selectedMap.size > 0 && (
              <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => setSelectedMap(new Map())}>
                {t('Clear')}
              </Button>
            )}
          </div>
        )}
      </div>
    )}
    <AssetBrowser
      kind={kind}
      onOpen={pick}
      revision={revision}
      selectedIds={multiple ? selectedIds : undefined}
      onLoadedAssets={multiple ? setLoadedAssets : undefined}
    />
    {multiple ? (
      <div className="om-asset-picker-selection">
        {selectedList.length === 1 ? (
          <>
            <strong>{selectedList[0].name}</strong>
            <Select
              disabled={busy}
              label={t('Version')}
              value={version && selectedList[0].versions.some(v => v.id === version) ? version : selectedList[0].currentVersionId}
              onCommit={setVersion}
              options={selectedList[0].versions.map((v, i) => ({ value: v.id, label: `V${i + 1}` }))}
            />
          </>
        ) : selectedList.length > 1 ? (
          <strong>{t('{count} selected', { count: selectedList.length })}</strong>
        ) : (
          <span className="om-muted">{t('Click items to select one, several, or all assets.')}</span>
        )}
        <div className="om-asset-picker-footer-actions">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={busy || loadedAssets.length === 0}
            onClick={() => onPickMany?.(loadedAssets.map(asset => ({ reference: { assetId: asset.id, versionId: asset.currentVersionId }, asset })))}
          >
            {t('Import all ({count})', { count: loadedAssets.length })}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={busy || selectedList.length === 0}
            aria-busy={busy}
            onClick={() => {
              if (selectedList.length === 1) {
                const only = selectedList[0];
                const chosenVersion = version && only.versions.some(v => v.id === version) ? version : only.currentVersionId;
                onPickMany?.([{ reference: { assetId: only.id, versionId: chosenVersion }, asset: only }]);
              } else {
                onPickMany?.(selectedList.map(asset => ({ reference: { assetId: asset.id, versionId: asset.currentVersionId }, asset })));
              }
            }}
          >
            {busy && <RemixIcon name="loader-4-line" size={16} className="animate-spin motion-reduce:animate-none" />}
            {t(busy ? busyLabel : 'Import ({count})', { count: selectedList.length })}
          </Button>
        </div>
      </div>
    ) : selected && <div className="om-asset-picker-selection"><strong>{selected.name}</strong><Select disabled={busy} label={t('Version')} value={version} onCommit={setVersion} options={selected.versions.map((v, i) => ({ value: v.id, label: `V${i + 1}` }))} /><Button variant="ghost" className="om-button h-auto" data-primary disabled={busy} aria-busy={busy} onClick={() => onPick?.({ assetId: selected.id, versionId: version }, selected)}>{busy && <RemixIcon name="loader-4-line" size={16} className="animate-spin motion-reduce:animate-none" />}{t(busy ? busyLabel : confirmLabel)}</Button></div>}
  </div></SettingsDialog>;
}
