import { Tooltip } from "../components/ui/Tooltip";
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { isEditableTemplate, type GalleryTemplate, type TemplatePage } from '../../../shared/catalog';
import { useI18n } from '../i18n/I18n';
import { Tabs, TabsList, Tab, TabPanel } from '../components/ui/Tabs';
import { Skeleton } from '../components/ui/Skeleton';
import { RemixIcon } from '../icons/RemixIcons';
import { TemplateGalleryCard } from './TemplateGalleryCard';
import { purposeOrder, discoveryPurposes } from './templateDiscoveryTaxonomy';
import { useTemplatePlayback } from './useTemplatePlayback';
import { motionApi } from './useWorkspace';

export function McpTemplateShowcase({ scroller, enabled, canCopy, onCopy, openLibrary }: {
  scroller: RefObject<HTMLElement | null>; enabled: boolean; canCopy: boolean;
  onCopy: (template: GalleryTemplate) => void;
  openLibrary: (trigger?: HTMLElement, templateId?: string) => void;
}) {
  const { t, locale } = useI18n();
  const [catalog, setCatalog] = useState<GalleryTemplate[] | null>(null);
  const [failed, setFailed] = useState(false), [attempt, retry] = useState(0);
  const [category, setCategory] = useState('all');
  const [priority, setPriority] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null); setFailed(false);
    void (async () => {
      const items: GalleryTemplate[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: TemplatePage = await motionApi(`/template-catalog?category=all&covered=true&limit=60&offset=${offset}&locale=${encodeURIComponent(locale)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
        if (!Array.isArray(page.items)) throw new Error('Invalid catalogue');
        items.push(...page.items);
        if (page.next != null && (!Number.isSafeInteger(page.next) || page.next <= offset)) throw new Error('Invalid catalogue cursor');
        offset = page.next ?? null;
      }
      if (!controller.signal.aborted) setCatalog([...new Map(items.map(item => [item.id, item])).values()]);
    })().catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [locale, attempt]);
  const categories = useMemo(() => ['all', ...purposeOrder.filter(purpose => catalog?.some(item => discoveryPurposes(item).includes(purpose)))], [catalog]);
  const selected = categories.includes(category) ? category : 'all';
  const visible = useMemo(() => (catalog ?? []).filter(item => selected === 'all' || discoveryPurposes(item).includes(selected)).slice(0, 6), [catalog, selected]);
  const active = useTemplatePlayback(scroller, `${selected}:${visible.map(item => item.id).join(',')}`, enabled, true, priority);
  return <section className="om-mcp-section" aria-labelledby="mcp-templates" id="mcp-template-section">
    <div className="om-mcp-section-heading"><div><p className="om-mcp-eyebrow">{t('Start with something you can build on')}</p><h2 id="mcp-templates">{t('Bring a template into your Agent')}</h2><p className="om-muted">{t('Use an editable template or ask your Agent to recreate a reference. Preview here, copy the instruction, or open the full library.')}</p></div><button className="om-button" onClick={event => openLibrary(event.currentTarget)}>{t('View all templates')}<RemixIcon name="arrow-right-line" size={16} /></button></div>
    <Tabs value={selected} onValueChange={value => { setCategory(String(value)); setPriority(null); }}>
      <div className="om-mcp-template-toolbar"><TabsList className="om-mcp-category-tabs" aria-label={t('Template categories')}>{categories.map(value => <Tab key={value} value={value}>{t(value === 'all' ? 'Featured' : value)}</Tab>)}</TabsList></div>
      <TabPanel value={selected}>
        {failed ? <div className="om-card om-mcp-unavailable"><p>{t('Templates could not be loaded.')}</p><button className="om-button" onClick={() => retry(value => value + 1)}>{t('Retry')}</button></div> : <div className="om-mcp-template-grid">{catalog === null ? [1, 2, 3, 4, 5, 6].map(key => <Skeleton key={key} className="om-mcp-template-skeleton" />) : visible.map(template => <TemplateGalleryCard key={template.id} template={template} active={active.has(template.id)} onPriority={setPriority} onSelect={(item, trigger) => openLibrary(trigger, item.id)} footer={<div className="om-mcp-template-caption"><div><h3>{template.title}</h3><span>{t(isEditableTemplate(template) ? 'Ready to edit' : 'Reference · Agent recreation')}</span></div><Tooltip label={t('Copy template prompt')} wrap><button className="om-button" disabled={!canCopy} aria-label={t('Copy template prompt')} onClick={() => onCopy(template)}><RemixIcon name="file-copy-line" size={16} /></button></Tooltip></div>} />)}</div>}
        {catalog?.length === 0 && <div className="om-mcp-unavailable"><p className="om-muted">{t('No templates available. Open the library or try again later.')}</p><button className="om-button" onClick={event => openLibrary(event.currentTarget)}>{t('Explore templates')}</button></div>}
      </TabPanel>
    </Tabs>
  </section>;
}
