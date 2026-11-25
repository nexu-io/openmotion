import { relativeLayerBounds, type LayerBounds } from "../components/editor/isolatedLayerBounds";

type Target = { sourceFile: string; elementId?: string | null; hfId?: string | null };
type Selection = { target: Target; apply(bounds: LayerBounds, geometry: LayerBounds): void };
export type SelectionPaintReply = boolean | { applied: boolean; geometry: LayerBounds; viewport: { width: number; height: number } };
type Stage = HTMLElement & { startViewTransition?(update: () => Promise<void>): ViewTransition };
const selections = new WeakMap<HTMLIFrameElement, {read: () => Selection | undefined; sent: number; shown: number}>();

export function observeIsolatedSelection(frame: HTMLIFrameElement, read: () => Selection | undefined) {
  const owner = { read, sent: 0, shown: 0 };
  selections.set(frame, owner);
  return () => { if (selections.get(frame) === owner) selections.delete(frame); };
}

/** Hold the already-painted stage only for the local iframe mutation and its measured reply. */
export async function paintWithIsolatedSelection(frame: HTMLIFrameElement, path: string, hold: boolean,
  current: () => boolean, request: (target?: Target) => Promise<SelectionPaintReply>): Promise<boolean> {
  const owner = selections.get(frame);
  const selection = owner?.read();
  if (!owner || !selection || selection.target.sourceFile !== path) return await request() === true;
  const stage = frame.closest<Stage>("[data-preview-pan-surface]");
  let applied = false;
  const paint = async () => {
    if (!current()) return;
    const sequence = ++owner.sent;
    const result = await request(selection.target);
    applied = result === true || (typeof result === "object" && result?.applied === true);
    if (typeof result !== "object" || !result || sequence <= owner.shown || !current() || selections.get(frame) !== owner) return;
    const bounds = relativeLayerBounds(result);
    if (bounds) {
      owner.shown = sequence;
      selection.apply(bounds, result.geometry);
    }
  };
  if (hold && stage?.startViewTransition && !stage.ownerDocument.hidden) {
    // A cross-origin surface can present independently even while the transition's
    // update callback is pending. First put the OLD snapshot on screen, then edit.
    const transition = stage.startViewTransition(() => Promise.resolve());
    const doc = stage.ownerDocument;
    const skipIfHidden = () => { if (doc.hidden) transition.skipTransition(); };
    doc.addEventListener("visibilitychange", skipIfHidden);
    const finished = transition.finished.catch(() => {});
    const nextPaint = () => Promise.race([finished, new Promise<void>(resolve => requestAnimationFrame(() => resolve()))]);
    try {
      await transition.ready.catch(() => {});
      await nextPaint();
      await paint();
      // Let both compositor surfaces submit their updated pixels before revealing them.
      await nextPaint();
    } finally {
      doc.removeEventListener("visibilitychange", skipIfHidden);
      transition.skipTransition();
    }
  } else await paint();
  return applied;
}
