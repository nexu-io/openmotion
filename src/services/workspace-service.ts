import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError, featureDeferredP2 } from '../contracts/errors.ts';
import type { BlobMetadata, BlobScope, StoragePort } from '../contracts/storage.ts';
import { applyWorkspaceBlobRefDeltas, type BlobRefDelta } from '../db/cas.ts';
import type { Database } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import { workspaces } from '../db/schema/auth.ts';
import { idempotencyReceipts } from '../db/schema/jobs.ts';
import {
  projectFiles,
  projectHistoryEntries,
  projectVersionFiles,
  projectVersions,
} from '../db/schema/project-files.ts';
import {
  projectGrants,
  projects,
  sessionMessages,
  sessions,
  type ProjectType,
  type SessionMessageRole,
} from '../db/schema/projects.ts';
import { workspaceBlobKey } from '../infra/storage.ts';
import { validateInstruction, type SessionMessage } from '../../shared/conversation.ts';
import {
  computeProjectRevision,
  isTextProjectPath,
  isUuid,
  validateProjectTitle,
  type ProjectCatalog,
  type ProjectMutationResult,
  type SavedProject,
} from '../../shared/project-validation.ts';
import {
  availableSession,
  projectArtifact,
  creationMode,
  type CreativeSession,
  type SessionDetail,
} from '../../shared/session.ts';
import { getMimeType, sha256Hex } from '../studio/etag.ts';
import { prepareFullBaseline } from './text-patch-boundaries.ts';
import {
  agentProjectFilter,
  assertAgentProjectAccess,
  assertAgentSessionAccess,
  assertValidUuid,
  canonicalInputHash,
  loadProjectOrThrow,
  MAX_TEXT_FILE_BYTES,
  normalizeSafeProjectPath,
  type HotTextCachePort,
  type ProjectFilesService,
} from './project-files-service.ts';

export const DEFAULT_SESSION_TITLE = 'New Session';

function sessionNotFound(sessionId: string): CloudError {
  return new CloudError('SESSION_NOT_FOUND', `Session ${sessionId} was not found.`, {
    status: 404,
    applied: false,
  });
}

const MAX_SESSION_MESSAGES = 200;

export interface WorkspaceServiceDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly files: ProjectFilesService;
  readonly onCatalogChange?: (workspaceId: string) => void;
  readonly hotTextCache?: HotTextCachePort;
}

export interface InitialProjectFile {
  readonly path: string;
  readonly content?: string;
  readonly data?: Buffer;
  // A new project may share content-addressed blobs. Text revisions belong to their source project.
  readonly blobScope?: 'workspace' | 'catalog';
  readonly sha256?: string;
  readonly sizeBytes?: number;
  readonly mimeType?: string;
  readonly isText?: boolean;
  readonly metadata?: BlobMetadata | null;
}

export interface CreateProjectInput {
  readonly title?: string;
  readonly titleKey?: 'OpenMotion Sample Video' | null;
  readonly projectType?: ProjectType;
  readonly templateId?: string | null;
  readonly requirements?: string | null;
  readonly namingLanguage?: string | null;
  readonly sessionId?: string | null;
  readonly sourceMeta?: Record<string, unknown> | null;
  readonly initialFiles?: readonly InitialProjectFile[];
  readonly requestId?: string;
  readonly selectActive?: boolean;
  readonly initialPrompt?: string;
}

export interface CreatedProjectResult {
  readonly projectId: string;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly title: string;
  readonly revision: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly historySeq: number;
  readonly activeProjectId: string;
  readonly replayed: boolean;
}

export interface ProjectSummaryDetail {
  readonly id: string;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly title: string;
  readonly titleKey: 'OpenMotion Sample Video' | null;
  readonly projectType: ProjectType;
  readonly templateId: string | null;
  readonly requirements: string | null;
  readonly namingLanguage: string | null;
  readonly sourceMeta: Record<string, unknown> | null;
  readonly revision: string;
  readonly currentVersionId: string | null;
  readonly currentVersionNumber: number;
  readonly currentHistorySeq: number;
  readonly previewDisplay: Record<string, unknown> | null;
  readonly reviews: unknown[];
  readonly trashed: boolean;
  readonly trashedAt: number | null;
  readonly createdAt: number;
  readonly openedAt: number;
  readonly updatedAt: number;
}

export interface WorkspaceCatalogResult extends ProjectCatalog {
  readonly trashedProjects: SavedProject[];
}

export function buildBlankProjectFiles(title: string, namingLanguage?: string | null): InitialProjectFile[] {
  const safeTitle = title.replace(/[<>&"]/g, (ch) =>
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : '&quot;',
  );
  const rawHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${safeTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #0f172a; color: #f8fafc; font-family: sans-serif; }
    #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    #title { font-size: 72px; font-weight: 700; letter-spacing: -0.02em; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="5" data-fps="30">
    <h1 id="title" data-start="0" data-duration="5">${safeTitle}</h1>
  </div>
</body>
</html>
`;
  const stampedHtml = stampHfIdsInPlace(rawHtml);
  const hyperframesJson = JSON.stringify(
    {
      name: title,
      entry: 'index.html',
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 5,
    },
    null,
    2,
  ) + '\n';
  const motionProjectJson = JSON.stringify(
    {
      title,
      ...(namingLanguage ? { namingLanguage } : {}),
    },
    null,
    2,
  ) + '\n';
  const motionAssetsJson = JSON.stringify({ assets: [] }, null, 2) + '\n';

  return [
    { path: 'index.html', content: stampedHtml, mimeType: 'text/html; charset=utf-8' },
    { path: 'hyperframes.json', content: hyperframesJson, mimeType: 'application/json; charset=utf-8' },
    { path: 'motion-project.json', content: motionProjectJson, mimeType: 'application/json; charset=utf-8' },
    { path: 'motion-assets.json', content: motionAssetsJson, mimeType: 'application/json; charset=utf-8' },
  ];
}

function toSavedProject(row: typeof projects.$inferSelect): SavedProject {
  return {
    id: row.id,
    title: row.title,
    ...(row.titleKey === 'OpenMotion Sample Video' ? { titleKey: 'OpenMotion Sample Video' as const } : {}),
    ...(row.templateId ? { templateId: row.templateId } : {}),
    createdAt: row.createdAt.getTime(),
    openedAt: row.openedAt.getTime(),
    ...(row.trashedAt ? { trashedAt: row.trashedAt.getTime() } : {}),
  };
}

function toProjectSummaryDetail(row: typeof projects.$inferSelect): ProjectSummaryDetail {
  return {
    id: row.id,
    sessionId: row.sessionId,
    artifactId: row.artifactId,
    title: row.title,
    titleKey: row.titleKey === 'OpenMotion Sample Video' ? 'OpenMotion Sample Video' : null,
    projectType: row.projectType,
    templateId: row.templateId ?? null,
    requirements: row.requirements ?? null,
    namingLanguage: row.namingLanguage ?? null,
    sourceMeta: row.sourceMeta ?? null,
    revision: row.revision.trim(),
    currentVersionId: row.currentVersionId ?? null,
    currentVersionNumber: row.currentVersionNumber,
    currentHistorySeq: row.currentHistorySeq,
    previewDisplay: row.previewDisplay ?? null,
    reviews: Array.isArray(row.reviews) ? row.reviews : [],
    trashed: row.trashed,
    trashedAt: row.trashedAt ? row.trashedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    openedAt: row.openedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toSessionMessage(row: typeof sessionMessages.$inferSelect): SessionMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.getTime(),
  };
}

function safeTitle(raw: unknown, fallback = 'Untitled Project'): string {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return fallback;
  }
  try {
    return validateProjectTitle(raw);
  } catch (error) {
    throw new CloudError(
      'INVALID_ARGUMENT',
      error instanceof Error ? error.message : 'Project title must be 1–100 characters.',
      { status: 400, applied: false },
    );
  }
}

export class WorkspaceService {
  private readonly db: Database;
  private readonly storage: StoragePort;
  private readonly textPatchWrites: boolean;
  private readonly hotTextCache?: HotTextCachePort;

  private readonly onCatalogChange?: WorkspaceServiceDeps['onCatalogChange'];

  constructor(deps: WorkspaceServiceDeps) {
    this.onCatalogChange = deps.onCatalogChange;
    this.db = deps.db;
    this.storage = deps.storage;
    this.textPatchWrites = deps.files.textPatchWrites;
    this.hotTextCache = deps.hotTextCache;
  }

  /** Return the full multi-tenant workspace catalog (active project, projects, trashed projects, sessions). */
  async getCatalog(ctx: AuthContext): Promise<WorkspaceCatalogResult> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');

    const [wsRow] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId));

    const agentFilter = await agentProjectFilter(this.db, ctx);
    const workspaceProjectRows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, ctx.workspaceId))
      .orderBy(desc(projects.createdAt), asc(projects.id));
    const projectRows = agentFilter ? workspaceProjectRows.filter(agentFilter) : workspaceProjectRows;

    const sessionRows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, ctx.workspaceId))
      .orderBy(desc(sessions.openedAt), desc(sessions.createdAt));

    const activeProjects = projectRows.filter((p) => !p.trashed);
    const trashedProjects = projectRows.filter((p) => p.trashed);
    const trashedSet = new Set(trashedProjects.map((p) => p.id));

    const projectsBySession = new Map<string, typeof projectRows>();
    for (const proj of projectRows) {
      let bucket = projectsBySession.get(proj.sessionId);
      if (!bucket) {
        bucket = [];
        projectsBySession.set(proj.sessionId, bucket);
      }
      bucket.push(proj);
    }

    const creativeSessions: CreativeSession[] = [];
    for (const sess of sessionRows) {
      const artifacts = (projectsBySession.get(sess.id) ?? []).map(projectArtifact);
      if (agentFilter && artifacts.length === 0) continue;
      const activeArtifactId =
        agentFilter && !artifacts.some((a) => a.id === sess.activeArtifactId) ? artifacts[0].id : sess.activeArtifactId;
      const fullSession: CreativeSession = {
        id: sess.id,
        title: sess.title,
        mode: 'motion',
        artifacts,
        ...(activeArtifactId ? { activeArtifactId } : {}),
        createdAt: sess.createdAt.getTime(),
        openedAt: sess.openedAt.getTime(),
        ...(sess.templateId ? { templateId: sess.templateId } : {}),
      };
      const visible = availableSession(fullSession, trashedSet);
      if (visible) creativeSessions.push(visible);
    }

    const activeId =
      (wsRow?.activeProjectId && activeProjects.some((p) => p.id === wsRow.activeProjectId)
        ? wsRow.activeProjectId
        : activeProjects[0]?.id) ?? '';

    const activeSessionId =
      (wsRow?.activeSessionId && creativeSessions.some((s) => s.id === wsRow.activeSessionId)
        ? wsRow.activeSessionId
        : creativeSessions[0]?.id) ?? undefined;

    return {
      activeId,
      projects: activeProjects.map(toSavedProject),
      trashedProjects: trashedProjects.map(toSavedProject),
      sessions: creativeSessions,
      ...(activeSessionId ? { activeSessionId } : {}),
    };
  }

  /** Read full project metadata (without local disk access). */
  async getProject(ctx: AuthContext, projectId: string, options: { allowTrashed?: boolean } = {}): Promise<ProjectSummaryDetail> {
    const row = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, {
      allowTrashed: options.allowTrashed ?? true,
      auth: ctx,
    });
    return toProjectSummaryDetail(row);
  }

  /**
   * Create a brand-new project (and optional session) backed strictly by S3 CAS + PG v1 baseline.
   * Uploads all new workspace blobs to S3 CAS BEFORE starting the PostgreSQL transaction.
   */
  async createProject(ctx: AuthContext, input: CreateProjectInput = {}): Promise<CreatedProjectResult> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    const title = safeTitle(input.title, 'Untitled Project');
    const initialFiles =
      input.initialFiles && input.initialFiles.length > 0
        ? [...input.initialFiles]
        : buildBlankProjectFiles(title, input.namingLanguage);

    interface PreparedInitFile {
      path: string;
      blobScope: BlobScope;
      sha256: string;
      sizeBytes: number;
      mimeType: string;
      isText: boolean;
      metadata?: BlobMetadata | null;
      buffer?: Buffer;
      textContent?: string;
    }

    const prepared: PreparedInitFile[] = [];
    const seenPaths = new Set<string>();
    const toUpload = new Map<string, { s3Key: string; buffer: Buffer; mimeType: string; textContent?: string }>();

    for (const file of initialFiles) {
      const safePath = normalizeSafeProjectPath(file.path, true);
      if (seenPaths.has(safePath)) continue;
      seenPaths.add(safePath);

      if (file.sha256 && file.sizeBytes !== undefined) {
        const scope: BlobScope = file.blobScope ?? 'workspace';
        prepared.push({
          path: safePath,
          blobScope: scope,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType ?? getMimeType(safePath),
          isText: file.isText ?? isTextProjectPath(safePath),
          metadata: file.metadata,
        });
      } else {
        const buffer =
          file.data !== undefined
            ? file.data
            : Buffer.from(file.content ?? '', 'utf8');
        const sha256 = sha256Hex(buffer);
        const mimeType = file.mimeType ?? getMimeType(safePath);
        const isText = file.isText ?? (file.content !== undefined || isTextProjectPath(safePath));
        const textContent = file.content !== undefined ? file.content : isText ? buffer.toString('utf8') : undefined;
        if (!toUpload.has(sha256)) {
          toUpload.set(sha256, {
            s3Key: workspaceBlobKey(ctx.workspaceId, sha256),
            buffer,
            mimeType,
            textContent,
          });
        }
        prepared.push({
          path: safePath,
          blobScope: 'workspace',
          sha256,
          sizeBytes: buffer.byteLength,
          mimeType,
          isText,
          metadata: file.metadata,
          buffer,
          textContent,
        });
      }
    }

    const scope = 'project:create';
    const inputHash = input.requestId
      ? canonicalInputHash({
          title,
          templateId: input.templateId ?? null,
          sessionId: input.sessionId ?? null,
          files: prepared.map((f) => ({ path: f.path, sha256: f.sha256, sizeBytes: f.sizeBytes })),
        })
      : null;

    // Upload all new workspace blobs to S3 CAS BEFORE PG transaction.
    for (const upload of toUpload.values()) {
      await this.storage.putBlobIfAbsent(upload.s3Key, upload.buffer, upload.mimeType);
    }

    const result = await this.db.transaction(async (tx) => {
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
              `requestId "${input.requestId}" was already used with a different project creation payload.`,
              { status: 409, applied: false },
            );
          }
          if (receipt.state === 'completed' && receipt.responsePayload) {
            return {
              ...(receipt.responsePayload as unknown as CreatedProjectResult),
              replayed: true,
            };
          }
        }
      }

      const now = new Date();
      let sessionId: string;
      if (input.sessionId) {
        assertValidUuid(input.sessionId, 'sessionId');
        const sessRows = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.workspaceId, ctx.workspaceId), eq(sessions.id, input.sessionId)))
          .for('update');
        if (!sessRows[0]) {
          throw new CloudError('SESSION_NOT_FOUND', `Session ${input.sessionId} was not found.`, {
            status: 404,
            applied: false,
          });
        }
        // The new project is auto-granted, so it must not open someone else's conversation to the agent.
        await assertAgentSessionAccess(tx, ctx, input.sessionId);
        sessionId = sessRows[0].id;
      } else {
        const [createdSession] = await tx
          .insert(sessions)
          .values(
            asInsert(sessions, {
              workspaceId: ctx.workspaceId,
              title,
              mode: 'motion',
              templateId: input.templateId ?? null,
              createdAt: now,
              openedAt: now,
              updatedAt: now,
            }),
          )
          .returning({ id: sessions.id });
        sessionId = createdSession.id;
      }

      const revision = computeProjectRevision(
        prepared.map((f) => ({ path: f.path, size: f.sizeBytes, hash: f.sha256 })),
      );
      const artifactId = randomUUID();

      const [createdProject] = await tx
        .insert(projects)
        .values(
          asInsert(projects, {
            workspaceId: ctx.workspaceId,
            ownerUserId: ctx.userId,
            sessionId,
            artifactId,
            title,
            titleKey: input.titleKey ?? null,
            projectType: input.projectType ?? (input.templateId ? 'template' : 'natural_language'),
            templateId: input.templateId ?? null,
            requirements: input.requirements ?? null,
            namingLanguage: input.namingLanguage ?? null,
            sourceMeta: input.sourceMeta ?? null,
            assetNameAllocations: {},
            revision,
            currentVersionNumber: 1,
            currentHistorySeq: 1,
            trashed: false,
            trashedAt: null,
            createdAt: now,
            openedAt: now,
            updatedAt: now,
          }),
        )
        .returning({ id: projects.id });

      // Spec: when an OAuth agent creates a new project, automatically grant that connection access.
      if (ctx.authMethod === 'oauth_bearer' && ctx.clientId) {
        await tx
          .insert(projectGrants)
          .values(
            asInsert(projectGrants, {
              projectId: createdProject.id,
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              clientId: ctx.clientId,
              grantedAt: now,
              revokedAt: null,
            }),
          )
          .onConflictDoUpdate({
            target: [projectGrants.projectId, projectGrants.userId, projectGrants.clientId],
            set: asUpdate(projectGrants, {
              workspaceId: ctx.workspaceId,
              grantedAt: now,
              revokedAt: null,
            }),
          });
      }

      if (this.textPatchWrites) {
        for (const [id, upload] of toUpload) {
          if (upload.textContent === undefined || upload.buffer.length > MAX_TEXT_FILE_BYTES || !isUtf8(upload.buffer)) continue;
          await prepareFullBaseline(tx, {
            projectId: createdProject.id, workspaceId: ctx.workspaceId, scope: 'workspace', id, bytes: upload.buffer,
          });
        }
      }

      // Apply +2 refcount per workspace blob (+1 live project_files +1 v1 project_version_files).
      const deltas: BlobRefDelta[] = prepared
        .filter((f) => f.blobScope === 'workspace')
        .map((f) => ({
          sha256: f.sha256,
          delta: 2,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          s3Key: workspaceBlobKey(ctx.workspaceId, f.sha256),
          metadata: f.metadata,
        }));
      if (deltas.length > 0) {
        await applyWorkspaceBlobRefDeltas(tx, ctx.workspaceId, deltas);
      }

      if (prepared.length > 0) {
        await tx.insert(projectFiles).values(
          prepared.map((f) =>
            asInsert(projectFiles, {
              workspaceId: ctx.workspaceId,
              projectId: createdProject.id,
              path: f.path,
              blobScope: f.blobScope,
              sha256: f.sha256,
              sizeBytes: f.sizeBytes,
              mimeType: f.mimeType,
              isText: f.isText,
              updatedAt: now,
            }),
          ),
        );
      }

      const [baselineVersion] = await tx
        .insert(projectVersions)
        .values(
          asInsert(projectVersions, {
            workspaceId: ctx.workspaceId,
            projectId: createdProject.id,
            versionNumber: 1,
            revision,
            source: 'baseline',
            summary: 'Initial project',
            requestId: input.requestId ?? null,
            pinned: false,
            createdAt: now,
          }),
        )
        .returning({ id: projectVersions.id });

      if (prepared.length > 0) {
        await tx.insert(projectVersionFiles).values(
          prepared.map((f) =>
            asInsert(projectVersionFiles, {
              versionId: baselineVersion.id,
              workspaceId: ctx.workspaceId,
              projectId: createdProject.id,
              path: f.path,
              blobScope: f.blobScope,
              sha256: f.sha256,
              sizeBytes: f.sizeBytes,
              mimeType: f.mimeType,
            }),
          ),
        );
      }

      await tx.insert(projectHistoryEntries).values(
        asInsert(projectHistoryEntries, {
          workspaceId: ctx.workspaceId,
          projectId: createdProject.id,
          seq: 1,
          versionId: baselineVersion.id,
          parentEntryId: null,
          actorKind: 'system',
          actorName: ctx.displayName?.trim() || 'system',
          label: 'Initial project',
          pinned: false,
          undone: false,
          startedAt: now,
          endedAt: now,
        }),
      );

      await tx
        .update(projects)
        .set(asUpdate(projects, { currentVersionId: baselineVersion.id }))
        .where(and(eq(projects.id, createdProject.id), eq(projects.workspaceId, ctx.workspaceId)));

      await tx
        .update(sessions)
        .set(asUpdate(sessions, { activeArtifactId: artifactId, openedAt: now, updatedAt: now }))
        .where(and(eq(sessions.id, sessionId), eq(sessions.workspaceId, ctx.workspaceId)));

      if (input.initialPrompt?.trim()) {
        const validated = validateInstruction(input.initialPrompt);
        await tx.insert(sessionMessages).values(
          asInsert(sessionMessages, {
            id: randomUUID(),
            workspaceId: ctx.workspaceId,
            sessionId,
            role: 'user',
            content: validated,
            createdAt: now,
          }),
        );
      }

      let activeProjectId = createdProject.id;
      if (input.selectActive !== false) {
        await tx
          .update(workspaces)
          .set(
            asUpdate(workspaces, {
              activeProjectId: createdProject.id,
              activeSessionId: sessionId,
              updatedAt: now,
            }),
          )
          .where(eq(workspaces.id, ctx.workspaceId));
      } else {
        const [ws] = await tx
          .select({ activeProjectId: workspaces.activeProjectId })
          .from(workspaces)
          .where(eq(workspaces.id, ctx.workspaceId));
        activeProjectId = ws?.activeProjectId ?? createdProject.id;
      }

      const payload: CreatedProjectResult = {
        projectId: createdProject.id,
        sessionId,
        artifactId,
        title,
        revision,
        versionId: baselineVersion.id,
        versionNumber: 1,
        historySeq: 1,
        activeProjectId,
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
              resourceId: createdProject.id,
              responsePayload: payload as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
            set: asUpdate(idempotencyReceipts, {
              state: 'completed',
              resourceId: createdProject.id,
              responsePayload: payload as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          });
      }

      return payload;
    });

    if (!result.replayed && this.hotTextCache) {
      for (const [sha256, upload] of toUpload) {
        if (upload.textContent !== undefined) {
          void this.hotTextCache.setText(sha256, upload.textContent).catch(() => {});
        }
      }
    }

    if (!result.replayed) this.onCatalogChange?.(ctx.workspaceId);
    return result;
  }

  /** Set a non-trashed project as active in the workspace and session. */
  async selectProject(ctx: AuthContext, projectId: string, sourceProjectId?: string): Promise<ProjectSummaryDetail> {
    const updated = await this.db.transaction(async (tx) => {
      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: false,
        forUpdate: true,
        auth: ctx,
      });
      if (sourceProjectId !== undefined && sourceProjectId !== project.id) {
        await loadProjectOrThrow(tx, ctx.workspaceId, sourceProjectId, { auth: ctx, allowTrashed: true });
      }
      const now = new Date();
      const [row] = await tx
        .update(projects)
        .set(asUpdate(projects, { openedAt: now, updatedAt: now }))
        .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)))
        .returning();

      await tx
        .update(sessions)
        .set(asUpdate(sessions, { activeArtifactId: project.artifactId, openedAt: now, updatedAt: now }))
        .where(and(eq(sessions.id, project.sessionId), eq(sessions.workspaceId, ctx.workspaceId)));

      await tx
        .update(workspaces)
        .set(asUpdate(workspaces, { activeProjectId: project.id, activeSessionId: project.sessionId, updatedAt: now }))
        .where(eq(workspaces.id, ctx.workspaceId));

      return row;
    });
    return toProjectSummaryDetail(updated);
  }

  /** Rename a project with optional `expectedTitle` concurrency check & `requestId` idempotency. */
  async renameProject(
    ctx: AuthContext,
    projectId: string,
    input: { title: string; expectedTitle?: string; requestId?: string },
  ): Promise<ProjectMutationResult> {
    const nextTitle = safeTitle(input.title);
    const scope = 'project:rename';
    const inputHash = input.requestId
      ? canonicalInputHash({ projectId, title: nextTitle, expectedTitle: input.expectedTitle ?? null })
      : null;

    const result: ProjectMutationResult = await this.db.transaction(async (tx) => {
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
            throw new CloudError('REQUEST_ID_CONFLICT', 'requestId conflict on renameProject.', {
              status: 409,
              applied: false,
            });
          }
          if (receipt.state === 'completed' && receipt.responsePayload) {
            return { ...(receipt.responsePayload as unknown as ProjectMutationResult), replayed: true };
          }
        }
      }

      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: false,
        forUpdate: true,
        auth: ctx,
      });

      if (input.expectedTitle !== undefined && project.title !== input.expectedTitle) {
        throw new CloudError(
          'VERSION_CONFLICT',
          `Project title changed from "${input.expectedTitle}" to "${project.title}".`,
          { status: 409, applied: false, details: { currentTitle: project.title } },
        );
      }

      const now = new Date();
      await tx
        .update(projects)
        .set(asUpdate(projects, { title: nextTitle, titleKey: null, updatedAt: now }))
        .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));

      // If this session has only one project, keep the session title aligned.
      const siblings = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.sessionId, project.sessionId)));
      if (siblings.length <= 1) {
        await tx
          .update(sessions)
          .set(asUpdate(sessions, { title: nextTitle, updatedAt: now }))
          .where(and(eq(sessions.id, project.sessionId), eq(sessions.workspaceId, ctx.workspaceId)));
      }

      const [ws] = await tx
        .select({ activeProjectId: workspaces.activeProjectId })
        .from(workspaces)
        .where(eq(workspaces.id, ctx.workspaceId));

      const mutation: ProjectMutationResult = {
        projectId: project.id,
        title: nextTitle,
        activeProjectId: ws?.activeProjectId ?? project.id,
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
              resourceId: project.id,
              responsePayload: mutation as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
            set: asUpdate(idempotencyReceipts, {
              state: 'completed',
              resourceId: project.id,
              responsePayload: mutation as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          });
      }

      return mutation;
    });
    if (!result.replayed) this.onCatalogChange?.(ctx.workspaceId);
    return result;
  }

  /** Soft-trash a project (refuses trashing the last remaining active project in the workspace). */
  async trashProject(
    ctx: AuthContext,
    projectId: string,
    input: { requestId?: string; allowLastActive?: boolean } = {},
  ): Promise<ProjectMutationResult> {
    const scope = 'project:trash';
    const inputHash = input.requestId ? canonicalInputHash({ projectId, action: 'trash' }) : null;

    const result: ProjectMutationResult = await this.db.transaction(async (tx) => {
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
            throw new CloudError('REQUEST_ID_CONFLICT', 'requestId conflict on trashProject.', {
              status: 409,
              applied: false,
            });
          }
          if (receipt.state === 'completed' && receipt.responsePayload) {
            return { ...(receipt.responsePayload as unknown as ProjectMutationResult), replayed: true };
          }
        }
      }

      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: true,
        forUpdate: true,
        auth: ctx,
      });

      const activeProjects = await tx
        .select({ id: projects.id, sessionId: projects.sessionId })
        .from(projects)
        .where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.trashed, false)))
        .orderBy(desc(projects.openedAt));

      const others = activeProjects.filter((p) => p.id !== project.id);
      if (!project.trashed && others.length === 0 && !input.allowLastActive) {
        throw new CloudError('INVALID_ARGUMENT', 'Cannot move the last active project to trash.', {
          status: 400,
          applied: false,
          details: { code: 'LAST_ACTIVE_PROJECT' },
        });
      }

      const now = new Date();
      if (!project.trashed) {
        await tx
          .update(projects)
          .set(asUpdate(projects, { trashed: true, trashedAt: now, updatedAt: now }))
          .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));
      }

      const nextActive = others[0] ?? null;
      const [ws] = await tx
        .select({ activeProjectId: workspaces.activeProjectId })
        .from(workspaces)
        .where(eq(workspaces.id, ctx.workspaceId));

      let activeProjectId = ws?.activeProjectId ?? '';
      if (activeProjectId === project.id || !activeProjectId) {
        activeProjectId = nextActive?.id ?? '';
        await tx
          .update(workspaces)
          .set(
            asUpdate(workspaces, {
              activeProjectId: nextActive?.id ?? null,
              activeSessionId: nextActive?.sessionId ?? null,
              updatedAt: now,
            }),
          )
          .where(eq(workspaces.id, ctx.workspaceId));
      }

      const mutation: ProjectMutationResult = {
        projectId: project.id,
        title: project.title,
        trashed: true,
        activeProjectId,
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
              resourceId: project.id,
              responsePayload: mutation as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
            set: asUpdate(idempotencyReceipts, {
              state: 'completed',
              resourceId: project.id,
              responsePayload: mutation as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          });
      }

      return mutation;
    });
    if (!result.replayed) this.onCatalogChange?.(ctx.workspaceId);
    return result;
  }

  /** Restore a project from trash (`trashed = false, trashedAt = null`). */
  async restoreProject(
    ctx: AuthContext,
    projectId: string,
    input: { requestId?: string } = {},
  ): Promise<ProjectMutationResult> {
    const scope = 'project:restore-trash';
    const inputHash = input.requestId ? canonicalInputHash({ projectId, action: 'restore' }) : null;

    const result: ProjectMutationResult = await this.db.transaction(async (tx) => {
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
            throw new CloudError('REQUEST_ID_CONFLICT', 'requestId conflict on restoreProject.', {
              status: 409,
              applied: false,
            });
          }
          if (receipt.state === 'completed' && receipt.responsePayload) {
            return { ...(receipt.responsePayload as unknown as ProjectMutationResult), replayed: true };
          }
        }
      }

      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: true,
        forUpdate: true,
        auth: ctx,
      });

      const now = new Date();
      if (project.trashed) {
        await tx
          .update(projects)
          .set(asUpdate(projects, { trashed: false, trashedAt: null, updatedAt: now }))
          .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));
      }

      const [ws] = await tx
        .select({ activeProjectId: workspaces.activeProjectId })
        .from(workspaces)
        .where(eq(workspaces.id, ctx.workspaceId));
      const activeProjectId = ws?.activeProjectId ?? project.id;

      const mutation: ProjectMutationResult = {
        projectId: project.id,
        title: project.title,
        trashed: false,
        activeProjectId,
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
              resourceId: project.id,
              responsePayload: mutation as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
            set: asUpdate(idempotencyReceipts, {
              state: 'completed',
              resourceId: project.id,
              responsePayload: mutation as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          });
      }

      return mutation;
    });
    if (!result.replayed) this.onCatalogChange?.(ctx.workspaceId);
    return result;
  }

  /**
   * Permanently delete a trashed project in ONE PostgreSQL transaction:
   * 1. Aggregates ALL `blob_scope = 'workspace'` refs across BOTH `project_files` AND `project_version_files`.
   * 2. Deletes the `projects` row (cascading files, versions, version files, history, work rounds).
   * 3. Atomically decrements `workspace_blobs.ref_count` in sorted `sha256` order via `applyWorkspaceBlobRefDeltas`.
   * 4. Prunes orphaned empty sessions and clears stale `workspaces.active_project_id`.
   */
  async deleteProjectPermanently(
    ctx: AuthContext,
    projectId: string,
    input: { requestId?: string } = {},
  ): Promise<ProjectMutationResult & { decrementedBlobRefs: number }> {
    const scope = 'project:delete';
    const inputHash = input.requestId ? canonicalInputHash({ projectId, action: 'delete' }) : null;

    const result: ProjectMutationResult & { decrementedBlobRefs: number } = await this.db.transaction(async (tx) => {
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
            throw new CloudError('REQUEST_ID_CONFLICT', 'requestId conflict on deleteProjectPermanently.', {
              status: 409,
              applied: false,
            });
          }
          if (receipt.state === 'completed' && receipt.responsePayload) {
            return {
              ...(receipt.responsePayload as unknown as ProjectMutationResult & { decrementedBlobRefs: number }),
              replayed: true,
            };
          }
        }
      }

      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: true,
        forUpdate: true,
        auth: ctx,
      });

      if (!project.trashed) {
        throw new CloudError(
          'INVALID_ARGUMENT',
          'Project must be moved to trash before permanent deletion.',
          { status: 400, applied: false, details: { code: 'PROJECT_NOT_TRASHED' } },
        );
      }

      // Aggregate every workspace-scoped blob reference across live files and every historical version snapshot.
      const liveRefs = await tx
        .select({ sha256: projectFiles.sha256 })
        .from(projectFiles)
        .where(
          and(
            eq(projectFiles.workspaceId, ctx.workspaceId),
            eq(projectFiles.projectId, project.id),
            eq(projectFiles.blobScope, 'workspace'),
          ),
        );

      const versionRefs = await tx
        .select({ sha256: projectVersionFiles.sha256 })
        .from(projectVersionFiles)
        .where(
          and(
            eq(projectVersionFiles.workspaceId, ctx.workspaceId),
            eq(projectVersionFiles.projectId, project.id),
            eq(projectVersionFiles.blobScope, 'workspace'),
          ),
        );

      const countsBySha = new Map<string, number>();
      for (const row of liveRefs) {
        const sha = row.sha256.trim();
        countsBySha.set(sha, (countsBySha.get(sha) ?? 0) + 1);
      }
      for (const row of versionRefs) {
        const sha = row.sha256.trim();
        countsBySha.set(sha, (countsBySha.get(sha) ?? 0) + 1);
      }

      const negativeDeltas: BlobRefDelta[] = [...countsBySha.entries()].map(([sha256, count]) => ({
        sha256,
        delta: -count,
      }));
      const totalDecremented = [...countsBySha.values()].reduce((sum, n) => sum + n, 0);

      // Delete project row (cascades project_files, project_versions, project_version_files, history, work_rounds).
      await tx
        .delete(projects)
        .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));

      // Decrement workspace_blobs refcounts in deterministic sorted sha256 order.
      if (negativeDeltas.length > 0) {
        await applyWorkspaceBlobRefDeltas(tx, ctx.workspaceId, negativeDeltas);
      }

      // Prune orphaned session if it has no remaining projects.
      const remainingInSession = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.sessionId, project.sessionId)))
        .limit(1);
      if (remainingInSession.length === 0) {
        await tx
          .delete(sessions)
          .where(and(eq(sessions.id, project.sessionId), eq(sessions.workspaceId, ctx.workspaceId)));
      }

      const remainingActive = await tx
        .select({ id: projects.id, sessionId: projects.sessionId })
        .from(projects)
        .where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.trashed, false)))
        .orderBy(desc(projects.openedAt))
        .limit(1);

      const [ws] = await tx
        .select({ activeProjectId: workspaces.activeProjectId })
        .from(workspaces)
        .where(eq(workspaces.id, ctx.workspaceId));

      let activeProjectId = ws?.activeProjectId ?? '';
      if (!activeProjectId || activeProjectId === project.id) {
        activeProjectId = remainingActive[0]?.id ?? '';
        await tx
          .update(workspaces)
          .set(
            asUpdate(workspaces, {
              activeProjectId: remainingActive[0]?.id ?? null,
              activeSessionId: remainingActive[0]?.sessionId ?? null,
              updatedAt: new Date(),
            }),
          )
          .where(eq(workspaces.id, ctx.workspaceId));
      }

      const mutation = {
        projectId: project.id,
        title: project.title,
        deleted: true,
        activeProjectId,
        decrementedBlobRefs: totalDecremented,
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
              resourceId: null,
              responsePayload: mutation as unknown as Record<string, unknown>,
              updatedAt: new Date(),
            }),
          )
          .onConflictDoUpdate({
            target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
            set: asUpdate(idempotencyReceipts, {
              state: 'completed',
              resourceId: null,
              responsePayload: mutation as unknown as Record<string, unknown>,
              updatedAt: new Date(),
            }),
          });
      }

      return mutation;
    });
    if (!result.replayed) this.onCatalogChange?.(ctx.workspaceId);
    return result;
  }

  /** Record Studio preview display metadata on the project row. */
  async recordPreviewDisplay(
    ctx: AuthContext,
    projectId: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; projectId: string; previewDisplay: Record<string, unknown> }> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: false, auth: ctx });
    const merged = {
      ...(project.previewDisplay ?? {}),
      ...payload,
      updatedAt: new Date().toISOString(),
    };
    await this.db
      .update(projects)
      .set(asUpdate(projects, { previewDisplay: merged, updatedAt: new Date() }))
      .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));
    return { ok: true, projectId: project.id, previewDisplay: merged };
  }

  /** Append a review record to `projects.reviews`. */
  async recordReview(
    ctx: AuthContext,
    projectId: string,
    review: Record<string, unknown>,
  ): Promise<{ ok: true; projectId: string; reviews: unknown[] }> {
    return this.db.transaction(async (tx) => {
      const project = await loadProjectOrThrow(tx, ctx.workspaceId, projectId, {
        allowTrashed: false,
        forUpdate: true,
        auth: ctx,
      });
      const existing = Array.isArray(project.reviews) ? project.reviews : [];
      const next = [
        ...existing,
        {
          id: randomUUID(),
          ...review,
          createdAt: new Date().toISOString(),
        },
      ].slice(-100);
      await tx
        .update(projects)
        .set(asUpdate(projects, { reviews: next, updatedAt: new Date() }))
        .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));
      return { ok: true, projectId: project.id, reviews: next };
    });
  }

  /** Unified project management dispatcher (`openmotion_manage_project`). */
  async manageProject(
    ctx: AuthContext,
    input: {
      action: 'rename' | 'trash' | 'restore' | 'delete' | 'reveal' | 'comments';
      projectId: string;
      title?: string;
      expectedTitle?: string;
      requestId?: string;
    },
  ): Promise<ProjectMutationResult> {
    if (input.action === 'reveal') {
      throw new CloudError(
        'INVALID_ARGUMENT',
        'REVEAL_UNAVAILABLE: Local folder reveal is unavailable in cloud container mode.',
        { status: 400, applied: false, details: { code: 'REVEAL_UNAVAILABLE' } },
      );
    }
    if (input.action === 'comments') {
      throw featureDeferredP2('project_comments');
    }
    if (input.action === 'rename') {
      return this.renameProject(ctx, input.projectId, {
        title: input.title ?? '',
        expectedTitle: input.expectedTitle,
        requestId: input.requestId,
      });
    }
    if (input.action === 'trash') {
      return this.trashProject(ctx, input.projectId, { requestId: input.requestId });
    }
    if (input.action === 'restore') {
      return this.restoreProject(ctx, input.projectId, { requestId: input.requestId });
    }
    return this.deleteProjectPermanently(ctx, input.projectId, { requestId: input.requestId });
  }

  // -------------------------------------------------------------------------
  // Sessions & Messages
  // -------------------------------------------------------------------------

  async listSessions(ctx: AuthContext): Promise<CreativeSession[]> {
    const catalog = await this.getCatalog(ctx);
    return catalog.sessions ?? [];
  }

  async getSession(ctx: AuthContext, sessionId: string): Promise<SessionDetail> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(sessionId, 'sessionId');

    const [sess] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspaceId, ctx.workspaceId), eq(sessions.id, sessionId)));
    if (!sess) {
      throw new CloudError('SESSION_NOT_FOUND', `Session ${sessionId} was not found.`, {
        status: 404,
        applied: false,
      });
    }

    const sessionProjectRows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.sessionId, sess.id)))
      .orderBy(asc(projects.createdAt));
    const agentFilter = await agentProjectFilter(this.db, ctx);
    const projRows = agentFilter ? sessionProjectRows.filter(agentFilter) : sessionProjectRows;
    // The conversation belongs to its projects: agents need a grant on at least one of them.
    if (agentFilter && sessionProjectRows.length > 0 && projRows.length === 0) throw sessionNotFound(sessionId);

    const msgRows = await this.db
      .select()
      .from(sessionMessages)
      .where(and(eq(sessionMessages.workspaceId, ctx.workspaceId), eq(sessionMessages.sessionId, sess.id)))
      .orderBy(asc(sessionMessages.createdAt));

    const activeArtifacts = projRows
      .filter((p) => !p.trashed)
      .map(projectArtifact);
    const activeArtifactId =
      agentFilter && !activeArtifacts.some((a) => a.id === sess.activeArtifactId)
        ? activeArtifacts[0]?.id
        : sess.activeArtifactId;

    return {
      id: sess.id,
      title: sess.title,
      mode: 'motion',
      artifacts: activeArtifacts,
      ...(activeArtifactId ? { activeArtifactId } : {}),
      createdAt: sess.createdAt.getTime(),
      openedAt: sess.openedAt.getTime(),
      ...(sess.templateId ? { templateId: sess.templateId } : {}),
      messages: msgRows.map(toSessionMessage),
    };
  }

  async createSession(
    ctx: AuthContext,
    input: { id?: string; title?: string; mode?: string; templateId?: string | null; prompt?: string; instruction?: string } = {},
  ): Promise<SessionDetail> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    try {
      creationMode(input.mode ?? 'motion');
    } catch (error) {
      throw new CloudError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Unsupported creation mode.', {
        status: 400,
        applied: false,
      });
    }

    const requestedId = typeof input.id === 'string' && isUuid(input.id) ? input.id : undefined;
    const promptText = input.prompt ?? input.instruction;
    const title = safeTitle(input.title, DEFAULT_SESSION_TITLE);
    const now = new Date();
    const sessionId = await this.db.transaction(async (tx) => {
      if (requestedId) {
        const existing = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.workspaceId, ctx.workspaceId), eq(sessions.id, requestedId)))
          .limit(1);
        if (existing[0]) {
          return existing[0].id;
        }
      }

      const [sess] = await tx
        .insert(sessions)
        .values(
          asInsert(sessions, {
            ...(requestedId ? { id: requestedId } : {}),
            workspaceId: ctx.workspaceId,
            title,
            mode: 'motion',
            templateId: input.templateId ?? null,
            createdAt: now,
            openedAt: now,
            updatedAt: now,
          }),
        )
        .returning({ id: sessions.id });

      if (promptText?.trim()) {
        const content = validateInstruction(promptText);
        await tx.insert(sessionMessages).values(
          asInsert(sessionMessages, {
            id: randomUUID(),
            workspaceId: ctx.workspaceId,
            sessionId: sess.id,
            role: 'user',
            content,
            createdAt: now,
          }),
        );
      }

      await tx
        .update(workspaces)
        .set(asUpdate(workspaces, { activeSessionId: sess.id, updatedAt: now }))
        .where(eq(workspaces.id, ctx.workspaceId));

      return sess.id;
    });

    this.onCatalogChange?.(ctx.workspaceId);
    return this.getSession(ctx, sessionId);
  }

  async renameSession(ctx: AuthContext, sessionId: string, title: string): Promise<SessionDetail> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(sessionId, 'sessionId');
    await assertAgentSessionAccess(this.db, ctx, sessionId);
    const clean = safeTitle(title);

    const rows = await this.db
      .update(sessions)
      .set(asUpdate(sessions, { title: clean, updatedAt: new Date() }))
      .where(and(eq(sessions.workspaceId, ctx.workspaceId), eq(sessions.id, sessionId)))
      .returning({ id: sessions.id });

    if (!rows[0]) {
      throw new CloudError('SESSION_NOT_FOUND', `Session ${sessionId} was not found.`, {
        status: 404,
        applied: false,
      });
    }
    this.onCatalogChange?.(ctx.workspaceId);
    return this.getSession(ctx, sessionId);
  }

  async openSession(ctx: AuthContext, sessionId: string, projectId?: string): Promise<SessionDetail> {
    await this.activateSession(ctx, sessionId, projectId);
    return this.getSession(ctx, sessionId);
  }

  async openSessionForEditor(ctx: AuthContext, sessionId: string, projectId?: string, sourceProjectId?: string) {
    const selected = await this.activateSession(ctx, sessionId, projectId, { sourceProjectId });
    return { projectId: selected?.id ?? '', sessionId, artifact: selected ? projectArtifact(selected) : null };
  }

  private async activateSession(ctx: AuthContext, sessionId: string, projectId?: string, editor?: { sourceProjectId?: string }) {
    if (editor && projectId !== undefined) assertValidUuid(projectId, 'projectId');
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(sessionId, 'sessionId');

    return this.db.transaction(async (tx) => {
      const [sess] = await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.workspaceId, ctx.workspaceId), eq(sessions.id, sessionId)))
        .for('update');
      if (!sess) {
        throw new CloudError('SESSION_NOT_FOUND', `Session ${sessionId} was not found.`, {
          status: 404,
          applied: false,
        });
      }

      const projRows = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, ctx.workspaceId),
            eq(projects.sessionId, sess.id),
            eq(projects.trashed, false),
            editor && projectId ? eq(projects.id, projectId) : undefined,
          ),
        )
        .orderBy(desc(projects.openedAt));

      // Agents never get an ungranted project chosen for them; one they name still fails its grant check.
      const agentFilter = await agentProjectFilter(tx, ctx);
      if (agentFilter && projectId === undefined) await assertAgentSessionAccess(tx, ctx, sess.id);
      const candidates = agentFilter ? projRows.filter(agentFilter) : projRows;
      const activeProj =
        (projectId ? projRows.find((p) => p.id === projectId) : undefined) ??
        candidates.find((p) => p.artifactId === sess.activeArtifactId) ??
        candidates[0] ??
        null;
      if (!editor && agentFilter && activeProj) await assertAgentProjectAccess(tx, ctx, activeProj);
      if (editor) {
        if (projectId !== undefined && activeProj?.id !== projectId) {
          throw new CloudError('PROJECT_NOT_FOUND', 'Project is unavailable in this session.', { status: 404, applied: false });
        }
        if (activeProj) await assertAgentProjectAccess(tx, ctx, activeProj);
        if (editor.sourceProjectId !== undefined && editor.sourceProjectId !== activeProj?.id) {
          await loadProjectOrThrow(tx, ctx.workspaceId, editor.sourceProjectId, { auth: ctx, allowTrashed: true });
        }
      }
      const now = new Date();

      await tx
        .update(sessions)
        .set(
          asUpdate(sessions, {
            openedAt: now,
            updatedAt: now,
            ...(activeProj ? { activeArtifactId: activeProj.artifactId } : {}),
          }),
        )
        .where(and(eq(sessions.workspaceId, ctx.workspaceId), eq(sessions.id, sess.id)));

      await tx
        .update(workspaces)
        .set(
          asUpdate(workspaces, {
            activeSessionId: sess.id,
            ...(activeProj ? { activeProjectId: activeProj.id } : {}),
            updatedAt: now,
          }),
        )
        .where(eq(workspaces.id, ctx.workspaceId));
      return activeProj;
    });
  }

  async listProjectConversation(ctx: AuthContext, projectId: string): Promise<{ projectId: string; messages: SessionMessage[] }> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, { allowTrashed: true, auth: ctx });
    const rows = await this.db
      .select()
      .from(sessionMessages)
      .where(and(eq(sessionMessages.workspaceId, ctx.workspaceId), eq(sessionMessages.sessionId, project.sessionId)))
      .orderBy(asc(sessionMessages.createdAt));
    return {
      projectId: project.id,
      messages: rows.map(toSessionMessage),
    };
  }

  /**
   * Append a message to a session (idempotent on caller-provided UUID `id`, capped at 200 messages).
   */
  async appendMessage(
    ctx: AuthContext,
    sessionId: string,
    input: { id?: string; role?: SessionMessageRole; content: string },
  ): Promise<{ message: SessionMessage; messages: SessionMessage[]; replayed: boolean }> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(sessionId, 'sessionId');
    await assertAgentSessionAccess(this.db, ctx, sessionId);

    const role: SessionMessageRole = input.role === 'assistant' ? 'assistant' : 'user';
    let cleanContent: string;
    try {
      cleanContent = validateInstruction(input.content);
    } catch (error) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        error instanceof Error ? error.message : 'Message content must be 1–8000 characters.',
        { status: 400, applied: false },
      );
    }

    const messageId = input.id && isUuid(input.id) ? input.id : randomUUID();

    return this.db.transaction(async (tx) => {
      const [sess] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.workspaceId, ctx.workspaceId), eq(sessions.id, sessionId)))
        .for('update');
      if (!sess) {
        throw new CloudError('SESSION_NOT_FOUND', `Session ${sessionId} was not found.`, {
          status: 404,
          applied: false,
        });
      }

      const existing = await tx
        .select()
        .from(sessionMessages)
        .where(
          and(
            eq(sessionMessages.workspaceId, ctx.workspaceId),
            eq(sessionMessages.sessionId, sessionId),
            eq(sessionMessages.id, messageId),
          ),
        );

      let replayed = false;
      let savedRow = existing[0];
      const now = new Date();

      if (savedRow) {
        replayed = true;
      } else {
        const [inserted] = await tx
          .insert(sessionMessages)
          .values(
            asInsert(sessionMessages, {
              id: messageId,
              workspaceId: ctx.workspaceId,
              sessionId,
              role,
              content: cleanContent,
              createdAt: now,
            }),
          )
          .returning();
        savedRow = inserted;

        await tx
          .update(sessions)
          .set(asUpdate(sessions, { updatedAt: now }))
          .where(and(eq(sessions.workspaceId, ctx.workspaceId), eq(sessions.id, sessionId)));
      }

      // Enforce 200-message cap per session (oldest pruned first).
      const allRows = await tx
        .select()
        .from(sessionMessages)
        .where(and(eq(sessionMessages.workspaceId, ctx.workspaceId), eq(sessionMessages.sessionId, sessionId)))
        .orderBy(asc(sessionMessages.createdAt));

      let kept = allRows;
      if (allRows.length > MAX_SESSION_MESSAGES) {
        const overflow = allRows.slice(0, allRows.length - MAX_SESSION_MESSAGES);
        await tx
          .delete(sessionMessages)
          .where(
            and(
              eq(sessionMessages.workspaceId, ctx.workspaceId),
              inArray(
                sessionMessages.id,
                overflow.map((m) => m.id),
              ),
            ),
          );
        kept = allRows.slice(allRows.length - MAX_SESSION_MESSAGES);
      }

      return {
        message: toSessionMessage(savedRow),
        messages: kept.map(toSessionMessage),
        replayed,
      };
    });
  }
}
