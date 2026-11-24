import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { isSha256Hex, projectPath } from '../../shared/project-validation.ts';
import { cmsUrl } from '../../shared/repository-media.ts';
import type { RenderExportPayloadMap } from '../contracts/jobs.ts';
import type { Logger } from '../infra/logger.ts';
import { buildCatalogFilmstripJobId, type QueueService } from '../infra/queues.ts';
import { COMPOSITION_FILMSTRIP_VERSION } from '../studio/engine/composition-filmstrip-sprite.ts';
import type { PreparedCatalogTemplate } from './prism-motion-catalog.ts';

export const DEFAULT_CATALOG_FILMSTRIP_BAKED_TTL_SEC = 7 * 86_400;
export const DEFAULT_CATALOG_FILMSTRIP_QUEUED_TTL_SEC = 1_800;
export const DEFAULT_CATALOG_FILMSTRIP_FAILED_COOLDOWN_SEC = 6 * 3_600;
const MAX_LOCAL_BAKED_HASHES = 2_048;

export type CatalogFilmstripBakeStateStatus = 'baked' | 'failed' | null;

export interface CatalogFilmstripBakeStatePort {
  getState(formatVersion: number, templateBakeHash: string): Promise<CatalogFilmstripBakeStateStatus>;
  claimQueued(formatVersion: number, templateBakeHash: string, ttlSec?: number): Promise<boolean>;
  releaseQueued(formatVersion: number, templateBakeHash: string): Promise<void>;
  markBaked(formatVersion: number, templateBakeHash: string, ttlSec?: number): Promise<void>;
  markFailed(
    formatVersion: number,
    templateBakeHash: string,
    reason: string,
    ttlSec?: number,
  ): Promise<void>;
}

function assertValidVersionAndHash(formatVersion: number, templateBakeHash: string): void {
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new Error(`Invalid filmstrip format version: ${String(formatVersion)}`);
  }
  if (!isSha256Hex(templateBakeHash)) {
    throw new Error('templateBakeHash must be a 64-character lowercase hex sha256');
  }
}

export function catalogFilmstripBakedKey(formatVersion: number, templateBakeHash: string): string {
  assertValidVersionAndHash(formatVersion, templateBakeHash);
  return `om:catfilm:baked:v${formatVersion}:${templateBakeHash}`;
}

export function catalogFilmstripQueuedKey(formatVersion: number, templateBakeHash: string): string {
  assertValidVersionAndHash(formatVersion, templateBakeHash);
  return `om:catfilm:queued:v${formatVersion}:${templateBakeHash}`;
}

export function catalogFilmstripFailedKey(formatVersion: number, templateBakeHash: string): string {
  assertValidVersionAndHash(formatVersion, templateBakeHash);
  return `om:catfilm:failed:v${formatVersion}:${templateBakeHash}`;
}

/**
 * Compute a deterministic content fingerprint for an editable catalog template's source files
 * and filmstrip format version. Independent of publication IDs, card copy, sort order, or
 * covers so metadata-only Prism updates never re-trigger filmstrip baking.
 */
export function computeTemplateBakeHash(
  files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
  formatVersion: number = COMPOSITION_FILMSTRIP_VERSION,
): string {
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new Error(`Invalid filmstrip format version: ${String(formatVersion)}`);
  }
  const hash = createHash('sha256');
  hash.update(`omfs-template-bake-v${formatVersion}\n`);
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    hash.update(file.path);
    hash.update(':');
    hash.update(file.sha256);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export class RedisCatalogFilmstripBakeState implements CatalogFilmstripBakeStatePort {
  private readonly redis: Redis;
  private readonly bakedTtlSec: number;
  private readonly queuedTtlSec: number;
  private readonly failedCooldownSec: number;

  constructor(
    redis: Redis,
    options?: {
      bakedTtlSec?: number;
      queuedTtlSec?: number;
      failedCooldownSec?: number;
    },
  ) {
    this.redis = redis;
    this.bakedTtlSec = options?.bakedTtlSec ?? DEFAULT_CATALOG_FILMSTRIP_BAKED_TTL_SEC;
    this.queuedTtlSec = options?.queuedTtlSec ?? DEFAULT_CATALOG_FILMSTRIP_QUEUED_TTL_SEC;
    this.failedCooldownSec = options?.failedCooldownSec ?? DEFAULT_CATALOG_FILMSTRIP_FAILED_COOLDOWN_SEC;
  }

  async getState(formatVersion: number, templateBakeHash: string): Promise<CatalogFilmstripBakeStateStatus> {
    const [baked, failed] = await this.redis.mget(
      catalogFilmstripBakedKey(formatVersion, templateBakeHash),
      catalogFilmstripFailedKey(formatVersion, templateBakeHash),
    );
    if (baked) return 'baked';
    if (failed) return 'failed';
    return null;
  }

  async claimQueued(
    formatVersion: number,
    templateBakeHash: string,
    ttlSec = this.queuedTtlSec,
  ): Promise<boolean> {
    const res = await this.redis.set(
      catalogFilmstripQueuedKey(formatVersion, templateBakeHash),
      '1',
      'EX',
      Math.max(1, Math.floor(ttlSec)),
      'NX',
    );
    return res === 'OK';
  }

  async releaseQueued(formatVersion: number, templateBakeHash: string): Promise<void> {
    await this.redis.del(catalogFilmstripQueuedKey(formatVersion, templateBakeHash));
  }

  async markBaked(
    formatVersion: number,
    templateBakeHash: string,
    ttlSec = this.bakedTtlSec,
  ): Promise<void> {
    const bakedKey = catalogFilmstripBakedKey(formatVersion, templateBakeHash);
    const queuedKey = catalogFilmstripQueuedKey(formatVersion, templateBakeHash);
    const failedKey = catalogFilmstripFailedKey(formatVersion, templateBakeHash);
    await this.redis
      .multi()
      .set(bakedKey, '1', 'EX', Math.max(1, Math.floor(ttlSec)))
      .del(queuedKey, failedKey)
      .exec();
  }

  async markFailed(
    formatVersion: number,
    templateBakeHash: string,
    reason: string,
    ttlSec = this.failedCooldownSec,
  ): Promise<void> {
    const failedKey = catalogFilmstripFailedKey(formatVersion, templateBakeHash);
    const queuedKey = catalogFilmstripQueuedKey(formatVersion, templateBakeHash);
    const value = JSON.stringify({
      reason: reason.slice(0, 500),
      failedAt: new Date().toISOString(),
    });
    await this.redis
      .multi()
      .set(failedKey, value, 'EX', Math.max(1, Math.floor(ttlSec)))
      .del(queuedKey)
      .exec();
  }
}

export class InMemoryCatalogFilmstripBakeState implements CatalogFilmstripBakeStatePort {
  private readonly baked = new Map<string, number>();
  private readonly queued = new Map<string, number>();
  private readonly failed = new Map<string, { expiresAt: number; reason: string }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(formatVersion: number, templateBakeHash: string): string {
    assertValidVersionAndHash(formatVersion, templateBakeHash);
    return `v${formatVersion}:${templateBakeHash}`;
  }

  async getState(formatVersion: number, templateBakeHash: string): Promise<CatalogFilmstripBakeStateStatus> {
    const k = this.key(formatVersion, templateBakeHash);
    const now = this.now();
    const bakedExp = this.baked.get(k);
    if (bakedExp !== undefined) {
      if (bakedExp > now) return 'baked';
      this.baked.delete(k);
    }
    const failedEntry = this.failed.get(k);
    if (failedEntry !== undefined) {
      if (failedEntry.expiresAt > now) return 'failed';
      this.failed.delete(k);
    }
    return null;
  }

  async claimQueued(
    formatVersion: number,
    templateBakeHash: string,
    ttlSec = DEFAULT_CATALOG_FILMSTRIP_QUEUED_TTL_SEC,
  ): Promise<boolean> {
    const k = this.key(formatVersion, templateBakeHash);
    const now = this.now();
    const existing = this.queued.get(k);
    if (existing !== undefined && existing > now) return false;
    this.queued.set(k, now + ttlSec * 1000);
    return true;
  }

  async releaseQueued(formatVersion: number, templateBakeHash: string): Promise<void> {
    this.queued.delete(this.key(formatVersion, templateBakeHash));
  }

  async markBaked(
    formatVersion: number,
    templateBakeHash: string,
    ttlSec = DEFAULT_CATALOG_FILMSTRIP_BAKED_TTL_SEC,
  ): Promise<void> {
    const k = this.key(formatVersion, templateBakeHash);
    this.baked.set(k, this.now() + ttlSec * 1000);
    this.queued.delete(k);
    this.failed.delete(k);
  }

  async markFailed(
    formatVersion: number,
    templateBakeHash: string,
    reason: string,
    ttlSec = DEFAULT_CATALOG_FILMSTRIP_FAILED_COOLDOWN_SEC,
  ): Promise<void> {
    const k = this.key(formatVersion, templateBakeHash);
    this.failed.set(k, { expiresAt: this.now() + ttlSec * 1000, reason });
    this.queued.delete(k);
  }
}

export interface CatalogFilmstripScheduleSummary {
  readonly editableTemplates: number;
  readonly enqueued: number;
  readonly skippedLocal: number;
  readonly skippedBaked: number;
  readonly skippedCooldown: number;
  readonly skippedQueued: number;
  readonly enqueueErrors: number;
}

export interface CatalogFilmstripAutoBakeDispatcherDeps {
  readonly queues: Pick<QueueService, 'enqueueRenderExport'>;
  readonly state: CatalogFilmstripBakeStatePort;
  readonly logger?: Logger;
  readonly formatVersion?: number;
}

/**
 * Non-blocking API-side dispatcher invoked when Prism publishes a new catalog directory.
 * Enqueues one low-priority `bake_catalog_filmstrips` job per editable template whose
 * content-addressed `templateBakeHash` is neither already baked nor in failure cooldown
 * nor already queued by another API replica.
 */
export class CatalogFilmstripAutoBakeDispatcher {
  private readonly queues: Pick<QueueService, 'enqueueRenderExport'>;
  private readonly state: CatalogFilmstripBakeStatePort;
  private readonly logger?: Logger;
  private readonly formatVersion: number;
  private readonly localBakedHashes = new Set<string>();

  constructor(deps: CatalogFilmstripAutoBakeDispatcherDeps) {
    this.queues = deps.queues;
    this.state = deps.state;
    this.logger = deps.logger;
    this.formatVersion = deps.formatVersion ?? COMPOSITION_FILMSTRIP_VERSION;
  }

  private rememberLocalBaked(hash: string): void {
    if (this.localBakedHashes.has(hash)) return;
    if (this.localBakedHashes.size >= MAX_LOCAL_BAKED_HASHES) {
      const oldest = this.localBakedHashes.values().next().value;
      if (oldest) this.localBakedHashes.delete(oldest);
    }
    this.localBakedHashes.add(hash);
  }

  async scheduleForPublication(
    templates: readonly PreparedCatalogTemplate[],
    catalogVersion?: string,
  ): Promise<CatalogFilmstripScheduleSummary> {
    let editableTemplates = 0;
    let enqueued = 0;
    let skippedLocal = 0;
    let skippedBaked = 0;
    let skippedCooldown = 0;
    let skippedQueued = 0;
    let enqueueErrors = 0;

    for (const template of templates) {
      if (template.kind !== 'prism' || !template.hasHtmlProject) continue;
      const projectFiles = template.files
        .filter((f) => f.isProjectFile && Boolean(f.remoteUrl))
        .map((f) => {
          const normalizedPath = projectPath(f.path, true);
          return {
            path: normalizedPath,
            sha256: f.sha256,
            sizeBytes: f.sizeBytes,
            mimeType: f.mimeType,
            remoteUrl: cmsUrl(f.remoteUrl!),
          };
        });
      if (!projectFiles.some((f) => f.path === 'index.html')) continue;
      editableTemplates += 1;

      const templateBakeHash = computeTemplateBakeHash(projectFiles, this.formatVersion);
      if (this.localBakedHashes.has(templateBakeHash)) {
        skippedLocal += 1;
        continue;
      }

      let existingState: CatalogFilmstripBakeStateStatus = null;
      try {
        existingState = await this.state.getState(this.formatVersion, templateBakeHash);
      } catch (error) {
        this.logger?.warn('Catalog filmstrip bake state check failed; skipping enqueue', {
          templateId: template.id,
          templateBakeHash,
          error,
        });
        enqueueErrors += 1;
        continue;
      }

      if (existingState === 'baked') {
        this.rememberLocalBaked(templateBakeHash);
        skippedBaked += 1;
        continue;
      }
      if (existingState === 'failed') {
        skippedCooldown += 1;
        continue;
      }

      let claimed = false;
      try {
        claimed = await this.state.claimQueued(this.formatVersion, templateBakeHash);
      } catch (error) {
        this.logger?.warn('Catalog filmstrip queued claim failed; skipping enqueue', {
          templateId: template.id,
          templateBakeHash,
          error,
        });
        enqueueErrors += 1;
        continue;
      }
      if (!claimed) {
        skippedQueued += 1;
        continue;
      }

      const payload: RenderExportPayloadMap['bake_catalog_filmstrips'] = {
        templateId: template.id,
        catalogVersion: catalogVersion ?? template.catalogVersion,
        templateBakeHash,
        formatVersion: this.formatVersion,
        files: projectFiles,
      };
      const jobId = buildCatalogFilmstripJobId(this.formatVersion, templateBakeHash);
      try {
        await this.queues.enqueueRenderExport('bake_catalog_filmstrips', payload, {
          jobId,
          priority: 10,
        });
        enqueued += 1;
      } catch (error) {
        await this.state.releaseQueued(this.formatVersion, templateBakeHash).catch(() => {});
        this.logger?.warn('Failed to enqueue catalog filmstrip bake job', {
          templateId: template.id,
          templateBakeHash,
          jobId,
          error,
        });
        enqueueErrors += 1;
      }
    }

    const summary: CatalogFilmstripScheduleSummary = {
      editableTemplates,
      enqueued,
      skippedLocal,
      skippedBaked,
      skippedCooldown,
      skippedQueued,
      enqueueErrors,
    };
    if (enqueued > 0 || enqueueErrors > 0) {
      this.logger?.info('Scheduled Prism catalog filmstrip auto-bake', {
        catalogVersion: catalogVersion ?? templates[0]?.catalogVersion ?? null,
        ...summary,
      });
    }
    return summary;
  }
}
