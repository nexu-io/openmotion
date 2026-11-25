import { createHash } from 'node:crypto';
import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import type { PreviewLiveEdits } from '../../../shared/preview-timing.ts';
import { readBuiltinTemplateEntry } from '../../services/builtin-template-source.ts';
import { resolveVirtualPath, virtualDirname, type VirtualProjectReader } from '../virtual-project-store.ts';

const selector = 'meta[name="openmotion-live-edits"]';

/** An author can promise these edits do not affect startup code. Bind that promise to the reviewed code. */
export function previewBehaviorDigest(project: VirtualProjectReader, capabilities: string): string | null {
  const hash = createHash('sha256').update(JSON.stringify(capabilities));
  const files = project.listFiles().filter(f => /\.(?:m?js|cjs|html?)$/i.test(f.path))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  function appendScripts(root: Document | DocumentFragment, path: string): boolean {
    for (const el of root.querySelectorAll('*')) {
      if (['base', 'iframe', 'object', 'embed'].includes(el.localName) || el.hasAttribute('http-equiv') ||
          el.getAttributeNames().some(name => /^on/i.test(name))) return false;
      if (el.localName === 'template' && !appendScripts((el as HTMLTemplateElement).content, path)) return false;
      if (el.localName !== 'script') continue;
      const src = el.getAttribute('src');
      if (el.getAttribute('type') === 'module' || (src !== null &&
          (!/^[\w./-]+\.(?:js|mjs|cjs)$/i.test(src) || src.startsWith('/') ||
           !project.exists(resolveVirtualPath(virtualDirname(path), src) ?? '')))) return false;
      const attrs = el.getAttributeNames().filter(name => name !== 'data-hf-id').sort()
        .map(name => [name, el.getAttribute(name)]);
      hash.update(JSON.stringify([path, attrs, el.textContent]));
    }
    return true;
  }
  for (const file of files) {
    if (!/\.html?$/i.test(file.path)) {
      hash.update(JSON.stringify([file.path, file.sha256]));
      continue;
    }
    const source = project.readText(file.path);
    if (source === null || !appendScripts(parseHTMLContent(source), file.path)) return null;
  }
  return hash.digest('hex');
}

export async function verifiedPreviewLiveEdits(project: VirtualProjectReader): Promise<PreviewLiveEdits | undefined> {
  const current = project.readText('index.html');
  if (!current) return;
  // Never inherit over an explicit project declaration. The reviewed digest below
  // must still match this project's actual scripts, including every child composition.
  const entry = current.includes('openmotion-live-edits') ? current : await readBuiltinTemplateEntry(project.templateId);
  if (!entry?.includes('openmotion-live-edits')) return;
  const declarations = parseHTMLContent(entry).head?.querySelectorAll(selector);
  if (declarations?.length !== 1) return;
  const declaration = declarations[0]!;
  const capabilities = declaration.getAttribute('content')?.trim().split(/\s+/).sort();
  if (!capabilities?.length || capabilities.some(name => name !== 'position' && name !== 'mediaTiming')) return;
  const expected = declaration.getAttribute('data-scripts-sha256');
  if (!expected || !/^[0-9a-f]{64}$/.test(expected) ||
      previewBehaviorDigest(project, capabilities.join(' ')) !== expected) return;
  return Object.fromEntries(capabilities.map(name => [name, true]));
}
