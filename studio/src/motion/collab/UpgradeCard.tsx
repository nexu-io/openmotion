import { useState } from 'react';
import { Button } from 'open-design-ui/button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { ArtifactUpgradeDialog } from './ArtifactUpgradeDialog';
import { BalanceGateDialog } from './BalanceGateDialog';
import { ConcurrencyGateDialog } from './ConcurrencyGateDialog';

export function UpgradeCard() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const [refreshing, setRefreshing] = useState(false);

  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;
  const quota = snapshot?.quota;
  if (!collab || !snapshot?.signedIn || !active || !quota) return null;

  const isLocked = active.lifecycleState === 'locked' || active.lifecycleState === 'billing_past_due';
  const exhausted = isLocked || !quota.hasAvailableFunds;
  if (!exhausted) return null;

  const isOwner = snapshot.permissions.canManageBilling;
  const tone = isLocked ? 'danger' : 'warning';
  const title = isLocked
    ? t('Workspace billing paused')
    : t('Workspace quota reached');
  const description = isLocked
    ? isOwner
      ? t('Billing for {name} needs attention before new cloud tasks can run.', { name: active.workspaceName })
      : t('Ask your workspace owner to restore billing for {name}.', { name: active.workspaceName })
    : isOwner
      ? t('Credits and weekly quota for {name} are depleted. Upgrade or add credits to continue.', { name: active.workspaceName })
      : t('Workspace credits are depleted. Ask your workspace owner to add credits or switch workspace.');

  const personal = snapshot.workspaces.find(w => w.workspaceType === 'personal');
  const ownerDestination = isLocked ? 'billing-recovery' : 'billing';
  const openingOwnerLink = collab.openingCloudDestination === ownerDestination;

  return (
    <section
      className="om-upgrade-card"
      data-tone={tone}
      data-testid="super-agent-upgrade-card"
      aria-label={title}
    >
      <div className="om-upgrade-card-band">
        <span className="om-upgrade-card-title">
          <RemixIcon name={isLocked ? 'lock-line' : 'flashlight-line'} size={15} />
          <span>{title}</span>
        </span>
        <span className="om-collab-pill" data-tone={tone}>
          {active.workspaceName}
        </span>
      </div>
      <div className="om-upgrade-card-body">
        <p className="om-upgrade-card-desc">
          {description}
          {isOwner && collab.topUpPolling && (
            <>
              {' · '}
              <span>{t('Checking balance…')}</span>
            </>
          )}
        </p>
        <div className="om-upgrade-card-actions">
          {isOwner ? (
            <Button
              variant="primary"
              type="button"
              disabled={Boolean(collab.openingCloudDestination)}
              aria-busy={openingOwnerLink || undefined}
              onClick={() => {
                collab.startTopUpPolling();
                void collab.openCloudLink(ownerDestination);
              }}
            >
              <span>{t(isLocked ? 'Restore billing' : 'Upgrade or top up')}</span>
              <RemixIcon
                name={openingOwnerLink ? 'loader-4-line' : 'external-link-line'}
                size={14}
                className={openingOwnerLink ? 'animate-spin motion-reduce:animate-none' : undefined}
              />
            </Button>
          ) : (
            personal &&
            personal.workspaceId !== active.workspaceId && (
              <Button
                variant="plain"
                type="button"
                className="om-collab-tonal-btn"
                onClick={() => collab.requestSwitchWorkspace(personal.workspaceId)}
              >
                <span>{t('Switch to personal')}</span>
              </Button>
            )
          )}
          <Button
            variant="plain"
            type="button"
            className="om-collab-tonal-btn"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void collab.refresh(true).finally(() => setRefreshing(false));
            }}
          >
            <RemixIcon name={refreshing ? 'loader-4-line' : 'refresh-line'} size={14} />
            <span>{t('Refresh')}</span>
          </Button>
        </div>
      </div>
    </section>
  );
}

export function BillingGateDialog() {
  return (
    <>
      <BalanceGateDialog />
      <ConcurrencyGateDialog />
      <ArtifactUpgradeDialog />
    </>
  );
}
