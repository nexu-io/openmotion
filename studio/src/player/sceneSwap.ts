import { needsPreparedSceneSwap } from "../../../shared/preview-scene-swap";
import { studioApiFetch } from "../utils/studioApiFetch";
import { studioFileRevision } from "../utils/studioFileVersion";
import { logReload } from "../utils/reloadDebug";
import { whileScriptWrites } from "./previewReloading";

type SwapWindow = Window & {
  __hfSwapScenes?: (html: string, signal?: AbortSignal) => Promise<void>;
};

const SCENES_SWAPPED = "hf-scenes-swapped";
export const SCENE_SWAP_MS = 5000;
// A gesture released during a scene swap can reply after that swap finishes.
export const SCENE_GESTURE_REPLY_MS = SCENE_SWAP_MS + 1500;

const PREVIEW_DOCUMENT_LOADED = "hf-preview-document-loaded";

// A preview fetch races both local writes and remote edits. Each advances this
// monotonic clock; the local writer's own clock remains independent.
let externalPreviewRevision = 0;
export function notePeerPreviewChange(): void { externalPreviewRevision++; }
export function previewSourceRevision(): number { return externalPreviewRevision + studioFileRevision(); }

const contentGeneration = new WeakMap<HTMLIFrameElement, number>();
export function previewContentGeneration(iframe: HTMLIFrameElement): number {
  return contentGeneration.get(iframe) ?? 0;
}
function announceContentReplaced(iframe: HTMLIFrameElement, event: string): void {
  contentGeneration.set(iframe, previewContentGeneration(iframe) + 1);
  iframe.dispatchEvent(new Event(event));
}

export function announcePreviewDocumentLoaded(iframe: HTMLIFrameElement): void {
  announceContentReplaced(iframe, PREVIEW_DOCUMENT_LOADED);
}

/** The existing document now represents the confirmed source after a swap or rebind. */
export function announcePreviewScenesSwapped(iframe: HTMLIFrameElement): void {
  announceContentReplaced(iframe, SCENES_SWAPPED);
}

export function onPreviewDocumentLoaded(
  iframe: HTMLIFrameElement,
  onLoaded: () => void,
): () => void {
  iframe.addEventListener(PREVIEW_DOCUMENT_LOADED, onLoaded);
  return () => iframe.removeEventListener(PREVIEW_DOCUMENT_LOADED, onLoaded);
}

export function onPreviewContentReplaced(
  iframe: HTMLIFrameElement,
  onReplaced: () => void,
): () => void {
  const stopLoaded = onPreviewDocumentLoaded(iframe, onReplaced);
  iframe.addEventListener(SCENES_SWAPPED, onReplaced);
  return () => {
    stopLoaded();
    iframe.removeEventListener(SCENES_SWAPPED, onReplaced);
  };
}

const PREVIEW_PROMOTED = "hf-preview-promoted";
export type PreviewPromotion = { retired: HTMLIFrameElement | null; live: HTMLIFrameElement };

export function announcePreviewPromoted(promotion: PreviewPromotion): void {
  promotion.live.ownerDocument.dispatchEvent(
    new CustomEvent(PREVIEW_PROMOTED, { detail: promotion }),
  );
}

export function onPreviewPromoted(
  doc: Document,
  listener: (promotion: PreviewPromotion) => void,
): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<PreviewPromotion>).detail);
  doc.addEventListener(PREVIEW_PROMOTED, handle);
  return () => doc.removeEventListener(PREVIEW_PROMOTED, handle);
}

export function markScenesStale(iframe: HTMLIFrameElement | null, files: readonly string[]): void {
  const doc = iframe?.contentDocument;
  const meta = doc?.querySelector<HTMLMetaElement>('meta[name="hf-scene-parts"]');
  if (!doc || !meta) return;
  let parts: { shared: string; scenes: Record<string, string> };
  try {
    parts = JSON.parse(meta.content);
  } catch {
    return;
  }
  for (const file of files) {
    const hosts = doc.querySelectorAll(`[data-composition-file="${CSS.escape(file)}"]`);
    if (hosts.length === 0 && file.endsWith(".html")) parts.shared = "";
    for (const host of hosts) {
      const scene = host.closest("[data-hf-scene]")?.getAttribute("data-hf-scene");
      if (scene && scene in parts.scenes) parts.scenes[scene] = "";
    }
  }
  meta.content = JSON.stringify(parts);
}

export const supersededByNewerEdit = () =>
  new DOMException("superseded by a newer edit", "AbortError");

const SWAP_REFETCHES_BEFORE_THE_COPY_IN_HAND_WINS = 5;

type SceneSwap = (url: string, isCurrent: () => boolean, cancel?: AbortSignal) => Promise<void>;

export function swapFreshly(
  swap: SceneSwap,
  url: URL,
  isCurrent: () => boolean,
  cancel: AbortSignal,
  reloadWholeFilm: (url: string) => void,
  attempt = 0,
): void {
  const at = previewSourceRevision();
  const remoteAt = externalPreviewRevision;
  const fresh = () => previewSourceRevision() === at;
  const again = () => {
    url.searchParams.set("_t", String(Date.now()));
    swapFreshly(swap, url, isCurrent, cancel, reloadWholeFilm, attempt + 1);
  };
  const retries = attempt < SWAP_REFETCHES_BEFORE_THE_COPY_IN_HAND_WINS;
  const gate = () => isCurrent() && externalPreviewRevision === remoteAt && (!retries || fresh());
  void whileScriptWrites(() => swap(url.toString(), gate, cancel)
    .then(() => {
      if (isCurrent() && !fresh() && retries) again();
    })
    .catch((error: unknown) => {
      if (!isCurrent()) return;
      if (!fresh() && retries) return again();
      logReload("scene-swap-refused", { reason: String(error) });
      reloadWholeFilm(url.toString());
    }));
}

/** Null when the preview cannot swap; rejects when superseded, cancelled or a full reload is needed. */
export function sceneSwapFor(
  iframe: HTMLIFrameElement,
): ((url: string, isCurrent: () => boolean, cancel?: AbortSignal) => Promise<void>) | null {
  const win = iframe.contentWindow as SwapWindow | null;
  let swap: SwapWindow["__hfSwapScenes"];
  try {
    swap = win?.__hfSwapScenes;
  } catch {
    // A cross-origin frame refreshes through the shadow player.
    return null;
  }
  if (typeof swap !== "function") return null;
  return async (url, isCurrent, cancel) => {
    if (cancel?.aborted) throw cancel.reason;
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("the preview took too long to swap")),
      SCENE_SWAP_MS,
    );
    const onCancel = () => deadline.abort(cancel?.reason);
    cancel?.addEventListener("abort", onCancel, { once: true });
    const swapping = (async () => {
      logReload("perf-swap-fetch");
      const response = await studioApiFetch(url, { signal: deadline.signal });
      logReload("perf-swap-response");
      if (!response.ok) throw new Error(`preview request failed with ${response.status}`);
      const html = await response.text();
      if (!isCurrent()) throw new Error("superseded by a newer reload");
      const live = iframe.contentDocument;
      const manifest = 'meta[name="hf-scene-parts"]';
      const before = live?.querySelector<HTMLMetaElement>(manifest)?.content;
      if (live && before) {
        const incoming = new DOMParser().parseFromString(html, "text/html");
        const after = incoming.querySelector<HTMLMetaElement>(manifest)?.content;
        if (after && needsPreparedSceneSwap(live, incoming, JSON.parse(before).scenes, JSON.parse(after).scenes)) {
          throw new Error("the visible scene must be initialized at the playhead before presentation");
        }
      }
      // Aborted with the deadline, so a swap still waiting cannot land after the reload has begun.
      logReload("perf-swap-runtime");
      await swap.call(win, html, deadline.signal);
      logReload("perf-swap-done");
    })();
    const expired = new Promise<never>((_resolve, reject) =>
      deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason)),
    );
    try {
      await Promise.race([swapping, expired]);
    } finally {
      clearTimeout(timer);
      cancel?.removeEventListener("abort", onCancel);
    }
    // Another accepted edit may have arrived while the runtime was mounting
    // scenes. That obsolete swap must not release the file-backed timeline.
    if (!isCurrent()) throw supersededByNewerEdit();
    announcePreviewScenesSwapped(iframe);
  };
}
