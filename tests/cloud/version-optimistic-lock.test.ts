import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { AuthContext } from '../../src/contracts/auth.ts';
import { isCloudError } from '../../src/contracts/errors.ts';
import type { RenderWorkerHealth } from '../../src/contracts/events.ts';
import type {
  HeadObjectResult,
  ObjectStreamResult,
  PresignGetOptions,
  PresignPutOptions,
  StoragePort,
} from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import * as schema from '../../src/db/schema/index.ts';
import { AssetNamesService } from '../../src/services/asset-names-service.ts';
import { ProjectArchiveService } from '../../src/services/project-archive-service.ts';
import {
  ProjectFilesService,
  type HotTextCachePort,
} from '../../src/services/project-files-service.ts';
import { VersionHistoryService } from '../../src/services/version-history-service.ts';
import { WorkRoundsService } from '../../src/services/work-rounds-service.ts';
import { WorkspaceService } from '../../src/services/workspace-service.ts';
import type { StudioEventBusPort, StudioQueuesPort } from '../../src/studio/context.ts';
import { sha256Hex } from '../../src/studio/etag.ts';
import { computeProjectRevision } from '../../shared/project-validation.ts';

// ---------------------------------------------------------------------------
// Deterministic In-Memory PostgreSQL Driver for Real Drizzle ORM Execution
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const UUID_DEFAULT_TABLES = new Set([
  'workspaces',
  'sessions',
  'projects',
  'work_rounds',
  'project_versions',
  'project_history_entries',
  'jobs',
]);

class InMemoryPgClient {
  readonly tables = new Map<string, Row[]>();
  readonly trace: string[] = [];
  readonly blobLockOrder: string[] = [];
  private txSnapshot: Map<string, Row[]> | null = null;

  constructor() {
    for (const name of [
      'workspaces',
      'sessions',
      'session_messages',
      'projects',
      'work_rounds',
      'project_files',
      'project_versions',
      'project_version_files',
      'project_history_entries',
      'workspace_blobs',
      'catalog_templates',
      'catalog_template_files',
      'jobs',
      'idempotency_receipts',
    ]) {
      this.tables.set(name, []);
    }
  }

  seed(table: string, row: Row): void {
    const list = this.tables.get(table) ?? [];
    list.push({ ...row });
    this.tables.set(table, list);
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  private cloneTables(): Map<string, Row[]> {
    const snap = new Map<string, Row[]>();
    for (const [name, list] of this.tables) {
      snap.set(
        name,
        list.map((row) => structuredClone(row)),
      );
    }
    return snap;
  }

  async query(config: string | { text: string; rowMode?: string }, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const rawText = typeof config === 'string' ? config : config.text;
    const rowMode = typeof config === 'string' ? undefined : config.rowMode;
    const sqlText = rawText.trim();
    const upper = sqlText.toUpperCase();

    if (upper === 'BEGIN' || upper.startsWith('BEGIN ')) {
      this.trace.push('SQL:BEGIN');
      this.txSnapshot = this.cloneTables();
      return { rows: [] };
    }
    if (upper === 'COMMIT') {
      this.trace.push('SQL:COMMIT');
      this.txSnapshot = null;
      return { rows: [] };
    }
    if (upper === 'ROLLBACK') {
      this.trace.push('SQL:ROLLBACK');
      if (this.txSnapshot) {
        this.tables.clear();
        for (const [k, v] of this.txSnapshot) this.tables.set(k, v);
        this.txSnapshot = null;
      }
      return { rows: [] };
    }

    if (upper.startsWith('SELECT ')) {
      return this.execSelect(sqlText, params, rowMode);
    }
    if (upper.startsWith('INSERT INTO ')) {
      return this.execInsert(sqlText, params, rowMode);
    }
    if (upper.startsWith('UPDATE ')) {
      return this.execUpdate(sqlText, params, rowMode);
    }
    if (upper.startsWith('DELETE FROM ')) {
      return this.execDelete(sqlText, params, rowMode);
    }

    throw new Error(`Unsupported SQL in test harness: ${sqlText}`);
  }

  private execSelect(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const hasForUpdate = /\s+for\s+update\s*$/i.test(sqlText);
    const cleaned = sqlText.replace(/\s+for\s+update\s*$/i, '').trim();

    const m = /^select\s+([\s\S]+?)\s+from\s+"([^"]+)"([\s\S]*)$/i.exec(cleaned);
    if (!m) throw new Error(`Cannot parse SELECT: ${sqlText}`);
    const selectList = m[1].trim();
    const tableName = m[2];
    const rest = m[3].trim();

    if (hasForUpdate) {
      this.trace.push(`SQL:SELECT_FOR_UPDATE:${tableName}`);
    }

    let whereClause = '';
    let orderClause = '';
    let limitCount: number | null = null;

    let rem = rest;
    const limitMatch = /\s+limit\s+(\$\d+|\d+)\s*$/i.exec(rem);
    if (limitMatch) {
      const token = limitMatch[1];
      limitCount = token.startsWith('$') ? Number(params[Number(token.slice(1)) - 1]) : Number(token);
      rem = rem.slice(0, limitMatch.index).trim();
    }
    const orderMatch = /\s+order\s+by\s+([\s\S]+)$/i.exec(rem);
    if (orderMatch) {
      orderClause = orderMatch[1].trim();
      rem = rem.slice(0, orderMatch.index).trim();
    }
    const whereMatch = /^where\s+([\s\S]+)$/i.exec(rem);
    if (whereMatch) {
      whereClause = whereMatch[1].trim();
    }

    let matched = this.rows(tableName).filter((row) =>
      whereClause ? evalWhere(row, whereClause, params) : true,
    );

    if (/^COALESCE\s*\(\s*MAX\s*\(\s*"([^"]+)"\s*\)\s*,\s*0\s*\)/i.test(selectList)) {
      const colMatch = /MAX\s*\(\s*"([^"]+)"\s*\)/i.exec(selectList)!;
      const col = colMatch[1];
      let maxVal = 0;
      for (const row of matched) {
        const n = Number(row[col] ?? 0);
        if (n > maxVal) maxVal = n;
      }
      return { rows: [rowMode === 'array' ? [maxVal] : { maxSeq: maxVal }] };
    }

    if (orderClause) {
      const specs = splitTopLevel(orderClause, ',').map((part) => {
        const parts = part.trim().split(/\s+/);
        const col = extractColumnName(parts[0]);
        const dir = parts[1]?.toLowerCase() === 'desc' ? -1 : 1;
        return { col, dir };
      });
      matched = [...matched].sort((a, b) => {
        for (const spec of specs) {
          const av = normalizeSortValue(a[spec.col]);
          const bv = normalizeSortValue(b[spec.col]);
          if (av < bv) return -1 * spec.dir;
          if (av > bv) return 1 * spec.dir;
        }
        return 0;
      });
    }

    if (limitCount !== null) {
      matched = matched.slice(0, limitCount);
    }

    const cols = splitTopLevel(selectList, ',').map((part) => extractColumnName(part));
    return { rows: formatResultRows(matched, cols, rowMode) };
  }

  private execInsert(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const returningMatch = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const returningCols = returningMatch
      ? splitTopLevel(returningMatch[1], ',').map((part) => extractColumnName(part))
      : null;
    const withoutReturning = returningMatch ? sqlText.slice(0, returningMatch.index).trim() : sqlText;

    const conflictMatch = /\s+on\s+conflict\s*\(([^)]+)\)\s+do\s+update\s+set\s+([\s\S]+)$/i.exec(
      withoutReturning,
    );
    const conflictTarget = conflictMatch
      ? splitTopLevel(conflictMatch[1], ',').map((c) => extractColumnName(c))
      : null;
    let conflictSet = '';
    let conflictWhere = '';
    if (conflictMatch) {
      const setAndWhere = conflictMatch[2].trim();
      const whereIdx = findTopLevelKeyword(setAndWhere, 'where');
      if (whereIdx >= 0) {
        conflictSet = setAndWhere.slice(0, whereIdx).trim();
        conflictWhere = setAndWhere.slice(whereIdx + 5).trim();
      } else {
        conflictSet = setAndWhere;
      }
    }

    const baseInsert = conflictMatch ? withoutReturning.slice(0, conflictMatch.index).trim() : withoutReturning;
    const headerMatch = /^insert\s+into\s+"([^"]+)"\s*\(([^)]+)\)\s+values\s+([\s\S]+)$/i.exec(baseInsert);
    if (!headerMatch) throw new Error(`Cannot parse INSERT: ${sqlText}`);

    const tableName = headerMatch[1];
    const columns = splitTopLevel(headerMatch[2], ',').map((c) => extractColumnName(c));
    const valueTuples = splitValueTuples(headerMatch[3].trim());
    const tableRows = this.rows(tableName);
    const affected: Row[] = [];

    for (const tuple of valueTuples) {
      const exprs = splitTopLevel(tuple, ',');
      const newRow: Row = {};
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const expr = exprs[i].trim();
        newRow[col] = evalInsertDefaultOrValue(tableName, col, expr, params);
      }
      applyRowDefaults(tableName, newRow);

      if (tableName === 'workspace_blobs' && typeof newRow.sha256 === 'string') {
        this.blobLockOrder.push(newRow.sha256);
      }

      // Enforce unique constraint uq_project_versions_number (project_id, version_number).
      if (tableName === 'project_versions' && newRow.project_id && newRow.version_number !== undefined) {
        const dup = tableRows.find(
          (r) => r.project_id === newRow.project_id && r.version_number === newRow.version_number,
        );
        if (dup) {
          const err = new Error('duplicate key value violates unique constraint "uq_project_versions_number"') as Error & {
            code: string;
          };
          err.code = '23505';
          throw err;
        }
      }

      // Enforce unique partial index uq_jobs_active_export_per_project.
      if (
        tableName === 'jobs' &&
        newRow.kind === 'export_render' &&
        newRow.project_id &&
        ['queued', 'running', 'cancelling'].includes(String(newRow.state))
      ) {
        const dup = tableRows.find(
          (r) =>
            r.kind === 'export_render' &&
            r.project_id === newRow.project_id &&
            ['queued', 'running', 'cancelling'].includes(String(r.state)),
        );
        if (dup) {
          const err = new Error('duplicate key value violates unique constraint "uq_jobs_active_export_per_project"') as Error & {
            code: string;
          };
          err.code = '23505';
          throw err;
        }
      }

      if (conflictTarget) {
        const existing = tableRows.find((r) => conflictTarget.every((k) => r[k] === newRow[k]));
        if (existing) {
          if (conflictWhere && !evalWhere(existing, conflictWhere, params)) {
            continue;
          }
          applySetClause(existing, conflictSet, params);
          affected.push(existing);
          continue;
        }
      }

      tableRows.push(newRow);
      affected.push(newRow);
    }

    if (!returningCols) return { rows: [] };
    return { rows: formatResultRows(affected, returningCols, rowMode) };
  }

  private execUpdate(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const returningMatch = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const returningCols = returningMatch
      ? splitTopLevel(returningMatch[1], ',').map((part) => extractColumnName(part))
      : null;
    const withoutReturning = returningMatch ? sqlText.slice(0, returningMatch.index).trim() : sqlText;

    const m = /^update\s+"([^"]+)"\s+set\s+([\s\S]+)$/i.exec(withoutReturning);
    if (!m) throw new Error(`Cannot parse UPDATE: ${sqlText}`);
    const tableName = m[1];
    const body = m[2].trim();
    const whereIdx = findTopLevelKeyword(body, 'where');
    const setClause = whereIdx >= 0 ? body.slice(0, whereIdx).trim() : body;
    const whereClause = whereIdx >= 0 ? body.slice(whereIdx + 5).trim() : '';

    const matched = this.rows(tableName).filter((row) =>
      whereClause ? evalWhere(row, whereClause, params) : true,
    );

    for (const row of matched) {
      if (tableName === 'workspace_blobs' && typeof row.sha256 === 'string') {
        this.blobLockOrder.push(row.sha256);
      }
      applySetClause(row, setClause, params);
    }

    if (!returningCols) return { rows: [] };
    return { rows: formatResultRows(matched, returningCols, rowMode) };
  }

  private execDelete(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const returningMatch = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const returningCols = returningMatch
      ? splitTopLevel(returningMatch[1], ',').map((part) => extractColumnName(part))
      : null;
    const withoutReturning = returningMatch ? sqlText.slice(0, returningMatch.index).trim() : sqlText;

    const m = /^delete\s+from\s+"([^"]+)"(?:\s+where\s+([\s\S]+))?$/i.exec(withoutReturning);
    if (!m) throw new Error(`Cannot parse DELETE: ${sqlText}`);
    const tableName = m[1];
    const whereClause = m[2]?.trim() ?? '';

    const list = this.rows(tableName);
    const kept: Row[] = [];
    const removed: Row[] = [];
    for (const row of list) {
      if (!whereClause || evalWhere(row, whereClause, params)) {
        removed.push(row);
      } else {
        kept.push(row);
      }
    }
    this.tables.set(tableName, kept);

    // Emulate ON DELETE CASCADE for projects -> dependent tables.
    if (tableName === 'projects' && removed.length > 0) {
      const deletedProjectIds = new Set(removed.map((r) => r.id));
      for (const childTable of [
        'project_files',
        'project_versions',
        'project_version_files',
        'project_history_entries',
        'work_rounds',
      ]) {
        this.tables.set(
          childTable,
          this.rows(childTable).filter((r) => !deletedProjectIds.has(r.project_id)),
        );
      }
    }

    if (!returningCols) return { rows: [] };
    return { rows: formatResultRows(removed, returningCols, rowMode) };
  }
}

function extractColumnName(expr: string): string {
  const trimmed = expr.trim().replace(/\s+as\s+"[^"]+"$/i, '').trim();
  const quoted = [...trimmed.matchAll(/"([^"]+)"/g)];
  return quoted.length > 0 ? quoted[quoted.length - 1][1] : trimmed;
}

function splitTopLevel(input: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && input.slice(i, i + separator.length) === separator) {
      out.push(input.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

function splitValueTuples(input: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = -1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && start >= 0) {
        tuples.push(input.slice(start, i));
        start = -1;
      }
    }
  }
  return tuples;
}

function findTopLevelKeyword(input: string, keyword: string): number {
  const lower = input.toLowerCase();
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (
      depth === 0 &&
      lower.slice(i, i + keyword.length) === keyword &&
      (i === 0 || /\s/.test(input[i - 1])) &&
      (i + keyword.length === input.length || /\s/.test(input[i + keyword.length]))
    ) {
      return i;
    }
  }
  return -1;
}

function evalScalar(expr: string, params: unknown[]): unknown {
  const trimmed = expr.trim();
  if (/^\$\d+$/.test(trimmed)) {
    const val = params[Number(trimmed.slice(1)) - 1];
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  }
  if (/^null$/i.test(trimmed)) return null;
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^now\(\)$/i.test(trimmed)) return new Date().toISOString();
  if (/^'([^']*)'$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function evalInsertDefaultOrValue(table: string, col: string, expr: string, params: unknown[]): unknown {
  if (/^default$/i.test(expr)) {
    if (col === 'id' && UUID_DEFAULT_TABLES.has(table)) return randomUUID();
    if (col === 'artifact_id') return randomUUID();
    if (col.endsWith('_at') || col === 'started_at' || col === 'ended_at') return new Date().toISOString();
    if (col === 'expires_at') return new Date(Date.now() + 30 * 86_400_000).toISOString();
    if (col === 'pinned' || col === 'undone' || col === 'trashed' || col === 'remote_terminal' || col === 'save_pending') {
      return false;
    }
    if (col === 'current_version_number' || col === 'current_history_seq' || col === 'progress') return 0;
    if (col === 'asset_name_allocations' || col === 'input_payload' || col === 'default_models') return {};
    if (col === 'reviews') return [];
    if (col === 'gc_state') return 'active';
    if (col === 'state') return table === 'jobs' ? 'queued' : 'pending';
    if (col === 'mode') return 'motion';
    return null;
  }
  return evalScalar(expr, params);
}

function applyRowDefaults(table: string, row: Row): void {
  if (UUID_DEFAULT_TABLES.has(table) && !row.id) row.id = randomUUID();
  if (table === 'projects' && !row.artifact_id) row.artifact_id = randomUUID();
  if (table === 'projects') {
    if (row.asset_name_allocations === undefined) row.asset_name_allocations = {};
    if (row.reviews === undefined) row.reviews = [];
    if (row.trashed === undefined) row.trashed = false;
    if (row.trashed_at === undefined) row.trashed_at = null;
  }
  if (table === 'workspace_blobs' && !row.gc_state) row.gc_state = 'active';
}

function stripOuterParens(expr: string): string {
  let s = expr.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

function splitTopLevelAnd(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  const lower = expr.toLowerCase();

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (
      depth === 0 &&
      lower.slice(i, i + 3) === 'and' &&
      i > 0 &&
      /\s/.test(expr[i - 1]) &&
      i + 3 < expr.length &&
      /\s/.test(expr[i + 3])
    ) {
      parts.push(expr.slice(start, i).trim());
      start = i + 3;
      i += 2;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

function evalWhere(row: Row, rawWhere: string, params: unknown[]): boolean {
  const unwrapped = stripOuterParens(rawWhere);
  const terms = splitTopLevelAnd(unwrapped);
  if (terms.length > 1) {
    return terms.every((t) => evalWhere(row, t, params));
  }
  const term = stripOuterParens(terms[0]);

  const isNullMatch = /^([\s\S]+?)\s+is\s+null$/i.exec(term);
  if (isNullMatch) {
    const col = extractColumnName(isNullMatch[1]);
    return row[col] === null || row[col] === undefined;
  }
  const isNotNullMatch = /^([\s\S]+?)\s+is\s+not\s+null$/i.exec(term);
  if (isNotNullMatch) {
    const col = extractColumnName(isNotNullMatch[1]);
    return row[col] !== null && row[col] !== undefined;
  }
  const inMatch = /^([\s\S]+?)\s+in\s*\(([\s\S]+)\)$/i.exec(term);
  if (inMatch) {
    const col = extractColumnName(inMatch[1]);
    const list = splitTopLevel(inMatch[2], ',').map((v) => evalScalar(v, params));
    return list.includes(row[col]);
  }
  const gteMatch = /^([\s\S]+?)\s*>=\s*([\s\S]+)$/.exec(term);
  if (gteMatch) {
    const col = extractColumnName(gteMatch[1]);
    return Number(row[col]) >= Number(evalScalar(gteMatch[2], params));
  }
  const gtMatch = /^([\s\S]+?)\s*>\s*([\s\S]+)$/.exec(term);
  if (gtMatch) {
    const col = extractColumnName(gtMatch[1]);
    return Number(row[col]) > Number(evalScalar(gtMatch[2], params));
  }
  const ltMatch = /^([\s\S]+?)\s*<\s*([\s\S]+)$/.exec(term);
  if (ltMatch) {
    const col = extractColumnName(ltMatch[1]);
    return Number(row[col]) < Number(evalScalar(ltMatch[2], params));
  }
  const eqMatch = /^([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(term);
  if (eqMatch) {
    const col = extractColumnName(eqMatch[1]);
    const expected = evalScalar(eqMatch[2], params);
    return row[col] === expected;
  }
  throw new Error(`Unsupported WHERE term in test harness: ${term}`);
}

function applySetClause(row: Row, setClause: string, params: unknown[]): void {
  const assignments = splitTopLevel(setClause, ',');
  for (const assignment of assignments) {
    const eqIdx = assignment.indexOf('=');
    if (eqIdx < 0) continue;
    const col = extractColumnName(assignment.slice(0, eqIdx));
    const rhs = assignment.slice(eqIdx + 1).trim();

    // Handle ref_count + $N and ref_count - $N
    const addMatch = /"ref_count"\s*\+\s*(\$\d+)/i.exec(rhs);
    if (addMatch) {
      row[col] = Number(row.ref_count ?? 0) + Number(evalScalar(addMatch[1], params));
      continue;
    }
    const subMatch = !/^CASE\b/i.test(rhs) ? /"ref_count"\s*-\s*(\$\d+)/i.exec(rhs) : null;
    if (subMatch) {
      row[col] = Number(row.ref_count ?? 0) - Number(evalScalar(subMatch[1], params));
      continue;
    }
    // Handle CASE WHEN ref_count - $N = 0 THEN now() ELSE NULL END
    const caseZeroMatch = /CASE\s+WHEN[\s\S]*?"ref_count"\s*-\s*(\$\d+)\s*=\s*0\s+THEN\s+now\(\)\s+ELSE\s+NULL\s+END/i.exec(rhs);
    if (caseZeroMatch) {
      // Note: ref_count may already have been decremented earlier in this same SET clause.
      const currentRef = Number(row.ref_count ?? 0);
      row[col] = currentRef === 0 ? new Date().toISOString() : null;
      continue;
    }
    // Handle COALESCE(metadata, '{}'::jsonb) || $N::jsonb
    const jsonMergeMatch = /COALESCE\([\s\S]*?"metadata"[\s\S]*?\)\s*\|\|\s*(\$\d+)::jsonb/i.exec(rhs);
    if (jsonMergeMatch) {
      const incoming = evalScalar(jsonMergeMatch[1], params);
      const base = (row[col] && typeof row[col] === 'object' ? row[col] : {}) as Record<string, unknown>;
      row[col] =
        incoming && typeof incoming === 'object' ? { ...base, ...(incoming as Record<string, unknown>) } : base;
      continue;
    }

    row[col] = evalScalar(rhs, params);
  }
}

function normalizeSortValue(val: unknown): string | number {
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const parsedTime = Date.parse(val);
    if (/^\d{4}-\d{2}-\d{2}T/.test(val) && !Number.isNaN(parsedTime)) return parsedTime;
    return val;
  }
  return String(val ?? '');
}

function formatResultRows(rows: readonly Row[], cols: readonly string[], rowMode?: string): unknown[] {
  return rows.map((row) => {
    if (rowMode === 'array') {
      return cols.map((col) => {
        const val = row[col];
        return val instanceof Date ? val.toISOString() : val ?? null;
      });
    }
    const obj: Row = {};
    for (const col of cols) obj[col] = row[col] ?? null;
    return obj;
  });
}

// ---------------------------------------------------------------------------
// In-Memory Storage, HotTextCache, EventBus & Queues
// ---------------------------------------------------------------------------

class InMemoryStorage implements StoragePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly trace: string[] = [];
  private readonly sharedTrace?: string[];

  constructor(sharedTrace?: string[]) {
    this.sharedTrace = sharedTrace;
  }

  private record(event: string): void {
    this.trace.push(event);
    this.sharedTrace?.push(event);
  }

  async putObject(key: string, body: Buffer | Uint8Array | Readable | string, contentType: string): Promise<void> {
    const buf = Buffer.isBuffer(body)
      ? body
      : typeof body === 'string'
        ? Buffer.from(body, 'utf8')
        : body instanceof Uint8Array
          ? Buffer.from(body)
          : await streamToBuffer(body);
    this.objects.set(key, { body: buf, contentType });
    this.record(`S3:PUT:${key}`);
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    this.record(`S3:PUT_BLOB:${key}`);
    if (this.objects.has(key)) return { uploaded: false };
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`S3 NoSuchKey: ${key}`);
    return Buffer.from(found.body);
  }

  async getObjectStream(key: string): Promise<ObjectStreamResult> {
    const buf = await this.getObjectBuffer(key);
    return { stream: Readable.from([buf]), contentLength: buf.byteLength };
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    return { contentLength: found.body.byteLength, contentType: found.contentType };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(prefix)) {
        this.objects.delete(k);
        count++;
      }
    }
    return count;
  }

  async presignPut(key: string, _options: PresignPutOptions): Promise<string> {
    this.record(`S3:PRESIGN_PUT:${key}`);
    return `https://s3.test/${key}?X-Amz-Signature=put`;
  }

  async presignGet(key: string, options?: PresignGetOptions): Promise<string> {
    this.record(`S3:PRESIGN_GET:${key}`);
    const disp = options?.responseContentDisposition
      ? `&response-content-disposition=${encodeURIComponent(options.responseContentDisposition)}`
      : '';
    return `https://s3.test/${key}?X-Amz-Signature=get${disp}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

class InMemoryHotTextCache implements HotTextCachePort {
  readonly textMap = new Map<string, string>();
  readonly fontCssMap = new Map<string, string>();

  async getText(sha256: string): Promise<string | null> {
    return this.textMap.get(sha256) ?? null;
  }
  async setText(sha256: string, content: string): Promise<boolean> {
    this.textMap.set(sha256, content);
    return true;
  }
  async getFontCss(hash: string): Promise<string | null> {
    return this.fontCssMap.get(hash) ?? null;
  }
  async setFontCss(hash: string, css: string): Promise<boolean> {
    this.fontCssMap.set(hash, css);
    return true;
  }
}

class InMemoryEventBus implements StudioEventBusPort {
  readonly published: Array<{ channel: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Set<(payload: unknown, channel: string) => void>>();
  workersHealth: RenderWorkerHealth[] = [];

  async publish(channel: string, payload: unknown): Promise<number> {
    this.published.push({ channel, payload });
    const set = this.listeners.get(channel);
    if (!set) return 0;
    for (const fn of set) fn(payload, channel);
    return set.size;
  }

  async subscribe(
    channel: string,
    listener: (payload: unknown, channel: string) => void,
  ): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return async () => {
      set?.delete(listener);
    };
  }

  async getRenderWorkersHealth(): Promise<RenderWorkerHealth[]> {
    return this.workersHealth;
  }
}

function createHarness(options: { historyCoalesceWindowMs?: number; now?: () => Date } = {}) {
  const pgClient = new InMemoryPgClient();
  const db = drizzle({ client: pgClient as never, schema }) as unknown as Database;
  const storage = new InMemoryStorage(pgClient.trace);
  const hotTextCache = new InMemoryHotTextCache();
  const eventBus = new InMemoryEventBus();

  const WID_A = '11111111-1111-4111-8111-111111111111';
  const WID_B = '22222222-2222-4222-8222-222222222222';
  const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  pgClient.seed('workspaces', {
    id: WID_A,
    slug: 'ws-a',
    name: 'Workspace A',
    owner_user_id: USER_A,
    active_project_id: null,
    active_session_id: null,
    default_models: {},
    tracking_enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  pgClient.seed('workspaces', {
    id: WID_B,
    slug: 'ws-b',
    name: 'Workspace B',
    owner_user_id: USER_B,
    active_project_id: null,
    active_session_id: null,
    default_models: {},
    tracking_enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const authA: AuthContext = {
    workspaceId: WID_A,
    userId: USER_A,
    role: 'owner',
    scopes: ['workspace:admin'],
    authMode: 'dev',
    authMethod: 'session_cookie',
    displayName: 'Alice',
  };
  const authB: AuthContext = {
    workspaceId: WID_B,
    userId: USER_B,
    role: 'owner',
    scopes: ['workspace:admin'],
    authMode: 'dev',
    authMethod: 'session_cookie',
    displayName: 'Bob',
  };

  const files = new ProjectFilesService({
    db,
    storage,
    hotTextCache,
    eventBus,
    historyCoalesceWindowMs: options.historyCoalesceWindowMs,
    now: options.now,
  });
  const history = new VersionHistoryService({
    db,
    storage,
    hotTextCache,
    eventBus,
    historyCoalesceWindowMs: options.historyCoalesceWindowMs,
  });
  const workspace = new WorkspaceService({ db, storage, files, hotTextCache });
  const assetNames = new AssetNamesService({ db, files });
  const workRounds = new WorkRoundsService(db);
  const archives = new ProjectArchiveService({ db, storage, workspace, files });

  const queues: StudioQueuesPort = {
    enqueueMediaIngest: async () => ({}),
    enqueueRenderExport: async () => ({}),
  };

  return {
    pgClient,
    db,
    storage,
    hotTextCache,
    eventBus,
    queues,
    authA,
    authB,
    files,
    history,
    workspace,
    assetNames,
    workRounds,
    archives,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cloud Optimistic Locking, Idempotency & CAS Refcounts', () => {
  it('uploads S3 blobs BEFORE PG tx, computes canonical revision, warms HotTextCache, and publishes event with writeToken', async () => {
    const h = createHarness();
    const created = await h.workspace.createProject(h.authA, { title: 'Demo Film' });
    assert.equal(created.versionNumber, 1);
    assert.equal(created.historySeq, 1);

    h.pgClient.trace.length = 0;
    const updatedHtml = '<!DOCTYPE html><html><body><div data-composition-id="main" data-duration="6"><h1 id="t">Updated</h1></div></body></html>';

    const committed = await h.files.commitChanges(h.authA, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: updatedHtml }],
      expectedRevision: created.revision,
      expectedVersionId: created.versionId,
      writeToken: 'tok-abc-123',
      source: 'agent',
      summary: 'Updated hero title',
    });

    assert.equal(committed.replayed, false);
    assert.equal(committed.versionNumber, 2);
    assert.equal(committed.historySeq, 2);
    assert.equal(committed.writeToken, 'tok-abc-123');
    assert.equal(committed.affectsPreview, true);
    assert.ok(committed.affectedCompositions.includes('index.html'));

    // Verify S3 upload happened strictly BEFORE SQL:BEGIN!
    const putIdx = h.pgClient.trace.findIndex((e) => e.startsWith('S3:PUT_BLOB:'));
    const beginIdx = h.pgClient.trace.indexOf('SQL:BEGIN');
    assert.ok(putIdx >= 0 && beginIdx > putIdx, `Expected S3 upload before SQL:BEGIN, trace=${h.pgClient.trace.join(',')}`);
    assert.ok(h.pgClient.trace.includes('SQL:SELECT_FOR_UPDATE:projects'));

    // Verify canonical revision matches computeProjectRevision() exactly.
    const liveFiles = await h.files.listFiles(h.authA, created.projectId);
    const expectedRev = computeProjectRevision(
      liveFiles.map((f) => ({ path: f.path, size: f.sizeBytes, hash: f.sha256 })),
    );
    assert.equal(committed.revision, expectedRev);

    // Verify HotTextCache warmed post-commit and event published with writeToken.
    const newSha = sha256Hex(updatedHtml);
    assert.equal(await h.hotTextCache.getText(newSha), updatedHtml);
    const lastEvt = h.eventBus.published.at(-1);
    assert.equal(lastEvt?.channel, `om:project:${h.authA.workspaceId}:${created.projectId}`);
    assert.equal((lastEvt?.payload as { writeToken?: string }).writeToken, 'tok-abc-123');
  });

  it('throws VERSION_CONFLICT (409) on stale expectedRevision or expectedVersionId and rolls back tx', async () => {
    const h = createHarness();
    const created = await h.workspace.createProject(h.authA, { title: 'Lock Test' });

    const first = await h.files.commitChanges(h.authA, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_text', path: 'style.css', content: 'body { color: red; }' }],
      expectedRevision: created.revision,
    });

    // Stale expectedRevision must throw VERSION_CONFLICT (409).
    await assert.rejects(
      () =>
        h.files.commitChanges(h.authA, {
          projectId: created.projectId,
          ops: [{ op: 'upsert_text', path: 'style.css', content: 'body { color: blue; }' }],
          expectedRevision: created.revision,
        }),
      (err: unknown) => {
        assert.ok(isCloudError(err));
        assert.equal(err.code, 'VERSION_CONFLICT');
        assert.equal(err.status, 409);
        assert.equal(err.details?.currentRevision, first.revision);
        return true;
      },
    );

    // Stale expectedVersionId must throw VERSION_CONFLICT (409).
    await assert.rejects(
      () =>
        h.files.commitChanges(h.authA, {
          projectId: created.projectId,
          ops: [{ op: 'upsert_text', path: 'style.css', content: 'body { color: green; }' }],
          expectedVersionId: created.versionId,
        }),
      (err: unknown) => {
        assert.ok(isCloudError(err));
        assert.equal(err.code, 'VERSION_CONFLICT');
        assert.equal(err.status, 409);
        return true;
      },
    );

    // File must remain unchanged from first commit.
    const current = await h.files.readTextFile(h.authA, created.projectId, 'style.css');
    assert.equal(current?.content, 'body { color: red; }');
  });

  it('replays identical requestId via idempotency_receipts and rejects payload mismatch with REQUEST_ID_CONFLICT', async () => {
    const h = createHarness();
    const created = await h.workspace.createProject(h.authA, { title: 'Idempotency Test' });

    const first = await h.files.commitChanges(h.authA, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_text', path: 'notes.txt', content: 'hello world' }],
      expectedRevision: created.revision,
      requestId: 'req-edit-001',
    });
    assert.equal(first.replayed, false);
    assert.equal(first.versionNumber, 2);

    // Retry with identical requestId + identical payload (even though revision moved!) -> replays cleanly.
    const replay = await h.files.commitChanges(h.authA, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_text', path: 'notes.txt', content: 'hello world' }],
      expectedRevision: created.revision,
      requestId: 'req-edit-001',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.versionId, first.versionId);
    assert.equal(replay.revision, first.revision);

    // Reusing same requestId with a different payload must throw REQUEST_ID_CONFLICT (409).
    await assert.rejects(
      () =>
        h.files.commitChanges(h.authA, {
          projectId: created.projectId,
          ops: [{ op: 'upsert_text', path: 'notes.txt', content: 'DIFFERENT CONTENT' }],
          requestId: 'req-edit-001',
        }),
      (err: unknown) => {
        assert.ok(isCloudError(err));
        assert.equal(err.code, 'REQUEST_ID_CONFLICT');
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  it('supports unified PG undo/redo, pin, checkpoint, peek, blob read, and non-destructive restore', async () => {
    const h = createHarness();
    const created = await h.workspace.createProject(h.authA, { title: 'History Film' });
    const v1Html = (await h.files.readTextFile(h.authA, created.projectId, 'index.html'))!.content;

    const v2Html = v1Html.replace('History Film', 'History Film v2');
    const c2 = await h.files.commitChanges(h.authA, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: v2Html }],
      source: 'studio',
      summary: 'Edit v2',
    });
    assert.equal(c2.historySeq, 2);

    const v3Html = v1Html.replace('History Film', 'History Film v3');
    const c3 = await h.files.commitChanges(h.authA, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: v3Html }],
      source: 'studio',
      summary: 'Edit v3',
      forceVersion: true,
    });
    assert.equal(c3.historySeq, 3);

    // Step back (undo v3 -> v2).
    const afterUndo = await h.history.step(h.authA, created.projectId, 'back');
    assert.equal(afterUndo.seq, 2);
    assert.equal(afterUndo.canUndo, true);
    assert.equal(afterUndo.canRedo, true);
    assert.equal((await h.files.readTextFile(h.authA, created.projectId, 'index.html'))?.content, v2Html);

    const offered = await h.history.listHistory(h.authA, created.projectId);
    assert.deepEqual(offered.back?.paths, ['index.html']);
    assert.deepEqual(offered.forward?.paths, ['index.html']);
    assert.ok(Number.isFinite(offered.back?.endedAt));
    assert.ok(Number.isFinite(offered.forward?.endedAt));

    // Step forward (redo v2 -> v3).
    const afterRedo = await h.history.step(h.authA, created.projectId, 'forward');
    assert.equal(afterRedo.seq, 3);
    assert.equal(afterRedo.canRedo, false);
    assert.equal((await h.files.readTextFile(h.authA, created.projectId, 'index.html'))?.content, v3Html);

    // Pin entry 2 and verify peek + history blob access.
    const histList = await h.history.listHistory(h.authA, created.projectId);
    const entry2 = histList.entries.find((e) => e.seq === 2)!;
    assert.equal(entry2.who.kind, 'person');
    await h.history.pinEntry(h.authA, created.projectId, entry2.id, true);

    const peek = await h.history.peekPoint(h.authA, created.projectId, entry2.versionId, 'index.html');
    assert.equal(peek.file?.content, v2Html);
    const blob = await h.history.readHistoryBlob(h.authA, created.projectId, peek.file!.sha256);
    assert.equal(blob.buffer.toString('utf8'), v2Html);

    // Non-destructive restore of v1 creates v4 with source='restore' and enforces expectedRevision.
    await assert.rejects(
      () =>
        h.history.restoreVersion(h.authA, created.projectId, {
          targetVersionId: created.versionId,
          expectedRevision: created.revision,
        }),
      (err: unknown) => isCloudError(err) && err.code === 'VERSION_CONFLICT',
    );

    const restored = await h.history.restoreVersion(h.authA, created.projectId, {
      targetVersionId: created.versionId,
      expectedRevision: c3.revision,
      requestId: 'restore-v1-req',
    });
    assert.equal(restored.versionNumber, 4);
    assert.equal(restored.seq, 4);
    assert.equal((await h.files.readTextFile(h.authA, created.projectId, 'index.html'))?.content, v1Html);

    const versions = await h.history.listVersions(h.authA, created.projectId);
    assert.equal(versions.versions.length, 4);
    assert.equal(versions.versions[0].source, 'restore');
    assert.equal(versions.versions[0].restoredFromVersionId, created.versionId);

    // Undo after restore, then make a brand new edit: verify stale undone branch is pruned so redo tracks the new branch!
    await h.history.step(h.authA, created.projectId, 'back');
    const v5Html = v1Html.replace('History Film', 'History Film v5 branch');
    const c5 = await h.files.commitChanges(h.authA, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: v5Html }],
      source: 'studio',
      summary: 'Branch v5',
    });
    assert.equal(c5.versionNumber, 5);

    // Undo v5 -> checkpoint -> undo -> restoreVersion: verify ALL produce monotonic version numbers with zero 23505 collision!
    const backFromV5 = await h.history.step(h.authA, created.projectId, 'back');
    assert.equal(backFromV5.canRedo, true);
    const redoToV5 = await h.history.step(h.authA, created.projectId, 'forward');
    assert.equal(redoToV5.canRedo, false);
    assert.equal((await h.files.readTextFile(h.authA, created.projectId, 'index.html'))?.content, v5Html);

    await h.history.step(h.authA, created.projectId, 'back');
    const cp = await h.history.checkpoint(h.authA, created.projectId, { label: 'After undo checkpoint' });
    assert.equal(cp.versionNumber, 6);

    await h.history.step(h.authA, created.projectId, 'back');
    const restoreAfterUndo = await h.history.restoreVersion(h.authA, created.projectId, {
      targetVersionId: created.versionId,
    });
    assert.equal(restoreAfterUndo.versionNumber, 7);
  });

  it('maintains exact workspace_blobs ref_count across edits and decrements ALL live + version refs in sorted sha256 order on permanent delete', async () => {
    const h = createHarness();
    // Create two projects so trashing one is permitted (cannot trash last active project).
    const keep = await h.workspace.createProject(h.authA, { title: 'Keep Me' });
    const victim = await h.workspace.createProject(h.authA, {
      title: 'Delete Me',
      initialFiles: [
        { path: 'index.html', content: '<div data-composition-id="main">v1</div>' },
        { path: 'a.css', content: '/* unique-a */' },
      ],
    });

    // Add a second version with a modified index.html + new file b.css.
    await h.files.commitChanges(h.authA, {
      projectId: victim.projectId,
      ops: [
        { op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">v2</div>' },
        { op: 'upsert_text', path: 'b.css', content: '/* unique-b */' },
      ],
    });

    const shaV1 = sha256Hex('<div data-composition-id="main">v1</div>');
    const shaV2 = sha256Hex('<div data-composition-id="main">v2</div>');
    const shaA = sha256Hex('/* unique-a */');
    const shaB = sha256Hex('/* unique-b */');

    const getRefCount = (sha: string) =>
      Number(
        h.pgClient
          .rows('workspace_blobs')
          .find((r) => r.workspace_id === h.authA.workspaceId && r.sha256 === sha)?.ref_count ?? -1,
      );

    // Exact expected ref_counts before delete:
    // shaV1: v1 snapshot only = 1
    // shaV2: live + v2 snapshot = 2
    // shaA: live + v1 snapshot + v2 snapshot = 3
    // shaB: live + v2 snapshot = 2
    assert.equal(getRefCount(shaV1), 1);
    assert.equal(getRefCount(shaV2), 2);
    assert.equal(getRefCount(shaA), 3);
    assert.equal(getRefCount(shaB), 2);

    // Refuses permanent delete before trashing.
    await assert.rejects(
      () => h.workspace.deleteProjectPermanently(h.authA, victim.projectId),
      (err: unknown) => isCloudError(err) && err.code === 'INVALID_ARGUMENT',
    );

    await h.workspace.trashProject(h.authA, victim.projectId);
    h.pgClient.blobLockOrder.length = 0;

    const deleted = await h.workspace.deleteProjectPermanently(h.authA, victim.projectId);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.decrementedBlobRefs, 1 + 2 + 3 + 2);
    assert.equal(deleted.activeProjectId, keep.projectId);

    // Every blob exclusive to `victim` must now have ref_count === 0 and non-null zero_ref_since!
    for (const sha of [shaV1, shaV2, shaA, shaB]) {
      const row = h.pgClient
        .rows('workspace_blobs')
        .find((r) => r.workspace_id === h.authA.workspaceId && r.sha256 === sha);
      assert.equal(row?.ref_count, 0, `Expected ref_count 0 for ${sha}`);
      assert.ok(row?.zero_ref_since, `Expected zero_ref_since timestamp for ${sha}`);
    }

    // Verify workspace_blobs locks were acquired in strict lexicographical ascending sha256 order!
    const expectedSorted = [shaV1, shaV2, shaA, shaB].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(h.pgClient.blobLockOrder, expectedSorted);
  });

  it('enforces strict tenant workspaceId isolation across projects, files, history, and work rounds', async () => {
    const h = createHarness();
    const projA = await h.workspace.createProject(h.authA, { title: 'Tenant A Secret' });
    const roundA = await h.workRounds.create(h.authA, { projectId: projA.projectId, mode: 'create' });

    // Workspace B cannot read, edit, inspect history, or touch Workspace A's project or work rounds.
    await assert.rejects(
      () => h.workspace.getProject(h.authB, projA.projectId),
      (err: unknown) => isCloudError(err) && err.code === 'PROJECT_NOT_FOUND',
    );
    await assert.rejects(
      () => h.files.readTextFile(h.authB, projA.projectId, 'index.html'),
      (err: unknown) => isCloudError(err) && err.code === 'PROJECT_NOT_FOUND',
    );
    await assert.rejects(
      () => h.history.listHistory(h.authB, projA.projectId),
      (err: unknown) => isCloudError(err) && err.code === 'PROJECT_NOT_FOUND',
    );
    assert.equal(await h.workRounds.get(h.authB, projA.projectId, roundA.id), null);
  });

  it('supports PG asset-names allocations, work-rounds lifecycle, and pure in-memory ZIP archive export/import round-trip', async () => {
    const h = createHarness();
    const proj = await h.workspace.createProject(h.authA, { title: 'Archive Demo' });

    // Add a fake media asset so assetNames allocates deterministic captions in PG.
    await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_binary', path: 'assets/image-1.png', data: Buffer.from([1, 2, 3, 4]), mimeType: 'image/png' }],
    });
    const names = await h.assetNames.readAssetNames(h.authA, proj.projectId);
    assert.ok(names.assetNames['assets/image-1.png']);
    await h.assetNames.updateAssetNames(h.authA, proj.projectId, {
      assetNames: [{ path: 'assets/image-1.png', name: 'Hero Banner', nameSource: 'user' }],
      namingLanguage: 'en',
    });
    const updatedNames = await h.assetNames.readAssetNames(h.authA, proj.projectId);
    assert.equal(updatedNames.assetNames['assets/image-1.png'], 'Hero Banner');

    // Work round lifecycle: create -> saved -> exported -> studioEdited.
    const round = await h.workRounds.create(h.authA, { projectId: proj.projectId, mode: 'create' });
    assert.equal(round.state, 'authoring');
    const saved = await h.workRounds.markSaved(h.authA, proj.projectId, round.id);
    assert.equal(saved.state, 'saved');
    const exportedRound = await h.workRounds.markExported(h.authA, proj.projectId, round.id, { source: 'studio' });
    assert.equal(exportedRound.generation?.exportSource, 'studio');
    const latest = await h.workRounds.latestGenerated(h.authA, proj.projectId);
    assert.equal(latest?.id, round.id);

    // Export ZIP strictly in memory to S3, then import back into Workspace B!
    const exported = await h.archives.exportProjects(h.authA, {
      requestId: 'exp-req-1',
      projectIds: [proj.projectId],
    });
    assert.equal(exported.projects.length, 1);
    assert.equal(exported.replayed, false);

    // Replay returns identical archiveId.
    const exportReplay = await h.archives.exportProjects(h.authA, {
      requestId: 'exp-req-1',
      projectIds: [proj.projectId],
    });
    assert.equal(exportReplay.replayed, true);
    assert.equal(exportReplay.archiveId, exported.archiveId);

    const zipBytes = await h.storage.getObjectBuffer(`workspaces/${h.authA.workspaceId}/archives/${exported.archiveId}.zip`);
    const imported = await h.archives.importProjects(h.authB, {
      requestId: 'imp-req-1',
      zipBytes,
    });
    assert.equal(imported.imported.length, 1);
    assert.equal(imported.imported[0].title, 'Archive Demo');
    const importedHtml = await h.files.readTextFile(h.authB, imported.imported[0].projectId, 'index.html');
    assert.ok(importedHtml?.content.includes('Archive Demo'));
  });

  it('coalesces 5 rapid Studio edits within 4s into 1 project_versions row with delta project_version_files and exact CAS refcounts, and splits on export-ref / pin / MCP / >4s (c2)', async () => {
    let clockMs = Date.parse('2026-11-20T12:00:00.000Z');
    const h = createHarness({
      historyCoalesceWindowMs: 4000,
      now: () => new Date(clockMs),
    });

    const keep = await h.workspace.createProject(h.authA, { title: 'Keep Project' });
    const proj = await h.workspace.createProject(h.authA, {
      title: 'Coalesce Demo',
      initialFiles: [
        { path: 'index.html', content: '<div data-composition-id="main">base</div>' },
        { path: 'styles.css', content: '/* unchanged-styles */' },
        { path: 'a.css', content: '/* unchanged-a */' },
        { path: 'b.css', content: '/* removable-b */' },
      ],
    });

    const assertExactWorkspaceRefCounts = (label: string) => {
      const expectedCounts = new Map<string, number>();
      for (const row of h.pgClient.rows('project_files')) {
        if (row.workspace_id === h.authA.workspaceId && row.blob_scope === 'workspace') {
          const sha = String(row.sha256).trim();
          expectedCounts.set(sha, (expectedCounts.get(sha) ?? 0) + 1);
        }
      }
      for (const row of h.pgClient.rows('project_version_files')) {
        if (row.workspace_id === h.authA.workspaceId && row.blob_scope === 'workspace') {
          const sha = String(row.sha256).trim();
          expectedCounts.set(sha, (expectedCounts.get(sha) ?? 0) + 1);
        }
      }
      for (const blob of h.pgClient.rows('workspace_blobs')) {
        if (blob.workspace_id !== h.authA.workspaceId) continue;
        const sha = String(blob.sha256).trim();
        const expected = expectedCounts.get(sha) ?? 0;
        assert.equal(
          Number(blob.ref_count),
          expected,
          `[${label}] CAS ref_count mismatch for sha=${sha}: actual=${blob.ref_count}, expected=${expected}`,
        );
      }
    };

    // 5 rapid Studio edits within 4s (t=0, +500ms, +1000ms, +1500ms, +2000ms):
    // Edit 1 allocates v2 (cannot coalesce into v1 baseline); edits 2..5 ALL coalesce into v2!
    const edit1 = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">drag-1</div>' }],
      source: 'studio',
      summary: 'Drag step 1',
    });
    assert.equal(edit1.versionNumber, 2);
    assert.equal(edit1.historySeq, 2);
    assert.equal(edit1.coalesced, false);

    clockMs += 500;
    const edit2 = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">drag-2</div>' }],
      source: 'studio',
      summary: 'Drag step 2',
    });
    assert.equal(edit2.versionId, edit1.versionId);
    assert.equal(edit2.versionNumber, 2);
    assert.equal(edit2.historySeq, 2);
    assert.equal(edit2.coalesced, true);
    assert.notEqual(edit2.revision, edit1.revision);

    clockMs += 500;
    const edit3 = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [
        { op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">drag-3</div>' },
        { op: 'upsert_text', path: 'extra.css', content: '/* added-during-burst */' },
      ],
      source: 'studio',
      summary: 'Drag step 3',
    });
    assert.equal(edit3.versionId, edit1.versionId);
    assert.equal(edit3.coalesced, true);

    clockMs += 500;
    const edit4 = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [
        { op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">drag-4</div>' },
        { op: 'delete', path: 'b.css' },
      ],
      source: 'studio',
      summary: 'Drag step 4',
    });
    assert.equal(edit4.versionId, edit1.versionId);
    assert.equal(edit4.coalesced, true);

    clockMs += 500;
    const edit5 = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">drag-5</div>' }],
      source: 'studio',
      summary: 'Drag step 5',
    });
    assert.equal(edit5.versionId, edit1.versionId);
    assert.equal(edit5.versionNumber, 2);
    assert.equal(edit5.historySeq, 2);
    assert.equal(edit5.coalesced, true);

    // Only 2 project_versions rows exist (v1 baseline + 1 coalesced v2), NOT 6!
    const projectVerRows = () =>
      h.pgClient.rows('project_versions').filter((r) => r.project_id === proj.projectId);
    assert.equal(projectVerRows().length, 2);

    // v2 project_version_files reflects exact final state (has extra.css, deleted b.css, drag-5 index.html)
    const v2Files = h.pgClient
      .rows('project_version_files')
      .filter((r) => r.version_id === edit1.versionId);
    assert.deepEqual(
      v2Files.map((r) => r.path).sort(),
      ['a.css', 'extra.css', 'index.html', 'styles.css'],
    );
    assert.equal(
      v2Files.find((r) => r.path === 'index.html')?.sha256,
      sha256Hex('<div data-composition-id="main">drag-5</div>'),
    );

    // Intermediate drag-1..drag-4 blobs dropped cleanly to ref_count === 0 with zero_ref_since set!
    for (const step of ['drag-1', 'drag-2', 'drag-3', 'drag-4']) {
      const deadSha = sha256Hex(`<div data-composition-id="main">${step}</div>`);
      const blobRow = h.pgClient
        .rows('workspace_blobs')
        .find((r) => r.workspace_id === h.authA.workspaceId && r.sha256 === deadSha);
      assert.equal(blobRow?.ref_count, 0, `expected ref_count=0 for superseded ${step}`);
      assert.ok(blobRow?.zero_ref_since, `expected zero_ref_since for superseded ${step}`);
    }
    assertExactWorkspaceRefCounts('after-5-coalesced-studio-edits');

    // Boundary 1: Export job referencing current head version_id MUST freeze it -> next Studio edit allocates v3!
    h.pgClient.seed('jobs', {
      id: randomUUID(),
      workspace_id: h.authA.workspaceId,
      project_id: proj.projectId,
      kind: 'export_render',
      state: 'queued',
      stage: 'queued',
      progress: 0,
      version_id: edit5.versionId,
      input_payload: { compositionPath: 'index.html' },
      created_at: new Date(clockMs).toISOString(),
      updated_at: new Date(clockMs).toISOString(),
    });
    clockMs += 100;
    const afterExportCol = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">post-export-1</div>' }],
      source: 'studio',
      summary: 'After export col ref',
    });
    assert.equal(afterExportCol.coalesced, false);
    assert.equal(afterExportCol.versionNumber, 3);
    assert.notEqual(afterExportCol.versionId, edit5.versionId);

    // Also verify jobs referencing versionId via input_payload.versionId freezes v3!
    h.pgClient.seed('jobs', {
      id: randomUUID(),
      workspace_id: h.authA.workspaceId,
      project_id: proj.projectId,
      kind: 'export_render',
      state: 'completed',
      stage: 'done',
      progress: 100,
      version_id: null,
      input_payload: { versionId: afterExportCol.versionId },
      created_at: new Date(clockMs).toISOString(),
      updated_at: new Date(clockMs).toISOString(),
    });
    clockMs += 100;
    const afterExportPayload = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">post-export-2</div>' }],
      source: 'studio',
      summary: 'After export payload ref',
    });
    assert.equal(afterExportPayload.coalesced, false);
    assert.equal(afterExportPayload.versionNumber, 4);

    // Boundary 2: Pinning the head history entry freezes v4 -> next Studio edit allocates v5!
    const histBeforePin = await h.history.listHistory(h.authA, proj.projectId);
    const headEntry = histBeforePin.entries.find((e) => e.versionId === afterExportPayload.versionId)!;
    await h.history.pinEntry(h.authA, proj.projectId, headEntry.id, true);

    clockMs += 100;
    const afterPin = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">post-pin</div>' }],
      source: 'studio',
      summary: 'After pin',
    });
    assert.equal(afterPin.coalesced, false);
    assert.equal(afterPin.versionNumber, 5);

    // Boundary 3: MCP / Agent edit NEVER coalesces into Studio head (allocates v6),
    // and subsequent Studio edit NEVER coalesces into Agent head (allocates v7)!
    clockMs += 100;
    const mcpEdit = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">mcp-edit</div>' }],
      source: 'agent',
      actorKind: 'agent',
      summary: 'Agent update',
    });
    assert.equal(mcpEdit.coalesced, false);
    assert.equal(mcpEdit.versionNumber, 6);

    clockMs += 100;
    const studioAfterMcp = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">studio-after-mcp</div>' }],
      source: 'studio',
      summary: 'Studio after agent',
    });
    assert.equal(studioAfterMcp.coalesced, false);
    assert.equal(studioAfterMcp.versionNumber, 7);

    // Boundary 4: Advancing clock past 4000ms allocates a new immutable version (v8)!
    clockMs += 4500;
    const afterWindow = await h.files.commitChanges(h.authA, {
      projectId: proj.projectId,
      ops: [{ op: 'upsert_text', path: 'index.html', content: '<div data-composition-id="main">after-4s</div>' }],
      source: 'studio',
      summary: 'After window elapsed',
    });
    assert.equal(afterWindow.coalesced, false);
    assert.equal(afterWindow.versionNumber, 8);

    // Verify v2 frozen export snapshot STILL contains drag-5 intact!
    const v2Peek = await h.history.peekPoint(h.authA, proj.projectId, edit5.versionId!, 'index.html');
    assert.equal(v2Peek.file?.content, '<div data-composition-id="main">drag-5</div>');

    assertExactWorkspaceRefCounts('after-all-boundaries');

    // Permanent delete cleanly decrements all refs with zero underflow!
    await h.workspace.trashProject(h.authA, proj.projectId);
    const del = await h.workspace.deleteProjectPermanently(h.authA, proj.projectId);
    assert.equal(del.deleted, true);
    assert.equal(del.activeProjectId, keep.projectId);
    assertExactWorkspaceRefCounts('after-permanent-delete');
  });
});
