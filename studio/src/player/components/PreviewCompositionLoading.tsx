import { useId } from "react";
import { useI18n } from "../../i18n/I18n";
import { usePlayerStore } from "../store/playerStore";

interface PreviewCompositionLoadingProps {
  showMark?: boolean;
  assetGeneration?: { readonly current: number };
}

/** Keep the stage opaque from mount until the player releases its first-frame cover. */
export function PreviewCompositionLoading({ showMark = true, assetGeneration }: PreviewCompositionLoadingProps) {
  const { t } = useI18n();
  const labelId = useId();
  const pendingAsset = usePlayerStore((state) =>
    state.assetReadinessGeneration === assetGeneration?.current && !state.assetReadinessSkipped && state.assetReadinessPhase === "loading"
      ? state.assetReadinessPendingAsset?.trim()
      : undefined,
  );
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center overflow-hidden select-none bg-[var(--motion-video-ink)] text-[var(--motion-overlay-ink)]"
      data-hyperframes-ignore=""
      data-testid="composition-loading-overlay"
      role="status"
      aria-labelledby={labelId}
      aria-live="polite"
      aria-atomic="true"
      onDragStart={(event) => event.preventDefault()}
    >
      <div className={showMark ? "flex max-h-full w-full min-w-0 max-w-sm flex-col items-center gap-2 px-2 text-center" : "sr-only"}>
        {showMark && <span className="motion-preview-loading-mark" aria-hidden="true" />}
        <div className="w-full shrink-0">
          <span id={labelId} className="block text-sm font-semibold">
            {pendingAsset ? t("Preparing preview assets") : t("Loading preview…")}
          </span>
          <span dir="auto" title={pendingAsset} className="block min-h-lh truncate text-xs opacity-75">
            {pendingAsset}
          </span>
        </div>
      </div>
    </div>
  );
}
