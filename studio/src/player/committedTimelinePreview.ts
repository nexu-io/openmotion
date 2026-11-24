import { confirmedSource, type ConfirmedSource } from "../utils/confirmedTextSources";
import { scheduleCommittedPreview } from "./committedPreview";

type TimingReceipt = { before: string; after: string; version?: string };

/** Timeline history includes source bytes. Only a matching file revision may be sent to the player. */
export function scheduleCommittedTimelinePreview(
  frame: HTMLIFrameElement,
  projectId: string,
  path: string,
  files: Record<string, TimingReceipt>,
  previous: ConfirmedSource | undefined,
  refresh: (paths: readonly string[]) => void,
  bases?: ReadonlyMap<string, ConfirmedSource>,
) {
  const entries = Object.entries(files);
  const changes = entries.map(([file, receipt]) => {
    const base = bases?.get(file) ?? (entries.length === 1 ? previous : undefined);
    const known = confirmedSource(projectId, file);
    const current = receipt.version ? { version: receipt.version, content: receipt.after } : known;
    return { path: file, previous: base?.content === receipt.before ? base : undefined,
      current: current?.content === receipt.after ? current : undefined };
  });
  scheduleCommittedPreview(frame, projectId, changes.length ? changes : [{path}], refresh);
}
