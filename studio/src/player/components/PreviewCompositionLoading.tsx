import { useEffect, useId, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18n";
import { usePlayerStore } from "../store/playerStore";

interface PreviewCompositionLoadingProps {
  showMark?: boolean;
  canEditWhileLoading?: boolean;
  assetGeneration?: { readonly current: number };
  loadingPoster?: ReactNode;
}

/** Bound the loading message, not the player's wait for a displayable frame. */
export function PreviewCompositionLoading({ loadingPoster, ...status }: PreviewCompositionLoadingProps) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), 3_000);
    return () => clearTimeout(timer);
  }, []);

  if (!expired) return <CompositionLoadingStatus {...status} />;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden bg-[var(--motion-canvas)]"
      data-hyperframes-ignore=""
      data-testid="composition-loading-backdrop"
      aria-hidden="true"
    >
      {loadingPoster}
    </div>
  );
}

function CompositionLoadingStatus({ showMark = true, canEditWhileLoading, assetGeneration }: PreviewCompositionLoadingProps) {
  const { t } = useI18n();
  const labelId = useId();
  const pendingAsset = usePlayerStore((state) =>
    state.assetReadinessGeneration === assetGeneration?.current && !state.assetReadinessSkipped && state.assetReadinessPhase === "loading"
      ? state.assetReadinessPendingAsset?.trim()
      : undefined,
  );
  let hint: string;
  if (pendingAsset) {
    hint = canEditWhileLoading
      ? t("Downloading this file for playback. You can keep editing.")
      : t("Downloading this file for playback.");
  } else {
    hint = canEditWhileLoading
      ? t("You can keep editing while the preview loads.")
      : t("The preview will appear when it is ready.");
  }
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col items-center overflow-y-auto select-none [container-type:size] bg-[var(--motion-canvas)] text-[color:var(--motion-strong)]"
      data-hyperframes-ignore=""
      data-testid="composition-loading-overlay"
      role="status"
      aria-labelledby={labelId}
      aria-live="polite"
      aria-atomic="true"
      onDragStart={(event) => event.preventDefault()}
    >
      <div className={showMark ? "my-auto flex w-full min-w-0 max-w-sm flex-col items-center gap-2 p-2 text-center" : "sr-only"}>
        {showMark && <span className="motion-preview-loading-mark [@container(max-height:8rem)]:hidden!" aria-hidden="true" />}
        <div className="w-full shrink-0">
          <span id={labelId} className="block text-sm font-semibold">
            {pendingAsset ? t("Preparing preview assets") : t("Preparing the first preview frame")}
          </span>
          {pendingAsset && (
            <span dir="auto" title={pendingAsset} className="block truncate text-xs text-[color:var(--motion-text)]">
              {pendingAsset}
            </span>
          )}
          <span className="mt-1 block text-xs text-[color:var(--motion-muted)]">
            {hint}
          </span>
        </div>
      </div>
    </div>
  );
}
