import * as css from 'css-tree';
import { parseHTML } from 'linkedom';
import { canvasStyleRewriter, compositionCanvasSource } from './composition-canvas.ts';

const rewriteStyles = canvasStyleRewriter(css);

/**
 * @param {string} html
 * @param {{ ratio: import('./composition-canvas.ts').CanvasRatio, fit: import('./composition-canvas.ts').CanvasFit }} change
 */
export function reframeCanvas(html, change) {
  return compositionCanvasSource(html, { parseHTML, rewriteStyles }, change);
}
