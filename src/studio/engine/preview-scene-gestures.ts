/** A child can be replaced while its captions or scripts finish loading. Keep input bound
 * to the user's original target and verify its geometry before replaying a release. */
export const PREVIEW_SCENE_GESTURES = `
  const releasedSceneGestures = new Map();
  let waitingTextPick = null;

  function sameGestureBasis(before, after) {
    const same = (a, b, keys) => keys.every(key => Math.abs(a[key] - b[key]) < 0.001);
    if (before.makeRelative !== after.makeRelative || !same(before, after, ['left','top']) ||
        !same(before.axes, after.axes, ['a','b','c','d']) ||
        !same(before.selection.geometry, after.selection.geometry, ['x','y','width','height']) ||
        !same(before.startPosition, after.startPosition, ['time','x','y'])) return false;
    return !before.corner || (same(before, after, ['width','height']) &&
      ['width','height'].every(axis => same(before.resize[axis], after.resize[axis], ['w','h','x','y'])));
  }

  async function finishSceneGesture(step, message) {
    const update = step.sceneUpdate, path = step.selection.sourceFile;
    // The runtime may already have installed the next host while its scripts load.
    // Preserve ordinary pointer ordering and tentative styles on that live host.
    if (step.ordered && step.element.isConnected && !update.targets.get(path).host.contains(step.element)) {
      const result = canvasDrag(message);
      if (!result || !await update.ready || !pendingDrags.has(step.id) ||
          !step.element.isConnected || sourceVersions[path] !== update.versions[path]) return null;
      const { sha256, fileVersion, ...measurement } = result;
      return { ...measurement, ...sourceIdentity(update.versions[path]) };
    }
    // The previous host may still be drawing. Keep the release visible, then free the
    // pointer immediately so unrelated and consecutive gestures can proceed.
    canvasDrag({ ...message, phase:'move' });
    drag = null;
    releasedSceneGestures.set(step.id, step);
    try {
      if (!await update.ready) {
        // Roll back in reverse release order if the runtime retained the original host.
        for (const item of Array.from(releasedSceneGestures.values()).reverse()) {
          if (item.sceneUpdate === update) cancelSceneRelease(item);
        }
        return null;
      }
      if (releasedSceneGestures.get(step.id) !== step || sourceVersions[path] !== update.versions[path]) return null;
      const node = inspectorElement(step.selection);
      if (!node || node.localName !== step.element.localName) return null;
      const active = drag;
      try {
        drag = null;
        if (node === step.element) restoreStyles(node, step.original, step.applied);
        if (!startDrag({ gestureId:step.id, corner:step.corner, ordered:step.ordered }, node) ||
            !drag || !sameGestureBasis(step, drag)) return null;
        return canvasDrag(message);
      } finally { drag = active; }
    } finally {
      releasedSceneGestures.delete(step.id);
    }
  }

  function cancelSceneRelease(step) {
    releasedSceneGestures.delete(step.id);
    if (step.element.isConnected && step.applied) restoreStyles(step.element, step.original, step.applied);
  }

  function sceneCanvasDrag(message) {
    if (message.phase === 'cancel' || message.phase === 'removed') {
      const released = releasedSceneGestures.get(message.gestureId);
      if (released) {
        cancelSceneRelease(released);
        return null;
      }
    }
    if (message.phase === 'finish' && drag?.id === message.gestureId && drag.sceneUpdate)
      return finishSceneGesture(drag, message);
    const result = canvasDrag(message);
    if (message.phase === 'start' && drag?.id === message.gestureId && applyingSceneUpdate?.targets.has(drag.selection.sourceFile))
      drag.sceneUpdate = applyingSceneUpdate;
    return result;
  }

  function sceneInlineText(message) {
    if (message.phase === 'cancel' && waitingTextPick === message.editId) waitingTextPick = null;
    if (message.phase !== 'pick' || !applyingSceneUpdate) return editInlineText(message);
    const hit = canvasPointHit(message.x, message.y);
    const target = hit && describe(hit);
    const update = applyingSceneUpdate;
    if (!target || !update.targets.has(target.sourceFile)) return editInlineText(message);
    waitingTextPick = message.editId;
    return update.ready.then(applied => {
      if (waitingTextPick !== message.editId) return null;
      waitingTextPick = null;
      if (!applied || sourceVersions[target.sourceFile] !== update.versions[target.sourceFile]) return null;
      const node = inspectorElement(target);
      return node && canvasPointHit(message.x, message.y) === node ? editInlineText(message) : null;
    });
  }
`;
