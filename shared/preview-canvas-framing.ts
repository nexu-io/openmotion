import type { CanvasFit, canvasFrameTransform } from '../packages/edit-core/composition-canvas.ts';

export type CanvasFramingDraft = { id: string; width: number; height: number; fit: CanvasFit } | { id: string; clear: true };

/** Temporary visual projection. Leave the mounted scene, authored styles and running animations in place. */
export function paintCanvasFraming(doc: Document, draft: CanvasFramingDraft, transform: typeof canvasFrameTransform) {
  const root = doc.querySelector<HTMLElement>('[data-composition-id]');
  if (!root || !draft || typeof draft.id !== 'string' || draft.id.length > 100) return;
  const width = Number(root.getAttribute('data-width')), height = Number(root.getAttribute('data-height'));
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) return;
  let style = doc.querySelector<HTMLStyleElement>('style[data-openmotion-framing-preview]');
  if ('clear' in draft) {
    if (!style || style.getAttribute('data-openmotion-framing-preview') !== draft.id) return;
    style.remove();
    root.removeAttribute('data-openmotion-framing-root');
    return { width, height };
  }
  if (![draft.width, draft.height].every(n => Number.isFinite(n) && n > 0 && n <= 16384) || !['contain', 'cover'].includes(draft.fit)) return;
  const sourceWidth = Number(root.getAttribute('data-canvas-source-width') ?? width);
  const sourceHeight = Number(root.getAttribute('data-canvas-source-height') ?? height);
  if (![sourceWidth, sourceHeight].every(n => Number.isFinite(n) && n > 0)) return;
  const frameStyle = `transform-origin:0 0!important;transform:${transform(sourceWidth, sourceHeight, draft.width, draft.height, draft.fit)}!important`;
  const box = '[data-openmotion-framing-root]';
  // For an unframed project the body stands in for the source wrapper until its saved
  // version mounts. Moving a live iframe or canvas into a new wrapper could restart it.
  const framed = [...root.children].some(node => node.hasAttribute('data-canvas-frame'));
  const css = framed
    ? `${box}{width:${draft.width}px!important;height:${draft.height}px!important}${box}>[data-canvas-frame]{${frameStyle}}`
    : `html{background:#000!important}body{width:${sourceWidth}px!important;height:${sourceHeight}px!important;${frameStyle}}${box}{width:${sourceWidth}px!important;height:${sourceHeight}px!important}`;
  if (!style) {
    style = doc.createElement('style');
    (doc.head ?? doc.documentElement).append(style);
  }
  root.setAttribute('data-openmotion-framing-root', '');
  style.setAttribute('data-openmotion-framing-preview', draft.id);
  style.textContent = css;
  return { width: draft.width, height: draft.height };
}
