import { useEffect, useState } from "react";

export interface UseNearViewportOptions {
  /** Optional scroll-container selector resolved via `element.closest(rootSelector)`. */
  rootSelector?: string;
  rootMargin?: string;
}

/** Keep metadata work out of long off-screen asset/composition lists (and hibernate while hidden). */
export function useNearViewport(
  element: Element | null,
  enabled = true,
  options?: UseNearViewportOptions,
) {
  const rootSelector = options?.rootSelector;
  const rootMargin = options?.rootMargin ?? "80px";
  const [visible, setVisible] = useState(() => enabled && typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!enabled || !element) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const root = rootSelector ? element.closest(rootSelector) : null;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root,
      rootMargin,
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled, rootMargin, rootSelector]);
  return enabled && visible;
}
