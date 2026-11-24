import { IconButton } from "open-design-ui/icon-button";
import type { ManualImportBatch } from "../../hooks/manualImportResults";
import type { PendingExternalImport } from "../../hooks/useFileTree";
import { useI18n } from "../../i18n/I18n";
import { RemixIcon } from "../../icons/RemixIcons";

const STALE_PROCESSING_DISMISS_MS = 5 * 60_000;

/**
 * Deduplicate server-tracked pending imports against the active manual upload
 * batch card (`ManualImportResults`) so a timed-out or settled web upload never
 * renders duplicate `Processing…` + `Result unknown` cards for the same file.
 */
export function filterPendingExternalImports(
  pendingImports: readonly PendingExternalImport[],
  importBatch: ManualImportBatch | null,
): PendingExternalImport[] {
  if (!importBatch || pendingImports.length === 0) return [...pendingImports];
  const batchTargetPaths = new Set(
    importBatch.items.flatMap((item) =>
      [item.targetPath, item.path].filter((value): value is string => Boolean(value)),
    ),
  );
  const batchNames = new Set(importBatch.items.map((item) => item.name));
  return pendingImports.filter((item) => {
    if (importBatch.busy && item.source === "web_upload") return false;
    if (item.targetPath && batchTargetPaths.has(item.targetPath)) return false;
    if (item.source === "web_upload" && batchNames.has(item.filename)) return false;
    return true;
  });
}

function formatCompactBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function PendingExternalImports({
  items,
  onDismiss,
}: {
  items: readonly PendingExternalImport[];
  onDismiss?: (id: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;

  return (
    <div className="mb-2 space-y-1.5" data-pending-external-imports role="status" aria-live="polite">
      {items.map((item) => {
        const isFailed = item.state === "failed";
        const isWaiting = item.state === "waiting_upload";
        const isStaleProcessing =
          item.state === "processing" &&
          Number.isFinite(item.updatedAt) &&
          Date.now() - item.updatedAt >= STALE_PROCESSING_DISMISS_MS;
        const canDismiss = Boolean(onDismiss) && (isFailed || isStaleProcessing);
        const hasDeterminateProgress =
          !isWaiting && !isFailed && typeof item.progress === "number" && item.progress > 0;
        const clampedPct = hasDeterminateProgress
          ? Math.max(5, Math.min(100, Math.round(item.progress!)))
          : 0;
        const statusLabel = isFailed
          ? item.error || t("Import failed")
          : isWaiting
            ? t("Waiting for upload…")
            : item.stage === "downloading"
              ? hasDeterminateProgress
                ? `${t("Downloading…")} ${clampedPct}%`
                : t("Downloading…")
              : hasDeterminateProgress
                ? `${t("Processing…")} ${clampedPct}%`
                : t("Processing…");
        const sizeLabel = formatCompactBytes(item.bytes);

        return (
          <div
            key={item.id}
            data-pending-import-state={item.state}
            data-pending-import-source={item.source}
            className="rounded-md border border-border bg-surface p-2 text-step-11 text-text-1"
          >
            <div className="flex items-center gap-2 min-w-0">
              {isFailed ? (
                <RemixIcon name="error-warning-line" size={14} className="shrink-0 text-text-2" />
              ) : (
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-border border-t-text-2"
                />
              )}
              <span className="min-w-0 flex-1 truncate font-medium text-text-1">
                {item.filename}
              </span>
              {sizeLabel && (
                <span className="shrink-0 text-step-10 text-text-2 tabular-nums">
                  {sizeLabel}
                </span>
              )}
              {canDismiss && onDismiss && (
                <IconButton
                  variant="plain"
                  size="sm"
                  aria-label={t("Dismiss")}
                  onClick={() => onDismiss(item.id)}
                  icon={<RemixIcon name="close-line" size={14} />}
                />
              )}
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-step-10 text-text-2">
              <span className="truncate">{statusLabel}</span>
            </div>
            {!isFailed && (
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
                {hasDeterminateProgress ? (
                  <div
                    className="h-full rounded-full bg-studio-accent transition-[width] duration-200"
                    style={{ width: `${clampedPct}%` }}
                  />
                ) : (
                  <div className="h-full w-1/2 animate-pulse rounded-full bg-studio-accent/70" />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
