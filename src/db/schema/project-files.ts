import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { TextPatch } from '../../../shared/text-patch.ts';
import type { BlobScope } from '../../contracts/storage.ts';
import { workspaces } from './auth.ts';
import { projects } from './projects.ts';

export type ProjectVersionSource = 'baseline' | 'agent' | 'studio' | 'restore';
export type HistoryActorKind = 'user' | 'agent' | 'system';

/**
 * Each path references immutable content. Workspace/catalog references hold SHA-256 digests.
 * A patch reference holds the logical ID of a project_text_revisions row.
 */
export const projectFiles = pgTable(
  'project_files',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: varchar('path', { length: 240 }).notNull(),
    blobScope: varchar('blob_scope', { length: 16 }).$type<BlobScope>().notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    isText: boolean('is_text').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_project_files', columns: [t.projectId, t.path] }),
    index('idx_project_files_workspace_project').on(t.workspaceId, t.projectId),
    index('idx_project_files_workspace_sha')
      .on(t.workspaceId, t.sha256)
      .where(sql`${t.blobScope} = 'workspace'`),
    check('chk_project_files_blob_scope', sql`${t.blobScope} IN ('workspace', 'catalog') OR (${t.blobScope} = 'patch' AND ${t.isText})`),
    check('chk_project_files_size_nonneg', sql`${t.sizeBytes} >= 0`),
  ],
);

export const projectVersions = pgTable(
  'project_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    revision: char('revision', { length: 64 }).notNull(),
    source: varchar('source', { length: 32 }).$type<ProjectVersionSource>().notNull(),
    summary: varchar('summary', { length: 256 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    restoredFromVersionId: uuid('restored_from_version_id').references(
      (): AnyPgColumn => projectVersions.id,
      { onDelete: 'set null' },
    ),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_project_versions_number').on(t.projectId, t.versionNumber),
    uniqueIndex('uq_project_versions_request')
      .on(t.workspaceId, t.projectId, t.requestId)
      .where(sql`${t.requestId} IS NOT NULL`),
    index('idx_project_versions_list').on(t.projectId, t.versionNumber.desc()),
    check('chk_project_versions_number', sql`${t.versionNumber} >= 1`),
    check('chk_project_versions_source', sql`${t.source} IN ('baseline', 'agent', 'studio', 'restore')`),
  ],
);

export const projectVersionFiles = pgTable(
  'project_version_files',
  {
    versionId: uuid('version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    path: varchar('path', { length: 240 }).notNull(),
    blobScope: varchar('blob_scope', { length: 16 }).$type<BlobScope>().notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_project_version_files', columns: [t.versionId, t.path] }),
    index('idx_project_version_files_workspace_sha')
      .on(t.workspaceId, t.sha256)
      .where(sql`${t.blobScope} = 'workspace'`),
    index('idx_project_version_files_project').on(t.projectId),
    index('idx_project_version_files_path_version').on(t.projectId, t.path, t.sha256),
    check('chk_project_version_files_blob_scope', sql`${t.blobScope} IN ('workspace', 'catalog', 'patch')`),
    check('chk_project_version_files_size_nonneg', sql`${t.sizeBytes} >= 0`),
  ],
);

export const projectHistoryEntries = pgTable(
  'project_history_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    parentEntryId: uuid('parent_entry_id').references((): AnyPgColumn => projectHistoryEntries.id, {
      onDelete: 'set null',
    }),
    actorKind: varchar('actor_kind', { length: 16 }).$type<HistoryActorKind>().notNull(),
    actorName: varchar('actor_name', { length: 128 }).notNull(),
    label: varchar('label', { length: 256 }).notNull(),
    windowId: uuid('window_id'),
    undoGroup: varchar('undo_group', { length: 73 }),
    pinned: boolean('pinned').notNull().default(false),
    undone: boolean('undone').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_project_history_seq').on(t.projectId, t.seq),
    index('idx_project_history_active').on(t.projectId, t.undone, t.seq.desc()),
    index('idx_project_history_window')
      .on(t.projectId, t.windowId)
      .where(sql`${t.windowId} IS NOT NULL`),
    check('chk_project_history_seq', sql`${t.seq} >= 1`),
    check('chk_project_history_actor', sql`${t.actorKind} IN ('user', 'agent', 'system')`),
  ],
);

export const projectTextRevisions = pgTable('project_text_revisions', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  id: char('id', { length: 64 }).notNull(),
  parentScope: varchar('parent_scope', { length: 16 }).notNull().$type<BlobScope>(),
  parentId: char('parent_id', { length: 64 }).notNull(),
  patch: jsonb('patch').notNull().$type<TextPatch>(),
  sizeBytes: integer('size_bytes').notNull(),
  mimeType: varchar('mime_type', { length: 128 }).default('application/octet-stream').notNull(),
  depth: integer('depth').notNull(),
  chainPatchBytes: integer('chain_patch_bytes').notNull(),
  checkpointSha: char('checkpoint_sha', { length: 64 }),
  checkpointPendingSha: char('checkpoint_pending_sha', { length: 64 }),
  checkpointDueAt: timestamp('checkpoint_due_at', { withTimezone: true }),
}, t => [
  primaryKey({ columns: [t.workspaceId, t.id] }),
  index('idx_text_revisions_origin').on(t.projectId),
  index('idx_text_revisions_checkpoint_pending').on(t.workspaceId, t.checkpointPendingSha).where(sql`${t.checkpointPendingSha} IS NOT NULL`),
  index('idx_text_revisions_checkpoint_due').on(t.checkpointDueAt)
    .where(sql`${t.checkpointDueAt} IS NOT NULL AND ${t.checkpointSha} IS NULL`),
  index('idx_text_revisions_workspace_base').on(t.workspaceId, t.parentId).where(sql`${t.parentScope} = 'workspace'`),
  index('idx_text_revisions_checkpoint').on(t.workspaceId, t.checkpointSha).where(sql`${t.checkpointSha} IS NOT NULL`),
  check('project_text_revisions_parent_scope_check', sql`${t.parentScope} IN ('workspace','catalog','patch')`),
  check('project_text_revisions_size_bytes_check', sql`${t.sizeBytes} BETWEEN 0 AND 16777216`),
  check('project_text_revisions_depth_check', sql`${t.depth} >= 1`),
  check('project_text_revisions_chain_patch_bytes_check', sql`${t.chainPatchBytes} >= 1`),
]);
