import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { openExternalUrl } from '../../utils/platformHost';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';
import { useOptionalGrowthSurfaces } from './GrowthSurfacesContext';

export function PriorityAnnouncementDialog() {
  const { t } = useI18n();
  const growth = useOptionalGrowthSurfaces();
  const collab = useOptionalWorkspaceCollab();
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState(false);

  const open = Boolean(growth?.priorityAnnouncementOpen && growth.priorityMessage);
  const message = growth?.priorityMessage ?? null;

  useEffect(() => {
    if (!open) {
      setConfirming(false);
      setConfirmError(false);
    }
  }, [open, message?.id]);

  if (!growth || !open || !message) return null;

  const dismiss = async () => {
    if (confirming) return;
    setConfirming(true);
    setConfirmError(false);
    try {
      await growth.markMessageRead(message.id);
    } catch {
      setConfirmError(true);
    } finally {
      setConfirming(false);
    }
  };

  const viewPlans = async () => {
    if (confirming) return;
    setConfirming(true);
    setConfirmError(false);
    try {
      if (message.ctaUrl) {
        void openExternalUrl(message.ctaUrl);
      } else {
        await collab?.openCloudLink('plans');
      }
      await growth.markMessageRead(message.id);
    } catch {
      setConfirmError(true);
    } finally {
      setConfirming(false);
    }
  };

  const paragraphs = message.body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  return (
    <CollabDialog
      open
      title={message.title}
      onClose={() => void dismiss()}
      className="om-collab-dialog-wide"
    >
      <div className="om-collab-tonal-card" data-tone="warning" data-testid="priority-announcement-dialog">
        <div className="om-collab-dialog-meta-row">
          <span className="om-collab-pill" data-tone="warning">
            <RemixIcon name="notification-3-line" size={13} />
            <span>{t('Plan update')}</span>
          </span>
        </div>
        {paragraphs.length > 0 ? (
          <div className="om-priority-announcement-copy">
            {paragraphs.map((line, index) => (
              <p key={index} className="om-collab-dialog-copy">
                {line}
              </p>
            ))}
          </div>
        ) : (
          <p className="om-collab-dialog-copy">{message.body}</p>
        )}
      </div>

      {confirmError && (
        <div className="om-collab-tonal-card" data-tone="danger">
          <p className="om-collab-dialog-copy">{t('Could not confirm notice. Try again.')}</p>
        </div>
      )}

      <div className="om-collab-dialog-footer">
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          disabled={confirming}
          data-testid="priority-announcement-ack"
          onClick={() => void dismiss()}
        >
          <span>{t('Got it')}</span>
        </Button>
        <Button
          variant="primary"
          type="button"
          disabled={confirming}
          data-testid="priority-announcement-cta"
          onClick={() => void viewPlans()}
        >
          <span>{message.ctaLabel || t('View plans')}</span>
          <RemixIcon name="external-link-line" size={14} />
        </Button>
      </div>
    </CollabDialog>
  );
}
