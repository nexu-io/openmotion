import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { isEditableTemplate, type GalleryTemplate } from '../../../shared/catalog';
import { useI18n } from '../i18n/I18n';
import { Skeleton } from '../components/ui/Skeleton';
import { MotionIcon } from './icons';
import { BrandArtworkImage } from './BrandArtworkImage';
import { templateAspect } from './templateDiscovery';
import figmaLogo from './template-brands/figma.png';
import lovableLogo from './template-brands/lovable.svg';
import linearLogo from './template-brands/linear.svg';
import firecrawlLogo from './template-brands/firecrawl.png';
import kimiLogo from './template-brands/kimi.png';
import pondLogo from './template-brands/pond.svg';
import notionLogo from './template-brands/notion.png';
import higgsfieldLogo from './template-brands/higgsfield.png';

const brandLogos: Record<string, string> = { Notion: notionLogo, Higgsfield: higgsfieldLogo, Figma: figmaLogo, Lovable: lovableLogo, Linear: linearLogo, Firecrawl: firecrawlLogo, Kimi: kimiLogo, Pond: pondLogo };

export function TemplateIdentity({ template, brand = false, favicon = false }: { template: GalleryTemplate; brand?: boolean; favicon?: boolean }) {
  const name = brand ? template.brand || template.author : template.authorName || template.author || template.brand || 'OpenMotion';
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const candidates = favicon ? [template.brandLogoUrl] : [!brand && template.authorAvatarUrl, template.brandLogoUrl, brandLogos[template.brand ?? '']];
  const url = candidates.find((candidate): candidate is string => Boolean(candidate) && !failedUrls.includes(candidate as string));
  return <span className="om-gallery-avatar" data-favicon={favicon || undefined} aria-hidden="true">{name.slice(0, 1).toUpperCase()}{url
    && (favicon ? <BrandArtworkImage src={url} alt="" style={{ opacity: loadedUrl === url ? 1 : 0 }}
        onLoad={() => setLoadedUrl(url)} onError={() => setFailedUrls(previous => [...previous, url])} />
      : <img src={url} alt="" loading="lazy" onError={() => setFailedUrls(previous => [...previous, url])} />)}</span>;
}

/** A separate anchor keeps website navigation independent from opening the preview. */
export function TemplateSourceLink({ template, className }: { template: GalleryTemplate; className: string }) {
  const { t } = useI18n();
  if (!template.sourceUrl) return null;
  const domain = new URL(template.sourceUrl).hostname.replace(/^www\./, '');
  return <a className={className} href={template.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`${t('Source')}: ${template.title} · ${domain}`} title={template.sourceUrl}>
    <TemplateIdentity template={template} brand favicon />
    <span className="om-gallery-source-caption"><strong>{template.title}</strong><small>{domain}</small></span>
    <MotionIcon name="arrow-up-right" size={16} />
  </a>;
}

export function TemplatePoster({ template, eager = false, coverUrl, onCoverAspect }: { template: GalleryTemplate; eager?: boolean; coverUrl?: string; onCoverAspect?: (aspect: number | undefined) => void }) {
  const [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false);
  const [loadedCover, setLoadedCover] = useState<string>(), [failedCover, setFailedCover] = useState<string>();
  return <div className="om-gallery-poster" data-loaded={loaded}>
    {!loaded && !failed && template.posterUrl && <Skeleton className="om-gallery-poster-skeleton" animated={false} />}
    {(!template.posterUrl || failed) && <div className="om-gallery-poster-fallback"><MotionIcon name="film" size={26} /><span>{template.title}</span></div>}
    {template.posterUrl && !failed && <img src={template.posterUrl} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} style={{ opacity: loaded ? 1 : 0 }} />}
    {coverUrl && coverUrl !== failedCover && <BrandArtworkImage className="om-gallery-poster-cover" src={coverUrl} alt="" onLoad={event => { setLoadedCover(coverUrl); const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) onCoverAspect?.(image.naturalWidth / image.naturalHeight); }} onError={() => { setFailedCover(coverUrl); onCoverAspect?.(undefined); }} style={{ opacity: loadedCover === coverUrl ? 1 : 0 }} />}
  </div>;
}

export const TemplateGalleryCard = memo(function TemplateGalleryCard({ template, onSelect, active, onPriority, footer, resourceKind = 'template', animatedPreview, coverUrl }: { template: GalleryTemplate; onSelect: (template: GalleryTemplate, trigger: HTMLButtonElement) => void; footer?: ReactNode; active: boolean; onPriority: (id: string | null) => void; resourceKind?: 'template' | 'brand-kit'; animatedPreview?: string; coverUrl?: string }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [coverAspect, setCoverAspect] = useState<number>();
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    if (!active || !animatedPreview) { setAnimate(false); return; }
    const intent = setTimeout(() => setAnimate(true), 250);
    return () => clearTimeout(intent);
  }, [active, animatedPreview]);
  useEffect(() => {
    const element = video.current;
    if (!element || !active || !template.previewUrl || failed) return;
    let cancelled = false;
    element.src = template.previewUrl;
    void element.play().catch(() => { if (!cancelled) setPlaying(false); });
    return () => {
      cancelled = true; element.pause(); element.removeAttribute('src'); element.load(); setPlaying(false);
    };
  }, [active, template.previewUrl, failed]);
  const linkedSource = resourceKind === 'brand-kit' && Boolean(template.sourceUrl);
  return <article className="om-gallery-card" data-template-id={template.id} data-has-video={Boolean(template.previewUrl || animatedPreview)} data-website-cover={Boolean(coverUrl)}>
    <div className="om-gallery-card-media">
    <button className="motion-gallery-card-cover om-gallery-cover" style={{ aspectRatio: Math.max(0.8, Math.min(1.9, coverAspect || templateAspect(template))) }} onClick={event => onSelect(template, event.currentTarget)}
      onMouseEnter={() => onPriority(template.id)} onMouseLeave={() => onPriority(null)} onFocus={() => onPriority(template.id)} onBlur={() => onPriority(null)}
      aria-label={t(resourceKind === 'brand-kit' ? 'Preview Brand Kit {title}' : 'Preview template {title}', { title: template.title })}>
      <TemplatePoster key={template.posterUrl} template={template} coverUrl={coverUrl} onCoverAspect={setCoverAspect} />
      {template.previewUrl && <video ref={video} muted playsInline loop preload="none" aria-hidden="true" onPlaying={() => setPlaying(true)} onError={() => { setFailed(true); setPlaying(false); }} style={{ opacity: active && playing ? 1 : 0 }} />}
      {animatedPreview && active && animate && <iframe className="om-gallery-animation" src={animatedPreview} loading="lazy" sandbox="allow-scripts" title={template.title} tabIndex={-1} aria-hidden="true" />}
      <span className="om-gallery-card-shade" />
      <span className="om-gallery-card-top"><span>{t(resourceKind === 'brand-kit' ? 'Brand Kit' : 'Template')}</span>{resourceKind === 'template' && <span>{t(isEditableTemplate(template) ? 'Ready to edit' : template.styles?.[0] || 'Motion design')}</span>}{template.duration != null && <span>{t('{value}s', { value: Number(template.duration.toFixed(1)) })}</span>}</span>
      {!linkedSource && <span className="om-gallery-card-bottom"><TemplateIdentity template={template} /><span className="om-gallery-card-caption"><strong>{template.title}</strong><small>{template.authorName || template.author || template.brand}</small></span><span className="om-gallery-card-arrow"><MotionIcon name="arrow-up-right" size={18} /></span></span>}
    </button>
    </div>
    {linkedSource && <TemplateSourceLink template={template} className="om-gallery-card-source" />}
    {footer}
  </article>;
});
