import { isLiveMediaMove } from '../../../shared/preview-live-media.ts';
import { stageVisualClipInsert } from '../../../shared/preview-visual-insert.ts';
import { STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR } from '../../../packages/edit-core/canvas-position.ts';
import { PREVIEW_ATTRIBUTES, canPatchPreviewAttribute, PRESENTATION_TAGS, PRESENTATION_STYLES, MAX_PREVIEW_TEXT_LENGTH, isLivePositionEdit, canPatchPresentationValue } from '../../../shared/preview-timing.ts';

// Runs inside the token-scoped iframe. Each change targets a verified live node and file revision.
export const PREVIEW_PEER_TIMING = `
  const canPatchPreviewAttribute = ${canPatchPreviewAttribute.toString()};
  const previewAttributes = new Set(${JSON.stringify(PREVIEW_ATTRIBUTES)});
  const presentationTags = new Set(${JSON.stringify(PRESENTATION_TAGS)});
  const presentationStyles = new Set(${JSON.stringify(PRESENTATION_STYLES)});
  const originalTranslateAttribute = ${JSON.stringify(STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR)};
  const canPatchPresentationValue = ${canPatchPresentationValue.toString()};
  const styleDocumentId = globalThis.crypto?.randomUUID?.();
  const timingDocumentId = settings.canRebindTiming === true ? styleDocumentId : undefined;
  function timingVersion(tag) {
    if (typeof tag !== 'string') return null;
    const match = /^"(sha256|patch):([a-f0-9]{64})"$/.exec(tag);
    return match ? (match[1] === 'patch' ? tag : match[2]) : null;
  }
  function stagePresentation(node, change, effects, local, pending) {
    if (change.captureOriginalTranslate !== undefined) {
      const move = Array.isArray(change.styles) && change.styles.find(style => Array.isArray(style) && style[0] === 'translate');
      if (typeof change.captureOriginalTranslate !== 'boolean' || !timingDocumentId || !move) return false;
      const from = change.captureOriginalTranslate ? null : move[2];
      const to = change.captureOriginalTranslate ? move[1] : null;
      const actual = node.getAttribute(originalTranslateAttribute);
      if (actual !== from && !(local && actual === to)) return false;
      effects.push(forward => {
        const value = forward ? to : actual;
        if (value === null) node.removeAttribute(originalTranslateAttribute);
        else node.setAttribute(originalTranslateAttribute, value);
      });
    }
    if (!change.styles && !change.text) return true;
    if (!presentationTags.has(node.localName) && !(node.localName === 'canvas' && isPositionEdit([change]))) return false;
    if (change.styles) {
      if (!Array.isArray(change.styles) || !change.styles.length || change.styles.length > presentationStyles.size) return false;
      for (const [name, from, to] of change.styles) {
        const actual = node.style.getPropertyValue(name) || '';
        const applied = pending?.element === node ? pending.applied?.[name] : undefined;
        const newer = newerDragStyle(pending, node, name);
        if (!presentationStyles.has(name) || typeof from !== 'string' || typeof to !== 'string' || !canPatchPresentationValue(name, to) ||
            (newer !== undefined && actual !== newer) ||
            Math.max(from.length,to.length) > 256 || (actual !== from && !(local && (actual === to || actual === applied || actual === newer))) ||
            (typeof node.style.getPropertyPriority === 'function' && node.style.getPropertyPriority(name))) return false;
        // This receipt advances storage. A later gesture owns the live CSS value.
        if (local && actual === newer) continue;
        effects.push(forward => {
          const value = forward ? to : actual;
          if (value) node.style.setProperty(name, value);
          else node.style.removeProperty(name);
        });
      }
    }
    if (change.text) {
      const text = node.firstChild;
      if (!Array.isArray(change.text) || change.text.length !== 2 || change.text.some(value =>
          typeof value !== 'string' || value.length > ${MAX_PREVIEW_TEXT_LENGTH}) ||
          text?.nodeType !== 3 || text.nextSibling || (text.data !== change.text[0] && !(local && text.data === change.text[1]))) return false;
      const actual = text.data;
      effects.push(forward => { text.data = forward ? change.text[1] : actual; });
    }
    return true;
  }
  const isPositionEdit = ${isLivePositionEdit.toString()};
  const isMediaMove = ${isLiveMediaMove.toString()};
  const stageClipInsert = ${stageVisualClipInsert.toString()};
  // A draft owns only its provisional DOM. Its source version stays unchanged until storage confirms it.
  let structureDraft;
  function applyPeerTiming(m) {
    if (m.discardDraftId) {
      if (!structureDraft || m.discardDraftId !== structureDraft.id || m.path !== structureDraft.path ||
          m.documentId !== timingDocumentId) return false;
      const draft = structureDraft;
      structureDraft = undefined;
      draft.restore();
      return true;
    }
    const before = timingVersion(m.before), after = timingVersion(m.after), p = player();
    const temporary = m.type === 'peer-presentation' && m.temporary === true;
    const local = !temporary && m.type === 'peer-presentation' && m.localSave === true;
    const pending = local && pendingDrags.get(m.gestureId);
    const ownDrag = pending && pendingForSource(m.path)[0] === pending;
    const base = ownDrag ? pending.confirmedVersion || pending.sha256 : sourceVersions[m.path];
    const position = settings.liveEdits?.position === true && m.type === 'peer-presentation' &&
      Array.isArray(m.changes) && m.changes.length <= 32 && isPositionEdit(m.changes);
    const media = settings.liveEdits?.mediaTiming === true && m.type === 'peer-timing' &&
      Array.isArray(m.changes) && m.changes.length <= 32 && isMediaMove(m.changes);
    const target = temporary || position || media ? styleDocumentId : timingDocumentId;
    if (!target || m.documentId !== target || (temporary ? !!timingDocumentId : !position && m.path !== compositionPath) ||
        !before || !after || before !== base ||
        !Number.isFinite(m.expiresAt) || Date.now() >= m.expiresAt ||
        (!ownDrag && (drag || pendingDrags.size)) ||
        (inlineText && !(local && inlineText.id === m.gestureId && inlineText.after !== undefined)) || !p || typeof p.seek !== 'function' ||
        typeof p.getTime !== 'function' || typeof window.__hfForceTimelineRebind !== 'function' ||
        !Array.isArray(m.changes) || m.changes.length > 32) return false;
    const sameContent = !m.changes.length && m.sameContent === true && m.type === 'peer-timing' && !!timingDocumentId;
    if (!m.changes.length && !sameContent) return false;
    const drafting = typeof m.structureDraftId === 'string';
    if (drafting && (!timingDocumentId || m.type !== 'peer-timing' || before !== after ||
        !m.structureDraftId.length || m.structureDraftId.length > 64 || !m.changes.some(c => c?.removeFromComposition || c?.insert))) return false;
    if (structureDraft) {
      if (drafting) return false;
      const draft = structureDraft;
      structureDraft = undefined;
      if (m.type === 'peer-timing' && draft.path === m.path && draft.before === before &&
          draft.changes === JSON.stringify(m.changes)) {
        confirmCanvasVersion(m.path, after);
        return true;
      }
      draft.restore();
    }
    if (sameContent) {
      confirmCanvasVersion(m.path, after);
      return true;
    }
    const edits = [], effects = [], placements = [];
    let structureChanged = false;
    for (const change of m.changes) {
      if (!change || (!change.hfId && !change.id && !change.compositionId) || !Array.isArray(change.attributes) ||
          (!change.attributes.length && !change.styles && !change.text && !change.removeFromComposition && !change.insert) || change.attributes.length > previewAttributes.size) return false;
      if (change.insert) {
        if (structureChanged || !timingDocumentId || m.type !== 'peer-timing') return false;
        const insert = stageClipInsert(document, change, presentationTags);
        if (!insert) return false;
        structureChanged = true;
        effects.push(insert);
        continue;
      }
      if ((temporary || ownDrag) && (!change.styles || change.text || change.attributes.length)) return false;
      const selector = change.hfId ? '[data-hf-id="'+CSS.escape(change.hfId)+'"]' :
        change.id ? '#'+CSS.escape(change.id) : '[data-composition-id="'+CSS.escape(change.compositionId)+'"]';
      const matches = Array.from(document.querySelectorAll(selector)).filter(node =>
        node.localName === change.tag && sourceFileForElement(node) === m.path);
      if (matches.length !== 1 || matches[0].closest('[data-hf-parked-scene]')) return false;
      const node = matches[0];
      if (change.removeFromComposition) {
        const parent = node.parentElement, next = node.nextSibling;
        if (structureChanged || !timingDocumentId || m.type !== 'peer-timing' || !change.hfId || !presentationTags.has(node.localName) ||
            node.id !== change.id || node.childElementCount || !node.classList.contains('clip') ||
            parent?.getAttribute('data-composition-id') !== change.removeFromComposition) return false;
        structureChanged = true;
        effects.push(forward => forward ? node.remove() : parent.insertBefore(node, next));
      }
      if (media && change.tag !== 'audio' && node !== document.querySelector('[data-composition-id]')) return false;
      if (position && change.styles.some(([name]) => name === 'position')) {
        if (node.childElementCount) return false;
        // Inline declarations alone cannot tell whether stylesheet positioning is static.
        const livePosition = getComputedStyle(node).position;
        if (livePosition !== 'static' && livePosition !== 'relative') return false;
      }
      if (!stagePresentation(node, change, effects, local, pending)) return false;
      if (position && !temporary) placements.push([node, selector, change]);
      for (const [name, from, to] of change.attributes) {
        if (!previewAttributes.has(name) || [from, to].some(value => !canPatchPreviewAttribute(name, value, node.localName))) return false;
        const preserved = name === 'data-duration' || name === 'data-end' ? name.replace('data-','data-hf-authored-') : null;
        const names = preserved && node.hasAttribute(preserved) ? [preserved,name] : [name];
        const control = previewControls.get(node)?.get(names[0]);
        const actual = control ? control.base : node.getAttribute(names[0]);
        if (actual !== from && !(actual && from && Number(actual) === Number(from))) return false;
        for (const attr of names) edits.push({node,attr,old:attr === names[0] ? actual : node.getAttribute(attr),to});
      }
    }
    const time = p.getTime(), playing = p.isPlaying?.() === true;
    if (!Number.isFinite(time) || Date.now() >= m.expiresAt) return false;
    function update(key, at = time, resume = playing) {
      for (const e of edits) {
        applyTimelineReceipt(e.node, e.attr, e[key]);
      }
      for (const effect of effects) effect(key === 'to');
      // Lock is an editor flag. Studio reapplies the local monitor preference on mute.
      if (!structureChanged && !edits.some(edit => edit.attr !== 'data-timeline-locked' && edit.attr !== 'muted')) return;
      p.seek(at);
      window.__hfForceTimelineRebind();
      window.__hfStudioManualEditsApply?.();
      if (resume) p.play?.();
    }
    const run = cb => window.__hfSuppressSceneMutations ? window.__hfSuppressSceneMutations(cb) : cb();
    try { run(() => update('to')); }
    catch (_) { try { run(() => update('old')); } catch (_) {} return false; }
    if (drafting) {
      structureDraft = { id: m.structureDraftId, path: m.path, before, changes: JSON.stringify(m.changes),
        restore: () => run(() => update('old', p.getTime(), p.isPlaying?.() === true)) };
      return true;
    }
    // Only a complete rebind advances the revision used for future edits and selections.
    if (!temporary) {
      if (m.path !== compositionPath) advanceScenePlacements(m.path, before, after);
      for (const [node, selector, change] of placements) rememberScenePlacement(node, m.path, selector, change, after);
      if (ownDrag) pending.verifiedVersion = after;
      confirmCanvasVersion(m.path, after);
    }
    return true;
  }
`;
