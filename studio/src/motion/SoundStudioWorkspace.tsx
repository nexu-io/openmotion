import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { assetMediaUrl, assetVersion, type AssetVersion, type LibraryAsset } from '../../../shared/asset-library';
import { resumableJob, type GenerationJob, type Model } from '../../../shared/gateway';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { formatTime } from '../player/lib/time';
import type { useAssetBrowser } from './AssetBrowser';
import type { AssetDraft } from './AssetComposer';
import type { StudioCreation } from './CreativeWorkspace';
import { emptyParameters, type ParameterDraft } from './GenerationParameters';
import { ResizablePane } from './ResizablePane';
import { SoundComposer, resolveSoundModels } from './SoundComposer';
import { SoundPlayerDock, useSoundPlayer, type SoundPlayableTrack } from './SoundPlayerDock';
import {
  SOUND_MUSIC_RECIPES,
  SOUND_SFX_STARTERS,
  SOUND_SPEECH_SCRIPTS,
  deterministicWaveform,
  estimateSpeechSeconds,
  resampleWaveform,
  resolveSavedVoiceName,
  type SoundSfxStarter,
} from './soundPresets';
import {
  SOUND_TABS,
  classifyAudioTrackTab,
  findSoundTab,
  type SoundLiveTabId,
  type SoundTabDefinition,
  type SoundTabId,
} from './soundTabs';
import { dayKey, modelDisplayLabel } from './generationLabels';
import { buildVoicePreviewTrack, resolveVoicePreview, type VoicePreviewController } from './voicePreviews';
import './soundStudio.css';

type AudioTypeFilter = 'all' | SoundLiveTabId;

type StreamEntry =
  | { kind: 'job'; id: string; createdAt: number; job: GenerationJob }
  | { kind: 'track'; id: string; createdAt: number; track: SoundPlayableTrack };

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${Number(size.toFixed(1))} ${units[unit]}`;
}

function modelLabelForVersion(studio: StudioCreation, modelId?: string): string | undefined {
  return modelDisplayLabel(studio.catalog.catalog?.models, modelId);
}

function buildAssetTrack(
  asset: LibraryAsset,
  version: AssetVersion,
  studio: StudioCreation,
  t: (s: string) => string,
): SoundPlayableTrack {
  const modelLabel = modelLabelForVersion(studio, version.model);
  const voiceName = resolveSavedVoiceName(version.parameters?.voice, version.model, studio.catalog.catalog?.models);
  const subtitleParts = [
    modelLabel ?? (version.source === 'upload' ? t('Local upload') : ''),
    voiceName,
  ].filter(Boolean);
  return {
    id: `asset:${asset.id}/${version.id}`,
    kind: 'asset',
    title: asset.name,
    subtitle: subtitleParts.join(' · '),
    src: assetMediaUrl(asset.id, version.id),
    waveform: deterministicWaveform(`${asset.id}:${version.id}:${version.sha256}`, 44),
    durationHint: version.duration,
    prompt: version.prompt,
    downloadUrl: `${assetMediaUrl(asset.id, version.id)}?download=1`,
    asset,
    version,
  };
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function InteractiveWaveform({
  bars,
  progress,
  active,
  label,
  onSeek,
}: {
  bars: readonly number[];
  progress: number;
  active: boolean;
  label: string;
  onSeek: (ratio?: number) => void;
}) {
  const width = bars.length * 6;
  const clamped = Math.max(0, Math.min(1, progress));
  const playheadX = Math.max(1.5, Math.min(width - 2.5, clamped * width));

  return (
    <Button
      type="button"
      variant="plain"
      className="om-sound-waveform-btn"
      data-active={active || undefined}
      aria-label={label}
      onClick={event => {
        if (event.detail === 0) {
          onSeek(undefined);
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : undefined;
        onSeek(ratio);
      }}
    >
      <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" aria-hidden="true">
        {bars.map((height, index) => {
          const played = active && clamped > 0 && index / bars.length <= clamped;
          return (
            <rect
              key={index}
              x={index * 6 + 1}
              y={(100 - height) / 2}
              width={3.5}
              height={height}
              rx={1.75}
              data-played={played || undefined}
            />
          );
        })}
        {active && (
          <rect
            className="om-sound-playhead"
            x={playheadX}
            y={4}
            width={2.5}
            height={92}
            rx={1.25}
          />
        )}
      </svg>
    </Button>
  );
}

function GeneratingWaveform({ seed }: { seed: string }) {
  const bars = useMemo(() => deterministicWaveform(`gen:${seed}`, 44), [seed]);
  const width = bars.length * 6;
  return (
    <div className="om-sound-wave-generating" aria-hidden="true">
      <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
        {bars.map((height, index) => (
          <rect
            key={index}
            x={index * 6 + 1}
            y={(100 - height) / 2}
            width={3.5}
            height={height}
            rx={1.75}
            style={{ animationDelay: `${(index % 14) * 90}ms` }}
          />
        ))}
      </svg>
    </div>
  );
}

function SoundGeneratingRow({
  job,
  models,
  onCancel,
  onRecreate,
}: {
  job: GenerationJob;
  models: readonly Model[] | undefined;
  onCancel: (job: GenerationJob) => void;
  onRecreate: (job: GenerationJob) => void;
}) {
  const { t } = useI18n();
  const working = job.state === 'queued' || job.state === 'running';
  const saving = job.phase === 'downloading' || job.phase === 'saving';
  const reconnecting = working && job.phase === 'reconnecting';
  const voiceName = resolveSavedVoiceName(job.parameters?.voice, job.model.id, models, true);
  const tabKind = classifyAudioTrackTab(job.model.id, models);
  const primaryTitle = voiceName
    ?? (tabKind === 'sfx' ? t('Sound effects') : tabKind === 'speech' ? t('Speech') : t('Music'));

  return (
    <div
      role="listitem"
      className="om-sound-track-row om-sound-generating-row"
      data-state={job.state}
      aria-label={t('Generation activity')}
      aria-busy="true"
    >
      <span className="om-sound-row-spinner" aria-hidden="true">
        <RemixIcon name="loader-4-line" size={16} className="om-busy-icon" />
      </span>

      <div className="om-sound-row-info">
        <div className="om-sound-row-title-line">
          <strong className="om-sound-row-title">{primaryTitle}</strong>
          {(saving || reconnecting) && (
            <span className="om-badge" role="status">
              {t(saving ? 'Saving to assets' : 'Reconnecting…')}
            </span>
          )}
        </div>
        <Tooltip label={job.prompt} wrap>
          <p className="om-sound-row-desc">{job.prompt}</p>
        </Tooltip>
      </div>

      <div className="om-sound-row-wave">
        <GeneratingWaveform seed={job.id} />
      </div>

      <span className="om-badge om-sound-row-model">{job.model.label}</span>

      <div className="om-sound-row-actions">
        <Tooltip label={t('Recreate')}>
          <IconButton
            type="button"
            variant="plain"
            className="om-nav-item om-sound-row-action"
            aria-label={t('Recreate')}
            onClick={() => onRecreate(job)}
            icon={<RemixIcon name="sparkling-line" size={15} />}
          />
        </Tooltip>
        {working && (
          <Button
            type="button"
            variant="ghost"
            className="om-button h-auto om-sound-row-pill-btn"
            onClick={() => onCancel(job)}
          >
            {t('Cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}

function SoundFailedRow({
  job,
  onRetrySave,
  onResume,
  onRecreate,
  onDismiss,
}: {
  job: GenerationJob;
  onRetrySave?: (job: GenerationJob) => Promise<void>;
  onResume?: (job: GenerationJob) => Promise<void>;
  onRecreate: (job: GenerationJob) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const [showError, setShowError] = useState(false);
  const resumable = resumableJob(job);
  const cancelled = job.state === 'cancelled' && !job.savePending;

  let diagnostic = job.error;
  if (diagnostic?.startsWith('SAVE_NOT_AVAILABLE:')) {
    diagnostic = t('The retained files are missing, changed or unreadable. Saving cannot be retried. No new generation was requested.');
  } else if (diagnostic?.startsWith('ASSET_MEDIA_RUNTIME_NOT_READY:')) {
    diagnostic = t('Local media components are unavailable. Prepare or repair this installation, then submit again. No model request was made; your original asset is unchanged.');
  }

  const retrySave = async () => {
    if (!onRetrySave || retrying) return;
    setRetrying(true);
    try { await onRetrySave(job); } finally { setRetrying(false); }
  };

  const resume = async () => {
    if (!onResume || retrying) return;
    setRetrying(true);
    try { await onResume(job); } finally { setRetrying(false); }
  };

  return (
    <div
      role="listitem"
      className="om-sound-failed-row"
      data-state={job.state}
      aria-label={t('Generation activity')}
    >
      <div className="om-sound-failed-main">
        <div className="om-sound-failed-badges">
          <span className="om-sound-failed-pill" data-tone={cancelled ? 'muted' : 'danger'} role="status">
            <RemixIcon name={cancelled ? 'close-line' : 'error-warning-line'} size={14} />
            <span>{t(cancelled ? 'Cancelled' : 'Failed')}</span>
          </span>
          {job.savePending && onRetrySave && (
            <Tooltip label={t('Generated files are kept locally. Retry saving without generating again.')} wrap>
              <Button
                type="button"
                variant="ghost"
                className="om-button h-auto om-sound-row-pill-btn"
                disabled={retrying}
                onClick={() => void retrySave()}
              >
                {t(retrying ? 'Retrying save…' : 'Retry saving')}
              </Button>
            </Tooltip>
          )}
          {resumable && onResume && (
            <Button
              type="button"
              variant="ghost"
              className="om-button h-auto om-sound-row-pill-btn"
              disabled={retrying}
              onClick={() => void resume()}
            >
              {t(retrying ? 'Checking original task…' : 'Check original task')}
            </Button>
          )}
        </div>

        <div className="om-sound-failed-copy">
          <div className="om-sound-failed-heading">
            <strong className="om-sound-row-title">
              {t(cancelled ? 'Generation cancelled' : 'Try again, or adjust your prompt and settings.')}
            </strong>
            {diagnostic && (
              <Tooltip label={t('Failure details')}>
                <IconButton
                  type="button"
                  variant="plain"
                  className="om-nav-item om-sound-reset-icon"
                  aria-label={t('Failure details')}
                  aria-expanded={showError}
                  onClick={() => setShowError(v => !v)}
                  icon={<RemixIcon name="information-line" size={14} />}
                />
              </Tooltip>
            )}
          </div>
          <Tooltip label={job.prompt} wrap>
            <p className="om-sound-row-desc">{job.prompt}</p>
          </Tooltip>
        </div>

        <div className="om-sound-row-actions">
          <Tooltip label={t('Recreate')}>
            <IconButton
              type="button"
              variant="plain"
              className="om-nav-item om-sound-row-action"
              aria-label={t('Recreate')}
              onClick={() => onRecreate(job)}
              icon={<RemixIcon name="sparkling-line" size={15} />}
            />
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            className="om-button h-auto om-sound-row-pill-btn"
            onClick={onDismiss}
          >
            <RemixIcon name="delete-bin-line" size={14} />
            <span>{t('Delete')}</span>
          </Button>
        </div>
      </div>

      {diagnostic && showError && (
        <p className="om-sound-failed-detail">{t(diagnostic)}</p>
      )}
    </div>
  );
}

function SoundSoonPreview({
  tab,
  trackCount,
  onPivot,
}: {
  tab: SoundTabDefinition;
  trackCount: number;
  onPivot: (target: SoundLiveTabId) => void;
}) {
  const { t } = useI18n();
  const pivot = tab.pivotTab ? findSoundTab(tab.pivotTab) : undefined;
  const pipeline = tab.pipeline ?? [];

  return (
    <div className="om-sound-soon-stage">
      <div className="om-sound-soon-shell">
        <header className="om-sound-soon-head">
          <div className="om-sound-soon-title-row">
            <span className="om-creation-icon om-sound-soon-icon" data-tone="audio" aria-hidden="true">
              <RemixIcon name={tab.icon} size={18} />
            </span>
            <h2 className="om-sound-soon-title">{t(tab.label)}</h2>
            <span className="om-badge om-sound-soon-pill">{t('Coming soon')}</span>
          </div>
        </header>

        {pipeline.length > 0 && (
          <div className="om-sound-pipeline" role="list" aria-label={t(tab.label)}>
            {pipeline.map((node, index) => (
              <div key={node.label} className="om-sound-pipeline-step" role="listitem">
                {index > 0 && (
                  <span className="om-sound-pipeline-connector" aria-hidden="true">
                    <span className="om-sound-pipeline-line" />
                    <RemixIcon name="arrow-right-line" size={14} />
                  </span>
                )}
                <div className="om-sound-pipeline-node" data-engine={index === 1 || undefined}>
                  <span className="om-sound-pipeline-glyph" aria-hidden="true">
                    <RemixIcon name={node.icon} size={18} />
                  </span>
                  <strong>{t(node.label)}</strong>
                  <span className="om-sound-mono-readout">{t(node.spec)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="om-sound-soon-footer">
          {trackCount > 0 && (
            <span className="om-sound-mono-readout">
              {t('{count} tracks', { count: trackCount })}
            </span>
          )}
          {pivot && (
            <Button
              type="button"
              variant="ghost"
              className="om-button h-auto"
              onClick={() => onPivot(pivot.id as SoundLiveTabId)}
            >
              <span>{t('Open {tab}', { tab: t(pivot.label) })}</span>
              <RemixIcon name="arrow-right-line" size={14} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SoundStudioWorkspace({
  active,
  studio,
  draft,
  setDraft,
  browser,
  jobs,
  uploading,
  updatingAssets,
  mobileView,
  setMobileView,
  onUploadClick,
  onDropFiles,
  onOpenAsset,
  onTrashAsset,
  onCancelJob,
  onRetrySave,
  onResumeJob,
  onViewJob: _onViewJob,
  onCreated,
  onError,
  onNotify,
  onDownload,
}: {
  active: boolean;
  studio: StudioCreation;
  draft: AssetDraft;
  setDraft: Dispatch<SetStateAction<AssetDraft>>;
  browser: ReturnType<typeof useAssetBrowser>;
  jobs: GenerationJob[];
  uploading: boolean;
  updatingAssets: Set<string>;
  mobileView: 'library' | 'create';
  setMobileView: Dispatch<SetStateAction<'library' | 'create'>>;
  onUploadClick: () => void;
  onDropFiles: (files: File[]) => void;
  onOpenAsset: (asset: LibraryAsset) => void;
  onTrashAsset: (assetId: string) => Promise<boolean>;
  onCancelJob: (job: GenerationJob) => void;
  onRetrySave: (job: GenerationJob) => Promise<void>;
  onResumeJob: (job: GenerationJob) => Promise<void>;
  onViewJob: (job: GenerationJob) => void;
  onCreated: (job: GenerationJob) => void;
  onError: (message: string) => void;
  onNotify: (message: string) => void;
  onDownload: () => void;
}) {
  const { t, formatDate } = useI18n();
  const activeTab: SoundTabId = studio.soundTab ?? (studio.destination.scene.id === 'speech' ? 'speech' : 'music');
  const tabDef = findSoundTab(activeTab) ?? SOUND_TABS[0];
  const isSoonTab = tabDef.status === 'soon';
  const liveTab: SoundLiveTabId = isSoonTab ? (tabDef.pivotTab ?? 'music') : (tabDef.id as SoundLiveTabId);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const locateTimerRef = useRef<number | null>(null);
  const pendingLocateIdRef = useRef<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [locatedTrackId, setLocatedTrackId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<AudioTypeFilter>('all');
  const [sessionJobIds, setSessionJobIds] = useState<string[]>([]);
  const [dismissedJobIds, setDismissedJobIds] = useState<Set<string>>(() => new Set());
  const [parameterDrafts, setParameterDrafts] = useState<Record<string, ParameterDraft>>(() =>
    draft.model && draft.parameters
      ? { [draft.model]: { values: { ...draft.parameters }, advanced: '{}' } }
      : {},
  );

  // Sync parameter draft when cross-tab initial draft brings explicit parameters.
  useEffect(() => {
    if (!draft.model || !draft.parameters || Object.keys(draft.parameters).length === 0) return;
    setParameterDrafts(current => {
      if (current[draft.model!]) return current;
      return { ...current, [draft.model!]: { values: { ...draft.parameters }, advanced: '{}' } };
    });
  }, [draft.model, draft.parameters]);

  // Track any active audio job observed on screen so reload-recovered jobs transition cleanly
  // in-place to either their completed track row (with New badge) or an inline failed row.
  useEffect(() => {
    const activeIds = jobs
      .filter(job => job.modality === 'audio' && (job.state === 'queued' || job.state === 'running'))
      .map(job => job.id);
    if (activeIds.length === 0) return;
    setSessionJobIds(current => {
      const missing = activeIds.filter(id => !current.includes(id));
      return missing.length > 0 ? [...missing, ...current] : current;
    });
  }, [jobs]);

  const { selected: selectedModel, preferred: preferredModel } = resolveSoundModels(studio, liveTab);
  const activeModel = selectedModel ?? preferredModel;
  const models = studio.catalog.catalog?.models;

  const featuredRecipe = SOUND_MUSIC_RECIPES[0];
  const featuredDemoTrack: SoundPlayableTrack = useMemo(() => ({
    id: `demo:${featuredRecipe.id}`,
    kind: 'demo',
    title: t(featuredRecipe.title),
    subtitle: '',
    src: featuredRecipe.audio!,
    blobSource: true,
    waveform: resampleWaveform(featuredRecipe.waveform ?? [], 44),
    durationHint: featuredRecipe.durationSeconds,
    prompt: t(featuredRecipe.prompt),
  }), [t]);

  const assets = browser.data?.assets ?? [];
  const allAssetTracks = useMemo(() => assets.flatMap(asset => {
    const version = assetVersion(asset);
    return version ? [buildAssetTrack(asset, version, studio, t)] : [];
  }), [assets, studio.catalog.catalog, t]);

  const savedAssetIds = useMemo(
    () => new Set(allAssetTracks.map(item => item.asset?.id).filter((id): id is string => Boolean(id))),
    [allAssetTracks],
  );

  const filteredAssetTracks = useMemo(() => {
    if (typeFilter === 'all') return allAssetTracks;
    return allAssetTracks.filter(track => classifyAudioTrackTab(track.version?.model, models) === typeFilter);
  }, [allAssetTracks, typeFilter, models]);

  // Unified stream jobs: in-progress, save-pending and resumable jobs always appear;
  // completed jobs seamlessly yield to their saved library track row without duplicates;
  // failed/cancelled session jobs stay inline until dismissed.
  const streamJobs = useMemo(() => {
    const sessionSet = new Set(sessionJobIds);
    return jobs.filter(job => {
      if (job.modality !== 'audio') return false;
      if (dismissedJobIds.has(job.id)) return false;
      if (job.state === 'queued' || job.state === 'running') return true;
      if (job.savePending || resumableJob(job)) return true;
      if (job.state === 'completed') {
        const assetId = job.libraryAssets?.[0]?.assetId;
        return sessionSet.has(job.id) && (!assetId || !savedAssetIds.has(assetId));
      }
      return sessionSet.has(job.id);
    });
  }, [jobs, sessionJobIds, dismissedJobIds, savedAssetIds]);

  const streamEntries = useMemo<StreamEntry[]>(() => {
    const jobEntries: StreamEntry[] = streamJobs.map(job => ({
      kind: 'job',
      id: `job:${job.id}`,
      createdAt: job.createdAt,
      job,
    }));
    const trackEntries: StreamEntry[] = filteredAssetTracks.map(track => ({
      kind: 'track',
      id: track.id,
      createdAt: track.version?.createdAt ?? track.asset?.updatedAt ?? 0,
      track,
    }));
    if (browser.sort === 'name') return [...jobEntries, ...trackEntries];
    const combined = [...jobEntries, ...trackEntries];
    // Keep actively running jobs pinned above older entries while preserving chronological rhythm.
    combined.sort((a, b) => {
      const aRunning = a.kind === 'job' && (a.job.state === 'queued' || a.job.state === 'running');
      const bRunning = b.kind === 'job' && (b.job.state === 'queued' || b.job.state === 'running');
      if (aRunning !== bRunning) return aRunning ? -1 : 1;
      return browser.sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
    });
    return combined;
  }, [streamJobs, filteredAssetTracks, browser.sort]);

  const groupedStream = useMemo(() => {
    if (browser.sort === 'name') {
      return streamEntries.length > 0 ? [{ key: 'all', label: '', entries: streamEntries }] : [];
    }
    const groups: { key: string; label: string; entries: StreamEntry[] }[] = [];
    for (const entry of streamEntries) {
      const key = entry.createdAt > 0 ? dayKey(entry.createdAt) : 'recent';
      const existing = groups[groups.length - 1];
      if (existing && existing.key === key) {
        existing.entries.push(entry);
      } else {
        groups.push({
          key,
          label: entry.createdAt > 0
            ? formatDate(entry.createdAt, { year: 'numeric', month: 'long', day: 'numeric' })
            : '',
          entries: [entry],
        });
      }
    }
    return groups;
  }, [streamEntries, browser.sort, formatDate]);

  const playlist = useMemo(
    () => (filteredAssetTracks.length > 0 ? filteredAssetTracks : [featuredDemoTrack]),
    [filteredAssetTracks, featuredDemoTrack],
  );

  const player = useSoundPlayer({
    active,
    playlist,
    onVoiceError: () => onError(t('Preview failed to load')),
  });

  const voicePreview: VoicePreviewController = useMemo(() => ({
    activeTrackId: player.track?.kind === 'voice' ? player.track.id : undefined,
    playing: player.track?.kind === 'voice' && player.playing,
    loading: player.track?.kind === 'voice' && player.loading,
    resolve: (model, voice) => resolveVoicePreview(model, voice.value, voice.previewUrl),
    toggle: (model, voice) => {
      const source = resolveVoicePreview(model, voice.value, voice.previewUrl);
      if (!source) return;
      player.playTrack(buildVoicePreviewTrack(model, voice, source, t));
    },
  }), [player.track?.id, player.track?.kind, player.playing, player.loading, player.playTrack, t]);

  const revealTrackRow = useCallback((trackId: string): boolean => {
    const stage = stageRef.current;
    if (!stage) return false;
    const rows = stage.querySelectorAll<HTMLElement>('.om-sound-track-row[data-track-id]');
    const target = Array.from(rows).find(node => node.dataset.trackId === trackId);
    if (!target) return false;
    target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    setLocatedTrackId(trackId);
    if (locateTimerRef.current !== null) window.clearTimeout(locateTimerRef.current);
    locateTimerRef.current = window.setTimeout(() => {
      setLocatedTrackId(current => (current === trackId ? null : current));
      locateTimerRef.current = null;
    }, 1400);
    return true;
  }, []);

  useEffect(() => () => {
    if (locateTimerRef.current !== null) window.clearTimeout(locateTimerRef.current);
  }, []);

  useEffect(() => {
    const pendingId = pendingLocateIdRef.current;
    if (!pendingId || isSoonTab) return;
    if (revealTrackRow(pendingId)) pendingLocateIdRef.current = null;
  }, [filteredAssetTracks, isSoonTab, revealTrackRow]);

  // DAW-style keyboard auditioning: Space toggles play/pause, Up/Down steps tracks.
  useEffect(() => {
    if (!active || isSoonTab) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableElement(event.target)) return;
      if (event.key === ' ' && !event.repeat) {
        if (event.target instanceof HTMLElement && event.target.closest('button, a, [role="button"], [role="slider"]')) return;
        event.preventDefault();
        if (player.track) player.togglePlay();
        else if (playlist[0]) player.playTrack(playlist[0]);
      } else if (event.key === 'ArrowDown' && player.canStepNext) {
        if (event.target instanceof HTMLElement && event.target.closest('[role="listbox"], [role="menu"], [role="slider"]')) return;
        event.preventDefault();
        player.stepTrack(1);
      } else if (event.key === 'ArrowUp' && player.canStepPrev) {
        if (event.target instanceof HTMLElement && event.target.closest('[role="listbox"], [role="menu"], [role="slider"]')) return;
        event.preventDefault();
        player.stepTrack(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, isSoonTab, player, playlist]);

  const hasFilters = Boolean(browser.query.trim() || browser.source !== 'all' || typeFilter !== 'all');
  const libraryEmpty = browser.data !== undefined && browser.data.total === 0 && !hasFilters;
  const showStarters = libraryEmpty && streamJobs.length === 0;

  const applyPromptToComposer = (text: string, notice?: string) => {
    setDraft(current => ({ ...current, prompt: text }));
    setMobileView('create');
    requestAnimationFrame(() => promptRef.current?.focus());
    if (notice) onNotify(notice);
  };

  const applySfxStarter = (starter: SoundSfxStarter) => {
    const localizedPrompt = t(starter.prompt);
    const nextValues: Record<string, unknown> = {
      duration_seconds: starter.durationSeconds,
      ...(starter.loop ? { loop: true } : {}),
    };
    if (activeModel) {
      setParameterDrafts(current => {
        const prev = current[activeModel.id] ?? emptyParameters;
        return { ...current, [activeModel.id]: { ...prev, values: { ...prev.values, ...nextValues } } };
      });
    }
    setDraft(current => ({
      ...current,
      prompt: localizedPrompt,
      ...(activeModel ? { model: activeModel.id, parameters: { ...(current.parameters ?? {}), ...nextValues } } : {}),
    }));
    setMobileView('create');
    requestAnimationFrame(() => promptRef.current?.focus());
    onNotify(t('Prompt loaded into editor'));
  };

  const copyAssetRef = (track: SoundPlayableTrack) => {
    if (!track.asset || !track.version) return;
    const refText = `${track.asset.id}/${track.version.id}`;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(refText).then(
        () => onNotify(t('Asset reference copied')),
        () => onNotify(refText),
      );
    } else {
      onNotify(refText);
    }
  };

  const hydrateComposer = (prompt: string, modelId: string | undefined, parameters: Record<string, unknown> | undefined) => {
    const matchedModel = modelId ? models?.find(m => m.id === modelId) : undefined;
    const classified = classifyAudioTrackTab(modelId, models);
    const targetTab: SoundLiveTabId = classified === 'upload' ? liveTab : classified;

    if (modelId && parameters && Object.keys(parameters).length > 0) {
      const key = matchedModel?.id ?? modelId;
      setParameterDrafts(current => ({
        ...current,
        [key]: { values: { ...parameters }, advanced: '{}' },
      }));
    }

    const nextDraft: AssetDraft = {
      modality: 'audio',
      prompt,
      model: matchedModel?.id ?? modelId,
      parameters,
      references: [],
    };

    if (targetTab !== activeTab && studio.selectSoundTab) {
      studio.selectSoundTab(targetTab, nextDraft, matchedModel?.id ?? null);
      setMobileView('create');
      requestAnimationFrame(() => promptRef.current?.focus());
      onNotify(t('Prompt and settings loaded'));
      return;
    }

    if (targetTab !== liveTab && studio.reuseInScene) {
      studio.reuseInScene(targetTab === 'speech' ? 'speech' : 'music', nextDraft, matchedModel?.id ?? null);
      onNotify(t('Prompt and settings loaded'));
      return;
    }

    if (matchedModel) studio.chooseModel(matchedModel.id);
    setDraft(current => ({
      ...current,
      prompt,
      model: matchedModel?.id ?? current.model,
      parameters,
    }));
    setMobileView('create');
    requestAnimationFrame(() => promptRef.current?.focus());
    onNotify(t('Prompt and settings loaded'));
  };

  const reuseTrack = (track: SoundPlayableTrack) => {
    if (!track.prompt) return;
    hydrateComposer(track.prompt, track.version?.model, track.version?.parameters);
  };

  const recreateJob = (job: GenerationJob) => {
    hydrateComposer(job.prompt, job.model.id, job.parameters);
  };

  const handleCreated = (job: GenerationJob) => {
    // Ensure active right-side filters or pagination cannot hide the in-place generating row or its completed track.
    if (typeFilter !== 'all' && typeFilter !== liveTab) setTypeFilter('all');
    if (browser.source === 'upload') browser.setSource('all');
    if (browser.query.trim()) browser.setQuery('');
    if (browser.page > 0) browser.setPage(0);

    setSessionJobIds(current => [job.id, ...current.filter(id => id !== job.id)]);
    setDismissedJobIds(current => {
      if (!current.has(job.id)) return current;
      const next = new Set(current);
      next.delete(job.id);
      return next;
    });
    setMobileView('library');
    onCreated(job);
  };

  const clearAllFilters = () => {
    browser.setQuery('');
    browser.setSource('all');
    setTypeFilter('all');
  };

  const locateTrack = (track: SoundPlayableTrack) => {
    setMobileView('library');
    if (isSoonTab) {
      pendingLocateIdRef.current = track.id;
      pivotToLiveTab(liveTab);
      return;
    }
    if (revealTrackRow(track.id)) return;
    if (hasFilters) {
      pendingLocateIdRef.current = track.id;
      clearAllFilters();
    }
  };

  const typeOptions: readonly { id: AudioTypeFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'music', label: 'Music' },
    { id: 'sfx', label: 'Sound effects' },
    { id: 'speech', label: 'Speech' },
  ];

  const newAssetIds = useMemo(() => new Set(
    jobs
      .filter(job => sessionJobIds.includes(job.id) && job.state === 'completed')
      .flatMap(job => job.libraryAssets?.map(ref => ref.assetId) ?? []),
  ), [jobs, sessionJobIds]);

  const pivotToLiveTab = (target: SoundLiveTabId) => {
    if (studio.selectSoundTab) {
      studio.selectSoundTab(target);
      return;
    }
    if (studio.reuseInScene) {
      studio.reuseInScene(target === 'speech' ? 'speech' : 'music', { modality: 'audio', prompt: '', references: [] }, null);
    }
  };

  const renderTrackRow = (track: SoundPlayableTrack) => {
    const asset = track.asset!;
    const version = track.version!;
    const isCurrent = player.track?.id === track.id;
    const isPlaying = isCurrent && player.playing;
    const versionNum = asset.versions.findIndex(v => v.id === version.id) + 1;
    const trackDuration = isCurrent && player.duration > 0 ? player.duration : (version.duration ?? 0);
    const progress = isCurrent && trackDuration > 0 ? Math.min(1, player.currentTime / trackDuration) : 0;
    const isFresh = newAssetIds.has(asset.id);
    const isSaving = updatingAssets.has(asset.id);
    const modelLabel = modelLabelForVersion(studio, version.model);
    const voiceName = resolveSavedVoiceName(version.parameters?.voice, version.model, models);
    const isInstrumental = version.parameters?.instrumental === true;
    const isLoop = version.parameters?.loop === true;
    const normalizedPrompt = version.prompt?.replace(/\s+/g, ' ').trim();
    const titleTooltip = normalizedPrompt && normalizedPrompt.length > asset.name.length && normalizedPrompt.startsWith(asset.name)
      ? version.prompt!
      : asset.name;
    const sourceLabel = [
      modelLabel ?? (version.source === 'upload' ? t('Local upload') : ''),
      voiceName,
      isInstrumental ? t('Instrumental') : '',
      isLoop ? t('Loop') : '',
    ].filter(Boolean).join(' · ');
    const metadataText = [
      version.bytes > 0 ? formatBytes(version.bytes) : version.mimeType,
      formatDate(version.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    ].filter(Boolean).join(' · ');

    return (
      <div
        key={track.id}
        role="listitem"
        className="om-sound-track-row"
        data-track-id={track.id}
        data-active={isCurrent || undefined}
        data-playing={isPlaying || undefined}
        data-fresh={isFresh || undefined}
        data-located={locatedTrackId === track.id || undefined}
      >
        <Tooltip label={t(isPlaying ? 'Pause' : 'Play')}>
          <IconButton
            type="button"
            variant="plain"
            className={isPlaying ? 'om-sound-row-play hf-od-primary' : 'om-sound-row-play'}
            data-playing={isPlaying || undefined}
            aria-label={t(isPlaying ? 'Pause {name}' : 'Play {name}', { name: asset.name })}
            onClick={() => player.playTrack(track)}
            icon={<RemixIcon name={isPlaying ? 'pause-fill' : 'play-fill'} size={16} />}
          />
        </Tooltip>

        <div className="om-sound-row-info">
          <div className="om-sound-row-title-line">
            <Tooltip label={titleTooltip} wrap>
              <strong className="om-sound-row-title">{asset.name}</strong>
            </Tooltip>
            {asset.versions.length > 1 && <span className="om-badge">V{versionNum}</span>}
            {isFresh && <span className="om-badge" data-active="true">{t('New')}</span>}
          </div>
          <div className="om-sound-row-meta-line">
            {sourceLabel && (
              <Tooltip label={sourceLabel} wrap>
                <span className="om-sound-row-source">{sourceLabel}</span>
              </Tooltip>
            )}
            {sourceLabel && metadataText && (
              <span className="om-sound-row-sep" aria-hidden="true">·</span>
            )}
            <p className="om-sound-row-desc">
              <span>{metadataText}</span>
            </p>
          </div>
        </div>

        <div className="om-sound-row-wave">
          <InteractiveWaveform
            bars={track.waveform}
            progress={progress}
            active={isCurrent}
            label={t('Seek {name}', { name: asset.name })}
            onSeek={ratio => player.playTrack(track, ratio)}
          />
        </div>

        <span className="om-sound-row-duration">
          {isCurrent && trackDuration > 0
            ? `${formatTime(player.currentTime)} / ${formatTime(trackDuration)}`
            : trackDuration > 0
              ? formatTime(trackDuration)
              : '--:--'}
        </span>

        <div className="om-sound-row-actions">
          {version.prompt && (
            <Tooltip label={t('Recreate')}>
              <IconButton
                type="button"
                variant="plain"
                className="om-nav-item om-sound-row-action"
                aria-label={t('Recreate')}
                onClick={() => reuseTrack(track)}
                icon={<RemixIcon name="sparkling-line" size={15} />}
              />
            </Tooltip>
          )}
          <Tooltip label={t('Copy asset reference')}>
            <IconButton
              type="button"
              variant="plain"
              className="om-nav-item om-sound-row-action"
              aria-label={t('Copy asset reference')}
              onClick={() => copyAssetRef(track)}
              icon={<RemixIcon name="file-copy-line" size={15} />}
            />
          </Tooltip>
          <Tooltip label={t('Download')}>
            <a
              className="om-nav-item om-sound-row-action"
              href={track.downloadUrl}
              download
              aria-label={t('Download')}
              onClick={onDownload}
            >
              <RemixIcon name="download-2-line" size={15} />
            </a>
          </Tooltip>
          <Tooltip label={t('Asset details')}>
            <IconButton
              type="button"
              variant="plain"
              className="om-nav-item om-sound-row-action"
              aria-label={t('Asset details')}
              onClick={() => onOpenAsset(asset)}
              icon={<RemixIcon name="arrow-right-up-line" size={15} />}
            />
          </Tooltip>
          <Tooltip label={t('Move to trash')}>
            <IconButton
              type="button"
              variant="plain"
              className="om-nav-item om-sound-row-action"
              aria-label={t('Move to trash')}
              disabled={isSaving}
              onClick={() => {
                if (player.track?.id === track.id) player.close();
                void onTrashAsset(asset.id);
              }}
              icon={<RemixIcon name="delete-bin-line" size={15} />}
            />
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <div className="om-sound-studio" data-mobile-view={mobileView} data-sound-tab={activeTab}>
      {!isSoonTab && (
        <div className="om-assets-view-switch" role="group" aria-label={t('Sound Studio views')}>
          <div className="om-choice-tabs">
            <Button type="button" variant="plain" className="om-nav-item" aria-pressed={mobileView === 'create'} onClick={() => setMobileView('create')}>
              {t('Create')}
            </Button>
            <Button type="button" variant="plain" className="om-nav-item" aria-pressed={mobileView === 'library'} onClick={() => setMobileView('library')}>
              {t('Tracks')}
            </Button>
          </div>
        </div>
      )}

      <div className="om-assets-library om-sound-layout">
        {!isSoonTab && (
          <ResizablePane
            className="om-creator-pane om-sound-composer-pane"
            storageKey="motion-studio-controls-width"
            initial={388}
            min={320}
            max={540}
            edge="right"
            label={t('Resize creator')}
          >
            <SoundComposer
              active={active}
              tabId={liveTab}
              studio={studio}
              draft={draft}
              setDraft={setDraft}
              parameterDrafts={parameterDrafts}
              setParameterDrafts={setParameterDrafts}
              promptRef={promptRef}
              voicePreview={voicePreview}
              onCreated={handleCreated}
              onError={onError}
            />
          </ResizablePane>
        )}

        <section
          ref={stageRef}
          className="om-sound-stage"
          data-drag-active={dragActive || undefined}
          aria-label={t('Audio workspace')}
          onDragOver={event => {
            if (!isSoonTab && event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              if (!dragActive) setDragActive(true);
            }
          }}
          onDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
          }}
          onDrop={event => {
            setDragActive(false);
            if (!isSoonTab && event.dataTransfer.files.length) {
              event.preventDefault();
              onDropFiles(Array.from(event.dataTransfer.files));
            }
          }}
        >
          {isSoonTab ? (
            <SoundSoonPreview
              tab={tabDef}
              trackCount={browser.data?.total ?? 0}
              onPivot={pivotToLiveTab}
            />
          ) : (
            <>
              <header className="om-sound-toolbar">
                <div className="om-sound-toolbar-filters">
                  <div className="om-choice-tabs om-sound-source-tabs" role="group" aria-label={t('Audio type')}>
                    {typeOptions.map(option => (
                      <Button
                        type="button"
                        variant="plain"
                        key={option.id}
                        className="om-nav-item"
                        aria-pressed={typeFilter === option.id}
                        onClick={() => setTypeFilter(option.id)}
                      >
                        {t(option.label)}
                      </Button>
                    ))}
                  </div>

                  <div className="om-sound-select">
                    <Select
                      label={t('Source')}
                      value={browser.source}
                      onCommit={browser.setSource}
                      options={[
                        { value: 'all', label: t('All sources') },
                        { value: 'generated', label: t('AI generated') },
                        { value: 'upload', label: t('Local upload') },
                      ]}
                    />
                  </div>

                  <label className="om-field om-sound-search">
                    <RemixIcon name="search-line" size={15} />
                    <input
                      type="search"
                      aria-label={t('Search audio')}
                      placeholder={t('Search audio...')}
                      value={browser.query}
                      onChange={event => browser.setQuery(event.target.value)}
                      maxLength={200}
                    />
                  </label>

                  <div className="om-sound-select">
                    <Select
                      label={t('Sort')}
                      value={browser.sort}
                      onCommit={browser.setSort}
                      options={[
                        { value: 'newest', label: t('Newest first') },
                        { value: 'oldest', label: t('Oldest first') },
                        { value: 'name', label: t('Name') },
                      ]}
                    />
                  </div>
                </div>

                <div className="om-sound-toolbar-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    className="om-button h-auto"
                    disabled={uploading}
                    onClick={onUploadClick}
                  >
                    <RemixIcon name="upload-2-line" size={15} />
                    <span>{t(uploading ? 'Uploading…' : 'Upload')}</span>
                  </Button>
                </div>
              </header>

              <main className="om-sound-content">
                <section className="om-sound-section om-sound-library-section" aria-label={t('Audio library')}>
                  {browser.error && streamEntries.length === 0 ? (
                    <div className="om-empty om-sound-state-box">
                      <RemixIcon name="error-warning-line" size={28} />
                      <p>{t('Could not load assets')}</p>
                      <Button type="button" variant="ghost" className="om-button h-auto" onClick={browser.retry}>
                        {t('Retry')}
                      </Button>
                    </div>
                  ) : !browser.data && streamEntries.length === 0 ? (
                    <div className="om-sound-track-list" aria-busy="true" aria-label={t('Loading…')}>
                      {Array.from({ length: 4 }, (_, i) => (
                        <Skeleton key={i} className="om-sound-track-skeleton" />
                      ))}
                    </div>
                  ) : streamEntries.length > 0 ? (
                    <>
                      <div className="om-sound-day-stream" aria-busy={browser.loading} inert={browser.stale && !browser.error}>
                        {groupedStream.map(group => (
                          <div key={group.key} className="om-sound-day-group">
                            {group.label && <div className="om-sound-day-label">{group.label}</div>}
                            <div className="om-sound-track-list" role="list">
                              {group.entries.map(entry => {
                                if (entry.kind === 'track') return renderTrackRow(entry.track);
                                const job = entry.job;
                                const isWorkingOrMorphing =
                                  job.state === 'queued'
                                  || job.state === 'running'
                                  || (job.state === 'completed' && !job.savePending);
                                if (isWorkingOrMorphing) {
                                  return (
                                    <SoundGeneratingRow
                                      key={entry.id}
                                      job={job}
                                      models={models}
                                      onCancel={onCancelJob}
                                      onRecreate={recreateJob}
                                    />
                                  );
                                }
                                return (
                                  <SoundFailedRow
                                    key={entry.id}
                                    job={job}
                                    onRetrySave={onRetrySave}
                                    onResume={onResumeJob}
                                    onRecreate={recreateJob}
                                    onDismiss={() => setDismissedJobIds(current => new Set([...current, job.id]))}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>

                      {browser.data && (browser.page > 0 || browser.data.nextOffset !== null) && (
                        <div className="om-asset-pagination">
                          <Button
                            type="button"
                            variant="ghost"
                            className="om-button h-auto"
                            disabled={!browser.page || browser.loading}
                            onClick={() => browser.setPage(v => v - 1)}
                          >
                            {t('Previous')}
                          </Button>
                          <span className="om-muted">{browser.page + 1}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            className="om-button h-auto"
                            disabled={browser.data.nextOffset === null || browser.loading}
                            onClick={() => browser.setPage(v => v + 1)}
                          >
                            {t('Next')}
                          </Button>
                        </div>
                      )}
                    </>
                  ) : hasFilters ? (
                    <div className="om-empty om-sound-state-box">
                      <RemixIcon name="search-line" size={28} />
                      <h2 className="om-subtitle">{t('No matching assets')}</h2>
                      <Button
                        type="button"
                        variant="ghost"
                        className="om-button h-auto"
                        onClick={clearAllFilters}
                      >
                        {t('Clear filters')}
                      </Button>
                    </div>
                  ) : null}
                </section>

                {showStarters && (
                  <section className="om-sound-section om-sound-starters" aria-label={t('Starters')}>
                    {liveTab === 'music' && (
                      <div className="om-sound-track-list" role="list">
                        <div
                          role="listitem"
                          className="om-sound-track-row om-sound-sample-row"
                          data-active={player.track?.id === featuredDemoTrack.id || undefined}
                          data-playing={(player.track?.id === featuredDemoTrack.id && player.playing) || undefined}
                        >
                          <Tooltip label={t(player.track?.id === featuredDemoTrack.id && player.playing ? 'Pause' : 'Play')}>
                            <IconButton
                              type="button"
                              variant="plain"
                              className={player.track?.id === featuredDemoTrack.id && player.playing ? 'om-sound-row-play hf-od-primary' : 'om-sound-row-play'}
                              data-playing={(player.track?.id === featuredDemoTrack.id && player.playing) || undefined}
                              aria-label={t(
                                player.track?.id === featuredDemoTrack.id && player.playing ? 'Pause {name}' : 'Play {name}',
                                { name: t(featuredRecipe.title) },
                              )}
                              onClick={() => player.playTrack(featuredDemoTrack)}
                              icon={<RemixIcon name={player.track?.id === featuredDemoTrack.id && player.playing ? 'pause-fill' : 'play-fill'} size={16} />}
                            />
                          </Tooltip>
                          <div className="om-sound-row-info">
                            <div className="om-sound-row-title-line">
                              <strong className="om-sound-row-title">{t(featuredRecipe.title)}</strong>
                              <span className="om-badge">{t('Sample')}</span>
                            </div>
                            <p className="om-sound-row-desc">{t(featuredRecipe.prompt)}</p>
                          </div>
                          <div className="om-sound-row-wave">
                            <InteractiveWaveform
                              bars={featuredDemoTrack.waveform}
                              progress={
                                player.track?.id === featuredDemoTrack.id && (player.duration || featuredRecipe.durationSeconds || 0) > 0
                                  ? Math.min(1, player.currentTime / (player.duration || featuredRecipe.durationSeconds || 1))
                                  : 0
                              }
                              active={player.track?.id === featuredDemoTrack.id}
                              label={t('Seek {name}', { name: t(featuredRecipe.title) })}
                              onSeek={ratio => player.playTrack(featuredDemoTrack, ratio)}
                            />
                          </div>
                          <span className="om-sound-row-duration">
                            {player.track?.id === featuredDemoTrack.id && player.duration > 0
                              ? `${formatTime(player.currentTime)} / ${formatTime(player.duration)}`
                              : formatTime(featuredRecipe.durationSeconds ?? 37)}
                          </span>
                          <div className="om-sound-row-actions">
                            <Button
                              type="button"
                              variant="plain"
                              className="om-nav-item om-sound-use-btn"
                              onClick={() => applyPromptToComposer(t(featuredRecipe.prompt), t('Prompt loaded into editor'))}
                            >
                              <RemixIcon name="add-line" size={14} />
                              {t('Use')}
                            </Button>
                          </div>
                        </div>

                        {SOUND_MUSIC_RECIPES.slice(1).map(recipe => (
                          <div key={recipe.id} role="listitem" className="om-sound-starter-row">
                            <div className="om-sound-starter-copy">
                              <strong>{t(recipe.title)}</strong>
                              <p className="om-sound-row-desc">{t(recipe.prompt)}</p>
                            </div>
                            <Button
                              type="button"
                              variant="plain"
                              className="om-nav-item om-sound-use-btn"
                              onClick={() => applyPromptToComposer(t(recipe.prompt), t('Prompt loaded into editor'))}
                            >
                              <RemixIcon name="add-line" size={14} />
                              {t('Use')}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {liveTab === 'sfx' && (
                      <div className="om-sound-track-list" role="list">
                        {SOUND_SFX_STARTERS.map(starter => (
                          <div key={starter.id} role="listitem" className="om-sound-starter-row">
                            <div className="om-sound-starter-copy">
                              <div className="om-sound-row-title-line">
                                <strong>{t(starter.title)}</strong>
                                <span className="om-sound-mono-readout">{starter.durationSeconds}s</span>
                                {starter.loop && <span className="om-badge">{t('Loop')}</span>}
                              </div>
                              <p className="om-sound-row-desc">{t(starter.prompt)}</p>
                            </div>
                            <Button
                              type="button"
                              variant="plain"
                              className="om-nav-item om-sound-use-btn"
                              onClick={() => applySfxStarter(starter)}
                            >
                              <RemixIcon name="add-line" size={14} />
                              {t('Use')}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {liveTab === 'speech' && (
                      <div className="om-sound-track-list" role="list">
                        {SOUND_SPEECH_SCRIPTS.map(item => {
                          const localized = t(item.script);
                          const seconds = estimateSpeechSeconds(localized);
                          return (
                            <div key={item.id} role="listitem" className="om-sound-starter-row">
                              <div className="om-sound-starter-copy">
                                <div className="om-sound-row-title-line">
                                  <strong>{t(item.title)}</strong>
                                  <span className="om-sound-mono-readout">~{seconds}s</span>
                                </div>
                                <p className="om-sound-row-desc">{localized}</p>
                              </div>
                              <Button
                                type="button"
                                variant="plain"
                                className="om-nav-item om-sound-use-btn"
                                onClick={() => applyPromptToComposer(localized, t('Script loaded into editor'))}
                              >
                                <RemixIcon name="add-line" size={14} />
                                {t('Use')}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <Button
                      type="button"
                      variant="plain"
                      className="om-sound-drop-cue"
                      disabled={uploading}
                      onClick={onUploadClick}
                    >
                      <RemixIcon name="upload-2-line" size={15} />
                      <span>{t('Drop audio files here')}</span>
                    </Button>
                  </section>
                )}
              </main>
            </>
          )}

          <SoundPlayerDock
            player={player}
            onLocateTrack={locateTrack}
          />
        </section>
      </div>
    </div>
  );
}
