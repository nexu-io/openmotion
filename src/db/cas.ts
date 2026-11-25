import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, sql } from 'drizzle-orm';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import { DEFAULT_BLOB_GC_GRACE_SECONDS } from '../contracts/jobs.ts';
import type { BlobMetadata } from '../contracts/storage.ts';
import { isSha256Hex, isUuid } from '../../shared/project-validation.ts';
import type { Database, DbExecutor } from './client.ts';
import { asInsert, asUpdate } from './helpers.ts';
import { workspaceBlobs } from './schema/blobs-assets.ts';

export { DEFAULT_BLOB_GC_GRACE_SECONDS };

/** Retry publication when a GC claim forces its transaction to roll back. */
export async function withBlobGcRetry<T>(publish: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await publish();
    } catch (error) {
      if (!isCloudError(error) || error.code !== 'BLOB_GC_IN_PROGRESS') throw error;
      if (attempt === 3) throw new CloudError('BLOB_GC_IN_PROGRESS', 'Storage cleanup is in progress. Retry the request.', {
        status: 503, applied: false, cause: error,
      });
      // Give the collector time to finish outside the failed transaction and its locks.
      await delay(50 * attempt);
    }
  }
}

/**
 * Frozen preview proxy metadata written by `worker-media` (`generate_preview_proxy`)
 * into `workspace_blobs.metadata.previewProxy` and read by Studio preview routes.
 */
export interface PreviewProxyMetadata {
  status: 'ready' | 'failed';
  s3Key: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  codec?: string;
  generatedAt: string;
}

export type WorkspaceBlobMetadataPatch = BlobMetadata & {
  previewProxy?: PreviewProxyMetadata;
};

export interface ReconcileBlobRefCountsResult {
  healedLive: number;
  markedUnreferenced: number;
}

export interface BlobRefDelta {
  sha256: string;
  delta: number;
  sizeBytes?: number;
  mimeType?: string;
  s3Key?: string;
  metadata?: BlobMetadata | null;
}

export interface NormalizedBlobRefDelta {
  readonly sha256: string;
  readonly delta: number;
  readonly sizeBytes?: number;
  readonly mimeType?: string;
  readonly s3Key?: string;
  readonly metadata?: BlobMetadata | null;
}

export interface ClaimedGcBlob {
  workspaceId: string;
  sha256: string;
  s3Key: string;
}

/**
 * Aggregate duplicate SHA-256 deltas and sort lexicographically ascending by `sha256`.
 * Every transaction acquires `workspace_blobs` row locks in this canonical order to prevent
 * PostgreSQL deadlocks (`40P01`) across concurrent multi-file commits and deletes.
 */
export function normalizeBlobRefDeltas(deltas: readonly BlobRefDelta[]): NormalizedBlobRefDelta[] {
  const merged = new Map<
    string,
    {
      delta: number;
      sizeBytes?: number;
      mimeType?: string;
      s3Key?: string;
      metadata?: BlobMetadata | null;
    }
  >();

  for (const item of deltas) {
    if (!isSha256Hex(item.sha256)) {
      throw new CloudError('INVALID_ARGUMENT', `Invalid CAS blob sha256 digest: ${String(item.sha256)}`, {
        status: 400,
        applied: false,
      });
    }
    if (!Number.isInteger(item.delta)) {
      throw new CloudError('INVALID_ARGUMENT', `CAS refcount delta must be an integer: ${String(item.delta)}`, {
        status: 400,
        applied: false,
      });
    }
    const existing = merged.get(item.sha256);
    if (!existing) {
      merged.set(item.sha256, {
        delta: item.delta,
        sizeBytes: item.sizeBytes,
        mimeType: item.mimeType,
        s3Key: item.s3Key,
        metadata: item.metadata ?? undefined,
      });
    } else {
      existing.delta += item.delta;
      if (item.sizeBytes !== undefined) existing.sizeBytes = item.sizeBytes;
      if (item.mimeType !== undefined) existing.mimeType = item.mimeType;
      if (item.s3Key !== undefined) existing.s3Key = item.s3Key;
      if (item.metadata !== undefined && item.metadata !== null) {
        existing.metadata = existing.metadata ? { ...existing.metadata, ...item.metadata } : { ...item.metadata };
      }
    }
  }

  return [...merged.entries()]
    .filter(([, entry]) => entry.delta !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sha256, entry]) => ({
      sha256,
      delta: entry.delta,
      sizeBytes: entry.sizeBytes,
      mimeType: entry.mimeType,
      s3Key: entry.s3Key,
      metadata: entry.metadata,
    }));
}

function assertWorkspaceId(workspaceId: string): void {
  if (!isUuid(workspaceId)) {
    throw new CloudError('INVALID_ARGUMENT', 'workspaceId must be a valid UUID', {
      status: 400,
      applied: false,
    });
  }
}

// Keep the number of PostgreSQL bind parameters bounded even for a large manifest.
const MAX_BLOB_REF_BATCH = 1000;

function workspaceBlobInsert(workspaceId: string, item: NormalizedBlobRefDelta) {
  const sizeBytes = item.sizeBytes;
  if (sizeBytes === undefined || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new CloudError(
      'INVALID_ARGUMENT',
      `Positive CAS refcount delta for ${item.sha256} requires non-negative sizeBytes`,
      { status: 400, applied: false },
    );
  }
  return asInsert(workspaceBlobs, {
    workspaceId, sha256: item.sha256, sizeBytes,
    mimeType: item.mimeType ?? 'application/octet-stream',
    s3Key: item.s3Key ?? `workspaces/${workspaceId}/blobs/${item.sha256}`,
    metadata: item.metadata ?? null, refCount: item.delta, zeroRefSince: null, gcState: 'active',
  });
}

/**
 * Apply positive and negative workspace CAS refcount deltas inside an open transaction.
 * Locks are acquired in strict lexicographical `sha256` order.
 *
 * For positive deltas, callers MUST have already uploaded the object to S3 (`workspaces/{wid}/blobs/{sha256}`).
 * If a target blob row is currently in `gc_state = 'deleting'`, throws `BLOB_GC_IN_PROGRESS` (409)
 * so the caller aborts the tx, waits briefly, re-uploads to S3, and retries.
 */
export async function applyWorkspaceBlobRefDeltas(
  tx: DbExecutor,
  workspaceId: string,
  deltas: readonly BlobRefDelta[],
): Promise<void> {
  assertWorkspaceId(workspaceId);
  const normalized = normalizeBlobRefDeltas(deltas);

  for (let i = 0; i < normalized.length; i++) {
    const item = normalized[i];
    if (item.delta > 0) {
      // Ordinary snapshots retain many existing blobs with the same increment. Keep the
      // sorted order across batches, decrements and per-blob metadata updates.
      const batch = [workspaceBlobInsert(workspaceId, item)];
      if (!item.metadata) {
        while (batch.length < MAX_BLOB_REF_BATCH) {
          const next = normalized[i + 1];
          if (!next || next.delta !== item.delta || next.metadata) break;
          batch.push(workspaceBlobInsert(workspaceId, next));
          i++;
        }
      }
      const rows = await tx
        .insert(workspaceBlobs)
        .values(batch)
        .onConflictDoUpdate({
          target: [workspaceBlobs.workspaceId, workspaceBlobs.sha256],
          set: asUpdate(workspaceBlobs, {
            refCount: sql`${workspaceBlobs.refCount} + ${item.delta}`,
            zeroRefSince: null,
            ...(item.metadata !== undefined && item.metadata !== null
              ? {
                  metadata: sql`COALESCE(${workspaceBlobs.metadata}, '{}'::jsonb) || ${JSON.stringify(item.metadata)}::jsonb`,
                }
              : {}),
          }),
          setWhere: eq(workspaceBlobs.gcState, 'active'),
        })
        .returning({ sha256: workspaceBlobs.sha256 });

      if (rows.length !== batch.length) {
        const retained = new Set(rows.map(row => row.sha256));
        const sha256 = batch.find(row => !retained.has(row.sha256))!.sha256;
        throw new CloudError(
          'BLOB_GC_IN_PROGRESS',
          `Blob ${sha256} is currently being garbage-collected; re-upload and retry.`,
          { status: 409, applied: false, details: { sha256 } },
        );
      }
    } else {
      const dec = Math.abs(item.delta);
      const rows = await tx
        .update(workspaceBlobs)
        .set(
          asUpdate(workspaceBlobs, {
            refCount: sql`${workspaceBlobs.refCount} - ${dec}`,
            zeroRefSince: sql`CASE WHEN ${workspaceBlobs.refCount} - ${dec} = 0 THEN now() ELSE NULL END`,
          }),
        )
        .where(
          and(
            eq(workspaceBlobs.workspaceId, workspaceId),
            eq(workspaceBlobs.sha256, item.sha256),
            sql`${workspaceBlobs.refCount} >= ${dec}`,
          ),
        )
        .returning({ sha256: workspaceBlobs.sha256 });

      if (rows.length === 0) {
        throw new CloudError(
          'STORAGE_ERROR',
          `CAS refcount underflow or missing workspace blob ${item.sha256}`,
          { status: 500, applied: false, details: { workspaceId, sha256: item.sha256, delta: item.delta } },
        );
      }
    }
  }
}

export async function updateWorkspaceBlobMetadata(
  tx: DbExecutor,
  workspaceId: string,
  sha256: string,
  metadata: WorkspaceBlobMetadataPatch,
): Promise<boolean> {
  assertWorkspaceId(workspaceId);
  if (!isSha256Hex(sha256)) {
    throw new CloudError('INVALID_ARGUMENT', `Invalid sha256 digest: ${sha256}`, { status: 400, applied: false });
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new CloudError('INVALID_ARGUMENT', 'Blob metadata must be a non-null JSON object', {
      status: 400,
      applied: false,
    });
  }
  const rows = await tx
    .update(workspaceBlobs)
    .set(
      asUpdate(workspaceBlobs, {
        metadata: sql`COALESCE(${workspaceBlobs.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
      }),
    )
    .where(and(eq(workspaceBlobs.workspaceId, workspaceId), eq(workspaceBlobs.sha256, sha256)))
    .returning({ sha256: workspaceBlobs.sha256 });
  return rows.length > 0;
}

/**
 * Authoritative Mark-and-Sweep self-healing reconciliation pass:
 * 1. Detects any `workspace_blobs` row whose `ref_count = 0`, `zero_ref_since IS NOT NULL`, or
 *    `gc_state = 'deleting'` despite having live references in `project_files`,
 *    `project_version_files`, or `asset_versions`; heals `ref_count` to the true live count,
 *    clears `zero_ref_since`, and restores `gc_state = 'active'`.
 * 2. Detects truly unreferenced active blobs (`NOT EXISTS` across `project_files`,
 *    `project_version_files`, `asset_versions`, and active `upload_tickets`) whose `ref_count`
 *    drifted above 0 or whose `zero_ref_since` is null, resetting `ref_count = 0` and starting
 *    their grace clock via `zero_ref_since = COALESCE(zero_ref_since, now())`.
 */
export async function reconcileDriftedBlobRefCounts(
  db: Database,
  options: { batchSize?: number } = {},
): Promise<ReconcileBlobRefCountsResult> {
  const batchSize = Math.max(1, Math.min(5000, Math.floor(options.batchSize ?? 1000)));

  const healedLiveResult = await db.execute(sql`
    WITH drifted_live AS (
      SELECT
        wb.workspace_id,
        wb.sha256,
        (
          (
            SELECT COUNT(*)::int
            FROM project_files pf
            WHERE pf.workspace_id = wb.workspace_id
              AND pf.blob_scope = 'workspace'
              AND pf.sha256 = wb.sha256
          )
          +
          (
            SELECT COUNT(*)::int
            FROM project_version_files pvf
            WHERE pvf.workspace_id = wb.workspace_id
              AND pvf.blob_scope = 'workspace'
              AND pvf.sha256 = wb.sha256
          )
          +
          (
            SELECT COUNT(*)::int
            FROM asset_versions av
            WHERE av.workspace_id = wb.workspace_id
              AND av.sha256 = wb.sha256
          )
        ) AS live_count
      FROM workspace_blobs wb
      WHERE (
        wb.ref_count = 0
        OR wb.zero_ref_since IS NOT NULL
        OR wb.gc_state = 'deleting'
      )
      AND (
        EXISTS (
          SELECT 1
          FROM project_files pf
          WHERE pf.workspace_id = wb.workspace_id
            AND pf.blob_scope = 'workspace'
            AND pf.sha256 = wb.sha256
        )
        OR EXISTS (
          SELECT 1
          FROM project_version_files pvf
          WHERE pvf.workspace_id = wb.workspace_id
            AND pvf.blob_scope = 'workspace'
            AND pvf.sha256 = wb.sha256
        )
        OR EXISTS (
          SELECT 1
          FROM asset_versions av
          WHERE av.workspace_id = wb.workspace_id
            AND av.sha256 = wb.sha256
        )
      )
      LIMIT ${batchSize}
      FOR UPDATE OF wb SKIP LOCKED
    )
    UPDATE workspace_blobs wb
    SET ref_count = d.live_count,
        zero_ref_since = NULL,
        gc_state = 'active'
    FROM drifted_live d
    WHERE wb.workspace_id = d.workspace_id
      AND wb.sha256 = d.sha256
      AND d.live_count > 0
    RETURNING wb.workspace_id AS "workspaceId", wb.sha256 AS "sha256", d.live_count AS "liveCount"
  `);

  const markedUnrefResult = await db.execute(sql`
    WITH drifted_unreferenced AS (
      SELECT wb.workspace_id, wb.sha256
      FROM workspace_blobs wb
      WHERE wb.gc_state = 'active'
        AND (wb.ref_count > 0 OR wb.zero_ref_since IS NULL)
        AND NOT EXISTS (SELECT 1 FROM project_text_revisions tr
          WHERE tr.workspace_id = wb.workspace_id AND tr.checkpoint_pending_sha = wb.sha256)
        AND NOT EXISTS (
          SELECT 1
          FROM project_files pf
          WHERE pf.workspace_id = wb.workspace_id
            AND pf.blob_scope = 'workspace'
            AND pf.sha256 = wb.sha256
        )
        AND NOT EXISTS (
          SELECT 1
          FROM project_version_files pvf
          WHERE pvf.workspace_id = wb.workspace_id
            AND pvf.blob_scope = 'workspace'
            AND pvf.sha256 = wb.sha256
        )
        AND NOT EXISTS (
          SELECT 1
          FROM asset_versions av
          WHERE av.workspace_id = wb.workspace_id
            AND av.sha256 = wb.sha256
        )
        AND NOT EXISTS (
          SELECT 1
          FROM upload_tickets ut
          WHERE ut.workspace_id = wb.workspace_id
            AND ut.expected_sha256 = wb.sha256
            AND ut.state IN ('issued', 'uploaded', 'processing')
        )
      LIMIT ${batchSize}
      FOR UPDATE OF wb SKIP LOCKED
    )
    UPDATE workspace_blobs wb
    SET ref_count = 0,
        zero_ref_since = COALESCE(wb.zero_ref_since, now())
    FROM drifted_unreferenced d
    WHERE wb.workspace_id = d.workspace_id
      AND wb.sha256 = d.sha256
    RETURNING wb.workspace_id AS "workspaceId", wb.sha256 AS "sha256"
  `);

  return {
    healedLive: (healedLiveResult.rows as Array<Record<string, unknown>>).length,
    markedUnreferenced: (markedUnrefResult.rows as Array<Record<string, unknown>>).length,
  };
}

export interface MarkUnreferencedBlobsOptions {
  graceSeconds?: number;
  gracePeriodSeconds?: number;
  batchSize: number;
}

/**
 * Authoritative Mark-and-Sweep Phase 1 of CAS GC: atomically claim up to `batchSize`
 * unreferenced blobs whose grace window (default 7 days = 604800s) has elapsed AND that
 * satisfy strict `NOT EXISTS` across ALL live reference tables (`project_files`,
 * `project_version_files`, `asset_versions`, and active `upload_tickets`).
 *
 * NEVER relies solely on `workspace_blobs.ref_count = 0` to physically delete a blob.
 */
export async function markZeroRefForDeletion(
  db: Database,
  options: MarkUnreferencedBlobsOptions,
): Promise<ClaimedGcBlob[]> {
  const rawGrace = options.graceSeconds ?? options.gracePeriodSeconds ?? DEFAULT_BLOB_GC_GRACE_SECONDS;
  const graceSeconds = Math.max(0, Math.floor(rawGrace));
  const batchSize = Math.max(1, Math.min(2000, Math.floor(options.batchSize)));

  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT wb.workspace_id, wb.sha256
      FROM workspace_blobs wb
      WHERE wb.gc_state = 'active'
        AND wb.zero_ref_since IS NOT NULL
        AND wb.zero_ref_since <= now() - make_interval(secs => ${graceSeconds})
        AND NOT EXISTS (
          SELECT 1
          FROM project_files pf
          WHERE pf.workspace_id = wb.workspace_id
            AND pf.blob_scope = 'workspace'
            AND pf.sha256 = wb.sha256
        )
        AND NOT EXISTS (
          SELECT 1
          FROM project_version_files pvf
          WHERE pvf.workspace_id = wb.workspace_id
            AND pvf.blob_scope = 'workspace'
            AND pvf.sha256 = wb.sha256
        )
        AND NOT EXISTS (
          SELECT 1
          FROM asset_versions av
          WHERE av.workspace_id = wb.workspace_id
            AND av.sha256 = wb.sha256
        )
        AND NOT EXISTS (SELECT 1 FROM project_text_revisions tr WHERE tr.workspace_id = wb.workspace_id
          AND ((tr.parent_scope = 'workspace' AND tr.parent_id = wb.sha256) OR tr.checkpoint_sha = wb.sha256 OR tr.checkpoint_pending_sha = wb.sha256))
        AND NOT EXISTS (
          SELECT 1
          FROM upload_tickets ut
          WHERE ut.workspace_id = wb.workspace_id
            AND ut.expected_sha256 = wb.sha256
            AND ut.state IN ('issued', 'uploaded', 'processing')
        )
      ORDER BY wb.zero_ref_since ASC
      LIMIT ${batchSize}
      FOR UPDATE OF wb SKIP LOCKED
    )
    UPDATE workspace_blobs wb
    SET gc_state = 'deleting',
        ref_count = 0
    FROM candidates c
    WHERE wb.workspace_id = c.workspace_id
      AND wb.sha256 = c.sha256
    RETURNING wb.workspace_id AS "workspaceId", wb.sha256 AS "sha256", wb.s3_key AS "s3Key"
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    workspaceId: String(row.workspaceId),
    sha256: String(row.sha256),
    s3Key: String(row.s3Key),
  }));
}

export const markUnreferencedBlobsForDeletion = markZeroRefForDeletion;

/**
 * Authoritative Phase 3 of CAS GC: after S3 object + thumbnail + derived cleanup succeeds,
 * delete the PG row ONLY if it is still `gc_state = 'deleting'`, `ref_count = 0`, AND still
 * satisfies strict `NOT EXISTS` across all live reference tables so a concurrent reference
 * can never be lost.
 */
export async function finalizeBlobDeletion(
  db: DbExecutor,
  workspaceId: string,
  sha256: string,
): Promise<boolean> {
  assertWorkspaceId(workspaceId);
  if (!isSha256Hex(sha256)) {
    throw new CloudError('INVALID_ARGUMENT', `Invalid sha256 digest: ${sha256}`, { status: 400, applied: false });
  }
  const result = await db.execute(sql`
    DELETE FROM workspace_blobs wb
    WHERE wb.workspace_id = ${workspaceId}
      AND wb.sha256 = ${sha256}
      AND wb.gc_state = 'deleting'
      AND wb.ref_count = 0
      AND NOT EXISTS (
        SELECT 1
        FROM project_files pf
        WHERE pf.workspace_id = wb.workspace_id
          AND pf.blob_scope = 'workspace'
          AND pf.sha256 = wb.sha256
      )
      AND NOT EXISTS (
        SELECT 1
        FROM project_version_files pvf
        WHERE pvf.workspace_id = wb.workspace_id
          AND pvf.blob_scope = 'workspace'
          AND pvf.sha256 = wb.sha256
      )
      AND NOT EXISTS (
        SELECT 1
        FROM asset_versions av
        WHERE av.workspace_id = wb.workspace_id
          AND av.sha256 = wb.sha256
      )
      AND NOT EXISTS (SELECT 1 FROM project_text_revisions tr WHERE tr.workspace_id = wb.workspace_id
          AND ((tr.parent_scope = 'workspace' AND tr.parent_id = wb.sha256) OR tr.checkpoint_sha = wb.sha256 OR tr.checkpoint_pending_sha = wb.sha256))
      AND NOT EXISTS (
        SELECT 1
        FROM upload_tickets ut
        WHERE ut.workspace_id = wb.workspace_id
          AND ut.expected_sha256 = wb.sha256
          AND ut.state IN ('issued', 'uploaded', 'processing')
      )
    RETURNING wb.sha256 AS "sha256"
  `);
  return (result.rows as Array<Record<string, unknown>>).length > 0;
}

/**
 * Recovery helper: if S3 deletion failed transiently or a blob was resurrected with `ref_count > 0`,
 * return `gc_state` back to `'active'` so the row is never stranded in `'deleting'`.
 */
export async function resurrectBlobIfReferenced(
  db: DbExecutor,
  workspaceId: string,
  sha256: string,
): Promise<boolean> {
  assertWorkspaceId(workspaceId);
  if (!isSha256Hex(sha256)) {
    throw new CloudError('INVALID_ARGUMENT', `Invalid sha256 digest: ${sha256}`, { status: 400, applied: false });
  }
  const rows = await db
    .update(workspaceBlobs)
    .set(
      asUpdate(workspaceBlobs, {
        gcState: 'active',
        zeroRefSince: sql`CASE WHEN ${workspaceBlobs.refCount} > 0 THEN NULL ELSE COALESCE(${workspaceBlobs.zeroRefSince}, now()) END`,
      }),
    )
    .where(
      and(
        eq(workspaceBlobs.workspaceId, workspaceId),
        eq(workspaceBlobs.sha256, sha256),
        eq(workspaceBlobs.gcState, 'deleting'),
      ),
    )
    .returning({ sha256: workspaceBlobs.sha256 });
  return rows.length > 0;
}
