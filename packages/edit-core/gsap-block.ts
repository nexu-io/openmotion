import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import { findTimelineScript } from '@hyperframes/parsers/gsap-parser-acorn';
import { clipQueryRoot } from '@hyperframes/parsers/gsap-writer-acorn';
import { scanHtmlOpeningTags } from '@hyperframes/parsers/html-attribute-spans';

const studioTransformAttributes = ['data-hf-studio-path-offset', 'data-hf-studio-rotation'];

export function hasStudioTransform(element: Element): boolean {
  return studioTransformAttributes.some(name => element.hasAttribute(name));
}

export interface ExtractedGsapBlock {
  scriptText: string;
  document: Document;
  root: ParentNode;
  replaceScript(newText: string, clearTransforms?: ReadonlySet<Element>): string;
}

export function extractGsapScriptBlock(html: string): ExtractedGsapBlock | null {
  const document = parseHTMLContent(html);
  const scripts = [
    ...Array.from(document.querySelectorAll('script:not([src])')),
    ...Array.from(document.querySelectorAll('template')).flatMap((tmpl) =>
      Array.from(tmpl.querySelectorAll('script:not([src])')),
    ),
  ];
  const script = findTimelineScript(scripts);
  if (!script) return null;
  const scriptText = script.textContent || '';
  return {
    scriptText,
    document,
    root: clipQueryRoot(script),
    replaceScript(newText, clearTransforms): string {
      const tags = scanHtmlOpeningTags(html);
      if (!clearTransforms?.size) {
        const matching = tags.filter(tag => tag.name === 'script' && tag.rawTextEnd !== null &&
          !tag.attributes.some(attr => attr.name === 'src') && html.slice(tag.end, tag.rawTextEnd) === scriptText);
        if (matching.length === 1) {
          const tag = matching[0]!;
          return html.slice(0, tag.end) + newText + html.slice(tag.rawTextEnd!);
        }
      }

      // Linkedom's tree walker includes template children in authored order.
      // Use that order for identical scripts and for legacy inline offsets that must be removed.
      const candidates = tags.filter(tag => tag.name === 'script' ||
        (clearTransforms?.size && tag.attributes.some(attr => studioTransformAttributes.includes(attr.name))));
      const walker = document.createTreeWalker(document, 1 /* SHOW_ELEMENT */);
      let index = 0;
      let cursor = 0;
      let output = '';
      let remaining = 1 + (clearTransforms?.size ?? 0);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node as Element;
        if (el.localName !== 'script' && !(clearTransforms?.size && hasStudioTransform(el))) continue;
        const tag = candidates[index++];
        if (!tag || tag.name !== el.localName.toLowerCase()) break;
        if (clearTransforms?.has(el)) {
          for (const attr of tag.attributes) {
            if (!studioTransformAttributes.includes(attr.name)) continue;
            let start = attr.start;
            while (start > cursor && /[ \t\n\r\f]/.test(html[start - 1]!)) start--;
            output += html.slice(cursor, start);
            cursor = attr.end;
          }
          remaining--;
        }
        if (el === script) {
          if (tag.rawTextEnd === null || html.slice(tag.end, tag.rawTextEnd) !== scriptText) break;
          output += html.slice(cursor, tag.end) + newText;
          cursor = tag.rawTextEnd;
          remaining--;
        }
        if (remaining === 0) return output + html.slice(cursor);
      }
      throw new Error('Cannot locate the selected animation edits in the source HTML.');
    },
  };
}
