import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import {
  EXPERIENCE_SURVEY_IMPROVEMENTS,
  EXPERIENCE_SURVEY_MAX_FEEDBACK_CHARS,
  type ExperienceSurveyImprovement,
} from './experienceSurveyState';
import { useOptionalGrowthSurfaces } from './GrowthSurfacesContext';

const SCORE_SCALE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

const IMPROVEMENT_LABELS: Record<ExperienceSurveyImprovement, string> = {
  wrong_output: 'Wrong result',
  incomplete_output: 'Incomplete result',
  hard_to_use: 'Hard to use',
  stuck_or_failed: 'Stuck or failed',
  too_slow: 'Too slow',
  visual_quality: 'Visual quality',
  other: 'Other',
};

export function ExperienceSurveyCard() {
  const { t } = useI18n();
  const growth = useOptionalGrowthSurfaces();
  const [selectedScore, setSelectedScore] = useState<number | null>(null);
  const [selectedImprovement, setSelectedImprovement] = useState<ExperienceSurveyImprovement | null>(null);
  const [note, setNote] = useState('');

  const open = Boolean(growth?.surveyOpen);
  const submitted = Boolean(growth?.surveySubmitted);

  useEffect(() => {
    if (!open) {
      setSelectedScore(null);
      setSelectedImprovement(null);
      setNote('');
    }
  }, [open]);

  if (!growth || !open) return null;

  if (submitted) {
    return (
      <aside
        className="om-survey-card om-selection-panel"
        role="status"
        aria-live="polite"
        aria-label={t('Experience survey')}
        data-testid="experience-survey-card"
      >
        <div className="om-survey-thanks">
          <span className="om-survey-thanks-icon" aria-hidden="true">
            <RemixIcon name="check-line" size={18} />
          </span>
          <div className="om-survey-thanks-copy">
            <h2 className="om-survey-title">{t('Thank you for your feedback!')}</h2>
            <p className="om-survey-subtitle">{t('Your response helps improve OpenMotion.')}</p>
          </div>
          <IconButton
            variant="ghost"
            type="button"
            className="motion-icon-button om-survey-close"
            onClick={growth.dismissSurvey}
            aria-label={t('Dismiss feedback')}
            icon={<RemixIcon name="close-line" size={16} />}
          />
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="om-survey-card om-selection-panel"
      role="dialog"
      aria-modal="false"
      aria-label={t('Experience survey')}
      data-testid="experience-survey-card"
    >
      <div className="om-survey-header">
        <div className="om-survey-header-copy">
          <div className="om-survey-kicker">
            <RemixIcon name="sparkling-line" size={14} />
            <span>{t('Quick feedback')}</span>
          </div>
          <h2 className="om-survey-title">
            {selectedScore === null
              ? t('How likely are you to recommend OpenMotion?')
              : t('Thanks! Anything we could improve?')}
          </h2>
        </div>
        <IconButton
          variant="ghost"
          type="button"
          className="motion-icon-button om-survey-close"
          onClick={growth.dismissSurvey}
          aria-label={t('Dismiss feedback')}
          icon={<RemixIcon name="close-line" size={16} />}
        />
      </div>

      {selectedScore === null ? (
        <div className="om-survey-step">
          <div className="om-survey-scores" role="group" aria-label={t('Recommendation score from 0 to 10')}>
            {SCORE_SCALE.map(value => (
              <Button
                key={value}
                variant="plain"
                type="button"
                className="om-survey-score-btn"
                onClick={() => setSelectedScore(value)}
                aria-label={String(value)}
              >
                {value}
              </Button>
            ))}
          </div>
          <div className="om-survey-anchors">
            <span>{t('Not likely')}</span>
            <span>{t('Very likely')}</span>
          </div>
          <div className="om-survey-footer">
            <Button variant="plain" type="button" className="om-survey-text-btn" onClick={growth.dismissSurvey}>
              {t('Skip')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="om-survey-step">
          <div className="om-survey-score-summary">
            <span className="om-survey-score-pill">
              {t('Score: {score}/10', { score: String(selectedScore) })}
            </span>
            <Button
              variant="plain"
              type="button"
              className="om-survey-text-btn"
              onClick={() => setSelectedScore(null)}
            >
              {t('Back')}
            </Button>
          </div>

          <div className="om-survey-chips" role="group" aria-label={t('Area to improve (optional)')}>
            {EXPERIENCE_SURVEY_IMPROVEMENTS.map(key => {
              const active = selectedImprovement === key;
              return (
                <Button
                  key={key}
                  variant="plain"
                  type="button"
                  className="om-survey-chip"
                  data-selected={active ? 'true' : undefined}
                  aria-pressed={active}
                  onClick={() => setSelectedImprovement(current => (current === key ? null : key))}
                >
                  {t(IMPROVEMENT_LABELS[key])}
                </Button>
              );
            })}
          </div>

          <textarea
            className="om-field om-survey-textarea"
            rows={2}
            maxLength={EXPERIENCE_SURVEY_MAX_FEEDBACK_CHARS}
            value={note}
            onChange={event => setNote(event.target.value)}
            placeholder={t('Optional: share a quick note (max 240 chars)')}
            aria-label={t('Optional feedback note')}
          />

          <div className="om-survey-footer">
            <span className="om-survey-counter">
              {note.length}/{EXPERIENCE_SURVEY_MAX_FEEDBACK_CHARS}
            </span>
            <div className="om-survey-actions">
              <Button
                variant="primary"
                type="button"
                className="om-survey-submit-btn"
                onClick={() => growth.submitSurvey(selectedScore, selectedImprovement ?? undefined, note)}
              >
                {t('Submit')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
