import type { DomEditPatchBatchesResult } from "../../hooks/domEditCommitTypes";

type Receipt = { id: string; measuredVersion?: string; version: Promise<string | undefined> };
const receipts = new WeakMap<HTMLIFrameElement, Map<string, Receipt>>();

/** A measurement that includes a pending drag depends on that gesture's verified receipt. */
export function saveCanvasDrag(
  frame: HTMLIFrameElement, path: string, id: string, predecessor: string | undefined,
  write: (version?: string) => Promise<DomEditPatchBatchesResult | undefined>,
  measuredVersion?: string,
): Promise<DomEditPatchBatchesResult | undefined> {
  const byFile = receipts.get(frame) ?? new Map<string, Receipt>();
  receipts.set(frame, byFile);
  const previous = byFile.get(path);
  async function save() {
    if (!predecessor) {
      // A scripted preview may keep displaying our accepted position while an
      // updated scene is prepared. Continue only our own observed version chain.
      if (measuredVersion && previous?.measuredVersion === measuredVersion) return write(await previous.version);
      return write();
    }
    if (previous?.id !== predecessor) return;
    const version = await previous.version;
    if (version) return write(version);
  }
  const result = save();
  byFile.set(path, { id, measuredVersion, version: result.then(saved => saved?.savedCanvasVersion, () => undefined) });
  return result;
}
