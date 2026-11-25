export type ArtifactDeliveryKind = 'media' | 'export' | 'deliverable';

export type ArtifactDeliveredDetail = {
  kind: ArtifactDeliveryKind;
  label?: string;
  sourceId?: string;
};

export const ARTIFACT_DELIVERED_EVENT = 'openmotion:artifact-delivered';
export const ARTIFACT_UPGRADE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_UPGRADE_SHOWN_AT_KEY = 'openmotion.artifact-upgrade.shown-at';

let shownInSession = false;

export function emitArtifactDelivered(detail: ArtifactDeliveredDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ArtifactDeliveredDetail>(ARTIFACT_DELIVERED_EVENT, { detail }));
}

export function canShowArtifactUpgrade(now = Date.now()): boolean {
  if (shownInSession) return false;
  try {
    const raw = window.localStorage.getItem(ARTIFACT_UPGRADE_SHOWN_AT_KEY);
    if (!raw) return true;
    const shownAt = Number(raw);
    if (!Number.isFinite(shownAt)) return true;
    return now - shownAt >= ARTIFACT_UPGRADE_COOLDOWN_MS;
  } catch {
    return true;
  }
}

export function markArtifactUpgradeShown(now = Date.now()): void {
  shownInSession = true;
  try {
    window.localStorage.setItem(ARTIFACT_UPGRADE_SHOWN_AT_KEY, String(now));
  } catch {
    // In-memory session guard still prevents repeated prompts in this tab.
  }
}

/** Test hook: resets session and persistent cooldown state. */
export function resetArtifactUpgradeCooldown(): void {
  shownInSession = false;
  try {
    window.localStorage.removeItem(ARTIFACT_UPGRADE_SHOWN_AT_KEY);
  } catch {
    // Ignore storage unavailability in non-browser tests.
  }
}
