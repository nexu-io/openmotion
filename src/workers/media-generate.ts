import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, isNotNull } from 'drizzle-orm';
import { MAX_MEDIA_BYTES, mediaType } from '../../gateway/network.ts';
import type { AssetReference } from '../../shared/asset-library.ts';
import type { Model } from '../../shared/gateway.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { JobProgressEvent } from '../contracts/events.ts';
import type { MediaGenerateJobName, MediaGeneratePayloadMap } from '../contracts/jobs.ts';
import type { BlobMetadata, StoragePort } from '../contracts/storage.ts';
import { applyWorkspaceBlobRefDeltas, type BlobRefDelta } from '../db/cas.ts';
import type { Database, DbExecutor } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import { assets, assetVersions, type AssetModality } from '../db/schema/blobs-assets.ts';
import { jobs } from '../db/schema/jobs.ts';
import type { Logger } from '../infra/logger.ts';
import { cancelChannel, jobChannel, type RedisEventBus } from '../infra/redis.ts';
import { thumbnailKey, workspaceBlobKey } from '../infra/storage.ts';
import {
  defaultGenerateThumbnailBuffer,
  normalizeSdrPngFileIfApplicable,
  probeMediaFile,
  type ProbedMediaInfo,
} from './media-ingest.ts';

// ---------------------------------------------------------------------------
// PlatformModelGateway Port (structurally aligned with Spike 2 §3.3.1)
// ---------------------------------------------------------------------------

export interface GatewayCallContext {
  readonly workspaceId: string;
  readonly externalWorkspaceId?: string;
  readonly externalUserId?: string;
  readonly appUserId?: string;
  readonly amrWorkspaceMemberId?: string;
  readonly amrWorkspaceRole?: 'owner' | 'admin' | 'member';
  readonly amrWorkspaceLifecycleState?: string;
  readonly signal: AbortSignal;
  readonly idempotencyKey?: string;
}

export interface GatewayUploadedInput {
  readonly remoteAssetId: string;
  readonly role?: 'first_frame' | 'last_frame' | 'reference';
}

export interface GatewaySubmitInput {
  readonly jobId: string;
  readonly modality: AssetModality;
  readonly mode: 'text-to-image' | 'text-to-video' | 'text-to-audio' | 'text-to-speech';
  readonly modelId: string;
  readonly prompt: string;
  readonly parameters: Record<string, unknown>;
  readonly inputs: readonly GatewayUploadedInput[];
}

export interface GatewayTaskOutput {
  readonly remoteAssetId?: string;
  readonly downloadUrl?: string;
  readonly contentPath?: string;
  readonly inlineBytes?: Buffer;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
}

export interface GatewayTaskPollResult {
  readonly remoteTaskId: string;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly outputs?: readonly GatewayTaskOutput[];
  readonly metadata?: Record<string, unknown>;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly outcomeUnknown?: boolean;
  };
}

export interface PlatformModelGateway {
  readonly providerId: 'opendesign';
  listMediaModels(ctx: GatewayCallContext): Promise<Model[]>;
  uploadReference(
    ctx: GatewayCallContext,
    input: { bytes: Buffer; mimeType: string; idempotencyKey: string },
  ): Promise<{ remoteAssetId: string }>;
  submitTask(ctx: GatewayCallContext, input: GatewaySubmitInput): Promise<{ remoteTaskId: string }>;
  pollTask(
    ctx: GatewayCallContext,
    input: { modality: AssetModality; remoteTaskId: string },
  ): Promise<GatewayTaskPollResult>;
  downloadOutput(
    ctx: GatewayCallContext,
    output: GatewayTaskOutput,
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface MediaGenerateDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly eventBus: Pick<RedisEventBus, 'publish' | 'subscribe'>;
  readonly logger: Logger;
  readonly workerId: string;
  readonly gateway: PlatformModelGateway;
  readonly pollIntervalMs?: number;
  readonly maxPollMs?: number;
  readonly tmpBaseDir?: string;
  readonly probeMedia?: (filePath: string, modality: AssetModality) => Promise<ProbedMediaInfo>;
  readonly generateThumbnailBuffer?: (
    filePath: string,
    media: ProbedMediaInfo,
    options: { width: number },
  ) => Promise<Buffer | null>;
  readonly applyBlobDeltas?: (
    tx: DbExecutor,
    workspaceId: string,
    deltas: readonly BlobRefDelta[],
  ) => Promise<void>;
}

interface ParsedGenerationInput {
  modality: AssetModality;
  mode: 'text-to-image' | 'text-to-video' | 'text-to-audio' | 'text-to-speech';
  modelId: string;
  prompt: string;
  parameters: Record<string, unknown>;
  assetId?: string;
  assetName: string;
  parentVersionId?: string;
  references: Array<{
    assetId: string;
    versionId: string;
    sha256: string;
    mimeType: string;
    role?: 'first_frame' | 'last_frame' | 'reference';
  }>;
  externalWorkspaceId?: string;
  externalUserId?: string;
  appUserId?: string;
  amrWorkspaceMemberId?: string;
  amrWorkspaceRole?: 'owner' | 'admin' | 'member';
  amrWorkspaceLifecycleState?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_MS = 15 * 60_000;
const MAX_TRANSIENT_POLL_ERRORS = 5;
const BLOB_GC_RETRY_MAX = 5;

function parseGenerationInput(raw: Record<string, unknown>): ParsedGenerationInput {
  const modalityRaw = raw.modality;
  if (modalityRaw !== 'image' && modalityRaw !== 'video' && modalityRaw !== 'audio') {
    throw new CloudError('INVALID_ARGUMENT', `Invalid generation modality: ${String(modalityRaw)}`, { status: 400 });
  }
  const modeRaw = raw.mode;
  const mode: ParsedGenerationInput['mode'] =
    modeRaw === 'text-to-image' ||
    modeRaw === 'text-to-video' ||
    modeRaw === 'text-to-audio' ||
    modeRaw === 'text-to-speech'
      ? modeRaw
      : modalityRaw === 'image'
        ? 'text-to-image'
        : modalityRaw === 'video'
          ? 'text-to-video'
          : 'text-to-audio';
  const modelId = typeof raw.modelId === 'string' && raw.modelId.trim() ? raw.modelId.trim() : '';
  if (!modelId) {
    throw new CloudError('INVALID_ARGUMENT', 'Generation job is missing modelId', { status: 400 });
  }
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  const parameters =
    raw.parameters && typeof raw.parameters === 'object' && !Array.isArray(raw.parameters)
      ? (raw.parameters as Record<string, unknown>)
      : {};
  const assetName =
    typeof raw.assetName === 'string' && raw.assetName.trim()
      ? raw.assetName.trim().slice(0, 200)
      : typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim().slice(0, 200)
        : `Generated ${modalityRaw}`;
  const rawRefs = Array.isArray(raw.references) ? raw.references : [];
  const references = rawRefs
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
    .filter(
      (entry) =>
        typeof entry.assetId === 'string' &&
        typeof entry.versionId === 'string' &&
        typeof entry.sha256 === 'string' &&
        typeof entry.mimeType === 'string',
    )
    .map((entry) => ({
      assetId: entry.assetId as string,
      versionId: entry.versionId as string,
      sha256: entry.sha256 as string,
      mimeType: entry.mimeType as string,
      role:
        entry.role === 'first_frame' || entry.role === 'last_frame' || entry.role === 'reference'
          ? (entry.role as 'first_frame' | 'last_frame' | 'reference')
          : undefined,
    }));

  return {
    modality: modalityRaw,
    mode,
    modelId,
    prompt,
    parameters,
    assetId: typeof raw.assetId === 'string' ? raw.assetId : undefined,
    assetName,
    parentVersionId: typeof raw.parentVersionId === 'string' ? raw.parentVersionId : undefined,
    references,
    externalWorkspaceId: typeof raw.externalWorkspaceId === 'string' ? raw.externalWorkspaceId : undefined,
    externalUserId: typeof raw.externalUserId === 'string' ? raw.externalUserId : undefined,
    appUserId: typeof raw.appUserId === 'string' ? raw.appUserId : undefined,
    amrWorkspaceMemberId: typeof raw.amrWorkspaceMemberId === 'string' ? raw.amrWorkspaceMemberId : undefined,
    amrWorkspaceRole:
      raw.amrWorkspaceRole === 'owner' || raw.amrWorkspaceRole === 'admin' || raw.amrWorkspaceRole === 'member'
        ? raw.amrWorkspaceRole
        : undefined,
    amrWorkspaceLifecycleState:
      typeof raw.amrWorkspaceLifecycleState === 'string' ? raw.amrWorkspaceLifecycleState : undefined,
  };
}

async function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('COMMAND_CANCELLED');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('COMMAND_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function writeGatewayOutputToFile(
  gateway: PlatformModelGateway,
  callCtx: GatewayCallContext,
  output: GatewayTaskOutput,
  destPath: string,
): Promise<{ bytes: number; sha256: string }> {
  if (output.inlineBytes && output.inlineBytes.byteLength > 0) {
    if (output.inlineBytes.byteLength > MAX_MEDIA_BYTES) {
      throw new CloudError('INVALID_ARGUMENT', 'Generated media output exceeds byte limit', { status: 413 });
    }
    await writeFile(destPath, output.inlineBytes);
    return {
      bytes: output.inlineBytes.byteLength,
      sha256: createHash('sha256').update(output.inlineBytes).digest('hex'),
    };
  }

  const webStream = await gateway.downloadOutput(callCtx, output);
  const nodeStream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  const digest = createHash('sha256');
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.byteLength;
      if (bytes > MAX_MEDIA_BYTES) {
        callback(new CloudError('INVALID_ARGUMENT', 'Generated media output exceeds byte limit', { status: 413 }));
        return;
      }
      digest.update(buf);
      callback(null, buf);
    },
  });
  await pipeline(nodeStream, limiter, createWriteStream(destPath, { mode: 0o600 }));
  return { bytes, sha256: digest.digest('hex') };
}

async function defaultProbeGeneratedMedia(filePath: string, modality: AssetModality): Promise<ProbedMediaInfo> {
  try {
    return await probeMediaFile(filePath);
  } catch {
    // Fallback to deterministic magic-byte inspection when ffprobe is unavailable in minimal test environments.
    const bytes = await readFile(filePath);
    const detected = mediaType(bytes, modality);
    return {
      modality,
      mimeType: detected.mimeType,
      extension: detected.extension,
      sizeBytes: bytes.byteLength,
    };
  }
}

/**
 * Execute a `media-generate` job (`attempts: 1`, NO silent paid auto-replay):
 * 1. Claim job atomically with fencing `claim_token`.
 * 2. If `remote_id` is absent, upload pinned references + submit task with `Idempotency-Key: jobId`
 *    and IMMEDIATELY persist `remote_id` in PG `jobs` BEFORE entering the poll loop.
 * 3. Poll injected `PlatformModelGateway` port until terminal status or cancellation.
 * 4. Download output(s) to ephemeral `/tmp`, promote to S3 CAS BEFORE PG tx, commit
 *    `workspace_blobs` + `assets` + `asset_versions` + `jobs`, publish progress on `om:job:{jobId}`,
 *    and ALWAYS clean up `/tmp` in `finally`.
 */
export async function processMediaGenerateJob<K extends MediaGenerateJobName>(
  deps: MediaGenerateDeps,
  name: K,
  payload: MediaGeneratePayloadMap[K],
): Promise<Record<string, unknown>> {
  const { jobId, workspaceId } = payload;
  const claimToken = randomUUID();
  const retrySave = name === 'retry_save_generation';
  const workDir = path.join(deps.tmpBaseDir ?? os.tmpdir(), `om-gen-${jobId}-${claimToken}`);
  const abortController = new AbortController();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollMs = deps.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  const applyDeltas = deps.applyBlobDeltas ?? applyWorkspaceBlobRefDeltas;

  let unsubscribeCancel: (() => Promise<void>) | null = null;
  let claimedJob: typeof jobs.$inferSelect | null = null;
  let terminalHandled = false;
  let savePending = retrySave;

  const publishProgress = async (
    state: JobProgressEvent['state'],
    stage: string,
    progress: number,
    extra: Partial<JobProgressEvent> = {},
  ) => {
    const event: JobProgressEvent = {
      jobId,
      workspaceId,
      projectId: claimedJob?.projectId ?? null,
      kind: 'media_generate',
      state,
      stage,
      progress,
      ts: Date.now(),
      ...extra,
    };
    await deps.eventBus.publish(jobChannel(jobId), event).catch(() => {});
  };

  try {
    // 1. Atomic claim with fencing token (ensures single worker ownership).
    const now = new Date();
    const claimedRows = await deps.db
      .update(jobs)
      .set(
        asUpdate(jobs, {
          state: 'running',
          stage: 'claiming',
          progress: 5,
          workerId: deps.workerId,
          claimToken,
          ...(retrySave ? { failureStage: null, errorCode: null, errorMessage: null, terminalAt: null } : {}),
          startedAt: now,
          updatedAt: now,
        }),
      )
      .where(and(
        eq(jobs.id, jobId),
        eq(jobs.workspaceId, workspaceId),
        eq(jobs.state, retrySave ? 'failed' : 'queued'),
        retrySave ? and(eq(jobs.savePending, true), isNotNull(jobs.remoteId)) : undefined,
      ))
      .returning();

    if (claimedRows.length === 0) {
      deps.logger.info('Skipping ineligible media-generate job', { jobId, workspaceId, name });
      return { skipped: true, jobId };
    }
    claimedJob = claimedRows[0];

    // Subscribe to Redis cancellation notifications (`om:cancel:{jobId}`).
    unsubscribeCancel = await deps.eventBus.subscribe(cancelChannel(jobId), () => {
      abortController.abort(new Error('COMMAND_CANCELLED'));
    });

    const spec = parseGenerationInput(claimedJob.inputPayload ?? {});
    const callCtx: GatewayCallContext = {
      workspaceId,
      externalWorkspaceId: spec.externalWorkspaceId,
      externalUserId: spec.externalUserId,
      appUserId: spec.appUserId,
      amrWorkspaceMemberId: spec.amrWorkspaceMemberId,
      amrWorkspaceRole: spec.amrWorkspaceRole,
      amrWorkspaceLifecycleState: spec.amrWorkspaceLifecycleState,
      signal: abortController.signal,
      idempotencyKey: jobId,
    };

    // 2. Submit once. Save retries read the original result through the persisted remote ID.
    let remoteId: string | null =
      claimedJob.remoteId ??
      (name === 'resume_generation'
        ? (payload as MediaGeneratePayloadMap['resume_generation']).remoteId
        : null);

    if (!remoteId) {
      await publishProgress('running', 'uploading', 10);
      const uploadedInputs: GatewayUploadedInput[] = [];
      for (const [index, ref] of spec.references.entries()) {
        abortController.signal.throwIfAborted();
        const refKey = workspaceBlobKey(workspaceId, ref.sha256);
        const bytes = await deps.storage.getObjectBuffer(refKey, MAX_MEDIA_BYTES);
        const uploaded = await deps.gateway.uploadReference(callCtx, {
          bytes,
          mimeType: ref.mimeType,
          idempotencyKey: `${jobId}-upload-${index}`,
        });
        uploadedInputs.push({
          remoteAssetId: uploaded.remoteAssetId,
          ...(ref.role ? { role: ref.role } : {}),
        });
      }

      await publishProgress('running', 'submitting', 20);
      const submitted = await deps.gateway.submitTask(callCtx, {
        jobId,
        modality: spec.modality,
        mode: spec.mode,
        modelId: spec.modelId,
        prompt: spec.prompt,
        parameters: spec.parameters,
        inputs: uploadedInputs,
      });

      remoteId = submitted.remoteTaskId;

      // CRITICAL INVARIANT: Persist remote_id to PG BEFORE entering the poll loop!
      const persisted = await deps.db
        .update(jobs)
        .set(
          asUpdate(jobs, {
            remoteId,
            stage: 'submitted',
            progress: 25,
            updatedAt: new Date(),
          }),
        )
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.workspaceId, workspaceId),
            eq(jobs.claimToken, claimToken),
          ),
        )
        .returning({ id: jobs.id });

      if (persisted.length === 0) {
        throw new Error('CLAIM_TOKEN_LOST');
      }
      await publishProgress('running', 'submitted', 25);
    } else if (claimedJob.remoteId !== remoteId) {
      await deps.db
        .update(jobs)
        .set(asUpdate(jobs, { remoteId, stage: 'polling', updatedAt: new Date() }))
        .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId), eq(jobs.claimToken, claimToken)));
    }

    // 3. Poll injected PlatformModelGateway port until terminal outcome.
    const pollDeadline = Date.now() + maxPollMs;
    let pollResult: GatewayTaskPollResult | null = null;
    let transientErrors = 0;
    let pollAttempts = 0;

    while (Date.now() < pollDeadline) {
      if (abortController.signal.aborted) {
        throw new Error('COMMAND_CANCELLED');
      }
      if (pollAttempts > 0) {
        await delayWithSignal(pollIntervalMs, abortController.signal);
      }
      pollAttempts += 1;

      try {
        pollResult = await deps.gateway.pollTask(callCtx, {
          modality: spec.modality,
          remoteTaskId: remoteId,
        });
        transientErrors = 0;
      } catch (pollErr) {
        if (abortController.signal.aborted) throw new Error('COMMAND_CANCELLED');
        transientErrors += 1;
        if (transientErrors >= MAX_TRANSIENT_POLL_ERRORS) {
          throw pollErr;
        }
        await publishProgress('running', 'reconnecting', Math.min(80, 25 + pollAttempts * 3));
        continue;
      }

      if (pollResult.status === 'succeeded') {
        break;
      }
      if (pollResult.status === 'cancelled') {
        const outcomeUnknown = Boolean(pollResult.error?.outcomeUnknown);
        const errorCode = pollResult.error?.code ?? 'REMOTE_TASK_CANCELLED';
        const errorMessage =
          pollResult.error?.message ?? `Upstream generation task cancelled (${errorCode})`;
        const terminalNow = new Date();
        await deps.db
          .update(jobs)
          .set(
            asUpdate(jobs, {
              state: 'cancelled',
              stage: 'cancelled',
              remoteTerminal: !outcomeUnknown,
              savePending: false,
              failureStage: 'generating',
              errorCode,
              errorMessage,
              resultJson: pollResult.error ? { error: pollResult.error } : null,
              terminalAt: terminalNow,
              updatedAt: terminalNow,
            }),
          )
          .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId), eq(jobs.claimToken, claimToken)));

        await publishProgress('cancelled', 'cancelled', 0, {
          errorCode,
          errorMessage,
          remoteTerminal: !outcomeUnknown,
        });
        terminalHandled = true;
        return { jobId, state: 'cancelled', remoteId };
      }

      if (pollResult.status === 'failed') {
        const outcomeUnknown = Boolean(pollResult.error?.outcomeUnknown);
        const errorCode = pollResult.error?.code ?? 'REMOTE_TASK_FAILED';
        const errorMessage =
          pollResult.error?.message ?? `Upstream generation task failed (${errorCode})`;
        const terminalNow = new Date();
        await deps.db
          .update(jobs)
          .set(
            asUpdate(jobs, {
              state: 'failed',
              stage: 'failed',
              remoteTerminal: !outcomeUnknown,
              savePending: outcomeUnknown && savePending,
              failureStage: outcomeUnknown && savePending ? 'saving' : 'generating',
              errorCode,
              errorMessage,
              resultJson: pollResult.error ? { error: pollResult.error } : null,
              terminalAt: terminalNow,
              updatedAt: terminalNow,
            }),
          )
          .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId), eq(jobs.claimToken, claimToken)));

        await publishProgress('failed', 'failed', 0, {
          errorCode,
          errorMessage,
          remoteTerminal: !outcomeUnknown,
        });
        terminalHandled = true;
        throw new CloudError('STORAGE_ERROR', errorMessage, { status: 502 });
      }

      const estimatedProgress = Math.min(80, 30 + pollAttempts * 5);
      await publishProgress('running', 'generating', estimatedProgress);
    }

    if (!pollResult || pollResult.status !== 'succeeded') {
      throw new CloudError('SERVICE_UNAVAILABLE', 'Upstream media generation timed out; use resume to continue polling', {
        status: 504,
      });
    }

    const outputs = pollResult.outputs ?? [];
    if (outputs.length === 0) {
      throw new CloudError('STORAGE_ERROR', 'Upstream generation completed without media outputs', { status: 502 });
    }
    // 4. Download outputs into ephemeral /tmp, probe, normalize SDR PNG, generate thumbnails, upload to CAS BEFORE PG tx.
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await publishProgress('running', 'downloading', 85);

    const preparedOutputs: Array<{
      sha256: string;
      sizeBytes: number;
      blobKey: string;
      bytes: Buffer;
      probed: ProbedMediaInfo;
      metadata: BlobMetadata;
      thumbnailKey?: string;
    }> = [];

    const probeFn = deps.probeMedia ?? defaultProbeGeneratedMedia;
    const thumbFn =
      deps.generateThumbnailBuffer ??
      ((file: string, media: ProbedMediaInfo, opts: { width: number }) =>
        defaultGenerateThumbnailBuffer(file, media, opts));

    for (const [index, output] of outputs.entries()) {
      abortController.signal.throwIfAborted();
      const localPath = path.join(workDir, `output-${index}.bin`);
      await writeGatewayOutputToFile(deps.gateway, callCtx, output, localPath);
      const probed = await probeFn(localPath, spec.modality);
      const normalized = await normalizeSdrPngFileIfApplicable(localPath, probed.mimeType);
      const bytes = await readFile(localPath);
      const sha256 = normalized.sha256;
      const blobKey = workspaceBlobKey(workspaceId, sha256);

      let thumbKey: string | undefined;
      const thumbBuf = await thumbFn(localPath, probed, { width: 320 }).catch(() => null);
      if (thumbBuf && thumbBuf.byteLength > 0) {
        thumbKey = thumbnailKey(workspaceId, sha256, 'w320');
        await deps.storage.putObject(thumbKey, thumbBuf, 'image/jpeg', thumbBuf.byteLength);
      }

      preparedOutputs.push({
        sha256,
        sizeBytes: bytes.byteLength,
        blobKey,
        bytes,
        probed,
        metadata: {
          modality: probed.modality,
          mimeType: probed.mimeType,
          ...(probed.width !== undefined ? { width: probed.width } : {}),
          ...(probed.height !== undefined ? { height: probed.height } : {}),
          ...(probed.durationSec !== undefined ? { durationSec: probed.durationSec } : {}),
          ...(probed.fps !== undefined ? { fps: probed.fps } : {}),
          ...(probed.codec ? { codec: probed.codec } : {}),
          ...(normalized.normalized ? { sdrNormalized: true } : {}),
        },
        thumbnailKey: thumbKey,
      });
    }

    savePending = true;
    await publishProgress('running', 'saving', 92);

    // Upload-Before-Reference invariant: put every output blob to S3 CAS BEFORE PG transaction.
    const uploadOutputsToCas = async () => {
      for (const item of preparedOutputs) {
        await deps.storage.putBlobIfAbsent(item.blobKey, item.bytes, item.probed.mimeType);
      }
    };
    await uploadOutputsToCas();

    const referencesJson: AssetReference[] = spec.references.map((r) => ({
      assetId: r.assetId,
      versionId: r.versionId,
    }));

    // 5. Commit workspace_blobs + assets + asset_versions + jobs atomically (with BLOB_GC_IN_PROGRESS retry).
    let committedResult: {
      cancelled: boolean;
      libraryAssets: Array<{ assetId: string; versionId: string; sha256: string }>;
    } | null = null;

    for (let attempt = 0; ; attempt += 1) {
      try {
        committedResult = await deps.db.transaction(async (tx) => {
          const currentRows = await tx
            .select({ state: jobs.state, claimToken: jobs.claimToken })
            .from(jobs)
            .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId)))
            .for('update')
            .limit(1);

          if (currentRows.length === 0 || currentRows[0].claimToken !== claimToken) {
            throw new Error('CLAIM_TOKEN_LOST');
          }
          if (currentRows[0].state === 'cancelling' || abortController.signal.aborted) {
            const cancelNow = new Date();
            await tx
              .update(jobs)
              .set(
                asUpdate(jobs, {
                  state: 'cancelled',
                  stage: 'cancelled',
                  savePending: false,
                  terminalAt: cancelNow,
                  updatedAt: cancelNow,
                }),
              )
              .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId), eq(jobs.claimToken, claimToken)));
            return { cancelled: true, libraryAssets: [] };
          }

          await applyDeltas(
            tx,
            workspaceId,
            preparedOutputs.map((item) => ({
              sha256: item.sha256,
              delta: 1,
              sizeBytes: item.sizeBytes,
              mimeType: item.probed.mimeType,
              s3Key: item.blobKey,
              metadata: item.metadata,
            })),
          );

          const commitNow = new Date();
          const libraryAssets: Array<{ assetId: string; versionId: string; sha256: string }> = [];

          for (const [index, item] of preparedOutputs.entries()) {
            let assetId = index === 0 ? spec.assetId : undefined;
            if (assetId) {
              const found = await tx
                .select({ id: assets.id })
                .from(assets)
                .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)))
                .for('update')
                .limit(1);
              if (found.length === 0) assetId = undefined;
            }
            if (!assetId) {
              assetId = randomUUID();
              await tx.insert(assets).values(
                asInsert(assets, {
                  id: assetId,
                  workspaceId,
                  name: preparedOutputs.length > 1 ? `${spec.assetName} (${index + 1})` : spec.assetName,
                  modality: item.probed.modality,
                  trashed: false,
                  trashedAt: null,
                  createdAt: commitNow,
                  updatedAt: commitNow,
                }),
              );
            }

            const versionId = randomUUID();
            await tx.insert(assetVersions).values(
              asInsert(assetVersions, {
                id: versionId,
                workspaceId,
                assetId,
                source: 'generated',
                filename: `media.${item.probed.extension}`,
                displayName: spec.assetName,
                sha256: item.sha256,
                sizeBytes: item.sizeBytes,
                mimeType: item.probed.mimeType,
                width: item.probed.width ?? null,
                height: item.probed.height ?? null,
                durationSec: item.probed.durationSec ?? null,
                prompt: spec.prompt,
                model: `opendesign:${spec.modelId}`,
                parameters: spec.parameters,
                references: referencesJson,
                parentVersionId: index === 0 ? spec.parentVersionId ?? null : null,
                jobId,
                providerResult: pollResult?.metadata ?? null,
                createdAt: commitNow,
              }),
            );

            await tx
              .update(assets)
              .set(asUpdate(assets, { currentVersionId: versionId, updatedAt: commitNow }))
              .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));

            libraryAssets.push({ assetId, versionId, sha256: item.sha256 });
          }

          const resultJson = {
            remoteId,
            libraryAssets,
            ...(pollResult?.metadata ? { providerResult: pollResult.metadata } : {}),
          };

          await tx
            .update(jobs)
            .set(
              asUpdate(jobs, {
                state: 'completed',
                stage: 'completed',
                progress: 100,
                savePending: false,
                resultJson,
                terminalAt: commitNow,
                updatedAt: commitNow,
              }),
            )
            .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId), eq(jobs.claimToken, claimToken)));

          return { cancelled: false, libraryAssets };
        });
        break;
      } catch (error) {
        if (isCloudError(error) && error.code === 'BLOB_GC_IN_PROGRESS' && attempt < BLOB_GC_RETRY_MAX) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 150 * (attempt + 1));
            timer.unref();
          });
          await uploadOutputsToCas();
          continue;
        }
        throw error;
      }
    }

    if (committedResult.cancelled) {
      await publishProgress('cancelled', 'cancelled', 0);
      return { jobId, state: 'cancelled' };
    }

    const finalPayload = {
      remoteId,
      libraryAssets: committedResult.libraryAssets,
    };
    await publishProgress('completed', 'completed', 100, { resultJson: finalPayload });
    return { jobId, state: 'completed', ...finalPayload };
  } catch (error) {
    if (claimedJob && !terminalHandled) {
      const isCancelled =
        abortController.signal.aborted || (error instanceof Error && error.message === 'COMMAND_CANCELLED');
      const now = new Date();
      if (isCancelled) {
        try {
          await deps.db
            .update(jobs)
            .set(
              asUpdate(jobs, {
                state: 'cancelled',
                stage: 'cancelled',
                savePending: false,
                terminalAt: now,
                updatedAt: now,
              }),
            )
            .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId), eq(jobs.claimToken, claimToken)));
        } catch {
          // Best-effort terminal persistence during cancellation.
        }
        await publishProgress('cancelled', 'cancelled', 0);
      } else {
        const rawCode =
          !isCloudError(error) && error instanceof Error
            ? (error as Error & { code?: unknown }).code
            : undefined;
        const gatewayCode =
          typeof rawCode === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(rawCode) ? rawCode : null;
        const errorCode = isCloudError(error) ? error.code : (gatewayCode ?? 'MEDIA_GENERATE_FAILED');
        const errorMessage = error instanceof Error ? error.message : 'Media generation failed';
        try {
          await deps.db
            .update(jobs)
            .set(
              asUpdate(jobs, {
                state: 'failed',
                stage: 'failed',
                failureStage: savePending ? 'saving' : 'generate',
                savePending,
                errorCode,
                errorMessage,
                terminalAt: now,
                updatedAt: now,
              }),
            )
            .where(
              and(
                eq(jobs.id, jobId),
                eq(jobs.workspaceId, workspaceId),
                eq(jobs.claimToken, claimToken),
                eq(jobs.state, 'running'),
              ),
            );
        } catch {
          // Best-effort terminal persistence during failure handling.
        }
        await publishProgress('failed', 'failed', 0, {
          errorCode,
          errorMessage,
          remoteTerminal: false,
        });
      }
    }
    throw error;
  } finally {
    if (unsubscribeCancel) {
      await unsubscribeCancel().catch(() => {});
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
