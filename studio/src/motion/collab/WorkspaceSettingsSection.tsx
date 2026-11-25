import { Button } from 'open-design-ui/button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

export function WorkspaceSettingsSection() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;
  if (!collab || !snapshot?.signedIn || !active) return null;

  const isLocked = active.lifecycleState === 'locked' || active.lifecycleState === 'billing_past_due';
  const roleLabel =
    active.role === 'owner' ? t('Owner') : active.role === 'admin' ? t('Admin') : t('Member');

  return (
    <section className="om-settings-workspace-stack" data-testid="settings-workspace-section">
      {isLocked && (
        <div className="om-collab-tonal-card" data-tone="danger" role="alert">
          <div className="om-settings-row">
            <div>
              <h2 className="om-subtitle">{t('Workspace billing paused')}</h2>
              <p className="om-muted">
                {t(
                  snapshot.permissions.canManageBilling
                    ? 'Restore billing in OpenDesign Cloud to unlock team projects and generation.'
                    : 'This team workspace is paused. Contact your workspace owner to restore billing.',
                )}
              </p>
            </div>
            {snapshot.permissions.canManageBilling && (
              <Button
                variant="primary"
                type="button"
                disabled={Boolean(collab.openingCloudDestination)}
                aria-busy={collab.openingCloudDestination === 'billing-recovery' || undefined}
                onClick={() => void collab.openCloudLink('billing-recovery')}
              >
                <span>{t('Restore billing')}</span>
                <RemixIcon
                  name={collab.openingCloudDestination === 'billing-recovery' ? 'loader-4-line' : 'external-link-line'}
                  size={14}
                  className={collab.openingCloudDestination === 'billing-recovery' ? 'animate-spin motion-reduce:animate-none' : undefined}
                />
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="om-collab-tonal-card">
        <div className="om-settings-row">
          <div>
            <h2 className="om-subtitle">{t('Active workspace')}</h2>
            <p className="om-muted">
              {active.workspaceName} · {t(active.workspaceType === 'team' ? 'Team workspace' : 'Personal workspace')} · {roleLabel}
            </p>
          </div>
          {active.workspaceType === 'team' && snapshot.permissions.canInviteMembers && (
            <Button
              variant="plain"
              type="button"
              className="om-collab-tonal-btn"
              onClick={() => collab.setInviteDialogOpen(true)}
            >
              <RemixIcon name="group-line" size={15} />
              <span>{t('Invite teammates')}</span>
            </Button>
          )}
        </div>

        {snapshot.permissions.canShowWorkspaceSettings ? (
          <div className="om-settings-actions">
            <Button
              variant="plain"
              type="button"
              className="om-collab-tonal-btn"
              disabled={Boolean(collab.openingCloudDestination)}
              aria-busy={collab.openingCloudDestination === 'members' || undefined}
              onClick={() => void collab.openCloudLink('members')}
            >
              <RemixIcon name="group-line" size={15} />
              <span>{t('Members in Cloud')}</span>
              <RemixIcon
                name={collab.openingCloudDestination === 'members' ? 'loader-4-line' : 'external-link-line'}
                size={14}
                className={collab.openingCloudDestination === 'members' ? 'animate-spin motion-reduce:animate-none' : undefined}
              />
            </Button>
            <Button
              variant="plain"
              type="button"
              className="om-collab-tonal-btn"
              disabled={Boolean(collab.openingCloudDestination)}
              aria-busy={collab.openingCloudDestination === 'workspace-settings' || undefined}
              onClick={() => void collab.openCloudLink('workspace-settings')}
            >
              <RemixIcon name="settings-3-line" size={15} />
              <span>{t('Team settings')}</span>
              <RemixIcon
                name={collab.openingCloudDestination === 'workspace-settings' ? 'loader-4-line' : 'external-link-line'}
                size={14}
                className={collab.openingCloudDestination === 'workspace-settings' ? 'animate-spin motion-reduce:animate-none' : undefined}
              />
            </Button>
            {snapshot.permissions.canManageBilling && (
              <Button
                variant="plain"
                type="button"
                className="om-collab-tonal-btn"
                disabled={Boolean(collab.openingCloudDestination)}
                aria-busy={collab.openingCloudDestination === 'billing' || undefined}
                onClick={() => void collab.openCloudLink('billing')}
              >
                <RemixIcon name="bank-card-line" size={15} />
                <span>{t('Plans & billing')}</span>
                <RemixIcon
                  name={collab.openingCloudDestination === 'billing' ? 'loader-4-line' : 'external-link-line'}
                  size={14}
                  className={collab.openingCloudDestination === 'billing' ? 'animate-spin motion-reduce:animate-none' : undefined}
                />
              </Button>
            )}
          </div>
        ) : active.workspaceType === 'personal' ? (
          <div className="om-settings-actions">
            <Button
              variant="plain"
              type="button"
              className="om-collab-tonal-btn"
              disabled={Boolean(collab.openingCloudDestination)}
              aria-busy={collab.openingCloudDestination === 'create-workspace' || undefined}
              onClick={() => void collab.openCloudLink('create-workspace')}
            >
              <RemixIcon name="add-line" size={15} />
              <span>{t('Create team workspace')}</span>
              <RemixIcon
                name={collab.openingCloudDestination === 'create-workspace' ? 'loader-4-line' : 'external-link-line'}
                size={14}
                className={collab.openingCloudDestination === 'create-workspace' ? 'animate-spin motion-reduce:animate-none' : undefined}
              />
            </Button>
          </div>
        ) : (
          <p className="om-muted" data-quiet>
            {t('Team administration and billing are managed in OpenDesign Cloud by workspace owners and admins.')}
          </p>
        )}
      </div>
    </section>
  );
}
