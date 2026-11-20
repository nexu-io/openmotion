import { useRef } from 'react';
import { useI18n } from '../i18n/I18n';
import { StudioTemplateShelf } from './StudioTemplateShelf';
import { useWorkspaceChrome } from './WorkspaceChromeContext';

export function MotionStudioPage({ active }: { active: boolean }) {
  const { t, locale } = useI18n();
  const { projectNavigation } = useWorkspaceChrome();
  const root = useRef<HTMLElement>(null);
  return <main ref={root} className="om-explore" aria-label={t('Motion templates')}>
    <div className="om-discovery-page">
    <StudioTemplateShelf key={locale} studio="motion" root={root} active={active} navigation={projectNavigation} />
  </div></main>;
}
