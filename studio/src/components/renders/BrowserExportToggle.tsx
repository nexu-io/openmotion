import { useI18n } from "../../i18n/I18n";
import { Toggle } from "../ui/Toggle";

export function BrowserExportToggle({
  format,
  checked,
  disabled,
  supported,
  unsupportedReason = "WebCodecs VideoEncoder is unavailable in this browser.",
  onToggle,
}: {
  format: "mp4" | "webm" | "mov" | "gif";
  checked: boolean;
  disabled: boolean;
  supported: boolean;
  unsupportedReason?: string;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useI18n();
  if (format !== "mp4" && format !== "webm") return null;

  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <div className="min-w-0">
        <span className="text-step-10 text-text-3 block">{t("Browser export (Beta)")}</span>
        {!supported && (
          <span className="text-step-10 text-text-5 block">
            {t(unsupportedReason)}
          </span>
        )}
      </div>
      <Toggle
        label={t("Browser export (Beta)")}
        checked={checked && supported}
        disabled={disabled || !supported}
        onCommit={onToggle}
      />
    </div>
  );
}
