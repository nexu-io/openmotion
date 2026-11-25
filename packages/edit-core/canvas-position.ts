import { STUDIO_OFFSET_X_PROP, STUDIO_OFFSET_Y_PROP } from '@hyperframes/core/editing/draft-markers';
export const STUDIO_PATH_OFFSET_ATTR = 'data-hf-studio-path-offset';
export const STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR = 'data-hf-studio-original-inline-translate';
type PositionPatch = { type: 'inline-style' | 'attribute'; property: string; value: string | null };
type Point = { x: number; y: number };
const roundTo3 = (n: number) => Math.round(n * 1000) / 1000;

/** Plain px only: GSAP's CSSPlugin splits `translate` on spaces and drops a calc(). */
function formatTranslatePx(p: Point): string {
  return `${roundTo3(p.x)}px ${roundTo3(p.y)}px`;
}

const LEGACY_OFFSET_VARS = [STUDIO_OFFSET_X_PROP, STUDIO_OFFSET_Y_PROP];

/** Writes a move as the element's own translate; ends a legacy offset's vars and mark. */
export function writePlainMove(el: HTMLElement, p: Point): PositionPatch[] {
  writeTranslatePx(el, p);
  const patches: PositionPatch[] = [
    { type: 'inline-style', property: 'translate', value: formatTranslatePx(p) },
    {
      type: 'attribute',
      property: STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR,
      value: el.getAttribute(STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR),
    },
  ];
  for (const prop of LEGACY_OFFSET_VARS.filter((v) => el.style.getPropertyValue(v))) {
    el.style.removeProperty(prop);
    patches.push({ type: 'inline-style', property: prop, value: null });
  }
  if (el.hasAttribute(STUDIO_PATH_OFFSET_ATTR)) {
    el.removeAttribute(STUDIO_PATH_OFFSET_ATTR);
    patches.push({ type: 'attribute', property: STUDIO_PATH_OFFSET_ATTR, value: null });
  }
  return patches;
}

/** The first write records the author's own translate ("" for none), which Reset puts back. */
export function writeTranslatePx(el: HTMLElement, p: Point): void {
  if (!el.hasAttribute(STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR)) {
    const own = el.style.getPropertyValue('translate') || '';
    el.setAttribute(
      STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR,
      LEGACY_OFFSET_VARS.some((prop) => own.includes(prop)) ? '' : own,
    );
  }
  el.style.setProperty('translate', formatTranslatePx(p));
}

/** Resolve authored pixel insets for a headless layer move. A viewport-dependent cascade needs a measured box. */
export function authoredLayerBox(el: HTMLElement, delta: Point) {
  const template = el.closest('template');
  const roots = template ? [el.ownerDocument, template] : [el.ownerDocument];
  const declarations: CSSStyleDeclaration[] = [];
  const collect = (rules: CSSRuleList): boolean => Array.from(rules).every(rule => {
    if (!('selectorText' in rule) || ('cssRules' in rule && (rule.cssRules as CSSRuleList).length)) return false;
    const style = rule as CSSStyleRule;
    if (el.matches(style.selectorText)) declarations.push(style.style);
    return true;
  });
  try {
    for (const root of roots) {
      if (root.querySelector('link[rel~="stylesheet"]')) return;
      for (const style of root.querySelectorAll('style')) {
        if (!style.sheet || style.hasAttribute('media') || !collect(style.sheet.cssRules)) return;
      }
    }
  } catch { return; }
  const property = (name: string) => {
    const inline = el.style.getPropertyValue(name);
    if (inline.includes('!') || declarations.some(style => style.getPropertyPriority(name))) return;
    if (inline) return inline;
    const values = new Set(declarations.map(style => style.getPropertyValue(name)).filter(Boolean));
    return values.size < 2 ? [...values][0] ?? '' : undefined;
  };
  if (['inset', 'inset-inline', 'inset-block', 'inset-inline-start', 'inset-inline-end', 'inset-block-start', 'inset-block-end', 'all'].some(name => property(name) !== '')) return;
  const position = property('position');
  if (!['', 'static', 'relative', 'absolute', 'fixed'].includes(position ?? '?')) return;
  const makeRelative = !position || position === 'static';
  // Opposing insets can stretch a responsive box when one edge moves.
  if (!makeRelative && ['right', 'bottom'].some(name => !['', 'auto'].includes(property(name) ?? '?'))) return;
  const pixel = (axis: string) => {
    if (makeRelative) return 0;
    const value = property(axis);
    if (value === '0') return 0;
    if (value && /^-?(?:\d+\.?\d*|\.\d+)px$/.test(value)) return Number.parseFloat(value);
  };
  const left = pixel('left'), top = pixel('top');
  if (left == null || top == null) return;
  return { left: roundTo3(left + delta.x), top: roundTo3(top + delta.y), makeRelative };
}
