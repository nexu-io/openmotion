import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { Skeleton } from '../../components/ui/Skeleton';
import type { WorkspaceMemberRole, WorkspaceMembersResponse } from '../../../../shared/workspace-collab';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';

const roleLabels: Record<WorkspaceMemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

const avatarSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function memberInitial(name: string): string {
  const first = avatarSegmenter.segment(name.trim() || 'M')[Symbol.iterator]().next().value?.segment;
  return (first || 'M').toUpperCase();
}

export function TeamMembersDialog() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const open = Boolean(collab?.teamMembersDialogOpen);
  const activeWs = collab?.snapshot?.activeWorkspace;
  const targetTeam =
    activeWs?.workspaceType === 'team'
      ? activeWs
      : collab?.snapshot?.workspaces.find(w => w.workspaceType === 'team') ?? activeWs ?? null;

  const [data, setData] = useState<WorkspaceMembersResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (wsId?: string) => {
    if (!collab) return;
    setLoading(true);
    try {
      const res = await collab.fetchWorkspaceMembers(wsId);
      setData(res);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !targetTeam?.workspaceId) return;
    void load(targetTeam.workspaceId);
  }, [open, targetTeam?.workspaceId]);

  if (!collab || !open) return null;

  const members = data?.members ?? [];
  const totalCount = data?.totalCount ?? targetTeam?.memberCount ?? members.length;
  const canInvite = Boolean(data?.canInviteMembers ?? collab.snapshot?.permissions.canInviteMembers);
  const canManageCloud = Boolean(data?.canManageMembersInCloud ?? collab.snapshot?.permissions.canManageWorkspace);

  return (
    <CollabDialog
      open={open}
      title={t('Collaborators · {name}', { name: data?.workspaceName ?? targetTeam?.workspaceName ?? t('Team') })}
      onClose={() => collab.setTeamMembersDialogOpen(false)}
      className="om-collab-dialog-wide"
    >
      <div className="om-collab-dialog-meta-row">
        <span className="om-collab-pill" data-tone="accent">
          <RemixIcon name="group-line" size={12} />
          <span>{t('{count} teammates', { count: totalCount })}</span>
        </span>
        <span className="om-muted" style={{ fontSize: 'var(--motion-text-xs)' }}>
          {t('Workspace members share projects, assets, and Brand Kits.')}
        </span>
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={t('Refresh collaborators')}
          disabled={loading}
          onClick={() => void load(targetTeam?.workspaceId)}
          icon={
            <RemixIcon
              name={loading ? 'loader-4-line' : 'refresh-line'}
              size={14}
              className={loading ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
          }
        />
      </div>

      <div className="om-collab-tonal-card">
        {loading && members.length === 0 ? (
          <div className="om-collab-member-list">
            {[0, 1, 2].map(idx => (
              <Skeleton key={idx} style={{ height: 40, borderRadius: 'var(--motion-radius-md)' }} />
            ))}
          </div>
        ) : members.length === 0 ? (
          <p className="om-muted" style={{ margin: 0 }}>{t('No workspace collaborators loaded yet.')}</p>
        ) : (
          <ul className="om-collab-member-list" aria-label={t('Workspace collaborators')}>
            {members.map(member => (
              <li key={member.memberId} className="om-collab-member-row">
                <span className="om-collab-member-avatar" aria-hidden="true">
                  {memberInitial(member.name)}
                </span>
                <div className="om-collab-member-copy">
                  <span className="om-collab-member-name">
                    <strong>{member.name}</strong>
                    {member.isCurrentUser && <span className="om-collab-pill">{t('You')}</span>}
                  </span>
                  {member.email && <span className="om-collab-member-email">{member.email}</span>}
                </div>
                <span className="om-collab-pill" data-tone={member.role === 'owner' ? 'accent' : undefined}>
                  {t(roleLabels[member.role])}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data?.source === 'fallback' && totalCount > members.length && (
        <p className="om-muted" style={{ margin: 0, fontSize: 'var(--motion-text-xs)' }}>
          {t('Some teammate profiles are managed in OpenDesign Cloud.')}
        </p>
      )}

      <div className="om-collab-dialog-footer">
        {canManageCloud && (
          <Button
            variant="plain"
            type="button"
            className="om-collab-tonal-btn"
            onClick={() => void collab.openCloudLink('members', targetTeam?.workspaceId)}
          >
            <span>{t('Manage members in Cloud')}</span>
            <RemixIcon name="external-link-line" size={13} />
          </Button>
        )}
        {canInvite && (
          <Button
            variant="primary"
            type="button"
            onClick={() => {
              collab.setTeamMembersDialogOpen(false);
              collab.setInviteDialogOpen(true);
            }}
          >
            <RemixIcon name="group-line" size={14} />
            <span>{t('Invite teammates')}</span>
          </Button>
        )}
      </div>
    </CollabDialog>
  );
}
