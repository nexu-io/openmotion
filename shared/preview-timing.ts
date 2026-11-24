import type { GroupChange } from "./preview-group.ts";
export const MAX_PEER_PREVIEW_SOURCE_LENGTH = 128 * 1024;
export type PreviewLiveEdits = { position?: true; mediaTiming?: true };
export const PREVIEW_ATTRIBUTES = [
  "data-start", "data-end", "data-duration", "data-track-index", "data-playback-start", "data-media-start",
  "data-timeline-locked", "data-hidden", "muted", "data-volume", "loop", "data-playback-rate",
] as const;

/** Only values the player can reproduce from the mounted declarative document. */
export function canPatchPreviewAttribute(name: string, value: unknown, tag: string): boolean {
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
  text?: [string, string];
  /** Remove the verified visual leaf directly owned by this composition. */
  removeFromComposition?: string;
  insert?: VisualClipInsert;
  group?: GroupChange;
  attributes: [typeof PREVIEW_ATTRIBUTES[number], string | null, string | null][];
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
