import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { isFreeOrGoPlan } from '../../../../shared/workspace-collab';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { openExternalUrl } from '../../utils/platformHost';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';
import { useOptionalGrowthSurfaces } from './GrowthSurfacesContext';

export function ProductionCampaignModal() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const growth = useOptionalGrowthSurfaces();
  const [imageError, setImageError] = useState(false);

  const decision = growth?.modalDecision ?? null;
  const open = Boolean(collab?.snapshot?.signedIn && growth?.campaignModalOpen && decision);

  useEffect(() => {
    setImageError(false);
  }, [decision?.imageUrl, decision?.touchpointDecisionId]);

  useEffect(() => {
    if (!open || !growth || !decision) return;
    growth.reportTouchpointEvent(decision, 'impression');
  }, [decision, growth, open]);

  if (!collab || !growth || !open || !decision) return null;

  const planId = collab.snapshot?.quota?.planId ?? null;
  const isPaidSubscriber = Boolean(planId) && !isFreeOrGoPlan(planId);

  const primaryLabel = isPaidSubscriber
    ? decision.paidCtaLabel ||
      (decision.targetModelLabel ? t('Use {model}', { model: decision.targetModelLabel }) : t('Try now'))
    : decision.freeCtaLabel || t('Upgrade plan');

  const handlePrimaryAction = () => {
    growth.reportTouchpointEvent(
      decision,
      'action',
      isPaidSubscriber ? 'paid_cta' : 'free_cta',
    );
    growth.closeCampaignModal('action');

    if (isPaidSubscriber) {
      if (decision.internalPath) {
        growth.navigateInternalAction(decision.internalPath);
        return;
      }
      if (decision.targetModelId) {
        growth.useCampaignModelAction(decision.targetModelId, decision.targetModelLabel ?? null);
        return;
      }
      if (decision.ctaUrl) {
        void openExternalUrl(decision.ctaUrl);
      }
      return;
    }

    if (decision.ctaUrl) {
      void openExternalUrl(decision.ctaUrl);
    } else {
      void collab.openCloudLink('plans');
    }
  };

  return (
    <CollabDialog
      open
      title={decision.title}
      description={decision.subtitle ?? undefined}
      onClose={() => growth.closeCampaignModal('dismiss')}
      className="om-collab-dialog-wide"
    >
      <div className="om-collab-tonal-card" data-tone="accent" data-testid="touchpoint-campaign-modal">
        <div className="om-collab-dialog-meta-row">
          <span className="om-collab-pill" data-tone="accent">
            <RemixIcon name="gift-line" size={13} />
            <span>{decision.badgeLabel}</span>
          </span>
          {collab.snapshot?.quota?.planLabel && (
            <span className="om-collab-pill">{collab.snapshot.quota.planLabel}</span>
          )}
        </div>

        {decision.imageUrl && !imageError && (
          <img
            src={decision.imageUrl}
            alt=""
            className="om-touchpoint-modal-cover"
            onError={() => setImageError(true)}
          />
        )}

        {decision.body && <p className="om-collab-dialog-copy">{decision.body}</p>}

        {decision.highlights.length > 0 && (
          <div className="om-touchpoint-highlights">
            {decision.highlights.slice(0, 4).map((highlight, idx) => (
              <div key={idx} className="om-gate-benefit-item">
                <RemixIcon name="check-line" size={14} />
                <span>{highlight}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="om-collab-dialog-footer">
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          data-testid="touchpoint-campaign-dismiss"
          onClick={() => growth.closeCampaignModal('dismiss')}
        >
          <span>{t('Maybe later')}</span>
        </Button>
        <Button
          variant="primary"
          type="button"
          data-testid="touchpoint-campaign-primary-cta"
          onClick={handlePrimaryAction}
        >
          <span>{primaryLabel}</span>
          {!isPaidSubscriber && <RemixIcon name="external-link-line" size={14} />}
        </Button>
      </div>
    </CollabDialog>
  );
}
