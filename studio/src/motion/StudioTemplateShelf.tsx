import { Button } from 'open-design-ui/button';
import { useState, type RefObject } from 'react';
import type { TechniqueStudio } from '../../../shared/studio-catalog';
import { Skeleton } from '../components/ui/Skeleton';
import { useI18n, type Locale } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useExploreTemplates } from './ExploreTemplates';
import { TemplateGalleryCard } from './TemplateGalleryCard';
import { useTemplatePlayback } from './useTemplatePlayback';
import { useLoadMoreOnScroll } from './useLoadMoreOnScroll';
import { useWorkspaceChrome } from './WorkspaceChromeContext';

const collections = { shorts: 'short-form', marketing: 'ads', explainer: 'all', '3d': 'all', game: 'all' } as const;

// The catalogue searches the localized title, tags and description returned for this locale.
const explainerTerms: Record<Locale, string> = {
  en: 'explain', 'zh-CN': '解释', ja: '説明', ko: '설명', de: 'erklär', fr: 'expli',
  ru: 'объяс', es: 'explic', 'pt-BR': 'explic', it: 'spieg', tr: 'açıkla',
};

// The localized 3D motion tag. Matching the tag itself keeps out templates whose ids merely contain "3d".
const threeDimensionalTags: Record<Locale, string> = {
  en: '3D animation', 'zh-CN': '三维动效', ja: '3Dアニメーション', ko: '3D 애니메이션', de: '3D-Animation', fr: 'Animation 3D',
  ru: '3D-анимация', es: 'Animación 3D', 'pt-BR': 'Animação 3D', it: 'Animazione 3D', tr: '3B animasyon',
};
const shelfSize = 8;

export function StudioTemplateShelf({ studio, root, active }: {
  studio: TechniqueStudio['id']; root: RefObject<HTMLElement | null>; active: boolean;
}) {
  const { locale, t } = useI18n();
  const { openLibrary } = useWorkspaceChrome();
  const tag = studio === '3d' ? threeDimensionalTags[locale] : null;
  const query = tag ?? (studio === 'explainer' ? explainerTerms[locale] : '');
  // 3D loads every tag match at once (the catalogue's 60-item page) and reveals eight at a time.
  const templates = useExploreTemplates(collections[studio], locale, query, tag ? 60 : shelfSize);
  const [shown, setShown] = useState(shelfSize);
  const loaded = templates.pages.flatMap(page => page.items);
  const matching = tag ? loaded.filter(item => item.tags.includes(tag)) : loaded;
  const items = tag ? matching.slice(0, shown) : matching;
  const hasMore = tag ? matching.length > shown || templates.hasMore : templates.hasMore;
  const loadMore = () => tag && matching.length > shown ? setShown(count => count + shelfSize) : templates.loadMore();
  const [priority, setPriority] = useState<string | null>(null);
  // Further templates load as the user scrolls toward the end of the shelf; never while a page is in flight or after an error.
  const { sentinel, observing } = useLoadMoreOnScroll(root, hasMore && !templates.loading && !templates.error, loadMore, `${loaded.length}:${shown}`);
  const playing = useTemplatePlayback(root, items.map(item => item.id).join('|'), active, true, priority, true);
  const title = t('Templates');
  return <section className="om-studio-template-shelf" data-studio={studio} aria-label={title}>
    <header><h2 className="om-title">{title}</h2>
      <Button variant="ghost" type="button" className="om-button h-auto" onClick={event => openLibrary(event.currentTarget)}>{t('Template library')}<RemixIcon name="arrow-right-line" size={16} /></Button>
    </header>
    <div className="om-studio-template-grid">
      {items.map(item => <TemplateGalleryCard key={item.id} template={item} active={playing.has(item.id)} onPriority={setPriority}
        onSelect={(template, trigger) => openLibrary(trigger, template)} />)}
    </div>
    {items.length > 0 && <span className="sr-only" aria-live="polite">{t('{count} templates', { count: items.length })}</span>}
    {templates.loading && <div className="om-studio-template-grid" role="status" aria-label={t('Loading templates…')}>{[0, 1, 2, 3].map(n => <Skeleton key={n} />)}</div>}
    {templates.error ? <div className="om-discovery-empty"><span>{t('Templates could not be loaded.')}</span><Button variant="ghost" className="om-button h-auto" onClick={templates.retry}>{t('Retry')}</Button></div>
      : hasMore ? (observing ? <div ref={sentinel} className="om-shelf-sentinel" aria-hidden="true" />
        : !templates.loading && <Button variant="plain" className="om-button om-shelf-more" onClick={loadMore}>{t('More templates')}<RemixIcon name="arrow-down-s-line" size={16} /></Button>)
      : !templates.loading && !items.length && <p className="om-muted">{t('No templates available. Open the library or try again later.')}</p>}
  </section>;
}
