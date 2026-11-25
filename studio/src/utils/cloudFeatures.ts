import { CLOUD_P1_FEATURES, type CloudFeatureKey } from '../../../shared/cloud-features';
import { getCachedCloudDisklessMode, useCloudDisklessMode } from './cloudRuntime';

export { CLOUD_P1_FEATURES, type CloudFeatureKey };

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
