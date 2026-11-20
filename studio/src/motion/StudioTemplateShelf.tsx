import { Button } from 'open-design-ui/button';
import { useState, type ReactNode, type RefObject } from 'react';
import type { TechniqueStudio } from '../../../shared/studio-catalog';
import { Skeleton } from '../components/ui/Skeleton';
import { useI18n, type Locale } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useExploreTemplates } from './ExploreTemplates';
import { TemplateGalleryCard } from './TemplateGalleryCard';
import { useTemplatePlayback } from './useTemplatePlayback';
import { useWorkspaceChrome } from './WorkspaceChromeContext';

const collections = { motion: 'builtin', shorts: 'short-form', marketing: 'ads', explainer: 'all', '3d': 'all' } as const;

// The catalogue searches the localized title, tags and description returned for this locale.
const explainerTerms: Record<Locale, string> = {
  en: 'explain', 'zh-CN': '解释', ja: '説明', ko: '설명', de: 'erklär', fr: 'expli',
  ru: 'объяс', es: 'explic', 'pt-BR': 'explic', it: 'spieg', tr: 'açıkla',
};

export function StudioTemplateShelf({ studio, root, active, navigation }: {
  studio: 'motion' | TechniqueStudio['id']; root: RefObject<HTMLElement | null>; active: boolean; navigation?: ReactNode;
}) {
  const { locale, t } = useI18n();
  const { openLibrary } = useWorkspaceChrome();
  const query = studio === '3d' ? '3D' : studio === 'explainer' ? explainerTerms[locale] : '';
  const templates = useExploreTemplates(collections[studio], locale, query);
  const items = templates.pages.flatMap(page => page.items);
  const [priority, setPriority] = useState<string | null>(null);
  const playing = useTemplatePlayback(root, items.map(item => item.id).join('|'), active, true, priority, true);
  const title = t(studio === 'motion' ? 'Motion templates' : 'Templates');
  const Heading = studio === 'motion' ? 'h1' : 'h2';
  return <section className="om-studio-template-shelf" data-studio={studio} aria-label={title}>
    <header><div className="om-studio-template-heading">{navigation}<Heading className="om-title">{title}</Heading></div>
      <Button variant="ghost" type="button" className="om-button h-auto" onClick={event => openLibrary(event.currentTarget)}>{t('Template library')}<RemixIcon name="arrow-right-line" size={16} /></Button>
    </header>
    <div className="om-studio-template-grid">
      {items.map(item => <TemplateGalleryCard key={item.id} template={item} active={playing.has(item.id)} onPriority={setPriority}
        onSelect={(template, trigger) => openLibrary(trigger, template)} />)}
    </div>
    {templates.loading && <div className="om-studio-template-grid" role="status" aria-label={t('Loading templates…')}>{[0, 1, 2, 3].map(n => <Skeleton key={n} />)}</div>}
    {templates.error ? <div className="om-discovery-empty"><span>{t('Templates could not be loaded.')}</span><Button variant="ghost" className="om-button h-auto" onClick={templates.retry}>{t('Retry')}</Button></div>
      : !templates.loading && (templates.hasMore ? studio !== 'motion' && <Button variant="plain" className="om-button om-shelf-more" onClick={templates.loadMore}>{t('More templates')}<RemixIcon name="arrow-down-line" size={16} /></Button>
      : !items.length && <p className="om-muted">{t('No templates available. Open the library or try again later.')}</p>)}
  </section>;
}
