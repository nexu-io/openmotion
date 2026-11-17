import { gatewayRequest } from './gatewayClient';
import type { LibraryAsset } from '../../../shared/asset-library';
export async function assetRequest<T>(args: Record<string, unknown>): Promise<T> {
  return gatewayRequest<T>('phase1/call', 'POST', { name: 'openmotion_assets_use', arguments: args });
}
export async function uploadLibraryAsset(file: File, assetId?: string, parentVersionId?: string) {
  const query = new URLSearchParams({ requestId: crypto.randomUUID() });
  if (assetId) query.set('assetId', assetId);
  if (parentVersionId) query.set('parentVersionId', parentVersionId);
  const response = await fetch('/motion-api/assets/upload?' + query, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Upload failed');
  return data.asset as LibraryAsset;
}
