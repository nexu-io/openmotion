import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Select } from '../../components/ui/Select';
import { useI18n } from '../../i18n/I18n';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';

export function MoveToTeamDialog() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const target = collab?.moveToTeamTarget ?? null;
  const teams = (collab?.snapshot?.workspaces ?? []).filter(
    w => w.workspaceType === 'team' && w.memberStatus === 'active' && w.lifecycleState === 'active',
  );

  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [skipFutureConfirm, setSkipFutureConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    const preferred =
      collab?.snapshot?.activeWorkspace?.workspaceType === 'team'
        ? collab.snapshot.activeWorkspace.workspaceId
        : teams[0]?.workspaceId ?? '';
    setSelectedTeamId(preferred);
    setSkipFutureConfirm(false);
    setBusy(false);
  }, [target?.projectId]);

  if (!collab || !target) return null;
  const resolvedTeam = teams.find(item => item.workspaceId === selectedTeamId) ?? teams[0];

  const handleConfirm = async () => {
    if (!resolvedTeam || busy) return;
    setBusy(true);
    try {
      await collab.moveProjectToTeam(target.projectId, resolvedTeam.workspaceId, skipFutureConfirm, {
        kind: target.kind,
        title: target.title,
      });
      collab.setMoveToTeamTarget(null);
    } catch (err) {
      collab.notify(err instanceof Error ? err.message : t('Could not move project'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollabDialog
      open={Boolean(target)}
      title={t('Move project to team workspace')}
      onClose={() => collab.setMoveToTeamTarget(null)}
    >
      <p className="om-muted">
        {t(
          'Move “{title}” into {team}? Active team members can view and collaborate on this project.',
          { title: target.title, team: resolvedTeam?.workspaceName ?? t('team workspace') },
        )}
      </p>

      {teams.length > 1 && resolvedTeam && (
        <label className="om-label">
          <span>{t('Destination workspace')}</span>
          <Select
            label={t('Destination workspace')}
            value={resolvedTeam.workspaceId}
            disabled={busy}
            options={teams.map(team => ({ value: team.workspaceId, label: team.workspaceName }))}
            onCommit={setSelectedTeamId}
          />
        </label>
      )}

      <label className="om-collab-checkbox-row">
        <span className="om-ws-popover-option-main">
          <Checkbox
            aria-label={t("Don't ask again when moving projects")}
            checked={skipFutureConfirm}
            disabled={busy}
            onCheckedChange={checked => setSkipFutureConfirm(checked)}
          />
          <span className="om-muted">{t("Don't ask again when moving projects")}</span>
        </span>
      </label>

      <div className="om-collab-dialog-footer">
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          disabled={busy}
          onClick={() => collab.setMoveToTeamTarget(null)}
        >
          {t('Cancel')}
        </Button>
        <Button
          variant="primary"
          type="button"
          disabled={busy || !resolvedTeam}
          onClick={() => void handleConfirm()}
        >
          {t(busy ? 'Moving…' : 'Move to team')}
        </Button>
      </div>
    </CollabDialog>
  );
}
