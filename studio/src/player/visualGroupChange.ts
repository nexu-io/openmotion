import { indexGroupMembers, type GroupChange, type GroupMemberBox } from "../../../shared/preview-group";
import type { PreviewChange } from "../../../shared/preview-timing";

function box(node: HTMLElement): GroupMemberBox {
  return { left: node.style.left, top: node.style.top, track: node.getAttribute("data-track-index") };
}

function stripBox(node: HTMLElement) {
  node.style.removeProperty("left");
  node.style.removeProperty("top");
  node.removeAttribute("data-track-index");
  const style = node.style.cssText;
  if (style) node.setAttribute("style", style); else node.removeAttribute("style");
}

/** Recognize the core's wrap/unwrap by proving both the members and the rest of the source match. */
export function diffGroupChange(before: Document, after: Document, wrap: boolean, tags: Set<string>): PreviewChange | null {
  const flat = wrap ? before : after;
  const nested = wrap ? after : before;
  if ([flat, nested].some(doc => doc.querySelector("template,[data-composition-src]") || doc.querySelectorAll("[data-composition-id]").length !== 1)) return null;
  const candidates = [...nested.querySelectorAll<HTMLElement>("div[data-hf-group][id]")].filter(n => !flat.getElementById(n.id));
  if (candidates.length !== 1) return null;
  const wrapper = candidates[0]!;
  const parent = flat.querySelector("[data-composition-id]")!;
  const owner = parent.getAttribute("data-composition-id");
  if (!owner || wrapper.parentElement?.getAttribute("data-composition-id") !== owner || wrapper.children.length < 2 ||
      [...wrapper.attributes].some(a => !["id","data-hf-group","data-hf-id","style"].includes(a.name)) ||
      [...wrapper.childNodes].some(n => n.nodeType !== 1)) return null;
  const members: GroupChange["members"] = [];
  const flatNodes: HTMLElement[] = [];
  const children = indexGroupMembers(parent);
  for (const element of wrapper.children) {
    const child = element as HTMLElement;
    const hfId = child.getAttribute("data-hf-id");
    const other = hfId && children.get(hfId);
    if (!hfId || !other || !tags.has(child.localName) || child.childElementCount) return null;
    if (flatNodes.length && flatNodes.at(-1)!.nextElementSibling !== other) return null;
    const left = wrap ? other : child, right = wrap ? child : other;
    members.push({hfId, id: child.id, tag: child.localName, before: box(left), after: box(right)});
    const a = left.cloneNode(true) as HTMLElement, b = right.cloneNode(true) as HTMLElement;
    stripBox(a); stripBox(b);
    if (!a.isEqualNode(b)) return null;
    flatNodes.push(other);
  }
  const group: GroupChange = {wrap, owner, wrapper: {id: wrapper.id, hfId:wrapper.getAttribute("data-hf-id"), label:wrapper.dataset.hfGroup!, style:wrapper.getAttribute("style") ?? ""}, members};
  // Outside the affected run even a changed selector or sibling must take the normal reconciliation path.
  wrapper.replaceWith(nested.createComment("group"));
  parent.insertBefore(flat.createComment("group"), flatNodes.at(-1)!);
  flatNodes.forEach(n => n.remove());
  before.normalize(); after.normalize();
  if (!before.documentElement.isEqualNode(after.documentElement)) return null;
  return {tag:"div", id:group.wrapper.id, hfId:group.wrapper.hfId, compositionId:null, attributes:[], group};
}
