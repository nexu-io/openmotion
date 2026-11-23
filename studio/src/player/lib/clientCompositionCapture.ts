import { studioApiFetch } from "../../utils/studioApiFetch";
import { usePlayerStore } from "../store/playerStore";
import { isolatedPreviewOrigin } from "./previewLease";
import {
  createThumbnailKey,
  type ThumbnailLoadedResult,
  type ThumbnailPriority,
  type ThumbnailRequest,
  type ThumbnailValue,
} from "./thumbnailScheduler";

export const MAX_CLIENT_COMPOSITION_FRAMES = 8;
/** Cap how many uncached composition clips can block initial editor unlock. */
export const MAX_INITIAL_TIMELINE_PREVIEW_GATE = 4;
/** Maximum extra wait after primary assets settle before releasing to background capture. */
export const TIMELINE_PREVIEW_GATE_TIMEOUT_MS = 4_500;

const CAPTURE_TARGET_WIDTH = 240;
const CAPTURE_JPEG_QUALITY = 0.78;
const CAPTURE_BOOT_TIMEOUT_MS = 12_000;
const CAPTURE_MEDIA_TIMEOUT_MS = 4_000;
const CAPTURE_FRAME_YIELD_MS = 24;
const CAPTURE_IDLE_TEARDOWN_MS = 1_500;
const IDB_NAME = "openmotion-client-comp-thumbs-v1";
const IDB_STORE = "strips";
const IDB_MAX_ENTRIES = 120;
const MEMORY_STRIP_CACHE_MAX = 64;
const SHARED_COVER_CACHE_MAX = 128;

interface CachedStripRecord {
  key: string;
  aspect: number;
  width: number;
  height: number;
  blobs: Blob[];
  updatedAt: number;
}

interface MemoryStripEntry {
  blobs: readonly Blob[];
  value: ThumbnailValue;
  coverValue: ThumbnailValue;
  urls: string[];
  aspect: number;
  width: number;
  height: number;
  weight: number;
  baseCoverKey: string;
  compPathKey: string;
  inCache: boolean;
  refCount: number;
  revoked: boolean;
}

interface CapturePreviewWindow extends Window {
  __player?: {
    seek?: (time: number) => void;
    pause?: () => void;
    getDuration?: () => number;
  };
}

export interface ClientCaptureInput {
  previewUrl: string;
  projectId: string;
  sessionEpoch: number;
  contentRevision: number;
  frameCount: number;
  duration?: number;
  seekTime?: number;
  selector?: string;
  selectorIndex?: number;
  priority?: ThumbnailPriority;
  /** Boosts capture priority above background clips when participating in initial editor unlock. */
  gatePriority?: boolean;
  rich?: boolean;
}

type SnapdomModuleFn = typeof import("@zumer/snapdom").snapdom;

let testCapabilityOverride: boolean | null = null;
let snapdomLoader: Promise<SnapdomModuleFn | null> | null = null;
const projectRevisionByProjectId = new Map<string, string>();
// In-memory cover cache keyed by composition identity (ignoring frameCount) so sidebar 1-frame
// cards immediately reuse frames already captured for a timeline strip without booting a 2nd run.
const sharedCoverCache = new Map<string, { blob: Blob; aspect: number; width: number; height: number }>();
// In-memory LRU strip cache keyed independent of sessionEpoch so switching projects/compositions
// renders captured filmstrips synchronously in 0ms without re-queuing or re-fetching posters.
const memoryStripCache = new Map<string, MemoryStripEntry>();
// Maps any ThumbnailValue handed out from memoryStripCache back to its entry for owner ref-counting.
const entryByValue = new WeakMap<ThumbnailValue, MemoryStripEntry>();
const inFlightIdbReads = new Map<string, Promise<MemoryStripEntry | null>>();

function putSharedCoverCache(
  baseCoverKey: string,
  entry: { blob: Blob; aspect: number; width: number; height: number },
): void {
  if (sharedCoverCache.has(baseCoverKey)) sharedCoverCache.delete(baseCoverKey);
  sharedCoverCache.set(baseCoverKey, entry);
  while (sharedCoverCache.size > SHARED_COVER_CACHE_MAX) {
    const oldestKey = sharedCoverCache.keys().next().value;
    if (!oldestKey) break;
    sharedCoverCache.delete(oldestKey);
  }
}

function maybeRevokeEntry(entry: MemoryStripEntry): void {
  if (entry.revoked || entry.inCache || entry.refCount > 0) return;
  entry.revoked = true;
  for (const url of entry.urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}

function retainMemoryEntry(entry: MemoryStripEntry): () => void {
  entry.refCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    maybeRevokeEntry(entry);
  };
}

/**
 * Retain ownership of a ThumbnailValue returned by `peekCachedCompositionCapture`
 * so LRU cache eviction does not revoke its object URLs while mounted.
 */
export function retainCachedCompositionCapture(
  value: ThumbnailValue | null | undefined,
): () => void {
  if (!value) return () => {};
  const entry = entryByValue.get(value);
  if (!entry) return () => {};
  return retainMemoryEntry(entry);
}

/** Reset in-memory capture caches between unit tests. */
export function clearClientCompositionCaptureCacheForTest(): void {
  for (const entry of memoryStripCache.values()) {
    entry.inCache = false;
    if (!entry.revoked) {
      entry.revoked = true;
      for (const url of entry.urls) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
  }
  memoryStripCache.clear();
  sharedCoverCache.clear();
  projectRevisionByProjectId.clear();
  inFlightIdbReads.clear();
}

function normalizeCompositionPathForGate(raw: string): string {
  const withoutOrigin = raw.replace(/^https?:\/\/[^/]+/i, "");
  const previewComp = /\/preview\/comp\/([^?#]+)/.exec(withoutOrigin);
  if (previewComp?.[1]) {
    try {
      return decodeURIComponent(previewComp[1]).replace(/^(\.\/|\/)+/, "");
    } catch {
      return previewComp[1].replace(/^(\.\/|\/)+/, "");
    }
  }
  const previewRoot = /\/preview\/([^?#]+)/.exec(withoutOrigin);
  if (previewRoot?.[1]) {
    try {
      return decodeURIComponent(previewRoot[1]).replace(/^(\.\/|\/)+/, "");
    } catch {
      return previewRoot[1].replace(/^(\.\/|\/)+/, "");
    }
  }
  return withoutOrigin.split(/[?#]/)[0]!.replace(/^(\.\/|\/)+/, "");
}

/**
 * Pick at most `maxCount` unique visible composition paths closest to `currentTime`
 * to participate in the initial unified loading gate. Remaining clips capture
 * progressively in the background so long projects (20–30+ scenes) never stall.
 */
export function selectInitialGateCompositionPaths(
  elements: ReadonlyArray<{
    compositionSrc?: string;
    hidden?: boolean;
    start: number;
    duration: number;
  }>,
  currentTime: number,
  maxCount: number = MAX_INITIAL_TIMELINE_PREVIEW_GATE,
): string[] {
  if (maxCount <= 0) return [];
  const safeTime = Number.isFinite(currentTime) ? currentTime : 0;
  const bestDistance = new Map<string, { dist: number; start: number }>();
  for (const el of elements) {
    if (!el.compositionSrc || el.hidden) continue;
    const normalized = normalizeCompositionPathForGate(el.compositionSrc);
    if (!normalized) continue;
    const end = el.start + Math.max(0, el.duration);
    const dist =
      safeTime >= el.start && safeTime <= end
        ? 0
        : Math.min(Math.abs(safeTime - el.start), Math.abs(safeTime - end));
    const prev = bestDistance.get(normalized);
    if (!prev || dist < prev.dist || (dist === prev.dist && el.start < prev.start)) {
      bestDistance.set(normalized, { dist, start: el.start });
    }
  }
  return Array.from(bestDistance.entries())
    .sort((a, b) => a[1].dist - b[1].dist || a[1].start - b[1].start)
    .slice(0, maxCount)
    .map(([src]) => src);
}

/** Override browser capture eligibility in unit tests. */
export function setClientCompositionCaptureCapabilityForTest(enabled: boolean | null): void {
  testCapabilityOverride = enabled;
}

export function setCachedProjectRevision(projectId: string, revision: string | null | undefined): void {
  if (!projectId) return;
  if (typeof revision === "string" && revision.trim()) {
    projectRevisionByProjectId.set(projectId, revision.trim());
  }
}

export function canCaptureCompositionInBrowser(): boolean {
  if (testCapabilityOverride !== null) return testCapabilityOverride;
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (typeof HTMLCanvasElement === "undefined" || typeof requestAnimationFrame !== "function") return false;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/HappyDOM|jsdom/i.test(ua)) return false;
  return true;
}

/** Quantize requested timeline tiles into 1 / 2 / 4 / 8 captured frames so zooming reuses caches. */
export function quantizeCompositionFrameCount(
  tileCount: number,
  durationSeconds?: number,
): number {
  if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds <= 0.5) {
    return 1;
  }
  const safe = Math.max(1, Number.isFinite(tileCount) ? Math.ceil(tileCount) : 1);
  if (safe <= 1) return 1;
  if (safe <= 2) return 2;
  if (safe <= 4) return 4;
  return MAX_CLIENT_COMPOSITION_FRAMES;
}

/** Pick evenly distributed timestamps that avoid blank t=0 fade-ins and tail fade-outs. */
export function computeCompositionSampleTimes(
  durationSeconds: number,
  frameCount: number,
  seekTime?: number,
): number[] {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const count = Math.max(1, Math.min(MAX_CLIENT_COMPOSITION_FRAMES, Math.floor(frameCount || 1)));
  if (safeDuration <= 0) {
    return [Math.max(0, Number.isFinite(seekTime) ? seekTime! : 0)];
  }
  if (count === 1) {
    const preferred =
      typeof seekTime === "number" && Number.isFinite(seekTime) && seekTime > 0 && seekTime < safeDuration
        ? seekTime
        : safeDuration <= 3
          ? safeDuration * 0.5
          : Math.min(3, safeDuration * 0.35);
    return [Number(preferred.toFixed(3))];
  }
  if (count === 2) {
    return [
      Number((safeDuration * 0.25).toFixed(3)),
      Number((safeDuration * 0.75).toFixed(3)),
    ];
  }
  const start = safeDuration * 0.04;
  const end = safeDuration * 0.94;
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => Number((start + i * step).toFixed(3)));
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

function nextTwoAnimationFrames(win: Window, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let raf1 = 0;
    let raf2 = 0;
    const onAbort = () => {
      win.cancelAnimationFrame?.(raf1);
      win.cancelAnimationFrame?.(raf2);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    raf1 = win.requestAnimationFrame(() => {
      raf2 = win.requestAnimationFrame(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  });
}

async function waitUntilInteractiveIdle(signal: AbortSignal): Promise<void> {
  // Wait for primary composition assets to finish so capture hits the warm HTTP cache
  // without competing with initial preview loads, and yield while playing or hidden.
  // Do NOT block on editorInputLocked: initial timeline captures complete inside the unified loader.
  while (!signal.aborted) {
    const state = usePlayerStore.getState();
    const assetsSettled =
      state.assetReadinessPhase === "ready" || state.assetReadinessSkipped || !state.editorInputLocked;
    if (assetsSettled && !state.isPlaying && (typeof document === "undefined" || !document.hidden)) {
      return;
    }
    await sleepAbortable(60, signal);
  }
  throw abortError();
}

// ---------------------------------------------------------------------------
// IndexedDB Persistent Cache (best-effort; degrades cleanly in private mode)
// ---------------------------------------------------------------------------

let idbOpenPromise: Promise<IDBDatabase | null> | null = null;

function openThumbDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!idbOpenPromise) {
    idbOpenPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            const store = db.createObjectStore(IDB_STORE, { keyPath: "key" });
            store.createIndex("updatedAt", "updatedAt");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return idbOpenPromise;
}

async function readCachedStrip(key: string): Promise<CachedStripRecord | null> {
  const db = await openThumbDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const rec = req.result as CachedStripRecord | undefined;
        if (rec && Array.isArray(rec.blobs) && rec.blobs.length > 0) resolve(rec);
        else resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeCachedStrip(record: CachedStripRecord): Promise<void> {
  const db = await openThumbDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      store.put(record);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const overflow = (countReq.result || 0) - IDB_MAX_ENTRIES;
        if (overflow <= 0) return;
        let removed = 0;
        const cursorReq = store.index("updatedAt").openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || removed >= overflow) return;
          cursor.delete();
          removed += 1;
          cursor.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Serialized Single Offscreen Capture Iframe Host (steady-state 0 RAM)
// ---------------------------------------------------------------------------

type CaptureQueuePriority = "overscan" | "visible" | "gate" | "interaction";

const CAPTURE_PRIORITY_RANK: Readonly<Record<CaptureQueuePriority, number>> = {
  overscan: 0,
  visible: 1,
  gate: 2,
  interaction: 3,
};

interface QueuedCaptureJob {
  priority: CaptureQueuePriority;
  seq: number;
  signal: AbortSignal;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

let hostIframe: HTMLIFrameElement | null = null;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let activeCaptureRunning = false;
let captureJobSeq = 0;
const pendingCaptureJobs: QueuedCaptureJob[] = [];

function cancelIdleTeardown(): void {
  if (teardownTimer !== null) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
}

function scheduleIdleTeardown(): void {
  cancelIdleTeardown();
  if (activeCaptureRunning || pendingCaptureJobs.length > 0) return;
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    if (activeCaptureRunning || pendingCaptureJobs.length > 0 || !hostIframe) return;
    try {
      hostIframe.src = "about:blank";
      hostIframe.remove();
    } catch {
      // ignore teardown errors
    }
    hostIframe = null;
  }, CAPTURE_IDLE_TEARDOWN_MS);
}

function acquireOffscreenIframe(width = 1280, height = 720): HTMLIFrameElement {
  cancelIdleTeardown();
  if (!hostIframe || !hostIframe.isConnected) {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("data-openmotion-thumb-capture", "true");
    iframe.tabIndex = -1;
    iframe.sandbox.add("allow-scripts", "allow-same-origin");
    Object.assign(iframe.style, {
      position: "fixed",
      left: "-10000px",
      top: "-10000px",
      width: `${width}px`,
      height: `${height}px`,
      border: "0",
      pointerEvents: "none",
      zIndex: "-1",
    });
    document.body.appendChild(iframe);
    hostIframe = iframe;
  } else {
    hostIframe.style.width = `${width}px`;
    hostIframe.style.height = `${height}px`;
  }
  return hostIframe;
}

function pumpCaptureQueue(): void {
  if (activeCaptureRunning) return;
  while (pendingCaptureJobs.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < pendingCaptureJobs.length; i++) {
      const cand = pendingCaptureJobs[i]!;
      const best = pendingCaptureJobs[bestIdx]!;
      const delta = CAPTURE_PRIORITY_RANK[cand.priority] - CAPTURE_PRIORITY_RANK[best.priority];
      if (delta > 0 || (delta === 0 && cand.seq < best.seq)) {
        bestIdx = i;
      }
    }
    const [job] = pendingCaptureJobs.splice(bestIdx, 1);
    if (!job) break;
    job.signal.removeEventListener("abort", job.onAbort);
    if (job.signal.aborted) {
      job.reject(abortError());
      continue;
    }
    activeCaptureRunning = true;
    cancelIdleTeardown();
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeCaptureRunning = false;
        if (pendingCaptureJobs.length > 0) {
          pumpCaptureQueue();
        } else {
          scheduleIdleTeardown();
        }
      });
    return;
  }
  scheduleIdleTeardown();
}

function resolveQueuePriority(input: Pick<ClientCaptureInput, "priority" | "gatePriority">): CaptureQueuePriority {
  if (input.priority === "interaction") return "interaction";
  if (input.gatePriority) return "gate";
  if (input.priority === "overscan") return "overscan";
  return "visible";
}

function enqueueSerializedCapture<T>(
  priority: CaptureQueuePriority,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const job: QueuedCaptureJob = {
      priority,
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

async function loadLocalSnapdom(): Promise<SnapdomModuleFn | null> {
  if (!snapdomLoader) {
    snapdomLoader = import("@zumer/snapdom")
      .then((mod) => (typeof mod.snapdom === "function" ? mod.snapdom : null))
      .catch(() => null);
  }
  return snapdomLoader;
}

function findPureCanvasTarget(root: Element, stageW: number, stageH: number): HTMLCanvasElement | null {
  if (root instanceof HTMLCanvasElement) return root;
  const canvases = root.querySelectorAll("canvas");
  if (canvases.length !== 1) return null;
  if ((root.textContent ?? "").replace(/\s+/g, "").trim().length > 0) return null;
  if (root.querySelector("img,svg,video")) return null;
  const canvas = canvases[0]!;
  const rect = canvas.getBoundingClientRect();
  return rect.width >= stageW * 0.9 && rect.height >= stageH * 0.9 ? canvas : null;
}

function drawToJpegBlob(source: CanvasImageSource, outW: number, outH: number): Promise<Blob> {
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");
  if (!ctx) return Promise.reject(new Error("2D context unavailable"));
  ctx.drawImage(source, 0, 0, outW, outH);
  return new Promise((resolve, reject) => {
    out.toBlob(
      (blob) => {
        if (blob && blob.size > 0) resolve(blob);
        else reject(new Error("Failed to encode composition thumbnail frame"));
      },
      "image/jpeg",
      CAPTURE_JPEG_QUALITY,
    );
  });
}

async function waitForDocumentMedia(doc: Document, signal: AbortSignal): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (doc.fonts?.ready) tasks.push(doc.fonts.ready.catch(() => undefined));
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    if (img.complete) continue;
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

function buildCaptureUrl(previewUrl: string, contentRevision: number): URL {
  const url = new URL(previewUrl, window.location.origin);
  url.searchParams.set("capture", "1");
  if (contentRevision > 0) url.searchParams.set("revision", String(contentRevision));
  return url;
}

async function captureSameOrigin(
  input: ClientCaptureInput,
  signal: AbortSignal,
): Promise<{ blobs: Blob[]; aspect: number; width: number; height: number }> {
  const snapdom = await loadLocalSnapdom();
  if (!snapdom) throw new Error("SnapDOM unavailable");
  if (signal.aborted) throw abortError();

  const iframe = acquireOffscreenIframe(1280, 720);
  const captureUrl = buildCaptureUrl(input.previewUrl, input.contentRevision);

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

  const win = iframe.contentWindow as CapturePreviewWindow | null;
  const doc = iframe.contentDocument;
  if (!win || !doc) throw new Error("Offscreen capture frame is inaccessible");

  // Wait for HyperFrames player bootstrap inside the offscreen document.
  const deadline = Date.now() + CAPTURE_BOOT_TIMEOUT_MS;
  while (!signal.aborted) {
    const dur = win.__player?.getDuration?.() ?? 0;
    if (win.__player?.seek && Number.isFinite(dur) && dur > 0) break;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for composition player");
    await sleepAbortable(40, signal);
  }
  if (signal.aborted) throw abortError();

  win.__player?.pause?.();
  const root = (doc.querySelector("[data-composition-id]") ?? doc.body) as Element;
  const stageW = Number(root.getAttribute("data-width")) || root.clientWidth || 1280;
  const stageH = Number(root.getAttribute("data-height")) || root.clientHeight || 720;
  iframe.style.width = `${stageW}px`;
  iframe.style.height = `${stageH}px`;

  await waitForDocumentMedia(doc, signal);
  if (signal.aborted) throw abortError();

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

  const outW = CAPTURE_TARGET_WIDTH;
  const outH = Math.max(27, Math.round((outW * targetH) / Math.max(1, targetW)));
  const scale = outW / Math.max(1, targetW);
  const actualDuration = win.__player?.getDuration?.() || input.duration || 0;
  const times = computeCompositionSampleTimes(actualDuration, input.frameCount, input.seekTime);

  const blobs: Blob[] = [];
  for (const t of times) {
    await waitUntilInteractiveIdle(signal);
    win.__player!.seek!(t);
    await nextTwoAnimationFrames(win, signal);

    const pureCanvas = findPureCanvasTarget(target, targetW, targetH);
    let blob: Blob;
    if (pureCanvas) {
      blob = await drawToJpegBlob(pureCanvas, outW, outH);
    } else {
      const snap = await snapdom(target, {
        scale,
        fast: true,
        embedFonts: false,
        exclude: "video",
      });
      const rendered = await snap.toCanvas();
      blob = await drawToJpegBlob(rendered, outW, outH);
    }
    blobs.push(blob);
    if (times.length > 1) await sleepAbortable(CAPTURE_FRAME_YIELD_MS, signal);
  }

  return { blobs, aspect: targetW / Math.max(1, targetH), width: outW, height: outH };
}

async function captureIsolatedOrigin(
  input: ClientCaptureInput,
  previewOrigin: string,
  signal: AbortSignal,
): Promise<{ blobs: Blob[]; aspect: number; width: number; height: number }> {
  const grantResponse = await studioApiFetch(
    `/api/projects/${encodeURIComponent(input.projectId)}/preview-token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetLease: true }),
      cache: "no-store",
      signal,
    },
  );
  if (!grantResponse.ok) throw new Error(`Preview token failed (${grantResponse.status})`);
  const grant = (await grantResponse.json()) as { token?: string; previewOrigin?: string };
  if (!grant.token) throw new Error("Missing preview capture token");
  const token = grant.token;

  const source = new URL(input.previewUrl, window.location.origin);
  const isolatedUrl = new URL(source.pathname, previewOrigin);
  isolatedUrl.search = source.search;
  isolatedUrl.searchParams.set("capture", "1");
  if (input.contentRevision > 0) isolatedUrl.searchParams.set("revision", String(input.contentRevision));
  isolatedUrl.searchParams.set("pt", token);

  const iframe = acquireOffscreenIframe(1920, 1080);

  const duration = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for isolated capture bridge"));
    }, CAPTURE_BOOT_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== previewOrigin || event.source !== iframe.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== "openmotion-preview-bridge" || data.token !== token) return;
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

  const times = computeCompositionSampleTimes(duration || input.duration || 0, input.frameCount, input.seekTime);
  const requestId = `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const payload = await new Promise<{
    frames: ArrayBuffer[];
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
      if (event.origin !== previewOrigin || event.source !== iframe.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== "openmotion-preview-bridge" || data.token !== token) return;
      if (data.type === "response" && data.requestId === requestId) {
        cleanup();
        if (data.ok && data.result && Array.isArray(data.result.frames)) {
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
      },
      previewOrigin,
    );
  });

  const mimeType = payload.mimeType || "image/jpeg";
  const blobs = payload.frames.map((buf) => new Blob([buf], { type: mimeType }));
  return {
    blobs,
    aspect: payload.aspect && payload.aspect > 0 ? payload.aspect : 16 / 9,
    width: payload.width || CAPTURE_TARGET_WIDTH,
    height: payload.height || 135,
  };
}

function coverCacheKey(
  input: Pick<ClientCaptureInput, "projectId" | "previewUrl" | "contentRevision" | "selector" | "selectorIndex">,
  projectRev: string,
): string {
  return createThumbnailKey({
    project: input.projectId,
    url: input.previewUrl,
    projectRev,
    rev: input.contentRevision,
    sel: input.selector,
    idx: input.selectorIndex,
  });
}

function compPathCacheTag(projectId: string, compPath: string, projectRev: string, contentRevision: number): string {
  return `${projectId}|${normalizeCompositionPathForGate(compPath)}|${projectRev}|${contentRevision}`;
}

function stripMemoryCacheKey(
  input: Pick<
    ClientCaptureInput,
    "projectId" | "previewUrl" | "contentRevision" | "frameCount" | "selector" | "selectorIndex"
  >,
): { idbKey: string; baseCoverKey: string; compPathKey: string } {
  const projectRev = projectRevisionByProjectId.get(input.projectId) ?? "";
  const baseCoverKey = coverCacheKey(input, projectRev);
  return {
    idbKey: `${baseCoverKey}&frames=${input.frameCount}`,
    baseCoverKey,
    compPathKey: compPathCacheTag(input.projectId, input.previewUrl, projectRev, input.contentRevision),
  };
}

function putMemoryStripCache(
  idbKey: string,
  baseCoverKey: string,
  compPathKey: string,
  blobs: readonly Blob[],
  aspect: number,
  width: number,
  height: number,
): MemoryStripEntry {
  const existing = memoryStripCache.get(idbKey);
  if (existing) {
    memoryStripCache.delete(idbKey);
    memoryStripCache.set(idbKey, existing);
    return existing;
  }
  const urls = blobs.map((blob) => URL.createObjectURL(blob));
  const weight = Math.max(1, urls.length) * width * height * 4;
  const value: ThumbnailValue =
    urls.length === 1
      ? { kind: "image", url: urls[0]!, aspect, representative: "render" }
      : { kind: "filmstrip", urls, aspect };
  const coverUrl = urls[Math.min(urls.length - 1, Math.floor(urls.length / 2))]!;
  const coverValue: ThumbnailValue =
    value.kind === "image"
      ? value
      : { kind: "image", url: coverUrl, aspect, representative: "render" };
  const entry: MemoryStripEntry = {
    blobs,
    value,
    coverValue,
    urls,
    aspect,
    width,
    height,
    weight,
    baseCoverKey,
    compPathKey,
    inCache: true,
    refCount: 0,
    revoked: false,
  };
  entryByValue.set(value, entry);
  if (coverValue !== value) entryByValue.set(coverValue, entry);
  memoryStripCache.set(idbKey, entry);
  while (memoryStripCache.size > MEMORY_STRIP_CACHE_MAX) {
    const oldestKey = memoryStripCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = memoryStripCache.get(oldestKey);
    memoryStripCache.delete(oldestKey);
    if (evicted) {
      evicted.inCache = false;
      maybeRevokeEntry(evicted);
    }
  }
  return entry;
}

function retainOrRematerialize(idbKey: string, entry: MemoryStripEntry): MemoryStripEntry {
  if (!entry.revoked) return entry;
  return putMemoryStripCache(
    idbKey,
    entry.baseCoverKey,
    entry.compPathKey,
    entry.blobs,
    entry.aspect,
    entry.width,
    entry.height,
  );
}

function memoryEntryToThumbnailResult(entry: MemoryStripEntry): ThumbnailLoadedResult {
  // Retain the entry on behalf of ThumbnailScheduler so LRU eviction in memoryStripCache
  // only drops cache ownership; object URLs stay valid until ThumbnailScheduler disposes
  // its result and all direct consumers release their leases.
  const release = retainMemoryEntry(entry);
  return {
    value: entry.value,
    weight: entry.weight,
    dispose: release,
  };
}

function peekMemoryEntry(
  input: Pick<
    ClientCaptureInput,
    "projectId" | "previewUrl" | "contentRevision" | "frameCount" | "selector" | "selectorIndex"
  >,
): { entry: MemoryStripEntry; value: ThumbnailValue } | null {
  const { idbKey, baseCoverKey, compPathKey } = stripMemoryCacheKey(input);
  const exact = memoryStripCache.get(idbKey);
  if (exact) {
    memoryStripCache.delete(idbKey);
    memoryStripCache.set(idbKey, exact);
    return { entry: exact, value: exact.value };
  }
  if (input.frameCount === 1) {
    // Reuse an already-resident multi-frame strip's middle frame without creating duplicate
    // object URLs or triggering LRU eviction during React render.
    for (const [key, entry] of memoryStripCache) {
      if (entry.baseCoverKey === baseCoverKey) {
        memoryStripCache.delete(key);
        memoryStripCache.set(key, entry);
        return { entry, value: entry.coverValue };
      }
    }
    const shared = sharedCoverCache.get(baseCoverKey);
    if (shared) {
      const entry = putMemoryStripCache(
        idbKey,
        baseCoverKey,
        compPathKey,
        [shared.blob],
        shared.aspect,
        shared.width,
        shared.height,
      );
      return { entry, value: entry.value };
    }
  }
  return null;
}

/**
 * Synchronously return a warm in-memory captured strip/cover when available.
 * Independent of `sessionEpoch` so switching projects or sub-compositions renders in 0ms.
 * Callers holding the returned value across renders should retain it via
 * `retainCachedCompositionCapture(value)` so LRU eviction never revokes active URLs.
 */
export function peekCachedCompositionCapture(
  input: Pick<
    ClientCaptureInput,
    "projectId" | "previewUrl" | "contentRevision" | "frameCount" | "selector" | "selectorIndex"
  >,
): ThumbnailValue | null {
  return peekMemoryEntry(input)?.value ?? null;
}

/** Seed an in-memory cached capture strip in unit tests to exercise LRU/ownership semantics. */
export function seedClientCompositionCaptureForTest(
  input: Pick<
    ClientCaptureInput,
    "projectId" | "previewUrl" | "contentRevision" | "frameCount" | "selector" | "selectorIndex"
  >,
  blobs: readonly Blob[],
  dims: { aspect?: number; width?: number; height?: number } = {},
): ThumbnailValue {
  const { idbKey, baseCoverKey, compPathKey } = stripMemoryCacheKey(input);
  const aspect = dims.aspect ?? 16 / 9;
  const width = dims.width ?? CAPTURE_TARGET_WIDTH;
  const height = dims.height ?? 135;
  const coverBlob = blobs[Math.min(blobs.length - 1, Math.floor(blobs.length / 2))]!;
  putSharedCoverCache(baseCoverKey, { blob: coverBlob, aspect, width, height });
  return putMemoryStripCache(idbKey, baseCoverKey, compPathKey, blobs, aspect, width, height).value;
}

/** True when any frame count for this composition is already cached in RAM (no blocking gate needed). */
export function hasAnyCachedCompositionCapture(
  projectId: string,
  compPath: string,
  contentRevision = 0,
): boolean {
  const projectRev = projectRevisionByProjectId.get(projectId) ?? "";
  const target = compPathCacheTag(projectId, compPath, projectRev, contentRevision);
  for (const entry of memoryStripCache.values()) {
    if (entry.compPathKey === target) return true;
  }
  return false;
}

/**
 * Fast-path IndexedDB lookup that bypasses `thumbnailScheduler`'s 2-slot composition bucket
 * so warm page reloads recover all cached strips in parallel (~5–15ms).
 * Returns a retained lease that the caller must release when unmounting or changing keys.
 */
export function acquireCachedCompositionCaptureFromIdb(
  input: Pick<
    ClientCaptureInput,
    "projectId" | "previewUrl" | "contentRevision" | "frameCount" | "selector" | "selectorIndex"
  >,
): Promise<{ value: ThumbnailValue; release: () => void } | null> {
  const syncHit = peekMemoryEntry(input);
  if (syncHit) {
    return Promise.resolve({
      value: syncHit.value,
      release: retainMemoryEntry(syncHit.entry),
    });
  }
  const { idbKey, baseCoverKey, compPathKey } = stripMemoryCacheKey(input);
  let entryPromise = inFlightIdbReads.get(idbKey);
  if (!entryPromise) {
    entryPromise = readCachedStrip(idbKey)
      .then((cached) => {
        if (!cached) return null;
        const coverBlob =
          cached.blobs[Math.min(cached.blobs.length - 1, Math.floor(cached.blobs.length / 2))]!;
        putSharedCoverCache(baseCoverKey, {
          blob: coverBlob,
          aspect: cached.aspect,
          width: cached.width,
          height: cached.height,
        });
        return putMemoryStripCache(
          idbKey,
          baseCoverKey,
          compPathKey,
          cached.blobs,
          cached.aspect,
          cached.width,
          cached.height,
        );
      })
      .finally(() => {
        inFlightIdbReads.delete(idbKey);
      });
    inFlightIdbReads.set(idbKey, entryPromise);
  }
  return entryPromise.then((entry) => {
    if (!entry) return null;
    const live = retainOrRematerialize(idbKey, entry);
    return { value: live.value, release: retainMemoryEntry(live) };
  });
}

async function runClientCompositionCapture(
  input: ClientCaptureInput,
  signal: AbortSignal,
): Promise<ThumbnailLoadedResult> {
  const { idbKey, baseCoverKey, compPathKey } = stripMemoryCacheKey(input);

  // 0. Fast path: synchronous in-memory strip/cover cache hit (0ms across switches).
  const memHit = memoryStripCache.get(idbKey);
  if (memHit) {
    memoryStripCache.delete(idbKey);
    memoryStripCache.set(idbKey, memHit);
    return memoryEntryToThumbnailResult(memHit);
  }

  // 1. Fast path: 1-frame sidebar covers reuse any already-captured strip frame immediately.
  if (input.frameCount === 1) {
    for (const [key, entry] of memoryStripCache) {
      if (entry.baseCoverKey === baseCoverKey) {
        memoryStripCache.delete(key);
        memoryStripCache.set(key, entry);
        const release = retainMemoryEntry(entry);
        return {
          value: entry.coverValue,
          weight: entry.width * entry.height * 4,
          dispose: release,
        };
      }
    }
    const shared = sharedCoverCache.get(baseCoverKey);
    if (shared) {
      const entry = putMemoryStripCache(
        idbKey,
        baseCoverKey,
        compPathKey,
        [shared.blob],
        shared.aspect,
        shared.width,
        shared.height,
      );
      return memoryEntryToThumbnailResult(entry);
    }
  }

  // 2. Fast path: persistent IndexedDB hit across page refreshes.
  const cached = await readCachedStrip(idbKey);
  if (signal.aborted) throw abortError();
  if (cached) {
    const coverBlob = cached.blobs[Math.min(cached.blobs.length - 1, Math.floor(cached.blobs.length / 2))]!;
    putSharedCoverCache(baseCoverKey, {
      blob: coverBlob,
      aspect: cached.aspect,
      width: cached.width,
      height: cached.height,
    });
    const entry = putMemoryStripCache(
      idbKey,
      baseCoverKey,
      compPathKey,
      cached.blobs,
      cached.aspect,
      cached.width,
      cached.height,
    );
    return memoryEntryToThumbnailResult(entry);
  }

  // 3. Priority-queued serialized offscreen browser capture (max 1 hidden iframe, paused during playback).
  const queuePriority = resolveQueuePriority(input);
  const result = await enqueueSerializedCapture(queuePriority, signal, async () => {
    await waitUntilInteractiveIdle(signal);
    if (signal.aborted) throw abortError();
    const previewOrigin = isolatedPreviewOrigin();
    return previewOrigin
      ? captureIsolatedOrigin(input, previewOrigin, signal)
      : captureSameOrigin(input, signal);
  });

  if (signal.aborted) throw abortError();
  if (result.blobs.length === 0) throw new Error("Client composition capture returned no frames");

  const coverBlob = result.blobs[Math.min(result.blobs.length - 1, Math.floor(result.blobs.length / 2))]!;
  putSharedCoverCache(baseCoverKey, {
    blob: coverBlob,
    aspect: result.aspect,
    width: result.width,
    height: result.height,
  });

  void writeCachedStrip({
    key: idbKey,
    aspect: result.aspect,
    width: result.width,
    height: result.height,
    blobs: result.blobs,
    updatedAt: Date.now(),
  });

  const entry = putMemoryStripCache(
    idbKey,
    baseCoverKey,
    compPathKey,
    result.blobs,
    result.aspect,
    result.width,
    result.height,
  );
  return memoryEntryToThumbnailResult(entry);
}

/** Build a scheduler-managed request that captures real composition frames in the browser. */
export function createClientCompositionCaptureRequest(input: ClientCaptureInput): ThumbnailRequest {
  const projectRev = projectRevisionByProjectId.get(input.projectId) ?? "";
  return {
    key: createThumbnailKey({
      kind: "client-comp-capture",
      previewUrl: input.previewUrl,
      projectRev,
      revision: input.contentRevision,
      frames: input.frameCount,
      selector: input.selector,
      selectorIndex: input.selectorIndex,
    }),
    projectId: input.projectId,
    sessionEpoch: input.sessionEpoch,
    kind: "composition",
    priority: input.priority ?? "visible",
    rich: input.rich ?? true,
    load: (signal) => runClientCompositionCapture(input, signal),
  };
}
