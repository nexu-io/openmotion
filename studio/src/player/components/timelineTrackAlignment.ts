import { createTimelineRowGeometry, type TimelineRowGeometry } from "./timelineLayout";

/** Center spare vertical space in the same geometry used by drawing and hit tests. */
export function centerTimelineTracks(geometry: TimelineRowGeometry, viewportHeight: number): TimelineRowGeometry {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= geometry.canvasHeight || !geometry.rowKeys.length) return geometry;
  const extra = (viewportHeight - geometry.canvasHeight) / 2;
  return createTimelineRowGeometry(geometry.rowKeys, geometry.rowHeights, {
    top: geometry.padding.top + extra,
    bottom: geometry.padding.bottom + extra,
  });
}
