import { planWholePathOffset } from './animation-path.ts';
import { planAuthoredAnimatedValues } from './playhead-edit.ts';
import { extractGsapScriptBlock as readGsapBlock, hasStudioTransform } from './gsap-block.ts';
export type { ExtractedGsapBlock } from './gsap-block.ts';
import { gsapCdnDist } from '@hyperframes/core/gsap-cdn';
import {
  hasCompositionOutsideTemplates,
  insertBeforeCloseTag,
} from '@hyperframes/core/compiler/html-document';
import {
  extractGsapLabels,
  parseGsapScriptAcorn,
} from '@hyperframes/parsers/gsap-parser-acorn';
import {
  addAnimationToScript,
  addAnimationWithKeyframesToScript,
  addKeyframeToScript,
  addLabelToScript,
  addMotionPathPointInScript,
  addMotionPathToScript,
  convertToKeyframesFromScript,
  copyAnimationsInScript,
  dedupePositionWritesInScript,
  materializeKeyframesFromScript,
  moveKeyframeInScript,
  removeAllKeyframesFromScript,
  removeAnimationFromScript,
  removeArcPathFromScript,
  removeKeyframeFromScript,
  removeLabelFromScript,
  removeMotionPathPointInScript,
  removePropertyFromAnimation,
  replaceTweenWithKeyframesInScript,
  resizeKeyframedTweenInScript,
  retimeClipTweensInScript,
  setArcPathInScript,
  splitAnimationsInScript,
  splitIntoPropertyGroupsFromScript,
  syncPositionHoldsBeforeKeyframes,
  trimTrailingKeyframeSpans,
  unrollDynamicAnimations,
  updateAnimationInScript,
  updateArcSegmentInScript,
  updateKeyframeInScript,
  updateMotionPathPointInScript,
  type ClipTweenRetime,
} from '@hyperframes/parsers/gsap-writer-acorn';
import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';
import { findUnsafeMutationValues } from '@hyperframes/studio-server/finite-mutation';

const HOLD_SYNC_MUTATION_TYPES = new Set([
  'add',
  'add-with-keyframes',
  'replace-with-keyframes',
  'add-keyframe',
  'update-keyframe',
  'remove-keyframe',
  'move-keyframe',
  'resize-keyframed-tween',
  'convert-to-keyframes',
  'remove-all-keyframes',
  'materialize-keyframes',
  'update-property',
  'add-property',
  'update-properties',
  'update-meta',
  'split-animations',
  'delete',
  'delete-all-for-selector',
]);

export function extractGsapScriptBlock(html: string) {
  return readGsapBlock(stampHfIdsInPlace(html));
}

export function parseGsapAnimationsFromHtml(html: string) {
  const block = readGsapBlock(html);
  if (!block) {
    return {
      animations: [],
      timelineVar: 'tl',
      hasTimeline: false,
      labels: [],
      preamble: '',
      postamble: '',
    };
  }
  const parsed = parseGsapScriptAcorn(block.scriptText);
  return {
    ...parsed,
    hasTimeline: Boolean(parsed.timelineVar),
    labels: extractGsapLabels(block.scriptText),
  };
}

export function stripGsapAnimationsForSelector(html: string, selector: string): string {
  const block = extractGsapScriptBlock(html);
  if (!block) return html;
  const parsed = parseGsapScriptAcorn(block.scriptText);
  const matching = parsed.animations.filter((a) => a.targetSelector === selector);
  if (matching.length === 0) return html;
  let script = block.scriptText;
  for (const anim of [...matching].reverse()) {
    script = removeAnimationFromScript(script, anim.id);
  }
  return block.replaceScript(script);
}

export function copyGsapAnimationsForSelector(
  html: string,
  fromSelector: string,
  toSelector: string,
  delta = 0,
): string {
  const block = extractGsapScriptBlock(html);
  if (!block) return html;
  const updated = copyAnimationsInScript(block.scriptText, fromSelector, toSelector, delta);
  return updated === block.scriptText ? html : block.replaceScript(updated);
}

export function bakeGroupTransformIntoMembers(
  html: string,
  groupId: string,
  members: ReadonlyArray<{ id: string; cx: number; cy: number }>,
  groupCenter: { cx: number; cy: number },
): string {
  const block = extractGsapScriptBlock(html);
  if (!block) return html;
  const parsed = parseGsapScriptAcorn(block.scriptText);
  const groupSel = `#${groupId}`;
  const groupSets = parsed.animations.filter(
    (a) => a.targetSelector === groupSel && a.method === 'set',
  );
  if (groupSets.length === 0) return html;
  const gt: Record<string, number> = {};
  for (const s of groupSets) {
    for (const [k, v] of Object.entries(s.properties)) {
      if (typeof v === 'number') gt[k] = v;
    }
  }
  const tx = gt.x ?? 0;
  const ty = gt.y ?? 0;
  const rotDeg = gt.rotation ?? 0;
  const sx = gt.scaleX ?? gt.scale ?? 1;
  const sy = gt.scaleY ?? gt.scale ?? 1;
  if (tx === 0 && ty === 0 && rotDeg === 0 && sx === 1 && sy === 1) return html;

  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let script = block.scriptText;

  for (const member of members) {
    const dx = (member.cx - groupCenter.cx) * sx;
    const dy = (member.cy - groupCenter.cy) * sy;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    const finalDx = Math.round((groupCenter.cx + rx + tx - member.cx) * 100) / 100;
    const finalDy = Math.round((groupCenter.cy + ry + ty - member.cy) * 100) / 100;
    const props: Record<string, number> = {};
    if (finalDx !== 0) props.x = finalDx;
    if (finalDy !== 0) props.y = finalDy;
    if (rotDeg !== 0) props.rotation = rotDeg;
    if (sx !== 1) props.scaleX = sx;
    if (sy !== 1) props.scaleY = sy;
    if (Object.keys(props).length === 0) continue;
    const added = addAnimationToScript(script, {
      targetSelector: `#${member.id}`,
      method: 'set',
      position: 0,
      duration: 0,
      properties: props,
    });
    script = added.script;
  }
  return block.replaceScript(script);
}

function containsRawGsapExpression(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('__raw:');
  if (Array.isArray(value)) return value.some(containsRawGsapExpression);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsRawGsapExpression);
}

export function validateGsapMutationPayload(
  body: unknown,
): { ok: true; mutation: Record<string, unknown> } | { ok: false; error: string; fields?: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'mutation type required' };
  }
  const rec = body as Record<string, unknown>;
  const type = typeof rec.type === 'string' ? rec.type : typeof rec.op === 'string' ? rec.op : '';
  if (!type) return { ok: false, error: 'mutation type required' };
  if (containsRawGsapExpression(rec)) {
    return { ok: false, error: 'raw JavaScript expressions are not accepted' };
  }
  const unsafe = findUnsafeMutationValues(rec);
  if (unsafe.length > 0) {
    return {
      ok: false,
      error: 'mutation contains non-finite or unsafe values',
      fields: unsafe.map((u) => u.path),
    };
  }
  if (type === 'shift-positions-batch' && !Array.isArray(rec.shifts)) {
    return { ok: false, error: 'shift-positions-batch requires a `shifts` array' };
  }
  return { ok: true, mutation: type === rec.type ? rec : { ...rec, type } };
}

function collectStudioTransforms(root: ParentNode, selector: string, clear: Set<Element>): void {
  if (!selector) return;
  try {
    for (const el of Array.from(root.querySelectorAll(selector))) {
      if (hasStudioTransform(el)) clear.add(el);
    }
  } catch {
    // Ignore non-CSS selectors.
  }
}

export type GsapMutationBody = Record<string, unknown>;

export type GsapMutationExecutionResult =
  | {
      ok: true;
      changed: boolean;
      mutated: boolean;
      before: string;
      after: string;
      scriptText: string;
      mutationChanges: boolean[];
      skippedSelectors: string[];
      parsed: ReturnType<typeof parseGsapScriptAcorn>;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

/**
 * Pure in-memory Acorn GSAP AST mutation executor. Supports all 28+ Studio mutation operations
 * plus batch execution, hold synchronization, and trailing keyframe trimming.
 */
export function applyGsapMutationsInMemory(
  beforeHtml: string,
  mutations: readonly Record<string, unknown>[],
): GsapMutationExecutionResult {
  if (mutations.length === 0) {
    return { ok: false, status: 400, error: 'mutations array required' };
  }

  let html = beforeHtml;
  let block = extractGsapScriptBlock(html);
  const firstType = String(mutations[0]?.type ?? '');

  if (!block && (firstType === 'add' || firstType === 'add-with-keyframes')) {
    const compId = html.match(/data-composition-id="([^"]+)"/)?.[1] ?? 'main';
    const bootstrap = [
      `<script src="${gsapCdnDist()}gsap.min.js"></script>`,
      '<script>',
      'window.__timelines = window.__timelines || {};',
      'const tl = gsap.timeline({ paused: true });',
      `window.__timelines["${compId}"] = tl;`,
      '</script>',
    ].join('\n');
    const [first, second] = hasCompositionOutsideTemplates(html)
      ? (['body', 'template'] as const)
      : (['template', 'body'] as const);
    html =
      insertBeforeCloseTag(html, first, `${bootstrap}\n`) ??
      insertBeforeCloseTag(html, second, `${bootstrap}\n`) ??
      `${html}\n${bootstrap}`;
    block = extractGsapScriptBlock(html);
  }

  if (
    !block &&
    (firstType === 'shift-positions' || firstType === 'scale-positions' || firstType === 'shift-positions-batch')
  ) {
    return {
      ok: true,
      changed: false,
      mutated: false,
      before: beforeHtml,
      after: beforeHtml,
      scriptText: '',
      mutationChanges: mutations.map(() => false),
      skippedSelectors: [],
      parsed: { animations: [], timelineVar: 'tl', preamble: '', postamble: '' } as unknown as ReturnType<
        typeof parseGsapScriptAcorn
      >,
    };
  }

  if (!block) {
    return { ok: false, status: 400, error: 'no GSAP script found in file' };
  }

  const hasLayerLocks = /data-timeline-locked/i.test(beforeHtml);
  const initialScript = block.scriptText;
  const clearTransforms = new Set<Element>();
  const skippedSelectors = new Set<string>();
  const mutationChanges: boolean[] = [];

  // Detect whether composition duration is authored explicitly
  const rootEl = block.document.querySelector('[data-composition-id]');
  const lengthIsAuthored = Boolean(rootEl?.getAttribute('data-duration'));

  const requireAnim = (
    scriptText: string,
    animationId: string,
  ):
    | { anim: ReturnType<typeof parseGsapScriptAcorn>['animations'][number] }
    | { err: { ok: false; status: number; error: string } } => {
    const parsed = parseGsapScriptAcorn(scriptText);
    const anim = parsed.animations.find((a) => a.id === animationId);
    if (!anim) return { err: { ok: false, status: 404, error: 'animation not found' } };
    return { anim };
  };

  for (const rawMutation of mutations) {
    const previousScript = block.scriptText;
    let body = rawMutation as Record<string, any>;
    if (hasLayerLocks) {
      const selectors = [body.targetSelector, body.updates?.targetSelector,
        ...(Array.isArray(body.shifts) ? body.shifts.map((shift: {targetSelector?: string}) => shift?.targetSelector) : [])];
      if (body.animationId) {
        const found = requireAnim(previousScript, String(body.animationId));
        if ('err' in found) return found.err;
        if (found.anim.hasPartialSelector || found.anim.hasUnresolvedSelector)
          return {ok:false,status:400,error:'Cannot resolve the animation target while layers are locked.'};
        selectors.push(found.anim.targetSelector);
      }
      for (const selector of selectors) {
        if (typeof selector !== 'string' || !selector) continue;
        try {
          if (Array.from(block.root.querySelectorAll(selector)).some(el => el.closest('[data-timeline-locked]')))
            return {ok:false,status:400,error:'Unlock the animated layer before editing.'};
        } catch {
          return {ok:false,status:400,error:'Cannot resolve the animation target while layers are locked.'};
        }
      }
    }
    if (body.type === 'shift-animation-path') {
      const found = requireAnim(previousScript, String(body.animationId));
      if ('err' in found) return found.err;
      try {
        body = planWholePathOffset(found.anim,body.deltaX,body.deltaY);
      } catch (error) {
        return {ok:false,status:400,error:error instanceof Error ? error.message : 'Invalid path offset.'};
      }
    }
    if (body.type === 'set-animated-values') {
      const found = requireAnim(previousScript, String(body.animationId));
      if ('err' in found) return found.err;
      const at = body.at;
      if (!at || !(Number.isFinite(at.time) || Number.isFinite(at.percentage)) ||
          !body.values || !Object.values(body.values).length || !Object.values(body.values).every(Number.isFinite))
        return {ok:false,status:400,error:'A playhead position and finite values are required.'};
      const plan = planAuthoredAnimatedValues(found.anim, at, body.values, body.samples);
      if (plan.ok === false) return {ok:false,status:400,error:'Cannot edit animated values: ' + plan.reason + '. Supply measured tween endpoints/ease when required.'};
      body = plan.mutation;
    }
    const type = String(body.type ?? '');
    let nextScript = previousScript;

    switch (type) {
      case 'update-property':
      case 'add-property': {
        const found = requireAnim(previousScript, String(body.animationId));
        if ('err' in found) return found.err;
        const val = type === 'update-property' ? body.value : body.defaultValue;
        nextScript = updateAnimationInScript(previousScript, String(body.animationId), {
          properties: { ...found.anim.properties, [String(body.property)]: val },
        });
        break;
      }
      case 'update-properties': {
        const found = requireAnim(previousScript, String(body.animationId));
        if ('err' in found) return found.err;
        nextScript = updateAnimationInScript(previousScript, String(body.animationId), {
          properties: { ...found.anim.properties, ...(body.properties as Record<string, number | string>) },
        });
        break;
      }
      case 'update-from-property':
      case 'add-from-property': {
        const found = requireAnim(previousScript, String(body.animationId));
        if ('err' in found) return found.err;
        if (found.anim.method !== 'fromTo') {
          return { ok: false, status: 400, error: 'animation is not a fromTo' };
        }
        const val = type === 'update-from-property' ? body.value : body.defaultValue;
        nextScript = updateAnimationInScript(previousScript, String(body.animationId), {
          fromProperties: { ...(found.anim.fromProperties ?? {}), [String(body.property)]: val },
        });
        break;
      }
      case 'update-meta': {
        nextScript = updateAnimationInScript(previousScript, String(body.animationId), body.updates);
        break;
      }
      case 'add': {
        if (body.fromProperties && body.method !== 'fromTo') {
          return { ok: false, status: 400, error: 'fromProperties is only valid for method=fromTo' };
        }
        if (typeof body.targetSelector === 'string') {
          const keys = Object.keys((body.properties ?? {}) as Record<string, unknown>);
          if (keys.some((k) => ['x', 'y', 'rotation', 'rotate'].includes(k))) {
            collectStudioTransforms(block.root, body.targetSelector, clearTransforms);
          }
        }
        nextScript = addAnimationToScript(previousScript, {
          targetSelector: body.targetSelector,
          method: body.method,
          position: body.position,
          duration: body.duration,
          ease: body.ease,
          properties: body.properties,
          fromProperties: body.fromProperties,
          ...(body.global ? { global: true } : {}),
        }).script;
        break;
      }
      case 'delete': {
        const found = requireAnim(previousScript, String(body.animationId));
        if (!('err' in found) && body.stripStudioEdits) {
          collectStudioTransforms(block.root, found.anim.targetSelector, clearTransforms);
        }
        nextScript = removeAnimationFromScript(previousScript, String(body.animationId));
        break;
      }
      case 'delete-all-for-selector': {
        const parsed = parseGsapScriptAcorn(previousScript);
        const matching = parsed.animations.filter((a) => a.targetSelector === body.targetSelector);
        if (matching.length > 0) {
          collectStudioTransforms(block.root, String(body.targetSelector), clearTransforms);
          for (const anim of [...matching].reverse()) {
            nextScript = removeAnimationFromScript(nextScript, anim.id);
          }
        }
        break;
      }
      case 'consolidate-position-writes': {
        if (body.targetSelector) {
          nextScript = dedupePositionWritesInScript(
            previousScript,
            String(body.targetSelector),
            body.keepAnimationId,
          );
        }
        break;
      }
      case 'remove-property': {
        const found = requireAnim(previousScript, String(body.animationId));
        if ('err' in found) return found.err;
        nextScript = removePropertyFromAnimation(previousScript, String(body.animationId), String(body.property), false);
        break;
      }
      case 'remove-from-property': {
        const found = requireAnim(previousScript, String(body.animationId));
        if ('err' in found) return found.err;
        if (found.anim.method !== 'fromTo') {
          return { ok: false, status: 400, error: 'animation is not a fromTo' };
        }
        nextScript = removePropertyFromAnimation(previousScript, String(body.animationId), String(body.property), true);
        break;
      }
      case 'add-keyframe': {
        nextScript = addKeyframeToScript(
          previousScript,
          String(body.animationId),
          Number(body.percentage),
          body.properties,
          body.ease,
          body.backfillDefaults,
        );
        break;
      }
      case 'remove-keyframe': {
        nextScript = removeKeyframeFromScript(previousScript, String(body.animationId), Number(body.percentage));
        break;
      }
      case 'move-keyframe': {
        nextScript = moveKeyframeInScript(
          previousScript,
          String(body.animationId),
          Number(body.fromPercentage),
          Number(body.toPercentage),
        );
        break;
      }
      case 'resize-keyframed-tween': {
        nextScript = resizeKeyframedTweenInScript(
          previousScript,
          String(body.animationId),
          Number(body.position),
          Number(body.duration),
          body.pctRemap,
        );
        break;
      }
      case 'update-keyframe': {
        nextScript = updateKeyframeInScript(
          previousScript,
          String(body.animationId),
          Number(body.percentage),
          body.properties,
          body.ease,
        );
        break;
      }
      case 'convert-to-keyframes': {
        nextScript = convertToKeyframesFromScript(
          previousScript,
          String(body.animationId),
          body.resolvedFromValues,
          body.duration,
        );
        break;
      }
      case 'remove-all-keyframes': {
        nextScript = removeAllKeyframesFromScript(previousScript, String(body.animationId));
        break;
      }
      case 'materialize-keyframes': {
        if (Array.isArray(body.allElements) && body.allElements.length > 0) {
          nextScript = unrollDynamicAnimations(previousScript, String(body.animationId), body.allElements);
        } else {
          nextScript = materializeKeyframesFromScript(
            previousScript,
            String(body.animationId),
            body.keyframes,
            body.easeEach,
            body.resolvedSelector,
          );
        }
        break;
      }
      case 'set-arc-path': {
        nextScript = setArcPathInScript(previousScript, String(body.animationId), {
          enabled: Boolean(body.enabled),
          autoRotate: Boolean(body.autoRotate),
          segments: body.segments ?? [],
        });
        break;
      }
      case 'update-arc-segment': {
        nextScript = updateArcSegmentInScript(previousScript, String(body.animationId), Number(body.segmentIndex), {
          ...(body.curviness !== undefined ? { curviness: body.curviness } : {}),
          ...(body.cp1 ? { cp1: body.cp1 } : {}),
          ...(body.cp2 ? { cp2: body.cp2 } : {}),
        });
        break;
      }
      case 'update-motion-path-point': {
        nextScript = updateMotionPathPointInScript(previousScript, String(body.animationId), Number(body.pointIndex), {
          x: Number(body.x),
          y: Number(body.y),
        });
        break;
      }
      case 'add-motion-path-point': {
        nextScript = addMotionPathPointInScript(previousScript, String(body.animationId), Number(body.index), {
          x: Number(body.x),
          y: Number(body.y),
        });
        break;
      }
      case 'remove-motion-path-point': {
        nextScript = removeMotionPathPointInScript(previousScript, String(body.animationId), Number(body.index));
        break;
      }
      case 'add-motion-path': {
        nextScript = addMotionPathToScript(
          previousScript,
          String(body.targetSelector),
          Number(body.position),
          Number(body.duration),
          { x: Number(body.x), y: Number(body.y) },
          body.ease,
        ).script;
        break;
      }
      case 'remove-arc-path': {
        nextScript = removeArcPathFromScript(previousScript, String(body.animationId));
        break;
      }
      case 'add-with-keyframes': {
        nextScript = addAnimationWithKeyframesToScript(
          previousScript,
          String(body.targetSelector),
          Number(body.position),
          Number(body.duration),
          body.keyframes,
          body.ease,
          body.easeEach,
        ).script;
        break;
      }
      case 'replace-with-keyframes': {
        const replaced = replaceTweenWithKeyframesInScript(previousScript, String(body.animationId), {
          targetSelector: String(body.targetSelector),
          position: Number(body.position),
          duration: Number(body.duration),
          keyframes: body.keyframes,
          ease: body.ease,
          easeEach: body.easeEach,
        });
        if (replaced !== null) {
          nextScript = replaced;
        } else {
          const without = removeAnimationFromScript(previousScript, String(body.animationId));
          nextScript = addAnimationWithKeyframesToScript(
            without,
            String(body.targetSelector),
            Number(body.position),
            Number(body.duration),
            body.keyframes,
            body.ease,
            body.easeEach,
          ).script;
        }
        break;
      }
      case 'split-animations': {
        if (
          typeof body.originalId !== 'string' ||
          !body.originalId ||
          typeof body.newId !== 'string' ||
          !body.newId ||
          typeof body.splitTime !== 'number' ||
          !Number.isFinite(body.splitTime) ||
          typeof body.elementStart !== 'number' ||
          !Number.isFinite(body.elementStart) ||
          typeof body.elementDuration !== 'number' ||
          !Number.isFinite(body.elementDuration) ||
          body.elementDuration <= 0
        ) {
          return {
            ok: false,
            status: 400,
            error: 'split-animations requires originalId, newId, splitTime, elementStart, and positive elementDuration',
          };
        }
        const splitRes = splitAnimationsInScript(previousScript, {
          originalId: body.originalId,
          newId: body.newId,
          splitTime: body.splitTime,
          elementStart: body.elementStart,
          elementDuration: body.elementDuration,
        });
        nextScript = splitRes.script;
        for (const sel of splitRes.skippedSelectors) skippedSelectors.add(sel);
        break;
      }
      case 'split-into-property-groups': {
        nextScript = splitIntoPropertyGroupsFromScript(previousScript, String(body.animationId)).script;
        break;
      }
      case 'add-label': {
        nextScript = addLabelToScript(previousScript, String(body.name), Number(body.position));
        break;
      }
      case 'remove-label': {
        nextScript = removeLabelFromScript(previousScript, String(body.name));
        break;
      }
      case 'shift-positions-batch': {
        const shifts: ClipTweenRetime[] = (body.shifts as Array<{ targetSelector?: string; delta?: number }>)
          .filter((s) => Boolean(s.targetSelector) && typeof s.delta === 'number' && Number.isFinite(s.delta) && s.delta !== 0)
          .map((s) => ({ kind: 'shift' as const, targetSelector: s.targetSelector!, delta: s.delta! }));
        nextScript = retimeClipTweensInScript(previousScript, shifts, block.root).script;
        nextScript = syncPositionHoldsBeforeKeyframes(nextScript, previousScript);
        break;
      }
      case 'shift-positions': {
        if (body.targetSelector && typeof body.delta === 'number' && Number.isFinite(body.delta) && body.delta !== 0) {
          nextScript = retimeClipTweensInScript(
            previousScript,
            [{ kind: 'shift', targetSelector: String(body.targetSelector), delta: body.delta }],
            block.root,
          ).script;
          nextScript = syncPositionHoldsBeforeKeyframes(nextScript, previousScript);
        }
        break;
      }
      case 'scale-positions': {
        const nums = [body.oldStart, body.oldDuration, body.newStart, body.newDuration];
        if (
          body.targetSelector &&
          nums.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
          body.oldDuration > 0 &&
          body.newDuration > 0 &&
          (body.oldStart !== body.newStart || body.oldDuration !== body.newDuration)
        ) {
          nextScript = retimeClipTweensInScript(
            previousScript,
            [
              {
                kind: 'scale',
                targetSelector: String(body.targetSelector),
                oldStart: body.oldStart,
                oldDuration: body.oldDuration,
                newStart: body.newStart,
                newDuration: body.newDuration,
              },
            ],
            block.root,
          ).script;
          nextScript = syncPositionHoldsBeforeKeyframes(nextScript, previousScript);
        }
        break;
      }
      default:
        return { ok: false, status: 400, error: `unknown mutation type: ${type}` };
    }

    if (HOLD_SYNC_MUTATION_TYPES.has(type)) {
      if (lengthIsAuthored) {
        nextScript = trimTrailingKeyframeSpans(previousScript, nextScript);
      }
      nextScript = syncPositionHoldsBeforeKeyframes(nextScript, previousScript);
    }

    mutationChanges.push(nextScript !== previousScript);
    block.scriptText = nextScript;
  }

  const changed = block.scriptText !== initialScript || html !== beforeHtml;
  const after = changed ? block.replaceScript(block.scriptText, clearTransforms) : beforeHtml;

  return {
    ok: true,
    changed,
    mutated: after !== beforeHtml,
    before: beforeHtml,
    after,
    scriptText: block.scriptText,
    mutationChanges,
    skippedSelectors: [...skippedSelectors],
    parsed: parseGsapScriptAcorn(block.scriptText),
  };
}
