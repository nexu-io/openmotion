import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { validateExportExpectation, type ExportExpectation } from '../../shared/export-spec.ts';
import {
  STUDIO_MANIFESTS,
  isSha256Hex,
  isUuid,
  projectPath,
  validateStableRequestId,
} from '../../shared/project-validation.ts';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError, revisionConflict } from '../contracts/errors.ts';
import type { JobCancelEvent, JobProgressEvent, ProjectEvent } from '../contracts/events.ts';
import type { JobState } from '../contracts/jobs.ts';
import type { StoragePort } from '../contracts/storage.ts';
import { applyWorkspaceBlobRefDeltas } from '../db/cas.ts';
import type { Database } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import { jobs } from '../db/schema/jobs.ts';
import { projectFiles, projectVersionFiles, projectVersions } from '../db/schema/project-files.ts';
import { projects } from '../db/schema/projects.ts';
import type { QueueService } from '../infra/queues.ts';
import { cancelChannel, jobChannel, projectChannel, type RedisEventBus } from '../infra/redis.ts';
import { assertTenantScopedKey } from '../infra/storage.ts';

export type ExportFormat = 'mp4' | 'mov' | 'webm' | 'gif';
const EXPORT_FORMATS: ReadonlySet<string> = new Set(['mp4', 'mov', 'webm', 'gif']);
const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_EXPORT_PRESIGN_TTL_SEC = 300;
const EXPORT_DEADLINE_MS = 30 * 60_000;

export interface ExportServiceDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly queues: Pick<QueueService, 'enqueueRenderExport' | 'renderExport'>;
  readonly eventBus: Pick<RedisEventBus, 'publish' | 'subscribe'>;
  readonly presignGetTtlSec?: number;
}

export interface StartExportOptions {
  expectedRevision?: string;
  expectedVersionId?: string;
  requestId?: string;
  idempotencyKey?: string;
  compositionPath?: string;
  outputName?: string;
  format?: ExportFormat;
  phase1?: boolean;
  settings?: Record<string, unknown>;
  expected?: ExportExpectation;
  workId?: string;
}

export interface ExportJobRecord {
  id: string;
  jobId: string;
  workspaceId: string;
  projectId: string | null;
  versionId: string | null;
  revision: string | null;
  state: JobState;
  stage: string | null;
  progress: number;
  requestId: string | null;
  idempotencyKey: string | null;
  outputName: string;
  format: ExportFormat;
  compositionPath: string;
  sizeBytes?: number;
  sha256?: string;
  mimeType?: string;
  s3Key?: string;
  logS3Key?: string;
  durationMs?: number;
  audioLoweredDb?: number;
  verification?: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  terminalAt: string | null;
  updatedAt: string;
}

export interface StartExportResult {
  job: ExportJobRecord;
  replayed: boolean;
  snapshotVersionId: string;
  includedStudioManifests: string[];
}

export interface ExportFileMetadata {
  jobId: string;
  projectId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  etag: string;
  s3Key: string;
}

export function mimeTypeForExportFormat(format: string): string {
  switch (format) {
    case 'mov':
      return 'video/quicktime';
    case 'webm':
      return 'video/webm';
    case 'gif':
      return 'image/gif';
    default:
      return 'video/mp4';
  }
}

export function sanitizeExportFilename(raw: string | undefined, projectTitle: string, format: ExportFormat): string {
  const baseSource = (raw?.trim() || projectTitle.trim() || 'export')
    .replace(/\.[^./\\]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  const stem = baseSource || 'export';
  return `${stem}.${format}`;
}

function isPgUniqueViolation(error: unknown): { isUnique: boolean; constraint?: string } {
  if (!error || typeof error !== 'object') return { isUnique: false };
  const err = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = err.code ?? err.cause?.code;
  if (code !== '23505') return { isUnique: false };
  return { isUnique: true, constraint: err.constraint ?? err.cause?.constraint };
}

function toExportJobRecord(row: typeof jobs.$inferSelect): ExportJobRecord {
  const input = (row.inputPayload ?? {}) as Record<string, unknown>;
  const result = (row.resultJson ?? {}) as Record<string, unknown>;
  const formatCandidate = typeof input.format === 'string' && EXPORT_FORMATS.has(input.format)
    ? (input.format as ExportFormat)
    : 'mp4';
  const outputName =
    (typeof result.outputName === 'string' && result.outputName) ||
    (typeof input.outputName === 'string' && input.outputName) ||
    `export.${formatCandidate}`;
  const compositionPath =
    (typeof input.compositionPath === 'string' && input.compositionPath) || 'index.html';
  const s3Key = typeof result.s3Key === 'string' ? result.s3Key : undefined;
  const logS3Key = typeof result.logS3Key === 'string' ? result.logS3Key : undefined;

  return {
    id: row.id,
    jobId: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId ?? null,
    versionId: row.versionId ?? null,
    revision: row.revision ?? null,
    state: row.state,
    stage: row.stage ?? null,
    progress: Number(row.progress ?? 0),
    requestId: row.requestId ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    outputName,
    format: formatCandidate,
    compositionPath,
    ...(typeof result.bytes === 'number' ? { sizeBytes: result.bytes } : {}),
    ...(typeof result.sha256 === 'string' ? { sha256: result.sha256 } : {}),
    ...(typeof result.mimeType === 'string' ? { mimeType: result.mimeType } : {}),
    ...(s3Key !== undefined ? { s3Key } : {}),
    ...(logS3Key !== undefined ? { logS3Key } : {}),
    ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
    ...(typeof result.audioLoweredDb === 'number' ? { audioLoweredDb: result.audioLoweredDb } : {}),
    ...(result.verification && typeof result.verification === 'object'
      ? { verification: result.verification as Record<string, unknown> }
      : {}),
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    terminalAt: row.terminalAt ? row.terminalAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ExportService {
  private readonly db: Database;
  private readonly storage: StoragePort;
  private readonly queues: Pick<QueueService, 'enqueueRenderExport' | 'renderExport'>;
  private readonly eventBus: Pick<RedisEventBus, 'publish' | 'subscribe'>;
  private readonly presignGetTtlSec: number;

  constructor(deps: ExportServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.queues = deps.queues;
    this.eventBus = deps.eventBus;
    this.presignGetTtlSec = deps.presignGetTtlSec ?? DEFAULT_EXPORT_PRESIGN_TTL_SEC;
  }

  /**
   * Atomically lock the project row, verify `expectedRevision`/`expectedVersionId`,
   * ensure an immutable frozen `project_versions` + `project_version_files` snapshot
   * (including `.hyperframes/studio-manual-edits.json` and `.hyperframes/studio-motion.json`),
   * insert a `jobs` row (enforcing single active `export_render` per project via partial unique index),
   * and enqueue `render-export` (`attempts: 1`).
   */
  async startExport(
    ctx: AuthContext,
    projectId: string,
    opts: StartExportOptions = {},
  ): Promise<StartExportResult> {
    if (!isUuid(projectId)) {
      throw new CloudError('PROJECT_NOT_FOUND', 'projectId must be a valid UUID', { status: 404 });
    }
    if (opts.expectedRevision !== undefined && !isSha256Hex(opts.expectedRevision)) {
      throw new CloudError('INVALID_ARGUMENT', 'expectedRevision must be a 64-character sha256 hex digest', {
        status: 400,
      });
    }
    if (opts.expectedVersionId !== undefined && !isUuid(opts.expectedVersionId)) {
      throw new CloudError('INVALID_ARGUMENT', 'expectedVersionId must be a valid UUID', { status: 400 });
    }
    if (opts.workId !== undefined && !isUuid(opts.workId)) {
      throw new CloudError('INVALID_ARGUMENT', 'workId must be a valid UUID', { status: 400 });
    }

    const format: ExportFormat = opts.format ?? 'mp4';
    if (!EXPORT_FORMATS.has(format)) {
      throw new CloudError('INVALID_ARGUMENT', `Unsupported export format: ${String(format)}`, { status: 400 });
    }

    let compositionPath = 'index.html';
    if (opts.compositionPath !== undefined && opts.compositionPath.trim() !== '') {
      try {
        compositionPath = projectPath(opts.compositionPath.trim());
      } catch (error) {
        throw new CloudError(
          'INVALID_PATH',
          error instanceof Error ? error.message : 'Invalid compositionPath',
          { status: 400 },
        );
      }
    }

    let validatedExpected: ExportExpectation | undefined;
    if (opts.expected !== undefined) {
      try {
        validatedExpected = validateExportExpectation(opts.expected);
      } catch (error) {
        throw new CloudError(
          'INVALID_ARGUMENT',
          error instanceof Error ? error.message : 'Invalid export expectation',
          { status: 400 },
        );
      }
    }

    const requestId = opts.requestId !== undefined ? validateStableRequestId(opts.requestId) : undefined;
    const idempotencyKey =
      opts.idempotencyKey !== undefined
        ? validateStableRequestId(opts.idempotencyKey)
        : requestId;

    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          projectId,
          expectedRevision: opts.expectedRevision ?? null,
          expectedVersionId: opts.expectedVersionId ?? null,
          compositionPath,
          format,
          phase1: opts.phase1 ?? true,
          settings: opts.settings ?? null,
          expected: validatedExpected ?? null,
        }),
      )
      .digest('hex');

    let txOutcome: {
      replayed: boolean;
      row: typeof jobs.$inferSelect;
      snapshotVersionId: string;
      includedStudioManifests: string[];
      outputName: string;
    };

    try {
      txOutcome = await this.db.transaction(async (tx) => {
        const lockedProjects = await tx
          .select()
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.workspaceId, ctx.workspaceId)))
          .for('update')
          .limit(1);

        if (lockedProjects.length === 0) {
          throw new CloudError('PROJECT_NOT_FOUND', 'Project not found in this workspace', { status: 404 });
        }
        const project = lockedProjects[0];
        if (project.trashed || project.trashedAt !== null) {
          throw new CloudError('PROJECT_TRASHED', 'Restore this project from trash before exporting', {
            status: 400,
          });
        }

        // Idempotent replay check before enforcing revision conflict or creating new snapshot.
        if (idempotencyKey) {
          const existingIdem = await tx
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.workspaceId, ctx.workspaceId),
                eq(jobs.kind, 'export_render'),
                eq(jobs.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (existingIdem.length > 0) {
            const existing = existingIdem[0];
            if (existing.requestHash && existing.requestHash !== requestHash) {
              throw new CloudError(
                'REQUEST_ID_CONFLICT',
                'Export requestId / idempotencyKey was already used with different export options',
                { status: 409, applied: false },
              );
            }
            const existingOutput =
              typeof existing.inputPayload?.outputName === 'string'
                ? existing.inputPayload.outputName
                : sanitizeExportFilename(opts.outputName, project.title, format);
            return {
              replayed: true,
              row: existing,
              snapshotVersionId: existing.versionId ?? project.currentVersionId ?? '',
              includedStudioManifests: [],
              outputName: existingOutput,
            };
          }
        }

        if (opts.expectedRevision && project.revision !== opts.expectedRevision) {
          throw revisionConflict({
            currentRevision: project.revision,
            currentVersionId: project.currentVersionId ?? undefined,
          });
        }
        if (opts.expectedVersionId && project.currentVersionId !== opts.expectedVersionId) {
          throw new CloudError(
            'VERSION_CONFLICT',
            'Project version changed; reload the latest versionId before exporting.',
            {
              status: 409,
              applied: false,
              details: {
                currentRevision: project.revision,
                currentVersionId: project.currentVersionId,
              },
            },
          );
        }

        // Load all live project files (explicitly including .hyperframes/studio-manual-edits.json and studio-motion.json).
        const liveFiles = await tx
          .select()
          .from(projectFiles)
          .where(and(eq(projectFiles.workspaceId, ctx.workspaceId), eq(projectFiles.projectId, projectId)));

        if (!liveFiles.some((file) => file.path === compositionPath)) {
          throw new CloudError(
            'INVALID_PATH',
            `Composition entry "${compositionPath}" does not exist in this project`,
            { status: 400 },
          );
        }

        const includedStudioManifests = liveFiles
          .map((file) => file.path)
          .filter((filePath) => STUDIO_MANIFESTS.includes(filePath));

        // Reuse current immutable version snapshot if it exactly matches live files (including studio manifests),
        // otherwise freeze a brand-new immutable version + project_version_files snapshot.
        let snapshotVersionId = project.currentVersionId;
        let needsNewSnapshot = !snapshotVersionId;

        if (snapshotVersionId) {
          const [verRows, verFileRows] = await Promise.all([
            tx
              .select({ id: projectVersions.id, revision: projectVersions.revision })
              .from(projectVersions)
              .where(
                and(
                  eq(projectVersions.id, snapshotVersionId),
                  eq(projectVersions.workspaceId, ctx.workspaceId),
                  eq(projectVersions.projectId, projectId),
                ),
              )
              .limit(1),
            tx
              .select({
                path: projectVersionFiles.path,
                sha256: projectVersionFiles.sha256,
                blobScope: projectVersionFiles.blobScope,
              })
              .from(projectVersionFiles)
              .where(eq(projectVersionFiles.versionId, snapshotVersionId)),
          ]);

          if (verRows.length === 0 || verRows[0].revision !== project.revision) {
            needsNewSnapshot = true;
          } else if (verFileRows.length !== liveFiles.length) {
            needsNewSnapshot = true;
          } else {
            const byPath = new Map(verFileRows.map((row) => [row.path, `${row.blobScope}:${row.sha256}`]));
            for (const file of liveFiles) {
              if (byPath.get(file.path) !== `${file.blobScope}:${file.sha256}`) {
                needsNewSnapshot = true;
                break;
              }
            }
          }
        }

        if (needsNewSnapshot || !snapshotVersionId) {
          const nextVersionNumber = project.currentVersionNumber + 1;
          const createdVersionId = randomUUID();
          const now = new Date();

          await tx.insert(projectVersions).values(
            asInsert(projectVersions, {
              id: createdVersionId,
              workspaceId: ctx.workspaceId,
              projectId,
              versionNumber: nextVersionNumber,
              revision: project.revision,
              source: 'studio',
              summary: 'Frozen export snapshot',
              createdAt: now,
            }),
          );

          if (liveFiles.length > 0) {
            await tx.insert(projectVersionFiles).values(
              liveFiles.map((file) =>
                asInsert(projectVersionFiles, {
                  versionId: createdVersionId,
                  workspaceId: ctx.workspaceId,
                  projectId,
                  path: file.path,
                  blobScope: file.blobScope,
                  sha256: file.sha256,
                  sizeBytes: Number(file.sizeBytes),
                  mimeType: file.mimeType,
                }),
              ),
            );

            // Increment CAS refcounts for workspace-scoped blobs referenced by the frozen snapshot.
            const workspaceDeltas = liveFiles
              .filter((file) => file.blobScope === 'workspace')
              .map((file) => ({
                sha256: file.sha256,
                delta: 1,
                sizeBytes: Number(file.sizeBytes),
                mimeType: file.mimeType,
              }));
            if (workspaceDeltas.length > 0) {
              await applyWorkspaceBlobRefDeltas(tx, ctx.workspaceId, workspaceDeltas);
            }
          }

          await tx
            .update(projects)
            .set(
              asUpdate(projects, {
                currentVersionId: createdVersionId,
                currentVersionNumber: nextVersionNumber,
                updatedAt: now,
              }),
            )
            .where(and(eq(projects.id, projectId), eq(projects.workspaceId, ctx.workspaceId)));

          snapshotVersionId = createdVersionId;
        }

        const outputName = sanitizeExportFilename(opts.outputName, project.title, format);
        const jobId = randomUUID();
        const now = new Date();
        const deadlineAt = new Date(now.getTime() + EXPORT_DEADLINE_MS);

        const inserted = await tx
          .insert(jobs)
          .values(
            asInsert(jobs, {
              id: jobId,
              workspaceId: ctx.workspaceId,
              projectId,
              kind: 'export_render',
              state: 'queued',
              stage: 'queued',
              progress: 0,
              versionId: snapshotVersionId,
              revision: project.revision,
              workId: opts.workId ?? null,
              requestId: requestId ?? null,
              idempotencyKey: idempotencyKey ?? null,
              requestHash,
              inputPayload: {
                compositionPath,
                outputName,
                format,
                phase1: opts.phase1 ?? true,
                ...(opts.settings ? { settings: opts.settings } : {}),
                ...(validatedExpected ? { expected: validatedExpected } : {}),
                studioManifests: includedStudioManifests,
              },
              deadlineAt,
              createdAt: now,
              updatedAt: now,
            }),
          )
          .returning();

        return {
          replayed: false,
          row: inserted[0],
          snapshotVersionId,
          includedStudioManifests,
          outputName,
        };
      });
    } catch (error) {
      const unique = isPgUniqueViolation(error);
      if (unique.isUnique) {
        if (unique.constraint === 'uq_jobs_active_export_per_project') {
          throw new CloudError(
            'EXPORT_BUSY',
            'An export render is already active for this project; wait for completion or cancel it first.',
            { status: 409, applied: false },
          );
        }
        if (unique.constraint === 'uq_jobs_workspace_idempotency' && idempotencyKey) {
          const existingRows = await this.db
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.workspaceId, ctx.workspaceId),
                eq(jobs.kind, 'export_render'),
                eq(jobs.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (existingRows.length > 0) {
            const existing = existingRows[0];
            if (existing.requestHash && existing.requestHash !== requestHash) {
              throw new CloudError(
                'REQUEST_ID_CONFLICT',
                'Export requestId / idempotencyKey was already used with different export options',
                { status: 409, applied: false },
              );
            }
            return {
              job: toExportJobRecord(existing),
              replayed: true,
              snapshotVersionId: existing.versionId ?? '',
              includedStudioManifests: [],
            };
          }
        }
      }
      throw error;
    }

    if (!txOutcome.replayed) {
      try {
        await this.queues.enqueueRenderExport(
          'export_render',
          {
            jobId: txOutcome.row.id,
            workspaceId: ctx.workspaceId,
            projectId,
            versionId: txOutcome.snapshotVersionId,
            revision: txOutcome.row.revision!,
            compositionPath,
            outputName: txOutcome.outputName,
            format,
            phase1: opts.phase1 ?? true,
            ...(opts.settings ? { settings: opts.settings } : {}),
            ...(validatedExpected ? { expected: validatedExpected } : {}),
          },
          { attempts: 1 },
        );
      } catch (error) {
        // Release the single-active-export lock if Redis enqueue fails so the project is not stuck.
        await this.db
          .update(jobs)
          .set(
            asUpdate(jobs, {
              state: 'failed',
              stage: 'failed',
              failureStage: 'enqueue',
              errorCode: 'QUEUE_ENQUEUE_FAILED',
              errorMessage: error instanceof Error ? error.message : 'Failed to enqueue render job',
              terminalAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          .where(and(eq(jobs.id, txOutcome.row.id), eq(jobs.workspaceId, ctx.workspaceId)));
        throw error;
      }

      const progressEvent: JobProgressEvent = {
        jobId: txOutcome.row.id,
        workspaceId: ctx.workspaceId,
        projectId,
        kind: 'export_render',
        state: 'queued',
        stage: 'queued',
        progress: 0,
        ts: Date.now(),
      };
      const projectEvent: ProjectEvent = {
        type: 'render-updated',
        workspaceId: ctx.workspaceId,
        projectId,
        jobId: txOutcome.row.id,
        state: 'queued',
        progress: 0,
        stage: 'queued',
        ts: Date.now(),
      };
      await Promise.allSettled([
        this.eventBus.publish(jobChannel(txOutcome.row.id), progressEvent),
        this.eventBus.publish(projectChannel(ctx.workspaceId, projectId), projectEvent),
      ]);
    }

    return {
      job: toExportJobRecord(txOutcome.row),
      replayed: txOutcome.replayed,
      snapshotVersionId: txOutcome.snapshotVersionId,
      includedStudioManifests: txOutcome.includedStudioManifests,
    };
  }

  /** Fetch a single export job scoped strictly to `ctx.workspaceId`. */
  async getExport(ctx: AuthContext, jobId: string): Promise<ExportJobRecord> {
    if (!isUuid(jobId)) {
      throw new CloudError('EXPORT_NOT_FOUND', 'Export job not found', { status: 404 });
    }
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.workspaceId, ctx.workspaceId),
          eq(jobs.kind, 'export_render'),
          isNull(jobs.deletedAt),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      throw new CloudError('EXPORT_NOT_FOUND', 'Export job not found', { status: 404 });
    }
    return toExportJobRecord(rows[0]);
  }

  /** List non-deleted export jobs for a project scoped strictly to `ctx.workspaceId`. */
  async listProjectExports(
    ctx: AuthContext,
    projectId: string,
    options: { limit?: number } = {},
  ): Promise<ExportJobRecord[]> {
    if (!isUuid(projectId)) {
      throw new CloudError('PROJECT_NOT_FOUND', 'Project not found', { status: 404 });
    }
    const limit = Math.max(1, Math.min(100, options.limit ?? 50));
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, ctx.workspaceId),
          eq(jobs.projectId, projectId),
          eq(jobs.kind, 'export_render'),
          isNull(jobs.deletedAt),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(limit);

    return rows.map(toExportJobRecord);
  }

  /**
   * Cancel a queued or running export:
   * - `queued`: transitions directly to `cancelled` in PG and removes queued BullMQ job if present.
   * - `running` / `cancelling`: sets `state = 'cancelling'` in PG and publishes `om:cancel:{jobId}`
   *   so `worker-render` aborts the subprocess tree cleanly.
   */
  async cancelExport(ctx: AuthContext, jobId: string): Promise<ExportJobRecord> {
    if (!isUuid(jobId)) {
      throw new CloudError('EXPORT_NOT_FOUND', 'Export job not found', { status: 404 });
    }

    const outcome = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.workspaceId, ctx.workspaceId),
            eq(jobs.kind, 'export_render'),
            isNull(jobs.deletedAt),
          ),
        )
        .for('update')
        .limit(1);

      if (existing.length === 0) {
        throw new CloudError('EXPORT_NOT_FOUND', 'Export job not found', { status: 404 });
      }
      const current = existing[0];
      if (TERMINAL_JOB_STATES.has(current.state)) {
        return { row: current, shouldPublishCancel: false, wasQueued: false };
      }

      const now = new Date();
      if (current.state === 'queued') {
        const updated = await tx
          .update(jobs)
          .set(
            asUpdate(jobs, {
              state: 'cancelled',
              stage: 'cancelled',
              terminalAt: now,
              updatedAt: now,
            }),
          )
          .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, ctx.workspaceId)))
          .returning();
        return { row: updated[0], shouldPublishCancel: true, wasQueued: true };
      }

      const updated = await tx
        .update(jobs)
        .set(
          asUpdate(jobs, {
            state: 'cancelling',
            stage: 'cancelling',
            updatedAt: now,
          }),
        )
        .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, ctx.workspaceId)))
        .returning();
      return { row: updated[0], shouldPublishCancel: true, wasQueued: false };
    });

    if (outcome.wasQueued) {
      await this.queues.renderExport
        .getJob(jobId)
        .then((queuedJob) => queuedJob?.remove())
        .catch(() => {});
    }

    if (outcome.shouldPublishCancel) {
      const cancelEvent: JobCancelEvent = {
        jobId,
        workspaceId: ctx.workspaceId,
        requestedAt: Date.now(),
      };
      const progressEvent: JobProgressEvent = {
        jobId,
        workspaceId: ctx.workspaceId,
        projectId: outcome.row.projectId,
        kind: 'export_render',
        state: outcome.row.state,
        stage: outcome.row.stage ?? outcome.row.state,
        progress: Number(outcome.row.progress ?? 0),
        ts: Date.now(),
      };
      const publications: Promise<unknown>[] = [
        this.eventBus.publish(cancelChannel(jobId), cancelEvent),
        this.eventBus.publish(jobChannel(jobId), progressEvent),
      ];
      if (outcome.row.projectId) {
        const projectEvent: ProjectEvent = {
          type: 'render-updated',
          workspaceId: ctx.workspaceId,
          projectId: outcome.row.projectId,
          jobId,
          state: outcome.row.state,
          progress: Number(outcome.row.progress ?? 0),
          stage: outcome.row.stage ?? outcome.row.state,
          ts: Date.now(),
        };
        publications.push(this.eventBus.publish(projectChannel(ctx.workspaceId, outcome.row.projectId), projectEvent));
      }
      await Promise.allSettled(publications);
    }

    return toExportJobRecord(outcome.row);
  }

  /** Soft-delete a terminal export job from the project render list. */
  async deleteExport(ctx: AuthContext, jobId: string): Promise<{ jobId: string; deleted: boolean }> {
    if (!isUuid(jobId)) {
      throw new CloudError('EXPORT_NOT_FOUND', 'Export job not found', { status: 404 });
    }
    const existing = await this.getExport(ctx, jobId);
    if (!TERMINAL_JOB_STATES.has(existing.state)) {
      throw new CloudError('EXPORT_BUSY', 'Cancel an active export before deleting it', { status: 409 });
    }
    await this.db
      .update(jobs)
      .set(asUpdate(jobs, { deletedAt: new Date(), updatedAt: new Date() }))
      .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, ctx.workspaceId)));
    return { jobId, deleted: true };
  }

  /**
   * Read completed export file metadata directly from PostgreSQL (used to answer `HEAD`
   * requests directly without issuing a GET-signed S3 redirect).
   */
  async getExportFileMetadata(ctx: AuthContext, jobId: string): Promise<ExportFileMetadata> {
    const job = await this.getExport(ctx, jobId);
    if (job.state !== 'completed' || !job.s3Key || !job.sizeBytes || !job.sha256) {
      throw new CloudError('EXPORT_NOT_FOUND', 'Export output artifact is not available yet', { status: 404 });
    }
    assertTenantScopedKey(ctx.workspaceId, job.s3Key);
    return {
      jobId: job.id,
      projectId: job.projectId,
      filename: job.outputName,
      mimeType: job.mimeType ?? mimeTypeForExportFormat(job.format),
      sizeBytes: job.sizeBytes,
      sha256: job.sha256,
      etag: `"sha256:${job.sha256}"`,
      s3Key: job.s3Key,
    };
  }

  /** Lookup a completed export artifact by `(projectId, filename)` scoped to `ctx.workspaceId`. */
  async getExportFileMetadataByName(
    ctx: AuthContext,
    projectId: string,
    filename: string,
  ): Promise<ExportFileMetadata> {
    if (!isUuid(projectId)) {
      throw new CloudError('PROJECT_NOT_FOUND', 'Project not found', { status: 404 });
    }
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, ctx.workspaceId),
          eq(jobs.projectId, projectId),
          eq(jobs.kind, 'export_render'),
          eq(jobs.state, 'completed'),
          isNull(jobs.deletedAt),
          sql`COALESCE(${jobs.resultJson}->>'outputName', ${jobs.inputPayload}->>'outputName') = ${filename}`,
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(1);

    if (rows.length === 0) {
      throw new CloudError('EXPORT_NOT_FOUND', 'Export file not found', { status: 404 });
    }
    return this.getExportFileMetadata(ctx, rows[0].id);
  }

  /** Mint a short-lived S3 Presigned GET URL for an export output (`attachment` or `inline`). */
  async presignExportFile(
    ctx: AuthContext,
    jobId: string,
    options: { disposition?: 'attachment' | 'inline'; expiresInSec?: number } = {},
  ): Promise<{ url: string; metadata: ExportFileMetadata; expiresInSec: number }> {
    const metadata = await this.getExportFileMetadata(ctx, jobId);
    const expiresInSec = options.expiresInSec ?? this.presignGetTtlSec;
    const mode = options.disposition ?? 'attachment';
    const cleanFilename = metadata.filename.replace(/["\\\r\n]/g, '_') || 'export.mp4';
    const url = await this.storage.presignGet(metadata.s3Key, {
      expiresInSec,
      responseContentType: metadata.mimeType,
      responseContentDisposition: `${mode}; filename="${cleanFilename}"`,
    });
    return { url, metadata, expiresInSec };
  }

  /** Subscribe to live job progress events on `om:job:{jobId}`. */
  async subscribeJobProgress(
    jobId: string,
    listener: (event: JobProgressEvent) => void,
  ): Promise<() => Promise<void>> {
    return this.eventBus.subscribe(jobChannel(jobId), (payload) => {
      if (payload && typeof payload === 'object') {
        listener(payload as JobProgressEvent);
      }
    });
  }
}
