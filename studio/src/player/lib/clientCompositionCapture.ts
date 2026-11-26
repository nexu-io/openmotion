import { usePlayerStore } from "../store/playerStore";
import {
  clearRemoteCompositionFilmstripStateForTest,
  scheduleRemoteCompositionFilmstripUpload,
} from "./remoteCompositionFilmstrip";
import {
  acquireSharedPreviewGrant,
  clearSharedPreviewGrantsForTest,
  invalidateSharedPreviewGrant,
  isolatedPreviewOrigin,
} from "./previewLease";
import {
  createThumbnailKey,
  thumbnailScheduler,
  type ThumbnailLoadedResult,
  type ThumbnailRequest,
} from "./thumbnailScheduler";
import {
  CAPTURE_TARGET_WIDTH,
  captureSampleTimes,
  normalizeCompositionPathForGate,
  registerRevisionInvalidationHook,
  resetCompositionRevisionsForTest,
  resolveCompositionRevision,
  selectorCaptureWindowKey,
  stripMemoryCacheKey,
  type ClientCaptureInput,
} from "./compositionRevisionKey";
import {
  clearProgressiveEntry,
  evictStaleCompositionCacheEntries,
  hydrateCachedRecordIntoMemory,
  memoryEntryToThumbnailResult,
  peekMemoryEntry,
  putMemoryStripCache,
  putSharedCoverCache,
  readCachedStripWithCanonicalFallback,
  resetCompositionSpriteCacheForTest,
  retainMemoryEntry,
  setProgressiveEntry,
  writeCachedStrip,
} from "./compositionSpriteCache";

export {
  captureSampleTimes,
  computeCompositionSampleTimes,
  getCompositionCacheKeyRevision,
  getCompositionCacheRevision,
  MAX_CLIENT_COMPOSITION_FRAMES,
  quantizeCompositionFrameCount,
  selectPriorityCompositionPaths,
  selectorCaptureWindowKey,
  setCachedProjectRevision,
  subscribeCompositionCacheRevision,
  updateCachedCompositionRevisions,
  type ClientCaptureInput,
} from "./compositionRevisionKey";

export {
  acquireCachedCompositionCaptureFromIdb,
  getProgressiveCompositionCapture,
  IDB_MAX_BYTES,
  MEMORY_STRIP_CACHE_MAX_BYTES,
  peekCachedCompositionCapture,
  peekFallbackCompositionCapture,
  readClientCompositionStripFromIdbForTest,
  retainCachedCompositionCapture,
  seedClientCompositionCaptureForTest,
  seedClientCompositionSpriteForTest,
  seedSplitCompositionCaptureFallback,
  setClientCompositionIdbMaxBytesForTest,
  setMemoryStripCacheMaxBytesForTest,
  subscribeProgressiveCompositionCapture,
  writeClientCompositionStripToIdbForTest,
} from "./compositionSpriteCache";

const CAPTURE_MAX_HEIGHT = 480;
const CAPTURE_MAX_SCALE = 2;
const CAPTURE_JPEG_QUALITY = 0.78;
const CAPTURE_EXCLUDE_STYLE_PROPS = /^--/;
const OPAQUE_JPEG_URL_RE = /\.jpe?g(?:[?#]|$)/i;
const CAPTURE_BOOT_TIMEOUT_MS = 12_000;
const CAPTURE_MEDIA_TIMEOUT_MS = 2_000;
const CAPTURE_RAF_FALLBACK_MS = 250;
const CAPTURE_FRAME_YIELD_MS = 8;
const CAPTURE_IDLE_TEARDOWN_MS = 1_500;
const MAX_CONCURRENT_ISOLATED_CAPTURES = 3;
const MAX_CONCURRENT_SAME_ORIGIN_CAPTURES = 2;
const MAX_CONCURRENT_EDIT_REFRESH_CAPTURES = 1;

interface CapturePreviewWindow extends Window {
  __player?: {
    seek?: (time: number) => void;
    pause?: () => void;
    getDuration?: () => number;
  };
}

type SnapdomModuleFn = typeof import("@zumer/snapdom").snapdom;

type ProgressiveFrameCallback = (
  index: number,
  total: number,
  blob: Blob,
  dims: { aspect: number; width: number; height: number },
) => void;

type CaptureQueuePriority = "overscan" | "visible" | "gate" | "interaction";

const CAPTURE_PRIORITY_RANK: Readonly<Record<CaptureQueuePriority, number>> = {
  overscan: 0,
  visible: 1,
  gate: 2,
  interaction: 3,
};

interface LoadedCaptureState {
  docKey: string;
  projectId: string;
  compPath: string;
  compRev: string;
  contentRevision: number;
  origin: string;
  token: string;
  tokenExpiresAt: number;
  duration: number;
}

interface CaptureIframeSlot {
  iframe: HTMLIFrameElement;
  busy: boolean;
  loaded: LoadedCaptureState | null;
}

interface QueuedCaptureJob {
  priority: CaptureQueuePriority;
  docKey: string;
  isEditRefresh: boolean;
  seq: number;
  signal: AbortSignal;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

let testCapabilityOverride: boolean | null = null;
let snapdomLoader: Promise<SnapdomModuleFn | null> | null = null;

const captureIframePool: CaptureIframeSlot[] = [];
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let activeCaptureCount = 0;
let activeEditRefreshCount = 0;
let captureJobSeq = 0;
const activeDocKeys = new Set<string>();
const pendingCaptureJobs: QueuedCaptureJob[] = [];

/** Override browser capture eligibility in unit tests. */
export function setClientCompositionCaptureCapabilityForTest(enabled: boolean | null): void {
  testCapabilityOverride = enabled;
}

export function canCaptureCompositionInBrowser(): boolean {
  if (testCapabilityOverride !== null) return testCapabilityOverride;
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (typeof HTMLCanvasElement === "undefined" || typeof requestAnimationFrame !== "function") return false;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/HappyDOM|jsdom/i.test(ua)) return false;
  return true;
}

/** Reset in-memory capture caches, revisions, and iframe pool between unit tests. */
export function clearClientCompositionCaptureCacheForTest(): void {
  cancelIdleTeardown();
  for (const slot of captureIframePool) {
    slot.loaded = null;
    try {
      slot.iframe.src = "about:blank";
      slot.iframe.remove();
    } catch {
      // ignore teardown errors
    }
  }
  captureIframePool.length = 0;
  activeCaptureCount = 0;
  activeEditRefreshCount = 0;
  activeDocKeys.clear();
  pendingCaptureJobs.length = 0;
  resetCompositionSpriteCacheForTest();
  resetCompositionRevisionsForTest();
  clearRemoteCompositionFilmstripStateForTest();
  clearSharedPreviewGrantsForTest();
  thumbnailScheduler.setOpeningGateActive(usePlayerStore.getState().editorInputLocked);
}

function resetCaptureIframe(iframe: HTMLIFrameElement): void {
  try {
    iframe.src = "about:blank";
  } catch {
    // ignore reset errors
  }
}

function evictStaleCapturePoolSlots(projectId: string): void {
  for (const slot of captureIframePool) {
    if (slot.busy || !slot.loaded || slot.loaded.projectId !== projectId) continue;
    if (slot.loaded.compRev === resolveCompositionRevision(projectId, slot.loaded.compPath).rev) continue;
    slot.loaded = null;
    resetCaptureIframe(slot.iframe);
  }
}

registerRevisionInvalidationHook((projectId) => {
  evictStaleCapturePoolSlots(projectId);
});

/**
 * Proactively drop cached strip/cover entries and idle capture iframes whose revision
 * was superseded by a persisted file edit, freeing old blobs and object URLs immediately
 * instead of waiting for LRU eviction while keeping at most one fallback strip per clip
 * until the refreshed capture completes.
 */
export function evictStaleCompositionCaptures(
  projectId: string,
  compositions: readonly string[] | null = null,
  currentRevisions?: Readonly<Record<string, number>>,
): void {
  if (!projectId) return;
  const isStale = evictStaleCompositionCacheEntries(projectId, compositions, currentRevisions);
  for (const slot of captureIframePool) {
    if (slot.busy || !slot.loaded || slot.loaded.projectId !== projectId) continue;
    if (!isStale(slot.loaded.compPath, slot.loaded.contentRevision)) continue;
    slot.loaded = null;
    resetCaptureIframe(slot.iframe);
  }
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function nextAnimationFrames(win: Window, count: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let rafId = 0;
    let remaining = Math.max(1, count);
    let settled = false;
    const cleanup = () => {
      clearTimeout(fallbackTimer);
      win.cancelAnimationFrame?.(rafId);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    const fallbackTimer = setTimeout(finish, CAPTURE_RAF_FALLBACK_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    const step = () => {
      if (settled) return;
      if (--remaining <= 0) {
        finish();
        return;
      }
      rafId = win.requestAnimationFrame(step);
    };
    rafId = win.requestAnimationFrame(step);
  });
}

async function waitUntilInteractiveIdle(signal: AbortSignal, gatePriority = false): Promise<void> {
  // Wait for primary composition assets to finish so capture hits the warm HTTP cache
  // without competing with initial preview loads, and yield while playing or hidden.
  // While the opening gate is up (`editorInputLocked`), only gated timeline clips may run
  // so non-gated sidebar cards never spawn SnapDOM iframes or contend for sockets.
  while (!signal.aborted) {
    const state = usePlayerStore.getState();
    const gateAllowed = gatePriority || !state.editorInputLocked;
    const assetsSettled =
      state.assetReadinessPhase === "ready" || state.assetReadinessSkipped || !state.editorInputLocked;
    if (gateAllowed && assetsSettled && !state.isPlaying && (typeof document === "undefined" || !document.hidden)) {
      return;
    }
    await sleepAbortable(60, signal);
  }
  throw abortError();
}

// ---------------------------------------------------------------------------
// Bounded Concurrent Offscreen Capture Iframe Pool (steady-state 0 RAM)
// ---------------------------------------------------------------------------

function maxConcurrentCaptures(): number {
  return isolatedPreviewOrigin()
    ? MAX_CONCURRENT_ISOLATED_CAPTURES
    : MAX_CONCURRENT_SAME_ORIGIN_CAPTURES;
}

function cancelIdleTeardown(): void {
  if (teardownTimer !== null) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
}

function scheduleIdleTeardown(): void {
  cancelIdleTeardown();
  if (activeCaptureCount > 0 || pendingCaptureJobs.length > 0) return;
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    if (activeCaptureCount > 0 || pendingCaptureJobs.length > 0 || captureIframePool.length === 0) return;
    for (const slot of captureIframePool) {
      slot.loaded = null;
      try {
        slot.iframe.src = "about:blank";
        slot.iframe.remove();
      } catch {
        // ignore teardown errors
      }
    }
    captureIframePool.length = 0;
  }, CAPTURE_IDLE_TEARDOWN_MS);
}

function createCaptureIframe(width: number, height: number): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("data-openmotion-thumb-capture", "true");
  iframe.setAttribute("inert", "");
  iframe.tabIndex = -1;
  iframe.referrerPolicy = "no-referrer";
  iframe.allow = "autoplay 'none'";
  iframe.sandbox.add("allow-scripts", "allow-same-origin");
  // Keep hidden capture frames intersecting the viewport (0 opacity, behind the app):
  // positioning a cross-origin preview iframe offscreen (e.g. left: -10000px) causes Chromium
  // to throttle/suspend requestAnimationFrame inside isolated preview captures.
  Object.assign(iframe.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: `${width}px`,
    height: `${height}px`,
    opacity: "0",
    border: "0",
    pointerEvents: "none",
    zIndex: "-1",
  });
  document.body.appendChild(iframe);
  return iframe;
}

function acquireCaptureSlot(width = 1280, height = 720, preferredDocKey?: string): CaptureIframeSlot {
  cancelIdleTeardown();
  let warmMatch: CaptureIframeSlot | null = null;
  let emptySlot: CaptureIframeSlot | null = null;
  let fallbackSlot: CaptureIframeSlot | null = null;
  for (let i = captureIframePool.length - 1; i >= 0; i--) {
    const slot = captureIframePool[i]!;
    if (!slot.iframe.isConnected) {
      if (!slot.busy) {
        slot.loaded = null;
        captureIframePool.splice(i, 1);
      }
      continue;
    }
    if (slot.busy) continue;
    if (preferredDocKey && slot.loaded?.docKey === preferredDocKey) {
      warmMatch = slot;
      break;
    }
    if (!slot.loaded && !emptySlot) {
      emptySlot = slot;
    } else if (!fallbackSlot) {
      fallbackSlot = slot;
    }
  }
  const chosen = warmMatch ?? emptySlot ?? fallbackSlot;
  if (chosen) {
    chosen.busy = true;
    if (!warmMatch) {
      chosen.loaded = null;
      chosen.iframe.style.width = `${width}px`;
      chosen.iframe.style.height = `${height}px`;
    }
    return chosen;
  }
  const slot: CaptureIframeSlot = {
    iframe: createCaptureIframe(width, height),
    busy: true,
    loaded: null,
  };
  captureIframePool.push(slot);
  return slot;
}

function releaseCaptureSlot(slot: CaptureIframeSlot, reset: boolean): void {
  if (reset) {
    slot.loaded = null;
    resetCaptureIframe(slot.iframe);
  }
  slot.busy = false;
}

let previewSafeFetchDepth = 0;
let previewSafeFetchOrig: typeof fetch | null = null;
let previewSafeFetchWrapped: typeof fetch | null = null;

/**
 * SnapDOM defaults same-origin image/CSS fetches to `credentials: "include"`.
 * In cloud mode, `/api/projects/:id/preview/*` 302-redirects to cross-origin presigned
 * S3/R2/OSS URLs that do not emit `Access-Control-Allow-Credentials: true`, so `"include"`
 * fails with a CORS error and renders placeholder boxes. Downgrading preview-asset requests
 * to `"same-origin"` keeps cookies on the first hop and drops them across the 302 redirect.
 * Ref-counted so concurrent same-origin captures share one wrapper and only the outermost
 * owner restores `globalThis.fetch`.
 */
export async function withPreviewRedirectSafeFetch<T>(run: () => Promise<T>): Promise<T> {
  if (typeof globalThis.fetch !== "function") return run();
  if (previewSafeFetchDepth === 0) {
    const origFetch = globalThis.fetch;
    const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
      const baseHref = typeof window !== "undefined" ? window.location.href : "";
      const baseOrigin = typeof window !== "undefined" ? window.location.origin : "";
      if (init?.credentials === "include" && baseOrigin) {
        try {
          const rawUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : typeof input?.url === "string"
                  ? input.url
                  : "";
          if (rawUrl) {
            const parsed = new URL(rawUrl, baseHref);
            if (
              parsed.origin === baseOrigin &&
              /^\/api\/projects\/[^/]+\/preview\//.test(parsed.pathname)
            ) {
              return origFetch.call(globalThis, input, { ...init, credentials: "same-origin" });
            }
          }
        } catch {
          // ignore URL parse errors and fall through to original fetch
        }
      }
      return origFetch.call(globalThis, input, init);
    }) as typeof fetch;
    previewSafeFetchOrig = origFetch;
    previewSafeFetchWrapped = wrapped;
    globalThis.fetch = wrapped;
  }
  previewSafeFetchDepth += 1;
  try {
    return await run();
  } finally {
    previewSafeFetchDepth = Math.max(0, previewSafeFetchDepth - 1);
    if (previewSafeFetchDepth === 0) {
      if (previewSafeFetchOrig && globalThis.fetch === previewSafeFetchWrapped) {
        globalThis.fetch = previewSafeFetchOrig;
      }
      previewSafeFetchOrig = null;
      previewSafeFetchWrapped = null;
    }
  }
}

function findIdleWarmDocKeys(): Set<string> {
  const warm = new Set<string>();
  for (const slot of captureIframePool) {
    if (!slot.busy && slot.iframe.isConnected && slot.loaded) {
      warm.add(slot.loaded.docKey);
    }
  }
  return warm;
}

function pumpCaptureQueue(): void {
  const limit = maxConcurrentCaptures();
  while (activeCaptureCount < limit && pendingCaptureJobs.length > 0) {
    const warmDocKeys = findIdleWarmDocKeys();
    let bestIdx = -1;
    for (let i = 0; i < pendingCaptureJobs.length; i++) {
      const cand = pendingCaptureJobs[i]!;
      // Never load the exact same composition document into two hidden iframes at once;
      // sibling clips wait briefly and then reuse the warm loaded iframe without reloading.
      if (activeDocKeys.has(cand.docKey)) continue;
      if (cand.isEditRefresh && activeEditRefreshCount >= MAX_CONCURRENT_EDIT_REFRESH_CAPTURES) continue;
      if (bestIdx < 0) {
        bestIdx = i;
        continue;
      }
      const best = pendingCaptureJobs[bestIdx]!;
      const delta = CAPTURE_PRIORITY_RANK[cand.priority] - CAPTURE_PRIORITY_RANK[best.priority];
      if (delta > 0) {
        bestIdx = i;
      } else if (delta === 0) {
        const candWarm = warmDocKeys.has(cand.docKey) ? 1 : 0;
        const bestWarm = warmDocKeys.has(best.docKey) ? 1 : 0;
        if (candWarm > bestWarm || (candWarm === bestWarm && cand.seq < best.seq)) {
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0) break;
    const [job] = pendingCaptureJobs.splice(bestIdx, 1);
    if (!job) break;
    job.signal.removeEventListener("abort", job.onAbort);
    if (job.signal.aborted) {
      job.reject(abortError());
      continue;
    }
    activeCaptureCount += 1;
    activeDocKeys.add(job.docKey);
    if (job.isEditRefresh) activeEditRefreshCount += 1;
    cancelIdleTeardown();
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeCaptureCount = Math.max(0, activeCaptureCount - 1);
        activeDocKeys.delete(job.docKey);
        if (job.isEditRefresh) {
          activeEditRefreshCount = Math.max(0, activeEditRefreshCount - 1);
        }
        if (pendingCaptureJobs.length > 0) {
          pumpCaptureQueue();
        } else {
          scheduleIdleTeardown();
        }
      });
  }
  if (activeCaptureCount === 0 && pendingCaptureJobs.length === 0) {
    scheduleIdleTeardown();
  }
}

function resolveQueuePriority(input: Pick<ClientCaptureInput, "priority" | "gatePriority">): CaptureQueuePriority {
  if (input.priority === "interaction") return "interaction";
  if (input.gatePriority) return "gate";
  if (input.priority === "overscan") return "overscan";
  return "visible";
}

function enqueueSerializedCapture<T>(
  priority: CaptureQueuePriority,
  docKey: string,
  isEditRefresh: boolean,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const job: QueuedCaptureJob = {
      priority,
      docKey,
      isEditRefresh,
      seq: ++captureJobSeq,
      signal,
      task,
      resolve: (value) => resolve(value as T),
      reject,
      onAbort: () => {
        const idx = pendingCaptureJobs.indexOf(job);
        if (idx >= 0) {
          pendingCaptureJobs.splice(idx, 1);
          reject(abortError());
        }
      },
    };
    signal.addEventListener("abort", job.onAbort, { once: true });
    pendingCaptureJobs.push(job);
    cancelIdleTeardown();
    pumpCaptureQueue();
  });
}

// ---------------------------------------------------------------------------
// Same-Origin & Isolated-Origin SnapDOM Frame Capture Engine
// ---------------------------------------------------------------------------

async function loadLocalSnapdom(): Promise<SnapdomModuleFn | null> {
  if (!snapdomLoader) {
    snapdomLoader = import("@zumer/snapdom")
      .then((mod) => (typeof mod.snapdom === "function" ? mod.snapdom : null))
      .catch(() => null);
  }
  return snapdomLoader;
}

function hasVisibleText(node: Node): boolean {
  if (node.nodeType === 3) return Boolean((node.nodeValue ?? "").replace(/\s+/g, "").trim());
  if (node.nodeType !== 1) return false;
  const tag = (node as Element).tagName.toUpperCase();
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "CANVAS") {
    return false;
  }
  if (!node.childNodes || node.childNodes.length === 0) {
    return Boolean((node.textContent ?? "").replace(/\s+/g, "").trim());
  }
  for (const child of Array.from(node.childNodes)) {
    if (hasVisibleText(child)) return true;
  }
  return false;
}

function findPureCanvasTarget(root: Element, stageW: number, stageH: number): HTMLCanvasElement | null {
  if (root instanceof HTMLCanvasElement) return root;
  const canvases = root.querySelectorAll("canvas");
  if (canvases.length !== 1) return null;
  if (hasVisibleText(root)) return null;
  if (root.querySelector("img,svg,video")) return null;
  const canvas = canvases[0]!;
  const rect = canvas.getBoundingClientRect();
  return rect.width >= stageW * 0.9 && rect.height >= stageH * 0.9 ? canvas : null;
}

function isOrContainsDynamicVisual(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === "CANVAS" || tag === "VIDEO") return true;
  return Boolean(el.querySelector("canvas,video"));
}

function canSkipUnchangedFrame(doc: Document, target: Element): boolean {
  if (typeof MutationObserver !== "function" || typeof doc.getAnimations !== "function") return false;
  if (isOrContainsDynamicVisual(target)) return false;
  try {
    return doc.getAnimations().length === 0;
  } catch {
    return false;
  }
}

function releaseCanvasBacking(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // ignore teardown errors
  }
}

function drawToJpegBlob(
  source: CanvasImageSource,
  outW: number,
  outH: number,
  reusable?: HTMLCanvasElement,
): Promise<Blob> {
  const out = reusable ?? document.createElement("canvas");
  if (out.width !== outW) out.width = outW;
  if (out.height !== outH) out.height = outH;
  const ctx = out.getContext("2d");
  if (!ctx) {
    if (!reusable) releaseCanvasBacking(out);
    return Promise.reject(new Error("2D context unavailable"));
  }
  ctx.clearRect(0, 0, outW, outH);
  ctx.drawImage(source, 0, 0, outW, outH);
  return new Promise((resolve, reject) => {
    out.toBlob(
      (blob) => {
        if (!reusable) releaseCanvasBacking(out);
        if (blob && blob.size > 0) resolve(blob);
        else reject(new Error("Failed to encode composition thumbnail frame"));
      },
      "image/jpeg",
      CAPTURE_JPEG_QUALITY,
    );
  });
}

function encodeCaptureInlineDataUrl(canvas: HTMLCanvasElement, sourceUrl: string): string {
  const webp = canvas.toDataURL("image/webp", 0.8);
  if (webp && webp.startsWith("data:image/webp")) return webp;
  if (OPAQUE_JPEG_URL_RE.test(sourceUrl)) {
    const jpeg = canvas.toDataURL("image/jpeg", 0.82);
    if (jpeg && jpeg.startsWith("data:image/jpeg")) return jpeg;
  }
  if (webp && webp.startsWith("data:image/")) return webp;
  return canvas.toDataURL("image/png");
}

function inlineDecodedSameOriginImages(root: Element, maxDim: number): void {
  const imgs = root.querySelectorAll("img");
  if (!imgs.length) return;
  const limit = Math.max(160, Math.min(480, maxDim || 320));
  const cache = new Map<string, string | null>();
  let scratch: HTMLCanvasElement | null = null;
  for (const img of Array.from(imgs)) {
    if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) continue;
    const rawSrc = img.getAttribute("src") ?? "";
    if (rawSrc.startsWith("data:")) continue;
    const key = img.currentSrc || img.src || rawSrc;
    if (!key) continue;
    let dataUrl = cache.get(key);
    if (dataUrl === undefined) {
      try {
        const natW = img.naturalWidth;
        const natH = img.naturalHeight;
        const scale = Math.min(1, limit / Math.max(natW, natH));
        const cw = Math.max(1, Math.round(natW * scale));
        const ch = Math.max(1, Math.round(natH * scale));
        if (!scratch) scratch = document.createElement("canvas");
        scratch.width = cw;
        scratch.height = ch;
        const ctx = scratch.getContext("2d");
        if (!ctx) {
          cache.set(key, null);
          continue;
        }
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        dataUrl = encodeCaptureInlineDataUrl(scratch, key);
        cache.set(key, dataUrl);
      } catch {
        // Discard a tainted scratch canvas so subsequent local images still inline.
        scratch = null;
        cache.set(key, null);
        continue;
      }
    }
    if (!dataUrl) continue;
    if (!img.hasAttribute("width") && !img.hasAttribute("height")) {
      img.setAttribute("width", String(img.naturalWidth));
      img.setAttribute("height", String(img.naturalHeight));
    }
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.setAttribute("src", dataUrl);
  }
  if (scratch) releaseCanvasBacking(scratch);
}

async function waitForDocumentMedia(doc: Document, signal: AbortSignal): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (doc.fonts?.ready) tasks.push(doc.fonts.ready.catch(() => undefined));
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    if (img.complete) continue;
    if (!img.getAttribute("src") && !img.getAttribute("srcset")) continue;
    if (img.loading === "lazy") img.loading = "eager";
    tasks.push(
      new Promise<void>((resolve) => {
        const done = () => {
          img.removeEventListener("load", done);
          img.removeEventListener("error", done);
          resolve();
        };
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      }),
    );
  }
  if (tasks.length === 0) return;
  await Promise.race([
    Promise.all(tasks),
    sleepAbortable(CAPTURE_MEDIA_TIMEOUT_MS, signal),
  ]);
}

function buildCaptureUrl(previewUrl: string, contentRevision: number, fileVersion?: string): URL {
  const url = new URL(previewUrl, window.location.origin);
  url.searchParams.set("capture", "1");
  const revisionToken = fileVersion || (contentRevision > 0 ? String(contentRevision) : "");
  if (revisionToken) url.searchParams.set("revision", revisionToken);
  return url;
}

function buildCaptureDocumentKey(
  input: Pick<ClientCaptureInput, "projectId" | "previewUrl" | "contentRevision">,
  previewOrigin: string | undefined,
): string {
  const { rev: compRev, hasFileVersion } = resolveCompositionRevision(input.projectId, input.previewUrl);
  const revTag = hasFileVersion ? 0 : input.contentRevision;
  if (previewOrigin) {
    const expectedOrigin = new URL(previewOrigin).origin;
    const source = new URL(input.previewUrl, window.location.origin);
    return `iso|${expectedOrigin}|${source.pathname}|${source.search}|rev=${revTag}|compRev=${compRev}`;
  }
  const captureUrl = buildCaptureUrl(input.previewUrl, input.contentRevision, compRev);
  return `same|${captureUrl.href}|compRev=${compRev}`;
}

function computeBoundedCaptureDimensions(
  targetW: number,
  targetH: number,
): { outW: number; outH: number; scale: number; aspect: number } {
  const safeW = Math.max(1, targetW);
  const safeH = Math.max(1, targetH);
  let outW = CAPTURE_TARGET_WIDTH;
  const outH = Math.max(27, Math.min(CAPTURE_MAX_HEIGHT, Math.round((outW * safeH) / safeW)));
  if (outH === CAPTURE_MAX_HEIGHT) {
    outW = Math.max(48, Math.min(CAPTURE_TARGET_WIDTH, Math.round((outH * safeW) / safeH)));
  }
  const scale = Math.min(CAPTURE_MAX_SCALE, outW / safeW);
  return { outW, outH, scale, aspect: safeW / safeH };
}

async function captureSameOrigin(
  input: ClientCaptureInput,
  docKey: string,
  signal: AbortSignal,
  onFrame?: ProgressiveFrameCallback,
  onCaptureStarted?: () => void,
): Promise<{ blobs: Blob[]; aspect: number; width: number; height: number }> {
  const snapdom = await loadLocalSnapdom();
  if (!snapdom) throw new Error("SnapDOM unavailable");
  if (signal.aborted) throw abortError();

  const compPath = normalizeCompositionPathForGate(input.previewUrl);
  const { rev: compRev } = resolveCompositionRevision(input.projectId, input.previewUrl);
  onCaptureStarted?.();
  const slot = acquireCaptureSlot(1280, 720, docKey);
  const iframe = slot.iframe;
  const captureUrl = buildCaptureUrl(input.previewUrl, input.contentRevision, compRev);
  let resetSlot = false;

  try {
    let win = iframe.contentWindow as CapturePreviewWindow | null;
    let doc = iframe.contentDocument;
    const canReuseWarm =
      slot.loaded !== null &&
      slot.loaded.docKey === docKey &&
      win !== null &&
      doc !== null &&
      typeof win.__player?.seek === "function";

    if (!canReuseWarm) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out loading offscreen composition for thumbnail capture"));
        }, CAPTURE_BOOT_TIMEOUT_MS);
        const onLoad = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("Failed to load offscreen composition"));
        };
        const onAbort = () => {
          cleanup();
          reject(abortError());
        };
        function cleanup() {
          clearTimeout(timeout);
          iframe.removeEventListener("load", onLoad);
          iframe.removeEventListener("error", onError);
          signal.removeEventListener("abort", onAbort);
        }
        iframe.addEventListener("load", onLoad, { once: true });
        iframe.addEventListener("error", onError, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
        iframe.src = captureUrl.href;
      });

      win = iframe.contentWindow as CapturePreviewWindow | null;
      doc = iframe.contentDocument;
      if (!win || !doc) throw new Error("Offscreen capture frame is inaccessible");

      // Wait for HyperFrames player bootstrap inside the offscreen document.
      const deadline = Date.now() + CAPTURE_BOOT_TIMEOUT_MS;
      while (!signal.aborted) {
        const dur = win.__player?.getDuration?.() ?? 0;
        if (win.__player?.seek && Number.isFinite(dur) && dur > 0) break;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for composition player");
        await sleepAbortable(30, signal);
      }
      if (signal.aborted) throw abortError();
    }

    if (!win || !doc) throw new Error("Offscreen capture frame is inaccessible");

    win.__player?.pause?.();
    const root = (doc.querySelector("[data-composition-id]") ?? doc.body) as Element;
    const stageW = Number(root.getAttribute("data-width")) || root.clientWidth || 1280;
    const stageH = Number(root.getAttribute("data-height")) || root.clientHeight || 720;
    if (!canReuseWarm) {
      iframe.style.width = `${stageW}px`;
      iframe.style.height = `${stageH}px`;
      await waitForDocumentMedia(doc, signal);
      if (signal.aborted) throw abortError();
      slot.loaded = {
        docKey,
        projectId: input.projectId,
        compPath,
        compRev,
        contentRevision: input.contentRevision,
        origin: window.location.origin,
        token: "",
        tokenExpiresAt: Number.POSITIVE_INFINITY,
        duration: win.__player?.getDuration?.() || 0,
      };
    }

    let target: Element = root;
    if (input.selector) {
      try {
        const match = doc.querySelectorAll(input.selector)[input.selectorIndex ?? 0];
        if (match) target = match;
      } catch {
        // invalid selector falls back to stage root
      }
    }
    let targetW = stageW;
    let targetH = stageH;
    if (target !== root) {
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        targetW = rect.width;
        targetH = rect.height;
      }
    }

    const { outW, outH, scale, aspect } = computeBoundedCaptureDimensions(targetW, targetH);
    inlineDecodedSameOriginImages(target, Math.min(320, Math.max(240, outW * 2)));
    const actualDuration = win.__player?.getDuration?.() || 0;
    const effectiveFrameCount =
      !input.selector && actualDuration > 0 && actualDuration <= 0.5 ? 1 : input.frameCount;
    const times = captureSampleTimes(actualDuration, { ...input, frameCount: effectiveFrameCount });
    const order: number[] = [];
    if (onFrame && times.length >= 3) {
      const coverIdx = Math.floor(times.length / 2);
      order.push(coverIdx);
      for (let i = 0; i < times.length; i++) {
        if (i !== coverIdx) order.push(i);
      }
    } else {
      for (let i = 0; i < times.length; i++) order.push(i);
    }

    const hasAsyncVisual = isOrContainsDynamicVisual(target);
    const settleFrames = hasAsyncVisual ? 2 : 1;
    const outCanvas = document.createElement("canvas");
    let observer: MutationObserver | null = null;
    let observedMutated = false;
    const observeRoot = doc.documentElement ?? (target === root ? root : null);
    if (times.length > 1 && observeRoot && canSkipUnchangedFrame(doc, target)) {
      try {
        observer = new MutationObserver(() => {
          observedMutated = true;
        });
        observer.observe(observeRoot, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        });
      } catch {
        observer = null;
      }
    }

    const blobs: Array<Blob | undefined> = new Array(times.length);
    let lastBlob: Blob | null = null;
    try {
      for (const frameIdx of order) {
        const t = times[frameIdx]!;
        await waitUntilInteractiveIdle(signal, Boolean(input.gatePriority));
        if (observer) {
          observer.takeRecords();
          observedMutated = false;
        }
        win.__player!.seek!(t);
        await nextAnimationFrames(win, settleFrames, signal);

        let blob: Blob;
        if (
          observer &&
          lastBlob &&
          !observedMutated &&
          observer.takeRecords().length === 0 &&
          canSkipUnchangedFrame(doc, target)
        ) {
          blob = lastBlob;
        } else {
          const pureCanvas = findPureCanvasTarget(target, targetW, targetH);
          if (pureCanvas) {
            blob = await drawToJpegBlob(pureCanvas, outW, outH, outCanvas);
          } else {
            const rendered = await withPreviewRedirectSafeFetch(async () => {
              const snap = await snapdom(target, {
                scale,
                dpr: 1,
                fast: "auto",
                embedFonts: false,
                placeholders: false,
                excludeStyleProps: CAPTURE_EXCLUDE_STYLE_PROPS,
                exclude: "video",
              });
              return snap.toCanvas();
            });
            try {
              blob = await drawToJpegBlob(rendered, outW, outH, outCanvas);
            } finally {
              releaseCanvasBacking(rendered);
            }
          }
        }
        lastBlob = blob;
        blobs[frameIdx] = blob;
        onFrame?.(frameIdx, times.length, blob, { aspect, width: outW, height: outH });
        if (times.length > 1) await sleepAbortable(CAPTURE_FRAME_YIELD_MS, signal);
      }
    } finally {
      observer?.disconnect();
      releaseCanvasBacking(outCanvas);
    }

    return {
      blobs: blobs.filter((b): b is Blob => Boolean(b)),
      aspect,
      width: outW,
      height: outH,
    };
  } catch (error) {
    resetSlot = true;
    throw error;
  } finally {
    releaseCaptureSlot(slot, resetSlot);
  }
}

async function captureIsolatedOrigin(
  input: ClientCaptureInput,
  previewOrigin: string,
  docKey: string,
  signal: AbortSignal,
  onFrame?: ProgressiveFrameCallback,
  onCaptureStarted?: () => void,
): Promise<{ blobs: Blob[]; aspect: number; width: number; height: number }> {
  const expectedOrigin = new URL(previewOrigin).origin;
  const grant = await acquireSharedPreviewGrant(input.projectId, expectedOrigin, signal);
  const token = grant.token;

  const compPath = normalizeCompositionPathForGate(input.previewUrl);
  const { rev: compRev } = resolveCompositionRevision(input.projectId, input.previewUrl);
  const source = new URL(input.previewUrl, window.location.origin);
  const isolatedUrl = new URL(source.pathname, expectedOrigin);
  isolatedUrl.search = source.search;
  isolatedUrl.searchParams.set("capture", "1");
  const revisionToken = compRev || (input.contentRevision > 0 ? String(input.contentRevision) : "");
  if (revisionToken) isolatedUrl.searchParams.set("revision", revisionToken);
  isolatedUrl.searchParams.set("pt", token);

  if (signal.aborted) throw abortError();
  onCaptureStarted?.();
  const slot = acquireCaptureSlot(1920, 1080, docKey);
  const iframe = slot.iframe;
  let resetSlot = false;

  try {
    const canReuseWarm =
      slot.loaded !== null &&
      slot.loaded.docKey === docKey &&
      slot.loaded.origin === expectedOrigin &&
      slot.loaded.token === token &&
      slot.loaded.tokenExpiresAt > Date.now() + 5_000 &&
      iframe.contentWindow !== null;

    let duration: number;
    if (canReuseWarm) {
      duration = slot.loaded!.duration;
    } else {
      duration = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          if (grant.expiresAt <= Date.now()) {
            invalidateSharedPreviewGrant(input.projectId, token);
          }
          reject(new Error("Timed out waiting for isolated capture bridge"));
        }, CAPTURE_BOOT_TIMEOUT_MS);
        const onMessage = (event: MessageEvent) => {
          if (event.origin !== expectedOrigin || event.source !== iframe.contentWindow) return;
          const data = event.data;
          if (!data || data.source !== "openmotion-preview-bridge" || data.token !== token) return;
          if (data.type === "preview-build-busy") {
            cleanup();
            reject(new Error("Isolated preview builder is busy"));
            return;
          }
          if (data.type === "timeline-state" && typeof data.duration === "number" && data.duration > 0) {
            if (typeof data.width === "number" && data.width > 0 && typeof data.height === "number" && data.height > 0) {
              iframe.style.width = `${data.width}px`;
              iframe.style.height = `${data.height}px`;
            }
            cleanup();
            resolve(data.duration);
          }
        };
        const onAbort = () => {
          cleanup();
          reject(abortError());
        };
        function cleanup() {
          clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          signal.removeEventListener("abort", onAbort);
        }
        window.addEventListener("message", onMessage);
        signal.addEventListener("abort", onAbort, { once: true });
        iframe.src = isolatedUrl.href;
      });
      slot.loaded = {
        docKey,
        projectId: input.projectId,
        compPath,
        compRev,
        contentRevision: input.contentRevision,
        origin: expectedOrigin,
        token,
        tokenExpiresAt: grant.expiresAt,
        duration,
      };
    }

    const effectiveFrameCount =
      !input.selector && duration > 0 && duration <= 0.5 ? 1 : input.frameCount;
    const times = captureSampleTimes(duration, { ...input, frameCount: effectiveFrameCount });
    const requestId = `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const streamedBlobs: Array<Blob | undefined> = new Array(times.length);
    let streamedCount = 0;

    const payload = await new Promise<{
      frames?: ArrayBuffer[];
      streamed?: boolean;
      frameCount?: number;
      mimeType?: string;
      width?: number;
      height?: number;
      aspect?: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out capturing frames from isolated preview"));
      }, CAPTURE_BOOT_TIMEOUT_MS * 2);
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== expectedOrigin || event.source !== iframe.contentWindow) return;
        const data = event.data;
        if (!data || data.source !== "openmotion-preview-bridge" || data.token !== token) return;
        if (data.type === "capture-frame" && data.requestId === requestId) {
          const idx = typeof data.index === "number" ? data.index : -1;
          if (idx >= 0 && idx < times.length && data.frame instanceof ArrayBuffer) {
            const mime = typeof data.mimeType === "string" && data.mimeType ? data.mimeType : "image/jpeg";
            const blob = new Blob([data.frame], { type: mime });
            if (!streamedBlobs[idx]) streamedCount += 1;
            streamedBlobs[idx] = blob;
            onFrame?.(idx, Number(data.total) || times.length, blob, {
              aspect: typeof data.aspect === "number" && data.aspect > 0 ? data.aspect : 16 / 9,
              width: typeof data.width === "number" && data.width > 0 ? data.width : CAPTURE_TARGET_WIDTH,
              height: typeof data.height === "number" && data.height > 0 ? data.height : 90,
            });
          }
          return;
        }
        if (data.type === "response" && data.requestId === requestId) {
          cleanup();
          if (data.ok && data.result && (Array.isArray(data.result.frames) || data.result.streamed)) {
            resolve(data.result);
          } else {
            reject(new Error(String(data.error || "Isolated capture failed")));
          }
        }
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      function cleanup() {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        signal.removeEventListener("abort", onAbort);
      }
      window.addEventListener("message", onMessage);
      signal.addEventListener("abort", onAbort, { once: true });
      iframe.contentWindow?.postMessage(
        {
          source: "openmotion-studio",
          version: 1,
          type: "capture-frames",
          projectId: input.projectId,
          token,
          requestId,
          times,
          width: CAPTURE_TARGET_WIDTH,
          selector: input.selector,
          selectorIndex: input.selectorIndex,
          progressive: Boolean(onFrame),
        },
        expectedOrigin,
      );
    });

    const mimeType = payload.mimeType || "image/jpeg";
    const blobs =
      streamedCount > 0
        ? streamedBlobs.filter((b): b is Blob => Boolean(b))
        : (payload.frames ?? []).map((buf) => new Blob([buf], { type: mimeType }));
    return {
      blobs,
      aspect: payload.aspect && payload.aspect > 0 ? payload.aspect : 16 / 9,
      width: payload.width || CAPTURE_TARGET_WIDTH,
      height: payload.height || 90,
    };
  } catch (error) {
    resetSlot = true;
    throw error;
  } finally {
    releaseCaptureSlot(slot, resetSlot);
  }
}

async function runClientCompositionCapture(
  input: ClientCaptureInput,
  signal: AbortSignal,
  onCaptureStarted?: () => void,
): Promise<ThumbnailLoadedResult> {
  const { idbKey, baseCoverKey, compPathKey, meta } = stripMemoryCacheKey(input);

  // 0 & 1. Fast path: synchronous in-memory strip/cover hit (including downsampling from canonical strips).
  const memHit = peekMemoryEntry(input);
  if (memHit) {
    const release = retainMemoryEntry(memHit.entry);
    const isCover = memHit.value === memHit.entry.coverValue && memHit.value !== memHit.entry.value;
    return {
      value: memHit.value,
      weight: isCover ? memHit.entry.width * memHit.entry.height * 4 : memHit.entry.weight,
      dispose: release,
    };
  }

  // 2. Fast path: persistent IndexedDB hit across page refreshes (reusing canonical strip/sprite when present).
  const found = await readCachedStripWithCanonicalFallback(idbKey, baseCoverKey, input.frameCount);
  if (signal.aborted) throw abortError();
  if (found) {
    const entry = hydrateCachedRecordIntoMemory(
      found.storageKey,
      baseCoverKey,
      compPathKey,
      meta,
      found.record,
    );
    if (entry) {
      if (input.frameCount === 1) {
        const release = retainMemoryEntry(entry);
        return {
          value: entry.coverValue,
          weight:
            entry.coverValue === entry.value
              ? entry.weight
              : entry.width * entry.height * 4,
          dispose: release,
        };
      }
      return memoryEntryToThumbnailResult(entry);
    }
  }

  // 3. Priority-queued bounded-pool offscreen browser capture (paused during playback).
  const queuePriority = resolveQueuePriority(input);
  const precreatedUrls: Array<string | undefined> = [];
  const receivedBlobs: Array<Blob | undefined> = [];
  let receivedCount = 0;
  let committed = false;

  const fillNearestUrls = (total: number): string[] => {
    const dense: string[] = [];
    for (let i = 0; i < total; i++) {
      let bestUrl = precreatedUrls[i];
      if (!bestUrl) {
        let bestDist = Infinity;
        for (let j = 0; j < precreatedUrls.length; j++) {
          const cand = precreatedUrls[j];
          if (!cand) continue;
          const dist = Math.abs(i - j);
          if (dist < bestDist) {
            bestDist = dist;
            bestUrl = cand;
          }
        }
      }
      if (bestUrl) dense.push(bestUrl);
    }
    return dense;
  };

  const onProgressiveFrame: ProgressiveFrameCallback = (index, total, blob, dims) => {
    if (signal.aborted) return;
    if (!receivedBlobs[index]) receivedCount += 1;
    receivedBlobs[index] = blob;
    const isFirst = receivedCount === 1;
    const isMidpoint = total >= 4 && receivedCount === Math.ceil(total / 2);
    if (!isFirst && !isMidpoint) return;

    if (isFirst) {
      putSharedCoverCache(baseCoverKey, {
        blob,
        aspect: dims.aspect,
        width: dims.width,
        height: dims.height,
        projectId: meta.projectId,
        compPath: meta.compPath,
        compRev: meta.compRev,
        contentRevision: meta.contentRevision,
      });
      const firstUrl = precreatedUrls[index] ?? URL.createObjectURL(blob);
      precreatedUrls[index] = firstUrl;
      setProgressiveEntry(
        idbKey,
        input.frameCount === 1
          ? { kind: "image", url: firstUrl, aspect: dims.aspect, representative: "render" }
          : { kind: "filmstrip", urls: [firstUrl], aspect: dims.aspect },
      );
      return;
    }

    for (let i = 0; i < receivedBlobs.length; i++) {
      if (receivedBlobs[i] && !precreatedUrls[i]) {
        precreatedUrls[i] = URL.createObjectURL(receivedBlobs[i]!);
      }
    }
    const denseUrls = fillNearestUrls(total);
    if (denseUrls.length > 0) {
      setProgressiveEntry(idbKey, { kind: "filmstrip", urls: denseUrls, aspect: dims.aspect });
    }
  };

  const previewOrigin = isolatedPreviewOrigin();
  const docKey = buildCaptureDocumentKey(input, previewOrigin);
  const isEditRefresh = input.contentRevision > 0;

  const gatePriority = Boolean(input.gatePriority);
  try {
    await waitUntilInteractiveIdle(signal, gatePriority);
    if (signal.aborted) throw abortError();
    const result = await enqueueSerializedCapture(queuePriority, docKey, isEditRefresh, signal, async () => {
      await waitUntilInteractiveIdle(signal, gatePriority);
      if (signal.aborted) throw abortError();
      return previewOrigin
        ? captureIsolatedOrigin(input, previewOrigin, docKey, signal, onProgressiveFrame, onCaptureStarted)
        : captureSameOrigin(input, docKey, signal, onProgressiveFrame, onCaptureStarted);
    });

    if (signal.aborted) throw abortError();
    if (result.blobs.length === 0) throw new Error("Client composition capture returned no frames");

    const coverBlob = result.blobs[Math.min(result.blobs.length - 1, Math.floor(result.blobs.length / 2))]!;
    putSharedCoverCache(baseCoverKey, {
      blob: coverBlob,
      aspect: result.aspect,
      width: result.width,
      height: result.height,
      projectId: meta.projectId,
      compPath: meta.compPath,
      compRev: meta.compRev,
      contentRevision: meta.contentRevision,
    });

    void writeCachedStrip({
      key: idbKey,
      aspect: result.aspect,
      width: result.width,
      height: result.height,
      blobs: result.blobs,
      updatedAt: Date.now(),
    });

    if (!input.selector) {
      const { rev: compRev, hasFileVersion } = resolveCompositionRevision(input.projectId, input.previewUrl);
      scheduleRemoteCompositionFilmstripUpload({
        projectId: input.projectId,
        previewUrl: input.previewUrl,
        compRev,
        contentRevision: hasFileVersion ? 0 : input.contentRevision,
        blobs: result.blobs,
        width: result.width,
        height: result.height,
        aspect: result.aspect,
        duration: input.duration,
      });
    }

    const entry = putMemoryStripCache(
      idbKey,
      baseCoverKey,
      compPathKey,
      meta,
      result.blobs,
      result.aspect,
      result.width,
      result.height,
      precreatedUrls,
    );
    committed = true;
    clearProgressiveEntry(idbKey);
    return memoryEntryToThumbnailResult(entry);
  } finally {
    clearProgressiveEntry(idbKey);
    if (!committed) {
      for (const url of precreatedUrls) {
        if (!url) continue;
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
  }
}

/** Keep ThumbnailScheduler's opening-gate hold synced with `editorInputLocked` so deferred captures never occupy slots. */
function syncOpeningGateHold(): void {
  thumbnailScheduler.setOpeningGateActive(usePlayerStore.getState().editorInputLocked);
}
syncOpeningGateHold();
const unbindOpeningGateHold = usePlayerStore.subscribe((state) => {
  thumbnailScheduler.setOpeningGateActive(state.editorInputLocked);
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unbindOpeningGateHold();
    thumbnailScheduler.setOpeningGateActive(false);
  });
}

/** Build a scheduler-managed request that captures real composition frames in the browser. */
export function createClientCompositionCaptureRequest(input: ClientCaptureInput): ThumbnailRequest {
  const { rev: compRev, hasFileVersion } = resolveCompositionRevision(input.projectId, input.previewUrl);
  return {
    key: createThumbnailKey({
      kind: "client-comp-capture",
      previewUrl: input.previewUrl,
      projectRev: compRev,
      revision: hasFileVersion ? undefined : input.contentRevision,
      frames: input.frameCount,
      selector: input.selector,
      selectorIndex: input.selectorIndex,
      samples: selectorCaptureWindowKey(input),
    }),
    projectId: input.projectId,
    sessionEpoch: input.sessionEpoch,
    kind: "composition",
    concurrencyBucket: "client-capture",
    priority: input.priority ?? "visible",
    rich: input.rich ?? true,
    gatePriority: Boolean(input.gatePriority),
    compositionPath: normalizeCompositionPathForGate(input.previewUrl),
    contentRevision: hasFileVersion ? 0 : input.contentRevision,
    compositionRevision: compRev,
    load: (signal, finishInBackground) =>
      runClientCompositionCapture(input, signal, compRev ? finishInBackground : undefined),
  };
}
