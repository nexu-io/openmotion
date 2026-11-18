import { useEffect, useRef, useState, type ReactNode } from 'react';
import { voiceKinds, voiceProviders, type VoiceAsset, type VoiceProvider } from '../../../shared/voice-library';
import { assetMediaUrl } from '../../../shared/asset-library';
import { registeredProvider } from '../../../shared/provider-registry';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';
import { assetRequest, uploadLibraryAsset } from './assetClient';
import { useWorkspaceChrome } from './WorkspaceFrame';
import type { AssetDraft } from './AssetComposer';
import * as tracking from './pageTracking';
import { AssetTile, type AssetGalleryExtras } from './AssetBrowser';
import { AssetNameEditor } from './AssetDetailWorkspace';
import { AssetAudioPreview } from './AssetAudioPreview';
import { ResizablePane } from './ResizablePane';
import { SettingsDialog } from './settingsPrimitives';
import './voices.css';

export const voiceStatus = (voice: VoiceAsset) => voice.connection === 'required' ? 'Connect provider' : voice.connection === 'changed' ? 'Check connection' : voice.access === 'listed' ? 'Found in your account' : voice.access === 'not_listed' ? 'Not listed · synthesis unverified' : 'Synthesis unverified';
export const voiceKindLabel = (kind: VoiceAsset['kind']) => ({ cloned: 'Cloned voice', designed: 'Designed voice', system: 'System voice', unknown: 'Existing voice' })[kind];
const request = <T,>(voice: Record<string, unknown>) => assetRequest<T>({ action: 'voice', voice });

export function VoiceLibrary({ active, revision, trash = false, query = '', sort = 'newest', adding, onCloseAdd, renderGallery, onUse, onError, onNotice }: {
  active: boolean; revision: number; trash?: boolean; query?: string; sort?: string; adding: boolean;
  onCloseAdd: () => void; renderGallery?: (extras: AssetGalleryExtras & { content: ReactNode }) => ReactNode; onUse: (draft: AssetDraft) => void; onError: (message: string) => void; onNotice: (message: string) => void;
}) {
  const { t } = useI18n(), { openModelSettings } = useWorkspaceChrome();
  const [voices, setVoices] = useState<VoiceAsset[]>(), [failed, setFailed] = useState(false), [refresh, setRefresh] = useState(0), [selectedId, setSelectedId] = useState<string>(), [busy, setBusy] = useState(false);
  const sequence = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active) return; let cancelled = false; setFailed(false);
    void request<{ voices: VoiceAsset[] }>({ command: 'list', trash }).then(result => { if (!cancelled) setVoices(result.voices); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [active, revision, refresh, trash]);
  useEffect(() => { sequence.current++; }, [selectedId, trash]);
  const selected = voices?.find(voice => voice.id === selectedId);
  const shown = voices?.filter(voice => `${voice.name} ${voice.description} ${t(registeredProvider(voice.provider)?.label ?? voice.provider)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt);
  const update = async (voice: VoiceAsset, command: string, changes?: Record<string, unknown>) => {
    if (busy) return; setBusy(true); const current = sequence.current;
    try {
      const result = await request<{ voice: VoiceAsset }>({ command, voiceId: voice.id, revision: voice.revision, ...(changes ? { changes } : {}) });
      if (!mounted.current) return;
      setRefresh(value => value + 1);
      if (current === sequence.current) setSelectedId(result.voice.id);
      onNotice(t(command === 'check' ? voiceStatus(result.voice) : changes?.trashed ? 'Asset removed' : 'Saved'));
      return true;
    } catch (error) { if (mounted.current) onError(t((error as Error).message)); return false; }
    finally { if (mounted.current) setBusy(false); }
  };
  const use = (voice: VoiceAsset) => {
    setSelectedId(undefined);
    onUse({ modality: 'audio', prompt: '', model: voice.provider === 'fishaudio' ? 'fishaudio:s2-pro' : `${voice.provider}:speech-2.8-hd`, references: [], voiceRef: { voiceId: voice.id, revision: voice.revision }, voiceName: voice.name });
  };
  const items = shown?.map(voice => <AssetTile key={voice.id} name={voice.name} selected={selectedId === voice.id}
    onOpen={() => { tracking.reportAssetsClick('assets_library', 'open_asset', { asset_kind: 'voice' }); setSelectedId(voice.id); }}
    preview={<VoicePreview />} caption={!selected && <>{t(registeredProvider(voice.provider)?.label ?? voice.provider)} · {t(voiceKindLabel(voice.kind))}</>} />);
  const feedback = failed ? <div className="om-empty"><p>{t('Could not load voices')}</p><button className="om-button" onClick={() => setRefresh(value => value + 1)}>{t('Retry')}</button></div>
    : !shown ? <div className="om-asset-grid">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="om-asset-loading-card" />)}</div> : undefined;
  const gallery = <section aria-label={t('Voices')}><div className="om-asset-results">{feedback ?? (shown?.length ? <><p className="om-muted">{t('{count} assets', { count: shown.length })}</p><div className="om-asset-grid">{items}</div></> : <div className="om-empty om-asset-empty"><RemixIcon name={trash ? 'delete-bin-line' : 'voiceprint-line'} size={40} /><h2 className="om-subtitle">{t(query ? 'No matching voices' : trash ? 'No removed voices' : 'Bring your own voice')}</h2><p className="om-muted">{t('Save voices from your accounts. Generate narration as audio, then use it in your video.')}</p></div>)}</div></section>;
  return <>
    {adding && <VoiceAdd onCancel={onCloseAdd} onError={onError} onAdded={voice => { setSelectedId(voice.id); onCloseAdd(); setRefresh(value => value + 1); onNotice(t('Saved')); }} />}
    {selected ? <VoiceDetail key={`${selected.id}:${selected.revision}`} voice={selected} active={active} busy={busy} navigation={<section data-compact><div className="om-asset-grid">{items}</div></section>} onClose={() => setSelectedId(undefined)} onCheck={() => void update(selected, 'check')} onUse={() => use(selected)} onProvider={openModelSettings} onSave={changes => update(selected, 'update', changes)} onError={onError} />
      : renderGallery ? renderGallery({ items, count: shown?.length ?? 0, feedback, content: gallery }) : gallery}
  </>;
}
function VoicePreview() {
  return <div className="om-asset-preview om-media-surface" data-kind="audio"><div className="om-asset-media-symbol"><RemixIcon name="voiceprint-line" size={40} /></div></div>;
}

function VoiceAdd({ onCancel, onAdded, onError }: { onCancel: () => void; onAdded: (voice: VoiceAsset) => void; onError: (message: string) => void }) {
  const { t } = useI18n(), { openModelSettings } = useWorkspaceChrome();
  const [provider, setProvider] = useState<VoiceProvider>('fishaudio'), [name, setName] = useState(''), [externalId, setExternalId] = useState(''), [kind, setKind] = useState<VoiceAsset['kind']>('unknown'), [busy, setBusy] = useState(false);
  const [discovered, setDiscovered] = useState<{ externalId: string; name: string; kind: VoiceAsset['kind'] }[]>([]), [nextPage, setNextPage] = useState<number | null>(1), [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  const load = async () => {
    if (loading) return; setLoading(true); const current = sequence.current;
    try {
      const result = await request<{ voices: typeof discovered; nextPage: number | null }>({ command: 'discover', provider, page: nextPage ?? 1 });
      if (current === sequence.current) { setDiscovered(items => nextPage === 1 ? result.voices : [...items, ...result.voices]); setNextPage(result.nextPage); }
    } catch (error) { if (current === sequence.current) onError(t((error as Error).message)); }
    finally { if (current === sequence.current) setLoading(false); }
  };
  return <SettingsDialog title={t('Add an existing voice')} onClose={() => { if (!busy) onCancel(); }}><form className="om-voice-form" aria-label={t('Add voice')} onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); const current = sequence.current;
    try { const result = await request<{ voice: VoiceAsset }>({ command: 'add', requestId: crypto.randomUUID(), provider, name, externalId, kind }); if (current === sequence.current) onAdded(result.voice); }
    catch (error) { if (current === sequence.current) onError(t((error as Error).message)); }
    finally { if (current === sequence.current) setBusy(false); }
  }}>
    <div className="om-voice-fields"><label><span className="om-eyebrow">{t('Provider')}</span><Select label={t('Provider')} value={provider} options={voiceProviders.map(id => ({ value: id, label: t(registeredProvider(id)!.label) }))} onCommit={value => { sequence.current++; setProvider(value as VoiceProvider); setDiscovered([]); setNextPage(1); setLoading(false); setExternalId(''); setKind('unknown'); }} disabled={busy} /></label>
    <label><span className="om-eyebrow">{t('Name')}</span><span className="om-field"><input required maxLength={200} value={name} onChange={e => setName(e.target.value)} aria-label={t('Voice name')} placeholder={t('My narration voice')} disabled={busy} /></span></label></div>
    <div className="om-asset-actions"><button type="button" className="om-button" disabled={busy || loading || nextPage === null} onClick={() => void load()}><RemixIcon name="refresh-line" size={15} />{t(loading ? 'Working…' : discovered.length ? 'Load more voices' : 'Browse account voices')}</button><button type="button" className="om-nav-item" disabled={busy} onClick={() => { onCancel(); openModelSettings(); }}>{t('Model providers')}</button></div>
    {discovered.length > 0 && <Select label={t('Account voice')} value={externalId} options={discovered.map(voice => ({ value: voice.externalId, label: voice.name }))} onCommit={id => { const voice = discovered.find(item => item.externalId === id)!; setExternalId(id); setName(voice.name); setKind(voice.kind); }} />}
    <div className="om-voice-fields"><label><span className="om-eyebrow">{t('Voice ID')}</span><span className="om-field"><input required aria-label={t('Voice ID')} maxLength={256} value={externalId} onChange={e => setExternalId(e.target.value)} placeholder={t('Paste your provider voice ID')} disabled={busy} /></span></label><label><span className="om-eyebrow">{t('Voice type')}</span><Select label={t('Voice type')} value={kind} options={voiceKinds.map(value => ({ value, label: t(voiceKindLabel(value)) }))} onCommit={value => setKind(value as VoiceAsset['kind'])} disabled={busy} /></label></div>
    <p className="om-muted">{t('Missing from the list? Paste the voice ID. MiniMax may list custom voices only after synthesis.')}</p><p className="om-muted">{t('Saving a voice does not clone, activate or generate speech.')}</p><div className="om-dialog-actions"><button type="button" className="om-button" disabled={busy} onClick={onCancel}>{t('Cancel')}</button><button className="om-button" data-primary disabled={busy || !name.trim() || !externalId.trim()}>{t(busy ? 'Working…' : 'Save voice')}</button></div>
  </form></SettingsDialog>;
}
function VoiceDetail({ voice, active, busy, navigation, onClose, onCheck, onUse, onProvider, onSave, onError }: {
  voice: VoiceAsset; active: boolean; busy: boolean; navigation: ReactNode; onClose: () => void; onCheck: () => void; onUse: () => void; onProvider: () => void;
  onSave: (changes: Record<string, unknown>) => Promise<boolean | void>; onError: (message: string) => void;
}) {
  const { t, formatDate } = useI18n(), [description, setDescription] = useState(voice.description), [uploading, setUploading] = useState(false), [failed, setFailed] = useState(false);
  const upload = useRef<HTMLInputElement>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <section className="om-asset-workspace" aria-label={t('Voice details')}>
    <header className="om-asset-workspace-header"><button className="om-nav-item" onClick={onClose}><RemixIcon name="arrow-left-line" size={16} />{t('All assets')}</button><strong>{voice.name}</strong><span className="om-badge">{t('Voices')}</span></header>
    <div className="om-asset-workspace-body">
      <ResizablePane className="om-asset-filmstrip om-surface-divider" storageKey="motion-asset-filmstrip-width" initial={150} min={112} max={280} edge="right" label={t('Resize asset navigation')}>{navigation}</ResizablePane>
      <main className="om-asset-viewer"><div className="om-asset-viewer-stage"><div className="om-asset-preview om-media-surface" data-kind="audio">
        {voice.preview && active && !failed ? <AssetAudioPreview src={assetMediaUrl(voice.preview.assetId, voice.preview.versionId)} onError={() => { setFailed(true); onError(t('Preview unavailable')); }} /> : <div className="om-empty"><div className="om-asset-media-symbol"><RemixIcon name="voiceprint-line" size={40} /></div><p className="om-muted">{t(failed ? 'Preview unavailable' : 'No audio sample attached')}</p></div>}
      </div></div><footer className="om-asset-viewer-caption om-muted"><span>{t(registeredProvider(voice.provider)?.label ?? voice.provider)}</span><span>{t(voiceKindLabel(voice.kind))}</span></footer></main>
      <ResizablePane className="om-asset-inspector-pane" storageKey="motion-asset-inspector-width" initial={360} min={280} max={600} edge="left" label={t('Resize asset details')}>
        <aside className="om-asset-inspector" data-voice-detail aria-label={t('Voice details')}>
          <AssetNameEditor name={voice.name} saving={busy} onRename={name => onSave({ name })} />
          <dl className="om-asset-metadata"><dt>{t('Provider')}</dt><dd>{t(registeredProvider(voice.provider)?.label ?? voice.provider)}</dd><dt>{t('Voice type')}</dt><dd>{t(voiceKindLabel(voice.kind))}</dd><dt>{t('Created')}</dt><dd>{formatDate(voice.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</dd>{voice.checkedAt && <><dt>{t('Last checked')}</dt><dd>{formatDate(voice.checkedAt, { dateStyle: 'short', timeStyle: 'short' })}</dd></>}</dl>
          <p className="om-muted" role="status">{t(voiceStatus(voice))}</p>
          {!voice.trashedAt && <><div className="om-asset-version-actions"><button className="om-button" data-primary disabled={busy} onClick={onUse}><RemixIcon name="voiceprint-line" size={16} />{t('Use for narration')}</button></div><div className="om-asset-version-actions"><button className="om-button" disabled={busy} onClick={onCheck}>{t('Check availability')}</button><button className="om-button" onClick={onProvider}>{t('Model providers')}</button></div></>}
          <section className="om-asset-provenance"><label className="om-eyebrow" htmlFor="voice-description">{t('Description')}</label><span className="om-field"><textarea id="voice-description" aria-label={t('Voice description')} value={description} rows={3} maxLength={2000} onChange={e => setDescription(e.target.value)} disabled={busy} /></span>{description !== voice.description && <button className="om-button" disabled={busy} onClick={() => void onSave({ description })}>{t('Save')}</button>}</section>
          <details className="om-asset-provenance"><summary className="om-nav-item">{t('Source details')}</summary><p>{voice.externalId}</p><p className="om-muted">{t('Voice revisions preserve configuration, not remote model weights.')}</p></details>
          <p className="om-muted">{t('An audio sample does not verify that speech generation is available.')}</p>
          <div className="om-asset-inspector-footer">{!voice.trashedAt && <button className="om-nav-item" disabled={busy || uploading} onClick={() => upload.current?.click()}><RemixIcon name="upload-2-line" size={15} />{t(uploading ? 'Working…' : 'Attach audio sample')}</button>}<button className="om-nav-item" disabled={busy || uploading} onClick={() => void onSave({ trashed: !voice.trashedAt })}><RemixIcon name={voice.trashedAt ? 'history-line' : 'delete-bin-line'} size={15} />{t(voice.trashedAt ? 'Restore' : 'Move voice to trash')}</button></div><p className="om-muted">{t('Removing this record keeps the provider voice and generated audio.')}</p>
          <input ref={upload} type="file" accept="audio/*" hidden onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file || uploading) return; setUploading(true); try { const asset = await uploadLibraryAsset(file); if (asset.modality !== 'audio') throw new Error('Choose an audio asset for the preview'); if (mounted.current) await onSave({ preview: { assetId: asset.id, versionId: asset.currentVersionId } }); } catch (error) { if (mounted.current) onError(t((error as Error).message)); } finally { if (mounted.current) setUploading(false); } }} />
        </aside>
      </ResizablePane>
    </div>
  </section>;
}
