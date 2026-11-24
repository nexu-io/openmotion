/** Measure how the live layout maps CSS dimensions to the axis-aligned selection box. */
export const PREVIEW_CANVAS_RESIZE = `
  function resizeFrameBounds(element) {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { geometry: { x, y, width, height }, viewport: { width: innerWidth, height: innerHeight } };
  }

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
    const minW = 1 - step.width, minH = 1 - step.height;
    const normW = w.w * w.w + w.h * w.h, normH = h.w * h.w + h.h * h.h;
    let widthDelta, heightDelta;
    // The normalized determinant is the sine between the two size directions.
    // Nearly parallel directions amplify a small cursor movement into huge CSS sizes.
    if (Math.abs(det) > Math.sqrt(normW * normH) / 16) {
      widthDelta = (h.h * dw - h.w * dh) / det;
      heightDelta = (w.w * dh - w.h * dw) / det;
      if (widthDelta < minW || heightDelta < minH) {
        // Find the closest reachable corner on either minimum-size boundary.
        const hAtMinW = Math.max(minH, (h.w * (dw - w.w * minW) + h.h * (dh - w.h * minW)) / normH);
        const wAtMinH = Math.max(minW, (w.w * (dw - h.w * minH) + w.h * (dh - h.h * minH)) / normW);
        const error = (x, y) => Math.hypot(w.w * x + h.w * y - dw, w.h * x + h.h * y - dh);
        [widthDelta, heightDelta] = error(minW, hAtMinW) < error(wAtMinH, minH) ? [minW, hAtMinW] : [wAtMinH, minH];
      }
    } else {
      // At a 45-degree rotation the two screen dimensions cannot be controlled
      // independently. Follow the pointer along the diagonal at the original aspect ratio.
      const sx = w.w * step.width + h.w * step.height;
      const sy = w.h * step.width + h.h * step.height;
      const scale = Math.max(minW / step.width, minH / step.height, (sx * dw + sy * dh) / (sx * sx + sy * sy || 1));
      widthDelta = step.width * scale;
      heightDelta = step.height * scale;
    }
    // Size changes can move the opposite corner when transforms rotate about their origin.
    const correction = localOffset(step.axes, -w.x * widthDelta - h.x * heightDelta, -w.y * widthDelta - h.y * heightDelta);
    return { width: step.width + widthDelta, height: step.height + heightDelta, ...correction };
  }
`;
