import { isLottieAnimationLoaded } from "@hyperframes/core/runtime/lottie-readiness";

export type PreviewAssetKind = "image" | "video" | "audio" | "font" | "lottie";

export interface PreviewAssetFailure {
  id: string;
  label: string;
  kind: PreviewAssetKind;
  reason: "error" | "timeout";
}

export interface PreviewAssetProgress {
  status: "loading" | "ready";
  completed: number;
  total: number;
  failed: PreviewAssetFailure[];
  skipped?: boolean;
}

export interface PreviewAssetReadinessTracker {
  retryFailed: () => Promise<PreviewAssetFailure[]>;
  skip: () => void;
  dispose: () => void;
}

export interface TrackDocumentAssetOptions {
  itemTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  maxConcurrentVideos?: number;
  fetchImpl?: typeof fetch;
}

export const ASSET_ITEM_TIMEOUT_MS = 10_000;
export const ASSET_RETRY_DELAYS_MS = [500, 1500] as const;
export const MAX_CONCURRENT_VIDEO_PRELOADS = 3;
export const EDITOR_LOADING_OVERLAY_DEBOUNCE_MS = 150;
export const EDITOR_LOADING_SLOW_ESCAPE_MS = 8_000;

const MEDIA_HAVE_CURRENT_DATA = 2;
const MEDIA_HAVE_FUTURE_DATA = 3;
const MEDIA_NETWORK_EMPTY = 0;
const MEDIA_NETWORK_IDLE = 1;
const LOTTIE_POLL_MS = 100;

export function isNonRetryableHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function withRetryQueryParam(
  rawUrl: string,
  attempt: number,
  baseHref?: string,
): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || /^(?:data|blob|javascript):/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed, baseHref || "http://localhost/");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.searchParams.set("_omRetry", String(attempt));
    if (!/^[a-z]+:\/\//i.test(trimmed) && baseHref) {
      const base = new URL(baseHref);
      if (parsed.origin === base.origin) {
        return parsed.pathname + parsed.search + parsed.hash;
      }
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function assetLabelFromUrl(rawUrl: string | null | undefined, fallback: string): string {
  const trimmed = rawUrl?.trim();
  if (!trimmed || /^(?:data|blob):/i.test(trimmed)) return fallback;
  try {
    const pathname = new URL(trimmed, "http://localhost/").pathname;
    const segment = pathname.split("/").filter(Boolean).pop();
    if (!segment) return fallback;
    const decoded = decodeURIComponent(segment);
    return decoded.length > 48 ? `${decoded.slice(0, 45)}...` : decoded;
  } catch {
    return fallback;
  }
}

function resolveSourceUrl(el: Element): string {
  if (el.tagName === "IMG") {
    const img = el as HTMLImageElement;
    return img.getAttribute("src") || img.currentSrc || "";
  }
  const media = el as HTMLMediaElement;
  const direct = media.getAttribute("src");
  if (direct) return direct;
  const source = media.querySelector("source[src]");
  if (source) return source.getAttribute("src") || "";
  return media.currentSrc || "";
}

function applyRetrySource(el: Element, nextUrl: string): void {
  if (el.tagName === "IMG") {
    (el as HTMLImageElement).src = nextUrl;
    return;
  }
  const media = el as HTMLMediaElement;
  const direct = media.getAttribute("src");
  if (direct !== null) {
    media.src = nextUrl;
  } else {
    const source = media.querySelector("source[src]");
    if (source) source.setAttribute("src", nextUrl);
    else media.src = nextUrl;
  }
  media.load();
}

async function isUrlRetryable(
  rawUrl: string,
  baseHref: string | undefined,
  sameOrigin: string | undefined,
  fetchImpl: typeof fetch | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (!fetchImpl || !rawUrl || /^(?:data|blob|javascript):/i.test(rawUrl)) return false;
  let target: URL;
  try {
    target = new URL(rawUrl, baseHref || "http://localhost/");
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (!sameOrigin || target.origin !== sameOrigin) return true;
  try {
    const response = await fetchImpl(target.href, {
      method: "HEAD",
      redirect: "manual",
      signal,
    });
    if (response.type === "opaqueredirect" || response.status === 0) return true;
    return !isNonRetryableHttpStatus(response.status);
  } catch {
    return !signal.aborted;
  }
}

interface TrackedAssetItem {
  id: string;
  label: string;
  kind: PreviewAssetKind;
  settled: boolean;
  failedReason: "error" | "timeout" | null;
  retryNow?: (attempt: number) => Promise<boolean>;
}

/**
 * Tracks every external asset referenced by a composition document:
 * fonts, all `<img>` (promoting lazy images), non-hidden `<audio>`,
 * concurrency-limited non-hidden `<video>`, and Lottie animations.
 *
 * Every item settles independently (bounded automatic retry + per-item timeout),
 * so a single broken or slow asset never deadlocks editor unlock.
 */
export function trackDocumentAssetReadiness(
  doc: Document,
  win: Window | null,
  onProgress: (progress: PreviewAssetProgress) => void,
  options: TrackDocumentAssetOptions = {},
): PreviewAssetReadinessTracker {
  const itemTimeoutMs = options.itemTimeoutMs ?? ASSET_ITEM_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? ASSET_RETRY_DELAYS_MS;
  const maxConcurrentVideos = Math.max(1, options.maxConcurrentVideos ?? MAX_CONCURRENT_VIDEO_PRELOADS);
  const fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  const baseHref =
    (doc.baseURI && doc.baseURI !== "about:blank" ? doc.baseURI : undefined) ||
    win?.location?.href ||
    undefined;
  const sameOrigin = (() => {
    try {
      const origin = win?.location?.origin;
      return origin && origin !== "null" ? origin : undefined;
    } catch {
      return undefined;
    }
  })();

  let disposed = false;
  let skipped = false;
  let manualRetryCounter = retryDelaysMs.length;
  const cleanups: Array<() => void> = [];
  const items: TrackedAssetItem[] = [];

  const buildSnapshot = (): PreviewAssetProgress => {
    const total = items.length;
    let completed = 0;
    const failed: PreviewAssetFailure[] = [];
    for (const item of items) {
      if (item.settled) completed += 1;
      if (item.failedReason) {
        failed.push({
          id: item.id,
          label: item.label,
          kind: item.kind,
          reason: item.failedReason,
        });
      }
    }
    const done = skipped || total === 0 || completed >= total;
    return {
      status: done ? "ready" : "loading",
      completed,
      total,
      failed,
      ...(skipped ? { skipped: true } : {}),
    };
  };

  let lastSignature = "";
  const emit = (force = false) => {
    if (disposed) return;
    const snap = buildSnapshot();
    const signature = `${snap.status}:${snap.completed}:${snap.total}:${snap.skipped ? 1 : 0}:${snap.failed.map((f) => `${f.id}:${f.reason}`).join(",")}`;
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    onProgress(snap);
  };

  const settleItem = (item: TrackedAssetItem, failure: "error" | "timeout" | null) => {
    if (disposed) return;
    item.settled = true;
    item.failedReason = failure;
    emit();
  };

  const scheduleTimeout = (ms: number, fn: () => void) => {
    const id = setTimeout(fn, ms);
    const cancel = () => clearTimeout(id);
    cleanups.push(cancel);
    return cancel;
  };

  // 1. Fonts
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts && fonts.size > 0) {
    const item: TrackedAssetItem = {
      id: "fonts",
      label: "Fonts",
      kind: "font",
      settled: fonts.status === "loaded",
      failedReason: null,
    };
    items.push(item);
    if (!item.settled) {
      const cancelTimer = scheduleTimeout(itemTimeoutMs, () => {
        if (!item.settled) settleItem(item, "timeout");
      });
      void Promise.resolve(fonts.ready).then(
        () => {
          cancelTimer();
          if (!item.settled) settleItem(item, null);
        },
        () => {
          cancelTimer();
          if (!item.settled) settleItem(item, "error");
        },
      );
    }
  }

  // 2. Images
  const images = Array.from(doc.querySelectorAll<HTMLImageElement>("img[src], img[srcset]")).filter(
    (img) => !img.closest("[data-hyperframes-ignore]"),
  );
  images.forEach((img, index) => {
    const originalSrc = resolveSourceUrl(img);
    if (img.loading === "lazy") img.loading = "eager";
    const readyNow = img.complete && img.naturalWidth > 0;
    const item: TrackedAssetItem = {
      id: `img-${index}`,
      label: assetLabelFromUrl(originalSrc, `image-${index + 1}`),
      kind: "image",
      settled: readyNow,
      failedReason: null,
    };
    items.push(item);
    if (readyNow) return;

    const watchImageAttempt = (
      retryIndex: number,
      allowAutoRetry: boolean,
      checkExisting: boolean,
      onComplete: (ok: boolean, reason: "error" | "timeout" | null) => void,
    ) => {
      let finished = false;
      let probing = false;
      let cancelTimer: (() => void) | null = null;
      let cancelRetryTimer: (() => void) | null = null;
      let probeController: AbortController | null = null;
      const detachListeners = () => {
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
      };
      const detach = () => {
        detachListeners();
        cancelTimer?.();
        cancelTimer = null;
        cancelRetryTimer?.();
        cancelRetryTimer = null;
        if (probeController) {
          probeController.abort();
          probeController = null;
        }
      };
      const done = (ok: boolean, reason: "error" | "timeout" | null) => {
        if (finished || disposed) return;
        finished = true;
        detach();
        onComplete(ok, reason);
      };
      const onLoad = () => done(true, null);
      const onError = () => {
        if (finished || probing || disposed) return;
        probing = true;
        detachListeners();
        if (!allowAutoRetry || retryIndex >= retryDelaysMs.length || !originalSrc) {
          done(false, "error");
          return;
        }
        probeController = new AbortController();
        void isUrlRetryable(
          originalSrc,
          baseHref,
          sameOrigin,
          fetchImpl,
          probeController.signal,
        ).then((retryable) => {
          if (disposed || finished) return;
          probeController = null;
          if (!retryable) {
            done(false, "error");
            return;
          }
          const nextUrl = withRetryQueryParam(originalSrc, retryIndex + 1, baseHref);
          if (!nextUrl) {
            done(false, "error");
            return;
          }
          cancelTimer?.();
          cancelTimer = null;
          const delay = retryDelaysMs[retryIndex] ?? 500;
          cancelRetryTimer = scheduleTimeout(delay, () => {
            if (disposed || finished) return;
            finished = true;
            cancelRetryTimer = null;
            watchImageAttempt(retryIndex + 1, true, false, onComplete);
            applyRetrySource(img, nextUrl);
          });
        });
      };

      img.addEventListener("load", onLoad);
      img.addEventListener("error", onError);
      cleanups.push(detach);
      cancelTimer = scheduleTimeout(itemTimeoutMs, () => {
        if (!probing && img.complete && img.naturalWidth > 0) done(true, null);
        else done(false, "timeout");
      });

      if (checkExisting && img.complete) {
        if (img.naturalWidth > 0) done(true, null);
        else onError();
      }
    };

    item.retryNow = (attempt) =>
      new Promise<boolean>((resolve) => {
        if (disposed || !img.isConnected) {
          resolve(false);
          return;
        }
        const nextUrl = withRetryQueryParam(originalSrc, attempt, baseHref);
        if (!nextUrl) {
          resolve(false);
          return;
        }
        watchImageAttempt(retryDelaysMs.length, false, false, (ok, reason) => {
          settleItem(item, ok ? null : reason);
          resolve(ok);
        });
        applyRetrySource(img, nextUrl);
      });

    watchImageAttempt(0, true, true, (ok, reason) => settleItem(item, ok ? null : reason));
  });

  // Helper for <audio> and <video>
  const watchMediaElement = (
    media: HTMLMediaElement,
    item: TrackedAssetItem,
    originalSrc: string,
    targetReadyState: number,
    onDone?: () => void,
  ) => {
    const startAttempt = (
      retryIndex: number,
      allowAutoRetry: boolean,
      triggerReload: boolean,
      onComplete: (ok: boolean, reason: "error" | "timeout" | null) => void,
    ) => {
      let finished = false;
      let probing = false;
      let cancelTimer: (() => void) | null = null;
      let cancelRetryTimer: (() => void) | null = null;
      let probeController: AbortController | null = null;
      const detachListeners = () => {
        media.removeEventListener("loadeddata", onProgressEvent);
        media.removeEventListener("canplay", onProgressEvent);
        media.removeEventListener("canplaythrough", onProgressEvent);
        media.removeEventListener("error", onError);
      };
      const detach = () => {
        detachListeners();
        cancelTimer?.();
        cancelTimer = null;
        cancelRetryTimer?.();
        cancelRetryTimer = null;
        if (probeController) {
          probeController.abort();
          probeController = null;
        }
      };
      const done = (ok: boolean, reason: "error" | "timeout" | null) => {
        if (finished || disposed) return;
        finished = true;
        detach();
        onComplete(ok, reason);
      };
      const isReady = () => media.readyState >= targetReadyState;
      const onProgressEvent = () => {
        if (isReady() || (item.kind === "video" && media.readyState >= MEDIA_HAVE_CURRENT_DATA)) {
          done(true, null);
        }
      };
      const onError = () => {
        if (finished || probing || disposed) return;
        probing = true;
        detachListeners();
        if (!allowAutoRetry || retryIndex >= retryDelaysMs.length || !originalSrc) {
          done(false, "error");
          return;
        }
        probeController = new AbortController();
        void isUrlRetryable(
          originalSrc,
          baseHref,
          sameOrigin,
          fetchImpl,
          probeController.signal,
        ).then((retryable) => {
          if (disposed || finished) return;
          probeController = null;
          if (!retryable) {
            done(false, "error");
            return;
          }
          const nextUrl = withRetryQueryParam(originalSrc, retryIndex + 1, baseHref);
          if (!nextUrl) {
            done(false, "error");
            return;
          }
          cancelTimer?.();
          cancelTimer = null;
          const delay = retryDelaysMs[retryIndex] ?? 500;
          cancelRetryTimer = scheduleTimeout(delay, () => {
            if (disposed || finished) return;
            finished = true;
            cancelRetryTimer = null;
            startAttempt(retryIndex + 1, true, false, onComplete);
            applyRetrySource(media, nextUrl);
          });
        });
      };

      media.addEventListener("loadeddata", onProgressEvent);
      media.addEventListener("canplay", onProgressEvent);
      media.addEventListener("canplaythrough", onProgressEvent);
      media.addEventListener("error", onError);
      cleanups.push(detach);

      cancelTimer = scheduleTimeout(itemTimeoutMs, () => {
        if (!probing && media.readyState >= MEDIA_HAVE_CURRENT_DATA) done(true, null);
        else done(false, "timeout");
      });

      if (triggerReload) {
        if (media.error) {
          onError();
          return;
        }
        if (isReady()) {
          done(true, null);
          return;
        }
      }
      if (media.preload !== "auto") media.preload = "auto";
      if (
        triggerReload &&
        (media.networkState === MEDIA_NETWORK_EMPTY ||
          (media.readyState === 0 && media.networkState === MEDIA_NETWORK_IDLE))
      ) {
        try {
          media.load();
        } catch {
          /* ignore synthetic DOM media load errors */
        }
      }
    };

    item.retryNow = (attempt) =>
      new Promise<boolean>((resolve) => {
        if (disposed || !media.isConnected) {
          resolve(false);
          return;
        }
        const nextUrl = withRetryQueryParam(originalSrc, attempt, baseHref);
        if (!nextUrl) {
          resolve(false);
          return;
        }
        startAttempt(retryDelaysMs.length, false, false, (ok, reason) => {
          settleItem(item, ok ? null : reason);
          resolve(ok);
        });
        applyRetrySource(media, nextUrl);
      });

    startAttempt(0, true, true, (ok, reason) => {
      settleItem(item, ok ? null : reason);
      onDone?.();
    });
  };

  // 3. Audio (all non-hidden audio clips referenced by the composition)
  const audios = Array.from(doc.querySelectorAll<HTMLAudioElement>("audio")).filter(
    (audio) =>
      !audio.hasAttribute("data-hf-clip-hidden") &&
      !audio.closest("[data-hyperframes-ignore]") &&
      Boolean(resolveSourceUrl(audio)),
  );
  audios.forEach((audio, index) => {
    const originalSrc = resolveSourceUrl(audio);
    const readyNow = !audio.error && audio.readyState >= MEDIA_HAVE_FUTURE_DATA;
    const item: TrackedAssetItem = {
      id: `audio-${index}`,
      label: assetLabelFromUrl(originalSrc, `audio-${index + 1}`),
      kind: "audio",
      settled: readyNow,
      failedReason: null,
    };
    items.push(item);
    if (!readyNow) {
      watchMediaElement(audio, item, originalSrc, MEDIA_HAVE_FUTURE_DATA);
    }
  });

  // 4. Video (concurrency-limited queue so multi-clip projects don't thrash bandwidth)
  const videos = Array.from(doc.querySelectorAll<HTMLVideoElement>("video")).filter(
    (video) =>
      !video.hasAttribute("data-hf-clip-hidden") &&
      !video.closest("[data-hyperframes-ignore]") &&
      Boolean(resolveSourceUrl(video)),
  );
  const videoQueue: Array<() => void> = [];
  let activeVideos = 0;
  const pumpVideoQueue = () => {
    while (!disposed && activeVideos < maxConcurrentVideos && videoQueue.length > 0) {
      const next = videoQueue.shift();
      if (!next) break;
      activeVideos += 1;
      next();
    }
  };

  videos.forEach((video, index) => {
    const originalSrc = resolveSourceUrl(video);
    const readyNow = !video.error && video.readyState >= MEDIA_HAVE_CURRENT_DATA;
    const item: TrackedAssetItem = {
      id: `video-${index}`,
      label: assetLabelFromUrl(originalSrc, `video-${index + 1}`),
      kind: "video",
      settled: readyNow,
      failedReason: null,
    };
    items.push(item);
    if (!readyNow) {
      videoQueue.push(() => {
        watchMediaElement(video, item, originalSrc, MEDIA_HAVE_CURRENT_DATA, () => {
          activeVideos = Math.max(0, activeVideos - 1);
          pumpVideoQueue();
        });
      });
    }
  });

  // 5. Lottie animations
  const lotties = (win as (Window & { __hfLottie?: unknown[] }) | null)?.__hfLottie;
  if (Array.isArray(lotties) && lotties.length > 0) {
    lotties.forEach((anim, index) => {
      const readyNow = isLottieAnimationLoaded(anim);
      const item: TrackedAssetItem = {
        id: `lottie-${index}`,
        label: `lottie-${index + 1}`,
        kind: "lottie",
        settled: readyNow,
        failedReason: null,
      };
      items.push(item);
      if (readyNow) return;
      let done = false;
      const pollId = setInterval(() => {
        if (done || disposed) return;
        if (isLottieAnimationLoaded(anim)) {
          done = true;
          clearInterval(pollId);
          cancelTimer();
          settleItem(item, null);
        }
      }, LOTTIE_POLL_MS);
      const cancelPoll = () => clearInterval(pollId);
      cleanups.push(cancelPoll);
      const cancelTimer = scheduleTimeout(itemTimeoutMs, () => {
        if (done || disposed) return;
        done = true;
        cancelPoll();
        settleItem(item, isLottieAnimationLoaded(anim) ? null : "timeout");
      });
    });
  }

  // Emit initial progress before starting queued video preloads.
  emit(true);
  pumpVideoQueue();

  return {
    retryFailed: async () => {
      if (disposed) return [];
      const failedItems = items.filter((item) => item.failedReason !== null && item.retryNow);
      if (failedItems.length === 0) return buildSnapshot().failed;
      manualRetryCounter += 1;
      const attempt = manualRetryCounter;
      await Promise.all(failedItems.map((item) => item.retryNow!(attempt)));
      return buildSnapshot().failed;
    },
    skip: () => {
      if (disposed || skipped) return;
      skipped = true;
      emit(true);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      while (cleanups.length > 0) {
        cleanups.pop()?.();
      }
      videoQueue.length = 0;
    },
  };
}
