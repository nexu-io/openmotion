/** A scripted scene shows its initial layout until the player binds its timelines and seeks. */
export function needsPreparedSceneSwap(
  live: Document, incoming: Document, before: Record<string, string>, after: Record<string, string>,
): boolean {
  const visible = new Set<string>();
  for (const host of Array.from(live.querySelectorAll<HTMLElement>("[data-hf-scene][data-composition-file]"))) {
    const scene = host.getAttribute("data-hf-scene");
    if (!scene) continue;
    let ancestor: HTMLElement | null = host;
    let changed = false;
    for (; ancestor; ancestor = ancestor.parentElement) {
      // A shader can reveal a mounted clip. Its marker alone does not mean it is hidden.
      if (ancestor.matches("[data-hf-parked-scene],[hidden]") ||
          (ancestor.hasAttribute("data-hf-clip-hidden") && ancestor.style.visibility === "hidden")) break;
      const owner = ancestor.getAttribute("data-hf-scene");
      if (owner && before[owner] !== after[owner]) changed = true;
    }
    if (!ancestor && changed) visible.add(scene);
  }
  if (!visible.size) return false;
  for (const doc of [live, incoming]) {
    for (const script of Array.from(doc.querySelectorAll("script"))) {
      const scene = script.closest("[data-hf-scene]")?.getAttribute("data-hf-scene");
      if (!scene || !visible.has(scene) || !(script.hasAttribute("src") || script.textContent?.trim())) continue;
      const type = script.getAttribute("type")?.trim().toLowerCase() || "";
      if (!type || type === "module" || type === "text/hf-after-fonts" ||
          /^(?:application|text)\/(?:x-)?(?:java|ecma)script$/.test(type)) return true;
    }
  }
  return false;
}
