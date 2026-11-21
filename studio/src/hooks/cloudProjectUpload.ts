import { MAX_ASSET_BYTES } from "../../../shared/asset-limits";
import { computeFileSha256 } from "../utils/streamingSha256";
import { studioApiFetch, studioProjectUrl } from "../utils/studioApiFetch";

/** Binary media & font extensions that MUST use S3 Presigned PUT / Multipart direct upload in cloud-diskless mode. */
const CLOUD_DIRECT_UPLOAD_EXT =
  /\.(?:mp4|mov|webm|m4v|mkv|avi|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|webp|gif|avif|woff2|woff|ttf|otf|ttc)$/i;

/** Files >= 50 MiB automatically switch from single Presigned PUT to resumable S3 Multipart Upload. */
export const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;
export const MULTIPART_DEFAULT_PART_BYTES = 8 * 1024 * 1024;
const MULTIPART_PART_CONCURRENCY = 3;
const MULTIPART_PART_MAX_RETRIES = 3;
const MULTIPART_STORAGE_PREFIX = "om:multipart:v1:";

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  ttc: "font/collection",
};

export function isCloudDirectUploadFile(file: File): boolean {
  if (CLOUD_DIRECT_UPLOAD_EXT.test(file.name)) return true;
  const mime = (file.type || "").toLowerCase();
  if (mime === "image/svg+xml") return false;
  return mime.startsWith("video/") || mime.startsWith("audio/") || mime.startsWith("image/") || mime.startsWith("font/");
}

export function inferUploadMimeType(file: File): string {
  const raw = (file.type || "").trim().toLowerCase().split(";")[0];
  if (raw && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+_-]{0,100}$/.test(raw)) {
    return raw;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

export function buildProjectUploadTargetPath(
  fileName: string,
  dir: string | undefined,
  existingPaths: ReadonlySet<string>,
): string {
  const baseName = (fileName.split(/[\\/]/).pop() || "asset.bin").replace(/[\x00-\x1f/\\]/g, "_").trim() || "asset.bin";
  const cleanedDir = (dir ?? "").replace(/^\/+|\/+$/g, "");
  const initial = cleanedDir ? `${cleanedDir}/${baseName}` : baseName;
  if (!existingPaths.has(initial)) return initial;

  const dotIndex = baseName.lastIndexOf(".");
  const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
  const ext = dotIndex > 0 ? baseName.slice(dotIndex) : "";
  for (let n = 2; n < 1000; n += 1) {
    const candidateName = `${stem} (${n})${ext}`;
    const candidate = cleanedDir ? `${cleanedDir}/${candidateName}` : candidateName;
    if (!existingPaths.has(candidate)) return candidate;
  }
  return cleanedDir ? `${cleanedDir}/${stem}-${Date.now()}${ext}` : `${stem}-${Date.now()}${ext}`;
}

export interface CloudFileUploadProgress {
  phase: "uploading" | "processing";
  progress: number;
  stage?: string;
}

export interface CloudFileUploadResult {
  status: "imported" | "failed" | "unknown";
  path?: string;
  sha256?: string;
  instant?: boolean;
  resumed?: boolean;
  reason?: string;
  diagnostic?: string;
  category?: "too_large" | "unreadable" | "other";
}

interface PresignedTicketPayload {
  uploadId?: string;
  ticketId?: string;
  uploadUrl?: string;
  method?: string;
  headers?: Record<string, string>;
  expiresAt?: string;
  mode?: "single" | "multipart";
  partSize?: number;
  totalParts?: number;
  instantCommitted?: boolean;
  projectPath?: string;
  sha256?: string;
  error?: string;
  code?: string;
  applied?: boolean;
}

interface MultipartPartsPayload {
  uploadId?: string;
  partSize?: number;
  totalParts?: number;
  expiresAt?: string;
  uploadedParts?: Array<{ partNumber: number; etag: string; size?: number }>;
  urls?: Array<{ partNumber: number; uploadUrl: string; sizeBytes: number }>;
  error?: string;
}

interface ConfirmUploadPayload {
  uploadId?: string;
  jobId?: string | null;
  state?: string;
  replayed?: boolean;
  error?: string;
  code?: string;
  applied?: boolean;
  result?: {
    projectPath?: string;
    sha256?: string;
    error?: string;
  } | null;
}

interface SavedMultipartSession {
  uploadId: string;
  targetPath: string;
  partSize: number;
  totalParts: number;
  expiresAt: string;
}

function multipartStorageKey(projectId: string, file: File): string {
  return `${MULTIPART_STORAGE_PREFIX}${projectId}:${file.name}:${file.size}:${file.lastModified}`;
}

function readSavedMultipartSession(key: string): SavedMultipartSession | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedMultipartSession>;
    if (
      typeof parsed.uploadId !== "string" ||
      typeof parsed.targetPath !== "string" ||
      typeof parsed.partSize !== "number" ||
      typeof parsed.totalParts !== "number" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }
    if (Date.parse(parsed.expiresAt) <= Date.now() + 30_000) {
      window.localStorage.removeItem(key);
      return null;
    }
    return parsed as SavedMultipartSession;
  } catch {
    return null;
  }
}

function writeSavedMultipartSession(key: string, session: SavedMultipartSession): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(key, JSON.stringify(session));
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
}

function clearSavedMultipartSession(key: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors.
  }
}

function putBlobWithProgress(
  uploadUrl: string,
  method: string,
  contentType: string | undefined,
  body: Blob,
  onLoadedBytes?: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; etag: string | null }> {
  if (typeof XMLHttpRequest === "undefined") {
    return fetch(uploadUrl, {
      method,
      headers: contentType ? { "Content-Type": contentType } : undefined,
      body,
      signal,
    }).then((res) => {
      if (res.ok) onLoadedBytes?.(body.size);
      return { ok: res.ok, status: res.status, etag: res.headers.get("etag") };
    });
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => {
      xhr.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onLoadedBytes?.(Math.min(body.size, event.loaded));
      }
    };
    xhr.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      const ok = xhr.status >= 200 && xhr.status < 300;
      if (ok) onLoadedBytes?.(body.size);
      resolve({ ok, status: xhr.status, etag: xhr.getResponseHeader("ETag") });
    };
    xhr.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new TypeError("Direct storage upload network error"));
    };
    xhr.ontimeout = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Direct storage upload timed out"));
    };

    xhr.open(method || "PUT", uploadUrl, true);
    if (contentType) {
      xhr.setRequestHeader("Content-Type", contentType);
    }
    xhr.send(body);
  });
}

async function uploadMultipartPartsResumable(params: {
  uploadId: string;
  file: File;
  partSize: number;
  totalParts: number;
  initialPartsPayload?: MultipartPartsPayload;
  onProgress?: (update: CloudFileUploadProgress) => void;
  signal?: AbortSignal;
}): Promise<{ ok: true; parts: Array<{ partNumber: number; etag: string }>; resumed: boolean } | { ok: false; reason: string; diagnostic: string; category?: "too_large" | "other" }> {
  const { uploadId, file, partSize, totalParts, onProgress, signal } = params;
  const completedParts = new Map<number, { etag: string; size: number }>();
  const inFlightBytes = new Map<number, number>();
  let resumed = false;

  const reportAggregateProgress = () => {
    let loaded = 0;
    for (const part of completedParts.values()) loaded += part.size;
    for (const bytes of inFlightBytes.values()) loaded += bytes;
    const pct = file.size > 0 ? Math.max(0, Math.min(100, Math.round((loaded / file.size) * 100))) : 100;
    onProgress?.({ phase: "uploading", progress: pct, stage: "uploading_parts" });
  };

  const fetchBatch = async (partNumbers?: number[]): Promise<MultipartPartsPayload> => {
    const res = await studioApiFetch(`/motion-api/assets/uploads/${encodeURIComponent(uploadId)}/parts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partNumbers ? { partNumbers } : {}),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as MultipartPartsPayload;
    if (!res.ok) {
      throw new Error(data.error || `Multipart part signing failed (${res.status})`);
    }
    return data;
  };

  let batch: MultipartPartsPayload;
  try {
    batch = params.initialPartsPayload ?? (await fetchBatch());
  } catch (error) {
    return {
      ok: false,
      reason: "Could not prepare multipart upload chunks. Try again.",
      diagnostic: error instanceof Error ? error.message : "Failed to list/sign multipart parts",
    };
  }

  for (const existing of batch.uploadedParts ?? []) {
    if (existing.partNumber >= 1 && existing.partNumber <= totalParts && existing.etag) {
      const start = (existing.partNumber - 1) * partSize;
      const expectedSize = Math.min(partSize, Math.max(1, file.size - start));
      completedParts.set(existing.partNumber, {
        etag: existing.etag,
        size: existing.size ?? expectedSize,
      });
    }
  }
  if (completedParts.size > 0) {
    resumed = true;
    reportAggregateProgress();
  }

  // Upload all missing parts in signed batches with bounded concurrency and per-part retries.
  let signedUrls = new Map<number, { uploadUrl: string; sizeBytes: number }>();
  for (const u of batch.urls ?? []) {
    signedUrls.set(u.partNumber, { uploadUrl: u.uploadUrl, sizeBytes: u.sizeBytes });
  }

  for (;;) {
    if (signal?.aborted) {
      return { ok: false, reason: "Upload cancelled.", diagnostic: "Aborted" };
    }
    const missing: number[] = [];
    for (let n = 1; n <= totalParts; n += 1) {
      if (!completedParts.has(n)) missing.push(n);
    }
    if (missing.length === 0) break;

    const batchTargets = missing.slice(0, 32);
    const needSigning = batchTargets.filter((n) => !signedUrls.has(n));
    if (needSigning.length > 0) {
      try {
        const nextBatch = await fetchBatch(batchTargets);
        signedUrls = new Map();
        for (const u of nextBatch.urls ?? []) {
          signedUrls.set(u.partNumber, { uploadUrl: u.uploadUrl, sizeBytes: u.sizeBytes });
        }
      } catch (error) {
        return {
          ok: false,
          reason: "Could not sign upload parts. Try again.",
          diagnostic: error instanceof Error ? error.message : "Part sign failed",
        };
      }
    }

    let cursor = 0;
    const errorRef: { current: { reason: string; diagnostic: string; category?: "too_large" | "other" } | null } = {
      current: null,
    };

    const runPartWorker = async () => {
      for (;;) {
        if (errorRef.current || signal?.aborted) return;
        const idx = cursor;
        cursor += 1;
        if (idx >= batchTargets.length) return;
        const partNumber = batchTargets[idx];
        const signed = signedUrls.get(partNumber);
        if (!signed) {
          errorRef.current = {
            reason: "Missing presigned URL for upload chunk.",
            diagnostic: `No presigned URL for part ${partNumber}`,
          };
          return;
        }

        const start = (partNumber - 1) * partSize;
        const end = Math.min(file.size, start + partSize);
        const chunkBlob = file.slice(start, end);

        let uploaded = false;
        let lastErr = "";
        for (let attempt = 0; attempt < MULTIPART_PART_MAX_RETRIES; attempt += 1) {
          if (signal?.aborted) return;
          try {
            const putOutcome = await putBlobWithProgress(
              signed.uploadUrl,
              "PUT",
              undefined,
              chunkBlob,
              (loaded) => {
                inFlightBytes.set(partNumber, loaded);
                reportAggregateProgress();
              },
              signal,
            );
            inFlightBytes.delete(partNumber);
            if (putOutcome.ok && putOutcome.etag) {
              completedParts.set(partNumber, { etag: putOutcome.etag, size: chunkBlob.size });
              reportAggregateProgress();
              uploaded = true;
              break;
            }
            if (putOutcome.status === 413) {
              errorRef.current = {
                reason: "Upload rejected: payload too large. Choose smaller files.",
                diagnostic: `Multipart part ${partNumber} HTTP 413`,
                category: "too_large",
              };
              return;
            }
            lastErr = putOutcome.ok
              ? `Part ${partNumber} missing ETag response header (check bucket CORS ExposeHeaders)`
              : `Part ${partNumber} HTTP ${putOutcome.status}`;
          } catch (error) {
            inFlightBytes.delete(partNumber);
            if (error instanceof DOMException && error.name === "AbortError") return;
            lastErr = error instanceof Error ? error.message : `Part ${partNumber} network error`;
          }

          if (attempt + 1 < MULTIPART_PART_MAX_RETRIES) {
            const backoffMs = 400 * Math.pow(2, attempt);
            await new Promise<void>((resolve) => window.setTimeout(resolve, backoffMs));
          }
        }

        if (!uploaded && !signal?.aborted) {
          errorRef.current = {
            reason: "Upload to storage was interrupted. Re-select the same file to resume.",
            diagnostic: lastErr || `Part ${partNumber} failed after retries`,
          };
          return;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(MULTIPART_PART_CONCURRENCY, batchTargets.length) }, () => runPartWorker()),
    );
    if (errorRef.current) {
      return { ok: false, ...errorRef.current };
    }
    signedUrls.clear();
  }

  const orderedParts = Array.from(completedParts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([partNumber, info]) => ({ partNumber, etag: info.etag }));

  // Assemble uploaded parts on S3 before invoking standard /confirm.
  try {
    const completeRes = await studioApiFetch(
      `/motion-api/assets/uploads/${encodeURIComponent(uploadId)}/complete-multipart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: orderedParts }),
        signal,
      },
    );
    const completeData = (await completeRes.json().catch(() => ({}))) as { error?: string };
    if (!completeRes.ok) {
      return {
        ok: false,
        reason: completeData.error || "Failed to finalize multipart upload. Try again.",
        diagnostic: `Complete multipart HTTP ${completeRes.status}${completeData.error ? `: ${completeData.error}` : ""}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: "Connection dropped while finalizing upload. Re-select the file to resume.",
      diagnostic: error instanceof Error ? error.message : "Complete multipart error",
    };
  }

  onProgress?.({ phase: "uploading", progress: 100 });
  return { ok: true, parts: orderedParts, resumed };
}

async function waitForMediaCommitJob(
  projectId: string,
  uploadId: string,
  jobId: string | null | undefined,
  requestId: string,
  fileName: string,
  onProgress?: (update: CloudFileUploadProgress) => void,
  signal?: AbortSignal,
): Promise<{ state: "completed" | "failed" | "timeout"; projectPath?: string; sha256?: string; error?: string }> {
  const maxWaitMs = 300_000;
  const deadline = Date.now() + maxWaitMs;

  if (jobId && typeof EventSource !== "undefined") {
    const sseOutcome = await new Promise<
      | { done: true; state: "completed" | "failed"; projectPath?: string; sha256?: string; error?: string }
      | { done: false }
    >((resolve) => {
      let settled = false;
      const es = new EventSource(studioProjectUrl(`/api/media-jobs/${encodeURIComponent(jobId)}/progress`, projectId));
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        es.close();
      };
      const finish = (
        res:
          | { done: true; state: "completed" | "failed"; projectPath?: string; sha256?: string; error?: string }
          | { done: false },
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      };
      const onAbort = () => finish({ done: false });
      const timeoutId = window.setTimeout(() => finish({ done: false }), maxWaitMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      es.addEventListener("progress", (evt) => {
        try {
          const data = JSON.parse((evt as MessageEvent).data) as {
            state?: string;
            stage?: string;
            progress?: number;
            result?: { projectPath?: string; sha256?: string } | null;
            error?: string | null;
          };
          if (typeof data.progress === "number") {
            onProgress?.({ phase: "processing", progress: data.progress, stage: data.stage });
          }
          if (data.state === "completed") {
            finish({
              done: true,
              state: "completed",
              projectPath: data.result?.projectPath,
              sha256: data.result?.sha256,
            });
          } else if (data.state === "failed" || data.state === "cancelled") {
            finish({
              done: true,
              state: "failed",
              error: data.error || "Media processing failed",
            });
          }
        } catch {
          // Ignore malformed SSE event.
        }
      });

      es.onerror = () => {
        finish({ done: false });
      };
    });

    if (sseOutcome.done) {
      return {
        state: sseOutcome.state,
        projectPath: sseOutcome.projectPath,
        sha256: sseOutcome.sha256,
        error: sseOutcome.error,
      };
    }
  }

  let delayMs = 400;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { state: "failed", error: "Upload cancelled" };
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
    delayMs = Math.min(2000, Math.round(delayMs * 1.4));

    const pollRes = await studioApiFetch(`/motion-api/assets/uploads/${encodeURIComponent(uploadId)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: fileName, requestId }),
      signal,
    });
    const pollData = (await pollRes.json().catch(() => ({}))) as ConfirmUploadPayload;
    if (!pollRes.ok) {
      return {
        state: "failed",
        error: typeof pollData.error === "string" ? pollData.error : `Confirm failed (${pollRes.status})`,
      };
    }
    if (pollData.state === "committed") {
      return {
        state: "completed",
        projectPath: pollData.result?.projectPath,
        sha256: pollData.result?.sha256,
      };
    }
    if (pollData.state === "failed") {
      return {
        state: "failed",
        error: pollData.result?.error || pollData.error || "Upload processing failed",
      };
    }
  }

  return { state: "timeout" };
}

/**
 * Upload one binary media/font file directly to S3:
 * 1. Computes constant-memory streaming SHA-256 to attempt same-workspace CAS instant commit ("秒传").
 * 2. Files < 50 MiB use single Presigned PUT with real-time XHR byte progress.
 * 3. Files >= 50 MiB use resumable S3 Multipart Upload (8 MiB parts, 3-way concurrency, localStorage resume).
 * Never falls back to `/api/projects/:id/upload` (K8s Ingress caps body size at 16m).
 */
export async function uploadCloudProjectFile(params: {
  projectId: string;
  file: File;
  targetPath: string;
  multipartThresholdBytes?: number;
  onProgress?: (update: CloudFileUploadProgress) => void;
  signal?: AbortSignal;
}): Promise<CloudFileUploadResult> {
  const {
    projectId,
    file,
    targetPath,
    multipartThresholdBytes = MULTIPART_THRESHOLD_BYTES,
    onProgress,
    signal,
  } = params;

  if (file.size === 0) {
    return {
      status: "failed",
      reason: "This file is empty. Choose a file with content.",
      category: "unreadable",
    };
  }
  if (file.size > MAX_ASSET_BYTES) {
    return {
      status: "failed",
      reason: "Upload rejected: payload too large. Choose smaller files.",
      category: "too_large",
    };
  }

  const requestId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const mimeType = inferUploadMimeType(file);
  const shouldUseMultipart = file.size >= multipartThresholdBytes;
  const storageKey = multipartStorageKey(projectId, file);

  // Step 0: Constant-memory streaming SHA-256 for same-workspace CAS instant dedupe ("秒传").
  let expectedSha256: string | undefined;
  try {
    expectedSha256 = await computeFileSha256(file, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { status: "failed", reason: "Upload cancelled.", diagnostic: "Aborted during hashing" };
    }
    // Non-fatal: continue normal upload without instant dedupe if hashing fails.
  }

  // Step 1a: If multipart, try resuming an existing active session from localStorage first.
  let uploadId: string | undefined;
  let effectiveTargetPath = targetPath;
  let resumedSessionParts: MultipartPartsPayload | undefined;
  let multipartPartSize = MULTIPART_DEFAULT_PART_BYTES;
  let multipartTotalParts = Math.max(1, Math.ceil(file.size / multipartPartSize));
  let isMultipartMode = false;

  if (shouldUseMultipart) {
    const saved = readSavedMultipartSession(storageKey);
    if (saved) {
      try {
        const resumeRes = await studioApiFetch(
          `/motion-api/assets/uploads/${encodeURIComponent(saved.uploadId)}/parts`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
            signal,
          },
        );
        if (resumeRes.ok) {
          resumedSessionParts = (await resumeRes.json().catch(() => ({}))) as MultipartPartsPayload;
          uploadId = saved.uploadId;
          effectiveTargetPath = saved.targetPath;
          multipartPartSize = resumedSessionParts.partSize ?? saved.partSize;
          multipartTotalParts = resumedSessionParts.totalParts ?? saved.totalParts;
          isMultipartMode = true;
        } else {
          clearSavedMultipartSession(storageKey);
        }
      } catch {
        clearSavedMultipartSession(storageKey);
      }
    }
  }

  let ticketData: PresignedTicketPayload = {};
  if (!uploadId) {
    // Step 1b: Mint upload ticket (with same-workspace instant commit & optional multipart mode).
    let ticketRes: Response;
    try {
      ticketRes = await studioApiFetch("/motion-api/assets/uploads/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose: "project_asset",
          targetProjectId: projectId,
          targetPath,
          filename: file.name,
          mimeType,
          sizeBytes: file.size,
          ...(expectedSha256 ? { expectedSha256, allowInstantCommit: true } : {}),
          ...(shouldUseMultipart ? { multipart: true, partSize: MULTIPART_DEFAULT_PART_BYTES } : {}),
          requestId,
        }),
        signal,
      });
    } catch (error) {
      return {
        status: "failed",
        reason: "Could not start upload. Check your connection and try again.",
        diagnostic: error instanceof Error ? `${error.name}: ${error.message}` : "Ticket request failed",
        category: "other",
      };
    }

    ticketData = (await ticketRes.json().catch(() => ({}))) as PresignedTicketPayload;
    if (!ticketRes.ok) {
      if (ticketRes.status === 413) {
        return {
          status: "failed",
          reason: "Upload rejected: payload too large. Choose smaller files.",
          diagnostic: `Ticket HTTP 413${ticketData.error ? `: ${ticketData.error}` : ""}`,
          category: "too_large",
        };
      }
      return {
        status: "failed",
        reason: ticketData.error || "The server rejected this upload before adding files. Choose the files again.",
        diagnostic: `Ticket HTTP ${ticketRes.status}${ticketData.error ? `: ${ticketData.error}` : ""}`,
        category: "other",
      };
    }

    // Instant same-workspace CAS commit hit ("秒传"): 0 bytes uploaded!
    if (ticketData.instantCommitted) {
      onProgress?.({ phase: "uploading", progress: 100 });
      onProgress?.({ phase: "processing", progress: 100, stage: "completed" });
      return {
        status: "imported",
        path: ticketData.projectPath || targetPath,
        sha256: ticketData.sha256 ?? expectedSha256,
        instant: true,
      };
    }

    uploadId = ticketData.uploadId ?? ticketData.ticketId;
    if (ticketData.mode === "multipart" && uploadId && ticketData.partSize && ticketData.totalParts) {
      isMultipartMode = true;
      multipartPartSize = ticketData.partSize;
      multipartTotalParts = ticketData.totalParts;
      writeSavedMultipartSession(storageKey, {
        uploadId,
        targetPath,
        partSize: multipartPartSize,
        totalParts: multipartTotalParts,
        expiresAt: ticketData.expiresAt ?? new Date(Date.now() + 900_000).toISOString(),
      });
    } else if (!uploadId || !ticketData.uploadUrl) {
      return {
        status: "failed",
        reason: "The server did not return an upload destination. Try again.",
        diagnostic: "Missing uploadId or uploadUrl from ticket response",
        category: "other",
      };
    }
  }

  // Step 2: Upload bytes directly to S3 (Multipart resumable OR single Presigned PUT).
  let resumed = false;
  if (isMultipartMode && uploadId) {
    onProgress?.({ phase: "uploading", progress: 0, stage: "uploading_parts" });
    const mpOutcome = await uploadMultipartPartsResumable({
      uploadId,
      file,
      partSize: multipartPartSize,
      totalParts: multipartTotalParts,
      initialPartsPayload: resumedSessionParts,
      onProgress,
      signal,
    });
    if (!mpOutcome.ok) {
      if (signal?.aborted) {
        clearSavedMultipartSession(storageKey);
        void studioApiFetch(`/motion-api/assets/uploads/${encodeURIComponent(uploadId)}`, {
          method: "DELETE",
        }).catch(() => {});
      }
      return {
        status: "failed",
        reason: mpOutcome.reason,
        diagnostic: mpOutcome.diagnostic,
        category: mpOutcome.category ?? "other",
      };
    }
    resumed = mpOutcome.resumed;
    clearSavedMultipartSession(storageKey);
  } else {
    const signedContentType =
      ticketData.headers?.["Content-Type"] ?? ticketData.headers?.["content-type"] ?? mimeType;
    onProgress?.({ phase: "uploading", progress: 0 });
    try {
      const putOutcome = await putBlobWithProgress(
        ticketData.uploadUrl!,
        ticketData.method || "PUT",
        signedContentType,
        file,
        (loaded) => {
          const pct = file.size > 0 ? Math.max(0, Math.min(100, Math.round((loaded / file.size) * 100))) : 100;
          onProgress?.({ phase: "uploading", progress: pct });
        },
        signal,
      );
      if (!putOutcome.ok) {
        if (putOutcome.status === 413) {
          return {
            status: "failed",
            reason: "Upload rejected: payload too large. Choose smaller files.",
            diagnostic: "Direct storage PUT HTTP 413",
            category: "too_large",
          };
        }
        return {
          status: "failed",
          reason: "Upload to storage failed before adding the file. Choose the file again.",
          diagnostic: `Direct storage PUT HTTP ${putOutcome.status}`,
          category: "other",
        };
      }
    } catch (error) {
      return {
        status: "failed",
        reason: "Upload to storage was interrupted before adding the file. Try again.",
        diagnostic: error instanceof Error ? `${error.name}: ${error.message}` : "Direct PUT error",
        category: "other",
      };
    }
  }

  // Step 3: Confirm upload & wait for worker-media CAS + PG commit.
  onProgress?.({ phase: "processing", progress: 10, stage: "probing" });
  let confirmRes: Response;
  try {
    confirmRes = await studioApiFetch(`/motion-api/assets/uploads/${encodeURIComponent(uploadId!)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        requestId,
        ...(expectedSha256 ? { expectedSha256 } : {}),
      }),
      signal,
    });
  } catch (error) {
    return {
      status: "unknown",
      diagnostic: error instanceof Error ? `${error.name}: ${error.message}` : "Confirm request lost",
    };
  }

  const confirmData = (await confirmRes.json().catch(() => ({}))) as ConfirmUploadPayload;
  if (!confirmRes.ok) {
    const knownRejection = confirmRes.status === 413 || confirmData.applied === false;
    return {
      status: knownRejection ? "failed" : "unknown",
      reason: confirmData.error || undefined,
      diagnostic: `Confirm HTTP ${confirmRes.status}${confirmData.error ? `: ${confirmData.error}` : ""}`,
      category: confirmRes.status === 413 ? "too_large" : "other",
    };
  }

  if (confirmData.state === "committed") {
    return {
      status: "imported",
      path: confirmData.result?.projectPath || effectiveTargetPath,
      sha256: confirmData.result?.sha256 ?? expectedSha256,
      resumed,
    };
  }
  if (confirmData.state === "failed") {
    return {
      status: "failed",
      reason: confirmData.result?.error || confirmData.error || "Cannot read this media file.",
      diagnostic: `Commit failed: ${confirmData.result?.error || confirmData.error || "unknown"}`,
      category: "unreadable",
    };
  }

  const outcome = await waitForMediaCommitJob(
    projectId,
    uploadId!,
    confirmData.jobId,
    requestId,
    file.name,
    onProgress,
    signal,
  );
  if (outcome.state === "completed") {
    return {
      status: "imported",
      path: outcome.projectPath || effectiveTargetPath,
      sha256: outcome.sha256 ?? expectedSha256,
      resumed,
    };
  }
  if (outcome.state === "failed") {
    return {
      status: "failed",
      reason: outcome.error || "Cannot read this media file.",
      diagnostic: `Media ingest failed: ${outcome.error || "unknown"}`,
      category: "unreadable",
    };
  }
  return {
    status: "unknown",
    diagnostic: "Timed out waiting for media commit confirmation",
  };
}
