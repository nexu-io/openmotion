import type { CSSProperties } from "react";
import type { PreviewCompositionSize } from "../../utils/previewCompositionSize";
import { toDomPrecision } from "./previewZoom";

export const PREVIEW_STAGE_INSET_PX = 8;

// Stack the live slot above any loading shadow in the same absolute stage box so
// promoting a shadow never changes layout geometry (only GPU compositor properties).
export const LIVE_IFRAME_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 1,
};

// Avoid `visibility: hidden` and `clip-path: inset(100%)`: Chromium defers OOPIF
// and WebGL compositing for hidden/clipped frames, causing a blank flash when the
// old live slot unmounts at promotion. `zIndex: 0` + near-zero opacity keeps the
// shadow invisible (even through transparent compositions or a child's
// `visibility: visible` loading overlay) while letting the browser rasterize it.
export const SHADOW_IFRAME_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 0,
  opacity: 0.0001,
  pointerEvents: "none",
};

export function resolvePreviewStageSize(
  viewportWidth: number,
  viewportHeight: number,
  compositionSize: PreviewCompositionSize | null,
  portrait: boolean | undefined,
  gutterPx = 0,
  insetPx = PREVIEW_STAGE_INSET_PX,
): { width: number; height: number } {
  const availableWidth = Math.max(0, viewportWidth - 2 * (insetPx + gutterPx));
  const availableHeight = Math.max(0, viewportHeight - 2 * (insetPx + gutterPx));
  const aspectRatio =
    compositionSize && compositionSize.width > 0 && compositionSize.height > 0
      ? compositionSize.width / compositionSize.height
      : portrait
        ? 9 / 16
        : 16 / 9;

  if (availableWidth === 0 || availableHeight === 0) {
    return { width: 0, height: 0 };
  }

  let width = availableWidth;
  let height = width / aspectRatio;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * aspectRatio;
  }

  return {
    width: toDomPrecision(width),
    height: toDomPrecision(height),
  };
}
