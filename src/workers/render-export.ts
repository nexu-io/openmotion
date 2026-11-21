import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { extractStandaloneEntryFromIndex } from '@hyperframes/core/compiler';
import {
  pluginRoot,
  runHyperframesIsolated,
  snapshotExportExpectationIsolated,
  type CommandResult,
  type IsolatedExecuteOptions,
} from '../../hyperframes.ts';
import {
  verificationBinaries,
  verifyExport,
  type ExportExpectation,
  type VerificationReport,
} from '../../scripts/verify-export.ts';
import { projectPath } from '../../shared/project-validation.ts';
import { CloudError } from '../contracts/errors.ts';
import type { JobProgressEvent, ProjectEvent, RenderWorkerHealth } from '../contracts/events.ts';
import type { RenderExportJobName, RenderExportPayloadMap } from '../contracts/jobs.ts';
import type { StoragePort } from '../contracts/storage.ts';
import type { Database } from '../db/client.ts';
import { asUpdate } from '../db/helpers.ts';
import { jobs } from '../db/schema/jobs.ts';
import { projectFiles, projectVersionFiles } from '../db/schema/project-files.ts';
import type { Logger } from '../infra/logger.ts';
import { cancelChannel, jobChannel, projectChannel, type RedisEventBus } from '../infra/redis.ts';
import {
  catalogBlobKey,
  compThumbnailKey,
  exportKey,
  workspaceBlobKey,
} from '../infra/storage.ts';
import { mimeTypeForExportFormat } from '../services/export-service.ts';
import {
  assertRenderSubprocessEnvClean,
  buildRenderSubprocessEnv,
  injectStudioRenderParityIntoHydratedDir,
} from './render-env.ts';

const HYDRATION_CONCURRENCY = 8;
const HYDRATION_LARGE_FILE_BYTES = 10 * 1024 * 1024;
const HYDRATION_LARGE_FILE_CONCURRENCY = 2;
const RENDER_TIMEOUT_MS = 25 * 60_000;
const THUMBNAIL_TIMEOUT_MS = 90_000;
const PROGRESS_PUBLISH_MIN_INTERVAL_MS = 500;
const DEFAULT_HEALTH_INTERVAL_MS = 15_000;

export interface HydratedSnapshotFile {
  path: string;
  blobScope: 'workspace' | 'catalog';
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}

export interface HydratedWorkspaceResult {
  projectDir: string;
  fileCount: number;
  skippedUnreferencedCount?: number;
  injectedManualEdits: boolean;
  injectedStudioMotion: boolean;
}

const ALWAYS_HYDRATE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.json',
  '.svg',
  '.xml',
  '.txt',
  '.md',
  '.vtt',
  '.srt',
  '.csv',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.glsl',
  '.vert',
  '.frag',
]);

const REFERENCE_SCAN_EXTENSIONS: ReadonlySet<string> = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.svg',
  '.vtt',
  '.srt',
]);

const LAZY_MEDIA_MIN_BYTES = 256 * 1024;
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const DYNAMIC_MEDIA_INTERPOLATION_REGEX =
  /\$\{[^}]+\}[^`'"\n]{0,32}\.(mp4|mov|webm|m4v|qt|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif|avif)\b/i;

function isAlwaysHydratedSnapshotFile(file: HydratedSnapshotFile): boolean {
  const safePath = projectPath(file.path);
  if (safePath.startsWith('.hyperframes/')) return true;
  if (file.sizeBytes <= LAZY_MEDIA_MIN_BYTES) return true;
  const ext = path.posix.extname(safePath).toLowerCase();
  return ALWAYS_HYDRATE_EXTENSIONS.has(ext);
}

function decodePercentSequencesSafe(input: string): string {
  return input.replace(/(?:%[0-9A-Fa-f]{2})+/g, (segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/**
 * Determine which large binary media candidates are referenced by any hydrated text/code/manifest
 * files in the composition workspace. Uses conservative substring matching (full path, URL-encoded
 * path, and bare basename) plus a dynamic `${...}.ext` interpolation fallback so referenced assets
 * are never accidentally skipped while unreferenced library uploads (>256 KiB) stay out of `/tmp`.
 */
export function selectReferencedMediaCandidates(
  candidates: readonly HydratedSnapshotFile[],
  textSources: readonly string[],
): HydratedSnapshotFile[] {
  if (candidates.length === 0) return [];
  const rawCorpus = textSources.join('\n');
  if (!rawCorpus) return [];
  const decodedCorpus = decodePercentSequencesSafe(rawCorpus);

  if (DYNAMIC_MEDIA_INTERPOLATION_REGEX.test(rawCorpus)) {
    return [...candidates];
  }

  return candidates.filter((file) => {
    const safePath = projectPath(file.path);
    const base = path.posix.basename(safePath);
    const encodedPath = safePath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const encodedBase = encodeURIComponent(base);
    return (
      rawCorpus.includes(safePath) ||
      decodedCorpus.includes(safePath) ||
      rawCorpus.includes(encodedPath) ||
      rawCorpus.includes(base) ||
      decodedCorpus.includes(base) ||
      rawCorpus.includes(encodedBase)
    );
  });
}

export interface RenderExportDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly eventBus: Pick<RedisEventBus, 'publish' | 'subscribe' | 'publishRenderWorkerHealth'>;
  readonly logger: Logger;
  readonly workerId: string;
  readonly runtimeRoot?: string;
  readonly tmpBaseDir?: string;
  readonly concurrency?: number;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly runRenderCommand?: (
    runtimeRoot: string,
    projectDir: string,
    args: string[],
    options: IsolatedExecuteOptions,
  ) => Promise<CommandResult>;
  readonly verifyExportFn?: (
    outputPath: string,
    expectation: ExportExpectation,
    signal?: AbortSignal,
  ) => Promise<VerificationReport>;
  readonly extractExpectationFn?: (
    runtimeRoot: string,
    projectDir: string,
    compositionPath: string,
  ) => Promise<ExportExpectation>;
  readonly renderThumbnailFn?: (params: {
    projectDir: string;
    compositionPath: string;
    outputPngPath: string;
    timeSec: number;
    width: number;
    height: number;
    env: Record<string, string>;
    signal?: AbortSignal;
  }) => Promise<void>;
}

export interface RenderHealthHeartbeatHandle {
  pulse: () => Promise<void>;
  stop: () => void;
  setActiveJobs: (count: number) => void;
}

async function checkBinaryExecutable(binaryPath: string | undefined): Promise<boolean> {
  if (!binaryPath) return false;
  if (path.isAbsolute(binaryPath)) {
    try {
      await access(binaryPath);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Periodically publish `RenderWorkerHealth` to Redis (`om:workers:render:health`)
 * so Studio's `GET /api/environment/ffmpeg` accurately reflects live render worker capacity.
 */
export function startRenderHealthHeartbeat(options: {
  eventBus: Pick<RedisEventBus, 'publishRenderWorkerHealth'>;
  logger: Logger;
  workerId: string;
  concurrency: number;
  intervalMs?: number;
  sourceEnv?: NodeJS.ProcessEnv;
}): RenderHealthHeartbeatHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const sourceEnv = options.sourceEnv ?? process.env;
  let activeJobs = 0;
  let stopped = false;

  const pulse = async () => {
    if (stopped) return;
    const bins = verificationBinaries();
    const [ffmpeg, ffprobe, chromium] = await Promise.all([
      checkBinaryExecutable(sourceEnv.HYPERFRAMES_FFMPEG_PATH ?? bins.ffmpeg),
      checkBinaryExecutable(sourceEnv.HYPERFRAMES_FFPROBE_PATH ?? bins.ffprobe),
      checkBinaryExecutable(sourceEnv.HYPERFRAMES_BROWSER_PATH ?? sourceEnv.PRODUCER_HEADLESS_SHELL_PATH),
    ]);
    const health: RenderWorkerHealth = {
      workerId: options.workerId,
      ffmpeg,
      ffprobe,
      chromium,
      concurrency: options.concurrency,
      activeJobs,
      updatedAt: Date.now(),
    };
    await options.eventBus.publishRenderWorkerHealth(health, Math.ceil((intervalMs * 3) / 1000));
  };

  void pulse().catch((error) => {
    options.logger.warn('Initial render worker health heartbeat failed', {
      workerId: options.workerId,
      error,
    });
  });

  const timer = setInterval(() => {
    void pulse().catch((error) => {
      options.logger.warn('Periodic render worker health heartbeat failed', {
        workerId: options.workerId,
        error,
      });
    });
  }, intervalMs);
  timer.unref();

  return {
    pulse,
    setActiveJobs(count: number) {
      activeJobs = Math.max(0, count);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Remove stale ephemeral `/tmp/om-render-*` and `/tmp/om-thumb-*` folders left by hard OOM kills. */
export async function sweepStaleRenderTempDirs(tmpBaseDir = os.tmpdir(), logger?: Logger): Promise<number> {
  let removed = 0;
  try {
    const entries = await readdir(tmpBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('om-render-') && !entry.name.startsWith('om-thumb-')) continue;
      await rm(path.join(tmpBaseDir, entry.name), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  } catch (error) {
    logger?.warn('Failed to sweep stale render temp dirs', { tmpBaseDir, error });
  }
  return removed;
}

/**
 * Hydrate an immutable snapshot (`project_version_files` or `project_files`) from S3 CAS
 * (`workspaceBlobKey` / `catalogBlobKey`) into an ephemeral `/tmp` directory, verify every
 * file's SHA-256 digest and path containment, and inject `.hyperframes/studio-manual-edits.json`
 * + `.hyperframes/studio-motion.json` runtime scripts into the ephemeral entry HTML copy.
 */
export async function hydrateSnapshotFilesToDir(params: {
  storage: StoragePort;
  workspaceId: string;
  projectDir: string;
  compositionPath: string;
  files: readonly HydratedSnapshotFile[];
  onlyReferencedMedia?: boolean;
}): Promise<HydratedWorkspaceResult> {
  const resolvedRoot = path.resolve(params.projectDir);
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });

  let largeActive = 0;
  const largeWaiters: Array<() => void> = [];
  const acquireLargeSlot = async () => {
    if (largeActive >= HYDRATION_LARGE_FILE_CONCURRENCY) {
      await new Promise<void>((resolve) => largeWaiters.push(resolve));
    }
    largeActive += 1;
  };
  const releaseLargeSlot = () => {
    largeActive = Math.max(0, largeActive - 1);
    const next = largeWaiters.shift();
    if (next) next();
  };

  const hydrateBatch = async (batch: readonly HydratedSnapshotFile[]): Promise<void> => {
    if (batch.length === 0) return;
    let cursor = 0;
    const workerCount = Math.min(HYDRATION_CONCURRENCY, Math.max(1, batch.length));

    const runWorker = async () => {
      for (;;) {
        const idx = cursor;
        cursor += 1;
        if (idx >= batch.length) return;
        const file = batch[idx];

        // Strict path normalization & directory containment check (zero path traversal).
        const safeRelPath = projectPath(file.path);
        const destPath = path.resolve(resolvedRoot, safeRelPath);
        if (destPath !== resolvedRoot && !destPath.startsWith(`${resolvedRoot}${path.sep}`)) {
          throw new CloudError('INVALID_PATH', `Snapshot path escapes hydration directory: ${file.path}`, {
            status: 400,
          });
        }

        const s3Key =
          file.blobScope === 'catalog'
            ? catalogBlobKey(file.sha256)
            : workspaceBlobKey(params.workspaceId, file.sha256);

        await mkdir(path.dirname(destPath), { recursive: true, mode: 0o700 });

        const isLarge = file.sizeBytes >= HYDRATION_LARGE_FILE_BYTES;
        if (isLarge) {
          await acquireLargeSlot();
        }
        try {
          const { stream } = await params.storage.getObjectStream(s3Key);
          const hash = createHash('sha256');
          const hasher = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              hash.update(buf);
              callback(null, buf);
            },
          });
          await pipeline(stream, hasher, createWriteStream(destPath, { mode: 0o600 }));
          const actualSha = hash.digest('hex');
          if (actualSha !== file.sha256) {
            await rm(destPath, { force: true }).catch(() => {});
            throw new CloudError(
              'STORAGE_ERROR',
              `Hydrated CAS blob digest mismatch for ${safeRelPath}: expected ${file.sha256}, got ${actualSha}`,
              { status: 500 },
            );
          }
        } catch (error) {
          await rm(destPath, { force: true }).catch(() => {});
          throw error;
        } finally {
          if (isLarge) {
            releaseLargeSlot();
          }
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  };

  let hydratedCount = 0;
  let skippedUnreferencedCount = 0;

  if (params.onlyReferencedMedia) {
    const alwaysFiles: HydratedSnapshotFile[] = [];
    const lazyCandidates: HydratedSnapshotFile[] = [];
    for (const file of params.files) {
      if (isAlwaysHydratedSnapshotFile(file)) {
        alwaysFiles.push(file);
      } else {
        lazyCandidates.push(file);
      }
    }

    await hydrateBatch(alwaysFiles);
    hydratedCount += alwaysFiles.length;

    if (lazyCandidates.length > 0) {
      const textSources: string[] = [];
      for (const file of alwaysFiles) {
        const safeRelPath = projectPath(file.path);
        const ext = path.posix.extname(safeRelPath).toLowerCase();
        if (!REFERENCE_SCAN_EXTENSIONS.has(ext) || file.sizeBytes > MAX_SCAN_FILE_BYTES) continue;
        const text = await readFile(path.resolve(resolvedRoot, safeRelPath), 'utf8').catch(() => '');
        if (text) textSources.push(text);
      }
      const referencedMedia = selectReferencedMediaCandidates(lazyCandidates, textSources);
      skippedUnreferencedCount = lazyCandidates.length - referencedMedia.length;
      await hydrateBatch(referencedMedia);
      hydratedCount += referencedMedia.length;
    }
  } else {
    await hydrateBatch(params.files);
    hydratedCount = params.files.length;
  }

  // Inject studio manual edits & studio motion render parity scripts into the ephemeral HTML copy (#9 §6.3).
  const parity = await injectStudioRenderParityIntoHydratedDir(resolvedRoot, params.compositionPath);

  return {
    projectDir: resolvedRoot,
    fileCount: hydratedCount,
    skippedUnreferencedCount,
    injectedManualEdits: parity.injectedManualEdits,
    injectedStudioMotion: parity.injectedStudioMotion,
  };
}

function parseRenderProgressLine(line: string): { progress?: number; stage?: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const progress =
      typeof parsed.progress === 'number' && Number.isFinite(parsed.progress)
        ? Math.max(0, Math.min(99, parsed.progress <= 1 ? Math.round(parsed.progress * 100) : Math.round(parsed.progress)))
        : typeof parsed.percent === 'number' && Number.isFinite(parsed.percent)
          ? Math.max(0, Math.min(99, Math.round(parsed.percent)))
          : undefined;
    const stage = typeof parsed.stage === 'string' && parsed.stage.trim() ? parsed.stage.trim() : undefined;
    if (progress === undefined && stage === undefined) return null;
    return { progress, stage };
  } catch {
    return null;
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

const ALLOWED_RENDER_QUALITIES: ReadonlySet<string> = new Set(['draft', 'looks', 'delivery', 'standard', 'high']);
const SAFE_FPS_STRING = /^\d{1,6}(?:\/\d{1,6})?$/;
const SAFE_RESOLUTION_PRESET = /^[a-z0-9-]{2,32}$/i;
const SAFE_BITRATE_STRING = /^\d+(?:\.\d+)?[kKmM]?$/;

/**
 * Build validated CLI arguments for `hyperframes@0.9.7 render`, forwarding only safe
 * allowlisted `payload.settings` (`fps`, `quality`, `resolution`, `crf`, `videoBitrate`,
 * `gifLoop`, `variables`).
 */
export function buildRenderExportArgs(params: {
  compositionPath: string;
  outputFilePath: string;
  format: 'mp4' | 'mov' | 'webm' | 'gif';
  settings?: Record<string, unknown>;
}): string[] {
  const args: string[] = [
    'render',
    '.',
    ...(params.compositionPath !== 'index.html' ? ['--composition', params.compositionPath] : []),
    '--output',
    params.outputFilePath,
    '--format',
    params.format,
  ];

  const settings = params.settings;
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    if (typeof settings.fps === 'number' && Number.isFinite(settings.fps) && settings.fps >= 1 && settings.fps <= 240) {
      args.push('--fps', String(settings.fps));
    } else if (typeof settings.fps === 'string' && SAFE_FPS_STRING.test(settings.fps.trim())) {
      args.push('--fps', settings.fps.trim());
    }

    if (typeof settings.quality === 'string' && ALLOWED_RENDER_QUALITIES.has(settings.quality.trim())) {
      args.push('--quality', settings.quality.trim());
    }

    if (typeof settings.resolution === 'string' && SAFE_RESOLUTION_PRESET.test(settings.resolution.trim())) {
      args.push('--resolution', settings.resolution.trim());
    }

    const hasCrf =
      params.format !== 'mov' &&
      typeof settings.crf === 'number' &&
      Number.isInteger(settings.crf) &&
      settings.crf >= 0 &&
      settings.crf <= 51;
    const hasBitrate =
      params.format !== 'mov' &&
      typeof settings.videoBitrate === 'string' &&
      SAFE_BITRATE_STRING.test(settings.videoBitrate.trim());

    // --crf and --video-bitrate are mutually exclusive in hyperframes@0.9.7.
    if (hasCrf && !hasBitrate) {
      args.push('--crf', String(settings.crf));
    } else if (hasBitrate && !hasCrf) {
      args.push('--video-bitrate', (settings.videoBitrate as string).trim());
    }

    if (
      params.format === 'gif' &&
      typeof settings.gifLoop === 'number' &&
      Number.isInteger(settings.gifLoop) &&
      settings.gifLoop >= 0 &&
      settings.gifLoop <= 65_535
    ) {
      args.push('--gif-loop', String(settings.gifLoop));
    }

    if (settings.variables && typeof settings.variables === 'object' && !Array.isArray(settings.variables)) {
      args.push('--variables', JSON.stringify(settings.variables));
    }
  }

  args.push('--json');
  return args;
}

/**
 * Build valid `hyperframes@0.9.7 snapshot` CLI arguments for capturing a single composition
 * thumbnail PNG at `timeSec` (never passing unsupported `--format png` or `--start/--end`).
 */
export function buildThumbnailSnapshotArgs(params: {
  framesDir: string;
  timeSec: number;
  compositionId?: string | null;
}): string[] {
  const safeTime = Number.isFinite(params.timeSec) && params.timeSec >= 0 ? params.timeSec : 0;
  const sample = params.compositionId
    ? ['--composition', params.compositionId, '--frames', '1']
    : ['--at', String(safeTime)];
  return ['snapshot', '.', '--output', params.framesDir, ...sample, '--no-end', '--json'];
}

/** Render a subscene on its own clock inside the disposable snapshot directory. */
async function prepareThumbnailEntry(projectDir: string, compositionPath: string): Promise<string | null> {
  const normalized = projectPath(compositionPath);
  if (normalized === 'index.html') return null;
  const indexPath = path.join(projectDir, 'index.html');
  const [index, scene] = await Promise.all([
    readFile(indexPath, 'utf8'), readFile(path.join(projectDir, normalized), 'utf8'),
  ]);
  const shell = extractStandaloneEntryFromIndex(index, normalized, scene);
  if (shell) {
    await writeFile(indexPath, shell);
    return null;
  }
  // Nested scenes may only have a mount inside another composition.
  const id = /\bdata-composition-id\s*=\s*["']([^"']+)["']/i.exec(scene)?.[1]?.trim();
  if (!id) throw new Error(`No composition found for thumbnail: ${normalized}`);
  return id;
}

async function verifyContainerHeader(filePath: string, format: string): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 16) {
    throw new CloudError('STORAGE_ERROR', 'Render output file is missing or empty', { status: 500 });
  }
  if (format === 'mp4' || format === 'mov') {
    const fh = await open(filePath, 'r');
    try {
      const header = Buffer.alloc(12);
      await fh.read(header, 0, 12, 0);
      if (header.subarray(4, 8).toString('ascii') !== 'ftyp') {
        throw new CloudError('STORAGE_ERROR', 'Render subprocess did not produce a valid MP4/MOV container', {
          status: 500,
        });
      }
    } finally {
      await fh.close();
    }
  }
}

/**
 * Execute an `export_render` job on `worker-render` (`attempts: 1`):
 * 1. Acquire fencing `claim_token` on `jobs` (`state = 'queued' -> 'running'`).
 * 2. Subscribe to `om:cancel:{jobId}` for immediate subprocess tree termination.
 * 3. Hydrate frozen `project_version_files` into `/tmp/om-render-<jobId>` + inject Studio parity scripts.
 * 4. Spawn `hyperframes render` with strictly stripped allowlist env (`buildRenderSubprocessEnv`).
 * 5. Run `verify-export` technical validation on MP4 outputs.
 * 6. Upload MP4 + `render.log` to `exportKey(wid, jobId, name)`, update PG `jobs` checking `claim_token`
 *    (or delete uploaded MP4 and finalize `cancelled` if cancelled mid-flight), publish `om:job:{jobId}`.
 * 7. UNCONDITIONALLY wipe `/tmp/om-render-<jobId>` in `finally`!
 */
export async function processExportRenderJob(
  deps: RenderExportDeps,
  payload: RenderExportPayloadMap['export_render'],
): Promise<Record<string, unknown>> {
  const { jobId, workspaceId, projectId, versionId, format } = payload;
  const compositionPath = payload.compositionPath ?? 'index.html';
  const runtimeRoot = deps.runtimeRoot ?? pluginRoot;
  const renderRootDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-render-${jobId}`);
  const projectDir = path.join(renderRootDir, 'project');
  const ephemeralHomeDir = path.join(renderRootDir, 'home');
  const ephemeralTmpDir = path.join(renderRootDir, 'tmp');
  const outputDir = path.join(renderRootDir, 'out');
  const safeOutputName = path.basename(payload.outputName).replace(/[^a-zA-Z0-9._-]/g, '_') || `export.${format}`;
  const outputFilePath = path.join(outputDir, safeOutputName);

  const claimToken = randomUUID();
  const abortController = new AbortController();
  const startedMs = Date.now();
  let unsubscribeCancel: (() => Promise<void>) | null = null;
  let claimed = false;
  let failureStage = 'hydrating';
  let failureCode = 'EXPORT_HYDRATION_FAILED';
  let uploadedOutputKey: string | null = null;

  const publishProgress = async (
    state: JobProgressEvent['state'],
    stage: string,
    progress: number,
    extra: Partial<JobProgressEvent> = {},
  ) => {
    const nowTs = Date.now();
    const jobEvent: JobProgressEvent = {
      jobId,
      workspaceId,
      projectId,
      kind: 'export_render',
      state,
      stage,
      progress,
      ts: nowTs,
      ...extra,
    };
    const projEvent: ProjectEvent = {
      type: 'render-updated',
      workspaceId,
      projectId,
      jobId,
      state,
      progress,
      stage,
      ts: nowTs,
    };
    await Promise.allSettled([
      deps.eventBus.publish(jobChannel(jobId), jobEvent),
      deps.eventBus.publish(projectChannel(workspaceId, projectId), projEvent),
    ]);
  };

  const checkpointStage = async (stage: string, progress: number) => {
    const updated = await deps.db
      .update(jobs)
      .set(asUpdate(jobs, { stage, progress, updatedAt: new Date() }))
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.workspaceId, workspaceId),
          eq(jobs.claimToken, claimToken),
          eq(jobs.state, 'running'),
        ),
      )
      .returning({ id: jobs.id });
    if (updated.length === 0) {
      throw new Error('COMMAND_CANCELLED');
    }
    await publishProgress('running', stage, progress);
  };

  try {
    // 1. Acquire fencing claim_token atomically.
    const now = new Date();
    const claimedRows = await deps.db
      .update(jobs)
      .set(
        asUpdate(jobs, {
          state: 'running',
          stage: 'hydrating',
          progress: 5,
          workerId: deps.workerId,
          claimToken,
          startedAt: now,
          updatedAt: now,
        }),
      )
      .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId), eq(jobs.state, 'queued')))
      .returning();

    if (claimedRows.length === 0) {
      deps.logger.info('Skipping export_render job (not queued)', { jobId, workspaceId });
      return { skipped: true, jobId };
    }
    claimed = true;

    // 2. Listen for Redis cancellation signals immediately after claiming.
    unsubscribeCancel = await deps.eventBus.subscribe(cancelChannel(jobId), () => {
      abortController.abort(new Error('COMMAND_CANCELLED'));
    });

    await publishProgress('running', 'hydrating', 5);

    // 3. Hydrate frozen project_version_files into ephemeral /tmp/om-render-<jobId>.
    await Promise.all([
      mkdir(projectDir, { recursive: true, mode: 0o700 }),
      mkdir(ephemeralHomeDir, { recursive: true, mode: 0o700 }),
      mkdir(ephemeralTmpDir, { recursive: true, mode: 0o700 }),
      mkdir(outputDir, { recursive: true, mode: 0o700 }),
    ]);

    const snapshotRows = await deps.db
      .select({
        path: projectVersionFiles.path,
        blobScope: projectVersionFiles.blobScope,
        sha256: projectVersionFiles.sha256,
        sizeBytes: projectVersionFiles.sizeBytes,
        mimeType: projectVersionFiles.mimeType,
      })
      .from(projectVersionFiles)
      .where(
        and(
          eq(projectVersionFiles.versionId, versionId),
          eq(projectVersionFiles.workspaceId, workspaceId),
          eq(projectVersionFiles.projectId, projectId),
        ),
      );

    if (snapshotRows.length === 0) {
      throw new CloudError('NOT_FOUND', `Frozen version snapshot ${versionId} has no files`, { status: 404 });
    }

    await hydrateSnapshotFilesToDir({
      storage: deps.storage,
      workspaceId,
      projectDir,
      compositionPath,
      files: snapshotRows.map((row) => ({
        path: row.path,
        blobScope: row.blobScope,
        sha256: row.sha256,
        sizeBytes: Number(row.sizeBytes),
        mimeType: row.mimeType,
      })),
      onlyReferencedMedia: true,
    });

    abortController.signal.throwIfAborted();

    // 4. Build strict stripped env (NO secrets!) and spawn hyperframes render.
    failureStage = 'render';
    failureCode = 'EXPORT_RENDER_FAILED';
    await checkpointStage('rendering', 15);

    const renderEnv = buildRenderSubprocessEnv({
      ephemeralHomeDir,
      ephemeralTmpDir,
      sourceEnv: deps.sourceEnv,
    });
    assertRenderSubprocessEnvClean(renderEnv);

    let lastPublishAt = 0;
    const renderArgs = buildRenderExportArgs({
      compositionPath,
      outputFilePath,
      format,
      settings: payload.settings,
    });

    const runRender = deps.runRenderCommand ?? runHyperframesIsolated;
    const renderResult = await runRender(runtimeRoot, projectDir, renderArgs, {
      env: renderEnv,
      timeoutMs: RENDER_TIMEOUT_MS,
      signal: abortController.signal,
      onStdoutLine: (line) => {
        const parsed = parseRenderProgressLine(line);
        if (!parsed) return;
        const nowMs = Date.now();
        if (nowMs - lastPublishAt < PROGRESS_PUBLISH_MIN_INTERVAL_MS) return;
        lastPublishAt = nowMs;
        const scaledProgress =
          parsed.progress !== undefined ? Math.max(15, Math.min(85, Math.round(15 + parsed.progress * 0.7))) : 50;
        void publishProgress('running', parsed.stage ?? 'rendering', scaledProgress);
      },
    });

    const renderLogContent = `${renderResult.stdout}\n${renderResult.stderr}`.trim() + '\n';
    const logKey = exportKey(workspaceId, jobId, 'render.log');
    const logBytes = Buffer.from(renderLogContent, 'utf8');
    await deps.storage.putObject(logKey, logBytes, 'text/plain; charset=utf-8', logBytes.byteLength).catch(() => {});

    if (renderResult.code !== 0) {
      throw new Error(
        `Hyperframes render exited with code ${renderResult.code}: ${(renderResult.stderr || renderResult.stdout).slice(-1800)}`,
      );
    }

    // 5. Output sanity + technical verification via scripts/verify-export.ts.
    failureStage = 'output';
    failureCode = 'EXPORT_OUTPUT_INVALID';
    await verifyContainerHeader(outputFilePath, format);

    let verificationReport: VerificationReport | undefined;
    if (format === 'mp4') {
      failureStage = 'verification';
      failureCode = 'EXPORT_VERIFICATION_FAILED';
      await checkpointStage('verifying', 88);

      const expectation =
        payload.expected ??
        (deps.extractExpectationFn
          ? await deps.extractExpectationFn(runtimeRoot, projectDir, compositionPath)
          : await snapshotExportExpectationIsolated(runtimeRoot, projectDir, compositionPath, {
              env: renderEnv,
              timeoutMs: 60_000,
              signal: abortController.signal,
            }));

      const verifyFn =
        deps.verifyExportFn ??
        ((file: string, exp: ExportExpectation, signal?: AbortSignal) =>
          verifyExport(file, exp, verificationBinaries(), signal));

      verificationReport = await verifyFn(outputFilePath, expectation, abortController.signal);
      if (verificationReport.status !== 'passed') {
        if (verificationReport.status === 'blocked') {
          failureCode = 'EXPORT_VERIFICATION_BLOCKED';
        }
        throw new Error(`EXPORT_VERIFICATION_FAILED: ${JSON.stringify(verificationReport.checks)}`);
      }
    }

    // 6. Upload verified MP4 to tenant S3 export keyspace and finalize with fencing check.
    failureStage = 'uploading';
    failureCode = 'EXPORT_UPLOAD_FAILED';
    await checkpointStage('uploading', 94);

    const outputStat = await stat(outputFilePath);
    const outputSha256 = verificationReport?.sha256 ?? (await computeFileSha256(outputFilePath));
    const outputKey = exportKey(workspaceId, jobId, safeOutputName);
    const mimeType = mimeTypeForExportFormat(format);

    await deps.storage.putObject(outputKey, createReadStream(outputFilePath), mimeType, outputStat.size);
    uploadedOutputKey = outputKey;

    const durationMs = Date.now() - startedMs;
    const resultJson: Record<string, unknown> = {
      s3Key: outputKey,
      logS3Key: logKey,
      outputName: safeOutputName,
      format,
      mimeType,
      bytes: outputStat.size,
      sha256: outputSha256,
      durationMs,
      ...(verificationReport ? { verification: verificationReport } : {}),
    };

    const finishNow = new Date();
    const finalized = await deps.db
      .update(jobs)
      .set(
        asUpdate(jobs, {
          state: 'completed',
          stage: 'completed',
          progress: 100,
          resultJson,
          terminalAt: finishNow,
          updatedAt: finishNow,
        }),
      )
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.workspaceId, workspaceId),
          eq(jobs.claimToken, claimToken),
          eq(jobs.state, 'running'),
        ),
      )
      .returning({ id: jobs.id });

    if (finalized.length === 0) {
      // Job was cancelled while uploading; delete uploaded artifact and transition cleanly to cancelled.
      await deps.storage.deleteObject(outputKey).catch(() => {});
      uploadedOutputKey = null;
      await deps.db
        .update(jobs)
        .set(
          asUpdate(jobs, {
            state: 'cancelled',
            stage: 'cancelled',
            terminalAt: finishNow,
            updatedAt: finishNow,
          }),
        )
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.workspaceId, workspaceId),
            eq(jobs.claimToken, claimToken),
            eq(jobs.state, 'cancelling'),
          ),
        );
      await publishProgress('cancelled', 'cancelled', 0);
      return { jobId, state: 'cancelled' };
    }

    await publishProgress('completed', 'completed', 100, { resultJson });
    return { jobId, state: 'completed', ...resultJson };
  } catch (error) {
    if (claimed) {
      const isCancelled =
        abortController.signal.aborted || (error instanceof Error && error.message === 'COMMAND_CANCELLED');
      const errCode = (error as NodeJS.ErrnoException | undefined)?.code;
      if (failureStage === 'render' && errCode === 'COMMAND_TIMEOUT') {
        failureCode = 'EXPORT_RENDER_TIMEOUT';
      } else if (failureStage === 'output' && errCode === 'ENOENT') {
        failureCode = 'EXPORT_OUTPUT_MISSING';
      }

      if (uploadedOutputKey) {
        await deps.storage.deleteObject(uploadedOutputKey).catch(() => {});
      }

      const failNow = new Date();
      if (isCancelled) {
        try {
          await deps.db
            .update(jobs)
            .set(
              asUpdate(jobs, {
                state: 'cancelled',
                stage: 'cancelled',
                terminalAt: failNow,
                updatedAt: failNow,
              }),
            )
            .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId), eq(jobs.claimToken, claimToken)));
        } catch {
          // Best-effort terminal persistence during error handling.
        }
        await publishProgress('cancelled', 'cancelled', 0);
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Export render failed';
        try {
          await deps.db
            .update(jobs)
            .set(
              asUpdate(jobs, {
                state: 'failed',
                stage: 'failed',
                failureStage,
                errorCode: failureCode,
                errorMessage,
                terminalAt: failNow,
                updatedAt: failNow,
              }),
            )
            .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId), eq(jobs.claimToken, claimToken)));
        } catch {
          // Best-effort terminal persistence during error handling.
        }
        await publishProgress('failed', 'failed', 0, {
          errorCode: failureCode,
          errorMessage,
        });
      }
    }
    throw error;
  } finally {
    if (unsubscribeCancel) {
      await unsubscribeCancel().catch(() => {});
    }
    // CRITICAL INVARIANT: ALWAYS wipe ephemeral /tmp/om-render-<jobId> on success, failure, or cancellation!
    await rm(renderRootDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultRenderCompositionThumbnail(params: {
  runtimeRoot: string;
  projectDir: string;
  compositionPath: string;
  outputPngPath: string;
  timeSec: number;
  width: number;
  height: number;
  env: Record<string, string>;
  signal?: AbortSignal;
}): Promise<void> {
  // Use hyperframes@0.9.7 built-in `snapshot` subcommand in stripped env so Chromium executes
  // strictly inside the allowlisted env without leaking worker secrets.
  const framesDir = path.join(path.dirname(params.outputPngPath), 'frames');
  await mkdir(framesDir, { recursive: true, mode: 0o700 });
  const compositionId = await prepareThumbnailEntry(params.projectDir, params.compositionPath);
  const args = buildThumbnailSnapshotArgs({
    framesDir,
    timeSec: params.timeSec,
    compositionId,
  });

  const result = await runHyperframesIsolated(params.runtimeRoot, params.projectDir, args, {
    env: params.env,
    timeoutMs: THUMBNAIL_TIMEOUT_MS,
    signal: params.signal,
  });
  if (result.code !== 0) {
    throw new Error(`Composition thumbnail snapshot failed: ${(result.stderr || result.stdout).slice(-1000)}`);
  }

  const allPngs = (await readdir(framesDir))
    .filter((name) => name.toLowerCase().endsWith('.png') && !name.includes('contact'))
    .sort();
  const targetPng = allPngs.find((name) => name.startsWith('at-')) ?? allPngs[0];
  if (!targetPng) {
    throw new Error('Composition thumbnail snapshot produced no PNG frames');
  }

  const rawFrame = await readFile(path.join(framesDir, targetPng));
  const resized = await sharp(rawFrame)
    .resize({
      width: params.width,
      height: params.height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  await writeFile(params.outputPngPath, resized, { mode: 0o600 });
}

/**
 * Execute a `render_thumbnail` job on `worker-render`:
 * Hydrates snapshot into ephemeral `/tmp/om-thumb-<uuid>`, injects Studio parity scripts,
 * renders PNG via strictly stripped env, uploads to `compThumbnailKey(wid, projectId, cacheKey)`,
 * and ALWAYS wipes `/tmp` in `finally`.
 */
export async function processRenderThumbnailJob(
  deps: RenderExportDeps,
  payload: RenderExportPayloadMap['render_thumbnail'],
): Promise<{ key: string; bytes: number }> {
  const thumbRootDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-thumb-${randomUUID()}`);
  const projectDir = path.join(thumbRootDir, 'project');
  const ephemeralHomeDir = path.join(thumbRootDir, 'home');
  const ephemeralTmpDir = path.join(thumbRootDir, 'tmp');
  const outputPngPath = path.join(thumbRootDir, 'thumb.png');
  const runtimeRoot = deps.runtimeRoot ?? pluginRoot;

  try {
    await Promise.all([
      mkdir(projectDir, { recursive: true, mode: 0o700 }),
      mkdir(ephemeralHomeDir, { recursive: true, mode: 0o700 }),
      mkdir(ephemeralTmpDir, { recursive: true, mode: 0o700 }),
    ]);

    const snapshotFiles: HydratedSnapshotFile[] = payload.versionId
      ? (
          await deps.db
            .select({
              path: projectVersionFiles.path,
              blobScope: projectVersionFiles.blobScope,
              sha256: projectVersionFiles.sha256,
              sizeBytes: projectVersionFiles.sizeBytes,
              mimeType: projectVersionFiles.mimeType,
            })
            .from(projectVersionFiles)
            .where(
              and(
                eq(projectVersionFiles.versionId, payload.versionId),
                eq(projectVersionFiles.workspaceId, payload.workspaceId),
                eq(projectVersionFiles.projectId, payload.projectId),
              ),
            )
        ).map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }))
      : (
          await deps.db
            .select({
              path: projectFiles.path,
              blobScope: projectFiles.blobScope,
              sha256: projectFiles.sha256,
              sizeBytes: projectFiles.sizeBytes,
              mimeType: projectFiles.mimeType,
            })
            .from(projectFiles)
            .where(
              and(
                eq(projectFiles.workspaceId, payload.workspaceId),
                eq(projectFiles.projectId, payload.projectId),
              ),
            )
        ).map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));

    if (snapshotFiles.length === 0) {
      throw new CloudError('NOT_FOUND', 'No project files found to render composition thumbnail', { status: 404 });
    }

    await hydrateSnapshotFilesToDir({
      storage: deps.storage,
      workspaceId: payload.workspaceId,
      projectDir,
      compositionPath: payload.compositionPath,
      files: snapshotFiles,
      onlyReferencedMedia: true,
    });

    const renderEnv = buildRenderSubprocessEnv({
      ephemeralHomeDir,
      ephemeralTmpDir,
      sourceEnv: deps.sourceEnv,
    });
    assertRenderSubprocessEnvClean(renderEnv);

    if (deps.renderThumbnailFn) {
      await deps.renderThumbnailFn({
        projectDir,
        compositionPath: payload.compositionPath,
        outputPngPath,
        timeSec: payload.timeSec,
        width: payload.width,
        height: payload.height,
        env: renderEnv,
      });
    } else {
      await defaultRenderCompositionThumbnail({
        runtimeRoot,
        projectDir,
        compositionPath: payload.compositionPath,
        outputPngPath,
        timeSec: payload.timeSec,
        width: payload.width,
        height: payload.height,
        env: renderEnv,
      });
    }

    const pngBytes = await readFile(outputPngPath);
    const destKey = compThumbnailKey(payload.workspaceId, payload.projectId, payload.cacheKey);
    await deps.storage.putObject(destKey, pngBytes, 'image/png', pngBytes.byteLength);
    return { key: destKey, bytes: pngBytes.byteLength };
  } finally {
    // CRITICAL INVARIANT: ALWAYS wipe ephemeral /tmp/om-thumb-* directory!
    await rm(thumbRootDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function processRenderExportQueueJob<K extends RenderExportJobName>(
  deps: RenderExportDeps,
  name: K,
  payload: RenderExportPayloadMap[K],
): Promise<unknown> {
  if (name === 'export_render') {
    return processExportRenderJob(deps, payload as RenderExportPayloadMap['export_render']);
  }
  if (name === 'render_thumbnail') {
    return processRenderThumbnailJob(deps, payload as RenderExportPayloadMap['render_thumbnail']);
  }
  throw new Error(`Unknown render-export job: ${String(name)}`);
}
