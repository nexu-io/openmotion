import type { PointerEventHandler } from "react";
import { IconButton } from "open-design-ui/icon-button";
import { Tooltip } from "../ui/Tooltip";
import { RemixIcon } from "../../icons/RemixIcons";
import { Film, Folder, ImageIcon, Music, Square, Type, Vector } from "../../icons/SystemIcons";
import { useI18n } from "../../i18n/I18n";
import { useMvpEditor } from "../../motion/StudioHost";
import type { LayerKind } from "./layerKind";

const [CARET, ICON, GAP] = [16, 20, 6];
const CHILD_INDENT = CARET + GAP + ICON + GAP;

const KIND_ICON = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  vector: Vector,
  group: Folder,
  text: Type,
  shape: Square,
} as const;

interface Props {
  index: number;
  label: string;
  depth: number;
  childCount: number;
  kind: LayerKind;
  isCompHost?: boolean;
  isCollapsed: boolean;
  selected: boolean;
  isDragged?: boolean;
  dragging?: boolean;
  hint?: string;
  onSelect: (additive?: boolean) => void;
  onToggle: () => void;
  onDoubleClick?: () => void;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerEnter?: () => void;
}

export function LayerRow({ index, label, depth, childCount, kind, isCompHost, isCollapsed, selected,
  isDragged, dragging, hint, onSelect, onToggle, onDoubleClick, onPointerDown, onPointerEnter }: Props) {
  const { t } = useI18n();
  const mvp = useMvpEditor();
  const KindIcon = KIND_ICON[kind];
  const kindName = kind[0].toUpperCase() + kind.slice(1);
  const hasChildren = childCount > 0;
  return (
    <Tooltip label={hint ? t(hint) : undefined} wrap><div
      data-layer-index={index}
      role="button"
      aria-pressed={selected}
      tabIndex={0}
      onClick={e => onSelect(e.shiftKey)}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(e.shiftKey);
        }
      }}
      className={`group mx-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors ${
        isDragged
          ? "opacity-40"
          : selected
            ? mvp ? "bg-panel-hover text-panel-text-1" : "bg-panel-accent/14 text-accent-ink"
            : "text-panel-text-2 hover:bg-panel-hover/40 hover:text-panel-text-1"
      } ${dragging ? "cursor-grabbing" : "cursor-pointer"}`}
      style={{ paddingLeft: 8 + depth * CHILD_INDENT }}
    >
      {hasChildren ? (
        <IconButton variant="plain"
          type="button"
          onClick={e => { e.stopPropagation(); onToggle(); }}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? t("Expand children") : t("Collapse children")}
          className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-neutral-500 hover:text-neutral-300 before:absolute before:-inset-1.5 before:content-['']"
          icon={<RemixIcon name="arrow-right-s-line" size={12} className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`} />}
        />
      ) : null}
      <Tooltip label={hint ? `${t(kindName)} · ${t(hint)}` : t(kindName)} wrap><span
        data-layer-kind={kind}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
          mvp
            ? selected ? "bg-panel-hover text-panel-text-1" : "bg-panel-hover text-panel-text-4"
            : selected
            ? "bg-panel-accent/18 text-accent-ink"
            : isCompHost
              ? "bg-on text-accent-ink"
              : "bg-panel-hover text-panel-text-4"
        }`}
      >
        <KindIcon size={12} />
      </span></Tooltip>
      <span className="min-w-0 flex-1 truncate text-[11px]">{label}</span>
      {hasChildren && (
        <span className="text-[9px] tabular-nums text-panel-text-5">
          {childCount}
        </span>
      )}
    </div></Tooltip>
  );
}
