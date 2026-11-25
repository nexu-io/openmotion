import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { applyTextPatchBytes, type TextPatch } from '../../shared/text-patch.ts';
import { CloudError } from '../contracts/errors.ts';
import type { BlobScope, StoragePort } from '../contracts/storage.ts';
import { withBlobGcRetry } from '../db/cas.ts';
import { projectTextRevisions } from '../db/schema/project-files.ts';
import type { Database, DbExecutor } from '../db/client.ts';
import { formatFileVersion } from '../studio/etag.ts';
import { MAX_TEXT_BYTES, prepareFullBaseline } from './text-snapshot-boundaries.ts';
import { catalogBlobKey, workspaceBlobKey } from './storage.ts';

export const TEXT_CHECKPOINT_INTERVAL = 32;
export const TEXT_CHECKPOINT_BYTES = 256 * 1024;
type Ref = { scope: BlobScope; id: string; sha256?: string };
type RevisionRow = {
  id: string; parent_scope: BlobScope; parent_id: string; checkpoint_sha: string | null;
  size_bytes: number; mime_type: string; chain_patch_bytes: number;
};

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = () => new CloudError('NOT_FOUND', 'Text revision not found.', { status: 404 });
const corrupt = () => new CloudError('STORAGE_ERROR', 'Text revision cannot be reconstructed.', { status: 500 });

/** Resolve the target and nearest published baseline in one database snapshot.
 * Only pointers are recursive. A backlog in the worker must not cap the chain. */
export async function planTextRevision(db: DbExecutor, workspace: string, id: string, fromVersion?: string) {
  const fromId = /^"patch:([a-f0-9]{64})"$/.exec(fromVersion ?? '')?.[1];
  const { rows } = await db.execute<RevisionRow>(sql`
    WITH RECURSIVE chain AS (
      SELECT workspace_id, project_id, id, parent_scope, parent_id, checkpoint_sha, size_bytes, mime_type, chain_patch_bytes
      FROM project_text_revisions WHERE workspace_id = ${workspace} AND id = ${id}
      UNION
      SELECT p.workspace_id, p.project_id, p.id, p.parent_scope, p.parent_id, p.checkpoint_sha, p.size_bytes, p.mime_type, p.chain_patch_bytes
      FROM chain c JOIN project_text_revisions p
        ON p.workspace_id = c.workspace_id AND p.project_id = c.project_id AND p.id = c.parent_id
      WHERE c.parent_scope = 'patch' AND c.checkpoint_sha IS NULL AND c.id <> ${fromId ?? ''}
    )
    SELECT id, parent_scope, parent_id, checkpoint_sha, size_bytes, mime_type, chain_patch_bytes FROM chain
  `);
  const byId = new Map(rows.map(row => [row.id, row]));
  const target = byId.get(id);
  if (!target) throw missing();
  const patches: PatchRef[] = [];
  let row: RevisionRow = target;
  let base: Ref;
  for (;;) {
    if (row.checkpoint_sha || row.id === fromId) {
      base = { scope: 'patch', id: row.id, ...(row.checkpoint_sha && { sha256: row.checkpoint_sha }) };
      break;
    }
    patches.push({ id: row.id, byteBound: row.chain_patch_bytes });
    if (row.parent_scope !== 'patch') {
      base = { scope: row.parent_scope, id: row.parent_id, sha256: row.parent_id };
      break;
    }
    byId.delete(row.id);
    const parent = byId.get(row.parent_id);
    if (!parent) throw corrupt();
    row = parent;
  }
  return { base, patches: patches.reverse(), sizeBytes: target.size_bytes, mimeType: target.mime_type };
}

type PatchRef = { id: string; byteBound: number };

/** The segment's cumulative byte count also bounds this patch. Small edits share a batch;
 * a large patch is read on its own so requests never accumulate many large bodies at once. */
export async function* readTextPatches(db: DbExecutor, workspace: string, patches: readonly PatchRef[]) {
  for (let i = 0; i < patches.length;) {
    const batch: string[] = [];
    let bytes = 0;
    do {
      const patch = patches[i++];
      bytes += patch.byteBound;
      batch.push(patch.id);
    } while (i < patches.length && batch.length < 16 && bytes + patches[i].byteBound <= 1024 * 1024);
    const table = projectTextRevisions;
    const rows = await db.select({ id: table.id, patch: table.patch }).from(table)
      .where(and(eq(table.workspaceId, workspace), inArray(table.id, batch)));
    const stored = new Map(rows.map(row => [row.id, row.patch]));
    for (const id of batch) {
      const patch = stored.get(id);
      if (!patch) throw corrupt();
      yield { id, patch };
    }
  }
}

/** Return a wire-sized delta for a reader which can also accept a full download. */
export async function loadTextRevisionChain(db: DbExecutor, workspace: string, id: string,
  fromVersion?: string, maxBytes = Infinity) {
  const { base, patches } = await planTextRevision(db, workspace, id, fromVersion);
  const changes: { from: string; to: string; patch: TextPatch }[] = [];
  let from = formatFileVersion(base.scope, base.id);
  let bytes = 2;
  for await (const item of readTextPatches(db, workspace, patches)) {
    const change = { from, to: formatFileVersion('patch', item.id), patch: item.patch };
    bytes += Buffer.byteLength(JSON.stringify(change)) + (changes.length ? 1 : 0);
    if (bytes >= maxBytes) return null;
    changes.push(change);
    from = change.to;
  }
  return { base, changes };
}

export class TextRevisionStorage {
  private readonly activeCheckpoints = new Map<string, Promise<string>>();
  readonly db: Database;
  readonly blobs: Pick<StoragePort, 'getObjectBuffer' | 'putBlobIfAbsent'>;
  constructor(db: Database, blobs: TextRevisionStorage['blobs']) {
    this.db = db;
    this.blobs = blobs;
  }

  async head(workspace: string, id: string) {
    const result = await this.db.execute<{size_bytes: number; mime_type: string}>(sql`
      SELECT size_bytes, mime_type FROM project_text_revisions WHERE workspace_id = ${workspace} AND id = ${id}
    `);
    return result.rows[0] ? { contentLength: result.rows[0].size_bytes, contentType: result.rows[0].mime_type } : null;
  }

  async read(workspace: string, id: string, maxBytes = MAX_TEXT_BYTES, db: DbExecutor = this.db): Promise<Buffer> {
    const { base, patches, sizeBytes } = await planTextRevision(db, workspace, id);
    if (sizeBytes > maxBytes) throw new CloudError('INVALID_ARGUMENT', 'Revision exceeds read size limit.', { status: 413 });
    const hash = base.sha256!;
    const key = base.scope === 'catalog' ? catalogBlobKey(hash) : workspaceBlobKey(workspace, hash);
    const snapshot = await this.blobs.getObjectBuffer(key, MAX_TEXT_BYTES);
    if (digest(snapshot) !== hash) throw corrupt();
    if (!isUtf8(snapshot)) throw corrupt();
    let bytes: Uint8Array = snapshot;
    for await (const { patch } of readTextPatches(db, workspace, patches)) {
      bytes = applyTextPatchBytes(bytes, patch, MAX_TEXT_BYTES);
    }
    if (bytes.byteLength !== sizeBytes) throw corrupt();
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  checkpoint(workspace: string, id: string): Promise<string> {
    const key = `${workspace}:${id}`;
    const active = this.activeCheckpoints.get(key);
    if (active) return active;
    const task = this.publishCheckpoint(workspace, id).finally(() => this.activeCheckpoints.delete(key));
    this.activeCheckpoints.set(key, task);
    return task;
  }

  private async publishCheckpoint(workspace: string, id: string): Promise<string> {
    const revision = await this.db.execute<{ project_id: string; checkpoint_sha: string | null; mime_type: string }>(sql`
      SELECT project_id, checkpoint_sha, mime_type FROM project_text_revisions WHERE workspace_id = ${workspace} AND id = ${id}
    `);
    const row = revision.rows[0];
    if (!row) throw missing();
    if (row.checkpoint_sha) return row.checkpoint_sha;
    const bytes = await this.read(workspace, id);
    const sha = digest(bytes);
    const key = workspaceBlobKey(workspace, sha);

    // The unpublished reservation makes an in-flight object visible to GC only. Readers still
    // use the parent and patch until the object and its boundary index have both been published.
    const published = await withBlobGcRetry(() => this.db.transaction(async tx => {
      const revision = await tx.execute<{checkpoint_sha: string | null}>(sql`
        SELECT checkpoint_sha FROM project_text_revisions WHERE workspace_id = ${workspace} AND id = ${id} FOR UPDATE
      `);
      if (!revision.rows[0]) throw missing();
      if (revision.rows[0].checkpoint_sha) return revision.rows[0].checkpoint_sha;
      const claimed = await tx.execute(sql`
        INSERT INTO workspace_blobs (workspace_id, sha256, s3_key, size_bytes, mime_type, ref_count, zero_ref_since)
        VALUES (${workspace}, ${sha}, ${key}, ${bytes.length}, ${row.mime_type}, 0, NULL)
        ON CONFLICT (workspace_id, sha256) DO UPDATE SET zero_ref_since = NULL WHERE workspace_blobs.gc_state = 'active'
        RETURNING sha256
      `);
      if (!claimed.rows.length) throw new CloudError('BLOB_GC_IN_PROGRESS', 'Checkpoint object is being collected.', { status: 409, applied: false });
      await tx.execute(sql`UPDATE project_text_revisions SET checkpoint_pending_sha = ${sha},
        checkpoint_due_at = COALESCE(checkpoint_due_at, now() + interval '1 minute') WHERE workspace_id = ${workspace} AND id = ${id}`);
      return null;
    }));
    if (published) return published;
    await this.blobs.putBlobIfAbsent(key, bytes, row.mime_type);
    await this.db.transaction(async tx => {
      const result = await tx.execute(sql`
        UPDATE project_text_revisions SET checkpoint_sha = ${sha}, checkpoint_pending_sha = NULL
        WHERE workspace_id = ${workspace} AND id = ${id} AND checkpoint_pending_sha = ${sha}
        RETURNING id
      `);
      if (!result.rows.length) {
        const done = await tx.execute(sql`SELECT 1 FROM project_text_revisions
          WHERE workspace_id = ${workspace} AND id = ${id} AND checkpoint_sha = ${sha}`);
        if (!done.rows.length) throw missing();
        return;
      }
      await prepareFullBaseline(tx, { workspaceId: workspace, projectId: row.project_id, scope: 'workspace', id: sha, bytes });
      await tx.execute(sql`UPDATE workspace_blobs SET zero_ref_since = now()
        WHERE workspace_id = ${workspace} AND sha256 = ${sha} AND ref_count = 0 AND zero_ref_since IS NULL`);
    });
    return sha;
  }
}
