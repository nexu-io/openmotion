import { studioApiFetch } from "../../utils/studioApiFetch";
import { waitForMediaDerived } from "../../utils/mediaDerivedBus";

export interface SpriteSheetInfo {
  index: number;
  url: string;
  startFrame: number;
  frameCount: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
}

export interface SpriteManifestData {
  version: 1;
  sha256: string;
  durationSec: number;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  intervalSec: number;
  columns: number;
  rows: number;
  sheets: SpriteSheetInfo[];
}

export interface SpriteFrameSlice {
  sheetUrl: string;
  backgroundSize: string;
  backgroundPosition: string;
}

const manifestCache = new Map<string, SpriteManifestData>();
const inflightManifests = new Map<string, Promise<SpriteManifestData | null>>();
const unavailableSprites = new Set<string>();
const preloadedSheetUrls = new Set<string>();

/** Convert a same-origin `/api/projects/:id/preview/*` URL into its `/sprite/*` endpoint. */
export function resolveSpriteManifestUrl(videoSrc: string): string | null {
  if (!videoSrc || typeof window === "undefined") return null;
  try {
    const url = new URL(videoSrc, window.location.href);
    if (url.origin !== window.location.origin) return null;
    if (!/^\/api\/projects\/[^/]+\/preview\/.+/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/^(\/api\/projects\/[^/]+)\/preview\//, "$1/sprite/");
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

/** Convert a same-origin `/api/projects/:id/preview/*` URL into its `/image-thumbnail/*?w=320` endpoint. */
export function resolveVideoPosterUrl(videoSrc: string, width = 320): string | null {
  if (!videoSrc || typeof window === "undefined") return null;
  try {
    const url = new URL(videoSrc, window.location.href);
    if (url.origin !== window.location.origin) return null;
    if (!/^\/api\/projects\/[^/]+\/preview\/.+/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/^(\/api\/projects\/[^/]+)\/preview\//, "$1/image-thumbnail/");
    url.searchParams.set("w", String(width));
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

export function clearSpriteCache(): void {
  manifestCache.clear();
  inflightManifests.clear();
  unavailableSprites.clear();
  preloadedSheetUrls.clear();
}

function isValidSpriteManifest(value: unknown): value is SpriteManifestData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SpriteManifestData>;
  return (
    candidate.version === 1 &&
    typeof candidate.frameCount === "number" &&
    candidate.frameCount > 0 &&
    typeof candidate.frameWidth === "number" &&
    candidate.frameWidth > 0 &&
    typeof candidate.frameHeight === "number" &&
    candidate.frameHeight > 0 &&
    typeof candidate.intervalSec === "number" &&
    candidate.intervalSec > 0 &&
    Array.isArray(candidate.sheets) &&
    candidate.sheets.length > 0 &&
    candidate.sheets.every(
      (s) =>
        s &&
        typeof s.url === "string" &&
        s.url.length > 0 &&
        typeof s.columns === "number" &&
        s.columns > 0 &&
        typeof s.rows === "number" &&
        s.rows > 0,
    )
  );
}

function preloadSheetImage(url: string, signal: AbortSignal): Promise<boolean> {
  if (preloadedSheetUrls.has(url) || typeof Image === "undefined") {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const img = new Image();
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      img.src = "";
      resolve(false);
    };
    if (signal.aborted) {
      resolve(false);
      return;
    }
    img.onload = () => {
      cleanup();
      preloadedSheetUrls.add(url);
      resolve(true);
    };
    img.onerror = () => {
      cleanup();
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    img.src = url;
  });
}

async function fetchSpriteManifestLoop(
  spriteUrl: string,
  signal: AbortSignal,
): Promise<SpriteManifestData | null> {
  const maxAttempts = 12;
  let delayMs = 500;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal.aborted) return null;
    const res = await studioApiFetch(spriteUrl, { signal });
    if (res.status === 200) {
      const data: unknown = await res.json().catch(() => null);
      if (!isValidSpriteManifest(data)) return null;
      // Preload first sheet so CSS background-image paints cleanly without blink.
      const loaded = await preloadSheetImage(data.sheets[0].url, signal);
      if (signal.aborted) return null;
      if (!loaded) return null;
      // Warm remaining sheets (at most 1 extra sheet for >60s videos) in the background.
      for (let i = 1; i < data.sheets.length; i += 1) {
        void preloadSheetImage(data.sheets[i].url, signal);
      }
      manifestCache.set(spriteUrl, data);
      return data;
    }

    if (res.status === 202) {
      const pendingBody = (await res.json().catch(() => null)) as { sha256?: string } | null;
      const expectedSha = typeof pendingBody?.sha256 === "string" ? pendingBody.sha256 : undefined;
      const sseEvent = await waitForMediaDerived(
        (evt) => evt.kind === "sprite" && (!expectedSha || evt.sha256 === expectedSha),
        delayMs,
        signal,
      ).catch(() => null);
      if (signal.aborted) return null;
      if (sseEvent?.status === "failed") {
        unavailableSprites.add(spriteUrl);
        return null;
      }
      delayMs = Math.min(4000, Math.round(delayMs * 1.7));
      continue;
    }

    // 404 / 405 / 501 / 5xx -> fall back immediately to client decoder without retry loops.
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      unavailableSprites.add(spriteUrl);
    }
    return null;
  }

  return null;
}

/**
 * Load (or wait via `media-derived-ready` SSE + backoff) for a cloud video's WebP sprite manifest.
 * Returns `null` when unavailable/failed so callers can fall back seamlessly to client decoding.
 */
export function loadSpriteManifest(
  spriteUrl: string,
  signal: AbortSignal,
): Promise<SpriteManifestData | null> {
  const cached = manifestCache.get(spriteUrl);
  if (cached) return Promise.resolve(cached);
  if (unavailableSprites.has(spriteUrl)) return Promise.resolve(null);

  const existing = inflightManifests.get(spriteUrl);
  if (existing) return existing;

  const controller = new AbortController();
  const promise = fetchSpriteManifestLoop(spriteUrl, controller.signal)
    .catch(() => null)
    .finally(() => {
      if (inflightManifests.get(spriteUrl) === promise) {
        inflightManifests.delete(spriteUrl);
      }
    });
  inflightManifests.set(spriteUrl, promise);

  if (signal.aborted) return Promise.resolve(null);
  return new Promise<SpriteManifestData | null>((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((result) => {
      signal.removeEventListener("abort", onAbort);
      resolve(signal.aborted ? null : result);
    });
  });
}

/**
 * Pure CSS `background-size` / `background-position` calculation for rendering a single
 * `object-cover` frame tile from a WebP sprite sheet at timestamp `timeSec`.
 */
export function computeSpriteFrameSlice(
  manifest: SpriteManifestData,
  timeSec: number,
  tileWidth: number,
  tileHeight: number,
): SpriteFrameSlice {
  const clampedTime = Math.max(0, Math.min(manifest.durationSec, Number.isFinite(timeSec) ? timeSec : 0));
  const rawFrame = Math.floor(clampedTime / Math.max(manifest.intervalSec, 0.001));
  const frameIndex = Math.max(0, Math.min(manifest.frameCount - 1, rawFrame));

  let sheet = manifest.sheets[manifest.sheets.length - 1];
  for (const candidate of manifest.sheets) {
    if (frameIndex >= candidate.startFrame && frameIndex < candidate.startFrame + candidate.frameCount) {
      sheet = candidate;
      break;
    }
  }

  const localIndex = Math.max(0, Math.min(sheet.frameCount - 1, frameIndex - sheet.startFrame));
  const col = localIndex % sheet.columns;
  const row = Math.floor(localIndex / sheet.columns);

  const safeW = Math.max(1, tileWidth);
  const safeH = Math.max(1, tileHeight);
  const frameAspect = manifest.frameWidth / manifest.frameHeight;
  const boxAspect = safeW / safeH;

  // Center-crop cover scale so non-16:9 videos (e.g. 9:16 portrait or 1:1 square) never distort.
  const scale = frameAspect > boxAspect ? safeH / manifest.frameHeight : safeW / manifest.frameWidth;
  const renderedFrameW = manifest.frameWidth * scale;
  const renderedFrameH = manifest.frameHeight * scale;
  const offsetX = (safeW - renderedFrameW) / 2;
  const offsetY = (safeH - renderedFrameH) / 2;

  const bgW = sheet.columns * renderedFrameW;
  const bgH = sheet.rows * renderedFrameH;
  const posX = -(col * renderedFrameW) + offsetX;
  const posY = -(row * renderedFrameH) + offsetY;

  return {
    sheetUrl: sheet.url,
    backgroundSize: `${bgW.toFixed(2)}px ${bgH.toFixed(2)}px`,
    backgroundPosition: `${posX.toFixed(2)}px ${posY.toFixed(2)}px`,
  };
}
