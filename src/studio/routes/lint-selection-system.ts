import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getHyperframeRuntimeScript } from '@hyperframes/core/runtime-script';
import { CloudError, featureDeferredP2 } from '../../contracts/errors.ts';
import type { AuthContext } from '../../contracts/auth.ts';
import type { ProjectEvent, SelectionEvent } from '../../contracts/events.ts';
import { projectChannel, selectionChannel, workspaceCatalogChannel } from '../../infra/redis.ts';
import { isUuid } from '../../../shared/project-validation.ts';
import {
  extractWildcardPath,
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import { infoInMemory, timelineInMemory } from '../engine/inspect.ts';
import { lintProjectInMemory } from '../engine/lint-project.ts';
import { installMotionComponent, motionComponentCards } from '../../services/motion-component-registry.ts';
import { createWriteToken, fileContentVersion, getMimeType, hashIndexHeadMarkup } from '../etag.ts';
import type { VirtualFileRecord } from '../virtual-project-store.ts';

const SAFE_VENDOR_PATH_RE = /^[a-zA-Z0-9._/@-]{1,200}$/;
const VERSIONED_GSAP_PREFIX_RE = /^gsap@[a-zA-Z0-9._-]+\/(?:dist\/)?/;
const SAFE_GSAP_ASSET_FILE_RE = /^[a-zA-Z0-9._-]+\.(?:js|mjs|cjs|map)$/;
const LINT_CACHE_MAX_ENTRIES = 64;

type StoredSelection = SelectionEvent & { selection?: unknown };

interface CachedLintEntry {
  readonly fingerprint: string;
  readonly fullBody: string;
  readonly fullEtag: string;
  readonly findingsBody: string;
  readonly findingsEtag: string;
}

function computeLintFingerprint(files: readonly VirtualFileRecord[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash('sha256');
  for (const file of sorted) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.blobScope);
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
    hash.update(String(file.sizeBytes));
    if (file.metadata) {
      const dur = file.metadata.durationSec;
      const codec = file.metadata.codec;
      if (typeof dur === 'number' || typeof codec === 'string') {
        hash.update('\0');
        hash.update(String(dur ?? ''));
        hash.update(':');
        hash.update(String(codec ?? ''));
      }
    }
    hash.update('\n');
  }
  return hash.digest('hex');
}

function normalizeEtagValue(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
}

function ifNoneMatchMatches(header: string | undefined, currentEtag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;
  const target = normalizeEtagValue(currentEtag);
  return trimmed.split(',').some((part) => normalizeEtagValue(part) === target);
}

export type StudioSystemRouteDeps = DisklessStudioDeps & {
  readonly previewOrigin?: string | null;
};

export function createStudioSystemRoutes(deps: StudioSystemRouteDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();
  const runtimeRoot = deps.runtimeRoot ?? process.cwd();
  const studioVersion = deps.studioVersion ?? '0.9.7';
  const previewOrigin = deps.previewOrigin ?? null;

  // In-memory latest selection mirror (per instance, updated via Redis pub/sub for multi-pod sync).
  const latestSelections = new Map<string, StoredSelection>();
  // Bounded per-project lint result cache keyed by workspace+project and validated against file+metadata fingerprint.
  const lintCache = new Map<string, CachedLintEntry>();
  const inFlightLint = new Map<string, Promise<CachedLintEntry>>();

  const putLintCache = (key: string, entry: CachedLintEntry): void => {
    if (lintCache.has(key)) lintCache.delete(key);
    lintCache.set(key, entry);
    while (lintCache.size > LINT_CACHE_MAX_ENTRIES) {
      const oldestKey = lintCache.keys().next().value;
      if (!oldestKey) break;
      lintCache.delete(oldestKey);
    }
  };

  // During a rolling update, old tabs need an explicit shared thumbnail digest. Read
  // only for those subscribers and share the immutable version's result across tabs.
  const legacyHeadDigests = new Map<string, Promise<string | undefined>>();
  function legacyHeadDigest(auth: AuthContext, projectId: string, version: string) {
    const key = [auth.workspaceId, projectId, version].join(':');
    const cached = legacyHeadDigests.get(key);
    if (cached) return cached;
    const patch = /^"patch:([a-f0-9]{64})"$/.exec(version);
    const source = patch
      ? deps.files.readTextBlob(auth.workspaceId, 'patch', patch[1])
      : deps.files.readTextFile(auth, projectId, 'index.html').then(file => file?.version === version ? file.content : undefined);
    const digest = source.then(text => text === undefined ? undefined : hashIndexHeadMarkup(text)).catch(() => {
      if (legacyHeadDigests.get(key) === digest) legacyHeadDigests.delete(key);
      return undefined;
    });
    legacyHeadDigests.set(key, digest);
    if (legacyHeadDigests.size > 64) legacyHeadDigests.delete(legacyHeadDigests.keys().next().value!);
    return digest;
  }

  let cachedRuntimeJs: string | null = null;
  const vendorCache = new Map<string, { content: Buffer; mimeType: string }>();

  const loadRuntimeJs = (): string => {
    if (cachedRuntimeJs === null) {
      cachedRuntimeJs = getHyperframeRuntimeScript();
    }
    return cachedRuntimeJs;
  };

  const loadVendorAsset = async (subPath: string): Promise<{ content: Buffer; mimeType: string } | null> => {
    const cleaned = subPath.replace(/^\/+/, '');
    if (
      !cleaned ||
      !SAFE_VENDOR_PATH_RE.test(cleaned) ||
      cleaned.includes('..') ||
      cleaned.includes('\\')
    ) {
      return null;
    }
    const cached = vendorCache.get(cleaned);
    if (cached) return cached;

    const req = createRequire(path.resolve(runtimeRoot, 'package.json'));
    try {
      if (cleaned.startsWith('gsap/')) {
        const gsapRoot = path.dirname(req.resolve('gsap/package.json'));
        const rawFileName = cleaned.slice('gsap/'.length);
        const fileName = rawFileName.replace(VERSIONED_GSAP_PREFIX_RE, '');
        if (!SAFE_GSAP_ASSET_FILE_RE.test(fileName) || fileName.includes('..')) {
          return null;
        }
        const candidates = [
          path.resolve(gsapRoot, 'dist', fileName),
          path.resolve(gsapRoot, fileName),
        ];
        for (const candidate of candidates) {
          if (!candidate.startsWith(gsapRoot + path.sep)) continue;
          try {
            const content = await readFile(candidate);
            const entry = { content, mimeType: getMimeType(candidate) };
            vendorCache.set(cleaned, entry);
            return entry;
          } catch {
            // Try next candidate.
          }
        }
      }
    } catch {
      return null;
    }
    return null;
  };

  // GET /api/projects/:id/lint — Pure in-memory lintProjectInMemory (reads blobs.metadata, zero ffprobe).
  // Cached by project file+metadata fingerprint with single-flight dedupe so 304 revalidations avoid re-linting.
  app.get('/api/projects/:id/lint', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const files = await deps.files.listFiles(auth, projectId);
    const fingerprint = computeLintFingerprint(files);
    const cacheKey = `${auth.workspaceId}:${projectId}`;

    let entry = lintCache.get(cacheKey);
    if (entry && entry.fingerprint === fingerprint) {
      putLintCache(cacheKey, entry);
    } else {
      const flightKey = `${cacheKey}:${fingerprint}`;
      let pending = inFlightLint.get(flightKey);
      if (!pending) {
        pending = (async () => {
          const virtual = await deps.files.loadVirtualProject(auth, projectId);
          const result = await lintProjectInMemory(virtual);
          const fullBody = JSON.stringify(result);
          // Keep the UI validator stable across edits that preserve the visible findings.
          const findings = result.findings.map(({ severity, message, file, fixHint, elementId }) => ({
            severity, message, file, fixHint, elementId,
          }));
          const findingsBody = JSON.stringify({ findings });
          const computed: CachedLintEntry = {
            fingerprint: computeLintFingerprint(virtual.listFiles()),
            fullBody,
            fullEtag: fileContentVersion(fullBody),
            findingsBody,
            findingsEtag: fileContentVersion(findingsBody),
          };
          putLintCache(cacheKey, computed);
          return computed;
        })().finally(() => {
          if (inFlightLint.get(flightKey) === pending) {
            inFlightLint.delete(flightKey);
          }
        });
        inFlightLint.set(flightKey, pending);
      }
      entry = await pending;
    }

    const isFindingsView = c.req.query('view') === 'findings';
    const body = isFindingsView ? entry.findingsBody : entry.fullBody;
    const responseEtag = isFindingsView ? entry.findingsEtag : entry.fullEtag;
    c.header('Cache-Control', 'private, no-cache');
    c.header('Vary', 'Cookie, Authorization');
    c.header('ETag', responseEtag);
    if (ifNoneMatchMatches(c.req.header('if-none-match'), responseEtag)) {
      return c.body(null, 304);
    }
    c.header('Content-Type', 'application/json; charset=utf-8');
    return c.body(body, 200);
  });

  // GET /api/projects/:id/info — Pure in-memory project metadata inspection.
  app.get('/api/projects/:id/info', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    return c.json(infoInMemory(virtual));
  });

  // GET /api/projects/:id/timeline — Pure in-memory composition timeline extraction.
  app.get('/api/projects/:id/timeline', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    return c.json(timelineInMemory(virtual));
  });

  // GET /api/projects/:id/selection — Read latest Studio selection state.
  app.get('/api/projects/:id/selection', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const key = `${auth.workspaceId}:${projectId}`;
    const existing = latestSelections.get(key);
    return c.json(
      existing ?? {
        workspaceId: auth.workspaceId,
        projectId,
        elementIds: [],
        selection: null,
        ts: 0,
      },
    );
  });

  // PUT & POST /api/projects/:id/selection — Publish Studio selection update across instances via RedisEventBus.
  // Supports both Studio `useStudioSelectionPublisher` (`PUT { selection }`) and `{ elementIds, compositionId, senderId }`.
  const handleUpdateSelection = async (c: Context<{ Variables: StudioVariables }>) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id') ?? '';
    const body = (await c.req.json().catch(() => ({}))) as {
      selection?: unknown;
      compositionId?: string;
      elementIds?: unknown;
      senderId?: string;
    };

    const nestedSel =
      body.selection && typeof body.selection === 'object' && !Array.isArray(body.selection)
        ? (body.selection as Record<string, unknown>)
        : null;

    const rawIds = Array.isArray(body.elementIds)
      ? body.elementIds
      : Array.isArray(nestedSel?.elementIds)
        ? nestedSel.elementIds
        : Array.isArray(nestedSel?.ids)
          ? nestedSel.ids
          : [];
    const elementIds = rawIds.filter((id): id is string => typeof id === 'string').slice(0, 500);

    const compositionId =
      typeof body.compositionId === 'string'
        ? body.compositionId
        : typeof nestedSel?.compositionId === 'string'
          ? nestedSel.compositionId
          : undefined;

    const event: StoredSelection = {
      workspaceId: auth.workspaceId,
      projectId,
      ...(compositionId ? { compositionId } : {}),
      elementIds,
      ...(typeof body.senderId === 'string' ? { senderId: body.senderId } : {}),
      ...(body.selection !== undefined ? { selection: body.selection } : {}),
      ts: Date.now(),
    };

    latestSelections.set(`${auth.workspaceId}:${projectId}`, event);
    if (deps.eventBus && isUuid(projectId)) {
      void deps.eventBus.publish(selectionChannel(auth.workspaceId, projectId), event).catch(() => {});
    }
    return c.json({ ok: true, selection: body.selection ?? event, event });
  };

  app.put('/api/projects/:id/selection', handleUpdateSelection);
  app.post('/api/projects/:id/selection', handleUpdateSelection);

  // GET /api/events — Cross-instance SSE subscribing to RedisEventBus `om:project:{wid}:{pid}` + `om:selection:{wid}:{pid}`.
  app.get('/api/events', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.query('projectId') ?? '';
    if (!isUuid(projectId)) {
      throw new CloudError('INVALID_ARGUMENT', 'Query parameter "projectId" must be a valid project UUID.', {
        status: 400,
        applied: false,
      });
    }

    // Verify caller owns this project in their tenant workspace before subscribing!
    await deps.workspace.getProject(auth, projectId, { allowTrashed: true });

    return streamSSE(c, async (stream) => {
      const connected = () => stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({ projectId, ts: Date.now() }),
      });

      if (!deps.eventBus) {
        await connected();
        return;
      }

      const { promise: disconnected, resolve: disconnect } = Promise.withResolvers<void>();
      stream.onAbort(disconnect);
      const unsubscribe: Array<() => Promise<void>> = [];
      let keepalive: ReturnType<typeof setInterval> | undefined;
      const ordered = c.req.query('orderedEdits') === '1';
      let projectDelivery = Promise.resolve();

      try {
        unsubscribe.push(await deps.eventBus.subscribe(
          projectChannel(auth.workspaceId, projectId),
          (payload) => {
            if (stream.aborted) return;
            const evt = payload as ProjectEvent;
            if (ordered && evt?.type === 'history-changed' && evt.includedInOrderedEdit) return;
            const eventName =
              evt?.type === 'history-changed'
                ? 'history-changed'
                : evt?.type === 'media-derived-ready'
                  ? 'media-derived-ready'
                  : evt?.type === 'media-ingest-status'
                    ? 'media-ingest-status'
                    : evt?.type === 'render-updated'
                      ? 'render-updated'
                      : 'file-change';
            // Tabs opened before a rolling update may only understand the single-path wire format.
            const fileEvent = evt?.type === 'file-change' || evt?.type === 'files-changed' ? evt : undefined;
            const files = fileEvent?.paths;
            const data = fileEvent && files?.length && !('path' in fileEvent)
              ? { ...fileEvent, path: files.length === 1 ? files[0] : '.' }
              : evt;
            const send = (data: unknown) => stream.writeSSE({ event: eventName, data: JSON.stringify(data) });
            if (ordered) {
              void send(data).catch(() => {});
              return;
            }
            // A legacy digest may be asynchronous; preserve event ordering on that stream.
            projectDelivery = projectDelivery.then(async () => {
              if (stream.aborted) return;
              const root = fileEvent?.fileVersions?.['index.html'];
              if (root && !fileEvent?.indexHeadHash) {
                const indexHeadHash = await legacyHeadDigest(auth, projectId, root);
                if (stream.aborted) return;
                return send({ ...data, indexHeadHash });
              }
              return send(data);
            }).catch(() => {});
          },
        ));

        unsubscribe.push(await deps.eventBus.subscribe(
          selectionChannel(auth.workspaceId, projectId),
          (payload) => {
            if (stream.aborted) return;
            const sel = payload as StoredSelection;
            latestSelections.set(`${auth.workspaceId}:${projectId}`, sel);
            void stream
              .writeSSE({
                event: 'selection',
                data: JSON.stringify(payload),
              })
              .catch(() => {});
          },
        ));

        // The signal carries no project metadata. Each recipient reloads its own authorized catalog.
        unsubscribe.push(await deps.eventBus.subscribe(workspaceCatalogChannel(auth.workspaceId), () => {
          if (!stream.aborted) void stream.writeSSE({
            event: 'catalog-changed', data: JSON.stringify({ projectId }),
          }).catch(() => {});
        }));

        // Clients reconcile after this acknowledgement, including edits made while subscribing.
        if (stream.aborted) return;
        await connected();

        keepalive = setInterval(() => {
          if (stream.aborted) return;
          void stream.write(': keepalive\n\n').catch(() => {});
        }, 20_000);

        if (!stream.aborted) await disconnected;
      } finally {
        clearInterval(keepalive);
        await Promise.allSettled(unsubscribe.map(stop => stop()));
      }
    });
  });

  // GET /__hyperframes_config — Studio runtime configuration descriptor.
  app.get('/__hyperframes_config', async (c) => {
    const projectId = c.req.query('projectId');
    return c.json({
      isHyperframes: true,
      version: studioVersion,
      mode: 'cloud-diskless',
      diskless: true,
      multiProject: true,
      projectDir: projectId ? `/virtual/${projectId}` : '/virtual',
      previewOrigin,
    });
  });

  // GET /api/environment/ffmpeg — Reads Redis `om:workers:render:health` heartbeat (never spawns local ffmpeg!).
  app.get('/api/environment/ffmpeg', async (c) => {
    await getAuthContext(c, deps, { scope: 'projects:read' });
    const workers = deps.eventBus
      ? await deps.eventBus.getRenderWorkersHealth(60_000).catch(() => [])
      : [];
    const ffmpegWorkers = workers.filter((w) => w.ffmpeg);
    const available = ffmpegWorkers.length > 0;
    return c.json({
      ok: available,
      available,
      version: available ? 'remote-worker' : null,
      mode: 'remote-worker',
      workers: workers.map((w) => ({
        workerId: w.workerId,
        ffmpeg: w.ffmpeg,
        ffprobe: w.ffprobe,
        chromium: w.chromium,
        concurrency: w.concurrency,
        activeJobs: w.activeJobs,
        updatedAt: w.updatedAt,
      })),
    });
  });

  // GET /api/runtime.js — Serve pre-built Hyperframes browser runtime IIFE directly from @hyperframes/core/runtime-script.
  app.get('/api/runtime.js', (c) => {
    const js = loadRuntimeJs();
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(js, 200);
  });

  // GET /api/vendor/* — Serve read-only GSAP & vendor JS assets from node_modules.
  app.get('/api/vendor/*', async (c) => {
    const subPath = extractWildcardPath(c.req.url, '/api/vendor/');
    const asset = await loadVendorAsset(subPath);
    if (!asset) return c.notFound();
    c.header('Content-Type', asset.mimeType);
    c.header('Cache-Control', 'public, max-age=86400, immutable');
    return c.body(new Uint8Array(asset.content), 200);
  });

  // GET /api/open-in-desktop — Probe endpoint called by OpenInDesktopButton; reports desktop handoff unavailable in cloud mode.
  app.get('/api/open-in-desktop', async (c) => {
    await getAuthContext(c, deps, { scope: 'projects:read' });
    return c.json({ available: false, handoff: false, installed: false });
  });

  // POST /api/open-in-desktop — Unavailable in cloud container mode.
  app.post('/api/open-in-desktop', async (c) => {
    await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    throw featureDeferredP2('open_in_desktop');
  });

  // GET /api/assets/global — Empty container-safe global asset list (workspace assets live in AssetsService).
  app.get('/api/assets/global', async (c) => {
    await getAuthContext(c, deps, { scope: 'projects:read' });
    return c.json({ assets: [] });
  });

  // GET /api/registry/blocks & POST /api/projects/:id/registry/install
  app.get('/api/registry/blocks', async (c) => {
    await getAuthContext(c, deps, { scope: 'projects:read' });
    return c.json({ blocks: motionComponentCards });
  });

  app.post('/api/projects/:id/registry/install', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const body = await c.req.json().catch(() => null);
    if (typeof body?.blockName !== 'string' || !body.blockName) return c.json({ error: 'blockName is required' }, 400);
    return c.json(await installMotionComponent(auth, deps.files, c.req.param('id'), body.blockName,
      { writeToken: createWriteToken(c.req.header('x-hyperframes-write-token')) }));
  });

  return app;
}
