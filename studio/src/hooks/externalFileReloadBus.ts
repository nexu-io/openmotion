import type { ConfirmedSource } from "../utils/confirmedTextSources";
import type { RemoteFileRead } from "./remoteFileReads";

export interface ExternalFileChange {
  projectId: string;
  paths: readonly string[] | null;
  treeChanged: boolean;
  previous?: ConfirmedSource;
  current?: ConfirmedSource;
}

type ExternalFileReloadListener = (path: string, read?: RemoteFileRead, change?: ExternalFileChange) => void;

const listeners = new Set<ExternalFileReloadListener>();

export function addExternalFileReloadListener(listener: ExternalFileReloadListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyExternalFileReload(...change: Parameters<ExternalFileReloadListener>): void {
  for (const listener of listeners) {
    try {
      listener(...change);
    } catch {
      // A stale SDK owner must not prevent sibling owners from reloading.
    }
  }
}
