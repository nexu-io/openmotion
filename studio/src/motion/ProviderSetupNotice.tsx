import { Button } from 'open-design-ui/button';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { AccountStatus, useAccountSignIn } from './AccountSettings';
import type { ReactNode } from 'react';
import { MultimodalOfferCard, MultimodalUpgradeCard } from './MultimodalOfferCard';
import { useI18n } from '../i18n/I18n';
import type { StudioDestination } from './creativeStudios';
import { destinationTarget, reportCreativeClick } from './exploreTracking';
import { reportOfferClick, type OfferKind, type OfferVisit } from './offerTracking';
import { gatewayRequest } from './gatewayClient';
import { notifyProvidersChanged } from './useProviderDirectory';
import { useSubscriptionOpener } from './useSubscriptionOpener';
import { RemixIcon } from '../icons/RemixIcons';
import styles from './GenerationOffer.module.css';

export function ProviderSetupNotice({ message, children }: {
  message: string; children: ReactNode;
}) {
  return <div className="om-creation-setup om-provider-setup" role="status">
    <RemixIcon name="information-line" size={18} />
    <p className="om-muted">{message}</p>
    <div className="om-control-row">{children}</div>
  </div>;
}

function generationOfferCopy({ scene }: StudioDestination, kind: OfferKind) {
  if (scene.modality === 'image') return {
    title: '7 days of unlimited flagship image generation',
    details: kind === 'upgrade' ? 'Black Friday: the year’s best deals, up to 50% off' : 'Available with Plus or higher',
  };
  return {
    title: 'Black Friday: up to 50% off your first year',
    details: 'Enjoy this offer with Plus or higher',
  };
}

export function GenerationUpgradeNotice({ destination, onError, onUpgrade, visit }: { visit?: OfferVisit; destination: StudioDestination; onError: (message: string) => void; onUpgrade: () => void }) {
  const { t } = useI18n();
  const subscription = useSubscriptionOpener(
    element => {
      reportCreativeClick('creative_studio', 'asset_create', element, destinationTarget(destination));
    },
    onError,
    () => { void gatewayRequest('settings/account?refresh=true').then(notifyProvidersChanged).catch((error: Error) => onError(error.message)); },
  );
  const { title, details } = generationOfferCopy(destination, 'upgrade');
  return <MultimodalUpgradeCard
    subscription={subscription}
    visit={visit}
    model={destination.model ?? undefined}
    onUpgrade={onUpgrade}
    title={t(title)}
    details={t(details)}
    buttonLabel={t('Upgrade', undefined, 'generation offer')}
  />;
}

export function GenerationSignInNotice({ destination, onSignIn, visit }: { visit?: OfferVisit; destination: StudioDestination; onSignIn: () => void }) {
  const { t } = useI18n(), toast = useToast();
  const { state, busy, action } = useAccountSignIn(destination, toast.showToast);
  const retry = !state.account && state.error;
  const { title, details } = generationOfferCopy(destination, 'sign_in');
  const signInCard = (onClick: () => void) => <MultimodalOfferCard kind="sign_in" visit={state.account ? visit : undefined} title={t(title)} details={t(details)}>
    <Button variant="plain" className={styles.signInButton} disabled={state.account ? busy : !state.error} onClick={onClick}>
      {t(retry ? 'Retry' : 'Sign in now')}
      <RemixIcon name={retry ? 'refresh-line' : 'arrow-right-up-line'} size={12} />
    </Button>
  </MultimodalOfferCard>;
  return <>
    {state.account ? <AccountStatus account={state.account} busy={busy} showToast={toast.showToast} renderSignIn={() => signInCard(() => {
        onSignIn();
        void action('login', visit && reportOfferClick(visit, 'sign_in', destination.model));
      })}
      action={name => { if (name === 'login') onSignIn(); return action(name); }} />
      : signInCard(() => void state.refresh())}
    <StudioToastViewport {...toast} />
  </>;
}
