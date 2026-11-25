import { useEffect, useRef, type RefObject } from 'react';

/**
 * Calls `onSeen(id)` once a gallery card has stayed at least half visible, in a visible tab, for one unbroken second.
 * One observer per card kind serves the gallery. `resultKey` names the current search, filter and sort combination: when it
 * changes, cards still on screen are timed again. `onSeen` returns false to be asked again after another second.
 */
export function useCardImpressions(root: RefObject<HTMLElement | null>, catalogKey: string, enabled: boolean, resultKey: string, onSeen: (id: string) => boolean, attribute: 'data-template-id' | 'data-series-id' | 'data-reference-entry' | 'data-generation-offer' = 'data-template-id') {
  const seen = useRef(onSeen); seen.current = onSeen;
  const restart = useRef<() => void>(() => {});
  useEffect(() => {
    const container = root.current;
    if (!container || !enabled || typeof IntersectionObserver === 'undefined') return;
    // Standalone cards are clipped by their scrolling ancestors and by the viewport.
    const standalone = container.hasAttribute(attribute);
    const covered = () => standalone && Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'));
    let obscured = covered();
    const inView = new Set<string>(), timers = new Map<string, ReturnType<typeof setTimeout>>(), done = new Set<string>();
    const stop = (id: string) => { clearTimeout(timers.get(id)); timers.delete(id); };
    const start = (id: string) => {
      if (done.has(id) || !inView.has(id) || document.hidden || obscured || timers.has(id)) return;
      timers.set(id, setTimeout(() => { timers.delete(id); if (!document.hidden && !covered() && seen.current(id)) done.add(id); else start(id); }, 1000));
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = entry.target.getAttribute(attribute)!;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) { inView.add(id); start(id); } else { inView.delete(id); stop(id); }
      }
    }, { root: standalone ? null : container, threshold: 0.5 });
    if (standalone) observer.observe(container);
    else container.querySelectorAll(`[${attribute}]`).forEach(element => observer.observe(element));
    const visibility = () => { for (const id of inView) { if (document.hidden) stop(id); else start(id); } };
    const modalObserver = standalone ? new MutationObserver(() => {
      const next = covered();
      if (next === obscured) return;
      obscured = next;
      for (const id of inView) { stop(id); start(id); }
    }) : undefined;
    modalObserver?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'role', 'aria-modal'] });
    document.addEventListener('visibilitychange', visibility);
    restart.current = () => { done.clear(); for (const id of inView) { stop(id); start(id); } };
    return () => {
      restart.current = () => {};
      for (const id of [...timers.keys()]) stop(id);
      observer.disconnect(); modalObserver?.disconnect(); document.removeEventListener('visibilitychange', visibility);
    };
  }, [root, catalogKey, enabled, attribute]);
  useEffect(() => { restart.current(); }, [resultKey]);
}

export { useCardImpressions as useTemplateImpressions };
