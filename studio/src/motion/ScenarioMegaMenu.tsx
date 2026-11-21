import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { cleanLegacyScenarioTitle, findScenario, type ScenarioId } from '../../../shared/scenarios';
import type { ScenarioRunSummary } from '../../../shared/scenario-runs';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { scenarioCover } from '../scenario/scenarioCovers';
import { scenarioClient } from '../scenario/scenarioClient';
import { scenarioStudio, studioDeliverables, studioScenes, studiosForScene, type StudioSceneId } from '../scenario/scenarioStudios';
import { ExploreCoverImage } from './ExploreCoverImage';
import './scenarioNavigation.css';

const MAX_MEGA_RECENT = 3;
const MEGA_RECENT_FETCH_LIMIT = 15;

export function selectMegaMenuRecentRuns(
  runs: readonly ScenarioRunSummary[],
  maxItems = MAX_MEGA_RECENT,
): { visible: ScenarioRunSummary[]; hiddenCount: number } {
  const seenScenarios = new Set<ScenarioId>();
  const visible: ScenarioRunSummary[] = [];
  for (const run of runs) {
    if (run.archivedAt !== null) continue;
    if (seenScenarios.has(run.scenarioId)) continue;
    seenScenarios.add(run.scenarioId);
    visible.push(run);
    if (visible.length >= maxItems) break;
  }
  const activeCount = runs.filter(run => run.archivedAt === null).length;
  return {
    visible,
    hiddenCount: Math.max(0, activeCount - visible.length),
  };
}

export function ScenarioMegaMenu({
  activeScenarioId,
  onSelect,
  onOpenHub,
}: {
  activeScenarioId: ScenarioId | 'hub' | null;
  onSelect: (id: ScenarioId, runId?: string) => void;
  onOpenHub: () => void;
}) {
  const { t } = useI18n();
  const [recentRuns, setRecentRuns] = useState<ScenarioRunSummary[]>([]);
  const [hiddenRecentCount, setHiddenRecentCount] = useState(0);
  const [hasMoreRecent, setHasMoreRecent] = useState(false);
  const [scene, setScene] = useState<StudioSceneId>('all');

  useEffect(() => {
    let cancelled = false;
    scenarioClient
      .list({ limit: MEGA_RECENT_FETCH_LIMIT })
      .then(result => {
        if (!cancelled && Array.isArray(result?.runs)) {
          const { visible, hiddenCount } = selectMegaMenuRecentRuns(result.runs, MAX_MEGA_RECENT);
          setRecentRuns(visible);
          setHiddenRecentCount(hiddenCount);
          setHasMoreRecent(result.nextOffset !== null && result.nextOffset !== undefined);
        }
      })
      .catch(() => {
        // Optional recent-runs strip stays hidden if the run service is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const studios = studiosForScene(scene);

  return (
    <div className="om-scenario-mega" data-studio-scene={scene}>
      <div className="om-studio-mega-head">
        <RemixIcon name="sparkling-fill" size={16} aria-hidden="true" />
        <h2>{t('Studios')}</h2>
        <span>{t('One brief in, a full kit out')}</span>
      </div>
      <div className="om-studio-mega-scenes" role="tablist" aria-label={t('Scenes')}>
        {studioScenes.map(item => (
          <Button
            key={item.id}
            variant="plain"
            role="tab"
            aria-selected={scene === item.id}
            className="om-studio-mega-scene"
            data-studio-scene-tab={item.id}
            onClick={() => setScene(item.id)}
          >
            {t(item.label)}
          </Button>
        ))}
      </div>
      <div className="om-studio-mega-grid" role="tabpanel">
        {studios.map(scenario => (
          <Button
            key={scenario.id}
            variant="plain"
            className="om-studio-mega-card"
            data-scenario-tile={scenario.id}
            aria-current={activeScenarioId === scenario.id ? 'page' : undefined}
            onClick={() => onSelect(scenario.id)}
          >
            <span className="om-studio-mega-art" aria-hidden="true">
              <ExploreCoverImage src={scenarioCover(scenario.id)} eager />
              {scenario.badge && (
                <span className="om-badge" data-nav-badge={scenario.badge} lang="en">
                  {scenario.badge}
                </span>
              )}
            </span>
            <strong className="om-studio-mega-title">{t(scenarioStudio(scenario.id).title)}</strong>
            <span className="om-studio-mega-kit">
              {studioDeliverables(scenario).map(step => t(step.title)).join(' · ')}
            </span>
          </Button>
        ))}
      </div>
      <div className="om-scenario-mega-footer">
        {recentRuns.length > 0 && (
          <div className="om-scenario-mega-recent" aria-label={t('Recent')}>
            <span className="om-scenario-mega-recent-label">{t('Recent')}</span>
            <div className="om-scenario-mega-recent-list">
              {recentRuns.map(run => {
                const def = findScenario(run.scenarioId);
                const displayTitle = cleanLegacyScenarioTitle(run.title);
                return (
                  <Button
                    key={run.id}
                    variant="plain"
                    className="om-nav-item om-scenario-mega-run"
                    title={def ? `${t(scenarioStudio(def.id).title)} · ${displayTitle}` : displayTitle}
                    onClick={() => onSelect(run.scenarioId, run.id)}
                  >
                    <RemixIcon name={def?.icon ?? 'time-line'} size={13} aria-hidden="true" />
                    <span className="om-scenario-mega-run-title">{displayTitle}</span>
                  </Button>
                );
              })}
              {(hiddenRecentCount > 0 || hasMoreRecent) && (
                <Button
                  variant="plain"
                  className="om-nav-item om-scenario-mega-more"
                  title={t('Manage run history')}
                  onClick={onOpenHub}
                >
                  {hiddenRecentCount > 0
                    ? t('+{count} more', { count: hiddenRecentCount })
                    : t('More')}
                </Button>
              )}
            </div>
          </div>
        )}
        <Button
          variant="plain"
          className="om-nav-item om-scenario-mega-all"
          onClick={onOpenHub}
        >
          <span>{t('All workflows')}</span>
          <RemixIcon name="arrow-right-line" size={15} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
