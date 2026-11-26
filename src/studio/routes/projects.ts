import { createHash } from 'node:crypto';
import { decodeAuthoredAttribute, scanHtmlOpeningTags } from '@hyperframes/parsers';
import { decodedUrlPath } from '@hyperframes/parsers/asset-paths';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { FONT_EXT } from '../../../shared/asset-names.ts';
import { extractIndexHeadMarkup, isNonVisualPreviewFile } from '../../../shared/preview-impact.ts';
import {
  isStyleOrScriptCodePath,
  isVendorOrMinifiedScriptPath,
  isVisualMediaPath,
  resolveReferencedVisualMediaPaths,
} from '../engine/composition-filmstrip-sprite.ts';
import { uploadTickets } from '../../db/schema/blobs-assets.ts';
import { jobs } from '../../db/schema/jobs.ts';
import type { AuthContext } from '../../contracts/auth.ts';
import type { FontMetadataEntry } from '../../services/asset-names-service.ts';
import {
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import { infoInMemory } from '../engine/inspect.ts';
import { formatFileVersion, hashIndexHeadMarkup } from '../etag.ts';
import {
  type VirtualFileRecord,
  listVirtualCompositions,
  resolveVirtualPath,
  virtualDirname,
} from '../virtual-project-store.ts';
import { classifyPreviewProxyTarget } from '../../workers/media-ingest.ts';

// Detect inline runtime patterns that can load another HTML composition outside
// static `data-composition-src` attributes (e.g. `fetch("compositions/child.html")`,
// `XMLHttpRequest`, dynamic `import()`, or embedded `<iframe>`/`<object>`/`<embed>`).
// Standard GSAP / Canvas / SVG animation `<script>` blocks and vendored `<script src>`
// tags (whose files are already hashed into `sharedTag`) remain safely cacheable.
const DYNAMIC_EMBED_TAG_RE = /<(?:iframe|object|embed)\b/i;
const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const DYNAMIC_SCRIPT_LOAD_RE =
  /\b(?:fetch|XMLHttpRequest|EventSource|WebSocket)\b|\bimport\s*\(|\.html?\b/i;
const DYNAMIC_HANDLER_RE =
  /\bon[a-z]+\s*=\s*(?:"[^"]*(?:fetch|XMLHttpRequest|import\s*\(|\.html?\b)[^"]*"|'[^']*(?:fetch|XMLHttpRequest|import\s*\(|\.html?\b)[^']*')/i;

function hasDynamicCompositionInputs(html: string): boolean {
  if (DYNAMIC_EMBED_TAG_RE.test(html)) return true;
  if (DYNAMIC_HANDLER_RE.test(html)) return true;
  SCRIPT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_BLOCK_RE.exec(html)) !== null) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    if (/\.html?\b/i.test(attrs) || (body && DYNAMIC_SCRIPT_LOAD_RE.test(body))) {
      return true;
    }
  }
  return false;
}

function resolveNestedCompositionRef(
  owner: string,
  rawRef: string,
  byPath: ReadonlyMap<string, string>,
): string | null {
  const trimmed = rawRef.trim();
  if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed)) return null;
  const pathOnly = decodedUrlPath(trimmed.split(/[?#]/)[0] ?? '');
  if (!pathOnly) return null;
  const local = resolveVirtualPath(virtualDirname(owner), pathOnly);
  if (local && byPath.has(local)) return local;
  const fromRoot = resolveVirtualPath('', pathOnly);
  if (fromRoot && byPath.has(fromRoot)) return fromRoot;
  return null;
}

/**
 * Collect the transitive `data-composition-src` dependency closure for `rootComp`.
 * Returns `null` (fail closed to `projectRevision`) when sources cannot be read,
 * a `data-composition-src` reference cannot be resolved in the project file list,
 * or markup contains dynamic document/runtime loading (e.g. `fetch(...)`, `import()`,
 * `XMLHttpRequest`, or `<iframe>`).
 */
function collectNestedCompositionDeps(
  rootComp: string,
  byPath: ReadonlyMap<string, string>,
  readText?: (filePath: string) => string | null,
): string[] | null {
  if (!readText) return null;
  const visited = new Set<string>([rootComp]);
  const queue: string[] = [rootComp];
  const deps: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const html = readText(current);
    if (html === null) return null;
    if (hasDynamicCompositionInputs(html)) return null;
    if (!/data-composition-src/i.test(html)) continue;
    for (const tag of scanHtmlOpeningTags(html)) {
      const attr = tag.attributes.find((a) => a.name.toLowerCase() === 'data-composition-src');
      if (!attr) continue;
      if (attr.kind !== 'value') return null;
      const target = resolveNestedCompositionRef(current, decodeAuthoredAttribute(attr.value), byPath);
      if (!target) return null;
      if (visited.has(target)) continue;
      visited.add(target);
      deps.push(target);
      queue.push(target);
    }
  }
  return deps.sort((a, b) => a.localeCompare(b));
}

/**
 * Compute per-composition cache revisions combining each composition file's own
 * persisted content version (`formatFileVersion(blobScope, sha256)`) with its
 * transitive `data-composition-src` closure (`|deps:`) and a shared render tag
 * covering `index.html`'s `<head>` (ignoring `<body>` clip timing edits) and
 * non-composition shared project files (CSS, images, fonts, scripts).
 *
 * Moving, trimming, or splitting clips in `index.html <body>` and editing sibling
 * compositions preserve untouched scenes' exact revision tokens across live edits
 * and page reloads, while shared CSS/asset/`<head>` edits invalidate cleanly and
 * unreadable, unresolved, or dynamically-fetching compositions fail closed to
 * `projectRevision`.
 */
export function computeCompositionRevisions(
  fileList: ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly blobScope?: string }>,
  compositions: readonly string[],
  indexHtml: string | null = null,
  projectRevision = '',
  readText?: (filePath: string) => string | null,
): Record<string, string> {
  const indexHead = extractIndexHeadMarkup(indexHtml);
  const headHasDynamicLoads = hasDynamicCompositionInputs(indexHead);
  const indexHeadHash = hashIndexHeadMarkup(indexHtml);
  const compSet = new Set(compositions);
  const byPath = new Map<string, string>();
  const sharedNonMediaHash = createHash('sha256');
  const sharedAllVisualHash = createHash('sha256');
  const sorted = [...fileList].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    const scope =
      file.blobScope === 'patch' || file.blobScope === 'catalog' || file.blobScope === 'workspace'
        ? file.blobScope
        : 'workspace';
    const version = formatFileVersion(scope, file.sha256);
    byPath.set(file.path, version);
    if (file.path !== 'index.html' && !compSet.has(file.path) && !isNonVisualPreviewFile(file.path)) {
      sharedAllVisualHash.update(file.path);
      sharedAllVisualHash.update(':');
      sharedAllVisualHash.update(version);
      sharedAllVisualHash.update('\n');
      if (!isVisualMediaPath(file.path)) {
        sharedNonMediaHash.update(file.path);
        sharedNonMediaHash.update(':');
        sharedNonMediaHash.update(version);
        sharedNonMediaHash.update('\n');
      }
    }
  }
  const sharedNonMediaTag = `${indexHeadHash}:${sharedNonMediaHash.digest('hex').slice(0, 12)}`;
  const sharedAllVisualTag = `${indexHeadHash}:${sharedAllVisualHash.digest('hex').slice(0, 12)}`;
  const readCompositionText = readText
    ? (filePath: string) => {
        const text = readText(filePath);
        if (text !== null) return text;
        return filePath === 'index.html' ? indexHtml : null;
      }
    : undefined;
  const revisions: Record<string, string> = {};
  for (const comp of compositions) {
    if (headHasDynamicLoads) {
      revisions[comp] = projectRevision;
      continue;
    }
    const ownVersion = byPath.get(comp);
    if (!ownVersion) {
      revisions[comp] = projectRevision;
      continue;
    }
    const nestedDeps = collectNestedCompositionDeps(comp, byPath, readCompositionText);
    if (nestedDeps === null) {
      revisions[comp] = projectRevision;
      continue;
    }
    const includedComps = new Set<string>(nestedDeps);
    const referencedMedia = resolveReferencedVisualMediaPaths({
      compPath: comp,
      includedComps,
      files: sorted,
      indexHead: indexHtml !== null ? indexHead : null,
      readText: readCompositionText,
    });
    const sharedTag = referencedMedia !== null ? sharedNonMediaTag : sharedAllVisualTag;
    let mediaPart = '';
    if (referencedMedia !== null && referencedMedia.size > 0) {
      const mediaHash = createHash('sha256');
      for (const mediaPath of [...referencedMedia].sort((a, b) => a.localeCompare(b))) {
        mediaHash.update(mediaPath);
        mediaHash.update(':');
        mediaHash.update(byPath.get(mediaPath) ?? '');
        mediaHash.update('\n');
      }
      mediaPart = `|media:${mediaHash.digest('hex').slice(0, 12)}`;
    }
    if (nestedDeps.length === 0) {
      revisions[comp] = `${ownVersion}${mediaPart}|shared:${sharedTag}`;
      continue;
    }
    const nestedHash = createHash('sha256');
    for (const dep of nestedDeps) {
      nestedHash.update(dep);
      nestedHash.update(':');
      nestedHash.update(byPath.get(dep) ?? '');
      nestedHash.update('\n');
    }
    revisions[comp] = `${ownVersion}|deps:${nestedHash.digest('hex').slice(0, 12)}${mediaPart}|shared:${sharedTag}`;
  }
  return revisions;
}

// Captions depend on paths, the two naming manifests and font contents. Other
// content edits leave these details unchanged when an editor refreshes its tree.
function assetDetailsKey(files: readonly VirtualFileRecord[], language: string | null): string {
  const hash = createHash('sha256').update(JSON.stringify(language));
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const includeContent = FONT_EXT.test(file.path) || file.path === 'motion-assets.json' || file.path === 'motion-project.json';
    hash.update(JSON.stringify([file.path, includeContent ? file.sha256 : null]));
  }
  return hash.digest('hex');
}

async function readAssetDetails(
  deps: DisklessStudioDeps, auth: AuthContext, projectId: string, fileList: readonly VirtualFileRecord[],
) {
  const projectFonts: Array<FontMetadataEntry & { postscriptName?: string }> = [];
  if (deps.fontCatalog) {
    for (const file of fileList) {
      if (!FONT_EXT.test(file.path)) continue;
      try {
        const bytes = await deps.files.readBinaryBlob(auth.workspaceId, file.blobScope, file.sha256);
        const meta = deps.fontCatalog.inspectBuffer(bytes);
        if (meta) {
          projectFonts.push({ ...meta, path: file.path });
        }
      } catch {
        // Invalid font assets remain listed in files but are skipped from selectable fonts.
      }
    }
  }

  const assetNameInfo = await deps.assetNames.readAssetNames(auth, projectId, {
    paths: fileList.map(file => file.path),
    fonts: projectFonts,
  });
  return { fonts: projectFonts, assetNames: assetNameInfo.assetNames, namingLanguage: assetNameInfo.namingLanguage };
}

export function createStudioProjectsRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // GET /api/projects — List non-trashed workspace projects (virtual descriptors, zero local paths).
  app.get('/api/projects', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const catalog = await deps.workspace.getCatalog(auth);
    return c.json({
      activeId: catalog.activeId,
      projects: catalog.projects.map((p) => ({
        id: p.id,
        title: p.title,
        name: p.title,
        dir: `/virtual/${p.id}`,
        templateId: p.templateId,
        createdAt: p.createdAt,
        openedAt: p.openedAt,
      })),
    });
  });

  // GET /api/projects/:id — Full Studio project payload (virtual files, compositions, fonts, assetNames, info).
  app.get('/api/projects/:id', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const detail = await deps.workspace.getProject(auth, projectId, { allowTrashed: true });
    const view = c.req.query('view');
    if (view === 'asset-details') {
      const files = await deps.files.listFiles(auth, projectId);
      return c.json({ assetDetailsKey: assetDetailsKey(files, detail.namingLanguage), ...await readAssetDetails(deps, auth, projectId, files) });
    }
    const editor = view === 'editor';
    const virtual = await deps.files.loadVirtualProject(
      auth,
      projectId,
      editor
        ? (filePath) =>
            /\.html?$/i.test(filePath) ||
            (isStyleOrScriptCodePath(filePath) && !isVendorOrMinifiedScriptPath(filePath))
        : undefined,
    );
    const fileList = virtual.listFiles();
    const filePaths = fileList.map((f) => f.path);
    const compositions = listVirtualCompositions(fileList);
    const revision = editor ? virtual.revision : detail.revision;
    const compositionRevisions = computeCompositionRevisions(
      fileList,
      compositions,
      virtual.readText('index.html'),
      revision,
      (filePath) => virtual.readText(filePath),
    );
    const info = editor ? null : infoInMemory(virtual);

    const deferredDetails = editor && deps.fontCatalog && fileList.some(file => FONT_EXT.test(file.path));
    const assetDetails = deferredDetails
      ? { assetDetailsKey: assetDetailsKey(fileList, detail.namingLanguage) }
      : await readAssetDetails(deps, auth, projectId, fileList);

    const assetMetadata: Record<
      string,
      {
        version?: string;
        mimeType?: string;
        duration?: number;
        width?: number;
        height?: number;
        hasAudio?: boolean;
        hasVideo?: boolean;
        proxyStatus?: 'ready' | 'failed';
        spriteStatus?: 'ready' | 'failed';
        waveformReady?: boolean;
        thumbnailReady?: boolean;
        optimizationStatus?: 'optimizing' | 'ready';
      }
    > = {};
    for (const file of fileList) {
      const binaryInput = deps.files.textPatchWrites && !file.isText;
      if (!file.metadata && !binaryInput) continue;
      const meta = file.metadata ?? {};
      const previewProxy = (meta as { previewProxy?: { status?: 'ready' | 'failed' } }).previewProxy;
      let optimizationStatus: 'optimizing' | 'ready' | undefined;
      if (file.metadata && file.blobScope === 'workspace') {
        const mime = (meta.mimeType ?? file.mimeType ?? '').toLowerCase();
        const proxyTarget = classifyPreviewProxyTarget({
          mimeType: mime,
          sizeBytes: file.sizeBytes,
          width: meta.width,
          height: meta.height,
        });
        const proxySettled =
          !proxyTarget || previewProxy?.status === 'ready' || previewProxy?.status === 'failed';
        const isVideo = meta.modality === 'video' || mime.startsWith('video/');
        const isImage = meta.modality === 'image' || mime.startsWith('image/');
        if (isVideo || (isImage && proxyTarget)) {
          optimizationStatus = proxySettled ? 'ready' : 'optimizing';
        } else if (meta.modality === 'audio' || mime.startsWith('audio/')) {
          const waveformSettled =
            (typeof meta.waveformPeaksKey === 'string' && meta.waveformPeaksKey.length > 0) ||
            meta.waveformFailed === true;
          optimizationStatus = waveformSettled && proxySettled ? 'ready' : 'optimizing';
        }
      }
      const entry: (typeof assetMetadata)[string] = {
        ...(binaryInput && { version: formatFileVersion(file.blobScope, file.sha256), mimeType: file.mimeType }),
        ...(typeof meta.durationSec === 'number' && Number.isFinite(meta.durationSec)
          ? { duration: meta.durationSec }
          : {}),
        ...(typeof meta.width === 'number' && Number.isFinite(meta.width) ? { width: meta.width } : {}),
        ...(typeof meta.height === 'number' && Number.isFinite(meta.height) ? { height: meta.height } : {}),
        ...(typeof meta.hasAudio === 'boolean' ? { hasAudio: meta.hasAudio } : {}),
        ...(typeof meta.hasVideo === 'boolean' ? { hasVideo: meta.hasVideo } : {}),
        ...(previewProxy?.status === 'ready' || previewProxy?.status === 'failed'
          ? { proxyStatus: previewProxy.status }
          : {}),
        ...(meta.sprite?.status === 'ready' || meta.sprite?.status === 'failed'
          ? { spriteStatus: meta.sprite.status }
          : {}),
        ...(typeof meta.waveformPeaksKey === 'string' && meta.waveformPeaksKey.length > 0
          ? { waveformReady: true }
          : {}),
        ...(meta.thumbnailReady === true ? { thumbnailReady: true } : {}),
        ...(optimizationStatus ? { optimizationStatus } : {}),
      };
      if (Object.keys(entry).length > 0) {
        assetMetadata[file.path] = entry;
      }
    }

    // Pending MCP / external media imports for reload-resilient sidebar placeholder cards (Option A).
    const pendingImports: Array<{
      id: string;
      ticketId?: string;
      jobId?: string;
      filename: string;
      targetPath?: string;
      bytes?: number;
      source: 'mcp_upload' | 'mcp_url' | 'web_upload';
      state: 'waiting_upload' | 'processing';
      stage?: string;
      progress?: number;
      expiresAt?: string;
      updatedAt: number;
    }> = [];
    try {
      const now = new Date();
      const freshIngestCutoff = new Date(now.getTime() - 15 * 60_000);
      const [activeTickets, activeJobs] = await Promise.all([
        deps.db
          .select()
          .from(uploadTickets)
          .where(
            and(
              eq(uploadTickets.workspaceId, auth.workspaceId),
              eq(uploadTickets.targetProjectId, projectId),
              inArray(uploadTickets.state, ['issued', 'uploaded', 'processing']),
              gt(uploadTickets.expiresAt, now),
            ),
          )
          .orderBy(desc(uploadTickets.createdAt))
          .limit(30),
        deps.db
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.workspaceId, auth.workspaceId),
              eq(jobs.projectId, projectId),
              eq(jobs.kind, 'media_ingest'),
              inArray(jobs.state, ['queued', 'running']),
              gt(jobs.updatedAt, freshIngestCutoff),
            ),
          )
          .orderBy(desc(jobs.createdAt))
          .limit(30),
      ]);

      const jobsByUploadId = new Map<string, (typeof activeJobs)[number]>();
      for (const job of activeJobs) {
        const payload = (job.inputPayload ?? {}) as Record<string, unknown>;
        if (typeof payload.uploadId === 'string') {
          jobsByUploadId.set(payload.uploadId, job);
        }
      }
      const seenJobIds = new Set<string>();
      for (const ticket of activeTickets) {
        const linkedJob = jobsByUploadId.get(ticket.id);
        if (linkedJob) seenJobIds.add(linkedJob.id);
        const isProcessing = ticket.state === 'processing' || ticket.state === 'uploaded' || Boolean(linkedJob);
        const ticketResult = (ticket.resultPayload ?? {}) as Record<string, unknown>;
        const source: 'mcp_upload' | 'mcp_url' | 'web_upload' =
          ticketResult.source === 'mcp_upload' ? 'mcp_upload' : 'web_upload';
        pendingImports.push({
          id: linkedJob?.id ?? ticket.id,
          ticketId: ticket.id,
          ...(linkedJob ? { jobId: linkedJob.id } : {}),
          filename: ticket.filename,
          ...(ticket.targetPath ? { targetPath: ticket.targetPath } : {}),
          bytes: Number(ticket.maxBytes),
          source,
          state: isProcessing ? 'processing' : 'waiting_upload',
          ...(linkedJob?.stage ? { stage: linkedJob.stage } : {}),
          ...(linkedJob ? { progress: Number(linkedJob.progress ?? 0) } : {}),
          expiresAt: ticket.expiresAt.toISOString(),
          updatedAt: (linkedJob?.updatedAt ?? ticket.updatedAt).getTime(),
        });
      }
      for (const job of activeJobs) {
        if (seenJobIds.has(job.id)) continue;
        const payload = (job.inputPayload ?? {}) as Record<string, unknown>;
        const kind = typeof payload.kind === 'string' ? payload.kind : typeof payload.operation === 'string' ? payload.operation : '';
        const explicitSource = payload.source;
        const source: 'mcp_upload' | 'mcp_url' | 'web_upload' =
          explicitSource === 'mcp_upload' || explicitSource === 'mcp_url' || explicitSource === 'web_upload'
            ? explicitSource
            : kind === 'url' || kind === 'url_fetch'
              ? 'mcp_url'
              : kind === 'upload_commit'
                ? 'web_upload'
                : 'mcp_upload';
        const filename =
          (typeof payload.name === 'string' && payload.name) ||
          (typeof payload.targetPath === 'string' && payload.targetPath.split('/').pop()) ||
          'Importing media';
        pendingImports.push({
          id: job.id,
          jobId: job.id,
          filename,
          ...(typeof payload.targetPath === 'string' ? { targetPath: payload.targetPath } : {}),
          source,
          state: 'processing',
          ...(job.stage ? { stage: job.stage } : {}),
          progress: Number(job.progress ?? 0),
          updatedAt: job.updatedAt.getTime(),
        });
      }
    } catch {
      // Non-fatal: partial DB mocks in isolated unit tests may omit upload_tickets/jobs tables.
    }

    return c.json({
      id: detail.id,
      name: detail.title,
      title: detail.title,
      dir: `/virtual/${detail.id}`,
      revision,
      ...(editor ? { entryVersion: virtual.getFileVersion('index.html') } : {}),
      compositionRevisions,
      versionId: detail.currentVersionId,
      versionNumber: detail.currentVersionNumber,
      historySeq: detail.currentHistorySeq,
      files: filePaths,
      compositions,
      ...assetDetails,
      assetMetadata,
      pendingImports,
      ...(info ? { width: info.width, height: info.height, fps: info.fps, duration: info.duration, resolution: info.resolution } : {}),
    });
  });

  // GET /api/projects/:id/signature — Canonical project signature / revision for polling & preview invalidation.
  app.get('/api/projects/:id/signature', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const detail = await deps.workspace.getProject(auth, projectId, { allowTrashed: true });
    const fileList = await deps.files.listFiles(auth, projectId, { allowTrashed: true });
    return c.json({
      signature: detail.revision,
      revision: detail.revision,
      versionId: detail.currentVersionId,
      versionNumber: detail.currentVersionNumber,
      fileCount: fileList.length,
    });
  });

  // GET /api/projects/:id/files — Detailed file listing with strong ETags & types.
  app.get('/api/projects/:id/files', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const detail = await deps.workspace.getProject(auth, projectId, { allowTrashed: true });
    const fileList = await deps.files.listFiles(auth, projectId, { allowTrashed: true });
    const compositions = listVirtualCompositions(fileList);
    const assetNameInfo = await deps.assetNames.readAssetNames(auth, projectId, {
      paths: fileList.map((f) => f.path),
    });

    return c.json({
      dir: `/virtual/${detail.id}`,
      revision: detail.revision,
      compositions,
      assetNames: assetNameInfo.assetNames,
      files: fileList.map((f) => ({
        path: f.path,
        size: f.sizeBytes,
        type: f.mimeType,
        isText: f.isText,
        version: formatFileVersion(f.blobScope, f.sha256),
        modifiedAt: f.updatedAt.toISOString(),
        metadata: f.metadata ?? null,
      })),
    });
  });

  return app;
}
