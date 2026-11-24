import { isolatedSourceVersion, type IsolatedSourceTarget } from "./isolatedSourceTarget";

type Watch = { target: IsolatedSourceTarget; removed(): void };
const gestures = new WeakMap<HTMLIFrameElement, Set<Watch>>();

/** A finished gesture remains observable until its save is acknowledged or rejected. */
export function watchCanvasTarget(frame: HTMLIFrameElement, target: IsolatedSourceTarget, removed: () => void) {
  const watches = gestures.get(frame) ?? new Set<Watch>();
  gestures.set(frame, watches);
  const watch = { target, removed };
  watches.add(watch);
  return () => watches.delete(watch);
}

export function watchedCanvasTargets(frame: HTMLIFrameElement, path: string) {
  return Array.from(gestures.get(frame) ?? []).filter(({ target }) => target.sourceFile === path);
}

function sourceIds(content: string) {
  const ids = new Set<string>();
  const visit = (root: Document | DocumentFragment) => {
    for (const node of root.querySelectorAll("[id], [data-hf-id], template")) {
      if (node.id) ids.add("#" + node.id);
      const hf = node.getAttribute("data-hf-id");
      if (hf) ids.add("hf:" + hf);
      if (node instanceof HTMLTemplateElement) visit(node.content);
    }
  };
  visit(new DOMParser().parseFromString(content, "text/html"));
  return ids;
}

/** Cancel only a target that existed in its displayed version and disappeared from the confirmed file. */
export async function cancelRemovedCanvasTargets(
  frame: HTMLIFrameElement, watches: Watch[], content: string, readBase: (version: string) => Promise<string | undefined>,
) {
  if (!watches.length) return;
  const current = sourceIds(content);
  const bases = new Map<string, Set<string>>();
  for (const watch of watches) {
    const { target } = watch;
    const keys = [target.elementId && "#" + target.elementId, target.hfId && "hf:" + target.hfId].filter((key): key is string => !!key);
    if (keys.some(key => current.has(key))) continue;
    const version = isolatedSourceVersion(target);
    let base = bases.get(version);
    if (!base) {
      const original = await readBase(version);
      if (original === undefined) continue;
      base = sourceIds(original);
      bases.set(version, base);
    }
    if (keys.some(key => base.has(key)) && gestures.get(frame)?.has(watch)) watch.removed();
  }
}
