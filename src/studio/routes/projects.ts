import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { FONT_EXT } from '../../../shared/asset-names.ts';
import { uploadTickets } from '../../db/schema/blobs-assets.ts';
import { jobs } from '../../db/schema/jobs.ts';
import type { FontMetadataEntry } from '../../services/asset-names-service.ts';
import {
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import { infoInMemory } from '../engine/inspect.ts';
import { formatVersionFromSha256 } from '../etag.ts';
import { listVirtualCompositions } from '../virtual-project-store.ts';
import { classifyPreviewProxyTarget } from '../../workers/media-ingest.ts';

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
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const fileList = virtual.listFiles();
    const filePaths = fileList.map((f) => f.path);
    const compositions = listVirtualCompositions(fileList);
    const info = infoInMemory(virtual);

    const projectFonts: Array<FontMetadataEntry & { postscriptName?: string }> = [];
    if (deps.fontCatalog) {
      for (const file of fileList) {
        if (!FONT_EXT.test(file.path)) continue;
        try {
          const bin = await deps.files.readBinaryFile(auth, projectId, file.path);
          if (!bin) continue;
          const meta = deps.fontCatalog.inspectBuffer(bin.buffer);
          if (meta) {
            projectFonts.push({ ...meta, path: file.path });
          }
        } catch {
          // Invalid font assets remain listed in files but are skipped from selectable fonts.
        }
      }
    }

    const assetNameInfo = await deps.assetNames.readAssetNames(auth, projectId, {
      paths: filePaths,
      fonts: projectFonts,
    });

    const assetMetadata: Record<
      string,
      {
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
      const meta = file.metadata;
      if (!meta) continue;
      const previewProxy = (meta as { previewProxy?: { status?: 'ready' | 'failed' } }).previewProxy;
      let optimizationStatus: 'optimizing' | 'ready' | undefined;
      if (file.blobScope === 'workspace') {
        const mime = (meta.mimeType ?? file.mimeType ?? '').toLowerCase();
        const proxyTarget = classifyPreviewProxyTarget({
          mimeType: mime,
          sizeBytes: file.sizeBytes,
          width: meta.width,
          height: meta.height,
        });
        const proxySettled =
          !proxyTarget || previewProxy?.status === 'ready' || previewProxy?.status === 'failed';
        if (meta.modality === 'video' || mime.startsWith('video/')) {
          const spriteSettled = meta.sprite?.status === 'ready' || meta.sprite?.status === 'failed';
          optimizationStatus = spriteSettled && proxySettled ? 'ready' : 'optimizing';
        } else if ((meta.modality === 'image' || mime.startsWith('image/')) && proxyTarget) {
          optimizationStatus = proxySettled ? 'ready' : 'optimizing';
        } else if (meta.modality === 'audio' || mime.startsWith('audio/')) {
          const waveformSettled =
            (typeof meta.waveformPeaksKey === 'string' && meta.waveformPeaksKey.length > 0) ||
            meta.waveformFailed === true;
          optimizationStatus = waveformSettled && proxySettled ? 'ready' : 'optimizing';
        }
      }
      const entry: (typeof assetMetadata)[string] = {
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
        const filename =
          (typeof payload.name === 'string' && payload.name) ||
          (typeof payload.targetPath === 'string' && payload.targetPath.split('/').pop()) ||
          'Importing media';
        pendingImports.push({
          id: job.id,
          jobId: job.id,
          filename,
          ...(typeof payload.targetPath === 'string' ? { targetPath: payload.targetPath } : {}),
          source: kind === 'url' || kind === 'url_fetch' ? 'mcp_url' : 'mcp_upload',
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
      revision: detail.revision,
      versionId: detail.currentVersionId,
      versionNumber: detail.currentVersionNumber,
      historySeq: detail.currentHistorySeq,
      files: filePaths,
      compositions,
      fonts: projectFonts,
      assetNames: assetNameInfo.assetNames,
      assetMetadata,
      pendingImports,
      namingLanguage: assetNameInfo.namingLanguage,
      width: info.width,
      height: info.height,
      fps: info.fps,
      duration: info.duration,
      resolution: info.resolution,
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
        version: formatVersionFromSha256(f.sha256),
        modifiedAt: f.updatedAt.toISOString(),
        metadata: f.metadata ?? null,
      })),
    });
  });

  return app;
}
