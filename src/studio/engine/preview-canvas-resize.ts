/** Measure how the live layout maps CSS dimensions to the axis-aligned selection box. */
export const PREVIEW_CANVAS_RESIZE = `
  function resizeFrameBounds(element) {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { geometry: { x, y, width, height }, viewport: { width: innerWidth, height: innerHeight } };
  }

  // An ordinary 2D transform, including a tilted plane without perspective, is affine.
  // Only a projection whose depth varies across the element needs live corrections.
  function hasResizePerspective(element) {
    let tilted = false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (tilted && style.perspective && style.perspective !== 'none') return true;
      const rotate = style.rotate;
      if (rotate?.includes(' ') && !rotate.startsWith('z ')) tilted = true;
      if (!style.transform?.startsWith('matrix3d(')) continue;
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (matrix.m14 || matrix.m24 || (tilted && matrix.m34)) return true;
      tilted ||= !!(matrix.m13 || matrix.m23);
    }
    return false;
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
    const projection = hasResizePerspective(element) ? { before, anchorX, anchorY } : null;
    return { width: w, height: h, writeLeft: writeLeft || !!projection, writeTop: writeTop || !!projection, projection };
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

  // The initial size-to-screen mapping is only tangent to a perspective projection.
  // Refine against the real bounds, stopping as soon as it fits or improvement stalls.
  function projectedResize(step, dx, dy, first) {
    const { before, anchorX, anchorY } = step.resize.projection;
    const signX = step.corner.endsWith('w') ? -1 : 1;
    const signY = step.corner.startsWith('n') ? -1 : 1;
    const style = step.element.style;
    if (step.makeRelative) style.position = 'relative';
    let best = { width: step.width, height: step.height, x: 0, y: 0 };
    let bestError = Math.hypot(dx, dy);
    let inputX = dx, inputY = dy, biasX = 0, biasY = 0;
    for (let i = 0; i < 4; i++) {
      const candidate = i === 0 ? first : resizedBox(step, inputX, inputY);
      candidate.x += biasX;
      candidate.y += biasY;
      style.width = candidate.width + 'px';
      style.height = candidate.height + 'px';
      style.left = (step.left + candidate.x) + 'px';
      style.top = (step.top + candidate.y) + 'px';
      const rect = step.element.getBoundingClientRect();
      const widthError = dx - signX * (rect.width - before.width);
      const heightError = dy - signY * (rect.height - before.height);
      const anchorErrorX = before[anchorX] - rect[anchorX];
      const anchorErrorY = before[anchorY] - rect[anchorY];
      const error = Math.hypot(widthError, heightError, anchorErrorX, anchorErrorY);
      if (!(error < bestError)) break;
      best = candidate;
      bestError = error;
      if (error < 0.1) break;
      inputX += widthError;
      inputY += heightError;
      const shift = localOffset(step.axes, anchorErrorX, anchorErrorY);
      biasX += shift.x;
      biasY += shift.y;
    }
    return best;
  }
`;
