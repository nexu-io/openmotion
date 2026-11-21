import type { TimelineElement } from "../player/store/timelineElement";
import { authoredSrcPath, resolveMediaPreviewUrl } from "../player/components/thumbnailUtils";
import { buildProjectApiPath } from "../utils/projectRouting";

/**
 * Resolve media asset URLs for client-side export, appending `?original=1` on
 * internal `/preview/` routes so cloud deployments serve the full-resolution
 * original CAS object rather than a low-res editing proxy.
 */
export function resolveOriginalPreviewMediaUrl(
  src: string,
  projectId: string,
  origin?: string,
): string {
  const trimmed = src.trim();
  if (!trimmed || /^(?:data:|blob:)/i.test(trimmed)) return trimmed;
  const previewBase = buildProjectApiPath(projectId, "/preview/");
  let url: string;
  try {
    const candidate = new URL(trimmed, origin || "http://studio.local");
    if (candidate.pathname.startsWith(previewBase)) {
      url = trimmed;
    } else {
      url = resolveMediaPreviewUrl(authoredSrcPath(trimmed), projectId, origin);
    }
  } catch {
    url = resolveMediaPreviewUrl(authoredSrcPath(trimmed), projectId, origin);
  }
  if (!url || /^(?:data:|blob:)/i.test(url)) return url;
  try {
    const parsed = new URL(url, origin || "http://studio.local");
    if (
      parsed.pathname.startsWith(previewBase) &&
      !parsed.searchParams.has("original") &&
      !parsed.searchParams.has("raw")
    ) {
      parsed.searchParams.set("original", "1");
      if (/^https?:/i.test(url)) return parsed.toString();
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    /* ignore malformed URL */
  }
  return url;
}

export interface BrowserExportPreflightInput {
  format: "mp4" | "webm" | "mov" | "gif";
  elements: readonly TimelineElement[];
  duration: number;
  webCodecsSupported?: boolean;
  iframe?: HTMLIFrameElement | null;
  origin?: string;
}

export interface BrowserExportPreflightResult {
  eligible: boolean;
  reasons: string[];
  warnings: string[];
}

export const ISOLATED_PREVIEW_EXPORT_REASON =
  "Browser export is unavailable while preview isolation is active.";

function readIframeCandidateUrl(iframe: HTMLIFrameElement): string | null {
  const rawSrc = iframe.getAttribute("src")?.trim() || iframe.src?.trim() || "";
  if (rawSrc && rawSrc !== "about:blank" && rawSrc !== "about:srcdoc") {
    return rawSrc;
  }
  try {
    const docUrl = iframe.contentDocument?.URL?.trim() || "";
    if (docUrl && docUrl !== "about:blank" && docUrl !== "about:srcdoc") {
      return docUrl;
    }
  } catch {
    /* cross-origin access throws; handled by caller */
  }
  return null;
}

/**
 * Returns true when the preview iframe is isolated onto a distinct origin (e.g.
 * cloud `PREVIEW_PUBLIC_ORIGIN`) or an opaque sandbox without `allow-same-origin`.
 * Browser export must refuse such previews rather than reloading untrusted
 * project scripts onto the authenticated app origin.
 */
export function isIsolatedPreviewIframe(
  iframe: HTMLIFrameElement | null | undefined,
  origin: string | undefined = globalThis.location?.origin,
): boolean {
  if (!iframe) return false;
  let doc: Document | null = null;
  try {
    doc = iframe.contentDocument ?? null;
  } catch {
    return true;
  }

  const sandbox = iframe.getAttribute("sandbox");
  if (sandbox !== null) {
    const tokens = new Set(sandbox.trim().toLowerCase().split(/\s+/).filter(Boolean));
    if (!tokens.has("allow-same-origin")) {
      return true;
    }
  }

  const candidate = readIframeCandidateUrl(iframe);
  if (candidate && /^https?:/i.test(candidate)) {
    if (origin && /^https?:/i.test(origin)) {
      try {
        if (new URL(candidate).origin !== new URL(origin).origin) {
          return true;
        }
      } catch {
        return true;
      }
    } else if (doc === null) {
      return true;
    }
  }

  return false;
}

export function isBrowserWebCodecsSupported(): boolean {
  return (
    typeof globalThis.VideoEncoder === "function" &&
    typeof globalThis.VideoFrame === "function"
  );
}

/**
 * Evaluate whether the current composition and browser runtime can execute
 * client-side hardware-accelerated export (WebCodecs + Canvas + Mediabunny).
 */
export function evaluateBrowserExportEligibility({
  format,
  elements,
  duration,
  webCodecsSupported = isBrowserWebCodecsSupported(),
  iframe,
  origin,
}: BrowserExportPreflightInput): BrowserExportPreflightResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (format !== "mp4" && format !== "webm") {
    reasons.push("Browser export only supports MP4 and WebM.");
  }
  if (!webCodecsSupported) {
    reasons.push("WebCodecs VideoEncoder is unavailable in this browser.");
  }
  if (isIsolatedPreviewIframe(iframe, origin)) {
    reasons.push(ISOLATED_PREVIEW_EXPORT_REASON);
  }
  const visible = elements.filter((el) => !el.hidden);
  if (visible.length === 0 || !Number.isFinite(duration) || duration <= 0) {
    reasons.push("No content to export. Add media first.");
  }

  let hasSubComposition = false;
  let hasCustomCanvas = false;
  let hasExternalHtml = false;
  for (const el of visible) {
    if (el.compositionSrc || el.tag === "hf-composition") hasSubComposition = true;
    else if (el.tag === "canvas" || el.tag === "svg") hasCustomCanvas = true;
    else if (!["video", "img", "audio"].includes(el.tag) && !el.text) hasExternalHtml = true;
  }

  if (hasSubComposition) {
    warnings.push("Nested sub-compositions are not flattened in the experimental browser renderer.");
  }
  if (hasCustomCanvas) {
    warnings.push("Custom canvas/SVG procedural graphics may require server export for full fidelity.");
  }
  if (hasExternalHtml) {
    warnings.push("Complex HTML/CSS layers render as simplified layout boxes in the experimental browser renderer.");
  }

  try {
    const doc = iframe?.contentDocument;
    if (doc && doc.querySelector("canvas[data-hf-3d]")) {
      warnings.push("3D WebGL scenes require server export for full fidelity.");
    }
  } catch {
    /* ignore cross-origin or detached iframe */
  }

  return { eligible: reasons.length === 0, reasons, warnings };
}
