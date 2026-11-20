import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { RemixIcon } from '../../../../packages/design-system/react/RemixIcons';
import { designBriefPrompt, designScenarios, findDesignScenario, type DesignScenarioId, type DesignTemplateSummary } from '../../../../shared/design-project';
import { StudioToastViewport } from '../../components/StudioToastViewport';
import { useToast } from '../../hooks/useToast';
import { useI18n } from '../../i18n/I18n';
import { useIntegrationInfo } from '../../motion/useIntegrationInfo';
import { designClient } from '../designClient';
import { DesignTemplateDetailModal } from '../DesignTemplateDetailModal';
import { ScaledPreviewThumb } from '../ScaledPreviewThumb';
import type { DesignTabId } from './DesignSceneTabs';
import '../design.css';

/**
 * Design Studio HTML scenarios and live-preview starter template shelf embedded in Explore.
 */
export function ExploreDesignSection({
  onSelectDesignScene,
  onOpenProject,
}: {
  onSelectDesignScene: (scene: DesignTabId) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const { t, locale } = useI18n();
  const { info: integrationInfo } = useIntegrationInfo();
  const toast = useToast();
  const [templates, setTemplates] = useState<DesignTemplateSummary[]>([]);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    designClient.listTemplates({ limit: 8 }).then(res => {
      if (active && Array.isArray(res?.items)) setTemplates(res.items);
    }).catch(() => { /* optional in offline/mocked tests */ });
    return () => { active = false; };
  }, []);

  const remix = async (tpl: DesignTemplateSummary) => {
    try {
      const { project } = await designClient.createProject({ scenario: tpl.scenario as DesignScenarioId, templateId: tpl.id });
      onOpenProject(project.id);
    } catch {
      onSelectDesignScene(tpl.scenario);
    }
  };

  const useWithAgent = async (tpl: DesignTemplateSummary) => {
    const prompt = designBriefPrompt({
      scenario: tpl.scenario,
      brief: tpl.examplePrompt || `Adapt the "${tpl.title}" template for my project.`,
      templateIds: [tpl.id],
      language: locale !== 'en' ? locale : null,
      integration: integrationInfo,
    });
    try {
      await navigator.clipboard.writeText(prompt);
      toast.showToast(t('Copied. Paste into your Agent.'), 'info', 'feedback');
    } catch {
      toast.showToast(t('Copy failed. Check clipboard permissions and try again.'), 'error', 'feedback');
    }
  };

  return (
    <div className="om-design-explore-block" data-design-explore-section="">
      <div className="om-design-section-head">
        <span className="om-design-muted">{t('HTML design scenarios · built with your MCP Agent')}</span>
        <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="folder-open-line" size={14} />} onClick={() => onSelectDesignScene('projects')}>
          {t('All design projects')}
        </Button>
      </div>

      <div className="om-design-scenario-grid">
        {designScenarios.map(scenario => (
          <Button
            key={scenario.id}
            type="button"
            variant="ghost"
            className="om-design-scenario-card"
            data-design-scenario={scenario.id}
            onClick={() => onSelectDesignScene(scenario.id)}
          >
            <div className="om-design-scenario-inner">
              <div className="om-design-scenario-top">
                <span className="om-design-icon-well">
                  <RemixIcon name={scenario.icon} size={17} />
                </span>
                <RemixIcon name="arrow-right-up-line" size={15} />
              </div>
              <strong className="om-design-card-title">{t(scenario.label)}</strong>
              <p className="om-design-card-desc">{t(scenario.hint)}</p>
            </div>
          </Button>
        ))}
      </div>

      {templates.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span className="om-design-muted">{t('Design templates')}</span>
          <div className="om-design-grid">
            {templates.slice(0, 8).map((tpl, idx) => {
              const scen = findDesignScenario(tpl.scenario);
              return (
                <article key={tpl.id} className="om-design-card" data-design-template={tpl.id}>
                  <div style={{ cursor: 'pointer' }} onClick={() => setPreviewIdx(idx)}>
                    <ScaledPreviewThumb
                      src={tpl.previewUrl}
                      title={tpl.title}
                      badge={scen ? t(scen.label) : tpl.scenario}
                    />
                  </div>
                  <div className="om-design-card-body">
                    <strong className="om-design-card-title" style={{ cursor: 'pointer' }} onClick={() => setPreviewIdx(idx)}>{tpl.title}</strong>
                    <p className="om-design-card-desc">{tpl.description}</p>
                    <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
                      <Button type="button" size="sm" variant="primary" onClick={() => onSelectDesignScene(tpl.scenario)}>{t('Try')}</Button>
                      <Button type="button" size="sm" variant="secondary" onClick={() => void remix(tpl)}>{t('Remix')}</Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {previewIdx !== null && (
        <DesignTemplateDetailModal
          templates={templates.slice(0, 8)}
          index={previewIdx}
          onNavigate={setPreviewIdx}
          onClose={() => setPreviewIdx(null)}
          onRemix={tpl => { void remix(tpl); setPreviewIdx(null); }}
          onUseWithAgent={tpl => { void useWithAgent(tpl); }}
        />
      )}

      <StudioToastViewport toasts={toast.toasts} dismissToast={toast.dismissToast} />
    </div>
  );
}
