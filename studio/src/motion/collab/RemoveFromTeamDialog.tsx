import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { Checkbox } from '../../components/ui/Checkbox';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';

export function RemoveFromTeamDialog() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const target = collab?.removeFromTeamTarget ?? null;
  const [skipFutureConfirm, setSkipFutureConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setSkipFutureConfirm(false);
    setBusy(false);
  }, [target?.projectId]);

  if (!collab || !target) return null;

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await collab.removeProjectFromTeam(target.projectId, skipFutureConfirm);
      collab.setRemoveFromTeamTarget(null);
      if (collab.sharingProjectTarget?.projectId === target.projectId) {
        collab.closeProjectSharing();
      }
    } catch (err) {
      collab.notify(err instanceof Error ? err.message : t('Could not remove project from team'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollabDialog
      open={Boolean(target)}
      title={t('Remove from {team}?', { team: target.workspaceName })}
      onClose={() => collab.setRemoveFromTeamTarget(null)}
    >
      <div className="om-collab-tonal-card" data-tone="danger">
        <p className="om-muted" style={{ margin: 0 }}>
          {t(
            '“{title}” will move back to your Personal workspace. Teammates in {team} will immediately lose access, while your files and edit history stay intact.',
            { title: target.title, team: target.workspaceName },
          )}
        </p>
      </div>

      <label className="om-collab-checkbox-row">
        <span className="om-ws-popover-option-main">
          <Checkbox
            aria-label={t("Don't ask again when removing from team")}
            checked={skipFutureConfirm}
            disabled={busy}
            onCheckedChange={checked => setSkipFutureConfirm(checked)}
          />
          <span className="om-muted">{t("Don't ask again when removing from team")}</span>
        </span>
      </label>

      <div className="om-collab-dialog-footer">
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          disabled={busy}
          onClick={() => collab.setRemoveFromTeamTarget(null)}
        >
          {t('Cancel')}
        </Button>
        <Button
          variant="danger"
          type="button"
          disabled={busy}
          onClick={() => void handleConfirm()}
        >
          <RemixIcon name="arrow-go-back-line" size={14} />
          <span>{t(busy ? 'Removing…' : 'Remove from team')}</span>
        </Button>
      </div>
    </CollabDialog>
  );
}
