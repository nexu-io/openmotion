import { parse } from 'acorn';
import { RUNTIME_BOOTSTRAP_ATTR } from '@hyperframes/core/compiler';

// Only certify static markup whose HTML inputs the compiler can enumerate. Runtime scripts,
// embedded documents, external styles and unrecognized markup retain whole-preview refresh.
const layoutTags = new Set(('html head title meta style body main section div article header footer ' +
  'span p h1 h2 h3 h4 h5 h6 img picture audio video source track').split(' '));
const formattingTags = new Set('aside nav b i em strong small br ol ul li figure figcaption'.split(' '));

export function isPassivePreviewTag(tag: string, includeFormatting = true): boolean {
  return layoutTags.has(tag) || (includeFormatting && formattingTags.has(tag));
}

// A project may initialize private scalar metadata in its own script. Such a
// script has no DOM inputs to recompute when the editor changes markup.
export function isPreviewDataScript(el: Element): boolean {
  if (el.localName !== 'script' || el.hasAttribute('src') || el.getAttributeNames().some(name => /^on/i.test(name))) return false;
  const type = el.getAttribute('type')?.trim().toLowerCase();
  if (type === 'application/json' || type === 'application/ld+json') return true;
  if (type && type !== 'text/javascript' && type !== 'application/javascript') return false;
  const source = el.textContent ?? '';
  if (!source.trim()) return true;
  if (!source.includes('__')) return false;
  try {
    return parse(source, { ecmaVersion: 'latest' }).body.every(statement => {
      if (statement.type === 'EmptyStatement') return true;
      if (statement.type !== 'ExpressionStatement') return false;
      const expr = statement.expression;
      if (expr.type === 'Literal') return expr.value === 'use strict';
      if (expr.type !== 'AssignmentExpression' || expr.operator !== '=' || expr.left.type !== 'MemberExpression' ||
          expr.left.computed || expr.left.object.type !== 'Identifier' || expr.left.property.type !== 'Identifier' ||
          !['window', 'globalThis'].includes(expr.left.object.name) || expr.right.type !== 'Literal' ||
          !['string', 'number', 'boolean'].includes(typeof expr.right.value) && expr.right.value !== null) return false;
      const key = expr.left.property.name;
      // Leave browser prototypes and player-owned slots on the scripted path.
      return /^__[a-z][a-z0-9_$]*$/i.test(key) && !(key in Object.prototype) &&
        !/^__(?:hf|hyperframes|openmotion|player|timeline|clipManifest)/i.test(key);
    });
  } catch {
    return false;
  }
}

const plainMedia = /^[\w./-]+\.(?:png|jpe?g|gif|webp|avif|svg|mp[34]|mov|webm|wav|ogg|m4[av]|vtt)$/i;
const number = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const channel = `${number}%?`;
const firstChannel = `${number}(?:%|deg|grad|rad|turn)?`;
const commaChannels = String.raw`${firstChannel}\s*,\s*${channel}\s*,\s*${channel}(?:\s*,\s*${channel})?`;
const spaceChannels = String.raw`${firstChannel}\s+${channel}\s+${channel}(?:\s*\/\s*${channel})?`;
const numericColor = new RegExp(String.raw`(^|[\t\n\f\r :,])(?:rgba?|hsla?)\(\s*(?:${commaChannels}|${spaceChannels})\s*\)`, 'gi');

function cssMayLoadResources(css: string): boolean {
  if (/[\\@]/.test(css)) return true;
  if (!css.includes('(')) return false;
  // Keep mixed strings/comments and unfamiliar functions on the conservative path.
  if (/["']|\/\*/.test(css)) return true;
  return css.replace(numericColor, '$1').includes('(');
}

const SAFE_HEAD_LINK_RELS = new Set([
  'stylesheet',
  'preconnect',
  'dns-prefetch',
  'icon',
  'shortcut icon',
  'apple-touch-icon',
]);

function isSafeHeadLink(el: Element): boolean {
  if (el.localName !== 'link') return false;
  if (el.hasAttribute('http-equiv') || el.hasAttribute('srcset')) return false;
  if (el.getAttributeNames().some(name => /^on/i.test(name))) return false;
  const rel = (el.getAttribute('rel') ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!SAFE_HEAD_LINK_RELS.has(rel)) return false;
  const href = (el.getAttribute('href') ?? '').trim();
  if (!href) return true;
  if (/^(?:javascript|data|vbscript):/i.test(href)) return false;
  const pathOnly = href.split(/[?#]/)[0] ?? '';
  return !/\.html?$/i.test(pathOnly);
}

function hasUnknownInputs(
  root: Document | DocumentFragment,
  runtime?: Element | null,
  allowSafeHeadLinks = false,
): boolean {
  return Array.from(root.querySelectorAll('*')).some(el => {
    if (el === runtime || isPreviewDataScript(el)) return false;
    if (allowSafeHeadLinks && isSafeHeadLink(el)) return false;
    if ((!isPassivePreviewTag(el.localName) && el.localName !== 'template') || el.hasAttribute('http-equiv') || el.hasAttribute('srcset')) return true;
    if (el.localName === 'template' && hasUnknownInputs((el as HTMLTemplateElement).content, null, allowSafeHeadLinks)) return true;
    // CSS can load more resources through @import, url(), image-set() or escaped identifiers.
    const css = el.localName === 'style' ? el.textContent : el.getAttribute('style');
    if (css && cssMayLoadResources(css)) return true;
    return el.getAttributeNames().some(name => /^on/i.test(name) ||
      (['src', 'poster', 'href'].includes(name) && !plainMedia.test(el.getAttribute(name) ?? '')));
  });
}

/**
 * Returns true when markup contains scripts, event handlers, embedded documents,
 * dynamic CSS resource loads, or unrecognized tags whose runtime file dependencies
 * cannot be statically enumerated.
 */
export function hasUnknownStaticHtmlInputs(
  root: Document | DocumentFragment,
  options?: { runtime?: Element | null; allowSafeHeadLinks?: boolean },
): boolean {
  return hasUnknownInputs(root, options?.runtime ?? null, options?.allowSafeHeadLinks === true);
}

export function staticPreviewHtmlSources(entry: string, doc: Document, runtimeUrl: string) {
  const runtime = Array.from(doc.querySelectorAll('script')).find(el => el.hasAttribute(RUNTIME_BOOTSTRAP_ATTR) &&
    el.getAttribute('src') === runtimeUrl && !el.textContent?.trim());
  let known = !hasUnknownInputs(doc, runtime);
  const sources = new Set([entry]);
  return {
    add(path: string) { if (known) sources.add(path); },
    inspect(child: Document) { if (known && hasUnknownInputs(child)) known = false; },
    markUnknown() { known = false; },
    paths() { return known ? [...sources] : undefined; },
  };
}
