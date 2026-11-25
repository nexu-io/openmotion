/** A child can be replaced while its captions or scripts finish loading. Keep input bound
 * to the user's original target and verify its geometry before replaying a release. */
export const PREVIEW_SCENE_GESTURES = `
  const releasedSceneGestures = new Map();
  let waitingTextPick = null;

  function sameGestureBasis(before, after) {
    const same = (a, b, keys) => a === b || (a && b && keys.every(key => Math.abs(a[key] - b[key]) < 0.001));
    const positionKeys = Object.keys(before.startPosition);
    if (positionKeys.length !== Object.keys(after.startPosition).length || before.makeRelative !== after.makeRelative || !same(before, after, ['left','top']) ||
        !same(before.axes, after.axes, ['a','b','c','d']) ||
        !same(before.selection.geometry, after.selection.geometry, ['x','y','width','height']) ||
        !same(before.startPosition, after.startPosition, positionKeys)) return false;
    return !before.corner || (same(before, after, ['width','height']) &&
      ['width','height'].every(axis => same(before.resize[axis], after.resize[axis], ['w','h','x','y'])));
  }

  function onIncomingNode(step, node, release = false) {
    if (!node || node.localName !== step.element.localName) return null;
    const active = drag;
    try {
      drag = null;
      if (node === step.element) restoreStyles(node, step.original, step.applied);
      if (!startDrag(step.sceneStart, node) || !drag || !sameGestureBasis(step, drag)) return null;
      return release ? canvasDrag(step.releaseMessage) : drag;
    } finally { drag = active; }
  }

  // The incoming DOM must include earlier releases before hit-testing and measuring
  // the next pointerdown. Preserve the bridge's ordinary pending/rollback order.
  function stageMountedGestures() {
    for (const step of releasedSceneGestures.values()) {
      if (!step.ordered || step.element.isConnected || 'sceneResult' in step) continue;
      const node = inspectorElement(step.selection);
      if (!node || step.sceneUpdate.targets.get(step.selection.sourceFile).host.contains(node)) continue;
      const result = onIncomingNode(step, node, true);
      // A newly mounted child can still be hidden until its scripts finish.
      if (result) step.sceneResult = result;
    }
    // A scene may also mount while the pointer is still down. Transfer the
    // same measurement and last pointer delta before the new node is painted.
    const active = drag;
    if (!active?.sceneUpdate || !active.ordered || active.element.isConnected) return;
    const next = onIncomingNode(active, inspectorElement(active.selection));
    if (!next) return;
    Object.assign(active, next);
    if (drag.sceneMove) canvasDrag(drag.sceneMove);
  }

  // Restore tentative edits before the browser paints a newly mounted host, even
  // when the user makes no further input. Observe only the parents being swapped.
  function watchSceneMount(update) {
    if (update.gestureObserver) return;
    const observer = update.gestureObserver = new MutationObserver(stageMountedGestures);
    for (const {host} of update.targets.values()) {
      if (host.parentElement) observer.observe(host.parentElement, {childList: true});
    }
    update.ready.then(applied => {
      observer.disconnect();
      if (applied) stageMountedGestures();
    });
  }

  async function finishSceneGesture(step, message) {
    const update = step.sceneUpdate, path = step.selection.sourceFile;
    step.releaseMessage = message;
    if (step.ordered && step.element.isConnected && !update.targets.get(path).host.contains(step.element)) {
      step.sceneResult = canvasDrag(message);
    } else {
      canvasDrag({ ...message, phase:'move' });
      drag = null;
    }
    releasedSceneGestures.set(step.id, step);
    if (step.ordered && !('sceneResult' in step)) {
      watchSceneMount(update);
      stageMountedGestures();
    }
    try {
      if (!await update.ready) {
        for (const item of Array.from(releasedSceneGestures.values()).reverse()) {
          if (item.sceneUpdate === update) cancelSceneRelease(item, 'cancel');
        }
        return null;
      }
      if (releasedSceneGestures.get(step.id) !== step || sourceVersions[path] !== update.versions[path]) return null;
      if (!('sceneResult' in step)) return onIncomingNode(step, inspectorElement(step.selection), true);
      if (!step.sceneResult || !pendingDrags.get(step.id)?.element.isConnected) return null;
      const { sha256, fileVersion, ...measurement } = step.sceneResult;
      return { ...measurement, ...sourceIdentity(update.versions[path]) };
    } finally {
      releasedSceneGestures.delete(step.id);
    }
  }

  function cancelSceneRelease(step, phase) {
    releasedSceneGestures.delete(step.id);
    if (pendingDrags.has(step.id)) canvasDrag({phase, gestureId:step.id});
    else if (step.element.isConnected && step.applied) restoreStyles(step.element, step.original, step.applied);
  }

  function cancelDependentReleases(step, phase) {
    const releases = Array.from(releasedSceneGestures.values());
    const node = pendingDrags.get(step.id)?.element || inspectorElement(step.selection) || step.element;
    const dependsOn = el => node === el || node.contains(el);
    if (drag && dependsOn(drag.element)) canvasDrag({phase:'cancel', gestureId:drag.id});
    for (const item of releases.slice(releases.indexOf(step) + 1).reverse()) {
      const el = pendingDrags.get(item.id)?.element || inspectorElement(item.selection) || item.element;
      if (item.sceneUpdate === step.sceneUpdate && dependsOn(el)) cancelSceneRelease(item, 'cancel');
    }
    cancelSceneRelease(step, phase);
  }

  function sceneCanvasDrag(message) {
    if (message.phase === 'start' && !drag && releasedSceneGestures.size) stageMountedGestures();
    if (message.phase === 'cancel' || message.phase === 'removed') {
      const released = releasedSceneGestures.get(message.gestureId);
      if (released) {
        cancelDependentReleases(released, message.phase);
        return null;
      }
    }
    if (message.phase === 'finish' && drag?.id === message.gestureId && drag.sceneUpdate)
      return finishSceneGesture(drag, message);
    if (message.phase === 'move' && drag?.id === message.gestureId && drag.sceneUpdate) {
      stageMountedGestures();
      drag.sceneMove = message;
    }
    const result = canvasDrag(message);
    if (message.phase === 'start' && drag?.id === message.gestureId && applyingSceneUpdate?.targets.has(drag.selection.sourceFile)) {
      drag.sceneUpdate = applyingSceneUpdate;
      drag.sceneStart = message;
      if (drag.ordered) watchSceneMount(applyingSceneUpdate);
    }
    return result;
  }

  function sceneInlineText(message) {
    if (message.phase === 'cancel' && waitingTextPick === message.editId) waitingTextPick = null;
    if (message.phase !== 'pick' || !applyingSceneUpdate) return editInlineText(message);
    if (releasedSceneGestures.size) stageMountedGestures();
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
