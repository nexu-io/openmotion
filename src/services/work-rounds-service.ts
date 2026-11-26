import { and, desc, eq } from 'drizzle-orm';
import type { CloudTrackingHandle } from '../cloud-tracking.ts';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { Database } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import { workRounds, type WorkRoundMode, type WorkRoundState } from '../db/schema/projects.ts';
import { assertValidUuid, loadProjectOrThrow } from './project-files-service.ts';

export interface WorkRoundRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly mode: WorkRoundMode;
  readonly state: WorkRoundState;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly revision: string;
  readonly jobId: string | null;
  readonly previousJobId: string | null;
  readonly generation: Record<string, unknown> | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkRoundInput {
  readonly projectId: string;
  readonly title?: string;
  readonly mode: WorkRoundMode;
  readonly versionId?: string;
  readonly versionNumber?: number;
  readonly revision?: string;
  readonly jobId?: string | null;
  readonly previousJobId?: string | null;
  readonly generation?: Record<string, unknown> | null;
}

function toRecord(row: typeof workRounds.$inferSelect): WorkRoundRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    mode: row.mode,
    state: row.state,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    revision: row.revision.trim(),
    jobId: row.jobId ?? null,
    previousJobId: row.previousJobId ?? null,
    generation: row.generation ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class WorkRoundsService {
  private readonly db: Database;
  private readonly cloudTracking?: CloudTrackingHandle;

  constructor(db: Database, options?: { readonly cloudTracking?: CloudTrackingHandle }) {
    this.db = db;
    this.cloudTracking = options?.cloudTracking;
  }

  private emitStage(
    ctx: AuthContext,
    record: WorkRoundRecord,
    stage: 'started' | 'generated' | 'edited' | 'exported',
    exportRoute?: 'mcp' | 'studio',
  ): void {
    this.cloudTracking?.trackWorkGenerationStage({
      workId: record.id,
      projectId: record.projectId,
      stage,
      taskType: record.mode,
      versionId: record.versionId,
      revision: record.revision,
      ...(exportRoute ? { exportRoute } : {}),
      userId: ctx.appUserId ?? ctx.userId,
      entrypoint: 'mcp',
    });
  }

  /** Start a new authoring work round bound to a project's current version & revision. */
  async create(ctx: AuthContext, input: CreateWorkRoundInput): Promise<WorkRoundRecord> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, input.projectId, { allowTrashed: false, auth: ctx });
    const versionId = input.versionId ?? project.currentVersionId;
    if (!versionId) {
      throw new CloudError('INVALID_ARGUMENT', 'Project does not have a baseline version yet.', {
        status: 400,
        applied: false,
      });
    }
    assertValidUuid(versionId, 'versionId');
    if (input.jobId) assertValidUuid(input.jobId, 'jobId');
    if (input.previousJobId) assertValidUuid(input.previousJobId, 'previousJobId');

    const title = (input.title?.trim() || project.title).slice(0, 100);
    const now = new Date();

    const [inserted] = await this.db
      .insert(workRounds)
      .values(
        asInsert(workRounds, {
          workspaceId: ctx.workspaceId,
          projectId: project.id,
          title,
          mode: input.mode,
          state: 'authoring',
          versionId,
          versionNumber: input.versionNumber ?? project.currentVersionNumber,
          revision: (input.revision ?? project.revision).trim(),
          jobId: input.jobId ?? null,
          previousJobId: input.previousJobId ?? null,
          generation: input.generation ?? null,
          error: null,
          createdAt: now,
          updatedAt: now,
        }),
      )
      .returning();

    const record = toRecord(inserted);
    this.emitStage(ctx, record, 'started');
    return record;
  }

  /** Read a single work round scoped by workspace + project. */
  async get(ctx: AuthContext, projectId: string, workId: string): Promise<WorkRoundRecord | null> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(projectId, 'projectId');
    assertValidUuid(workId, 'workId');

    const rows = await this.db
      .select()
      .from(workRounds)
      .where(
        and(
          eq(workRounds.workspaceId, ctx.workspaceId),
          eq(workRounds.projectId, projectId),
          eq(workRounds.id, workId),
        ),
      );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** List work rounds for a project newest first. */
  async list(ctx: AuthContext, projectId: string, limit = 50): Promise<WorkRoundRecord[]> {
    await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: true, auth: ctx });
    const clamped = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = await this.db
      .select()
      .from(workRounds)
      .where(and(eq(workRounds.workspaceId, ctx.workspaceId), eq(workRounds.projectId, projectId)))
      .orderBy(desc(workRounds.createdAt))
      .limit(clamped);
    return rows.map(toRecord);
  }

  /** Find the latest saved/generated work round for telemetry or Studio export attribution. */
  async latestGenerated(ctx: AuthContext, projectId: string): Promise<WorkRoundRecord | null> {
    await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: true, auth: ctx });
    const rows = await this.db
      .select()
      .from(workRounds)
      .where(
        and(
          eq(workRounds.workspaceId, ctx.workspaceId),
          eq(workRounds.projectId, projectId),
          eq(workRounds.state, 'saved'),
        ),
      )
      .orderBy(desc(workRounds.createdAt))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Mark a work round as saved with its produced version, revision, and optional generation metadata. */
  async markSaved(
    ctx: AuthContext,
    projectId: string,
    workId: string,
    update: {
      versionId?: string;
      versionNumber?: number;
      revision?: string;
      jobId?: string | null;
      generation?: Record<string, unknown> | null;
    } = {},
  ): Promise<WorkRoundRecord> {
    const record = await this.updateRound(ctx, projectId, workId, {
      state: 'saved',
      error: null,
      ...update,
    });
    this.emitStage(ctx, record, 'generated');
    return record;
  }

  /** Mark a work round as failed with a human-readable error message. */
  async markFailed(
    ctx: AuthContext,
    projectId: string,
    workId: string,
    error: string,
  ): Promise<WorkRoundRecord> {
    return this.updateRound(ctx, projectId, workId, {
      state: 'failed',
      error: error.slice(0, 4000),
    });
  }

  /** Record an export event against a work round. */
  async markExported(
    ctx: AuthContext,
    projectId: string,
    workId: string,
    details: { jobId?: string; source?: 'studio' | 'mcp' | 'api' } = {},
  ): Promise<WorkRoundRecord> {
    const existing = await this.get(ctx, projectId, workId);
    if (!existing) {
      throw new CloudError('NOT_FOUND', `Work round ${workId} not found.`, { status: 404, applied: false });
    }
    const generation = {
      ...(existing.generation ?? {}),
      exportedAt: new Date().toISOString(),
      exportSource: details.source ?? 'studio',
      ...(details.jobId ? { exportJobId: details.jobId } : {}),
    };
    const record = await this.updateRound(ctx, projectId, workId, {
      ...(details.jobId ? { jobId: details.jobId, previousJobId: existing.jobId } : {}),
      generation,
    });
    this.emitStage(ctx, record, 'exported', details.source === 'mcp' ? 'mcp' : 'studio');
    return record;
  }

  /** Record that the user edited this work round inside Studio. */
  async markStudioEdited(ctx: AuthContext, projectId: string, workId: string): Promise<WorkRoundRecord> {
    const existing = await this.get(ctx, projectId, workId);
    if (!existing) {
      throw new CloudError('NOT_FOUND', `Work round ${workId} not found.`, { status: 404, applied: false });
    }
    const generation = {
      ...(existing.generation ?? {}),
      studioEditedAt: new Date().toISOString(),
    };
    const record = await this.updateRound(ctx, projectId, workId, { generation });
    this.emitStage(ctx, record, 'edited');
    return record;
  }

  private async updateRound(
    ctx: AuthContext,
    projectId: string,
    workId: string,
    patch: {
      state?: WorkRoundState;
      versionId?: string;
      versionNumber?: number;
      revision?: string;
      jobId?: string | null;
      previousJobId?: string | null;
      generation?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): Promise<WorkRoundRecord> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(projectId, 'projectId');
    assertValidUuid(workId, 'workId');
    if (patch.versionId) assertValidUuid(patch.versionId, 'versionId');
    if (patch.jobId) assertValidUuid(patch.jobId, 'jobId');
    if (patch.previousJobId) assertValidUuid(patch.previousJobId, 'previousJobId');

    const rows = await this.db
      .update(workRounds)
      .set(
        asUpdate(workRounds, {
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.versionId !== undefined ? { versionId: patch.versionId } : {}),
          ...(patch.versionNumber !== undefined ? { versionNumber: patch.versionNumber } : {}),
          ...(patch.revision !== undefined ? { revision: patch.revision.trim() } : {}),
          ...(patch.jobId !== undefined ? { jobId: patch.jobId } : {}),
          ...(patch.previousJobId !== undefined ? { previousJobId: patch.previousJobId } : {}),
          ...(patch.generation !== undefined ? { generation: patch.generation } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          updatedAt: new Date(),
        }),
      )
      .where(
        and(
          eq(workRounds.workspaceId, ctx.workspaceId),
          eq(workRounds.projectId, projectId),
          eq(workRounds.id, workId),
        ),
      )
      .returning();

    if (!rows[0]) {
      throw new CloudError('NOT_FOUND', `Work round ${workId} not found.`, { status: 404, applied: false });
    }
    return toRecord(rows[0]);
  }
}
