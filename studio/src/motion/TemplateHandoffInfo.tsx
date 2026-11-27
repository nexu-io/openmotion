import { useEffect, useRef } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import type { PreparedTemplateProject } from './templateHandoff';
import type { GalleryTemplate } from '../../../shared/catalog';
import { cloudInstallGuideUrl } from '../../../shared/integration';
import { newCampaignEntryId } from './campaignAttribution';
import { MotionIcon } from './icons';
import { useI18n } from '../i18n/I18n';
import styles from './TemplateLibraryDialog.module.css';

const HANDOFF_DISMISSED_KEY = 'openmotion.local-agent-handoff.dismissed';

export function hasDismissedLocalAgentHandoff(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(HANDOFF_DISMISSED_KEY) === '1'; }
  catch { return false; }
}

export function dismissLocalAgentHandoff(): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(HANDOFF_DISMISSED_KEY, '1'); }
  catch { /* ignore storage errors */ }
}

export type TemplateOpenProgress = {
  requestId: string; state: 'creating' | 'failed' | 'unknown' | 'ready' | 'opening' | 'open_failed';
  result?: PreparedTemplateProject; error?: string;
};

export function TemplateCopiedHandoffCard({
  onDismiss,
  mode = 'cloud',
  kind = 'template',
  onOpenConnections,
  className,
}: {
  onDismiss: () => void;
  mode?: 'cloud' | 'local';
  kind?: 'template' | 'skill';
  onOpenConnections?: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const installUrl = cloudInstallGuideUrl(typeof location !== 'undefined' ? location.origin : '');
  const handleDismiss = () => { dismissLocalAgentHandoff(); onDismiss(); };
  const isCloud = mode === 'cloud';
  const title = isCloud
    ? t('Copied — next step in your local Agent')
    : t('Copied — next step in your Agent');
  const body = isCloud
    ? t('Paste into Codex, Claude Code, DeepSeek, or OpenDesign Desktop, and attach your logo or .ai / .svg / image files.')
    : kind === 'skill'
      ? t('1. Make sure your Agent is connected to OpenMotion MCP. 2. Paste into your Agent chat and add your topic.')
      : t('Paste into Codex, Claude Code, DeepSeek, or Cursor, attach your materials, and send.');
  return <section className={`${styles.handoffSteps} ${styles.copiedHandoff}${className ? ` ${className}` : ''}`} role="status" aria-label={title}>
    <div className={styles.copiedHandoffHeader}>
      <strong><MotionIcon name="check" size={14} />{title}</strong>
      <IconButton variant="plain" className={styles.copiedHandoffClose} onClick={handleDismiss} aria-label={t('Dismiss')} icon={<MotionIcon name="close" size={14} />} />
    </div>
    <p>{body}</p>
    <div className={styles.copiedHandoffFooter}>
      {isCloud ? <>
        <span>{t('No OpenMotion plugin yet?')}</span>
        <a className="om-text-link" data-quiet href={installUrl} target="_blank" rel="noreferrer">{t('30s plugin install guide')}<MotionIcon name="arrow-up-right" size={13} /></a>
        <span className={styles.copiedHandoffDivider} aria-hidden="true">·</span>
        <Button variant="plain" className="om-text-link" data-quiet onClick={handleDismiss}>{t("Already installed, don't show again")}</Button>
      </> : <>
        <span>{t('Not connected yet?')}</span>
        {onOpenConnections
          ? <Button variant="plain" className="om-text-link" data-quiet onClick={onOpenConnections}>{t('Connect Agent (30s)')}<MotionIcon name="arrow-up-right" size={13} /></Button>
          : <a className="om-text-link" data-quiet href={installUrl} target="_blank" rel="noreferrer">{t('30s plugin install guide')}<MotionIcon name="arrow-up-right" size={13} /></a>}
        <span className={styles.copiedHandoffDivider} aria-hidden="true">·</span>
        <Button variant="plain" className="om-text-link" data-quiet onClick={handleDismiss}>{t("Already connected, don't show again")}</Button>
      </>}
    </div>
  </section>;
}

export function TemplateAiMediaPrepStrip({
  pageName,
  templateId,
  skillId,
  onGenerate,
  className,
}: {
  pageName: 'studio' | 'skills';
  templateId?: string;
  skillId?: string;
  onGenerate: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const entryIdRef = useRef<string>(newCampaignEntryId());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    void import('./tracking').then(({ trackMotion }) => trackMotion('surface_view', {
      page_name: pageName,
      area: 'entitlement_gate',
      element: 'banner',
      hook_id: 'template_prep_ai_media',
      entry_id: entryIdRef.current,
      ...(templateId ? { template_id: templateId } : {}),
      ...(skillId ? { skill_id: skillId } : {}),
    }));
  }, [pageName, templateId, skillId]);
  const handleClick = () => {
    const clickedEntryId = entryIdRef.current;
    entryIdRef.current = newCampaignEntryId();
    if (typeof window !== 'undefined') {
      void import('./tracking').then(({ trackMotion }) => trackMotion('ui_click', {
        page_name: pageName,
        area: 'entitlement_gate',
        element: 'open_assets',
        hook_id: 'template_prep_ai_media',
        entry_id: clickedEntryId,
        ...(templateId ? { template_id: templateId } : {}),
        ...(skillId ? { skill_id: skillId } : {}),
      }));
    }
    onGenerate();
  };
  return <div className={`${styles.aiPrepStrip}${className ? ` ${className}` : ''}`}>
    <span>{t('Need images, clips, or voiceover?')}</span>
    <Button variant="plain" className="om-text-link" onClick={handleClick}><MotionIcon name="sparkles" size={14} />{t('Generate with AI')}</Button>
  </div>;
}

export function TemplateHandoffSteps({ template }: { template: GalleryTemplate }) {
  const { t } = useI18n();
  const headline = template.id === 'motion-be2a4af0-0183-4979-ab05-2a68413c0890';
  const materials = [template.id === 'nyt-graph' ? 'Your data and main takeaway.'
    : headline ? 'Your headline.' : 'Your copy; screenshots or recordings if needed.',
    'Optional: logo, colors and audio.'];
  return <section className={styles.handoffSteps} aria-label={t('After copying')}>
    <strong>{t('After copying')}</strong>
    <ol>
      <li><span>1</span>{t('Paste into your Agent')}</li>
      <li><span>2</span><div className={styles.handoffMaterials}><strong>{t('Add content and send')}</strong>{materials.map(material => <p key={material}>{t(material)}</p>)}</div></li>
      <li><span>3</span>{t('Open the project to edit')}</li>
    </ol>
  </section>;
}

export function TemplateOpenRecovery({ progress, onRetry, onCheck, onOpen }: {
  progress?: TemplateOpenProgress; onRetry: () => void; onCheck: () => void; onOpen: () => void;
}) {
  const { t } = useI18n();
  if (!progress) return null;
  const busy = progress.state === 'creating' || progress.state === 'opening';
  return <section className={styles.handoffRecovery} aria-label={t('This project status')} aria-busy={busy}>
    <strong>{t(progress.state === 'creating' ? 'Creating a separate project…' : progress.state === 'opening' ? 'Opening this project…' : progress.state === 'failed' ? 'Project not created' : progress.state === 'unknown' ? 'Creation result needs checking' : progress.state === 'open_failed' ? 'Project created, preview not opened' : 'This project is ready')}</strong>
    {progress.result && <p>{progress.result.title}<small>{t('Your original project is retained')}</small></p>}
    {progress.error && <p>{progress.error}</p>}
    {progress.state === 'failed' && <Button variant="ghost" className="om-button h-auto" onClick={onRetry}>{t('Retry creation')}</Button>}
    {progress.state === 'unknown' && <><p>{t('Check the original request before creating another project.')}</p><Button variant="ghost" className="om-button h-auto" onClick={onCheck}>{t('Check creation result')}</Button></>}
    {(progress.state === 'ready' || progress.state === 'open_failed') && <Button variant="ghost" className="om-button h-auto" data-primary onClick={onOpen}>{t(progress.state === 'open_failed' ? 'Retry opening this project' : 'Open this project')}<MotionIcon name="arrow-up-right" size={16} /></Button>}
  </section>;
}
