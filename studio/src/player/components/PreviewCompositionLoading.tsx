import { useI18n } from "../../i18n/I18n";

/** Keep the stage opaque from mount until the player releases its first-frame cover. */
export function PreviewCompositionLoading({ showMark = true }: { showMark?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center select-none bg-[var(--motion-video-ink)]"
      data-hyperframes-ignore=""
      data-testid="composition-loading-overlay"
      role="status"
      aria-live="polite"
      onDragStart={(event) => event.preventDefault()}
    >
      {showMark && <span className="motion-preview-loading-mark" aria-hidden="true" />}
      <span className="sr-only">{t("Loading composition")}</span>
    </div>
  );
}
