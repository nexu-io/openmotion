import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  DEFAULT_BLOB_GC_GRACE_SECONDS,
  QUEUE_NAMES,
  blobGcJobSchemas,
  mediaGenerateJobSchemas,
  mediaIngestJobSchemas,
  renderExportJobSchemas,
  type BlobGcJobName,
  type BlobGcPayloadMap,
  type MediaGenerateJobName,
  type MediaGeneratePayloadMap,
  type MediaIngestJobName,
  type MediaIngestPayloadMap,
  type QueueName,
  type RenderExportJobName,
  type RenderExportPayloadMap,
} from '../contracts/jobs.ts';
import { createRedisClient } from './redis.ts';

export const QUEUE_DEFAULT_JOB_OPTIONS: Readonly<Record<QueueName, JobsOptions>> = {
  [QUEUE_NAMES.mediaIngest]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 2_000 },
  },
  // Paid upstream model generations MUST NEVER auto-retry silently.
  [QUEUE_NAMES.mediaGenerate]: {
    attempts: 1,
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 2_000 },
  },
  // Export renders MUST NEVER auto-replay silently after worker failure.
  [QUEUE_NAMES.renderExport]: {
    attempts: 1,
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 2_000 },
  },
  [QUEUE_NAMES.blobGc]: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 200 },
    removeOnFail: { age: 86_400 * 7, count: 500 },
  },
};

export function validateMediaIngestPayload<K extends MediaIngestJobName>(
  name: K,
  payload: unknown,
): MediaIngestPayloadMap[K] {
  return mediaIngestJobSchemas[name].parse(payload) as MediaIngestPayloadMap[K];
}

export function validateMediaGeneratePayload<K extends MediaGenerateJobName>(
  name: K,
  payload: unknown,
): MediaGeneratePayloadMap[K] {
  return mediaGenerateJobSchemas[name].parse(payload) as MediaGeneratePayloadMap[K];
}

export function validateRenderExportPayload<K extends RenderExportJobName>(
  name: K,
  payload: unknown,
): RenderExportPayloadMap[K] {
  return renderExportJobSchemas[name].parse(payload) as RenderExportPayloadMap[K];
}

export function validateBlobGcPayload<K extends BlobGcJobName>(
  name: K,
  payload: unknown,
): BlobGcPayloadMap[K] {
  return blobGcJobSchemas[name].parse(payload) as BlobGcPayloadMap[K];
}

export function buildRenderThumbnailJobId(
  workspaceId: string,
  projectId: string,
  cacheKey: string,
): string {
  // BullMQ v5 rejects custom jobIds containing ':'.
  return `thumb__${workspaceId}__${projectId}__${cacheKey}`;
}

export function buildPreviewProxyJobId(workspaceId: string, sha256: string): string {
  // BullMQ v5 rejects custom jobIds containing ':'.
  return `proxy__${workspaceId}__${sha256}`;
}

export function buildMediaProbeJobId(workspaceId: string, sha256: string): string {
  return `probe__${workspaceId}__${sha256}`;
}

export function buildImageThumbnailJobId(workspaceId: string, sha256: string, spec: string): string {
  return `imgthumb__${workspaceId}__${sha256}__${spec}`;
}

export function buildVideoSpriteJobId(workspaceId: string, sha256: string): string {
  return `sprite__${workspaceId}__${sha256}`;
}

export function buildWaveformPeaksJobId(workspaceId: string, sha256: string): string {
  return `waveform__${workspaceId}__${sha256}`;
}

const DERIVED_DEDUPE_JOB_PREFIXES = ['probe__', 'imgthumb__', 'sprite__', 'waveform__', 'proxy__'] as const;

function isDerivedDedupeJobId(jobId: string | undefined): boolean {
  return Boolean(jobId && DERIVED_DEDUPE_JOB_PREFIXES.some((prefix) => jobId.startsWith(prefix)));
}

function defaultMediaIngestPriority(name: MediaIngestJobName): number {
  switch (name) {
    case 'upload_commit':
    case 'url_fetch':
      return 1;
    case 'media_probe':
      return 2;
    case 'image_thumbnail':
      return 3;
    case 'generate_video_sprite':
    case 'extract_waveform_peaks':
      return 4;
    case 'freeze_frame':
    case 'extract_asset_read':
    case 'inline_video_preview':
    case 'loudness_normalize':
      return 5;
    case 'generate_preview_proxy':
      return 10;
  }
}

export class QueueService {
  readonly mediaIngest: Queue;
  readonly mediaGenerate: Queue;
  readonly renderExport: Queue;
  readonly blobGc: Queue;
  private readonly redisUrl: string;
  private readonly connection: Redis;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
    this.connection = createRedisClient(redisUrl, 'bullmq');

    this.mediaIngest = new Queue(QUEUE_NAMES.mediaIngest, {
      connection: this.connection,
      defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.mediaIngest],
    });
    this.mediaGenerate = new Queue(QUEUE_NAMES.mediaGenerate, {
      connection: this.connection,
      defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.mediaGenerate],
    });
    this.renderExport = new Queue(QUEUE_NAMES.renderExport, {
      connection: this.connection,
      defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.renderExport],
    });
    this.blobGc = new Queue(QUEUE_NAMES.blobGc, {
      connection: this.connection,
      defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.blobGc],
    });
  }

  async enqueueMediaIngest<K extends MediaIngestJobName>(
    name: K,
    payload: MediaIngestPayloadMap[K],
    options?: JobsOptions,
  ) {
    const validated = validateMediaIngestPayload(name, payload);
    const defaultJobId =
      name === 'generate_preview_proxy'
        ? buildPreviewProxyJobId(
            validated.workspaceId,
            (validated as MediaIngestPayloadMap['generate_preview_proxy']).sha256,
          )
        : name === 'media_probe'
          ? buildMediaProbeJobId(
              validated.workspaceId,
              (validated as MediaIngestPayloadMap['media_probe']).sha256,
            )
          : name === 'image_thumbnail'
            ? buildImageThumbnailJobId(
                validated.workspaceId,
                (validated as MediaIngestPayloadMap['image_thumbnail']).sha256,
                (validated as MediaIngestPayloadMap['image_thumbnail']).spec,
              )
            : name === 'generate_video_sprite'
              ? buildVideoSpriteJobId(
                  validated.workspaceId,
                  (validated as MediaIngestPayloadMap['generate_video_sprite']).sha256,
                )
              : name === 'extract_waveform_peaks'
                ? buildWaveformPeaksJobId(
                    validated.workspaceId,
                    (validated as MediaIngestPayloadMap['extract_waveform_peaks']).sha256,
                  )
                : 'jobId' in validated && typeof validated.jobId === 'string'
                  ? validated.jobId
                  : undefined;
    const jobId = options?.jobId ?? defaultJobId;
    // BullMQ silently ignores add() when a terminal job with the same custom jobId is still retained.
    // Clear terminal derived jobs on explicit re-enqueue while keeping active/waiting jobs deduplicated.
    if (jobId && isDerivedDedupeJobId(jobId)) {
      const existing = await this.mediaIngest.getJob(jobId).catch(() => undefined);
      if (existing) {
        const state = await existing.getState().catch(() => null);
        if (state === 'completed' || state === 'failed') {
          await existing.remove().catch(() => {});
        }
      }
    }
    const defaultPriority = defaultMediaIngestPriority(name);
    return this.mediaIngest.add(name, validated, {
      priority: defaultPriority,
      ...options,
      ...(jobId ? { jobId } : {}),
    });
  }

  async enqueueMediaGenerate<K extends MediaGenerateJobName>(
    name: K,
    payload: MediaGeneratePayloadMap[K],
    options?: JobsOptions,
  ) {
    const validated = validateMediaGeneratePayload(name, payload);
    return this.mediaGenerate.add(name, validated, {
      ...options,
      jobId: options?.jobId ?? validated.jobId,
      attempts: 1,
    });
  }

  async enqueueRenderExport<K extends RenderExportJobName>(
    name: K,
    payload: RenderExportPayloadMap[K],
    options?: JobsOptions,
  ) {
    const validated = validateRenderExportPayload(name, payload);
    const defaultJobId =
      'jobId' in validated && typeof validated.jobId === 'string'
        ? validated.jobId
        : buildRenderThumbnailJobId(
            validated.workspaceId,
            validated.projectId,
            (validated as RenderExportPayloadMap['render_thumbnail']).cacheKey,
          );
    // Give export renders higher priority (1) than speculative composition thumbnails (5).
    const defaultPriority = name === 'export_render' ? 1 : 5;
    return this.renderExport.add(name, validated, {
      priority: defaultPriority,
      ...options,
      jobId: options?.jobId ?? defaultJobId,
      attempts: 1,
    });
  }

  async enqueueBlobGc<K extends BlobGcJobName>(
    name: K,
    payload: BlobGcPayloadMap[K],
    options?: JobsOptions,
  ) {
    const validated = validateBlobGcPayload(name, payload);
    return this.blobGc.add(name, validated, options);
  }

  async scheduleBlobGcRepeatable(graceSeconds: number = DEFAULT_BLOB_GC_GRACE_SECONDS): Promise<void> {
    await this.blobGc.upsertJobScheduler(
      'blob-gc-sweep-unreferenced',
      { every: 15 * 60_000 },
      {
        name: 'sweep_unreferenced_blobs',
        data: validateBlobGcPayload('sweep_unreferenced_blobs', { batchSize: 500, graceSeconds }),
      },
    );
    await this.blobGc.upsertJobScheduler(
      'blob-gc-sweep-uploads',
      { every: 15 * 60_000 },
      {
        name: 'sweep_expired_uploads',
        data: validateBlobGcPayload('sweep_expired_uploads', { batchSize: 500 }),
      },
    );
    await this.blobGc.upsertJobScheduler(
      'blob-gc-sweep-receipts',
      { every: 60 * 60_000 },
      {
        name: 'sweep_expired_receipts',
        data: validateBlobGcPayload('sweep_expired_receipts', { batchSize: 1000 }),
      },
    );
  }

  createQueueEvents(queueName: QueueName): { events: QueueEvents; close: () => Promise<void> } {
    const eventsConnection = createRedisClient(this.redisUrl, 'bullmq');
    const events = new QueueEvents(queueName, { connection: eventsConnection });
    return {
      events,
      close: async () => {
        await events.close();
        await eventsConnection.quit();
      },
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.mediaIngest.close(),
      this.mediaGenerate.close(),
      this.renderExport.close(),
      this.blobGc.close(),
    ]);
    await this.connection.quit();
  }
}
