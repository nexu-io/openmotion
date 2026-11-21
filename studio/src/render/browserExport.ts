import { CANVAS_DIMENSIONS, type CanvasResolution } from "@hyperframes/parsers";
import type { KeyframeCacheEntry } from "../player/store/keyframeSlice";
import type { TimelineElement } from "../player/store/timelineElement";
import { mediaUrlSourceOptions } from "../player/lib/mediaFetch";
import { fetchMediaCredentials, mixTimelineAudio } from "./audioMixer";
import {
  ISOLATED_PREVIEW_EXPORT_REASON,
  isIsolatedPreviewIframe,
  resolveOriginalPreviewMediaUrl,
} from "./browserExportPreflight";
import {
  captureLiveElementBox,
  capturePreviewLayoutSnapshot,
  findDomElement,
  interpolateElementTransform,
  type ElementLayoutBox,
  type InterpolatedTransform,
} from "./layoutSnapshot";

export type BrowserHtmlCaptureMode = "canvas2d" | "snapdom-cached" | "snapdom-live";

export interface BrowserExportProgress {
  progress: number;
  stage: string;
}

export interface BrowserExportStats {
  htmlMode: BrowserHtmlCaptureMode;
  effectiveFps: number;
  snapdomCaptures: number;
  snapdomTotalMs: number;
  videoDecodeTotalMs: number;
  encodeTotalMs: number;
}

export interface BrowserExportOptions {
  projectId: string;
  format: "mp4" | "webm";
  quality: "draft" | "standard" | "high";
  fps: number;
  resolution?: CanvasResolution | "auto";
  compositionDimensions?: { width: number; height: number } | null;
  duration: number;
  elements: readonly TimelineElement[];
  keyframeCache: ReadonlyMap<string, KeyframeCacheEntry>;
  iframe?: HTMLIFrameElement | null;
  /** Create an isolated hidden iframe for live seek capture so the editor preview stays still. Defaults to true. */
  isolateIframe?: boolean;
  htmlCaptureMode?: BrowserHtmlCaptureMode;
  snapdomEngine?: "svg" | "html-in-canvas";
  signal?: AbortSignal;
  onProgress?: (update: BrowserExportProgress) => void;
}

export interface BrowserExportResult {
  blobUrl: string;
  mimeType: string;
  bytes: number;
  durationMs: number;
  frameCount: number;
  width: number;
  height: number;
  stats?: BrowserExportStats;
}

export function resolveBrowserExportDimensions(
  resolution: CanvasResolution | "auto" | undefined,
  compositionDimensions?: { width: number; height: number } | null,
): { width: number; height: number } {
  const raw =
    resolution && resolution !== "auto" && Object.hasOwn(CANVAS_DIMENSIONS, resolution)
      ? CANVAS_DIMENSIONS[resolution]
      : compositionDimensions && compositionDimensions.width > 0 && compositionDimensions.height > 0
        ? compositionDimensions
        : { width: 1920, height: 1080 };
  // Video encoders (H.264/VP9 YUV420) require even pixel dimensions.
  return {
    width: Math.max(2, Math.floor(raw.width) & ~1),
    height: Math.max(2, Math.floor(raw.height) & ~1),
  };
}

export function resolveBrowserExportBitrate(
  quality: "draft" | "standard" | "high",
  width: number,
  height: number,
  fps: number,
): number {
  const pixelsPerSecond = width * height * fps;
  const bitsPerPixel = quality === "high" ? 0.14 : quality === "draft" ? 0.045 : 0.085;
  return Math.max(400_000, Math.min(40_000_000, Math.round(pixelsPerSecond * bitsPerPixel)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function createRenderCanvas(width: number, height: number): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
} {
  if (typeof globalThis.OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context is unavailable for browser export.");
  return { canvas, ctx };
}

function drawFitted(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  box: { left: number; top: number; width: number; height: number },
  fit: ElementLayoutBox["objectFit"],
): void {
  if (sourceW <= 0 || sourceH <= 0 || box.width <= 0 || box.height <= 0) return;
  if (fit === "fill") {
    ctx.drawImage(source, box.left, box.top, box.width, box.height);
    return;
  }
  const scale =
    fit === "cover"
      ? Math.max(box.width / sourceW, box.height / sourceH)
      : Math.min(box.width / sourceW, box.height / sourceH);
  const drawW = sourceW * scale;
  const drawH = sourceH * scale;
  const dx = box.left + (box.width - drawW) / 2;
  const dy = box.top + (box.height - drawH) / 2;
  if (fit === "cover") {
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.left, box.top, box.width, box.height);
    ctx.clip();
    ctx.drawImage(source, dx, dy, drawW, drawH);
    ctx.restore();
  } else {
    ctx.drawImage(source, dx, dy, drawW, drawH);
  }
}

function drawTextLayer(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  el: TimelineElement,
  box: ElementLayoutBox,
): void {
  const value = el.text?.value ?? el.label ?? "";
  if (!value.trim() && !box.backgroundColor && !el.text?.background) return;

  const bg = el.text?.background ?? box.backgroundColor;
  if (bg) {
    ctx.fillStyle = bg;
    if (box.borderRadius > 0 && typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(box.left, box.top, box.width, box.height, box.borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(box.left, box.top, box.width, box.height);
    }
  }

  if (!value) return;
  const fontFamily = el.text?.fontFamily ?? box.fontFamily;
  const fontWeight = el.text?.fontWeight ?? box.fontWeight;
  ctx.font = `${fontWeight} ${box.fontSize}px ${fontFamily}`;
  ctx.fillStyle = el.text?.color ?? box.color;
  ctx.textAlign = box.textAlign;
  ctx.textBaseline = "top";

  const lines = value.split(/\r?\n/);
  const anchorX =
    box.textAlign === "center"
      ? box.left + box.width / 2
      : box.textAlign === "right" || box.textAlign === "end"
        ? box.left + box.width
        : box.left;
  const totalTextHeight = lines.length * box.lineHeight;
  let y = box.top + Math.max(0, (box.height - totalTextHeight) / 2);
  for (const line of lines) {
    ctx.fillText(line, anchorX, y, Math.max(1, box.width));
    y += box.lineHeight;
  }
}

async function loadImageSource(
  url: string,
  signal?: AbortSignal,
): Promise<{ source: ImageBitmap | HTMLImageElement; width: number; height: number; close: () => void } | null> {
  const response = await fetch(url, { credentials: fetchMediaCredentials(), signal });
  if (!response.ok) return null;
  const blob = await response.blob();
  throwIfAborted(signal);
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`Failed to decode image ${url}`));
      element.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

type SnapdomFn = typeof import("@zumer/snapdom").snapdom;

async function tryLoadSnapdom(): Promise<SnapdomFn | null> {
  try {
    const mod = await import("@zumer/snapdom");
    return typeof mod.snapdom === "function" ? mod.snapdom : null;
  } catch {
    return null;
  }
}

type HfPreviewWindow = Window & {
  __player?: { seek?: (t: number) => void; pause?: () => void };
  __playerReady?: boolean;
  __timelines?: Record<string, { seek?: (t: number) => void }>;
};

const ISOLATED_IFRAME_READY_TIMEOUT_MS = 15_000;

function resolveIframeSourceUrl(iframe: HTMLIFrameElement | null | undefined): string | null {
  if (!iframe) return null;
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
    /* ignore */
  }
  return null;
}

function isSameOriginUrl(rawUrl: string, origin?: string): boolean {
  if (!rawUrl) return false;
  if (!origin || !/^https?:/i.test(origin)) return !/^https?:/i.test(rawUrl);
  try {
    return new URL(rawUrl, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function resolveIsolatablePreviewUrl(
  iframe: HTMLIFrameElement | null | undefined,
  _projectId?: string,
  origin: string | undefined = globalThis.location?.origin,
): string | null {
  // Never downgrade a cookie-less isolated preview iframe (e.g. PREVIEW_PUBLIC_ORIGIN)
  // back onto the authenticated app origin; keep untrusted project scripts isolated.
  if (!iframe || isIsolatedPreviewIframe(iframe, origin)) {
    return null;
  }
  const candidate = resolveIframeSourceUrl(iframe);
  if (candidate && isSameOriginUrl(candidate, origin)) {
    return candidate;
  }
  try {
    const doc = iframe.contentDocument;
    if (doc && doc.URL && doc.URL !== "about:blank" && doc.URL !== "about:srcdoc") {
      return isSameOriginUrl(doc.URL, origin) ? doc.URL : null;
    }
  } catch {
    return null;
  }
  return null;
}

function silenceIframeMedia(doc: Document | null | undefined): void {
  if (!doc) return;
  for (const media of Array.from(doc.querySelectorAll("audio, video"))) {
    const el = media as HTMLMediaElement;
    el.muted = true;
    el.volume = 0;
    try {
      el.pause?.();
    } catch {
      /* ignore */
    }
  }
}

async function createIsolatedExportIframe(options: {
  sourceUrl: string;
  width: number;
  height: number;
  sandbox?: string | null;
  signal?: AbortSignal;
}): Promise<HTMLIFrameElement> {
  const { sourceUrl, width, height, sandbox, signal } = options;
  if (typeof document === "undefined" || !document.body) {
    throw new Error("DOM document is unavailable for isolated export iframe.");
  }
  throwIfAborted(signal);

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("data-openmotion-export-frame", "true");
  frame.tabIndex = -1;
  if (sandbox) {
    frame.setAttribute("sandbox", sandbox);
  }
  // Keep inside viewport with near-zero alpha behind the UI so Chromium does not throttle rAF or canvas paints.
  frame.style.cssText = [
    "position: fixed",
    "left: 0",
    "top: 0",
    `width: ${Math.max(2, Math.round(width))}px`,
    `height: ${Math.max(2, Math.round(height))}px`,
    "border: 0",
    "opacity: 0.001",
    "pointer-events: none",
    "z-index: -1",
  ].join("; ");

  const cleanupFrame = () => {
    try {
      frame.src = "about:blank";
    } catch {
      /* ignore */
    }
    frame.remove();
  };

  try {
    let loaded = false;
    frame.addEventListener("load", () => {
      loaded = true;
    });
    document.body.appendChild(frame);
    frame.src = sourceUrl;

    const deadline = Date.now() + ISOLATED_IFRAME_READY_TIMEOUT_MS;
    while (true) {
      throwIfAborted(signal);
      let win: HfPreviewWindow | null = null;
      let doc: Document | null = null;
      try {
        win = (frame.contentWindow ?? null) as HfPreviewWindow | null;
        doc = frame.contentDocument ?? null;
      } catch {
        win = null;
        doc = null;
      }
      const docUrl = doc?.URL ?? "";
      const hasNavigatedDoc = Boolean(doc && (loaded || (docUrl && docUrl !== "about:blank")));
      const docComplete = hasNavigatedDoc && doc?.readyState === "complete";
      const runtimeReady = Boolean(
        win &&
          (win.__playerReady === true ||
            typeof win.__player?.seek === "function" ||
            (win.__timelines && Object.keys(win.__timelines).length > 0)),
      );
      if (docComplete && runtimeReady) {
        try {
          win?.__player?.pause?.();
        } catch {
          /* ignore */
        }
        silenceIframeMedia(doc);
        await seekIframeTimeline(frame, 0);
        return frame;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for isolated export iframe to boot.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch (error) {
    cleanupFrame();
    throw error;
  }
}

async function seekIframeTimeline(
  iframe: HTMLIFrameElement | null | undefined,
  timeSec: number,
): Promise<void> {
  let win: HfPreviewWindow | null = null;
  try {
    win = (iframe?.contentWindow ?? null) as HfPreviewWindow | null;
  } catch {
    return;
  }
  if (!win) return;
  if (typeof win.__player?.seek === "function") {
    win.__player.seek(timeSec);
  } else if (win.__timelines) {
    for (const tl of Object.values(win.__timelines)) {
      if (typeof tl?.seek === "function") tl.seek(timeSec);
    }
  }
  if (typeof win.requestAnimationFrame === "function") {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      win!.requestAnimationFrame(() => setTimeout(done, 0));
      setTimeout(done, 16);
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function readAuthoredDimensionsFromIframe(
  iframe: HTMLIFrameElement | null | undefined,
): { width: number; height: number } | null {
  try {
    const root = iframe?.contentDocument?.querySelector("[data-composition-id]");
    if (!root) return null;
    const w = Number(root.getAttribute("data-width"));
    const h = Number(root.getAttribute("data-height"));
    return Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

function findDirectCanvasOnlyTarget(domEl: Element): HTMLCanvasElement | null {
  if (domEl.tagName === "CANVAS") return domEl as HTMLCanvasElement;
  const canvases = domEl.querySelectorAll("canvas");
  if (canvases.length !== 1) return null;
  const canvas = canvases[0]!;
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  // Treat wrappers containing only a canvas + layout-ignored/transparent preloads (e.g. hyper-world) as pure canvas layers.
  for (const child of Array.from(domEl.querySelectorAll("*"))) {
    if (child === canvas || child.contains(canvas)) continue;
    if (child.hasAttribute("data-layout-ignore")) continue;
    const style = (child as HTMLElement).style;
    if (style?.opacity === "0" || style?.display === "none" || style?.visibility === "hidden") continue;
    return null;
  }
  return canvas;
}

function isSnapdomHtmlLayer(el: TimelineElement): boolean {
  if (["video", "audio"].includes(el.tag) || ["video", "audio"].includes(el.kind ?? "")) {
    return false;
  }
  if ((el.tag === "img" || el.kind === "image") && Boolean(el.src)) {
    return false;
  }
  return true;
}

function shouldUseLiveHtmlCapture(
  visible: ReadonlyArray<{ el: TimelineElement }>,
  previewDoc: Document | null,
  keyframeCache: ReadonlyMap<string, KeyframeCacheEntry>,
): boolean {
  return visible.some(({ el }) => {
    if (
      el.compositionSrc ||
      el.tag === "hf-composition" ||
      el.tag === "canvas" ||
      el.tag === "svg"
    ) {
      return true;
    }
    if (isSnapdomHtmlLayer(el) && !el.src) {
      if (el.start > 0 || (keyframeCache.get(el.id)?.keyframes.length ?? 0) > 0) {
        return true;
      }
    }
    const domEl = previewDoc ? findDomElement(previewDoc, el) : null;
    if (!domEl) return false;
    if (domEl.querySelector("canvas, svg, [data-composition-id]")) {
      return true;
    }
    if (isSnapdomHtmlLayer(el) && !el.src) {
      const view = previewDoc?.defaultView;
      if (view) {
        const style = view.getComputedStyle(domEl);
        const parsedOpacity = parseFloat(style.opacity);
        const hasCssAnimation = Boolean(style.animationName && style.animationName !== "none");
        const initiallyHidden =
          style.display === "none" ||
          style.visibility === "hidden" ||
          (Number.isFinite(parsedOpacity) && parsedOpacity <= 0);
        if (hasCssAnimation || initiallyHidden) {
          return true;
        }
      }
      if (typeof domEl.getAnimations === "function" && domEl.getAnimations().length > 0) {
        return true;
      }
    }
    return false;
  });
}

export async function runBrowserExport(options: BrowserExportOptions): Promise<BrowserExportResult> {
  const {
    projectId,
    format,
    quality,
    fps,
    resolution,
    compositionDimensions,
    duration,
    elements,
    keyframeCache,
    iframe,
    isolateIframe = true,
    htmlCaptureMode,
    snapdomEngine = "svg",
    signal,
    onProgress,
  } = options;

  const startedAt = Date.now();
  throwIfAborted(signal);
  onProgress?.({ progress: 2, stage: "Preparing browser export" });

  const visible = elements
    .filter((el) => !el.hidden)
    .map((el, index) => ({ el, index }))
    .sort((a, b) => (a.el.zIndex ?? a.el.track ?? 0) - (b.el.zIndex ?? b.el.track ?? 0) || a.index - b.index);

  const mb = await import("mediabunny");
  throwIfAborted(signal);

  const origin = globalThis.location?.origin;
  if (isIsolatedPreviewIframe(iframe, origin)) {
    throw new Error(ISOLATED_PREVIEW_EXPORT_REASON);
  }
  const inputsToDispose: Array<{ dispose: () => void }> = [];
  const bitmapsToClose: Array<() => void> = [];

  type VideoDecoderEntry = {
    sink: InstanceType<typeof mb.CanvasSink>;
    width: number;
    height: number;
    lastCanvas: HTMLCanvasElement | OffscreenCanvas | null;
  };
  const videoDecoders = new Map<string, VideoDecoderEntry>();
  const imageAssets = new Map<string, { source: CanvasImageSource; width: number; height: number }>();
  const snapdomCache = new Map<string, HTMLCanvasElement | null>();

  let previewDoc: Document | null = null;
  try {
    previewDoc = iframe?.contentDocument ?? null;
  } catch {
    previewDoc = null;
  }
  const hasHtmlElements = visible.some(({ el }) => isSnapdomHtmlLayer(el));
  const initialRequiresLiveSeek = shouldUseLiveHtmlCapture(visible, previewDoc, keyframeCache);
  const initialResolvedMode: BrowserHtmlCaptureMode =
    htmlCaptureMode ?? (initialRequiresLiveSeek ? "snapdom-live" : "snapdom-cached");

  let captureIframe: HTMLIFrameElement | null | undefined = iframe;
  let isolatedIframe: HTMLIFrameElement | null = null;
  let snapdomCaptures = 0;
  let snapdomTotalMs = 0;
  let videoDecodeTotalMs = 0;
  let encodeTotalMs = 0;
  let width = 1920;
  let height = 1080;

  let output: InstanceType<typeof mb.Output> | null = null;
  let completed = false;

  try {
    const needsIsolatedSameOriginFrame =
      isolateIframe &&
      hasHtmlElements &&
      initialResolvedMode === "snapdom-live";
    if (needsIsolatedSameOriginFrame) {
      const sourceUrl = resolveIsolatablePreviewUrl(iframe, projectId, origin);
      if (sourceUrl) {
        onProgress?.({ progress: 4, stage: "Preparing isolated render frame" });
        const preliminaryDims = compositionDimensions ?? readAuthoredDimensionsFromIframe(iframe);
        const prelimSize = resolveBrowserExportDimensions(resolution, preliminaryDims);
        const frameWidth = preliminaryDims?.width ?? prelimSize.width;
        const frameHeight = preliminaryDims?.height ?? prelimSize.height;
        try {
          isolatedIframe = await createIsolatedExportIframe({
            sourceUrl,
            width: frameWidth,
            height: frameHeight,
            sandbox: iframe?.getAttribute("sandbox"),
            signal,
          });
          captureIframe = isolatedIframe;
          previewDoc = isolatedIframe.contentDocument ?? previewDoc;
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          // Fall back to the live preview iframe if the background frame fails to boot.
        }
      }
    }

    const effectiveCompDimensions =
      compositionDimensions ?? readAuthoredDimensionsFromIframe(captureIframe) ?? readAuthoredDimensionsFromIframe(iframe);
    ({ width, height } = resolveBrowserExportDimensions(resolution, effectiveCompDimensions));
    const bitrate = resolveBrowserExportBitrate(quality, width, height, fps);

    const requiresLiveSeek = shouldUseLiveHtmlCapture(visible, previewDoc, keyframeCache);
    const resolvedHtmlMode: BrowserHtmlCaptureMode =
      htmlCaptureMode ?? (requiresLiveSeek ? "snapdom-live" : "snapdom-cached");
    const snapdomFn =
      resolvedHtmlMode !== "canvas2d" && previewDoc && hasHtmlElements ? await tryLoadSnapdom() : null;
    const activeHtmlMode: BrowserHtmlCaptureMode = snapdomFn ? resolvedHtmlMode : "canvas2d";

    const layoutSnapshot = capturePreviewLayoutSnapshot(captureIframe, elements, width, height);
    for (const { el } of visible) {
      throwIfAborted(signal);
      if (!el.src) continue;
      const url = resolveOriginalPreviewMediaUrl(el.src, projectId, origin);

      if ((el.tag === "video" || el.kind === "video") && !videoDecoders.has(url)) {
        const { fetchFn, getRetryDelay, cancelReads, maxCacheSize } = mediaUrlSourceOptions("thumbnail");
        const input = new mb.Input({
          source: new mb.UrlSource(url, { fetchFn, getRetryDelay, maxCacheSize }),
          formats: mb.ALL_FORMATS,
        });
        inputsToDispose.push({ dispose: () => { cancelReads(); input.dispose(); } });
        const videoTrack = await input.getPrimaryVideoTrack();
        if (videoTrack) {
          const box = layoutSnapshot.elements.get(el.id);
          const sink = new mb.CanvasSink(videoTrack, {
            width: Math.max(2, Math.round(box?.width ?? width)),
            height: Math.max(2, Math.round(box?.height ?? height)),
            fit: box?.objectFit ?? "contain",
            poolSize: 2,
          });
          videoDecoders.set(url, {
            sink,
            width: videoTrack.displayWidth || width,
            height: videoTrack.displayHeight || height,
            lastCanvas: null,
          });
        }
      } else if ((el.tag === "img" || el.kind === "image") && !imageAssets.has(url)) {
        const loaded = await loadImageSource(url, signal);
        if (loaded) {
          bitmapsToClose.push(loaded.close);
          imageAssets.set(url, { source: loaded.source, width: loaded.width, height: loaded.height });
        }
      }
    }

    onProgress?.({ progress: 8, stage: "Mixing audio" });
    const mixedAudio =
      typeof globalThis.AudioEncoder === "function"
        ? await mixTimelineAudio({ projectId, elements, duration, signal })
        : null;
    throwIfAborted(signal);

    const outputFormat =
      format === "webm"
        ? new mb.WebMOutputFormat()
        : new mb.Mp4OutputFormat({ fastStart: "in-memory" });
    const videoCodec = await mb.getFirstEncodableVideoCodec(outputFormat.getSupportedVideoCodecs(), {
      width,
      height,
      bitrate,
    });
    if (!videoCodec) {
      throw new Error(`No supported WebCodecs video encoder for ${format.toUpperCase()} (${width}×${height}).`);
    }

    const target = new mb.BufferTarget();
    output = new mb.Output({ format: outputFormat, target });

    const { canvas, ctx } = createRenderCanvas(width, height);
    const videoSource = new mb.CanvasSource(canvas, {
      codec: videoCodec,
      bitrate,
      keyFrameInterval: 2,
    });
    output.addVideoTrack(videoSource, { frameRate: fps });

    let audioSource: InstanceType<typeof mb.AudioBufferSource> | null = null;
    if (mixedAudio) {
      const audioCodec = await mb.getFirstEncodableAudioCodec(
        outputFormat.getSupportedAudioCodecs(),
        { numberOfChannels: mixedAudio.audioBuffer.numberOfChannels, sampleRate: mixedAudio.audioBuffer.sampleRate, bitrate: 128_000 },
      );
      if (audioCodec) {
        audioSource = new mb.AudioBufferSource({ codec: audioCodec, bitrate: 128_000 });
        output.addAudioTrack(audioSource);
      }
    }

    await output.start();
    throwIfAborted(signal);

    const totalFrames = Math.max(1, Math.ceil(duration * fps));
    const frameDuration = 1 / fps;

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      throwIfAborted(signal);
      const t = frameIndex * frameDuration;
      if (activeHtmlMode === "snapdom-live" && captureIframe) {
        await seekIframeTimeline(captureIframe, t);
      }

      ctx.fillStyle = layoutSnapshot.backgroundColor;
      ctx.fillRect(0, 0, width, height);

      for (const { el } of visible) {
        if (t < el.start || t >= el.start + el.duration) continue;
        if (el.tag === "audio" || el.kind === "audio") continue;

        const domEl = previewDoc ? findDomElement(previewDoc, el) : null;
        const liveMeasured =
          activeHtmlMode === "snapdom-live" && previewDoc && domEl
            ? captureLiveElementBox(previewDoc, domEl, width, height)
            : null;
        if (liveMeasured && !liveMeasured.visible) continue;

        const box: ElementLayoutBox = liveMeasured?.box ??
          layoutSnapshot.elements.get(el.id) ?? {
            left: 0,
            top: 0,
            width,
            height,
            opacity: 1,
            objectFit: "contain",
            backgroundColor: "",
            color: "white",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: Math.round(height * 0.05),
            fontWeight: "600",
            textAlign: "center",
            lineHeight: Math.round(height * 0.065),
            borderRadius: 0,
          };

        const directCanvas =
          activeHtmlMode === "snapdom-live" && domEl ? findDirectCanvasOnlyTarget(domEl) : null;
        const usesSnapdomCapture = Boolean(
          snapdomFn && previewDoc && isSnapdomHtmlLayer(el) && domEl && !domEl.querySelector("video") && !directCanvas,
        );
        const isLiveMeasured = activeHtmlMode === "snapdom-live" && liveMeasured !== null;
        const clipPct = el.duration > 0 ? ((t - el.start) / el.duration) * 100 : 0;
        let transform: InterpolatedTransform;
        if (isLiveMeasured) {
          // In snapdom-live mode, the seeked DOM is the authoritative visual state:
          // liveMeasured.box already reflects seeked geometry and opacity, and snapdom
          // bakes domEl's computed CSS opacity into its rasterized image. Re-applying
          // keyframe opacity or transforms would double-attenuate or double-offset layers.
          transform = {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: usesSnapdomCapture ? 1 : box.opacity,
          };
        } else {
          // snapdom already bakes domEl's own computed CSS opacity into its rasterized image,
          // whereas directCanvas and fallback draws need ctx.globalAlpha.
          const baseOpacity = usesSnapdomCapture && !keyframeCache.has(el.id) ? 1 : box.opacity;
          transform = interpolateElementTransform(keyframeCache.get(el.id), clipPct, baseOpacity);
        }
        if (transform.opacity <= 0) continue;

        ctx.save();
        ctx.globalAlpha = transform.opacity;
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        if (transform.x !== 0 || transform.y !== 0 || transform.rotationDeg !== 0 || transform.scaleX !== 1 || transform.scaleY !== 1) {
          ctx.translate(cx + transform.x, cy + transform.y);
          if (transform.rotationDeg !== 0) ctx.rotate((transform.rotationDeg * Math.PI) / 180);
          if (transform.scaleX !== 1 || transform.scaleY !== 1) ctx.scale(transform.scaleX, transform.scaleY);
          ctx.translate(-cx, -cy);
        }

        if ((el.tag === "video" || el.kind === "video") && el.src) {
          const url = resolveOriginalPreviewMediaUrl(el.src, projectId, origin);
          const decoder = videoDecoders.get(url);
          if (decoder) {
            const sourceTime = Math.max(0, (el.playbackStart ?? 0) + (t - el.start) * (el.playbackRate ?? 1));
            const tDec0 = performance.now();
            const wrapped = await decoder.sink.getCanvas(sourceTime);
            videoDecodeTotalMs += performance.now() - tDec0;
            const frameSource = wrapped?.canvas ?? decoder.lastCanvas;
            if (wrapped?.canvas) decoder.lastCanvas = wrapped.canvas;
            if (frameSource) {
              drawFitted(ctx, frameSource, frameSource.width, frameSource.height, box, box.objectFit);
            }
          }
        } else if ((el.tag === "img" || el.kind === "image") && el.src) {
          const url = resolveOriginalPreviewMediaUrl(el.src, projectId, origin);
          const asset = imageAssets.get(url);
          if (asset) {
            drawFitted(ctx, asset.source, asset.width, asset.height, box, box.objectFit);
          }
        } else {
          let renderedBySnapdom = false;
          if (snapdomFn && previewDoc && domEl && !domEl.querySelector("video") && isSnapdomHtmlLayer(el)) {
            if (directCanvas) {
              ctx.drawImage(directCanvas, box.left, box.top, box.width, box.height);
              renderedBySnapdom = true;
            } else {
                let captured: HTMLCanvasElement | null | undefined =
                  activeHtmlMode === "snapdom-cached" ? snapdomCache.get(el.id) : undefined;
                if (captured === undefined) {
                  const tSnap0 = performance.now();
                  try {
                    const snapResult = await snapdomFn(domEl, {
                      backgroundColor: null,
                      embedFonts: "auto",
                      fast: true,
                      engine: snapdomEngine,
                      exclude: "video",
                    });
                    const snapCanvas = await snapResult.toCanvas();
                    captured = snapCanvas.width > 0 && snapCanvas.height > 0 ? snapCanvas : null;
                    snapdomCaptures += 1;
                  } catch {
                    captured = null;
                  } finally {
                    snapdomTotalMs += performance.now() - tSnap0;
                  }
                  if (activeHtmlMode === "snapdom-cached") {
                    snapdomCache.set(el.id, captured);
                  }
                }
                if (captured) {
                  ctx.drawImage(captured, box.left, box.top, box.width, box.height);
                  renderedBySnapdom = true;
                }
              }
            }
          if (!renderedBySnapdom && (el.text || !["div", "section"].includes(el.tag) || box.backgroundColor)) {
            if (isLiveMeasured && usesSnapdomCapture) {
              ctx.globalAlpha = box.opacity;
            }
            drawTextLayer(ctx, el, box);
          }
        }

        ctx.restore();
      }

      const tEnc0 = performance.now();
      await videoSource.add(t, frameDuration);
      encodeTotalMs += performance.now() - tEnc0;

      const pct = 10 + Math.round(((frameIndex + 1) / totalFrames) * 82);
      onProgress?.({
        progress: Math.min(92, pct),
        stage: `Capturing frame ${frameIndex + 1}/${totalFrames}`,
      });
      if (frameIndex % 4 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    videoSource.close();
    if (audioSource && mixedAudio) {
      onProgress?.({ progress: 93, stage: "Encoding audio" });
      await audioSource.add(mixedAudio.audioBuffer);
      audioSource.close();
    }

    throwIfAborted(signal);
    onProgress?.({ progress: 96, stage: "Finalizing export" });
    await output.finalize();

    const buffer = target.buffer;
    if (!buffer) throw new Error("Browser export produced an empty output buffer.");

    const mimeType = await output.getMimeType();
    const blob = new Blob([buffer], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    completed = true;
    onProgress?.({ progress: 100, stage: "Completed" });

    const totalDurationMs = Math.max(1, Date.now() - startedAt);
    return {
      blobUrl,
      mimeType,
      bytes: blob.size,
      durationMs: totalDurationMs,
      frameCount: totalFrames,
      width,
      height,
      stats: {
        htmlMode: activeHtmlMode,
        effectiveFps: Number(((totalFrames * 1000) / totalDurationMs).toFixed(2)),
        snapdomCaptures,
        snapdomTotalMs: Math.round(snapdomTotalMs),
        videoDecodeTotalMs: Math.round(videoDecodeTotalMs),
        encodeTotalMs: Math.round(encodeTotalMs),
      },
    };
  } finally {
    if (!completed && output && output.state === "started") {
      await output.cancel().catch(() => {});
    }
    for (const input of inputsToDispose) {
      try {
        input.dispose();
      } catch {
        /* ignore */
      }
    }
    for (const closeBitmap of bitmapsToClose) {
      try {
        closeBitmap();
      } catch {
        /* ignore */
      }
    }
    if (isolatedIframe) {
      try {
        isolatedIframe.src = "about:blank";
      } catch {
        /* ignore */
      }
      isolatedIframe.remove();
    }
  }
}
