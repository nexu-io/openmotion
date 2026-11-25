import { Button } from 'open-design-ui/button';
import { formatPlanLabel, isMaxPlanTier } from '../../../../shared/workspace-collab';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';

export function ConcurrencyGateDialog() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();

  const gate = collab?.billingGate;
  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;
  if (!collab || !gate || gate.kind !== 'concurrency' || !snapshot || !active) {
    return null;
  }

  const planId = snapshot.quota?.planId ?? active.planId;
  const planLabel = snapshot.quota?.planLabel ?? formatPlanLabel(planId);
  const isOwner = snapshot.permissions.canManageBilling;
  const isMaxPlan = isMaxPlanTier(planId);
  const canUpgrade = isOwner && !isMaxPlan;

  const description = !isOwner
    ? t(
        'Your workspace hit its concurrent request limit. Wait for running tasks to finish or ask your workspace owner about a higher plan.',
      )
    : isMaxPlan
      ? t(
          'All parallel request slots on the Max plan are currently busy. Wait a moment for running tasks to finish, then try again.',
        )
      : t(
          'All parallel request slots on {name} are currently busy. Upgrade your plan for higher concurrency or try again shortly.',
          { name: active.workspaceName },
        );

  const hasSlots = typeof gate.inFlight === 'number' && typeof gate.limit === 'number' && gate.limit > 0;

  return (
    <CollabDialog
      open
      title={t('Too many active requests')}
      onClose={() => collab.setBillingGate(null)}
      className="om-collab-dialog-wide"
    >
      <div className="om-collab-tonal-card" data-tone="warning" data-testid="concurrency-gate-dialog">
        <div className="om-collab-dialog-meta-row">
          <span className="om-collab-pill" data-tone="warning">
            <RemixIcon name="time-line" size={13} />
            <span>{active.workspaceName}</span>
          </span>
          <span className="om-collab-pill">{planLabel}</span>
          {hasSlots && (
            <span className="om-collab-pill">
              {t('{inFlight} / {limit} active tasks', { inFlight: gate.inFlight!, limit: gate.limit! })}
            </span>
          )}
        </div>

        <p className="om-collab-dialog-copy">{description}</p>

        {canUpgrade && (
          <div className="om-gate-benefit-list">
            <span className="om-gate-benefit-item">
              <RemixIcon name="check-line" size={14} />
              <span>{t('Higher parallel task limit')}</span>
            </span>
            <span className="om-gate-benefit-item">
              <RemixIcon name="check-line" size={14} />
              <span>{t('Priority generation throughput')}</span>
            </span>
          </div>
        )}
      </div>

      <div className="om-collab-dialog-footer">
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          onClick={() => collab.setBillingGate(null)}
        >
          {t('Close')}
        </Button>

        {gate.onRetry && (
          <Button
            variant="plain"
            type="button"
            className="om-collab-tonal-btn"
            onClick={() => {
              const retry = gate.onRetry;
              collab.setBillingGate(null);
              retry?.();
            }}
          >
            <RemixIcon name="refresh-line" size={14} />
            <span>{t('Try again')}</span>
          </Button>
        )}

        {canUpgrade && (
          <Button
            variant="primary"
            type="button"
            onClick={() => {
              collab.setBillingGate(null);
              void collab.openCloudLink('plans');
            }}
          >
            <span>{t('Upgrade plan')}</span>
            <RemixIcon name="external-link-line" size={14} />
          </Button>
        )}
      </div>
    </CollabDialog>
  );
}
