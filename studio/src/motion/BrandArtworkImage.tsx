import { useEffect, useRef, type ComponentPropsWithoutRef } from 'react';

// Website artwork can wait on remote hosts even though its URL is local.
// Keep browser connections free for detail navigation, playback and downloads.
const maxRequests = 3;
let inFlight = 0;
const waiting = new Set<() => void>();
const nearby = new Map<Element, () => void>();
let observer: IntersectionObserver | undefined;

function drain() {
  while (inFlight < maxRequests && waiting.size) {
    const start = waiting.values().next().value!;
    waiting.delete(start);
    start();
  }
}

function requestArtwork(startRequest: () => void) {
  let active = false;
  const start = () => { active = true; inFlight++; startRequest(); };
  waiting.add(start);
  drain();
  return () => {
    waiting.delete(start);
    if (active) { active = false; inFlight--; drain(); }
  };
}

function whenNearby(node: Element, start: () => void) {
  if (typeof IntersectionObserver === 'undefined') { start(); return () => {}; }
  observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      const load = nearby.get(entry.target);
      nearby.delete(entry.target);
      observer?.unobserve(entry.target);
      load?.();
    }
  }, { rootMargin: '160px' });
  nearby.set(node, start);
  observer.observe(node);
  return () => {
    nearby.delete(node);
    observer?.unobserve(node);
    if (!nearby.size) { observer?.disconnect(); observer = undefined; }
  };
}

export function BrandArtworkImage({ src, onLoad, onError, ...props }: ComponentPropsWithoutRef<'img'> & { src: string }) {
  const image = useRef<HTMLImageElement>(null);
  const finish = useRef<() => void>(() => {});
  useEffect(() => {
    const node = image.current;
    if (!node) return;
    const stop = whenNearby(node, () => {
      finish.current = requestArtwork(() => { node.src = src; });
    });
    return () => { stop(); node.removeAttribute('src'); finish.current(); };
  }, [src]);
  return <img {...props} ref={image} data-artwork-src={src} decoding="async" fetchPriority="low"
    onLoad={event => { finish.current(); onLoad?.(event); }}
    onError={event => { finish.current(); onError?.(event); }} />;
}
