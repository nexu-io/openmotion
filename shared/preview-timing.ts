import type { GroupChange } from "./preview-group.ts";
export type PreviewLiveEdits = { position?: true; mediaTiming?: true; audioTrimV1?: true; presentation?: true; cssLayoutOffset?: true };
export const PREVIEW_ATTRIBUTES = [
  "data-start", "data-end", "data-duration", "data-track-index", "data-playback-start", "data-media-start",
  "data-timeline-locked", "data-hidden", "muted", "data-volume", "loop", "data-playback-rate", "data-color-grading",
] as const;

/** Only values the player can reproduce from the mounted declarative document. */
export function canPatchPreviewAttribute(name: string, value: unknown, tag: string): boolean {
  if (name === "data-color-grading") return (tag === "img" || tag === "video") && (value === null || typeof value === "string");
  if (["muted", "data-volume", "loop", "data-playback-rate"].includes(name) && tag !== "audio" && tag !== "video") return false;
  if (value === null) return true;
  if (typeof value !== "string") return false;
  if (name === "data-timeline-locked" || name === "data-hidden" || name === "muted" || name === "loop") {
    return value === "" || value === "true" || value === name;
  }
  if (name === "data-playback-rate" && Number(value) <= 0) return false;
  return /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && (name !== "data-volume" || Number(value) <= 1);
}

// Properties set directly by the inspector or by the positioning gesture.
export const PRESENTATION_STYLES = ["position", "left", "top", "width", "height", "font-size", "font-weight", "font-family", "text-align", "color", "background-color", "background-image", "object-fit", "opacity", "translate"] as const;
/** Solid fills clear the image layer; canvas moves produce a one- or two-axis pixel offset. */
export function canPatchPresentationValue(name: string, value: string): boolean {
  if (name === "background-image") return value === "none" || value === "";
  if (name === "object-fit") return ["", "fill", "contain", "cover", "none", "scale-down"].includes(value);
  if (name === "translate") return value === "" || value === "none" || /^-?(?:\d+\.?\d*|\.\d+)px(?: -?(?:\d+\.?\d*|\.\d+)px)?$/.test(value);
  return true;
}
export const PRESENTATION_TAGS = ["div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6"] as const;
export const MAX_PREVIEW_TEXT_LENGTH = 4096;

/** Newlines in a text node and authored BR elements have different layout and identity. */
export type PreviewText = string | { lines: string[]; breaks: (string | null)[] };

export function validPreviewText(value: PreviewText): boolean {
  if (typeof value === 'string') return value.length <= MAX_PREVIEW_TEXT_LENGTH;
  if (!value || !Array.isArray(value.lines) || !Array.isArray(value.breaks) || !value.breaks.length ||
      value.breaks.length > 64 || value.lines.length !== value.breaks.length + 1) return false;
  let length = value.breaks.length;
  for (const line of value.lines) {
    if (typeof line !== 'string' || (length += line.length) > MAX_PREVIEW_TEXT_LENGTH) return false;
  }
  const ids = new Set<string>();
  for (const id of value.breaks) {
    if (id === null) continue;
    if (typeof id !== 'string' || !/^hf-[a-z0-9]{4}$/.test(id) || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

export function readPreviewText(node: Element): PreviewText | null {
  const lines = [''], breaks: (string | null)[] = [];
  let length = 0;
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const text = child.nodeValue ?? '';
      if ((length += text.length) > MAX_PREVIEW_TEXT_LENGTH) return null;
      lines[lines.length - 1] += text;
    } else {
      const br = child as Element;
      if (br.nodeType !== 1 || br.localName !== 'br' || br.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
          br.firstChild || br.attributes.length > Number(br.hasAttribute('data-hf-id')) || breaks.length === 64) return null;
      breaks.push(br.getAttribute('data-hf-id'));
      lines.push('');
    }
  }
  const value = breaks.length ? { lines, breaks } : lines[0]!;
  return validPreviewText(value) ? value : null;
}

export function samePreviewText(a: PreviewText, b: PreviewText): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.breaks.length === b.breaks.length && a.lines.every((line, i) => line === b.lines[i]) &&
    a.breaks.every((id, i) => id === b.breaks[i]);
}

/** The bundler preserves identified, numeric, direct visual leaves. No executable markup crosses the bridge. */
export type VisualClipInsert = {
  owner: string;
  next: string | null;
  whitespace: [before: string, left: string, right: string];
  attrs: [name: string, value: string][];
  text: string;
};

export interface PreviewChange {
  hfId: string | null;
  id: string;
  compositionId: string | null;
  tag: string;
  styles?: [typeof PRESENTATION_STYLES[number], string, string][];
  /** A first canvas move captures the author's translate for Reset; undo removes the marker. */
  captureOriginalTranslate?: boolean;
  text?: [PreviewText, PreviewText];
  /** Remove the verified visual leaf directly owned by this composition. */
  removeFromComposition?: string;
  insert?: VisualClipInsert;
  group?: GroupChange;
  attributes: [typeof PREVIEW_ATTRIBUTES[number], string | null, string | null][];
}

export function isGradeOnlyChange(change: PreviewChange): boolean {
  return (change?.tag === 'img' || change?.tag === 'video') && !change.styles && !change.text &&
    !change.group && !change.insert && !change.removeFromComposition &&
    Array.isArray(change.attributes) && change.attributes.length === 1 && change.attributes[0]?.[0] === 'data-color-grading';
}

/** Source-verified text and inline styles can paint without restarting or rebinding arbitrary scripts. */
export function isAuthoredPresentation(changes: PreviewChange[]): boolean {
  return Array.isArray(changes) && changes.length > 0 && changes.every(change =>
    !!change && !change.group && !change.insert && !change.removeFromComposition &&
    Array.isArray(change.attributes) && !change.attributes.length && !!(change.styles?.length || change.text));
}

/** Used by Studio and the isolated bridge to validate the complete set of changes. */
export function isLivePositionEdit(changes: PreviewChange[]): boolean {
  return Array.isArray(changes) && changes.length > 0 && changes.every(change => {
    if (change?.text || !Array.isArray(change?.attributes) || change.attributes.length ||
        !Array.isArray(change.styles) || !change.styles.length) return false;
    let hasOffset = false;
    for (const style of change.styles) {
      if (!Array.isArray(style) || style.length !== 3) return false;
      const [name, from, to] = style;
      // A first drag promotes a static leaf to relative positioning so its offsets take effect.
      if (name === "position" && ((from === "" || from === "static") && to === "relative" ||
          from === "relative" && (to === "" || to === "static"))) continue;
      if ((name !== "left" && name !== "top") || ![from, to].every(value =>
        typeof value === "string" && (value === "" || /^-?(?:\d+\.?\d*|\.\d+)px$/.test(value)))) return false;
      hasOffset = true;
    }
    return hasOffset;
  });
}

/** The subset that can be drawn and reversed without running authored scripts. */
export function isHistoryGeometry(changes: PreviewChange[]): boolean {
  return Array.isArray(changes) && changes.length > 0 && changes.every(c =>
    c && !c.insert && !c.group && !c.removeFromComposition && !c.text && Array.isArray(c.attributes) &&
    (c.styles ? c.attributes.length === 0 && (isLivePositionEdit([c]) || isPixelBoxChange(c, true)) :
      c.attributes.length > 0 && c.attributes.every(a => Array.isArray(a) &&
        ["data-start", "data-end", "data-duration", "data-track-index", "data-playback-start", "data-media-start"].includes(a[0]))));
}

/** An identified DOM box can keep its descendants and handlers when only pixel geometry changes. */
export function isPixelBoxChange(change: PreviewChange, cssLayoutOffset = false): boolean {
  return !!change && !change.text && !change.insert && !change.group && !change.removeFromComposition &&
    change.captureOriginalTranslate === undefined && Array.isArray(change.attributes) && !change.attributes.length &&
    Array.isArray(change.styles) && change.styles.length > 0 && change.styles.every(style => {
      if (!Array.isArray(style) || style.length !== 3) return false;
      const [name, from, to] = style;
      if (cssLayoutOffset && name === "translate")
        return [from, to].every(value => typeof value === "string" && canPatchPresentationValue(name, value));
      return ["left", "top", "width", "height"].includes(name) &&
        [from, to].every(value => typeof value === "string" && (value === "" || /^-?(?:\d+\.?\d*|\.\d+)px$/.test(value)));
    });
}

/** A pinned nested source can confirm a caption together with its intervening pixel placements. */
export function isMountedCaptionBatch(changes: PreviewChange[], allowPosition: boolean, cssOffset: boolean): boolean {
  return Array.isArray(changes) && changes.some(c => c?.text) && changes.every(c => {
    if (!c || !Array.isArray(c.attributes) || c.attributes.length || c.insert || c.group || c.removeFromComposition ||
        c.captureOriginalTranslate !== undefined) return false;
    if (c.text && (!(PRESENTATION_TAGS as readonly string[]).includes(c.tag) || !Array.isArray(c.text) ||
        c.text.length !== 2 || !validPreviewText(c.text[0]) || !validPreviewText(c.text[1]))) return false;
    if (!c.styles) return !!c.text;
    if (!Array.isArray(c.styles) || !c.styles.length) return false;
    // A first move of a static box may also establish its relative position.
    const geometry = { ...c, text: undefined };
    if (isPixelBoxChange(geometry, cssOffset)) return true;
    if (!allowPosition) return false;
    const dimensions = c.styles.filter(([key]) => key === 'height' || key === 'width');
    const move = c.styles.filter(([key]) => key !== 'height' && key !== 'width');
    return isLivePositionEdit([{ ...geometry, styles: move }]) &&
      (!dimensions.length || isPixelBoxChange({ ...geometry, styles: dimensions }));
  });
}

/** These inline style changes leave the measured box, hierarchy and source coordinates intact. */
export function isPaintOnlyChange(change: PreviewChange): boolean {
  return !!change && !change.text && !change.insert && !change.removeFromComposition && Array.isArray(change.attributes) && !change.attributes.length &&
    Array.isArray(change.styles) && change.styles.length > 0 && change.styles.every(style => Array.isArray(style) && (["opacity", "color", "background-color", "object-fit"].includes(style[0]) ||
      (style[0] === "background-image" && [style[1], style[2]].every(value => value === "" || value === "none"))));
}

/** A media element's measured CSS box can be updated without replacing its drawing buffer or decoder. */
export function isMediaBoxChange(change: PreviewChange): boolean {
  return !!change && ["canvas", "img", "video"].includes(change.tag) && Array.isArray(change.attributes) && !change.attributes.length &&
    !change.text && !change.insert && !change.removeFromComposition && Array.isArray(change.styles) && change.styles.length > 0 &&
    change.styles.every(style => {
      if (!Array.isArray(style)) return false;
      const [name, from, to] = style;
      if (["color", "background-color", "opacity"].includes(name)) return true;
      if (name === "position") return (!from || from === "static") && to === "relative";
      return ["left", "top", "width", "height"].includes(name) &&
        [from, to].every(value => value === "" || /^-?(?:\d+\.?\d*|\.\d+)px$/.test(value));
    });
}
