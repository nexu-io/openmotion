import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import type { PreparedTemplateProject } from './templateHandoff';
import type { GalleryTemplate } from '../../../shared/catalog';
import { MotionIcon } from './icons';
import { useI18n } from '../i18n/I18n';
import styles from './TemplateLibraryDialog.module.css';

const PLUGIN_INSTALL_URL = 'https://releases.open-design.ai/open-motion/install.md';
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

export function TemplateCopiedHandoffCard({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  const handleDismiss = () => { dismissLocalAgentHandoff(); onDismiss(); };
  return <section className={`${styles.handoffSteps} ${styles.copiedHandoff}`} role="status" aria-label={t('Copied — next step in your local Agent')}>
    <div className={styles.copiedHandoffHeader}>
      <strong><MotionIcon name="check" size={14} />{t('Copied — next step in your local Agent')}</strong>
      <IconButton variant="plain" className={styles.copiedHandoffClose} onClick={handleDismiss} aria-label={t('Dismiss')} icon={<MotionIcon name="close" size={14} />} />
    </div>
    <p>{t('Paste into Codex, Claude Code, DeepSeek, or OpenDesign Desktop, and attach your logo or .ai / .svg / image files.')}</p>
    <div className={styles.copiedHandoffFooter}>
      <span>{t('No OpenMotion plugin yet?')}</span>
      <a className="om-text-link" data-quiet href={PLUGIN_INSTALL_URL} target="_blank" rel="noreferrer">{t('30s plugin install guide')}<MotionIcon name="arrow-up-right" size={13} /></a>
      <span className={styles.copiedHandoffDivider} aria-hidden="true">·</span>
      <Button variant="plain" className="om-text-link" data-quiet onClick={handleDismiss}>{t("Already installed, don't show again")}</Button>
    </div>
  </section>;
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
