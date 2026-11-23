import { useI18n } from "../../i18n/I18n";
import { HyperframesLoader } from "../../components/ui";

export function PreviewCompositionLoading() {
  const { t } = useI18n();
  return (
    <div
      className="motion-preview-loading"
      data-hyperframes-ignore=""
      data-testid="composition-loading-overlay"
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
    >
      <div className="motion-preview-loading-card">
        <HyperframesLoader title={t("Loading composition")} size={56} />
      </div>
    </div>
  );
}
