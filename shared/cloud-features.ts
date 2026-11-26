/**
 * Cloud Phase 1 feature availability switches shared between Studio and the Cloud API.
 *
 * Local desktop/CLI mode (`cloud-diskless` not active) leaves every feature enabled.
 * Cloud Phase 1 hides features whose backend or desktop-only surfaces are deferred to Phase 2
 * (or temporarily hidden in Cloud P1). When a feature ships in Cloud, flip its flag to `true`
 * (or delete the key and let TypeScript highlight every gate site to clean up).
 */
export const CLOUD_P1_FEATURES = {
  localAgents: false,
  modelProviders: false,
  gameStudio: false,
  workflows: false,
  designStudio: false,
  asr: false,
  brandKit: false,
  reviewComments: false,
  customVoiceId: false,
} as const;

export type CloudFeatureKey = keyof typeof CLOUD_P1_FEATURES;
