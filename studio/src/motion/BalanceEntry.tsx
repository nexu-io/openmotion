import { type MouseEvent } from 'react';
import { MenuItem } from '../components/ui/Menu';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';
import type { CreativePage } from './exploreTracking';
import type { AccountSummary } from '../../../shared/provider-directory';
import { trackMotion } from './tracking';
import styles from './BalanceEntry.module.css';

const amount = (value: string) => { const number = Number(value); return value.trim() !== '' && Number.isFinite(number) ? number : null; };

/** Shows an OpenDesign balance string as dollars with two decimals; anything that is not a number is shown as given. */
export function formatBalance(balance: string) {
  const value = amount(balance);
  return value === null ? `$${balance}` : `$${value.toFixed(2)}`;
}

/** The plan's display name: `free` becomes the Free plan; other tiers are capitalised, as the account service names them. */
export function planLabel(plan: string, t: (message: string, values?: Record<string, string | number>) => string) {
  const name = plan.trim();
  if (!name || name.toLowerCase() === 'free') return t('Free plan');
  return t('{plan} plan', { plan: name.charAt(0).toUpperCase() + name.slice(1) });
}

/** Share of the Design Plan quota left, 0–1, from the account's tightest quota window; null when there is none. */
export function quotaShare(quota?: AccountSummary['quota']) {
  if (!quota || !Number.isFinite(quota.remainingPercent)) return null;
  return Math.min(1, Math.max(0, quota.remainingPercent / 100));
}

/** A circle round the 30px avatar, clockwise from the top. */
const OUTLINE = 'M15 1.5 A13.5 13.5 0 1 1 14.99 1.5';

/** Remaining plan credits as a ring round the avatar; laid over it, the ring adds no size of its own. */
export function BalanceRing({ share }: { share: number }) {
  const percent = Math.round(share * 100);
  return <svg className={styles.ring} viewBox="0 0 30 30" aria-hidden="true" data-share={percent}>
    <path className={styles.ringTrack} d={OUTLINE} pathLength={100} />
    {percent > 0 && <path className={styles.ringFill} d={OUTLINE} pathLength={100} strokeDasharray={`${percent} 100`} />}
  </svg>;
}

/** Signed-in header avatar: a round initial inside the remaining-credits ring. */
export function AccountAvatar({ initial, share }: { initial?: string; share: number | null }) {
  return <>
    {share !== null && <BalanceRing share={share} />}
    <span className={styles.face}>{initial}</span>
  </>;
}

/**
 * Account menu row: with a Design Plan quota, how much of it is left as a percentage and a bar, the wallet balance
 * below; without one, the wallet balance left. Opens Subscription & usage.
 */
export function BalanceMenuItem({ balance, quota, trackingPage, openUsage }: { balance: string | null; quota?: AccountSummary['quota']; trackingPage?: CreativePage; openUsage: () => void }) {
  const { t } = useI18n();
  const share = quotaShare(quota), wallet = balance === null ? null : formatBalance(balance);
  if (share === null && wallet === null) return null;
  const percent = share === null ? null : `${Math.round(share * 100)}%`;
  const label = percent ? t('Plan quota') : t('Available balance'), left = percent ?? wallet!;
  function open(event: MouseEvent) {
    if (trackingPage) void trackMotion('ui_click', { page_name: trackingPage, area: 'header', element: 'open_balance', interaction_method: event.detail === 0 ? 'keyboard' : 'pointer' });
    openUsage();
  }
  return <MenuItem className={styles.item} onClick={open} aria-label={`${label} · ${t('Remaining')} ${left}${percent && wallet ? ` · ${t('Available balance')} ${wallet}` : ''}`}>
    <span className={styles.row}>
      <span>{label}</span>
      <span className={styles.left}>{t('Remaining')} {left}<RemixIcon name="arrow-right-s-line" size={14} /></span>
    </span>
    {share !== null && <span className={styles.meter} aria-hidden="true"><span className={styles.fill} style={{ width: `${Math.round(share * 100)}%` }} /></span>}
    {percent && wallet && <span className={styles.wallet}>{t('Available balance')} {wallet}</span>}
  </MenuItem>;
}
