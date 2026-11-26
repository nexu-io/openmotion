import { useCallback, useEffect, useRef, useState } from 'react';

/** A temporary, silent player layered over the retained gallery poster. */
export function AssetHoverVideo({ src, active = true }: { src: string; active?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const resumedFromWarmPause = useRef(false);
  const pendingPauseRetry = useRef(false);
  const attemptFailed = useRef(false);
  const [playing, setPlaying] = useState(false), [failed, setFailed] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const handleFailure = useCallback(() => {
    if (attemptFailed.current) return;
    attemptFailed.current = true;
    setPlaying(false);
    if (!active && retryCount === 0) {
      resumedFromWarmPause.current = false;
      pendingPauseRetry.current = true;
      const element = video.current;
      if (element?.hasAttribute('src')) {
        element.pause();
        element.removeAttribute('src');
        element.load();
      }
      return;
    }
    if (resumedFromWarmPause.current && retryCount === 0 && active) {
      resumedFromWarmPause.current = false;
      setRetryCount(1);
      return;
    }
    setFailed(true);
  }, [active, retryCount]);
  useEffect(() => {
    resumedFromWarmPause.current = false;
    pendingPauseRetry.current = false;
    attemptFailed.current = false;
    setPlaying(false);
    setFailed(false);
    setRetryCount(0);
  }, [src]);
  useEffect(() => {
    const element = video.current;
    if (!element || !src || failed) return;
    element.muted = true;
    element.src = src;
    return () => {
      resumedFromWarmPause.current = false;
      pendingPauseRetry.current = false;
      attemptFailed.current = false;
      if (element.hasAttribute('src')) {
        element.pause();
        element.removeAttribute('src');
        element.load();
      }
      setPlaying(false);
    };
  }, [src, failed, retryCount]);
  useEffect(() => {
    const element = video.current;
    if (!element || !src || failed) return;
    attemptFailed.current = false;
    if (!active) {
      resumedFromWarmPause.current = true;
      element.pause();
      return;
    }
    if (pendingPauseRetry.current) {
      pendingPauseRetry.current = false;
      resumedFromWarmPause.current = false;
      setRetryCount(1);
      return;
    }
    let cancelled = false;
    const unavailable = () => {
      window.clearTimeout(timeout);
      if (!cancelled) handleFailure();
    };
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
  }, [active, src, failed, retryCount, handleFailure]);
  return <video ref={video} className="om-asset-hover-video" muted loop playsInline preload="none" aria-hidden="true"
    style={{ visibility: playing && !failed ? 'visible' : 'hidden' }}
    onPlaying={() => {
      resumedFromWarmPause.current = false;
      pendingPauseRetry.current = false;
      attemptFailed.current = false;
      setPlaying(true);
    }}
    onError={handleFailure} />;
}
