/**
 * Shared frame-extraction loader for `VideoFrameThumbnail`:
 * - Isolates cloud redirected video routes with `?frame=1` so CORS canvas frame
 *   extraction uses a dedicated S3 presigned URL cache key and cannot collide with
 *   non-CORS `<video>` playback entries in the browser HTTP disk cache.
 * - Deduplicates concurrent extractions for the same `(src, retryAttempt)`.
 * - Caps concurrent hidden `<video>` decodes across long galleries.
 * - Retains an in-memory LRU JPEG cache so searches, tab switches, sidebars, and
 *   version history reuse extracted frames immediately without re-decoding.
 */

const MAX_CACHED_FRAMES = 200;
const MAX_CONCURRENT_EXTRACTIONS = 4;
const EXTRACTION_TIMEOUT_MS = 15_000;

const ISOLATABLE_VIDEO_ROUTE_RE =
  /^\/(?:api|motion-api)\/(?:assets\/[^/]+\/versions\/[^/]+\/file|(?:render|exports)\/[^/]+\/view|projects\/[^/]+\/renders\/file\/[^/]+)$/;

export interface VideoFrameSubscriber {
  onFrame: (dataUrl: string) => void;
  onError: () => void;
}

interface VideoFrameJob {
  readonly key: string;
  readonly src: string;
  readonly loadUrl: string;
  readonly subscribers: Set<VideoFrameSubscriber>;
  active: boolean;
  settled: boolean;
  cancelVideo: (() => void) | null;
}

const frameCache = new Map<string, string>();
const inFlightJobs = new Map<string, VideoFrameJob>();
const pendingQueue: VideoFrameJob[] = [];
let activeCount = 0;

/**
 * Append `?frame=1` (and `?retry=N` on retries) to same-origin cloud redirected video
 * routes so CORS frame extraction never shares an S3 HTTP cache key with non-CORS
 * `<video>` playback. Local/relative paths and external URLs are returned unchanged.
 */
export function resolveVideoFrameUrl(src: string, retryAttempt = 0): string {
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("blob:") || trimmed.startsWith("data:")) {
    return src;
  }
  const hasOrigin = typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin !== "null";
  const baseOrigin = hasOrigin ? window.location.origin : "http://localhost";
  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseOrigin);
  } catch {
    return src;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return src;
  if (resolved.origin !== baseOrigin) return src;
  if (!ISOLATABLE_VIDEO_ROUTE_RE.test(resolved.pathname)) return src;

  resolved.searchParams.set("frame", "1");
  if (retryAttempt > 0) {
    resolved.searchParams.set("retry", String(retryAttempt));
  } else {
    resolved.searchParams.delete("retry");
  }
  if (trimmed.startsWith("/")) {
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  }
  return resolved.href;
}

export function getCachedVideoFrame(src: string): string | null {
  const cached = frameCache.get(src);
  if (cached === undefined) return null;
  // Refresh LRU recency.
  frameCache.delete(src);
  frameCache.set(src, cached);
  return cached;
}

function setCachedVideoFrame(src: string, dataUrl: string): void {
  frameCache.delete(src);
  frameCache.set(src, dataUrl);
  while (frameCache.size > MAX_CACHED_FRAMES) {
    const oldest = frameCache.keys().next().value;
    if (oldest === undefined) break;
    frameCache.delete(oldest);
  }
}

function removeFromPending(job: VideoFrameJob): void {
  const idx = pendingQueue.indexOf(job);
  if (idx >= 0) pendingQueue.splice(idx, 1);
}

function pumpQueue(): void {
  while (activeCount < MAX_CONCURRENT_EXTRACTIONS && pendingQueue.length > 0) {
    const next = pendingQueue.shift();
    if (!next || next.settled || next.subscribers.size === 0) continue;
    startJob(next);
  }
}

function startJob(job: VideoFrameJob): void {
  activeCount += 1;
  job.active = true;

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  let cleanedUp = false;
  let captureOnLoadedData = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const releaseSlot = () => {
    if (!job.active) return;
    job.active = false;
    activeCount = Math.max(0, activeCount - 1);
    pumpQueue();
  };

  // Clearing src fires one more `error` on the video, so all listeners must be
  // detached first — otherwise error -> cleanup -> error spins forever.
  const cleanupVideo = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    job.cancelVideo = null;
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    video.removeEventListener("loadedmetadata", onLoadedMetadata);
    video.removeEventListener("loadeddata", onLoadedData);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("error", onError);
    video.src = "";
    video.load();
    releaseSlot();
  };

  const finishSuccess = (dataUrl: string) => {
    if (job.settled) return;
    job.settled = true;
    inFlightJobs.delete(job.key);
    setCachedVideoFrame(job.src, dataUrl);
    cleanupVideo();
    const listeners = [...job.subscribers];
    job.subscribers.clear();
    for (const listener of listeners) listener.onFrame(dataUrl);
  };

  const finishError = () => {
    if (job.settled) return;
    job.settled = true;
    inFlightJobs.delete(job.key);
    cleanupVideo();
    const listeners = [...job.subscribers];
    job.subscribers.clear();
    for (const listener of listeners) listener.onError();
  };

  const captureFrame = () => {
    if (job.settled) return;
    if (!ctx || !(video.videoWidth > 0 && video.videoHeight > 0)) {
      finishError();
      return;
    }
    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      if (!dataUrl || !dataUrl.startsWith("data:image/")) {
        finishError();
        return;
      }
      finishSuccess(dataUrl);
    } catch {
      finishError();
    }
  };

  const onLoadedMetadata = () => {
    if (job.settled) return;
    const duration = video.duration;
    const targetTime = Number.isFinite(duration) && duration > 0 ? Math.min(2, duration * 0.1) : 0;
    if (targetTime > 0) {
      captureOnLoadedData = false;
      video.currentTime = targetTime;
      return;
    }
    if (video.readyState >= 2) {
      captureFrame();
    } else {
      captureOnLoadedData = true;
      // Ensure the browser actually fetches the first frame instead of idling at HAVE_METADATA.
      video.preload = "auto";
    }
  };

  const onLoadedData = () => {
    if (captureOnLoadedData) captureFrame();
  };

  const onSeeked = () => {
    captureFrame();
  };

  const onError = () => {
    // Ignore the synthetic error cleanup itself just triggered.
    if (!video.getAttribute("src")) return;
    finishError();
  };

  job.cancelVideo = cleanupVideo;
  stallTimer = setTimeout(() => finishError(), EXTRACTION_TIMEOUT_MS);

  video.addEventListener("loadedmetadata", onLoadedMetadata);
  video.addEventListener("loadeddata", onLoadedData);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("error", onError);
  video.src = job.loadUrl;
  video.load();
}

export function subscribeVideoFrame(
  src: string,
  retryAttempt: number,
  subscriber: VideoFrameSubscriber,
): () => void {
  if (!src.trim()) {
    subscriber.onError();
    return () => {};
  }
  const cached = getCachedVideoFrame(src);
  if (cached) {
    subscriber.onFrame(cached);
    return () => {};
  }

  const key = `${src}\u0000${retryAttempt}`;
  let job = inFlightJobs.get(key);
  if (!job) {
    job = {
      key,
      src,
      loadUrl: resolveVideoFrameUrl(src, retryAttempt),
      subscribers: new Set(),
      active: false,
      settled: false,
      cancelVideo: null,
    };
    inFlightJobs.set(key, job);
    pendingQueue.push(job);
  }
  job.subscribers.add(subscriber);
  pumpQueue();

  return () => {
    job.subscribers.delete(subscriber);
    if (job.subscribers.size === 0 && !job.settled) {
      job.settled = true;
      inFlightJobs.delete(job.key);
      removeFromPending(job);
      job.cancelVideo?.();
    }
  };
}

export function resetVideoFrameThumbnailLoaderForTests(): void {
  frameCache.clear();
  pendingQueue.length = 0;
  for (const job of [...inFlightJobs.values()]) {
    job.settled = true;
    job.subscribers.clear();
    job.cancelVideo?.();
  }
  inFlightJobs.clear();
  activeCount = 0;
}
