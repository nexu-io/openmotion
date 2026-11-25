import { useEffect, useRef, useState } from 'react';
import { canvasPresets, canvasRatio, canvasFrameTransform, type CanvasRatio, type CanvasFit } from '../../../shared/composition-canvas';
import { useStudioShellContext } from '../contexts/StudioContext';
import { useLivePreviewIframe } from '../player/store/previewIframeStore';
import { useI18n } from '../i18n/I18n';
import { Button } from 'open-design-ui/button';
import { Menu, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../components/ui/Menu';
import { CaretDown } from '../icons/RemixIcons';
import { projectPreviewAdapter } from '../player/lib/projectPreviewAdapter';
import { onPreviewContentReplaced } from '../player/sceneSwap';
import { compositionPathOfPreviewUrl } from '../utils/projectCompositionPath';
import { paintCanvasFraming, type CanvasFramingDraft } from '../../../shared/preview-canvas-framing';
import { editPanelComposition } from './compositionPanelEdits';

type Framing = { ratio: CanvasRatio; fit: CanvasFit };
type FrameRequest = Framing & { id: string; project: string; path: string; saved: boolean };

function present(frame: HTMLIFrameElement | null, project: string, path: string, draft: CanvasFramingDraft) {
  if (!frame) return;
  const adapter = projectPreviewAdapter(frame, project);
  if (adapter) { adapter.send('canvas-framing', { path, draft }); return; }
  const doc = frame.contentDocument;
  if (doc?.URL.includes('/preview') && compositionPathOfPreviewUrl(doc.URL) !== path) return;
  const size = doc && paintCanvasFraming(doc, draft, canvasFrameTransform);
  const host = (frame.getRootNode() as ShadowRoot).host;
  if (size && host?.localName === 'hyperframes-player') {
    host.setAttribute('width', String(size.width));
    host.setAttribute('height', String(size.height));
  }
}

function presentRequest(frame: HTMLIFrameElement | null, request: FrameRequest) {
  const preset = canvasPresets.find(value => value.ratio === request.ratio)!;
  present(frame, request.project, request.path, { ...preset, fit: request.fit, id: request.id });
}
export function PreviewCanvasMenu() {
  const shell = useStudioShellContext(), { t } = useI18n(), iframe = useLivePreviewIframe();
  const { projectId } = shell, path = shell.activeCompPath || 'index.html';
  const dimensions = shell.compositionDimensions;
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState<{ frame: WeakRef<HTMLIFrameElement>; path: string; fit: CanvasFit; ratio: string } | null>(null);
  const [requested, setRequested] = useState<FrameRequest | null>(null);
  const latest = useRef<FrameRequest | null>(null);
  const current = useRef({ projectId, path, iframe }); current.current = { projectId, path, iframe };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (!iframe) return;
    const frameRef = new WeakRef(iframe);
    let sequence = 0;
    async function read(replaced: boolean) {
      const id = ++sequence, request = latest.current;
      const adapter = projectPreviewAdapter(iframe, projectId);
      let root: Element | null = null;
      try { root = iframe!.contentDocument?.querySelector('[data-composition-id]') ?? null; } catch { /* Isolated preview. */ }
      const data = root ? {
        sourceFile: root.ownerDocument.URL.includes('/preview') ? compositionPathOfPreviewUrl(root.ownerDocument.URL) : path,
        fit: root.getAttribute('data-canvas-fit') === 'cover' ? 'cover' as const : 'contain' as const,
        width: Number(root.getAttribute('data-width')), height: Number(root.getAttribute('data-height')),
      } : await adapter?.request<{sourceFile: string; fit: CanvasFit; width?: number; height?: number} | null>('canvas-framing').catch(() => null);
      if (id !== sequence) return;
      if (data?.sourceFile !== path || !['contain', 'cover'].includes(data.fit)) { setMounted(null); return; }
      const width = data.width || dimensions?.width, height = data.height || dimensions?.height;
      if (!width || !height) return;
      const ratio = canvasRatio(width, height);
      setMounted({ frame: frameRef, path, fit: data.fit, ratio });
      if (!request || request !== latest.current || request.project !== projectId || request.path !== path) return;
      if ((ratio === request.ratio && data.fit === request.fit) || (replaced && request.saved)) {
        present(iframe, projectId, path, { id: request.id, clear: true });
        latest.current = null;
        setRequested(null);
      } else if (replaced) presentRequest(iframe, request);
    }
    void read(false);
    const unsubscribe = onPreviewContentReplaced(iframe, () => void read(true));
    return () => { ++sequence; unsubscribe(); };
  }, [iframe, path, projectId, dimensions?.width, dimensions?.height]);
  const shown = mounted?.frame.deref() === iframe && mounted?.path === path ? mounted : null;
  const local = requested?.project === projectId && requested.path === path ? requested : null;
  const ratio = local?.ratio ?? shown?.ratio ?? (dimensions ? canvasRatio(dimensions.width, dimensions.height) : '');
  const fit = local?.fit ?? shown?.fit ?? 'contain';
  const disabled = !shown || Boolean(shell.writeBlockedReason) || shell.renderQueue.isRendering;

  async function change(nextRatio: CanvasRatio, nextFit: CanvasFit) {
    if (disabled) return;
    const request = { id: crypto.randomUUID(), project: projectId, path, ratio: nextRatio, fit: nextFit, saved: false };
    latest.current = request;
    setRequested(request);
    setOpen(false);
    presentRequest(iframe, request);
    try {
      await editPanelComposition(shell, 'Change canvas framing', async html => {
        const { reframeCanvas } = await import('../../../packages/edit-core/reframe-canvas.js');
        return reframeCanvas(html, request).content;
      });
      request.saved = true;
      if (alive.current && latest.current === request && current.current.projectId === projectId && current.current.path === path) {
        shell.showToast(t('Canvas updated'), 'info');
      }
    } catch (error) {
      if (!alive.current) return;
      const sameComposition = current.current.projectId === projectId && current.current.path === path;
      if (latest.current === request) {
        latest.current = null;
        setRequested(null);
        if (sameComposition) present(current.current.iframe, projectId, path, { id: request.id, clear: true });
      }
      if (sameComposition) shell.showToast(t(error instanceof Error ? error.message : 'Canvas update failed'), 'error');
    }
  }
  return <Menu open={open} onOpenChange={setOpen} modal={false} side="bottom" align="end" className="w-28 min-w-0" tooltip={t('Aspect ratio')} aria-label={t('Aspect ratio')} trigger={<Button size="sm" variant="ghost" className="shrink-0 font-normal tabular-nums text-text-0" aria-label={t('Aspect ratio')} disabled={disabled} onPointerDown={event => event.stopPropagation()}>{ratio || '—'}<CaretDown size={12} /></Button>}>
    <div className="om-menu-caption" data-tone="subtle">{t('Aspect ratio')}</div>
    <MenuRadioGroup value={ratio} aria-label={t('Aspect ratio')}>
      {canvasPresets.map(preset => <MenuRadioItem
        key={preset.ratio}
        value={preset.ratio}
        className="gap-2 tabular-nums"
        disabled={disabled}
        onClick={() => void change(preset.ratio, fit)}
      >
        <span className="flex items-center gap-2">
          <span className="w-6">{preset.ratio}</span>
          <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
            <span className="block rounded-[var(--motion-radius-xs)] border border-current" style={{
              width: `${Math.min(1, preset.width / preset.height) * 100}%`,
              aspectRatio: `${preset.width} / ${preset.height}`,
            }} />
          </span>
        </span>
      </MenuRadioItem>)}
    </MenuRadioGroup>
    <MenuSeparator />
    <div className="om-menu-caption" data-tone="subtle">{t('Content fit')}</div>
    <MenuRadioGroup value={fit} aria-label={t('Content fit')}>
      {(['contain', 'cover'] as const).map(value => <MenuRadioItem key={value} value={value} className="gap-2" disabled={disabled || !canvasPresets.some(item => item.ratio === ratio)} onClick={() => void change(ratio as CanvasRatio, value)}>{t(value === 'contain' ? 'Letterbox' : 'Crop')}</MenuRadioItem>)}
    </MenuRadioGroup>
  </Menu>;
}
