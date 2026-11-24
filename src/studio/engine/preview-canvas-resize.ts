/** Measure how the live layout maps CSS dimensions to the axis-aligned selection box. */
export const PREVIEW_CANVAS_RESIZE = `
  function measureResize(element, width, height, corner, original, axes) {
    const before = element.getBoundingClientRect();
    const anchorX = corner.endsWith('w') ? 'right' : 'left';
    const anchorY = corner.startsWith('n') ? 'bottom' : 'top';
    const probe = property => {
      const value = property === 'width' ? width : height;
      element.style[property] = (value + 32) + 'px';
      const rect = element.getBoundingClientRect();
      restoreStyles(element, { [property]: original[property] });
      return {
        w: (rect.width - before.width) / 32, h: (rect.height - before.height) / 32,
        x: (rect[anchorX] - before[anchorX]) / 32, y: (rect[anchorY] - before[anchorY]) / 32,
      };
    };
    const w = probe('width'), h = probe('height');
    const shiftW = localOffset(axes, w.x, w.y), shiftH = localOffset(axes, h.x, h.y);
    const writeLeft = corner.endsWith('w') || Math.abs(shiftW.x) + Math.abs(shiftH.x) > 0.0001;
    const writeTop = corner.startsWith('n') || Math.abs(shiftW.y) + Math.abs(shiftH.y) > 0.0001;
    return { width: w, height: h, writeLeft, writeTop };
  }

  function resizedBox(step, dx, dy) {
    const w = step.resize.width, h = step.resize.height;
    const dw = step.corner.endsWith('w') ? -dx : dx;
    const dh = step.corner.startsWith('n') ? -dy : dy;
    const det = w.w * h.h - w.h * h.w;
    let widthDelta, heightDelta;
    if (Math.abs(det) > 0.0001) {
      widthDelta = (h.h * dw - h.w * dh) / det;
      heightDelta = (w.w * dh - w.h * dw) / det;
    } else {
      // At a 45-degree rotation the two screen dimensions cannot be controlled
      // independently. Follow the pointer along the diagonal at the original aspect ratio.
      const sx = w.w * step.width + h.w * step.height;
      const sy = w.h * step.width + h.h * step.height;
      const scale = (sx * dw + sy * dh) / (sx * sx + sy * sy || 1);
      widthDelta = step.width * scale;
      heightDelta = step.height * scale;
    }
    widthDelta = Math.max(1 - step.width, widthDelta);
    heightDelta = Math.max(1 - step.height, heightDelta);
    // Size changes can move the opposite corner when transforms rotate about their origin.
    const correction = localOffset(step.axes, -w.x * widthDelta - h.x * heightDelta, -w.y * widthDelta - h.y * heightDelta);
    return { width: step.width + widthDelta, height: step.height + heightDelta, ...correction };
  }
`;
