import { isBeatMedia } from '../../shared/asset-names.ts';
import type { OrderedEditEvents } from './ordered-edit-events.ts';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { textEditSchema } from './text-edit-input.ts';
import { componentOverlaySource } from '../../shared/registry-material-compat.ts';
import type { TextPatch } from '../../shared/text-patch.ts';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { BlobScope, StoragePort } from '../contracts/storage.ts';
import type { Database, DbTransaction } from '../db/client.ts';
import { projectFiles, projectTextRevisions } from '../db/schema/project-files.ts';
import { TEXT_CHECKPOINT_INTERVAL, TEXT_CHECKPOINT_BYTES } from '../infra/text-revisions.ts';
import { formatFileVersion } from '../studio/etag.ts';
import {
  canonicalInputHash, loadProjectOrThrow, MAX_TEXT_FILE_BYTES, normalizeSafeProjectPath, readCommitReceipt,
  type CommitProjectFilesResult, type ProjectFileOp, type ProjectFilesService,
} from './project-files-service.ts';
import { primaryFile } from './motion-component-source.ts';
import { getMotionComponent, prepareMotionComponent } from './motion-component-registry.ts';
import { validateTextPatch } from './text-patch-boundaries.ts';

// Existing callers may use the patch form even for very short files.
const SMALL_TEXT_PATCH_BYTES = 64 * 1024;
function invalid(message: string) {
  return new CloudError('INVALID_ARGUMENT', message, {status: 400, applied: false});
}
export interface PendingTextRevision {
  path: string; parentScope: BlobScope; parentId: string; sizeBytes: number;
  mimeType: string; depth: number; chainPatchBytes: number; checkpointDue: boolean; patch: TextPatch;
}
export interface TextEditIdentity {
  events?: OrderedEditEvents;
  observedProject?: { expectedRevision: string; expectedVersionId: string };
  requestId: string; writeToken?: string; source: 'studio'|'agent';
  // Semantic MCP requests retain their original identity before generating bytes.
  command?: {scope: string; hash: string; result: Record<string, unknown>};
}

/** Called inside the existing project lock, after receipt replay and all file preconditions. */
export async function appendTextRevisions(tx: DbTransaction, workspaceId: string, projectId: string,
  revisions: readonly PendingTextRevision[]) {
  const rows = revisions.map(({path, checkpointDue, ...revision}) => ({
    path, record: {...revision, workspaceId, projectId, id: randomBytes(32).toString('hex'), checkpointDueAt: checkpointDue ? sql`now()` : null},
  }));
  await tx.insert(projectTextRevisions).values(rows.map(({record}) => record));
  return rows.map(({path, record}) => ({
    op: 'upsert' as const, path, blobScope: 'patch' as const, sha256: record.id,
    sizeBytes: record.sizeBytes, mimeType: record.mimeType, isText: true,
  }));
}

// The inserted strings have exactly the same JSON escaping in both wire forms. Each
// retained UTF-8 byte can cost at most six JSON bytes (e.g. a control character).
// This upper bound rules out wasteful patches without reading the unchanged source.
function canPatchBeSmaller(patch: TextPatch, baseBytes: number): boolean {
  const retained = patch.reduce((bytes, [, removed]) => bytes - removed, baseBytes);
  const envelope = patch.map(([offset, removed]) => [offset, removed, '']);
  return JSON.stringify({ patch: envelope }).length < '{"content":""}'.length + 6 * retained;
}

export async function commitTextEdits(files: ProjectFilesService, db: Database, storage: StoragePort,
  ctx: AuthContext, projectId: string, body: unknown, identity: TextEditIdentity): Promise<CommitProjectFilesResult> {
  const parsed = textEditSchema.safeParse(body);
  if (!parsed.success || !identity.requestId || identity.requestId.length > 100) throw invalid('Supply a valid text edit and request ID');
  const input = parsed.data;
  if (input.installComponent && (input.files.length !== 1 || input.files[0].baseVersion === null ||
      (!files.textPatchWrites && 'patch' in input.files[0]))) {
    throw invalid('Place a component by editing one existing host composition');
  }
  if (input.undoGroup && identity.source !== 'studio') throw invalid('Only continuous Studio edits can share an undo step');
  const targets = new Set<string>();
  const guards = new Map(Object.entries(input.dependencies ?? {}));
  for (const item of input.files) {
    if (item.path !== normalizeSafeProjectPath(item.path, true) || targets.has(item.path)) throw invalid('Use distinct, canonical file paths');
    if (guards.has(item.path) && guards.get(item.path) !== item.baseVersion) throw invalid('Conflicting file versions');
    targets.add(item.path);
    guards.set(item.path, item.baseVersion);
  }
  if (guards.size > 256) throw invalid('Too many files in a text edit');
  for (const path of guards.keys()) if (path !== normalizeSafeProjectPath(path)) throw invalid('Invalid dependency path');

  const scope = identity.command?.scope ?? `project:${projectId}:${identity.source}:text-edits`;
  const hash = identity.command?.hash ?? canonicalInputHash(identity.observedProject ? [input, identity.observedProject] : input);
  await loadProjectOrThrow(db, ctx.workspaceId, projectId, {auth: ctx, allowTrashed: false});
  const item = input.installComponent ? getMotionComponent(input.installComponent) : undefined;
  const catalogPaths = item?.files.map(file => file.target) ?? [];
  if (catalogPaths.some(path => guards.has(path)) || guards.size + catalogPaths.length > 256) {
    throw invalid('Component dependencies must fit this edit and be separate from its text files');
  }
  const observed = await db.select().from(projectFiles).where(and(eq(projectFiles.workspaceId, ctx.workspaceId),
    eq(projectFiles.projectId, projectId), inArray(projectFiles.path, [...guards.keys(), ...catalogPaths])));
  const replay = await readCommitReceipt(db, ctx.workspaceId, scope, identity.requestId, hash);
  if (replay) return replay;
  if (identity.observedProject) await files.checkObservedFiles(ctx, projectId, identity.observedProject, guards);
  const rows = new Map(observed.map(row => [row.path, row]));
  for (const [path, expected] of guards) {
    const row = rows.get(path);
    const currentVersion = row ? formatFileVersion(row.blobScope, row.sha256) : null;
    if (expected !== currentVersion) throw new CloudError('VERSION_CONFLICT', 'File changed before this edit', {
      status: 409, applied: false, details: {path, currentVersion, code: 'VERSION_MISMATCH'},
    });
  }
  for (const asset of input.beatAssets ?? []) {
    if (!guards.get(asset) || !targets.has('beats/' + asset + '.json') || !isBeatMedia(asset, rows.get(asset))) {
      throw invalid('Beat edits require a versioned project audio or video asset');
    }
  }
  const revisions: PendingTextRevision[] = [];
  const ops: ProjectFileOp[] = [];
  for (const item of input.files) {
    const parent = rows.get(item.path);
    if (parent && !parent.isText) throw invalid('This file contains binary data');
    if ('content' in item) {
      if (!item.content.isWellFormed() || item.content.includes('\0') || Buffer.byteLength(item.content) > MAX_TEXT_FILE_BYTES) {
        throw invalid('Invalid project text');
      }
      ops.push({op: 'upsert_text', path: item.path, content: item.content, mimeType: parent?.mimeType});
      continue;
    }
    const patchBytes = Buffer.byteLength(JSON.stringify(item.patch));
    if (!parent) throw invalid('Invalid patch base');
    if (!item.patch.length) continue;
    const sizeBytes = await validateTextPatch(db, {workspaceId: ctx.workspaceId, projectId, base: parent, patch: item.patch, storage});
    if (patchBytes > SMALL_TEXT_PATCH_BYTES && !canPatchBeSmaller(item.patch, parent.sizeBytes)) {
      throw invalid('Send content for a large replacement whose patch cannot be smaller than the complete file.');
    }
    let depth = 1;
    let chainPatchBytes = patchBytes;
    if (parent.blobScope === 'patch') {
      const [stored] = await db.select({depth: projectTextRevisions.depth, chainBytes: projectTextRevisions.chainPatchBytes,
        checkpoint: projectTextRevisions.checkpointSha, dueAt: projectTextRevisions.checkpointDueAt})
        .from(projectTextRevisions).where(and(eq(projectTextRevisions.workspaceId, ctx.workspaceId),
          eq(projectTextRevisions.projectId, projectId), eq(projectTextRevisions.id, parent.sha256)));
      if (!stored) throw new CloudError('STORAGE_ERROR', 'Missing text revision', {status: 500});
      // A pending snapshot starts the next counting interval even while its bytes are still being built.
      if (!stored.checkpoint && !stored.dueAt) {
        depth += stored.depth;
        chainPatchBytes += stored.chainBytes;
      }
    }
    const due = depth >= TEXT_CHECKPOINT_INTERVAL || chainPatchBytes >= TEXT_CHECKPOINT_BYTES;
    revisions.push({path: item.path, parentScope: parent.blobScope, parentId: parent.sha256, sizeBytes,
      mimeType: parent.mimeType, patch: item.patch, checkpointDue: due, depth, chainPatchBytes});
  }
  if (item) {
    for (const path of catalogPaths) {
      const row = rows.get(path);
      guards.set(path, row ? formatFileVersion(row.blobScope, row.sha256) : null);
    }
    ops.push(...await prepareMotionComponent(item, new Set(rows.keys()), true));
    const installed = rows.get(primaryFile(item).target);
    if (installed && installed.blobScope !== 'patch' && installed.sha256 === item.opaqueSourceSha256) {
      const source = await files.readTextBlob(ctx.workspaceId, installed.blobScope, installed.sha256);
      ops.push({ op: 'upsert_text', path: installed.path, content: componentOverlaySource(source), mimeType: installed.mimeType });
    }
  }
  return files.commitChanges(ctx, {
    projectId, requestId: identity.requestId, idempotencyScope: scope, source: identity.source,
    orderedEvents: identity.events,
    ...(identity.source === 'agent' && { actorKind: 'agent' }),
    commandReceipt: {inputHash: hash, result: identity.command?.result ?? {}},
    summary: input.label, writeToken: identity.writeToken, ops, textRevisions: revisions,
    undoGroup: input.undoGroup && `${ctx.userId}:${input.undoGroup}`,
    filePreconditions: [...guards].map(([path, expected]) => expected === null ? {path, ifNoneMatch: '*'} : {path, ifMatch: expected}),
  });
}
