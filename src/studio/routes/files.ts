import { ORDERED_TEXT_EDITS_HEADER } from '../../../shared/ordered-text-edits.ts';
import { commitOrderedTextEdits } from '../../services/ordered-text-edits.ts';
import { TEXT_PATCH_BASE_HEADER } from '../../../shared/text-patch.ts';
import { isUuid } from '../../../shared/project-validation.ts';
import { commitProjectEdit } from '../../services/project-edit.ts';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { routePath } from 'hono/route';
import { PROJECT_SOURCE_ROUTE } from '../../../shared/project-source-url.ts';
import { bodyLimit } from 'hono/body-limit';
import { CloudError, isCloudError } from '../../contracts/errors.ts';
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '../../../shared/asset-names.ts';
import { MAX_ASSET_BYTES } from '../../../shared/asset-limits.ts';
import {
  buildMediaProbeJobId,
  buildPreviewProxyJobId,
  buildWaveformPeaksJobId,
} from '../../infra/queues.ts';
import { workspaceBlobKey } from '../../infra/storage.ts';
import { classifyPreviewProxyTarget } from '../../workers/media-ingest.ts';
import {
  isBinaryBuffer,
  normalizeSafeProjectPath,
  type ProjectFileOp,
} from '../../services/project-files-service.ts';
import {
  studioWriteHistory,
  extractWildcardPath,
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import { rewritePathReferencesInText } from '../engine/source-mutations.ts';
import {
  DELETED_VERSION,
  createWriteToken,
  formatFileVersion,
  formatVersionFromSha256,
  getMimeType,
  sha256Hex,
} from '../etag.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STRIPPED_PNG_COLOR_CHUNKS = new Set(['cICP', 'iCCP', 'gAMA', 'cHRM', 'sRGB']);

/**
 * Pure in-memory PNG SDR color-tag stripper (removes non-essential color-profile chunks that cause
 * macOS/Chrome gamma mismatches on uploaded PNG assets without invoking native image binaries).
 */
function stripSdrPngColourTags(buffer: Buffer): Buffer {
  if (buffer.byteLength < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return buffer;
  }
  const chunks: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let strippedAny = false;

  while (offset + 12 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.byteLength) return buffer;
    if (STRIPPED_PNG_COLOR_CHUNKS.has(type)) {
      strippedAny = true;
    } else {
      chunks.push(buffer.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
    if (type === 'IEND') break;
  }

  return strippedAny ? Buffer.concat(chunks) : buffer;
}

async function readUploadBodyText(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const parsed = (await request.json().catch(() => null)) as { content?: unknown } | null;
    if (!parsed || typeof parsed.content !== 'string') {
      throw new CloudError('INVALID_ARGUMENT', 'JSON body must include string field "content".', {
        status: 400,
        applied: false,
      });
    }
    return parsed.content;
  }
  return request.text();
}

async function buildConflictPayload(
  deps: DisklessStudioDeps,
  workspaceId: string,
  error: CloudError,
): Promise<Record<string, unknown>> {
  const details = (error.details ?? {}) as {
    path?: string;
    currentVersion?: string | null;
    currentSha256?: string | null;
    currentBlobScope?: 'workspace' | 'catalog' | 'patch' | null;
    currentIsText?: boolean;
  };
  let currentContent: string | null = null;
  if (details.currentIsText && details.currentSha256 && details.currentBlobScope) {
    currentContent = await deps.files
      .readTextBlob(workspaceId, details.currentBlobScope, details.currentSha256)
      .catch(() => null);
  }
  return {
    error: 'file conflict',
    code: 'VERSION_MISMATCH',
    path: details.path ?? null,
    currentVersion: details.currentVersion ?? null,
    currentContent,
  };
}

export function createStudioFilesRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // A filename ending in .svg/.css/.js must not make the current project version an edge-cached asset.
  app.on('GET', [PROJECT_SOURCE_ROUTE, '/api/projects/:id/files/*'], async (c) => {
    c.header('Cache-Control', 'private, no-cache');
    c.header('CDN-Cache-Control', 'no-store');
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const rawPath = routePath(c) === PROJECT_SOURCE_ROUTE ? c.req.query('path') ?? '' : extractWildcardPath(c.req.url, '/files/');
    const safePath = normalizeSafeProjectPath(rawPath);
    if (deps.files.textPatchWrites) {
      c.header('X-OpenMotion-Text-Edits', '1');
    }
    c.header(ORDERED_TEXT_EDITS_HEADER, '1');
    c.header('Vary', deps.files.textPatchWrites ? `Cookie, Authorization, ${TEXT_PATCH_BASE_HEADER}` : 'Cookie, Authorization');
    const optional = c.req.query('optional') === '1' || c.req.query('optional') === 'true';

    const file = await deps.files.getFile(auth, projectId, safePath);
    if (!file) {
      if (optional) {
        return c.json({
          filename: path.posix.basename(safePath),
          path: safePath,
          content: '',
          version: null,
          missing: true,
        });
      }
      return c.json({ error: 'File not found', path: safePath }, 404);
    }

    const version = formatFileVersion(file.blobScope, file.sha256);
    if (c.req.query('view') === 'metadata') {
      c.header('ETag', version);
      return c.json({ path: safePath, version, mimeType: file.mimeType, isText: file.isText });
    }
    if (!file.isText) {
      return c.json(
        {
          error: 'not a text file',
          why: 'binary',
          path: safePath,
          version,
        },
        415,
      );
    }

    // Always reauthorize and revalidate private sources. Identical content needs no second body.
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch && ifNoneMatch.trim() === version) {
      c.header('ETag', version);
      return c.body(null, 304);
    }

    const baseVersion = c.req.header(TEXT_PATCH_BASE_HEADER);
    if (deps.files.textPatchWrites && file.blobScope === 'patch' && baseVersion && /^"(?:sha256|patch):[a-f0-9]{64}"$/.test(baseVersion)) {
      const patch = await deps.files.readParentPatch(auth.workspaceId, projectId, file.sha256, baseVersion);
      if (patch) {
        c.header('X-OpenMotion-Representation', 'text-patch');
        c.header('ETag', version);
        return c.json({ path: safePath, baseVersion, version, patch });
      }
    }

    const content = await deps.files.readTextBlob(auth.workspaceId, file.blobScope, file.sha256);
    c.header('ETag', version);
    return c.json({
      filename: path.posix.basename(safePath),
      path: safePath,
      content,
      version,
      missing: false,
    });
  });

  // PUT /api/projects/:id/files/* — Optimistic-concurrency text write with If-Match / If-None-Match: *.
  app.put('/api/projects/:id/files/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const rawPath = extractWildcardPath(c.req.url, '/files/');
    const safePath = normalizeSafeProjectPath(rawPath, true);
    const ifMatch = c.req.header('if-match');
    const ifNoneMatch = c.req.header('if-none-match');
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));

    if (!ifMatch && !ifNoneMatch) {
      const existing = await deps.files.getFile(auth, projectId, safePath);
      let currentContent: string | null = null;
      if (existing && existing.isText) {
        currentContent = await deps.files
          .readTextBlob(auth.workspaceId, existing.blobScope, existing.sha256)
          .catch(() => null);
      }
      return c.json(
        {
          error: 'precondition required',
          code: 'PRECONDITION_REQUIRED',
          path: safePath,
          currentVersion: existing ? formatFileVersion(existing.blobScope, existing.sha256) : null,
          currentContent,
        },
        428,
      );
    }

    const content = await readUploadBodyText(c.req.raw);

    try {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [
          {
            op: 'upsert_text',
            path: safePath,
            content,
            stampHfIds: safePath.endsWith('.html') || safePath.endsWith('.htm'),
          },
        ],
        filePreconditions: [
          {
            path: safePath,
            ...(ifMatch ? { ifMatch } : {}),
            ...(ifNoneMatch ? { ifNoneMatch } : {}),
          },
        ],
        source: 'studio',
        ...studioWriteHistory(c.req.raw.headers),
        writeToken,
      });

      const version = committed.versionsByPath[safePath] ?? formatVersionFromSha256(sha256Hex(content));
      c.header('ETag', version);
      return c.json({
        ok: true,
        path: safePath,
        version,
        revision: committed.revision,
        versionId: committed.versionId,
        writeToken: committed.writeToken,
        backupPath: null,
      });
    } catch (error) {
      if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
        return c.json(await buildConflictPayload(deps, auth.workspaceId, error), 409);
      }
      throw error;
    }
  });

  app.post('/api/projects/:id/text-edits/batch', bodyLimit({maxSize: 32 * 1024 * 1024}), async c => {
    const auth = await getAuthContext(c, deps, {scope: 'projects:write', minRole: 'editor'});
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const outcome = await deps.files.withOrderedEditEvents(auth, projectId, events =>
      commitOrderedTextEdits(body, (edit, id) => deps.files.commitTextEdits(auth, projectId, edit, {
        requestId: id, source: 'studio', writeToken: id, events,
      }), deps.files.textPatchWrites));
    return c.json(outcome);
  });

  app.post('/api/projects/:id/text-edits', bodyLimit({maxSize: 32 * 1024 * 1024}), async c => {
    const auth = await getAuthContext(c, deps, {scope: 'projects:write', minRole: 'editor'});
    const requestId = c.req.header('idempotency-key') ?? '';
    const body = await c.req.json().catch(() => null);
    // Catalog placement also supports complete host text on deployments without patch storage.
    if (!deps.files.textPatchWrites && !(body?.installComponent && Array.isArray(body.files) &&
      body.files.every((file: {content?: unknown} | null) => typeof file?.content === 'string'))) {
      return c.json({error: 'Text patch writes are disabled'}, 503);
    }
    try {
      const commit = await deps.files.commitTextEdits(auth, c.req.param('id'), body, {
        requestId, source: 'studio', writeToken: createWriteToken(c.req.header('x-hyperframes-write-token')),
      });
      return c.json({versions: commit.versionsByPath, changedPaths: commit.changedPaths,
        versionId: commit.versionId, revision: commit.revision, writeToken: commit.writeToken});
    } catch (error) {
      if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
        const details = error.details ?? {};
        return c.json({code: error.code, applied: false, path: details.path, currentVersion: details.currentVersion}, 409);
      }
      throw error;
    }
  });

  const handleEdit = async (c: Context<{ Variables: StudioVariables }>, path?: string) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const body = await c.req.json().catch(() => null);
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        (path && (body.kind === 'batch' || (body.compositionPath !== undefined && body.compositionPath !== path))) ||
        (!path && (!body.versions || typeof body.versions !== 'object' || Array.isArray(body.versions) ||
          (body.undoGroup !== undefined && !isUuid(body.undoGroup))))) {
      return c.json({ error: 'Invalid editing command or base versions' }, 400);
    }
    const edit = path ? { ...body, compositionPath: path } : body.edit;
    const versions = path ? { [path]: c.req.header('if-match') ?? (c.req.header('if-none-match') === '*' ? null : '') } : body.versions;
    try {
      const commit = await commitProjectEdit(deps.files, auth, c.req.param('id')!, edit,
        c.req.header('idempotency-key') ?? '', { source: 'studio', versions, writeToken, windowId: c.req.header('x-openmotion-edit-window'),
          undoGroup: path ? undefined : body.undoGroup });
      return c.json({ ...(path && { version: commit.versionsByPath[path] ?? versions[path] }),
        versions: { ...versions, ...commit.versionsByPath }, changedPaths: commit.changedPaths, rebased: commit.commandResult?.rebased === true,
        revision: commit.revision, writeToken: commit.writeToken });
    } catch (error) {
      if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
        if (typeof error.details?.currentContent === 'string') return c.json(error.details, 409);
        return c.json(await buildConflictPayload(deps, auth.workspaceId, error), 409);
      }
      throw error;
    }
  };
  // Body limit matches the sibling text-edit routes: the edit payload is buffered in full before
  // the size is validated, so an unbounded body would exhaust the shared API process. The custom
  // onError keeps the repository error envelope instead of the middleware's bare HTTPException.
  const editBodyLimit = bodyLimit({
    maxSize: 32 * 1024 * 1024,
    onError: (c: Context<{ Variables: StudioVariables }>) =>
      c.json(new CloudError('INVALID_ARGUMENT', 'Payload Too Large', { status: 413, applied: false }).toJSON(), 413),
  });
  app.post('/api/projects/:id/edits', editBodyLimit, c => handleEdit(c));
  app.post('/api/projects/:id/edits/*', editBodyLimit, c => handleEdit(c,
    normalizeSafeProjectPath(extractWildcardPath(c.req.url, '/edits/'), true)));

  // POST /api/projects/:id/files/* — Create a new text file (409 if already exists).
  app.post('/api/projects/:id/files/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const rawPath = extractWildcardPath(c.req.url, '/files/');
    const safePath = normalizeSafeProjectPath(rawPath, true);
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const content = await readUploadBodyText(c.req.raw);

    try {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [
          {
            op: 'upsert_text',
            path: safePath,
            content,
            stampHfIds: safePath.endsWith('.html') || safePath.endsWith('.htm'),
          },
        ],
        filePreconditions: [{ path: safePath, ifNoneMatch: '*' }],
        source: 'studio',
        summary: `Created ${safePath}`,
        writeToken,
      });

      const version = committed.versionsByPath[safePath] ?? formatVersionFromSha256(sha256Hex(content));
      c.header('ETag', version);
      return c.json(
        {
          ok: true,
          path: safePath,
          version,
          revision: committed.revision,
          writeToken: committed.writeToken,
        },
        201,
      );
    } catch (error) {
      if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
        return c.json(await buildConflictPayload(deps, auth.workspaceId, error), 409);
      }
      throw error;
    }
  });

  // PATCH /api/projects/:id/files/* — Rename file or folder prefix and rewrite relative references in memory.
  app.patch('/api/projects/:id/files/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const rawOldPath = extractWildcardPath(c.req.url, '/files/');
    const oldPath = normalizeSafeProjectPath(rawOldPath);
    const body = (await c.req.json().catch(() => null)) as { newPath?: unknown } | null;
    if (!body || typeof body.newPath !== 'string' || !body.newPath.trim()) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain non-empty "newPath".', {
        status: 400,
        applied: false,
      });
    }
    const newPath = normalizeSafeProjectPath(body.newPath, true);
    if (oldPath === 'index.html') {
      throw new CloudError('INVALID_ARGUMENT', 'Cannot rename entry file index.html.', {
        status: 400,
        applied: false,
      });
    }

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const allFiles = virtual.listFiles();

    const matchedFiles = allFiles.filter(
      (f) => f.path === oldPath || f.path.startsWith(`${oldPath}/`),
    );
    if (matchedFiles.length === 0) {
      return c.json({ error: 'File or folder not found', path: oldPath }, 404);
    }

    const ops: ProjectFileOp[] = [];
    const renamePairs: Array<{ from: string; to: string }> = [];

    for (const file of matchedFiles) {
      const targetPath =
        file.path === oldPath ? newPath : normalizeSafeProjectPath(`${newPath}${file.path.slice(oldPath.length)}`, true);
      if (virtual.exists(targetPath) && !matchedFiles.some((m) => m.path === targetPath)) {
        return c.json({ error: 'Target path already exists', path: targetPath }, 409);
      }
      renamePairs.push({ from: file.path, to: targetPath });
      ops.push({ op: 'delete', path: file.path });
      ops.push({
        op: 'upsert_ref',
        path: targetPath,
        blobScope: file.blobScope,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        isText: file.isText,
        metadata: file.metadata,
      });
    }

    // Rewrite relative path references in remaining text files (HTML/CSS/JS/JSON).
    let updatedReferences = 0;
    const movedSourceSet = new Set(matchedFiles.map((f) => f.path));
    for (const file of allFiles) {
      if (!file.isText || movedSourceSet.has(file.path)) continue;
      const original = virtual.readText(file.path);
      if (!original) continue;
      let updated = original;
      for (const pair of renamePairs) {
        const nextText = rewritePathReferencesInText(updated, pair.from, pair.to, false);
        if (nextText !== updated) {
          updated = nextText;
          updatedReferences += 1;
        }
      }
      if (updated !== original) {
        ops.push({ op: 'upsert_text', path: file.path, content: updated });
      }
    }

    const committed = await deps.files.commitChanges(auth, {
      projectId,
      ops,
      source: 'studio',
      summary: `Renamed ${oldPath} to ${newPath}`,
      writeToken,
    });

    return c.json({
      ok: true,
      oldPath,
      newPath,
      path: newPath,
      updatedReferences,
      revision: committed.revision,
      writeToken: committed.writeToken,
    });
  });

  // DELETE /api/projects/:id/files/* — Delete file or folder prefix; cleans asset names & emits DELETED_VERSION.
  app.delete('/api/projects/:id/files/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const rawPath = extractWildcardPath(c.req.url, '/files/');
    const targetPath = normalizeSafeProjectPath(rawPath);

    if (targetPath === 'index.html') {
      return c.json({ error: 'Cannot delete index.html' }, 400);
    }

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const allFiles = await deps.files.listFiles(auth, projectId);
    const toDelete = allFiles.filter(
      (f) => f.path === targetPath || f.path.startsWith(`${targetPath}/`),
    );

    if (toDelete.length === 0) {
      return c.json({ error: 'File not found', path: targetPath }, 404);
    }

    const committed = await deps.files.commitChanges(auth, {
      projectId,
      ops: toDelete.map((f) => ({ op: 'delete' as const, path: f.path })),
      source: 'studio',
      summary: `Deleted ${targetPath}`,
      writeToken,
    });

    await deps.assetNames.cleanupDeletedPaths(
      auth,
      projectId,
      toDelete.map((f) => f.path),
    );

    return c.json({
      ok: true,
      path: targetPath,
      deletedPaths: toDelete.map((f) => f.path),
      version: DELETED_VERSION,
      revision: committed.revision,
      writeToken: committed.writeToken,
      backupPath: null,
    });
  });

  // POST /api/projects/:id/duplicate-file — Clone a project file into a unique sibling path via CAS ref.
  app.post('/api/projects/:id/duplicate-file', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; targetPath?: unknown } | null;
    if (!body || typeof body.path !== 'string' || !body.path.trim()) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "path".', { status: 400, applied: false });
    }
    const sourcePath = normalizeSafeProjectPath(body.path);
    const allFiles = await deps.files.listFiles(auth, projectId);
    const existingSet = new Set(allFiles.map((f) => f.path));
    const source = allFiles.find((f) => f.path === sourcePath);
    if (!source) {
      return c.json({ error: 'Source file not found', path: sourcePath }, 404);
    }

    let destination: string;
    if (typeof body.targetPath === 'string' && body.targetPath.trim()) {
      destination = normalizeSafeProjectPath(body.targetPath, true);
      if (existingSet.has(destination)) {
        return c.json({ error: 'Destination path already exists', path: destination }, 409);
      }
    } else {
      const ext = path.posix.extname(sourcePath);
      const stem = ext ? sourcePath.slice(0, -ext.length) : sourcePath;
      let idx = 1;
      destination = `${stem}-copy${ext}`;
      while (existingSet.has(destination)) {
        idx++;
        destination = `${stem}-copy-${idx}${ext}`;
      }
      destination = normalizeSafeProjectPath(destination, true);
    }

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const committed = await deps.files.commitChanges(auth, {
      projectId,
      ops: [
        {
          op: 'upsert_ref',
          path: destination,
          blobScope: source.blobScope,
          sha256: source.sha256,
          sizeBytes: source.sizeBytes,
          mimeType: source.mimeType,
          isText: source.isText,
          metadata: source.metadata,
        },
      ],
      source: 'studio',
      summary: `Duplicated ${sourcePath} to ${destination}`,
      writeToken,
    });

    return c.json(
      {
        ok: true,
        sourcePath,
        path: destination,
        version: formatFileVersion(source.blobScope, source.sha256),
        revision: committed.revision,
        writeToken: committed.writeToken,
      },
      201,
    );
  });

  // POST /api/projects/:id/upload — Multipart asset upload directly to S3 CAS (zero local disk).
  app.post(
    '/api/projects/:id/upload',
    bodyLimit({
      maxSize: MAX_ASSET_BYTES,
      onError: (c) =>
        c.json({ error: 'Upload exceeds 500 MB (500000000 bytes)', maxBytes: MAX_ASSET_BYTES }, 413),
    }),
    async (c) => {
      const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
      const projectId = c.req.param('id');
      const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));

      const form = await c.req.formData();
      const uploadedFiles = form.getAll('file').filter((entry): entry is File => entry instanceof File);
      if (uploadedFiles.length === 0) {
        throw new CloudError('INVALID_ARGUMENT', 'Multipart form must include at least one "file" field.', {
          status: 400,
          applied: false,
        });
      }

      const queryDir = c.req.query('dir');
      const formDir = form.get('directory');
      const rawDir =
        typeof queryDir === 'string' && queryDir.trim()
          ? queryDir.trim()
          : typeof formDir === 'string' && formDir.trim()
            ? formDir.trim()
            : 'assets';
      const rawTarget =
        uploadedFiles.length === 1 && typeof form.get('path') === 'string'
          ? String(form.get('path')).trim()
          : '';

      const ops: ProjectFileOp[] = [];
      const prepared: Array<{
        path: string;
        size: number;
        mimeType: string;
        sha256: string;
        version: string;
        isText: boolean;
      }> = [];
      let totalBytes = 0;

      for (const uploadedFile of uploadedFiles) {
        const safeFileName = path.posix
          .basename(uploadedFile.name || 'asset.bin')
          .replace(/[\x00-\x1f/\\]/g, '_');
        const cleanedDir = rawDir.replace(/^\/+|\/+$/g, '');
        const candidatePath = rawTarget || (cleanedDir ? `${cleanedDir}/${safeFileName}` : safeFileName);
        const safePath = normalizeSafeProjectPath(candidatePath, true);

        let data: Buffer = Buffer.from(await uploadedFile.arrayBuffer());
        const mimeType = uploadedFile.type || getMimeType(safePath);
        if (mimeType === 'image/png' || safePath.toLowerCase().endsWith('.png')) {
          data = stripSdrPngColourTags(data);
        }

        const sha256 = sha256Hex(data);
        const isText = !isBinaryBuffer(data) && getMimeType(safePath).startsWith('text/');
        totalBytes += data.byteLength;

        ops.push({
          op: 'upsert_binary',
          path: safePath,
          data,
          mimeType,
        });
        prepared.push({
          path: safePath,
          size: data.byteLength,
          mimeType,
          sha256,
          version: formatVersionFromSha256(sha256),
          isText,
        });
      }

      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops,
        source: 'studio',
        summary:
          prepared.length === 1
            ? `Uploaded ${prepared[0].path}`
            : `Uploaded ${prepared.length} files`,
        writeToken,
      });

      // Warm editing metadata, waveforms and proxies. Thumbnails and sprites are generated on request.
      if (deps.queues) {
        for (const item of prepared) {
          if (item.isText) continue;
          const s3Key = workspaceBlobKey(auth.workspaceId, item.sha256);
          const isVideo = VIDEO_EXT.test(item.path);
          const isAudio = AUDIO_EXT.test(item.path);
          const isImage = IMAGE_EXT.test(item.path);

          if (isVideo || isAudio || isImage) {
            void deps.queues
              .enqueueMediaIngest(
                'media_probe',
                {
                  workspaceId: auth.workspaceId,
                  blobScope: 'workspace',
                  sha256: item.sha256,
                  s3Key,
                  projectId,
                },
                { jobId: buildMediaProbeJobId(auth.workspaceId, item.sha256) },
              )
              .catch(() => {});
          }
          if (isAudio || isVideo) {
            void deps.queues
              .enqueueMediaIngest(
                'extract_waveform_peaks',
                {
                  workspaceId: auth.workspaceId,
                  blobScope: 'workspace',
                  sha256: item.sha256,
                  projectId,
                  samples: 2048,
                },
                { jobId: buildWaveformPeaksJobId(auth.workspaceId, item.sha256) },
              )
              .catch(() => {});
          }
          const proxyTarget = classifyPreviewProxyTarget({
            mimeType: item.mimeType,
            sizeBytes: item.size,
          });
          if (proxyTarget) {
            void deps.queues
              .enqueueMediaIngest(
                'generate_preview_proxy',
                {
                  kind: 'generate_preview_proxy',
                  workspaceId: auth.workspaceId,
                  sha256: item.sha256,
                  projectId,
                  mimeType: item.mimeType,
                  sizeBytes: item.size,
                },
                { jobId: buildPreviewProxyJobId(auth.workspaceId, item.sha256) },
              )
              .catch(() => {});
          }
        }
      }

      const first = prepared[0];
      const uploadedPaths = prepared.map((p) => p.path);
      return c.json(
        {
          ok: true,
          files: uploadedPaths,
          path: first.path,
          size: totalBytes,
          mimeType: first.mimeType,
          sha256: first.sha256,
          version: first.version,
          uploaded: prepared.map((p) => ({
            path: p.path,
            size: p.size,
            mimeType: p.mimeType,
            sha256: p.sha256,
            version: p.version,
          })),
          revision: committed.revision,
          writeToken: committed.writeToken,
        },
        201,
      );
    },
  );

  return app;
}
