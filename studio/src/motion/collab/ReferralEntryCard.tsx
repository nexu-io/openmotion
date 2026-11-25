import { Button } from 'open-design-ui/button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

export function ReferralEntryCard() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const snapshot = collab?.snapshot;
  const referral = snapshot?.referral;
  if (!collab || !snapshot?.signedIn || !referral?.available) return null;

  return (
    <aside className="om-referral-card" data-testid="referral-entry-card">
      <div className="om-referral-card-leading">
        <span className="om-account-hub-reset-keycap" aria-hidden="true">reset</span>
        <div className="om-referral-card-copy">
          <strong className="om-subtitle">
            {t('Share OpenDesign · Earn reset cards')}
          </strong>
          <span className="om-muted">
            {t('{invited}/{target} teammates joined · {cards} reset cards ready', {
              invited: referral.invitedCount,
              target: referral.inviteTarget,
              cards: referral.resetCardsAvailable,
            })}
          </span>
        </div>
      </div>
      <Button
        variant="plain"
        type="button"
        className="om-collab-tonal-btn"
        disabled={Boolean(collab.openingCloudDestination)}
        aria-busy={collab.openingCloudDestination === 'referral' || undefined}
        onClick={() => void collab.openCloudLink('referral')}
      >
        <RemixIcon name="sparkling-line" size={15} />
        <span>{t('View referral link')}</span>
        <RemixIcon
          name={collab.openingCloudDestination === 'referral' ? 'loader-4-line' : 'external-link-line'}
          size={14}
          className={collab.openingCloudDestination === 'referral' ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
      </Button>
    </aside>
  );
}
