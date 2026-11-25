import type { PatchTarget } from "./sourcePatcher";
import { ensureHfIds, isCompositionTemplate } from "@hyperframes/parsers/hf-ids";
import {
  PREVIEW_ONLY_ATTRS,
  STUDIO_PREVIEW_LAZY_ATTR,
} from "@hyperframes/core/studio-preview-mark";

// Stamped as the preview stamps the files it serves, so a live element's hf-id finds its source.
export function parseSavedSource(html: string): Document {
  return new DOMParser().parseFromString(ensureHfIds(html), "text/html");
}

const rootsByDoc = new WeakMap<Document, ParentNode[]>();

// A plain template is a runtime clone source, so ids inside it repeat across clones.
function searchRoots(root: ParentNode): ParentNode[] {
  const templates = Array.from(root.querySelectorAll("template")).filter(isCompositionTemplate);
  return [root, ...templates.flatMap((template) => searchRoots(template.content))];
}

function findByAttribute(doc: Document, name: string, value: string): Element | null {
  let roots = rootsByDoc.get(doc);
  if (!roots) rootsByDoc.set(doc, (roots = searchRoots(doc)));
  const selector = `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
  for (const root of roots) {
    const match = root.querySelector(selector);
    if (match) return match;
  }
  return null;
}

export type AuthoredIdentity = Pick<PatchTarget, "id" | "hfId">;

/** Look up the stable identity in the owning source file, including composition templates.
 *  When an explicit DOM id is present, never fall back via a stale data-hf-id to a sibling
 *  element if that DOM id was removed from the saved source. */
export function findAuthoredIdentity(doc: Document, { id, hfId }: AuthoredIdentity): Element | null {
  if (id) return findByAttribute(doc, "id", id);
  return hfId ? findByAttribute(doc, "data-hf-id", hfId) : null;
}

export function findAuthoredElement(doc: Document, live: Element): Element | null {
  const hfId = live.getAttribute("data-hf-id");
  if (hfId) return findByAttribute(doc, "data-hf-id", hfId);
  return live.id ? findByAttribute(doc, "id", live.id) : null;
}

export { authoredMarkup } from "../../../packages/edit-core/clipboard-paths";

export function liveMarkupWithoutPreviewMarks(live: Element): string {
  const copy = live.cloneNode(true) as Element;
  for (const el of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
    if (el.hasAttribute(STUDIO_PREVIEW_LAZY_ATTR)) el.removeAttribute("loading");
    for (const attr of PREVIEW_ONLY_ATTRS) el.removeAttribute(attr);
  }
  return copy.outerHTML;
}
