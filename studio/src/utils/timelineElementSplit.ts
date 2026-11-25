import { SPLIT_BOUNDARY_EPSILON_S } from "@hyperframes/core/composition-contract";
import type { TimelineElement } from "../player/store/playerStore";

export { buildPatchTarget, readFileContent } from "../hooks/timelineEditingHelpers";
export { SPLIT_BOUNDARY_EPSILON_S };

/**
 * True when splitTime leaves at least SPLIT_BOUNDARY_EPSILON_S on both sides
 * of the cut. Inclusive at the epsilon offsets: the timeline canvas clamps
 * edge clicks to exactly start/end ± epsilon, so the clamped value must pass.
 */
export function isSplitTimeWithinBounds(
  splitTime: number,
  clipStart: number,
  clipDuration: number,
): boolean {
  return (
    splitTime >= clipStart + SPLIT_BOUNDARY_EPSILON_S &&
    splitTime <= clipStart + clipDuration - SPLIT_BOUNDARY_EPSILON_S
  );
}

export const CANVAS_SPLIT_UNSUPPORTED_MESSAGE =
  "Canvas layers cannot be split directly. Split the parent composition instead.";

/**
 * Procedural `<canvas>` layers are typically bound by ID or direct DOM reference
 * to custom scripts; cloning a second `<canvas id="...-split">` leaves the right
 * half blank/black in both preview and thumbnails. Split the parent composition instead.
 */
export function isUnsplittableCanvasElement(
  el: Pick<TimelineElement, "tag" | "compositionSrc">,
): boolean {
  return el.tag.toLowerCase() === "canvas" && !el.compositionSrc;
}

export function canSplitElement(el: TimelineElement): boolean {
  if (isUnsplittableCanvasElement(el)) return false;
  const hasStableIdentity = Boolean(el.hfId || el.domId || el.selector);
  const hasValidRate =
    el.playbackRate == null || (Number.isFinite(el.playbackRate) && el.playbackRate > 0);
  return (
    !el.timelineLocked &&
    hasStableIdentity &&
    hasValidRate &&
    !!el.duration &&
    Number.isFinite(el.duration)
  );
}

/**
 * True when `el` can be split AND `splitTime` lies within its boundary epsilon.
 * Shared by the single-clip and split-all razor paths so both honor the same
 * minimum-distance rule (split-all previously used raw `>`/`<`, letting cuts
 * land inside the epsilon margin and produce a degenerate slice).
 */
export function canSplitElementAt(el: TimelineElement, splitTime: number): boolean {
  return canSplitElement(el) && isSplitTimeWithinBounds(splitTime, el.start, el.duration);
}

/** Elements that the split-all razor action can cut at `splitTime`. */
export function selectSplittableElements(
  elements: TimelineElement[],
  splitTime: number,
): TimelineElement[] {
  return elements.filter((el) => canSplitElementAt(el, splitTime));
}

/** A nonempty selection limits the cut, even if its IDs are stale or ineligible. */
export function selectPlayheadSplitElements(
  state: {
    elements: TimelineElement[];
    selectedElementId: string | null;
    selectedElementIds: ReadonlySet<string>;
  },
  splitTime: number,
): TimelineElement[] {
  const ids = new Set(state.selectedElementIds);
  if (state.selectedElementId) ids.add(state.selectedElementId);
  const candidates = ids.size > 0
    ? state.elements.filter((element) => ids.has(element.key ?? element.id))
    : state.elements;
  return selectSplittableElements(candidates, splitTime);
}
