import { Button } from 'open-design-ui/button';
import { Tooltip } from '../../components/ui/Tooltip';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { useOptionalGrowthSurfaces } from './GrowthSurfacesContext';

export function ProductionCampaignBadge() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const growth = useOptionalGrowthSurfaces();
  const badge = growth?.badgeDecision ?? null;

  if (!collab?.snapshot?.signedIn || !growth || !badge) {
    return null;
  }

  return (
    <Tooltip label={badge.title || t('Campaign offer')} side="bottom">
      <Button
        variant="plain"
        type="button"
        className="om-nav-item om-touchpoint-badge"
        data-testid="touchpoint-campaign-badge"
        aria-label={badge.badgeLabel}
        onClick={() => growth.openCampaignModal()}
      >
        <RemixIcon name="gift-line" size={14} />
        <span className="om-touchpoint-badge-label">{badge.badgeLabel}</span>
      </Button>
    </Tooltip>
  );
}
