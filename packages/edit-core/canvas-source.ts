import { walkCompositionDescendants } from "@hyperframes/parsers/hf-ids";
import {
  dedupeClonedCompositionId,
  findTargetElement,
  nextUniqueId,
  parseSourceDocument,
  unwrapElementsFromHtml,
  wrapElementsInHtml,
  type PatchOperation,
  type SourceMutationTarget,
  type UnwrapChildTrack,
} from "@hyperframes/studio-server/source-mutation";
import {
  bakeGroupTransformIntoMembers,
  copyGsapAnimationsForSelector,
  stripGsapAnimationsForSelector,
} from "./gsap-mutations.ts";

function requireCanvasTarget(target: SourceMutationTarget): void {
  if (
    ![target?.hfId, target?.id, target?.selector].some((value) => typeof value === "string" && value.trim())
  ) {
    throw new Error("Choose a canvas element by id, hfId or selector.");
  }
}

export function checkCanvasTargets(
  source: string,
  targets: SourceMutationTarget[],
  options: {
    requireAll?: boolean;
    subtree?: boolean;
    operations?: PatchOperation[];
  } = {},
): void {
  for (const target of targets) requireCanvasTarget(target);
  // Inline compositions can reuse bare hf IDs. The legacy patcher resolves bare IDs first.
  const candidates = new Set(
    targets.flatMap(({ hfId }) => (hfId && source.indexOf(hfId) !== source.lastIndexOf(hfId) ? [hfId] : [])),
  );
  if (!options.requireAll && !candidates.size && !/data-timeline-locked/i.test(source)) return;
  const { document } = parseSourceDocument(source);
  if (candidates.size) {
    const seen = new Set<string>();
    walkCompositionDescendants(document, (el) => {
      const id = el.getAttribute("data-hf-id");
      if (!id || !candidates.has(id)) return;
      if (seen.has(id))
        throw new Error("Ambiguous hfId in this file. Specify a selector within the intended composition.");
      seen.add(id);
    });
  }

  for (const target of targets) {
    const el = findTargetElement(document, target);
    if (!el && options.requireAll) throw new Error("Canvas element was not found.");
    for (const op of options.operations ?? []) {
      const child = op.childSelector ? el?.querySelectorAll(op.childSelector)[op.childIndex ?? 0] : el;
      if (
        child?.closest("[data-timeline-locked]") ||
        ((op.type === "rich-text" || op.type === "text-content") &&
          child?.querySelector("[data-timeline-locked]"))
      )
        throw new Error("Unlock the affected layer before editing.");
    }
    if (
      el?.closest("[data-timeline-locked]") ||
      (options.subtree && el?.querySelector("[data-timeline-locked]"))
    ) {
      throw new Error("Unlock the affected layer before editing.");
    }
  }
}

export function groupCanvasElements(...args: Parameters<typeof wrapElementsInHtml>) {
  const [source, targets] = args;
  checkCanvasTargets(source, targets, { requireAll: true, subtree: true });
  return wrapElementsInHtml(...args);
}

export function isStudioFontFaceCss(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8192) return false;
  if (!/^@font-face\s*\{[\s\S]*\}$/.test(trimmed)) return false;
  if (/<\/style/i.test(trimmed)) return false;
  const openCount = (trimmed.match(/\{/g) ?? []).length;
  const closeCount = (trimmed.match(/\}/g) ?? []).length;
  return openCount === 1 && closeCount === 1;
}

export function ensureStudioFontFaceCss(html: string, fontFaceCss: string): string {
  if (html.includes(fontFaceCss.trim())) return html;
  const { document } = parseSourceDocument(html);
  const head = document.head;
  if (!head) return html;
  let styleEl = head.querySelector('style[data-hf-studio-fonts="true"]');
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-hf-studio-fonts", "true");
    head.appendChild(styleEl);
  }
  const existing = (styleEl.textContent || "").trim();
  styleEl.textContent = existing ? `${existing}\n${fontFaceCss.trim()}` : fontFaceCss.trim();
  return document.toString();
}

/**
 * Pure in-memory element duplication: clones the target element, assigns a unique ID,
 * dedupes any nested `data-composition-id`, and copies GSAP animations when an ID is present.
 */
export function duplicateElementInHtml(
  source: string,
  target: SourceMutationTarget,
  options: {
    newId?: string;
    takenIds?: ReadonlySet<string>;
    delta?: number;
  } = {},
): { html: string; matched: boolean; clonedId: string | null } {
  checkCanvasTargets(source, [target], { subtree: true });
  const { document, wrappedFragment } = parseSourceDocument(source);
  const el = findTargetElement(document, target);
  if (!el || !el.parentElement) {
    return { html: source, matched: false, clonedId: null };
  }
  const originalId = el.getAttribute("id");
  const clone = el.cloneNode(true) as Element;
  clone.removeAttribute("data-hf-id");
  for (const desc of Array.from(clone.querySelectorAll("[data-hf-id]"))) {
    desc.removeAttribute("data-hf-id");
  }
  dedupeClonedCompositionId(document, clone);

  let clonedId: string | null = null;
  const baseId = options.newId || (originalId ? `${originalId}-copy` : null);
  if (baseId) {
    clonedId = nextUniqueId(document, baseId, options.takenIds);
    clone.setAttribute("id", clonedId);
  } else {
    clone.removeAttribute("id");
  }
  el.after(clone);

  let out = wrappedFragment ? document.body.innerHTML : document.toString();
  if (originalId && clonedId) {
    out = copyGsapAnimationsForSelector(out, `#${originalId}`, `#${clonedId}`, options.delta ?? 0);
  }
  return { html: out, matched: true, clonedId };
}

/**
 * Pure in-memory unwrap + group transform bake + group GSAP cleanup.
 */
export function unwrapGroupWithGsapCleanup(
  source: string,
  groupTarget: SourceMutationTarget,
  childTracks?: UnwrapChildTrack[],
): { html: string; unwrapped: boolean; changed: boolean; memberIds?: string[] } {
  checkCanvasTargets(source, [groupTarget], { subtree: true });
  const result = unwrapElementsFromHtml(source, groupTarget, childTracks);
  if (!result.unwrapped) {
    return { html: source, unwrapped: false, changed: false };
  }
  let cleaned = result.html;
  if (result.unwrappedGroupId && result.members && result.groupCenter) {
    cleaned = bakeGroupTransformIntoMembers(
      cleaned,
      result.unwrappedGroupId,
      result.members,
      result.groupCenter,
    );
  }
  if (result.unwrappedGroupId) {
    cleaned = stripGsapAnimationsForSelector(cleaned, `#${result.unwrappedGroupId}`);
  }
  return { html: cleaned, unwrapped: true, changed: cleaned !== source, memberIds: result.members?.map(member => member.id) };
}
