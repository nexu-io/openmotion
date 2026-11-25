import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

export type PriorityBannerResolution =
  | { kind: 'locked'; key: string }
  | { kind: 'referral'; key: string }
  | { kind: 'home-invite'; key: string }
  | { kind: 'campaign' }
  | null;

export function resolvePriorityBanner(options: {
  signedIn: boolean;
  isExploreHome: boolean;
  bfBannerVisible: boolean;
  lifecycleState?: string | null;
  weeklyLimitExhausted?: boolean;
  inviteeWindowActive?: boolean;
  canInviteMembers?: boolean;
  workspaceType?: string | null;
  workspaceId?: string | null;
  dismissedBanners?: string[];
}): PriorityBannerResolution {
  const dismissed = new Set(options.dismissedBanners ?? []);

  if (options.signedIn) {
    if (options.lifecycleState === 'locked' || options.lifecycleState === 'billing_past_due') {
      return { kind: 'locked', key: `locked:${options.workspaceId ?? 'ws'}` };
    }
    const referralKey = `referral:${options.workspaceId ?? 'ws'}`;
    if ((options.weeklyLimitExhausted || options.inviteeWindowActive) && !dismissed.has(referralKey)) {
      return { kind: 'referral', key: referralKey };
    }
    const inviteKey = `home-invite:${options.workspaceId ?? 'ws'}`;
    if (
      options.isExploreHome &&
      options.workspaceType === 'team' &&
      options.canInviteMembers &&
      !dismissed.has(inviteKey)
    ) {
      return { kind: 'home-invite', key: inviteKey };
    }
  }

  if (options.bfBannerVisible) {
    return { kind: 'campaign' };
  }

  return null;
}

export function WorkspaceCollabBanner({ banner }: { banner: Exclude<PriorityBannerResolution, { kind: 'campaign' } | null> }) {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;
  if (!collab || !snapshot || !active) return null;

  if (banner.kind === 'locked') {
    const canManage = snapshot.permissions.canManageBilling;
    return (
      <aside className="om-collab-top-banner" data-tone="danger" data-testid="top-banner-locked" aria-label={t('Workspace billing notice')}>
        <div className="om-collab-top-banner-copy">
          <RemixIcon name="lock-line" size={14} />
          <span>
            {t(
              canManage
                ? 'Workspace billing needs attention. Restore billing to resume team generation.'
                : 'Workspace billing is paused. Contact your workspace owner to restore access.',
            )}
          </span>
        </div>
        {canManage && (
          <Button
            variant="plain"
            type="button"
            className="om-collab-tonal-btn"
            data-compact="true"
            disabled={Boolean(collab.openingCloudDestination)}
            aria-busy={collab.openingCloudDestination === 'billing-recovery' || undefined}
            onClick={() => void collab.openCloudLink('billing-recovery')}
          >
            <span>{t('Restore billing')}</span>
            <RemixIcon
              name={collab.openingCloudDestination === 'billing-recovery' ? 'loader-4-line' : 'external-link-line'}
              size={13}
              className={collab.openingCloudDestination === 'billing-recovery' ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
          </Button>
        )}
      </aside>
    );
  }

  if (banner.kind === 'referral') {
    return (
      <aside className="om-collab-top-banner" data-tone="warning" data-testid="top-banner-referral" aria-label={t('Quota reset notice')}>
        <div className="om-collab-top-banner-copy">
          <RemixIcon name="sparkling-fill" size={14} />
          <span>{t('Weekly limit reached. Share OpenDesign with friends to earn quota reset cards.')}</span>
        </div>
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          data-compact="true"
          disabled={Boolean(collab.openingCloudDestination)}
          aria-busy={collab.openingCloudDestination === 'referral' || undefined}
          onClick={() => void collab.openCloudLink('referral')}
        >
          <span>{t('Get reset cards')}</span>
          <RemixIcon
            name={collab.openingCloudDestination === 'referral' ? 'loader-4-line' : 'external-link-line'}
            size={13}
            className={collab.openingCloudDestination === 'referral' ? 'animate-spin motion-reduce:animate-none' : undefined}
          />
        </Button>
        <IconButton
          variant="ghost"
          size="sm"
          className="om-collab-top-banner-close"
          aria-label={t('Dismiss notice')}
          onClick={() => void collab.dismissBanner(banner.key)}
          icon={<RemixIcon name="close-line" size={14} />}
        />
      </aside>
    );
  }

  return (
    <aside className="om-collab-top-banner" data-tone="accent" data-testid="top-banner-invite" aria-label={t('Team collaboration')}>
      <div className="om-collab-top-banner-copy">
        <RemixIcon name="group-line" size={14} />
        <span>
          {t('Invite teammates to {name} — free seats, shared projects and assets.', {
            name: active.workspaceName,
          })}
        </span>
      </div>
      <Button
        variant="plain"
        type="button"
        className="om-collab-tonal-btn"
        data-compact="true"
        onClick={() => collab.setInviteDialogOpen(true)}
      >
        <span>{t('Invite teammates')}</span>
      </Button>
      <IconButton
        variant="ghost"
        size="sm"
        className="om-collab-top-banner-close"
        aria-label={t('Dismiss notice')}
        onClick={() => void collab.dismissBanner(banner.key)}
        icon={<RemixIcon name="close-line" size={14} />}
      />
    </aside>
  );
}
