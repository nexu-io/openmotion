import { gatewayRequest } from './gatewayClient';
import type { LibraryAsset } from '../../../shared/asset-library';
import { MAX_ASSET_BYTES } from '../../../shared/asset-limits';
import { AssetUploadError, uploadResponseError } from './assetUploadError';

export async function assetRequest<T>(args: Record<string, unknown>): Promise<T> {
  return gatewayRequest<T>('phase1/call', 'POST', { name: 'openmotion_assets_use', arguments: args });
}

interface PresignedTicketResponse {
  ticketId?: string;
  uploadId?: string;
  uploadUrl?: string;
  method?: string;
  headers?: Record<string, string>;
}

interface ConfirmUploadResponse {
  ticketId?: string;
  jobId?: string | null;
  state?: string;
  replayed?: boolean;
  asset?: LibraryAsset;
  result?: {
    asset?: LibraryAsset;
    assetId?: string;
    versionId?: string;
    error?: string;
  } | null;
}

function isValidLibraryAsset(asset: unknown, modality?: 'video'): asset is LibraryAsset {
  const candidate = asset as Partial<LibraryAsset> | null | undefined;
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id) return false;
  if (modality && candidate.modality !== modality) return false;
  if (typeof candidate.currentVersionId !== 'string' || !candidate.currentVersionId) return false;
  if (!Array.isArray(candidate.versions)) return false;
  return candidate.versions.some((version: { id?: string }) => version?.id === candidate.currentVersionId);
}

async function resolveCommittedAsset(
  uploadId: string,
  confirmed: ConfirmUploadResponse,
  requestId: string,
  parentVersionId?: string,
  modality?: 'video',
): Promise<LibraryAsset> {
  const extract = async (payload: ConfirmUploadResponse): Promise<LibraryAsset | null> => {
    const direct = payload.asset ?? payload.result?.asset;
    if (isValidLibraryAsset(direct, modality)) return direct;
    const committedAssetId = payload.result?.assetId;
    if (typeof committedAssetId === 'string' && committedAssetId) {
      const res = await fetch(`/motion-api/assets/${encodeURIComponent(committedAssetId)}`);
      if (res.ok) {
        const fetched = (await res.json()) as { asset?: LibraryAsset };
        if (isValidLibraryAsset(fetched.asset, modality)) return fetched.asset;
      }
    }
    return null;
  };

  const immediate = await extract(confirmed);
  if (immediate) return immediate;

  // Subscribe to media-job SSE first when available, then poll idempotent confirm endpoint (up to 180s for large videos).
  if (confirmed.state === 'queued' || confirmed.state === 'processing' || confirmed.state === 'uploaded') {
    if (confirmed.jobId && typeof EventSource !== 'undefined') {
      const sseResult = await new Promise<{ assetId?: string; failed?: string } | null>((resolve) => {
        let settled = false;
        const es = new EventSource(`/api/media-jobs/${encodeURIComponent(confirmed.jobId!)}/progress`);
        const finish = (value: { assetId?: string; failed?: string } | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          es.close();
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), 180_000);
        es.addEventListener('progress', (evt) => {
          try {
            const data = JSON.parse((evt as MessageEvent).data) as {
              state?: string;
              result?: { assetId?: string } | null;
              error?: string | null;
            };
            if (data.state === 'completed') finish({ assetId: data.result?.assetId });
            else if (data.state === 'failed' || data.state === 'cancelled') {
              finish({ failed: data.error || 'Upload processing failed' });
            }
          } catch { /* ignore malformed event */ }
        });
        es.onerror = () => finish(null);
      });
      if (sseResult?.failed) {
        throw uploadResponseError(400, { error: sseResult.failed, applied: false });
      }
      if (sseResult?.assetId) {
        const asset = await extract({ result: { assetId: sseResult.assetId } });
        if (asset) return asset;
      }
    }

    const deadline = Date.now() + 180_000;
    let delayMs = 400;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      delayMs = Math.min(2000, Math.round(delayMs * 1.3));
      const pollRes = await fetch(`/motion-api/assets/uploads/${encodeURIComponent(uploadId)}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, ...(parentVersionId ? { parentVersionId } : {}) }),
      });
      let pollData: ConfirmUploadResponse & { error?: unknown; applied?: unknown } = {};
      try { pollData = (await pollRes.json()) as typeof pollData; } catch { /* non-JSON */ }
      if (!pollRes.ok) throw uploadResponseError(pollRes.status, pollData);
      if (pollData.state === 'failed') {
        throw uploadResponseError(400, { error: pollData.result?.error ?? 'Upload processing failed', applied: false });
      }
      const asset = await extract(pollData);
      if (asset) return asset;
    }
  }
  throw new AssetUploadError('unknown');
}

async function uploadDirectFallback(
  file: File,
  requestId: string,
  { assetId, parentVersionId, modality }: { assetId?: string; parentVersionId?: string; modality?: 'video' },
): Promise<LibraryAsset> {
  const query = new URLSearchParams({ requestId });
  if (assetId) query.set('assetId', assetId);
  if (parentVersionId) query.set('parentVersionId', parentVersionId);
  if (modality) query.set('modality', modality);
  const response = await fetch('/motion-api/assets/upload?' + query, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
  if (response.status === 413) throw uploadResponseError(413);
  const data = await response.json();
  if (!response.ok) throw uploadResponseError(response.status, data);
  if (!isValidLibraryAsset(data?.asset, modality)) throw new AssetUploadError('unknown');
  return data.asset as LibraryAsset;
}

/**
 * Cloud presigned asset upload flow:
 * 1. POST /motion-api/assets/uploads/tickets (with fallback to /motion-api/assets/uploads)
 * 2. PUT file bytes directly to the presigned S3 URL
 * 3. POST /motion-api/assets/uploads/:id/confirm to enqueue & commit via worker-media
 * Falls back gracefully to legacy direct /motion-api/assets/upload only if ticket routes return 404/405.
 */
export async function uploadLibraryAsset(
  file: File,
  { assetId, parentVersionId, modality }: { assetId?: string; parentVersionId?: string; modality?: 'video' } = {},
): Promise<LibraryAsset> {
  if (file.size > MAX_ASSET_BYTES) throw new AssetUploadError('rejected', 'size');
  if (!file.size) throw new AssetUploadError('rejected', 'unreadable');
  const requestId = crypto.randomUUID();
  const mimeType = file.type || 'application/octet-stream';
  const ticketBody = JSON.stringify({
    purpose: 'library_asset',
    filename: file.name,
    mimeType,
    sizeBytes: file.size,
    ...(modality ? { expectedModality: modality } : {}),
    ...(assetId ? { targetAssetId: assetId } : {}),
    requestId,
  });

  try {
    let ticketRes = await fetch('/motion-api/assets/uploads/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ticketBody,
    });
    if (ticketRes.status === 404 || ticketRes.status === 405) {
      ticketRes = await fetch('/motion-api/assets/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: ticketBody,
      });
    }
    if (ticketRes.status === 404 || ticketRes.status === 405) {
      return await uploadDirectFallback(file, requestId, { assetId, parentVersionId, modality });
    }
    if (ticketRes.status === 413) throw uploadResponseError(413);
    const ticketData = (await ticketRes.json()) as PresignedTicketResponse & { error?: unknown; applied?: unknown };
    if (!ticketRes.ok) throw uploadResponseError(ticketRes.status, ticketData);
    const uploadId = ticketData.uploadId ?? ticketData.ticketId;
    const uploadUrl = ticketData.uploadUrl;
    if (!uploadId || !uploadUrl) throw new AssetUploadError('unknown');

    // Upload bytes directly to S3 presigned PUT URL (omit forbidden Content-Length header in browser fetch).
    const putHeaders: Record<string, string> = {};
    const signedContentType = ticketData.headers?.['Content-Type'] ?? ticketData.headers?.['content-type'] ?? mimeType;
    if (signedContentType) putHeaders['Content-Type'] = signedContentType;
    const putRes = await fetch(uploadUrl, {
      method: ticketData.method === 'PUT' || !ticketData.method ? 'PUT' : ticketData.method,
      headers: putHeaders,
      body: file,
    });
    if (!putRes.ok) {
      if (putRes.status === 413) throw uploadResponseError(413);
      throw new AssetUploadError('unknown');
    }

    const confirmRes = await fetch(`/motion-api/assets/uploads/${encodeURIComponent(uploadId)}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: file.name,
        requestId,
        ...(parentVersionId ? { parentVersionId } : {}),
      }),
    });
    if (confirmRes.status === 413) throw uploadResponseError(413);
    const confirmData = (await confirmRes.json()) as ConfirmUploadResponse & { error?: unknown; applied?: unknown };
    if (!confirmRes.ok) throw uploadResponseError(confirmRes.status, confirmData);

    return await resolveCommittedAsset(uploadId, confirmData, requestId, parentVersionId, modality);
  } catch (error) {
    if (error instanceof AssetUploadError) throw error;
    throw new AssetUploadError('unknown');
  }
}
