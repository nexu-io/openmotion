import { useEffect, useRef, type RefObject } from 'react';

/**
 * Calls `onLoad` when the returned sentinel scrolls near the bottom of `root`, so template lists keep
 * filling in as the user scrolls instead of waiting for a "More templates" click. The observer is
 * recreated after every batch, which re-checks the sentinel: a short list keeps loading until it
 * fills the viewport. Where IntersectionObserver is unavailable nothing loads automatically: `observing` is
 * false and the caller keeps an explicit "More templates" button instead of rendering every template at once.
 */
export function useLoadMoreOnScroll(root: RefObject<HTMLElement | null>, enabled: boolean, onLoad: () => void, revision: unknown) {
  const sentinel = useRef<HTMLDivElement>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  const observing = typeof IntersectionObserver !== 'undefined';
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !enabled || !observing) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      load.current();
    }, { root: root.current, rootMargin: '0px 0px 720px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [root, enabled, observing, revision]);
  return { sentinel, observing };
}
