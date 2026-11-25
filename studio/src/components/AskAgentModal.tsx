import { IconButton } from "open-design-ui/icon-button";
import { Button } from "open-design-ui/button";
import { useI18n } from "../i18n/I18n";
import { useState, useRef, type CSSProperties } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { getSuperAgentMotionEmbedConfig } from "../motion/superAgentMotionBridge";
import { type AgentModalAnchorPoint, clampNumber } from "../utils/studioHelpers";
import { useDialogBehavior } from "./ui/useDialogBehavior";

function getAgentModalPositionStyle(
  anchorPoint: AgentModalAnchorPoint | null,
): CSSProperties | undefined {
  if (!anchorPoint || typeof window === "undefined") return undefined;

  const modalWidth = 480;
  const estimatedModalHeight = 270;
  const margin = 16;
  const left = clampNumber(
    anchorPoint.x,
    margin + modalWidth / 2,
    window.innerWidth - margin - modalWidth / 2,
  );
  const top = clampNumber(
    anchorPoint.y + 12,
    margin,
    window.innerHeight - margin - estimatedModalHeight,
  );

  return { left, top, transform: "translateX(-50%)" };
}

export interface AskAgentModalProps {
  selectionLabel: string;
  contextPreview?: string;
  anchorPoint?: AgentModalAnchorPoint | null;
  onSubmit: (instruction: string, sendImmediately?: boolean) => void;
  onClose: () => void;
}

export function AskAgentModal({
  selectionLabel,
  contextPreview,
  anchorPoint = null,
  onSubmit,
  onClose,
}: AskAgentModalProps) {
  const { t } = useI18n();
  const embeddedInSuperAgent = Boolean(getSuperAgentMotionEmbedConfig());
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const modalPositionStyle = getAgentModalPositionStyle(anchorPoint);
  // A dirty draft vetoes Escape/backdrop closes — a stray click must not
  // discard typed instructions. The X button and Copy still close directly.
  const { requestClose } = useDialogBehavior({
    open: true,
    onClose,
    containerRef,
    canClose: () => !value.trim(),
  });

  useMountEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  });

  const handleSubmit = (sendImmediately = true) => {
    if (!embeddedInSuperAgent && !value.trim()) return;
    if (embeddedInSuperAgent && sendImmediately && !value.trim()) return;
    onSubmit(value.trim(), sendImmediately);
  };

  const dialogHeading = embeddedInSuperAgent ? t("Ask Super Agent") : t("Copy prompt to AI agent");

  return (
    <div
      className={
        anchorPoint
          ? "hf-backdrop-in fixed inset-0 z-100 bg-black/60"
          : "hf-backdrop-in fixed inset-0 z-100 flex items-center justify-center bg-black/60"
      }
      onClick={requestClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={dialogHeading}
        tabIndex={-1}
        className={`w-[480px] rounded-2xl border border-border bg-surface text-text-1 shadow-2xl outline-hidden ${
          anchorPoint ? "fixed" : ""
        }`}
        style={modalPositionStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
          <div>
            <h3 className="text-sm font-medium text-text-0">{dialogHeading}</h3>
            <p className="text-xs text-text-2 mt-0.5">
              {selectionLabel.length > 50 ? `${selectionLabel.slice(0, 49)}…` : selectionLabel}
            </p>
          </div>
          <IconButton variant="plain"
            className="p-1 rounded-md text-text-2 hover:text-text-0 hover:bg-hover active:scale-[0.98]"
            onClick={onClose}
            aria-label={t("Close")}
            icon={<svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>}
          />
        </div>
        <div className="px-5 py-4 space-y-3">
          <textarea
            ref={inputRef}
            className="w-full h-24 px-3 py-2 rounded-lg border border-border bg-bg-2 text-sm text-text-1 placeholder:text-text-3 resize-none focus:outline-hidden focus:border-accent"
            placeholder={embeddedInSuperAgent ? t("Describe what you want Super Agent to change…") : t("Describe what you want to change…")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(true);
              // Escape is handled at the document level by useDialogBehavior,
              // guarded against discarding a dirty draft.
            }}
          />
          {contextPreview && (
            <details className="group">
              <summary className="text-[11px] text-text-2 cursor-pointer select-none hover:text-text-1">
                {t("Context included in prompt")}</summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-bg-2 px-3 py-2 text-[11px] leading-relaxed text-text-2 whitespace-pre-wrap wrap-break-word border border-border/50">
                {contextPreview}
              </pre>
            </details>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border/60">
          <span className="text-[11px] text-text-3">
            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}{t(embeddedInSuperAgent ? "+Enter to send" : "+Enter to copy")}
          </span>
          {embeddedInSuperAgent ? (
            <div className="flex items-center gap-2">
              <Button
                variant="plain"
                className="px-3 py-1.5 rounded-lg border-0 bg-[color-mix(in_srgb,var(--motion-text)_9%,transparent)] hover:bg-[color-mix(in_srgb,var(--motion-text)_14%,transparent)] text-xs font-medium text-text-1"
                onClick={() => handleSubmit(false)}
              >
                {t("Attach to chat")}
              </Button>
              <Button
                variant="plain"
                className="px-4 py-1.5 rounded-lg border-0 bg-[var(--motion-action)] text-xs font-medium text-[var(--motion-on-action)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={!value.trim()}
                onClick={() => handleSubmit(true)}
              >
                {t("Send to Agent")}
              </Button>
            </div>
          ) : (
            <Button variant="plain"
              className="px-4 py-1.5 rounded-lg border-0 bg-[var(--motion-action)] text-xs font-medium text-[var(--motion-on-action)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!value.trim()}
              onClick={() => handleSubmit(true)}
            >
              {t("Copy prompt")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
