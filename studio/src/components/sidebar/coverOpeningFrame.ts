export const OPENING_COVER_SEEK_TIME_SECONDS = 0.5;

const SAMPLE_W = 8;
const SAMPLE_H = 6;
const MIN_LUMA_STD_DEV = 8;
const MIN_COLOR_SPREAD = 14;
const MAX_CACHE_ENTRIES = 256;

const openingFrameCache = new Map<string, number>();
const inFlightDetections = new Map<string, Promise<number>>();

function rememberOpeningFrame(key: string, frameIndex: number): number {
  openingFrameCache.delete(key);
  openingFrameCache.set(key, frameIndex);
  while (openingFrameCache.size > MAX_CACHE_ENTRIES) {
    const oldest = openingFrameCache.keys().next().value;
    if (!oldest) break;
    openingFrameCache.delete(oldest);
  }
  return frameIndex;
}

/** Tests only: clear cached opening-frame detection results. */
export function clearOpeningCoverFrameCacheForTest(): void {
  openingFrameCache.clear();
  inFlightDetections.clear();
}

/** Compute luminance std-dev and max-min channel spread across an RGBA sample buffer. */
export function scoreFrameVisualVariance(rgba: Uint8ClampedArray): {
  lumaStdDev: number;
  colorSpread: number;
} {
  const pixelCount = Math.floor(rgba.length / 4);
  if (pixelCount <= 1) return { lumaStdDev: 0, colorSpread: 0 };

  let sum = 0;
  let sumSq = 0;
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;

  for (let i = 0; i < pixelCount * 4; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += luma;
    sumSq += luma * luma;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }

  const mean = sum / pixelCount;
  const variance = Math.max(0, sumSq / pixelCount - mean * mean);
  const colorSpread = Math.max(maxR - minR, maxG - minG, maxB - minB);
  return {
    lumaStdDev: Math.sqrt(variance),
    colorSpread,
  };
}

/** True when a sampled frame contains real visual content rather than a solid blank fade-in. */
export function isFrameVisuallyNonBlank(rgba: Uint8ClampedArray): boolean {
  const { lumaStdDev, colorSpread } = scoreFrameVisualVariance(rgba);
  return lumaStdDev >= MIN_LUMA_STD_DEV || colorSpread >= MIN_COLOR_SPREAD;
}

export function openingFrameCacheKey(
  mediaKey: string,
  minFrame: number,
  maxFrame: number,
): string {
  return `${mediaKey}|${minFrame}|${maxFrame}`;
}

const IMAGE_LOAD_TIMEOUT_MS = 4_000;

export function peekFirstVisibleCoverFrame(key: string): number | null {
  const cached = openingFrameCache.get(key);
  if (cached === undefined) return null;
  openingFrameCache.delete(key);
  openingFrameCache.set(key, cached);
  return cached;
}

function loadHtmlImage(url: string): Promise<HTMLImageElement | null> {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    let settled = false;
    const finish = (result: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), IMAGE_LOAD_TIMEOUT_MS);
    img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

function inspectCanvasImageNonBlank(
  img: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): boolean | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, SAMPLE_W, SAMPLE_H);
    const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    return isFrameVisuallyNonBlank(data);
  } catch {
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Pick the first visually non-blank frame within `[minFrame..maxFrame]` of a packed sprite sheet.
 * Draws the entire sprite once onto a tiny `(cols * 8) x (rows * 6)` offscreen canvas (<0.2ms)
 * so blank black/white opening fade-ins automatically advance to the first real visible shot.
 */
export function detectFirstVisibleSpriteFrame(input: {
  url: string;
  frameCount: number;
  cols: number;
  rows: number;
  minFrame: number;
  maxFrame: number;
}): Promise<number> {
  const safeCount = Math.max(1, Math.floor(input.frameCount || 1));
  const minFrame = Math.max(0, Math.min(safeCount - 1, Math.floor(input.minFrame || 0)));
  const maxFrame = Math.max(minFrame, Math.min(safeCount - 1, Math.floor(input.maxFrame || 0)));
  const key = openingFrameCacheKey(input.url, minFrame, maxFrame);

  const cached = peekFirstVisibleCoverFrame(key);
  if (cached !== null) return Promise.resolve(cached);
  if (minFrame === maxFrame) return Promise.resolve(rememberOpeningFrame(key, minFrame));

  const existing = inFlightDetections.get(key);
  if (existing) return existing;

  const task = (async (): Promise<number> => {
    if (typeof document === "undefined") return minFrame;
    const img = await loadHtmlImage(input.url);
    if (!img) return minFrame;

    const safeCols = Math.max(1, Math.floor(input.cols || safeCount));
    const safeRows = Math.max(1, Math.floor(input.rows || Math.ceil(safeCount / safeCols)));
    const canvas = document.createElement("canvas");
    canvas.width = safeCols * SAMPLE_W;
    canvas.height = safeRows * SAMPLE_H;
    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return minFrame;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (let idx = minFrame; idx <= maxFrame; idx++) {
        const col = idx % safeCols;
        const row = Math.floor(idx / safeCols);
        const rgba = ctx.getImageData(col * SAMPLE_W, row * SAMPLE_H, SAMPLE_W, SAMPLE_H).data;
        if (isFrameVisuallyNonBlank(rgba)) {
          return rememberOpeningFrame(key, idx);
        }
      }
      return rememberOpeningFrame(key, minFrame);
    } catch {
      return minFrame;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  })().finally(() => {
    inFlightDetections.delete(key);
  });

  inFlightDetections.set(key, task);
  return task;
}

/** Pick the first visually non-blank frame within `[minFrame..maxFrame]` of a multi-URL filmstrip. */
export function detectFirstVisibleFilmstripFrame(input: {
  urls: readonly string[];
  minFrame: number;
  maxFrame: number;
}): Promise<number> {
  const safeCount = input.urls.length;
  if (safeCount <= 1) return Promise.resolve(0);
  const minFrame = Math.max(0, Math.min(safeCount - 1, Math.floor(input.minFrame || 0)));
  const maxFrame = Math.max(minFrame, Math.min(safeCount - 1, Math.floor(input.maxFrame || 0)));
  const mediaKey = input.urls.slice(minFrame, maxFrame + 1).join("|");
  const key = openingFrameCacheKey(mediaKey, minFrame, maxFrame);

  const cached = peekFirstVisibleCoverFrame(key);
  if (cached !== null) return Promise.resolve(cached);
  if (minFrame === maxFrame) return Promise.resolve(rememberOpeningFrame(key, minFrame));

  const existing = inFlightDetections.get(key);
  if (existing) return existing;

  const task = (async (): Promise<number> => {
    if (typeof document === "undefined") return minFrame;
    let inspectedAny = false;
    for (let idx = minFrame; idx <= maxFrame; idx++) {
      const url = input.urls[idx];
      if (!url) continue;
      const img = await loadHtmlImage(url);
      if (!img) continue;
      const nonBlank = inspectCanvasImageNonBlank(img, 0, 0, img.naturalWidth, img.naturalHeight);
      if (nonBlank === null) return minFrame;
      inspectedAny = true;
      if (nonBlank) return rememberOpeningFrame(key, idx);
    }
    return inspectedAny ? rememberOpeningFrame(key, minFrame) : minFrame;
  })().finally(() => {
    inFlightDetections.delete(key);
  });

  inFlightDetections.set(key, task);
  return task;
}
