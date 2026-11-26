import { Button } from 'open-design-ui/button';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useI18n } from '../i18n/I18n';
import { motionStudio, type StudioDestination } from './creativeStudios';
import { gemini4Spotlight as geminiHub } from './gemini4Spotlight';
import { motionStudioCover } from './skillCatalog';
import { destinationTarget, reportCreativeClick } from './exploreTracking';
import seedanceHeroPoster from './model-hubs/seedance-2-5/hero.webp?no-inline';
import gptImageHeroPoster from './model-hubs/gpt-image-2-6/hero.webp?no-inline';
import blackFridayHeroPoster from './scene-art/black-friday-spotlight.webp?no-inline';

const track = (element: Parameters<typeof reportCreativeClick>[2], target: Parameters<typeof reportCreativeClick>[3]) => reportCreativeClick('explore', 'explore_spotlight', element, target);

const motionPoster = motionStudioCover?.poster ?? '';
const motionClip = motionStudioCover?.video;

interface FeaturedSlide {
  id: string;
  title: string;

  badge?: string;

  badgeTone?: 'top' | 'promo' | 'neutral';
  tagline: string;

  icon: string;
  poster: string;
  clip?: string;
  credit?: string;
  scene?: { target: StudioDestination; prompt: string };
  /** Opens a model hub page instead of a studio. */
  hub?: string;
}

const SEEDANCE_HUB_ID = 'seedance-2-5';
const GPT_IMAGE_HUB_ID = 'gpt-image-2-6';

const slides: FeaturedSlide[] = [{
  id: GPT_IMAGE_HUB_ID,
  title: 'GPT Image 2.0',
  badge: '7 Days Unlimited',

  badgeTone: 'promo',
  tagline: 'Annual Pro & Max · Includes Seedream 5.5 / 5.0 & Nano Banana 2',

  icon: 'image-line',
  poster: gptImageHeroPoster,
  hub: GPT_IMAGE_HUB_ID,
}, {
  id: SEEDANCE_HUB_ID,
  title: 'Seedance 2.5',
  badge: '50% Off Annual',

  badgeTone: 'top',
  tagline: 'Cinema multi-shot video with Plus+ · 70 1-click templates',

  icon: 'film-line',
  poster: seedanceHeroPoster,
  hub: SEEDANCE_HUB_ID,
}, {
  id: 'black-friday',
  title: 'Black Friday collection',
  tagline: 'Black Friday promo templates · Ready to use',

  icon: 'sparkling-line',
  poster: blackFridayHeroPoster,
}, {
  id: 'hub-' + geminiHub.id,
  title: geminiHub.latestModel,
  tagline: 'Generate code animations from one prompt',

  icon: 'sparkling-line',
  poster: geminiHub.poster,
  hub: geminiHub.id,
}, {
  id: motionStudio.id,
  title: motionStudio.title,
  tagline: 'Animate type & graphics on a timeline',

  icon: motionStudio.icon,
  poster: motionPoster,
  clip: motionClip,
}];

function FeaturedClip({ src, poster, playing }: { src: string; poster: string; playing: boolean }) {
  const player = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const video = player.current;
    return () => {
      if (video?.hasAttribute('src')) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [src]);
  useEffect(() => {
    const video = player.current;
    if (!video || failed) return;
    if (playing) {
      if (!video.hasAttribute('src') || video.error) video.src = src;
      void video.play().catch(() => { /* The poster remains available if autoplay is blocked. */ });
    } else {
      video.pause();
    }
  }, [playing, src, failed]);
  return !failed ? (
    <video
      ref={player}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
      style={{ opacity: ready ? 1 : 0 }}
      onPlaying={() => setReady(true)}
      onError={() => { setReady(false); setFailed(true); }}
    />
  ) : null;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const u = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return u * u * (3 - 2 * u);
};

export function ExploreBlackFridaySpotlight({ active, onNavigate, onOpenMotionEditor, motionEditorDisabled, onOpenBlackFriday, onModelHub }: {
  active: boolean;
  onNavigate: (target: StudioDestination, prompt: string) => void;
  onOpenMotionEditor: () => void;
  motionEditorDisabled?: boolean;
  onOpenBlackFriday: (trigger: HTMLButtonElement) => void;
  onModelHub: (id: string) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportRectRef = useRef<{ left: number; width: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection;
  const [saveData, setSaveData] = useState(Boolean(connection?.saveData));
  const [visible, setVisible] = useState(false);
  const [hoveredSlide, setHoveredSlide] = useState<string | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const dragState = useRef({ active: false, moved: false, startX: 0, startOffset: 0, lastX: 0, lastTime: 0, releaseVel: 0 });
  const panRef = useRef({
    offset: 0,
    maxOffset: 0,
    targetVel: 0,
    currentVel: 0,
    wheelVel: 0,
  });
  const rafIdRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const animEnabledRef = useRef(false);
  animEnabledRef.current = active && visible && !paused;

  useEffect(() => {
    const change = () => setSaveData(Boolean(connection?.saveData));
    connection?.addEventListener?.('change', change);
    return () => connection?.removeEventListener?.('change', change);
  }, [connection]);

  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setPaused(preference.matches);
    preference.addEventListener('change', change);
    return () => preference.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let disposed = false;
    let inView = typeof IntersectionObserver === 'undefined';
    const update = () => { if (!disposed) setVisible(inView && !document.hidden); };
    if (typeof IntersectionObserver === 'undefined') {
      update();
      document.addEventListener('visibilitychange', update);
      return () => { disposed = true; document.removeEventListener('visibilitychange', update); };
    }
    const observer = new IntersectionObserver(entries => {
      if (disposed) return;
      inView = entries[entries.length - 1].isIntersecting;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => { disposed = true; observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);

  const syncEdges = useCallback((offset: number, maxOffset: number) => {
    const left = offset > 2;
    const right = maxOffset - offset > 2;
    setEdges(old => (old.left === left && old.right === right ? old : { left, right }));
  }, []);

  const stopAnimation = useCallback(() => {
    if (rafIdRef.current) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
  }, []);

  // Run the camera-dolly rAF loop strictly on demand (pointer edge-pan, trackpad swipe, or drag inertia)
  // so an idle Spotlight contributes zero animation frames per second.
  const startAnimation = useCallback(() => {
    if (rafIdRef.current || !animEnabledRef.current) return;
    const pan = panRef.current;
    if (dragState.current.active || pan.maxOffset <= 0) return;
    if (pan.targetVel === 0 && pan.currentVel === 0 && pan.wheelVel === 0) return;

    lastFrameRef.current = performance.now();
    const tick = (now: number) => {
      rafIdRef.current = 0;
      if (!animEnabledRef.current || dragState.current.active) return;

      const dt = Math.min(0.05, (now - lastFrameRef.current) / 1000);
      lastFrameRef.current = now;

      const trackEl = trackRef.current;
      const state = panRef.current;
      if (!trackEl || state.maxOffset <= 0) return;

      let desiredVel = state.targetVel;

      // Hydraulic soft-stop cushion within 180px of either end so it never hits a brick wall
      const cushionDist = 180;
      if (desiredVel > 0) {
        const remaining = state.maxOffset - state.offset;
        desiredVel *= smoothstep(0, cushionDist, remaining);
      } else if (desiredVel < 0) {
        const remaining = state.offset;
        desiredVel *= smoothstep(0, cushionDist, remaining);
      }

      // Asymmetric dolly inertia: weighted glide-in, velvety long coast-to-stop
      const accelerating = Math.abs(desiredVel) > Math.abs(state.currentVel);
      const rate = accelerating ? 3.8 : 2.7;
      const damp = 1 - Math.exp(-rate * dt);
      state.currentVel += (desiredVel - state.currentVel) * damp;
      if (Math.abs(state.currentVel) < 0.4 && Math.abs(desiredVel) < 0.4) state.currentVel = 0;

      // Decay trackpad/flick momentum
      state.wheelVel *= Math.exp(-5.2 * dt);
      if (Math.abs(state.wheelVel) < 1) state.wheelVel = 0;

      const totalVel = state.currentVel + state.wheelVel;
      if (totalVel !== 0) {
        const next = Math.max(0, Math.min(state.maxOffset, state.offset + totalVel * dt));
        if (next !== state.offset) {
          state.offset = next;
          trackEl.style.transform = `translate3d(${-state.offset.toFixed(2)}px, 0, 0)`;
          syncEdges(state.offset, state.maxOffset);
        } else {
          state.currentVel *= 0.6;
          if (Math.abs(state.currentVel) < 0.4) state.currentVel = 0;
          state.wheelVel = 0;
        }
      }

      const needsMoreFrames =
        Math.abs(desiredVel) >= 0.4 ||
        state.currentVel !== 0 ||
        state.wheelVel !== 0;
      if (needsMoreFrames) {
        rafIdRef.current = window.requestAnimationFrame(tick);
      }
    };

    rafIdRef.current = window.requestAnimationFrame(tick);
  }, [syncEdges]);

  useEffect(() => {
    if (!active || !visible || paused) {
      stopAnimation();
      return;
    }
    startAnimation();
    return stopAnimation;
  }, [active, visible, paused, startAnimation, stopAnimation]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const trackEl = trackRef.current;
    if (!viewport || !trackEl) return;
    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      if (rect.width > 0) {
        viewportRectRef.current = { left: rect.left, width: rect.width };
      }
      const maxOffset = Math.max(0, viewport.scrollWidth - viewport.clientWidth, trackEl.scrollWidth - viewport.clientWidth);
      panRef.current.maxOffset = maxOffset;
      panRef.current.offset = Math.max(0, Math.min(maxOffset, panRef.current.offset));
      trackEl.style.transform = `translate3d(${-panRef.current.offset.toFixed(2)}px, 0, 0)`;
      syncEdges(panRef.current.offset, maxOffset);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(viewport);
    ro?.observe(trackEl);
    measure();
    return () => ro?.disconnect();
  }, [syncEdges]);

  // Trackpad two-finger horizontal swipe support with smooth inertia
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || paused) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || Math.abs(event.deltaX) < 1) return;
      event.preventDefault();
      panRef.current.wheelVel = Math.max(-1400, Math.min(1400, panRef.current.wheelVel + event.deltaX * 9));
      startAnimation();
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [paused, startAnimation]);

  const updateEdgePan = (clientX: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let rect = viewportRectRef.current;
    if (!rect || rect.width <= 0) {
      const measured = viewport.getBoundingClientRect();
      if (measured.width <= 0) return;
      rect = { left: measured.left, width: measured.width };
      viewportRectRef.current = rect;
    }
    const nx = (clientX - rect.left) / rect.width;
    const edgeZone = 0.26;
    const maxSpeed = 620;
    const smoothCurve = (u: number) => {
      const c = Math.max(0, Math.min(1, u));
      return c * c * (3 - 2 * c);
    };
    if (nx < edgeZone) {
      const t = smoothCurve((edgeZone - nx) / edgeZone);
      panRef.current.targetVel = -t * maxSpeed;
      startAnimation();
    } else if (nx > 1 - edgeZone) {
      const t = smoothCurve((nx - (1 - edgeZone)) / edgeZone);
      panRef.current.targetVel = t * maxSpeed;
      startAnimation();
    } else {
      panRef.current.targetVel = 0;
    }
  };

  const onTrackPointerEnter = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    if (rect.width > 0) {
      viewportRectRef.current = { left: rect.left, width: rect.width };
    }
  };

  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    stopAnimation();
    panRef.current.wheelVel = 0;
    panRef.current.currentVel = 0;
    dragState.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      startOffset: panRef.current.offset,
      lastX: event.clientX,
      lastTime: performance.now(),
      releaseVel: 0,
    };
  };

  const onTrackPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') {
      updateEdgePan(event.clientX);
    }
    if (!dragState.current.active || !trackRef.current) return;
    const dx = event.clientX - dragState.current.startX;
    if (Math.abs(dx) > 6) dragState.current.moved = true;
    if (!dragState.current.moved) return;

    const now = performance.now();
    const stepDt = Math.max(4, now - dragState.current.lastTime) / 1000;
    dragState.current.releaseVel = ((dragState.current.lastX - event.clientX) / stepDt) * 0.7;
    dragState.current.lastX = event.clientX;
    dragState.current.lastTime = now;

    const next = Math.max(0, Math.min(panRef.current.maxOffset, dragState.current.startOffset - dx));
    panRef.current.offset = next;
    trackRef.current.style.transform = `translate3d(${-next.toFixed(2)}px, 0, 0)`;
    syncEdges(next, panRef.current.maxOffset);
  };

  const endTrackDrag = () => {
    const hadDrag = dragState.current.active && dragState.current.moved;
    if (hadDrag) {
      panRef.current.wheelVel = Math.max(-1200, Math.min(1200, dragState.current.releaseVel));
    }
    dragState.current.active = false;
    if (hadDrag || panRef.current.targetVel !== 0 || panRef.current.currentVel !== 0) {
      startAnimation();
    }
    window.setTimeout(() => { dragState.current.moved = false; }, 40);
  };

  const handleTrackLeave = () => {
    panRef.current.targetVel = 0;
    endTrackDrag();
  };

  const revealCardInView = (card: HTMLButtonElement) => {
    const viewport = viewportRef.current;
    const trackEl = trackRef.current;
    if (!viewport || !trackEl || panRef.current.maxOffset <= 0) return;
    if (paused) {
      card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    const item = card.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(viewport).paddingInlineStart) || 0;
    const leftGap = item.left - bounds.left - inset;
    const rightOverflow = item.right - bounds.right + inset;
    const delta = leftGap < 0 ? leftGap : Math.max(0, rightOverflow);
    const next = Math.max(0, Math.min(panRef.current.maxOffset, panRef.current.offset + delta));
    if (next !== panRef.current.offset) {
      panRef.current.offset = next;
      trackEl.style.transform = `translate3d(${-next.toFixed(2)}px, 0, 0)`;
      syncEdges(next, panRef.current.maxOffset);
    }
  };

  return <section
    ref={root}
    className="om-feature-carousel om-spotlight-carousel"
    data-bf-spotlight="true"
    aria-label={t('Featured')}
    onPointerLeave={handleTrackLeave}
  >
    <div
      ref={viewportRef}
      className="om-rail-viewport om-overflow-fade om-spotlight-edge-viewport"
      data-fade-start={edges.left || undefined}
      data-fade-end={edges.right || undefined}
      onPointerEnter={onTrackPointerEnter}
      onPointerDown={onTrackPointerDown}
      onPointerMove={onTrackPointerMove}
      onPointerUp={endTrackDrag}
      onPointerCancel={endTrackDrag}
      role="group"
      aria-label={t('Featured')}
    >
      <div ref={trackRef} className="om-spotlight-edge-track">
        {slides.map((slide, i) => {
          const scene = slide.scene;
          const blackFriday = slide.id === 'black-friday';
          const clipPlaying = active && visible && hoveredSlide === slide.id && !paused && !saveData;
          const title = t(slide.title);
          const badge = slide.badge ? t(slide.badge) : null;
          const tagline = t(slide.tagline);

          const openSlide = (trigger: HTMLButtonElement) => {
            if (dragState.current.moved) return;
            if (slide.hub) {
              track('slide_action', { slide: slide.id, position: i });
              onModelHub(slide.hub);
              return;
            }
            if (blackFriday) {
              track('slide_action', { slide: slide.id, position: i });
              onOpenBlackFriday(trigger);
              return;
            }
            track('slide_action', { slide: slide.id, position: i, ...(scene ? destinationTarget(scene.target) : { studio: motionStudio.id }) });
            if (scene) onNavigate(scene.target, t(scene.prompt));
            else onOpenMotionEditor();
          };

          return (
            <Button
              key={slide.id}
              type="button"
              variant="plain"
              className="om-discovery-hero om-feature-slide om-spotlight-card"
              disabled={Boolean(motionEditorDisabled && !slide.hub && !scene && !blackFriday)}
              data-scene={slide.id}
              data-clickable="true"
              onMouseEnter={() => setHoveredSlide(slide.id)}
              onMouseLeave={() => setHoveredSlide(prev => (prev === slide.id ? null : prev))}
              onFocus={event => revealCardInView(event.currentTarget)}
              onClick={event => openSlide(event.currentTarget)}
            >
              <div className="om-feature-art" aria-hidden="true"><div className="om-feature-camera">
                <img src={slide.poster} alt="" draggable={false} loading={i < 3 ? 'eager' : 'lazy'} decoding="async" />
                {active && visible && !saveData && slide.clip && hoveredSlide === slide.id && <FeaturedClip src={slide.clip} poster={slide.poster} playing={clipPlaying} />}
              </div></div>
              <div className="om-spotlight-overlay">
                {badge && (
                  <span className="om-spotlight-badge" data-tone={slide.badgeTone ?? 'neutral'} title={badge}>
                    {badge}
                  </span>
                )}
                <div className="om-spotlight-footer">
                  <div className="om-spotlight-copy">
                    <h2 title={title}>{title}</h2>
                    <p title={tagline}>{tagline}</p>
                  </div>
                </div>
              </div>
            </Button>
          );
        })}
      </div>
    </div>
  </section>;
}
