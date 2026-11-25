import { PREVIEW_CANVAS_RESIZE } from './preview-canvas-resize.ts';

/** Runs inside the scoped project frame alongside describe() and sourceVersions.
 * Studio owns pointer capture and authorizes the final source write. */
export const PREVIEW_CANVAS_DRAG = `
  let drag = null;
  const pendingDrags = new Map();
  ${PREVIEW_CANVAS_RESIZE}

  function localOffset({ a, b, c, d, determinant }, dx, dy) {
    return { x: (d * dx - c * dy) / determinant, y: (a * dy - b * dx) / determinant };
  }

  function pendingForSource(path) {
    return Array.from(pendingDrags.values()).filter(step => step.selection.sourceFile === path);
  }

  function canvasBase(path, gesture) {
    if (sourceVersions[path]) return sourceVersions[path];
    const steps = pendingForSource(path);
    const plainMove = step => !step.corner && (!step.makeRelative || step.element.childElementCount === 0);
    const canChain = (timingDocumentId && path === compositionPath) ||
      (settings.liveEdits?.position === true && plainMove(gesture) && steps.every(plainMove));
    const latest = canChain && steps.at(-1);
    return latest && (latest.confirmedVersion || latest.sha256);
  }

  function confirmCanvasVersion(path, version) {
    const steps = pendingForSource(path);
    if (steps.length) steps.forEach(step => { step.confirmedVersion = version; });
    if (steps.every(step => step.ordered)) {
      sourceVersions[path] = version;
      notifyInspectorSourceReady(path);
    }
  }

  function newerDragStyle(step, node, name) {
    if (step?.element !== node || step.applied?.[name] === undefined) return undefined;
    const steps = pendingForSource(step.selection.sourceFile);
    const newer = [...steps.slice(steps.indexOf(step) + 1), drag];
    return newer.findLast(item => item?.element === node && item.applied?.[name] !== undefined)?.applied[name];
  }

  function restoreStyles(element, original, applied) {
    for (const [property, { value, priority }] of Object.entries(original)) {
      // A runtime animation or another edit may have since taken over this property.
      if (applied && (element.style[property] !== applied[property] || element.style.getPropertyPriority(property))) continue;
      element.style.setProperty(property, value, priority);
    }
  }

  function animatedLayoutOffset(element, style) {
    // GSAP may absorb a CSS translate into its own transform on the next load.
    // Use this coordinate system only when compilation proved the scene has no authored script.
    if (!(settings.canRebindTiming || settings.liveEdits?.cssLayoutOffset)) return null;
    if (!style.animationName || style.animationName === 'none') return null;
    const frames = element.getAnimations().flatMap(({effect}) =>
      effect?.target === element && !effect.pseudoElement ? effect.getKeyframes() : []);
    if (!frames.some(frame => 'left' in frame || 'top' in frame) || frames.some(frame => 'translate' in frame)) return null;
    if (style.translate === 'none') return [0, 0];
    const parts = style.translate?.split(' ');
    if (!parts?.length || parts.length > 2 || !parts.every(value => /^-?(?:\\d+\\.?\\d*|\\.\\d+)px$/.test(value))) return null;
    return [parseFloat(parts[0]), parseFloat(parts[1] || '0')];
  }

  function writeMove(element, x, y, makeRelative, translate) {
    if (translate) element.style.translate = x + 'px ' + y + 'px';
    else {
      if (makeRelative) element.style.position = 'relative';
      element.style.left = x + 'px';
      element.style.top = y + 'px';
    }
  }

  function measureDragAxes(element, x, y, makeRelative, original, translate, message, corner) {
    const before = element.getBoundingClientRect();
    const layoutWidth = element.offsetWidth, layoutHeight = element.offsetHeight;
    let layoutChanged = false, boundsResized = false;
    function probe(dx, dy) {
      writeMove(element, x + dx, y + dy, makeRelative, translate);
      const rect = element.getBoundingClientRect();
      boundsResized ||= Math.abs(rect.width - before.width) > 1 || Math.abs(rect.height - before.height) > 1;
      layoutChanged ||= element.offsetWidth !== layoutWidth || element.offsetHeight !== layoutHeight;
      return rect;
    }
    const zero = probe(0, 0), horizontal = probe(32, 0), vertical = probe(0, 32);
    restoreStyles(element, original);
    // Moving an auto-sized, pinned box can genuinely resize it. A tilted plane
    // under perspective can change screen size without changing its CSS layout.
    if (layoutChanged || (boundsResized && !hasPerspectiveProjection(element)) ||
        Math.abs(zero.x - before.x) > 1 || Math.abs(zero.y - before.y) > 1 ||
        Math.abs(zero.width - before.width) > 1 || Math.abs(zero.height - before.height) > 1) return null;
    const projection = boundsResized && !corner;
    const u = projection ? (message.x * innerWidth - before.left) / before.width : 0;
    const v = projection ? (message.y * innerHeight - before.top) / before.height : 0;
    const a = (horizontal.x - zero.x + u * (horizontal.width - zero.width)) / 32;
    const b = (horizontal.y - zero.y + v * (horizontal.height - zero.height)) / 32;
    const c = (vertical.x - zero.x + u * (vertical.width - zero.width)) / 32;
    const d = (vertical.y - zero.y + v * (vertical.height - zero.height)) / 32;
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.0001) return null;
    return { a, b, c, d, determinant, projection: projection && {before, u, v} };
  }

  function moveOffset(step, dx, dy) {
    const offset = localOffset(step.axes, dx, dy);
    if (!step.axes.projection) return offset;
    // Keep the grabbed point of the projected bounds under the pointer. The
    // mapping bends with depth, so refine large drags against the actual box.
    const { before, u, v } = step.axes.projection;
    let best = {x:0, y:0}, bestError = Math.hypot(dx, dy);
    for (let i = 0; i < 4; i++) {
      writeMove(step.element, step.left + offset.x, step.top + offset.y, step.makeRelative, step.translate);
      const rect = step.element.getBoundingClientRect();
      const ex = dx - (rect.x - before.x + u * (rect.width - before.width));
      const ey = dy - (rect.y - before.y + v * (rect.height - before.height));
      const error = Math.hypot(ex, ey);
      if (!(error < bestError)) break;
      best = {...offset}; bestError = error;
      if (error <= 0.25) break;
      const adjustment = localOffset(step.axes, ex, ey);
      offset.x += adjustment.x;
      offset.y += adjustment.y;
    }
    return best;
  }

  function canvasTargetVisible(element, style) {
    if (!element.isConnected || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function canvasPointHit(x, y) {
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return document.elementFromPoint(x * innerWidth, y * innerHeight)?.closest('[id],[data-hf-id]');
  }

  function canvasGestureTarget(message, corner) {
    const { x, y, target } = message;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const insideFrame = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    if (insideFrame && !target) return corner ? picked : canvasPointHit(x, y);
    if (!target?.sourceFile) return null;
    const node = inspectorElement(target);
    if (!node || node.closest('[data-hf-parked-scene]')) return null;
    if (insideFrame && corner) return node;
    if (picked?.isConnected && node !== picked) return null;

    // The selected box can extend beyond the clipped iframe. Validate the actual live
    // bounds instead of redirecting the pointer to a different layer at the frame edge.
    const rect = node.getBoundingClientRect();
    const px = x * innerWidth, py = y * innerHeight;
    if (!corner) return px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom ? node : null;
    const cx = corner.endsWith('w') ? rect.left : rect.right;
    const cy = corner.startsWith('n') ? rect.top : rect.bottom;
    return Math.abs(px - cx) <= 4 && Math.abs(py - cy) <= 4 ? node : null;
  }

  function startDrag(message, knownTarget) {
    if (drag) return null;
    const corner = ['nw','ne','sw','se'].includes(message.corner) ? message.corner : null;
    const element = knownTarget || canvasGestureTarget(message, corner);
    if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement ||
        element.matches('[data-composition-id],[data-composition-src],[data-hf-scene]') ||
        element.closest('[data-timeline-locked]')) return null;
    const selection = describe(element);

    const style = getComputedStyle(element);
    if (!canvasTargetVisible(element, style)) return null;
    const makeRelative = style.position === 'static';
    if (!canvasBase(selection.sourceFile, {corner, makeRelative, element})) return { waitingForSource: true };
    // A CSS animation owns its layout properties. Move its path using the independent translate instead.
    // Older Studio clients can save translated moves but would drop the dimensions of a resize.
    const allowTranslate = corner ? message.cssResizeOffset === true : message.cssLayoutOffset === true;
    const translate = allowTranslate && animatedLayoutOffset(element, style);
    const properties = translate ? ['translate'] : makeRelative ? ['left', 'top', 'position'] : ['left', 'top'];
    const width = parseFloat(style.width), height = parseFloat(style.height);
    if (corner) {
      // Inline replaced media honor CSS width and height, unlike an inline text span.
      if (!(width > 0 && height > 0) || (style.display === 'inline' && !element.matches('canvas,img,video'))) return null;
      properties.push('width','height');
    }
    const original = Object.fromEntries(properties.map(property => [property, {
      value: element.style[property], priority: element.style.getPropertyPriority(property)
    }]));
    const left = translate ? translate[0] : makeRelative ? 0 : parseFloat(style.left) || 0;
    const top = translate ? translate[1] : makeRelative ? 0 : parseFloat(style.top) || 0;
    const axes = measureDragAxes(element, left, top, makeRelative, original, translate, message, corner);
    if (!axes && corner !== 'se') return null;
    const resize = corner && measureResize(element, width, height, corner, original, axes);
    if (corner && !resize) return null;

    const localTime = window.__timelines?.[element.closest('[data-composition-id]')?.getAttribute('data-composition-id')]?.time?.();
    const time = Number.isFinite(localTime) ? localTime : (Number(window.__player?.getTime?.()) || 0);
    const pos = axis => parseFloat(window.gsap?.getProperty?.(element, axis)) || 0;
    const startPosition = corner || translate ? {time} : {time,x:pos('x'),y:pos('y')};
    drag = { ordered: message.ordered === true, startPosition, id: message.gestureId, element, original, left, top, makeRelative, translate, axes, resize, selection, width, height, corner };
    return { geometry: selection.geometry, viewport: selection.viewport, ...((corner || axes.projection) && { liveResizeBounds: true }), target: { sourceFile: selection.sourceFile, hfId: selection.hfId, elementId: selection.elementId, ...sourceIdentity(canvasBase(selection.sourceFile, drag)) } };
  }

  function canvasDrag(message) {
    if (message.phase === 'start') return startDrag(message);
    const pending = pendingDrags.get(message.gestureId);
    if (message.phase === 'removed') {
      const step = pending || (drag?.id === message.gestureId && drag);
      if (!step?.ordered) return null;
      step.element.remove();
      pendingDrags.delete(step.id);
      if (drag === step) drag = null;
      return null;
    }
    if (pending && (message.phase === 'commit' || message.phase === 'cancel')) {
      const path = pending.selection.sourceFile;
      const requiresFreshFrame = !pending.ordered && message.phase === 'commit' && message.changed && !pending.verifiedVersion;
      if (pending.ordered && message.phase === 'cancel') {
        if (structureDraft?.pending?.includes(pending)) {
          structureDraft.restore();
          structureDraft = undefined;
        }
        // Other queued operations own their own outcome, including edits to a different layer in this file.
        const later = [...pendingForSource(path).slice(pendingForSource(path).indexOf(pending) + 1), drag];
        for (const key of Object.keys(pending.applied || {})) {
          const next = later.find(step => step?.element === pending.element && step.original[key]);
          if (next) next.original[key] = pending.original[key];
          else restoreStyles(pending.element, { [key]: pending.original[key] }, pending.applied);
        }
      } else if (message.phase === 'cancel' || requiresFreshFrame) {
        // Later measurements include this gesture. Unwind newest first.
        if (drag?.selection.sourceFile === path) {
          if (drag.applied && !requiresFreshFrame) restoreStyles(drag.element, drag.original, drag.applied);
          drag = null;
        }
        const steps = pendingForSource(path);
        for (const step of steps.slice(steps.indexOf(pending)).reverse()) {
          if (!requiresFreshFrame) restoreStyles(step.element, step.original, step.applied);
          pendingDrags.delete(step.id);
        }
      }
      pendingDrags.delete(message.gestureId);
      const confirmed = !pending.ordered && !requiresFreshFrame && (pending.confirmedVersion || pending.sha256);
      if (confirmed) confirmCanvasVersion(path, confirmed);
      return null;
    }
    if (!drag || message.gestureId !== drag.id) return null;
    if (message.phase === 'cancel') {
      if (drag.applied) restoreStyles(drag.element, drag.original, drag.applied);
      drag = null;
      return null;
    }
    if (message.phase === 'finish' && !canvasTargetVisible(drag.element, getComputedStyle(drag.element))) {
      if (drag.applied) restoreStyles(drag.element, drag.original, drag.applied);
      drag = null;
      return null;
    }
    if (!drag.element.isConnected || !['move', 'finish'].includes(message.phase) ||
        !Number.isFinite(message.dx) || !Number.isFinite(message.dy)) return null;

    const dx = message.dx * innerWidth, dy = message.dy * innerHeight;
    const round = n => Math.round(n * 1000) / 1000;
    const { corner } = drag;
    let size = corner && resizedBox(drag, dx, dy);
    if (drag.resize?.projection) size = projectedResize(drag, dx, dy, size);
    const { x: offsetX, y: offsetY } = size || moveOffset(drag, dx, dy);
    const left = round(drag.left + offsetX), top = round(drag.top + offsetY);
    const width = size && round(size.width), height = size && round(size.height);
    const writeLeft = !corner || drag.resize.writeLeft;
    const writeTop = !corner || drag.resize.writeTop;
    const applied = {};
    const set = (key,value) => { drag.element.style[key] = value; applied[key] = drag.element.style[key]; };
    if (writeLeft || writeTop) {
      if (drag.translate) set('translate', left + 'px ' + top + 'px');
      else {
        if (drag.makeRelative) set('position','relative');
        if (writeLeft) set('left',left + 'px');
        if (writeTop) set('top',top + 'px');
      }
    }
    if (corner) { set('width',width+'px'); set('height',height+'px'); }
    drag.applied = applied;
    if (message.phase !== 'finish') return null;
    const { sourceFile, elementId, hfId } = drag.selection;
    const { makeRelative, startPosition } = drag;
    const translated = Boolean(drag.translate);
    const position = !corner && !translated && (message.wholePath
      ? { time:startPosition.time, delta:{x:round(offsetX), y:round(offsetY)} }
      : { time:startPosition.time, x:round(startPosition.x + offsetX), y:round(startPosition.y + offsetY) });
    const sha256 = canvasBase(sourceFile, drag);
    const predecessor = pendingForSource(sourceFile).at(-1)?.id;
    const finalBounds = (corner || drag.axes?.projection) && canvasFrameBounds(drag.element);
    // Keep general inspectors pinned to the last fully settled document.
    if (!drag.ordered) delete sourceVersions[sourceFile];
    pendingDrags.set(drag.id, { ...drag, sha256 });
    drag = null;
    const extraAxes = (writeLeft && !corner?.endsWith('w') ? 'x' : '') + (writeTop && !corner?.startsWith('n') ? 'y' : '');
    return { sourceFile, elementId, hfId, ...sourceIdentity(sha256), ...(predecessor && {predecessor}), left, top, makeRelative, ...(translated && {translated}), ...(position && {position}), ...(corner && {corner,width,height,...(extraAxes && {extraAxes})}), ...finalBounds };
  }
`;
