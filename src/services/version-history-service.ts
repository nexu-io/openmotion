import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { ProjectEvent } from '../contracts/events.ts';
import type { BlobScope, StoragePort } from '../contracts/storage.ts';
import { applyWorkspaceBlobRefDeltas, type BlobRefDelta } from '../db/cas.ts';
import type { Database } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import { idempotencyReceipts } from '../db/schema/jobs.ts';
import {
  projectFiles,
  projectHistoryEntries,
  projectVersionFiles,
  projectVersions,
  type HistoryActorKind,
  type ProjectVersionSource,
} from '../db/schema/project-files.ts';
import { projects } from '../db/schema/projects.ts';
import { projectChannel } from '../infra/redis.ts';
import { workspaceBlobKey } from '../infra/storage.ts';
import { computeProjectRevision, isSha256Hex, isTextProjectPath, isUuid } from '../../shared/project-validation.ts';
import { computePreviewImpact, createWriteToken, formatVersionFromSha256 } from '../studio/etag.ts';
import {
  DEFAULT_HISTORY_COALESCE_WINDOW_MS,
  assertValidUuid,
  canonicalInputHash,
  loadProjectOrThrow,
  normalizeSafeProjectPath,
  resolveBlobStorageKey,
  type EventBusPort,
  type HotTextCachePort,
} from './project-files-service.ts';

export interface VersionHistoryServiceDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly hotTextCache?: HotTextCachePort;
  readonly eventBus?: EventBusPort;
  /** Coalesce window (ms) shared with ProjectFilesService for interactive Studio edits. Defaults to 4000ms. */
  readonly historyCoalesceWindowMs?: number;
}

export interface ProjectVersionSummary {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly revision: string;
  readonly source: ProjectVersionSource;
  readonly summary: string;
  readonly requestId: string | null;
  readonly restoredFromVersionId: string | null;
  readonly pinned: boolean;
  readonly current: boolean;
  readonly createdAt: string;
}

export interface HistoryFileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
}

export interface StudioHistoryWho {
  readonly kind: 'person' | 'agent' | 'outside';
  readonly name: string;
}

export interface HistoryListItem {
  readonly id: string;
  readonly seq: number;
  readonly point: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly revision: string;
  readonly label: string;
  readonly summary: string;
  readonly who: StudioHistoryWho;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly pinned: boolean;
  readonly undone: boolean;
  readonly windowId: string | null;
  readonly files: HistoryFileChange[];
}

export interface HistoryStepTarget {
  readonly id: string;
  readonly seq: number;
  readonly point: string;
  readonly label: string;
  readonly paths: string[];
  readonly endedAt: number;
  readonly versionId: string;
}

export interface HistoryListResult {
  readonly projectId: string;
  readonly revision: string;
  readonly currentVersionId: string | null;
  readonly currentSeq: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly back: HistoryStepTarget | null;
  readonly forward: HistoryStepTarget | null;
  readonly entries: HistoryListItem[];
}

export interface HistoryMutationResult {
  readonly ok: true;
  readonly projectId: string;
  readonly revision: string;
  readonly versionId: string | null;
  readonly versionNumber: number;
  readonly seq: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly appliedFiles: string[];
  readonly writeToken: string;
  readonly entry?: HistoryListItem | null;
  readonly replayed?: boolean;
}

export interface RestoreVersionInput {
  readonly targetVersionId?: string;
  readonly point?: string;
  readonly seq?: number;
  readonly expectedRevision?: string;
  readonly expectedVersionId?: string;
  readonly requestId?: string;
  readonly label?: string;
  readonly actorKind?: HistoryActorKind;
  readonly actorName?: string;
  readonly writeToken?: string | null;
}

function toStudioWho(actorKind: HistoryActorKind, actorName: string): StudioHistoryWho {
  const kind: StudioHistoryWho['kind'] =
    actorKind === 'user' ? 'person' : actorKind === 'agent' ? 'agent' : 'outside';
  return { kind, name: actorName };
}

function mapActor(ctx: AuthContext, actorKind?: HistoryActorKind, actorName?: string): {
  actorKind: HistoryActorKind;
  actorName: string;
} {
  const kind: HistoryActorKind =
    actorKind ?? (ctx.authMethod === 'session_cookie' || ctx.authMethod === 'dev_bypass' ? 'user' : 'agent');
  const name = (actorName?.trim() || ctx.displayName?.trim() || ctx.email?.trim() || kind).slice(0, 128);
  return { actorKind: kind, actorName: name };
}

function diffSnapshots(
  previous: ReadonlyMap<string, string> | null,
  current: ReadonlyMap<string, string>,
): HistoryFileChange[] {
  const changes: HistoryFileChange[] = [];
  if (!previous) {
    for (const filePath of [...current.keys()].sort((a, b) => a.localeCompare(b))) {
      changes.push({ path: filePath, status: 'added' });
    }
    return changes;
  }

  const allPaths = new Set<string>([...previous.keys(), ...current.keys()]);
  for (const filePath of [...allPaths].sort((a, b) => a.localeCompare(b))) {
    const prevSha = previous.get(filePath);
    const currSha = current.get(filePath);
    if (prevSha === undefined && currSha !== undefined) {
      changes.push({ path: filePath, status: 'added' });
    } else if (prevSha !== undefined && currSha === undefined) {
      changes.push({ path: filePath, status: 'deleted' });
    } else if (prevSha !== currSha) {
      changes.push({ path: filePath, status: 'modified' });
    }
  }
  return changes;
}

export class VersionHistoryService {
  private readonly db: Database;
  private readonly storage: StoragePort;
  private readonly hotTextCache?: HotTextCachePort;
  private readonly eventBus?: EventBusPort;
  readonly historyCoalesceWindowMs: number;

  constructor(deps: VersionHistoryServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.hotTextCache = deps.hotTextCache;
    this.eventBus = deps.eventBus;
    this.historyCoalesceWindowMs = Math.max(
      0,
      Math.floor(deps.historyCoalesceWindowMs ?? DEFAULT_HISTORY_COALESCE_WINDOW_MS),
    );
  }

  /** Paginated MCP version list (`versionNumber DESC`). */
  async listVersions(
    ctx: AuthContext,
    projectId: string,
    options: { limit?: number; cursorVersionNumber?: number } = {},
  ): Promise<{
    projectId: string;
    revision: string;
    currentVersionId: string | null;
    currentVersionNumber: number;
    versions: ProjectVersionSummary[];
    nextCursor: number | null;
  }> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: true });
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));

    const whereClause =
      options.cursorVersionNumber !== undefined
        ? and(
            eq(projectVersions.workspaceId, ctx.workspaceId),
            eq(projectVersions.projectId, project.id),
            lt(projectVersions.versionNumber, options.cursorVersionNumber),
          )
        : and(eq(projectVersions.workspaceId, ctx.workspaceId), eq(projectVersions.projectId, project.id));

    const rows = await this.db
      .select()
      .from(projectVersions)
      .where(whereClause)
      .orderBy(desc(projectVersions.versionNumber))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const versions: ProjectVersionSummary[] = page.map((row) => ({
      versionId: row.id,
      versionNumber: row.versionNumber,
      revision: row.revision.trim(),
      source: row.source,
      summary: row.summary,
      requestId: row.requestId ?? null,
      restoredFromVersionId: row.restoredFromVersionId ?? null,
      pinned: row.pinned,
      current: project.currentVersionId === row.id,
      createdAt: row.createdAt.toISOString(),
    }));

    return {
      projectId: project.id,
      revision: project.revision.trim(),
      currentVersionId: project.currentVersionId ?? null,
      currentVersionNumber: project.currentVersionNumber,
      versions,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].versionNumber : null,
    };
  }

  /** Unified PG history ledger for Studio History UI (`GET /api/projects/:id/history`). */
  async listHistory(ctx: AuthContext, projectId: string): Promise<HistoryListResult> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: true });

    const entryRows = await this.db
      .select()
      .from(projectHistoryEntries)
      .where(
        and(
          eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
          eq(projectHistoryEntries.projectId, project.id),
        ),
      )
      .orderBy(asc(projectHistoryEntries.seq));

    const versionIds = [...new Set(entryRows.map((e) => e.versionId))];
    const versionMap = new Map<string, typeof projectVersions.$inferSelect>();
    if (versionIds.length > 0) {
      const versionRows = await this.db
        .select()
        .from(projectVersions)
        .where(and(eq(projectVersions.workspaceId, ctx.workspaceId), inArray(projectVersions.id, versionIds)));
      for (const v of versionRows) {
        versionMap.set(v.id, v);
      }
    }

    const filesByVersion = new Map<string, Map<string, string>>();
    if (versionIds.length > 0) {
      const vfRows = await this.db
        .select({
          versionId: projectVersionFiles.versionId,
          path: projectVersionFiles.path,
          sha256: projectVersionFiles.sha256,
        })
        .from(projectVersionFiles)
        .where(
          and(
            eq(projectVersionFiles.workspaceId, ctx.workspaceId),
            inArray(projectVersionFiles.versionId, versionIds),
          ),
        );
      for (const row of vfRows) {
        let bucket = filesByVersion.get(row.versionId);
        if (!bucket) {
          bucket = new Map();
          filesByVersion.set(row.versionId, bucket);
        }
        bucket.set(row.path, row.sha256.trim());
      }
    }

    const entryById = new Map(entryRows.map((row) => [row.id, row]));
    const items: HistoryListItem[] = entryRows.map((row, idx) => {
      const ver = versionMap.get(row.versionId);
      const currSnapshot = filesByVersion.get(row.versionId) ?? new Map<string, string>();
      const parentEntry = row.parentEntryId ? entryById.get(row.parentEntryId) : idx > 0 ? entryRows[idx - 1] : undefined;
      const prevSnapshot = parentEntry ? (filesByVersion.get(parentEntry.versionId) ?? null) : null;
      const files = diffSnapshots(prevSnapshot, currSnapshot);

      return {
        id: row.id,
        seq: row.seq,
        point: row.versionId,
        versionId: row.versionId,
        versionNumber: ver?.versionNumber ?? row.seq,
        revision: ver?.revision.trim() ?? '',
        label: row.label,
        summary: ver?.summary ?? row.label,
        who: toStudioWho(row.actorKind, row.actorName),
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt.toISOString(),
        pinned: row.pinned,
        undone: row.undone,
        windowId: row.windowId ?? null,
        files,
      };
    });

    const activeItems = items.filter((item) => !item.undone && item.seq <= project.currentHistorySeq);
    const undoneItems = items.filter((item) => item.undone && item.seq > project.currentHistorySeq);

    const canUndo = activeItems.length > 1;
    const canRedo = undoneItems.length > 0;
    const backItem = canUndo ? activeItems[activeItems.length - 1] : null;
    const forwardItem = canRedo ? undoneItems[0] : null;

    return {
      projectId: project.id,
      revision: project.revision.trim(),
      currentVersionId: project.currentVersionId ?? null,
      currentSeq: project.currentHistorySeq,
      canUndo,
      canRedo,
      back: backItem
        ? {
            id: backItem.id,
            seq: backItem.seq,
            point: backItem.point,
            paths: backItem.files.map((file) => file.path),
            endedAt: Date.parse(backItem.endedAt),
            label: backItem.label,
            versionId: backItem.versionId,
          }
        : null,
      forward: forwardItem
        ? {
            id: forwardItem.id,
            seq: forwardItem.seq,
            point: forwardItem.point,
            paths: forwardItem.files.map((file) => file.path),
            endedAt: Date.parse(forwardItem.endedAt),
            label: forwardItem.label,
            versionId: forwardItem.versionId,
          }
        : null,
      entries: [...items].reverse(),
    };
  }

  /**
   * Claim or label the latest Studio edit entry (`POST /api/projects/:id/history/claim`).
   * Coalesces with the current active entry when `windowId` matches or updates its human label.
   */
  async claimEdit(
    ctx: AuthContext,
    projectId: string,
    input: { label?: string; windowId?: string | null; actorKind?: HistoryActorKind; actorName?: string } = {},
  ): Promise<{
    claimed: { id: string; seq: number; label: string } | null;
    seq: number;
    canUndo: boolean;
    canRedo: boolean;
  }> {
    const label = input.label?.trim().slice(0, 256);
    const windowId = input.windowId && isUuid(input.windowId) ? input.windowId : null;
    const actor = mapActor(ctx, input.actorKind, input.actorName);

    const claimed = await this.db.transaction(async (tx) => {
      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: false,
        forUpdate: true,
      });

      const currentRows = await tx
        .select()
        .from(projectHistoryEntries)
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
            eq(projectHistoryEntries.projectId, project.id),
            eq(projectHistoryEntries.seq, project.currentHistorySeq),
          ),
        );
      const current = currentRows[0];
      if (!current) return null;

      const now = new Date();
      const nextLabel = label || current.label;
      await tx
        .update(projectHistoryEntries)
        .set(
          asUpdate(projectHistoryEntries, {
            label: nextLabel,
            actorKind: actor.actorKind,
            actorName: actor.actorName,
            ...(windowId ? { windowId } : {}),
            endedAt: now,
          }),
        )
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
            eq(projectHistoryEntries.id, current.id),
          ),
        );

      if (label && current.versionId) {
        await tx
          .update(projectVersions)
          .set(asUpdate(projectVersions, { summary: nextLabel }))
          .where(
            and(
              eq(projectVersions.workspaceId, ctx.workspaceId),
              eq(projectVersions.projectId, project.id),
              eq(projectVersions.id, current.versionId),
            ),
          );
      }

      return { id: current.id, seq: current.seq, label: nextLabel };
    });

    const summary = await this.listHistory(ctx, projectId);
    return {
      claimed,
      seq: summary.currentSeq,
      canUndo: summary.canUndo,
      canRedo: summary.canRedo,
    };
  }

  /** Create an explicit named checkpoint snapshot of the current project working tree. */
  async checkpoint(
    ctx: AuthContext,
    projectId: string,
    input: { label?: string; actorKind?: HistoryActorKind; actorName?: string; pinned?: boolean; writeToken?: string | null } = {},
  ): Promise<HistoryMutationResult> {
    const writeToken = createWriteToken(input.writeToken);
    const actor = mapActor(ctx, input.actorKind, input.actorName);
    const label = (input.label?.trim() || 'Checkpoint').slice(0, 256);

    const txResult = await this.db.transaction(async (tx) => {
      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: false,
        forUpdate: true,
      });

      const liveFiles = await tx
        .select()
        .from(projectFiles)
        .where(and(eq(projectFiles.workspaceId, ctx.workspaceId), eq(projectFiles.projectId, project.id)));

      const deltas: BlobRefDelta[] = liveFiles
        .filter((f) => f.blobScope === 'workspace')
        .map((f) => ({
          sha256: f.sha256.trim(),
          delta: 1,
          sizeBytes: Number(f.sizeBytes),
          mimeType: f.mimeType,
          s3Key: workspaceBlobKey(ctx.workspaceId, f.sha256.trim()),
        }));
      if (deltas.length > 0) {
        await applyWorkspaceBlobRefDeltas(tx, ctx.workspaceId, deltas);
      }

      const maxSeqRow = await tx
        .select({ maxSeq: sql<number>`COALESCE(MAX(${projectHistoryEntries.seq}), 0)` })
        .from(projectHistoryEntries)
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
            eq(projectHistoryEntries.projectId, project.id),
          ),
        );
      const maxVerRow = await tx
        .select({ maxVer: sql<number>`COALESCE(MAX(${projectVersions.versionNumber}), 0)` })
        .from(projectVersions)
        .where(
          and(
            eq(projectVersions.workspaceId, ctx.workspaceId),
            eq(projectVersions.projectId, project.id),
          ),
        );
      const nextSeq = Math.max(project.currentHistorySeq, Number(maxSeqRow[0]?.maxSeq ?? 0)) + 1;
      const nextVersionNumber = Math.max(project.currentVersionNumber, Number(maxVerRow[0]?.maxVer ?? 0)) + 1;
      const now = new Date();

      const parentRows =
        project.currentHistorySeq > 0
          ? await tx
              .select({ id: projectHistoryEntries.id })
              .from(projectHistoryEntries)
              .where(
                and(
                  eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
                  eq(projectHistoryEntries.projectId, project.id),
                  eq(projectHistoryEntries.seq, project.currentHistorySeq),
                ),
              )
          : [];

      const revision = computeProjectRevision(
        liveFiles.map((f) => ({ path: f.path, size: Number(f.sizeBytes), hash: f.sha256.trim() })),
      );

      const [createdVersion] = await tx
        .insert(projectVersions)
        .values(
          asInsert(projectVersions, {
            workspaceId: ctx.workspaceId,
            projectId: project.id,
            versionNumber: nextVersionNumber,
            revision,
            source: 'studio',
            summary: label,
            pinned: Boolean(input.pinned),
            createdAt: now,
          }),
        )
        .returning({ id: projectVersions.id });

      if (liveFiles.length > 0) {
        await tx.insert(projectVersionFiles).values(
          liveFiles.map((f) =>
            asInsert(projectVersionFiles, {
              versionId: createdVersion.id,
              workspaceId: ctx.workspaceId,
              projectId: project.id,
              path: f.path,
              blobScope: f.blobScope,
              sha256: f.sha256.trim(),
              sizeBytes: Number(f.sizeBytes),
              mimeType: f.mimeType,
            }),
          ),
        );
      }

      await tx
        .delete(projectHistoryEntries)
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
            eq(projectHistoryEntries.projectId, project.id),
            eq(projectHistoryEntries.undone, true),
            gt(projectHistoryEntries.seq, project.currentHistorySeq),
          ),
        );

      await tx.insert(projectHistoryEntries).values(
        asInsert(projectHistoryEntries, {
          workspaceId: ctx.workspaceId,
          projectId: project.id,
          seq: nextSeq,
          versionId: createdVersion.id,
          parentEntryId: parentRows[0]?.id ?? null,
          actorKind: actor.actorKind,
          actorName: actor.actorName,
          label,
          pinned: Boolean(input.pinned),
          undone: false,
          startedAt: now,
          endedAt: now,
        }),
      );

      await tx
        .update(projects)
        .set(
          asUpdate(projects, {
            revision,
            currentVersionId: createdVersion.id,
            currentVersionNumber: nextVersionNumber,
            currentHistorySeq: nextSeq,
            updatedAt: now,
          }),
        )
        .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));

      return {
        revision,
        versionId: createdVersion.id,
        versionNumber: nextVersionNumber,
        seq: nextSeq,
      };
    });

    await this.publishHistoryChanged(ctx.workspaceId, projectId, txResult.revision, txResult.versionId, txResult.seq);
    const list = await this.listHistory(ctx, projectId);
    return {
      ok: true,
      projectId,
      revision: txResult.revision,
      versionId: txResult.versionId,
      versionNumber: txResult.versionNumber,
      seq: txResult.seq,
      canUndo: list.canUndo,
      canRedo: list.canRedo,
      appliedFiles: [],
      writeToken,
      entry: list.entries.find((e) => e.seq === txResult.seq) ?? null,
    };
  }

  /** Step one position `'back'` (undo) or `'forward'` (redo) along the PG history timeline. */
  async step(
    ctx: AuthContext,
    projectId: string,
    direction: 'back' | 'forward',
    options: { writeToken?: string | null } = {},
  ): Promise<HistoryMutationResult> {
    const writeToken = createWriteToken(options.writeToken);

    const txResult = await this.db.transaction(async (tx) => {
      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: false,
        forUpdate: true,
      });

      const entries = await tx
        .select()
        .from(projectHistoryEntries)
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
            eq(projectHistoryEntries.projectId, project.id),
          ),
        )
        .orderBy(asc(projectHistoryEntries.seq));

      let targetEntry: typeof projectHistoryEntries.$inferSelect | undefined;
      if (direction === 'back') {
        const active = entries.filter((e) => !e.undone && e.seq <= project.currentHistorySeq);
        if (active.length <= 1) {
          throw new CloudError('INVALID_ARGUMENT', 'Nothing to undo.', { status: 400, applied: false });
        }
        const currentEntry = active[active.length - 1];
        targetEntry = active[active.length - 2];

        await tx
          .update(projectHistoryEntries)
          .set(asUpdate(projectHistoryEntries, { undone: true }))
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.id, currentEntry.id),
            ),
          );
      } else {
        const undone = entries.filter((e) => e.undone && e.seq > project.currentHistorySeq);
        if (undone.length === 0) {
          throw new CloudError('INVALID_ARGUMENT', 'Nothing to redo.', { status: 400, applied: false });
        }
        targetEntry = undone[0];

        await tx
          .update(projectHistoryEntries)
          .set(asUpdate(projectHistoryEntries, { undone: false }))
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.id, targetEntry.id),
            ),
          );
      }

      const [targetVersion] = await tx
        .select()
        .from(projectVersions)
        .where(
          and(
            eq(projectVersions.workspaceId, ctx.workspaceId),
            eq(projectVersions.id, targetEntry.versionId),
          ),
        );
      if (!targetVersion) {
        throw new CloudError('NOT_FOUND', `History target version ${targetEntry.versionId} not found.`, {
          status: 404,
          applied: false,
        });
      }

      const { appliedFiles, revision } = await this.applySnapshotToLiveFiles(
        tx,
        ctx.workspaceId,
        project.id,
        targetVersion.id,
      );

      await tx
        .update(projects)
        .set(
          asUpdate(projects, {
            revision,
            currentVersionId: targetVersion.id,
            currentVersionNumber: targetVersion.versionNumber,
            currentHistorySeq: targetEntry.seq,
            updatedAt: new Date(),
          }),
        )
        .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));

      return {
        revision,
        versionId: targetVersion.id,
        versionNumber: targetVersion.versionNumber,
        seq: targetEntry.seq,
        appliedFiles,
      };
    });

    await this.publishProjectAndHistory(
      ctx.workspaceId,
      projectId,
      txResult.revision,
      txResult.versionId,
      txResult.seq,
      txResult.appliedFiles,
      writeToken,
    );

    const list = await this.listHistory(ctx, projectId);
    return {
      ok: true,
      projectId,
      revision: txResult.revision,
      versionId: txResult.versionId,
      versionNumber: txResult.versionNumber,
      seq: txResult.seq,
      canUndo: list.canUndo,
      canRedo: list.canRedo,
      appliedFiles: txResult.appliedFiles,
      writeToken,
      entry: list.entries.find((e) => e.seq === txResult.seq) ?? null,
    };
  }

  /** Undo a specific history entry (marks it and any newer active entries undone, restoring its parent version). */
  async undoEntry(
    ctx: AuthContext,
    projectId: string,
    entryId: string,
    options: { writeToken?: string | null } = {},
  ): Promise<HistoryMutationResult> {
    assertValidUuid(entryId, 'entryId');
    const writeToken = createWriteToken(options.writeToken);

    const txResult = await this.db.transaction(async (tx) => {
      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: false,
        forUpdate: true,
      });

      const entries = await tx
        .select()
        .from(projectHistoryEntries)
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
            eq(projectHistoryEntries.projectId, project.id),
          ),
        )
        .orderBy(asc(projectHistoryEntries.seq));

      const targetIndex = entries.findIndex((e) => e.id === entryId);
      if (targetIndex < 0) {
        throw new CloudError('NOT_FOUND', `History entry ${entryId} not found.`, {
          status: 404,
          applied: false,
        });
      }
      const target = entries[targetIndex];
      const priorActive = entries.filter((e) => !e.undone && e.seq < target.seq);
      const restoreEntry = priorActive[priorActive.length - 1];
      if (!restoreEntry) {
        throw new CloudError('INVALID_ARGUMENT', 'Cannot undo the initial baseline entry.', {
          status: 400,
          applied: false,
        });
      }

      const toUndoIds = entries.filter((e) => !e.undone && e.seq >= target.seq).map((e) => e.id);
      if (toUndoIds.length > 0) {
        await tx
          .update(projectHistoryEntries)
          .set(asUpdate(projectHistoryEntries, { undone: true }))
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              inArray(projectHistoryEntries.id, toUndoIds),
            ),
          );
      }

      const [restoreVersion] = await tx
        .select()
        .from(projectVersions)
        .where(
          and(
            eq(projectVersions.workspaceId, ctx.workspaceId),
            eq(projectVersions.id, restoreEntry.versionId),
          ),
        );
      if (!restoreVersion) {
        throw new CloudError('NOT_FOUND', 'Restore target version not found.', { status: 404, applied: false });
      }

      const { appliedFiles, revision } = await this.applySnapshotToLiveFiles(
        tx,
        ctx.workspaceId,
        project.id,
        restoreVersion.id,
      );

      await tx
        .update(projects)
        .set(
          asUpdate(projects, {
            revision,
            currentVersionId: restoreVersion.id,
            currentVersionNumber: restoreVersion.versionNumber,
            currentHistorySeq: restoreEntry.seq,
            updatedAt: new Date(),
          }),
        )
        .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));

      return {
        revision,
        versionId: restoreVersion.id,
        versionNumber: restoreVersion.versionNumber,
        seq: restoreEntry.seq,
        appliedFiles,
      };
    });

    await this.publishProjectAndHistory(
      ctx.workspaceId,
      projectId,
      txResult.revision,
      txResult.versionId,
      txResult.seq,
      txResult.appliedFiles,
      writeToken,
    );

    const list = await this.listHistory(ctx, projectId);
    return {
      ok: true,
      projectId,
      revision: txResult.revision,
      versionId: txResult.versionId,
      versionNumber: txResult.versionNumber,
      seq: txResult.seq,
      canUndo: list.canUndo,
      canRedo: list.canRedo,
      appliedFiles: txResult.appliedFiles,
      writeToken,
      entry: list.entries.find((e) => e.seq === txResult.seq) ?? null,
    };
  }

  /**
   * Non-destructive restore of a historical version or history point.
   * Creates a new `source = 'restore'` version + history entry, enforces `expectedRevision`
   * / `expectedVersionId` optimistic locking and `idempotency_receipts`.
   */
  async restoreVersion(
    ctx: AuthContext,
    projectId: string,
    input: RestoreVersionInput,
  ): Promise<HistoryMutationResult> {
    const writeToken = createWriteToken(input.writeToken);
    const actor = mapActor(ctx, input.actorKind, input.actorName);
    const scope = 'project:restore';
    const inputHash = input.requestId
      ? canonicalInputHash({
          projectId,
          targetVersionId: input.targetVersionId ?? null,
          point: input.point ?? null,
          seq: input.seq ?? null,
        })
      : null;

    const txResult = await this.db.transaction(async (tx) => {
      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: false,
        forUpdate: true,
      });

      if (input.requestId && inputHash) {
        const receipts = await tx
          .select()
          .from(idempotencyReceipts)
          .where(
            and(
              eq(idempotencyReceipts.workspaceId, ctx.workspaceId),
              eq(idempotencyReceipts.scope, scope),
              eq(idempotencyReceipts.requestId, input.requestId),
            ),
          )
          .for('update');
        const receipt = receipts[0];
        if (receipt) {
          if (receipt.inputHash.trim() !== inputHash) {
            throw new CloudError(
              'REQUEST_ID_CONFLICT',
              `requestId "${input.requestId}" was already used for a different restore target.`,
              { status: 409, applied: false },
            );
          }
          if (receipt.state === 'completed' && receipt.responsePayload) {
            return {
              replayed: true,
              payload: receipt.responsePayload as unknown as HistoryMutationResult,
            };
          }
        }
      }

      const currentRevision = project.revision.trim();
      if (input.expectedRevision !== undefined && currentRevision !== input.expectedRevision.trim()) {
        throw new CloudError('VERSION_CONFLICT', 'Project revision mismatch; reload before restoring.', {
          status: 409,
          applied: false,
          details: {
            expectedRevision: input.expectedRevision,
            currentRevision,
            currentVersionId: project.currentVersionId,
          },
        });
      }
      if (input.expectedVersionId !== undefined && project.currentVersionId !== input.expectedVersionId) {
        throw new CloudError('VERSION_CONFLICT', 'Project versionId mismatch; reload before restoring.', {
          status: 409,
          applied: false,
          details: {
            expectedVersionId: input.expectedVersionId,
            currentRevision,
            currentVersionId: project.currentVersionId,
          },
        });
      }

      const targetVersion = await this.resolveTargetVersion(tx, ctx.workspaceId, project.id, input);

      const snapshotFiles = await tx
        .select()
        .from(projectVersionFiles)
        .where(
          and(
            eq(projectVersionFiles.workspaceId, ctx.workspaceId),
            eq(projectVersionFiles.versionId, targetVersion.id),
          ),
        );

      const liveFiles = await tx
        .select()
        .from(projectFiles)
        .where(and(eq(projectFiles.workspaceId, ctx.workspaceId), eq(projectFiles.projectId, project.id)));

      // Refcount deltas: live replacement (-1 old, +1 target) + new restore version snapshot (+1 target).
      const deltas: BlobRefDelta[] = [];
      for (const oldFile of liveFiles) {
        if (oldFile.blobScope === 'workspace') {
          deltas.push({ sha256: oldFile.sha256.trim(), delta: -1 });
        }
      }
      for (const snap of snapshotFiles) {
        if (snap.blobScope === 'workspace') {
          deltas.push({
            sha256: snap.sha256.trim(),
            delta: 2,
            sizeBytes: Number(snap.sizeBytes),
            mimeType: snap.mimeType,
            s3Key: workspaceBlobKey(ctx.workspaceId, snap.sha256.trim()),
          });
        }
      }
      if (deltas.length > 0) {
        await applyWorkspaceBlobRefDeltas(tx, ctx.workspaceId, deltas);
      }

      const now = new Date();
      await tx
        .delete(projectFiles)
        .where(and(eq(projectFiles.workspaceId, ctx.workspaceId), eq(projectFiles.projectId, project.id)));

      if (snapshotFiles.length > 0) {
        await tx.insert(projectFiles).values(
          snapshotFiles.map((f) =>
            asInsert(projectFiles, {
              workspaceId: ctx.workspaceId,
              projectId: project.id,
              path: f.path,
              blobScope: f.blobScope,
              sha256: f.sha256.trim(),
              sizeBytes: Number(f.sizeBytes),
              mimeType: f.mimeType,
              isText: isTextProjectPath(f.path),
              updatedAt: now,
            }),
          ),
        );
      }

      const appliedFiles = computeChangedFilePaths(liveFiles, snapshotFiles);
      const nextRevision = computeProjectRevision(
        snapshotFiles.map((f) => ({ path: f.path, size: Number(f.sizeBytes), hash: f.sha256.trim() })),
      );
      const maxVerRow = await tx
        .select({ maxVer: sql<number>`COALESCE(MAX(${projectVersions.versionNumber}), 0)` })
        .from(projectVersions)
        .where(
          and(
            eq(projectVersions.workspaceId, ctx.workspaceId),
            eq(projectVersions.projectId, project.id),
          ),
        );
      const nextVersionNumber = Math.max(project.currentVersionNumber, Number(maxVerRow[0]?.maxVer ?? 0)) + 1;

      const maxSeqRow = await tx
        .select({ maxSeq: sql<number>`COALESCE(MAX(${projectHistoryEntries.seq}), 0)` })
        .from(projectHistoryEntries)
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
            eq(projectHistoryEntries.projectId, project.id),
          ),
        );
      const nextSeq = Math.max(project.currentHistorySeq, Number(maxSeqRow[0]?.maxSeq ?? 0)) + 1;

      const parentRows =
        project.currentHistorySeq > 0
          ? await tx
              .select({ id: projectHistoryEntries.id })
              .from(projectHistoryEntries)
              .where(
                and(
                  eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
                  eq(projectHistoryEntries.projectId, project.id),
                  eq(projectHistoryEntries.seq, project.currentHistorySeq),
                ),
              )
          : [];

      const summary = (input.label?.trim() || `Restored v${targetVersion.versionNumber}`).slice(0, 256);

      const [newVersion] = await tx
        .insert(projectVersions)
        .values(
          asInsert(projectVersions, {
            workspaceId: ctx.workspaceId,
            projectId: project.id,
            versionNumber: nextVersionNumber,
            revision: nextRevision,
            source: 'restore',
            summary,
            requestId: input.requestId ?? null,
            restoredFromVersionId: targetVersion.id,
            pinned: false,
            createdAt: now,
          }),
        )
        .returning({ id: projectVersions.id });

      if (snapshotFiles.length > 0) {
        await tx.insert(projectVersionFiles).values(
          snapshotFiles.map((f) =>
            asInsert(projectVersionFiles, {
              versionId: newVersion.id,
              workspaceId: ctx.workspaceId,
              projectId: project.id,
              path: f.path,
              blobScope: f.blobScope,
              sha256: f.sha256.trim(),
              sizeBytes: Number(f.sizeBytes),
              mimeType: f.mimeType,
            }),
          ),
        );
      }

      await tx
        .delete(projectHistoryEntries)
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
            eq(projectHistoryEntries.projectId, project.id),
            eq(projectHistoryEntries.undone, true),
            gt(projectHistoryEntries.seq, project.currentHistorySeq),
          ),
        );

      await tx.insert(projectHistoryEntries).values(
        asInsert(projectHistoryEntries, {
          workspaceId: ctx.workspaceId,
          projectId: project.id,
          seq: nextSeq,
          versionId: newVersion.id,
          parentEntryId: parentRows[0]?.id ?? null,
          actorKind: actor.actorKind,
          actorName: actor.actorName,
          label: summary,
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
            currentVersionId: newVersion.id,
            currentVersionNumber: nextVersionNumber,
            currentHistorySeq: nextSeq,
            updatedAt: now,
          }),
        )
        .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));

      const resultPayload: HistoryMutationResult = {
        ok: true,
        projectId: project.id,
        revision: nextRevision,
        versionId: newVersion.id,
        versionNumber: nextVersionNumber,
        seq: nextSeq,
        canUndo: true,
        canRedo: false,
        appliedFiles,
        writeToken,
        replayed: false,
      };

      if (input.requestId && inputHash) {
        await tx
          .insert(idempotencyReceipts)
          .values(
            asInsert(idempotencyReceipts, {
              workspaceId: ctx.workspaceId,
              scope,
              requestId: input.requestId,
              inputHash,
              state: 'completed',
              resourceId: newVersion.id,
              responsePayload: resultPayload as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
            set: asUpdate(idempotencyReceipts, {
              state: 'completed',
              resourceId: newVersion.id,
              responsePayload: resultPayload as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          });
      }

      return { replayed: false, payload: resultPayload };
    });

    if (txResult.replayed) {
      return { ...txResult.payload, replayed: true };
    }

    await this.publishProjectAndHistory(
      ctx.workspaceId,
      projectId,
      txResult.payload.revision,
      txResult.payload.versionId,
      txResult.payload.seq,
      txResult.payload.appliedFiles,
      writeToken,
    );

    const list = await this.listHistory(ctx, projectId);
    return {
      ...txResult.payload,
      canUndo: list.canUndo,
      canRedo: list.canRedo,
      entry: list.entries.find((e) => e.seq === txResult.payload.seq) ?? null,
    };
  }

  /** Pin or unpin a history entry (and its associated version) under the project lock. */
  async pinEntry(
    ctx: AuthContext,
    projectId: string,
    entryId: string,
    pinned: boolean,
  ): Promise<{ ok: true; entryId: string; pinned: boolean }> {
    assertValidUuid(entryId, 'entryId');

    return this.db.transaction(async (tx) => {
      await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: true,
        forUpdate: true,
      });

      const rows = await tx
        .update(projectHistoryEntries)
        .set(asUpdate(projectHistoryEntries, { pinned }))
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
            eq(projectHistoryEntries.projectId, projectId),
            eq(projectHistoryEntries.id, entryId),
          ),
        )
        .returning({ id: projectHistoryEntries.id, versionId: projectHistoryEntries.versionId });

      const updated = rows[0];
      if (!updated) {
        throw new CloudError('NOT_FOUND', `History entry ${entryId} not found.`, { status: 404, applied: false });
      }

      await tx
        .update(projectVersions)
        .set(asUpdate(projectVersions, { pinned }))
        .where(
          and(
            eq(projectVersions.workspaceId, ctx.workspaceId),
            eq(projectVersions.id, updated.versionId),
          ),
        );

      return { ok: true as const, entryId: updated.id, pinned };
    });
  }

  /** Inspect files at a historical point (`versionId`, `entryId`, `seq`, or `'head'`). */
  async peekPoint(
    ctx: AuthContext,
    projectId: string,
    point: string,
    filePath?: string,
  ): Promise<{
    point: string;
    versionId: string;
    revision: string;
    files: Record<string, string>;
    file?: { path: string; content: string; version: string; sha256: string } | null;
  }> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: true });

    const targetVersion =
      point === 'head' && project.currentVersionId
        ? await this.resolveTargetVersion(this.db, ctx.workspaceId, project.id, {
            targetVersionId: project.currentVersionId,
          })
        : await this.resolveTargetVersion(this.db, ctx.workspaceId, project.id, { point });

    const rows = await this.db
      .select()
      .from(projectVersionFiles)
      .where(
        and(
          eq(projectVersionFiles.workspaceId, ctx.workspaceId),
          eq(projectVersionFiles.versionId, targetVersion.id),
        ),
      )
      .orderBy(asc(projectVersionFiles.path));

    const files: Record<string, string> = {};
    for (const row of rows) {
      files[row.path] = row.sha256.trim();
    }

    let singleFile: { path: string; content: string; version: string; sha256: string } | null | undefined;
    if (filePath !== undefined) {
      const safePath = normalizeSafeProjectPath(filePath);
      const match = rows.find((r) => r.path === safePath);
      if (!match) {
        singleFile = null;
      } else {
        const sha = match.sha256.trim();
        let content: string | null = null;
        if (this.hotTextCache) {
          content = await this.hotTextCache.getText(sha).catch(() => null);
        }
        if (content === null) {
          const key = resolveBlobStorageKey(ctx.workspaceId, match.blobScope, sha);
          const buf = await this.storage.getObjectBuffer(key);
          content = buf.toString('utf8');
        }
        singleFile = {
          path: match.path,
          content,
          sha256: sha,
          version: formatVersionFromSha256(sha),
        };
      }
    }

    return {
      point: targetVersion.id,
      versionId: targetVersion.id,
      revision: targetVersion.revision.trim(),
      files,
      ...(filePath !== undefined ? { file: singleFile } : {}),
    };
  }

  /**
   * Read an immutable historical blob by SHA-256 ONLY if referenced by this project's live files
   * or version history (enforcing strict tenant + project isolation).
   */
  async readHistoryBlob(
    ctx: AuthContext,
    projectId: string,
    sha256: string,
  ): Promise<{ buffer: Buffer; mimeType: string; blobScope: BlobScope; sha256: string }> {
    await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: true });
    const cleanSha = sha256.trim().toLowerCase();
    if (!isSha256Hex(cleanSha)) {
      throw new CloudError('INVALID_ARGUMENT', 'History blob hash must be a 64-char hex SHA-256 digest.', {
        status: 400,
        applied: false,
      });
    }

    const versionRefs = await this.db
      .select({ blobScope: projectVersionFiles.blobScope, mimeType: projectVersionFiles.mimeType })
      .from(projectVersionFiles)
      .where(
        and(
          eq(projectVersionFiles.workspaceId, ctx.workspaceId),
          eq(projectVersionFiles.projectId, projectId),
          eq(projectVersionFiles.sha256, cleanSha),
        ),
      )
      .limit(1);

    const ref =
      versionRefs[0] ??
      (
        await this.db
          .select({ blobScope: projectFiles.blobScope, mimeType: projectFiles.mimeType })
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.workspaceId, ctx.workspaceId),
              eq(projectFiles.projectId, projectId),
              eq(projectFiles.sha256, cleanSha),
            ),
          )
          .limit(1)
      )[0];

    if (!ref) {
      throw new CloudError('NOT_FOUND', `History blob ${cleanSha} was not found in this project.`, {
        status: 404,
        applied: false,
      });
    }

    const key = resolveBlobStorageKey(ctx.workspaceId, ref.blobScope, cleanSha);
    const buffer = await this.storage.getObjectBuffer(key);
    return {
      buffer,
      mimeType: ref.mimeType,
      blobScope: ref.blobScope,
      sha256: cleanSha,
    };
  }

  /** Mint a stateless PG-compatible history window ID for Studio edit coalescing. */
  async openWindow(ctx: AuthContext, projectId: string): Promise<{ windowId: string }> {
    await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: false });
    return { windowId: randomUUID() };
  }

  /** Close a history edit window (stateless no-op under PG unified ledger). */
  async closeWindow(ctx: AuthContext, projectId: string, windowId: string): Promise<{ ok: true; windowId: string }> {
    await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: true });
    return { ok: true, windowId };
  }

  private async resolveTargetVersion(
    db: Parameters<Parameters<Database['transaction']>[0]>[0] | Database,
    workspaceId: string,
    projectId: string,
    input: { targetVersionId?: string; point?: string; seq?: number },
  ): Promise<typeof projectVersions.$inferSelect> {
    if (input.targetVersionId) {
      assertValidUuid(input.targetVersionId, 'targetVersionId');
      const rows = await db
        .select()
        .from(projectVersions)
        .where(
          and(
            eq(projectVersions.workspaceId, workspaceId),
            eq(projectVersions.projectId, projectId),
            eq(projectVersions.id, input.targetVersionId),
          ),
        );
      if (rows[0]) return rows[0];
      throw new CloudError('NOT_FOUND', `Version ${input.targetVersionId} not found.`, {
        status: 404,
        applied: false,
      });
    }

    if (input.seq !== undefined && Number.isInteger(input.seq)) {
      const entryRows = await db
        .select({ versionId: projectHistoryEntries.versionId })
        .from(projectHistoryEntries)
        .where(
          and(
            eq(projectHistoryEntries.workspaceId, workspaceId),
            eq(projectHistoryEntries.projectId, projectId),
            eq(projectHistoryEntries.seq, input.seq),
          ),
        );
      if (entryRows[0]) {
        return this.resolveTargetVersion(db, workspaceId, projectId, {
          targetVersionId: entryRows[0].versionId,
        });
      }
    }

    if (input.point) {
      const trimmed = input.point.trim();
      if (isUuid(trimmed)) {
        const directVer = await db
          .select()
          .from(projectVersions)
          .where(
            and(
              eq(projectVersions.workspaceId, workspaceId),
              eq(projectVersions.projectId, projectId),
              eq(projectVersions.id, trimmed),
            ),
          );
        if (directVer[0]) return directVer[0];

        const byEntry = await db
          .select({ versionId: projectHistoryEntries.versionId })
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, workspaceId),
              eq(projectHistoryEntries.projectId, projectId),
              eq(projectHistoryEntries.id, trimmed),
            ),
          );
        if (byEntry[0]) {
          return this.resolveTargetVersion(db, workspaceId, projectId, {
            targetVersionId: byEntry[0].versionId,
          });
        }
      }

      const seqMatch = /^(?:seq:|v)?(\d+)$/i.exec(trimmed);
      if (seqMatch) {
        const num = Number.parseInt(seqMatch[1], 10);
        const bySeq = await db
          .select({ versionId: projectHistoryEntries.versionId })
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, workspaceId),
              eq(projectHistoryEntries.projectId, projectId),
              eq(projectHistoryEntries.seq, num),
            ),
          );
        if (bySeq[0]) {
          return this.resolveTargetVersion(db, workspaceId, projectId, {
            targetVersionId: bySeq[0].versionId,
          });
        }
        const byVerNum = await db
          .select()
          .from(projectVersions)
          .where(
            and(
              eq(projectVersions.workspaceId, workspaceId),
              eq(projectVersions.projectId, projectId),
              eq(projectVersions.versionNumber, num),
            ),
          );
        if (byVerNum[0]) return byVerNum[0];
      }
    }

    throw new CloudError('NOT_FOUND', 'Requested project version or history point was not found.', {
      status: 404,
      applied: false,
    });
  }

  private async applySnapshotToLiveFiles(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    workspaceId: string,
    projectId: string,
    versionId: string,
  ): Promise<{ appliedFiles: string[]; revision: string }> {
    const liveFiles = await tx
      .select()
      .from(projectFiles)
      .where(and(eq(projectFiles.workspaceId, workspaceId), eq(projectFiles.projectId, projectId)));

    const snapshotFiles = await tx
      .select()
      .from(projectVersionFiles)
      .where(
        and(
          eq(projectVersionFiles.workspaceId, workspaceId),
          eq(projectVersionFiles.versionId, versionId),
        ),
      );

    const deltas: BlobRefDelta[] = [];
    for (const oldFile of liveFiles) {
      if (oldFile.blobScope === 'workspace') {
        deltas.push({ sha256: oldFile.sha256.trim(), delta: -1 });
      }
    }
    for (const snap of snapshotFiles) {
      if (snap.blobScope === 'workspace') {
        deltas.push({
          sha256: snap.sha256.trim(),
          delta: 1,
          sizeBytes: Number(snap.sizeBytes),
          mimeType: snap.mimeType,
          s3Key: workspaceBlobKey(workspaceId, snap.sha256.trim()),
        });
      }
    }
    if (deltas.length > 0) {
      await applyWorkspaceBlobRefDeltas(tx, workspaceId, deltas);
    }

    await tx
      .delete(projectFiles)
      .where(and(eq(projectFiles.workspaceId, workspaceId), eq(projectFiles.projectId, projectId)));

    const now = new Date();
    if (snapshotFiles.length > 0) {
      await tx.insert(projectFiles).values(
        snapshotFiles.map((f) =>
          asInsert(projectFiles, {
            workspaceId,
            projectId,
            path: f.path,
            blobScope: f.blobScope,
            sha256: f.sha256.trim(),
            sizeBytes: Number(f.sizeBytes),
            mimeType: f.mimeType,
            isText: isTextProjectPath(f.path),
            updatedAt: now,
          }),
        ),
      );
    }

    const appliedFiles = computeChangedFilePaths(liveFiles, snapshotFiles);
    const revision = computeProjectRevision(
      snapshotFiles.map((f) => ({ path: f.path, size: Number(f.sizeBytes), hash: f.sha256.trim() })),
    );
    return { appliedFiles, revision };
  }

  private async publishHistoryChanged(
    workspaceId: string,
    projectId: string,
    revision: string,
    versionId: string | null,
    historySeq: number,
  ): Promise<void> {
    if (!this.eventBus) return;
    const event: ProjectEvent = {
      type: 'history-changed',
      workspaceId,
      projectId,
      revision,
      versionId: versionId ?? undefined,
      historySeq,
      ts: Date.now(),
    };
    await this.eventBus.publish(projectChannel(workspaceId, projectId), event).catch(() => {});
  }

  private async publishProjectAndHistory(
    workspaceId: string,
    projectId: string,
    revision: string,
    versionId: string | null,
    historySeq: number,
    appliedFiles: readonly string[],
    writeToken: string,
  ): Promise<void> {
    if (!this.eventBus) return;
    const channel = projectChannel(workspaceId, projectId);
    if (appliedFiles.length > 0) {
      const impact = computePreviewImpact(appliedFiles);
      const fileEvent: ProjectEvent = {
        type: 'file-change',
        workspaceId,
        projectId,
        revision,
        versionId: versionId ?? undefined,
        paths: [...appliedFiles],
        writeToken,
        affectsPreview: impact.affectsPreview,
        affectedCompositions: impact.affectedCompositions,
        ts: Date.now(),
      };
      await this.eventBus.publish(channel, fileEvent).catch(() => {});
    }
    await this.publishHistoryChanged(workspaceId, projectId, revision, versionId, historySeq);
  }
}

function computeChangedFilePaths(
  before: ReadonlyArray<{ path: string; sha256: string }>,
  after: ReadonlyArray<{ path: string; sha256: string }>,
): string[] {
  const beforeMap = new Map(before.map((f) => [f.path, f.sha256.trim()]));
  const afterMap = new Map(after.map((f) => [f.path, f.sha256.trim()]));
  const changed: string[] = [];
  for (const filePath of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    if (beforeMap.get(filePath) !== afterMap.get(filePath)) {
      changed.push(filePath);
    }
  }
  return changed.sort((a, b) => a.localeCompare(b));
}
