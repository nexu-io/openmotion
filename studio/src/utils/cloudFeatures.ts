import { getCachedCloudDisklessMode, useCloudDisklessMode } from './cloudRuntime';

/**
 * Cloud Phase 1 feature availability switches.
 *
 * Local desktop/CLI mode (`cloud-diskless` not active) leaves every feature enabled.
 * Cloud Phase 1 hides features whose backend or desktop-only surfaces are deferred to Phase 2.
 * When a feature ships in Cloud, flip its flag to `true` (or delete the key and let TypeScript
 * highlight every gate site to clean up).
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
} as const;

export type CloudFeatureKey = keyof typeof CLOUD_P1_FEATURES;

let testOverrides: Partial<Record<CloudFeatureKey, boolean>> | null = null;

/** Test-only override helper; pass `null` to restore runtime defaults. */
export function setCloudFeatureOverridesForTest(
  overrides: Partial<Record<CloudFeatureKey, boolean>> | null,
): void {
  testOverrides = overrides;
}

export function isCloudFeatureEnabled(
  feature: CloudFeatureKey,
  cloudDiskless = getCachedCloudDisklessMode(),
): boolean {
  if (testOverrides && feature in testOverrides) {
    return Boolean(testOverrides[feature]);
  }
  if (!cloudDiskless) return true;
  return CLOUD_P1_FEATURES[feature];
}

export function useCloudFeatureEnabled(feature: CloudFeatureKey): boolean {
  const cloudDiskless = useCloudDisklessMode();
  return isCloudFeatureEnabled(feature, cloudDiskless);
}
