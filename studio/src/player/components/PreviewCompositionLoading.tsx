import { useI18n } from "../../i18n/I18n";

/** Frameless preview-stage first-frame indicator: a gentle breathing brand mark with no modal box or text. */
export function PreviewCompositionLoading() {
  const { t } = useI18n();
  return (
    <div
      className="motion-preview-loading"
      data-hyperframes-ignore=""
      data-testid="composition-loading-overlay"
      role="status"
      aria-live="polite"
      onDragStart={(event) => event.preventDefault()}
    >
      <span className="motion-preview-loading-mark" aria-hidden="true" />
      <span className="sr-only">{t("Loading composition")}</span>
    </div>
  );
}
