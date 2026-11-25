export interface LayerBounds { x: number; y: number; width: number; height: number }

/** Bounds in fractions of the preview document. Studio's layout may change after a pick. */
export function relativeLayerBounds(selection?: { geometry?: LayerBounds; viewport?: { width: number; height: number } }) {
  const { geometry, viewport } = selection ?? {};
  if (!geometry || !viewport || ![geometry.x, geometry.y, geometry.width, geometry.height, viewport.width,
    viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return null;
  return { x: geometry.x / viewport.width, y: geometry.y / viewport.height,
    width: geometry.width / viewport.width, height: geometry.height / viewport.height };
}
