import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { Popover } from '../../components/ui/Popover';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { WORKSPACE_LOCATION_CHANGED } from '../../utils/workspaceHistory';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

function formatResetDate(iso: string | null, formatDate: (date: Date, options?: Intl.DateTimeFormatOptions) => string): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return formatDate(new Date(time), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function WorkspaceQuotaPopover() {
  const { t, formatDate } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener(WORKSPACE_LOCATION_CHANGED, close);
    return () => window.removeEventListener(WORKSPACE_LOCATION_CHANGED, close);
  }, []);

  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;
  const quota = snapshot?.quota;
  if (!collab || !snapshot?.signedIn || !active || !quota) return null;

  const isLocked = active.lifecycleState === 'locked' || active.lifecycleState === 'billing_past_due';
  const isWarning = isLocked || !quota.hasAvailableFunds || quota.weeklyLimitExhausted;
  const pillSummary = quota.weeklyPercentLeft !== null
    ? `${quota.weeklyPercentLeft}%`
    : quota.creditsUsd !== null
      ? `$${quota.creditsUsd}`
      : quota.planLabel;
  const resetText = formatResetDate(quota.weeklyResetsAt, formatDate);
  const canManageBilling = snapshot.permissions.canManageBilling;
  const primaryDestination = isLocked ? 'billing-recovery' : 'plans';
  const openingPrimary = collab.openingCloudDestination === primaryDestination;
  const openingBilling = collab.openingCloudDestination === 'billing';

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      initialFocus={false}
      aria-label={t('Workspace plan and credits')}
      className="om-ws-quota-popover"
      trigger={
        <Button
          variant="plain"
          type="button"
          className="om-ws-header-cta"
          data-testid="workspace-quota-trigger"
          data-warning={isWarning || undefined}
          aria-label={t('Workspace plan and credits')}
          aria-expanded={open}
        >
          <RemixIcon name="flashlight-line" size={14} />
          <span className="om-ws-header-cta-label">{quota.planLabel}</span>
          <span className="om-ws-header-cta-label">·</span>
          <span>{pillSummary}</span>
        </Button>
      }
    >
      <div className="om-ws-quota-head">
        <div>
          <strong className="om-subtitle">{active.workspaceName}</strong>
          <p className="om-muted">{t('{plan} plan', { plan: quota.planLabel })}</p>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={t('Refresh quota')}
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void collab.refresh(true).finally(() => setRefreshing(false));
          }}
          icon={
            <RemixIcon
              name={refreshing ? 'loader-4-line' : 'refresh-line'}
              size={15}
              className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
          }
        />
      </div>

      {quota.weeklyPercentLeft !== null && (
        <div className="om-ws-quota-block">
          <div className="om-ws-quota-row">
            <span>{t('Weekly usage')}</span>
            <strong>{t('{percent}% left', { percent: quota.weeklyPercentLeft })}</strong>
          </div>
          <div className="om-ws-meter-track" role="progressbar" aria-valuenow={quota.weeklyPercentLeft} aria-valuemin={0} aria-valuemax={100}>
            <div
              className="om-ws-meter-fill"
              data-exhausted={quota.weeklyLimitExhausted || undefined}
              style={{ width: `${Math.max(0, Math.min(100, quota.weeklyPercentLeft))}%` }}
            />
          </div>
          {resetText && (
            <span className="om-muted">{t('Resets on {date}', { date: resetText })}</span>
          )}
        </div>
      )}

      <div className="om-ws-quota-block">
        <div className="om-ws-quota-row">
          <span>{t('Available credits')}</span>
          <strong>{quota.creditsUsd !== null ? `$${quota.creditsUsd}` : '—'}</strong>
        </div>
        <span className="om-muted">
          {t(active.workspaceType === 'team' ? 'Shared workspace credits in USD' : 'Account credits in USD')}
        </span>
      </div>

      {canManageBilling ? (
        <div className="om-ws-quota-actions" data-testid="quota-owner-actions">
          <Button
            variant="primary"
            type="button"
            disabled={Boolean(collab.openingCloudDestination)}
            aria-busy={openingPrimary || undefined}
            onClick={() => {
              void collab.openCloudLink(primaryDestination).finally(() => setOpen(false));
            }}
          >
            <span>{t(isLocked ? 'Restore billing' : 'Upgrade plan')}</span>
            <RemixIcon
              name={openingPrimary ? 'loader-4-line' : 'external-link-line'}
              size={14}
              className={openingPrimary ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
          </Button>
          <Button
            variant="plain"
            type="button"
            className="om-collab-tonal-btn"
            disabled={Boolean(collab.openingCloudDestination)}
            aria-busy={openingBilling || undefined}
            onClick={() => {
              void collab.openCloudLink('billing').finally(() => setOpen(false));
            }}
          >
            <span>{t('Billing')}</span>
            <RemixIcon
              name={openingBilling ? 'loader-4-line' : 'external-link-line'}
              size={14}
              className={openingBilling ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
          </Button>
        </div>
      ) : (
        <div className="om-collab-scope-notice" data-testid="quota-member-notice">
          <span className="om-collab-scope-notice-copy">
            <RemixIcon name="information-line" size={14} />
            <span>{t('Billing is managed by your workspace owner.')}</span>
          </span>
        </div>
      )}
    </Popover>
  );
}
