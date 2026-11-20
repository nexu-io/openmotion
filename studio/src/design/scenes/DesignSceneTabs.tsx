import { Button } from 'open-design-ui/button';
import { RemixIcon } from '../../../../packages/design-system/react/RemixIcons';
import { designScenarios, type DesignScenarioId } from '../../../../shared/design-project';
import { useI18n } from '../../i18n/I18n';
import '../design.css';

export type DesignTabId = DesignScenarioId | 'projects';

export function DesignSceneTabs({
  activeTab,
  onSelectDesignScene,
}: {
  activeTab: DesignTabId | null;
  onSelectDesignScene: (scene: DesignTabId) => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <span className="om-design-divider" aria-hidden="true" />
      <span className="om-design-scene-tabs">
        <Button
          type="button"
          variant="plain"
          className="om-nav-item"
          aria-current={activeTab === 'projects' ? 'page' : undefined}
          onClick={() => onSelectDesignScene('projects')}
        >
          <RemixIcon name="folder-open-line" size={14} />
          {t('Projects')}
        </Button>
        {designScenarios.map(scenario => (
          <Button
            key={scenario.id}
            type="button"
            variant="plain"
            className="om-nav-item"
            aria-current={activeTab === scenario.id ? 'page' : undefined}
            onClick={() => onSelectDesignScene(scenario.id)}
          >
            <RemixIcon name={scenario.icon} size={14} />
            {t(scenario.label)}
          </Button>
        ))}
      </span>
    </>
  );
}
