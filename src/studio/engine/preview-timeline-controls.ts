// The mounted player can show a click before its project revision is accepted.
// Preserve each authored attribute separately so verified file receipts still
// compare against their exact base while the user is toggling the same track.
export const PREVIEW_TIMELINE_CONTROLS = `
  const previewControls = new WeakMap();
  function previewTimelineControls(message) {
    const name = message.attr;
    if (!['data-hidden','data-timeline-locked','muted','data-volume','data-color-grading'].includes(name) || !Array.isArray(message.changes)) return;
    let changed = false;
    for (const item of message.changes) {
      if (!item || typeof item.settled !== 'boolean' ||
          !Object.hasOwn(sourceVersions, item.sourceFile)) continue;
      const node = inspectorElement(item);
      if (!node || node.closest('[data-hf-parked-scene]') || !canPatchPreviewAttribute(name,item.value,node.localName)) continue;
      let controls = previewControls.get(node);
      if (!controls) previewControls.set(node, controls = new Map());
      let entry = controls.get(name);
      if (!entry) {
        if (item.settled) continue;
        entry = {base:node.getAttribute(name)};
        controls.set(name,entry);
      }
      if (name === 'data-color-grading') {
        if (item.settled && entry.gesture !== message.gesture) continue;
        entry.gesture = message.gesture;
      }
      entry.settled = item.settled;
      if (node.getAttribute(name) !== item.value) {
        if (item.value === null) node.removeAttribute(name);
        else node.setAttribute(name, item.value);
        changed = true;
      }
      if (item.settled && entry.base === item.value) controls.delete(name);
    }
    if (changed && (name === 'data-hidden' || name === 'data-volume')) {
      const p = player();
      if (p?.seek && p.getTime) {
        const playing = p.isPlaying?.();
        p.seek(p.getTime());
        if (name === 'data-volume') window.__hfForceTimelineRebind?.();
        if (playing) p.play?.();
      }
    }
  }
  function applyTimelineReceipt(node, name, value) {
    const controls = previewControls.get(node);
    const entry = controls?.get(name);
    if (entry) {
      entry.base = value;
      if (!entry.settled) return;
      controls.delete(name);
    }
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name,value);
  }
`;
