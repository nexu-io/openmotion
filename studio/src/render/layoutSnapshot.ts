import type { KeyframeCacheEntry } from "../player/store/keyframeSlice";
import type { TimelineElement } from "../player/store/timelineElement";

export interface ElementLayoutBox {
  left: number;
  top: number;
  width: number;
  height: number;
  opacity: number;
  objectFit: "cover" | "contain" | "fill";
  backgroundColor: string;
  color: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  textAlign: CanvasTextAlign;
  lineHeight: number;
  borderRadius: number;
}

export interface PreviewLayoutSnapshot {
  backgroundColor: string;
  elements: Map<string, ElementLayoutBox>;
}

export interface InterpolatedTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  opacity: number;
}

const DEFAULT_FONT = "Inter, system-ui, -apple-system, sans-serif";

function parseObjectFit(value: string): ElementLayoutBox["objectFit"] {
  if (value === "cover" || value === "fill") return value;
  return "contain";
}

function parseTextAlign(value: string): CanvasTextAlign {
  if (value === "center" || value === "right" || value === "end") return value;
  return "left";
}

function isOpaqueColor(color: string): boolean {
  if (!color || color === "transparent") return false;
  const normalized = color.trim().toLowerCase();
  const match = /^rgba?\(([^)]+)\)$/i.exec(normalized);
  if (!match) return true;
  const parts = (match[1] ?? "").split(/[\s,/]+/).filter(Boolean);
  if (parts.length >= 4 && Number.parseFloat(parts[3] ?? "1") === 0) return false;
  return true;
}

export function findDomElement(doc: Document, el: TimelineElement): Element | null {
  if (el.hfId) {
    const found = doc.querySelector(`[data-hf-id="${CSS.escape(el.hfId)}"]`);
    if (found) return found;
  }
  if (el.domId) {
    const found = doc.getElementById(el.domId);
    if (found) return found;
  }
  if (el.selector) {
    try {
      const matches = doc.querySelectorAll(el.selector);
      const index = el.selectorIndex ?? 0;
      if (index >= 0 && index < matches.length) return matches[index] ?? null;
    } catch {
      /* ignore invalid selector */
    }
  }
  return null;
}

export interface LiveElementBoxResult {
  box: ElementLayoutBox;
  visible: boolean;
}

function measureElementBox(
  view: Window,
  rootRect: DOMRect,
  domEl: Element,
  scaleX: number,
  scaleY: number,
): LiveElementBoxResult {
  const rect = domEl.getBoundingClientRect();
  const style = view.getComputedStyle(domEl);
  const fontSize = Math.max(12, (parseFloat(style.fontSize) || 48) * scaleY);
  const rawLineHeight = parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(rawLineHeight)
    ? rawLineHeight * scaleY
    : fontSize * 1.25;
  const parsedOpacity = parseFloat(style.opacity);
  const opacity = Number.isFinite(parsedOpacity) ? Math.max(0, Math.min(1, parsedOpacity)) : 1;
  const visible =
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    opacity > 0 &&
    rect.width > 0 &&
    rect.height > 0;

  return {
    visible,
    box: {
      left: (rect.left - rootRect.left) * scaleX,
      top: (rect.top - rootRect.top) * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
      opacity,
      objectFit: parseObjectFit(style.objectFit),
      backgroundColor: isOpaqueColor(style.backgroundColor) ? style.backgroundColor : "",
      color: style.color || "white",
      fontFamily: style.fontFamily || DEFAULT_FONT,
      fontSize,
      fontWeight: style.fontWeight || "600",
      textAlign: parseTextAlign(style.textAlign),
      lineHeight,
      borderRadius: (parseFloat(style.borderRadius) || 0) * Math.min(scaleX, scaleY),
    },
  };
}

function getCompositionContext(
  doc: Document | null | undefined,
  targetWidth: number,
  targetHeight: number,
): { view: Window; root: Element; rootRect: DOMRect; scaleX: number; scaleY: number } | null {
  const view = doc?.defaultView;
  if (!doc || !view) return null;
  const root = doc.querySelector("[data-composition-id]");
  if (!root) return null;
  const rootRect = root.getBoundingClientRect();
  if (rootRect.width <= 0 || rootRect.height <= 0) return null;
  return {
    view,
    root,
    rootRect,
    scaleX: targetWidth / rootRect.width,
    scaleY: targetHeight / rootRect.height,
  };
}

/**
 * Snapshot base layout geometry and computed styles from the mounted preview
 * iframe so the experimental Canvas renderer positions elements accurately.
 */
export function capturePreviewLayoutSnapshot(
  iframe: HTMLIFrameElement | null | undefined,
  elements: readonly TimelineElement[],
  targetWidth: number,
  targetHeight: number,
): PreviewLayoutSnapshot {
  const result: PreviewLayoutSnapshot = {
    backgroundColor: "black",
    elements: new Map(),
  };

  let doc: Document | null = null;
  try {
    doc = iframe?.contentDocument ?? null;
  } catch {
    return result;
  }
  const ctx = getCompositionContext(doc, targetWidth, targetHeight);
  if (!doc || !ctx) return result;

  for (let node: Element | null = ctx.root; node; node = node.parentElement) {
    const bg = ctx.view.getComputedStyle(node).backgroundColor;
    if (isOpaqueColor(bg)) {
      result.backgroundColor = bg;
      break;
    }
  }

  for (const el of elements) {
    const domEl = findDomElement(doc, el);
    if (!domEl) continue;
    const { box } = measureElementBox(ctx.view, ctx.rootRect, domEl, ctx.scaleX, ctx.scaleY);
    result.elements.set(el.id, box);
  }

  return result;
}

/**
 * Re-measure a single DOM element at the current seeked timeline timestamp so
 * delayed (`data-start > 0`) sub-compositions and animated boxes stay accurate.
 */
export function captureLiveElementBox(
  doc: Document,
  domEl: Element,
  targetWidth: number,
  targetHeight: number,
): LiveElementBoxResult | null {
  const ctx = getCompositionContext(doc, targetWidth, targetHeight);
  if (!ctx) return null;
  return measureElementBox(ctx.view, ctx.rootRect, domEl, ctx.scaleX, ctx.scaleY);
}

function numericProp(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Evaluate interpolated transform and opacity properties at `clipProgressPct` (0..100)
 * from Studio's keyframe cache.
 */
export function interpolateElementTransform(
  entry: KeyframeCacheEntry | undefined,
  clipProgressPct: number,
  baseOpacity = 1,
): InterpolatedTransform {
  const base: InterpolatedTransform = {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: baseOpacity,
  };
  if (!entry || entry.keyframes.length === 0) return base;

  const pct = Math.max(0, Math.min(100, clipProgressPct));
  const sorted = [...entry.keyframes].sort((a, b) => a.percentage - b.percentage);

  const sampleNumeric = (key: string, fallback: number): number => {
    const frames = sorted
      .map((kf) => ({ pct: kf.percentage, val: numericProp(kf.properties[key]) }))
      .filter((item): item is { pct: number; val: number } => item.val !== undefined);
    if (frames.length === 0) return fallback;
    if (pct <= frames[0]!.pct) return frames[0]!.val;
    const last = frames[frames.length - 1]!;
    if (pct >= last.pct) return last.val;

    for (let i = 0; i < frames.length - 1; i++) {
      const a = frames[i]!;
      const b = frames[i + 1]!;
      if (pct >= a.pct && pct <= b.pct) {
        const span = b.pct - a.pct;
        const alpha = span > 0 ? (pct - a.pct) / span : 0;
        return a.val + (b.val - a.val) * alpha;
      }
    }
    return fallback;
  };

  const uniformScale = sampleNumeric("scale", 1);
  return {
    x: sampleNumeric("x", 0),
    y: sampleNumeric("y", 0),
    scaleX: sampleNumeric("scaleX", uniformScale),
    scaleY: sampleNumeric("scaleY", uniformScale),
    rotationDeg: sampleNumeric("rotation", 0),
    opacity: Math.max(0, Math.min(1, sampleNumeric("opacity", baseOpacity))),
  };
}
