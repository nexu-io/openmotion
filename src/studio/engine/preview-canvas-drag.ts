/** Runs inside the scoped project frame alongside describe() and sourceVersions.
 * Studio owns pointer capture and authorizes the final source write. */
export const PREVIEW_CANVAS_DRAG = `
  let drag = null;
  const pendingDrags = new Map();

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
    else {
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

  function measureDragAxes(element, x, y, makeRelative, original, translate) {
    // Measure the authored coordinate system, including transformed ancestors.
    const before = element.getBoundingClientRect();
    function probe(dx, dy) {
      if (translate) element.style.translate = (x + dx) + 'px ' + (y + dy) + 'px';
      else {
        if (makeRelative) element.style.position = 'relative';
        element.style.left = (x + dx) + 'px';
        element.style.top = (y + dy) + 'px';
      }
      return element.getBoundingClientRect();
    }
    const zero = probe(0, 0), horizontal = probe(32, 0), vertical = probe(0, 32);
    restoreStyles(element, original);

    const a = (horizontal.x - zero.x) / 32;
    const b = (horizontal.y - zero.y) / 32;
    const c = (vertical.x - zero.x) / 32;
    const d = (vertical.y - zero.y) / 32;
    const determinant = a * d - b * c;
    const resizes = [zero, horizontal, vertical].some(rect =>
      Math.abs(rect.width - before.width) > 1 || Math.abs(rect.height - before.height) > 1
    );
    if (resizes || Math.abs(determinant) < 0.0001 ||
        Math.abs(zero.x - before.x) > 1 || Math.abs(zero.y - before.y) > 1) return null;
    return { a, b, c, d, determinant };
  }

  function canvasTargetVisible(element, style) {
    if (!element.isConnected || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function startDrag(message) {
    if (drag) return null;
    const hit = document.elementFromPoint(message.x * innerWidth, message.y * innerHeight);
    const corner = ['nw','ne','sw','se'].includes(message.corner) ? message.corner : null;
    const element = corner ? (message.target ? inspectorElement(message.target) : picked) : hit?.closest('[id],[data-hf-id]');
    if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement ||
        element.matches('[data-composition-id],[data-composition-src],[data-hf-scene]') ||
        element.closest('[data-timeline-locked]')) return null;
    const selection = describe(element);

    const style = getComputedStyle(element);
    if (!canvasTargetVisible(element, style)) return null;
    const makeRelative = style.position === 'static';
    if (!canvasBase(selection.sourceFile, {corner, makeRelative, element})) return { waitingForSource: true };
    // A CSS animation owns its layout properties. Move its path using the independent translate instead.
    const translate = !corner && animatedLayoutOffset(element, style);
    const properties = translate ? ['translate'] : makeRelative ? ['left', 'top', 'position'] : ['left', 'top'];
    const width = parseFloat(style.width), height = parseFloat(style.height);
    if (corner) {
      // Inline replaced media honor CSS width and height, unlike an inline text span.
      if (!(width > 0 && height > 0) || (style.display === 'inline' && !element.matches('canvas,img,video')) ||
          style.transform !== 'none') return null;
      properties.push('width','height');
    }
    const original = Object.fromEntries(properties.map(property => [property, {
      value: element.style[property], priority: element.style.getPropertyPriority(property)
    }]));
    const left = translate ? translate[0] : makeRelative ? 0 : parseFloat(style.left) || 0;
    const top = translate ? translate[1] : makeRelative ? 0 : parseFloat(style.top) || 0;
    const axes = measureDragAxes(element, left, top, makeRelative, original, translate);
    if (!axes || (corner && (axes.a <= 0 || axes.d <= 0 || Math.abs(axes.b) + Math.abs(axes.c) > 0.001))) return null;

    const localTime = window.__timelines?.[element.closest('[data-composition-id]')?.getAttribute('data-composition-id')]?.time?.();
    const time = Number.isFinite(localTime) ? localTime : (Number(window.__player?.getTime?.()) || 0);
    const pos = axis => parseFloat(window.gsap?.getProperty?.(element, axis)) || 0;
    const startPosition = translate ? {time} : {time,x:pos('x'),y:pos('y')};
    drag = { startPosition, id: message.gestureId, element, original, left, top, makeRelative, translate, axes, selection, width, height, corner };
    return { geometry: selection.geometry, viewport: selection.viewport };
  }

  function canvasDrag(message) {
    if (message.phase === 'start') return startDrag(message);
    const pending = pendingDrags.get(message.gestureId);
    if (pending && (message.phase === 'commit' || message.phase === 'cancel')) {
      const path = pending.selection.sourceFile;
      const requiresFreshFrame = message.phase === 'commit' && message.changed && !pending.verifiedVersion;
      if (message.phase === 'cancel' || requiresFreshFrame) {
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
      const confirmed = !requiresFreshFrame && (pending.confirmedVersion || pending.sha256);
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
    const { a, b, c, d, determinant } = drag.axes;
    const round = n => Math.round(n * 1000) / 1000;
    const offsetX = (d * dx - c * dy) / determinant, offsetY = (a * dy - b * dx) / determinant;
    const { corner } = drag;
    const west = corner?.endsWith('w'), north = corner?.startsWith('n');
    const width = round(Math.max(1, drag.width + (west ? -offsetX : offsetX)));
    const height = round(Math.max(1, drag.height + (north ? -offsetY : offsetY)));
    const left = round(drag.left + (corner ? (west ? drag.width - width : 0) : offsetX));
    const top = round(drag.top + (corner ? (north ? drag.height - height : 0) : offsetY));
    const applied = {};
    const set = (key,value) => { drag.element.style[key] = value; applied[key] = drag.element.style[key]; };
    if (drag.translate) set('translate', left + 'px ' + top + 'px');
    else if (!corner || west || north) {
      if (drag.makeRelative) set('position','relative');
      if (!corner || west) set('left',left + 'px');
      if (!corner || north) set('top',top + 'px');
    }
    if (corner) { set('width',width+'px'); set('height',height+'px'); }
    drag.applied = applied;
    if (message.phase !== 'finish') return null;
    const { sourceFile, elementId, hfId } = drag.selection;
    const { makeRelative, startPosition } = drag;
    const position = drag.translate ? { time:startPosition.time, x:left, y:top } : message.wholePath
      ? { time:startPosition.time, delta:{x:round(offsetX), y:round(offsetY)} }
      : { time:startPosition.time, x:round(startPosition.x + offsetX), y:round(startPosition.y + offsetY) };
    const translated = Boolean(drag.translate);
    const sha256 = canvasBase(sourceFile, drag);
    const predecessor = pendingForSource(sourceFile).at(-1)?.id;
    // Keep general inspectors pinned to the last fully settled document.
    delete sourceVersions[sourceFile];
    pendingDrags.set(drag.id, { ...drag, sha256 });
    drag = null;
    return { sourceFile, elementId, hfId, ...sourceIdentity(sha256), ...(predecessor && {predecessor}), left, top, makeRelative, ...(translated && {translated}), ...(!corner && {position}), ...(corner && {corner,width,height}) };
  }
`;
