import type { RefObject } from 'react';
import { IconButton } from 'open-design-ui/icon-button';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { MotionIcon } from '../motion/icons';
import { DesignProjectList } from './DesignProjectList';

export function DesignProjectSidebar({ navigationId, closeRef, refreshKey, onProjectsChanged, onClose, onOpen }: {
  navigationId: string;
  closeRef: RefObject<HTMLButtonElement | null>;
  refreshKey: number;
  onProjectsChanged: () => void;
  onClose: () => void;
  onOpen: (projectId: string) => void;
}) {
  const { t } = useI18n();

  return <aside className="motion-sidebar" aria-label={t('Workspace navigation')}>
    <div className="motion-sidebar-brand">
      <strong className="om-subtitle">{t('Workspace')}</strong>
      <Tooltip label={t('Close project list')} wrap>
        <IconButton ref={closeRef} type="button" variant="ghost" className="motion-icon-button"
          aria-label={t('Close project list')} aria-controls={navigationId} aria-expanded
          icon={<MotionIcon name="sidebar" size={16} />} onClick={onClose} />
      </Tooltip>
    </div>
    <DesignProjectList layout="sidebar" refreshKey={refreshKey} onProjectsChanged={onProjectsChanged} onOpen={onOpen} />
  </aside>;
}
