import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { Select } from '../../components/ui/Select';
import { Skeleton } from '../../components/ui/Skeleton';
import type {
  ProjectVisibility,
  WorkspaceMemberRole,
  WorkspaceMembersResponse,
  WorkspaceProjectKind,
} from '../../../../shared/workspace-collab';
import type { WebPublishStatusResponse } from '../../../../shared/web-publish';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { gatewayRequest } from '../gatewayClient';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';
import { CommentSyncBanner } from './CommentSyncBanner';

const kindMeta: Record<WorkspaceProjectKind, { label: string; icon: string }> = {
  motion: { label: 'Motion', icon: 'movie-line' },
  design: { label: 'Design', icon: 'palette-line' },
  game: { label: 'Game', icon: 'gamepad-line' },
};

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

export function ProjectSharingDialog() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const target = collab?.sharingProjectTarget ?? null;
  const snapshot = collab?.snapshot ?? null;

  const teams = (snapshot?.workspaces ?? []).filter(
    w => w.workspaceType === 'team' && w.memberStatus === 'active' && w.lifecycleState === 'active',
  );
  const projectMeta = target ? snapshot?.projectMeta[target.projectId] : undefined;
  const assignedTeam = projectMeta?.workspaceId
    ? snapshot?.workspaces.find(w => w.workspaceId === projectMeta.workspaceId && w.workspaceType === 'team') ?? null
    : null;
  const isInTeam = Boolean(assignedTeam);
  const visibility: ProjectVisibility = projectMeta?.visibility ?? 'workspace';
  const isOwner =
    !isInTeam ||
    !projectMeta?.ownerMemberId ||
    projectMeta.ownerMemberId === assignedTeam?.workspaceMemberId;

  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [busy, setBusy] = useState<'move' | 'visibility' | null>(null);
  const [membersData, setMembersData] = useState<WorkspaceMembersResponse | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [webPublish, setWebPublish] = useState<WebPublishStatusResponse | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const memberScopeWorkspaceId = assignedTeam?.workspaceId ?? (selectedTeamId || teams[0]?.workspaceId || '');

  useEffect(() => {
    if (!target) return;
    const defaultTeam =
      assignedTeam?.workspaceId ??
      (snapshot?.activeWorkspace?.workspaceType === 'team'
        ? snapshot.activeWorkspace.workspaceId
        : teams[0]?.workspaceId ?? '');
    setSelectedTeamId(defaultTeam);
    setBusy(null);
    setCopiedUrl(false);
  }, [target?.projectId, assignedTeam?.workspaceId]);

  useEffect(() => {
    if (!target || !collab || !snapshot?.signedIn || !memberScopeWorkspaceId) {
      setMembersData(null);
      return;
    }
    let cancelled = false;
    setMembersLoading(true);
    collab
      .fetchWorkspaceMembers(memberScopeWorkspaceId)
      .then(res => {
        if (!cancelled) setMembersData(res);
      })
      .catch(() => {
        if (!cancelled) setMembersData(null);
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target?.projectId, memberScopeWorkspaceId, snapshot?.signedIn, collab]);

  useEffect(() => {
    if (!target) {
      setWebPublish(null);
      return;
    }
    const kind = target.kind ?? 'motion';
    let cancelled = false;
    gatewayRequest<WebPublishStatusResponse>(
      `web-publish/${encodeURIComponent(kind)}/${encodeURIComponent(target.projectId)}`,
    )
      .then(res => {
        if (!cancelled) setWebPublish(res);
      })
      .catch(() => {
        if (!cancelled) setWebPublish(null);
      });
    return () => {
      cancelled = true;
    };
  }, [target?.projectId, target?.kind]);

  if (!collab || !target) return null;

  const projectKind = target.kind ?? projectMeta?.kind ?? 'motion';
  const kindInfo = kindMeta[projectKind];
  const resolvedTeam = teams.find(item => item.workspaceId === selectedTeamId) ?? teams[0] ?? null;

  const statusTone = !isInTeam ? undefined : visibility === 'workspace' ? 'accent' : 'warning';
  const statusIcon = !isInTeam ? 'lock-line' : visibility === 'workspace' ? 'group-line' : 'eye-off-line';
  const statusLabel = !isInTeam
    ? t('Personal')
    : visibility === 'workspace'
      ? t('Shared with {team}', { team: assignedTeam!.workspaceName })
      : t('Private in {team}', { team: assignedTeam!.workspaceName });

  const handleShareToTeam = async () => {
    if (!resolvedTeam || busy) return;
    setBusy('move');
    try {
      await collab.moveProjectToTeam(target.projectId, resolvedTeam.workspaceId, false, {
        kind: projectKind,
        title: target.title,
      });
    } catch (err) {
      collab.notify(err instanceof Error ? err.message : t('Could not move project'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleVisibilityChange = async (nextVisibility: ProjectVisibility) => {
    if (busy || nextVisibility === visibility) return;
    setBusy('visibility');
    try {
      await collab.setProjectVisibility(target.projectId, nextVisibility);
    } catch (err) {
      collab.notify(err instanceof Error ? err.message : t('Could not update visibility'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const copyLiveUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(true);
      collab.notify(t('Share link copied'), 'info');
      setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      collab.notify(t('Could not copy link'), 'error');
    }
  };

  const members = membersData?.members ?? [];
  const totalMemberCount =
    membersData?.totalCount ?? assignedTeam?.memberCount ?? resolvedTeam?.memberCount ?? members.length;
  const activePublication = webPublish?.active?.status === 'published' && webPublish.active.url
    ? webPublish.active
    : null;

  return (
    <CollabDialog
      open={Boolean(target)}
      title={target.title}
      onClose={collab.closeProjectSharing}
      className="om-collab-dialog-wide"
    >
      <div className="om-collab-dialog-meta-row" data-testid="project-sharing-status">
        <span className="om-collab-pill">
          <RemixIcon name={kindInfo.icon} size={12} />
          <span>{t(kindInfo.label)}</span>
        </span>
        <span className="om-collab-pill" data-tone={statusTone}>
          <RemixIcon name={statusIcon} size={12} />
          <span>{statusLabel}</span>
        </span>
      </div>

      {/* Section 1: Team sharing & visibility / removal */}
      <section className="om-collab-tonal-card" aria-label={t('Team collaboration')}>
        <div className="om-collab-section-head">
          <strong>{t('Team sharing')}</strong>
          {isInTeam && assignedTeam && (
            <span className="om-muted" style={{ fontSize: 'var(--motion-text-xs)' }}>
              {isOwner
                ? t('Created by You')
                : projectMeta?.ownerName
                  ? t('Created by {name}', { name: projectMeta.ownerName })
                  : t('Shared project')}
            </span>
          )}
        </div>

        {!snapshot?.signedIn ? (
          <p className="om-muted" style={{ margin: 0 }}>
            {t('Sign in with OpenDesign to share projects with a team workspace.')}
          </p>
        ) : !isInTeam ? (
          teams.length > 0 && resolvedTeam ? (
            <>
              <p className="om-muted" style={{ margin: 0 }}>
                {t('Only you can access this project right now. Share it to {team} so teammates can view and comment.', {
                  team: resolvedTeam.workspaceName,
                })}
              </p>
              <div className="om-collab-control-pair">
                {teams.length > 1 && (
                  <Select
                    label={t('Destination workspace')}
                    value={resolvedTeam.workspaceId}
                    disabled={Boolean(busy)}
                    options={teams.map(team => ({ value: team.workspaceId, label: team.workspaceName }))}
                    onCommit={setSelectedTeamId}
                  />
                )}
                <Button
                  variant="primary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void handleShareToTeam()}
                >
                  <RemixIcon name="group-line" size={14} />
                  <span>{t(busy === 'move' ? 'Sharing…' : 'Share to team')}</span>
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="om-muted" style={{ margin: 0 }}>
                {t('Create or join a team workspace in OpenDesign Cloud to collaborate on projects together.')}
              </p>
              <div>
                <Button
                  variant="plain"
                  type="button"
                  className="om-collab-tonal-btn"
                  onClick={() => void collab.openCloudLink('create-workspace')}
                >
                  <span>{t('Create team workspace')}</span>
                  <RemixIcon name="external-link-line" size={13} />
                </Button>
              </div>
            </>
          )
        ) : (
          <>
            <p className="om-muted" style={{ margin: 0 }}>
              {t('Control whether teammates in {team} can view and collaborate.', {
                team: assignedTeam!.workspaceName,
              })}
            </p>
            <div className="om-collab-control-pair">
              <Select
                label={t('Workspace access')}
                value={visibility}
                disabled={Boolean(busy) || !isOwner}
                options={[
                  { value: 'workspace', label: t('Workspace members ({team})', { team: assignedTeam!.workspaceName }) },
                  { value: 'private', label: t('Only you') },
                ]}
                onCommit={next => void handleVisibilityChange(next as ProjectVisibility)}
              />
              {isOwner && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-collab-tonal-btn om-collab-danger-tonal-btn"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    collab.requestRemoveFromTeam({
                      id: target.projectId,
                      title: target.title,
                      workspaceName: assignedTeam!.workspaceName,
                    })
                  }
                >
                  <RemixIcon name="arrow-go-back-line" size={14} />
                  <span>{t('Remove from team')}</span>
                </Button>
              )}
            </div>
            {!isOwner && (
              <p className="om-muted" style={{ margin: 0, fontSize: 'var(--motion-text-xs)' }}>
                {t('Only the project creator can change visibility or remove it from the team.')}
              </p>
            )}
            <CommentSyncBanner projectId={target.projectId} compact />
          </>
        )}
      </section>

      {/* Section 2: Collaborators */}
      {snapshot?.signedIn && (isInTeam || teams.length > 0) && (
        <section className="om-collab-tonal-card" aria-label={t('Collaborators')}>
          <div className="om-collab-section-head">
            <strong>
              {isInTeam
                ? t('Collaborators ({count})', { count: totalMemberCount })
                : t('Team collaborators ({count})', { count: totalMemberCount })}
            </strong>
            <div className="om-collab-inline-actions">
              {snapshot.permissions.canInviteMembers && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-collab-tonal-btn"
                  data-size="compact"
                  onClick={() => collab.setInviteDialogOpen(true)}
                >
                  <RemixIcon name="group-line" size={13} />
                  <span>{t('Invite')}</span>
                </Button>
              )}
              {(isInTeam ? assignedTeam?.role !== 'member' : snapshot.permissions.canManageWorkspace) && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-collab-tonal-btn"
                  data-size="compact"
                  onClick={() => void collab.openCloudLink('members', memberScopeWorkspaceId)}
                >
                  <span>{t('Manage in Cloud')}</span>
                  <RemixIcon name="external-link-line" size={12} />
                </Button>
              )}
            </div>
          </div>

          {membersLoading && members.length === 0 ? (
            <div className="om-collab-member-list">
              {[0, 1].map(idx => (
                <Skeleton key={idx} style={{ height: 36, borderRadius: 'var(--motion-radius-md)' }} />
              ))}
            </div>
          ) : members.length > 0 ? (
            <ul className="om-collab-member-list om-collab-member-list-compact">
              {members.map(member => {
                const accessHint = !isInTeam
                  ? t('No access until shared')
                  : visibility === 'private' && !member.isCurrentUser && member.memberId !== projectMeta?.ownerMemberId
                    ? t('Hidden while private')
                    : member.role === 'owner'
                      ? t('Full access')
                      : t('Can view & comment');
                return (
                  <li key={member.memberId} className="om-collab-member-row">
                    <span className="om-collab-member-avatar" aria-hidden="true">
                      {memberInitial(member.name)}
                    </span>
                    <div className="om-collab-member-copy">
                      <span className="om-collab-member-name">
                        <strong>{member.name}</strong>
                        {member.isCurrentUser && <span className="om-collab-pill">{t('You')}</span>}
                      </span>
                      <span className="om-collab-member-email">{accessHint}</span>
                    </div>
                    <span className="om-collab-pill" data-tone={member.role === 'owner' ? 'accent' : undefined}>
                      {t(roleLabels[member.role])}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="om-muted" style={{ margin: 0, fontSize: 'var(--motion-text-xs)' }}>
              {t('Members in this workspace will appear here.')}
            </p>
          )}
          <p className="om-muted" style={{ margin: 0, fontSize: 'var(--motion-text-xs)' }}>
            {t('Member roles and team removal are managed in OpenDesign Cloud.')}
          </p>
        </section>
      )}

      {/* Section 3: Public Web Link distinction */}
      <section className="om-collab-tonal-card" aria-label={t('Public share link')}>
        <div className="om-collab-section-head">
          <strong>{t('Public share link')}</strong>
          {activePublication ? (
            <span className="om-collab-pill" data-tone="accent">
              <RemixIcon name="cloud-line" size={12} />
              <span>{t('Live link')}</span>
            </span>
          ) : (
            <span className="om-collab-pill">{t('Not published')}</span>
          )}
        </div>
        {activePublication?.url ? (
          <div className="om-collab-control-pair">
            <span className="om-muted truncate" style={{ flex: 1, fontSize: 'var(--motion-text-xs)' }} title={activePublication.url}>
              {activePublication.url}
            </span>
            <Button
              variant="plain"
              type="button"
              className="om-collab-tonal-btn"
              data-size="compact"
              onClick={() => void copyLiveUrl(activePublication.url!)}
            >
              <RemixIcon name={copiedUrl ? 'check-line' : 'link'} size={13} />
              <span>{t(copiedUrl ? 'Share link copied' : 'Copy link')}</span>
            </Button>
          </div>
        ) : (
          <p className="om-muted" style={{ margin: 0, fontSize: 'var(--motion-text-xs)' }}>
            {t('Team sharing keeps work inside your workspace. Use Share in the editor to publish a public preview link.')}
          </p>
        )}
      </section>
    </CollabDialog>
  );
}
