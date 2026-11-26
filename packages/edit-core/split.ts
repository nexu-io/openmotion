import { findTargetElement, nextUniqueId, parseSourceDocument, relinkSplitHalvesInHtml, splitElementInHtml, type SourceMutationTarget } from '@hyperframes/studio-server/source-mutation';
import { isTimelineIgnoredElement } from './content-duration.ts';
import { applyGsapMutationsInMemory } from './gsap-mutations.ts';

export const CANVAS_SPLIT_UNSUPPORTED_MESSAGE =
  'Canvas layers cannot be split directly. Trim the clip or ask your Agent to edit the scene.';

/**
 * Procedural `<canvas>` elements (and non-sub-composition wrappers around them)
 * cannot be split by DOM cloning because the drawing script remains bound to a
 * single canvas, leaving the cloned right half empty/black.
 */
export function isUnsplittableCanvasElement(el: Element): boolean {
  if (el.hasAttribute('data-composition-src') || el.hasAttribute('data-composition-file')) {
    return false;
  }
  if (el.localName === 'canvas') return !isTimelineIgnoredElement(el);
  for (const canvas of Array.from(el.querySelectorAll('canvas'))) {
    if (isTimelineIgnoredElement(canvas)) continue;
    let isolated = false;
    for (let p = canvas.parentElement; p && p !== el; p = p.parentElement) {
      if (
        p.localName === 'template' ||
        p.hasAttribute('data-composition-src') ||
        p.hasAttribute('data-composition-file')
      ) {
        isolated = true;
        break;
      }
    }
    if (!isolated) return true;
  }
  return false;
}

export function assertSplittableElementInHtml(html: string, target: SourceMutationTarget): void {
  const { document } = parseSourceDocument(html);
  const el = findTargetElement(document, target);
  if (el && isUnsplittableCanvasElement(el)) {
    throw new Error(CANVAS_SPLIT_UNSUPPORTED_MESSAGE);
  }
}

export interface AtomicCutTarget {
  target: SourceMutationTarget;
  originalId?: string;
  splitTime: number;
  elementStart: number;
  elementDuration: number;
  playbackStart?: number;
  playbackRate?: number;
  track?: number;
}

/**
 * Apply all cut targets for a single file atomically in memory (DOM split + GSAP split + relink).
 */
export function applyAtomicCutsToHtml(
  before: string,
  targets: readonly AtomicCutTarget[],
  takenIds?: ReadonlySet<string>,
): { after: string; splitCount: number; skippedSelectors: string[]; rightHalfIds: string[] } {
  let html = before;
  let splitCount = 0;
  const skippedSelectors = new Set<string>();
  const rightHalfIds: string[] = [];
  const usedIds = new Set<string>(takenIds ?? []);

  for (const cut of targets) {
    const { document } = parseSourceDocument(html);
    const el = findTargetElement(document, cut.target);
    if (!el) continue;
    if (isUnsplittableCanvasElement(el)) {
      throw new Error(CANVAS_SPLIT_UNSUPPORTED_MESSAGE);
    }

    const originalId = cut.originalId || el.getAttribute('id') || undefined;
    const baseNewId = originalId ? `${originalId}-split` : 'clip-split';
    const newId = nextUniqueId(document, baseNewId, usedIds);
    usedIds.add(newId);

    const splitRes = splitElementInHtml(html, cut.target, cut.splitTime, newId, {
      start: cut.elementStart,
      duration: cut.elementDuration,
      ...(cut.playbackStart !== undefined ? { playbackStart: cut.playbackStart } : {}),
      ...(cut.playbackRate !== undefined ? { playbackRate: cut.playbackRate } : {}),
      ...(cut.track !== undefined ? { track: cut.track } : {}),
    });

    if (!splitRes.matched || !splitRes.newId) continue;
    html = splitRes.html;
    splitCount += 1;
    rightHalfIds.push(splitRes.newId);

    if (originalId) {
      const gsapRes = applyGsapMutationsInMemory(html, [
        {
          type: 'split-animations',
          originalId,
          newId: splitRes.newId,
          splitTime: cut.splitTime,
          elementStart: cut.elementStart,
          elementDuration: cut.elementDuration,
        },
      ]);
      if (gsapRes.ok) {
        html = gsapRes.after;
        for (const s of gsapRes.skippedSelectors) skippedSelectors.add(s);
      }
    }
  }

  if (rightHalfIds.length > 0) {
    html = relinkSplitHalvesInHtml(html, rightHalfIds);
  }

  return {
    after: html,
    splitCount,
    skippedSelectors: [...skippedSelectors],
    rightHalfIds,
  };
}
