import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { Select } from '../../components/ui/Select';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import {
  buildWorkspacePermissions,
  isValidInviteEmail,
  type WorkspaceInviteRole,
  type WorkspaceInviteRowResult,
} from '../../../../shared/workspace-collab';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';

type InviteDraftRow = {
  id: string;
  email: string;
  role: WorkspaceInviteRole;
  idempotencyKey: string;
  result?: WorkspaceInviteRowResult;
};

function makeEmptyRow(): InviteDraftRow {
  return {
    id: crypto.randomUUID(),
    email: '',
    role: 'member',
    idempotencyKey: crypto.randomUUID(),
  };
}

export function HeaderInviteTrigger() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const active = collab?.snapshot?.activeWorkspace;
  if (
    !collab ||
    !collab.snapshot?.signedIn ||
    active?.workspaceType !== 'team' ||
    !collab.snapshot.permissions.canInviteMembers
  ) {
    return null;
  }

  return (
    <Button
      variant="plain"
      type="button"
      className="om-ws-header-cta"
      data-testid="header-invite-trigger"
      aria-label={t('Invite')}
      onClick={() => collab.setInviteDialogOpen(true)}
    >
      <RemixIcon name="group-line" size={14} />
      <span className="om-ws-header-cta-label">{t('Invite')}</span>
    </Button>
  );
}

export function InviteMembersDialog() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const open = Boolean(collab?.inviteDialogOpen);
  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;

  const invitableTeams = (snapshot?.workspaces ?? []).filter(
    ws => ws.workspaceType === 'team' && buildWorkspacePermissions(ws).canInviteMembers,
  );
  const defaultTargetId =
    active?.workspaceType === 'team' && buildWorkspacePermissions(active).canInviteMembers
      ? active.workspaceId
      : invitableTeams[0]?.workspaceId ?? active?.workspaceId ?? '';

  const [targetWorkspaceId, setTargetWorkspaceId] = useState(defaultTargetId);
  const [rows, setRows] = useState<InviteDraftRow[]>(() => [makeEmptyRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTargetWorkspaceId(defaultTargetId);
      setRows([makeEmptyRow()]);
      setFormError(null);
      setSubmitting(false);
    }
  }, [open, defaultTargetId]);

  if (!collab || !active) return null;

  const targetWorkspace =
    invitableTeams.find(ws => ws.workspaceId === targetWorkspaceId) ??
    (active.workspaceType === 'team' && buildWorkspacePermissions(active).canInviteMembers ? active : invitableTeams[0] ?? null);
  const targetPerms = targetWorkspace ? buildWorkspacePermissions(targetWorkspace) : null;
  const canInviteAdmins = Boolean(targetPerms?.canInviteAdmins);
  const referral = snapshot?.referral ?? null;

  const roleOptions = canInviteAdmins
    ? [
        { value: 'member', label: t('Member') },
        { value: 'admin', label: t('Admin') },
      ]
    : [{ value: 'member', label: t('Member') }];

  const pendingOrRetryableRows = rows.filter(row => !row.result?.ok && row.email.trim());
  const hasFailures = rows.some(row => row.result && !row.result.ok);
  const allSent = rows.some(row => row.result?.ok) && rows.every(row => !row.email.trim() || row.result?.ok);

  const handleSubmit = async (onlyFailed = false) => {
    setFormError(null);
    const targets = rows.filter(row => {
      if (row.result?.ok) return false;
      if (onlyFailed) return Boolean(row.result && !row.result.ok && row.email.trim());
      return Boolean(row.email.trim());
    });
    if (!targets.length) {
      setFormError(t('Enter at least one teammate email address.'));
      return;
    }

    const seen = new Set<string>();
    let hasClientError = false;
    const validatedRows = rows.map(row => {
      if (row.result?.ok || !row.email.trim()) return row;
      if (onlyFailed && !row.result) return row;
      const email = row.email.trim().toLowerCase();
      if (!isValidInviteEmail(email)) {
        hasClientError = true;
        return {
          ...row,
          result: { email, role: row.role, ok: false, error: 'invalid_email', message: 'Enter a valid email address.' },
        };
      }
      if (seen.has(email)) {
        hasClientError = true;
        return {
          ...row,
          result: { email, role: row.role, ok: false, error: 'duplicate_email', message: 'Duplicate email in this list.' },
        };
      }
      seen.add(email);
      return { ...row, email, result: undefined };
    });

    if (hasClientError) {
      setRows(validatedRows);
      return;
    }

    setSubmitting(true);
    try {
      const payloadRows = targets.map(item => ({
        email: item.email.trim().toLowerCase(),
        role: canInviteAdmins ? item.role : ('member' as const),
        idempotencyKey: item.idempotencyKey,
      }));
      const response = await collab.sendInvites(payloadRows, targetWorkspace?.workspaceId ?? active.workspaceId);
      const byEmail = new Map(response.results.map(item => [item.email.toLowerCase(), item]));
      setRows(prev =>
        prev.map(row => {
          const match = byEmail.get(row.email.trim().toLowerCase());
          return match ? { ...row, result: match } : row;
        }),
      );
      const sentCount = response.results.filter(item => item.ok).length;
      const failedCount = response.results.length - sentCount;
      if (sentCount > 0 && failedCount === 0) {
        collab.notify(t('Sent {count} invitations', { count: sentCount }), 'info');
      } else if (sentCount > 0 && failedCount > 0) {
        collab.notify(t('Sent {sent}; {failed} failed', { sent: sentCount, failed: failedCount }), 'error');
      } else if (failedCount > 0) {
        setFormError(t('Some invitations could not be sent. Review details below and retry.'));
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('Could not send invitations.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CollabDialog
      open={open}
      title={targetWorkspace ? t('Invite to {name}', { name: targetWorkspace.workspaceName }) : t('Invite teammates')}
      description={targetWorkspace ? t('Seats are free. Teammates share workspace projects, assets, and brand kits.') : undefined}
      onClose={() => collab.setInviteDialogOpen(false)}
      className="om-collab-dialog-wide"
    >
      {targetWorkspace ? (
        <>
          {invitableTeams.length > 1 && (
            <label className="om-label">
              <span>{t('Destination workspace')}</span>
              <Select
                label={t('Destination workspace')}
                value={targetWorkspace.workspaceId}
                disabled={submitting}
                options={invitableTeams.map(team => ({ value: team.workspaceId, label: team.workspaceName }))}
                onCommit={setTargetWorkspaceId}
              />
            </label>
          )}

          <div className="om-invite-rows">
            {rows.map((row, index) => {
              const succeeded = Boolean(row.result?.ok);
              const failed = Boolean(row.result && !row.result.ok);
              const removable = rows.length > 1;
              return (
                <div key={row.id}>
                  <div className="om-invite-row" data-removable={removable || undefined}>
                    <label className="om-field">
                      <input
                        type="email"
                        value={row.email}
                        disabled={submitting || succeeded}
                        aria-invalid={failed || undefined}
                        aria-label={t('Teammate email {index}', { index: index + 1 })}
                        placeholder="colleague@company.com"
                        onChange={event => {
                          const val = event.target.value;
                          setRows(prev =>
                            prev.map(item =>
                              item.id === row.id
                                ? { ...item, email: val, result: undefined, idempotencyKey: crypto.randomUUID() }
                                : item,
                            ),
                          );
                        }}
                      />
                    </label>
                    <Select
                      label={t('Role')}
                      value={canInviteAdmins ? row.role : 'member'}
                      disabled={submitting || succeeded || !canInviteAdmins}
                      options={roleOptions}
                      onCommit={next =>
                        setRows(prev =>
                          prev.map(item =>
                            item.id === row.id ? { ...item, role: next as WorkspaceInviteRole } : item,
                          ),
                        )
                      }
                    />
                    {removable && (
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label={t('Remove row')}
                        disabled={submitting}
                        onClick={() => setRows(prev => prev.filter(item => item.id !== row.id))}
                        icon={<RemixIcon name="delete-bin-line" size={15} />}
                      />
                    )}
                  </div>
                  {row.result && (
                    <div className="om-invite-row-status" data-ok={row.result.ok}>
                      <RemixIcon
                        name={row.result.ok ? 'checkbox-circle-line' : 'error-warning-line'}
                        size={13}
                      />
                      <span>{row.result.ok ? t('Invitation sent') : t(row.result.message || 'Could not send invitation')}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {rows.length < 10 && !allSent && (
            <div className="om-invite-add-row">
              <Button
                variant="plain"
                type="button"
                className="om-invite-add-btn"
                disabled={submitting}
                onClick={() => setRows(prev => [...prev, makeEmptyRow()])}
              >
                <RemixIcon name="add-line" size={14} />
                <span>{t('Add another')}</span>
              </Button>
            </div>
          )}

          {formError && (
            <p className="om-field-error" role="alert">
              {formError}
            </p>
          )}
        </>
      ) : (
        <div className="om-collab-tonal-card">
          <p className="om-muted">
            {t('Seats are free. Teammates share workspace projects, assets, and brand kits.')}
          </p>
          <div>
            <Button
              variant="primary"
              type="button"
              disabled={Boolean(collab.openingCloudDestination)}
              onClick={() => void collab.openCloudLink('create-workspace')}
            >
              <RemixIcon name="add-line" size={14} />
              <span>{t('Create team workspace')}</span>
              <RemixIcon name="external-link-line" size={14} />
            </Button>
          </div>
        </div>
      )}

      {referral?.available && (
        <div className="om-invite-reset-banner" data-testid="invite-dialog-reset-tip">
          <span className="om-account-hub-reset-keycap" aria-hidden="true">reset</span>
          <div className="om-invite-reset-copy">
            <strong>{t('Share OpenDesign · Earn reset cards')}</strong>
            <span>
              {t('{invited}/{target} teammates joined · {cards} reset cards ready', {
                invited: referral.invitedCount,
                target: referral.inviteTarget,
                cards: referral.resetCardsAvailable,
              })}
            </span>
          </div>
          <Button
            variant="plain"
            type="button"
            className="om-invite-reset-cta"
            disabled={Boolean(collab.openingCloudDestination)}
            onClick={() => void collab.openCloudLink('referral')}
          >
            <span>{t('View referral link')}</span>
            <RemixIcon name="external-link-line" size={13} />
          </Button>
        </div>
      )}

      <div className="om-collab-dialog-footer">
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          onClick={() => collab.setInviteDialogOpen(false)}
        >
          {t(allSent || !targetWorkspace ? 'Done' : 'Cancel')}
        </Button>
        {targetWorkspace && (hasFailures ? (
          <Button
            variant="primary"
            type="button"
            disabled={submitting}
            onClick={() => void handleSubmit(true)}
          >
            <RemixIcon name="refresh-line" size={14} />
            <span>{t(submitting ? 'Retrying…' : 'Retry failed')}</span>
          </Button>
        ) : !allSent ? (
          <Button
            variant="primary"
            type="button"
            disabled={submitting || pendingOrRetryableRows.length === 0}
            onClick={() => void handleSubmit(false)}
          >
            <span>{t(submitting ? 'Sending…' : 'Send invitations')}</span>
          </Button>
        ) : null)}
      </div>
    </CollabDialog>
  );
}
