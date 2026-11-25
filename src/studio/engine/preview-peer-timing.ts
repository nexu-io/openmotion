import { indexGroupMembers, stageGroupChange } from "../../../shared/preview-group.ts";
import { isLiveMediaMove } from '../../../shared/preview-live-media.ts';
import { stageVisualClipInsert } from '../../../shared/preview-visual-insert.ts';
import { STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR } from '../../../packages/edit-core/canvas-position.ts';
import { PREVIEW_ATTRIBUTES, canPatchPreviewAttribute, PRESENTATION_TAGS, PRESENTATION_STYLES, MAX_PREVIEW_TEXT_LENGTH, readPreviewText, validPreviewText, samePreviewText, isMountedCaptionBatch, isGradeOnlyChange, isAuthoredPresentation, isLivePositionEdit, isPaintOnlyChange, isPixelBoxChange, isMediaBoxChange, canPatchPresentationValue } from '../../../shared/preview-timing.ts';

// Runs inside the token-scoped iframe. Each change targets a verified live node and file revision.
export const PREVIEW_PEER_TIMING = `
  const canPatchPreviewAttribute = ${canPatchPreviewAttribute.toString()};
  const previewAttributes = new Set(${JSON.stringify(PREVIEW_ATTRIBUTES)});
  const indexGroupMembers = ${indexGroupMembers.toString()};
  const stageGroup = ${stageGroupChange.toString()};
  const mediaBox = ${isMediaBoxChange.toString()};
  const isPixelBoxChange = ${isPixelBoxChange.toString()};
  const gradeOnly = ${isGradeOnlyChange.toString()};
  const paintOnly = ${isPaintOnlyChange.toString()};
  const PRESENTATION_TAGS = ${JSON.stringify(PRESENTATION_TAGS)};
  const presentationTags = new Set(PRESENTATION_TAGS);
  const presentationStyles = new Set(${JSON.stringify(PRESENTATION_STYLES)});
  const originalTranslateAttribute = ${JSON.stringify(STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR)};
  const canPatchPresentationValue = ${canPatchPresentationValue.toString()};
  const MAX_PREVIEW_TEXT_LENGTH = ${MAX_PREVIEW_TEXT_LENGTH};
  const validPreviewText = ${validPreviewText.toString()};
  const readPreviewText = ${readPreviewText.toString()};
  const samePreviewText = ${samePreviewText.toString()};
  const isMountedCaptionBatch = ${isMountedCaptionBatch.toString()};
  const styleDocumentId = globalThis.crypto?.randomUUID?.();
  const timingDocumentId = settings.canRebindTiming === true ? styleDocumentId : undefined;
  function timingVersion(tag) {
    if (typeof tag !== 'string') return null;
    const match = /^"(sha256|patch):([a-f0-9]{64})"$/.exec(tag);
    return match ? (match[1] === 'patch' ? tag : match[2]) : null;
  }
  function stageText(node, pair, local) {
    if (!Array.isArray(pair) || pair.length !== 2 || !validPreviewText(pair[0]) || !validPreviewText(pair[1])) return null;
    const actual = readPreviewText(node), [from, to] = pair;
    if (actual === null) return null;
    if (local && samePreviewText(actual, to)) return () => {};
    if (!samePreviewText(actual, from)) return null;
    const text = node.firstChild;
    if (typeof to === 'string' && typeof actual === 'string' && text?.nodeType === 3 && !text.nextSibling)
      return forward => { text.data = forward ? to : actual; };
    // Only text nodes and inert line breaks cross this boundary. Keep surviving BRs and
    // restore the actual children (including their identity) if another staged effect fails.
    const original = Array.from(node.childNodes), brs = Array.from(node.children), doc = node.ownerDocument;
    const next = [];
    if (typeof to === 'string') { if (to) next.push(doc.createTextNode(to)); }
    else for (const [i, line] of to.lines.entries()) {
      if (i) {
        const id = to.breaks[i-1], match = brs.findIndex(br => br.getAttribute('data-hf-id') === id);
        const br = match >= 0 ? brs.splice(match, 1)[0] : doc.createElement('br');
        if (id && match < 0) br.setAttribute('data-hf-id', id);
        next.push(br);
      }
      if (line) next.push(doc.createTextNode(line));
    }
    return forward => node.replaceChildren(...(forward ? next : original));
  }
  function stagePresentation(node, change, effects, local, pending, authored, canUpdateBox) {
    if (change.captureOriginalTranslate !== undefined) {
      const move = Array.isArray(change.styles) && change.styles.find(style => Array.isArray(style) && style[0] === 'translate');
      if (typeof change.captureOriginalTranslate !== 'boolean' || !(timingDocumentId || authored) || !move) return false;
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
    if (!presentationTags.has(node.localName) && !(node.localName === 'canvas' && isLivePositionEdit([change])) &&
        !(pending?.ordered && pending.element === node && mediaBox(change)) &&
        !(['canvas','img','video'].includes(node.localName) && (canUpdateBox || paintOnly(change)))) return false;
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
      const write = presentationTags.has(node.localName) && stageText(node, change.text, local);
      if (!write) return false;
      effects.push(write);
    }
    return true;
  }
  const isAuthoredPresentation = ${isAuthoredPresentation.toString()};
  const isLivePositionEdit = ${isLivePositionEdit.toString()};
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
    const mediaControl = m.type === 'peer-timing' && Array.isArray(m.changes) && m.changes.length &&
      m.changes.every(c => ['video','audio'].includes(c?.tag) && !c.styles && !c.text && !c.insert && !c.removeFromComposition &&
        Array.isArray(c.attributes) && c.attributes.length && c.attributes.every(a =>
          Array.isArray(a) && ['loop','data-playback-rate','data-media-start','data-playback-start'].includes(a[0])));
    const local = !temporary && (m.type === 'peer-presentation' || mediaControl) && m.localSave === true;
    const pending = local && pendingDrags.get(m.gestureId);
    const ownDrag = pending && (pending.ordered || pendingForSource(m.path)[0] === pending);
    const paintDuringDrag = !local && Array.isArray(m.changes) && m.changes.every(paintOnly) &&
      (!drag || drag.ordered) && pendingForSource(m.path).every(step => step.ordered);
    const base = ownDrag ? pending.confirmedVersion || pending.sha256 : sourceVersions[m.path];
    const measured = ownDrag && pending.ordered && Array.isArray(m.changes) && m.changes.length === 1 && mediaBox(m.changes[0]);
    const nestedBox = m.type === 'peer-presentation' && settings.smallMountedSources?.includes(m.path) &&
      Array.isArray(m.changes) && m.changes.length > 0 && m.changes.every(change => isPixelBoxChange(change));
    const nestedCaption = m.type === 'peer-presentation' && !temporary && settings.smallMountedSources?.includes(m.path) &&
      isMountedCaptionBatch(m.changes, settings.liveEdits?.position === true, !!timingDocumentId || settings.liveEdits?.cssLayoutOffset === true);
    const cssBox = (timingDocumentId || settings.liveEdits?.cssLayoutOffset === true) && m.type === 'peer-presentation' &&
      Array.isArray(m.changes) && m.changes.length > 0 && m.changes.every(change => isPixelBoxChange(change, true));
    const position = measured || nestedBox || cssBox || settings.liveEdits?.position === true && m.type === 'peer-presentation' &&
      Array.isArray(m.changes) && (isLivePositionEdit(m.changes) || m.changes.every(paintOnly));
    // An independent leaf can update verified geometry and captions without re-seeking the timeline.
    // Check again in the frame: a new pointer or caret can arrive after Studio sends a patch.
    const leaves = settings.independentSceneFiles;
    const disjoint = path => path && path !== m.path && leaves.includes(path);
    const siblingPaint = !temporary && !structureDraft && leaves?.includes(m.path) &&
      (nestedCaption || (position && m.changes.every(c => c.styles?.length && !c.text && !c.attributes.length && !c.group && !c.insert && !c.removeFromComposition))) &&
      (!drag || disjoint(drag.selection?.sourceFile)) && Array.from(pendingDrags.values()).every(step => disjoint(step.selection?.sourceFile)) &&
      (!inlineText || (disjoint(sourceFileForElement(inlineText.el)) && (!inlineText.binding || disjoint(inlineText.binding.sourceFile))));
    const media = settings.liveEdits?.mediaTiming === true && m.type === 'peer-timing' &&
      Array.isArray(m.changes) && isMediaMove(m.changes);
    // Only this mounted file may update its verified live text/style, preserving the
    // already-executed handlers. Nested scenes also need their remount cache updated.
    const authored = m.type === 'peer-presentation' && m.path === compositionPath && isAuthoredPresentation(m.changes);
    const grade = m.type === 'peer-timing' && m.path === compositionPath && Array.isArray(m.changes) &&
      m.changes.length > 0 && m.changes.every(gradeOnly);
    const target = temporary || position || nestedCaption || media || authored || grade ? styleDocumentId : timingDocumentId;
    if (!target || m.documentId !== target || (temporary ? !!timingDocumentId : !position && !nestedCaption && m.path !== compositionPath) ||
        !before || !after || before !== base ||
        !Number.isFinite(m.expiresAt) || Date.now() >= m.expiresAt ||
        (!ownDrag && !paintDuringDrag && !siblingPaint && (drag || pendingDrags.size)) ||
        (inlineText && !siblingPaint && !(local && inlineText.id === m.gestureId && inlineText.after !== undefined)) || !p || typeof p.seek !== 'function' ||
        typeof p.getTime !== 'function' || typeof window.__hfForceTimelineRebind !== 'function' ||
        !Array.isArray(m.changes)) return false;
    const sameContent = !m.changes.length && m.sameContent === true && m.type === 'peer-timing' && !!timingDocumentId;
    if (!m.changes.length && !sameContent) return false;
    const drafting = typeof m.structureDraftId === 'string';
    if (drafting && (!timingDocumentId || m.type !== 'peer-timing' || before !== after ||
        !m.structureDraftId.length || m.structureDraftId.length > 64 || !m.changes.some(c => c?.removeFromComposition || c?.insert || c?.group))) return false;
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
    // Bulk edits resolve IDs in one traversal, including duplicate IDs across source files.
    const targets = new Map();
    const bulk = m.changes.length > 8;
    const parkedSource = !local && siblingPaint && parkedPlacementSource(m.path);
    const searchRoot = parkedSource || document;
    if (bulk) {
      for (const node of searchRoot.querySelectorAll('[data-hf-id], [id], [data-composition-id]')) {
        if (sourceFileForElement(node) !== m.path) continue;
        for (const attr of ['data-hf-id', 'id', 'data-composition-id']) {
          const value = node.getAttribute(attr);
          if (!value) continue;
          const key = node.localName + ':' + attr + ':' + value;
          targets.set(key, targets.has(key) ? null : node);
        }
      }
    }
    for (const change of m.changes) {
      if (!change || (!change.hfId && !change.id && !change.compositionId) || !Array.isArray(change.attributes) ||
          (!change.attributes.length && !change.styles && !change.text && !change.removeFromComposition && !change.insert && !change.group) || change.attributes.length > previewAttributes.size) return false;
      if (change.group) {
        if (m.changes.length !== 1 || !timingDocumentId || m.type !== 'peer-timing') return false;
        const applyGroup = stageGroup(document, change.group, presentationTags);
        if (!applyGroup) return false;
        structureChanged = true;
        effects.push(applyGroup);
        continue;
      }
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
      let node;
      if (bulk) {
        const key = change.hfId ? 'data-hf-id:' + change.hfId : change.id ? 'id:' + change.id : 'data-composition-id:' + change.compositionId;
        node = targets.get(change.tag + ':' + key);
      } else {
        const matches = Array.from(searchRoot.querySelectorAll(selector)).filter(candidate =>
          candidate.localName === change.tag && sourceFileForElement(candidate) === m.path);
        if (matches.length === 1) node = matches[0];
      }
      if (!node || node.closest('[data-hf-parked-scene]')) return false;
      if (change.text && ((change.id && node.id !== change.id) ||
          (change.compositionId && node.getAttribute('data-composition-id') !== change.compositionId))) return false;
      if (measured && node !== pending.element) return false;
      if (change.removeFromComposition) {
        const parent = node.parentElement, next = node.nextSibling;
        if (structureChanged || !timingDocumentId || m.type !== 'peer-timing' || !change.hfId || !presentationTags.has(node.localName) ||
            node.id !== change.id || node.childElementCount || !node.classList.contains('clip') ||
            parent?.getAttribute('data-composition-id') !== change.removeFromComposition) return false;
        structureChanged = true;
        effects.push(forward => forward ? node.remove() : parent.insertBefore(node, next));
      }
      if (media && change.tag !== 'audio' && node !== document.querySelector('[data-composition-id]')) return false;
      if ((position || nestedCaption) && change.styles?.some(([name]) => name === 'position')) {
        if (parkedSource || node.childElementCount) return false;
        // Inline declarations alone cannot tell whether stylesheet positioning is static.
        const livePosition = getComputedStyle(node).position;
        if (livePosition !== 'static' && livePosition !== 'relative') return false;
      }
      if (!stagePresentation(node, change, effects, local, pending, authored, nestedBox || cssBox || nestedCaption)) return false;
      if ((position || nestedCaption) && !temporary) placements.push([node, selector, change]);
      for (const [name, from, to] of change.attributes) {
        if (!previewAttributes.has(name) || [from, to].some(value => !canPatchPreviewAttribute(name, value, node.localName))) return false;
        const preserved = name === 'data-duration' || name === 'data-end' ? name.replace('data-','data-hf-authored-') : null;
        const names = preserved && node.hasAttribute(preserved) ? [preserved,name] : [name];
        const control = previewControls.get(node)?.get(names[0]);
        const actual = control ? control.base : node.getAttribute(names[0]);
        if (actual !== from && !(local && mediaControl && actual === to) && !(actual && from && Number(actual) === Number(from))) return false;
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
      if (!structureChanged && !edits.some(edit => edit.attr !== 'data-timeline-locked' && edit.attr !== 'muted' && edit.attr !== 'data-color-grading')) return;
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
