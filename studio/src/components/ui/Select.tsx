import { Check, RemixIcon } from "../../icons/RemixIcons";
/**
 * Select: Base UI select in Input's box. The trigger keeps `role="combobox"`, which both hotkey selector
 * lists match. Options are data, not children, so typeahead and the value display can read labels.
 */

import { Select as BaseSelect } from "@base-ui/react/select";
import { cn } from "./cn";
import { fieldBase } from "./Input";
import { floatingMotion, POPUP_LAYER } from "./Menu";
import type { PreviewState } from "./Button";
import type { ReactNode } from "react";

export interface SelectOption {
  label: string;
  value: string;
  /** Offered but not choosable; the label stays visible so the reason stays visible too. */
  disabled?: boolean;
  /** Decorative identity shown in the trigger and list, without changing typeahead. */
  icon?: ReactNode;
  /** Secondary context is shown only in the expanded list. */
  description?: string;
}

export interface SelectProps {
  /** Accessible name for the trigger. */
  label: string;
  value: string;
  options: SelectOption[];
  /** Called when a different option is chosen. */
  onCommit: (next: string) => void;
  /** Called once per committed change, for design-input telemetry. */
  onTrack?: () => void;
  disabled?: boolean;
  className?: string;
  "data-preview-state"?: PreviewState;
}

export function Select({
  label,
  value,
  options,
  onCommit,
  onTrack,
  disabled,
  className,
  "data-preview-state": previewState,
}: SelectProps) {
  const rich = options.some(option => option.icon || option.description);
  const selected = options.find(option => option.value === value);
  return (
    <BaseSelect.Root
      value={value}
      disabled={disabled}
      items={options}
      onValueChange={(next) => {
        const chosen = String(next);
        if (chosen === value) return;
        onCommit(chosen);
        onTrack?.();
      }}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(
          fieldBase,
          "w-full cursor-pointer justify-between text-left",
          "data-[popup-open]:border-border-strong",
          rich && "om-select-trigger",
          className,
        )}
        data-preview-state={previewState}
      >
        {selected?.icon && <span className="om-select-icon" aria-hidden="true">{selected.icon}</span>}
        <BaseSelect.Value className="min-w-0 flex-1 truncate" />
        <BaseSelect.Icon className="shrink-0 text-text-4" aria-hidden="true">
          <RemixIcon name="arrow-down-s-line" size={14} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>

      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className={POPUP_LAYER}>
          <BaseSelect.Popup
            className={cn(
              "om-select-popup min-w-[var(--anchor-width)] rounded-md border border-border bg-surface py-1 shadow-menu",
              floatingMotion("duration-open"),
            )}
          >
            <BaseSelect.List className="om-select-list" data-rich={rich || undefined}>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={cn(
                    "om-select-option flex h-ctl-sm cursor-pointer select-none items-center gap-2 px-2.5",
                    "text-step-11 text-text-2 outline-hidden",
                    "data-[highlighted]:bg-hover data-[highlighted]:text-text-0",
                    "data-[selected]:text-text-0",
                    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
                  )}
                >
                  {option.icon && <span className="om-select-icon" aria-hidden="true">{option.icon}</span>}
                  <span className="om-select-option-copy"><BaseSelect.ItemText className="block truncate">{option.label}</BaseSelect.ItemText>{option.description && <span className="om-select-description">{option.description}</span>}</span>
                  <span className="flex size-3 shrink-0 items-center justify-center text-accent-ink">
                    <BaseSelect.ItemIndicator className="flex"><Check size={12} /></BaseSelect.ItemIndicator>
                  </span>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
