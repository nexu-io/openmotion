import type { ReactNode } from 'react';
import { Button } from 'open-design-ui/button';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { reportOfferClick, useOfferImpression, type OfferKind, type OfferVisit } from './offerTracking';
import type { useSubscriptionOpener } from './useSubscriptionOpener';
import styles from './GenerationOffer.module.css';

export function MultimodalOfferCard({ title, details, children, visit, kind }: {
  title: string; details: string; children: ReactNode; visit?: OfferVisit; kind: OfferKind;
}) {
  const card = useOfferImpression(visit, kind);
  return <section ref={card} data-generation-offer={visit ? kind : undefined} className={styles.card} aria-label={title}>
    <h3>{title}</h3>
    <p title={details}>{details}</p>
    {children}
  </section>;
}

export function MultimodalUpgradeButton({ subscription, label, visit, onUpgrade, model }: { subscription: ReturnType<typeof useSubscriptionOpener>; label?: string; onUpgrade?: () => void; model?: string; visit?: OfferVisit }) {
  const { t } = useI18n();
  return subscription.link ?? <Button variant="plain" onClick={() => { onUpgrade?.(); void subscription.openSubscription('view_plans', visit && reportOfferClick(visit, 'upgrade', model)); }}>
    {label ?? t('Upgrade to Plus')}<RemixIcon name="arrow-right-up-line" size={12} />
  </Button>;
}

export function MultimodalUpgradeCard({ subscription, visit, title, details, buttonLabel, onUpgrade, model }: {
  subscription: ReturnType<typeof useSubscriptionOpener>; visit?: OfferVisit; title?: string; details?: string; buttonLabel?: string; model?: string; onUpgrade?: () => void;
}) {
  const { t } = useI18n();
  return <MultimodalOfferCard kind="upgrade" visit={visit} title={title ?? t('Unlock multimodal creation')} details={details ?? t('Black Friday’s lowest prices of the year! 7 days of unlimited use')}>
    <MultimodalUpgradeButton subscription={subscription} label={buttonLabel} visit={visit} model={model} onUpgrade={onUpgrade} />
  </MultimodalOfferCard>;
}
