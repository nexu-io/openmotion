import { useState } from 'react';
import { Button } from 'open-design-ui/button';
import { formatPlanLabel } from '../../../../shared/workspace-collab';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';

export function BalanceGateDialog() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const [refreshing, setRefreshing] = useState(false);

  const gate = collab?.billingGate;
  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;
  if (!collab || !gate || (gate.kind !== 'balance' && gate.kind !== 'owner-topup') || !snapshot || !active) {
    return null;
  }

  const isOwner = snapshot.permissions.canManageBilling;
  const isLocked = gate.reason === 'workspace_locked' || active.lifecycleState === 'locked';
  const isPastDue = gate.reason === 'billing_past_due' || active.lifecycleState === 'billing_past_due';
  const needsBillingRecovery = isLocked || isPastDue;

  const tone = needsBillingRecovery ? 'danger' : 'warning';
  const title = needsBillingRecovery
    ? t('Workspace billing paused')
    : isOwner
      ? t('Workspace balance required')
      : t('Ask your workspace owner to continue');

  const description = needsBillingRecovery
    ? isOwner
      ? t('Billing for {name} needs attention before new cloud tasks can run.', { name: active.workspaceName })
      : t('Ask your workspace owner to restore billing for {name}.', { name: active.workspaceName })
    : isOwner
      ? t('Credits and weekly quota for {name} are depleted. Upgrade or add credits to continue.', {
          name: active.workspaceName,
        })
      : t('Workspace credits are depleted. Ask your workspace owner to add credits or switch workspace.');

  const balanceUsd = gate.balanceUsd ?? snapshot.quota?.creditsUsd ?? null;
  const weeklyPercentLeft = gate.weeklyPercentLeft ?? snapshot.quota?.weeklyPercentLeft ?? null;
  const planLabel = snapshot.quota?.planLabel ?? formatPlanLabel(active.planId);
  const personal = snapshot.workspaces.find(w => w.workspaceType === 'personal');
  const destination = needsBillingRecovery ? 'billing-recovery' : 'billing';
  const openingCloud = collab.openingCloudDestination === destination;

  return (
    <CollabDialog
      open
      title={title}
      onClose={() => {
        collab.stopTopUpPolling();
        collab.setBillingGate(null);
      }}
      className="om-collab-dialog-wide"
    >
      <div className="om-collab-tonal-card" data-tone={tone} data-testid="balance-gate-dialog">
        <div className="om-collab-dialog-meta-row">
          <span className="om-collab-pill" data-tone={tone}>
            <RemixIcon name={needsBillingRecovery ? 'lock-line' : 'flashlight-line'} size={13} />
            <span>{active.workspaceName}</span>
          </span>
          <span className="om-collab-pill">{planLabel}</span>
        </div>

        <p className="om-collab-dialog-copy">{description}</p>

        {(balanceUsd !== null || weeklyPercentLeft !== null) && (
          <div className="om-gate-metric-grid">
            {balanceUsd !== null && (
              <div className="om-gate-metric-item">
                <span>{t('Available credits')}</span>
                <strong>${balanceUsd}</strong>
              </div>
            )}
            {weeklyPercentLeft !== null && (
              <div className="om-gate-metric-item">
                <span>{t('Weekly quota')}</span>
                <strong>{weeklyPercentLeft}%</strong>
              </div>
            )}
          </div>
        )}
      </div>

      {isOwner && collab.topUpPolling && (
        <div className="om-collab-tonal-card" data-tone="accent" data-testid="balance-gate-polling">
          <div className="om-gate-poll-row">
            <span className="om-gate-poll-copy">
              <RemixIcon name="loader-4-line" size={15} className="animate-spin motion-reduce:animate-none" />
              <span>{t('Checking balance every 5s. Returning after payment resumes automatically.')}</span>
            </span>
            <Button
              variant="plain"
              type="button"
              size="sm"
              className="om-collab-tonal-btn"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void collab.checkTopUpNow().finally(() => setRefreshing(false));
              }}
            >
              <span>{t('Check now')}</span>
            </Button>
          </div>
        </div>
      )}

      {!isOwner && (
        <div className="om-collab-tonal-card" data-testid="balance-gate-member-notice">
          <p className="om-muted om-collab-note">{t('Billing is managed by your workspace owner.')}</p>
        </div>
      )}

      <div className="om-collab-dialog-footer">
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          onClick={() => {
            collab.stopTopUpPolling();
            collab.setBillingGate(null);
          }}
        >
          {t('Close')}
        </Button>

        {isOwner ? (
          <Button
            variant="primary"
            type="button"
            disabled={Boolean(collab.openingCloudDestination)}
            aria-busy={openingCloud || undefined}
            onClick={() => {
              collab.startTopUpPolling(gate.onRecovered);
              void collab.openCloudLink(destination);
            }}
          >
            <span>{t(needsBillingRecovery ? 'Restore billing' : 'Upgrade or top up')}</span>
            <RemixIcon
              name={openingCloud ? 'loader-4-line' : 'external-link-line'}
              size={14}
              className={openingCloud ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
          </Button>
        ) : (
          <>
            {personal && personal.workspaceId !== active.workspaceId && (
              <Button
                variant="plain"
                type="button"
                className="om-collab-tonal-btn"
                onClick={() => {
                  collab.setBillingGate(null);
                  collab.requestSwitchWorkspace(personal.workspaceId);
                }}
              >
                <span>{t('Switch to personal')}</span>
              </Button>
            )}
            <Button
              variant="plain"
              type="button"
              className="om-collab-tonal-btn"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void collab.checkTopUpNow().then(ok => {
                  if (!ok) return collab.refresh(true);
                }).finally(() => setRefreshing(false));
              }}
            >
              <RemixIcon name={refreshing ? 'loader-4-line' : 'refresh-line'} size={14} />
              <span>{t('Refresh')}</span>
            </Button>
          </>
        )}
      </div>
    </CollabDialog>
  );
}
