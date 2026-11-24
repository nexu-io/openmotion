import type { DomEditPatchBatchesResult } from "../../hooks/domEditCommitTypes";

type Outcome = { version?: string } | { error: unknown };
type Receipt = { id: string; measuredVersion?: string; outcome: Promise<Outcome> };
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
      if (measuredVersion && previous?.measuredVersion === measuredVersion) {
        const prior = await previous.outcome;
        if ("version" in prior && prior.version) return write(prior.version);
      }
      return write();
    }
    if (previous?.id !== predecessor) return;
    const prior = await previous.outcome;
    // The original failed write already reports its error. Its dependants share
    // that failure, including the conflict explanation shown to the user.
    if ("error" in prior) throw prior.error;
    if (prior.version) return write(prior.version);
  }
  const result = save();
  byFile.set(path, { id, measuredVersion, outcome: result.then(saved => ({ version: saved?.savedCanvasVersion }), error => ({ error })) });
  return result;
}
