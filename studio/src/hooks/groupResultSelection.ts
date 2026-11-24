import { onPreviewContentReplaced, onPreviewPromoted } from "../player/sceneSwap";

export type GroupTarget = { id?: string | null; hfId?: string | null };
export interface GroupSelectionResult { wrap: boolean; wrapper: GroupTarget; members: GroupTarget[] }

/** A structural edit owns its result selection until the user selects something else. */
export function followGroupSelection(
  frame: HTMLIFrameElement,
  result: GroupSelectionResult,
  select: (frame: HTMLIFrameElement, result: GroupSelectionResult, current: () => boolean) => Promise<boolean>,
) {
  const controller = new AbortController();
  const { signal } = controller;
  let live = frame;
  let sequence = 0;
  const cancel = () => controller.abort();
  let target = result;
  let saved = false;
  let selected = false;
  const paint = async () => {
    const turn = ++sequence;
    const current = () => !signal.aborted && sequence === turn && live.isConnected;
    if (!current()) return;
    const applied = await select(live, target, current);
    if (applied && current()) {
      selected = true;
      if (saved) cancel();
    }
  };
  const ready = () => { void paint().catch(() => { /* A replacement frame may still be loading. */ }); };
  let stopContent = onPreviewContentReplaced(live, ready);
  const doc = live.ownerDocument;
  const stopPromotion = onPreviewPromoted(doc, ({retired, live: next}) => {
    if (retired !== live) return;
    stopContent();
    live = next;
    stopContent = onPreviewContentReplaced(live, ready);
    ready();
  });
  doc.addEventListener("pointerdown", cancel, {capture:true, signal});
  doc.addEventListener("keydown", cancel, {capture:true, signal});
  signal.addEventListener("abort", () => { stopContent(); stopPromotion(); }, {once:true});
  return {
    ready, cancel,
    saved() { saved = true; if (selected) cancel(); },
    rollback() {
      saved = true;
      if (!selected) { cancel(); return; }
      target = {...result, wrap: !result.wrap};
      ready();
    },
  };
}
