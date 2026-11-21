import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Skeleton } from '../components/ui/Skeleton';
import { CoverPlaceholder } from '../components/ui/CoverPlaceholder';

const VIRTUAL_WIDTH = 960;
const VIRTUAL_HEIGHT = 600;
export const MAX_ACTIVE_THUMBS = 8;

type SlotEntry = {
  hovered: boolean;
  onEvict: () => void;
};

const activeThumbSlots = new Map<string, SlotEntry>();

function disposeIframeResources(iframe: HTMLIFrameElement | null): void {
  if (!iframe) return;
  try {
    iframe.contentWindow?.postMessage({ type: 'om:thumb-dispose' }, '*');
  } catch {
    /* ignore sandboxed or already-detached frames */
  }
}

function acquireThumbSlot(id: string, hovered: boolean, onEvict: () => void): boolean {
  if (activeThumbSlots.has(id)) {
    const existing = activeThumbSlots.get(id)!;
    existing.hovered = hovered;
    existing.onEvict = onEvict;
    return true;
  }
  while (activeThumbSlots.size >= MAX_ACTIVE_THUMBS) {
    let victimKey: string | null = null;
    for (const [key, entry] of activeThumbSlots) {
      if (!entry.hovered) {
        victimKey = key;
        break;
      }
    }
    if (victimKey === null) {
      victimKey = activeThumbSlots.keys().next().value ?? null;
    }
    if (victimKey === null) break;
    const victim = activeThumbSlots.get(victimKey);
    activeThumbSlots.delete(victimKey);
    victim?.onEvict();
  }
  activeThumbSlots.set(id, { hovered, onEvict });
  return true;
}

function releaseThumbSlot(id: string): void {
  activeThumbSlots.delete(id);
}

function updateThumbSlotHover(id: string, hovered: boolean): void {
  const entry = activeThumbSlots.get(id);
  if (!entry) return;
  entry.hovered = hovered;
  // Promote hovered entries toward the tail so FIFO eviction targets older idle cards first.
  if (hovered) {
    activeThumbSlots.delete(id);
    activeThumbSlots.set(id, entry);
  }
}

function withThumbParam(src: string): string {
  if (!src.startsWith('/motion-api/design/')) return src;
  return src.includes('?') ? `${src}&thumb=1` : `${src}?thumb=1`;
}

/**
 * Viewport-aware, edge-to-edge scaled sandboxed iframe thumbnail for Design Studio templates and projects.
 * - Unmounts off-screen, hidden-tab, or inactive-page iframes so WebGL/rAF contexts are freed immediately.
 * - Appends ?thumb=1 so heavy WebGL/rAF animations paint their initial frame and freeze at 0% GPU until hovered.
 * - Caps simultaneous mounted iframes across the workspace to MAX_ACTIVE_THUMBS so GPU/WebGL contexts cannot exhaust.
 */
export function ScaledPreviewThumb({
  src,
  title,
  badge,
  brandedFallback = false,
  active = true,
}: {
  src: string;
  title: string;
  badge?: string;
  brandedFallback?: boolean;
  active?: boolean;
}) {
  const instanceId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hoveredRef = useRef(false);
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  );
  const [visible, setVisible] = useState(false);
  const [slotGranted, setSlotGranted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [scale, setScale] = useState(0.32);

  const waitForReady = brandedFallback && src?.startsWith('/motion-api/design/catalog/templates/');
  const thumbSrc = useMemo(
    () => (src ? withThumbParam(src) + (waitForReady ? '&thumbReady=1' : '') : ''),
    [src, waitForReady],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setScale(width / VIRTUAL_WIDTH);
    };
    update();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(el);
    }
    if (!active || !pageVisible) {
      setVisible(false);
      setLoaded(false);
      return () => { ro?.disconnect(); };
    }
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return () => { ro?.disconnect(); };
    }
    const io = new IntersectionObserver(entries => {
      const inView = entries.some(e => e.isIntersecting);
      setVisible(inView);
      if (!inView) setLoaded(false);
    }, { rootMargin: '40px' });
    io.observe(el);
    return () => {
      io.disconnect();
      ro?.disconnect();
    };
  }, [active, pageVisible]);

  const wantMount = Boolean(active && pageVisible && visible && thumbSrc);

  const evictSelf = useCallback(() => {
    disposeIframeResources(iframeRef.current);
    setSlotGranted(false);
    setLoaded(false);
  }, []);

  useEffect(() => {
    if (!wantMount) {
      releaseThumbSlot(instanceId);
      setSlotGranted(false);
      setLoaded(false);
      return;
    }
    const granted = acquireThumbSlot(instanceId, hoveredRef.current, evictSelf);
    setSlotGranted(granted);
    return () => {
      releaseThumbSlot(instanceId);
    };
  }, [wantMount, instanceId, evictSelf]);

  const shouldMount = wantMount && slotGranted;

  useEffect(() => {
    if (!shouldMount) return;
    const iframe = iframeRef.current;
    return () => disposeIframeResources(iframe);
  }, [shouldMount, thumbSrc]);

  useEffect(() => {
    if (!shouldMount || !waitForReady) return;
    const receiveReady = (event: MessageEvent) => {
      if (event.source === iframeRef.current?.contentWindow && event.data?.type === 'om:thumb-ready') setLoaded(true);
    };
    window.addEventListener('message', receiveReady);
    return () => window.removeEventListener('message', receiveReady);
  }, [shouldMount, waitForReady]);

  const setPlaying = (play: boolean) => {
    hoveredRef.current = play;
    if (play && wantMount && !slotGranted) {
      if (acquireThumbSlot(instanceId, true, evictSelf)) {
        setSlotGranted(true);
      }
      return;
    }
    updateThumbSlotHover(instanceId, play);
    try {
      iframeRef.current?.contentWindow?.postMessage({ type: 'om:thumb-play', play }, '*');
    } catch { /* ignore */ }
  };

  const handleIframeLoad = () => {
    if (!waitForReady) setLoaded(true);
    if (hoveredRef.current) {
      try {
        iframeRef.current?.contentWindow?.postMessage({ type: 'om:thumb-play', play: true }, '*');
      } catch { /* ignore */ }
    }
  };

  return (
    <div
      ref={hostRef}
      className="om-design-card-thumb"
      data-loaded={loaded}
      onMouseEnter={() => setPlaying(true)}
      onMouseLeave={() => setPlaying(false)}
    >
      {!loaded && (brandedFallback ? <CoverPlaceholder fill /> : <Skeleton className="om-design-thumb-skeleton" />)}
      {shouldMount && (
        <iframe
          ref={iframeRef}
          title={title}
          src={thumbSrc}
          loading="lazy"
          sandbox="allow-scripts"
          tabIndex={-1}
          onLoad={handleIframeLoad}
          style={{
            width: VIRTUAL_WIDTH,
            height: VIRTUAL_HEIGHT,
            transform: `scale(${scale})`,
            opacity: loaded ? 1 : 0,
          }}
        />
      )}
      {badge && <span className="om-design-thumb-badge">{badge}</span>}
    </div>
  );
}
