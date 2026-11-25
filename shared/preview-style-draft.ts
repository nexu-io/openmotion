// Shared by direct and isolated previews. An older failure cannot roll back a newer draft.
export function createStyleDrafts() {
  type Step = { value: string; saved: boolean };
  type Chain = { base: string; visible: string; steps: Step[] };
  const styles = new WeakMap<CSSStyleDeclaration, Map<string, Chain>>();
  return (style: CSSStyleDeclaration, name: string, value: string) => {
    if (style.getPropertyPriority(name)) return;
    let properties = styles.get(style);
    if (!properties) styles.set(style, properties = new Map());
    const actual = style.getPropertyValue(name);
    let chain = properties.get(name);
    if (!chain || chain.visible !== actual) {
      chain = { base: actual, visible: actual, steps: [] };
      properties.set(name, chain);
    }
    style.setProperty(name, value);
    const step = { value: style.getPropertyValue(name), saved: false };
    chain.visible = step.value;
    chain.steps.push(step);
    return (saved: boolean) => {
      if (properties.get(name) !== chain) return;
      if (style.getPropertyValue(name) !== chain.visible || style.getPropertyPriority(name)) {
        properties.delete(name);
        return;
      }
      step.saved = saved;
      if (!saved) chain.steps.splice(chain.steps.indexOf(step), 1);
      while (chain.steps[0]?.saved) chain.base = chain.steps.shift()!.value;
      const next = chain.steps.length ? chain.steps[chain.steps.length - 1]!.value : chain.base;
      if (next !== chain.visible) style.setProperty(name, next);
      chain.visible = next;
      if (!chain.steps.length) properties.delete(name);
    };
  };
}

// Only edit a mounted declaration when its entire selector belongs to the requested file.
export function findBlockColorRule(doc: Document, path: string, key: string, value: string, entry?: string) {
  if (!/^--[a-zA-Z][\w-]{0,62}$/.test(key) || typeof value !== 'string' || value.length > 128 ||
      !doc.defaultView?.CSS?.supports('color', value) || /(?:url|var|attr|env)\s*\(|[;{}\\]/i.test(value)) return;
  let found: CSSStyleDeclaration | undefined;
  for (const sheet of Array.from(doc.styleSheets)) {
    if (sheet.ownerNode?.nodeName !== 'STYLE' || sheet.disabled || sheet.media?.mediaText) continue;
    for (const rule of Array.from(sheet.cssRules)) {
      if (!('selectorText' in rule) || !('style' in rule)) continue;
      const css = rule as CSSStyleRule;
      if (!css.style.getPropertyValue(key)) continue;
      let targets: Element[];
      try { targets = Array.from(doc.querySelectorAll(css.selectorText)); }
      catch { continue; } // CSS namespaces can produce selectors unavailable to querySelectorAll.
      const owned = (el: Element) => {
        const owner = el.closest('[data-composition-file],[data-composition-src]');
        return (owner?.getAttribute('data-composition-file') || owner?.getAttribute('data-composition-src') || entry) === path;
      };
      if (!targets.some(owned)) continue;
      if (found || !targets.every(owned)) return;
      found = css.style;
    }
  }
  return found;
}
