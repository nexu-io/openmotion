import { createHash } from 'node:crypto';
import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import { readBuiltinTemplateEntry } from '../../services/builtin-template-source.ts';
import type { VirtualProjectReader } from '../virtual-project-store.ts';
import { hasUnknownStaticHtmlInputs } from './preview-html-sources.ts';

const selector = 'meta[name="openmotion-live-edits"]';
const attribute = 'data-standalone-inputs';

/** The review binds executable scripts and stylesheets in DOM order. Copy, layout and
 * other passive markup are checked by the normal HTML dependency scanner. */
function reviewedInputs(element: Element, project: VirtualProjectReader): string | undefined {
  const hash = createHash('sha256');
  const unknown = hasUnknownStaticHtmlInputs(element, { recordInput(el) {
    if (el.getAttributeNames().some(name => /^on/i.test(name))) return false;
    if (!['script', 'style', 'link'].includes(el.localName)) return false;
    if (el.localName === 'link' && el.getAttribute('rel') !== 'stylesheet') return false;
    const src = el.getAttribute(el.localName === 'link' ? 'href' : 'src');
    let version: string | undefined;
    if (src !== null) {
      // The compiled document base is the project root.
      if (!/^[\w-]+(?:\/[\w.-]+)*\.(?:js|css)$/.test(src)) return false;
      version = project.getFile(src)?.sha256;
      if (!version) return false;
    }
    const attrs = el.getAttributeNames().filter(name => name !== 'data-hf-id').sort().map(name => [name, el.getAttribute(name)]);
    hash.update(JSON.stringify([el.localName, attrs, el.textContent, version]));
    return true;
  } });
  return unknown ? undefined : hash.digest('hex');
}

/** A separately opened clip inherits index.html's head. A template can explicitly review
 * which startup code and shared styles are independent of other HTML files. */
export async function standaloneHtmlSources(project: VirtualProjectReader, path: string, doc: Document) {
  if (doc.querySelector('template, [data-composition-src]')) return;
  const sources = [path, 'index.html'];
  if (!hasUnknownStaticHtmlInputs(doc)) return sources;
  if ([...doc.documentElement.attributes, ...doc.body.attributes].some(a => a.name !== 'data-hf-id')) return;
  const declarations = doc.head.querySelectorAll(selector);
  if (declarations.length > 1) return;
  let declaration = declarations[0]?.getAttribute(attribute) ?? null;
  if (declaration == null) {
    const entry = await readBuiltinTemplateEntry(project.templateId);
    if (entry?.includes(attribute)) declaration = parseHTMLContent(entry).head?.querySelector(selector)?.getAttribute(attribute) ?? null;
  }
  if (!declaration) return;
  const [head, ...bodies] = declaration.trim().split(/\s+/);
  if (!head || reviewedInputs(doc.head, project) !== head) return;
  if (!hasUnknownStaticHtmlInputs(doc.body)) return sources;
  const body = reviewedInputs(doc.body, project);
  if (body && bodies.includes(body)) return sources;
}
