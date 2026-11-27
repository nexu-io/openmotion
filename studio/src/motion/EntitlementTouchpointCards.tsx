import { useEffect, useRef } from 'react';
import { Button } from 'open-design-ui/button';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';
import { newCampaignEntryId, useBlackFridayActive } from './campaignAttribution';
import {
  entitlementAttributionFields,
  openEntitlementModal,
  type EntitlementAttributionContext,
  type EntitlementHookId,
} from './entitlementModalBus';
import offerStyles from './GenerationOffer.module.css';
import './EntitlementTouchpointCards.css';

function trackGateClick(payload: {
  page_name: 'creative_studio' | 'assets';
  area: 'entitlement_gate';
  element: 'sign_in' | 'view_plans' | 'select_model' | 'open_pricing';
  hook_id: EntitlementHookId;
  entry_id?: string;
} & ReturnType<typeof entitlementAttributionFields>) {
  if (typeof window === 'undefined') return;
  void import('./tracking').then(({ trackMotion }) => trackMotion('ui_click', payload));
}

function trackGateImpression(payload: {
  page_name: 'creative_studio' | 'assets';
  area: 'entitlement_gate';
  element: 'banner';
  hook_id: EntitlementHookId;
  entry_id: string;
} & ReturnType<typeof entitlementAttributionFields>) {
  if (typeof window === 'undefined') return;
  void import('./tracking').then(({ trackMotion }) => trackMotion('surface_view', payload));
}

/**
 * U6 · Borderless tonal gate card placed inline above the Generate button
 * when a Free / Go account selects an OpenDesign hosted media model.
 */
export function FreePlanGenerationGate({
  onOpenProviders,
  hookId = 'studio_free_gate',
  attribution,
}: {
  onOpenProviders?: () => void;
  hookId?: EntitlementHookId;
  attribution?: EntitlementAttributionContext;
}) {
  const { t } = useI18n();
  const blackFriday = useBlackFridayActive();
  const entryIdRef = useRef<string>(newCampaignEntryId());
  const resolvedAttr: EntitlementAttributionContext = {
    gateReason: 'plan_locked',
    ...attribution,
  };
  const attrFields = entitlementAttributionFields(resolvedAttr);

  useEffect(() => {
    trackGateImpression({
      page_name: 'creative_studio',
      area: 'entitlement_gate',
      element: 'banner',
      hook_id: hookId,
      entry_id: entryIdRef.current,
      ...attrFields,
    });
  }, [hookId, attrFields.model_id, attrFields.model_provider, attrFields.modality, attrFields.gate_reason, attrFields.user_plan]);

  const openUpgradeModal = () => {
    const clickedEntryId = entryIdRef.current;
    entryIdRef.current = newCampaignEntryId();
    trackGateClick({
      page_name: 'creative_studio',
      area: 'entitlement_gate',
      element: 'view_plans',
      hook_id: hookId,
      entry_id: clickedEntryId,
      ...attrFields,
    });
    openEntitlementModal({
      mode: 'upgrade',
      hookId,
      entryId: clickedEntryId,
      attribution: resolvedAttr,
    });
  };

  if (blackFriday) {
    const isImage = resolvedAttr.modality === 'image';
    const title = t(isImage ? '7 days of unlimited flagship image generation' : 'Black Friday: up to 50% off your first year');
    const details = t(isImage ? 'Annual Pro & Max · Up to 50% off' : 'Enjoy this offer with Plus or higher');
    return (
      <section
        className={`om-entitlement-gate ${offerStyles.card}`}
        data-generation-offer="upgrade"
        role="status"
        aria-label={title}
      >
        <h3>{title}</h3>
        <p title={details}>{details}</p>
        <Button variant="plain" onClick={openUpgradeModal}>
          {t('Upgrade', undefined, 'generation offer')}
          <RemixIcon name="arrow-right-up-line" size={12} />
        </Button>
        {onOpenProviders && (
          <div className="om-entitlement-gate-secondary">
            <Button variant="plain" className="om-entitlement-gate-secondary" onClick={onOpenProviders}>
              {t('Use own API key')}
            </Button>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="om-entitlement-gate" role="status">
      <div className="om-entitlement-gate-copy">
        <strong>{t('Upgrade to Plus for hosted media models')}</strong>
        <p className="om-muted">{t('Your current plan does not include OpenDesign hosted image, video, or audio generation.')}</p>
      </div>
      <div className="om-entitlement-gate-actions">
        <Button
          variant="plain"
          className="om-button h-auto"
          data-primary
          onClick={openUpgradeModal}
        >
          <RemixIcon name="sparkling-line" size={15} />
          {t('Upgrade to Plus')}
        </Button>
        {onOpenProviders && (
          <Button variant="plain" className="om-button h-auto" onClick={onOpenProviders}>
            {t('Use own API key')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * U6 · Inline top-up CTA inside a failed generation card when credits/balance are insufficient.
 */
export function InsufficientBalanceFailureGate({
  hookId = 'failure_card_topup',
  attribution,
}: {
  hookId?: EntitlementHookId;
  attribution?: EntitlementAttributionContext;
}) {
  const { t } = useI18n();
  const entryIdRef = useRef<string>(newCampaignEntryId());
  const resolvedAttr: EntitlementAttributionContext = {
    gateReason: 'insufficient_credits',
    ...attribution,
  };
  const attrFields = entitlementAttributionFields(resolvedAttr);

  useEffect(() => {
    trackGateImpression({
      page_name: 'creative_studio',
      area: 'entitlement_gate',
      element: 'banner',
      hook_id: hookId,
      entry_id: entryIdRef.current,
      ...attrFields,
    });
  }, [hookId, attrFields.model_id, attrFields.model_provider, attrFields.modality, attrFields.gate_reason, attrFields.user_plan]);

  return (
    <div className="om-entitlement-gate" data-tone="warning" role="alert">
      <div className="om-entitlement-gate-copy">
        <strong>{t('Not enough credits to generate')}</strong>
        <p className="om-muted">{t('Your prompt and references are preserved with no charge. Add credits or lower settings to retry.')}</p>
      </div>
      <div className="om-entitlement-gate-actions">
        <Button
          variant="plain"
          className="om-button h-auto"
          data-primary
          onClick={() => {
            const clickedEntryId = entryIdRef.current;
            entryIdRef.current = newCampaignEntryId();
            trackGateClick({
              page_name: 'creative_studio',
              area: 'entitlement_gate',
              element: 'open_pricing',
              hook_id: hookId,
              entry_id: clickedEntryId,
              ...attrFields,
            });
            openEntitlementModal({
              mode: 'upgrade',
              hookId,
              entryId: clickedEntryId,
              attribution: resolvedAttr,
            });
          }}
        >
          <RemixIcon name="bank-card-line" size={15} />
          {t('Add credits')}
        </Button>
      </div>
    </div>
  );
}

/**
 * U3 · Guest empty state for Web cloud `/assets` when unauthenticated (replaces raw 401 error).
 */
export function AssetsGuestEmptyState() {
  const { t } = useI18n();
  return (
    <section className="om-assets-guest-empty" aria-label={t('Sign in to access your asset library')}>
      <div className="om-assets-guest-icon" aria-hidden="true">
        <RemixIcon name="folder-image-line" size={28} />
      </div>
      <h2 className="om-title">{t('Sign in to access your asset library')}</h2>
      <p className="om-muted">{t('Your generated images, videos, audio clips, and reusable media stay synced across devices once you sign in.')}</p>
      <Button
        variant="plain"
        className="om-button h-auto"
        data-primary
        onClick={() => {
          trackGateClick({ page_name: 'assets', area: 'entitlement_gate', element: 'sign_in', hook_id: 'assets_empty' });
          openEntitlementModal({ mode: 'guest', hookId: 'assets_empty' });
        }}
      >
        <RemixIcon name="login-box-line" size={16} />
        {t('Sign in with OpenDesign')}
      </Button>
    </section>
  );
}
