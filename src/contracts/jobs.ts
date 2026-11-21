import { z } from 'zod';

export const QUEUE_NAMES = {
  mediaIngest: 'media-ingest',
  mediaGenerate: 'media-generate',
  renderExport: 'render-export',
  blobGc: 'blob-gc',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_KINDS = [
  'export_render',
  'media_generate',
  'media_ingest',
  'media_thumbnail',
  'archive_export',
  'archive_import',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = [
  'queued',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const blobScopeSchema = z.enum(['workspace', 'catalog']);

// ---------------------------------------------------------------------------
// Queue 1: media-ingest (worker-media, concurrency 20-50)
// ---------------------------------------------------------------------------

export const uploadCommitPayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
  uploadId: uuidSchema,
  userId: uuidSchema.optional(),
  purpose: z.enum(['library_asset', 'project_asset', 'project_archive']),
  targetProjectId: uuidSchema.optional(),
  targetAssetId: uuidSchema.optional(),
  parentVersionId: uuidSchema.optional(),
  targetPath: z.string().max(240).optional(),
  name: z.string().min(1).max(200),
  requestId: z.string().min(1).max(128).optional(),
  expectedModality: z.enum(['image', 'video', 'audio']).optional(),
  expectedSha256: sha256Schema.optional(),
});

export const urlFetchPayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
  url: z.string().url().max(2048),
  targetProjectId: uuidSchema.optional(),
  targetAssetId: uuidSchema.optional(),
  targetPath: z.string().max(240).optional(),
  parentVersionId: uuidSchema.optional(),
  itemId: z.string().max(128).optional(),
  name: z.string().min(1).max(200),
  requestId: z.string().min(1).max(128),
  expectedModality: z.enum(['image', 'video', 'audio']).optional(),
  expectedSha256: sha256Schema.optional(),
});

export const mediaProbePayloadSchema = z.object({
  workspaceId: uuidSchema,
  blobScope: blobScopeSchema,
  sha256: sha256Schema,
  s3Key: z.string().min(1).max(512),
  projectId: uuidSchema.optional(),
});

export const imageThumbnailPayloadSchema = z.object({
  workspaceId: uuidSchema,
  blobScope: blobScopeSchema,
  sha256: sha256Schema,
  spec: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  width: z.number().int().min(16).max(2048),
  height: z.number().int().min(16).max(2048).optional(),
  timestampSec: z.number().min(0).optional(),
  projectId: uuidSchema.optional(),
});

export const extractWaveformPeaksPayloadSchema = z.object({
  workspaceId: uuidSchema,
  blobScope: blobScopeSchema,
  sha256: sha256Schema,
  samples: z.number().int().min(16).max(16384).default(2048),
  projectId: uuidSchema.optional(),
});

export const generateVideoSpritePayloadSchema = z.object({
  workspaceId: uuidSchema,
  blobScope: blobScopeSchema,
  sha256: sha256Schema,
  projectId: uuidSchema.optional(),
  durationSec: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const loudnessNormalizePayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  blobScope: blobScopeSchema,
  sha256: sha256Schema,
  targetPath: z.string().min(1).max(240),
  targetLufs: z.number().min(-36).max(-5).default(-16),
});

export const freezeFramePayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  blobScope: blobScopeSchema,
  sha256: sha256Schema,
  timestampSec: z.number().min(0),
  targetPath: z.string().min(1).max(240),
});

export const extractAssetReadPayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
  assetId: uuidSchema,
  versionId: uuidSchema,
  timestamps: z.array(z.number().min(0)).max(4).optional(),
  start: z.number().min(0).optional(),
  duration: z.number().min(0.1).max(15).optional(),
});

export const inlineVideoPreviewPayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
  exportJobId: uuidSchema,
  sourceS3Key: z.string().min(1).max(512),
  sourceSha256: sha256Schema,
});

export const generatePreviewProxyPayloadSchema = z.object({
  kind: z.literal('generate_preview_proxy').default('generate_preview_proxy'),
  workspaceId: uuidSchema,
  sha256: sha256Schema,
  mimeType: z.string().min(1).max(128),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  projectId: uuidSchema.optional(),
});

export const mediaIngestJobSchemas = {
  upload_commit: uploadCommitPayloadSchema,
  url_fetch: urlFetchPayloadSchema,
  media_probe: mediaProbePayloadSchema,
  image_thumbnail: imageThumbnailPayloadSchema,
  extract_waveform_peaks: extractWaveformPeaksPayloadSchema,
  generate_video_sprite: generateVideoSpritePayloadSchema,
  loudness_normalize: loudnessNormalizePayloadSchema,
  freeze_frame: freezeFramePayloadSchema,
  extract_asset_read: extractAssetReadPayloadSchema,
  inline_video_preview: inlineVideoPreviewPayloadSchema,
  generate_preview_proxy: generatePreviewProxyPayloadSchema,
} as const;

export type MediaIngestJobName = keyof typeof mediaIngestJobSchemas;
export type MediaIngestPayloadMap = {
  [K in MediaIngestJobName]: z.infer<(typeof mediaIngestJobSchemas)[K]>;
};

// ---------------------------------------------------------------------------
// Queue 2: media-generate (worker-media, attempts: 1 — never auto-repay!)
// ---------------------------------------------------------------------------

export const generateMediaPayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
});

export const resumeGenerationPayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
  remoteId: z.string().min(1).max(200),
});

export const retrySaveGenerationPayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
});

export const mediaGenerateJobSchemas = {
  generate_media: generateMediaPayloadSchema,
  resume_generation: resumeGenerationPayloadSchema,
  retry_save_generation: retrySaveGenerationPayloadSchema,
} as const;

export type MediaGenerateJobName = keyof typeof mediaGenerateJobSchemas;
export type MediaGeneratePayloadMap = {
  [K in MediaGenerateJobName]: z.infer<(typeof mediaGenerateJobSchemas)[K]>;
};

// ---------------------------------------------------------------------------
// Queue 3: render-export (worker-render, concurrency 1-2, attempts: 1)
// ---------------------------------------------------------------------------

export const exportRenderPayloadSchema = z.object({
  jobId: uuidSchema,
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  versionId: uuidSchema,
  revision: sha256Schema,
  compositionPath: z.string().max(240).optional(),
  outputName: z.string().min(1).max(255),
  format: z.enum(['mp4', 'mov', 'webm', 'gif']).default('mp4'),
  phase1: z.boolean().default(true),
  settings: z.record(z.string(), z.unknown()).optional(),
  expected: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().positive(),
      duration: z.number().positive(),
      audio: z.enum(['silent', 'optional', 'required']),
    })
    .optional(),
});

export const renderThumbnailPayloadSchema = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  versionId: uuidSchema.optional(),
  revision: sha256Schema,
  compositionPath: z.string().min(1).max(240),
  cacheKey: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  timeSec: z.number().min(0).default(0),
  width: z.number().int().min(32).max(1920).default(320),
  height: z.number().int().min(32).max(1080).default(180),
});

export const renderExportJobSchemas = {
  export_render: exportRenderPayloadSchema,
  render_thumbnail: renderThumbnailPayloadSchema,
} as const;

export type RenderExportJobName = keyof typeof renderExportJobSchemas;
export type RenderExportPayloadMap = {
  [K in RenderExportJobName]: z.infer<(typeof renderExportJobSchemas)[K]>;
};

// ---------------------------------------------------------------------------
// Queue 4: blob-gc (worker-media repeatable sweeper)
// ---------------------------------------------------------------------------

/** Default 7-day grace window before Mark-and-Sweep CAS GC physically deletes unreferenced blobs. */
export const DEFAULT_BLOB_GC_GRACE_SECONDS = 604_800;

export const sweepUnreferencedBlobsPayloadSchema = z.object({
  batchSize: z.number().int().min(1).max(2000).default(500),
  graceSeconds: z.number().int().min(0).default(DEFAULT_BLOB_GC_GRACE_SECONDS),
});

export const sweepExpiredUploadsPayloadSchema = z.object({
  batchSize: z.number().int().min(1).max(2000).default(500),
});

export const sweepExpiredReceiptsPayloadSchema = z.object({
  batchSize: z.number().int().min(1).max(5000).default(1000),
});

export const blobGcJobSchemas = {
  sweep_unreferenced_blobs: sweepUnreferencedBlobsPayloadSchema,
  sweep_expired_uploads: sweepExpiredUploadsPayloadSchema,
  sweep_expired_receipts: sweepExpiredReceiptsPayloadSchema,
} as const;

export type BlobGcJobName = keyof typeof blobGcJobSchemas;
export type BlobGcPayloadMap = {
  [K in BlobGcJobName]: z.infer<(typeof blobGcJobSchemas)[K]>;
};
