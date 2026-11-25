import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { AuthContext } from '../../src/contracts/auth.ts';
import type { ProjectEvent } from '../../src/contracts/events.ts';
import { isCloudError } from '../../src/contracts/errors.ts';
import { applyWorkspaceBlobRefDeltas, finalizeBlobDeletion, markZeroRefForDeletion, type BlobRefDelta } from '../../src/db/cas.ts';
import * as schema from '../../src/db/schema/index.ts';
import { createDbHandle } from '../../src/db/client.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { TextRevisionStorage } from '../../src/infra/text-revisions.ts';
import { StorageService, archiveKey, workspaceBlobKey } from '../../src/infra/storage.ts';
import { createTextCheckpoints, requestTextCheckpoint } from '../../src/services/text-checkpoints.ts';
import { createLogger } from '../../src/infra/logger.ts';
import { ProjectArchiveService } from '../../src/services/project-archive-service.ts';
import { ProjectFilesService } from '../../src/services/project-files-service.ts';
import { VersionHistoryService } from '../../src/services/version-history-service.ts';
import { WorkspaceService } from '../../src/services/workspace-service.ts';
import { bundlePreviewInMemory } from '../../src/studio/engine/preview-bundler.ts';
import { formatFileVersion, sha256Hex } from '../../src/studio/etag.ts';
import { hydrateSnapshotFilesToDir } from '../../src/workers/render-export.ts';
import { readProjectZip } from '../../shared/project-zip.ts';
import { applyTextPatch, TEXT_PATCH_BASE_HEADER } from '../../shared/text-patch.ts';
import { readMcpProjectFile, type ProjectFileQuery } from '../../src/mcp/project-file-read.ts';
import { AssetNamesService } from '../../src/services/asset-names-service.ts';
import { createStudioFilesRoutes } from '../../src/studio/routes/files.ts';
import { createStudioGsapRoutes } from '../../src/studio/routes/gsap.ts';
import { createStudioProjectsRoutes } from '../../src/studio/routes/projects.ts';
import { createStudioPreviewRoutes } from '../../src/studio/routes/preview.ts';
import { createStudioMediaRoutes } from '../../src/studio/routes/media.ts';

// Only the object bucket is replaced. Logical references still use the production storage adapter,
// database, manifest, authoring services, signing, archive writer and renderer hydration.
class LocalBucket extends StorageService {
  readonly objects = new Map<string, Buffer>();
  reads = 0;
  writes = 0;
  override async putBlobIfAbsent(key: string, data: Buffer) {
    this.writes++;
    const uploaded = !this.objects.has(key);
    this.objects.set(key, Buffer.from(data));
    return { uploaded };
  }
  override async getObjectBuffer(key: string, limit?: number) {
    const bytes = this.objects.get(key);
    if (!bytes) return super.getObjectBuffer(key, limit);
    this.reads++;
    return bytes;
  }
  override async putObject(key: string, data: Buffer) {
    this.objects.set(key, Buffer.from(data));
  }
}

const connectionString = process.env.OPENMOTION_TEST_DATABASE_URL;
async function fixture() {
  await runMigrations({ connectionString });
  const { db, pool, close } = createDbHandle({ connectionString: connectionString! });
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const auth: AuthContext = { workspaceId, userId, role: 'owner', authMode: 'dev', authMethod: 'dev_bypass', scopes: ['workspace:admin'] };
  const storage = new LocalBucket({ textRevisionDb: db, bucket: 'test', region: 'us-east-1', endpoint: 'http://localhost:9901',
    accessKeyId: 'fixture', secretAccessKey: 'fixture' });
  const events: ProjectEvent[] = [];
  const eventBus = { async publish(_channel: string, event: unknown) { events.push(event as ProjectEvent); return 1; } };
  const files = new ProjectFilesService({ db, storage, historyCoalesceWindowMs: 0, textPatchWrites: true,
    eventBus,
  });
  const workspace = new WorkspaceService({ db, storage, files });
  const archive = new ProjectArchiveService({ db, storage, files, workspace });
  const history = new VersionHistoryService({ db, storage, historyCoalesceWindowMs: 0, eventBus });
  await pool.query('INSERT INTO users(id,oidc_sub,display_name) VALUES ($1,$2,$2)', [userId, userId]);
  await pool.query('INSERT INTO workspaces(id,slug,name,owner_user_id) VALUES ($1,$2,$2,$3)', [workspaceId, workspaceId, userId]);
  return { db, pool, events, storage, auth, workspaceId, files, workspace, archive, history,
    async cleanup() {
      await pool.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
      await close();
    },
  };
}

it('commits missing dependencies and the host patch as one collaborative catalog placement', { skip: !connectionString }, async t => {
  const { events, auth, workspace, files, history, cleanup } = await fixture();
  try {
    const host = 'intro.html', child = 'compositions/components/blur-in.html';
    const original = '<main><h1>Hello</h1></main>', insert = '<div data-composition-src="' + child + '"></div>';
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path: host, content: original }] });
    const read = (path: string) => files.readTextFile(auth, projectId, path);
    const before = (await read(host))!;
    t.mock.method(globalThis, 'fetch', async () => new Response('<div>Blur</div>'));
    events.length = 0;
    const input = { installComponent: 'blur-in', files: [{ path: host, baseVersion: before.version,
      patch: [[before.content.indexOf('</main>'), 0, insert]] }] };
    const receipt = await files.commitTextEdits(auth, projectId, input, { source: 'studio', requestId: randomUUID() });
    assert.match(receipt.versionsByPath[host], /^"patch:/);
    assert.deepEqual(events.flatMap(event => 'paths' in event ? event.paths ?? [] : []).sort(), [child, host].sort());
    assert.equal(events.filter(event => event.type === 'history-changed').length, 1);
    assert.equal((await read(host))?.content, before.content.replace('</main>', insert + '</main>'));
    assert.match((await read(child))!.content, /Blur/);
    await history.step(auth, projectId, 'back');
    assert.equal((await read(host))?.version, before.version);
    assert.equal(await read(child), null);
    await history.step(auth, projectId, 'forward');
    assert.equal((await read(host))?.version, receipt.versionsByPath[host]);
    assert.equal((await read(child))?.version, receipt.versionsByPath[child]);
  } finally { await cleanup(); }
});

it('accepts large localized patches from an upgraded editor during a rolling deployment', { skip: !connectionString }, async () => {
  const { auth, workspace, files, cleanup } = await fixture();
  try {
    const path = 'large.html';
    const original = 'a'.repeat(1024 * 1024);
    const inserted = '中\n\\'.repeat(60 * 1024);
    assert.equal(Buffer.byteLength(inserted), 300 * 1024);
    const escapedPath = 'escaped.txt';
    const prefix = 'a'.repeat(300 * 1024);
    const retained = '\u0001'.repeat(8);
    const { projectId } = await workspace.createProject(auth, { initialFiles: [
      { path, content: original }, { path: escapedPath, content: prefix + retained },
    ] });
    const base = (await files.readTextFile(auth, projectId, path))!;
    const saved = await files.commitTextEdits(auth, projectId, { files: [
      { path, baseVersion: base.version, patch: [[0, Buffer.byteLength(inserted), inserted]] },
    ] }, { source: 'studio', requestId: randomUUID() });
    const current = (await files.readTextFile(auth, projectId, path))!;
    assert.equal(current.version, saved.versionsByPath[path]);
    assert.equal(current.content, inserted + original.slice(Buffer.byteLength(inserted)));

    const requestId = randomUUID();
    const size = Buffer.byteLength(current.content);
    await assert.rejects(files.commitTextEdits(auth, projectId, { files: [
      { path, baseVersion: current.version, patch: [[0, size / 2, inserted], [size / 2, size / 2, inserted]] },
    ] }, { source: 'studio', requestId }), /Send content/);
    assert.equal((await files.readTextFile(auth, projectId, path))!.version, current.version);
    const full = await files.commitTextEdits(auth, projectId, { files: [
      { path, baseVersion: current.version, content: inserted + inserted },
    ] }, { source: 'studio', requestId });
    assert.match(full.versionsByPath[path], /^"sha256:/);
    assert.equal((await files.readTextFile(auth, projectId, path))!.content, inserted + inserted);

    // The patch is bigger than the raw result but smaller than its escaped wire representation.
    const escapedBase = (await files.readTextFile(auth, projectId, escapedPath))!;
    const patch = [[0, prefix.length, inserted]] as const;
    assert.ok(Buffer.byteLength(JSON.stringify({ patch })) > Buffer.byteLength(inserted + retained));
    assert.ok(Buffer.byteLength(JSON.stringify({ patch })) < Buffer.byteLength(JSON.stringify({ content: inserted + retained })));
    await files.commitTextEdits(auth, projectId, { files: [{ path: escapedPath, baseVersion: escapedBase.version, patch }] },
      { source: 'studio', requestId: randomUUID() });
    assert.equal((await files.readTextFile(auth, projectId, escapedPath))!.content, inserted + retained);
  } finally { await cleanup(); }
});

it('publishes one exact file version and one history change for a patch, undo, redo and deletion', { skip: !connectionString }, async () => {
  const { events, auth, workspace, files, history, cleanup } = await fixture();
  try {
    const path = 'intro.html';
    const content = '<h1>Hello</h1>' + ' '.repeat(512);
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, content }] });
    const initial = (await files.readTextFile(auth, projectId, path))!.version;
    events.length = 0;
    async function expectDelivery(version: string | null, deleted = false) {
      assert.equal(events.length, 2);
      const [change, navigation] = events.splice(0);
      assert.equal(change?.type, 'file-change');
      assert.deepEqual(change.paths, [path]);
      assert.deepEqual(change.fileVersions, { [path]: version });
      if (deleted) assert.equal(change.version, '"deleted"');
      assert.equal(navigation?.type, 'history-changed');
      assert.equal(navigation.revision, change.revision);
      assert.equal(navigation.versionId, change.versionId);
      assert.equal((await files.readTextFile(auth, projectId, path))?.version ?? null, version);
    }
    const saved = await files.commitTextEdits(auth, projectId, { files: [{ path, baseVersion: initial, patch: [[4, 5, 'World']] }] },
      { source: 'studio', requestId: randomUUID() });
    const patch = saved.versionsByPath[path];
    assert.match(patch, /^"patch:/);
    await expectDelivery(patch);
    await history.step(auth, projectId, 'back');
    await expectDelivery(initial);
    await history.step(auth, projectId, 'forward');
    await expectDelivery(patch);
    await files.commitChanges(auth, { projectId, ops: [{ op: 'delete', path }], source: 'agent', origin: 'mcp' });
    await expectDelivery(null, true);
    await history.step(auth, projectId, 'back');
    await expectDelivery(patch);
  } finally { await cleanup(); }
});

it('opens a project and reads its compiled preview and byte ranges while its checkpoint row is locked', {
  skip: !connectionString, timeout: 15_000,
}, async t => {
  const { db, pool, storage, auth, workspaceId, files, workspace, history, cleanup } = await fixture();
  const locker = await pool.connect();
  try {
    const initial = '<!doctype html><main data-composition-id="root"><h1>暖冬</h1></main>';
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path: 'index.html', content: initial }] });
    const head = (await files.readTextFile(auth, projectId, 'index.html'))!;
    const offset = Buffer.byteLength(initial.slice(0, initial.indexOf('暖冬')));
    const expected = Buffer.from(initial.replace('暖冬', '新🎄'));
    const result = await files.commitTextEdits(auth, projectId, { files: [
      { path: head.file.path, baseVersion: head.version, patch: [[offset, 6, '新🎄']] },
    ] }, { requestId: randomUUID(), source: 'studio' });
    const version = result.versionsByPath['index.html'];
    const id = version.slice(7, -1);
    await locker.query('BEGIN');
    const locked = await locker.query('SELECT checkpoint_sha FROM project_text_revisions WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, id]);
    assert.deepEqual(locked.rows, [{ checkpoint_sha: null }]);
    t.mock.method(storage, 'ensureTextCheckpoint', async () => { throw new Error('reader attempted a checkpoint'); });
    storage.writes = 0;
    const deps = { db, files, storage, workspace, history, assetNames: new AssetNamesService({ db, files }), resolveAuth: () => auth, skipDeterministicFonts: true };
    const prefix = `/api/projects/${projectId}`;
    assert.equal((await createStudioProjectsRoutes(deps).request(prefix)).status, 200);
    const preview = createStudioPreviewRoutes(deps);
    const doc = await preview.request(prefix + '/preview');
    assert.equal(doc.status, 200);
    assert.match(await doc.text(), /新🎄/);
    const metadata = await createStudioMediaRoutes(deps).request(prefix + '/media/metadata?path=index.html');
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).pending, false);
    const raw = prefix + '/preview/index.html';
    for (const [range, start, end] of [
      [`bytes=${offset + 1}-${offset + 3}`, offset + 1, offset + 4], // Includes partial UTF-8 characters.
      ['bytes=-4', expected.length - 4, expected.length],
      ['bytes=3-', 3, expected.length], ['bytes=0-9999999999', 0, expected.length],
    ] as const) {
      const part = await preview.request(raw, { headers: { Range: range, 'If-Range': version } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('etag'), version);
      assert.equal(part.headers.get('content-range'), `bytes ${start}-${end - 1}/${expected.length}`);
      assert.equal(Number(part.headers.get('content-length')), end - start);
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), expected.subarray(start, end));
    }
    const reads = storage.reads;
    const outOfBounds = await preview.request(raw, { headers: { Range: 'bytes=9999-' } });
    assert.equal(outOfBounds.status, 416);
    assert.equal(outOfBounds.headers.get('content-range'), `bytes */${expected.length}`);
    assert.equal((await preview.request(raw, { method: 'HEAD' })).status, 200);
    assert.equal((await preview.request(raw, { headers: { 'If-None-Match': version } })).status, 304);
    assert.equal(storage.reads, reads);
    const full = await preview.request(raw, { headers: { Range: 'bytes=0-1', 'If-Range': head.version } });
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), expected);
    assert.equal(storage.writes, 0);
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
    await cleanup();
  }
});

it('returns pending for an edited text image while only the background checkpoint worker can prepare its media input', { skip: !connectionString }, async () => {
  const { db, pool, storage, auth, workspaceId, files, workspace, history, cleanup } = await fixture();
  const locker = await pool.connect();
  try {
    // Portable graymap is a real image format with an editable ASCII representation.
    const path = 'assets/gray.pgm', content = 'P2\n1 1\n255\n128\n';
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, mimeType: 'image/x-portable-graymap', content }] });
    const original = (await files.readTextFile(auth, projectId, path))!;
    const revision = await files.commitTextEdits(auth, projectId, { files: [{ path, baseVersion: original.version,
      patch: [[content.indexOf('128'), 3, '255']] }] }, { requestId: randomUUID(), source: 'studio' });
    const version = revision.versionsByPath[path], id = version.slice(7, -1);
    const app = createStudioMediaRoutes({ db, files, storage, workspace, history, assetNames: new AssetNamesService({ db, files }), resolveAuth: () => auth });
    const prefix = `/api/projects/${projectId}`;
    const meta = () => app.request(prefix + '/media/metadata?path=' + path);
    const checkpoint = async () => (await pool.query('SELECT checkpoint_sha,checkpoint_due_at FROM project_text_revisions WHERE workspace_id=$1 AND id=$2', [workspaceId, id])).rows[0];
    storage.writes = 0;
    assert.equal((await app.request(prefix + '/image-thumbnail/' + path + '?cached=1')).status, 204);
    assert.equal((await app.request(prefix + '/image-thumbnail/' + path, { method: 'HEAD' })).status, 404);
    assert.deepEqual(await checkpoint(), { checkpoint_sha: null, checkpoint_due_at: null });
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM project_text_revisions WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, id]);
    const pending = await meta();
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { pending: true, path, sha256: null, version });
    await locker.query('ROLLBACK');
    assert.equal((await meta()).status, 202);
    const requested = await checkpoint();
    assert.equal(requested.checkpoint_sha, null);
    assert.ok(requested.checkpoint_due_at);
    assert.equal(storage.writes, 0);
    const digest = await storage.ensureTextCheckpoint(workspaceId, id);
    const readyToProbe = await meta();
    assert.equal(readyToProbe.status, 202);
    assert.equal((await readyToProbe.json()).sha256, digest);
    assert.equal(storage.writes, 1);
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
    await cleanup();
  }
});

it('reads the same saved patch in preview, history, render, download, ZIP and an independent project copy', {
  skip: !connectionString,
}, async () => {
  const { db, pool, storage, auth, workspaceId, files, workspace, archive, history, cleanup } = await fixture();
  const dir = await mkdtemp(path.join(tmpdir(), 'om-patch-readers-'));
  try {
    const initial = '<!DOCTYPE html><html><body><h1>暖冬片头</h1>' + ' '.repeat(600) + '</body></html>';
    const source = await workspace.createProject(auth, { title: 'Test readers', initialFiles: [{ path: 'index.html', content: initial }] });
    const indexRows = await pool.query('SELECT block_index FROM project_text_boundary_blocks WHERE project_id=$1 AND snapshot_sha=$2',
      [source.projectId, sha256Hex(initial)]);
    assert.equal(indexRows.rowCount, 1);
    const before = (await files.readTextFile(auth, source.projectId, 'index.html'))!;
    const offset = Buffer.byteLength(initial.slice(0, initial.indexOf('暖冬')));
    const expected = initial.replace('暖冬', '🎄圣诞');
    const { versionId, revision, versionsByPath } = await files.commitTextEdits(auth, source.projectId, {
      files: [{ path: 'index.html', baseVersion: before.version, patch: [[offset, Buffer.byteLength('暖冬'), '🎄圣诞']] }],
    }, { requestId: randomUUID(), source: 'studio' });
    const token = versionsByPath['index.html'];
    assert.match(token, /^"patch:[0-9a-f]{64}"$/);
    assert.notEqual(token.slice(7, -1), sha256Hex(expected));
    const virtual = await files.loadVirtualProject(auth, source.projectId);
    assert.equal(virtual.readText('index.html'), expected);
    assert.equal(virtual.getFileVersion('index.html'), token);
    assert.match((await bundlePreviewInMemory(virtual, { skipDeterministicFonts: true }))!, /🎄圣诞片头/);
    await hydrateSnapshotFilesToDir({ storage, workspaceId, files: virtual.listFiles(), projectDir: dir, compositionPath: 'index.html' });
    assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), expected);
    assert.equal(storage.objects.has(workspaceBlobKey(workspaceId, sha256Hex(expected))), false);

    const zip = await archive.exportProjects(auth, { projectIds: [source.projectId], expectedRevisions: { [source.projectId]: revision }, requestId: randomUUID() });
    const exported = zip.projects[0];
    assert.equal(exported.revision, revision);
    const zipContent = readProjectZip(storage.objects.get(archiveKey(workspaceId, zip.archiveId))!).get(`${exported.folder}/index.html`)!.toString();
    assert.equal(zipContent, expected);

    const point = await workspace.getProject(auth, source.projectId);
    const undoEntries = await history.listHistory(auth, source.projectId);
    const mcpFile = (query: Omit<ProjectFileQuery, 'path'>) => readMcpProjectFile(
      { db, storage, files, expiresInSec: 60 }, auth, source.projectId, { ...query, path: 'index.html', atProjectVersion: versionId! });
    const text = await mcpFile({ mode: 'read' });
    assert.equal(text.fileVersion, token);
    assert.ok('content' in text && text.content === zipContent);
    const delta = await mcpFile({ mode: 'sync', fromFileVersion: before.version });
    assert.ok('patches' in delta && !('baseline' in delta));
    assert.equal(delta.patches.length, 1);
    assert.equal(delta.patches[0].from, before.version);
    assert.equal(delta.patches[0].to, token);
    assert.equal(applyTextPatch(initial, delta.patches[0].patch), zipContent);
    const fresh = await mcpFile({ mode: 'sync' });
    assert.ok('baseline' in fresh && fresh.baseline);
    assert.equal(fresh.baseline.fileVersion, before.version);
    assert.deepEqual(fresh.patches, delta.patches);

    const indexFile = (await files.getFile(auth, source.projectId, 'index.html'))!;
    const signed = await files.presignResolvedFileGet(auth.workspaceId, indexFile);
    const cas = workspaceBlobKey(workspaceId, sha256Hex(expected));
    assert.ok(new URL(signed.url).pathname.endsWith('/' + cas));
    assert.equal(signed.etag, token);
    assert.equal(storage.objects.get(cas)?.toString(), expected);
    const link = await mcpFile({ mode: 'download', atFileVersion: token });
    assert.ok('downloadUrl' in link && new URL(link.downloadUrl).pathname.endsWith('/' + cas));
    assert.equal(link.fileVersion, token);
    const partial = await mcpFile({ mode: 'read', length: 5 });
    assert.ok('nextOffset' in partial);
    await mcpFile({ mode: 'read', offset: partial.nextOffset, atFileVersion: token });
    assert.deepEqual(await workspace.getProject(auth, source.projectId), point);
    assert.deepEqual(await history.listHistory(auth, source.projectId), undoEntries);
    await history.step(auth, source.projectId, 'back');
    assert.equal((await files.readTextFile(auth, source.projectId, 'index.html'))?.content, initial);
    const historical = (await history.peekPoint(auth, source.projectId, versionId!, 'index.html')).file!;
    assert.equal(historical.content, expected);
    assert.equal(historical.version, token);
    assert.equal(historical.sha256, sha256Hex(expected));
    for (const id of [historical.blobId, historical.sha256]) {
      assert.equal((await history.readHistoryBlob(auth, source.projectId, id)).buffer.toString(), expected);
    }
    await history.step(auth, source.projectId, 'forward');
    assert.equal((await files.readTextFile(auth, source.projectId, 'index.html'))?.version, token);
    const copy = await archive.duplicateProject(auth, source.projectId);
    await pool.query('DELETE FROM projects WHERE id=$1', [source.projectId]);
    assert.equal((await files.readTextFile(auth, copy.projectId, 'index.html'))?.content, expected);
    assert.equal((await files.getFile(auth, copy.projectId, 'index.html'))?.blobScope, 'workspace');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanup();
  }
});

it('checks GSAP ETags before fetching either a full blob or a patch, and parses the authorized version on a miss', {
  skip: !connectionString,
}, async () => {
  const { db, auth, storage, files, workspace, history, cleanup } = await fixture();
  try {
    const path = 'scene.html';
    const content = '<html><script>const tl = gsap.timeline(); tl.to("#first", { opacity: 1, duration: 1 }, 0);</script></html>';
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, content }] });
    const app = createStudioGsapRoutes({
      db, files, storage, workspace, history, assetNames: new AssetNamesService({ db, files }), resolveAuth: () => auth,
    });
    const read = (etag?: string) => app.request(`/api/projects/${projectId}/gsap-animations/${path}`,
      { headers: etag ? { 'If-None-Match': etag } : {} });
    const getFile = files.getFile.bind(files);
    const base = `"sha256:${sha256Hex(content)}"`;
    let metaReads = 0;
    let committedVersion: string | undefined;
    let saveAfterLookup = false;
    files.getFile = async (...args) => {
      metaReads++;
      const ref = await getFile(...args);
      if (saveAfterLookup) {
        saveAfterLookup = false;
        const saved = await files.commitTextEdits(auth, projectId, { files: [
          { path, baseVersion: base, patch: [[content.indexOf('#first'), 6, '#second']] },
        ] }, { source: 'studio', requestId: randomUUID() });
        committedVersion = saved.versionsByPath[path];
      }
      return ref;
    };

    const first = await read();
    const baseEtag = first.headers.get('etag')!;
    assert.equal((await first.json()).version, base);
    storage.reads = 0;
    assert.equal((await read(baseEtag)).status, 304);
    assert.equal(storage.reads, 0);

    saveAfterLookup = true;
    metaReads = 0;
    const captured = await read();
    const older = await captured.json();
    assert.equal(metaReads, 1);
    assert.equal(storage.reads, 1);
    assert.equal(captured.headers.get('etag'), baseEtag);
    assert.equal(older.version, base);
    assert.equal(older.animations[0].targetSelector, '#first');

    const patched = await read(baseEtag);
    const patchEtag = patched.headers.get('etag')!;
    const latest = await patched.json();
    assert.equal(patched.status, 200);
    assert.match(patchEtag, /^"patch:/);
    assert.equal(latest.version, committedVersion);
    assert.equal(latest.animations[0].targetSelector, '#second');
    assert.equal(storage.reads, 2);
    storage.reads = metaReads = 0;
    assert.equal((await read(patchEtag)).status, 304);
    assert.equal(storage.reads, 0);
    assert.equal(metaReads, 1);
  } finally {
    await cleanup();
  }
});

it('retains only promised MCP pages and download bytes through coalesced Studio writes', { skip: !connectionString }, async () => {
  const { db, storage, workspace, auth, pool, cleanup } = await fixture();
  try {
    const path = 'notes.txt';
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, content: 'initial' }] });
    const files = new ProjectFilesService({ db, storage, historyCoalesceWindowMs: 60_000 });
    const windowId = randomUUID();
    const save = (content: string, skipVersion = false) => files.commitChanges(auth, {
      projectId, windowId, skipVersion, source: 'studio', ops: [{ op: 'upsert_text', path, content }],
    });
    const read = (query: Omit<ProjectFileQuery, 'path'> = {}) => readMcpProjectFile(
      { db, storage, files, expiresInSec: 60 }, auth, projectId, { path, ...query });

    const first = await save('first generation');
    await read();
    const second = await save('second generation');
    assert.equal(second.coalesced, true);
    assert.equal(first.versionId, second.versionId);

    const point = await workspace.getProject(auth, projectId);
    const ledger = () => pool.query('SELECT id, seq, version_id, pinned, undone FROM project_history_entries WHERE project_id=$1 ORDER BY seq', [projectId]);
    const undo = (await ledger()).rows;
    const page = await read({ length: 6 });
    await read({ mode: 'download', atFileVersion: page.fileVersion });
    assert.deepEqual(await workspace.getProject(auth, projectId), point);
    assert.deepEqual((await ledger()).rows, undo);
    const third = await save('third generation');
    assert.notEqual(third.versionId, second.versionId);
    const tail = await read({ offset: 6, atProjectVersion: second.versionId!, atFileVersion: page.fileVersion });
    assert.ok('content' in page && 'content' in tail);
    assert.equal(page.content + tail.content, 'second generation');

    const link = await read({ mode: 'download' });
    await save('fourth generation');
    const renewed = await read({ mode: 'download', atFileVersion: link.fileVersion });
    assert.ok('downloadUrl' in link && 'downloadUrl' in renewed);
    assert.equal(new URL(renewed.downloadUrl).pathname, new URL(link.downloadUrl).pathname);
    const pinned = await pool.query('SELECT count(*) FROM project_history_entries WHERE project_id=$1 AND pinned', [projectId]);
    assert.equal(Number(pinned.rows[0].count), 0);

    // If the editor wins while the first page is in flight, no invalid continuation is published.
    const readTextBlob = files.readTextBlob.bind(files);
    files.readTextBlob = async (...args) => {
      files.readTextBlob = readTextBlob;
      await save('racing writer');
      return readTextBlob(...args);
    };
    await assert.rejects(read({ length: 2 }), { code: 'VERSION_CONFLICT' });
    const retried = await read({ length: 2 });
    assert.ok('content' in retried && retried.content === 'ra');

    // A live metadata file can be newer than every saved manifest. Retaining it
    // creates one immutable manifest, without inventing a user action or reading any blob.
    await save('unversioned metadata', true);
    const unversioned = await read({ mode: 'download' });
    await save('later metadata', true);
    const frozen = await read({ atFileVersion: unversioned.fileVersion });
    assert.ok('content' in frozen && frozen.content === 'unversioned metadata');
  } finally {
    await cleanup();
  }
});

it('serves a direct parent delta, a skipped-version full file, and readable snapshots after disabling patch writes', {
  skip: !connectionString,
}, async () => {
  const { db, auth, storage, files, workspace, history, cleanup } = await fixture();
  try {
    const path = 'title.txt', initial = 'title 48px';
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, content: initial }] });
    const assetNames = new AssetNamesService({ db, files });
    const routes = (files: ProjectFilesService) => createStudioFilesRoutes({
      db, files, storage, workspace, history, assetNames, resolveAuth: () => auth,
    });
    const app = routes(files);
    const url = `/api/projects/${projectId}/file-source?path=${encodeURIComponent(path)}`;
    const legacyUrl = `/api/projects/${projectId}/files/${path}`;
    const baseline = (await files.readTextFile(auth, projectId, path))!.version;
    const save = async (baseVersion: string, size: string) => (await files.commitTextEdits(auth, projectId, {
      files: [{ path, baseVersion, patch: [[6, 2, size]] }],
    }, { requestId: randomUUID(), source: 'studio' })).versionsByPath[path];
    const one = await save(baseline, '52'), two = await save(one, '64');
    const same = await app.request(url, { headers: { 'If-None-Match': two } });
    assert.equal(same.status, 304);
    assert.equal(same.headers.get('ETag'), two);

    storage.reads = 0;
    const direct = await app.request(url, { headers: { [TEXT_PATCH_BASE_HEADER]: one } });
    assert.equal(direct.headers.get('X-OpenMotion-Representation'), 'text-patch');
    assert.equal(direct.headers.get('CDN-Cache-Control'), 'no-store');
    assert.equal(applyTextPatch('title 52px', (await direct.json()).patch), 'title 64px');
    assert.equal(storage.reads, 0);
    const missed = await app.request(url, { headers: { [TEXT_PATCH_BASE_HEADER]: baseline } });
    assert.equal(missed.headers.get('X-OpenMotion-Representation'), null);
    assert.equal((await missed.json()).content, 'title 64px');

    const disabled = new ProjectFilesService({ db, storage });
    const full = await routes(disabled).request(legacyUrl, { headers: { [TEXT_PATCH_BASE_HEADER]: one } });
    assert.equal(full.headers.get('X-OpenMotion-Text-Edits'), null);
    assert.equal((await full.json()).content, 'title 64px');
    const sync = await readMcpProjectFile({ db, files: disabled, storage, expiresInSec: 60 }, auth, projectId,
      { path, mode: 'sync', fromFileVersion: one });
    assert.ok('baseline' in sync && sync.baseline?.fileVersion === two);
    assert.deepEqual(sync.patches, []);
  } finally {
    await cleanup();
  }
});

it('serializes writes per file, preserves batch atomicity and retries, and avoids object I/O on small edits', {
  skip: !connectionString,
}, async () => {
  const { pool, events, storage, auth, files, workspace, cleanup } = await fixture();
  try {
    const initial = '🎄' + 'A'.repeat(256);
    const paths = ['one.txt', 'two.txt', 'left.txt', 'right.txt'];
    const { projectId } = await workspace.createProject(auth, {
      initialFiles: paths.map(path => ({ path, content: initial })),
    });
    const baseline = `"sha256:${sha256Hex(initial)}"`;
    const edit = (path: string, baseVersion: string, text: string) => ({ path, baseVersion, patch: [[4, 1, text]] });
    const save = (changes: unknown[], dependencies?: Record<string, string>, requestId: string = randomUUID()) =>
      files.commitTextEdits(auth, projectId, { files: changes, dependencies }, { source: 'studio', requestId });
    const versions = async () => Number((await pool.query('SELECT count(*) AS n FROM project_versions WHERE project_id=$1', [projectId])).rows[0].n);
    storage.reads = storage.writes = 0;
    const [one, two] = await Promise.all([save([edit(paths[0], baseline, '1')]), save([edit(paths[1], baseline, '2')])]);
    assert.equal(await versions(), 3);
    const oneVersion = one.versionsByPath[paths[0]];
    const twoVersion = two.versionsByPath[paths[1]];
    assert.deepEqual([storage.reads, storage.writes], [0, 0]);

    // The winning batch updates its companion. The rejected batch cannot alter its companion.
    const compete = (n: number) => save([edit(paths[0], oneVersion, String(n)), edit(paths[n], baseline, String(n))]);
    const raced = await Promise.allSettled([compete(2), compete(3)]);
    const loser = raced.findIndex(outcome => outcome.status === 'rejected');
    assert.equal(raced.filter(outcome => outcome.status === 'rejected').length, 1);
    assert.equal((raced[loser] as PromiseRejectedResult).reason.status, 409);
    const untouched = paths[loser + 2];
    assert.equal((await files.getFile(auth, projectId, untouched))?.sha256, sha256Hex(initial));
    assert.equal(await versions(), 4);

    const sameEdit = [edit(untouched, baseline, 'x')];
    const requestId = randomUUID();
    const beforeEvents = events.length;
    const receipts = await Promise.all([save(sameEdit, undefined, requestId), save(sameEdit, undefined, requestId)]);
    assert.equal(receipts.filter(r => r.replayed).length, 1);
    assert.equal(receipts[0].versionId, receipts[1].versionId);
    assert.deepEqual(events.slice(beforeEvents).map(event => event.type).sort(), ['file-change', 'history-changed']);
    assert.equal(await versions(), 5);
    await assert.rejects(save([edit(paths[1], twoVersion, '!')], { [paths[0]]: oneVersion }), { status: 409 });
    await assert.rejects(save([{ path: paths[1], baseVersion: twoVersion, patch: [[1, 1, 'x']] }]), { status: 400 });
    assert.equal(await versions(), 5);
    assert.deepEqual([storage.reads, storage.writes], [0, 0]);

    // A generated checkpoint already owns its UTF-8 index. Editing the middle of its
    // original text takes no further object read to validate byte offsets.
    await storage.ensureTextCheckpoint(auth.workspaceId, twoVersion.slice(7, -1));
    storage.reads = storage.writes = 0;
    const checked = await save([{ path: paths[1], baseVersion: twoVersion, patch: [[100, 1, 'q']] }]);
    assert.deepEqual([storage.reads, storage.writes], [0, 0]);
    const rewritten = 'a complete replacement\n';
    const full = await save([{ path: paths[1], baseVersion: checked.versionsByPath[paths[1]], content: rewritten }]);
    assert.equal(full.versionsByPath[paths[1]], `"sha256:${sha256Hex(rewritten)}"`);
    assert.deepEqual([storage.reads, storage.writes], [0, 1]);
    assert.equal((await files.readTextFile(auth, projectId, paths[1]))?.content, rewritten);
  } finally {
    await cleanup();
  }
});

it('returns retryable 503 during checkpoint GC and publishes the same bytes once collection finishes', { skip: !connectionString }, async t => {
  const { db, pool, auth, workspace, files, storage, cleanup } = await fixture();
  try {
    const path = 'title.txt', initial = 'original', updated = 'original!';
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, content: initial }] });
    const commit = await files.commitTextEdits(auth, projectId, { files: [{ path, baseVersion: formatFileVersion('workspace', sha256Hex(initial)),
      patch: [[8, 0, '!']] }] }, { requestId: randomUUID(), source: 'studio' });
    const id = commit.versionsByPath[path].slice(7, -1), sha = sha256Hex(updated);
    const key = workspaceBlobKey(auth.workspaceId, sha);
    // A collector already claimed an unreferenced blob with identical bytes.
    await pool.query("INSERT INTO workspace_blobs(workspace_id,sha256,s3_key,size_bytes,mime_type,ref_count,gc_state,zero_ref_since) VALUES ($1,$2,$3,$4,'text/plain',0,'deleting',now())",
      [auth.workspaceId, sha, key, Buffer.byteLength(updated)]);
    let failures = 0;
    let finishCollection = false;
    const transact = db.transaction.bind(db);
    t.mock.method(db, 'transaction', async (...args: Parameters<typeof transact>) => {
      try {
        return await transact(...args);
      } catch (error) {
        if (isCloudError(error) && error.code === 'BLOB_GC_IN_PROGRESS') {
          failures++;
          if (finishCollection) assert.ok(await finalizeBlobDeletion(db, auth.workspaceId, sha));
        }
        throw error;
      }
    });

    storage.reads = storage.writes = 0;
    await assert.rejects(storage.ensureTextCheckpoint(auth.workspaceId, id), { code: 'BLOB_GC_IN_PROGRESS', status: 503, applied: false });
    assert.deepEqual([failures, storage.reads, storage.writes], [3, 1, 0]);
    assert.equal((await files.getFile(auth, projectId, path))?.sha256, id);

    finishCollection = true;
    assert.equal(await storage.ensureTextCheckpoint(auth.workspaceId, id), sha);
    assert.deepEqual([failures, storage.reads, storage.writes], [4, 2, 1]);
    assert.equal(storage.objects.get(key)?.toString(), updated);
  } finally {
    await cleanup();
  }
});

it('keeps immutable autosave versions in one undo step and separates confirmed commands and other authors', { skip: !connectionString }, async () => {
  const { db, storage, files, workspace, history, auth, pool, cleanup } = await fixture();
  try {
    const path = 'notes.txt';
    const scene = 'scene.html';
    const html = '<div data-composition-id="scene" data-duration="12"><div data-hf-id="hf-title" data-start="2" data-duration="3"></div></div>';
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, content: '0' }, { path: scene, content: html }] });
    const group = randomUUID();
    let editor = auth;
    const app = createStudioFilesRoutes({ db, storage, files, workspace, history,
      assetNames: new AssetNamesService({ db, files }), resolveAuth: () => editor });
    const current = async () => (await files.readTextFile(auth, projectId, path))!;
    const body = (baseVersion: string, next: string, continuous: boolean) => ({
      files: [{ path, baseVersion, patch: [[0, 1, next]] }], ...(continuous && { undoGroup: group }),
    });
    const send = async (payload: object, id = randomUUID()) => {
      const response = await app.request(`/api/projects/${projectId}/text-edits`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': id, 'X-OpenMotion-Edit-Window': group },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const save = async (next: string, continuous = false) => send(body((await current()).version, next, continuous));
    const first = await save('1', true);
    const retryId = randomUUID();
    const input = body(first.versions[path], '2', true);
    const second = await send(input, retryId);
    assert.notEqual(second.versionId, first.versionId);
    assert.equal((await history.listHistory(auth, projectId)).currentSeq, 2);
    assert.equal((await history.peekPoint(auth, projectId, first.versionId, path)).file?.content, '1');
    assert.equal((await send(input, retryId)).versionId, second.versionId);
    assert.equal(Number((await pool.query('SELECT count(*) FROM project_versions WHERE project_id=$1', [projectId])).rows[0].count), 3);

    await save('3');
    await save('4'); // Two independent confirms with the same legacy window header.
    await save('5', true);
    editor = { ...auth, userId: randomUUID() };
    await save('6', true); // Same group UUID and display name, different authenticated user.
    editor = auth;
    await save('7', true);
    const agentInput = body((await current()).version, '8', false);
    await files.commitTextEdits(auth, projectId, agentInput, { source: 'agent', requestId: randomUUID() });
    await save('9', true);
    for (const expected of ['8', '7', '6', '5', '4', '3', '2', '0']) {
      await history.step(auth, projectId, 'back');
      assert.equal((await current()).content, expected);
    }
    await history.step(auth, projectId, 'forward');
    assert.equal((await current()).content, '2');

    // Studio can also ask the server to calculate the patch for a continuous gesture.
    const getScene = async () => (await files.readTextFile(auth, projectId, scene))!;
    const startingScene = await getScene();
    const fallbackSequences: number[] = [];
    for (const start of [4, 5]) {
      const response = await app.request(`/api/projects/${projectId}/edits`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ versions: { [scene]: (await getScene()).version }, undoGroup: group,
          edit: { kind: 'moveClip', compositionPath: scene, hfId: 'hf-title', start } }),
      });
      assert.equal(response.status, 200, await response.text());
      fallbackSequences.push((await history.listHistory(auth, projectId)).currentSeq);
    }
    assert.equal(fallbackSequences[0], fallbackSequences[1]);
    assert.match((await getScene()).content, /data-start="5"/);
    await history.step(auth, projectId, 'back');
    assert.equal((await getScene()).content, startingScene.content);
  } finally {
    await cleanup();
  }
});

it('commits a checkpoint candidate when cumulative UTF-8 bytes cross the threshold, without touching the bucket', { skip: !connectionString }, async () => {
  const { auth, files, workspace, storage, pool, cleanup } = await fixture();
  try {
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path: 'index.html', content: 'x' }] });
    let version = formatFileVersion('workspace', sha256Hex('x'));
    const inserted = '🌙'.repeat(14_000);
    const patch = [[1, 0, inserted]];
    const encodedBytes = Buffer.byteLength(JSON.stringify(patch));
    storage.reads = storage.writes = 0;
    for (let i = 1; i <= 6; i++) {
      version = (await files.commitTextEdits(auth, projectId, { files: [{ path: 'index.html', baseVersion: version, patch }] },
        { requestId: randomUUID(), source: 'studio' })).versionsByPath['index.html'];
      const { rows: [row] } = await pool.query(`SELECT depth, chain_patch_bytes, checkpoint_due_at IS NOT NULL AS due, checkpoint_sha
        FROM project_text_revisions WHERE workspace_id=$1 AND id=$2`, [auth.workspaceId, version.slice(7, -1)]);
      const depth = i === 6 ? 1 : i;
      assert.deepEqual(row, { depth, chain_patch_bytes: depth * encodedBytes, due: i === 5, checkpoint_sha: null });
      assert.deepEqual([storage.reads, storage.writes], [0, 0]);
    }
    assert.equal((await files.readTextFile(auth, projectId, 'index.html'))?.content, 'x' + inserted.repeat(6));
  } finally { await cleanup(); }
});

it('records a 300 KiB splice once, retries checkpoint failures and keeps saving while that upload is blocked', { skip: !connectionString, timeout: 20000 }, async t => {
  const { auth, db, files, workspace, storage, pool, cleanup } = await fixture();
  const releaseUpload = Promise.withResolvers<void>();
  try {
    const path = 'index.html';
    const baseline = 'x'.repeat(1024 * 1024);
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, content: baseline }] });
    let version = formatFileVersion('workspace', sha256Hex(baseline));
    async function append(text: string) {
      const result = await files.commitTextEdits(auth, projectId, { files: [{ path, baseVersion: version, patch: [[baseline.length, 0, text]] }] },
        { requestId: randomUUID(), source: 'studio' });
      version = result.versionsByPath[path];
      return version.slice(7, -1);
    }
    const large = 'X'.repeat(300 * 1024), small = 'y'.repeat(1024);
    storage.reads = storage.writes = 0;
    const candidate = await append(large);
    await append(small);
    assert.deepEqual([storage.reads, storage.writes], [0, 0]);
    const worker = { db, storage, logger: createLogger({ sink() {} }) };
    const prioritize = () => pool.query("UPDATE project_text_revisions SET checkpoint_due_at='-infinity' WHERE workspace_id=$1 AND id=$2",
      [auth.workspaceId, candidate]);
    await prioritize();
    const ensure = storage.ensureTextCheckpoint.bind(storage);
    t.mock.method(storage, 'ensureTextCheckpoint', async () => { throw new Error('Bucket temporarily unavailable'); }, { times: 1 });
    assert.deepEqual(await createTextCheckpoints(worker, { batchSize: 1 }), { completed: 0, failed: 1 });
    const { rows: [retry] } = await pool.query('SELECT checkpoint_sha, checkpoint_due_at > now() AS deferred FROM project_text_revisions WHERE id=$1', [candidate]);
    assert.deepEqual(retry, { checkpoint_sha: null, deferred: true });
    await requestTextCheckpoint(db, auth.workspaceId, candidate);
    const { rows: [stillDeferred] } = await pool.query('SELECT checkpoint_due_at > now() AS deferred FROM project_text_revisions WHERE id=$1', [candidate]);
    assert.equal(stillDeferred.deferred, true);

    await prioritize();
    const uploading = Promise.withResolvers<void>();
    const upload = storage.putBlobIfAbsent.bind(storage);
    t.mock.method(storage, 'putBlobIfAbsent', async (key: string, bytes: Buffer) => {
      uploading.resolve();
      await releaseUpload.promise;
      return upload(key, bytes);
    });
    const work = createTextCheckpoints(worker, { batchSize: 1 });
    try {
      await Promise.race([uploading.promise, work.then(() => { throw new Error('Checkpoint ended before upload'); })]);
      // The welcome bootstrap also takes this lock on a cold workspace.
      await pool.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT", [auth.workspaceId]);
      // The reservation survives a crash, but the upload holds no database transaction or object locks.
      const { rows: [reservation] } = await pool.query('SELECT checkpoint_pending_sha, checkpoint_sha FROM project_text_revisions WHERE id=$1 FOR UPDATE NOWAIT', [candidate]);
      assert.deepEqual(reservation, { checkpoint_pending_sha: sha256Hex(baseline + large), checkpoint_sha: null });
      await pool.query('SELECT sha256 FROM workspace_blobs WHERE workspace_id=$1 AND sha256=$2 FOR UPDATE NOWAIT', [auth.workspaceId, reservation.checkpoint_pending_sha]);
      assert.ok(!(await markZeroRefForDeletion(db, { graceSeconds: 0, batchSize: 128 })).some(row => row.sha256 === reservation.checkpoint_pending_sha));
      await requestTextCheckpoint(db, auth.workspaceId, candidate);
      await append(small);
      const { rows } = await pool.query(`SELECT depth, chain_patch_bytes, checkpoint_due_at IS NOT NULL AS due FROM project_text_revisions
        WHERE project_id=$1 ORDER BY chain_patch_bytes DESC`, [projectId]);
      const smallBytes = Buffer.byteLength(JSON.stringify([[baseline.length, 0, small]]));
      assert.deepEqual(rows, [
        { depth: 1, chain_patch_bytes: Buffer.byteLength(JSON.stringify([[baseline.length, 0, large]])), due: true },
        { depth: 2, chain_patch_bytes: smallBytes * 2, due: false }, { depth: 1, chain_patch_bytes: smallBytes, due: false },
      ]);
    } finally { releaseUpload.resolve(); await work; }
    assert.deepEqual(await work, { completed: 1, failed: 0 });
    assert.equal(await ensure(auth.workspaceId, candidate), sha256Hex(baseline + large));
    assert.equal((await files.readTextFile(auth, projectId, path))?.content, baseline + small + small + large);
  } finally { releaseUpload.resolve(); await cleanup(); }
});

it('lets another process publish identical bytes while a checkpoint upload stalls and retry after a lost acknowledgement', {
  skip: !connectionString, timeout: 10000,
}, async t => {
  const { db, pool, storage, auth, workspace, files, cleanup } = await fixture();
  const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  try {
    const target = 'shared target', sha = sha256Hex(target);
    async function revision(source: string) {
      const path = 'scene.html';
      const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, content: source }] });
      const baseVersion = formatFileVersion('workspace', sha256Hex(source));
      const result = await files.commitTextEdits(auth, projectId, { files: [{ path, baseVersion, patch: [[0, source.length, target]] }] },
        { requestId: randomUUID(), source: 'studio' });
      return result.versionsByPath[path].slice(7, -1);
    }
    const [a, b] = await Promise.all([revision('first'), revision('second')]);
    const put = storage.putBlobIfAbsent.bind(storage);
    t.mock.method(storage, 'putBlobIfAbsent', async (key: string, data: Buffer) => {
      reached.resolve();
      await resume.promise;
      await put(key, data);
      throw new Error('Lost upload acknowledgement');
    }, { times: 1 });
    const first = storage.ensureTextCheckpoint(auth.workspaceId, a);
    try {
      await reached.promise;
      await assert.doesNotReject(pool.query('SELECT id FROM project_text_revisions WHERE id=$1 FOR UPDATE NOWAIT', [a]));
      assert.equal(await new TextRevisionStorage(db, storage).checkpoint(auth.workspaceId, b), sha);
    } finally { resume.resolve(); await assert.rejects(first, /Lost upload acknowledgement/); }
    const { rows: [pending] } = await pool.query('SELECT checkpoint_pending_sha, checkpoint_sha FROM project_text_revisions WHERE id=$1', [a]);
    assert.deepEqual(pending, { checkpoint_pending_sha: sha, checkpoint_sha: null });
    assert.equal(await new TextRevisionStorage(db, storage).checkpoint(auth.workspaceId, a), sha);
    const { rows } = await pool.query('SELECT checkpoint_pending_sha, checkpoint_sha FROM project_text_revisions WHERE id IN ($1,$2)', [a,b]);
    assert.deepEqual(rows, [1, 2].map(() => ({ checkpoint_pending_sha: null, checkpoint_sha: sha })));
  } finally { resume.resolve(); await cleanup(); }
});

it('pins all unchanged snapshot files in one SQL round trip per concurrent project edit', { skip: !connectionString }, async () => {
  const { pool, workspace, storage, auth, workspaceId, cleanup } = await fixture();
  try {
    let pinStatements = 0;
    const db = drizzle(pool, { schema, logger: { logQuery(query) {
      if (query.startsWith('insert into "workspace_blobs"')) pinStatements++;
    } } });
    const files = new ProjectFilesService({ db, storage, textPatchWrites: true });
    const source = '<h1>0</h1>' + ' '.repeat(512);
    const initialFiles = [{ path: 'index.html', content: source }, ...Array.from({ length: 64 }, (_, i) => ({
      path: `clips/${i}.html`, content: `<p>${i}</p>`,
    }))];
    const left = await workspace.createProject(auth, { title: 'Left', initialFiles });
    const right = await workspace.createProject(auth, { title: 'Right', initialFiles: [...initialFiles].reverse() });
    const edit = async (projectId: string, baseVersion: string, digit: string) =>
      (await files.commitTextEdits(auth, projectId, { files: [{ path: 'index.html', baseVersion, patch: [[4, 1, digit]] }] },
        { requestId: randomUUID(), source: 'studio' })).versionsByPath['index.html'];

    const initial = formatFileVersion('workspace', sha256Hex(source));
    const heads = await Promise.all([edit(left.projectId, initial, '1'), edit(right.projectId, initial, '2')]);
    const counts = async () => (await pool.query<{ref_count: number}>(
      'SELECT ref_count FROM workspace_blobs WHERE workspace_id=$1 AND sha256<>$2 ORDER BY sha256',
      [workspaceId, sha256Hex(source)])).rows.map(row => row.ref_count);
    const before = await counts();
    assert.equal(before.length, initialFiles.length - 1);
    pinStatements = storage.reads = storage.writes = 0;
    await Promise.all([edit(left.projectId, heads[0], '3'), edit(right.projectId, heads[1], '4')]);
    assert.equal(pinStatements, 2);
    assert.equal(storage.reads + storage.writes, 0);
    assert.deepEqual(await counts(), before.map(n => n + 2));
  } finally { await cleanup(); }
});

it('rolls back a mixed CAS batch on a GC claim or underflow and preserves per-object metadata', { skip: !connectionString }, async () => {
  const { db, pool, workspaceId, cleanup } = await fixture();
  try {
    const [first, second, third] = [1, 2, 3].map(i => String(i).padStart(64, '0'));
    const retain = (deltas: BlobRefDelta[]) => db.transaction(tx => applyWorkspaceBlobRefDeltas(tx, workspaceId, deltas));
    const blob = (sha256: string) => ({ sha256, delta: 1, sizeBytes: 2, mimeType: 'text/plain' });
    await retain([{ ...blob(first), metadata: { width: 40 } }, blob(third)]);
    await pool.query("UPDATE workspace_blobs SET gc_state='deleting', ref_count=0, zero_ref_since=now() WHERE workspace_id=$1 AND sha256=$2",
      [workspaceId, third]);
    const rows = async () => (await pool.query('SELECT sha256,ref_count,metadata,size_bytes,mime_type FROM workspace_blobs WHERE workspace_id=$1 ORDER BY sha256',
      [workspaceId])).rows;
    const before = await rows();
    await assert.rejects(retain([blob(third), blob(first), blob(second)]), { code: 'BLOB_GC_IN_PROGRESS', details: { sha256: third } });
    assert.deepEqual(await rows(), before);
    await assert.rejects(retain([blob(first), blob(second), { sha256: third, delta: -1 }]), { code: 'STORAGE_ERROR' });
    assert.deepEqual(await rows(), before);
    await retain([{ ...blob(first), metadata: { height: 20 } }, { ...blob(second), delta: 3, sizeBytes: 19, mimeType: 'text/html' }]);
    const [a, b] = await rows();
    assert.deepEqual([a.ref_count, a.metadata, b.ref_count, Number(b.size_bytes), b.mime_type], [2, { width: 40, height: 20 }, 3, 19, 'text/html']);
  } finally { await cleanup(); }
});

it('keeps a hundred ordered Studio edits, their undo points and replay receipts across HTTP batches', { skip: !connectionString }, async () => {
  const { auth, db, storage, workspace, files, history, events, cleanup } = await fixture();
  try {
    const path = 'index.html';
    const { projectId } = await workspace.createProject(auth, { initialFiles: [{ path, content: '0' }] });
    const app = createStudioFilesRoutes({ db, storage, files, workspace, history,
      assetNames: new AssetNamesService({db, files}), resolveAuth: () => auth });
    app.onError((error, c) => isCloudError(error) ? c.json(error.toJSON(), error.status as 400) : c.json({}, 500));

    const url = '/api/projects/' + projectId;
    const send = (operations: object[]) => app.request(url + '/text-edits/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({operations}),
    });
    const start = await app.request(url + '/files/' + path);
    assert.equal(start.headers.get('X-OpenMotion-Ordered-Edits'), '1');
    const initial = (await start.json()).version as string;
    const ids = Array.from({length: 100}, () => randomUUID());
    const operations = ids.map((id, i) => ({ id, files: [{ path,
      baseVersion: i ? {after: ids[i - 1]} : initial, patch: [[0, String(i).length, String(i + 1)]],
    }] }));

    // A malformed dependency graph must not leave an accepted prefix.
    assert.equal((await send([operations[0], operations[0]])).status, 400);
    assert.equal((await send([operations[0], operations[3]])).status, 400);
    assert.equal((await files.readTextFile(auth, projectId, path))!.version, initial);

    events.length = 0;
    storage.reads = storage.writes = 0;
    const response = await send(operations);
    assert.deepEqual([storage.reads, storage.writes], [0, 0]);
    assert.equal(response.status, 200);
    const { committed, failed } = await response.json();
    assert.equal(failed, undefined);
    assert.deepEqual(events.map(event => event.type), ['files-changed', 'history-changed']);
    const forwarded = events[0];
    assert.ok(forwarded.type === 'files-changed');
    assert.equal(forwarded.indexHeadHash, undefined);
    assert.deepEqual(forwarded.ordered?.steps.map(step => step.id), ids);
    assert.ok(forwarded.ordered?.steps.every(step => step.patches?.length === 1));
    events.length = 0;
    assert.deepEqual(committed.map((r: { id: string }) => r.id), ids);
    assert.equal(new Set(committed.map((r: { versionId: string }) => r.versionId)).size, 100);
    assert.equal((await files.readTextFile(auth, projectId, path))!.content, '100');
    const historyBeforeReplay = await history.listHistory(auth, projectId);
    assert.deepEqual((await (await send(operations)).json()).committed, committed);
    assert.equal((await history.listHistory(auth, projectId)).currentSeq, historyBeforeReplay.currentSeq);
    assert.equal(events.length, 0);

    // A retry with a changed operation must stop at that step. The suffix was never executed.
    const different = {...operations[1], label: 'Changed intent'};
    const badId = await (await send([operations[0], different])).json();
    assert.deepEqual(badId.committed, [committed[0]]);
    assert.equal(badId.failed.code, 'REQUEST_ID_CONFLICT');
    const tail = { id: randomUUID(), files: [{ path, baseVersion: committed[99].versions[path], content: 'tail' }] };
    const stale = { id: randomUUID(), files: [{ path, baseVersion: initial, content: 'stale' }] };
    const prefix = await (await send([tail, stale, {id: randomUUID(), files: [{path, baseVersion: {after: tail.id}, content: 'wrong'}]}])).json();
    assert.equal(prefix.committed.length, 1);
    const partial = events.find(event => event.type === 'files-changed');
    assert.ok(partial?.type === 'files-changed');
    assert.equal(partial.indexHeadHash, sha256Hex('').slice(0, 12));
    assert.deepEqual(partial.ordered?.steps.map(step => step.id), [tail.id]);
    assert.deepEqual([prefix.failed.id, prefix.failed.status, prefix.failed.path, prefix.failed.currentVersion],
      [stale.id, 409, path, prefix.committed[0].versions[path]]);
    assert.equal((await files.readTextFile(auth, projectId, path))!.content, 'tail');
    await history.step(auth, projectId, 'back');
    assert.equal((await files.readTextFile(auth, projectId, path))!.content, '100');
    await history.step(auth, projectId, 'back');
    assert.equal((await files.readTextFile(auth, projectId, path))!.content, '99');
  } finally { await cleanup(); }
});
