import { Button } from 'open-design-ui/button';
import type { MouseEvent, ReactNode } from 'react';
import type { GatewayStatus, Model, ProviderState } from '../../../shared/gateway';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { buildSubscriptionUrl } from './accountOffer';
import { markExternalCheckoutPending } from './entitlementModalBus';
import * as tracking from './pageTracking';

export function ProviderSetupNotice({ message, children }: {
  message: string; children: ReactNode;
}) {
  return <div className="om-creation-setup om-provider-setup" role="status">
    <RemixIcon name="information-line" size={18} />
    <p className="om-muted">{message}</p>
    <div className="om-control-row">{children}</div>
  </div>;
}

export function isUnifiedCloudGateway(providers: readonly ProviderState[] | undefined): boolean {
  return Boolean(
    providers?.length
    && providers.every(provider => provider.id === 'opendesign' && provider.credentialSource === 'environment'),
  );
}

export function isCloudEmptyCatalog(
  gateway: { status: GatewayStatus; models: Model[]; mode?: 'opendesign' | 'mock' } | undefined,
  compatibleCount: number,
): boolean {
  if (!gateway || compatibleCount > 0) return false;
  const providers = gateway.status.providers;
  if (!providers.some(provider => provider.id === 'opendesign')) return false;
  return providers.every(provider => !provider.available);
}

export function CloudEmptyModelsNotice({
  consoleUrl,
  boxed = false,
  onOpenSubscription,
}: {
  consoleUrl?: string;
  boxed?: boolean;
  onOpenSubscription: () => void;
}) {
  const { t } = useI18n();
  const message = t('Your OpenDesign workspace currently has no available image, video or audio models. Upgrade to Plus to unlock multimodal generation, then sync models.');
  const openUpgrade = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.detail === 0 && event.button === 0) {
      event.currentTarget.href = buildSubscriptionUrl(consoleUrl, 'openmotion_manage_subscription');
    }
    markExternalCheckoutPending('studio_free_gate');
    tracking.reportSettingsClick('provider_detail', 'view_plans');
  };
  const actions = <>
    <a
      className="om-button"
      data-primary
      href={buildSubscriptionUrl(consoleUrl, 'openmotion_manage_subscription')}
      target="_blank"
      rel="noreferrer"
      onPointerDown={event => {
        event.currentTarget.href = buildSubscriptionUrl(consoleUrl, 'openmotion_manage_subscription');
      }}
      onClick={openUpgrade}
      onAuxClick={event => { if (event.button === 1) openUpgrade(event); }}
    >
      <RemixIcon name="sparkling-line" size={15} />
      {t('Upgrade to Plus')}
      <RemixIcon name="external-link-line" size={14} />
    </a>
    <Button type="button" variant="ghost" className="om-button h-auto" onClick={onOpenSubscription}>
      {t('Check account & plan')}
    </Button>
  </>;
  if (boxed) {
    return (
      <div data-empty-models="true">
        <ProviderSetupNotice message={message}>{actions}</ProviderSetupNotice>
      </div>
    );
  }
  return (
    <div className="om-creation-setup" role="status" data-empty-models="true">
      <RemixIcon name="information-line" size={18} />
      <p className="om-muted">{message}</p>
      <div className="om-control-row">{actions}</div>
    </div>
  );
}
