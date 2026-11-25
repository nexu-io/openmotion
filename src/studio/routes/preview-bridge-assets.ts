import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { StoragePort } from '../../contracts/storage.ts';
import { createLogger } from '../../infra/logger.ts';
import { PREVIEW_BRIDGE_ASSET_RE, PREVIEW_BRIDGE_PATH } from '../engine/preview-bridge.ts';
import { PreviewBuildBusy } from '../engine/preview-document-cache.ts';

const javascript = 'application/javascript; charset=utf-8';
const noStore = { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' };
const bridgeKey = (version: string) => 'system/preview-bridge/' + version + '.js';

export function createPreviewBridgeAssets(storage: StoragePort, script: string) {
  const routes = new Hono();
  const logger = createLogger();
  const localBytes = new TextEncoder().encode(script);
  const localVersion = createHash('sha256').update(localBytes).digest('hex');
  let publication: Promise<void> | undefined;
  let retryAt = 0;

  function ensurePublished() {
    if (Date.now() < retryAt) throw new PreviewBuildBusy();
    // A successful S3 PUT makes these exact bytes readable by other builds. Abort
    // stalled writes so each player can use its existing bounded document retries.
    publication ??= storage.putObject(
      bridgeKey(localVersion), localBytes, javascript, localBytes.length, AbortSignal.timeout(3000),
    ).catch(() => {
      publication = undefined;
      retryAt = Date.now() + 1000;
      logger.warn('Could not archive the preview bridge for other API versions', { version: localVersion });
      throw new PreviewBuildBusy();
    });
    return publication;
  }

  // Older documents used a query-based URL that some CDNs cache by pathname.
  routes.get(PREVIEW_BRIDGE_PATH, c => c.body(localBytes, 200, { ...noStore, 'Content-Type': javascript }));

  routes.get('/api/preview-bridge/:file', async c => {
    const version = PREVIEW_BRIDGE_ASSET_RE.exec(c.req.path)?.[1];
    if (!version) return c.text('Bridge version not found', 404, noStore);
    let bytes = localBytes;
    if (version !== localVersion) {
      const key = bridgeKey(version);
      try {
        if (!await storage.headObject(key)) return c.text('Bridge version not found', 404, noStore);
        const archived = await storage.getObjectBuffer(key, 1024 * 1024);
        if (createHash('sha256').update(archived).digest('hex') !== version) {
          return c.text('Bridge version unavailable', 503, noStore);
        }
        bytes = new Uint8Array(archived);
      } catch {
        return c.text('Bridge version unavailable', 503, noStore);
      }
    }
    return c.body(bytes, 200, { 'Content-Type': javascript, 'Cache-Control': 'public, max-age=31536000, immutable' });
  });
  return { routes, ensurePublished };
}
