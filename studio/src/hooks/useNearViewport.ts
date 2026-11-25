import { useEffect, useState } from "react";

/** Keep metadata work out of long off-screen asset lists (and hibernate while hidden). */
export function useNearViewport(element: Element | null, enabled = true) {
  const [visible, setVisible] = useState(() => enabled && typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "80px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled]);
  return enabled && visible;
}
