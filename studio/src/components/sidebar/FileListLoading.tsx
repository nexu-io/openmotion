import { useState } from "react";
import { Button } from "open-design-ui/button";
import { RemixIcon } from "../../icons/RemixIcons";
import { useI18n } from "../../i18n/I18n";
import { Skeleton } from "../ui/Skeleton";

export function FileListLoading() {
  const { t } = useI18n();
  return <div role="status" aria-label={t("Loading…")} className="space-y-2 p-2">
    {[0, 1, 2].map(row => <div key={row} className="flex items-center gap-2">
      <Skeleton className="h-10 w-16 shrink-0" />
      <Skeleton className="h-3 w-1/3" />
    </div>)}
  </div>;
}

export function FileListError({ onRetry }: { onRetry?: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  return (
    <div
      role="alert"
      data-testid="file-list-error"
      className="flex h-full flex-1 items-center justify-center px-4 text-center"
    >
      <div className="motion-panel-empty-content">
        <RemixIcon name="error-warning-line" size={18} />
        <p>{t("Could not load project files")}</p>
        {onRetry && (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={retrying}
            data-testid="file-list-retry"
            onClick={() => {
              setRetrying(true);
              void Promise.resolve(onRetry()).finally(() => setRetrying(false));
            }}
          >
            {retrying ? t("Retrying…") : t("Retry")}
          </Button>
        )}
      </div>
    </div>
  );
}
