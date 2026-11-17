import { PreviewCard } from '@base-ui/react/preview-card';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { GalleryTemplate } from '../../../shared/catalog';
import { useI18n } from '../i18n/I18n';
import { floatingMotion, POPUP_LAYER } from '../components/ui/Menu';
import { Skeleton } from '../components/ui/Skeleton';
import { TemplatePoster } from './TemplateGalleryCard';
import styles from './TemplateLibraryDialog.module.css';

function PreviewMedia({ template }: { template: GalleryTemplate }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false), [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const element = video.current;
    if (!element || !template.previewUrl || reducedMotion || failed) return;
    let cancelled = false;
    element.src = template.previewUrl;
    const unavailable = () => { if (!cancelled) { setFailed(true); setPlaying(false); } };
    // A stalled request must return to a usable poster instead of loading indefinitely.
    const timeout = window.setTimeout(unavailable, 15000);
    const ready = () => window.clearTimeout(timeout);
    element.addEventListener('playing', ready);
    void element.play().catch(unavailable);
    return () => {
      cancelled = true; window.clearTimeout(timeout); element.removeEventListener('playing', ready);
      element.pause(); element.removeAttribute('src'); element.load(); setPlaying(false);
    };
  }, [template.previewUrl, reducedMotion, failed, attempt]);
  return <>
    <TemplatePoster template={template} eager />
    {template.previewUrl && !reducedMotion && !failed && <video ref={video} muted playsInline loop preload="none" aria-hidden="true"
      style={{ opacity: playing ? 1 : 0 }} onPlaying={() => setPlaying(true)} onError={() => { setFailed(true); setPlaying(false); }} />}
    {template.previewUrl && !reducedMotion && !playing && !failed && <div className={styles.relatedPreviewStatus} role="status"><Skeleton className={styles.mediaProgress} /><span>{t('Loading preview…')}</span></div>}
    {failed && <div className={styles.relatedPreviewStatus} role="status"><span>{t('Preview unavailable. Try again.')}</span><button className="om-button" onClick={() => { setFailed(false); retry(value => value + 1); }}>{t('Retry')}</button></div>}
    <span className={styles.relatedPreviewCaption}>{template.title}</span>
  </>;
}

/** One lazy player shared by all related cards, kept inside the native dialog's top layer. */
export function RelatedTemplatePreviews({ templates, panel, onSelect }: {
  templates: GalleryTemplate[];
  panel: RefObject<HTMLDivElement | null>;
  onSelect: (template: GalleryTemplate, position: number) => void;
}) {
  const { t } = useI18n();
  const section = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false), [trigger, setTrigger] = useState<Element | null>(null);
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 699px)').matches);
  useEffect(() => {
    const preference = matchMedia('(max-width: 699px)');
    const update = () => { setCompact(preference.matches); setOpen(false); };
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const hidden = () => { if (document.hidden) dismiss(); };
    document.addEventListener('visibilitychange', hidden);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [open]);
  const anchor = useMemo(() => trigger ? {
    contextElement: trigger,
    getBoundingClientRect: () => {
      const rect = trigger.getBoundingClientRect();
      // Both thumbnail columns open over the stage, never over neighboring cards.
      return compact ? rect : new DOMRect(panel.current?.getBoundingClientRect().left ?? rect.left, rect.top, 0, rect.height);
    },
  } : null, [trigger, panel, compact]);

  return <PreviewCard.Root<GalleryTemplate> open={open} onOpenChange={(next, details) => {
    if (next && document.hidden) { details.cancel(); return; }
    if (details.trigger) setTrigger(details.trigger);
    setOpen(next);
  }}>{({ payload }) => <>
    <section ref={section} className={styles.related} aria-label={t('Related templates')}>
      <h3>{t('Related templates')}</h3>
      <div>{templates.map((item, index) => <PreviewCard.Trigger key={item.id} payload={item} delay={150} closeDelay={100}
        render={<button type="button" onClick={() => { setOpen(false); onSelect(item, index + 1); }}
          aria-label={t('Preview template {title}', { title: item.title })} />}>
        <TemplatePoster template={item} /><span className={styles.relatedCaption}>{item.title}</span>
      </PreviewCard.Trigger>)}</div>
    </section>
    <PreviewCard.Portal container={section.current?.closest('dialog')}>
      <PreviewCard.Positioner anchor={anchor} side={compact ? 'top' : 'left'} sideOffset={20} collisionPadding={16}
        positionMethod="fixed" collisionAvoidance={{ side: compact ? 'flip' : 'none', align: 'shift' }} className={`${POPUP_LAYER} ${styles.relatedPreviewPositioner}`}>
        <PreviewCard.Popup className={`${styles.relatedPreview} ${floatingMotion('duration-open')}`} aria-label={payload?.title}>
          {open && payload && <PreviewMedia key={payload.id} template={payload} />}
        </PreviewCard.Popup>
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  </>}</PreviewCard.Root>;
}
