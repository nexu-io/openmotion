import { Button } from 'open-design-ui/button';
import { RemixIcon } from '../../../../packages/design-system/react/RemixIcons';
import { designScenarios, type DesignScenarioId } from '../../../../shared/design-project';
import { findMediaStudio, type StudioScene } from '../../../../shared/studio-catalog';
import { useI18n } from '../../i18n/I18n';
import { scenesForStudio } from '../../motion/creativeStudios';
import { HorizontalRail } from '../../motion/HorizontalRail';
import '../design.css';

export type DesignTabId = DesignScenarioId | 'projects';

const imageScenes = scenesForStudio(findMediaStudio('design')!);

export function DesignSceneTabs({
  activeTab,
  onSelectImageScene,
  onSelectDesignScene,
}: {
  activeTab: DesignTabId | StudioScene['id'];
  onSelectImageScene: (scene: StudioScene) => void;
  onSelectDesignScene: (scene: DesignTabId) => void;
}) {
  const { t } = useI18n();
  const tabs = [
    ...imageScenes.map(scene => ({
      id: scene.id,
      label: scene.label,
      icon: undefined,
      select: () => onSelectImageScene(scene),
    })),
    ...designScenarios.map(scenario => ({
      id: scenario.id,
      label: scenario.label,
      icon: scenario.icon,
      select: () => onSelectDesignScene(scenario.id),
    })),
  ];

  return (
    <nav className="om-design-scene-tabs" aria-label={t('Scenes')}>
      <HorizontalRail label="Scenes" viewportClassName="om-design-scene-tabs-viewport" selection={activeTab} revealSelectionOnMount={false} plainArrows>
        <div className="om-design-scene-tabs-track">
          {tabs.map(tab => (
            <Button
              key={tab.id}
              type="button"
              variant="plain"
              className="om-nav-item"
              icon={tab.icon ? <RemixIcon name={tab.icon} size={14} /> : undefined}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={tab.select}
            >
              {t(tab.label)}
            </Button>
          ))}
        </div>
      </HorizontalRail>
    </nav>
  );
}
