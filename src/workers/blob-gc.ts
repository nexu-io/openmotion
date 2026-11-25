import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  DEFAULT_BLOB_GC_GRACE_SECONDS,
  type BlobGcJobName,
  type BlobGcPayloadMap,
} from '../contracts/jobs.ts';
import type { StoragePort } from '../contracts/storage.ts';
import {
  finalizeBlobDeletion,
  markZeroRefForDeletion,
  reconcileDriftedBlobRefCounts,
  resurrectBlobIfReferenced,
  type ClaimedGcBlob,
  type MarkUnreferencedBlobsOptions,
  type ReconcileBlobRefCountsResult,
} from '../db/cas.ts';
import type { Database } from '../db/client.ts';
import { asUpdate } from '../db/helpers.ts';
import { createTextCheckpoints } from '../services/text-checkpoints.ts';
import { uploadTickets } from '../db/schema/blobs-assets.ts';
import type { Logger } from '../infra/logger.ts';
import {
  blobDerivedPrefix,
  blobThumbnailsPrefix,
  workspaceBlobKey,
} from '../infra/storage.ts';

export interface BlobGcCasOps {
  reconcileDriftedBlobRefCounts?(
    db: Database,
    options?: { batchSize?: number },
  ): Promise<ReconcileBlobRefCountsResult>;
  markZeroRefForDeletion(
    db: Database,
    options: MarkUnreferencedBlobsOptions,
  ): Promise<ClaimedGcBlob[]>;
  finalizeBlobDeletion(db: Database, workspaceId: string, sha256: string): Promise<boolean>;
  resurrectBlobIfReferenced(db: Database, workspaceId: string, sha256: string): Promise<boolean>;
}

export interface BlobGcDeps {
  readonly db: Database;
  readonly storage: Pick<StoragePort, 'deleteObject' | 'deletePrefix' | 'ensureTextCheckpoint'>;
  readonly logger: Logger;
  readonly casOps?: BlobGcCasOps;
}

export interface SweepUnreferencedBlobsResult {
  claimed: number;
  deleted: number;
  failed: number;
  thumbnailsDeleted: number;
  derivedDeleted: number;
  reconciledLive: number;
  markedUnreferenced: number;
}

export interface SweepExpiredUploadsResult {
  swept: number;
  failed: number;
}

export interface SweepExpiredReceiptsResult {
  deleted: number;
}

const DEFAULT_CAS_OPS: BlobGcCasOps = {
  reconcileDriftedBlobRefCounts,
  markZeroRefForDeletion,
  finalizeBlobDeletion,
  resurrectBlobIfReferenced,
};

/**
 * Authoritative Mark-and-Sweep CAS blob garbage collection:
 * 0. Reconcile pass: `reconcileDriftedBlobRefCounts` heals any blob whose `ref_count` drifted
 *    to 0 despite live references (`project_files`/`project_version_files`/`asset_versions`),
 *    and starts the grace clock on truly unreferenced blobs whose `ref_count` drifted > 0.
 * 1. Phase 1: `markZeroRefForDeletion` transitions eligible unreferenced rows (`gc_state = 'active'`)
 *    whose grace period (default 7 days = 604800s) elapsed AND that pass strict `NOT EXISTS` across
 *    all live reference tables into `gc_state = 'deleting'` via `FOR UPDATE OF wb SKIP LOCKED`.
 * 2. Phase 2 (no PG tx held): Deletes S3 `workspaces/{wid}/blobs/{sha256}`,
 *    `workspaces/{wid}/thumbnails/{sha256}/`, and `workspaces/{wid}/derived/{sha256}/`.
 *    On transient S3 failure, restores `gc_state = 'active'` via `resurrectBlobIfReferenced`.
 * 3. Phase 3: Calls `finalizeBlobDeletion` to delete the PG row only if still `deleting`, `ref_count = 0`,
 *    and still unreferenced across all live reference tables.
 */
export async function sweepUnreferencedBlobs(
  deps: BlobGcDeps,
  payload: BlobGcPayloadMap['sweep_unreferenced_blobs'],
): Promise<SweepUnreferencedBlobsResult> {
  const cas = deps.casOps ?? DEFAULT_CAS_OPS;
  const reconciled = cas.reconcileDriftedBlobRefCounts
    ? await cas.reconcileDriftedBlobRefCounts(deps.db, { batchSize: payload.batchSize })
    : { healedLive: 0, markedUnreferenced: 0 };

  if (reconciled.healedLive > 0 || reconciled.markedUnreferenced > 0) {
    deps.logger.warn('CAS GC reconciled drifted workspace_blobs ref_counts', {
      healedLive: reconciled.healedLive,
      markedUnreferenced: reconciled.markedUnreferenced,
    });
  }

  const graceSeconds = payload.graceSeconds ?? DEFAULT_BLOB_GC_GRACE_SECONDS;
  const claimed = await cas.markZeroRefForDeletion(deps.db, {
    graceSeconds,
    batchSize: payload.batchSize,
  });

  let deleted = 0;
  let failed = 0;
  let thumbnailsDeleted = 0;
  let derivedDeleted = 0;

  for (const blob of claimed) {
    const blobKey = workspaceBlobKey(blob.workspaceId, blob.sha256);
    const thumbPrefix = blobThumbnailsPrefix(blob.workspaceId, blob.sha256);
    const derivedPrefix = blobDerivedPrefix(blob.workspaceId, blob.sha256);

    try {
      await deps.storage.deleteObject(blobKey);
      const [thumbsCount, derivedCount] = await Promise.all([
        deps.storage.deletePrefix(thumbPrefix),
        deps.storage.deletePrefix(derivedPrefix),
      ]);
      thumbnailsDeleted += thumbsCount;
      derivedDeleted += derivedCount;

      const finalized = await cas.finalizeBlobDeletion(deps.db, blob.workspaceId, blob.sha256);
      if (finalized) {
        deleted += 1;
      } else {
        deps.logger.warn('CAS GC finalize skipped (blob no longer deleting/unreferenced)', {
          workspaceId: blob.workspaceId,
          sha256: blob.sha256,
        });
      }
    } catch (error) {
      failed += 1;
      deps.logger.error('CAS GC S3 deletion failed; reverting gc_state to active', {
        workspaceId: blob.workspaceId,
        sha256: blob.sha256,
        error,
      });
      await cas.resurrectBlobIfReferenced(deps.db, blob.workspaceId, blob.sha256).catch((resErr) => {
        deps.logger.error('Failed to resurrect CAS blob after S3 GC error', {
          workspaceId: blob.workspaceId,
          sha256: blob.sha256,
          error: resErr,
        });
      });
    }
  }

  return {
    claimed: claimed.length,
    deleted,
    failed,
    thumbnailsDeleted,
    derivedDeleted,
    reconciledLive: reconciled.healedLive,
    markedUnreferenced: reconciled.markedUnreferenced,
  };
}

export const runBlobGcSweep = sweepUnreferencedBlobs;

/**
 * Clean up abandoned upload staging objects whose tickets expired before confirmation.
 */
export async function sweepExpiredUploads(
  deps: BlobGcDeps,
  payload: BlobGcPayloadMap['sweep_expired_uploads'],
): Promise<SweepExpiredUploadsResult> {
  const now = new Date();
  const expiredTickets = await deps.db
    .select()
    .from(uploadTickets)
    .where(and(inArray(uploadTickets.state, ['issued', 'uploaded']), lte(uploadTickets.expiresAt, now)))
    .limit(payload.batchSize);

  let swept = 0;
  let failed = 0;

  for (const ticket of expiredTickets) {
    try {
      await deps.storage.deleteObject(ticket.s3StagingKey).catch(() => {});
      if (ticket.licenseS3StagingKey) {
        await deps.storage.deleteObject(ticket.licenseS3StagingKey).catch(() => {});
      }
      await deps.db
        .update(uploadTickets)
        .set(asUpdate(uploadTickets, { state: 'expired', updatedAt: new Date() }))
        .where(
          and(
            eq(uploadTickets.id, ticket.id),
            eq(uploadTickets.workspaceId, ticket.workspaceId),
            inArray(uploadTickets.state, ['issued', 'uploaded']),
          ),
        );
      swept += 1;
    } catch (error) {
      failed += 1;
      deps.logger.error('Failed to sweep expired upload ticket', {
        workspaceId: ticket.workspaceId,
        uploadId: ticket.id,
        error,
      });
    }
  }

  return { swept, failed };
}

/** Delete expired `idempotency_receipts` rows in bounded batches. */
export async function sweepExpiredReceipts(
  deps: BlobGcDeps,
  payload: BlobGcPayloadMap['sweep_expired_receipts'],
): Promise<SweepExpiredReceiptsResult> {
  const batchSize = Math.max(1, Math.min(5000, Math.floor(payload.batchSize)));
  const result = await deps.db.execute(sql`
    WITH doomed AS (
      SELECT ctid
      FROM idempotency_receipts
      WHERE expires_at <= now()
      LIMIT ${batchSize}
    )
    DELETE FROM idempotency_receipts r
    USING doomed d
    WHERE r.ctid = d.ctid
    RETURNING 1
  `);
  return { deleted: result.rows.length };
}

export async function processBlobGcJob<K extends BlobGcJobName>(
  deps: BlobGcDeps,
  name: K,
  payload: BlobGcPayloadMap[K],
): Promise<SweepUnreferencedBlobsResult | SweepExpiredUploadsResult | SweepExpiredReceiptsResult | { completed: number; failed: number }> {
  if (name === 'create_text_checkpoints') {
    return createTextCheckpoints(deps, payload as BlobGcPayloadMap['create_text_checkpoints']);
  }
  if (name === 'sweep_unreferenced_blobs') {
    return sweepUnreferencedBlobs(deps, payload as BlobGcPayloadMap['sweep_unreferenced_blobs']);
  }
  if (name === 'sweep_expired_uploads') {
    return sweepExpiredUploads(deps, payload as BlobGcPayloadMap['sweep_expired_uploads']);
  }
  if (name === 'sweep_expired_receipts') {
    return sweepExpiredReceipts(deps, payload as BlobGcPayloadMap['sweep_expired_receipts']);
  }
  throw new Error(`Unknown blob-gc job: ${String(name)}`);
}
