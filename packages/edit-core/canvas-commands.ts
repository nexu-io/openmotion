import { deleteCanvasSelection } from "./element-deletion.ts";
import { planArcDrag } from "./arc-drag.ts";
import { applyPatchByTarget, readTagAttribute, readTagSnippetByTarget, replaceTagStyle, uniqueAuthoredHfTag } from "./source-patcher.ts";
import { parseHTMLContent } from "@hyperframes/core/compiler/html-document";
import { resolveTweenStart, resolveTweenDuration } from "./playhead-edit.ts";
import { canvasBoxOperations } from "./canvas-box.ts";
import {
  findTargetElement,
  isHTMLElement,
  parseSourceDocument,
  patchElementInHtml,
} from "@hyperframes/studio-server/source-mutation";
import { findUnsafeDomPatchValues } from "@hyperframes/studio-server/finite-mutation";
import {
  parseGsapAnimationsFromHtml,
  applyGsapMutationsInMemory,
  validateGsapMutationPayload,
} from "./gsap-mutations.ts";
import {
  checkCanvasTargets,
  groupCanvasElements,
  duplicateElementInHtml,
  ensureStudioFontFaceCss,
  isStudioFontFaceCss,
  unwrapGroupWithGsapCleanup,
} from "./canvas-source.ts";
import { authoredLayerBox, writePlainMove } from "./canvas-position.ts";
import type { CanvasCommand, CanvasElementPatch } from "./canvas-schema.ts";
export type { CanvasCommand } from "./canvas-schema.ts";

// Direct edits to an authored tag should preserve every byte outside it. Use the
// same SDK to resolve the target and to serialize the modified attribute or text.
function patchAuthoredElement(source: string, patch: CanvasElementPatch) {
  const hfId = patch.target.hfId;
  if (!hfId || patch.operations.some(op => op.childSelector !== undefined)) return;
  const plainText = patch.operations.length === 1 && patch.operations[0]!.type === "text-content";
  if (!plainText && !patch.operations.every(op => op.type === "inline-style")) return;
  const opening = uniqueAuthoredHfTag(source, hfId);
  if (!opening || opening.tag.endsWith("/") || opening.tag.includes("&")) return;
  const element = findTargetElement(parseHTMLContent(source), patch.target);
  if (!element || !isHTMLElement(element) || element.getAttribute("data-hf-id") !== hfId) return;
  if (plainText) {
    const name = element.localName;
    if (!/^(?:h[1-6]|p|span|div|strong|em|i|b|li|blockquote)$/.test(name) || element.childElementCount) return;
    const start = opening.end + 1;
    const end = source.indexOf("<", start);
    const close = "</" + name + ">";
    if (end < 0 || source.slice(end, end + close.length).toLowerCase() !== close) return;
    const previous = source.slice(start, end);
    if (previous !== element.innerHTML && previous !== element.textContent) return;
    const fragment = source.slice(opening.start, end + close.length);
    const result = patchElementInHtml(fragment, { hfId }, patch.operations);
    if (!result.matched) return;
    const edited = findTargetElement(parseHTMLContent(result.html), { hfId });
    if (!edited || Array.from(edited.childNodes).some(node => node.nodeType !== 3)) return;
    if (edited.textContent === element.textContent) return { ...result, html: source };
    const html = source.slice(0, start) + edited.innerHTML + source.slice(end);
    return { ...result, html };
  }
  const fragment = opening.tag + ">";
  const result = patchElementInHtml(fragment, { hfId }, patch.operations);
  if (!result.matched) return;
  if (result.html === fragment) return { ...result, html: source };
  const tag = readTagSnippetByTarget(result.html, { hfId });
  const style = tag && readTagAttribute(tag, "style");
  if (style === undefined) return;
  // All project writers stamp new IDs at commit. This operation only replaces the style attribute.
  return { ...result, html: replaceTagStyle(source, opening, style) };
}

export function patchCanvasElement(
  source: string,
  patch: CanvasElementPatch,
  takenIds?: ReadonlySet<string>,
) {
  checkCanvasTargets(source, [patch.target], { operations: patch.operations });
  if (findUnsafeDomPatchValues({ operations: patch.operations }).length) throw new Error("Invalid layout value.");
  const result = patchAuthoredElement(source, patch) ?? patchElementInHtml(source, patch.target, patch.operations, takenIds);
  // The SDK DOM patcher accepts HTML nodes. SVG presentation styles use the same authored-tag writer as Studio.
  if (
    !result.matched &&
    patch.target.hfId &&
    patch.operations.every((op) => op.type === "inline-style" && !op.childSelector)
  ) {
    const el = findTargetElement(parseSourceDocument(source).document, patch.target);
    if (el?.namespaceURI === "http://www.w3.org/2000/svg") {
      result.html = patch.operations.reduce(
        (html, op) =>
          applyPatchByTarget(html, patch.target, {
            ...op,
            type: "inline-style",
          }),
        source,
      );
      result.matched = true;
    }
  }
  if (patch.fontFaceCss !== undefined) {
    if (!isStudioFontFaceCss(patch.fontFaceCss)) throw new Error("Invalid imported font CSS.");
    if (result.matched) result.html = ensureStudioFontFaceCss(result.html, patch.fontFaceCss);
  }
  return result;
}

export function applyCanvasCommand(source: string, command: CanvasCommand): string {
  switch (command.kind) {
    case "setCanvasBox":
      return applyCanvasCommand(source, {
        kind: "editElements",
        patches: [
          {
            target: command.target,
            operations: canvasBoxOperations(command.box),
          },
        ],
      });
    case "editElements": {
      let html = source;
      for (const patch of command.patches) {
        const result = patchCanvasElement(html, patch);
        if (!result.matched) throw new Error("Canvas element or child was not found.");
        html = result.html;
      }
      return html;
    }
    case "moveCanvasElement": {
      checkCanvasTargets(source, [command.target]);
      const delta = command.delta;
      const point = { x: delta?.x ?? command.x!, y: delta?.y ?? command.y! };
      if (
        delta &&
        (command.x !== undefined || command.y !== undefined || String(command.mode) === "playhead")
      )
        throw new Error("Choose either an absolute playhead position or a whole-path delta.");
      if (command.mode === "wholePath" && !delta) throw new Error("Whole-path moves require delta.");
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Invalid canvas position.");
      const { document } = parseSourceDocument(source);
      const el = findTargetElement(document, command.target) as HTMLElement | null;
      if (!el?.style || el.closest("[data-timeline-locked]"))
        throw new Error("Choose an unlocked canvas element.");
      const animations = /<script\b/i.test(source) ? parseGsapAnimationsFromHtml(source).animations : [];
      let sharedPosition = false;
      const candidates = animations.filter((anim) => {
        if (anim.properties?.data === "hf-hold") return false;
        const channels = [
          anim.properties,
          anim.fromProperties,
          ...(anim.keyframes?.keyframes ?? []).map((k) => k.properties),
        ];
        if (
          !anim.arcPath?.enabled &&
          !channels.some(
            (props) =>
              props &&
              ["x", "y", "xPercent", "yPercent", "translate", "transform", "motionPath"].some(
                (key) => key in props,
              ),
          )
        )
          return false;
        // Dynamic JS targets cannot prove ownership of a layer. Preserve their script
        // and apply a layer offset when no authored selector owns the drag.
        if (anim.hasUnresolvedSelector) return false;
        let hits: Element[];
        try {
          hits = Array.from((el.closest("template") ?? document).querySelectorAll(anim.targetSelector));
        } catch {
          throw new Error("Cannot resolve the animated position selector.");
        }
        if (!hits.includes(el)) return false;
        if (anim.hasPartialSelector || hits.length !== 1) sharedPosition = true;
        return true;
      });
      if (delta && (sharedPosition || candidates.length > 1)) {
        // A layer offset moves the entrance, the hold, and the exit together. Each GSAP
        // tween keeps its own inherited start values, easing, and lifecycle callbacks.
        const box = command.staticBox ?? authoredLayerBox(el, delta);
        if (!box) throw new Error("Supply a measured layer box to move this responsive layout.");
        const { left, top, makeRelative } = box;
        return applyCanvasCommand(source, { kind: "setCanvasBox", target: command.target, box: { left, top, makeRelative } });
      }
      if (sharedPosition) throw new Error("The position tween targets multiple elements. Choose the shared animation explicitly.");
      if (candidates.length) {
        if (command.time === undefined && !(delta && candidates.length === 1))
          throw new Error("Specify the composition time for the animated layer.");
        // GSAP rounds timeline time to seven decimals. A literal duration can retain
        // more precision in the file, including the last frame of the welcome editor.
        const tick = (time: number) => Math.round(time * 1e7);
        const active = candidates.filter((anim) => {
          const start = resolveTweenStart(anim);
          return (
            start != null && tick(start) <= tick(command.time!) &&
            tick(command.time!) <= tick(start + resolveTweenDuration(anim))
          );
        });
        const owner = active.length === 1 ? active[0] : candidates.length === 1 ? candidates[0] : undefined;
        if (!owner)
          throw new Error("Multiple position tweens could own this move. Select the animation explicitly.");
        if (delta && owner.method !== "set")
          return applyCanvasCommand(source, {
            kind: "editAnimation",
            mutations: [
              { type: "shift-animation-path", animationId: owner.id, deltaX: delta.x, deltaY: delta.y },
            ],
          });
        if (delta && owner.method === "set") {
          for (const axis of ["x", "y"] as const) {
            const before = owner.properties[axis] ?? 0;
            if (typeof before !== "number") throw new Error("Cannot offset this non-numeric position.");
            point[axis] = before + delta[axis];
          }
        }
        if (owner.arcPath?.enabled) {
          const mutation = planArcDrag(owner, command.time!, {
            x: point.x,
            y: point.y,
          });
          if (!mutation) throw new Error("Cannot resolve the motion path at this composition time.");
          return applyCanvasCommand(source, {
            kind: "editAnimation",
            mutations: [mutation],
          });
        }
        if (owner.method === "set")
          return applyCanvasCommand(source, {
            kind: "editAnimation",
            mutations: [
              {
                type: "update-properties",
                animationId: owner.id,
                properties: point,
              },
            ],
          });
        return applyCanvasCommand(source, {
          kind: "setAnimatedValues",
          animationId: owner.id,
          at: { time: command.time! },
          samples: command.samples,
          values: point,
        });
      }
      if (command.staticBox)
        return applyCanvasCommand(source, {
          kind: "setCanvasBox",
          target: command.target,
          box: command.staticBox,
        });
      if (delta) {
        const raw = el.style.getPropertyValue("translate")?.trim();
        if (!raw && /(?:^|[;{])\s*translate\s*:/i.test(source))
          throw new Error("Use measured x/y for an inherited CSS translate.");
        const tokens = raw && raw !== "none" ? raw.split(/\s+/) : [];
        if (tokens.length > 2 || tokens.some((t) => !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(t)))
          throw new Error("Use measured x/y for a non-pixel CSS translate.");
        point.x = Number.parseFloat(tokens[0] || "0") + delta.x;
        point.y = Number.parseFloat(tokens[1] || "0") + delta.y;
      }
      const operations = writePlainMove(el, point);
      return applyCanvasCommand(source, {
        kind: "editElements",
        patches: [{ target: command.target, operations }],
      });
    }
    case "setAnimatedValues":
      return applyCanvasCommand(source, {
        kind: "editAnimation",
        mutations: [
          {
            type: "set-animated-values",
            animationId: command.animationId,
            at: command.at,
            samples: command.samples,
            values: command.values,
          },
        ],
      });
    case "editAnimation": {
      for (const mutation of command.mutations) {
        const valid = validateGsapMutationPayload(mutation);
        if (valid.ok === false) throw new Error(valid.error);
      }
      const result = applyGsapMutationsInMemory(source, command.mutations);
      if (result.ok === false) throw new Error(result.error);
      return result.after;
    }
    case "deleteCanvasElements": {
      checkCanvasTargets(source, command.targets, {
        requireAll: true,
        subtree: true,
      });
      return deleteCanvasSelection(source, command.targets);
    }
    case "duplicateElement": {
      const result = duplicateElementInHtml(source, command.target, command);
      if (!result.matched) throw new Error("Canvas element was not found.");
      return result.html;
    }
    case "groupElements": {
      const result = groupCanvasElements(
        source,
        command.targets,
        command.groupId,
        command.bbox,
        command.rebases,
      );
      if (!result.matched) throw new Error(result.error || "Cannot group the selected elements.");
      return result.html;
    }
    case "ungroupElements": {
      const result = unwrapGroupWithGsapCleanup(source, command.target, command.childTracks);
      if (!result.unwrapped) throw new Error("Group was not found.");
      return result.html;
    }
  }
}
export function canvasCommandLabel(command: CanvasCommand): string {
  switch (command.kind) {
    case "setCanvasBox":
      return command.box.corner ? "Resize layer" : "Move layer";
    case "moveCanvasElement":
      return "Move layer";
    case "editElements":
      return "Edit layer properties";
    case "setAnimatedValues":
      return "Edit animated properties";
    case "editAnimation":
      return "Edit animation";
    case "groupElements":
      return "Group layers";
    case "ungroupElements":
      return "Ungroup layers";
    case "deleteCanvasElements":
      return command.targets.length === 1 ? "Delete layer" : "Delete layers";
    case "duplicateElement":
      return "Duplicate layer";
  }
}
