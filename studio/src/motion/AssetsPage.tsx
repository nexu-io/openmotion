import { VoiceLibrary } from './VoiceLibrary';
import * as tracking from './pageTracking';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { assetVersion, type LibraryAsset } from '../../../shared/asset-library';
import type { GenerationJob } from '../../../shared/gateway';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { AssetBrowserContent, useAssetBrowser, AssetPicker, type AssetGalleryExtras, type AssetKind } from './AssetBrowser';
import { AssetGalleryToolbar } from './AssetGalleryToolbar';
import { AssetTaskMenu } from './AssetTaskHistory';
import { assetTasks, mergeAssetJobs, type AssetChatSummary, type AssetTask, type AssetTaskMode } from './assetTasks';
import { gatewayRequest } from './gatewayClient';
import { AssetComposer, type AssetDraft } from './AssetComposer';
import { assetRequest, uploadLibraryAsset } from './assetClient';
import { AssetUploadError } from './assetUploadError';
import { assetUploadMessage, type AssetUploadSummary } from '../i18n/assetUploadMessages';
import { AssetDetailWorkspace } from './AssetDetailWorkspace';
import { ResizablePane } from './ResizablePane';
import './assets.css';
export function AssetsPage({ active, hasProject = false }: { active: boolean; hasProject?: boolean }) {
  const { t } = useI18n(), toast = useToast();
  const [voiceView, setVoiceView] = useState(false), [voiceAdding, setVoiceAdding] = useState(false);
  const [kind, setKind] = useState<AssetKind>('all'), [revision, setRevision] = useState(0), [creating, setCreating] = useState(false), [picking, setPicking] = useState(false), [uploading, setUploading] = useState(false), [selected, setSelected] = useState<LibraryAsset>(), [versionId, setVersionId] = useState(''), [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [draft, setDraft] = useState<AssetDraft>({ modality: 'image', prompt: '', references: [] });
  const [mobileView, setMobileView] = useState<'library' | 'create'>('create');
  const [agentReferences, setAgentReferences] = useState<AssetDraft['references']>([]);
  const [mode, setMode] = useState<AssetTaskMode>('direct'), [taskIds, setTaskIds] = useState<{ direct?: string; agent?: string }>({}), [taskEpoch, setTaskEpoch] = useState(0);
  const [conversations, setConversations] = useState<AssetChatSummary[]>([]), [historyLoading, setHistoryLoading] = useState(true), [historyError, setHistoryError] = useState<string>(), [historyRetry, setHistoryRetry] = useState(0), [selectingTask, setSelectingTask] = useState(false);
  const selectionRequest = useRef(0);
  const selectedAsset = useRef<LibraryAsset | undefined>(undefined), assetReadRequest = useRef(0);
  const pendingWrites = useRef(new Set<string>()), [updatingAssets, setUpdatingAssets] = useState<Set<string>>(new Set());
  const browser = useAssetBrowser({ kind, revision, active });
  // One page view each time the library is shown; the page stays mounted while hidden.
  useEffect(() => { if (active) tracking.reportAssetsPageView(hasProject); }, [active]);
  const gallery = useRef<HTMLElement>(null), galleryScroll = useRef<{ top: number; key: string } | undefined>(undefined);
  useLayoutEffect(() => {
    if (selected || !gallery.current || !browser.data || !galleryScroll.current) return;
    if (galleryScroll.current.key === browser.data.key) gallery.current.scrollTop = galleryScroll.current.top;
    galleryScroll.current = undefined;
  }, [selected, browser.data]);
  const tasks = assetTasks(jobs, conversations), selectedKey = taskIds[mode] ? `${mode}:${taskIds[mode]}` : undefined;
  const chatChanged = useCallback((chat: AssetChatSummary) => setConversations(current => {
    if ((current.find(item => item.id === chat.id)?.updatedAt ?? -1) > chat.updatedAt) return current;
    return [chat, ...current.filter(item => item.id !== chat.id)];
  }), []);
  const upload = useRef<HTMLInputElement>(null), replace = useRef<HTMLInputElement>(null), knownJobs = useRef<GenerationJob[]>([]);
  const refresh = useCallback(() => setRevision(v => v + 1), []), onError = useCallback((message: string) => toast.showToast(message), [toast.showToast]);
  const closePreview = useCallback(() => {
    selectionRequest.current++; assetReadRequest.current++; selectedAsset.current = undefined;
    setSelectingTask(false); setSelected(undefined); setVersionId(''); setCreating(false);
  }, []);
  const open = useCallback((asset: LibraryAsset) => {
    if (gallery.current && browser.data) galleryScroll.current = { top: gallery.current.scrollTop, key: browser.data.key };
    selectionRequest.current++; assetReadRequest.current++; selectedAsset.current = asset;
    setSelectingTask(false); setSelected(asset); setVersionId(asset.currentVersionId); setCreating(false);
  }, [browser.data]);
  useEffect(() => {
    if (!active) return; let cancelled = false, pending = false;
    const poll = async () => {
      if (pending || document.hidden) return; pending = true;
      try {
        const [jobResult, chatResult] = await Promise.allSettled([assetRequest<{ jobs: GenerationJob[] }>({ action: 'jobs' }), gatewayRequest<{ conversations: AssetChatSummary[] }>('assets/conversations')]);
        if (cancelled) return;
        if (chatResult.status === 'fulfilled') setConversations(current => {
          const merged = new Map(current.map(chat => [chat.id, chat]));
          for (const chat of chatResult.value.conversations) if ((merged.get(chat.id)?.updatedAt ?? 0) <= chat.updatedAt) merged.set(chat.id, chat);
          return [...merged.values()];
        });
        setHistoryError(jobResult.status === 'rejected' || chatResult.status === 'rejected' ? 'Could not load task history' : undefined);
        if (jobResult.status === 'rejected') return;
        const next = mergeAssetJobs(knownJobs.current, jobResult.value.jobs);
        if (JSON.stringify(next) !== JSON.stringify(knownJobs.current)) {
          const outputsChanged = JSON.stringify(next.flatMap(job => job.libraryAssets ?? [])) !== JSON.stringify(knownJobs.current.flatMap(job => job.libraryAssets ?? []));
          knownJobs.current = next; setJobs(next);
          if (outputsChanged) refresh();
        }
      } catch { if (!cancelled) setHistoryError('Could not load task history'); } finally { pending = false; if (!cancelled) setHistoryLoading(false); }
    };
    void poll(); const timer = setInterval(() => void poll(), 2500); return () => { cancelled = true; clearInterval(timer); };
  }, [active, refresh, historyRetry]);
  useEffect(() => {
    if (!active || !selected) return; let cancelled = false;
    const request = ++assetReadRequest.current;
    void assetRequest<{ asset: LibraryAsset }>({ action: 'get', assetId: selected.id }).then(({ asset }) => {
      if (cancelled || request !== assetReadRequest.current || selectedAsset.current?.id !== asset.id || pendingWrites.current.has(asset.id)) return;
      if (Boolean(asset.trashedAt) !== Boolean(selectedAsset.current.trashedAt)) { closePreview(); refresh(); return; }
      if (asset.updatedAt < selectedAsset.current.updatedAt) return;
      setVersionId(current => assetVersion(asset, current) ? current : asset.currentVersionId);
      selectedAsset.current = asset; setSelected(asset);
    }).catch(error => { if (!cancelled && request === assetReadRequest.current) onError(error.message); });
    return () => { cancelled = true; };
  }, [active, selected?.id, revision, onError, closePreview, refresh]);
  const importFiles = async (files: File[], newVersion = false, entry: 'library_button' | 'library_drop' | 'library_new_version' = newVersion ? 'library_new_version' : 'library_button') => {
    const targetId = newVersion ? selected?.id : undefined, parentVersionId = newVersion ? versionId : undefined, request = selectionRequest.current;
    if (newVersion && !targetId) return;
    if (uploading || !files.length) return; setUploading(true);
    const summary: AssetUploadSummary = { uploaded: 0, failed: 0, unknown: 0, reasons: new Set() };
    try {
      for (const file of files) {
        try { const asset = await uploadLibraryAsset(file, targetId, parentVersionId); summary.uploaded++; if (newVersion && request === selectionRequest.current && selectedAsset.current?.id === targetId) open(asset); }
        catch (error) {
          if (error instanceof AssetUploadError && error.outcome === 'rejected') {
            summary.failed++; if (error.reason) summary.reasons.add(error.reason);
          } else summary.unknown++;
        }
      }
      if (summary.uploaded || summary.unknown) refresh();
      toast.showToast(assetUploadMessage(summary), summary.failed || summary.unknown ? 'error' : 'info');
      tracking.reportLibraryImport(entry, files.length, summary.uploaded);
    } finally { setUploading(false); }
  };
  const persistUpdate = async (assetId: string, changes: Record<string, unknown>) => {
    if (pendingWrites.current.has(assetId)) throw new Error(t('This asset is being updated. Try again in a moment.'));
    pendingWrites.current.add(assetId); setUpdatingAssets(new Set(pendingWrites.current));
    assetReadRequest.current++;
    try {
      const { asset } = await assetRequest<{ asset: LibraryAsset }>({ action: 'update', assetId, changes });
      // A completed write only reconciles its own asset, never a later selection.
      if (selectedAsset.current?.id === assetId && asset.updatedAt >= selectedAsset.current.updatedAt) {
        if (Boolean(asset.trashedAt) !== Boolean(selectedAsset.current.trashedAt)) closePreview();
        else {
          selectedAsset.current = asset; setSelected(asset);
          if (typeof changes.currentVersionId === 'string') setVersionId(changes.currentVersionId);
        }
      }
    } finally {
      assetReadRequest.current++;
      pendingWrites.current.delete(assetId); setUpdatingAssets(new Set(pendingWrites.current));
      refresh();
    }
  };
  const update = async (assetId: string, changes: Record<string, unknown>) => {
    if (pendingWrites.current.has(assetId)) return false;
    const modality = selectedAsset.current?.id === assetId ? selectedAsset.current.modality : undefined;
    try {
      await persistUpdate(assetId, changes);
      tracking.reportAssetUpdate(changes, 'success', modality);
      if (changes.trashed === true) toast.showToast(t('Asset removed'), 'info', undefined, {
        key: `restore:${assetId}`, label: t('Undo'), onClick: async () => {
          try { await persistUpdate(assetId, { trashed: false }); tracking.reportAssetUpdate({ trashed: false }, 'success', modality); }
          catch (error) { tracking.reportAssetUpdate({ trashed: false }, 'failure', modality); throw error; }
          toast.showToast(t('Asset restored'), 'info');
        },
      });
      else toast.showToast(t(changes.trashed === false ? 'Asset restored' : 'Saved'), 'info');
      return true;
    } catch (error) { tracking.reportAssetUpdate(changes, 'failure', modality); onError((error as Error).message); return false; }
  };
  const cancelJob = (job: GenerationJob) => { tracking.reportAssetsClick('asset_tasks', 'cancel_task', { modality: job.modality }); void assetRequest({ action: 'cancel', jobId: job.id }).then(() => setHistoryRetry(value => value + 1)).catch(error => onError(error.message)); };
  const retrySave = async (job: GenerationJob) => {
    tracking.reportAssetsClick('asset_tasks', 'retry_save', { modality: job.modality });
    try {
      const { job: next } = await assetRequest<{ job: GenerationJob }>({ action: 'retry_save', jobId: job.id, requestId: `save-${job.id}` });
      knownJobs.current = mergeAssetJobs(knownJobs.current, [next]); setJobs(knownJobs.current);
    } catch (error) { onError((error as Error).message.startsWith('SAVE_NOT_AVAILABLE:') ? t('The retained files are missing, changed or unreadable. Saving cannot be retried. No new generation was requested.') : (error as Error).message); }
  };
  const resumeJob = async (job: GenerationJob) => {
    tracking.reportAssetsClick('asset_tasks', 'resume_task', { modality: job.modality });
    try {
      const { job: next } = await assetRequest<{ job: GenerationJob }>({ action: 'resume', jobId: job.id, requestId: `resume-${job.id}` });
      knownJobs.current = mergeAssetJobs(knownJobs.current, [next]); setJobs(knownJobs.current);
    } catch (error) { onError((error as Error).message); }
  };
  const openReference = async (reference: { assetId: string; versionId: string }) => {
    const request = ++selectionRequest.current;
    try {
      const { asset } = await assetRequest<{ asset: LibraryAsset }>({ action: 'get', assetId: reference.assetId });
      if (request !== selectionRequest.current) return;
      open(asset); setVersionId(reference.versionId);
    } catch (error) { if (request === selectionRequest.current) onError((error as Error).message); }
  };
  const viewJob = (job: GenerationJob) => { if (job.libraryAssets?.[0]) void openReference(job.libraryAssets[0]); };
  const version = selected && assetVersion(selected, versionId);
  const startDraft = (next: AssetDraft, nextMode: AssetTaskMode = 'direct') => {
    setMobileView('create');
    selectionRequest.current++; setSelectingTask(false); setDraft(next); setMode(nextMode);
    if (nextMode === 'agent') setAgentReferences([]);
    setTaskIds(current => ({ ...current, [nextMode]: undefined })); setTaskEpoch(value => value + 1); setCreating(true);
  };
  const edit = () => {
    if (!selected || !version) return;
    tracking.reportAssetsClick('asset_detail', 'edit_version', { modality: selected.modality });
    startDraft({ modality: selected.modality, prompt: version.prompt ?? '', model: version.model, parameters: version.parameters, ...(version.result?.voice ? { voiceRef: { voiceId: (version.result.voice as any).voiceId, revision: (version.result.voice as any).revision }, voiceName: (version.result.voice as any).name } : {}), target: { asset: selected, versionId }, references: selected.modality === 'audio' ? [] : [{ reference: { assetId: selected.id, versionId }, name: selected.name }] });
  };
  const create = () => {
    const modality = kind === 'video' || kind === 'audio' ? kind : 'image';
    tracking.reportAssetsClick('assets_library', 'create_asset', { modality });
    startDraft({ modality, prompt: '', references: [] });
  };
  const selectTask = async (task: AssetTask) => {
    const request = ++selectionRequest.current; setSelectingTask(true);
    try {
      let nextDraft = draft;
      if (task.mode === 'direct') {
        const job = task.jobs[0], referenceIds = job.library?.references ?? [];
        const references = await Promise.all(referenceIds.map(async reference => {
          const { asset } = await assetRequest<{ asset: LibraryAsset }>({ action: 'get', assetId: reference.assetId });
          if (!assetVersion(asset, reference.versionId)) throw new Error(t('A referenced version is no longer available.'));
          return { reference, name: asset.name };
        }));
        let target: AssetDraft['target'];
        if (job.library?.parentVersionId && !job.library.createNew) {
          const { asset } = await assetRequest<{ asset: LibraryAsset }>({ action: 'get', assetId: job.library.assetId });
          if (!assetVersion(asset, job.library.parentVersionId)) throw new Error(t('A referenced version is no longer available.'));
          target = { asset, versionId: job.library.parentVersionId };
        }
        nextDraft = { voiceRef: job.voiceRef, voiceName: job.voice?.name, modality: job.modality, prompt: job.prompt, model: job.model.id, parameters: job.parameters, references, target };
      }
      if (request !== selectionRequest.current) return;
      setDraft(nextDraft); setMode(task.mode); if (task.mode === 'agent') setAgentReferences([]); setTaskIds(current => ({ ...current, [task.mode]: task.id }));
      setTaskEpoch(value => value + 1); setCreating(true); setMobileView('create');
    } catch (error) { if (request === selectionRequest.current) onError((error as Error).message); }
    finally { if (request === selectionRequest.current) setSelectingTask(false); }
  };
  const history = { tasks, selectedKey, loading: historyLoading, error: historyError, onRetry: () => { setHistoryLoading(true); setHistoryRetry(value => value + 1); }, onSelect: (task: AssetTask) => { tracking.reportAssetsClick('asset_tasks', 'select_task', { task_mode: task.mode }); void selectTask(task); } };
  const taskMenu = <AssetTaskMenu {...history} disabled={selectingTask} />;
  const composer = <AssetComposer key={taskEpoch} active={active} draft={draft} setDraft={setDraft} agentReferences={agentReferences} setAgentReferences={setAgentReferences} jobs={jobs} mode={mode} onMode={next => { if (next !== mode) tracking.reportAssetsClick('asset_create', 'mode_switch', { task_mode: next }); setMode(next); }} taskIds={taskIds} history={history} selectingTask={selectingTask}
    onNew={() => startDraft(mode === 'agent' ? draft : { modality: draft.modality, prompt: '', references: [] }, mode)} onChatChanged={chatChanged}
    onChatStarted={id => setTaskIds(current => ({ ...current, agent: id }))}
    onCancel={cancelJob} onRetrySave={retrySave} onResume={resumeJob} onView={viewJob} onReference={() => { tracking.reportAssetsClick('asset_create', 'add_reference', { task_mode: mode }); setPicking(true); }} onCreated={job => {
      knownJobs.current = mergeAssetJobs(knownJobs.current, [job]); setJobs(knownJobs.current); setTaskIds(current => ({ ...current, direct: job.id }));
      refresh(); toast.showToast(t('Generation started. Track it in Tasks.'), 'info');
    }} onError={onError} onClose={() => { selectionRequest.current++; setSelectingTask(false); setCreating(false); }} />;
  const renderGallery = (voices?: AssetGalleryExtras & { content: ReactNode }) => (
    <main ref={gallery} className="om-assets-main" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void importFiles(Array.from(e.dataTransfer.files), false, 'library_drop'); } }}>
      <header className="om-assets-heading"><div><h1 className="om-title">{t(kind === 'trash' ? 'Trash' : 'Workspace assets')}</h1><p className="om-muted">{t('One library for every creation.')}</p></div><div className="om-asset-actions">{taskMenu}{voiceView ? <button className="om-button" data-primary onClick={() => setVoiceAdding(true)}><RemixIcon name="add-line" size={16} />{t('Add voice')}</button> : <><button className="om-button" disabled={uploading} onClick={() => { tracking.reportAssetsClick('assets_library', 'upload'); upload.current?.click(); }}><RemixIcon name="upload-2-line" size={16} />{t(uploading ? 'Uploading…' : 'Upload')}</button><button className="om-button" data-primary onClick={create}><RemixIcon name="add-line" size={16} />{t('AI Create')}</button></>}</div></header>

      <AssetGalleryToolbar browser={browser} voices={voiceView} onVoices={() => { setKind('all'); setVoiceView(true); setVoiceAdding(false); closePreview(); tracking.reportAssetsClick('assets_library', 'kind_filter', { asset_kind: 'voice' }); }} onKindChange={next => { setVoiceView(false); setVoiceAdding(false); if (next !== kind) tracking.reportAssetsClick('assets_library', next === 'trash' ? 'trash_view' : 'kind_filter', { asset_kind: next }); setKind(next); }} />
      {voiceView ? voices?.content : <AssetBrowserContent extras={voices} browser={browser} hoverPreview={active} toolbar={<></>} onOpen={asset => { tracking.reportAssetsClick('assets_library', 'open_asset', { modality: asset.modality }); open(asset); }} onCreate={modality => { tracking.reportAssetsClick('assets_library', 'create_asset', { modality }); startDraft({ modality, prompt: '', references: [] }); }} />}
    </main>
  );
  return <div className="om-assets-page" data-creating={creating} data-previewing={Boolean(selected)} data-mobile-view={mobileView}>
    {selected ? <AssetDetailWorkspace asset={selected} versionId={versionId} active={active} uploading={uploading} saving={updatingAssets.has(selected.id)} editor={creating ? composer : undefined} taskControls={taskMenu}
      navigation={<AssetBrowserContent browser={browser} onOpen={open} compact selectedId={selected.id} />}
      onBack={() => { tracking.reportAssetsClick('asset_detail', 'close_detail', { modality: selected.modality }); closePreview(); }} onVersion={id => { if (id !== versionId) tracking.reportAssetsClick('asset_detail', 'switch_version', { modality: selected.modality }); setVersionId(id); }} onUpdate={changes => update(selected.id, changes)} onEdit={edit}
      onReference={() => { tracking.reportAssetsClick('asset_detail', 'use_as_reference', { modality: selected.modality }); startDraft({ modality: selected.modality, prompt: '', references: [{ reference: { assetId: selected.id, versionId }, name: selected.name }] }); }}
      onOpenReference={reference => { void openReference(reference); }}
      onUpload={() => { tracking.reportAssetsClick('asset_detail', 'upload', { modality: selected.modality }); replace.current?.click(); }} onDownload={() => { tracking.reportAssetsClick('asset_detail', 'download_asset', { modality: selected.modality }); toast.showToast(t('Download started'), 'info'); }} /> : <>
    {creating && <div className="om-assets-view-switch" role="group" aria-label={t('Workspace assets')}><div className="om-choice-tabs">
      <button className="om-nav-item" aria-pressed={mobileView === 'library'} onClick={() => setMobileView('library')}>{t('Asset library')}</button>
      <button className="om-nav-item" aria-pressed={mobileView === 'create'} onClick={() => setMobileView('create')}>{t('AI Create')}</button>
    </div></div>}
    <div className="om-assets-library">
    {voiceView || kind === 'all' || kind === 'trash' ? <VoiceLibrary active={active} revision={revision} trash={kind === 'trash'} query={browser.query} sort={browser.sort} adding={voiceAdding} onCloseAdd={() => setVoiceAdding(false)} renderGallery={voices => renderGallery(voiceView || browser.source === 'all' ? voices : undefined)} onUse={next => startDraft(next)} onError={onError} onNotice={message => toast.showToast(message, 'info')} /> : renderGallery()}

    {creating && <ResizablePane className="om-creator-pane" storageKey="motion-assets-creator-width" initial={460} min={340} max={800} edge="left" label={t('Resize creator')}>{composer}</ResizablePane>}
    </div>
    </>}
    <input ref={upload} type="file" multiple accept="image/*,video/*,audio/*" hidden onChange={e => { void importFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
    <input ref={replace} type="file" accept={`${selected?.modality ?? 'image'}/*`} hidden onChange={e => { void importFiles(Array.from(e.target.files ?? []), true); e.target.value = ''; }} />
    {active && picking && <AssetPicker revision={revision} onClose={() => setPicking(false)} onPick={(reference, asset) => { const items = mode === 'agent' ? agentReferences : draft.references;
      const references = [...items.filter(r => r.reference.assetId !== reference.assetId || r.reference.versionId !== reference.versionId), { reference, name: asset.name }];
      if (mode === 'agent') setAgentReferences(references); else setDraft({ ...draft, references }); setPicking(false); }} />}
    <StudioToastViewport {...toast} />
  </div>;
}
