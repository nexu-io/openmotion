import { isTextProjectPath, projectPath } from '../../shared/project-validation.ts';
import { boundedMediaBody, cmsUrl, mediaDigest } from '../../shared/repository-media.ts';
import type { RenderExportPayloadMap } from '../contracts/jobs.ts';
import type { StoragePort } from '../contracts/storage.ts';
import type { Logger } from '../infra/logger.ts';
import { catalogBlobKey, catalogCompFilmstripKey } from '../infra/storage.ts';
import { getBuiltinCompositionFilmstrip } from '../services/builtin-filmstrip-store.ts';
import {
  computeTemplateBakeHash,
  type CatalogFilmstripBakeStatePort,
} from '../services/catalog-filmstrip-autobake.ts';
import {
  computeCompositionFilmstripDepsDigest,
  extractFilmstripMeta,
  extractIndexHeadMarkup,
  isHtmlCompositionPath,
  MAX_FILMSTRIP_JPEG_BYTES,
  preloadTransitiveReferencedCodeAssets,
} from '../studio/engine/composition-filmstrip-sprite.ts';
import {
  listVirtualCompositions,
  type VirtualFileRecord,
} from '../studio/virtual-project-store.ts';
import {
  bakeVirtualCompositionsWithChromium,
  type BakeVirtualCompositionsResult,
  type CapturedFilmstripSprite,
  type CompositionCaptureOutcome,
  type VirtualPreviewServerInput,
} from './filmstrip-renderer.ts';

type BakePayload = RenderExportPayloadMap['bake_catalog_filmstrips'];
type BakePayloadFile = BakePayload['files'][number];

const MAX_HTML_PREFETCH_CONCURRENCY = 4;
const REMOTE_ASSET_FETCH_TIMEOUT_MS = 60_000;

export interface BakeCatalogFilmstripsDeps {
  readonly storage: StoragePort;
  readonly logger: Logger;
  readonly bakeState?: CatalogFilmstripBakeStatePort;
  readonly runtimeRoot?: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly tmpBaseDir?: string;
  readonly fetchImpl?: typeof fetch;
  /** Cooperative yield hook checked before launch and between compositions for user export priority. */
  readonly shouldYield?: () => Promise<boolean> | boolean;
  /** Test seam to avoid launching Chromium during deterministic unit tests. */
  readonly renderCompositionsFn?: (input: {
    readonly server: VirtualPreviewServerInput;
    readonly targetCompositions: readonly string[];
    readonly shouldYield?: () => Promise<boolean> | boolean;
  }) => Promise<BakeVirtualCompositionsResult | Map<string, CompositionCaptureOutcome>>;
}

export interface BakeCatalogFilmstripsResult {
  readonly status: 'already_baked' | 'baked' | 'yielded' | 'partial_failure' | 'failed';
  readonly templateId: string;
  readonly templateBakeHash: string;
  readonly formatVersion: number;
  readonly totalCompositions: number;
  readonly bakedCount: number;
  readonly skippedBuiltinCount: number;
  readonly skippedExistingCount: number;
  readonly failedCompositions: readonly string[];
  readonly totalBytes: number;
}

async function fetchVerifiedCatalogFileBytes(
  file: BakePayloadFile,
  storage: StoragePort,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const blobKey = catalogBlobKey(file.sha256);
  try {
    const head = await storage.headObject(blobKey);
    if (head && head.contentLength === file.sizeBytes) {
      const fromStorage = await storage.getObjectBuffer(blobKey, file.sizeBytes);
      if (fromStorage.byteLength === file.sizeBytes && mediaDigest(fromStorage) === file.sha256) {
        return fromStorage;
      }
    }
  } catch {
    // Fall through to verified Prism CDN fetch.
  }

  const verifiedUrl = cmsUrl(file.remoteUrl);
  if (new URL(verifiedUrl).pathname !== `/files/${file.sha256}`) {
    throw new Error(`Content URL does not match source digest for ${file.path}`);
  }
  const response = await fetchImpl(verifiedUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(REMOTE_ASSET_FETCH_TIMEOUT_MS),
  });
  const bytes = await boundedMediaBody(response, file.sizeBytes);
  if (bytes.byteLength !== file.sizeBytes || mediaDigest(bytes) !== file.sha256) {
    throw new Error(`Source size or SHA-256 mismatch for ${file.path}`);
  }
  return bytes;
}

async function mapBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.values();
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    for (const item of queue) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Worker-side handler for low-priority `bake_catalog_filmstrips` jobs on `worker-render`.
 *
 * Guarantees:
 * - Never re-bakes compositions already present in S3 (`catalog/filmstrips/v{N}/{fileSha}/{depsSha}/strip.jpg`)
 *   or covered by the packaged built-in filmstrip manifest.
 * - Never launches Chromium or downloads non-HTML binary assets if all target compositions already exist.
 * - Verifies every downloaded Prism asset against `cmsUrl` + exact `sizeBytes` + `sha256`.
 * - Records `baked` (7-day fast skip) on full success and `failed` (6-hour cooldown) on failure so broken
 *   templates never thrash `worker-render`.
 */
export async function processBakeCatalogFilmstripsJob(
  deps: BakeCatalogFilmstripsDeps,
  payload: BakePayload,
): Promise<BakeCatalogFilmstripsResult> {
  const startedAt = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const formatVersion = payload.formatVersion;

  const normalizedFiles = payload.files.map((f) => ({
    ...f,
    path: projectPath(f.path, true),
  }));
  const computedHash = computeTemplateBakeHash(normalizedFiles, formatVersion);
  if (computedHash !== payload.templateBakeHash) {
    const reason = `templateBakeHash mismatch (expected ${computedHash}, got ${payload.templateBakeHash})`;
    deps.logger.warn('Rejected catalog filmstrip bake job due to hash mismatch', {
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      computedHash,
    });
    await deps.bakeState?.markFailed(formatVersion, payload.templateBakeHash, reason).catch(() => {});
    return {
      status: 'failed',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: 0,
      bakedCount: 0,
      skippedBuiltinCount: 0,
      skippedExistingCount: 0,
      failedCompositions: [],
      totalBytes: 0,
    };
  }

  const now = new Date(0);
  const byPath = new Map<string, BakePayloadFile>();
  const records: VirtualFileRecord[] = normalizedFiles.map((file) => {
    byPath.set(file.path, file);
    return {
      path: file.path,
      blobScope: 'catalog',
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      isText: isTextProjectPath(file.path),
      updatedAt: now,
      metadata: null,
    };
  });

  const allCompositions = listVirtualCompositions(records);
  if (allCompositions.length === 0) {
    await deps.bakeState?.markBaked(formatVersion, payload.templateBakeHash).catch(() => {});
    return {
      status: 'already_baked',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: 0,
      bakedCount: 0,
      skippedBuiltinCount: 0,
      skippedExistingCount: 0,
      failedCompositions: [],
      totalBytes: 0,
    };
  }

  // Step 1: Load only HTML files (small text) first so we can compute exact depsSha256
  // and skip already-baked compositions via S3 HEAD without downloading media or launching Chromium.
  const assetBytesCache = new Map<string, Buffer>();
  const textContents = new Map<string, string>();
  const htmlFiles = normalizedFiles.filter((f) => isTextProjectPath(f.path) && isHtmlCompositionPath(f.path));

  try {
    await mapBounded(htmlFiles, MAX_HTML_PREFETCH_CONCURRENCY, async (file) => {
      const bytes = await fetchVerifiedCatalogFileBytes(file, deps.storage, fetchImpl);
      assetBytesCache.set(file.path, bytes);
      textContents.set(file.path, bytes.toString('utf8'));
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.logger.warn('Failed to load catalog template HTML for filmstrip baking', {
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      error: reason,
    });
    await deps.bakeState?.markFailed(formatVersion, payload.templateBakeHash, reason).catch(() => {});
    return {
      status: 'failed',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: allCompositions.length,
      bakedCount: 0,
      skippedBuiltinCount: 0,
      skippedExistingCount: 0,
      failedCompositions: [...allCompositions],
      totalBytes: 0,
    };
  }

  const indexHead = extractIndexHeadMarkup(textContents.get('index.html'));
  // When the template includes image/video assets, transitively prefetch referenced small
  // non-vendor CSS/JS before computing depsSha256 so baked S3 keys match composition-filmstrips.ts
  // identically. Any fetch error aborts the bake instead of persisting sprites under a degraded key.
  try {
    await preloadTransitiveReferencedCodeAssets({
      files: normalizedFiles,
      indexHead,
      htmlSources: textContents,
      hasLoaded: (codePath) => textContents.has(codePath),
      loadCodeText: async (codePath) => {
        const file = byPath.get(codePath);
        if (!file) return null;
        const cachedBytes = assetBytesCache.get(file.path);
        const bytes = cachedBytes ?? (await fetchVerifiedCatalogFileBytes(file, deps.storage, fetchImpl));
        assetBytesCache.set(file.path, bytes);
        const text = bytes.toString('utf8');
        textContents.set(file.path, text);
        return text;
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.logger.error('Failed to prefetch referenced catalog code assets for filmstrip baking', {
      templateId: payload.templateId,
      error: reason,
    });
    await deps.bakeState?.markFailed(formatVersion, payload.templateBakeHash, reason).catch(() => {});
    return {
      status: 'failed',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: allCompositions.length,
      bakedCount: 0,
      skippedBuiltinCount: 0,
      skippedExistingCount: 0,
      failedCompositions: [...allCompositions],
      totalBytes: 0,
    };
  }
  const targetsToBake: Array<{
    readonly compPath: string;
    readonly fileSha256: string;
    readonly depsSha256: string;
    readonly s3Key: string;
  }> = [];
  let skippedBuiltinCount = 0;
  let skippedExistingCount = 0;

  for (const compPath of allCompositions) {
    const file = byPath.get(compPath);
    if (!file) continue;
    const { depsSha256 } = computeCompositionFilmstripDepsDigest({
      compPath,
      files: records,
      indexHead,
      readText: (filePath) => textContents.get(filePath) ?? null,
    });

    const builtin = await getBuiltinCompositionFilmstrip(file.sha256, deps.runtimeRoot);
    if (builtin && builtin.depsSha256 === depsSha256) {
      skippedBuiltinCount += 1;
      continue;
    }

    const s3Key = catalogCompFilmstripKey(file.sha256, depsSha256, formatVersion);
    let head = null;
    try {
      head = await deps.storage.headObject(s3Key);
    } catch {
      head = null;
    }
    if (head && head.contentLength > 0 && head.contentLength <= MAX_FILMSTRIP_JPEG_BYTES) {
      skippedExistingCount += 1;
      continue;
    }

    targetsToBake.push({ compPath, fileSha256: file.sha256, depsSha256, s3Key });
  }

  if (targetsToBake.length === 0) {
    await deps.bakeState?.markBaked(formatVersion, payload.templateBakeHash).catch(() => {});
    deps.logger.info('Catalog template filmstrips already present in S3/builtin; skipped Chromium', {
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      totalCompositions: allCompositions.length,
      skippedBuiltinCount,
      skippedExistingCount,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: 'already_baked',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: allCompositions.length,
      bakedCount: 0,
      skippedBuiltinCount,
      skippedExistingCount,
      failedCompositions: [],
      totalBytes: 0,
    };
  }

  if (deps.shouldYield && (await deps.shouldYield())) {
    deps.logger.info('Catalog template filmstrip bake yielded before Chromium launch for user render work', {
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      remainingCompositions: targetsToBake.length,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: 'yielded',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: allCompositions.length,
      bakedCount: 0,
      skippedBuiltinCount,
      skippedExistingCount,
      failedCompositions: [],
      totalBytes: 0,
    };
  }

  // Step 2: Preload remaining small text files (CSS/JS/JSON/SVG) needed by the preview bundler,
  // while binary media assets (images, fonts, etc.) are fetched lazily on-demand only when Chromium requests them.
  const otherTextFiles = normalizedFiles.filter(
    (f) => isTextProjectPath(f.path) && !assetBytesCache.has(f.path),
  );
  try {
    await mapBounded(otherTextFiles, MAX_HTML_PREFETCH_CONCURRENCY, async (file) => {
      const bytes = await fetchVerifiedCatalogFileBytes(file, deps.storage, fetchImpl);
      assetBytesCache.set(file.path, bytes);
      textContents.set(file.path, bytes.toString('utf8'));
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.logger.warn('Failed to load catalog template text assets for filmstrip baking', {
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      error: reason,
    });
    await deps.bakeState?.markFailed(formatVersion, payload.templateBakeHash, reason).catch(() => {});
    return {
      status: 'failed',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: allCompositions.length,
      bakedCount: 0,
      skippedBuiltinCount,
      skippedExistingCount,
      failedCompositions: targetsToBake.map((t) => t.compPath),
      totalBytes: 0,
    };
  }

  const inFlightAssetLoads = new Map<string, Promise<Buffer>>();
  const resolveAsset = async (
    relPath: string,
  ): Promise<{ readonly bytes: Buffer; readonly mimeType: string } | null> => {
    let safeRel: string;
    try {
      safeRel = projectPath(relPath, true);
    } catch {
      return null;
    }
    const file = byPath.get(safeRel);
    if (!file) return null;
    const cached = assetBytesCache.get(safeRel);
    if (cached) return { bytes: cached, mimeType: file.mimeType };
    let pending = inFlightAssetLoads.get(safeRel);
    if (!pending) {
      pending = fetchVerifiedCatalogFileBytes(file, deps.storage, fetchImpl)
        .then((bytes) => {
          assetBytesCache.set(safeRel, bytes);
          return bytes;
        })
        .finally(() => {
          inFlightAssetLoads.delete(safeRel);
        });
      inFlightAssetLoads.set(safeRel, pending);
    }
    const loaded = await pending;
    return { bytes: loaded, mimeType: file.mimeType };
  };

  const serverInput: VirtualPreviewServerInput = {
    projectId: `catalog-bake-${payload.templateId}`,
    projectName: payload.templateId,
    revision: payload.catalogVersion,
    files: records,
    textContents,
    resolveAsset,
    repoRoot: deps.runtimeRoot,
  };

  let renderResults: Map<string, CompositionCaptureOutcome>;
  let yielded = false;
  try {
    const rawRender = deps.renderCompositionsFn
      ? await deps.renderCompositionsFn({
          server: serverInput,
          targetCompositions: targetsToBake.map((t) => t.compPath),
          shouldYield: deps.shouldYield,
        })
      : await bakeVirtualCompositionsWithChromium({
          server: serverInput,
          targetCompositions: targetsToBake.map((t) => t.compPath),
          sourceEnv: deps.sourceEnv,
          tmpBaseDir: deps.tmpBaseDir,
          shouldYield: deps.shouldYield,
        });
    if (rawRender instanceof Map) {
      renderResults = rawRender;
    } else {
      renderResults = rawRender.results;
      yielded = rawRender.yielded;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.logger.warn('Catalog filmstrip Chromium session failed', {
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      error: reason,
    });
    await deps.bakeState?.markFailed(formatVersion, payload.templateBakeHash, reason).catch(() => {});
    return {
      status: 'failed',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: allCompositions.length,
      bakedCount: 0,
      skippedBuiltinCount,
      skippedExistingCount,
      failedCompositions: targetsToBake.map((t) => t.compPath),
      totalBytes: 0,
    };
  }

  let bakedCount = 0;
  let totalBytes = 0;
  const failedCompositions: string[] = [];
  const failureReasons: string[] = [];
  let remainingOnYield = 0;

  for (const target of targetsToBake) {
    const outcome = renderResults.get(target.compPath);
    if (!outcome) {
      if (yielded) {
        remainingOnYield += 1;
        continue;
      }
      failedCompositions.push(target.compPath);
      failureReasons.push(`${target.compPath}: missing render result`);
      continue;
    }
    if (!outcome.ok) {
      failedCompositions.push(target.compPath);
      const errText = 'error' in outcome ? outcome.error : 'missing render result';
      failureReasons.push(`${target.compPath}: ${errText}`);
      continue;
    }
    const meta = extractFilmstripMeta(outcome.sprite.jpeg);
    if (!meta) {
      failedCompositions.push(target.compPath);
      failureReasons.push(`${target.compPath}: rendered JPEG failed OMFS1 validation`);
      continue;
    }
    try {
      await deps.storage.putBlobIfAbsent(target.s3Key, outcome.sprite.jpeg, 'image/jpeg');
      bakedCount += 1;
      totalBytes += outcome.sprite.jpeg.byteLength;
    } catch (error) {
      failedCompositions.push(target.compPath);
      failureReasons.push(
        `${target.compPath}: S3 upload failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  if (yielded && remainingOnYield > 0) {
    deps.logger.info('Catalog template filmstrip bake yielded mid-template for user render work', {
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      bakedCount,
      remainingCompositions: remainingOnYield,
      failedBeforeYield: failedCompositions.length,
      totalBytes,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: 'yielded',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: allCompositions.length,
      bakedCount,
      skippedBuiltinCount,
      skippedExistingCount,
      failedCompositions,
      totalBytes,
    };
  }

  if (failedCompositions.length === 0) {
    await deps.bakeState?.markBaked(formatVersion, payload.templateBakeHash).catch(() => {});
    deps.logger.info('Baked catalog template filmstrips into shared S3 cache', {
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      bakedCount,
      skippedBuiltinCount,
      skippedExistingCount,
      totalBytes,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: 'baked',
      templateId: payload.templateId,
      templateBakeHash: payload.templateBakeHash,
      formatVersion,
      totalCompositions: allCompositions.length,
      bakedCount,
      skippedBuiltinCount,
      skippedExistingCount,
      failedCompositions: [],
      totalBytes,
    };
  }

  const reasonSummary = failureReasons.join('; ');
  await deps.bakeState?.markFailed(formatVersion, payload.templateBakeHash, reasonSummary).catch(() => {});
  const status = bakedCount > 0 ? 'partial_failure' : 'failed';
  deps.logger.warn('Catalog template filmstrip bake completed with failures; entering cooldown', {
    templateId: payload.templateId,
    templateBakeHash: payload.templateBakeHash,
    status,
    bakedCount,
    skippedBuiltinCount,
    skippedExistingCount,
    failedCompositions,
    reason: reasonSummary,
    durationMs: Date.now() - startedAt,
  });
  return {
    status,
    templateId: payload.templateId,
    templateBakeHash: payload.templateBakeHash,
    formatVersion,
    totalCompositions: allCompositions.length,
    bakedCount,
    skippedBuiltinCount,
    skippedExistingCount,
    failedCompositions,
    totalBytes,
  };
}
