import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18n';
import { MotionIcon } from './icons';

/** Native horizontal scrolling keeps trackpad and touch gestures under browser control. */
export function GalleryCategoryStrip({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = () => {
    const node = viewport.current;
    if (!node) return;
    const start = node.scrollLeft > 1;
    const end = node.clientWidth > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setEdges(previous => previous.start === start && previous.end === end ? previous : { start, end });
  };
  useLayoutEffect(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current!);
    observer.observe(content.current!);
    document.fonts?.addEventListener('loadingdone', measure);
    measure();
    return () => { observer.disconnect(); document.fonts?.removeEventListener('loadingdone', measure); };
  }, []);
  const scroll = (direction: number) => {
    const node = viewport.current;
    if (!node) return;
    node.scrollBy({ left: direction * node.clientWidth * .75, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  return <div className="om-gallery-category-strip" data-scroll-start={edges.start} data-scroll-end={edges.end}>
    <div ref={viewport} id={id} className="om-gallery-category-viewport" onScroll={measure} onFocusCapture={event => {
      const node = viewport.current;
      if (!node || !(event.target instanceof HTMLElement)) return;
      // Leave room for the edge affordances when tabbing to a partially clipped pill.
      const frame = node.getBoundingClientRect(), target = event.target.getBoundingClientRect();
      const inset = Math.min(node.clientWidth / 4, 32);
      const delta = target.left < frame.left + inset ? target.left - frame.left - inset
        : target.right > frame.right - inset ? target.right - frame.right + inset : 0;
      if (delta) node.scrollBy({ left: delta, behavior: 'instant' });
    }}>
      <div ref={content} className="om-control-row om-gallery-categories" role="group" aria-label={label}>{children}</div>
    </div>
    <button type="button" className="om-button om-icon-button om-gallery-category-arrow" data-direction="start" aria-label={t('Scroll categories left')} aria-controls={id} disabled={!edges.start} onClick={() => scroll(-1)}><MotionIcon name="arrow-left" size={16} /></button>
    <button type="button" className="om-button om-icon-button om-gallery-category-arrow" data-direction="end" aria-label={t('Scroll categories right')} aria-controls={id} disabled={!edges.end} onClick={() => scroll(1)}><MotionIcon name="arrow-right" size={16} /></button>
  </div>;
}
