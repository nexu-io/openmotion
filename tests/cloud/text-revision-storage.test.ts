import { randomBytes, randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createDbHandle } from '../../src/db/client.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { markZeroRefForDeletion } from '../../src/db/cas.ts';
import { TextRevisionStorage, loadTextRevisionChain, TEXT_CHECKPOINT_INTERVAL } from '../../src/infra/text-revisions.ts';
import { workspaceBlobKey } from '../../src/infra/storage.ts';
import { formatFileVersion, sha256Hex } from '../../src/studio/etag.ts';
import type { BlobScope } from '../../src/contracts/storage.ts';

const connectionString = process.env.OPENMOTION_TEST_DATABASE_URL;
it('reconstructs immutable text, skips known prefixes, pins checkpoints during GC and never mixes workspaces', {
  skip: !connectionString,
}, async () => {
  await runMigrations({ connectionString });
  const { pool, db, close } = createDbHandle({ connectionString: connectionString! });
  const workspace = randomUUID(), user = randomUUID(), session = randomUUID(), project = randomUUID();
  const objects = new Map<string, Buffer>();
  let reads = 0, writes = 0;
  const revisions = new TextRevisionStorage(db, {
    async getObjectBuffer(key) { reads++; return objects.get(key)!; },
    async putBlobIfAbsent(key, bytes) { writes++; objects.set(key, bytes); return { uploaded: true }; },
  });
  try {
    await pool.query('INSERT INTO users(id,oidc_sub,display_name) VALUES ($1,$2,$2)', [user, user]);
    await pool.query('INSERT INTO workspaces(id,slug,name,owner_user_id) VALUES ($1,$2,$2,$3)', [workspace, workspace, user]);
    await pool.query("INSERT INTO sessions(id,workspace_id,title) VALUES ($1,$2,'test')", [session, workspace]);
    await pool.query("INSERT INTO projects(id,workspace_id,session_id,title,revision) VALUES ($1,$2,$3,'test',$4)", [project, workspace, session, '0'.repeat(64)]);
    const start = Buffer.from('\uFEFFHi🚀\r\n');
    const baseline = sha256Hex(start), key = workspaceBlobKey(workspace, baseline);
    objects.set(key, start);
    await pool.query("INSERT INTO workspace_blobs(workspace_id,sha256,size_bytes,s3_key,mime_type,ref_count,zero_ref_since) VALUES ($1,$2,$3,$4,'text/html',0,now())", [workspace, baseline, start.length, key]);
    let size = start.length;
    const ids: string[] = [];
    let chainBytes = 0;
    async function append(parentScope: BlobScope, parent: string, depth: number) {
      const id = randomBytes(32).toString('hex');
      const patch = [[size, 0, '!']];
      size++;
      chainBytes = (depth === 1 ? 0 : chainBytes) + Buffer.byteLength(JSON.stringify(patch));
      await pool.query('INSERT INTO project_text_revisions(workspace_id,project_id,id,parent_scope,parent_id,size_bytes,depth,patch,chain_patch_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [workspace, project, id, parentScope, parent, size, depth, JSON.stringify(patch), chainBytes]);
      ids.push(id);
      return id;
    }
    let id = await append('workspace', baseline, 1);
    const count = 3 * TEXT_CHECKPOINT_INTERVAL + 5;
    for (let n = 2; n <= count; n++) id = await append('patch', id, (n - 1) % TEXT_CHECKPOINT_INTERVAL + 1);
    assert.equal(reads, 0);
    const chain = await loadTextRevisionChain(db, workspace, id, formatFileVersion('patch', ids.at(-3)!));
    assert.ok(chain);
    assert.equal(chain.changes.length, 2);
    assert.equal(chain.base.id, ids.at(-3));
    await assert.rejects(revisions.read(randomUUID(), id), { code: 'NOT_FOUND' });
    await assert.rejects(revisions.read(workspace, id, size - 1), { status: 413 });
    assert.equal(reads, 0);
    const expected = start.toString() + '!'.repeat(count);
    const checkpoint = sha256Hex(expected);
    const concurrent = await Promise.all([revisions.checkpoint(workspace, id), revisions.checkpoint(workspace, id)]);
    assert.deepEqual(concurrent, [checkpoint, checkpoint]);
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    const child = await append('patch', id, 1);
    const subsequent = await loadTextRevisionChain(db, workspace, child);
    assert.ok(subsequent);
    assert.deepEqual(subsequent.base, { scope: 'patch', id, sha256: checkpoint });
    assert.equal(subsequent.changes.length, 1);
    assert.equal((await revisions.read(workspace, child)).toString(), expected + '!');
    assert.equal((await revisions.read(workspace, ids[0])).toString(), start.toString() + '!');
    assert.deepEqual((await markZeroRefForDeletion(db, { graceSeconds: 0, batchSize: 100 })).filter(blob => blob.workspaceId === workspace), []);
    await pool.query('DELETE FROM projects WHERE id=$1', [project]);
    const removable = (await markZeroRefForDeletion(db, { graceSeconds: 0, batchSize: 100 })).filter(blob => blob.workspaceId === workspace);
    assert.deepEqual(removable.map(entry => entry.sha256).sort(), [baseline, checkpoint].sort());
  } finally {
    await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
    await close();
  }
});
