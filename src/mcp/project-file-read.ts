import { and, eq, isNotNull } from 'drizzle-orm';
import { basename } from 'node:path/posix';
import { isTextProjectPath } from '../../shared/project-validation.ts';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { BlobScope, StoragePort } from '../contracts/storage.ts';
import type { Database } from '../db/client.ts';
import { projectFiles, projectHistoryEntries, projectVersionFiles } from '../db/schema/project-files.ts';
import { asUpdate } from '../db/helpers.ts';
import { loadTextRevisionChain } from '../infra/text-revisions.ts';
import { loadProjectOrThrow, normalizeSafeProjectPath, resolveBlobStorageKey, type ProjectFilesService } from '../services/project-files-service.ts';
import { freezeProjectSnapshot } from '../services/project-snapshot.ts';
import { buildContentDisposition, formatFileVersion } from '../studio/etag.ts';

export interface ProjectFileQuery {
  path: string;
  mode?: 'read' | 'download' | 'sync';
  offset?: number;
  length?: number;
  atProjectVersion?: string;
  atFileVersion?: string;
  fromFileVersion?: string;
}

interface FileReadDeps {
  db: Database;
  storage: StoragePort;
  files: ProjectFilesService;
  expiresInSec: number;
}
type FileRef = { path: string; sha256: string; blobScope: BlobScope; sizeBytes: number; mimeType: string; isText: boolean };

function badQuery(message: string): never {
  throw new CloudError('INVALID_ARGUMENT', message, { status: 400, applied: false });
}

// Call after project authorization. Never take a storage key or workspace ID from the tool arguments.
async function resolveFile(deps: FileReadDeps, auth: AuthContext, projectId: string, path: string, query: ProjectFileQuery): Promise<FileRef> {
  if (!query.atProjectVersion) {
    const live = await deps.files.getFile(auth, projectId, path);
    if (live && (!query.atFileVersion || formatFileVersion(live.blobScope, live.sha256) === query.atFileVersion)) return live;
    if (!query.atFileVersion) throw new CloudError('NOT_FOUND', 'File not found in project', { status: 404 });
  }
  const conditions = [
    eq(projectVersionFiles.workspaceId, auth.workspaceId),
    eq(projectVersionFiles.projectId, projectId),
    eq(projectVersionFiles.path, path),
  ];
  if (query.atProjectVersion) conditions.push(eq(projectVersionFiles.versionId, query.atProjectVersion));
  if (query.atFileVersion) {
    const match = /^"(sha256|patch):([a-f0-9]{64})"$/.exec(query.atFileVersion);
    if (!match) badQuery('atFileVersion must be a fileVersion returned by OpenMotion');
    conditions.push(eq(projectVersionFiles.sha256, match[2]));
    if (match[1] === 'patch') conditions.push(eq(projectVersionFiles.blobScope, 'patch'));
  }
  const [file] = await deps.db.select().from(projectVersionFiles).where(and(...conditions)).limit(1);
  if (!file || (query.atFileVersion && formatFileVersion(file.blobScope, file.sha256) !== query.atFileVersion)) {
    throw new CloudError('NOT_FOUND', 'File not found at the requested version of this project', { status: 404 });
  }
  return { ...file, isText: isTextProjectPath(path) || file.mimeType.startsWith('text/') };
}

export async function readMcpProjectFile(
  deps: FileReadDeps, auth: AuthContext, projectId: string, query: ProjectFileQuery,
) {
  const path = normalizeSafeProjectPath(query.path);
  const mode = query.mode ?? 'read';
  if (mode !== 'read' && (query.offset !== undefined || query.length !== undefined)) badQuery('offset and length apply to read mode');
  if (mode !== 'sync' && query.fromFileVersion !== undefined) badQuery('fromFileVersion applies to sync mode');
  const file = await resolveFile(deps, auth, projectId, path, query);
  const fileVersion = formatFileVersion(file.blobScope, file.sha256);
  const info = { path, fileVersion, bytes: file.sizeBytes, mimeType: file.mimeType };

  // A legacy Studio edit window can replace the file in its latest manifest. Close that
  // window before handing out a cursor or renewable link. Ordinary single-page reads skip this.
  async function retainVersion() {
    await deps.db.transaction(async tx => {
      const project = await loadProjectOrThrow(tx, auth.workspaceId, projectId, { auth, allowTrashed: true, forUpdate: true });
      const [manifest] = await tx.select({ versionId: projectVersionFiles.versionId }).from(projectVersionFiles)
        .where(and(eq(projectVersionFiles.workspaceId, auth.workspaceId), eq(projectVersionFiles.projectId, projectId),
          eq(projectVersionFiles.path, path), eq(projectVersionFiles.blobScope, file.blobScope), eq(projectVersionFiles.sha256, file.sha256),
          query.atProjectVersion ? eq(projectVersionFiles.versionId, query.atProjectVersion) : undefined)).limit(1);
      if (manifest) {
        await tx.update(projectHistoryEntries).set(asUpdate(projectHistoryEntries, { windowId: null }))
          .where(and(eq(projectHistoryEntries.workspaceId, auth.workspaceId), eq(projectHistoryEntries.projectId, projectId),
            eq(projectHistoryEntries.versionId, manifest.versionId), isNotNull(projectHistoryEntries.windowId)));
        return;
      }
      // A metadata-only save can leave a live file with no history snapshot. Use the
      // same freeze as export, only if the file we are promising is still the live one.
      if (!query.atProjectVersion) {
        const inProject = and(eq(projectFiles.workspaceId, auth.workspaceId), eq(projectFiles.projectId, projectId));
        const [live] = await tx.select({ path: projectFiles.path }).from(projectFiles).where(and(inProject,
          eq(projectFiles.path, path), eq(projectFiles.blobScope, file.blobScope), eq(projectFiles.sha256, file.sha256)));
        if (live) {
          const liveFiles = await tx.select().from(projectFiles).where(inProject);
          await freezeProjectSnapshot(tx, project, liveFiles, 'Frozen file download snapshot');
          return;
        }
      }
      throw new CloudError('VERSION_CONFLICT', 'File changed during the read. Retry to capture the latest file.', { status: 409 });
    });
  }

  async function download(scope: BlobScope, id: string) {
    await retainVersion();
    const key = resolveBlobStorageKey(auth.workspaceId, scope, id);
    const expiresAt = new Date(Date.now() + deps.expiresInSec * 1000).toISOString();
    const downloadUrl = await deps.storage.presignGet(key, {
      expiresInSec: deps.expiresInSec,
      responseContentType: file.mimeType,
      responseContentDisposition: buildContentDisposition('attachment', basename(path)),
    });
    return { fileVersion: formatFileVersion(scope, id), downloadUrl, expiresAt };
  }

  if (mode === 'download') return { ...info, ...await download(file.blobScope, file.sha256) };
  if (mode === 'sync') {
    if (query.fromFileVersion === fileVersion) return { ...info, patches: [] };
    if (deps.files.textPatchWrites && file.blobScope === 'patch') {
      const chain = await loadTextRevisionChain(deps.db, auth.workspaceId, file.sha256, query.fromFileVersion, Math.min(256 * 1024, file.sizeBytes));
      if (chain) {
        const base = chain.base;
        const held = formatFileVersion(base.scope, base.id) === query.fromFileVersion;
        return { ...info, ...(held ? {} : { baseline: await download(base.scope, base.id) }), patches: chain.changes };
      }
    }
    return { ...info, baseline: await download(file.blobScope, file.sha256), patches: [] };
  }
  if (!file.isText) throw new CloudError('INVALID_ARGUMENT', 'Use file.mode=download for a binary file.', { status: 415 });
  const content = await deps.files.readTextBlob(auth.workspaceId, file.blobScope, file.sha256);
  // Preserve UTF-16 indexing of the original MCP file reader. Returned fileVersion pins subsequent pages.
  const offset = query.offset ?? 0;
  const sliced = content.slice(offset, offset + (query.length ?? 200_000));
  const nextOffset = offset + sliced.length;
  if (nextOffset < content.length) await retainVersion();
  return { ...info, offset, length: sliced.length, totalLength: content.length,
    truncated: nextOffset < content.length, ...(nextOffset < content.length && { nextOffset }), content: sliced };
}
