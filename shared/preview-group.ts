export type GroupMemberBox = { left: string; top: string; track: string | null };
export type GroupChange = {
  wrap: boolean;
  owner: string;
  wrapper: { id: string; hfId: string | null; label: string; style: string };
  members: { id: string; hfId: string; tag: string; before: GroupMemberBox; after: GroupMemberBox }[];
};

/** A duplicate authored ID cannot identify a group member unambiguously. */
export function indexGroupMembers(parent: Element) {
  const nodes = new Map<string, HTMLElement | null>();
  for (const node of parent.children) {
    const id = node.getAttribute("data-hf-id");
    if (id) nodes.set(id, nodes.has(id) ? null : node as HTMLElement);
  }
  return nodes;
}

/** Pure staging for an already-certified source change. Keep the mounted children, including their references. */
export function stageGroupChange(doc: Document, change: GroupChange, tags: Set<string>) {
  const { wrap, owner, wrapper, members } = change;
  if (typeof wrap !== "boolean" || !owner || !wrapper?.id || !wrapper.label || !Array.isArray(members) ||
      members.length < 2 || new Set(members.map(m => m.hfId)).size !== members.length) return null;
  const roots = [...doc.querySelectorAll<HTMLElement>("[data-composition-id]")].filter(n => n.dataset.compositionId === owner);
  if (roots.length !== 1) return null;
  const parent = roots[0]!;
  const wrappers = [...doc.querySelectorAll<HTMLElement>("[id]")].filter(n => n.id === wrapper.id);
  if (wrappers.length !== (wrap ? 0 : 1)) return null;
  const group = wrap ? doc.createElement("div") : wrappers[0]!;
  if (!wrap && (group.parentElement !== parent || group.localName !== "div" || group.dataset.hfGroup !== wrapper.label ||
      (wrapper.hfId && group.dataset.hfId !== wrapper.hfId) || group.children.length !== members.length)) return null;
  if (wrap) {
    group.id = wrapper.id;
    group.setAttribute("data-hf-group", wrapper.label);
    if (wrapper.hfId) group.setAttribute("data-hf-id", wrapper.hfId);
    for (const declaration of wrapper.style.split(";")) {
      if (!declaration.trim()) continue;
      const match = /^\s*(position|left|top|width|height|z-index)\s*:\s*([^:;]+?)\s*$/.exec(declaration);
      if (!match) return null;
      const [, name, value] = match;
      if (name === "position" ? value !== "absolute" : name === "z-index" ? !/^-?\d+$/.test(value!) : !/^-?(?:\d+\.?\d*|\.\d+)px$/.test(value!)) return null;
      group.style.setProperty(name!, value!);
    }
    if (group.style.position !== "absolute") return null;
  }

  const origin = wrap ? parent : group;
  const children = indexGroupMembers(origin);
  const nodes: HTMLElement[] = [];
  for (const member of members) {
    if (!tags.has(member.tag) || !member.hfId || !member.before || !member.after) return null;
    const node = children.get(member.hfId);
    if (!node || node.localName !== member.tag || node.id !== member.id || node.childElementCount ||
        nodes.length && nodes.at(-1)!.nextElementSibling !== node) return null;
    for (const name of ["left", "top"] as const) {
      if (node.style[name] !== member.before[name] || node.style.getPropertyPriority(name) ||
          ![member.before[name], member.after[name]].every(v => typeof v === "string" && (v === "" || /^-?(?:\d+\.?\d*|\.\d+)px$/.test(v)))) return null;
    }
    if (node.getAttribute("data-track-index") !== member.before.track ||
        ![member.before.track, member.after.track].every(v => v === null || /^\d+$/.test(v))) return null;
    nodes.push(node);
  }
  const anchors = nodes.map(n => n.nextSibling);
  const groupNext = group.nextSibling;
  const applyBox = (node: HTMLElement, box: GroupMemberBox) => {
    node.style.left = box.left;
    node.style.top = box.top;
    if (box.track === null) node.removeAttribute("data-track-index"); else node.setAttribute("data-track-index", box.track);
  };
  return (forward: boolean) => {
    if (forward) {
      if (wrap) parent.insertBefore(group, nodes.at(-1)!);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        applyBox(node, members[i]!.after);
        if (wrap) group.appendChild(node); else parent.insertBefore(node, group);
      }
      if (!wrap) group.remove();
    } else {
      if (!wrap) parent.insertBefore(group, groupNext);
      for (let i = nodes.length - 1; i >= 0; i--) {
        applyBox(nodes[i]!, members[i]!.before);
        origin.insertBefore(nodes[i]!, anchors[i] ?? null);
      }
      if (wrap) group.remove();
    }
  };
}
