import { createPreviewAdapter } from "../player/lib/previewAdapter";
import { diffPreviewChanges } from "../player/peerTimingPreview";
import type { RecordEditInput } from "../utils/studioFileHistory";

const attr = "data-color-grading";

function setGrade(node: Element, value: string | null) {
  if (value === null) node.removeAttribute(attr);
  else node.setAttribute(attr, value);
}

/** Stage the same attribute observed by the grading runtime. Unaddressable DOM falls back on receipt. */
export function projectColorGrade(frame: HTMLIFrameElement, activePath: string, files: RecordEditInput["files"]) {
  const doc = frame.contentDocument;
  const gesture = crypto.randomUUID();
  const adapter = createPreviewAdapter({ iframe: frame });
  let complete = true;
  const changes = Object.entries(files).flatMap(([sourceFile, file]) => {
    if (file.before === file.after) return [];
    const diff = diffPreviewChanges(file.before, file.after);
    if (!diff) complete = false;
    return (diff ?? []).flatMap(change => change.attributes.filter(([name]) => name === attr)
      .map(([, before, value]) => ({ sourceFile, hfId: change.hfId, elementId: change.id, before, value })));
  });
  const bridge = (settled: boolean, saved = true) => {
    if (changes.length) adapter.send("timeline-controls", { attr, gesture, changes: changes.map(change => ({
      ...change, settled, value: saved ? change.value : change.before,
    })) });
  };
  const painted: { node: Element; before: string | null; value: string | null }[] = [];
  if (doc) {
    const identity = (path: string, hfId: string | null, id: string) => JSON.stringify([path, hfId || id]);
    const byId = new Map(changes.map(c => [identity(c.sourceFile, c.hfId, c.elementId), c]));
    const matched = new Set<(typeof changes)[number]>();
    for (const node of doc.querySelectorAll("img, video")) {
      const owner = node.parentElement?.closest("[data-composition-file],[data-composition-src]");
      const path = owner?.getAttribute("data-composition-file") ?? owner?.getAttribute("data-composition-src") ?? activePath;
      const change = byId.get(identity(path, node.getAttribute("data-hf-id"), node.id)) ?? byId.get(identity(path, null, node.id));
      if (!change || node.getAttribute(attr) !== change.before) continue;
      matched.add(change);
      painted.push({ node, before: change.before, value: change.value });
      setGrade(node, change.value);
    }
    complete &&= matched.size === changes.length;
  } else bridge(false);
  return { complete, settle(saved: boolean) {
    if (!doc) bridge(true, saved);
    else if (!saved) for (const { node, before, value } of painted) {
      if (node.getAttribute(attr) === value) setGrade(node, before);
    }
  } };
}
