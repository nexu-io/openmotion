import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { Button } from "open-design-ui/button";
import { RemixIcon } from "../../icons/RemixIcons";
import { useI18n } from "../../i18n/I18n";
import { Tooltip } from "./Tooltip";

export interface ItemLoadErrorBadgeProps {
  /** Custom accessible label / tooltip describing the load failure. */
  label?: string;
  /** Compact icon-only pill for small thumbnails (e.g. 80×45 composition cards or narrow clips). */
  compact?: boolean;
  /** True while a manual reload request is currently in flight. */
  reloading?: boolean;
  /** Use `<span role="button">` when mounted inside a native `<button>` (e.g. TimelineClip). */
  nestedInButton?: boolean;
  /** Inline layout instead of absolute bottom-right positioning (e.g. AudioRow footer). */
  inline?: boolean;
  className?: string;
  onReload: () => void;
}

function stopBubble(event: MouseEvent | PointerEvent | KeyboardEvent) {
  event.stopPropagation();
}

/**
 * Compact bottom-right error indicator with one-click reload for dispersed-loading
 * media tiles, composition cards, and timeline clips.
 */
export function ItemLoadErrorBadge({
  label,
  compact = false,
  reloading = false,
  nestedInButton = false,
  inline = false,
  className,
  onReload,
}: ItemLoadErrorBadgeProps) {
  const { t } = useI18n();
  const tooltipLabel = label ?? t(reloading ? "Reloading…" : "Failed to load · Click to reload");

  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!reloading) onReload();
  };

  const handleDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    if (!reloading) onReload();
  };

  const classes = [
    "motion-item-error-badge",
    compact ? "is-compact" : "",
    inline ? "is-inline" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const content = reloading ? (
    <RemixIcon
      name="loader-4-line"
      size={12}
      className="shrink-0 animate-spin motion-reduce:animate-none"
    />
  ) : (
    <>
      <RemixIcon name="error-warning-fill" size={12} className="motion-item-error-badge__alert" />
      <RemixIcon name="refresh-line" size={11} className="motion-item-error-badge__reload" />
    </>
  );

  const trigger = nestedInButton ? (
    <span
      role="button"
      tabIndex={reloading ? -1 : 0}
      aria-label={tooltipLabel}
      aria-busy={reloading || undefined}
      aria-disabled={reloading || undefined}
      data-testid="item-load-error"
      data-item-error-reload="true"
      data-reloading={reloading ? "true" : undefined}
      className={classes}
      onPointerDown={stopBubble}
      onPointerUp={stopBubble}
      onContextMenu={stopBubble}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      {content}
    </span>
  ) : (
    <Button
      variant="plain"
      type="button"
      disabled={reloading}
      draggable={false}
      aria-label={tooltipLabel}
      aria-busy={reloading || undefined}
      data-testid="item-load-error"
      data-item-error-reload="true"
      data-reloading={reloading ? "true" : undefined}
      className={classes}
      onPointerDown={stopBubble}
      onPointerUp={stopBubble}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {content}
    </Button>
  );

  return (
    <Tooltip label={tooltipLabel} wrap>
      {trigger}
    </Tooltip>
  );
}
