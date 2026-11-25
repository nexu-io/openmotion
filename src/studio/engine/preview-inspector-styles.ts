// Visual feedback in the mounted frame while Studio saves an inspector edit.
// Pending changes on a single property share its original value, so any order
// of success or failure leaves the latest successful edit on screen.
import { createStyleDrafts, findBlockColorRule } from '../../../shared/preview-style-draft.ts';

export const PREVIEW_INSPECTOR_STYLES = `
  const showStyleDraft = (${createStyleDrafts.toString()})();
  const blockColorRule = ${findBlockColorRule.toString()};
  const pendingInspectorStyles = new Map();
  const visibleStyleNames = new Set(['color','background-color','font-size','font-weight','text-align','opacity']);
  function showInspectorStyle(el, name, value) {
    if (!visibleStyleNames.has(name) || typeof value !== 'string' || value.length > 256 ||
        (value && !CSS.supports(name, value)) || el.style.getPropertyPriority(name)) return null;
    return showStyleDraft(el.style, name, value);
  }
  function previewInspectorStyles(m) {
    if (typeof m.editId !== 'string' || m.editId.length > 80) return;
    if (m.phase === 'settle') {
      const pending = pendingInspectorStyles.get(m.editId);
      pendingInspectorStyles.delete(m.editId);
      if (pending) pending.forEach(finish => finish(m.saved === true));
      return;
    }
    if (m.phase !== 'show' || pendingInspectorStyles.has(m.editId) || typeof m.sourceFile !== 'string' ||
        !Object.hasOwn(sourceVersions, m.sourceFile) || sourceIdentity(sourceVersions[m.sourceFile]).fileVersion !== m.fileVersion) return;
    if (m.blockColor) {
      const { key, value } = m.blockColor;
      const rule = blockColorRule(document, m.sourceFile, key, value, compositionPath);
      const finish = rule && showStyleDraft(rule, key, value);
      if (finish) pendingInspectorStyles.set(m.editId, [finish]);
      return;
    }
    if (!Array.isArray(m.styles) || m.styles.length > 32) return;
    const el = inspectorElement(m);
    if (!el || el.closest('[data-hf-parked-scene]')) return;
    const pending = m.styles.filter(pair => Array.isArray(pair) && pair.length === 2)
      .map(([name, value]) => showInspectorStyle(el, name, value)).filter(Boolean);
    if (pending.length) pendingInspectorStyles.set(m.editId, pending);
  }
`;
