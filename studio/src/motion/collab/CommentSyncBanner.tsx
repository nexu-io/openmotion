import { useState } from 'react';
import { Button } from 'open-design-ui/button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

export function CommentSyncBanner({
  projectId,
  compact = false,
}: {
  projectId: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const [syncing, setSyncing] = useState(false);

  const snapshot = collab?.snapshot;
  if (!collab || !snapshot?.signedIn || !projectId) return null;

  const active = snapshot.activeWorkspace;
  const projectWsId = snapshot.projectMeta[projectId]?.workspaceId;
  const isTeamProject =
    active?.workspaceType === 'team' ||
    Boolean(projectWsId && snapshot.workspaces.some(w => w.workspaceId === projectWsId && w.workspaceType === 'team'));
  const syncStatus = snapshot.commentSync[projectId];
  const needsSync = syncStatus?.state === 'pending' || syncStatus?.state === 'failed';

  if (!isTeamProject && !needsSync) return null;

  const handleSync = () => {
    if (syncing) return;
    setSyncing(true);
    void collab.retryCommentSync(projectId).finally(() => setSyncing(false));
  };

  if (needsSync) {
    return (
      <div
        className="om-collab-scope-notice"
        data-tone={syncStatus.state === 'failed' ? 'warning' : undefined}
        data-testid="comment-sync-banner"
        role="status"
      >
        <span className="om-collab-scope-notice-copy">
          <RemixIcon name={syncStatus.state === 'failed' ? 'alert-line' : 'refresh-line'} size={14} />
          <span>
            {syncStatus.state === 'failed'
              ? (syncStatus.lastError ? t(syncStatus.lastError) : t('Comment sync failed for {count} items.', { count: Math.max(1, syncStatus.pendingCount) }))
              : t('{count} local review comments pending team sync.', { count: Math.max(1, syncStatus.pendingCount) })}
          </span>
        </span>
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          data-compact="true"
          disabled={syncing}
          onClick={handleSync}
        >
          <RemixIcon name={syncing ? 'loader-4-line' : 'refresh-line'} size={13} />
          <span>{t(syncing ? 'Syncing…' : 'Sync now')}</span>
        </Button>
      </div>
    );
  }

  if (compact) return null;

  const teamName =
    snapshot.workspaces.find(w => w.workspaceId === projectWsId)?.workspaceName ??
    active?.workspaceName ??
    t('Team');

  return (
    <div className="om-collab-scope-notice" data-testid="comment-team-presence">
      <span className="om-collab-scope-notice-copy">
        <RemixIcon name="group-line" size={14} />
        <span>{t('Shared review comments synced with {team}', { team: teamName })}</span>
      </span>
      <span className="om-collab-pill">{t('Synced')}</span>
    </div>
  );
}
