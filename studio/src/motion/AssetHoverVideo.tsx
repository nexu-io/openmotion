import { useEffect, useRef, useState } from 'react';

/** A temporary, silent player layered over the retained gallery poster. */
export function AssetHoverVideo({ src, active = true }: { src: string; active?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element || !src || failed) return;
    element.muted = true;
    element.src = src;
    return () => {
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [src, failed]);
  useEffect(() => {
    const element = video.current;
    if (!element || !src || failed) return;
    if (!active) {
      element.pause();
      return;
    }
    let cancelled = false;
    const unavailable = () => { if (!cancelled) setFailed(true); };
    const timeout = window.setTimeout(unavailable, 15000);
    const ready = () => window.clearTimeout(timeout);
    element.addEventListener('playing', ready);
    element.muted = true;
    if (element.getAttribute('src') !== src) element.src = src;
    void element.play().catch(unavailable);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      element.removeEventListener('playing', ready);
    };
  }, [active, src, failed]);
  return <video ref={video} className="om-asset-hover-video" muted loop playsInline preload="none" aria-hidden="true"
    style={{ visibility: playing && !failed ? 'visible' : 'hidden' }}
    onPlaying={() => setPlaying(true)} onError={() => setFailed(true)} />;
}
