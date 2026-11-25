import type { PreviewChange } from './preview-timing.ts';

/** This function is also embedded in the isolated preview. It only prepares detached nodes. */
export function stageVisualClipInsert(document: Document, change: PreviewChange, tags: Set<string>) {
  const insert = change.insert;
  if (!insert || !change.hfId || !change.id || !tags.has(change.tag) || change.compositionId ||
      change.attributes.length || change.styles || change.text || change.removeFromComposition ||
      typeof insert.text !== 'string' || insert.text.length > 4096 ||
      !Array.isArray(insert.attrs) || insert.attrs.length > 8 ||
      !Array.isArray(insert.whitespace) || insert.whitespace.length !== 3 ||
      insert.whitespace.some(s => typeof s !== 'string' || s.length > 256 || !/^[\t\n\r ]*$/.test(s))) return null;
  const owners = document.querySelectorAll('[data-composition-id]');
  const parent = owners[0];
  if (owners.length !== 1 || !parent || parent.getAttribute('data-composition-id') !== insert.owner ||
      document.getElementById(change.id) || document.querySelector('[data-hf-id="'+CSS.escape(change.hfId)+'"]')) return null;
  const anchors = insert.next === null ? [] : [...parent.children].filter(node => node.getAttribute('data-hf-id') === insert.next);
  if (insert.next !== null && anchors.length !== 1) return null;
  const next = anchors[0] ?? null;
  const adjacent = next ? next.previousSibling : parent.lastChild;
  const oldSpace = adjacent?.nodeType === 3 ? adjacent : null;
  const [before, left, right] = insert.whitespace;
  if ((oldSpace?.textContent ?? '') !== before) return null;

  const node = document.createElement(change.tag);
  for (const entry of insert.attrs) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [name, value] = entry;
    if (typeof name !== 'string' || typeof value !== 'string' || value.length > 4096 || node.hasAttribute(name)) return null;
    if (name === 'class') {
      if (!value.split(/\s+/).includes('clip')) return null;
    } else if (name === 'style') {
      // Mutable leaf styles contain only simple layout, color and text declarations.
      // URL-bearing values, escaped CSS and custom properties go through the regular bundler.
      for (const declaration of value.split(';')) {
        if (!declaration.trim()) continue;
        const colon = declaration.indexOf(':');
        const property = declaration.slice(0, colon).trim();
        const css = declaration.slice(colon + 1).trim();
        if (colon < 1 || !/^(?:position|left|top|right|bottom|width|height|z-index|background(?:-color)?|color|opacity|font-size|font-weight|font-family|text-align)$/.test(property)) return null;
        const simple = css.replace(/(?:rgb|hsl)a?\([\d\s.,%/+\-]+\)/gi, '');
        if (!/^[\w\s#.,%'"-]*$/.test(simple)) return null;
      }
    } else if (name === 'data-track-index') {
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
    } else if (name === 'data-start' || name === 'data-duration' || name === 'data-end') {
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) return null;
    } else return null;
    node.setAttribute(name, value);
  }
  if (!node.classList.contains('clip') || !node.hasAttribute('data-start') || !node.hasAttribute('data-duration')) return null;
  node.id = change.id;
  node.setAttribute('data-hf-id', change.hfId);
  node.textContent = insert.text;
  const newNodes: Node[] = [node];
  if (left) newNodes.unshift(document.createTextNode(left));
  if (right) newNodes.push(document.createTextNode(right));
  return (forward: boolean) => {
    if (forward) {
      oldSpace?.remove();
      for (const child of newNodes) parent.insertBefore(child, next);
    } else {
      for (const child of newNodes) if (child.parentNode === parent) parent.removeChild(child);
      if (oldSpace) parent.insertBefore(oldSpace, next);
    }
  };
}
