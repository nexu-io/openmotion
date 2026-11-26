import { useEffect, useRef, useState, type RefObject } from 'react';

const NO_CLIPS: ReadonlySet<string> = new Set();

export function usePromoPlayback(dialog: RefObject<HTMLDialogElement | null>, open: boolean) {
  const [playable, setPlayable] = useState(NO_CLIPS);

  useEffect(() => {
    if (!open || !dialog.current || typeof IntersectionObserver === 'undefined') {
      setPlayable(NO_CLIPS);
      return;
    }
    const visible = new Map<string, string>();
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection;
    const update = () => {
      if (document.hidden || motion.matches || connection?.saveData) {
        setPlayable(NO_CLIPS);
        return;
      }
      // During a rail loop, two copies of the same clip can be visible at once.
      const slotBySource = new Map<string, string>();
      for (const [slot, src] of visible) {
        if (!slotBySource.has(src)) slotBySource.set(src, slot);
      }
      setPlayable(new Set(slotBySource.values()));
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const { promoSlot: slot, promoSrc: src } = (entry.target as HTMLElement).dataset;
        if (!slot || !src) continue;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.1) visible.set(slot, src);
        else visible.delete(slot);
      }
      update();
    }, { threshold: 0.1 });
    dialog.current.querySelectorAll('[data-promo-slot]').forEach(slot => observer.observe(slot));
    document.addEventListener('visibilitychange', update);
    motion.addEventListener('change', update);
    connection?.addEventListener('change', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      motion.removeEventListener('change', update);
      connection?.removeEventListener('change', update);
    };
  }, [dialog, open]);

  return playable;
}

function attachPromoVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  video.src = video.dataset.src!;
  return () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}

export function PromoClip({ src, slot, playable, priority = 'auto' }: {
  src: string;
  slot: string;
  playable: boolean;
  priority?: 'high' | 'auto' | 'low';
}) {
  const poster = src.replace(/\.(mp4|webm)$/, '-poster.webp');
  const image = useRef<HTMLImageElement>(null);
  const [painted, setPainted] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!playable || painted || !image.current) return;
    const preview = image.current;
    let cancelled = false;
    let frame = 0;
    // Leave a paint between decoding the poster and attaching the video source.
    // A failed poster can still recover by showing the clip.
    const afterDecode = () => {
      if (cancelled) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setPainted(true));
      });
    };
    const decode = () => { void preview.decode().then(afterDecode, afterDecode); };
    if (preview.complete) decode();
    else {
      preview.addEventListener('load', decode, { once: true });
      preview.addEventListener('error', afterDecode, { once: true });
    }
    return () => {
      cancelled = true;
      preview.removeEventListener('load', decode);
      preview.removeEventListener('error', afterDecode);
      cancelAnimationFrame(frame);
    };
  }, [playable, painted]);

  return (
    <div className="om-epm-clip" data-promo-slot={slot} data-promo-src={src}>
      {playable && painted && !failed ? (
        <video ref={attachPromoVideo} data-src={src} poster={poster} preload="none" muted loop playsInline autoPlay onError={() => setFailed(true)} />
      ) : (
        <img ref={image} src={poster} alt="" fetchPriority={priority} loading={priority === 'high' ? 'eager' : 'lazy'} />
      )}
    </div>
  );
}
