import { usePlayerStore } from "../store/playerStore";
import { compositionPosterSource, MAX_POSTER_SOURCE_LENGTH } from "./compositionPosterSource";
import { createThumbnailKey } from "./thumbnailScheduler";
import { studioApiFetch } from "../../utils/studioApiFetch";
import { buildProjectApiPath, optionalProjectSourceUrl } from "../../utils/projectRouting";
import { IMAGE_EXT, VIDEO_EXT } from "../../utils/mediaTypes";
import { decodeImageThumbnail } from "./thumbnailImageDecoder";
import { decodeVideoThumbnail } from "./thumbnailVideoDecoder";
import type { ThumbnailLoadedResult } from "./thumbnailScheduler";

interface BoxDimensions {
  width?: number;
  height?: number;
}

const DECORATIVE_MEDIA_TOKEN =
  /(?:^|[-_./\s])(avatar|avatars|icon|icons|logo|logos|brand[-_]?mark|wordmark|favicon|badge|emoji|cursor|spinner)(?:$|[-_./\s\d])/i;

/** Strip folder prefix and `.html` extension so fallback labels read as scene names, not raw files. */
export function compositionDisplayName(file: string): string {
  const leaf = file.replace(/^compositions\//i, "").split("/").pop() || file;
  return leaf.replace(/\.html$/i, "").trim() || leaf;
}

/** Resolve only project-owned media. Project templates commonly use root-based assets/ paths. */
function projectMediaUrl(raw: string, projectId: string, file: string): URL | null {
  const source = raw.trim();
  if (!source || /^(?:[a-z][a-z\d+.-]*:|\/\/)|[\\\x00-\x1f]/i.test(source)) return null;
  const base = new URL(buildProjectApiPath(projectId, "/preview/"), window.location.origin);
  const relative = source.startsWith("/") || /^assets\//.test(source)
    ? source.replace(/^\//, "") : file.slice(0, file.lastIndexOf("/") + 1) + source;
  try {
    const url = new URL(relative, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
    const segments = url.pathname.slice(base.pathname.length).split("/").map(decodeURIComponent);
    if (segments.some(part => /[\\/\x00-\x1f]/.test(part) || part === "..")) return null;
    return url;
  } catch {
    return null;
  }
}

function selectContent(html: string, selector: string | null, index: number): ParentNode | null {
  // A template's inert document neither executes scripts nor loads images while inspecting the file.
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content.querySelector("template")?.content ?? template.content;
  if (!selector) return content;
  try {
    return content.querySelectorAll(selector)[index] ?? null;
  } catch {
    return null;
  }
}

function queryAllIn(scope: ParentNode, selector: string): Element[] {
  const matches: Element[] = [];
  if (scope instanceof Element && scope.matches(selector)) matches.push(scope);
  scope.querySelectorAll(selector).forEach((el) => matches.push(el));
  return matches;
}

function parsePx(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(raw);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseStyleBox(declarations: string): BoxDimensions {
  const width = /\bwidth\s*:\s*(\d+(?:\.\d+)?)px\b/i.exec(declarations)?.[1];
  const height = /\bheight\s*:\s*(\d+(?:\.\d+)?)px\b/i.exec(declarations)?.[1];
  return {
    width: width ? Number.parseFloat(width) : undefined,
    height: height ? Number.parseFloat(height) : undefined,
  };
}

function parseStyleDimensionHints(scope: ParentNode): Map<string, BoxDimensions> {
  const hints = new Map<string, BoxDimensions>();
  if (!("querySelectorAll" in scope)) return hints;
  const styles = scope.querySelectorAll("style");
  for (const styleEl of styles) {
    const css = styleEl.textContent ?? "";
    for (const block of css.split("}")) {
      const brace = block.indexOf("{");
      if (brace < 0) continue;
      const box = parseStyleBox(block.slice(brace + 1));
      if (box.width === undefined && box.height === undefined) continue;
      const selectorText = block.slice(0, brace);
      for (const rawSelector of selectorText.split(",")) {
        const key = rawSelector.trim().replace(/\s+/g, " ");
        if (!key) continue;
        const prev = hints.get(key);
        hints.set(key, {
          width: box.width ?? prev?.width,
          height: box.height ?? prev?.height,
        });
      }
    }
  }
  return hints;
}

function selectorKeysFor(el: Element): string[] {
  const keys: string[] = [];
  if (el.id) keys.push(`#${el.id}`);
  for (const cls of el.classList) keys.push(`.${cls}`);
  return keys;
}

function resolveElementBox(el: Element, styleHints: Map<string, BoxDimensions>): BoxDimensions {
  const inline = parseStyleBox(el.getAttribute("style") ?? "");
  let width = inline.width ?? parsePx(el.getAttribute("width"));
  let height = inline.height ?? parsePx(el.getAttribute("height"));

  const applyHint = (key: string) => {
    const hint = styleHints.get(key);
    if (!hint) return;
    if (width === undefined && hint.width !== undefined) width = hint.width;
    if (height === undefined && hint.height !== undefined) height = hint.height;
  };

  for (const key of selectorKeysFor(el)) applyHint(key);
  const parent = el.parentElement;
  if (parent) {
    for (const key of selectorKeysFor(parent)) applyHint(`${key} img`);
    if (width === undefined || height === undefined) {
      const parentInline = parseStyleBox(parent.getAttribute("style") ?? "");
      if (width === undefined) width = parentInline.width;
      if (height === undefined) height = parentInline.height;
      for (const key of selectorKeysFor(parent)) applyHint(key);
    }
  }

  return { width, height };
}

function resolveStageBox(scope: ParentNode): { width: number; height: number } | null {
  const root =
    scope instanceof Element && scope.hasAttribute("data-width")
      ? scope
      : "querySelector" in scope
        ? scope.querySelector("[data-width][data-height], [data-composition-id]")
        : null;
  if (!root) return null;
  const width = parsePx(root.getAttribute("data-width"));
  const height = parsePx(root.getAttribute("data-height"));
  return width && height ? { width, height } : null;
}

function isDecorativeMediaPath(rawSrc: string): boolean {
  const clean = rawSrc.split(/[?#]/)[0] ?? "";
  return DECORATIVE_MEDIA_TOKEN.test(clean);
}

function hasDecorativeMarkers(el: Element, rawSrc: string): boolean {
  if (isDecorativeMediaPath(rawSrc)) return true;
  const tokens = [
    el.id,
    el.getAttribute("class") ?? "",
    el.parentElement?.id ?? "",
    el.parentElement?.getAttribute("class") ?? "",
  ];
  return tokens.some((token) => token.length > 0 && DECORATIVE_MEDIA_TOKEN.test(token));
}

function isSmallInsetImage(
  el: Element,
  stage: { width: number; height: number } | null,
  styleHints: Map<string, BoxDimensions>,
): boolean {
  const { width, height } = resolveElementBox(el, styleHints);
  if (width === undefined && height === undefined) return false;
  const maxDim = Math.max(width ?? 0, height ?? 0);
  const minDim = Math.min(width ?? Infinity, height ?? Infinity);
  if (maxDim <= 96 || minDim <= 64) return true;
  if (stage && width !== undefined && height !== undefined) {
    const areaRatio = (width * height) / (stage.width * stage.height);
    if (areaRatio < 0.08) return true;
  }
  return false;
}

function findRepresentativeMedia(
  scope: ParentNode,
  projectId: string,
  path: string,
): URL | null {
  const stage = resolveStageBox(scope);
  // Videos and video posters are primary scene media; check them before static images.
  for (const video of queryAllIn(scope, "video[poster]")) {
    const poster = video.getAttribute("poster");
    const url = poster ? projectMediaUrl(poster, projectId, path) : null;
    if (url && (IMAGE_EXT.test(url.pathname) || VIDEO_EXT.test(url.pathname))) return url;
  }

  const images = queryAllIn(scope, "img[src]");
  const styleHints = images.length > 0 ? parseStyleDimensionHints(scope) : new Map<string, BoxDimensions>();
  for (const img of images) {
    const src = img.getAttribute("src") ?? "";
    // Skip decorative icons, avatars, wordmarks and small inset graphics when summarizing a scene,
    // while keeping directly targeted <img> elements intact.
    if (img !== scope && (hasDecorativeMarkers(img, src) || isSmallInsetImage(img, stage, styleHints))) {
      continue;
    }
    const url = projectMediaUrl(src, projectId, path);
    if (url && (IMAGE_EXT.test(url.pathname) || VIDEO_EXT.test(url.pathname))) return url;
  }

  for (const video of queryAllIn(scope, "video[src],video source[src]")) {
    const src = video.getAttribute("src");
    const url = src ? projectMediaUrl(src, projectId, path) : null;
    if (url && (IMAGE_EXT.test(url.pathname) || VIDEO_EXT.test(url.pathname))) return url;
  }

  return null;
}

function cleanNodeText(node: ParentNode | null | undefined): string {
  if (!node) return "";
  const clone = node.cloneNode(true) as ParentNode;
  if ("querySelectorAll" in clone) {
    clone.querySelectorAll("script,style,noscript,template").forEach((el) => el.remove());
    clone.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
  }
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

function readVarTextPhrase(el: Element): string {
  const own = cleanNodeText(el);
  if (!own) return "";
  const parent = el.parentElement;
  if (parent && parent.children.length > 1 && parent.children.length <= 4) {
    const parts: string[] = [];
    for (const child of Array.from(parent.children)) {
      if (!child.hasAttribute("data-var-text")) break;
      const text = cleanNodeText(child);
      if (text) parts.push(text);
    }
    const joined = parts.join(" ").trim();
    if (parts.length > 1 && joined.length <= 64) return joined;
  }
  return own;
}

function extractLabel(scope: ParentNode | null, file: string): string {
  if (scope) {
    for (const selector of ["title", "h1"]) {
      for (const el of queryAllIn(scope, selector)) {
        const text = cleanNodeText(el);
        if (text) return text;
      }
    }

    const varNodes = queryAllIn(scope, "[data-var-text]");
    let brandFallback = "";
    for (const el of varNodes) {
      const varName = (el.getAttribute("data-var-text") ?? "").trim().toLowerCase();
      const text = readVarTextPhrase(el);
      if (!text) continue;
      if (varName === "brand") {
        if (!brandFallback) brandFallback = text;
        continue;
      }
      return text;
    }

    for (const el of queryAllIn(scope, "h2,h3")) {
      const text = cleanNodeText(el);
      if (text) return text;
    }

    if (brandFallback) return brandFallback;

    for (const el of queryAllIn(scope, "[aria-label]")) {
      const aria = (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
      if (aria) return aria;
    }

    const bodyText = cleanNodeText(scope);
    if (bodyText) return bodyText;
  }
  return compositionDisplayName(file);
}

function textPoster(label: string): ThumbnailLoadedResult {
  const theme = getComputedStyle(document.documentElement);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 320 180");
  const backdrop = document.createElementNS(svg.namespaceURI, "rect");
  backdrop.setAttribute("width", "320");
  backdrop.setAttribute("height", "180");
  backdrop.setAttribute(
    "fill",
    theme.getPropertyValue("--motion-clip-video").trim() ||
      theme.getPropertyValue("--color-neutral-900").trim() ||
      "Canvas",
  );
  const text = document.createElementNS(svg.namespaceURI, "text");
  text.setAttribute("x", "160");
  text.setAttribute("y", "98");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute(
    "fill",
    theme.getPropertyValue("--motion-on-clip").trim() ||
      theme.getPropertyValue("--color-neutral-100").trim() ||
      "CanvasText",
  );
  text.setAttribute("font-family", "sans-serif");
  text.setAttribute("font-weight", "600");
  const excerpt = Array.from(label).slice(0, 38).join("");
  text.setAttribute("font-size", String(Math.min(28, 380 / Math.max(1, excerpt.length))));
  text.textContent = excerpt;
  svg.append(backdrop, text);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
  return {
    value: { kind: "image", url, aspect: 16 / 9, representative: "text", label },
    weight: 320 * 180 * 4,
    dispose: () => URL.revokeObjectURL(url),
  };
}

/** A representative from this authored composition. No renderer, executable preview or queue is needed. */
export async function loadCloudCompositionPoster(
  url: URL, projectId: string, sessionEpoch: number, signal: AbortSignal,
): Promise<ThumbnailLoadedResult> {
  const prefix = buildProjectApiPath(projectId, "/thumbnail/");
  if (url.origin !== window.location.origin || !url.pathname.startsWith(prefix)) {
    throw new Error("Invalid composition thumbnail URL");
  }
  const path = decodeURIComponent(url.pathname.slice(prefix.length));
  const selector = url.searchParams.get("selector");
  const index = Number(url.searchParams.get("selectorIndex") ?? 0);
  const state = usePlayerStore.getState();
  // Only the live manifest for this project, session, exact authored file and selection is eligible.
  // A persisted edit invalidates the still before the next manifest may arrive.
  const known = Number(url.searchParams.get("revision") ?? 0) === 0 && state.previewBooted && state.timelineProjectId === projectId && state.timelineSessionEpoch === sessionEpoch
    ? state.elements.find(el => el.sourceFile === path && !el.hidden && el.src &&
      (el.tag === "img" || el.tag === "video") &&
      (selector || el.tag !== "img" || !isDecorativeMediaPath(el.src)) &&
      (!selector || (el.selector === selector && (el.selectorIndex ?? 0) === index))) : undefined;
  let media = known?.src ? projectMediaUrl(known.src, projectId, path) : null;
  let label = compositionDisplayName(path);
  if (!media) {
    const revision = Number(url.searchParams.get("revision") ?? 0);
    let content: unknown = compositionPosterSource(state, projectId, sessionEpoch, path, revision);
    if (content === undefined) {
      const response = await studioApiFetch(optionalProjectSourceUrl(projectId, path), { signal, priority: "low" });
      if (!response.ok) throw new Error(`Composition source unavailable (${response.status})`);
      content = (await response.json()).content;
    }
    signal.throwIfAborted();
    const scope = typeof content === "string" && content.length <= MAX_POSTER_SOURCE_LENGTH
      ? selectContent(content, selector, index) : null;
    media = scope ? findRepresentativeMedia(scope, projectId, path) : null;
    label = extractLabel(scope, path);
  }
  if (media && (IMAGE_EXT.test(media.pathname) || VIDEO_EXT.test(media.pathname))) {
    const revision = url.searchParams.get("revision");
    if (revision && revision !== "0") media.searchParams.set("revision", revision);
    // Let the scheduler retry failed media after its error TTL; a failed read is not a permanent text cover.
    if (IMAGE_EXT.test(media.pathname)) return decodeImageThumbnail(media.href, signal);
    return decodeVideoThumbnail({
      source: media.href,
      contentVersion: createThumbnailKey({ project: projectId, session: sessionEpoch }),
      frameCount: 1,
    }, signal);
  }
  return textPoster(label);
}
