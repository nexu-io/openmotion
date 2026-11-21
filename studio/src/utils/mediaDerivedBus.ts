export type MediaDerivedKind = "thumbnail" | "sprite" | "waveform" | "proxy" | "metadata";

export interface MediaDerivedReadyEvent {
  type: "media-derived-ready";
  workspaceId?: string;
  projectId: string;
  sha256: string;
  kind: MediaDerivedKind;
  status: "ready" | "failed";
  paths?: string[];
  ts?: number;
}

export type MediaIngestSource = "mcp_upload" | "mcp_url" | "web_upload";
export type MediaIngestState = "waiting_upload" | "processing" | "completed" | "failed";

export interface MediaIngestStatusEvent {
  type: "media-ingest-status";
  workspaceId?: string;
  projectId: string;
  ticketId?: string;
  jobId?: string;
  filename: string;
  targetPath?: string;
  bytes?: number;
  source: MediaIngestSource;
  state: MediaIngestState;
  stage?: string;
  progress?: number;
  error?: string;
  expiresAt?: string;
  ts?: number;
}

type DerivedListener = (event: MediaDerivedReadyEvent) => void;
type IngestListener = (event: MediaIngestStatusEvent) => void;

const listeners = new Set<DerivedListener>();
const ingestListeners = new Set<IngestListener>();

export function isMediaIngestStatusEvent(value: unknown): value is MediaIngestStatusEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MediaIngestStatusEvent>;
  return (
    candidate.type === "media-ingest-status" &&
    typeof candidate.projectId === "string" &&
    typeof candidate.filename === "string" &&
    (candidate.source === "mcp_upload" || candidate.source === "mcp_url" || candidate.source === "web_upload") &&
    (candidate.state === "waiting_upload" ||
      candidate.state === "processing" ||
      candidate.state === "completed" ||
      candidate.state === "failed")
  );
}

export function emitMediaIngestStatus(event: MediaIngestStatusEvent): void {
  for (const listener of ingestListeners) {
    try {
      listener(event);
    } catch {
      // Isolate individual subscriber failures.
    }
  }
}

export function subscribeMediaIngestStatus(listener: IngestListener): () => void {
  ingestListeners.add(listener);
  return () => {
    ingestListeners.delete(listener);
  };
}

export function isMediaDerivedReadyEvent(value: unknown): value is MediaDerivedReadyEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MediaDerivedReadyEvent>;
  return (
    candidate.type === "media-derived-ready" &&
    typeof candidate.projectId === "string" &&
    typeof candidate.sha256 === "string" &&
    (candidate.kind === "thumbnail" ||
      candidate.kind === "sprite" ||
      candidate.kind === "waveform" ||
      candidate.kind === "proxy" ||
      candidate.kind === "metadata") &&
    (candidate.status === "ready" || candidate.status === "failed")
  );
}

export function emitMediaDerived(event: MediaDerivedReadyEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Isolate individual subscriber failures.
    }
  }
}

export function subscribeMediaDerived(listener: DerivedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Wait until either a matching `media-derived-ready` SSE event arrives or `timeoutMs` elapses.
 * Rejects immediately with AbortError if `signal` aborts.
 */
export function waitForMediaDerived(
  predicate: (event: MediaDerivedReadyEvent) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MediaDerivedReadyEvent | null> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<MediaDerivedReadyEvent | null>((resolve, reject) => {
    let settled = false;
    const finish = (event: MediaDerivedReadyEvent | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      resolve(event);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const unsubscribe = subscribeMediaDerived((event) => {
      if (predicate(event)) finish(event);
    });
    const timer = window.setTimeout(() => finish(null), Math.max(50, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
