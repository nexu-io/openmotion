import { useEffect, useRef, useState, type RefObject } from 'react';

export const MAX_TEMPLATE_PLAYERS = 8;
export const MAX_RETAINED_TEMPLATE_PLAYERS = 16;
const COMPACT_RETAINED_TEMPLATE_PLAYERS = 8;

export type TemplatePlaybackPool = {
  playing: Set<string>;
  retained: Set<string>;
};

const EMPTY_SET = new Set<string>();
const EMPTY_POOL: TemplatePlaybackPool = { playing: EMPTY_SET, retained: EMPTY_SET };

function sameSet(previous: Set<string>, next: readonly string[]): boolean {
  return previous.size === next.length && next.every(id => previous.has(id));
}

/**
 * One observer with a bounded active decoder budget plus an optional bounded LRU warm-pause pool
 * (`retainedBudget`) so short back-and-forth scrolling resumes paused videos without re-fetching.
 */
export function useTemplatePlaybackPool(
  root: RefObject<HTMLElement | null>,
  catalogKey: string,
  enabled: boolean,
  autoplay: boolean,
  priority: string | null,
  priorityOnly = false,
  playerBudget = MAX_TEMPLATE_PLAYERS,
  retainedBudget = MAX_RETAINED_TEMPLATE_PLAYERS,
): TemplatePlaybackPool {
  const [pool, setPool] = useState<TemplatePlaybackPool>(EMPTY_POOL);
  const controls = useRef({ autoplay, priority });
  const retainedOrder = useRef(new Set<string>());
  const refresh = useRef<() => void>(() => {});
  useEffect(() => { controls.current = { autoplay, priority }; refresh.current(); }, [autoplay, priority]);
  useEffect(() => {
    const container = root.current;
    if (!container || !enabled) {
      retainedOrder.current.clear();
      setPool(previous => (previous.playing.size === 0 && previous.retained.size === 0 ? previous : EMPTY_POOL));
      return;
    }
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const compact = matchMedia('(max-width: 699px)');
    const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection;
    const visible = new Map<string, number>();
    const knownIds = new Set<string>();
    const update = () => {
      const { autoplay, priority } = controls.current;
      const allowed = autoplay && !document.hidden && !media.matches;
      const candidates = [...visible].sort((a, b) => Number(b[0] === priority) - Number(a[0] === priority) || b[1] - a[1]);
      // Brand Kit showcases are full HTML documents. Decode only the card the
      // user is actively hovering/focusing instead of starting several iframe
      // runtimes as soon as the masonry enters the viewport.
      const scoped = priorityOnly ? (priority ? candidates.filter(([id]) => id === priority) : []) : candidates;
      const activeBudget = Math.min(playerBudget, compact.matches ? 4 : MAX_TEMPLATE_PLAYERS);
      const ids = allowed
        ? scoped.filter(([id]) => !connection?.saveData || id === priority).slice(0, activeBudget).map(([id]) => id)
        : [];
      const activeSet = new Set(ids);
      const order = retainedOrder.current;
      for (const id of [...order]) {
        if (!knownIds.has(id)) order.delete(id);
      }
      if (!allowed) {
        order.clear();
      } else if (connection?.saveData || retainedBudget <= activeBudget) {
        order.clear();
        for (const id of ids) order.add(id);
      } else {
        for (const id of ids) {
          order.delete(id);
          order.add(id);
        }
        const maxRetained = Math.max(
          activeBudget,
          compact.matches ? Math.min(retainedBudget, COMPACT_RETAINED_TEMPLATE_PLAYERS) : retainedBudget,
        );
        if (order.size > maxRetained) {
          for (const candidate of [...order]) {
            if (order.size <= maxRetained) break;
            if (!activeSet.has(candidate)) order.delete(candidate);
          }
        }
      }
      const retainedIds = [...order];
      setPool(previous => {
        if (sameSet(previous.playing, ids) && sameSet(previous.retained, retainedIds)) return previous;
        return {
          playing: sameSet(previous.playing, ids) ? previous.playing : new Set(ids),
          retained: sameSet(previous.retained, retainedIds) ? previous.retained : new Set(retainedIds),
        };
      });
    };
    refresh.current = update;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const { playbackId, templateId } = (entry.target as HTMLElement).dataset;
        const id = playbackId ?? templateId!;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.2) visible.set(id, entry.intersectionRatio);
        else visible.delete(id);
      }
      update();
    }, { root: container, threshold: [0, 0.2, 0.5, 1] });
    container.querySelectorAll<HTMLElement>('[data-template-id][data-has-video="true"], [data-playback-id]').forEach(element => {
      const id = element.dataset.playbackId ?? element.dataset.templateId;
      if (id) knownIds.add(id);
      observer.observe(element);
    });
    document.addEventListener('visibilitychange', update);
    media.addEventListener('change', update); compact.addEventListener('change', update);
    connection?.addEventListener('change', update);
    update();
    return () => {
      refresh.current = () => {};
      observer.disconnect(); document.removeEventListener('visibilitychange', update);
      media.removeEventListener('change', update); compact.removeEventListener('change', update); connection?.removeEventListener('change', update);
    };
  }, [root, catalogKey, enabled, priorityOnly, playerBudget, retainedBudget]);
  return pool;
}

/** One observer and a bounded decoder budget for the whole gallery. No offscreen video sources. */
export function useTemplatePlayback(root: RefObject<HTMLElement | null>, catalogKey: string, enabled: boolean, autoplay: boolean, priority: string | null, priorityOnly = false, playerBudget = MAX_TEMPLATE_PLAYERS) {
  return useTemplatePlaybackPool(root, catalogKey, enabled, autoplay, priority, priorityOnly, playerBudget, 0).playing;
}
