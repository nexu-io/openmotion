import type { ArtifactDeliveryKind } from './artifactDeliveryBus';

export const EXPERIENCE_SURVEY_RETIRED_KEY = 'openmotion.experience-survey.retired.v1';
export const EXPERIENCE_SURVEY_DELIVERIES_KEY = 'openmotion.experience-survey.deliveries.v1';
export const EXPERIENCE_SURVEY_MIN_DELIVERIES = 1;
export const EXPERIENCE_SURVEY_DELAY_MS = 2500;
export const EXPERIENCE_SURVEY_THANK_YOU_CLOSE_MS = 1800;
export const EXPERIENCE_SURVEY_MAX_FEEDBACK_CHARS = 240;

export const EXPERIENCE_SURVEY_IMPROVEMENTS = [
  'wrong_output',
  'incomplete_output',
  'hard_to_use',
  'stuck_or_failed',
  'too_slow',
  'visual_quality',
  'other',
] as const;

export type ExperienceSurveyImprovement = (typeof EXPERIENCE_SURVEY_IMPROVEMENTS)[number];
export type ExperienceSurveyTrigger = 'post_generation' | 'post_export' | 'post_deliverable';

export function mapArtifactKindToSurveyTrigger(kind: ArtifactDeliveryKind): ExperienceSurveyTrigger {
  if (kind === 'media') return 'post_generation';
  if (kind === 'export') return 'post_export';
  return 'post_deliverable';
}

export function isSurveyRetired(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(EXPERIENCE_SURVEY_RETIRED_KEY) === '1';
  } catch {
    // Fail-closed when storage is unavailable so private sessions are never nagged.
    return true;
  }
}

export function retireSurvey(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(EXPERIENCE_SURVEY_RETIRED_KEY, '1');
  } catch {
    // Non-fatal in private browsing.
  }
}

export function readSurveyDeliveries(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(EXPERIENCE_SURVEY_DELIVERIES_KEY);
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function incrementSurveyDeliveries(): number {
  if (isSurveyRetired() || typeof window === 'undefined') return 0;
  const next = readSurveyDeliveries() + 1;
  try {
    window.localStorage.setItem(EXPERIENCE_SURVEY_DELIVERIES_KEY, String(next));
  } catch {
    // Non-fatal in private browsing.
  }
  return next;
}

export function resetExperienceSurveyForTest(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(EXPERIENCE_SURVEY_RETIRED_KEY);
    window.localStorage.removeItem(EXPERIENCE_SURVEY_DELIVERIES_KEY);
  } catch {
    // Ignore storage errors in tests.
  }
}
