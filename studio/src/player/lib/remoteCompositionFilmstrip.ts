import { studioApiFetch } from "../../utils/studioApiFetch";

const MAX_REMOTE_FILMSTRIP_FRAMES = 8;
const MIN_FRAME_WIDTH = 32;
const MAX_FRAME_WIDTH = 320;
const MIN_FRAME_HEIGHT = 24;
const MAX_FRAME_HEIGHT = 320;
const MAX_SPRITE_UPLOAD_BYTES = 512 * 1024;
const MAX_UPLOAD_FRAME_WIDTH = 160;
const SPRITE_ENCODE_QUALITY = 0.78;
const SLICE_ENCODE_QUALITY = 0.82;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const MAX_PENDING_WRITE_TARGETS = 256;
const MAX_COMPLETED_UPLOADS = 512;

const HEADER_FRAMES = "x-openmotion-filmstrip-frames";
const HEADER_WIDTH = "x-openmotion-filmstrip-width";
const HEADER_HEIGHT = "x-openmotion-filmstrip-height";
const HEADER_ASPECT = "x-openmotion-filmstrip-aspect";
const HEADER_SHA256 = "x-openmotion-filmstrip-sha256";
const HEADER_RENDER_KEY = "x-openmotion-filmstrip-render-key";
const HEADER_SCOPE = "x-openmotion-filmstrip-scope";
const HEADER_SOURCE = "x-openmotion-filmstrip-source";

export interface RemoteFilmstripHit {
  readonly status: "hit";
  readonly blobs: Blob[];
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
  readonly sha256: string;
  readonly renderKey?: string;
  readonly scope: string;
  readonly source: string;
}

export interface RemoteFilmstripMiss {
  readonly status: "miss";
  readonly sha256?: string;
  readonly renderKey?: string;
  readonly scope?: string;
}

export type RemoteFilmstripResult = RemoteFilmstripHit | RemoteFilmstripMiss;

export interface RemoteFilmstripCodec {
  decodeSprite(
    spriteBlob: Blob,
    meta: { frameCount: number; frameWidth: number; frameHeight: number },
  ): Promise<Blob[] | null>;
  packSprite(
    blobs: readonly Blob[],
    frameWidth: number,
    frameHeight: number,
  ): Promise<{ blob: Blob; frameCount: number; frameWidth: number; frameHeight: number } | null>;
}

interface PendingWriteTarget {
  readonly sha256: string;
  readonly renderKey: string;
  readonly scope: string;
  readonly existingFrames: number;
}

const inFlightFetches = new Map<string, Promise<RemoteFilmstripResult>>();
const pendingWriteTargets = new Map<string, PendingWriteTarget>();
const completedUploads = new Set<string>();
const inFlightUploads = new Set<string>();
let testCodecOverride: RemoteFilmstripCodec | null = null;

/** Inject deterministic sprite decode/pack stubs in unit tests (HappyDOM has no native JPEG canvas encoder). */
export function setRemoteFilmstripCodecForTest(codec: RemoteFilmstripCodec | null): void {
  testCodecOverride = codec;
}

/** Reset remote filmstrip dedupe and write-back state between unit tests. */
export function clearRemoteCompositionFilmstripStateForTest(): void {
  inFlightFetches.clear();
  pendingWriteTargets.clear();
  completedUploads.clear();
  inFlightUploads.clear();
  testCodecOverride = null;
}

function normalizeCompositionPath(previewUrl: string): string | null {
  const withoutOrigin = previewUrl.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0] ?? "";
  const compMatch = /\/preview\/comp\/(.+)$/.exec(withoutOrigin);
  if (compMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(compMatch[1]).replace(/^(\.\/|\/)+/, "");
      return decoded || null;
    } catch {
      return null;
    }
  }
  if (/\/preview\/?$/.test(withoutOrigin)) {
    return "index.html";
  }
  return null;
}

/** Build `/api/projects/:id/composition-filmstrip/<path>` from a preview URL, or null if unsupported. */
export function buildCompositionFilmstripUrl(
  projectId: string,
  previewUrl: string,
  compRev?: string,
  contentRevision = 0,
): string | null {
  if (!projectId) return null;
  const compPath = normalizeCompositionPath(previewUrl);
  if (!compPath) return null;
  const encodedPath = compPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (!encodedPath) return null;
  const params = new URLSearchParams();
  if (compRev) params.set("rev", compRev);
  if (contentRevision > 0) params.set("cr", String(contentRevision));
  const query = params.toString();
  return `/api/projects/${encodeURIComponent(projectId)}/composition-filmstrip/${encodedPath}${query ? `?${query}` : ""}`;
}

/** Evenly subsample a canonical frame array (e.g. 8 pre-baked frames) down to a smaller target frame count. */
export function subsampleFilmstripFrames<T>(frames: readonly T[], targetCount: number): T[] {
  if (frames.length === 0) return [];
  const count = Math.max(1, Math.floor(targetCount));
  if (count >= frames.length) return [...frames];
  if (count === 1) {
    return [frames[Math.min(frames.length - 1, Math.floor(frames.length / 2))]!];
  }
  return Array.from({ length: count }, (_, idx) => {
    const sourceIdx = Math.min(
      frames.length - 1,
      Math.round((idx / (count - 1)) * (frames.length - 1)),
    );
    return frames[sourceIdx]!;
  });
}

function writeTargetKey(
  projectId: string,
  previewUrl: string,
  compRev: string,
  contentRevision: number,
): string {
  const compPath = normalizeCompositionPath(previewUrl) ?? previewUrl;
  return `${projectId}|${compPath}|${compRev}|${contentRevision}`;
}

function recordPendingWriteTarget(key: string, target: PendingWriteTarget): void {
  if (pendingWriteTargets.has(key)) pendingWriteTargets.delete(key);
  pendingWriteTargets.set(key, target);
  while (pendingWriteTargets.size > MAX_PENDING_WRITE_TARGETS) {
    const oldest = pendingWriteTargets.keys().next().value;
    if (!oldest) break;
    pendingWriteTargets.delete(oldest);
  }
}

async function decodeBlobToSource(
  blob: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => {
          try {
            bitmap.close();
          } catch {
            // ignore
          }
        },
      };
    } catch {
      // Fall through to HTMLImageElement decode.
    }
  }
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Image decode failed"));
      el.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      release: () => URL.revokeObjectURL(objectUrl),
    };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return null;
  }
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(
        (blob) => resolve(blob && blob.size > 0 ? blob : null),
        "image/jpeg",
        quality,
      );
    } catch {
      resolve(null);
    }
  });
}

async function defaultDecodeSprite(
  spriteBlob: Blob,
  meta: { frameCount: number; frameWidth: number; frameHeight: number },
): Promise<Blob[] | null> {
  if (typeof document === "undefined") return null;
  const decoded = await decodeBlobToSource(spriteBlob);
  if (!decoded) return null;
  try {
    const expectedTotalW = meta.frameCount * meta.frameWidth;
    if (decoded.width !== expectedTotalW || decoded.height !== meta.frameHeight) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = meta.frameWidth;
    canvas.height = meta.frameHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const blobs: Blob[] = [];
    for (let i = 0; i < meta.frameCount; i++) {
      ctx.clearRect(0, 0, meta.frameWidth, meta.frameHeight);
      ctx.drawImage(
        decoded.source,
        i * meta.frameWidth,
        0,
        meta.frameWidth,
        meta.frameHeight,
        0,
        0,
        meta.frameWidth,
        meta.frameHeight,
      );
      const frameBlob = await canvasToJpegBlob(canvas, SLICE_ENCODE_QUALITY);
      if (!frameBlob) return null;
      blobs.push(frameBlob);
    }
    canvas.width = 0;
    canvas.height = 0;
    return blobs;
  } finally {
    decoded.release();
  }
}

/**
 * Compute uniform aspect-preserving pixel dimensions for a single filmstrip frame
 * within `[MIN_FRAME_WIDTH..MAX_UPLOAD_FRAME_WIDTH]` × `[MIN_FRAME_HEIGHT..MAX_FRAME_HEIGHT]`.
 */
export function computeRemoteSpriteFrameDimensions(
  frameWidth: number,
  frameHeight: number,
): { frameWidth: number; frameHeight: number } {
  const origW = Math.max(1, Math.round(Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth : MAX_UPLOAD_FRAME_WIDTH));
  const origH = Math.max(1, Math.round(Number.isFinite(frameHeight) && frameHeight > 0 ? frameHeight : 90));
  const scale = Math.min(1, MAX_UPLOAD_FRAME_WIDTH / origW, MAX_FRAME_HEIGHT / origH);
  return {
    frameWidth: Math.max(MIN_FRAME_WIDTH, Math.min(MAX_FRAME_WIDTH, Math.round(origW * scale))),
    frameHeight: Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, Math.round(origH * scale))),
  };
}

async function defaultPackSprite(
  blobs: readonly Blob[],
  frameWidth: number,
  frameHeight: number,
): Promise<{ blob: Blob; frameCount: number; frameWidth: number; frameHeight: number } | null> {
  if (typeof document === "undefined" || blobs.length === 0 || blobs.length > MAX_REMOTE_FILMSTRIP_FRAMES) {
    return null;
  }
  const { frameWidth: safeW, frameHeight: safeH } = computeRemoteSpriteFrameDimensions(
    frameWidth,
    frameHeight,
  );
  const canvas = document.createElement("canvas");
  canvas.width = safeW * blobs.length;
  canvas.height = safeH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    for (let i = 0; i < blobs.length; i++) {
      const decoded = await decodeBlobToSource(blobs[i]!);
      if (!decoded) return null;
      try {
        ctx.drawImage(decoded.source, i * safeW, 0, safeW, safeH);
      } finally {
        decoded.release();
      }
    }
    const spriteBlob = await canvasToJpegBlob(canvas, SPRITE_ENCODE_QUALITY);
    if (!spriteBlob || spriteBlob.size === 0 || spriteBlob.size > MAX_SPRITE_UPLOAD_BYTES) {
      return null;
    }
    return {
      blob: spriteBlob,
      frameCount: blobs.length,
      frameWidth: safeW,
      frameHeight: safeH,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function parseIntHeader(headers: Headers, name: string, min: number, max: number): number | null {
  const raw = headers.get(name)?.trim();
  if (!raw || !/^\d{1,4}$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * Tier 1.5 remote shared filmstrip lookup (deduplicated per composition + revision).
 * Returns decoded frame blobs on hit (builtin/catalog/workspace) and records the
 * server's authoritative file sha256 on a `204` miss for safe post-capture write-back.
 */
export function fetchRemoteCompositionFilmstrip(input: {
  projectId: string;
  previewUrl: string;
  compRev: string;
  contentRevision: number;
}): Promise<RemoteFilmstripResult> {
  const url = buildCompositionFilmstripUrl(
    input.projectId,
    input.previewUrl,
    input.compRev,
    input.contentRevision,
  );
  if (!url) return Promise.resolve({ status: "miss" });

  const targetKey = writeTargetKey(
    input.projectId,
    input.previewUrl,
    input.compRev,
    input.contentRevision,
  );
  const existing = inFlightFetches.get(targetKey);
  if (existing) return existing;

  const task = (async (): Promise<RemoteFilmstripResult> => {
    try {
      const response = await studioApiFetch(url, { priority: "low" });
      const rawSha = response.headers.get(HEADER_SHA256)?.trim() ?? "";
      const sha256 = SHA256_HEX_RE.test(rawSha) ? rawSha : "";
      const rawRenderKey = response.headers.get(HEADER_RENDER_KEY)?.trim() ?? "";
      const renderKey = SHA256_HEX_RE.test(rawRenderKey) ? rawRenderKey : "";
      const scope = response.headers.get(HEADER_SCOPE)?.trim() ?? "";

      if (response.status === 204) {
        if (sha256 && renderKey) {
          recordPendingWriteTarget(targetKey, { sha256, renderKey, scope, existingFrames: 0 });
        }
        return {
          status: "miss",
          ...(sha256 ? { sha256 } : {}),
          ...(renderKey ? { renderKey } : {}),
          ...(scope ? { scope } : {}),
        };
      }

      if (response.status !== 200) {
        return { status: "miss" };
      }

      const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (contentType !== "image/jpeg") {
        return { status: "miss" };
      }

      const frameCount = parseIntHeader(response.headers, HEADER_FRAMES, 1, MAX_REMOTE_FILMSTRIP_FRAMES);
      const frameWidth = parseIntHeader(response.headers, HEADER_WIDTH, MIN_FRAME_WIDTH, MAX_FRAME_WIDTH);
      const frameHeight = parseIntHeader(response.headers, HEADER_HEIGHT, MIN_FRAME_HEIGHT, MAX_FRAME_HEIGHT);
      if (!frameCount || !frameWidth || !frameHeight) {
        return { status: "miss" };
      }

      const rawAspect = Number.parseFloat(response.headers.get(HEADER_ASPECT) ?? "");
      const aspect =
        Number.isFinite(rawAspect) && rawAspect >= 0.1 && rawAspect <= 10
          ? rawAspect
          : frameWidth / frameHeight;
      const source = response.headers.get(HEADER_SOURCE)?.trim() ?? "workspace";

      const spriteBlob = await response.blob();
      if (!spriteBlob || spriteBlob.size === 0 || spriteBlob.size > MAX_SPRITE_UPLOAD_BYTES) {
        return { status: "miss" };
      }

      const codec = testCodecOverride;
      const blobs = codec
        ? await codec.decodeSprite(spriteBlob, { frameCount, frameWidth, frameHeight })
        : await defaultDecodeSprite(spriteBlob, { frameCount, frameWidth, frameHeight });
      if (!blobs || blobs.length !== frameCount) {
        return { status: "miss" };
      }

      if (sha256 && renderKey && frameCount < MAX_REMOTE_FILMSTRIP_FRAMES) {
        // Allow a later higher-frame-count capture to upgrade this cached sprite in S3.
        recordPendingWriteTarget(targetKey, { sha256, renderKey, scope, existingFrames: frameCount });
      } else {
        pendingWriteTargets.delete(targetKey);
      }

      return {
        status: "hit",
        blobs,
        frameCount,
        width: frameWidth,
        height: frameHeight,
        aspect,
        sha256,
        ...(renderKey ? { renderKey } : {}),
        scope,
        source,
      };
    } catch {
      return { status: "miss" };
    }
  })().finally(() => {
    inFlightFetches.delete(targetKey);
  });

  inFlightFetches.set(targetKey, task);
  return task;
}

/**
 * Best-effort async write-back after browser SnapDOM completes a cold capture.
 * Only executes when a prior Tier 1.5 `GET` observed a `204` miss (or lower-frame sprite)
 * with an authoritative file `sha256`, keeping isolated unit tests and unchanged scenes free
 * of extra network writes.
 */
export async function uploadRemoteCompositionFilmstripIfEligible(input: {
  projectId: string;
  previewUrl: string;
  compRev: string;
  contentRevision: number;
  blobs: readonly Blob[];
  width: number;
  height: number;
  aspect: number;
  duration?: number;
}): Promise<boolean> {
  if (input.blobs.length === 0 || input.blobs.length > MAX_REMOTE_FILMSTRIP_FRAMES) {
    return false;
  }
  // Avoid uploading a single-frame sidebar cover unless the composition itself is ultra-short (<= 0.5s).
  if (input.blobs.length === 1 && !(typeof input.duration === "number" && input.duration > 0 && input.duration <= 0.5)) {
    return false;
  }

  const targetKey = writeTargetKey(
    input.projectId,
    input.previewUrl,
    input.compRev,
    input.contentRevision,
  );
  const target = pendingWriteTargets.get(targetKey);
  if (!target || input.blobs.length <= target.existingFrames) {
    return false;
  }

  const uploadUrl = buildCompositionFilmstripUrl(input.projectId, input.previewUrl);
  if (!uploadUrl) return false;

  const dedupeKey = `${input.projectId}|${target.renderKey}|${input.blobs.length}`;
  if (completedUploads.has(dedupeKey) || inFlightUploads.has(dedupeKey)) {
    return false;
  }

  inFlightUploads.add(dedupeKey);
  try {
    const codec = testCodecOverride;
    const packed = codec
      ? await codec.packSprite(input.blobs, input.width, input.height)
      : await defaultPackSprite(input.blobs, input.width, input.height);
    if (!packed || packed.blob.size === 0 || packed.blob.size > MAX_SPRITE_UPLOAD_BYTES) {
      return false;
    }

    const headers: Record<string, string> = {
      "Content-Type": "image/jpeg",
      [HEADER_FRAMES]: String(packed.frameCount),
      [HEADER_WIDTH]: String(packed.frameWidth),
      [HEADER_HEIGHT]: String(packed.frameHeight),
      [HEADER_ASPECT]: (Number.isFinite(input.aspect) && input.aspect > 0
        ? input.aspect
        : packed.frameWidth / packed.frameHeight
      ).toFixed(4),
      [HEADER_SHA256]: target.sha256,
      [HEADER_RENDER_KEY]: target.renderKey,
    };
    if (target.scope) {
      headers[HEADER_SCOPE] = target.scope;
    }

    const response = await studioApiFetch(uploadUrl, {
      method: "PUT",
      headers,
      body: packed.blob,
      priority: "low",
    });
    if (response.ok) {
      completedUploads.add(dedupeKey);
      while (completedUploads.size > MAX_COMPLETED_UPLOADS) {
        const oldest = completedUploads.values().next().value;
        if (!oldest) break;
        completedUploads.delete(oldest);
      }
      if (packed.frameCount >= MAX_REMOTE_FILMSTRIP_FRAMES) {
        pendingWriteTargets.delete(targetKey);
      } else {
        recordPendingWriteTarget(targetKey, {
          sha256: target.sha256,
          renderKey: target.renderKey,
          scope: target.scope,
          existingFrames: packed.frameCount,
        });
      }
      return true;
    }
    if (response.status === 409) {
      pendingWriteTargets.delete(targetKey);
    }
    return false;
  } catch {
    return false;
  } finally {
    inFlightUploads.delete(dedupeKey);
  }
}
