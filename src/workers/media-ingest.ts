import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { stripSdrPngColourTags } from '@hyperframes/core/compiler/png-colour-tags';
import {
  DEFAULT_TARGET_LUFS,
  absoluteLoudnessPlan,
  loudnessMeasureArgs,
  parseEbur128Summary,
} from '@hyperframes/studio-server/loudness';
import { and, eq, gt, sql } from 'drizzle-orm';
import sharp, { type OverlayOptions } from 'sharp';
import { resolveBrandAddresses } from '../../gateway/brand-network.ts';
import { execute, pluginRoot } from '../../hyperframes.ts';
import { verificationBinaries } from '../../scripts/verify-export.ts';
import { MAX_ASSET_BYTES } from '../../shared/asset-limits.ts';
import type { AssetReadResult } from '../../shared/asset-library.ts';
import { computeProjectRevision, isTextProjectPath, isUuid, projectPath } from '../../shared/project-validation.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { JobProgressEvent, ProjectEvent } from '../contracts/events.ts';
import type { MediaIngestJobName, MediaIngestPayloadMap } from '../contracts/jobs.ts';
import type {
  BlobMetadata,
  StoragePort,
  VideoSpriteManifest,
  VideoSpriteMetadata,
  VideoSpriteSheetEntry,
} from '../contracts/storage.ts';
import {
  applyWorkspaceBlobRefDeltas,
  normalizeBlobRefDeltas,
  updateWorkspaceBlobMetadata,
  type BlobRefDelta,
  type PreviewProxyMetadata,
  type WorkspaceBlobMetadataPatch,
} from '../db/cas.ts';
import type { Database, DbExecutor } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import {
  assets,
  assetVersions,
  uploadTickets,
  workspaceBlobs,
  type AssetModality,
} from '../db/schema/blobs-assets.ts';
import { jobs } from '../db/schema/jobs.ts';
import {
  projectFiles,
  projectHistoryEntries,
  projectVersionFiles,
  projectVersions,
} from '../db/schema/project-files.ts';
import { projects } from '../db/schema/projects.ts';
import type { Logger } from '../infra/logger.ts';
import {
  buildImageThumbnailJobId,
  buildPreviewProxyJobId,
  buildVideoSpriteJobId,
  buildWaveformPeaksJobId,
  type QueueService,
} from '../infra/queues.ts';
import { jobChannel, projectChannel, type RedisEventBus } from '../infra/redis.ts';
import {
  assertTenantScopedKey,
  catalogBlobKey,
  derivedAssetKey,
  thumbnailKey,
  uploadStagingKey,
  workspaceBlobKey,
} from '../infra/storage.ts';
import {
  isHardenedPublicIp,
  validatePublicImportUrl,
} from '../services/asset-library-service.ts';

export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_FETCH_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_FETCH_TOTAL_TIMEOUT_MS = 300_000;
export const PREVIEW_PROXY_IMAGE_MIN_BYTES = 100 * 1024;
export const PREVIEW_PROXY_IMAGE_MAX_WIDTH = 1920;
export const SPRITE_MAX_TILE_WIDTH = 160;
export const SPRITE_MAX_TILE_HEIGHT = 90;
export const SPRITE_COLUMNS = 10;
export const SPRITE_ROWS = 6;
export const SPRITE_FRAMES_PER_SHEET = SPRITE_COLUMNS * SPRITE_ROWS;
export const SPRITE_MAX_FRAMES = 120;
const BLOB_GC_RETRY_MAX = 5;
const BLOB_GC_RETRY_DELAY_MS = 150;
const ASSET_READ_MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const ASSET_READ_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function parsePositiveIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export class AsyncSemaphore {
  readonly limit: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const lightFfmpegSemaphore = new AsyncSemaphore(
  parsePositiveIntEnv('MEDIA_LIGHT_FFMPEG_CONCURRENCY', 3, 1, 16),
);
const proxyFfmpegSemaphore = new AsyncSemaphore(
  parsePositiveIntEnv('MEDIA_PROXY_CONCURRENCY', 2, 1, 8),
);

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function computeSpriteTileDimensions(
  width?: number,
  height?: number,
): { frameWidth: number; frameHeight: number } {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { frameWidth: SPRITE_MAX_TILE_WIDTH, frameHeight: SPRITE_MAX_TILE_HEIGHT };
  }
  const scale = Math.min(SPRITE_MAX_TILE_WIDTH / width, SPRITE_MAX_TILE_HEIGHT / height, 1);
  const rawW = Math.max(16, Math.round((width * scale) / 2) * 2);
  const rawH = Math.max(16, Math.round((height * scale) / 2) * 2);
  return {
    frameWidth: Math.min(SPRITE_MAX_TILE_WIDTH, rawW),
    frameHeight: Math.min(SPRITE_MAX_TILE_HEIGHT, rawH),
  };
}

export function computeSpriteSamplingPlan(durationSec: number): { targetFrames: number; intervalSec: number } {
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1;
  let targetFrames: number;
  if (safeDuration <= 2) {
    targetFrames = Math.max(1, Math.min(4, Math.ceil(safeDuration * 2)));
  } else if (safeDuration <= 60) {
    targetFrames = Math.max(2, Math.min(SPRITE_FRAMES_PER_SHEET, Math.ceil(safeDuration)));
  } else {
    targetFrames = Math.min(SPRITE_MAX_FRAMES, Math.max(SPRITE_FRAMES_PER_SHEET, Math.ceil(safeDuration / 2)));
  }
  const intervalSec = Math.max(0.25, safeDuration / targetFrames);
  return { targetFrames, intervalSec };
}

async function publishMediaDerivedReady(
  deps: Pick<MediaIngestDeps, 'db' | 'eventBus' | 'logger'>,
  params: {
    workspaceId: string;
    sha256: string;
    kind: 'thumbnail' | 'sprite' | 'waveform' | 'proxy' | 'metadata';
    status: 'ready' | 'failed';
    projectId?: string;
  },
): Promise<void> {
  const byProject = new Map<string, string[]>();
  if (params.projectId && isUuid(params.projectId)) {
    byProject.set(params.projectId, []);
  }

  try {
    const rows = await deps.db
      .select({
        projectId: projectFiles.projectId,
        path: projectFiles.path,
      })
      .from(projectFiles)
      .where(and(eq(projectFiles.workspaceId, params.workspaceId), eq(projectFiles.sha256, params.sha256)));

    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row.projectId !== 'string' || !isUuid(row.projectId)) continue;
        const list = byProject.get(row.projectId) ?? [];
        if (typeof row.path === 'string' && row.path.length > 0 && !list.includes(row.path)) {
          list.push(row.path);
        }
        byProject.set(row.projectId, list);
      }
    }
  } catch {
    // Lightweight mock databases in unit tests may not model project_files lookups.
  }

  if (byProject.size === 0) return;

  const ts = Date.now();
  await Promise.allSettled(
    [...byProject.entries()].map(([projectId, paths]) => {
      const evt: ProjectEvent = {
        type: 'media-derived-ready',
        workspaceId: params.workspaceId,
        projectId,
        sha256: params.sha256,
        kind: params.kind,
        status: params.status,
        ...(paths.length > 0 ? { paths } : {}),
        ts,
      };
      return deps.eventBus.publish(projectChannel(params.workspaceId, projectId), evt);
    }),
  );
}

async function enqueueDerivedMediaJobs(
  deps: Pick<MediaIngestDeps, 'queues' | 'logger'>,
  params: {
    workspaceId: string;
    blobScope: 'workspace' | 'catalog';
    sha256: string;
    mimeType: string;
    sizeBytes: number;
    probed?: ProbedMediaInfo | null;
    projectId?: string;
    skipThumbnail?: boolean;
  },
): Promise<void> {
  if (!deps.queues) return;
  const queues = deps.queues;
  const mime = params.mimeType.trim().toLowerCase().split(';')[0] ?? '';
  const modality =
    params.probed?.modality ??
    (mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : mime.startsWith('image/')
          ? 'image'
          : undefined);

  const tasks: Array<{ name: MediaIngestJobName; run: () => Promise<unknown> }> = [];

  if (modality === 'video') {
    tasks.push({
      name: 'generate_video_sprite',
      run: () =>
        queues.enqueueMediaIngest(
          'generate_video_sprite',
          {
            workspaceId: params.workspaceId,
            blobScope: params.blobScope,
            sha256: params.sha256,
            ...(params.projectId ? { projectId: params.projectId } : {}),
            ...(params.probed?.durationSec !== undefined ? { durationSec: params.probed.durationSec } : {}),
            ...(params.probed?.width !== undefined ? { width: params.probed.width } : {}),
            ...(params.probed?.height !== undefined ? { height: params.probed.height } : {}),
          },
          { jobId: buildVideoSpriteJobId(params.workspaceId, params.sha256) },
        ),
    });

    if (params.probed?.hasAudio !== false) {
      tasks.push({
        name: 'extract_waveform_peaks',
        run: () =>
          queues.enqueueMediaIngest(
            'extract_waveform_peaks',
            {
              workspaceId: params.workspaceId,
              blobScope: params.blobScope,
              sha256: params.sha256,
              ...(params.projectId ? { projectId: params.projectId } : {}),
              samples: 2048,
            },
            { jobId: buildWaveformPeaksJobId(params.workspaceId, params.sha256) },
          ),
      });
    }

    if (!params.skipThumbnail) {
      tasks.push({
        name: 'image_thumbnail',
        run: () =>
          queues.enqueueMediaIngest(
            'image_thumbnail',
            {
              workspaceId: params.workspaceId,
              blobScope: params.blobScope,
              sha256: params.sha256,
              ...(params.projectId ? { projectId: params.projectId } : {}),
              spec: 'w320',
              width: 320,
            },
            { jobId: buildImageThumbnailJobId(params.workspaceId, params.sha256, 'w320') },
          ),
      });
    }
  } else if (modality === 'audio') {
    tasks.push({
      name: 'extract_waveform_peaks',
      run: () =>
        queues.enqueueMediaIngest(
          'extract_waveform_peaks',
          {
            workspaceId: params.workspaceId,
            blobScope: params.blobScope,
            sha256: params.sha256,
            ...(params.projectId ? { projectId: params.projectId } : {}),
            samples: 2048,
          },
          { jobId: buildWaveformPeaksJobId(params.workspaceId, params.sha256) },
        ),
    });
  } else if (modality === 'image' && mime !== 'image/svg+xml' && !params.skipThumbnail) {
    tasks.push({
      name: 'image_thumbnail',
      run: () =>
        queues.enqueueMediaIngest(
          'image_thumbnail',
          {
            workspaceId: params.workspaceId,
            blobScope: params.blobScope,
            sha256: params.sha256,
            ...(params.projectId ? { projectId: params.projectId } : {}),
            spec: 'w320',
            width: 320,
          },
          { jobId: buildImageThumbnailJobId(params.workspaceId, params.sha256, 'w320') },
        ),
    });
  }

  if (params.blobScope === 'workspace') {
    const proxyTarget = classifyPreviewProxyTarget({
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      width: params.probed?.width,
      height: params.probed?.height,
    });
    if (proxyTarget) {
      tasks.push({
        name: 'generate_preview_proxy',
        run: () =>
          queues.enqueueMediaIngest(
            'generate_preview_proxy',
            {
              kind: 'generate_preview_proxy',
              workspaceId: params.workspaceId,
              sha256: params.sha256,
              ...(params.projectId ? { projectId: params.projectId } : {}),
              mimeType: params.mimeType,
              sizeBytes: params.sizeBytes,
              ...(params.probed?.width !== undefined ? { width: params.probed.width } : {}),
              ...(params.probed?.height !== undefined ? { height: params.probed.height } : {}),
            },
            { jobId: buildPreviewProxyJobId(params.workspaceId, params.sha256) },
          ),
      });
    }
  }

  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks.map((t) => t.run()));
  results.forEach((res, idx) => {
    if (res.status === 'rejected') {
      deps.logger.warn('Best-effort derived media enqueue failed (ingest still committed)', {
        workspaceId: params.workspaceId,
        sha256: params.sha256,
        jobName: tasks[idx]?.name,
        mimeType: params.mimeType,
        error: res.reason,
      });
    }
  });
}

export type PreviewProxyTrackKind = 'video' | 'image' | 'audio';

export interface PreviewProxyTarget {
  track: PreviewProxyTrackKind;
  derivedName: string;
  mimeType: string;
  codec: string;
}

const PROXY_ELIGIBLE_RASTER_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
  'image/bmp',
  'image/avif',
]);

const PROXY_ELIGIBLE_AUDIO_MIMES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
]);

/**
 * Determine whether an ingested workspace media blob should have a lightweight preview proxy
 * generated in `workspaces/{wid}/derived/{sha256}/proxy.{mp4,webp,m4a}`.
 */
export function classifyPreviewProxyTarget(input: {
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
}): PreviewProxyTarget | null {
  const mime = input.mimeType.trim().toLowerCase().split(';')[0] ?? '';
  if (mime.startsWith('video/')) {
    return { track: 'video', derivedName: 'proxy.mp4', mimeType: 'video/mp4', codec: 'h264' };
  }
  if (mime === 'image/svg+xml' || mime === 'image/gif' || mime === 'image/webp') {
    return null;
  }
  if (PROXY_ELIGIBLE_RASTER_IMAGE_MIMES.has(mime)) {
    const exceedsBytes = input.sizeBytes > PREVIEW_PROXY_IMAGE_MIN_BYTES;
    const exceedsWidth = typeof input.width === 'number' && input.width > PREVIEW_PROXY_IMAGE_MAX_WIDTH;
    if (!exceedsBytes && !exceedsWidth) return null;
    return { track: 'image', derivedName: 'proxy.webp', mimeType: 'image/webp', codec: 'webp' };
  }
  if (PROXY_ELIGIBLE_AUDIO_MIMES.has(mime)) {
    return { track: 'audio', derivedName: 'proxy.m4a', mimeType: 'audio/mp4', codec: 'aac' };
  }
  return null;
}

export interface ProbedMediaInfo {
  modality: AssetModality;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
  codec?: string;
  audioCodec?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  rotation?: number;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
}

export interface SafeFetchOptions {
  maxBytes?: number;
  maxRedirects?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  allowDohFakeIpFallback?: boolean;
  signal?: AbortSignal;
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
  resolveDns?: (hostname: string, signal: AbortSignal) => Promise<Array<{ address: string; family: number }>>;
}

export interface SafeFetchResult {
  finalUrl: string;
  bytes: number;
  sha256: string;
  contentType?: string;
}

export interface MediaIngestDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly eventBus: Pick<RedisEventBus, 'publish'>;
  readonly logger: Logger;
  readonly workerId: string;
  readonly queues?: Pick<QueueService, 'enqueueMediaIngest'>;
  readonly allowDohFakeIpFallback?: boolean;
  readonly tmpBaseDir?: string;
  readonly probeMedia?: (filePath: string) => Promise<ProbedMediaInfo>;
  readonly fetchPublicUrlToFile?: (
    url: string,
    destPath: string,
    options?: SafeFetchOptions,
  ) => Promise<SafeFetchResult>;
  readonly generateThumbnailBuffer?: (
    filePath: string,
    media: ProbedMediaInfo,
    options: { width: number; height?: number; timestampSec?: number },
  ) => Promise<Buffer | null>;
  readonly runFfmpegCommand?: (
    binary: 'ffmpeg' | 'ffprobe',
    args: string[],
    cwd: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  readonly applyBlobDeltas?: (
    tx: DbExecutor,
    workspaceId: string,
    deltas: readonly BlobRefDelta[],
  ) => Promise<void>;
}

function parseFrameRate(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parts = raw.split('/').map(Number);
  if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[1] > 0) {
    return Math.round((parts[0] / parts[1]) * 1000) / 1000;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function toBlobMetadata(media: ProbedMediaInfo, extra: Partial<BlobMetadata> = {}): BlobMetadata {
  return {
    modality: media.modality,
    mimeType: media.mimeType,
    ...(media.width !== undefined ? { width: media.width } : {}),
    ...(media.height !== undefined ? { height: media.height } : {}),
    ...(media.durationSec !== undefined ? { durationSec: media.durationSec } : {}),
    ...(media.fps !== undefined ? { fps: media.fps } : {}),
    ...(media.codec ? { codec: media.codec } : {}),
    ...(media.audioCodec ? { audioCodec: media.audioCodec } : {}),
    ...(media.hasAudio !== undefined ? { hasAudio: media.hasAudio } : {}),
    ...(media.hasVideo !== undefined ? { hasVideo: media.hasVideo } : {}),
    ...(media.rotation !== undefined ? { rotation: media.rotation } : {}),
    ...(media.sampleRate !== undefined ? { sampleRate: media.sampleRate } : {}),
    ...(media.channels !== undefined ? { channels: media.channels } : {}),
    ...(media.bitrate !== undefined ? { bitrate: media.bitrate } : {}),
    ...extra,
  };
}

async function defaultRunFfmpegCommand(
  binary: 'ffmpeg' | 'ffprobe',
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const bins = verificationBinaries();
  return execute(binary === 'ffmpeg' ? bins.ffmpeg : bins.ffprobe, args, cwd, timeoutMs, {}, signal);
}

/**
 * Inspect media bytes using `ffprobe` + 1-frame `ffmpeg` decode check (matching `gateway/asset-probe.ts`
 * without calling local desktop `requireNativeRuntime`).
 */
export async function probeMediaFile(
  filePath: string,
  runCmd: NonNullable<MediaIngestDeps['runFfmpegCommand']> = defaultRunFfmpegCommand,
): Promise<ProbedMediaInfo> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ASSET_BYTES) {
    throw new CloudError('INVALID_ARGUMENT', `Asset must be a file of at most ${MAX_ASSET_BYTES} bytes`, {
      status: 400,
    });
  }

  const probe = await runCmd(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
    path.dirname(filePath),
    60_000,
  );
  if (probe.code !== 0) {
    throw new CloudError('INVALID_ARGUMENT', 'File is not readable image, video, or audio media', { status: 400 });
  }

  const parsed = JSON.parse(probe.stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: {
      format_name?: string;
      duration?: string;
      bit_rate?: string;
      tags?: Record<string, unknown>;
    };
  };
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find(
    (s) => s.codec_type === 'video' && !(s.disposition as Record<string, unknown> | undefined)?.attached_pic,
  );
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const primary = videoStream ?? audioStream;
  if (!primary) {
    throw new CloudError('INVALID_ARGUMENT', 'Unsupported media type (no video or audio streams)', { status: 400 });
  }

  const formatName = String(parsed.format?.format_name ?? '');
  const majorBrand = String(parsed.format?.tags?.major_brand ?? '').trim();
  const isAvif = formatName.includes('mov') && /^avi[fs]$/.test(majorBrand);
  const imageCodecs: Record<string, [string, string]> = {
    png: ['image/png', 'png'],
    mjpeg: ['image/jpeg', 'jpg'],
    webp: ['image/webp', 'webp'],
    gif: ['image/gif', 'gif'],
    av1: ['image/avif', 'avif'],
  };
  const primaryCodec = String(primary.codec_name ?? '');
  const imageMatch = isAvif || /image2|_pipe|^gif$/.test(formatName) ? imageCodecs[primaryCodec] : undefined;

  const audioFormats: Record<string, [string, string]> = {
    wav: ['audio/wav', 'wav'],
    mp3: ['audio/mpeg', 'mp3'],
    ogg: ['audio/ogg', 'ogg'],
    flac: ['audio/flac', 'flac'],
    aac: ['audio/aac', 'aac'],
  };
  const resolvedKind: [string, string] | undefined =
    imageMatch ??
    (primary.codec_type === 'video' && formatName.includes('mov')
      ? ['video/mp4', 'mp4']
      : primary.codec_type === 'video' && /webm|matroska/.test(formatName)
        ? ['video/webm', 'webm']
        : primary.codec_type === 'audio'
          ? audioFormats[formatName] ??
            (formatName.includes('mov')
              ? ['audio/mp4', 'm4a']
              : /webm|matroska/.test(formatName)
                ? ['audio/webm', 'webm']
                : undefined)
          : undefined);

  const rawWidth = Number(primary.width ?? 0);
  const rawHeight = Number(primary.height ?? 0);
  if (!resolvedKind || (primary.codec_type === 'video' && !(rawWidth > 0 && rawHeight > 0))) {
    throw new CloudError('INVALID_ARGUMENT', 'Unsupported media format or dimensions', { status: 400 });
  }

  // Verify at least 1 frame/packet decodes cleanly (guards against spoofed headers).
  const streamIndex = Number(primary.index ?? 0);
  const decodeCheck = await runCmd(
    'ffmpeg',
    [
      '-v',
      'error',
      '-xerror',
      '-err_detect',
      'explode',
      '-i',
      filePath,
      '-map',
      `0:${streamIndex}`,
      primary.codec_type === 'video' ? '-frames:v' : '-frames:a',
      '1',
      '-f',
      'null',
      '-',
    ],
    path.dirname(filePath),
    60_000,
  );
  if (decodeCheck.code !== 0) {
    throw new CloudError('INVALID_ARGUMENT', 'Media file failed decode validation', { status: 400 });
  }

  const sideData = Array.isArray(primary.side_data_list)
    ? (primary.side_data_list as Array<Record<string, unknown>>)
    : [];
  const rotationValue = Number(sideData.find((d) => d.rotation !== undefined)?.rotation ?? 0);
  const turned = Math.abs(rotationValue) % 180 === 90;
  const modality = resolvedKind[0].split('/')[0] as AssetModality;
  const durationNum = Number(parsed.format?.duration ?? primary.duration ?? NaN);
  const bitrateNum = Number(parsed.format?.bit_rate ?? primary.bit_rate ?? NaN);
  const sampleRateNum = Number(audioStream?.sample_rate ?? NaN);
  const channelsNum = Number(audioStream?.channels ?? NaN);

  return {
    modality,
    mimeType: resolvedKind[0],
    extension: resolvedKind[1],
    sizeBytes: info.size,
    ...(rawWidth > 0 && rawHeight > 0
      ? {
          width: turned ? rawHeight : rawWidth,
          height: turned ? rawWidth : rawHeight,
        }
      : {}),
    ...(!imageMatch && Number.isFinite(durationNum) && durationNum > 0 ? { durationSec: durationNum } : {}),
    ...(videoStream ? { fps: parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate) } : {}),
    ...(primaryCodec ? { codec: primaryCodec } : {}),
    ...(audioStream && typeof audioStream.codec_name === 'string' ? { audioCodec: audioStream.codec_name } : {}),
    hasAudio: Boolean(audioStream),
    hasVideo: Boolean(videoStream && !imageMatch),
    ...(Number.isFinite(rotationValue) && rotationValue !== 0 ? { rotation: rotationValue } : {}),
    ...(Number.isFinite(sampleRateNum) && sampleRateNum > 0 ? { sampleRate: sampleRateNum } : {}),
    ...(Number.isFinite(channelsNum) && channelsNum > 0 ? { channels: channelsNum } : {}),
    ...(Number.isFinite(bitrateNum) && bitrateNum > 0 ? { bitrate: bitrateNum } : {}),
  };
}

/**
 * Normalize SDR PNG colour tags (`cICP`/`gAMA`/`cHRM`) via Hyperframes' pure `stripSdrPngColourTags`
 * so Chromium preview and FFmpeg capture render identical sRGB colours (#9 §6.5).
 */
export async function normalizeSdrPngFileIfApplicable(
  filePath: string,
  mimeType: string,
  knownSha256?: string,
): Promise<{ normalized: boolean; sizeBytes: number; sha256: string }> {
  if (mimeType !== 'image/png') {
    const fileInfo = await stat(filePath);
    const sha256 = knownSha256 ?? (await computeFileSha256(filePath));
    return { normalized: false, sizeBytes: fileInfo.size, sha256 };
  }

  const bytes = await readFile(filePath);
  const stripped = stripSdrPngColourTags(bytes);
  if (stripped) {
    await writeFile(filePath, stripped);
    const sha256 = createHash('sha256').update(stripped).digest('hex');
    return { normalized: true, sizeBytes: stripped.byteLength, sha256 };
  }
  const sha256 = knownSha256 ?? createHash('sha256').update(bytes).digest('hex');
  return { normalized: false, sizeBytes: bytes.byteLength, sha256 };
}

/**
 * Generate a JPEG thumbnail buffer using `sharp` (directly for images, or via 1-frame `ffmpeg`
 * extract + `sharp` resize for videos).
 */
export async function defaultGenerateThumbnailBuffer(
  filePath: string,
  media: ProbedMediaInfo,
  options: { width: number; height?: number; timestampSec?: number },
  runCmd: NonNullable<MediaIngestDeps['runFfmpegCommand']> = defaultRunFfmpegCommand,
): Promise<Buffer | null> {
  if (media.modality === 'audio') return null;
  let sourceImagePath = filePath;
  let tempFramePath: string | null = null;

  try {
    if (media.modality === 'video') {
      tempFramePath = path.join(path.dirname(filePath), `thumb-frame-${randomUUID()}.png`);
      const seekSec = Math.max(0, options.timestampSec ?? 0);
      const extracted = await runCmd(
        'ffmpeg',
        ['-v', 'error', '-nostdin', '-ss', String(seekSec), '-i', filePath, '-map', '0:V:0', '-frames:v', '1', '-y', tempFramePath],
        path.dirname(filePath),
        30_000,
      );
      if (extracted.code !== 0) return null;
      sourceImagePath = tempFramePath;
    }

    return await sharp(sourceImagePath)
      .rotate()
      .resize({
        width: options.width,
        ...(options.height ? { height: options.height } : {}),
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } finally {
    if (tempFramePath) {
      await rm(tempFramePath, { force: true }).catch(() => {});
    }
  }
}

async function resolvePublicAddressesStrict(
  hostname: string,
  signal: AbortSignal,
  allowDohFakeIpFallback: boolean,
): Promise<Array<{ address: string; family: number }>> {
  let addresses: Array<{ address: string; family: number }>;
  if (allowDohFakeIpFallback) {
    try {
      addresses = await resolveBrandAddresses(hostname, signal);
    } catch (error) {
      throw new CloudError(
        'SSRF_BLOCKED',
        error instanceof Error ? error.message : 'Host resolved to a non-public address',
        { status: 400 },
      );
    }
  } else {
    addresses = await lookup(hostname, { all: true });
    signal.throwIfAborted();
  }

  if (addresses.length === 0 || addresses.some((entry) => !isHardenedPublicIp(entry.address))) {
    throw new CloudError('SSRF_BLOCKED', `Host "${hostname}" resolved to a private or non-public address`, {
      status: 400,
    });
  }
  return addresses;
}

/**
 * SSRF-hardened DNS-pinned streaming HTTPS download to an ephemeral file:
 * - Validates initial URL and EVERY redirect hop via `validatePublicImportUrl`.
 * - Resolves DNS and pins TCP `lookup` to validated public IP addresses (prevents DNS rebinding).
 * - Enforces max redirects (default 3), max byte cap (`MAX_ASSET_BYTES`), idle timeout, and total timeout.
 * - Never sends `Authorization` or `Cookie` headers.
 */
export async function safePublicHttpsFetchToFile(
  rawUrl: string,
  destPath: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_FETCH_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_FETCH_TOTAL_TIMEOUT_MS;
  const allowDoh = options.allowDohFakeIpFallback ?? false;

  const totalController = new AbortController();
  const totalTimer = setTimeout(() => {
    totalController.abort(new CloudError('INVALID_ARGUMENT', 'Public URL download timed out', { status: 408 }));
  }, totalTimeoutMs);
  totalTimer.unref();

  const onParentAbort = () => totalController.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(totalTimer);
      throw new Error('COMMAND_CANCELLED');
    }
    options.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  const resolveDns =
    options.resolveDns ??
    ((hostname: string, signal: AbortSignal) => resolvePublicAddressesStrict(hostname, signal, allowDoh));

  try {
    let currentUrl = validatePublicImportUrl(rawUrl);

    for (let redirectCount = 0; ; redirectCount += 1) {
      const parsed = new URL(currentUrl);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
      const addresses = await resolveDns(hostname, totalController.signal);
      if (addresses.length === 0 || addresses.some((entry) => !isHardenedPublicIp(entry.address))) {
        throw new CloudError('SSRF_BLOCKED', 'DNS resolution returned a non-public IP address', { status: 400 });
      }

      const hopOutcome = await new Promise<
        | { kind: 'redirect'; location: string }
        | { kind: 'done'; bytes: number; sha256: string; contentType?: string }
      >((resolve, reject) => {
        const req = https.get(
          parsed,
          {
            signal: totalController.signal,
            headers: {
              'User-Agent': 'OpenMotion-MediaIngest/1.0',
              Accept: '*/*',
            },
            lookup: (_host, lookupOpts, done) => {
              if ((lookupOpts as { all?: boolean }).all) {
                (done as (err: null, addrs: Array<{ address: string; family: number }>) => void)(null, addresses);
              } else {
                done(null, addresses[0].address, addresses[0].family);
              }
            },
          },
          (res) => {
            const status = res.statusCode ?? 502;
            if (status >= 300 && status < 400 && typeof res.headers.location === 'string') {
              res.resume();
              if (redirectCount >= maxRedirects) {
                reject(new CloudError('SSRF_BLOCKED', `Exceeded maximum redirect count (${maxRedirects})`, { status: 400 }));
                return;
              }
              try {
                const nextUrl = new URL(res.headers.location, parsed).href;
                resolve({ kind: 'redirect', location: nextUrl });
              } catch {
                reject(new CloudError('SSRF_BLOCKED', 'Invalid redirect location URL', { status: 400 }));
              }
              return;
            }

            if (status !== 200) {
              res.resume();
              reject(new CloudError('INVALID_ARGUMENT', `Public URL download failed with HTTP ${status}`, { status: 400 }));
              return;
            }

            const declaredLen = Number(res.headers['content-length'] ?? 0);
            if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
              res.destroy();
              reject(new CloudError('INVALID_ARGUMENT', `Remote asset exceeds maximum size of ${maxBytes} bytes`, { status: 413 }));
              return;
            }

            const digest = createHash('sha256');
            let receivedBytes = 0;
            let lastProgressTs = 0;
            const knownTotal = Number.isFinite(declaredLen) && declaredLen > 0 ? declaredLen : undefined;
            const limiter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                receivedBytes += chunk.byteLength;
                if (receivedBytes > maxBytes) {
                  callback(
                    new CloudError('INVALID_ARGUMENT', `Remote asset exceeds maximum size of ${maxBytes} bytes`, {
                      status: 413,
                    }),
                  );
                  return;
                }
                digest.update(chunk);
                if (options.onProgress) {
                  const nowTs = Date.now();
                  if (nowTs - lastProgressTs >= 500) {
                    lastProgressTs = nowTs;
                    options.onProgress(receivedBytes, knownTotal);
                  }
                }
                callback(null, chunk);
              },
            });

            const out = createWriteStream(destPath, { mode: 0o600 });
            pipeline(res, limiter, out)
              .then(() => {
                if (receivedBytes <= 0) {
                  reject(new CloudError('INVALID_ARGUMENT', 'Remote URL returned an empty body', { status: 400 }));
                  return;
                }
                resolve({
                  kind: 'done',
                  bytes: receivedBytes,
                  sha256: digest.digest('hex'),
                  contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined,
                });
              })
              .catch(reject);
          },
        );

        req.setTimeout(idleTimeoutMs, () => {
          req.destroy(new CloudError('INVALID_ARGUMENT', 'Remote download idle timeout', { status: 408 }));
        });
        req.on('error', reject);
      });

      if (hopOutcome.kind === 'redirect') {
        currentUrl = validatePublicImportUrl(hopOutcome.location);
        continue;
      }
      return {
        finalUrl: currentUrl,
        bytes: hopOutcome.bytes,
        sha256: hopOutcome.sha256,
        contentType: hopOutcome.contentType,
      };
    }
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

async function streamS3ObjectToFile(
  storage: StoragePort,
  s3Key: string,
  destPath: string,
  maxBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  const { stream } = await storage.getObjectStream(s3Key);
  const digest = createHash('sha256');
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.byteLength;
      if (bytes > maxBytes) {
        callback(
          new CloudError('INVALID_ARGUMENT', `Object ${s3Key} exceeds maximum size of ${maxBytes} bytes`, {
            status: 413,
          }),
        );
        return;
      }
      digest.update(buf);
      callback(null, buf);
    },
  });
  await pipeline(stream, limiter, createWriteStream(destPath, { mode: 0o600 }));
  return { bytes, sha256: digest.digest('hex') };
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function retryOnBlobGcConflict<T>(
  reuploadBlobs: () => Promise<void>,
  runTx: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runTx();
    } catch (error) {
      if (isCloudError(error) && error.code === 'BLOB_GC_IN_PROGRESS' && attempt < BLOB_GC_RETRY_MAX) {
        await sleepMs(BLOB_GC_RETRY_DELAY_MS * (attempt + 1));
        await reuploadBlobs();
        continue;
      }
      throw error;
    }
  }
}

const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['.woff2', '.woff', '.ttf', '.otf', '.ttc']);

export interface DetectedFontInfo {
  mimeType: string;
  extension: string;
  sizeBytes: number;
}

/**
 * Inspect font binary magic bytes (`wOF2`, `wOFF`, `OTTO`, TrueType `00 01 00 00`/`true`/`ttcf`)
 * so `project_asset` font uploads (+ companion license) bypass `ffprobe` cleanly.
 */
export async function detectFontBinary(filePath: string, targetPath?: string): Promise<DetectedFontInfo | null> {
  const fh = await open(filePath, 'r');
  let sizeBytes = 0;
  const header = Buffer.alloc(16);
  try {
    const info = await fh.stat();
    sizeBytes = info.size;
    if (sizeBytes < 12 || sizeBytes > MAX_ASSET_BYTES) return null;
    await fh.read(header, 0, 16, 0);
  } finally {
    await fh.close();
  }

  const sigAscii = header.subarray(0, 4).toString('ascii');
  const sigHex = header.subarray(0, 4).toString('hex');
  const ext = targetPath ? path.posix.extname(targetPath).toLowerCase() : '';

  if (sigAscii === 'wOF2') return { mimeType: 'font/woff2', extension: 'woff2', sizeBytes };
  if (sigAscii === 'wOFF') return { mimeType: 'font/woff', extension: 'woff', sizeBytes };
  if (sigAscii === 'OTTO') return { mimeType: 'font/otf', extension: 'otf', sizeBytes };
  if (sigHex === '00010000' || sigAscii === 'true' || sigAscii === 'ttcf') {
    return { mimeType: 'font/ttf', extension: 'ttf', sizeBytes };
  }
  // Reject files claiming a font extension whose magic bytes are not a valid font container.
  if (FONT_EXTENSIONS.has(ext)) {
    throw new CloudError('INVALID_ARGUMENT', 'Uploaded font file has unrecognized or corrupt font header bytes', {
      status: 400,
    });
  }
  return null;
}

async function promoteFileToLibraryOrProject(
  deps: MediaIngestDeps,
  params: {
    jobId: string;
    workspaceId: string;
    filePath: string;
    name: string;
    purpose: 'library_asset' | 'project_asset' | 'project_archive';
    targetAssetId?: string;
    targetProjectId?: string;
    targetPath?: string;
    parentVersionId?: string;
    requestId?: string;
    expectedModality?: AssetModality;
    uploadId?: string;
    licenseBuffer?: Buffer | null;
    licenseFilename?: string | null;
    sourceSha256?: string;
    sourceStagingKey?: string;
    ingestSource?: 'mcp_upload' | 'mcp_url' | 'web_upload';
  },
): Promise<{
  assetId?: string;
  versionId?: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  modality: AssetModality | 'font';
  thumbnailKey?: string;
  projectPath?: string;
  licenseProjectPath?: string;
  projectRevision?: string;
  projectVersionId?: string;
  projectVersionNumber?: number;
}> {
  if (params.purpose === 'project_archive') {
    throw new CloudError(
      'INVALID_ARGUMENT',
      'project_archive uploads must be processed by the archive import service, not media-ingest upload_commit',
      { status: 400 },
    );
  }
  if (params.purpose === 'project_asset' && (!params.targetProjectId || !params.targetPath)) {
    throw new CloudError(
      'INVALID_ARGUMENT',
      'project_asset uploads require both targetProjectId and targetPath',
      { status: 400 },
    );
  }

  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;
  const probe = deps.probeMedia ?? ((file: string) => probeMediaFile(file, runCmd));
  const thumbFn =
    deps.generateThumbnailBuffer ??
    ((file: string, media: ProbedMediaInfo, opts: { width: number; height?: number; timestampSec?: number }) =>
      defaultGenerateThumbnailBuffer(file, media, opts, runCmd));
  const applyDeltas = deps.applyBlobDeltas ?? applyWorkspaceBlobRefDeltas;

  // Support font uploads (`project_asset` + optional companion license) without running ffprobe/thumbnailing.
  const detectedFont =
    params.purpose === 'project_asset' && !params.expectedModality
      ? await detectFontBinary(params.filePath, params.targetPath)
      : null;

  let probed: ProbedMediaInfo | null = null;
  let mimeType: string;
  let modality: AssetModality | 'font';
  let sha256: string;
  let sizeBytes: number;
  let fileWasModified = false;
  let blobMetadata: BlobMetadata | null = null;

  if (detectedFont) {
    sizeBytes = detectedFont.sizeBytes;
    sha256 = params.sourceSha256 ?? (await computeFileSha256(params.filePath));
    mimeType = detectedFont.mimeType;
    modality = 'font';
    blobMetadata = { mimeType: detectedFont.mimeType };
  } else {
    probed = await probe(params.filePath);
    if (params.expectedModality && probed.modality !== params.expectedModality) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        `Uploaded media modality "${probed.modality}" does not match expected "${params.expectedModality}"`,
        { status: 400 },
      );
    }

    // Strip SDR PNG colour tags before finalizing CAS sha256 (#9 §6.5); non-PNG skips full-file RAM read.
    const normalized = await normalizeSdrPngFileIfApplicable(params.filePath, probed.mimeType, params.sourceSha256);
    fileWasModified = normalized.normalized;
    sha256 = normalized.sha256;
    sizeBytes = normalized.sizeBytes;
    mimeType = probed.mimeType;
    modality = probed.modality;
    blobMetadata = toBlobMetadata(probed, normalized.normalized ? { sdrNormalized: true } : {});
  }

  const blobKey = workspaceBlobKey(params.workspaceId, sha256);

  // Optional companion font license blob (e.g. uploaded alongside font/project asset).
  let licenseSha256: string | null = null;
  let licenseBlobKey: string | null = null;
  if (params.licenseBuffer && params.licenseBuffer.byteLength > 0) {
    licenseSha256 = createHash('sha256').update(params.licenseBuffer).digest('hex');
    licenseBlobKey = workspaceBlobKey(params.workspaceId, licenseSha256);
  }

  // Generate thumbnail off-thread before PG tx (skipped for fonts and audio).
  let uploadedThumbKey: string | undefined;
  if (probed) {
    const thumbBuffer = await thumbFn(params.filePath, probed, { width: 320 }).catch(() => null);
    if (thumbBuffer && thumbBuffer.byteLength > 0) {
      uploadedThumbKey = thumbnailKey(params.workspaceId, sha256, 'w320');
      await deps.storage.putObject(uploadedThumbKey, thumbBuffer, 'image/jpeg', thumbBuffer.byteLength);
      if (blobMetadata) {
        blobMetadata = { ...blobMetadata, thumbnailReady: true };
      }
    }
  }

  // INVARIANT: Upload bytes to S3 CAS BEFORE opening PG transaction!
  // Prefer zero-copy S3 server-side CopyObject from staging or streaming upload to avoid buffering large videos in RAM.
  const uploadCasBlobs = async () => {
    if (!fileWasModified && params.sourceStagingKey && deps.storage.copyObject) {
      const existing = await deps.storage.headObject(blobKey);
      if (!existing) {
        await deps.storage.copyObject(params.sourceStagingKey, blobKey, mimeType);
      }
    } else if (deps.storage.putBlobIfAbsentStream) {
      await deps.storage.putBlobIfAbsentStream(
        blobKey,
        () => createReadStream(params.filePath),
        sizeBytes,
        mimeType,
      );
    } else {
      const bytes = await readFile(params.filePath);
      await deps.storage.putBlobIfAbsent(blobKey, bytes, mimeType);
    }
    if (licenseBlobKey && params.licenseBuffer) {
      await deps.storage.putBlobIfAbsent(licenseBlobKey, params.licenseBuffer, 'text/plain; charset=utf-8');
    }
  };
  await uploadCasBlobs();

  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        sha256,
        name: params.name,
        targetAssetId: params.targetAssetId ?? null,
        parentVersionId: params.parentVersionId ?? null,
        requestId: params.requestId ?? null,
      }),
    )
    .digest('hex');

  const committed = await retryOnBlobGcConflict(uploadCasBlobs, () =>
    deps.db.transaction(async (tx) => {
      const deltas: BlobRefDelta[] = [
        {
          sha256,
          delta: 1,
          sizeBytes,
          mimeType,
          s3Key: blobKey,
          metadata: blobMetadata,
        },
      ];

      let createdAssetId: string | undefined;
      let createdVersionId: string | undefined;
      let committedProjectPath: string | undefined;
      let committedLicensePath: string | undefined;
      let committedProjectRevision: string | undefined;
      let committedProjectVersionId: string | undefined;
      let committedProjectVersionNumber: number | undefined;
      const now = new Date();

      if (params.purpose === 'project_asset' && params.targetProjectId && params.targetPath) {
        // Lock parent project row FOR UPDATE so concurrent overwrites to the same path
        // serialize, revision/version snapshots stay linear, and workspace_blobs.ref_count stays exact.
        const lockedProject = await tx
          .select({
            id: projects.id,
            trashed: projects.trashed,
            currentVersionNumber: projects.currentVersionNumber,
            currentHistorySeq: projects.currentHistorySeq,
          })
          .from(projects)
          .where(and(eq(projects.id, params.targetProjectId), eq(projects.workspaceId, params.workspaceId)))
          .for('update')
          .limit(1);
        if (lockedProject.length === 0) {
          throw new CloudError('PROJECT_NOT_FOUND', 'Target project not found', { status: 404 });
        }
        if (lockedProject[0].trashed) {
          throw new CloudError('PROJECT_TRASHED', 'Target project is in trash', { status: 400 });
        }

        committedProjectPath = projectPath(params.targetPath);
        const existingFiles = await tx
          .select()
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.workspaceId, params.workspaceId),
              eq(projectFiles.projectId, params.targetProjectId),
            ),
          );

        const existingFile = existingFiles.find((f) => f.path === committedProjectPath);
        if (existingFile && existingFile.blobScope === 'workspace') {
          deltas.push({ sha256: existingFile.sha256.trim(), delta: -1 });
        }

        let licenseTargetPath: string | null = null;
        if (licenseSha256 && params.licenseBuffer && params.licenseFilename) {
          licenseTargetPath = projectPath(
            path.posix.join(path.posix.dirname(committedProjectPath), params.licenseFilename),
          );
          committedLicensePath = licenseTargetPath;
          const existingLicense = existingFiles.find((f) => f.path === licenseTargetPath);
          if (existingLicense && existingLicense.blobScope === 'workspace') {
            deltas.push({ sha256: existingLicense.sha256.trim(), delta: -1 });
          }
          deltas.push({
            sha256: licenseSha256,
            delta: 1,
            sizeBytes: params.licenseBuffer.byteLength,
            mimeType: 'text/plain; charset=utf-8',
            s3Key: licenseBlobKey!,
          });
        }

        const nextByPath = new Map<
          string,
          {
            path: string;
            blobScope: 'workspace' | 'catalog';
            sha256: string;
            sizeBytes: number;
            mimeType: string;
            isText: boolean;
          }
        >();
        for (const file of existingFiles) {
          nextByPath.set(file.path, {
            path: file.path,
            blobScope: file.blobScope,
            sha256: file.sha256.trim(),
            sizeBytes: Number(file.sizeBytes),
            mimeType: file.mimeType,
            isText: file.isText,
          });
        }
        nextByPath.set(committedProjectPath, {
          path: committedProjectPath,
          blobScope: 'workspace',
          sha256,
          sizeBytes,
          mimeType,
          isText: isTextProjectPath(committedProjectPath),
        });
        if (licenseTargetPath && licenseSha256 && params.licenseBuffer) {
          nextByPath.set(licenseTargetPath, {
            path: licenseTargetPath,
            blobScope: 'workspace',
            sha256: licenseSha256,
            sizeBytes: params.licenseBuffer.byteLength,
            mimeType: 'text/plain; charset=utf-8',
            isText: true,
          });
        }
        const nextFiles = [...nextByPath.values()];

        // Account for the immutable project_version_files snapshot (+1 per workspace-scoped file).
        for (const file of nextFiles) {
          if (file.blobScope === 'workspace') {
            deltas.push({
              sha256: file.sha256,
              delta: 1,
              sizeBytes: file.sizeBytes,
              mimeType: file.mimeType,
              s3Key: workspaceBlobKey(params.workspaceId, file.sha256),
            });
          }
        }

        await applyDeltas(tx, params.workspaceId, normalizeBlobRefDeltas(deltas));

        if (licenseTargetPath && licenseSha256 && params.licenseBuffer) {
          await tx
            .insert(projectFiles)
            .values(
              asInsert(projectFiles, {
                workspaceId: params.workspaceId,
                projectId: params.targetProjectId,
                path: licenseTargetPath,
                blobScope: 'workspace',
                sha256: licenseSha256,
                sizeBytes: params.licenseBuffer.byteLength,
                mimeType: 'text/plain; charset=utf-8',
                isText: true,
                updatedAt: now,
              }),
            )
            .onConflictDoUpdate({
              target: [projectFiles.projectId, projectFiles.path],
              set: asUpdate(projectFiles, {
                blobScope: 'workspace',
                sha256: licenseSha256,
                sizeBytes: params.licenseBuffer.byteLength,
                mimeType: 'text/plain; charset=utf-8',
                isText: true,
                updatedAt: now,
              }),
            });
        }

        await tx
          .insert(projectFiles)
          .values(
            asInsert(projectFiles, {
              workspaceId: params.workspaceId,
              projectId: params.targetProjectId,
              path: committedProjectPath,
              blobScope: 'workspace',
              sha256,
              sizeBytes,
              mimeType,
              isText: isTextProjectPath(committedProjectPath),
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [projectFiles.projectId, projectFiles.path],
            set: asUpdate(projectFiles, {
              blobScope: 'workspace',
              sha256,
              sizeBytes,
              mimeType,
              isText: isTextProjectPath(committedProjectPath),
              updatedAt: now,
            }),
          });

        const nextRevision = computeProjectRevision(
          nextFiles.map((file) => ({
            path: file.path,
            size: file.sizeBytes,
            hash: file.sha256,
          })),
        );

        const maxVerRow = await tx
          .select({ maxVer: sql<number>`COALESCE(MAX(${projectVersions.versionNumber}), 0)` })
          .from(projectVersions)
          .where(
            and(
              eq(projectVersions.workspaceId, params.workspaceId),
              eq(projectVersions.projectId, params.targetProjectId),
            ),
          );
        const currentVersionNumber = Number(lockedProject[0].currentVersionNumber ?? 0);
        const nextVersionNumber = Math.max(currentVersionNumber, Number(maxVerRow[0]?.maxVer ?? 0)) + 1;

        const maxSeqRow = await tx
          .select({ maxSeq: sql<number>`COALESCE(MAX(${projectHistoryEntries.seq}), 0)` })
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, params.workspaceId),
              eq(projectHistoryEntries.projectId, params.targetProjectId),
            ),
          );
        const currentHistorySeq = Number(lockedProject[0].currentHistorySeq ?? 0);
        const nextHistorySeq = Math.max(currentHistorySeq, Number(maxSeqRow[0]?.maxSeq ?? 0)) + 1;

        const parentRows =
          currentHistorySeq > 0
            ? await tx
                .select({ id: projectHistoryEntries.id })
                .from(projectHistoryEntries)
                .where(
                  and(
                    eq(projectHistoryEntries.workspaceId, params.workspaceId),
                    eq(projectHistoryEntries.projectId, params.targetProjectId),
                    eq(projectHistoryEntries.seq, currentHistorySeq),
                  ),
                )
                .limit(1)
            : [];
        const parentEntryId = parentRows[0]?.id ?? null;

        const summary = `Import asset ${params.name || path.posix.basename(committedProjectPath)}`.slice(0, 256);
        const versionRequestId = params.requestId
          ? `${params.requestId}:${params.jobId}`.slice(0, 128)
          : null;
        const projectVersionId = randomUUID();

        await tx.insert(projectVersions).values(
          asInsert(projectVersions, {
            id: projectVersionId,
            workspaceId: params.workspaceId,
            projectId: params.targetProjectId,
            versionNumber: nextVersionNumber,
            revision: nextRevision,
            source: 'agent',
            summary,
            requestId: versionRequestId,
            pinned: false,
            createdAt: now,
          }),
        );

        const snapshotValues = nextFiles.map((file) =>
          asInsert(projectVersionFiles, {
            versionId: projectVersionId,
            workspaceId: params.workspaceId,
            projectId: params.targetProjectId!,
            path: file.path,
            blobScope: file.blobScope,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            mimeType: file.mimeType,
          }),
        );
        if (snapshotValues.length > 0) {
          await tx.insert(projectVersionFiles).values(snapshotValues);
        }

        await tx
          .delete(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, params.workspaceId),
              eq(projectHistoryEntries.projectId, params.targetProjectId),
              eq(projectHistoryEntries.undone, true),
              gt(projectHistoryEntries.seq, currentHistorySeq),
            ),
          );

        await tx.insert(projectHistoryEntries).values(
          asInsert(projectHistoryEntries, {
            id: randomUUID(),
            workspaceId: params.workspaceId,
            projectId: params.targetProjectId,
            seq: nextHistorySeq,
            versionId: projectVersionId,
            parentEntryId,
            actorKind: 'agent',
            actorName: 'media-ingest',
            label: summary,
            windowId: null,
            pinned: false,
            undone: false,
            startedAt: now,
            endedAt: now,
          }),
        );

        await tx
          .update(projects)
          .set(
            asUpdate(projects, {
              revision: nextRevision,
              currentVersionId: projectVersionId,
              currentVersionNumber: nextVersionNumber,
              currentHistorySeq: nextHistorySeq,
              updatedAt: now,
            }),
          )
          .where(and(eq(projects.id, params.targetProjectId), eq(projects.workspaceId, params.workspaceId)));

        committedProjectRevision = nextRevision;
        committedProjectVersionId = projectVersionId;
        committedProjectVersionNumber = nextVersionNumber;
      } else {
        // Library asset creation or new version append (requires probed media info).
        if (!probed) {
          throw new CloudError('INVALID_ARGUMENT', 'Library assets must be image, video, or audio media', {
            status: 400,
          });
        }
        await applyDeltas(tx, params.workspaceId, normalizeBlobRefDeltas(deltas));

        let assetId = params.targetAssetId;
        if (assetId) {
          const existingAssets = await tx
            .select()
            .from(assets)
            .where(and(eq(assets.id, assetId), eq(assets.workspaceId, params.workspaceId)))
            .for('update')
            .limit(1);
          if (existingAssets.length === 0) {
            throw new CloudError('ASSET_NOT_FOUND', 'Target asset not found', { status: 404 });
          }
          if (existingAssets[0].modality !== probed.modality) {
            throw new CloudError('INVALID_ARGUMENT', 'Asset versions must have the same media modality', {
              status: 400,
            });
          }
          if (params.parentVersionId) {
            const parentMatch = await tx
              .select({ id: assetVersions.id })
              .from(assetVersions)
              .where(
                and(
                  eq(assetVersions.id, params.parentVersionId),
                  eq(assetVersions.assetId, assetId),
                  eq(assetVersions.workspaceId, params.workspaceId),
                ),
              )
              .limit(1);
            if (parentMatch.length === 0) {
              throw new CloudError('ASSET_VERSION_UNAVAILABLE', 'Parent version not found in this asset', {
                status: 404,
              });
            }
          }
        } else {
          assetId = randomUUID();
          await tx.insert(assets).values(
            asInsert(assets, {
              id: assetId,
              workspaceId: params.workspaceId,
              name: params.name,
              modality: probed.modality,
              trashed: false,
              trashedAt: null,
              createdAt: now,
              updatedAt: now,
            }),
          );
        }

        const versionId = randomUUID();
        const filename = `media.${probed.extension}`;
        await tx.insert(assetVersions).values(
          asInsert(assetVersions, {
            id: versionId,
            workspaceId: params.workspaceId,
            assetId,
            source: 'upload',
            filename,
            displayName: params.name,
            sha256,
            sizeBytes,
            mimeType: probed.mimeType,
            width: probed.width ?? null,
            height: probed.height ?? null,
            durationSec: probed.durationSec ?? null,
            references: [],
            parentVersionId: params.parentVersionId ?? null,
            jobId: params.jobId,
            requestId: params.requestId ?? null,
            requestHash,
            createdAt: now,
          }),
        );

        await tx
          .update(assets)
          .set(asUpdate(assets, { currentVersionId: versionId, updatedAt: now }))
          .where(and(eq(assets.id, assetId), eq(assets.workspaceId, params.workspaceId)));

        createdAssetId = assetId;
        createdVersionId = versionId;
      }

      const resultPayload = {
        jobId: params.jobId,
        sha256,
        sizeBytes,
        mimeType,
        modality,
        ...(createdAssetId ? { assetId: createdAssetId } : {}),
        ...(createdVersionId ? { versionId: createdVersionId } : {}),
        ...(uploadedThumbKey ? { thumbnailKey: uploadedThumbKey } : {}),
        ...(committedProjectPath ? { projectPath: committedProjectPath } : {}),
        ...(committedLicensePath ? { licenseProjectPath: committedLicensePath } : {}),
        ...(committedProjectRevision ? { projectRevision: committedProjectRevision } : {}),
        ...(committedProjectVersionId ? { projectVersionId: committedProjectVersionId } : {}),
        ...(committedProjectVersionNumber !== undefined
          ? { projectVersionNumber: committedProjectVersionNumber }
          : {}),
      };

      if (params.uploadId) {
        await tx
          .update(uploadTickets)
          .set(
            asUpdate(uploadTickets, {
              state: 'committed',
              resultPayload,
              updatedAt: now,
            }),
          )
          .where(
            and(
              eq(uploadTickets.id, params.uploadId),
              eq(uploadTickets.workspaceId, params.workspaceId),
            ),
          );
      }

      await tx
        .update(jobs)
        .set(
          asUpdate(jobs, {
            state: 'completed',
            stage: 'completed',
            progress: 100,
            resultJson: resultPayload,
            terminalAt: now,
            updatedAt: now,
          }),
        )
        .where(and(eq(jobs.id, params.jobId), eq(jobs.workspaceId, params.workspaceId)));

      return {
        assetId: createdAssetId,
        versionId: createdVersionId,
        projectPath: committedProjectPath,
        licenseProjectPath: committedLicensePath,
        projectRevision: committedProjectRevision,
        projectVersionId: committedProjectVersionId,
        projectVersionNumber: committedProjectVersionNumber,
        resultPayload,
      };
    }),
  );

  const readyEvent: JobProgressEvent = {
    jobId: params.jobId,
    workspaceId: params.workspaceId,
    projectId: params.targetProjectId ?? null,
    kind: 'media_ingest',
    state: 'completed',
    stage: 'completed',
    progress: 100,
    resultJson: committed.resultPayload,
    ts: Date.now(),
  };
  const publications: Promise<unknown>[] = [deps.eventBus.publish(jobChannel(params.jobId), readyEvent)];
  if (params.targetProjectId && committed.projectPath) {
    const changedPaths = [
      committed.projectPath,
      ...(committed.licenseProjectPath ? [committed.licenseProjectPath] : []),
    ];
    const projEvent: ProjectEvent = {
      type: 'file-change',
      workspaceId: params.workspaceId,
      projectId: params.targetProjectId,
      revision: committed.projectRevision ?? sha256,
      paths: changedPaths,
      affectsPreview: true,
      ts: Date.now(),
    };
    publications.push(deps.eventBus.publish(projectChannel(params.workspaceId, params.targetProjectId), projEvent));
    const ingestDoneEvent: ProjectEvent = {
      type: 'media-ingest-status',
      workspaceId: params.workspaceId,
      projectId: params.targetProjectId,
      ...(params.uploadId ? { ticketId: params.uploadId } : {}),
      jobId: params.jobId,
      filename: params.name,
      targetPath: committed.projectPath,
      bytes: sizeBytes,
      source: params.ingestSource ?? 'web_upload',
      state: 'completed',
      stage: 'completed',
      progress: 100,
      ts: Date.now(),
    };
    publications.push(
      deps.eventBus.publish(projectChannel(params.workspaceId, params.targetProjectId), ingestDoneEvent),
    );
  }
  await Promise.allSettled(publications);

  // Best-effort non-blocking derived media scheduling (sprite / waveform / thumbnail / preview proxy).
  // Never fail upload_commit / url_fetch if background scheduling fails.
  if (probed && deps.queues) {
    await enqueueDerivedMediaJobs(deps, {
      workspaceId: params.workspaceId,
      blobScope: 'workspace',
      sha256,
      mimeType,
      sizeBytes,
      probed,
      projectId: params.targetProjectId,
      skipThumbnail: Boolean(uploadedThumbKey),
    });
  }

  return {
    assetId: committed.assetId,
    versionId: committed.versionId,
    sha256,
    sizeBytes,
    mimeType,
    modality,
    thumbnailKey: uploadedThumbKey,
    projectPath: committed.projectPath,
    licenseProjectPath: committed.licenseProjectPath,
    projectRevision: committed.projectRevision,
    projectVersionId: committed.projectVersionId,
    projectVersionNumber: committed.projectVersionNumber,
  };
}

/** Process `upload_commit` job: stream staged upload -> hash -> SDR PNG strip -> probe -> thumb -> CAS promote -> cleanup. */
export async function handleUploadCommitJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['upload_commit'],
): Promise<Record<string, unknown>> {
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-ingest-${payload.jobId}`);
  const stagingKey = uploadStagingKey(payload.workspaceId, payload.uploadId);
  let licenseKey: string | null = null;
  let licenseFilename: string | null = null;
  const claimToken = randomUUID();

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });

    const ticketRows = await deps.db
      .select()
      .from(uploadTickets)
      .where(
        and(eq(uploadTickets.id, payload.uploadId), eq(uploadTickets.workspaceId, payload.workspaceId)),
      )
      .limit(1);

    if (ticketRows.length === 0) {
      throw new CloudError('NOT_FOUND', `Upload ticket ${payload.uploadId} not found`, { status: 404 });
    }
    const ticket = ticketRows[0];
    if (ticket.state === 'committed' && ticket.resultPayload) {
      return ticket.resultPayload;
    }

    licenseKey = ticket.licenseS3StagingKey ?? null;
    licenseFilename = ticket.licenseFilename ?? null;

    const now = new Date();
    await deps.db
      .update(uploadTickets)
      .set(asUpdate(uploadTickets, { state: 'processing', updatedAt: now }))
      .where(and(eq(uploadTickets.id, ticket.id), eq(uploadTickets.workspaceId, payload.workspaceId)));

    await deps.db
      .update(jobs)
      .set(
        asUpdate(jobs, {
          state: 'running',
          stage: 'probing',
          progress: 20,
          workerId: deps.workerId,
          claimToken,
          startedAt: now,
          updatedAt: now,
        }),
      )
      .where(and(eq(jobs.id, payload.jobId), eq(jobs.workspaceId, payload.workspaceId)));

    const stagedFilePath = path.join(workDir, 'staged.bin');
    const maxBytes = Math.min(Number(ticket.maxBytes), MAX_ASSET_BYTES);
    const streamed = await streamS3ObjectToFile(deps.storage, stagingKey, stagedFilePath, maxBytes);

    const expectedSha = payload.expectedSha256 ?? ticket.expectedSha256 ?? undefined;
    if (expectedSha && streamed.sha256 !== expectedSha) {
      throw new CloudError('INVALID_ARGUMENT', 'Uploaded object SHA-256 does not match expectedSha256', {
        status: 400,
      });
    }

    let licenseBuffer: Buffer | null = null;
    if (licenseKey) {
      assertTenantScopedKey(payload.workspaceId, licenseKey);
      licenseBuffer = await deps.storage.getObjectBuffer(licenseKey, Number(ticket.licenseMaxBytes ?? 131_072));
    }

    const ticketResultMeta = (ticket.resultPayload ?? {}) as Record<string, unknown>;
    const ingestSource: 'mcp_upload' | 'web_upload' =
      ticketResultMeta.source === 'mcp_upload' ? 'mcp_upload' : 'web_upload';
    const effectiveProjectId = payload.targetProjectId ?? ticket.targetProjectId ?? undefined;
    const effectiveTargetPath = payload.targetPath ?? ticket.targetPath ?? undefined;

    if (effectiveProjectId) {
      await deps.eventBus
        .publish(projectChannel(payload.workspaceId, effectiveProjectId), {
          type: 'media-ingest-status',
          workspaceId: payload.workspaceId,
          projectId: effectiveProjectId,
          ticketId: ticket.id,
          jobId: payload.jobId,
          filename: payload.name || ticket.filename,
          ...(effectiveTargetPath ? { targetPath: effectiveTargetPath } : {}),
          bytes: streamed.bytes,
          source: ingestSource,
          state: 'processing',
          stage: 'probing',
          progress: 45,
          ts: Date.now(),
        } satisfies ProjectEvent)
        .catch(() => {});
    }

    const promoted = await promoteFileToLibraryOrProject(deps, {
      jobId: payload.jobId,
      workspaceId: payload.workspaceId,
      filePath: stagedFilePath,
      name: payload.name,
      purpose: payload.purpose,
      targetAssetId: payload.targetAssetId ?? ticket.targetAssetId ?? undefined,
      targetProjectId: effectiveProjectId,
      targetPath: effectiveTargetPath,
      parentVersionId: payload.parentVersionId,
      requestId: payload.requestId ?? ticket.requestId ?? undefined,
      expectedModality: payload.expectedModality ?? ticket.expectedModality ?? undefined,
      uploadId: ticket.id,
      licenseBuffer,
      licenseFilename,
      sourceSha256: streamed.sha256,
      sourceStagingKey: stagingKey,
      ingestSource,
    });

    // Clean up staging object(s) after durable PG + CAS commit.
    await deps.storage.deleteObject(stagingKey).catch(() => {});
    if (licenseKey) {
      await deps.storage.deleteObject(licenseKey).catch(() => {});
    }

    return promoted;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload commit failed';
    const errorCode = isCloudError(error) ? error.code : 'UPLOAD_COMMIT_FAILED';
    const now = new Date();
    await Promise.allSettled([
      deps.db
        .update(uploadTickets)
        .set(asUpdate(uploadTickets, { state: 'failed', error: message, updatedAt: now }))
        .where(and(eq(uploadTickets.id, payload.uploadId), eq(uploadTickets.workspaceId, payload.workspaceId))),
      deps.db
        .update(jobs)
        .set(
          asUpdate(jobs, {
            state: 'failed',
            stage: 'failed',
            failureStage: 'upload_commit',
            errorCode,
            errorMessage: message,
            terminalAt: now,
            updatedAt: now,
          }),
        )
        .where(and(eq(jobs.id, payload.jobId), eq(jobs.workspaceId, payload.workspaceId))),
      deps.eventBus.publish(jobChannel(payload.jobId), {
        jobId: payload.jobId,
        workspaceId: payload.workspaceId,
        projectId: payload.targetProjectId ?? null,
        kind: 'media_ingest',
        state: 'failed',
        stage: 'failed',
        progress: 0,
        errorCode,
        errorMessage: message,
        ts: Date.now(),
      } satisfies JobProgressEvent),
      ...(payload.targetProjectId
        ? [
            deps.eventBus.publish(projectChannel(payload.workspaceId, payload.targetProjectId), {
              type: 'media-ingest-status',
              workspaceId: payload.workspaceId,
              projectId: payload.targetProjectId,
              ticketId: payload.uploadId,
              jobId: payload.jobId,
              filename: payload.name,
              ...(payload.targetPath ? { targetPath: payload.targetPath } : {}),
              source: 'web_upload',
              state: 'failed',
              stage: 'failed',
              error: message,
              ts: Date.now(),
            } satisfies ProjectEvent),
          ]
        : []),
    ]);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Process `url_fetch` job with hardened SSRF validation + DNS pinning + CAS promotion. */
export async function handleUrlFetchJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['url_fetch'],
): Promise<Record<string, unknown>> {
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-ingest-${payload.jobId}`);
  const claimToken = randomUUID();
  const fetchToFile = deps.fetchPublicUrlToFile ?? safePublicHttpsFetchToFile;

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const validatedUrl = validatePublicImportUrl(payload.url);

    const now = new Date();
    await deps.db
      .update(jobs)
      .set(
        asUpdate(jobs, {
          state: 'running',
          stage: 'downloading',
          progress: 15,
          workerId: deps.workerId,
          claimToken,
          startedAt: now,
          updatedAt: now,
        }),
      )
      .where(and(eq(jobs.id, payload.jobId), eq(jobs.workspaceId, payload.workspaceId)));

    const fetchedPath = path.join(workDir, 'fetched.bin');
    const fetched = await fetchToFile(validatedUrl, fetchedPath, {
      maxBytes: MAX_ASSET_BYTES,
      maxRedirects: DEFAULT_MAX_REDIRECTS,
      idleTimeoutMs: DEFAULT_FETCH_IDLE_TIMEOUT_MS,
      totalTimeoutMs: DEFAULT_FETCH_TOTAL_TIMEOUT_MS,
      allowDohFakeIpFallback: deps.allowDohFakeIpFallback ?? false,
      onProgress: payload.targetProjectId
        ? (downloadedBytes, totalBytes) => {
            const pct = totalBytes
              ? Math.max(10, Math.min(70, Math.round(10 + (downloadedBytes / totalBytes) * 60)))
              : 30;
            void deps.eventBus
              .publish(projectChannel(payload.workspaceId, payload.targetProjectId!), {
                type: 'media-ingest-status',
                workspaceId: payload.workspaceId,
                projectId: payload.targetProjectId!,
                jobId: payload.jobId,
                filename: payload.name,
                ...(payload.targetPath ? { targetPath: payload.targetPath } : {}),
                bytes: totalBytes ?? downloadedBytes,
                source: 'mcp_url',
                state: 'processing',
                stage: 'downloading',
                progress: pct,
                ts: Date.now(),
              } satisfies ProjectEvent)
              .catch(() => {});
          }
        : undefined,
    });

    if (payload.expectedSha256 && fetched.sha256 !== payload.expectedSha256) {
      throw new CloudError('INVALID_ARGUMENT', 'Downloaded object SHA-256 does not match expectedSha256', {
        status: 400,
      });
    }

    const isProjectAsset = Boolean(payload.targetProjectId && payload.targetPath);
    return await promoteFileToLibraryOrProject(deps, {
      jobId: payload.jobId,
      workspaceId: payload.workspaceId,
      filePath: fetchedPath,
      name: payload.name,
      purpose: isProjectAsset ? 'project_asset' : 'library_asset',
      targetAssetId: payload.targetAssetId,
      targetProjectId: payload.targetProjectId,
      targetPath: isProjectAsset ? payload.targetPath : undefined,
      parentVersionId: payload.parentVersionId,
      requestId: payload.requestId,
      expectedModality: payload.expectedModality,
      sourceSha256: fetched.sha256,
      ingestSource: 'mcp_url',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'URL import failed';
    const errorCode = isCloudError(error) ? error.code : 'URL_FETCH_FAILED';
    const now = new Date();
    await Promise.allSettled([
      deps.db
        .update(jobs)
        .set(
          asUpdate(jobs, {
            state: 'failed',
            stage: 'failed',
            failureStage: 'url_fetch',
            errorCode,
            errorMessage: message,
            terminalAt: now,
            updatedAt: now,
          }),
        )
        .where(and(eq(jobs.id, payload.jobId), eq(jobs.workspaceId, payload.workspaceId))),
      deps.eventBus.publish(jobChannel(payload.jobId), {
        jobId: payload.jobId,
        workspaceId: payload.workspaceId,
        projectId: payload.targetProjectId ?? null,
        kind: 'media_ingest',
        state: 'failed',
        stage: 'failed',
        progress: 0,
        errorCode,
        errorMessage: message,
        ts: Date.now(),
      } satisfies JobProgressEvent),
      ...(payload.targetProjectId
        ? [
            deps.eventBus.publish(projectChannel(payload.workspaceId, payload.targetProjectId), {
              type: 'media-ingest-status',
              workspaceId: payload.workspaceId,
              projectId: payload.targetProjectId,
              jobId: payload.jobId,
              filename: payload.name,
              ...(payload.targetPath ? { targetPath: payload.targetPath } : {}),
              source: 'mcp_url',
              state: 'failed',
              stage: 'failed',
              error: message,
              ts: Date.now(),
            } satisfies ProjectEvent),
          ]
        : []),
    ]);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveBlobS3Key(workspaceId: string, blobScope: 'workspace' | 'catalog', sha256: string): string {
  return blobScope === 'catalog' ? catalogBlobKey(sha256) : workspaceBlobKey(workspaceId, sha256);
}

/** Offloaded Studio job: `media_probe` — extract ffprobe metadata and update `workspace_blobs.metadata`. */
export async function handleMediaProbeJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['media_probe'],
): Promise<BlobMetadata> {
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-probe-${randomUUID()}`);
  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;
  const probe = deps.probeMedia ?? ((file: string) => probeMediaFile(file, runCmd));

  try {
    assertTenantScopedKey(payload.workspaceId, payload.s3Key, { allowCatalog: payload.blobScope === 'catalog' });
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const localFile = path.join(workDir, 'media.bin');
    await streamS3ObjectToFile(deps.storage, payload.s3Key, localFile, MAX_ASSET_BYTES);

    const probed = await probe(localFile);
    const metadata = toBlobMetadata(probed);
    if (payload.blobScope === 'workspace') {
      await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, metadata);
    }
    await enqueueDerivedMediaJobs(deps, {
      workspaceId: payload.workspaceId,
      blobScope: payload.blobScope,
      sha256: payload.sha256,
      mimeType: probed.mimeType,
      sizeBytes: probed.sizeBytes,
      probed,
      projectId: payload.projectId,
    });
    await publishMediaDerivedReady(deps, {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      kind: 'metadata',
      status: 'ready',
      projectId: payload.projectId,
    });
    return metadata;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Offloaded Studio job: `image_thumbnail` — generate thumbnail JPEG and upload to `thumbnailKey`. */
export async function handleImageThumbnailJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['image_thumbnail'],
): Promise<{ key: string; bytes: number }> {
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-imgthumb-${randomUUID()}`);
  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;
  const probe = deps.probeMedia ?? ((file: string) => probeMediaFile(file, runCmd));
  const thumbFn =
    deps.generateThumbnailBuffer ??
    ((file: string, media: ProbedMediaInfo, opts: { width: number; height?: number; timestampSec?: number }) =>
      defaultGenerateThumbnailBuffer(file, media, opts, runCmd));

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const sourceKey = resolveBlobS3Key(payload.workspaceId, payload.blobScope, payload.sha256);
    const localFile = path.join(workDir, 'source.bin');
    await streamS3ObjectToFile(deps.storage, sourceKey, localFile, MAX_ASSET_BYTES);

    const media = await probe(localFile);
    const buffer = await thumbFn(localFile, media, {
      width: payload.width,
      height: payload.height,
      timestampSec: payload.timestampSec,
    });
    if (!buffer || buffer.byteLength === 0) {
      throw new CloudError('INVALID_ARGUMENT', 'Could not generate thumbnail for this media asset', { status: 400 });
    }

    const destKey = thumbnailKey(payload.workspaceId, payload.sha256, payload.spec);
    await deps.storage.putObject(destKey, buffer, 'image/jpeg', buffer.byteLength);
    if (payload.blobScope === 'workspace' && payload.spec === 'w320') {
      await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, {
        thumbnailReady: true,
      }).catch(() => {});
    }
    await publishMediaDerivedReady(deps, {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      kind: 'thumbnail',
      status: 'ready',
      projectId: payload.projectId,
    });
    return { key: destKey, bytes: buffer.byteLength };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GenerateVideoSpriteResult {
  status: 'ready' | 'skipped';
  reason?: 'already_ready' | 'blob_deleting' | 'not_video';
  sprite?: VideoSpriteMetadata;
  manifest?: VideoSpriteManifest;
}

/**
 * Offloaded Studio job: `generate_video_sprite` — extract multi-frame WebP sprite sheets
 * (10×6 grid, max 160×90 aspect-preserving tiles, up to 120 frames / 2 sheets) using fast
 * keyframe-only FFmpeg decoding with sparse-keyframe seek fallback.
 */
export async function handleGenerateVideoSpriteJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['generate_video_sprite'],
): Promise<GenerateVideoSpriteResult> {
  const manifestKey = derivedAssetKey(payload.workspaceId, payload.sha256, 'sprite-manifest.json');

  if (payload.blobScope === 'workspace') {
    try {
      const existingRows = await deps.db
        .select({
          metadata: workspaceBlobs.metadata,
          gcState: workspaceBlobs.gcState,
        })
        .from(workspaceBlobs)
        .where(and(eq(workspaceBlobs.workspaceId, payload.workspaceId), eq(workspaceBlobs.sha256, payload.sha256)))
        .limit(1);

      const existingRow = existingRows[0];
      if (existingRow?.gcState === 'deleting') {
        return { status: 'skipped', reason: 'blob_deleting' };
      }
      const existingSprite = (existingRow?.metadata as WorkspaceBlobMetadataPatch | null)?.sprite;
      if (existingSprite?.status === 'ready' && existingSprite.manifestKey) {
        const head = await deps.storage.headObject(existingSprite.manifestKey);
        if (head) {
          return { status: 'skipped', reason: 'already_ready', sprite: existingSprite };
        }
      }
    } catch {
      // Allow lightweight mock databases to proceed directly to generation.
    }
  } else {
    const head = await deps.storage.headObject(manifestKey);
    if (head) {
      return { status: 'skipped', reason: 'already_ready' };
    }
  }

  const workDir = path.join(
    deps.tmpBaseDir ?? os.tmpdir(),
    `om-sprite-${payload.sha256.slice(0, 12)}-${randomUUID()}`,
  );
  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;
  const probe = deps.probeMedia ?? ((file: string) => probeMediaFile(file, runCmd));

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const framesDir = path.join(workDir, 'frames');
    await mkdir(framesDir, { recursive: true, mode: 0o700 });

    const sourceKey = resolveBlobS3Key(payload.workspaceId, payload.blobScope, payload.sha256);
    const localFile = path.join(workDir, 'source.bin');
    await streamS3ObjectToFile(deps.storage, sourceKey, localFile, MAX_ASSET_BYTES);

    let durationSec = payload.durationSec;
    let sourceWidth = payload.width;
    let sourceHeight = payload.height;
    let isVideo = true;

    if (!durationSec || !sourceWidth || !sourceHeight) {
      const probed = await probe(localFile);
      if (probed.modality !== 'video') {
        isVideo = false;
      } else {
        durationSec = durationSec ?? probed.durationSec;
        sourceWidth = sourceWidth ?? probed.width;
        sourceHeight = sourceHeight ?? probed.height;
      }
    }

    if (!isVideo) {
      return { status: 'skipped', reason: 'not_video' };
    }

    const safeDuration = Number.isFinite(durationSec) && (durationSec ?? 0) > 0 ? Number(durationSec) : 1;
    const { frameWidth, frameHeight } = computeSpriteTileDimensions(sourceWidth, sourceHeight);
    const { targetFrames, intervalSec } = computeSpriteSamplingPlan(safeDuration);

    const listExtractedFrames = async (): Promise<string[]> => {
      const entries = await readdir(framesDir);
      return entries
        .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
        .sort()
        .map((f) => path.join(framesDir, f));
    };

    const clearFramesDir = async () => {
      const entries = await readdir(framesDir).catch(() => []);
      await Promise.all(entries.map((entry) => rm(path.join(framesDir, entry), { force: true }).catch(() => {})));
    };

    let frameFiles: string[] = [];

    await lightFfmpegSemaphore.run(async () => {
      const scaleFilter = `scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=decrease:flags=fast_bilinear`;
      const framePattern = path.join(framesDir, 'f-%04d.jpg');

      if (safeDuration <= 12) {
        await runCmd(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-i',
            localFile,
            '-map',
            '0:V:0',
            '-vf',
            `fps=1/${intervalSec.toFixed(4)},${scaleFilter}`,
            '-frames:v',
            String(targetFrames),
            '-q:v',
            '4',
            '-y',
            framePattern,
          ],
          workDir,
          60_000,
        );
        frameFiles = await listExtractedFrames();
      } else {
        // Fast path: decode keyframes only (~10-20x faster on long / high-bitrate MP4s).
        await runCmd(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-skip_frame',
            'nokey',
            '-i',
            localFile,
            '-map',
            '0:V:0',
            '-vf',
            `fps=1/${intervalSec.toFixed(4)},${scaleFilter}`,
            '-frames:v',
            String(targetFrames),
            '-q:v',
            '4',
            '-y',
            framePattern,
          ],
          workDir,
          90_000,
        );
        frameFiles = await listExtractedFrames();

        // Fallback for sparse-keyframe videos (e.g., long GOP screen recordings): fast -ss input seeks.
        const minAcceptable = Math.max(2, Math.floor(targetFrames * 0.4));
        if (frameFiles.length < minAcceptable) {
          await clearFramesDir();
          const seekCount = Math.min(targetFrames, 40);
          for (let i = 0; i < seekCount; i += 1) {
            const t = seekCount <= 1 ? 0 : Math.min(safeDuration - 0.05, (i / seekCount) * safeDuration);
            const outPath = path.join(framesDir, `f-${String(i + 1).padStart(4, '0')}.jpg`);
            await runCmd(
              'ffmpeg',
              [
                '-v',
                'error',
                '-nostdin',
                '-ss',
                Math.max(0, t).toFixed(3),
                '-i',
                localFile,
                '-map',
                '0:V:0',
                '-vf',
                scaleFilter,
                '-frames:v',
                '1',
                '-q:v',
                '4',
                '-y',
                outPath,
              ],
              workDir,
              15_000,
            ).catch(() => null);
          }
          frameFiles = await listExtractedFrames();
        }
      }

      // Final 1-frame fallback if video is extremely short or has irregular timestamps.
      if (frameFiles.length === 0) {
        const outPath = path.join(framesDir, 'f-0001.jpg');
        await runCmd(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-i',
            localFile,
            '-map',
            '0:V:0',
            '-vf',
            scaleFilter,
            '-frames:v',
            '1',
            '-q:v',
            '4',
            '-y',
            outPath,
          ],
          workDir,
          30_000,
        );
        frameFiles = await listExtractedFrames();
      }
    });

    if (frameFiles.length === 0) {
      throw new CloudError('INVALID_ARGUMENT', 'Failed to extract any frames for video sprite sheet', { status: 400 });
    }

    const cappedFrames = frameFiles.slice(0, SPRITE_MAX_FRAMES);
    const sheets: VideoSpriteSheetEntry[] = [];
    const totalSheets = Math.ceil(cappedFrames.length / SPRITE_FRAMES_PER_SHEET);

    for (let sheetIndex = 0; sheetIndex < totalSheets; sheetIndex += 1) {
      const startFrame = sheetIndex * SPRITE_FRAMES_PER_SHEET;
      const chunk = cappedFrames.slice(startFrame, startFrame + SPRITE_FRAMES_PER_SHEET);
      const sheetColumns = Math.min(SPRITE_COLUMNS, chunk.length);
      const sheetRows = Math.ceil(chunk.length / sheetColumns);
      const sheetWidth = sheetColumns * frameWidth;
      const sheetHeight = sheetRows * frameHeight;

      const composites: OverlayOptions[] = [];
      for (let i = 0; i < chunk.length; i += 1) {
        const tileBuf = await sharp(chunk[i])
          .resize(frameWidth, frameHeight, {
            fit: 'contain',
            background: { r: 16, g: 16, b: 18, alpha: 1 },
          })
          .toBuffer();
        const col = i % sheetColumns;
        const row = Math.floor(i / sheetColumns);
        composites.push({
          input: tileBuf,
          left: col * frameWidth,
          top: row * frameHeight,
        });
      }

      const webpBuffer = await sharp({
        create: {
          width: sheetWidth,
          height: sheetHeight,
          channels: 3,
          background: { r: 16, g: 16, b: 18 },
        },
      })
        .composite(composites)
        .webp({ quality: 72 })
        .toBuffer();

      const sheetS3Key = derivedAssetKey(payload.workspaceId, payload.sha256, `sprite-${sheetIndex}.webp`);
      await deps.storage.putObject(sheetS3Key, webpBuffer, 'image/webp', webpBuffer.byteLength);

      sheets.push({
        index: sheetIndex,
        s3Key: sheetS3Key,
        startFrame,
        frameCount: chunk.length,
        columns: sheetColumns,
        rows: sheetRows,
        width: sheetWidth,
        height: sheetHeight,
      });
    }

    const actualIntervalSec = Math.round((safeDuration / cappedFrames.length) * 1000) / 1000;
    const generatedAt = new Date().toISOString();
    const manifest: VideoSpriteManifest = {
      version: 1,
      sha256: payload.sha256,
      durationSec: safeDuration,
      intervalSec: actualIntervalSec,
      frameCount: cappedFrames.length,
      frameWidth,
      frameHeight,
      columns: SPRITE_COLUMNS,
      rows: SPRITE_ROWS,
      sheets,
    };

    const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
    await deps.storage.putObject(manifestKey, manifestBuf, 'application/json', manifestBuf.byteLength);

    const spriteMeta: VideoSpriteMetadata = {
      status: 'ready',
      manifestKey,
      sheetCount: sheets.length,
      frameCount: cappedFrames.length,
      frameWidth,
      frameHeight,
      intervalSec: actualIntervalSec,
      durationSec: safeDuration,
      generatedAt,
    };

    if (payload.blobScope === 'workspace') {
      await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, {
        sprite: spriteMeta,
      });
    }

    await publishMediaDerivedReady(deps, {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      kind: 'sprite',
      status: 'ready',
      projectId: payload.projectId,
    });

    return { status: 'ready', sprite: spriteMeta, manifest };
  } catch (error) {
    const failedSprite: VideoSpriteMetadata = {
      status: 'failed',
      manifestKey: '',
      frameCount: 0,
      frameWidth: 0,
      frameHeight: 0,
      durationSec: 0,
      intervalSec: 0,
      sheetCount: 0,
      generatedAt: new Date().toISOString(),
    };
    if (payload.blobScope === 'workspace') {
      await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, {
        sprite: failedSprite,
      }).catch(() => {});
    }
    await publishMediaDerivedReady(deps, {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      kind: 'sprite',
      status: 'failed',
      projectId: payload.projectId,
    }).catch(() => {});
    deps.logger.warn('Video sprite generation failed', {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      error,
    });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Offloaded Studio job: `extract_waveform_peaks` — compute normalized waveform peaks JSON -> S3 derived key + blob metadata. */
export async function handleExtractWaveformPeaksJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['extract_waveform_peaks'],
): Promise<{ key: string; samples: number; peaks: number[]; durationSec: number }> {
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-peaks-${randomUUID()}`);
  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;
  const probe = deps.probeMedia ?? ((file: string) => probeMediaFile(file, runCmd));

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const sourceKey = resolveBlobS3Key(payload.workspaceId, payload.blobScope, payload.sha256);
    const localFile = path.join(workDir, 'audio.bin');
    const pcmFile = path.join(workDir, 'mono.pcm');
    await streamS3ObjectToFile(deps.storage, sourceKey, localFile, MAX_ASSET_BYTES);

    const probed = await probe(localFile);
    const sampleRate = 8000;
    const derivedKey = derivedAssetKey(payload.workspaceId, payload.sha256, 'waveform-peaks.json');

    // Silent videos (no audio stream) persist an explicit empty waveform instead of failing FFmpeg.
    if (probed.hasAudio === false) {
      const durationSec = probed.durationSec ?? 0;
      const silentJson = Buffer.from(
        JSON.stringify({
          peaks: [],
          bins: [],
          binSeconds: 0,
          samples: 0,
          sampleRate,
          duration: durationSec,
          hasAudio: false,
        }),
        'utf8',
      );
      await deps.storage.putObject(derivedKey, silentJson, 'application/json', silentJson.byteLength);
      if (payload.blobScope === 'workspace') {
        await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, {
          waveformPeaksKey: derivedKey,
          durationSec,
          hasAudio: false,
        });
      }
      await publishMediaDerivedReady(deps, {
        workspaceId: payload.workspaceId,
        sha256: payload.sha256,
        kind: 'waveform',
        status: 'ready',
        projectId: payload.projectId,
      });
      return { key: derivedKey, samples: 0, peaks: [], durationSec };
    }

    const decode = await lightFfmpegSemaphore.run(() =>
      runCmd(
        'ffmpeg',
        ['-v', 'error', '-nostdin', '-i', localFile, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-y', pcmFile],
        workDir,
        60_000,
      ),
    );
    if (decode.code !== 0) {
      throw new CloudError('INVALID_ARGUMENT', 'Failed to extract audio PCM for waveform peaks', { status: 400 });
    }

    const pcm = await readFile(pcmFile);
    const totalFrames = Math.floor(pcm.byteLength / 2);
    const bucketCount = Math.max(16, Math.min(16_384, payload.samples));
    const peaks: number[] = [];

    if (totalFrames === 0) {
      for (let i = 0; i < bucketCount; i += 1) peaks.push(0);
    } else {
      const framesPerBucket = totalFrames / bucketCount;
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const start = Math.floor(bucket * framesPerBucket);
        const end = Math.min(totalFrames, Math.max(start + 1, Math.floor((bucket + 1) * framesPerBucket)));
        let peak = 0;
        for (let idx = start; idx < end; idx += 1) {
          const sample = Math.abs(pcm.readInt16LE(idx * 2)) / 32768;
          if (sample > peak) peak = sample;
        }
        peaks.push(Math.round(peak * 10_000) / 10_000);
      }
    }

    const durationSec = probed.durationSec ?? (totalFrames > 0 ? totalFrames / sampleRate : 0);
    const binSeconds = durationSec > 0 && bucketCount > 0 ? Math.round((durationSec / bucketCount) * 1_000_000) / 1_000_000 : 0;
    const jsonBuf = Buffer.from(
      JSON.stringify({
        peaks,
        bins: peaks,
        binSeconds,
        samples: bucketCount,
        sampleRate,
        duration: durationSec,
        hasAudio: true,
      }),
      'utf8',
    );
    await deps.storage.putObject(derivedKey, jsonBuf, 'application/json', jsonBuf.byteLength);

    if (payload.blobScope === 'workspace') {
      await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, {
        waveformPeaksKey: derivedKey,
        durationSec,
      });
    }

    await publishMediaDerivedReady(deps, {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      kind: 'waveform',
      status: 'ready',
      projectId: payload.projectId,
    });

    return { key: derivedKey, samples: bucketCount, peaks, durationSec };
  } catch (error) {
    if (payload.blobScope === 'workspace') {
      await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, {
        waveformFailed: true,
      }).catch(() => {});
    }
    await publishMediaDerivedReady(deps, {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      kind: 'waveform',
      status: 'failed',
      projectId: payload.projectId,
    }).catch(() => {});
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Offloaded Studio job: `loudness_normalize` — measure EBU R128 loudness and compute target gain plan. */
export async function handleLoudnessNormalizeJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['loudness_normalize'],
): Promise<Record<string, unknown>> {
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-loudness-${payload.jobId}`);
  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const sourceKey = resolveBlobS3Key(payload.workspaceId, payload.blobScope, payload.sha256);
    const localFile = path.join(workDir, 'audio.bin');
    await streamS3ObjectToFile(deps.storage, sourceKey, localFile, MAX_ASSET_BYTES);

    const args = loudnessMeasureArgs(localFile, { mediaStart: 0, duration: null }, 0);
    const result = await runCmd('ffmpeg', args, workDir, 60_000);
    if (result.code !== 0) {
      throw new CloudError('INVALID_ARGUMENT', `FFmpeg loudness measurement failed: ${result.stderr.slice(-500)}`, {
        status: 400,
      });
    }

    const measured = parseEbur128Summary(result.stderr);
    const targetLufs = payload.targetLufs ?? DEFAULT_TARGET_LUFS;
    const plan = absoluteLoudnessPlan(
      {
        id: payload.targetPath,
        volume: 1,
        integratedLufs: measured.integratedLufs,
        truePeakDbfs: measured.truePeakDbfs,
      },
      targetLufs,
    );

    const derivedKey = derivedAssetKey(payload.workspaceId, payload.sha256, 'loudness.json');
    const summaryPayload = {
      derivedKey,
      targetPath: payload.targetPath,
      measuredLufs: measured.integratedLufs,
      truePeakDbfs: measured.truePeakDbfs,
      targetLufs: plan.targetLufs,
      gainDb: plan.gainDb,
      changeDb: plan.changeDb,
      projectedLufs: plan.projectedLufs,
      projectedTruePeakDbfs: plan.projectedTruePeakDbfs,
      volume: plan.volume,
      limitedBy: plan.limitedBy,
    };
    const jsonBuf = Buffer.from(JSON.stringify(summaryPayload), 'utf8');
    await deps.storage.putObject(derivedKey, jsonBuf, 'application/json', jsonBuf.byteLength);

    if (payload.blobScope === 'workspace') {
      await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, {
        loudnessLufs: measured.integratedLufs,
      });
    }

    const now = new Date();
    await deps.db
      .update(jobs)
      .set(
        asUpdate(jobs, {
          state: 'completed',
          stage: 'completed',
          progress: 100,
          resultJson: summaryPayload,
          terminalAt: now,
          updatedAt: now,
        }),
      )
      .where(and(eq(jobs.id, payload.jobId), eq(jobs.workspaceId, payload.workspaceId)));

    await deps.eventBus
      .publish(jobChannel(payload.jobId), {
        jobId: payload.jobId,
        workspaceId: payload.workspaceId,
        projectId: payload.projectId,
        kind: 'media_ingest',
        state: 'completed',
        stage: 'completed',
        progress: 100,
        resultJson: summaryPayload,
        ts: Date.now(),
      } satisfies JobProgressEvent)
      .catch(() => {});

    return summaryPayload;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Offloaded Studio job: `freeze_frame` — extract PNG frame from video, promote to CAS & project_files. */
export async function handleFreezeFrameJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['freeze_frame'],
): Promise<Record<string, unknown>> {
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-freeze-${payload.jobId}`);
  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;
  const probe = deps.probeMedia ?? ((file: string) => probeMediaFile(file, runCmd));
  const applyDeltas = deps.applyBlobDeltas ?? applyWorkspaceBlobRefDeltas;

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const safeTargetPath = projectPath(payload.targetPath);
    const sourceKey = resolveBlobS3Key(payload.workspaceId, payload.blobScope, payload.sha256);
    const videoFile = path.join(workDir, 'video.bin');
    const pngFile = path.join(workDir, 'freeze.png');
    await streamS3ObjectToFile(deps.storage, sourceKey, videoFile, MAX_ASSET_BYTES);

    const extract = await runCmd(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-ss',
        String(payload.timestampSec),
        '-i',
        videoFile,
        '-map',
        '0:V:0',
        '-frames:v',
        '1',
        '-y',
        pngFile,
      ],
      workDir,
      30_000,
    );
    if (extract.code !== 0) {
      throw new CloudError('INVALID_ARGUMENT', `Freeze frame extraction failed: ${extract.stderr.slice(-500)}`, {
        status: 400,
      });
    }

    const probed = await probe(pngFile);
    const normalized = await normalizeSdrPngFileIfApplicable(pngFile, 'image/png');
    const pngBytes = await readFile(pngFile);
    const pngSha = normalized.sha256;
    const blobKey = workspaceBlobKey(payload.workspaceId, pngSha);
    const derivedName = `freeze-${Math.round(payload.timestampSec * 1000)}ms.png`;
    const derivedKey = derivedAssetKey(payload.workspaceId, payload.sha256, derivedName);
    const metadata = toBlobMetadata(probed, normalized.normalized ? { sdrNormalized: true } : {});

    // Upload bytes to S3 BEFORE opening PG transaction.
    const uploadBlobs = async () => {
      await Promise.all([
        deps.storage.putBlobIfAbsent(blobKey, pngBytes, 'image/png'),
        deps.storage.putObject(derivedKey, pngBytes, 'image/png', pngBytes.byteLength),
      ]);
    };
    await uploadBlobs();

    const resultPayload = {
      path: safeTargetPath,
      sha256: pngSha,
      sizeBytes: pngBytes.byteLength,
      width: probed.width ?? null,
      height: probed.height ?? null,
      derivedKey,
    };

    await retryOnBlobGcConflict(uploadBlobs, () =>
      deps.db.transaction(async (tx) => {
        // Lock parent project row FOR UPDATE before reading existing project_files to prevent
        // concurrent overwrite refcount double-decrements.
        const lockedProject = await tx
          .select({ id: projects.id, trashed: projects.trashed })
          .from(projects)
          .where(and(eq(projects.id, payload.projectId), eq(projects.workspaceId, payload.workspaceId)))
          .for('update')
          .limit(1);
        if (lockedProject.length === 0) {
          throw new CloudError('PROJECT_NOT_FOUND', 'Target project not found', { status: 404 });
        }
        if (lockedProject[0].trashed) {
          throw new CloudError('PROJECT_TRASHED', 'Target project is in trash', { status: 400 });
        }

        const deltas: BlobRefDelta[] = [
          {
            sha256: pngSha,
            delta: 1,
            sizeBytes: pngBytes.byteLength,
            mimeType: 'image/png',
            s3Key: blobKey,
            metadata,
          },
        ];
        const existing = await tx
          .select()
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.workspaceId, payload.workspaceId),
              eq(projectFiles.projectId, payload.projectId),
              eq(projectFiles.path, safeTargetPath),
            ),
          )
          .limit(1);
        if (existing.length > 0 && existing[0].blobScope === 'workspace') {
          deltas.push({ sha256: existing[0].sha256, delta: -1 });
        }

        await applyDeltas(tx, payload.workspaceId, deltas);

        const now = new Date();
        await tx
          .insert(projectFiles)
          .values(
            asInsert(projectFiles, {
              workspaceId: payload.workspaceId,
              projectId: payload.projectId,
              path: safeTargetPath,
              blobScope: 'workspace',
              sha256: pngSha,
              sizeBytes: pngBytes.byteLength,
              mimeType: 'image/png',
              isText: false,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [projectFiles.projectId, projectFiles.path],
            set: asUpdate(projectFiles, {
              blobScope: 'workspace',
              sha256: pngSha,
              sizeBytes: pngBytes.byteLength,
              mimeType: 'image/png',
              isText: false,
              updatedAt: now,
            }),
          });

        await tx
          .update(jobs)
          .set(
            asUpdate(jobs, {
              state: 'completed',
              stage: 'completed',
              progress: 100,
              resultJson: resultPayload,
              terminalAt: now,
              updatedAt: now,
            }),
          )
          .where(and(eq(jobs.id, payload.jobId), eq(jobs.workspaceId, payload.workspaceId)));
      }),
    );

    await Promise.allSettled([
      deps.eventBus.publish(jobChannel(payload.jobId), {
        jobId: payload.jobId,
        workspaceId: payload.workspaceId,
        projectId: payload.projectId,
        kind: 'media_ingest',
        state: 'completed',
        stage: 'completed',
        progress: 100,
        resultJson: resultPayload,
        ts: Date.now(),
      } satisfies JobProgressEvent),
      deps.eventBus.publish(projectChannel(payload.workspaceId, payload.projectId), {
        type: 'file-change',
        workspaceId: payload.workspaceId,
        projectId: payload.projectId,
        revision: pngSha,
        paths: [safeTargetPath],
        affectsPreview: true,
        ts: Date.now(),
      } satisfies ProjectEvent),
    ]);

    return resultPayload;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Offloaded MCP job: `extract_asset_read` — bounded PNG/WAV previews matching `gateway/asset-read.ts`. */
export async function handleExtractAssetReadJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['extract_asset_read'],
): Promise<AssetReadResult> {
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-read-${payload.jobId}`);
  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;
  const probe = deps.probeMedia ?? ((file: string) => probeMediaFile(file, runCmd));

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const rows = await deps.db
      .select({
        assetId: assets.id,
        modality: assets.modality,
        version: assetVersions,
      })
      .from(assetVersions)
      .innerJoin(
        assets,
        and(eq(assets.id, assetVersions.assetId), eq(assets.workspaceId, assetVersions.workspaceId)),
      )
      .where(
        and(
          eq(assetVersions.workspaceId, payload.workspaceId),
          eq(assetVersions.assetId, payload.assetId),
          eq(assetVersions.id, payload.versionId),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      throw new CloudError('ASSET_VERSION_UNAVAILABLE', 'Asset version not found', { status: 404 });
    }
    const { modality, version } = rows[0];
    const sourceKey = workspaceBlobKey(payload.workspaceId, version.sha256);
    const localSource = path.join(workDir, 'source.bin');
    const downloaded = await streamS3ObjectToFile(deps.storage, sourceKey, localSource, MAX_ASSET_BYTES);
    if (downloaded.sha256 !== version.sha256) {
      throw new CloudError('STORAGE_ERROR', 'Pinned asset blob digest mismatch', { status: 500 });
    }

    const times = modality === 'video' ? payload.timestamps ?? [0] : [0];
    const audioStart = payload.start ?? 0;
    const audioDuration = payload.duration ?? 10;
    const result: AssetReadResult = {
      assetId: payload.assetId,
      versionId: payload.versionId,
      modality,
      version: {
        id: version.id,
        createdAt: version.createdAt.getTime(),
        source: version.source,
        filename: version.filename,
        mimeType: version.mimeType,
        bytes: Number(version.sizeBytes),
        sha256: version.sha256,
        references: Array.isArray(version.references) ? version.references : [],
        ...(version.width ? { width: version.width } : {}),
        ...(version.height ? { height: version.height } : {}),
        ...(version.durationSec ? { duration: version.durationSec } : {}),
      },
      previews: [],
      content: [],
    };

    let totalBytes = 0;
    for (const [index, timestamp] of times.entries()) {
      const isAudio = modality === 'audio';
      const outPath = path.join(workDir, `${index}.${isAudio ? 'wav' : 'png'}`);
      const args = [
        '-v',
        'error',
        '-nostdin',
        '-ss',
        String(isAudio ? audioStart : timestamp),
        '-i',
        localSource,
        ...(isAudio
          ? ['-map', '0:a:0', '-t', String(audioDuration), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']
          : [
              '-map',
              '0:V:0',
              '-frames:v',
              '1',
              '-vf',
              "scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease",
            ]),
        '-fs',
        String(ASSET_READ_MAX_PREVIEW_BYTES),
        '-y',
        outPath,
      ];
      const cmd = await runCmd('ffmpeg', args, workDir, 30_000);
      if (cmd.code !== 0) {
        throw new CloudError('INVALID_ARGUMENT', 'Asset preview could not be decoded', { status: 400 });
      }
      const outStat = await stat(outPath);
      totalBytes += outStat.size;
      if (outStat.size <= 0 || outStat.size > ASSET_READ_MAX_PREVIEW_BYTES || totalBytes > ASSET_READ_MAX_TOTAL_BYTES) {
        throw new CloudError('INVALID_ARGUMENT', 'Asset read preview exceeds byte cap', { status: 413 });
      }
      const previewMedia = await probe(outPath);
      const data = (await readFile(outPath)).toString('base64');
      result.previews.push({
        mimeType: previewMedia.mimeType,
        bytes: outStat.size,
        ...(isAudio
          ? { start: audioStart, duration: previewMedia.durationSec }
          : { width: previewMedia.width, height: previewMedia.height }),
        ...(modality === 'video' ? { timestamp } : {}),
      });
      result.content.push(
        {
          type: 'text',
          text: `${payload.assetId}/${payload.versionId}: ${isAudio ? `audio from ${audioStart}s` : modality === 'video' ? `video frame at ${timestamp}s` : 'image preview'}`,
        },
        {
          type: isAudio ? 'audio' : 'image',
          mimeType: previewMedia.mimeType,
          data,
        },
      );
    }

    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Offloaded job: `inline_video_preview` — extract poster JPEG for a completed export MP4. */
export async function handleInlineVideoPreviewJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['inline_video_preview'],
): Promise<{ posterKey: string; bytes: number }> {
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-inline-preview-${payload.jobId}`);
  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;
  const thumbFn =
    deps.generateThumbnailBuffer ??
    ((file: string, media: ProbedMediaInfo, opts: { width: number; height?: number; timestampSec?: number }) =>
      defaultGenerateThumbnailBuffer(file, media, opts, runCmd));

  try {
    assertTenantScopedKey(payload.workspaceId, payload.sourceS3Key);
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const mp4Path = path.join(workDir, 'export.mp4');
    await streamS3ObjectToFile(deps.storage, payload.sourceS3Key, mp4Path, MAX_ASSET_BYTES);

    const posterBuf = await thumbFn(
      mp4Path,
      { modality: 'video', mimeType: 'video/mp4', extension: 'mp4', sizeBytes: 1 },
      { width: 640, timestampSec: 0 },
    );
    if (!posterBuf || posterBuf.byteLength === 0) {
      throw new CloudError('INVALID_ARGUMENT', 'Failed to generate inline video poster', { status: 400 });
    }
    const posterKey = derivedAssetKey(payload.workspaceId, payload.sourceSha256, 'inline-poster.jpg');
    await deps.storage.putObject(posterKey, posterBuf, 'image/jpeg', posterBuf.byteLength);
    return { posterKey, bytes: posterBuf.byteLength };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GeneratePreviewProxyResult {
  status: 'ready' | 'skipped';
  reason?: 'ineligible' | 'already_ready' | 'blob_deleting';
  previewProxy?: PreviewProxyMetadata;
}

/**
 * Dual-track preview proxy generator (`generate_preview_proxy`):
 * - Video (`video/*`): 720p H.264 + short GOP (1s) + faststart -> `derived/{sha256}/proxy.mp4`
 * - Large/high-res raster image (`png`/`jpeg`/`tiff`/`bmp`/`avif`): <=1920px WebP -> `derived/{sha256}/proxy.webp`
 * - Uncompressed audio (`wav`/`flac`): AAC M4A + faststart -> `derived/{sha256}/proxy.m4a`
 *
 * Persists frozen `workspace_blobs.metadata.previewProxy` contract and is idempotent when
 * `previewProxy.status === 'ready'` already exists for `(workspaceId, sha256)`.
 */
export async function handleGeneratePreviewProxyJob(
  deps: MediaIngestDeps,
  payload: MediaIngestPayloadMap['generate_preview_proxy'],
): Promise<GeneratePreviewProxyResult> {
  const target = classifyPreviewProxyTarget({
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    width: payload.width,
    height: payload.height,
  });
  if (!target) {
    return { status: 'skipped', reason: 'ineligible' };
  }

  const existingRows = await deps.db
    .select({
      metadata: workspaceBlobs.metadata,
      gcState: workspaceBlobs.gcState,
    })
    .from(workspaceBlobs)
    .where(and(eq(workspaceBlobs.workspaceId, payload.workspaceId), eq(workspaceBlobs.sha256, payload.sha256)))
    .limit(1);

  const existingRow = existingRows[0];
  if (existingRow?.gcState === 'deleting') {
    return { status: 'skipped', reason: 'blob_deleting' };
  }
  const existingProxy = (existingRow?.metadata as WorkspaceBlobMetadataPatch | null)?.previewProxy;
  if (
    existingProxy?.status === 'ready' &&
    typeof existingProxy.s3Key === 'string' &&
    existingProxy.s3Key.length > 0
  ) {
    return { status: 'skipped', reason: 'already_ready', previewProxy: existingProxy };
  }

  const workDir = path.join(
    deps.tmpBaseDir ?? os.tmpdir(),
    `om-proxy-${payload.sha256.slice(0, 12)}-${randomUUID()}`,
  );
  const runCmd = deps.runFfmpegCommand ?? defaultRunFfmpegCommand;
  const sourceKey = workspaceBlobKey(payload.workspaceId, payload.sha256);
  const destKey = derivedAssetKey(payload.workspaceId, payload.sha256, target.derivedName);

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const sourcePath = path.join(workDir, 'source.bin');
    await streamS3ObjectToFile(deps.storage, sourceKey, sourcePath, MAX_ASSET_BYTES);

    let proxySizeBytes = 0;
    let proxyWidth: number | undefined;
    let proxyHeight: number | undefined;
    let proxyCodec: string = target.codec;

    if (target.track === 'video') {
      const outPath = path.join(workDir, 'proxy.mp4');
      const transcode = await proxyFfmpegSemaphore.run(() =>
        runCmd(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-i',
            sourcePath,
            '-vf',
            "scale='min(1280,iw)':-2",
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-threads',
            '2',
            '-crf',
            '24',
            '-pix_fmt',
            'yuv420p',
            '-g',
            '30',
            '-keyint_min',
            '30',
            '-movflags',
            '+faststart',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-y',
            outPath,
          ],
          workDir,
          300_000,
        ),
      );
      if (transcode.code !== 0) {
        throw new CloudError(
          'INVALID_ARGUMENT',
          `Video preview proxy transcode failed: ${transcode.stderr.slice(-500)}`,
          { status: 500 },
        );
      }

      const outStat = await stat(outPath);
      if (outStat.size === 0) {
        throw new CloudError('STORAGE_ERROR', 'Video preview proxy transcode produced empty output', {
          status: 500,
        });
      }
      proxySizeBytes = outStat.size;

      const probedOut = await runCmd(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height,codec_name',
          '-of',
          'json',
          outPath,
        ],
        workDir,
        15_000,
      ).catch(() => null);
      if (probedOut && probedOut.code === 0 && probedOut.stdout.trim()) {
        try {
          const parsed = JSON.parse(probedOut.stdout) as {
            streams?: Array<{ width?: unknown; height?: unknown; codec_name?: unknown }>;
          };
          const stream = parsed.streams?.[0];
          const w = Number(stream?.width ?? 0);
          const h = Number(stream?.height ?? 0);
          if (Number.isFinite(w) && w > 0) proxyWidth = w;
          if (Number.isFinite(h) && h > 0) proxyHeight = h;
          if (typeof stream?.codec_name === 'string' && stream.codec_name.trim()) {
            proxyCodec = stream.codec_name.trim();
          }
        } catch {
          // Ignore probe parse failure and fall back to computed dimensions below.
        }
      }
      if (proxyWidth === undefined && payload.width !== undefined && payload.height !== undefined) {
        proxyWidth = Math.min(1280, payload.width);
        proxyHeight = Math.max(2, Math.round((payload.height * proxyWidth) / payload.width / 2) * 2);
      }

      await deps.storage.putObject(destKey, createReadStream(outPath), target.mimeType, proxySizeBytes);
    } else if (target.track === 'image') {
      const rendered = await sharp(sourcePath)
        .rotate()
        .resize({
          width: PREVIEW_PROXY_IMAGE_MAX_WIDTH,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });

      if (rendered.data.byteLength === 0) {
        throw new CloudError('STORAGE_ERROR', 'Image preview proxy encode produced empty output', {
          status: 500,
        });
      }
      proxySizeBytes = rendered.data.byteLength;
      proxyWidth = rendered.info.width;
      proxyHeight = rendered.info.height;
      proxyCodec = 'webp';
      await deps.storage.putObject(destKey, rendered.data, target.mimeType, proxySizeBytes);
    } else {
      const outPath = path.join(workDir, 'proxy.m4a');
      const transcode = await proxyFfmpegSemaphore.run(() =>
        runCmd(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-i',
            sourcePath,
            '-vn',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            '-y',
            outPath,
          ],
          workDir,
          120_000,
        ),
      );
      if (transcode.code !== 0) {
        throw new CloudError(
          'INVALID_ARGUMENT',
          `Audio preview proxy transcode failed: ${transcode.stderr.slice(-500)}`,
          { status: 500 },
        );
      }
      const outStat = await stat(outPath);
      if (outStat.size === 0) {
        throw new CloudError('STORAGE_ERROR', 'Audio preview proxy transcode produced empty output', {
          status: 500,
        });
      }
      proxySizeBytes = outStat.size;
      proxyCodec = 'aac';
      await deps.storage.putObject(destKey, createReadStream(outPath), target.mimeType, proxySizeBytes);
    }

    const previewProxy: PreviewProxyMetadata = {
      status: 'ready',
      s3Key: destKey,
      mimeType: target.mimeType,
      sizeBytes: proxySizeBytes,
      ...(proxyWidth !== undefined ? { width: proxyWidth } : {}),
      ...(proxyHeight !== undefined ? { height: proxyHeight } : {}),
      codec: proxyCodec,
      generatedAt: new Date().toISOString(),
    };
    await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, {
      previewProxy,
    });
    await publishMediaDerivedReady(deps, {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      kind: 'proxy',
      status: 'ready',
      projectId: payload.projectId,
    });

    return { status: 'ready', previewProxy };
  } catch (error) {
    const failedProxy: PreviewProxyMetadata = {
      status: 'failed',
      s3Key: '',
      mimeType: target.mimeType,
      sizeBytes: 0,
      codec: target.codec,
      generatedAt: new Date().toISOString(),
    };
    await updateWorkspaceBlobMetadata(deps.db, payload.workspaceId, payload.sha256, {
      previewProxy: failedProxy,
    }).catch(() => {});
    await publishMediaDerivedReady(deps, {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      kind: 'proxy',
      status: 'failed',
      projectId: payload.projectId,
    }).catch(() => {});
    deps.logger.warn('Preview proxy generation failed', {
      workspaceId: payload.workspaceId,
      sha256: payload.sha256,
      mimeType: payload.mimeType,
      error,
    });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function processMediaIngestJob<K extends MediaIngestJobName>(
  deps: MediaIngestDeps,
  name: K,
  payload: MediaIngestPayloadMap[K],
): Promise<unknown> {
  switch (name) {
    case 'upload_commit':
      return handleUploadCommitJob(deps, payload as MediaIngestPayloadMap['upload_commit']);
    case 'url_fetch':
      return handleUrlFetchJob(deps, payload as MediaIngestPayloadMap['url_fetch']);
    case 'media_probe':
      return handleMediaProbeJob(deps, payload as MediaIngestPayloadMap['media_probe']);
    case 'image_thumbnail':
      return handleImageThumbnailJob(deps, payload as MediaIngestPayloadMap['image_thumbnail']);
    case 'generate_video_sprite':
      return handleGenerateVideoSpriteJob(deps, payload as MediaIngestPayloadMap['generate_video_sprite']);
    case 'extract_waveform_peaks':
      return handleExtractWaveformPeaksJob(deps, payload as MediaIngestPayloadMap['extract_waveform_peaks']);
    case 'loudness_normalize':
      return handleLoudnessNormalizeJob(deps, payload as MediaIngestPayloadMap['loudness_normalize']);
    case 'freeze_frame':
      return handleFreezeFrameJob(deps, payload as MediaIngestPayloadMap['freeze_frame']);
    case 'extract_asset_read':
      return handleExtractAssetReadJob(deps, payload as MediaIngestPayloadMap['extract_asset_read']);
    case 'inline_video_preview':
      return handleInlineVideoPreviewJob(deps, payload as MediaIngestPayloadMap['inline_video_preview']);
    case 'generate_preview_proxy':
      return handleGeneratePreviewProxyJob(deps, payload as MediaIngestPayloadMap['generate_preview_proxy']);
  }
}

export function mediaWorkerPluginRoot(): string {
  return pluginRoot;
}
