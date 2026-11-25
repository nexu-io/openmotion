import { gatewayRequest } from './gatewayClient';
import type { LibraryAsset } from '../../../shared/asset-library';
import type { GenerationJob } from '../../../shared/gateway';
import { MAX_ASSET_BYTES } from '../../../shared/asset-limits';
import type { AssetChatSummary } from './assetTasks';
import { AssetUploadError, uploadResponseError } from './assetUploadError';
import { isClientCacheEnabled } from '../utils/clientCacheMode';
import {
  assetListCacheKey,
  getFreshCachedAssetList,
  invalidateAssetHistoryCache,
  invalidateAssetListCache,
  peekCachedAssetHistory,
  peekCachedAssetList,
  runCachedAssetHistory,
  runCachedAssetList,
  saveCachedAssetHistory,
  type AssetHistorySnapshot,
  type AssetListArgs,
  type AssetListResult,
} from './assetCache';

export type { AssetHistorySnapshot, AssetListArgs, AssetListResult } from './assetCache';
export {
  assetListCacheKey,
  invalidateAssetHistoryCache,
  invalidateAssetListCache,
  peekCachedAssetHistory,
  peekCachedAssetList,
  saveCachedAssetHistory,
} from './assetCache';

export async function listAssetsCached(
  args: AssetListArgs,
  options?: { force?: boolean },
): Promise<AssetListResult> {
  return runCachedAssetList(
    args,
    normalized => assetRequest<AssetListResult>({ action: 'list', ...normalized }),
    options,
  );
}

export function prefetchAssetList(args: AssetListArgs): void {
  if (!isClientCacheEnabled()) return;
  if (getFreshCachedAssetList(args)) return;
  void listAssetsCached(args).catch(() => {});
}

export function prefetchAssetHistory(): void {
  runCachedAssetHistory(async (): Promise<AssetHistorySnapshot> => {
    const [jobResult, chatResult] = await Promise.allSettled([
      assetRequest<{ jobs: GenerationJob[] }>({ action: 'jobs' }),
      gatewayRequest<{ conversations: AssetChatSummary[] }>('assets/conversations'),
    ]);
    return {
      jobs: jobResult.status === 'fulfilled' && Array.isArray(jobResult.value.jobs)
        ? jobResult.value.jobs
        : [],
      conversations: chatResult.status === 'fulfilled' && Array.isArray(chatResult.value.conversations)
        ? chatResult.value.conversations
        : [],
    };
  });
}

export async function assetRequest<T>(args: Record<string, unknown>): Promise<T> {
  const action = typeof args.action === 'string' ? args.action : '';
  const isRead = action === 'list' || action === 'get' || action === 'jobs';
  if (!isRead) {
    invalidateAssetListCache();
    invalidateAssetHistoryCache();
  }
  return gatewayRequest<T>('phase1/call', 'POST', { name: 'openmotion_assets_use', arguments: args, channel: 'gui' });
}

export async function uploadLibraryAsset(file: File, { assetId, parentVersionId, modality }: { assetId?: string; parentVersionId?: string; modality?: 'video' } = {}) {
  if (file.size > MAX_ASSET_BYTES) throw new AssetUploadError('rejected', 'size');
  if (!file.size) throw new AssetUploadError('rejected', 'unreadable');
  if (file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name)) {
    throw new AssetUploadError('rejected', 'unsupported');
  }
  const query = new URLSearchParams({ requestId: crypto.randomUUID() });
  if (assetId) query.set('assetId', assetId);
  if (parentVersionId) query.set('parentVersionId', parentVersionId);
  if (modality) query.set('modality', modality);
  try {
    const response = await fetch('/motion-api/assets/upload?' + query, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
    if (response.status === 413) throw uploadResponseError(413);
    const data = await response.json();
    if (!response.ok) throw uploadResponseError(response.status, data);
    if ((modality && data?.asset?.modality !== modality) || !data?.asset?.id || !data.asset.currentVersionId || !Array.isArray(data.asset.versions)
      || !data.asset.versions.some((version: { id?: string }) => version?.id === data.asset.currentVersionId)) throw new AssetUploadError('unknown');
    invalidateAssetListCache();
    return data.asset as LibraryAsset;
  } catch (error) {
    if (error instanceof AssetUploadError) throw error;
    throw new AssetUploadError('unknown');
  }
}
