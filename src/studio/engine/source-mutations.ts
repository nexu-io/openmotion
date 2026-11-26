import {
  patchElementInHtml,
  probeElementInSource,
  probeElementsInSource,
  relinkSplitHalvesInHtml,
  removeElementFromHtml,
  removeElementsFromHtml,
  splitElementInHtml,
  unwrapElementsFromHtml,
  wrapElementsInHtml,
  type ElementRebase,
  type PatchOperation,
  type SourceMutationTarget,
  type UnwrapChildTrack,
} from '@hyperframes/studio-server/source-mutation';
import { findUnsafeDomPatchValues } from '@hyperframes/studio-server/finite-mutation';
import { encodeUrlPath } from '@hyperframes/parsers/asset-paths';
export {
  findUnsafeDomPatchValues,
  patchElementInHtml,
  probeElementInSource,
  probeElementsInSource,
  relinkSplitHalvesInHtml,
  removeElementFromHtml,
  removeElementsFromHtml,
  splitElementInHtml,
  unwrapElementsFromHtml,
  wrapElementsInHtml,
  type ElementRebase,
  type PatchOperation,
  type SourceMutationTarget,
  type UnwrapChildTrack,
};

/** Collect all element `id` attributes across a project's HTML files for `ensure-id` deduplication. */
export function collectProjectHtmlIds(htmlByPath: ReadonlyMap<string, string>): Set<string> {
  const ids = new Set<string>();
  const idRe = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  for (const [filePath, html] of htmlByPath) {
    if (!filePath.endsWith('.html') && !filePath.endsWith('.htm')) continue;
    for (const match of html.matchAll(idRe)) {
      const id = (match[1] ?? match[2] ?? '').trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

export { duplicateElementInHtml, unwrapGroupWithGsapCleanup, isStudioFontFaceCss, ensureStudioFontFaceCss } from '../../../packages/edit-core/canvas-source.ts';

export {
  applyAtomicCutsToHtml,
  assertSplittableElementInHtml,
  CANVAS_SPLIT_UNSUPPORTED_MESSAGE,
  type AtomicCutTarget,
} from '../../../packages/edit-core/split.ts';

export { insertCompositionInMemory } from '../../../packages/edit-core/insert-composition.ts';

/**
 * Pure in-memory reference rewriter for file/folder rename (`PATCH /api/projects/:id/files/*`).
 * Updates raw and URL-encoded relative references across HTML/CSS/JS/JSON text files.
 */
export function rewritePathReferencesInText(
  content: string,
  oldPath: string,
  newPath: string,
  isDirectory: boolean,
): string {
  const candidates: Array<[string, string]> = [[oldPath, newPath]];
  const encodedOld = encodeUrlPath(oldPath);
  const encodedNew = encodeUrlPath(newPath);
  if (encodedOld !== oldPath) {
    candidates.push([encodedOld, encodedNew]);
  }

  let out = content;
  for (const [from, to] of candidates) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = isDirectory ? '(?=/)' : '(?=["\'`\\s)?#&;\\\\]|$)';
    const re = new RegExp(`(?<=["'\`(=,\\s/]|^)(\\.\\/)?${escaped}${boundary}`, 'g');
    out = out.replace(re, (_match, dotSlash: string | undefined) => `${dotSlash ?? ''}${to}`);
  }
  return out;
}
