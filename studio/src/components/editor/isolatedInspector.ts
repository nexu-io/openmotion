import type { PreviewAdapter } from "../../player/lib/previewAdapter";
import { relativeLayerBounds } from "./isolatedLayerBounds";
import { resolveDomEditCapabilities } from "./domEditingLayers";
import { CURATED_STYLE_PROPERTIES, type DomEditSelection } from "./domEditingTypes";
import { isInlineTextTarget, type InlineTextTarget } from "./isolatedInlineTextPatch";

interface InspectorSnapshot extends InlineTextTarget {
  tag: string;
  geometry: DomEditSelection["boundingBox"];
  viewport?: { width: number; height: number };
  clipOwner?: DomEditSelection["isolatedClipOwner"];
  layoutBox?: DomEditSelection["boundingBox"] | null;
  inline: Record<string, string>;
  computed: Record<string, string>;
  data: Record<string, string>;
  leafText: string | null;
  lineBreaks?: boolean;
  compositionHost: boolean;
  compositionRoot: boolean;
  locked: boolean;
  muted: boolean;
  loop: boolean;
  src?: string;
  intrinsicMediaDuration?: number;
}

type Identity = { elementId?: string | null; hfId?: string | null; sourceFile?: string };

const identityString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;

function plainMap(input: unknown, allowed: (key: string) => boolean, limit: number) {
  return Object.fromEntries(Object.entries(input && typeof input === "object" ? input : {}).slice(0, 64)
    .filter(([key, value]) => allowed(key) && typeof value === "string" && value.length <= limit));
}

export async function inspectIsolatedElement(adapter: PreviewAdapter, identity: Identity, isMasterView: boolean) {
  if (!identity.elementId && !identity.hfId) return null;
  const snapshot = await adapter.request<InspectorSnapshot | null | undefined>("inspect-element", {
    elementId: identity.elementId, hfId: identity.hfId, sourceFile: identity.sourceFile, properties: CURATED_STYLE_PROPERTIES,
  }).catch(() => undefined);
  if (snapshot === undefined) return undefined;
  if (!snapshot || !isInlineTextTarget(snapshot) || [snapshot.hfId, snapshot.elementId].some(id => id != null && !identityString(id)) || (identity.elementId && snapshot.elementId !== identity.elementId) ||
      (identity.hfId && snapshot.hfId !== identity.hfId) || (identity.sourceFile && snapshot.sourceFile !== identity.sourceFile)) return null;
  const { tag, geometry, sourceFile, hfId, elementId: id } = snapshot;
  if (typeof tag !== "string" || !/^[a-z][a-z0-9]{0,30}$/.test(tag) || !geometry ||
      ![geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite)) return null;

  // The shared inspector reads native tag/attribute facts. Keep its surrogate
  // in a non-browsing document; never parse frame markup or adopt the node.
  const element = document.implementation.createHTMLDocument().createElement(
    tag === "img" || tag === "video" || tag === "audio" ? tag : "div");
  const selector = hfId ? '[data-hf-id="' + CSS.escape(hfId) + '"]' : "#" + CSS.escape(id!);
  if (id) element.id = id;
  if (hfId) element.setAttribute("data-hf-id", hfId);
  const dataAttributes = plainMap(snapshot.data, key => /^[a-z][a-z0-9-]{0,63}$/.test(key), 8192);
  for (const [key, value] of Object.entries(dataAttributes)) element.setAttribute("data-" + key, value);
  if (snapshot.loop === true) element.setAttribute("loop", "");
  if (snapshot.muted === true) element.setAttribute("muted", "");
  if (typeof snapshot.src === "string" && /^[\w.-]+(?:\/[\w. -]+)*$/.test(snapshot.src)) element.setAttribute("src", snapshot.src);
  const curated = (name: string) => (CURATED_STYLE_PROPERTIES as readonly string[]).includes(name);
  const inlineStyles = plainMap(snapshot.inline, curated, 2048), computedStyles = plainMap(snapshot.computed, curated, 2048);
  const textContent = typeof snapshot.leafText === "string" && snapshot.leafText.length <= 16384 ? snapshot.leafText : null;
  element.textContent = textContent;
  const flags = { isCompositionHost: snapshot.compositionHost === true, isInsideLockedComposition: snapshot.locked === true };
  const owner = snapshot.clipOwner;
  const isolatedClipOwner = owner && identityString(owner.sourceFile) && (owner.id || owner.hfId) &&
    [owner.id, owner.hfId].every(id => id == null || identityString(id)) ? owner : undefined;
  const box = snapshot.layoutBox;
  const isolatedLayoutBox = box && [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.width >= 0 && box.height >= 0 ? box : undefined;
  return {
    intrinsicMediaDuration: typeof snapshot.intrinsicMediaDuration === "number" && Number.isFinite(snapshot.intrinsicMediaDuration) && snapshot.intrinsicMediaDuration > 0
      ? snapshot.intrinsicMediaDuration : undefined,
    element, id: id || undefined, hfId: hfId || undefined, selector, sourceFile, compositionPath: sourceFile,
    label: id || hfId || tag, isolatedClipOwner, tagName: tag, ...flags, boundingBox: geometry, isolatedBounds: relativeLayerBounds(snapshot) ?? undefined, isolatedLayoutBox, inlineStyles, computedStyles, dataAttributes,
    existsInSource: true, textContent, isolatedTarget: { sourceFile, sha256: snapshot.sha256, ...(snapshot.fileVersion && {fileVersion: snapshot.fileVersion}), elementId: id, hfId, binding: snapshot.binding },
    textFields: textContent === null ? [] : [{ key: "self", label: "Text", value: textContent, tagName: tag,
      attributes: [], inlineStyles, computedStyles, preserveLineBreaks: snapshot.lineBreaks === true, source: "self" as const }],
    capabilities: resolveDomEditCapabilities({ ...flags, selector, tagName: tag, inlineStyles, computedStyles,
      isCompositionRoot: snapshot.compositionRoot === true, isMasterView }),
  } satisfies DomEditSelection;
}
