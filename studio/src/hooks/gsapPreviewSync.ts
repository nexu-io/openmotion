import { usePlayerStore } from "../player/store/playerStore";
import { applySoftReload, type SoftReloadResult } from "../utils/gsapSoftReload";
import { trackStudioEvent } from "../utils/studioTelemetry";
import { patchRuntimeTweenInPlace } from "./gsapRuntimePatch";
import type { CommitMutationOptions, MutationResult } from "./gsapScriptCommitTypes";

export function finishUnchangedMutation(
  iframe: HTMLIFrameElement | null,
  result: MutationResult,
  options: CommitMutationOptions,
  reloadPreview: () => void,
): boolean {
  if (result.changed !== false) return false;
  if (
    !options.skipReload &&
    (instantPatchesFor(options).length > 0 || options.previewFallbackLatch?.pending)
  ) {
    redrawUnlessPaintedBack(options, () =>
      applyPreviewSync(iframe, result, options, reloadPreview),
    );
  }
  return true;
}

export function redrawUnlessPaintedBack(options: CommitMutationOptions, redraw: () => void): void {
  if (options.pendingEdit) options.pendingEdit.drawUnlessUndone(redraw);
  else redraw();
}

export function refreshMutationPreview(
  iframe: HTMLIFrameElement | null,
  result: MutationResult,
  options: CommitMutationOptions,
  reloadPreview: () => void,
  onCacheInvalidate: () => void,
  nestedFiles?: Map<string, string> | null,
): void {
  redrawUnlessPaintedBack(options, () => {
    options.beforeReload?.();
    applyPreviewSync(iframe, result, options, reloadPreview, nestedFiles);
  });
  onCacheInvalidate();
}

/**
 * Apply a soft reload and enforce the U4 invariant via the richer
 * `SoftReloadResult`, with telemetry on every non-success path so the invariant
 * is observable in production, not just asserted in tests:
 *
 * - `"cannot-soft-reload"` (PERMANENT/STRUCTURAL: no gsap runtime, no rebind
 *   hook, no scopable key, no script element, or the sync re-run threw) →
 *   escalate to a full `reloadPreview()`; the preview is genuinely stale/broken.
 * - `"verify-failed"` (TRANSIENT: re-run happened, `__timelines` momentarily
 *   empty) → do NOT escalate; the live `gsap.set` already shows the correct value
 *   and a remount would re-flash the WebGL context + revert subcomp keyframes.
 * - `"applied"` → success (or deferred to async plugin load; `onAsyncFailure`
 *   covers the CDN-error escalation).
 */
export function softReloadOrEscalate(
  iframe: HTMLIFrameElement | null,
  scriptText: string,
  reloadPreview: () => void,
  origin: "preview_sync" | "sdk_refresh",
  authoredHtml?: string,
  nestedFiles?: Map<string, string> | null,
): void {
  // Seek the rebuilt timeline to the studio's own authoritative scrub position,
  // not the iframe's raw `__player.getTime()` — see the comment in
  // applySoftReload for why the two can desync after a keyframe-node drag.
  const currentTime = usePlayerStore.getState().currentTime;
  const result: SoftReloadResult = applySoftReload(iframe, scriptText, {
    onAsyncFailure: reloadPreview,
    currentTimeOverride: currentTime,
    authoredHtml,
    nestedFiles,
  });
  if (result === "applied") return;
  trackStudioEvent("gsap_soft_reload_outcome", {
    origin,
    result,
    escalated: result === "cannot-soft-reload",
  });
  // PERMANENT failure: the preview can't be soft-updated → full reload. TRANSIENT
  // "verify-failed" is suppressed (live state is correct).
  if (result === "cannot-soft-reload") reloadPreview();
}

/**
 * Sync the preview after a persisted commit. For a value-only edit
 * (`options.instantPatch`), try the in-place runtime patch first: on success the
 * preview is already correct, so we skip the reload entirely (instant). On `false`
 * — or when no `instantPatch` is supplied — fall back to the existing soft/full
 * reload. Pure (no React) so `runCommit`'s preview-sync decision is unit-testable.
 */
export function applyPreviewSync(
  iframe: HTMLIFrameElement | null,
  result: MutationResult,
  options: CommitMutationOptions,
  reloadPreview: () => void,
  nestedFiles?: Map<string, string> | null,
): void {
  const patches = instantPatchesFor(options);
  const writtenWithoutPatch = patches.length === 0;
  let needsFallback = options.previewFallbackLatch?.pending === true || writtenWithoutPatch;
  if (patches.length > 0) {
    const deferSeek = options.deferPreviewSync === true;
    const missed = patches.find(
      (patch, index) =>
        !patchRuntimeTweenInPlace(
          iframe,
          patch.selector,
          patch.change,
          undefined,
          deferSeek || index < patches.length - 1,
        ),
    );
    if (missed) {
      // The instant path couldn't patch in place — record the fallback so we can
      // track how often the fast path misses before the soft/full reload below.
      trackStudioEvent("gsap_instant_patch_fallback", { selector: missed.selector });
      needsFallback = true;
    }
    // Patched in place — elements are already correct on screen; no reload needed
    // unless an earlier deferred batch left one member unpatched.
    if (!needsFallback) return;
  }
  // Written, but the caller has more writes to make and will render after the last.
  if (options.deferPreviewSync && options.previewFallbackLatch) {
    options.previewFallbackLatch.pending = needsFallback;
    return;
  }
  if (options.deferPreviewSync && !needsFallback) return;
  if (options.previewFallbackLatch) options.previewFallbackLatch.pending = false;
  if (options.softReload && result.scriptText) {
    // A soft-reloadable edit escalates to a full iframe remount ONLY on the
    // PERMANENT "cannot-soft-reload" result (the preview is genuinely stale/
    // broken). The TRANSIENT "verify-failed" does NOT escalate — the value is
    // already correct on screen, and a remount re-flashes the WebGL context AND
    // re-inlines subcomps (reverting their keyframes). The async MotionPath-plugin
    // load failure escalates separately via `onAsyncFailure`.
    softReloadOrEscalate(
      iframe,
      result.scriptText,
      reloadPreview,
      "preview_sync",
      result.after ?? undefined,
      nestedFiles,
    );
  } else {
    reloadPreview();
  }
}

function instantPatchesFor(
  options: CommitMutationOptions,
): NonNullable<CommitMutationOptions["instantPatches"]> {
  return [
    ...(options.instantPatches ?? []),
    ...(options.instantPatch ? [options.instantPatch] : []),
  ];
}
