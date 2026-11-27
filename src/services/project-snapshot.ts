import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { DbTransaction } from '../db/client.ts';
import { applyWorkspaceBlobRefDeltas } from '../db/cas.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import {
  projectFiles,
  projectHistoryEntries,
  projectVersionFiles,
  projectVersions,
} from '../db/schema/project-files.ts';
import { projects } from '../db/schema/projects.ts';

export interface ProjectHistoryActor {
  source: 'studio' | 'agent';
  actorKind: 'user' | 'agent';
  actorName: string;
}

export function resolveProjectHistoryActor(actor: {
  authMethod?: string | null;
  displayName?: string | null;
  email?: string | null;
}): ProjectHistoryActor {
  const isStudioUser = actor.authMethod === 'session_cookie' || actor.authMethod === 'dev_bypass';
  const actorKind: 'user' | 'agent' = isStudioUser ? 'user' : 'agent';
  const actorName = (actor.displayName?.trim() || actor.email?.trim() || actorKind).slice(0, 128);
  return {
    source: isStudioUser ? 'studio' : 'agent',
    actorKind,
    actorName,
  };
}

export interface CommitProjectVersionAndHistoryInput {
  workspaceId: string;
  projectId: string;
  currentVersionNumber: number;
  currentHistorySeq: number;
  revision: string;
  source: 'studio' | 'agent';
  summary: string;
  requestId: string | null;
  actorKind: 'user' | 'agent';
  actorName?: string | null;
  now?: Date;
  /** Caller-local snapshot manifest and CAS refcount work executed after `project_versions` insert. */
  afterVersionInsert?: (versionId: string) => Promise<void>;
}

export interface CommitProjectVersionAndHistoryResult {
  versionId: string;
  versionNumber: number;
  historySeq: number;
  now: Date;
}

/**
 * Allocate the next project version and history sequence under the caller's locked project row,
 * insert the version snapshot row, run caller-local manifest/refcount work, prune undone redo
 * entries, insert the history entry, and advance the project's head pointers.
 *
 * After Undo, `projects.current_version_number` points back to an earlier snapshot while higher
 * `project_versions.version_number` rows remain for Redo; allocating strictly above `MAX(...)`
 * prevents `uq_project_versions_number` / `uq_project_history_seq` collisions.
 */
export async function commitProjectVersionAndHistory(
  tx: DbTransaction,
  input: CommitProjectVersionAndHistoryInput,
): Promise<CommitProjectVersionAndHistoryResult> {
  const now = input.now ?? new Date();
  const maxVerRow = await tx
    .select({ maxVer: sql<number>`COALESCE(MAX(${projectVersions.versionNumber}), 0)` })
    .from(projectVersions)
    .where(
      and(
        eq(projectVersions.workspaceId, input.workspaceId),
        eq(projectVersions.projectId, input.projectId),
      ),
    );
  const nextVersionNumber =
    Math.max(Number(input.currentVersionNumber ?? 0), Number(maxVerRow[0]?.maxVer ?? 0)) + 1;

  const maxSeqRow = await tx
    .select({ maxSeq: sql<number>`COALESCE(MAX(${projectHistoryEntries.seq}), 0)` })
    .from(projectHistoryEntries)
    .where(
      and(
        eq(projectHistoryEntries.workspaceId, input.workspaceId),
        eq(projectHistoryEntries.projectId, input.projectId),
      ),
    );
  const currentHistorySeq = Number(input.currentHistorySeq ?? 0);
  const nextHistorySeq = Math.max(currentHistorySeq, Number(maxSeqRow[0]?.maxSeq ?? 0)) + 1;

  const parentRows =
    currentHistorySeq > 0
      ? await tx
          .select({ id: projectHistoryEntries.id })
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, input.workspaceId),
              eq(projectHistoryEntries.projectId, input.projectId),
              eq(projectHistoryEntries.seq, currentHistorySeq),
            ),
          )
          .limit(1)
      : [];
  const parentEntryId = parentRows[0]?.id ?? null;

  const [newVersion] = await tx
    .insert(projectVersions)
    .values(
      asInsert(projectVersions, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        versionNumber: nextVersionNumber,
        revision: input.revision,
        source: input.source,
        summary: input.summary,
        requestId: input.requestId,
      }),
    )
    .returning();

  if (input.afterVersionInsert) {
    await input.afterVersionInsert(newVersion.id);
  }

  await tx
    .delete(projectHistoryEntries)
    .where(
      and(
        eq(projectHistoryEntries.workspaceId, input.workspaceId),
        eq(projectHistoryEntries.projectId, input.projectId),
        eq(projectHistoryEntries.undone, true),
        gt(projectHistoryEntries.seq, currentHistorySeq),
      ),
    );

  const actorName = (input.actorName?.trim() || input.actorKind).slice(0, 128);
  await tx.insert(projectHistoryEntries).values(
    asInsert(projectHistoryEntries, {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      seq: nextHistorySeq,
      versionId: newVersion.id,
      parentEntryId,
      actorKind: input.actorKind,
      actorName,
      label: input.summary,
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
        revision: input.revision,
        currentVersionId: newVersion.id,
        currentVersionNumber: nextVersionNumber,
        currentHistorySeq: nextHistorySeq,
        updatedAt: now,
      }),
    )
    .where(and(eq(projects.workspaceId, input.workspaceId), eq(projects.id, input.projectId)));

  return {
    versionId: newVersion.id,
    versionNumber: nextVersionNumber,
    historySeq: nextHistorySeq,
    now,
  };
}

/** Capture the current live manifest under the caller's project row lock. No undo entry or blob read. */
export async function freezeProjectSnapshot(
  tx: DbTransaction, project: typeof projects.$inferSelect,
  files: readonly (typeof projectFiles.$inferSelect)[], summary: string,
): Promise<string> {
  const id = randomUUID();
  const projectId = project.id, workspaceId = project.workspaceId;
  const versionNumber = project.currentVersionNumber + 1;
  const now = new Date();
  await tx.insert(projectVersions).values(asInsert(projectVersions, {
    id, workspaceId, projectId, versionNumber, revision: project.revision, source: 'studio', summary, createdAt: now,
  }));
  if (files.length) {
    await tx.insert(projectVersionFiles).values(files.map(file => asInsert(projectVersionFiles, {
      versionId: id, workspaceId, projectId, path: file.path, blobScope: file.blobScope,
      sha256: file.sha256, sizeBytes: Number(file.sizeBytes), mimeType: file.mimeType,
    })));
    const deltas = files.filter(file => file.blobScope === 'workspace').map(file => ({
      sha256: file.sha256, delta: 1, sizeBytes: Number(file.sizeBytes), mimeType: file.mimeType,
    }));
    await applyWorkspaceBlobRefDeltas(tx, workspaceId, deltas);
  }
  await tx.update(projects).set(asUpdate(projects, {
    currentVersionId: id, currentVersionNumber: versionNumber, updatedAt: now,
  })).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
  return id;
}
