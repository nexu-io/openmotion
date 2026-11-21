import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useEffect, useMemo, useRef, useState } from 'react';
import { brandCatalogFile, type BrandCatalogEntry } from '../../../shared/brand-catalog';
import type { BrandKit } from '../../../shared/brand-kit';
import type { WebPageState } from '../../../shared/browser';
import {
  designRoutes,
  designViewports,
  type DesignFile,
  type DesignProjectDetail,
  type DesignViewportId,
} from '../../../shared/design-project';
import {
  artifactCanonicalAddress,
  type SuperAgentArtifact,
  type SuperAgentArtifactKind,
  type SuperAgentResourceAttachment,
} from '../../../shared/super-agent';
import { Skeleton } from '../components/ui/Skeleton';
import { Tooltip } from '../components/ui/Tooltip';
import { CodeViewer } from '../design/CodeViewer';
import { designClient } from '../design/designClient';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { WebBrowser, type WebBrowserHandle } from '../motion/WebBrowser';
import { releaseMediaElement } from '../utils/releaseMediaElement';
import { resourceIcon } from './ResourcePickerDialog';
import { superAgentBrowserEndpoint } from './superAgentClient';

export const NEW_VIEWER_TAB_ID = '__new__';

function artifactTabIcon(kind: SuperAgentArtifactKind): string {
  switch (kind) {
    case 'design-project':
      return 'layout-line';
    case 'motion-project':
      return 'movie-line';
    case 'motion-export':
      return 'clapperboard-line';
    case 'asset-image':
      return 'image-line';
    case 'asset-video':
      return 'film-line';
    case 'asset-audio':
      return 'music-2-line';
    case 'brand-kit':
      return 'palette-line';
    case 'web':
      return 'global-line';
  }
}

function normalizeBrowserAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  if (/^localhost(?::\d+)?(?:\/.*)?$/i.test(trimmed) || /^127\.0\.0\.1(?::\d+)?(?:\/.*)?$/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return null;
}

function searchWebUrl(query: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(query.trim())}`;
}

export function safeBrowserTabId(artifactId: string): string {
  const cleaned = artifactId.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 80);
  return cleaned || 'web-tab';
}

function ManagedMediaElement({ kind, src }: { kind: 'video' | 'audio'; src: string }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    return () => releaseMediaElement(element);
  }, [src, kind]);
  return kind === 'video'
    ? <video ref={ref} controls playsInline src={src} />
    : <audio ref={ref} controls src={src} />;
}

function isInspectableCodeFile(file: DesignFile): boolean {
  return ['html', 'css', 'js', 'json', 'markdown', 'text'].includes(file.kind);
}

function DesignProjectArtifactView({
  artifact,
  mode,
  viewport,
  reloadKey,
}: {
  artifact: SuperAgentArtifact;
  mode: 'preview' | 'code';
  viewport: DesignViewportId;
  reloadKey: number;
}) {
  const { t } = useI18n();
  const projectId = artifact.projectId || '';
  const entry = artifact.entry || 'index.html';
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [project, setProject] = useState<DesignProjectDetail | null>(null);
  const [selectedFile, setSelectedFile] = useState<string>(entry);
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingCode, setLoadingCode] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const previewUrl = useMemo(() => {
    if (!projectId) return '';
    return `${designRoutes.raw(projectId, entry)}?rev=${encodeURIComponent(artifact.revision || String(reloadKey))}&r=${reloadKey}`;
  }, [projectId, entry, artifact.revision, reloadKey]);

  useEffect(() => {
    setFrameLoaded(false);
  }, [previewUrl]);

  useEffect(() => {
    if (mode !== 'code' || !projectId) return;
    let cancelled = false;
    setLoadingCode(true);
    setCodeError(null);
    void designClient
      .getProject(projectId)
      .then(result => {
        if (cancelled) return;
        setProject(result.project);
        const files = result.project.files.filter(isInspectableCodeFile);
        const preferred =
          files.find(item => item.path === selectedFile)?.path
          ?? files.find(item => item.path === result.project.entry)?.path
          ?? files[0]?.path
          ?? '';
        setSelectedFile(preferred);
        if (!preferred) {
          setFileContent('');
          setLoadingCode(false);
        }
      })
      .catch(error => {
        if (!cancelled) {
          setCodeError(error instanceof Error ? error.message : t('Could not load project files'));
          setLoadingCode(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, projectId, reloadKey, t]);

  useEffect(() => {
    if (mode !== 'code' || !projectId || !selectedFile) return;
    let cancelled = false;
    setLoadingCode(true);
    setCodeError(null);
    void designClient
      .readFile(projectId, selectedFile)
      .then(result => {
        if (!cancelled) setFileContent(result.content);
      })
      .catch(error => {
        if (!cancelled) setCodeError(error instanceof Error ? error.message : t('Could not read file'));
      })
      .finally(() => {
        if (!cancelled) setLoadingCode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, projectId, selectedFile, reloadKey, t]);

  if (mode === 'code') {
    const codeFiles = (project?.files ?? []).filter(isInspectableCodeFile);
    return (
      <div className="om-sa-code-view">
        <div className="om-sa-code-files" role="tablist" aria-label={t('Project files')}>
          {codeFiles.map(file => (
            <Button
              key={file.path}
              variant="plain"
              type="button"
              role="tab"
              aria-selected={selectedFile === file.path}
              data-active={selectedFile === file.path || undefined}
              className="om-sa-code-file-btn"
              onClick={() => setSelectedFile(file.path)}
            >
              <RemixIcon name="code-s-slash-line" size={13} />
              <span>{file.path}</span>
            </Button>
          ))}
        </div>
        <div className="om-sa-code-panel">
          {loadingCode ? (
            <div className="om-sa-viewer-loading">
              <Skeleton style={{ width: '60%', height: 18 }} />
              <Skeleton style={{ width: '100%', height: 180 }} />
            </div>
          ) : codeError ? (
            <div className="om-empty om-sa-viewer-empty" role="alert">
              <RemixIcon name="error-warning-line" size={24} />
              <p>{codeError}</p>
            </div>
          ) : (
            <CodeViewer content={fileContent} />
          )}
        </div>
      </div>
    );
  }

  const preset = designViewports.find(item => item.id === viewport) ?? designViewports[0];
  const frameStyle = preset.width && preset.height
    ? { width: preset.width, height: preset.height, maxWidth: '100%', maxHeight: '100%' }
    : undefined;

  return (
    <div className="om-sa-iframe-stage" data-viewport={viewport}>
      <div className="om-sa-iframe-frame" style={frameStyle}>
        {!frameLoaded && (
          <div className="om-sa-frame-skeleton" aria-hidden="true">
            <Skeleton style={{ width: '100%', height: '100%' }} />
          </div>
        )}
        <iframe
          key={`${projectId}:${artifact.revision ?? ''}:${reloadKey}`}
          title={artifact.title}
          src={previewUrl}
          sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
          onLoad={() => setFrameLoaded(true)}
        />
      </div>
    </div>
  );
}

function BrandKitArtifactView({
  artifact,
  reloadKey,
}: {
  artifact: SuperAgentArtifact;
  reloadKey: number;
}) {
  const { t } = useI18n();
  const kitId = artifact.kitId || '';
  const isCatalog = kitId.startsWith('catalog:');
  const catalogId = isCatalog ? kitId.slice('catalog:'.length) : '';
  const [savedKit, setSavedKit] = useState<BrandKit | null>(null);
  const [catalogEntry, setCatalogEntry] = useState<BrandCatalogEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!kitId) {
      setLoading(false);
      setError(t('Brand Kit identity is missing'));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async () => {
      if (isCatalog) {
        const res = await fetch('/motion-api/brand-kits/catalog');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { entries: BrandCatalogEntry[] };
        const found = data.entries.find(item => item.id === catalogId) ?? null;
        if (!found) throw new Error(t('Brand Kit could not be found'));
        if (!cancelled) {
          setCatalogEntry(found);
          setSavedKit(null);
        }
      } else {
        const res = await fetch(`/motion-api/brand-kits/${encodeURIComponent(kitId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { kit: BrandKit };
        if (!cancelled) {
          setSavedKit(data.kit);
          setCatalogEntry(null);
        }
      }
    };
    void load()
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('Could not load Brand Kit'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kitId, isCatalog, catalogId, reloadKey, retryCount, t]);

  if (loading) {
    return (
      <div className="om-sa-viewer-loading">
        <Skeleton style={{ width: '48%', height: 24 }} />
        <Skeleton style={{ width: '100%', height: 220 }} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="om-empty om-sa-viewer-empty" role="alert">
        <RemixIcon name="error-warning-line" size={24} />
        <p>{error}</p>
        <Button variant="ghost" className="om-button h-auto" onClick={() => setRetryCount(v => v + 1)}>
          {t('Retry')}
        </Button>
      </div>
    );
  }

  const title = savedKit ? savedKit.nameOverride || savedKit.name : catalogEntry?.name || artifact.title;
  const subtitle = savedKit
    ? savedKit.websiteUrl || savedKit.url
    : catalogEntry?.description || catalogEntry?.category;
  const sample = savedKit?.sample ?? catalogEntry?.sample;
  const swatches = (sample?.colors?.length ? sample.colors : catalogEntry?.colors ?? []).slice(0, 10);
  const style = sample?.style;

  return (
    <div className="om-sa-brand-view">
      <div className="om-sa-brand-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="om-muted">{subtitle}</p>}
        </div>
        {catalogEntry && (
          <span className="om-badge">{catalogEntry.category}</span>
        )}
      </div>

      {isCatalog ? (
        <div className="om-sa-brand-showcase">
          <iframe
            title={`${title} showcase`}
            src={brandCatalogFile(catalogId, 'showcase')}
            sandbox="allow-scripts"
          />
        </div>
      ) : savedKit?.preview ? (
        <div className="om-sa-brand-showcase">
          <ManagedMediaElement kind="video" src={`/motion-api/brand-kits/${encodeURIComponent(savedKit.id)}/files/preview.mp4`} />
        </div>
      ) : savedKit?.poster ? (
        <div className="om-sa-brand-showcase">
          <img src={`/motion-api/brand-kits/${encodeURIComponent(savedKit.id)}/files/poster.png`} alt={title} />
        </div>
      ) : null}

      {swatches.length > 0 && (
        <section className="om-sa-brand-section">
          <span className="om-eyebrow">{t('Palette')}</span>
          <div className="om-sa-brand-swatches">
            {swatches.map((hex, idx) => (
              <div key={`${hex}-${idx}`} className="om-sa-brand-swatch">
                <span className="om-sa-brand-swatch-chip" style={{ background: hex }} aria-hidden="true" />
                <code>{hex}</code>
              </div>
            ))}
          </div>
        </section>
      )}

      {style && (
        <section className="om-sa-brand-section">
          <span className="om-eyebrow">{t('Typography & surface tokens')}</span>
          <div className="om-sa-brand-tokens">
            <div><small>{t('Heading font')}</small><strong>{style.headingFont}</strong></div>
            <div><small>{t('Body font')}</small><strong>{style.bodyFont}</strong></div>
            <div><small>{t('Radius')}</small><strong>{style.radius}</strong></div>
          </div>
        </section>
      )}
    </div>
  );
}

function ImageArtifactView({ url, title }: { url: string; title: string }) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setZoom(1);
  }, [url]);

  return (
    <div className="om-sa-media-stage" data-kind="image">
      <div className="om-sa-zoom-bar">
        <IconButton
          variant="ghost"
          className="motion-icon-button"
          aria-label={t('Zoom out')}
          disabled={zoom <= 0.25}
          onClick={() => setZoom(v => Math.max(0.25, Number((v - 0.25).toFixed(2))))}
          icon={<RemixIcon name="zoom-out-line" size={15} />}
        />
        <Button
          variant="plain"
          type="button"
          className="om-sa-zoom-readout"
          onClick={() => setZoom(1)}
          title={t('Reset zoom')}
        >
          {Math.round(zoom * 100)}%
        </Button>
        <IconButton
          variant="ghost"
          className="motion-icon-button"
          aria-label={t('Zoom in')}
          disabled={zoom >= 3}
          onClick={() => setZoom(v => Math.min(3, Number((v + 0.25).toFixed(2))))}
          icon={<RemixIcon name="zoom-in-line" size={15} />}
        />
      </div>

      <div className="om-sa-image-checkerboard">
        {failed ? (
          <div className="om-empty om-sa-viewer-empty" role="alert">
            <RemixIcon name="error-warning-line" size={24} />
            <p>{t('Could not load image preview')}</p>
            <Button variant="ghost" className="om-button h-auto" onClick={() => setFailed(false)}>
              {t('Retry')}
            </Button>
          </div>
        ) : (
          <img
            src={url}
            alt={title}
            style={{ transform: `scale(${zoom})` }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}

export function ArtifactBrowserPane({
  active = true,
  chatId,
  artifacts,
  openTabIds,
  activeTabId,
  expanded,
  workspaceItems,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onOpenWebUrl,
  onOpenArtifact,
  onOpenResource,
  onToggleExpand,
  onClosePane,
  onAttachArtifact,
  onOpenInDesignStudio,
  onOpenInMotionStudio,
  onOpenInAssets,
  onOpenInBrandKit,
}: {
  active?: boolean;
  chatId: string | null;
  artifacts: SuperAgentArtifact[];
  openTabIds: string[];
  activeTabId: string;
  expanded: boolean;
  workspaceItems: SuperAgentResourceAttachment[];
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  onOpenWebUrl: (url: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onOpenResource: (item: SuperAgentResourceAttachment) => void;
  onToggleExpand: () => void;
  onClosePane: () => void;
  onAttachArtifact: (artifact: SuperAgentArtifact) => void;
  onOpenInDesignStudio: (projectId: string) => void;
  onOpenInMotionStudio: (projectId: string) => void;
  onOpenInAssets: (assetId: string, versionId?: string) => void;
  onOpenInBrandKit: (kitId?: string) => void;
}) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [viewport, setViewport] = useState<DesignViewportId>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const [webState, setWebState] = useState<WebPageState | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const [addressEditing, setAddressEditing] = useState(false);
  const [newTabQuery, setNewTabQuery] = useState('');
  const [newTabFilter, setNewTabFilter] = useState<'all' | 'web-apps' | 'motion' | 'media' | 'brand-kit' | 'browser'>('all');
  const [pendingWebUrl, setPendingWebUrl] = useState<string | null>(null);
  const webRef = useRef<WebBrowserHandle>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const newTabInputRef = useRef<HTMLInputElement>(null);

  const openTabs = useMemo(() => {
    const byId = new Map(artifacts.map(item => [item.id, item]));
    return openTabIds
      .map(id => byId.get(id))
      .filter((item): item is SuperAgentArtifact => Boolean(item));
  }, [artifacts, openTabIds]);

  const showNewTab = activeTabId === NEW_VIEWER_TAB_ID || !openTabs.length;
  const activeArtifact = showNewTab
    ? null
    : openTabs.find(item => item.id === activeTabId) ?? openTabs.at(-1) ?? null;

  useEffect(() => {
    setWebState(null);
    setAddressEditing(false);
    setPendingWebUrl(null);
    if (!activeArtifact) {
      setAddressDraft('');
      return;
    }
    setAddressDraft(artifactCanonicalAddress(activeArtifact));
    if (activeArtifact.kind === 'design-project') {
      setViewMode('preview');
      if (activeArtifact.scenario === 'mobile-app') setViewport('mobile');
      else setViewport('desktop');
    }
  }, [activeArtifact?.id]);

  useEffect(() => {
    if (!pendingWebUrl) return;
    const timer = setTimeout(() => setPendingWebUrl(null), 10_000);
    return () => clearTimeout(timer);
  }, [pendingWebUrl]);

  const navigateWeb = (targetUrl: string) => {
    setPendingWebUrl(targetUrl);
    setAddressDraft(targetUrl);
    onOpenWebUrl(targetUrl);
  };

  const webLoading = Boolean(pendingWebUrl) || Boolean(activeArtifact?.kind === 'web' && webState?.loading);

  useEffect(() => {
    if (activeArtifact?.kind === 'web' && webState?.url && !addressEditing) {
      setAddressDraft(webState.url);
    }
  }, [activeArtifact?.kind, webState?.url, addressEditing]);

  const handleBack = () => {
    if (activeArtifact?.kind === 'web') void webRef.current?.command('back');
  };
  const handleForward = () => {
    if (activeArtifact?.kind === 'web') void webRef.current?.command('forward');
  };
  const handleReload = () => {
    if (activeArtifact?.kind === 'web') void webRef.current?.command('reload');
    else setReloadKey(v => v + 1);
  };

  const quickOpenItems = useMemo(
    () =>
      workspaceItems
        .filter(item => ['design-project', 'motion-project', 'asset', 'brand-kit'].includes(item.kind)),
    [workspaceItems],
  );

  const normalizedNewTabQuery = newTabQuery.trim().toLowerCase();

  const matchesFilterArtifact = (item: SuperAgentArtifact) => {
    if (newTabFilter === 'web-apps' && item.kind !== 'design-project') return false;
    if (newTabFilter === 'motion' && item.kind !== 'motion-project' && item.kind !== 'motion-export') return false;
    if (newTabFilter === 'media' && !['asset-image', 'asset-video', 'asset-audio'].includes(item.kind)) return false;
    if (newTabFilter === 'brand-kit' && item.kind !== 'brand-kit') return false;
    if (newTabFilter === 'browser' && item.kind !== 'web') return false;
    if (!normalizedNewTabQuery) return true;
    return `${item.title} ${item.subtitle ?? ''} ${item.url ?? ''}`.toLowerCase().includes(normalizedNewTabQuery);
  };

  const matchesFilterResource = (item: SuperAgentResourceAttachment) => {
    if (newTabFilter === 'web-apps' && item.kind !== 'design-project') return false;
    if (newTabFilter === 'motion' && item.kind !== 'motion-project') return false;
    if (newTabFilter === 'media' && item.kind !== 'asset') return false;
    if (newTabFilter === 'brand-kit' && item.kind !== 'brand-kit') return false;
    if (newTabFilter === 'browser') return false;
    if (!normalizedNewTabQuery) return true;
    return `${item.title} ${item.subtitle ?? ''} ${item.kind}`.toLowerCase().includes(normalizedNewTabQuery);
  };

  const filteredArtifacts = useMemo(
    () => artifacts.filter(matchesFilterArtifact),
    [artifacts, newTabFilter, normalizedNewTabQuery],
  );

  const filteredQuickOpen = useMemo(
    () => quickOpenItems.filter(matchesFilterResource).slice(0, 12),
    [quickOpenItems, newTabFilter, normalizedNewTabQuery],
  );

  const shortcutTypes: {
    id: 'all' | 'web-apps' | 'motion' | 'media' | 'brand-kit' | 'browser';
    label: string;
    icon: string;
    tone: 'image' | 'audio' | 'video' | 'agent';
  }[] = [
    { id: 'all', label: 'All resources', icon: 'apps-2-line', tone: 'agent' },
    { id: 'web-apps', label: 'Web & Games', icon: 'layout-line', tone: 'agent' },
    { id: 'motion', label: 'Motion', icon: 'movie-line', tone: 'video' },
    { id: 'media', label: 'Media', icon: 'image-line', tone: 'image' },
    { id: 'brand-kit', label: 'Brand Kits', icon: 'palette-line', tone: 'audio' },
    { id: 'browser', label: 'Browser', icon: 'global-line', tone: 'video' },
  ];

  const externalHref = activeArtifact
    ? activeArtifact.kind === 'design-project' && activeArtifact.projectId
      ? designRoutes.raw(activeArtifact.projectId, activeArtifact.entry || 'index.html')
      : activeArtifact.kind === 'web'
        ? activeArtifact.url
        : undefined
    : undefined;

  const downloadHref = activeArtifact?.downloadUrl
    ?? (activeArtifact && ['asset-image', 'asset-video', 'asset-audio'].includes(activeArtifact.kind) && activeArtifact.url
      ? `${activeArtifact.url}?download=1`
      : undefined);

  return (
    <aside className="om-sa-viewer" aria-label={t('Artifact Viewer')}>
      <div className="om-sa-viewer-tabs-bar">
        <div className="om-sa-viewer-tabs" role="tablist" aria-label={t('Viewer tabs')}>
          {openTabs.map(tab => {
            const isActive = !showNewTab && activeArtifact?.id === tab.id;
            return (
              <div key={tab.id} className="om-sa-viewer-tab" data-active={isActive || undefined}>
                <Button
                  variant="plain"
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className="om-sa-viewer-tab-btn"
                  onClick={() => onSelectTab(tab.id)}
                >
                  <RemixIcon name={artifactTabIcon(tab.kind)} size={13} />
                  <span>{tab.title}</span>
                </Button>
                <IconButton
                  variant="plain"
                  className="om-sa-viewer-tab-close"
                  aria-label={t('Close tab')}
                  onClick={() => onCloseTab(tab.id)}
                  icon={<RemixIcon name="close-line" size={12} />}
                />
              </div>
            );
          })}
          {showNewTab && (
            <div className="om-sa-viewer-tab" data-active>
              <Button
                variant="plain"
                type="button"
                role="tab"
                aria-selected
                className="om-sa-viewer-tab-btn"
                onClick={onNewTab}
              >
                <RemixIcon name="global-line" size={13} />
                <span>{t('New tab')}</span>
              </Button>
            </div>
          )}
          <Tooltip label={t('New tab')}>
            <IconButton
              variant="plain"
              className="om-sa-new-tab-btn"
              aria-label={t('New tab')}
              disabled={showNewTab}
              onClick={event => {
                event.currentTarget.blur();
                setPendingWebUrl(null);
                onNewTab();
                requestAnimationFrame(() => newTabInputRef.current?.focus());
              }}
              icon={<RemixIcon name="add-line" size={15} />}
            />
          </Tooltip>
        </div>

        <div className="om-sa-viewer-win-actions">
          <Tooltip label={t(expanded ? 'Restore viewer' : 'Expand viewer')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t(expanded ? 'Restore viewer' : 'Expand viewer')}
              onClick={onToggleExpand}
              icon={<RemixIcon name={expanded ? 'fullscreen-exit-line' : 'fullscreen-line'} size={15} />}
            />
          </Tooltip>
          <Tooltip label={t('Close viewer')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t('Close viewer')}
              onClick={onClosePane}
              icon={<RemixIcon name="close-line" size={16} />}
            />
          </Tooltip>
        </div>
      </div>

      <div className="om-sa-viewer-toolbar">
        <div className="om-sa-nav-btns">
          <Tooltip label={t('Back')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t('Back')}
              disabled={activeArtifact?.kind !== 'web' || !webState?.canGoBack}
              onClick={handleBack}
              icon={<RemixIcon name="arrow-left-line" size={15} />}
            />
          </Tooltip>
          <Tooltip label={t('Forward')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t('Forward')}
              disabled={activeArtifact?.kind !== 'web' || !webState?.canGoForward}
              onClick={handleForward}
              icon={<RemixIcon name="arrow-right-line" size={15} />}
            />
          </Tooltip>
          <Tooltip label={t('Reload')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t('Reload')}
              disabled={!activeArtifact}
              onClick={handleReload}
              icon={<RemixIcon name="refresh-line" size={15} />}
            />
          </Tooltip>
        </div>

        <div className="om-sa-address-wrap">
          <form
            className="om-sa-address-form"
            onSubmit={event => {
              event.preventDefault();
              const trimmed = addressDraft.trim();
              if (!trimmed || /^(?:design|motion|export|asset|brand):\/\//i.test(trimmed)) return;
              const normalized = normalizeBrowserAddress(trimmed);
              setAddressEditing(false);
              addressInputRef.current?.blur();
              navigateWeb(normalized ?? searchWebUrl(trimmed));
            }}
          >
            <RemixIcon name={activeArtifact ? artifactTabIcon(activeArtifact.kind) : 'search-line'} size={14} />
            <input
              ref={addressInputRef}
              value={addressDraft}
              placeholder={t('Search web, artifacts, or enter a URL')}
              aria-label={t('Artifact address bar')}
              onFocus={event => {
                setAddressEditing(true);
                event.currentTarget.select();
              }}
              onBlur={() => setAddressEditing(false)}
              onChange={event => setAddressDraft(event.target.value)}
            />
          </form>

          {addressEditing && addressDraft.trim() && !/^(?:design|motion|export|asset|brand):\/\//i.test(addressDraft.trim()) && (() => {
            const trimmed = addressDraft.trim();
            const normalized = normalizeBrowserAddress(trimmed);
            const q = trimmed.toLowerCase();
            const matchedResources = quickOpenItems
              .filter(item => `${item.title} ${item.subtitle ?? ''}`.toLowerCase().includes(q))
              .slice(0, 3);
            return (
              <div className="om-sa-address-suggest" role="listbox" aria-label={t('Suggestions')}>
                {normalized ? (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-suggest-row"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setAddressEditing(false);
                      addressInputRef.current?.blur();
                      navigateWeb(normalized);
                    }}
                  >
                    <RemixIcon name="global-line" size={15} />
                    <span className="om-sa-suggest-query">{normalized}</span>
                    <small>{t('Open URL')}</small>
                  </Button>
                ) : (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-suggest-row"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setAddressEditing(false);
                      addressInputRef.current?.blur();
                      navigateWeb(searchWebUrl(trimmed));
                    }}
                  >
                    <RemixIcon name="search-line" size={15} />
                    <span className="om-sa-suggest-query">{trimmed}</span>
                    <small>{t('Search the web')}</small>
                  </Button>
                )}
                {matchedResources.map(item => (
                  <Button
                    key={`suggest:${item.kind}:${item.id}`}
                    variant="plain"
                    type="button"
                    className="om-sa-suggest-row"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setAddressEditing(false);
                      addressInputRef.current?.blur();
                      onOpenResource(item);
                    }}
                  >
                    <RemixIcon name={resourceIcon(item)} size={15} />
                    <span className="om-sa-suggest-query">{item.title}</span>
                    <small>{item.subtitle || item.kind}</small>
                  </Button>
                ))}
              </div>
            );
          })()}
        </div>

        <div className="om-sa-context-actions">
          {activeArtifact?.kind === 'design-project' && (
            <>
              <div className="om-sa-segmented" role="group" aria-label={t('View mode')}>
                <Button
                  variant="plain"
                  type="button"
                  data-active={viewMode === 'preview' || undefined}
                  onClick={() => setViewMode('preview')}
                >
                  <RemixIcon name="eye-line" size={14} />
                  <span>{t('Preview')}</span>
                </Button>
                <Button
                  variant="plain"
                  type="button"
                  data-active={viewMode === 'code' || undefined}
                  onClick={() => setViewMode('code')}
                >
                  <RemixIcon name="code-s-slash-line" size={14} />
                  <span>{t('Code')}</span>
                </Button>
              </div>
              {viewMode === 'preview' && (
                <div className="om-sa-segmented" role="group" aria-label={t('Viewport presets')}>
                  {designViewports.map(preset => (
                    <Tooltip key={preset.id} label={t(preset.label)}>
                      <IconButton
                        variant="plain"
                        className="om-sa-seg-icon"
                        data-active={viewport === preset.id || undefined}
                        aria-label={t(preset.label)}
                        onClick={() => setViewport(preset.id)}
                        icon={<RemixIcon name={preset.icon} size={14} />}
                      />
                    </Tooltip>
                  ))}
                </div>
              )}
              {activeArtifact.projectId && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-toolbar-btn"
                  onClick={() => onOpenInDesignStudio(activeArtifact.projectId!)}
                >
                  <RemixIcon name="layout-line" size={14} />
                  <span>{t('Open in Design Studio')}</span>
                </Button>
              )}
            </>
          )}

          {activeArtifact?.kind === 'motion-project' && activeArtifact.projectId && (
            <Button
              variant="plain"
              type="button"
              className="om-sa-toolbar-btn"
              onClick={() => onOpenInMotionStudio(activeArtifact.projectId!)}
            >
              <RemixIcon name="movie-line" size={14} />
              <span>{t('Open in Motion Studio')}</span>
            </Button>
          )}

          {activeArtifact && ['asset-image', 'asset-video', 'asset-audio'].includes(activeArtifact.kind) && (
            <>
              <Button
                variant="plain"
                type="button"
                className="om-sa-toolbar-btn"
                onClick={() => onAttachArtifact(activeArtifact)}
              >
                <RemixIcon name="add-line" size={14} />
                <span>{t('Attach to Chat')}</span>
              </Button>
              {activeArtifact.assetId && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-toolbar-btn"
                  onClick={() => onOpenInAssets(activeArtifact.assetId!, activeArtifact.versionId)}
                >
                  <RemixIcon name="folder-open-line" size={14} />
                  <span>{t('Open in Assets')}</span>
                </Button>
              )}
            </>
          )}

          {activeArtifact?.kind === 'brand-kit' && (
            <>
              <Button
                variant="plain"
                type="button"
                className="om-sa-toolbar-btn"
                onClick={() => onAttachArtifact(activeArtifact)}
              >
                <RemixIcon name="add-line" size={14} />
                <span>{t('Attach to Chat')}</span>
              </Button>
              <Button
                variant="plain"
                type="button"
                className="om-sa-toolbar-btn"
                onClick={() => onOpenInBrandKit(activeArtifact.kitId)}
              >
                <RemixIcon name="palette-line" size={14} />
                <span>{t('Open in Brand Kit')}</span>
              </Button>
            </>
          )}

          {downloadHref && (
            <Tooltip label={t('Download')}>
              <a href={downloadHref} download className="om-sa-toolbar-btn" aria-label={t('Download')}>
                <RemixIcon name="download-2-line" size={15} />
              </a>
            </Tooltip>
          )}

          {externalHref && (
            <Tooltip label={t('Open in external browser')}>
              <a
                href={externalHref}
                target="_blank"
                rel="noopener noreferrer"
                className="om-sa-toolbar-btn"
                aria-label={t('Open in external browser')}
              >
                <RemixIcon name="external-link-line" size={15} />
              </a>
            </Tooltip>
          )}
        </div>
        {webLoading && <div className="om-sa-viewer-progress" role="progressbar" aria-label={t('Loading…')} />}
      </div>

      <div className="om-sa-viewer-stage">
        {pendingWebUrl && (showNewTab || !activeArtifact) ? (
          <div className="om-sa-web-skeleton om-sa-web-skeleton-enter" role="status" aria-label={t('Loading…')}>
            <div className="om-sa-web-skeleton-head">
              <Skeleton style={{ width: 120, height: 18 }} />
              <Skeleton style={{ width: '42%', height: 28, borderRadius: 999 }} />
            </div>
            <Skeleton style={{ width: '100%', height: 180, borderRadius: 12 }} />
            <div className="om-sa-web-skeleton-grid">
              <Skeleton style={{ width: '100%', height: 96, borderRadius: 10 }} />
              <Skeleton style={{ width: '100%', height: 96, borderRadius: 10 }} />
            </div>
            <div className="om-sa-web-skeleton-lines">
              <Skeleton style={{ width: '68%', height: 14 }} />
              <Skeleton style={{ width: '88%', height: 14 }} />
              <Skeleton style={{ width: '54%', height: 14 }} />
            </div>
          </div>
        ) : showNewTab || !activeArtifact ? (
          <div className="om-sa-newtab">
            <div className="om-sa-newtab-hero">
              <form
                className="om-sa-newtab-search"
                onSubmit={event => {
                  event.preventDefault();
                  const trimmed = newTabQuery.trim();
                  if (!trimmed) return;
                  const normalized = normalizeBrowserAddress(trimmed);
                  setNewTabQuery('');
                  navigateWeb(normalized ?? searchWebUrl(trimmed));
                }}
              >
                <RemixIcon name="search-line" size={16} />
                <input
                  ref={newTabInputRef}
                  value={newTabQuery}
                  onChange={event => setNewTabQuery(event.target.value)}
                  placeholder={t('Search web, artifacts, or enter a URL')}
                  aria-label={t('Search web, artifacts, or enter a URL')}
                />
              </form>

              {newTabQuery.trim() && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-newtab-web-cta"
                  onClick={() => {
                    const trimmed = newTabQuery.trim();
                    const normalized = normalizeBrowserAddress(trimmed);
                    setNewTabQuery('');
                    navigateWeb(normalized ?? searchWebUrl(trimmed));
                  }}
                >
                  <RemixIcon name={normalizeBrowserAddress(newTabQuery) ? 'global-line' : 'search-line'} size={15} />
                  <span>{normalizeBrowserAddress(newTabQuery) ?? newTabQuery.trim()}</span>
                  <small>{t(normalizeBrowserAddress(newTabQuery) ? 'Open URL' : 'Search the web')}</small>
                </Button>
              )}

              <div className="om-sa-newtab-shortcuts" role="group" aria-label={t('Artifact types')}>
                {shortcutTypes.map(item => {
                  const isSelected = newTabFilter === item.id;
                  return (
                    <Button
                      key={item.id}
                      variant="plain"
                      type="button"
                      className="om-sa-shortcut-item"
                      aria-pressed={isSelected}
                      data-active={isSelected || undefined}
                      onClick={() => {
                        setNewTabFilter(item.id);
                        if (item.id === 'browser') {
                          addressInputRef.current?.focus();
                        }
                      }}
                    >
                      <span className="om-sa-shortcut-icon" data-tone={item.tone}>
                        <RemixIcon name={item.icon} size={18} />
                      </span>
                      <span className="om-sa-shortcut-label">{t(item.label)}</span>
                    </Button>
                  );
                })}
              </div>
            </div>

            {filteredArtifacts.length > 0 && (
              <section className="om-sa-newtab-section">
                <span className="om-eyebrow">{t('Session artifacts')}</span>
                <div className="om-sa-newtab-grid">
                  {filteredArtifacts.map(item => (
                    <Button
                      key={item.id}
                      variant="plain"
                      type="button"
                      className="om-sa-newtab-card"
                      onClick={() => onOpenArtifact(item.id)}
                    >
                      <RemixIcon name={artifactTabIcon(item.kind)} size={16} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.subtitle || artifactCanonicalAddress(item)}</small>
                      </span>
                    </Button>
                  ))}
                </div>
              </section>
            )}

            {filteredQuickOpen.length > 0 && (
              <section className="om-sa-newtab-section">
                <span className="om-eyebrow">{t('Workspace quick-open')}</span>
                <div className="om-sa-newtab-grid">
                  {filteredQuickOpen.map(item => (
                    <Button
                      key={`${item.kind}:${item.id}`}
                      variant="plain"
                      type="button"
                      className="om-sa-newtab-card"
                      onClick={() => onOpenResource(item)}
                    >
                      <RemixIcon name={resourceIcon(item)} size={16} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.subtitle || item.kind}</small>
                      </span>
                    </Button>
                  ))}
                </div>
              </section>
            )}

            {!filteredArtifacts.length && !filteredQuickOpen.length && (
              <p className="om-sa-newtab-hint">
                {t(newTabFilter === 'browser'
                  ? 'Enter any https:// URL in the address bar above to browse interactively.'
                  : 'Preview generated HTML games, websites, Motion films, videos, images, Brand Kits, or enter any https:// URL above.')}
              </p>
            )}
          </div>
        ) : !active ? (
          <div className="om-sa-viewer-loading" aria-hidden="true">
            <Skeleton style={{ width: '48%', height: 24 }} />
            <Skeleton style={{ width: '100%', height: 220 }} />
          </div>
        ) : activeArtifact.kind === 'design-project' ? (
          <DesignProjectArtifactView
            artifact={activeArtifact}
            mode={viewMode}
            viewport={viewport}
            reloadKey={reloadKey}
          />
        ) : activeArtifact.kind === 'motion-project' && activeArtifact.projectId ? (
          <div className="om-sa-iframe-stage" data-viewport="desktop">
            <div className="om-sa-iframe-frame">
              <iframe
                key={`${activeArtifact.projectId}:${activeArtifact.revision ?? ''}:${reloadKey}`}
                title={activeArtifact.title}
                src={`/?${activeArtifact.sessionId ? `session=${encodeURIComponent(activeArtifact.sessionId)}&` : ''}project=${encodeURIComponent(activeArtifact.projectId)}&embed=1&hostChrome=1#project/${encodeURIComponent(activeArtifact.projectId)}`}
              />
            </div>
          </div>
        ) : activeArtifact.kind === 'motion-export' && activeArtifact.downloadUrl ? (
          <div className="om-sa-media-stage" data-kind="video">
            <ManagedMediaElement kind="video" src={activeArtifact.downloadUrl} />
          </div>
        ) : activeArtifact.kind === 'asset-image' && activeArtifact.url ? (
          <ImageArtifactView url={activeArtifact.url} title={activeArtifact.title} />
        ) : activeArtifact.kind === 'asset-video' && activeArtifact.url ? (
          <div className="om-sa-media-stage" data-kind="video">
            <ManagedMediaElement kind="video" src={activeArtifact.url} />
          </div>
        ) : activeArtifact.kind === 'asset-audio' && activeArtifact.url ? (
          <div className="om-sa-media-stage" data-kind="audio">
            <span className="om-creation-icon" data-tone="audio">
              <RemixIcon name="music-2-line" size={26} />
            </span>
            <strong>{activeArtifact.title}</strong>
            <ManagedMediaElement kind="audio" src={activeArtifact.url} />
          </div>
        ) : activeArtifact.kind === 'brand-kit' ? (
          <BrandKitArtifactView artifact={activeArtifact} reloadKey={reloadKey} />
        ) : activeArtifact.kind === 'web' && activeArtifact.url && chatId ? (
          <div className="om-sa-web-stage">
            <WebBrowser
              ref={webRef}
              sessionId={chatId}
              tabId={safeBrowserTabId(activeArtifact.id)}
              endpoint={superAgentBrowserEndpoint(chatId, safeBrowserTabId(activeArtifact.id))}
              url={activeArtifact.url}
              onState={setWebState}
            />
          </div>
        ) : (
          <div className="om-empty om-sa-viewer-empty">
            <RemixIcon name="global-line" size={24} />
            <p>{t('Start or open a conversation to browse live web pages here.')}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
