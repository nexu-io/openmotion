import { useEffect, useRef } from 'react';
import { Button } from 'open-design-ui/button';
import { formatPlanLabel } from '../../../../shared/workspace-collab';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { openExternalUrl } from '../../utils/platformHost';
import { activeAccountOffer, MULTIMODAL_CAPABILITIES } from '../accountOffer';
import {
  BLACK_FRIDAY_CAMPAIGN,
  campaignPricingUrl,
  newCampaignEntryId,
  useBlackFridayActive,
} from '../campaignAttribution';
import { useCheckoutReturnRefresh } from '../entitlementAttribution';
import { send } from '../reporting';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { CollabDialog } from './CollabDialog';

export function ArtifactUpgradeDialog() {
  const { locale, t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const blackFriday = useBlackFridayActive();
  const markCheckoutReturn = useCheckoutReturnRefresh('studio', 'artifact_upgrade_banner');

  const gate = collab?.billingGate;
  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;
  const open = Boolean(collab && gate && gate.kind === 'artifact-upgrade' && snapshot && active);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      send('surface_view', {
        page_name: 'studio',
        area: 'entitlement_modal',
        element: 'modal',
        hook_id: 'artifact_upgrade_banner',
        ...(blackFriday ? { campaign_id: BLACK_FRIDAY_CAMPAIGN } : {}),
      });
    }
    wasOpen.current = open;
  }, [open, blackFriday]);
  if (!collab || !gate || gate.kind !== 'artifact-upgrade' || !snapshot || !active) {
    return null;
  }

  const isOwner = snapshot.permissions.canManageBilling;
  const enforced = Boolean(gate.enforced);
  const featureName = gate.featureLabel || t('this capability');
  const title = enforced
    ? t('Upgrade required for {feature}', { feature: featureName })
    : t('Unlock multimodal creation with Plus');
  const description = enforced
    ? isOwner
      ? t('Upgrade your OpenDesign workspace plan to unlock {feature}.', { feature: featureName })
      : t('This workspace plan does not include {feature}. Contact your workspace owner to upgrade.', {
          feature: featureName,
        })
    : t('Your creation is ready. Upgrade to generate images, videos, voiceovers, and music in OpenMotion.');

  const offer = activeAccountOffer();
  const planLabel = snapshot.quota?.planLabel ?? formatPlanLabel(active.planId);

  const handleUpgrade = () => {
    const entryId = newCampaignEntryId();
    markCheckoutReturn(entryId);
    send('ui_click', {
      page_name: 'studio',
      area: 'entitlement_modal',
      element: 'view_plans',
      hook_id: 'artifact_upgrade_banner',
      entry_id: entryId,
      ...(blackFriday ? { campaign_id: BLACK_FRIDAY_CAMPAIGN } : {}),
    });
    collab.setBillingGate(null);
    if (active.workspaceType === 'team') {
      void collab.openCloudLink('plans');
      return;
    }
    const url = campaignPricingUrl(locale, 'openmotion_artifact_upgrade', entryId);
    void openExternalUrl(url);
  };

  return (
    <CollabDialog
      open
      title={title}
      onClose={() => collab.setBillingGate(null)}
      className="om-collab-dialog-wide"
    >
      <div className="om-collab-tonal-card" data-tone="accent" data-testid="artifact-upgrade-dialog">
        <div className="om-collab-dialog-meta-row">
          <span className="om-collab-pill">{active.workspaceName}</span>
          <span className="om-collab-pill">{planLabel}</span>
          {(offer || blackFriday) && (
            <span className="om-collab-pill" data-tone="accent">
              <RemixIcon name="sparkling-fill" size={12} />
              <span>{blackFriday ? t('Black Friday up to 50% off') : t(offer!.title)}</span>
            </span>
          )}
        </div>

        <p className="om-collab-dialog-copy">{description}</p>

        <div className="om-upgrade-cap-grid" role="list">
          {MULTIMODAL_CAPABILITIES.map(cap => (
            <div key={cap.label} className="om-upgrade-cap-item" role="listitem">
              <RemixIcon name={cap.icon} size={15} />
              <span>{t(cap.label)}</span>
            </div>
          ))}
        </div>
      </div>

      {!isOwner && (
        <div className="om-collab-tonal-card">
          <p className="om-muted om-collab-note">
            {t('Ask your workspace owner to upgrade to Plus or higher.')}
          </p>
        </div>
      )}

      <div className="om-collab-dialog-footer">
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          onClick={() => collab.setBillingGate(null)}
        >
          {t(enforced ? 'Close' : 'Maybe later')}
        </Button>

        {isOwner && (
          <Button variant="primary" type="button" onClick={handleUpgrade}>
            <span>{t('Upgrade plan')}</span>
            <RemixIcon name="external-link-line" size={14} />
          </Button>
        )}
      </div>
    </CollabDialog>
  );
}
