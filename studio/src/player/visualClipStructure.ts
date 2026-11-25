import type { PreviewChange, VisualClipInsert } from "../../../shared/preview-timing";
import { stageVisualClipInsert } from "../../../shared/preview-visual-insert";

function declarativeClipRoot(doc: Document): Element | undefined {
  const roots = doc.querySelectorAll("[data-composition-id]");
  if (roots.length !== 1 || doc.querySelector("script,template,[data-composition-src]")) return;
  for (const node of doc.querySelectorAll("[data-start],[data-end],[data-duration]")) {
    for (const attr of ["data-start", "data-end", "data-duration"]) {
      const value = node.getAttribute(attr);
      if (value !== null && !/^\d+(?:\.\d+)?$/.test(value)) return;
    }
  }
  return roots[0];
}

/** The compiler keeps identified, direct visual leaves. Relative timings may depend on a deleted sibling. */
export function takeRemovedClip(before: Document, after: Document, nodes: Element[], tags: Set<string>): PreviewChange | null {
  const root = declarativeClipRoot(before);
  if (!root) return null;
  const ids = new Set([...after.querySelectorAll("[data-hf-id]")].map(node => node.getAttribute("data-hf-id")));
  const missing = nodes.filter(node => node.hasAttribute("data-hf-id") && !ids.has(node.getAttribute("data-hf-id")));
  const clip = missing[0];
  if (missing.length !== 1 || !clip || !tags.has(clip.localName) || clip.childElementCount ||
      !clip.classList.contains("clip") || clip.parentElement !== root) return null;
  const owner = root.getAttribute("data-composition-id");
  if (!owner) return null;
  clip.remove();
  nodes.splice(nodes.indexOf(clip), 1);
  return { hfId: clip.getAttribute("data-hf-id"), id: clip.id, compositionId: null,
    tag: clip.localName, attributes: [], removeFromComposition: owner };
}

/** Remove the inserted leaf from the comparison copy, preserving the exact whitespace on both sides. */
export function takeInsertedClip(before: Document, after: Document, nodes: Element[], tags: Set<string>): PreviewChange | null {
  const existing = new Set([...before.querySelectorAll("[data-hf-id]")].map(node => node.getAttribute("data-hf-id")));
  const added = nodes.filter(node => node.hasAttribute("data-hf-id") && !existing.has(node.getAttribute("data-hf-id")));
  const clip = added[0];
  if (added.length !== 1 || !clip || !clip.id || !tags.has(clip.localName) ||
      [...clip.childNodes].some(child => child.nodeType !== 3)) return null;
  const root = declarativeClipRoot(after);
  const owner = root?.getAttribute("data-composition-id");
  if (!owner || !root || clip.parentElement !== root) return null;
  const next = clip.nextElementSibling?.getAttribute("data-hf-id") ?? null;
  if (clip.nextElementSibling && !next) return null;
  const oldRoot = before.querySelector("[data-composition-id]");
  const oldNext = next && [...(oldRoot?.children ?? [])].find(node => node.getAttribute("data-hf-id") === next);
  if (!oldRoot || (next && !oldNext)) return null;
  const preceding = oldNext ? oldNext.previousSibling : oldRoot.lastChild;
  const whitespace = (node: ChildNode | null) => node?.nodeType === 3 ? node.textContent ?? "" : "";
  const insert: VisualClipInsert = { owner, next, whitespace: [whitespace(preceding), whitespace(clip.previousSibling), whitespace(clip.nextSibling)],
    text: clip.textContent ?? "", attrs: [...clip.attributes].filter(attr => attr.name !== "id" && attr.name !== "data-hf-id")
      .map(attr => [attr.name, attr.value]) };
  const change = { hfId: clip.getAttribute("data-hf-id"), id: clip.id, compositionId: null, tag: clip.localName, attributes: [], insert };
  if (!stageVisualClipInsert(before, change, tags)) return null;
  const anchor = clip.nextElementSibling;
  const [old, left, right] = insert.whitespace;
  if (left) clip.previousSibling?.remove();
  if (right) clip.nextSibling?.remove();
  clip.remove();
  if (old) root.insertBefore(after.createTextNode(old), anchor);
  nodes.splice(nodes.indexOf(clip), 1);
  return change;
}
