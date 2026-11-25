import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../db/client.ts';
import type { StoragePort } from '../contracts/storage.ts';
import type { Logger } from '../infra/logger.ts';

/** Ask the maintenance worker for physical bytes without waiting for a checkpoint already in progress. */
export async function requestTextCheckpoint(db: DbExecutor, workspaceId: string, revisionId: string): Promise<void> {
  await db.execute(sql`
    WITH available AS (
      SELECT workspace_id, id FROM project_text_revisions
      WHERE workspace_id = ${workspaceId} AND id = ${revisionId} AND checkpoint_sha IS NULL AND checkpoint_due_at IS NULL
      FOR UPDATE SKIP LOCKED
    )
    UPDATE project_text_revisions r SET checkpoint_due_at = now()
    FROM available a WHERE r.workspace_id = a.workspace_id AND r.id = a.id
  `);
}

/** Claim one due revision at a time. A stopped worker leaves a retryable row in Postgres. */
export async function createTextCheckpoints(deps: {
  db: DbExecutor; storage: Pick<StoragePort, 'ensureTextCheckpoint'>; logger: Logger;
}, { batchSize }: { batchSize: number }) {
  if (!deps.storage.ensureTextCheckpoint) throw new Error('Text revision storage unavailable');
  let completed = 0, failed = 0;
  for (let i = 0; i < batchSize; i++) {
    const { rows: [row] } = await deps.db.execute<{ workspace_id: string; id: string }>(sql`
      WITH candidate AS (
        SELECT workspace_id, id FROM project_text_revisions
        WHERE checkpoint_sha IS NULL AND checkpoint_due_at <= now()
        ORDER BY checkpoint_due_at LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE project_text_revisions r SET checkpoint_due_at = now() + interval '1 minute'
      FROM candidate c WHERE r.workspace_id = c.workspace_id AND r.id = c.id
      RETURNING r.workspace_id, r.id
    `);
    if (!row) break;
    try {
      await deps.storage.ensureTextCheckpoint(row.workspace_id, row.id);
      completed++;
    } catch (error) {
      failed++;
      deps.logger.error('Text revision checkpoint will retry', { workspaceId: row.workspace_id, revision: row.id, error });
    }
  }
  return { completed, failed };
}
