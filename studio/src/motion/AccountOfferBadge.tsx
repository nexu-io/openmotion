import { RemixIcon } from '../icons/RemixIcons';

export function AccountOfferBadge({ label, detail, appearance = 'callout' }: {
  label: string; detail?: string; appearance?: 'inline' | 'callout' | 'compact';
}) {
  return <span className={appearance === 'inline' ? 'om-account-offer' : 'om-account-offer om-account-offer-callout'}
    data-size={appearance === 'compact' ? 'compact' : undefined}>
    <RemixIcon name="sparkling-fill" size={appearance === 'compact' ? 12 : 15} />
    <strong>{label}</strong>{detail && <span>{detail}</span>}
  </span>;
}
