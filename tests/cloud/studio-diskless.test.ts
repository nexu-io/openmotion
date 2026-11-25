import assert from 'node:assert/strict';
import { McpToolDispatcher } from '../../src/mcp/tool-dispatcher.ts';
import { parseConfig } from '../../src/infra/config.ts';
import { parseHTMLContent } from '@hyperframes/core/compiler';
import { ensureHfIds } from '@hyperframes/parsers/hf-ids';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { projectChannel } from '../../src/infra/redis.ts';
import { PreviewBuildBusy, PreviewDocumentCache } from '../../src/studio/engine/preview-document-cache.ts';
import { createPreviewBridgeAssets } from '../../src/studio/routes/preview-bridge-assets.ts';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { StudioVariables } from '../../src/studio/context.ts';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { AuthContext } from '../../src/contracts/auth.ts';
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
import { createArchivesRouter } from '../../src/routes/archives.ts';
import { createProjectsRouter } from '../../src/routes/projects.ts';
import { createSessionsRouter } from '../../src/routes/sessions.ts';
import { AssetNamesService } from '../../src/services/asset-names-service.ts';
import { ProjectArchiveService } from '../../src/services/project-archive-service.ts';
import {
  ProjectFilesService,
  type HotTextCachePort,
} from '../../src/services/project-files-service.ts';
import { VersionHistoryService } from '../../src/services/version-history-service.ts';
import { WorkRoundsService } from '../../src/services/work-rounds-service.ts';
import { WorkspaceService } from '../../src/services/workspace-service.ts';
import {
  DELETED_VERSION,
  InMemoryVirtualProject,
  buildSubCompositionHtmlInMemory,
  bundlePreviewInMemory,
  createDisklessStudioApp,
  fileContentVersion,
  infoInMemory,
  lintProjectInMemory,
  sha256Hex,
  timelineInMemory,
  type StudioEventBusPort,
  type StudioQueuesPort,
  type VirtualFileRecord,
} from '../../src/studio/index.ts';
import { compThumbnailKey, derivedAssetKey, exportKey, thumbnailKey } from '../../src/infra/storage.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------------------
// Compact Self-Contained In-Memory Drizzle PG + S3 + Redis Test Harness
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const UUID_TABLES = new Set([
  'workspaces',
  'sessions',
  'projects',
  'work_rounds',
  'project_versions',
  'project_history_entries',
  'jobs',
]);

class StudioTestPgClient {
  readonly tables = new Map<string, Row[]>();
  selectCount = 0;
  private snap: Map<string, Row[]> | null = null;

  constructor() {
    for (const t of [
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
      'upload_tickets',
      'idempotency_receipts',
    ]) {
      this.tables.set(t, []);
    }
  }

  seed(table: string, row: Row): void {
    this.tables.get(table)!.push({ ...row });
  }

  rows(table: string): Row[] {
    return this.tables.get(table)!;
  }

  async query(config: string | { text: string; rowMode?: string }, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const sqlText = (typeof config === 'string' ? config : config.text).trim();
    const rowMode = typeof config === 'string' ? undefined : config.rowMode;
    const upper = sqlText.toUpperCase();

    if (upper === 'BEGIN' || upper.startsWith('BEGIN ')) {
      this.snap = new Map([...this.tables.entries()].map(([k, v]) => [k, v.map((r) => structuredClone(r))]));
      return { rows: [] };
    }
    if (upper === 'COMMIT') {
      this.snap = null;
      return { rows: [] };
    }
    if (upper === 'ROLLBACK') {
      if (this.snap) {
        this.tables.clear();
        for (const [k, v] of this.snap) this.tables.set(k, v);
        this.snap = null;
      }
      return { rows: [] };
    }
    if (upper.startsWith('SELECT ')) return this.select(sqlText, params, rowMode);
    if (upper.startsWith('INSERT INTO ')) return this.insert(sqlText, params, rowMode);
    if (upper.startsWith('UPDATE ')) return this.update(sqlText, params, rowMode);
    if (upper.startsWith('DELETE FROM ')) return this.del(sqlText, params, rowMode);
    throw new Error(`Unsupported SQL: ${sqlText}`);
  }

  private select(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    this.selectCount++;
    const cleaned = sqlText.replace(/\s+for\s+update\s*$/i, '').trim();
    const m = /^select\s+([\s\S]+?)\s+from\s+"([^"]+)"([\s\S]*)$/i.exec(cleaned)!;
    const selectList = m[1].trim();
    const table = m[2];
    let rem = m[3].trim();
    let limit: number | null = null;
    let order = '';
    let where = '';

    const limM = /\s+limit\s+(\$\d+|\d+)\s*$/i.exec(rem);
    if (limM) {
      limit = limM[1].startsWith('$') ? Number(params[Number(limM[1].slice(1)) - 1]) : Number(limM[1]);
      rem = rem.slice(0, limM.index).trim();
    }
    const ordM = /\s+order\s+by\s+([\s\S]+)$/i.exec(rem);
    if (ordM) {
      order = ordM[1].trim();
      rem = rem.slice(0, ordM.index).trim();
    }
    const whereIdx = findKw(rem, 'where');
    const joinsClause = whereIdx >= 0 ? rem.slice(0, whereIdx).trim() : /^left\s+/i.test(rem) ? rem : '';
    if (whereIdx >= 0) where = rem.slice(whereIdx + 5).trim();

    if (joinsClause) {
      const joins: { table: string; on: string }[] = [];
      let jc = joinsClause;
      while (jc) {
        const jm = /^left\s+(?:outer\s+)?join\s+"([^"]+)"\s+on\s+/i.exec(jc);
        if (!jm) throw new Error(`Unsupported JOIN: ${sqlText}`);
        const joinTable = jm[1];
        const afterOn = jc.slice(jm[0].length);
        const nextJoinIdx = findKw(afterOn, 'left');
        const onExpr = nextJoinIdx >= 0 ? afterOn.slice(0, nextJoinIdx).trim() : afterOn.trim();
        joins.push({ table: joinTable, on: onExpr });
        jc = nextJoinIdx >= 0 ? afterOn.slice(nextJoinIdx).trim() : '';
      }
      let combined: Map<string, Row | null>[] = this.rows(table).map((r) => new Map([[table, r]]));
      for (const j of joins) {
        const next: Map<string, Row | null>[] = [];
        for (const rowMap of combined) {
          let found = false;
          for (const candidate of this.rows(j.table)) {
            const merged = new Map(rowMap);
            merged.set(j.table, candidate);
            if (evalJoinedW(merged, j.on, params)) {
              next.push(merged);
              found = true;
            }
          }
          if (!found) {
            const merged = new Map(rowMap);
            merged.set(j.table, null);
            next.push(merged);
          }
        }
        combined = next;
      }
      if (where) combined = combined.filter((rowMap) => evalJoinedW(rowMap, where, params));
      if (limit !== null) combined = combined.slice(0, limit);
      const specs = splitTop(selectList, ',').map(qualifiedCol);
      return {
        rows: combined.map((rowMap) =>
          rowMode === 'array'
            ? specs.map((s) => (s.table ? rowMap.get(s.table)?.[s.col] : rowMap.get(table)?.[s.col]) ?? null)
            : Object.fromEntries(
                specs.map((s) => [s.col, (s.table ? rowMap.get(s.table)?.[s.col] : rowMap.get(table)?.[s.col]) ?? null]),
              ),
        ),
      };
    }

    let matched = this.rows(table).filter((r) => (where ? evalW(r, where, params) : true));
    if (/^COALESCE\s*\(\s*MAX\s*\(/i.test(selectList)) {
      const col = /MAX\s*\(\s*"([^"]+)"\s*\)/i.exec(selectList)![1];
      const maxVal = matched.reduce((acc, r) => Math.max(acc, Number(r[col] ?? 0)), 0);
      return { rows: [rowMode === 'array' ? [maxVal] : { maxVal }] };
    }
    if (order) {
      const specs = splitTop(order, ',').map((p) => {
        const parts = p.trim().split(/\s+/);
        return { col: colName(parts[0]), dir: parts[1]?.toLowerCase() === 'desc' ? -1 : 1 };
      });
      matched = [...matched].sort((a, b) => {
        for (const s of specs) {
          const av = sortVal(a[s.col]);
          const bv = sortVal(b[s.col]);
          if (av < bv) return -s.dir;
          if (av > bv) return s.dir;
        }
        return 0;
      });
    }
    if (limit !== null) matched = matched.slice(0, limit);
    const cols = splitTop(selectList, ',').map(colName);
    return { rows: fmtRows(matched, cols, rowMode) };
  }

  private insert(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const confM = /\s+on\s+conflict\s*\(([^)]+)\)\s+do\s+update\s+set\s+([\s\S]+)$/i.exec(noRet);
    const target = confM ? splitTop(confM[1], ',').map(colName) : null;
    let setC = '';
    let whereC = '';
    if (confM) {
      const idx = findKw(confM[2].trim(), 'where');
      setC = idx >= 0 ? confM[2].trim().slice(0, idx).trim() : confM[2].trim();
      whereC = idx >= 0 ? confM[2].trim().slice(idx + 5).trim() : '';
    }
    const base = confM ? noRet.slice(0, confM.index).trim() : noRet;
    const hM = /^insert\s+into\s+"([^"]+)"\s*\(([^)]+)\)\s+values\s+([\s\S]+)$/i.exec(base)!;
    const table = hM[1];
    const cols = splitTop(hM[2], ',').map(colName);
    const tuples = splitTuples(hM[3].trim());
    const rows = this.rows(table);
    const out: Row[] = [];

    for (const t of tuples) {
      const exprs = splitTop(t, ',');
      const row: Row = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = evalInsVal(table, cols[i], exprs[i].trim(), params);
      }
      if (UUID_TABLES.has(table) && !row.id) row.id = randomUUID();
      if (table === 'projects') {
        if (!row.artifact_id) row.artifact_id = randomUUID();
        if (row.asset_name_allocations === undefined) row.asset_name_allocations = {};
        if (row.reviews === undefined) row.reviews = [];
        if (row.trashed === undefined) row.trashed = false;
        if (row.trashed_at === undefined) row.trashed_at = null;
      }
      if (table === 'workspace_blobs' && !row.gc_state) row.gc_state = 'active';
      if (target) {
        const existing = rows.find((r) => target.every((k) => r[k] === row[k]));
        if (existing) {
          if (whereC && !evalW(existing, whereC, params)) continue;
          applySet(existing, setC, params);
          out.push(existing);
          continue;
        }
      }
      rows.push(row);
      out.push(row);
    }
    return { rows: retCols ? fmtRows(out, retCols, rowMode) : [] };
  }

  private update(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const m = /^update\s+"([^"]+)"\s+set\s+([\s\S]+)$/i.exec(noRet)!;
    const table = m[1];
    const body = m[2].trim();
    const wIdx = findKw(body, 'where');
    const setC = wIdx >= 0 ? body.slice(0, wIdx).trim() : body;
    const whereC = wIdx >= 0 ? body.slice(wIdx + 5).trim() : '';
    const matched = this.rows(table).filter((r) => (whereC ? evalW(r, whereC, params) : true));
    for (const r of matched) applySet(r, setC, params);
    return { rows: retCols ? fmtRows(matched, retCols, rowMode) : [] };
  }

  private del(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const m = /^delete\s+from\s+"([^"]+)"(?:\s+where\s+([\s\S]+))?$/i.exec(noRet)!;
    const table = m[1];
    const whereC = m[2]?.trim() ?? '';
    const kept: Row[] = [];
    const removed: Row[] = [];
    for (const r of this.rows(table)) {
      if (!whereC || evalW(r, whereC, params)) removed.push(r);
      else kept.push(r);
    }
    this.tables.set(table, kept);
    return { rows: retCols ? fmtRows(removed, retCols, rowMode) : [] };
  }
}

function colName(expr: string): string {
  const m = [...expr.trim().replace(/\s+as\s+"[^"]+"$/i, '').matchAll(/"([^"]+)"/g)];
  return m.length > 0 ? m[m.length - 1][1] : expr.trim();
}
function qualifiedCol(expr: string): { table?: string; col: string } {
  const trimmed = expr.trim().replace(/\s+as\s+"[^"]+"$/i, '').trim();
  const m = [...trimmed.matchAll(/"([^"]+)"/g)];
  if (m.length >= 2) return { table: m[m.length - 2][1], col: m[m.length - 1][1] };
  return { col: m.length === 1 ? m[0][1] : trimmed };
}
function evalJoinedOperand(rowMap: Map<string, Row | null>, expr: string, params: unknown[]): unknown {
  const t = expr.trim();
  const qm = /^"([^"]+)"\."([^"]+)"$/.exec(t);
  if (qm) return rowMap.get(qm[1])?.[qm[2]] ?? null;
  return evalSc(t, params);
}
function evalJoinedW(rowMap: Map<string, Row | null>, raw: string, params: unknown[]): boolean {
  const terms = splitAnd(stripP(raw));
  if (terms.length > 1) return terms.every((t) => evalJoinedW(rowMap, t, params));
  const term = stripP(terms[0]);
  let m: RegExpExecArray | null;
  if ((m = /^([\s\S]+?)\s+is\s+null$/i.exec(term))) return evalJoinedOperand(rowMap, m[1], params) == null;
  if ((m = /^([\s\S]+?)\s+is\s+not\s+null$/i.exec(term))) return evalJoinedOperand(rowMap, m[1], params) != null;
  if ((m = /^([\s\S]+?)\s+in\s*\(([\s\S]+)\)$/i.exec(term))) {
    const lv = evalJoinedOperand(rowMap, m[1], params);
    return lv != null && splitTop(m[2], ',').map((v) => evalJoinedOperand(rowMap, v, params)).includes(lv);
  }
  if ((m = /^([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(term))) {
    const lv = evalJoinedOperand(rowMap, m[1], params);
    const rv = evalJoinedOperand(rowMap, m[2], params);
    return lv !== null && rv !== null && lv === rv;
  }
  throw new Error(`Unsupported joined WHERE: ${term}`);
}
function splitTop(input: string, sep: string): string[] {
  const out: string[] = [];
  let d = 0, sq = false, dq = false, st = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (d === 0 && input.slice(i, i + sep.length) === sep) {
        out.push(input.slice(st, i));
        st = i + sep.length;
        i += sep.length - 1;
      }
    }
  }
  out.push(input.slice(st));
  return out;
}
function splitTuples(input: string): string[] {
  const out: string[] = [];
  let d = 0, sq = false, dq = false, st = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') { if (d === 0) st = i + 1; d++; }
      else if (c === ')') { d--; if (d === 0 && st >= 0) { out.push(input.slice(st, i)); st = -1; } }
    }
  }
  return out;
}
function findKw(input: string, kw: string): number {
  const lo = input.toLowerCase();
  let d = 0, sq = false, dq = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (d === 0 && lo.slice(i, i + kw.length) === kw && (i === 0 || /\s/.test(input[i - 1])) && (i + kw.length === input.length || /\s/.test(input[i + kw.length]))) return i;
    }
  }
  return -1;
}
function evalSc(expr: string, params: unknown[]): unknown {
  const t = expr.trim();
  if (/^\$\d+$/.test(t)) {
    const v = params[Number(t.slice(1)) - 1];
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }
  if (/^null$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^now\(\)$/i.test(t)) return new Date().toISOString();
  if (/^'([^']*)'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}
function evalInsVal(table: string, col: string, expr: string, params: unknown[]): unknown {
  if (/^default$/i.test(expr)) {
    if (col === 'id' && UUID_TABLES.has(table)) return randomUUID();
    if (col === 'artifact_id') return randomUUID();
    if (col.endsWith('_at') || col === 'started_at' || col === 'ended_at') return new Date().toISOString();
    if (col === 'expires_at') return new Date(Date.now() + 86_400_000).toISOString();
    if (['pinned', 'undone', 'trashed', 'remote_terminal', 'save_pending'].includes(col)) return false;
    if (['current_version_number', 'current_history_seq', 'progress'].includes(col)) return 0;
    if (['asset_name_allocations', 'input_payload', 'default_models'].includes(col)) return {};
    if (col === 'reviews') return [];
    if (col === 'gc_state') return 'active';
    if (col === 'state') return table === 'jobs' ? 'queued' : 'pending';
    if (col === 'mode') return 'motion';
    return null;
  }
  return evalSc(expr, params);
}
function stripP(s: string): string {
  let out = s.trim();
  while (out.startsWith('(') && out.endsWith(')')) {
    let d = 0, ok = true;
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === '(') d++;
      else if (out[i] === ')') d--;
      if (d === 0) { ok = false; break; }
    }
    if (!ok) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}
function splitAnd(expr: string): string[] {
  const parts: string[] = [];
  let d = 0, sq = false, dq = false, st = 0;
  const lo = expr.toLowerCase();
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (d === 0 && lo.slice(i, i + 3) === 'and' && i > 0 && /\s/.test(expr[i - 1]) && i + 3 < expr.length && /\s/.test(expr[i + 3])) {
        parts.push(expr.slice(st, i).trim());
        st = i + 3;
        i += 2;
      }
    }
  }
  parts.push(expr.slice(st).trim());
  return parts;
}
function evalW(row: Row, raw: string, params: unknown[]): boolean {
  const terms = splitAnd(stripP(raw));
  if (terms.length > 1) return terms.every((t) => evalW(row, t, params));
  const term = stripP(terms[0]);
  let m: RegExpExecArray | null;
  if ((m = /^([\s\S]+?)\s+is\s+null$/i.exec(term))) return row[colName(m[1])] == null;
  if ((m = /^([\s\S]+?)\s+is\s+not\s+null$/i.exec(term))) return row[colName(m[1])] != null;
  if ((m = /^([\s\S]+?)\s+in\s*\(([\s\S]+)\)$/i.exec(term))) {
    return splitTop(m[2], ',').map((v) => evalSc(v, params)).includes(row[colName(m[1])]);
  }
  if ((m = /^([\s\S]+?)\s*>=\s*([\s\S]+)$/.exec(term))) return cmpVal(row[colName(m[1])]) >= cmpVal(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*>\s*([\s\S]+)$/.exec(term))) return cmpVal(row[colName(m[1])]) > cmpVal(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*<\s*([\s\S]+)$/.exec(term))) return cmpVal(row[colName(m[1])]) < cmpVal(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(term))) return row[colName(m[1])] === evalSc(m[2], params);
  throw new Error(`Unsupported WHERE: ${term}`);
}
function applySet(row: Row, setC: string, params: unknown[]): void {
  for (const a of splitTop(setC, ',')) {
    const eq = a.indexOf('=');
    if (eq < 0) continue;
    const col = colName(a.slice(0, eq));
    const rhs = a.slice(eq + 1).trim();
    let m: RegExpExecArray | null;
    if ((m = /"ref_count"\s*\+\s*(\$\d+)/i.exec(rhs))) {
      row[col] = Number(row.ref_count ?? 0) + Number(evalSc(m[1], params));
    } else if (!/^CASE\b/i.test(rhs) && (m = /"ref_count"\s*-\s*(\$\d+)/i.exec(rhs))) {
      row[col] = Number(row.ref_count ?? 0) - Number(evalSc(m[1], params));
    } else if (/CASE\s+WHEN[\s\S]*?"ref_count"/i.test(rhs)) {
      row[col] = Number(row.ref_count ?? 0) === 0 ? new Date().toISOString() : null;
    } else if ((m = /COALESCE\([\s\S]*?"metadata"[\s\S]*?\)\s*\|\|\s*(\$\d+)::jsonb/i.exec(rhs))) {
      const inc = evalSc(m[1], params);
      row[col] = { ...((row[col] as Record<string, unknown>) ?? {}), ...((inc as Record<string, unknown>) ?? {}) };
    } else {
      row[col] = evalSc(rhs, params);
    }
  }
}
function cmpVal(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return Date.parse(v);
  return Number(v);
}
function sortVal(v: unknown): string | number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return Date.parse(v);
  return String(v ?? '');
}
function fmtRows(rows: readonly Row[], cols: readonly string[], rowMode?: string): unknown[] {
  return rows.map((r) =>
    rowMode === 'array'
      ? cols.map((c) => r[c] ?? null)
      : Object.fromEntries(cols.map((c) => [c, r[c] ?? null])),
  );
}

class MockStorage implements StoragePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  presignGetCalls = 0;

  async putObject(key: string, body: Buffer | Uint8Array | Readable | string, contentType: string): Promise<void> {
    const buf = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : Buffer.from(body as Uint8Array);
    this.objects.set(key, { body: buf, contentType });
  }
  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    if (this.objects.has(key)) return { uploaded: false };
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return { uploaded: true };
  }
  async getObjectBuffer(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`Missing key: ${key}`);
    return Buffer.from(found.body);
  }
  async getObjectStream(key: string): Promise<ObjectStreamResult> {
    const buf = await this.getObjectBuffer(key);
    return { stream: Readable.from([buf]), contentLength: buf.byteLength };
  }
  async headObject(key: string): Promise<HeadObjectResult | null> {
    const found = this.objects.get(key);
    return found ? { contentLength: found.body.byteLength, contentType: found.contentType } : null;
  }
  async deleteObject(key: string): Promise<void> { this.objects.delete(key); }
  async deletePrefix(): Promise<number> { return 0; }
  async presignPut(key: string, _opts: PresignPutOptions): Promise<string> { return `https://s3.local/${key}?sig=put`; }
  async presignGet(key: string, opts?: PresignGetOptions): Promise<string> {
    this.presignGetCalls++;
    const disp = opts?.responseContentDisposition ? `&disp=${encodeURIComponent(opts.responseContentDisposition)}` : '';
    return `https://s3.local/${key}?sig=get${disp}`;
  }
  async ensureBucketAndCors(): Promise<void> {}
}

function createStudioTestEnv(options?: { renderProgressKeepaliveMs?: number; programmatic?: boolean; fontCatalog?: Parameters<typeof createDisklessStudioApp>[0]['fontCatalog'] }) {
  const pgClient = new StudioTestPgClient();
  const db = drizzle({ client: pgClient as never, schema }) as unknown as Database;
  const storage = new MockStorage();
  const textCache = new Map<string, string>();
  const fontCssCache = new Map<string, string>();
  const hotTextCache: HotTextCachePort = {
    getText: async (s) => textCache.get(s) ?? null,
    setText: async (s, c) => { textCache.set(s, c); return true; },
    getFontCss: async (h) => fontCssCache.get(h) ?? null,
    setFontCss: async (h, c) => { fontCssCache.set(h, c); return true; },
  };
  const published: Array<{ channel: string; payload: unknown }> = [];
  const listeners = new Map<string, Set<(payload: unknown, ch: string) => void>>();
  const workerHealth: RenderWorkerHealth[] = [
    { workerId: 'render-1', ffmpeg: true, ffprobe: true, chromium: true, concurrency: 2, activeJobs: 0, updatedAt: Date.now() },
  ];
  const eventBus: StudioEventBusPort = {
    publish: async (ch, payload) => {
      published.push({ channel: ch, payload });
      const set = listeners.get(ch);
      if (set) for (const fn of set) fn(payload, ch);
      return set?.size ?? 0;
    },
    subscribe: async (ch, fn) => {
      let set = listeners.get(ch);
      if (!set) { set = new Set(); listeners.set(ch, set); }
      set.add(fn);
      return async () => { set?.delete(fn); };
    },
    getRenderWorkersHealth: async () => workerHealth,
  };
  const enqueued: Array<{ queue: string; name: string; payload: unknown }> = [];
  const queues: StudioQueuesPort = {
    enqueueMediaIngest: async (name, payload) => { enqueued.push({ queue: 'media-ingest', name, payload }); return { id: 'q1' }; },
    enqueueRenderExport: async (name, payload) => { enqueued.push({ queue: 'render-export', name, payload }); return { id: 'q2' }; },
  };

  const WID = '11111111-1111-4111-8111-111111111111';
  const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  pgClient.seed('workspaces', {
    id: WID,
    slug: 'demo',
    name: 'Demo Workspace',
    owner_user_id: UID,
    active_project_id: null,
    active_session_id: null,
    default_models: {},
    tracking_enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const auth: AuthContext = {
    workspaceId: WID,
    userId: UID,
    role: 'owner',
    scopes: ['workspace:admin'],
    authMode: 'dev',
    authMethod: options?.programmatic ? 'pat' : 'session_cookie',
    entry: options?.programmatic ? 'api' : 'web',
    displayName: 'Studio Tester',
  };

  const files = new ProjectFilesService({ db, storage, hotTextCache, eventBus });
  const history = new VersionHistoryService({ db, storage, hotTextCache, eventBus });
  const workspace = new WorkspaceService({ db, storage, files, hotTextCache });
  const assetNames = new AssetNamesService({ db, files });
  const workRounds = new WorkRoundsService(db);
  const archives = new ProjectArchiveService({ db, storage, workspace, files });

  const createStudioApp = () => createDisklessStudioApp({
    db,
    storage,
    hotTextCache,
    eventBus,
    queues,
    workspace,
    files,
    history,
    assetNames,
    workRounds,
    resolveAuth: () => auth,
    skipDeterministicFonts: true,
    fontCatalog: options?.fontCatalog,
    ...(options?.renderProgressKeepaliveMs !== undefined
      ? { renderProgressKeepaliveMs: options.renderProgressKeepaliveMs }
      : {}),
  });

  const projectsApp = createProjectsRouter({
    workspace,
    files,
    history,
    assetNames,
    workRounds,
    archives,
    resolveAuth: () => auth,
  });
  const sessionsApp = createSessionsRouter({ workspace, resolveAuth: () => auth });
  const archivesApp = createArchivesRouter({ archives, resolveAuth: () => auth });

  return {
    pgClient,
    storage,
    hotTextCache,
    eventBus,
    published,
    enqueued,
    workerHealth,
    auth,
    files,
    history,
    workspace,
    studioApp: createStudioApp(),
    createStudioApp,
    projectsApp,
    sessionsApp,
    archivesApp,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Zero Local ProjectDir Disk Writes Guard', () => {
  it('verifies no service or studio file writes to local filesystem or references HYPERFRAMES_HISTORY_ROOT', async () => {
    const collectTs = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await collectTs(full)));
        else if (e.isFile() && e.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };

    const ownedFiles = [
      path.join(REPO_ROOT, 'src/services/workspace-service.ts'),
      path.join(REPO_ROOT, 'src/services/project-files-service.ts'),
      path.join(REPO_ROOT, 'src/services/version-history-service.ts'),
      path.join(REPO_ROOT, 'src/services/project-archive-service.ts'),
      path.join(REPO_ROOT, 'src/services/asset-names-service.ts'),
      path.join(REPO_ROOT, 'src/services/work-rounds-service.ts'),
      ...(await collectTs(path.join(REPO_ROOT, 'src/studio'))),
      path.join(REPO_ROOT, 'src/routes/projects.ts'),
      path.join(REPO_ROOT, 'src/routes/sessions.ts'),
      path.join(REPO_ROOT, 'src/routes/archives.ts'),
    ];

    for (const file of ownedFiles) {
      const src = await readFile(file, 'utf8');
      assert.doesNotMatch(src, /\b(?:writeFile|writeFileSync|mkdir|mkdirSync|unlink|unlinkSync|rmSync)\b/, `Forbidden disk write in ${file}`);
      assert.doesNotMatch(src, /HYPERFRAMES_HISTORY_ROOT/, `Forbidden local history root reference in ${file}`);
      assert.doesNotMatch(src, /\bspawn\s*\(|\bexecFile\s*\(/, `Forbidden child process spawn in ${file}`);
    }
  });
});

describe('Pure In-Memory Hyperframes Engines (Bundle, Lint, Info, Timeline)', () => {
  it('shares versioned large scripts between interactive project and clip previews', async () => {
    const script = '/*' + 'v'.repeat(40 * 1024) + '*/window.vendorReady = true;';
    const sources = {
      'index.html': '<html><head><script src="vendor.js"></script></head><body></body></html>',
      'vendor.js': script,
      'compositions/clip.html': '<div data-composition-id="clip">Clip</div>',
    };
    const project = new InMemoryVirtualProject({
      projectId: 'fixture', projectName: 'Fixture', revision: 'a'.repeat(64), textContents: sources,
      files: Object.entries(sources).map(([path, content]) => ({
        path, blobScope: 'workspace', sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content),
        mimeType: path.endsWith('.js') ? 'text/javascript' : 'text/html', isText: true, updatedAt: new Date(),
      })),
    });
    const options = { baseHref: 'https://preview.example/authorized/', skipDeterministicFonts: true };
    const interactive = await bundlePreviewInMemory(project, { ...options, cacheProjectScripts: true });
    assert.ok(interactive);
    const pinned = options.baseHref + 'vendor.js?om-script=' + sha256Hex(script);
    assert.ok(interactive.includes(pinned));
    const clip = await buildSubCompositionHtmlInMemory(project, 'compositions/clip.html', { ...options, cacheProjectScripts: true });
    assert.ok(clip?.includes(pinned));
    assert.ok(!interactive.includes(script));
    assert.ok((await bundlePreviewInMemory(project, options))?.includes(script));
  });

  it('keeps deferred composition scripts with the scene that mounts their DOM', async () => {
    const sources = {
      'index.html': '<html><body><div data-composition-id="main"><div data-composition-id="later" data-composition-src="later.html" data-start="15" data-duration="3"></div></div><script>window.rootReady = true;</script></body></html>',
      'later.html': '<template><div data-composition-id="later"><canvas id="reel"></canvas></div><script>document.getElementById("reel").getContext("2d");</script></template>',
    };
    const project = new InMemoryVirtualProject({
      projectId: 'scene-script', projectName: 'Scene script', revision: 'b'.repeat(64),
      textContents: sources,
      files: Object.entries(sources).map(([path, content]) => ({
        path, blobScope: 'workspace', sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content),
        mimeType: 'text/html', isText: true, updatedAt: new Date(),
      })),
    });
    const bundled = await bundlePreviewInMemory(project, { skipDeterministicFonts: true });
    assert.ok(bundled);
    const scripts = [...bundled.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    const scene = scripts.find(([, , body]) => body.includes('getElementById("reel")'));
    assert.ok(scene);
    assert.match(scene[1], /data-hf-scene="later"/);
    assert.ok(!scene[2].includes('window.rootReady'));
  });

  it('bundles preview HTML, lints with PG blob metadata (no ffprobe), and computes info + timeline purely in memory', async () => {
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head>
<body>
  <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="10">
    <video id="clip1" src="assets/clip.mp4" data-start="0" data-duration="5" data-media-start="12"></video>
    <h1 id="headline" data-start="1" data-duration="4">Hello Diskless</h1>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.to("#headline", { opacity: 1, duration: 1 }, 1);
  </script>
</body>
</html>`;
    const css = '#headline { font-size: 64px; }';
    const now = new Date();
    const records: VirtualFileRecord[] = [
      {
        path: 'index.html',
        blobScope: 'workspace',
        sha256: sha256Hex(html),
        sizeBytes: Buffer.byteLength(html),
        mimeType: 'text/html; charset=utf-8',
        isText: true,
        updatedAt: now,
      },
      {
        path: 'styles.css',
        blobScope: 'workspace',
        sha256: sha256Hex(css),
        sizeBytes: Buffer.byteLength(css),
        mimeType: 'text/css; charset=utf-8',
        isText: true,
        updatedAt: now,
      },
      {
        path: 'assets/clip.mp4',
        blobScope: 'workspace',
        sha256: 'a'.repeat(64),
        sizeBytes: 2048,
        mimeType: 'video/mp4',
        isText: false,
        updatedAt: now,
        // Metadata from PG workspace_blobs: duration 8s (so media-start=12 is past EOF!) and codec hevc!
        metadata: { modality: 'video', durationSec: 8, codec: 'hevc', width: 1920, height: 1080, fps: 30 },
      },
    ];

    const virtual = new InMemoryVirtualProject({
      projectId: 'proj-virtual',
      projectName: 'Diskless Engine Test',
      revision: 'b'.repeat(64),
      files: records,
      textContents: { 'index.html': html, 'styles.css': css },
    });

    const bundled = await bundlePreviewInMemory(virtual, {
      runtimeUrl: '/api/runtime.js',
      baseHref: '/api/projects/proj-virtual/preview/',
      skipDeterministicFonts: true,
    });
    assert.ok(bundled && bundled.includes('hyperframes-studio-preview'));
    assert.ok(bundled.includes('/api/runtime.js'));
    assert.ok(bundled.includes('Hello Diskless'));

    const lint = await lintProjectInMemory(virtual);
    const rules = lint.findings.map((f) => f.code);
    assert.ok(rules.includes('video_media_start_past_eof'), `Expected media_start_past_eof in ${rules.join(',')}`);
    assert.ok(rules.includes('hevc_preview_codec'), `Expected hevc_preview_codec in ${rules.join(',')}`);

    const info = infoInMemory(virtual);
    assert.equal(info.width, 1920);
    assert.equal(info.height, 1080);
    assert.equal(info.fps, 30);
    assert.equal(info.duration, 10);
    assert.equal(info.resolution, 'landscape');

    const timeline = timelineInMemory(virtual);
    assert.equal(timeline.duration, 10);
    assert.equal(timeline.fps, 30);
    assert.ok(timeline.tracks.length >= 1);
  });

  it('adds crossorigin="anonymous" only to project-local audio/video media in root and sub-composition previews', async () => {
    const html = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <div id="root" data-composition-id="root" data-width="1920" data-height="1080" data-fps="30" data-duration="10">
      <audio id="local-audio" src="assets/lfs/soundtrack.m4a" data-start="0"></audio>
      <video id="local-video" src="/api/projects/proj-cors/preview/assets/intro.mp4" data-start="0"></video>
      <audio id="source-audio" data-start="0"><source src="assets/voice.mp3" type="audio/mpeg"></audio>
      <audio id="explicit-cors" src="assets/custom.m4a" crossorigin="use-credentials"></audio>
      <audio id="external-audio" src="https://cdn.example.com/song.mp3"></audio>
      <audio id="proto-rel-audio" src="//cdn.example.com/song.mp3"></audio>
      <audio id="data-audio" src="data:audio/wav;base64,UklGRg=="></audio>
      <audio id="empty-audio"></audio>
      <template id="tpl-audio"><audio id="in-template" src="assets/tpl.m4a"></audio></template>
    </div>
  </body>
</html>`;
    const subCompHtml = `<template id="scene-a-template">
  <div data-composition-id="scene-a" data-width="1920" data-height="1080" data-fps="30" data-duration="5">
    <audio id="sub-local" src="../assets/sub.m4a" data-start="0"></audio>
    <audio id="sub-ext" src="https://cdn.example.com/ext.mp3" data-start="0"></audio>
  </div>
</template>`;
    const now = new Date();
    const virtual = new InMemoryVirtualProject({
      projectId: 'proj-cors',
      projectName: 'CORS Media Test',
      revision: 'c'.repeat(64),
      files: [
        {
          path: 'index.html',
          blobScope: 'workspace',
          sha256: sha256Hex(html),
          sizeBytes: Buffer.byteLength(html),
          mimeType: 'text/html; charset=utf-8',
          isText: true,
          updatedAt: now,
        },
        {
          path: 'compositions/scene-a.html',
          blobScope: 'workspace',
          sha256: sha256Hex(subCompHtml),
          sizeBytes: Buffer.byteLength(subCompHtml),
          mimeType: 'text/html; charset=utf-8',
          isText: true,
          updatedAt: now,
        },
        {
          path: 'assets/sub.m4a',
          blobScope: 'workspace',
          sha256: 'd'.repeat(64),
          sizeBytes: 128,
          mimeType: 'audio/mp4',
          isText: false,
          updatedAt: now,
        },
      ],
      textContents: {
        'index.html': html,
        'compositions/scene-a.html': subCompHtml,
      },
    });

    const tagById = (docHtml: string, id: string): string => {
      const match = new RegExp(`<(?:audio|video)\\b[^>]*\\bid="${id}"[^>]*>`, 'i').exec(docHtml);
      assert.ok(match, `Expected element #${id}`);
      return match[0];
    };

    const bundled = await bundlePreviewInMemory(virtual, {
      runtimeUrl: '/api/runtime.js',
      baseHref: '/api/projects/proj-cors/preview/',
      skipDeterministicFonts: true,
    });
    assert.ok(bundled);
    assert.match(tagById(bundled, 'local-audio'), /\bcrossorigin="anonymous"/i);
    assert.match(tagById(bundled, 'local-video'), /\bcrossorigin="anonymous"/i);
    assert.match(tagById(bundled, 'source-audio'), /\bcrossorigin="anonymous"/i);
    assert.match(tagById(bundled, 'explicit-cors'), /\bcrossorigin="use-credentials"/i);
    assert.doesNotMatch(tagById(bundled, 'external-audio'), /\bcrossorigin=/i);
    assert.doesNotMatch(tagById(bundled, 'proto-rel-audio'), /\bcrossorigin=/i);
    assert.doesNotMatch(tagById(bundled, 'data-audio'), /\bcrossorigin=/i);
    assert.doesNotMatch(tagById(bundled, 'empty-audio'), /\bcrossorigin=/i);
    assert.match(tagById(bundled, 'in-template'), /\bcrossorigin="anonymous"/i);

    const subBundled = await buildSubCompositionHtmlInMemory(virtual, 'compositions/scene-a.html', {
      runtimeUrl: '/api/runtime.js',
      baseHref: '/api/projects/proj-cors/preview/',
      skipDeterministicFonts: true,
    });
    assert.ok(subBundled);
    assert.match(tagById(subBundled, 'sub-local'), /\bcrossorigin="anonymous"/i);
    assert.doesNotMatch(tagById(subBundled, 'sub-ext'), /\bcrossorigin=/i);
  });
});

describe('Diskless Studio HTTP Routes (ETag, HEAD direct, 302 headers, DOM & GSAP mutations, Render, Media)', () => {
  it('acknowledges the project event stream after its subscriptions are ready', async () => {
    const env = createStudioTestEnv();
    const project = await env.workspace.createProject(env.auth, { title: 'History stream' });
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const subscribe = env.eventBus.subscribe.bind(env.eventBus);
    let channelCount = 0;
    env.eventBus.subscribe = async (channel, listener) => {
      entered.resolve();
      await proceed.promise;
      const stop = await subscribe(channel, listener);
      channelCount++;
      return stop;
    };
    const response = await env.studioApp.request(`/api/events?projectId=${project.projectId}`);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    try {
      const first = reader.read().then(({ value }) => ({ text: new TextDecoder().decode(value), channelCount }));
      await entered.promise;
      proceed.resolve();
      const acknowledgement = await first;
      assert.match(acknowledgement.text, /event: connected/);
      assert.equal(acknowledgement.channelCount, 3);
    } finally {
      proceed.resolve();
      await reader.cancel();
    }
  });

  it('shares immutable root digest reads across older subscribers without holding up current tabs', async t => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const channel = projectChannel(env.auth.workspaceId, projectId);
    const version = '"patch:' + '1'.repeat(64) + '"';
    const baseUrl = '/api/events?projectId=' + projectId;
    const connect = async (flags = '') => {
      const reader = (await env.studioApp.request(baseUrl + flags)).body!.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/);
      return reader;
    };
    const [modern, older, oldest] = await Promise.all([connect('&orderedEdits=1'), connect(), connect()]);
    const source = Promise.withResolvers<string>();
    const read = t.mock.method(env.files, 'readTextBlob', () => source.promise);
    const get = async (reader: typeof modern) => new TextDecoder().decode((await reader.read()).value);
    try {
      const event = { type: 'files-changed', projectId, paths: ['index.html'], fileVersions: { 'index.html': version } };
      await env.eventBus.publish(channel, event);
      await env.eventBus.publish(channel, { type: 'history-changed', projectId });
      assert.doesNotMatch(await get(modern), /indexHeadHash/);
      assert.match(await get(modern), /history-changed/);
      assert.equal(read.mock.callCount(), 1);
      assert.deepEqual(read.mock.calls[0].arguments, [env.auth.workspaceId, 'patch', '1'.repeat(64)]);
      source.resolve('<html><head>shared style</head><body></body></html>');
      for (const client of [older, oldest]) {
        assert.match(await get(client), new RegExp(sha256Hex('shared style').slice(0, 12)));
        assert.match(await get(client), /history-changed/);
      }
    } finally {
      source.resolve('');
      await Promise.all([modern.cancel(), older.cancel(), oldest.cancel()]);
    }
  });

  it('lists the packaged registry and installs its project files atomically without replacing user changes', async t => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const read = await env.studioApp.request('/api/registry/blocks');
    assert.equal(read.status, 200);
    const { blocks } = await read.json();
    assert(blocks.some((b: { name: string }) => b.name === 'blur-in'));
    assert(blocks.some((b: { name: string }) => b.name === 'aurora'));
    const install = (blockName: string) => env.studioApp.request(`/api/projects/${projectId}/registry/install`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockName }),
    });
    let fail = true;
    const fetcher = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://raw.githubusercontent.com');
      assert.match(url.pathname, /\/registry\/blocks\/aurora\//);
      if (fail && url.pathname.endsWith('.txt')) return new Response(null, { status: 503 });
      return new Response(url.pathname);
    });
    assert.equal((await install('unknown-block')).status, 404);
    assert.equal(fetcher.mock.callCount(), 0);
    assert.equal((await install('aurora')).status, 502);
    assert(!(await env.files.listFiles(env.auth, projectId)).some(file => file.path.includes('aurora')));
    fail = false;
    const saved = await install('aurora');
    assert.equal(saved.status, 200);
    const { block, written } = await saved.json();
    assert.equal(block.name, 'aurora');
    assert.equal(written[0], 'compositions/aurora.html');
    assert.equal(written.length, 3);
    for (const path of written) assert((await env.files.readTextFile(env.auth, projectId, path))?.content.includes('/registry/blocks/aurora/'));
    await env.files.commitChanges(env.auth, { projectId, ops: [{ op: 'upsert_text', path: written[0], content: 'edited' }] });
    const downloads = fetcher.mock.callCount();
    const retry = await install('aurora');
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json()).written, written);
    assert.equal(fetcher.mock.callCount(), downloads);
    assert.equal((await env.files.readTextFile(env.auth, projectId, written[0]))?.content, 'edited');
  });

  it('commits a catalog placement once and undoes a newly installed component with its host', async t => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const host = 'index.html', effect = 'compositions/components/blur-in.html';
    const original = '<main data-composition-id="root"></main>';
    const mounted = '<main data-composition-id="root"><div data-composition-src="' + effect + '"></div></main>';
    await env.files.commitChanges(env.auth, { projectId, ops: [{ op: 'upsert_text', path: host, content: original }] });
    const read = (path: string) => env.files.readTextFile(env.auth, projectId, path);
    const prior = (await read(host))!;
    let fail = true;
    const fetcher = t.mock.method(globalThis, 'fetch', async () => fail
      ? new Response(null, { status: 502 }) : new Response('<div style="background: #000;">Hello</div>'));
    const add = (version: string, requestId = randomUUID()) => env.studioApp.request(`/api/projects/${projectId}/text-edits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
      body: JSON.stringify({ installComponent: 'blur-in', files: [{ path: host, baseVersion: version, content: mounted }], label: 'Add Blur In' }),
    });
    assert.equal((await add(prior.version)).status, 502);
    assert.equal((await read(host))?.version, prior.version);
    assert.equal(await read(effect), null);
    fail = false;
    const id = randomUUID();
    const response = await add(prior.version, id);
    assert.equal(response.status, 200, await response.clone().text());
    const receipt = await response.json();
    assert.deepEqual(receipt.changedPaths.sort(), [effect, host]);
    assert.match((await read(effect))!.content, /background: transparent/);
    const downloads = fetcher.mock.callCount();
    const replay = await add(prior.version, id);
    assert.equal((await replay.json()).versionId, receipt.versionId);
    assert.equal((await add(prior.version)).status, 409);
    assert.equal(fetcher.mock.callCount(), downloads);
    await env.history.step(env.auth, projectId, 'back');
    assert.equal((await read(host))?.version, prior.version);
    assert.equal(await read(effect), null);
    await env.history.step(env.auth, projectId, 'forward');
    assert.equal((await read(host))?.version, receipt.versions[host]);
    assert.equal((await read(effect))?.version, receipt.versions[effect]);
    await env.history.step(env.auth, projectId, 'back');
    const customized = '<div data-composition-id="blur-in" style="background: #000;">Edited locally</div>';
    await env.files.commitChanges(env.auth, { projectId, ops: [{ op: 'upsert_text', path: effect, content: customized }] });
    const previous = (await read(effect))!;
    const dispatcher = new McpToolDispatcher(parseConfig({
      NODE_ENV: 'test', AUTH_MODE: 'dev', MODEL_GATEWAY_MODE: 'mock', DATABASE_URL: 'postgres://test:test@localhost/openmotion',
      REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: '0'.repeat(32),
    }), { componentFiles: env.files });
    const mcp = await dispatcher.dispatch('openmotion_assets_use', { action: 'install_component', projectId, name: 'blur-in',
      requestId: randomUUID(), hostFile: { path: host, baseVersion: prior.version, content: mounted } },
      { auth: env.auth, supportsMcpAppsUi: false });
    assert(!mcp.isError, JSON.stringify(mcp.structuredContent));
    assert.equal((await read(host))?.version, receipt.versions[host]);
    assert.equal((await read(effect))?.version, previous.version);
    await env.history.step(env.auth, projectId, 'back');
    assert.equal((await read(effect))?.version, previous.version);
    assert.equal(fetcher.mock.callCount(), downloads);
  });

  it('places preinstalled stock overlays and leaves edited backgrounds untouched', async t => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const host = 'index.html', effect = 'compositions/components/chat-message.html';
    const source = await readFile(path.join(REPO_ROOT, 'tests/fixtures/motion-components/chat-message.html'), 'utf8');
    const downloads = t.mock.method(globalThis, 'fetch', async () => new Response(source));
    const post = (route: string, body: unknown) => env.studioApp.request(`/api/projects/${projectId}/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body),
    });
    const read = (path: string) => env.files.readTextFile(env.auth, projectId, path);
    const base = '<main data-composition-id="root"></main>';
    await env.files.commitChanges(env.auth, { projectId, ops: [{ op: 'upsert_text', path: host, content: base }] });
    const version = (await read(host))!.version;
    const place = () => post('text-edits', { installComponent: 'chat-message', files: [{
      path: host, baseVersion: version, content: base.replace('</main>', `<div data-composition-src="${effect}"></div></main>`),
    }] });
    assert.equal((await place()).status, 200);
    const placed = (await read(effect))!;
    assert.doesNotMatch(placed.content, /background: #000;/);
    await env.history.step(env.auth, projectId, 'back');

    assert.equal((await post('registry/install', { blockName: 'chat-message' })).status, 200);
    const installed = (await read(effect))!;
    assert.match(installed.content, /background: #000;/);
    const fetchCount = downloads.mock.callCount();
    assert.equal((await place()).status, 200);
    assert.equal((await read(effect))?.version, placed.version);
    await env.history.step(env.auth, projectId, 'back');
    assert.equal((await read(effect))?.version, installed.version);
    assert.equal((await read(host))?.version, version);

    const custom = installed.content + '\n<style>.favorite { background: #000; }</style>';
    await env.files.commitChanges(env.auth, { projectId, ops: [{ op: 'upsert_text', path: effect, content: custom }] });
    assert.equal((await place()).status, 200);
    assert.equal((await read(effect))?.content, custom);
    assert.equal(downloads.mock.callCount(), fetchCount);
  });

  it('installs the same mountable fragment via Studio and MCP, bundles nested references and undoes each installation', async t => {
    const env = createStudioTestEnv();
    const mcp = new McpToolDispatcher(parseConfig({
      NODE_ENV: 'test', AUTH_MODE: 'dev', MODEL_GATEWAY_MODE: 'mock', DATABASE_URL: 'postgres://test:test@localhost/openmotion',
      REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: '0'.repeat(32),
    }), { componentFiles: env.files });
    const call = (args: Record<string, unknown>) => mcp.dispatch('openmotion_assets_use', args,
      { auth: env.auth, supportsMcpAppsUi: false });
    const listed = await call({ action: 'list_components', query: 'blur-in' });
    assert(!listed.isError, JSON.stringify(listed.structuredContent));
    assert((listed.structuredContent?.items as { name: string }[]).some(card => card.name === 'blur-in'));

    const snippet = await readFile(path.join(REPO_ROOT, 'tests/fixtures/motion-components/blur-in.html'), 'utf8');
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      assert(new URL(String(input)).pathname.endsWith('/registry/components/blur-in/blur-in.html'));
      return new Response(snippet);
    });
    const sources = [];
    for (const adapter of ['studio', 'mcp']) {
      const { projectId } = await env.workspace.createProject(env.auth);
      const composition = (id: string, child: string, src: string) => `<!doctype html><html><body><div data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="5"><div data-composition-id="${child}" data-composition-src="${src}" data-start="0" data-duration="5" data-track-index="0"></div></div></body></html>`;
      await env.files.commitChanges(env.auth, { projectId, ops: [
        { op: 'upsert_text', path: 'index.html', content: composition('root', 'scene', 'compositions/scene.html') },
        { op: 'upsert_text', path: 'compositions/scene.html', content: composition('scene', 'blur-in', 'components/blur-in.html') },
      ] });
      const args = { action: 'install_component', projectId, requestId: 'install-' + projectId, name: 'blur-in' };
      const result = adapter === 'studio'
        ? await (await env.studioApp.request(`/api/projects/${projectId}/registry/install`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockName: 'blur-in' }),
        })).json() : (await call(args)).structuredContent;
      const file = 'compositions/components/blur-in.html';
      assert.deepEqual(result.written, [file], JSON.stringify(result));
      const virtual = await env.files.loadVirtualProject(env.auth, projectId);
      const installed = virtual.readText(file);
      assert(installed?.includes(snippet), 'original fragment contents retained');
      sources.push(installed);
      const bundled = await bundlePreviewInMemory(virtual, { runtimeUrl: '/api/runtime.js', skipDeterministicFonts: true });
      assert(bundled);
      assert.match(parseHTMLContent(bundled).querySelector('.hf-ui-blur-in')?.textContent ?? '', /Design/);
      const lint = await lintProjectInMemory(virtual);
      assert(!lint.results.some(row => row.result.findings.some(finding => finding.code === 'missing_or_empty_sub_composition')));
      if (adapter === 'mcp') assert(!(await call(args)).isError);
      await env.history.step(env.auth, projectId, 'back');
      assert(!(await env.files.listFiles(env.auth, projectId)).some(record => record.path === file));
    }
    assert.equal(sources[0], sources[1]);
  });

  it('revalidates editor lint findings independently of unrelated source changes', async () => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const write = (html: string) => env.files.commitChanges(env.auth, {
      projectId, ops: [{ op: 'upsert_text', path: 'index.html', content: html }],
    });
    const html = '<html><body><div data-composition-id="main"><img src="missing.png"></div></body></html>';
    await write(html);
    const url = `/api/projects/${projectId}/lint`;
    const view = url + '?view=findings';
    const full = await (await env.studioApp.request(url)).json();
    const response = await env.studioApp.request(view);
    assert.equal(response.status, 200);
    assert.ok(full.diagnostics.length > 0);
    assert.deepEqual(await response.json(), {
      findings: full.findings.map((finding: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(finding).filter(([key]) =>
          ['severity', 'message', 'file', 'fixHint', 'elementId'].includes(key)))),
    });
    const validator = response.headers.get('etag');
    assert.ok(validator);
    const revalidate = () => env.studioApp.request(view, { headers: { 'If-None-Match': validator } });
    await write(html + '<!-- edit -->');
    assert.equal((await revalidate()).status, 304);
    await write(html.replace('missing.png', 'other.png'));
    const changed = await revalidate();
    assert.equal(changed.status, 200);
    assert.match(await changed.text(), /other\.png/);
  });

  it('serves unchanged lint and 304 revalidations from cache without reloading virtual projects', async (t) => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const html = '<html><body><div data-composition-id="main"><img src="missing.png"></div></body></html>';
    await env.files.commitChanges(env.auth, {
      projectId, ops: [{ op: 'upsert_text', path: 'index.html', content: html }],
    });
    const loads = t.mock.method(env.files, 'loadVirtualProject');
    const view = `/api/projects/${projectId}/lint?view=findings`;

    const first = await env.studioApp.request(view);
    assert.equal(first.status, 200);
    assert.equal(loads.mock.callCount(), 1);
    const etagHeader = first.headers.get('etag');
    assert.ok(etagHeader);

    // Repeated 200 and 304 hits against the same file+metadata snapshot skip loadVirtualProject.
    const second = await env.studioApp.request(view);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('etag'), etagHeader);
    assert.equal(loads.mock.callCount(), 1);

    const notModified = await env.studioApp.request(view, { headers: { 'If-None-Match': etagHeader } });
    assert.equal(notModified.status, 304);
    assert.equal(loads.mock.callCount(), 1);

    // Concurrent requests for a new snapshot coalesce into a single virtual project load.
    await env.files.commitChanges(env.auth, {
      projectId, ops: [{ op: 'upsert_text', path: 'index.html', content: html.replace('missing.png', 'other.png') }],
    });
    const [concurrentA, concurrentB] = await Promise.all([
      env.studioApp.request(view),
      env.studioApp.request(view),
    ]);
    assert.equal(concurrentA.status, 200);
    assert.equal(concurrentB.status, 200);
    assert.equal(loads.mock.callCount(), 2);
  });

  it('accepts ordered web edits even without patch storage and keeps semantic execution behind programmatic entry points', async t => {
    const env = createStudioTestEnv();
    const {projectId} = await env.workspace.createProject(env.auth);
    const base = '/api/projects/' + projectId;
    const file = 'scene.html';
    const original = '<p>before</p>';
    await env.files.commitChanges(env.auth, {projectId, ops: [{op:'upsert_text', path:file, content:original}]});
    const reads = t.mock.method(env.files, 'readTextBlob');
    const metadata = await env.studioApp.request(base + '/files/' + file + '?view=metadata');
    assert.equal(metadata.status, 200);
    assert.equal(metadata.headers.get('X-OpenMotion-Ordered-Edits'), '1');
    const {version} = await metadata.json();
    assert.equal(metadata.headers.get('etag'), version);
    assert.equal(reads.mock.callCount(), 0);
    const post = (path: string, body: unknown) => env.studioApp.request(base + '/' + path, {
      method: 'POST', headers:{'Content-Type':'application/json', 'X-OpenMotion-Entry':'api', 'If-Match':version},
      body:JSON.stringify(body),
    });
    for (const [path, body] of [
      ['edits/' + file, {kind:'moveClip', hfId:'a', start:2}],
      ['file-mutations/patch-element/' + file, {}],
      ['file-mutations/remove-elements/' + file, {}],
      ['gsap-mutations-batch/' + file, {mutations:[]}],
    ] as const) {
      const rejected = await post(path, body);
      assert.equal(rejected.status, 400);
      assert.match(await rejected.text(), /prepared file changes/);
    }
    assert.equal(reads.mock.callCount(), 0);
    const render = await env.studioApp.request(base + '/gsap-animations/' + file);
    assert.equal(render.status, 200);
    const operations = [
      {id:'first', files:[{path:file, baseVersion:version, content:'<p>first</p>'}]},
      {id:'next', files:[{path:file, baseVersion:{after:'first'}, content:'<p>next</p>'}]},
    ];
    const disabled = await post('text-edits/batch', {operations:[operations[0],
      {id:'patch',files:[{path:file,baseVersion:{after:'first'},patch:[[0,1,'P']]}]}]});
    assert.equal(disabled.status, 503);
    assert.equal((await env.files.readTextFile(env.auth, projectId, file))?.version, version);
    const saved = await post('text-edits/batch', {operations});
    assert.equal(saved.status, 200, await saved.clone().text());
    const receipt = await saved.json();
    assert.deepEqual(receipt.committed.map((r: {id:string}) => r.id), ['first','next']);
    assert.deepEqual(await (await post('text-edits/batch',{operations})).json(), receipt);
    assert.match((await env.files.readTextFile(env.auth, projectId, file))!.content, /next/);
    const conflict = await (await post('text-edits/batch', {operations:[
      {id:'stale', files:[{path:file, baseVersion:version, content:original}]},
    ]})).json();
    assert.equal(conflict.failed.status, 409);
    assert.deepEqual(conflict.committed, []);
  });

  it('splits a legacy anonymous clip using its preview-stamped hf-id', async () => {
    const env = createStudioTestEnv({ programmatic: true });
    const { projectId } = await env.workspace.createProject(env.auth);
    const html = '<html><body><img data-start="0" data-duration="4"></body></html>';
    const hfId = ensureHfIds(html).match(/<img[^>]*data-hf-id="([^"]+)"/)?.[1];
    assert.ok(hfId);
    await env.files.commitChanges(env.auth, { projectId, ops: [{ op: 'upsert_text', path: 'index.html', content: html }] });
    const response = await env.studioApp.request(`/api/projects/${projectId}/file-mutations/split-batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'index.html', expectedVersion: fileContentVersion(html),
        targets: [{ target: { hfId }, splitTime: 2, elementStart: 0, elementDuration: 4 }] }] }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { files: Array<{ splitCount: number; before: string }> };
    assert.equal(result.files[0]!.before, html);
    assert.equal(result.files[0]!.splitCount, 1);
  });

  it('inserts at the canvas drop point with durable history and rejects stale edits without walking nested files', async (t) => {
    const env = createStudioTestEnv({ programmatic: true });
    const { projectId } = await env.workspace.createProject(env.auth);
    const scene = (id: string, children = '') => `<template><main data-composition-id="${id}" data-duration="4" data-width="200" data-height="100">${children}</main></template>`;
    const parent = 'comps/a/parent.html', child = 'comps/b/child.html', indirect = 'nested/loop.html';
    const files = {
      [parent]: scene('parent', '<span data-start="0" data-duration="4" data-track-index="0"></span>'),
      [child]: scene('child'), [indirect]: scene('loop', '<div data-composition-src="../comps/a/parent.html"></div>'),
    };
    await env.files.commitChanges(env.auth, { projectId, ops: Object.entries(files).map(([path, content]) => ({ op: 'upsert_text', path, content })) });
    const insert = (target: string, source: string, version: string) => env.studioApp.request(
      `/api/projects/${projectId}/file-mutations/insert-composition/${encodeURIComponent(target)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: source, expectedVersion: version, start: 2, track: 0, canvasPosition: { left: 160, top: 85 } }) });
    const before = files[parent], initialVersion = fileContentVersion(before);
    const saved = await insert(parent, child, initialVersion);
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.equal(result.before, before);
    assert.equal(result.after, (await env.files.readTextFile(env.auth, projectId, parent))!.content);
    assert.equal(result.version, fileContentVersion(result.after));
    assert.equal(result.track, 1);
    assert.match(result.after, /left: 60px; top: 35px/);
    assert.match(result.after, /data-composition-src="\.\.\/b\/child\.html"/);
    assert.match(result.after, /data-duration="6"/);
    assert.equal((await insert(parent, child, initialVersion)).status, 409);
    // A repeating branch is skipped by the preview compiler. Saving needs only the two direct inputs.
    const reads = t.mock.method(env.files, 'readTextFile');
    assert.equal((await insert(child, parent, fileContentVersion(files[child]))).status, 200);
    assert.deepEqual(reads.mock.calls.map(call => call.arguments[2]), [child, parent]);
    reads.mock.resetCalls();
    assert.equal((await insert(indirect, indirect, fileContentVersion(files[indirect]))).status, 200);
    assert.deepEqual(reads.mock.calls.map(call => call.arguments[2]), [indirect]);
  });

  it('applies Studio split targets atomically at the requested file version and returns stored history bytes', async () => {
    const env = createStudioTestEnv({ programmatic: true });
    const { projectId } = await env.workspace.createProject(env.auth);
    const html = '<html><body><img id="clip" data-start="0" data-duration="4" data-track-index="1"></body></html>';
    const file = (path: string) => env.files.readTextFile(env.auth, projectId, path);
    await env.files.commitChanges(env.auth, { projectId, ops: ['index.html', 'other.html'].map(path => ({
      op: 'upsert_text', path, content: html,
    })) });
    const expectedVersion = fileContentVersion(html);
    const targets = [{ target: { id: 'clip' }, originalId: 'clip', splitTime: 2, elementStart: 0, elementDuration: 4 }];
    const split = (files: unknown[]) => env.studioApp.request(`/api/projects/${projectId}/file-mutations/split-batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }),
    });
    const root = { path: 'index.html', expectedVersion, targets };
    assert.equal((await split([root, { ...root, path: 'other.html', expectedVersion: 'stale' }])).status, 409);
    assert.equal((await file('index.html'))?.content, html);
    assert.equal((await split([root, { ...root, path: 'other.html', targets: [{ ...targets[0], target: { id: 'gone' } }] }])).status, 409);
    assert.equal((await file('index.html'))?.content, html);
    const result = await split([root, { path: 'other.html', cuts: targets }]);
    assert.equal(result.status, 200);
    const body = await result.json() as { files: Array<{ path: string; before: string; after: string; version: string; splitCount: number }> };
    for (const output of body.files) {
      const saved = await file(output.path);
      assert.equal(output.splitCount, 1);
      assert.equal(output.before, html);
      assert.match(output.after, /id="clip-split/);
      assert.equal(output.after, saved?.content);
      assert.equal(output.version, saved?.version);
    }
  });

  it('reads the latest SVG through a stable source URL before and after an ordered save', async () => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const base = '/api/projects/' + projectId;
    const path = 'images/shape #1.svg';
    const url = base + '/file-source?path=' + encodeURIComponent(path);
    const legacyUrl = base + '/files/' + encodeURIComponent(path);
    const original = '<svg><title>Before</title></svg>';
    const next = '<svg><title>After</title></svg>';
    const read = async (path: string, init?: RequestInit) => {
      const response = await env.studioApp.request(path, init);
      assert.equal(response.headers.get('cache-control'), 'private, no-cache');
      assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
      return response;
    };
    const missing = await read(url + '&optional=1');
    assert.equal((await missing.json()).missing, true);
    await env.files.commitChanges(env.auth, { projectId, ops: [{ op: 'upsert_text', path, content: original }] });
    const before = await (await read(url)).json();
    assert.equal(before.content, original);
    assert.equal((await (await read(legacyUrl)).json()).version, before.version);
    const committed = await env.studioApp.request(base + '/text-edits/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: [{ id: 'svg-change', files: [{ path, baseVersion: before.version, content: next }] }] }),
    });
    assert.equal(committed.status, 200);
    const version = (await committed.json()).committed[0].versions[path];
    const after = await read(url, { headers: { 'If-None-Match': before.version } });
    assert.equal(after.status, 200);
    assert.equal((await after.json()).content, next);
    assert.equal(after.headers.get('etag'), version);
    assert.equal((await (await read(url + '&view=metadata')).json()).version, version);
    assert.equal((await read(url, { headers: { 'If-None-Match': version } })).status, 304);
    assert.equal((await (await read(legacyUrl)).json()).content, next);
    assert.equal((await read(base + '/file-source')).status, 400);
  });

  it('enforces exact strong ETag "sha256:...", If-Match, 428, 409, ?optional=1, and DELETED_VERSION', async () => {
    const env = createStudioTestEnv();
    const created = await env.workspace.createProject(env.auth, { title: 'ETag Studio' });

    // Optional missing file returns 200 { missing: true }.
    const optRes = await env.studioApp.request(`/api/projects/${created.projectId}/files/missing.css?optional=1`);
    assert.equal(optRes.status, 200);
    const optJson = (await optRes.json()) as { missing: boolean; version: string | null };
    assert.equal(optJson.missing, true);
    assert.equal(optJson.version, null);

    // GET index.html returns exact strong ETag `"sha256:<64hex>"`.
    const getRes = await env.studioApp.request(`/api/projects/${created.projectId}/files/index.html`);
    assert.equal(getRes.status, 200);
    const getJson = (await getRes.json()) as { content: string; version: string };
    assert.match(getJson.version, /^"sha256:[a-f0-9]{64}"$/);
    assert.equal(getRes.headers.get('etag'), getJson.version);
    assert.equal(getJson.version, fileContentVersion(getJson.content));

    // PUT without If-Match / If-None-Match -> 428 Precondition Required.
    const noPre = await env.studioApp.request(`/api/projects/${created.projectId}/files/index.html`, {
      method: 'PUT',
      body: 'updated',
    });
    assert.equal(noPre.status, 428);

    // PUT with wrong If-Match -> 409 Conflict with currentVersion + currentContent.
    const badMatch = await env.studioApp.request(`/api/projects/${created.projectId}/files/index.html`, {
      method: 'PUT',
      headers: { 'If-Match': `"sha256:${'0'.repeat(64)}"` },
      body: 'updated',
    });
    assert.equal(badMatch.status, 409);
    const conflictJson = (await badMatch.json()) as { code: string; currentVersion: string; currentContent: string };
    assert.equal(conflictJson.code, 'VERSION_MISMATCH');
    assert.equal(conflictJson.currentVersion, getJson.version);
    assert.equal(conflictJson.currentContent, getJson.content);

    // PUT new file with If-None-Match: * and X-Hyperframes-Write-Token echoes writeToken.
    const createCss = await env.studioApp.request(`/api/projects/${created.projectId}/files/extra.css`, {
      method: 'PUT',
      headers: {
        'If-None-Match': '*',
        'X-Hyperframes-Write-Token': 'studio-write-77',
      },
      body: '.box { opacity: 1; }',
    });
    assert.equal(createCss.status, 200);
    const cssJson = (await createCss.json()) as { version: string; writeToken: string };
    assert.equal(cssJson.writeToken, 'studio-write-77');
    assert.equal(cssJson.version, fileContentVersion('.box { opacity: 1; }'));

    // A delete emits a single file-change carrying the legacy deletion hint.
    const beforeDelete = env.published.length;
    const delRes = await env.studioApp.request(`/api/projects/${created.projectId}/files/extra.css`, {
      method: 'DELETE',
    });
    assert.equal(delRes.status, 200);
    const delJson = (await delRes.json()) as { version: string };
    assert.equal(delJson.version, DELETED_VERSION);
    assert.equal(DELETED_VERSION, '"deleted"');
    const deletions = env.published.slice(beforeDelete)
      .map(e => e.payload as { type?: string; version?: string })
      .filter(e => e.type === 'file-change');
    assert.equal(deletions.length, 1);
    assert.equal(deletions[0].version, DELETED_VERSION);
  });

  it('answers HEAD /preview/* and HEAD /render/:jobId/view DIRECTLY (never 302) while GET binary returns 302 with Cache-Control & Vary', async () => {
    const env = createStudioTestEnv();
    const created = await env.workspace.createProject(env.auth, { title: 'Media Preview' });

    const videoBytes = Buffer.from('FAKE_MP4_BINARY_PAYLOAD_0123456789');
    await env.files.commitChanges(env.auth, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_binary', path: 'assets/intro.mp4', data: videoBytes, mimeType: 'video/mp4' }],
    });

    // HEAD /api/projects/:id/preview/assets/intro.mp4 -> 200 DIRECT from PG metadata (1 SELECT), ZERO presignGet calls!
    const presignBefore = env.storage.presignGetCalls;
    const headSelectsBefore = env.pgClient.selectCount;
    const headPreview = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/intro.mp4`,
      { method: 'HEAD' },
    );
    assert.equal(headPreview.status, 200);
    assert.equal(headPreview.headers.get('content-type'), 'video/mp4');
    assert.equal(headPreview.headers.get('content-length'), String(videoBytes.byteLength));
    assert.equal(headPreview.headers.get('accept-ranges'), 'bytes');
    assert.equal(headPreview.headers.get('etag'), fileContentVersion(videoBytes));
    assert.equal(headPreview.headers.get('x-openmotion-media-track'), 'original');
    assert.equal(env.storage.presignGetCalls, presignBefore, 'HEAD must NEVER call presignGet');
    assert.equal(env.pgClient.selectCount - headSelectsBefore, 1, 'HEAD preview asset should use 1 joined PG query');

    // GET /api/projects/:id/preview/assets/intro.mp4 -> 302 Found reusing loaded file (1 SELECT, never re-calling getFile)!
    const getSelectsBefore = env.pgClient.selectCount;
    const getPreview = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/intro.mp4`,
      { method: 'GET' },
    );
    assert.equal(getPreview.status, 302);
    assert.ok(getPreview.headers.get('location')?.startsWith('https://s3.local/workspaces/'));
    assert.equal(getPreview.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(getPreview.headers.get('vary'), 'Origin, Cookie');
    assert.equal(getPreview.headers.get('x-openmotion-media-track'), 'original');
    assert.equal(env.pgClient.selectCount - getSelectsBefore, 1, 'GET preview asset must reuse file without a second getFile lookup');

    // Seed a completed export job in PG and test HEAD vs GET on /api/render/:jobId/view & /download.
    const jobId = randomUUID();
    const renderKey = exportKey(env.auth.workspaceId, jobId, 'Media_Preview.mp4');
    const renderSha = 'd'.repeat(64);
    env.pgClient.seed('jobs', {
      id: jobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'export_render',
      state: 'completed',
      stage: 'done',
      progress: 100,
      input_payload: { outputName: 'Media_Preview.mp4' },
      result_json: {
        s3Key: renderKey,
        filename: 'Media_Preview.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 987654,
        sha256: renderSha,
      },
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const presignBeforeRenderHead = env.storage.presignGetCalls;
    const headRender = await env.studioApp.request(`/api/render/${jobId}/view`, { method: 'HEAD' });
    assert.equal(headRender.status, 200);
    assert.equal(headRender.headers.get('content-type'), 'video/mp4');
    assert.equal(headRender.headers.get('content-length'), '987654');
    assert.equal(headRender.headers.get('accept-ranges'), 'bytes');
    assert.equal(headRender.headers.get('etag'), `"sha256:${renderSha}"`);
    assert.equal(env.storage.presignGetCalls, presignBeforeRenderHead, 'HEAD /render/:jobId/view must NEVER presign');

    const getRenderView = await env.studioApp.request(`/api/render/${jobId}/view`);
    assert.equal(getRenderView.status, 302);
    assert.equal(getRenderView.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(getRenderView.headers.get('vary'), 'Origin, Cookie');

    const getRenderDownload = await env.studioApp.request(`/api/render/${jobId}/download`);
    assert.equal(getRenderDownload.status, 302);
    assert.ok(getRenderDownload.headers.get('location')?.includes('attachment'));
  });

  it('persists a GSAP mutation into the scene template that Studio reopens', async () => {
    const env = createStudioTestEnv({ programmatic: true });
    const scene = 'compositions/title.html';
    const html = '<template><div data-composition-id="title"><h1 id="heading">Title</h1></div><script>const tl=gsap.timeline();tl.to("#heading",{x:10,duration:1},0);</script></template>';
    const project = await env.workspace.createProject(env.auth, {
      title: 'Animated title', initialFiles: [{ path: scene, content: html }, { path: 'index.html', content: '<html></html>' }],
    });
    const base = `/api/projects/${project.projectId}`;
    const read = async () => {
      const response = await env.studioApp.request(`${base}/gsap-animations/${scene}`);
      return response.json();
    };
    const { animations } = await read();
    const mutation = await env.studioApp.request(`${base}/gsap-mutations/${scene}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'update-property', animationId: animations[0].id, property: 'x', value: 55 }),
    });
    assert.equal(mutation.status, 200);
    assert.equal((await read()).animations[0].properties.x, 55);
  });

  it('persists an isolated welcome headline drag without rewriting the runtime letter animation', async () => {
    const env = createStudioTestEnv({ programmatic: true });
    const scene = 'compositions/intro.html';
    const source = await readFile(new URL('../../template-library/openmotion-welcome/compositions/intro.html', import.meta.url), 'utf8');
    const {projectId} = await env.workspace.createProject(env.auth, {
      title: 'Welcome canvas drag', initialFiles: [{path: scene, content: source}, {path: 'index.html', content: '<html></html>'}],
    });
    const read = async () => (await env.files.loadVirtualProject(env.auth, projectId)).readText(scene)!;
    const before = await read();
    const response = await env.studioApp.request(`/api/projects/${projectId}/file-mutations/patch-element-batches`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({batches: [{sourceFile: scene, ifMatch: fileContentVersion(before), geometry: {
        target: {id: 'intro-headline', hfId: 'hf-933r'}, box: {left: 110, top: 455, makeRelative: false},
        position: {time: 0.967, delta: {x: 10, y: 10}},
      }}]}),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.durable, true);
    const saved = await read();
    assert.match(saved, /<div[^>]*style="[^"]*left:\s*110px[^"]*"[^>]*id="intro-headline"/);
    assert.equal(saved.match(/<script>[\s\S]*?<\/script>/)?.[0], before.match(/<script>[\s\S]*?<\/script>/)?.[0]);
  });

  it('saves a canvas drag against the displayed source and rolls back unmatched batches', async () => {
    const env = createStudioTestEnv({ programmatic: true });
    const { projectId } = await env.workspace.createProject(env.auth, {
      title: 'Canvas drag',
      initialFiles: [{ path: 'index.html', content: '<html><body><div id="title">Title</div></body></html>' }],
    });
    const current = async () => (await env.files.loadVirtualProject(env.auth, projectId)).readText('index.html')!;
    const before = await current();
    const drag = (ids: string[], ifMatch: string) => env.studioApp.request(
      `/api/projects/${projectId}/file-mutations/patch-element-batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batches: [{
          sourceFile: 'index.html', ifMatch,
          patches: ids.map(id => ({ target: { id }, operations: [{ type: 'inline-style', property: 'left', value: '42px' }] })),
        }] }),
      },
    );
    const version = fileContentVersion(before);
    const unmatched = await drag(['title', 'missing'], version);
    assert.equal(unmatched.status, 200);
    const rejected = await unmatched.json();
    assert.equal(rejected.durable, false);
    assert.deepEqual(rejected.files[0].matched, [true, false]);
    assert.equal(rejected.files[0].after, before);
    assert.equal(await current(), before);
    const saved = await drag(['title'], version);
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.deepEqual(result.files[0].matched, [true]);
    assert.equal(result.files[0].before, before);
    assert.match(await current(), /left:\s*42px/);
    assert.equal((await drag(['title'], version)).status, 409);
    const remove = (ifMatch: string) => env.studioApp.request(
      `/api/projects/${projectId}/file-mutations/remove-elements/index.html`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': ifMatch },
        body: JSON.stringify({ targets: [{ id: 'title' }] }),
      });
    assert.equal((await remove(version)).status, 409);
    assert.match(await current(), /id="title"/);
    assert.equal(result.files[0].version, fileContentVersion(await current()));
    assert.equal((await remove(result.files[0].version)).status, 200);
    assert.doesNotMatch(await current(), /id="title"/);
  });

  it('executes DOM file-mutations and GSAP AST mutations + rollback purely in memory via PG', async () => {
    const env = createStudioTestEnv({ programmatic: true });
    const initialHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="5" data-fps="30">
    <h1 id="headline" data-start="0" data-duration="5">Before</h1>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.to("#headline", { opacity: 0.5, duration: 1 }, 0);
  </script>
</body>
</html>`;

    const created = await env.workspace.createProject(env.auth, {
      title: 'Mutations Demo',
      initialFiles: [{ path: 'index.html', content: initialHtml }],
    });

    const probe = await env.studioApp.request(
      `/api/projects/${created.projectId}/file-mutations/probe-elements/index.html`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: [{ id: 'headline' }, { id: 'missing' }] }) },
    );
    assert.equal(probe.status, 200);
    assert.deepEqual(await probe.json(), { ok: true, exists: [true, false], results: [true, false] });

    // DOM patch-element
    const patchRes = await env.studioApp.request(
      `/api/projects/${created.projectId}/file-mutations/patch-element/index.html`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { id: 'headline' },
          operations: [{ type: 'text-content', property: 'textContent', value: 'After Patch' }],
        }),
      },
    );
    assert.equal(patchRes.status, 200);
    const patchJson = (await patchRes.json()) as { matched: boolean; changed: boolean; content: string };
    assert.equal(patchJson.matched, true);
    assert.equal(patchJson.changed, true);
    assert.ok(patchJson.content.includes('After Patch'));

    // GSAP capabilities + read + mutate + rollback
    const capRes = await env.studioApp.request(
      `/api/projects/${created.projectId}/gsap-mutation-capabilities`,
    );
    assert.equal(capRes.status, 200);
    assert.deepEqual(await capRes.json(), { atomicOwnershipPairs: true });

    const gsapListRes = await env.studioApp.request(
      `/api/projects/${created.projectId}/gsap-animations/index.html`,
    );
    assert.equal(gsapListRes.status, 200);
    const gsapList = (await gsapListRes.json()) as { animations: Array<{ id: string }> };
    assert.equal(gsapList.animations.length, 1);

    const mutateRes = await env.studioApp.request(
      `/api/projects/${created.projectId}/gsap-mutations/index.html`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'update-property',
          animationId: gsapList.animations[0].id,
          property: 'opacity',
          value: 1,
        }),
      },
    );
    assert.equal(mutateRes.status, 200);
    const mutateJson = (await mutateRes.json()) as { ok: boolean; mutated: boolean; before: string; after: string };
    assert.equal(mutateJson.ok, true);
    assert.equal(mutateJson.mutated, true);
    assert.notEqual(mutateJson.before, mutateJson.after);

    // Rollback succeeds when expected matches current, and reports conflict when mismatched.
    const rbOk = await env.studioApp.request(
      `/api/projects/${created.projectId}/gsap-mutation-rollback/index.html`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected: mutateJson.after, restore: mutateJson.before }),
      },
    );
    assert.equal(rbOk.status, 200);
    assert.equal(((await rbOk.json()) as { restored: boolean }).restored, true);
  });

  it('handles /thumbnail (?cached=1 -> 204 miss, 302 hit), /remove-background (501), /environment/ffmpeg (Redis), and product routes', async () => {
    const env = createStudioTestEnv();
    const created = await env.workspace.createProject(env.auth, { title: 'System Routes' });

    // remove-background -> 501 FEATURE_DEFERRED_P2
    const remBg = await env.studioApp.request(
      `/api/projects/${created.projectId}/media/remove-background`,
      { method: 'POST' },
    );
    assert.equal(remBg.status, 501);
    assert.equal(((await remBg.json()) as { code: string }).code, 'FEATURE_DEFERRED_P2');

    // thumbnail ?cached=1 on miss -> 204 No Content
    const thumbMiss = await env.studioApp.request(
      `/api/projects/${created.projectId}/thumbnail?cached=1`,
    );
    assert.equal(thumbMiss.status, 204);

    // thumbnail without ?cached=1 on miss -> enqueues render_thumbnail and returns 202
    const thumbEnqueue = await env.studioApp.request(`/api/projects/${created.projectId}/thumbnail`);
    assert.equal(thumbEnqueue.status, 202);
    const { cacheKey } = (await thumbEnqueue.json()) as { cacheKey: string };
    assert.ok(env.enqueued.some((j) => j.queue === 'render-export' && j.name === 'render_thumbnail'));

    // Seed cached PNG thumbnail in S3 -> GET /thumbnail now returns 302 with Cache-Control & Vary!
    await env.storage.putObject(
      compThumbnailKey(env.auth.workspaceId, created.projectId, cacheKey),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'image/png',
    );
    const thumbHit = await env.studioApp.request(`/api/projects/${created.projectId}/thumbnail?cached=1`);
    assert.equal(thumbHit.status, 302);
    assert.equal(thumbHit.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(thumbHit.headers.get('vary'), 'Origin, Cookie');

    // /api/environment/ffmpeg reads Redis render worker health!
    const ffRes = await env.studioApp.request('/api/environment/ffmpeg');
    assert.equal(ffRes.status, 200);
    const ffJson = (await ffRes.json()) as { ok: boolean; available: boolean; workers: unknown[] };
    assert.equal(ffJson.ok, true);
    assert.equal(ffJson.available, true);
    assert.equal(ffJson.workers.length, 1);

    // Product routes: /motion-api/projects, /motion-api/sessions, /motion-api/project-archives
    const listProjects = await env.projectsApp.request('/motion-api/projects');
    assert.equal(listProjects.status, 200);
    assert.equal(((await listProjects.json()) as { projects: unknown[] }).projects.length, 1);

    const createSess = await env.sessionsApp.request('/motion-api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Brand Launch' }),
    });
    assert.equal(createSess.status, 201);
    const sess = (await createSess.json()) as { id: string };

    const msgId = randomUUID();
    const postMsg = await env.sessionsApp.request(`/motion-api/sessions/${sess.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: msgId, role: 'user', content: 'Create a 5s product reveal.' }),
    });
    assert.equal(postMsg.status, 201);

    // Export via archives router + verify HEAD /file is 200 direct & GET /file is 302.
    const expRes = await env.archivesApp.request('/motion-api/project-archives/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'route-exp-1', all: true }),
    });
    assert.equal(expRes.status, 200);
    const expJson = (await expRes.json()) as { archiveId: string; downloadUrl: string };

    const headArchive = await env.archivesApp.request(expJson.downloadUrl, { method: 'HEAD' });
    assert.equal(headArchive.status, 200);
    assert.equal(headArchive.headers.get('content-type'), 'application/zip');

    const getArchive = await env.archivesApp.request(expJson.downloadUrl);
    assert.equal(getArchive.status, 302);
    assert.equal(getArchive.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(getArchive.headers.get('vary'), 'Origin, Cookie');

    // Enqueue failure on POST /api/projects/:id/render marks PG job 'failed' so project is not wedged in EXPORT_BUSY.
    const failingStudio = createDisklessStudioApp({
      db: drizzle({ client: env.pgClient as never, schema }) as unknown as Database,
      storage: env.storage,
      hotTextCache: env.hotTextCache,
      eventBus: env.eventBus,
      queues: {
        enqueueMediaIngest: async () => { throw new Error('Redis down'); },
        enqueueRenderExport: async () => { throw new Error('BullMQ down'); },
      },
      workspace: env.workspace,
      files: env.files,
      history: env.history,
      assetNames: new AssetNamesService({ db: drizzle({ client: env.pgClient as never, schema }) as unknown as Database, files: env.files }),
      resolveAuth: () => env.auth,
      skipDeterministicFonts: true,
    });
    const failedRender = await failingStudio.request(`/api/projects/${created.projectId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'mp4' }),
    });
    assert.equal(failedRender.status, 500);
    // Subsequent render on healthy studio must succeed (NOT 409 EXPORT_BUSY!).
    const retryRender = await env.studioApp.request(`/api/projects/${created.projectId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'mp4', composition: 'index.html', variables: { theme: 'dark' } }),
    });
    assert.equal(retryRender.status, 200);
    const retryRenderJson = (await retryRender.json()) as { settings: { variables?: Record<string, unknown> } };
    assert.deepEqual(retryRenderJson.settings.variables, { theme: 'dark' });
  });

  it('opens an editor listing without reading vendor code, media or fonts and resolves font details separately', async (t) => {
    const font = { family: 'Test Font', weight: '500', style: 'normal' as const, postscriptName: 'TestFont' };
    const env = createStudioTestEnv({ fontCatalog: {
      inspectBuffer: () => font, listFamilies: async () => [], getFont: async () => null,
      prepareBuffer: () => { throw new Error('unused'); }, fetchGoogleFontCss: async () => '',
    } });
    const source = '<main data-composition-id="root"></main>';
    const { projectId } = await env.workspace.createProject(env.auth, {
      title: 'Editor file tree', initialFiles: [
        { path: 'index.html', content: source },
        { path: 'vendor.js', content: '/*' + 'a'.repeat(256 * 1024) + '*/' },
        { path: 'assets/font.woff', content: 'font bytes' },
        { path: 'assets/clip.mp4', content: 'media bytes' },
      ],
    });
    t.mock.method(env.hotTextCache, 'getText', async () => null);
    const reads = t.mock.method(env.storage, 'getObjectBuffer');
    const url = `/api/projects/${projectId}`;
    const open = await env.studioApp.request(url + '?view=editor');
    assert.equal(open.status, 200);
    const listing = await open.json();
    assert.deepEqual(listing.files.sort(), ['assets/clip.mp4', 'assets/font.woff', 'index.html', 'vendor.js']);
    assert.equal(listing.entryVersion, fileContentVersion(source));
    assert.equal(listing.fonts, undefined);
    assert.deepEqual(reads.mock.calls.map(call => call.arguments[0].split('/').at(-1)), [sha256Hex(source)]);

    const details = await (await env.studioApp.request(url + '?view=asset-details')).json();
    assert.equal(details.assetDetailsKey, listing.assetDetailsKey);
    assert.deepEqual(details.fonts, [{ ...font, path: 'assets/font.woff' }]);
    assert.deepEqual(reads.mock.calls.slice(1).map(call => call.arguments[0].split('/').at(-1)), [sha256Hex('font bytes')]);
    const full = await (await env.studioApp.request(url)).json();
    assert.deepEqual(full.compositionRevisions, listing.compositionRevisions);
    assert.deepEqual(full.assetNames, details.assetNames);
    assert.deepEqual(full.fonts, details.fonts);
  });

  it('caches only matching script versions on the project asset route', async () => {
    const env = createStudioTestEnv();
    const content = 'window.ready = true;';
    const { projectId } = await env.workspace.createProject(env.auth, {
      title: 'Script cache', initialFiles: [{ path: 'vendor.js', content }],
    });
    const url = `/api/projects/${projectId}/preview/vendor.js`;
    const read = (suffix: string) => env.studioApp.request(url + suffix);
    const cached = await read('?om-script=' + sha256Hex(content));
    assert.equal(cached.status, 200);
    assert.equal(await cached.text(), content);
    assert.equal(cached.headers.get('cache-control'), 'private, max-age=300, immutable');
    assert.equal((await read('')).headers.get('cache-control'), 'no-cache');
    const stale = await read('?om-script=' + sha256Hex('older'));
    assert.equal(stale.status, 409);
    assert.equal(stale.headers.get('cache-control'), 'no-store');
  });

  it('serves bundled vendor dist scripts on preview and file routes while still rejecting top-level dist paths', async () => {
    const env = createStudioTestEnv();
    const gsapContent = '/* bundled gsap */ window.gsap = {};'.repeat(1024);
    const { projectId } = await env.workspace.createProject(env.auth, {
      title: 'Vendor Dist Project',
      initialFiles: [
        {
          path: 'index.html',
          content: '<!doctype html><html><head><script src="./vendor/gsap-3.14.2/dist/gsap.min.js"></script></head><body><div data-composition-id="main" data-width="1920" data-height="1080" data-duration="5" data-fps="30"></div></body></html>',
        },
        { path: 'vendor/gsap-3.14.2/dist/gsap.min.js', content: gsapContent },
        { path: 'scene.html', content: '<div data-composition-id="scene">Scene</div>' },
      ],
    });

    const previewHtml = await env.studioApp.request(`/api/projects/${projectId}/preview`);
    assert.equal(previewHtml.status, 200);
    const expectedQuery = `vendor/gsap-3.14.2/dist/gsap.min.js?om-script=${sha256Hex(gsapContent)}`;
    assert.ok((await previewHtml.text()).includes(expectedQuery));

    const capture = await env.studioApp.request(`/api/projects/${projectId}/preview/comp/scene.html?capture=1`);
    assert.equal(capture.status, 200);
    assert.ok((await capture.text()).includes(expectedQuery));

    const previewScript = await env.studioApp.request(`/api/projects/${projectId}/preview/${expectedQuery}`);
    assert.equal(previewScript.status, 200);
    assert.equal(await previewScript.text(), gsapContent);
    assert.equal(previewScript.headers.get('cache-control'), 'private, max-age=300, immutable');

    const rawFile = await env.studioApp.request(`/api/projects/${projectId}/files/vendor/gsap-3.14.2/dist/gsap.min.js`);
    assert.equal(rawFile.status, 200);
    const fileBody = (await rawFile.json()) as { path?: string; content?: string };
    assert.equal(fileBody.path, 'vendor/gsap-3.14.2/dist/gsap.min.js');
    assert.equal(fileBody.content, gsapContent);

    const topLevelDistPreview = await env.studioApp.request(`/api/projects/${projectId}/preview/dist/gsap.min.js`);
    assert.equal(topLevelDistPreview.status, 400);
    assert.equal(((await topLevelDistPreview.json()) as { code?: string }).code, 'INVALID_PATH');

    const topLevelDistFile = await env.studioApp.request(`/api/projects/${projectId}/files/dist/gsap.min.js`);
    assert.equal(topLevelDistFile.status, 400);
    assert.equal(((await topLevelDistFile.json()) as { code?: string }).code, 'INVALID_PATH');
  });

  it('shares preview builds, validates ETags before loading files, and isolates document variants and edits', async t => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth, { title: 'Preview cache' });
    const url = `/api/projects/${projectId}/preview`;
    const loads = t.mock.method(env.files, 'loadVirtualProject');
    const results = await Promise.all(Array.from({ length: 8 }, () => env.studioApp.request(url)));
    assert.ok(results.every(response => response.status === 200));
    assert.equal(results[0]!.headers.get('cache-control'), 'private, no-cache');
    assert.equal(results[0]!.headers.get('vary'), 'Cookie, Authorization');
    assert.equal(loads.mock.callCount(), 1);
    const etag = results[0]!.headers.get('etag')!;
    const revalidated = await env.studioApp.request(url, { headers: { 'If-None-Match': etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get('cache-control'), 'private, no-cache');
    assert.equal(revalidated.headers.get('vary'), 'Cookie, Authorization');
    assert.equal(loads.mock.callCount(), 1);

    const warm = await env.studioApp.request(url + '?capture=1', { method: 'HEAD' });
    assert.equal(warm.status, 200);
    assert.equal(await warm.text(), '');
    assert.equal(loads.mock.callCount(), 2);
    const player = await env.studioApp.request(url + '?capture=1');
    assert.equal(player.headers.get('etag'), warm.headers.get('etag'));
    assert.ok((await player.text()).length > 0);
    assert.equal(loads.mock.callCount(), 2);

    for (const suffix of ['?capture=1', '?variables=%7B%22theme%22%3A%22red%22%7D', '/comp/index.html']) {
      const variant = await env.studioApp.request(url + suffix, { headers: { 'If-None-Match': etag } });
      assert.equal(variant.status, 200);
      assert.notEqual(variant.headers.get('etag'), etag);
    }
    assert.equal(loads.mock.callCount(), 4);
    await env.files.commitChanges(env.auth, {
      projectId, ops: [{ op: 'upsert_text', path: 'index.html', content: '<html><body>fresh-revision</body></html>' }],
    });
    const updated = await env.studioApp.request(url, { headers: { 'If-None-Match': etag } });
    assert.equal(updated.status, 200);
    assert.match(await updated.text(), /fresh-revision/);
    assert.notEqual(updated.headers.get('etag'), etag);
    assert.equal(loads.mock.callCount(), 5);
    const missingUrl = url + '/comp/missing.html';
    assert.equal((await env.studioApp.request(missingUrl, { headers: { 'If-None-Match': etag } })).status, 404);
    await env.files.commitChanges(env.auth, {
      projectId, ops: [{ op: 'upsert_text', path: 'missing.html', content: '<html><body>created</body></html>' }],
    });
    assert.equal((await env.studioApp.request(missingUrl)).status, 200);

  });

  it('serves one compiled scene with whole-film validators while sharing builds across scenes and leases', async t => {
    const env = createStudioTestEnv();
    const paths = ['compositions/intro.html', 'compositions/outro.html'];
    const index = '<html><body><main data-composition-id="main" data-duration="4">' +
      paths.map((file, i) => `<div data-composition-id="scene-${i}" data-composition-src="${file}" data-start="${i * 2}" data-duration="2"></div>`).join('') +
      '</main></body></html>';
    const {projectId} = await env.workspace.createProject(env.auth, { title: 'Two scenes', initialFiles: [
      { path: 'index.html', content: index },
      ...paths.map((path, i) => ({ path, content: `<html><body><div data-composition-id="scene-${i}" data-duration="2"><p>Unique text ${i}</p><img src="/poster-${i}.png"></div></body></html>` })),
    ] });
    const url = `/api/projects/${projectId}/preview`;
    const app = new Hono<{ Variables: StudioVariables }>();
    let base = 'https://preview.example/grant-one/';
    app.use('*', async (c, next) => { c.set('previewAssetBase', base); await next(); });
    app.route('/', env.studioApp);
    const loads = t.mock.method(env.files, 'loadVirtualProject');
    const full = await app.request(url);
    const doc = parseHTMLContent(await full.text());
    const manifest = (d: Document) => d.querySelector('meta[name="hf-scene-parts"]')?.getAttribute('content');
    const config = (d: Document) => d.querySelector('script[data-openmotion-preview]')?.getAttribute('data-openmotion-preview');
    const sceneUrl = (file: string) => url + '?sceneFile=' + encodeURIComponent(file);
    const etags = new Set([full.headers.get('etag')]);
    for (const [i, file] of paths.entries()) {
      const response = await app.request(sceneUrl(file));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /^text\/plain/);
      const html = await response.text();
      const part = parseHTMLContent(html);
      assert.equal(manifest(part), manifest(doc));
      assert.equal(config(part), config(doc));
      assert.equal(part.querySelector('script[data-openmotion-preview]')?.hasAttribute('src'), false);
      assert.equal(part.querySelector('[data-composition-file]')?.getAttribute('data-composition-file'), file);
      assert.ok(html.includes('Unique text ' + i));
      assert.ok(!html.includes('Unique text ' + (1-i)));
      assert.ok(html.includes(base + 'poster-' + i + '.png'));
      const tag = response.headers.get('etag')!;
      assert.ok(tag && !etags.has(tag));
      etags.add(tag);
      assert.equal((await app.request(sceneUrl(file), {headers: {'If-None-Match': tag}})).status, 304);
    }
    base = 'https://preview.example/grant-two/';
    const renewed = await app.request(sceneUrl(paths[0]!));
    const html = await renewed.text();
    assert.ok(html.includes(base + 'poster-0.png') && !html.includes('grant-one'));
    assert.equal(loads.mock.callCount(), 1);
    assert.equal((await app.request(sceneUrl('missing.html'))).status, 404);
    assert.equal((await app.request(sceneUrl('poster.png'))).status, 400);
    assert.equal((await app.request(sceneUrl(paths[0]!) + '&capture=1')).status, 400);
  });

  it('gates isolated documents and revalidation on bridge publication across API versions', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const path = `/api/projects/${projectId}/preview`;
    function isolatedPod(studioApp = env.studioApp) {
      const app = new Hono<{ Variables: StudioVariables }>();
      app.use('*', async (c, next) => { c.set('previewAssetBase', 'https://preview.test/base/'); await next(); });
      return app.route('/', studioApp);
    }
    const first = await isolatedPod().request(path);
    assert.equal(first.status, 200);
    const tag = first.headers.get('etag')!;
    const selector = 'script[data-openmotion-preview]';
    const bridge = parseHTMLContent(await first.text()).querySelector(selector)!;
    const url = new URL(bridge.getAttribute('src')!);
    const key = 'system/preview-bridge/' + url.pathname.split('/').pop();
    await env.storage.deleteObject(key);

    // Another running API version can only serve this document's script from storage.
    const olderPod = createPreviewBridgeAssets(env.storage, '// earlier build').routes;
    function assertNoStore(response: Response, status: number) {
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
    }
    assertNoStore(await olderPod.request(url), 404);

    const pod = isolatedPod(env.createStudioApp());
    const storage: StoragePort = env.storage;
    const putObject = storage.putObject.bind(storage);
    const write = t.mock.method(storage, 'putObject');
    const stalled = Promise.withResolvers<void>();
    const deadline = new AbortController();
    const timeout = t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
    write.mock.mockImplementationOnce(async (_key, _body, _type, _length, signal) => {
      assert.ok(signal);
      stalled.resolve();
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const loads = t.mock.method(env.files, 'loadVirtualProject');
    const conditional = { headers: { 'If-None-Match': tag } };
    const documents = Promise.all([pod.request(path, conditional), pod.request(path + '/comp/index.html')]);
    await stalled.promise;
    assert.equal(write.mock.callCount(), 1);
    assert.equal(loads.mock.callCount(), 0);
    assert.deepEqual(timeout.mock.calls[0]!.arguments, [3000]);
    deadline.abort();
    timeout.mock.restore();
    for (const response of await documents) {
      assertNoStore(response, 503);
      assert.equal(response.headers.get('retry-after'), '1');
      const html = await response.text();
      assert.match(html, /preview-build-busy/);
      assert.ok(!html.includes(url.pathname));
    }
    assertNoStore(await pod.request(path), 503);
    assert.equal(write.mock.callCount(), 1);

    t.mock.timers.tick(1000);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    write.mock.mockImplementationOnce(async (...args) => {
      started.resolve();
      await release.promise;
      await putObject(...args);
    });
    const retry = Promise.all([pod.request(path, conditional), pod.request(path)]);
    await started.promise;
    assertNoStore(await olderPod.request(url), 404);
    assert.equal(loads.mock.callCount(), 0);
    release.resolve();
    const [revalidated, full] = await retry;
    assert.equal(revalidated.status, 304);
    assert.equal(full.status, 200);
    const published = parseHTMLContent(await full.text()).querySelector(selector)!;
    assert.equal(published.getAttribute('src'), url.href);
    assert.equal(write.mock.callCount(), 2);
    assert.equal((await pod.request(path)).status, 200);
    assert.equal(write.mock.callCount(), 2);

    const read = t.mock.method(storage, 'getObjectBuffer');
    read.mock.mockImplementationOnce(async () => { throw new Error('temporary storage failure'); });
    assertNoStore(await olderPod.request(url), 503);
    read.mock.mockImplementationOnce(async () => Buffer.from('different bytes'));
    assertNoStore(await olderPod.request(url), 503);
    for (const reader of [pod, olderPod]) {
      const response = await reader.request(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(response.headers.get('cdn-cache-control'), null);
      const sha = sha256Hex(await response.text());
      assert.equal(url.pathname, `/api/preview-bridge/${sha}.js`);
      assert.equal(published.getAttribute('integrity'), 'sha256-' + Buffer.from(sha, 'hex').toString('base64'));
    }
  });

  it('signals retryable overload to an isolated document through the authenticated bridge', async t => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const projectPath = `/api/projects/${projectId}/preview`;
    const app = new Hono<{ Variables: StudioVariables }>();
    app.use('*', async (c, next) => { c.set('previewAssetBase', 'https://preview.test/base/'); await next(); });
    app.route('/', env.studioApp);
    t.mock.method(PreviewDocumentCache.prototype, 'get', () => { throw new PreviewBuildBusy(); });
    const busy = await app.request(projectPath + '?pt=example-token');
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '1');
    assert.match(busy.headers.get('content-type')!, /text\/html/);
    assert.equal(busy.headers.get('cache-control'), 'no-store');
    const script = (await busy.text()).match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const parent = { postMessage: t.mock.fn() };
    runInNewContext(script, { window: { parent }, URL, document: { referrer: 'https://studio.test/' },
      location: { href: 'https://preview.test' + projectPath + '?pt=example-token' } });
    assert.equal(parent.postMessage.mock.callCount(), 1);
    const [message, origin] = parent.postMessage.mock.calls[0]!.arguments as unknown as [Record<string, unknown>, string];
    assert.deepEqual({ ...message }, { source: 'openmotion-preview-bridge', version: 1, type: 'preview-build-busy',
      projectId, token: 'example-token', retryAfterMs: 1000 });
    assert.equal(origin, 'https://studio.test');
  });

  it('late-binds scoped roots and import maps while preserving authored base resolution', async () => {
    const env = createStudioTestEnv();
    const { projectId } = await env.workspace.createProject(env.auth);
    const path = `/api/projects/${projectId}/preview`;
    const app = new Hono<{ Variables: StudioVariables }>();
    let base = '';
    app.use('*', async (c, next) => { c.set('previewAssetBase', base); await next(); });
    app.route('/', env.studioApp);
    for (const href of ['assets/styles/', '../other/', '.', 'https://external.example/static/']) {
      await env.files.commitChanges(env.auth, { projectId, ops: [{
        op: 'upsert_text', path: 'index.html',
        content: `<html><head><base href="${href}"></head><body><img src="/poster.png"></body></html>`,
      }] });
      for (const lease of ['grant-a', 'grant-b']) {
        base = `https://preview.example${path}/~assets/${lease}/`;
        const response = await app.request(path);
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.equal(html.match(/<base href="([^"]+)"/)?.[1], new URL(href, base).href);
        assert.ok(html.includes(base + 'poster.png'));
        assert.ok(html.includes(JSON.stringify({ imports: { '/': base, [base]: base } })));
      }
    }
  });

  it('verifies #41 fixes: HTTP /preview + /preview/comp/* 200, real /api/runtime.js, worker-render resultJson interop, RBAC/scopes, HEAD thumbnails, PUT selection, GET open-in-desktop, and multi-file upload', async () => {
    const env = createStudioTestEnv();
    const subHtml = `<!DOCTYPE html><html><body><div data-composition-id="sub" data-width="1920" data-height="1080" data-duration="3"><span>Sub</span></div></body></html>`;
    const created = await env.workspace.createProject(env.auth, { title: 'Verifier41 Suite' });
    await env.files.commitChanges(env.auth, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_text', path: 'compositions/sub.html', content: subHtml }],
    });

    // 1. Live GET /api/projects/:id/preview and /preview/comp/* return 200 with root-relative gsapBaseUrl.
    const previewRes = await env.studioApp.request(`/api/projects/${created.projectId}/preview`);
    const previewHtml = await previewRes.text();
    assert.equal(previewRes.status, 200, previewHtml);
    assert.ok(previewHtml.includes('/api/vendor/gsap/'));
    assert.ok(previewHtml.includes('/api/runtime.js'));

    const subPreviewRes = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/comp/compositions/sub.html`,
    );
    assert.equal(subPreviewRes.status, 200);
    assert.ok((await subPreviewRes.text()).includes('Sub'));

    // 2. GET /api/runtime.js returns real pre-built Hyperframes browser runtime IIFE (>> 100 KB).
    const runtimeRes = await env.studioApp.request('/api/runtime.js');
    assert.equal(runtimeRes.status, 200);
    const runtimeJs = await runtimeRes.text();
    assert.ok(runtimeJs.length > 100_000, `Expected full Hyperframes runtime script, got ${runtimeJs.length} bytes`);

    // 3. Render worker interop: resultJson with { outputName, bytes, s3Key } + failed -> 'failed' + ?download=1.
    const workerJobId = randomUUID();
    env.pgClient.seed('jobs', {
      id: workerJobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'export_render',
      state: 'completed',
      stage: 'done',
      progress: 100,
      input_payload: { outputName: 'worker-out.mp4' },
      result_json: {
        s3Key: exportKey(env.auth.workspaceId, workerJobId, 'worker-out.mp4'),
        outputName: 'worker-out.mp4',
        bytes: 123456,
        sha256: 'e'.repeat(64),
      },
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const failedJobId = randomUUID();
    env.pgClient.seed('jobs', {
      id: failedJobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'export_render',
      state: 'failed',
      stage: 'render',
      progress: 12,
      input_payload: { outputName: 'broken.mp4' },
      error_message: 'boom',
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const headWorkerRender = await env.studioApp.request(`/api/render/${workerJobId}/view`, { method: 'HEAD' });
    assert.equal(headWorkerRender.status, 200);
    assert.equal(headWorkerRender.headers.get('content-length'), '123456');

    const rendersList = (await (await env.studioApp.request(`/api/projects/${created.projectId}/renders`)).json()) as {
      renders: Array<{ id: string; status: string; bytes?: number }>;
    };
    assert.equal(rendersList.renders.find((r) => r.id === failedJobId)?.status, 'failed');
    assert.equal(rendersList.renders.find((r) => r.id === workerJobId)?.bytes, 123456);

    const downloadByFilename = await env.studioApp.request(
      `/api/projects/${created.projectId}/renders/file/worker-out.mp4?download=1`,
    );
    assert.equal(downloadByFilename.status, 302);
    assert.ok(downloadByFilename.headers.get('location')?.includes('attachment'));

    // 4. HEAD on /thumbnail and /image-thumbnail/* answered directly (200 on hit, 204 on ?cached=1 miss, NEVER 302).
    const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await env.files.commitChanges(env.auth, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_binary', path: 'assets/pic.png', data: imgBytes, mimeType: 'image/png' }],
    });
    const imgSha = sha256Hex(imgBytes);
    await env.storage.putObject(thumbnailKey(env.auth.workspaceId, imgSha, 'w320'), Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');

    const presignBefore = env.storage.presignGetCalls;
    const headImgThumb = await env.studioApp.request(
      `/api/projects/${created.projectId}/image-thumbnail/assets/pic.png`,
      { method: 'HEAD' },
    );
    assert.equal(headImgThumb.status, 200);
    assert.equal(headImgThumb.headers.get('content-type'), 'image/jpeg');
    assert.equal(headImgThumb.headers.get('content-length'), '3');

    const headCompMiss = await env.studioApp.request(
      `/api/projects/${created.projectId}/thumbnail?cached=1`,
      { method: 'HEAD' },
    );
    assert.equal(headCompMiss.status, 204);
    assert.equal(env.storage.presignGetCalls, presignBefore, 'HEAD thumbnail must NEVER call presignGet');

    // 5. PUT /api/projects/:id/selection with { selection } and GET /api/open-in-desktop.
    const putSel = await env.studioApp.request(`/api/projects/${created.projectId}/selection`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection: { elementIds: ['headline'], compositionId: 'main' } }),
    });
    assert.equal(putSel.status, 200);
    const getSel = await (await env.studioApp.request(`/api/projects/${created.projectId}/selection`)).json() as {
      elementIds: string[];
    };
    assert.deepEqual(getSel.elementIds, ['headline']);

    const getDesktop = await env.studioApp.request('/api/open-in-desktop');
    assert.equal(getDesktop.status, 200);
    assert.deepEqual(await getDesktop.json(), { available: false, handoff: false, installed: false });

    // 6. Multi-file upload saves the originals and enqueues only eager media jobs.
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' }));
    form.append('file', new File([new Uint8Array([1, 2, 3, 4])], 'b.jpg', { type: 'image/jpeg' }));
    form.append('file', new File([new Uint8Array([5, 6, 7])], 'c.mp4', { type: 'video/mp4' }));
    env.enqueued.length = 0;
    const uploadRes = await env.studioApp.request(`/api/projects/${created.projectId}/upload?dir=media`, {
      method: 'POST',
      body: form,
    });
    assert.equal(uploadRes.status, 201);
    const uploadJson = (await uploadRes.json()) as { files: string[]; path: string };
    assert.deepEqual(uploadJson.files, ['media/a.png', 'media/b.jpg', 'media/c.mp4']);
    assert.equal(uploadJson.path, 'media/a.png');
    assert.deepEqual(env.enqueued.map(job => job.name).sort(), [
      'extract_waveform_peaks', 'generate_preview_proxy', 'media_probe', 'media_probe', 'media_probe',
    ]);
    env.enqueued.length = 0;
    const thumbnail = await env.studioApp.request(`/api/projects/${created.projectId}/image-thumbnail/media/a.png`);
    assert.equal(thumbnail.status, 202);
    assert.deepEqual(env.enqueued.map(job => job.name), ['image_thumbnail']);
    assert.equal((env.enqueued[0].payload as { spec: string }).spec, 'w320');

    // 7. RBAC & PAT scope enforcement: viewer with projects:read only is allowed reads and blocked (403) on writes!
    const viewerAuth: AuthContext = {
      ...env.auth,
      role: 'viewer',
      scopes: ['projects:read'],
      authMethod: 'pat',
    };
    const db = drizzle({ client: env.pgClient as never, schema }) as unknown as Database;
    const viewerStudio = createDisklessStudioApp({
      db,
      storage: env.storage,
      hotTextCache: env.hotTextCache,
      eventBus: env.eventBus,
      queues: { enqueueMediaIngest: async () => ({}), enqueueRenderExport: async () => ({}) },
      workspace: env.workspace,
      files: env.files,
      history: env.history,
      assetNames: new AssetNamesService({ db, files: env.files }),
      resolveAuth: () => viewerAuth,
      skipDeterministicFonts: true,
    });
    const viewerProjects = createProjectsRouter({
      workspace: env.workspace,
      files: env.files,
      history: env.history,
      assetNames: new AssetNamesService({ db, files: env.files }),
      workRounds: new WorkRoundsService(db),
      resolveAuth: () => viewerAuth,
    });
    const viewerSessions = createSessionsRouter({ workspace: env.workspace, resolveAuth: () => viewerAuth });
    const viewerArchives = createArchivesRouter({
      archives: new ProjectArchiveService({ db, storage: env.storage, workspace: env.workspace, files: env.files }),
      resolveAuth: () => viewerAuth,
    });

    assert.equal((await viewerStudio.request(`/api/projects/${created.projectId}/files/index.html`)).status, 200);
    assert.equal((await viewerProjects.request('/motion-api/projects')).status, 200);

    const viewerPut = await viewerStudio.request(`/api/projects/${created.projectId}/files/index.html`, {
      method: 'PUT',
      headers: { 'If-Match': '*' },
      body: 'nope',
    });
    assert.equal(viewerPut.status, 403);
    assert.equal(((await viewerPut.json()) as { applied: boolean }).applied, false);

    assert.equal(
      (await viewerProjects.request('/motion-api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status,
      403,
    );
    assert.equal(
      (await viewerSessions.request('/motion-api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status,
      403,
    );
    assert.equal(
      (await viewerArchives.request('/motion-api/project-archives/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) })).status,
      403,
    );

    // Editor with projects:write but without exports:write gets 403 on POST /render!
    const noExportEditor: AuthContext = {
      ...env.auth,
      role: 'editor',
      scopes: ['projects:read', 'projects:write'],
      authMethod: 'pat',
    };
    const noExportStudio = createDisklessStudioApp({
      db,
      storage: env.storage,
      hotTextCache: env.hotTextCache,
      eventBus: env.eventBus,
      queues: { enqueueMediaIngest: async () => ({}), enqueueRenderExport: async () => ({}) },
      workspace: env.workspace,
      files: env.files,
      history: env.history,
      assetNames: new AssetNamesService({ db, files: env.files }),
      resolveAuth: () => noExportEditor,
      skipDeterministicFonts: true,
    });
    const deniedRender = await noExportStudio.request(`/api/projects/${created.projectId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'mp4' }),
    });
    assert.equal(deniedRender.status, 403);
  });

  it('serves ready previewProxy on GET/HEAD /preview/* (c1), bypasses on ?original=1 / ?raw=1, and falls back when absent, failed, or cross-tenant', async () => {
    const env = createStudioTestEnv();
    const created = await env.workspace.createProject(env.auth, { title: 'Dual Track Proxy' });

    const rawVideo = Buffer.alloc(4096, 0x42);
    const rawVideoSha = sha256Hex(rawVideo);
    const proxyVideoKey = `workspaces/${env.auth.workspaceId}/derived/${rawVideoSha}/proxy.mp4`;

    const rawImage = Buffer.alloc(2048, 0x55);
    const rawImageSha = sha256Hex(rawImage);
    const proxyImageKey = `workspaces/${env.auth.workspaceId}/derived/${rawImageSha}/proxy.webp`;

    const failedVideo = Buffer.from('FAILED_PROXY_MP4_SOURCE');
    const failedVideoSha = sha256Hex(failedVideo);

    const tamperedVideo = Buffer.from('CROSS_TENANT_TAMPERED_SOURCE');
    const tamperedVideoSha = sha256Hex(tamperedVideo);
    const otherWorkspaceId = '99999999-9999-4999-8999-999999999999';

    await env.files.commitChanges(env.auth, {
      projectId: created.projectId,
      ops: [
        { op: 'upsert_binary', path: 'assets/clip4k.mp4', data: rawVideo, mimeType: 'video/mp4' },
        { op: 'upsert_binary', path: 'assets/photo.png', data: rawImage, mimeType: 'image/png' },
        { op: 'upsert_binary', path: 'assets/failed.mp4', data: failedVideo, mimeType: 'video/mp4' },
        { op: 'upsert_binary', path: 'assets/tampered.mp4', data: tamperedVideo, mimeType: 'video/mp4' },
      ],
    });

    // Attach frozen worker-media previewProxy metadata onto workspace_blobs rows
    const attachMeta = (sha: string, meta: Record<string, unknown>) => {
      const row = env.pgClient
        .rows('workspace_blobs')
        .find((r) => r.workspace_id === env.auth.workspaceId && r.sha256 === sha);
      assert.ok(row, `expected workspace_blobs row for ${sha}`);
      row.metadata = meta;
    };

    attachMeta(rawVideoSha, {
      modality: 'video',
      width: 3840,
      height: 2160,
      previewProxy: {
        status: 'ready',
        s3Key: proxyVideoKey,
        mimeType: 'video/mp4',
        sizeBytes: 512,
        width: 1280,
        height: 720,
        codec: 'h264',
        generatedAt: '2026-11-20T00:00:00.000Z',
      },
    });
    attachMeta(rawImageSha, {
      modality: 'image',
      width: 4000,
      height: 3000,
      previewProxy: {
        status: 'ready',
        s3Key: proxyImageKey,
        mimeType: 'image/webp',
        sizeBytes: 256,
        width: 1920,
        height: 1440,
        codec: 'webp',
        generatedAt: '2026-11-20T00:00:00.000Z',
      },
    });
    attachMeta(failedVideoSha, {
      modality: 'video',
      previewProxy: {
        status: 'failed',
        s3Key: `workspaces/${env.auth.workspaceId}/derived/${failedVideoSha}/proxy.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: 0,
        generatedAt: '2026-11-20T00:00:00.000Z',
      },
    });
    attachMeta(tamperedVideoSha, {
      modality: 'video',
      previewProxy: {
        status: 'ready',
        s3Key: `workspaces/${otherWorkspaceId}/derived/${tamperedVideoSha}/proxy.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: 128,
        generatedAt: '2026-11-20T00:00:00.000Z',
      },
    });

    // 1. Ready video proxy: HEAD answers 200 directly with proxy metadata (zero S3 redirect!)
    const presignBefore = env.storage.presignGetCalls;
    const headProxy = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/clip4k.mp4`,
      { method: 'HEAD' },
    );
    assert.equal(headProxy.status, 200);
    assert.equal(headProxy.headers.get('content-type'), 'video/mp4');
    assert.equal(headProxy.headers.get('content-length'), '512');
    assert.equal(headProxy.headers.get('x-openmotion-media-track'), 'proxy');
    assert.equal(env.storage.presignGetCalls, presignBefore, 'HEAD proxy must NEVER call presignGet');

    // 2. Ready video proxy: GET returns 302 redirecting to derived proxy s3Key with proxy headers
    const getProxy = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/clip4k.mp4`,
    );
    assert.equal(getProxy.status, 302);
    assert.equal(getProxy.headers.get('x-openmotion-media-track'), 'proxy');
    assert.equal(getProxy.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(getProxy.headers.get('vary'), 'Origin, Cookie');
    assert.ok(getProxy.headers.get('location')?.startsWith(`https://s3.local/${proxyVideoKey}`));

    // 3. Ready image WebP proxy switches MIME type & size on HEAD + redirects to proxy.webp on GET
    const headImgProxy = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/photo.png`,
      { method: 'HEAD' },
    );
    assert.equal(headImgProxy.status, 200);
    assert.equal(headImgProxy.headers.get('content-type'), 'image/webp');
    assert.equal(headImgProxy.headers.get('content-length'), '256');
    assert.equal(headImgProxy.headers.get('x-openmotion-media-track'), 'proxy');

    const getImgProxy = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/photo.png`,
    );
    assert.equal(getImgProxy.status, 302);
    assert.equal(getImgProxy.headers.get('x-openmotion-media-track'), 'proxy');
    assert.ok(getImgProxy.headers.get('location')?.startsWith(`https://s3.local/${proxyImageKey}`));

    // 4. ?original=1 and ?raw=1 bypass proxy and serve the original CAS blob
    const headOriginal = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/clip4k.mp4?original=1`,
      { method: 'HEAD' },
    );
    assert.equal(headOriginal.status, 200);
    assert.equal(headOriginal.headers.get('content-length'), '4096');
    assert.equal(headOriginal.headers.get('x-openmotion-media-track'), 'original');

    const getOriginal = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/clip4k.mp4?original=1`,
    );
    assert.equal(getOriginal.status, 302);
    assert.equal(getOriginal.headers.get('x-openmotion-media-track'), 'original');
    assert.ok(
      getOriginal.headers
        .get('location')
        ?.startsWith(`https://s3.local/workspaces/${env.auth.workspaceId}/blobs/${rawVideoSha}`),
    );

    const getRaw = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/photo.png?raw=1`,
    );
    assert.equal(getRaw.status, 302);
    assert.equal(getRaw.headers.get('x-openmotion-media-track'), 'original');
    assert.ok(
      getRaw.headers
        .get('location')
        ?.startsWith(`https://s3.local/workspaces/${env.auth.workspaceId}/blobs/${rawImageSha}`),
    );

    // 5. Failed proxy seamlessly falls back to original
    const getFailed = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/failed.mp4`,
    );
    assert.equal(getFailed.status, 302);
    assert.equal(getFailed.headers.get('x-openmotion-media-track'), 'original');
    assert.ok(
      getFailed.headers
        .get('location')
        ?.startsWith(`https://s3.local/workspaces/${env.auth.workspaceId}/blobs/${failedVideoSha}`),
    );

    // 6. Cross-tenant proxy s3Key is rejected and falls back cleanly to original
    const getTampered = await env.studioApp.request(
      `/api/projects/${created.projectId}/preview/assets/tampered.mp4`,
    );
    assert.equal(getTampered.status, 302);
    assert.equal(getTampered.headers.get('x-openmotion-media-track'), 'original');
    assert.ok(
      getTampered.headers
        .get('location')
        ?.startsWith(`https://s3.local/workspaces/${env.auth.workspaceId}/blobs/${tamperedVideoSha}`),
    );
  });

  it('serves /sprite/* (202 pending -> 200 manifest), /sprite-sheet/:idx/* (HEAD 200 / GET 302), silent /peaks/*, and assetMetadata on GET /api/projects/:id', async () => {
    const env = createStudioTestEnv();
    const created = await env.workspace.createProject(env.auth, { title: 'Sprite & Metadata Test' });

    const videoBytes = Buffer.alloc(1024, 0x33);
    const silentBytes = Buffer.alloc(512, 0x44);
    const failedBytes = Buffer.alloc(256, 0x55);

    await env.files.commitChanges(env.auth, {
      projectId: created.projectId,
      ops: [
        { op: 'upsert_binary', path: 'assets/hero.mp4', data: videoBytes, mimeType: 'video/mp4' },
        { op: 'upsert_binary', path: 'assets/silent.mp4', data: silentBytes, mimeType: 'video/mp4' },
        { op: 'upsert_binary', path: 'assets/broken.mp4', data: failedBytes, mimeType: 'video/mp4' },
      ],
      source: 'studio',
      summary: 'Add test videos',
    });

    const videoSha = sha256Hex(videoBytes);
    const silentSha = sha256Hex(silentBytes);
    const failedSha = sha256Hex(failedBytes);

    const blobs = env.pgClient.rows('workspace_blobs');
    const heroBlob = blobs.find((b) => b.sha256 === videoSha)!;
    heroBlob.metadata = {
      modality: 'video',
      durationSec: 18.5,
      width: 1920,
      height: 1080,
      hasAudio: true,
      hasVideo: true,
      thumbnailReady: true,
    };
    const silentBlob = blobs.find((b) => b.sha256 === silentSha)!;
    silentBlob.metadata = {
      modality: 'video',
      durationSec: 6.0,
      width: 1280,
      height: 720,
      hasAudio: false,
      hasVideo: true,
    };
    const failedBlob = blobs.find((b) => b.sha256 === failedSha)!;
    failedBlob.metadata = {
      modality: 'video',
      sprite: {
        status: 'failed',
        manifestKey: '',
        frameCount: 0,
        frameWidth: 0,
        frameHeight: 0,
        durationSec: 0,
        intervalSec: 0,
        sheetCount: 0,
        generatedAt: '2026-11-21T00:00:00.000Z',
      },
    };

    // 1. Cold sprite request -> 202 pending + enqueues generate_video_sprite
    env.enqueued.length = 0;
    const pendingRes = await env.studioApp.request(`/api/projects/${created.projectId}/sprite/assets/hero.mp4`);
    assert.equal(pendingRes.status, 202);
    const pendingBody = (await pendingRes.json()) as { pending: boolean; sha256: string };
    assert.equal(pendingBody.pending, true);
    assert.equal(pendingBody.sha256, videoSha);
    assert.ok(env.enqueued.some((j) => j.name === 'generate_video_sprite'));

    // 2. Failed sprite -> 404 unavailable (allows immediate client fallback)
    const failedRes = await env.studioApp.request(`/api/projects/${created.projectId}/sprite/assets/broken.mp4`);
    assert.equal(failedRes.status, 404);

    // 3. Cached sprite manifest + WebP sheet -> 200 manifest with rewritten sheet URL, HEAD 200 & GET 302 on sheet
    const sheetKey = derivedAssetKey(env.auth.workspaceId, videoSha, 'sprite-0.webp');
    const manifestKey = derivedAssetKey(env.auth.workspaceId, videoSha, 'sprite-manifest.json');
    await env.storage.putObject(sheetKey, Buffer.from('RIFF....WEBP'), 'image/webp');
    await env.storage.putObject(
      manifestKey,
      Buffer.from(
        JSON.stringify({
          version: 1,
          sha256: videoSha,
          durationSec: 18.5,
          frameCount: 18,
          frameWidth: 160,
          frameHeight: 90,
          intervalSec: 1.028,
          columns: 10,
          rows: 6,
          sheets: [
            {
              index: 0,
              s3Key: sheetKey,
              startFrame: 0,
              frameCount: 18,
              columns: 10,
              rows: 2,
              width: 1600,
              height: 180,
            },
          ],
        }),
      ),
      'application/json',
    );
    (heroBlob.metadata as Record<string, unknown>).sprite = {
      status: 'ready',
      manifestKey,
      frameCount: 18,
      frameWidth: 160,
      frameHeight: 90,
      durationSec: 18.5,
      intervalSec: 1.028,
      sheetCount: 1,
      generatedAt: '2026-11-21T00:00:00.000Z',
    };

    const hitRes = await env.studioApp.request(`/api/projects/${created.projectId}/sprite/assets/hero.mp4`);
    assert.equal(hitRes.status, 200);
    const hitBody = (await hitRes.json()) as {
      pending: boolean;
      frameCount: number;
      sheets: Array<{ index: number; url: string }>;
    };
    assert.equal(hitBody.pending, false);
    assert.equal(hitBody.frameCount, 18);
    assert.equal(
      hitBody.sheets[0].url,
      `/api/projects/${created.projectId}/sprite-sheet/0/assets/hero.mp4`,
    );

    const headSheet = await env.studioApp.request(
      `/api/projects/${created.projectId}/sprite-sheet/0/assets/hero.mp4`,
      { method: 'HEAD' },
    );
    assert.equal(headSheet.status, 200);
    assert.equal(headSheet.headers.get('content-type'), 'image/webp');

    const getSheet = await env.studioApp.request(
      `/api/projects/${created.projectId}/sprite-sheet/0/assets/hero.mp4`,
    );
    assert.equal(getSheet.status, 302);
    assert.ok(getSheet.headers.get('location')?.startsWith(`https://s3.local/${sheetKey}`));

    // 4. Silent video /peaks/* fast-path returns 200 empty peaks without queuing a job
    env.enqueued.length = 0;
    const silentPeaksRes = await env.studioApp.request(`/api/projects/${created.projectId}/peaks/assets/silent.mp4`);
    assert.equal(silentPeaksRes.status, 200);
    const silentPeaks = (await silentPeaksRes.json()) as { hasAudio: boolean; peaks: number[]; bins: number[] };
    assert.equal(silentPeaks.hasAudio, false);
    assert.deepEqual(silentPeaks.peaks, []);
    assert.deepEqual(silentPeaks.bins, []);
    assert.equal(env.enqueued.length, 0);

    // 5. GET /api/projects/:id includes assetMetadata summary & optimizationStatus without extra queries
    const projRes = await env.studioApp.request(`/api/projects/${created.projectId}`);
    assert.equal(projRes.status, 200);
    const projBody = (await projRes.json()) as {
      assetMetadata?: Record<
        string,
        {
          duration?: number;
          width?: number;
          height?: number;
          hasAudio?: boolean;
          spriteStatus?: string;
          thumbnailReady?: boolean;
          optimizationStatus?: 'optimizing' | 'ready';
        }
      >;
    };
    assert.equal(projBody.assetMetadata?.['assets/hero.mp4']?.duration, 18.5);
    assert.equal(projBody.assetMetadata?.['assets/hero.mp4']?.spriteStatus, 'ready');
    assert.equal(projBody.assetMetadata?.['assets/hero.mp4']?.thumbnailReady, true);
    // Sprite is ready but previewProxy hasn't completed yet -> optimizing
    assert.equal(projBody.assetMetadata?.['assets/hero.mp4']?.optimizationStatus, 'optimizing');
    assert.equal(projBody.assetMetadata?.['assets/silent.mp4']?.hasAudio, false);
    assert.equal(projBody.assetMetadata?.['assets/silent.mp4']?.optimizationStatus, 'optimizing');

    // Once proxy also finishes, hero.mp4 transitions cleanly to optimizationStatus === 'ready'
    (heroBlob.metadata as Record<string, unknown>).previewProxy = { status: 'ready' };
    (silentBlob.metadata as Record<string, unknown>).previewProxy = { status: 'ready' };
    const projReadyRes = await env.studioApp.request(`/api/projects/${created.projectId}`);
    assert.equal(projReadyRes.status, 200);
    const projReadyBody = (await projReadyRes.json()) as {
      assetMetadata?: Record<string, { optimizationStatus?: 'optimizing' | 'ready' }>;
    };
    assert.equal(projReadyBody.assetMetadata?.['assets/hero.mp4']?.optimizationStatus, 'ready');
    assert.equal(projReadyBody.assetMetadata?.['assets/silent.mp4']?.optimizationStatus, 'ready', 'a video without a requested sprite is ready once its proxy settles');

    // 6. GET /api/projects/:id/media/metadata skips media_probe for vector SVG files
    await env.files.commitChanges(env.auth, {
      projectId: created.projectId,
      ops: [
        {
          op: 'upsert_text',
          path: 'assets/favicon.svg',
          content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
          mimeType: 'image/svg+xml',
        },
      ],
      source: 'studio',
      summary: 'Add SVG favicon',
    });
    env.enqueued.length = 0;
    const svgMetaRes = await env.studioApp.request(
      `/api/projects/${created.projectId}/media/metadata?path=assets/favicon.svg`,
    );
    assert.equal(svgMetaRes.status, 200);
    const svgMetaBody = (await svgMetaRes.json()) as { pending: boolean; metadata: unknown; mimeType: string };
    assert.equal(svgMetaBody.pending, false);
    assert.equal(svgMetaBody.metadata, null);
    assert.equal(svgMetaBody.mimeType, 'image/svg+xml');
    assert.equal(env.enqueued.length, 0);
  });

  it('returns 503 instead of endless 202 pending on /waveform/* when media queues are missing or fail to enqueue', async () => {
    const env = createStudioTestEnv();
    const created = await env.workspace.createProject(env.auth, { title: 'Waveform Queue Fallback Test' });
    await env.files.commitChanges(env.auth, {
      projectId: created.projectId,
      ops: [{ op: 'upsert_binary', path: 'assets/soundtrack.m4a', data: Buffer.from('fake-m4a'), mimeType: 'audio/mp4' }],
      source: 'studio',
      summary: 'Add soundtrack',
    });

    const db = drizzle({ client: env.pgClient as never, schema }) as unknown as Database;
    const noQueueStudio = createDisklessStudioApp({
      db,
      storage: env.storage,
      hotTextCache: env.hotTextCache,
      eventBus: env.eventBus,
      workspace: env.workspace,
      files: env.files,
      history: env.history,
      assetNames: new AssetNamesService({ db, files: env.files }),
      resolveAuth: () => env.auth,
      skipDeterministicFonts: true,
    });
    const noQueueRes = await noQueueStudio.request(
      `/api/projects/${created.projectId}/waveform/assets/soundtrack.m4a`,
    );
    assert.equal(noQueueRes.status, 503);

    const brokenQueueStudio = createDisklessStudioApp({
      db,
      storage: env.storage,
      hotTextCache: env.hotTextCache,
      eventBus: env.eventBus,
      queues: {
        enqueueMediaIngest: async () => {
          throw new Error('redis offline');
        },
        enqueueRenderExport: async () => ({}),
      },
      workspace: env.workspace,
      files: env.files,
      history: env.history,
      assetNames: new AssetNamesService({ db, files: env.files }),
      resolveAuth: () => env.auth,
      skipDeterministicFonts: true,
    });
    const brokenQueueRes = await brokenQueueStudio.request(
      `/api/projects/${created.projectId}/waveform/assets/soundtrack.m4a`,
    );
    assert.equal(brokenQueueRes.status, 503);
  });

  it('reports render workerActive liveness, cancels orphaned renders immediately, and reconciles stale dead-worker jobs on re-export', async () => {
    const env = createStudioTestEnv();
    const created = await env.workspace.createProject(env.auth, {
      title: 'Export Recovery Project',
      initialFiles: [{ path: 'index.html', content: '<html><body>hi</body></html>' }],
    });

    // 1. Live worker: queued/running job reports workerActive: true and status: 'rendering'.
    const liveJobId = randomUUID();
    env.pgClient.seed('jobs', {
      id: liveJobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'export_render',
      state: 'running',
      stage: 'rendering',
      progress: 42,
      worker_id: 'render-1',
      input_payload: { outputName: 'live-render.mp4' },
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const liveListRes = await env.studioApp.request(`/api/projects/${created.projectId}/renders`);
    assert.equal(liveListRes.status, 200);
    const liveList = (await liveListRes.json()) as {
      renders: Array<{ id: string; status: string; workerActive?: boolean }>;
    };
    assert.equal(liveList.renders[0]?.id, liveJobId);
    assert.equal(liveList.renders[0]?.status, 'rendering');
    assert.equal(liveList.renders[0]?.workerActive, true);

    // 2. Claiming worker goes offline: /renders and /progress report status: 'unknown', workerActive: false.
    env.workerHealth.length = 0;
    const offlineListRes = await env.studioApp.request(`/api/projects/${created.projectId}/renders`);
    assert.equal(offlineListRes.status, 200);
    const offlineList = (await offlineListRes.json()) as {
      renders: Array<{ id: string; status: string; workerActive?: boolean }>;
    };
    assert.equal(offlineList.renders[0]?.status, 'unknown');
    assert.equal(offlineList.renders[0]?.workerActive, false);

    const offlineProgressRes = await env.studioApp.request(`/api/render/${liveJobId}/progress`);
    assert.equal(offlineProgressRes.status, 200);
    const offlineProgressBody = await offlineProgressRes.text();
    assert.ok(offlineProgressBody.includes('"status":"unknown"'));
    assert.ok(offlineProgressBody.includes('"workerActive":false'));

    // 3. Cancelling an orphaned running render converges directly to 'cancelled' and unblocks new exports.
    const cancelOrphanRes = await env.studioApp.request(`/api/render/${liveJobId}/cancel`, { method: 'POST' });
    assert.equal(cancelOrphanRes.status, 200);
    const cancelOrphanBody = (await cancelOrphanRes.json()) as { status: string; state: string; workerActive: boolean };
    assert.equal(cancelOrphanBody.status, 'cancelled');
    assert.equal(cancelOrphanBody.state, 'cancelled');
    assert.equal(cancelOrphanBody.workerActive, false);

    // 4. A stale dead-worker running job (> 60s old) is automatically reconciled when starting a new export.
    const staleJobId = randomUUID();
    const staleIso = new Date(Date.now() - 120_000).toISOString();
    env.pgClient.seed('jobs', {
      id: staleJobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'export_render',
      state: 'running',
      stage: 'rendering',
      progress: 50,
      worker_id: 'dead-worker-9',
      input_payload: { outputName: 'stale-render.mp4' },
      deleted_at: null,
      created_at: staleIso,
      updated_at: staleIso,
    });
    env.workerHealth.push({
      workerId: 'render-2',
      ffmpeg: true,
      ffprobe: true,
      chromium: true,
      concurrency: 1,
      activeJobs: 0,
      updatedAt: Date.now(),
    });

    const newExportRes = await env.studioApp.request(`/api/projects/${created.projectId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'mp4', fps: 30, quality: 'standard' }),
    });
    assert.equal(newExportRes.status, 200);
    const newExport = (await newExportRes.json()) as { jobId: string; status: string };
    assert.ok(newExport.jobId);
    assert.equal(newExport.status, 'rendering');

    const reconciledEvent = env.published.find(
      (entry) =>
        entry.channel === `om:job:${staleJobId}` &&
        (entry.payload as { state?: string; errorCode?: string })?.state === 'failed',
    );
    assert.ok(reconciledEvent, 'reconciling an orphaned render must publish a terminal job event on jobChannel');
    assert.equal((reconciledEvent.payload as { errorCode?: string }).errorCode, 'EXPORT_WORKER_LOST');
    assert.equal(
      (reconciledEvent.payload as { errorMessage?: string }).errorMessage,
      'Render worker disconnected before finishing the export.',
    );

    const afterReconcile = (await (await env.studioApp.request(`/api/projects/${created.projectId}/renders`)).json()) as {
      renders: Array<{ id: string; status: string; workerActive?: boolean }>;
    };
    assert.equal(afterReconcile.renders.find((r) => r.id === staleJobId)?.status, 'failed');
    assert.equal(afterReconcile.renders.find((r) => r.id === staleJobId)?.workerActive, false);
  });

  it('notifies an open /progress SSE subscriber immediately when another request reconciles an orphaned render', async () => {
    const env = createStudioTestEnv({ renderProgressKeepaliveMs: 60_000 });
    const created = await env.workspace.createProject(env.auth, {
      title: 'Orphan Reconcile PubSub Project',
      initialFiles: [{ path: 'index.html', content: '<html><body>hi</body></html>' }],
    });

    const staleJobId = randomUUID();
    const staleIso = new Date(Date.now() - 120_000).toISOString();
    env.pgClient.seed('jobs', {
      id: staleJobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'export_render',
      state: 'running',
      stage: 'rendering',
      progress: 50,
      worker_id: 'render-1',
      input_payload: { outputName: 'stale-live.mp4' },
      deleted_at: null,
      created_at: staleIso,
      updated_at: staleIso,
    });

    // Open SSE while render-1 is still alive so the stream subscribes to jobChannel.
    const progressRes = await env.studioApp.request(`/api/render/${staleJobId}/progress`);
    assert.equal(progressRes.status, 200);
    assert.ok(progressRes.body);
    const reader = progressRes.body.getReader();
    const decoder = new TextDecoder();
    const readChunkWithTimeout = async (timeoutMs = 3_000) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for reconciled SSE event')), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      let received = '';
      while (!received.includes('"status":"rendering"')) {
        const chunk = await readChunkWithTimeout();
        assert.equal(chunk.done, false);
        received += decoder.decode(chunk.value, { stream: true });
      }

      // Wait until the SSE handler finishes subscribing and its post-subscribe liveness check
      // by confirming a live pubsub progress update flows through the open stream.
      const subDeadline = Date.now() + 2_000;
      while ((await env.eventBus.publish(`om:job:${staleJobId}`, {
        jobId: staleJobId,
        workspaceId: env.auth.workspaceId,
        projectId: created.projectId,
        kind: 'export_render',
        state: 'running',
        stage: 'rendering',
        progress: 55,
        ts: Date.now(),
      })) === 0) {
        assert.ok(Date.now() < subDeadline, 'Timed out waiting for SSE handler to subscribe to jobChannel');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      while (!received.includes('"progress":55')) {
        const chunk = await readChunkWithTimeout();
        assert.equal(chunk.done, false);
        received += decoder.decode(chunk.value, { stream: true });
      }
      // Yield a tick so the post-subscribe recheck completes while render-1 is still healthy.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Now render-1 disappears and another tab starts a new export, triggering orphan reconciliation.
      env.workerHealth.length = 0;
      const reExportRes = await env.studioApp.request(`/api/projects/${created.projectId}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'mp4', fps: 30, quality: 'standard' }),
      });
      assert.equal(reExportRes.status, 200);

      // The open subscriber must receive the terminal failed event and close immediately (well before 60s keepalive).
      let closed = false;
      const deadline = Date.now() + 3_000;
      while (!closed) {
        const remaining = deadline - Date.now();
        assert.ok(remaining > 0, `SSE stream did not close on orphan reconciliation (received: ${received})`);
        const chunk = await readChunkWithTimeout(remaining);
        if (chunk.value) received += decoder.decode(chunk.value, { stream: true });
        closed = chunk.done;
      }
      received += decoder.decode();
      assert.ok(received.includes('"status":"failed"'), `Expected failed event, got: ${received}`);
      assert.ok(
        received.includes('Render worker disconnected before finishing the export.'),
        `Expected EXPORT_WORKER_LOST message, got: ${received}`,
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it('keeps a running export active across /renders, /render, and /cancel while its owning worker is draining', async () => {
    const env = createStudioTestEnv();
    const created = await env.workspace.createProject(env.auth, {
      title: 'Draining Worker Export Project',
      initialFiles: [{ path: 'index.html', content: '<html><body>hi</body></html>' }],
    });

    const drainingJobId = randomUUID();
    const oldIso = new Date(Date.now() - 120_000).toISOString();
    env.pgClient.seed('jobs', {
      id: drainingJobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'export_render',
      state: 'running',
      stage: 'rendering',
      progress: 65,
      worker_id: 'render-1',
      input_payload: { outputName: 'draining-render.mp4' },
      deleted_at: null,
      created_at: oldIso,
      updated_at: oldIso,
    });
    env.workerHealth[0] = {
      ...env.workerHealth[0],
      activeJobs: 1,
      draining: true,
      updatedAt: Date.now(),
    };

    // 1. /renders keeps reporting rendering + workerActive: true while the draining worker still pulses.
    const listRes = await env.studioApp.request(`/api/projects/${created.projectId}/renders`);
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as {
      renders: Array<{ id: string; status: string; workerActive?: boolean }>;
    };
    assert.equal(listBody.renders[0]?.id, drainingJobId);
    assert.equal(listBody.renders[0]?.status, 'rendering');
    assert.equal(listBody.renders[0]?.workerActive, true);

    // 2. Starting a duplicate export is still blocked (409 EXPORT_BUSY) even after >60s because the worker is alive.
    const dupRes = await env.studioApp.request(`/api/projects/${created.projectId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'mp4', fps: 30, quality: 'standard' }),
    });
    assert.equal(dupRes.status, 409);

    // 3. Cancel stays cooperative ('cancelling') instead of finalizing prematurely while the draining worker is live.
    const cancelRes = await env.studioApp.request(`/api/render/${drainingJobId}/cancel`, { method: 'POST' });
    assert.equal(cancelRes.status, 200);
    const cancelBody = (await cancelRes.json()) as { status: string; state: string; workerActive?: boolean };
    assert.equal(cancelBody.state, 'cancelling');
    assert.equal(cancelBody.status, 'cancelling');
    assert.equal(cancelBody.workerActive, true);

    // 4. A queued job stays pending/rendering (never downgraded to 'unknown') even when only draining or zero workers report health.
    const queuedProject = await env.workspace.createProject(env.auth, {
      title: 'Queued While No Active Worker Project',
      initialFiles: [{ path: 'index.html', content: '<html><body>hi</body></html>' }],
    });
    const queuedJobId = randomUUID();
    env.pgClient.seed('jobs', {
      id: queuedJobId,
      workspace_id: env.auth.workspaceId,
      project_id: queuedProject.projectId,
      kind: 'export_render',
      state: 'queued',
      stage: 'queued',
      progress: 0,
      worker_id: null,
      input_payload: { outputName: 'queued.mp4' },
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const onlyDrainingList = (await (
      await env.studioApp.request(`/api/projects/${queuedProject.projectId}/renders`)
    ).json()) as { renders: Array<{ id: string; status: string; state: string; workerActive?: boolean }> };
    assert.equal(onlyDrainingList.renders[0]?.status, 'rendering');
    assert.equal(onlyDrainingList.renders[0]?.state, 'queued');
    assert.equal(onlyDrainingList.renders[0]?.workerActive, undefined);

    env.workerHealth.length = 0;
    const noWorkerQueuedList = (await (
      await env.studioApp.request(`/api/projects/${queuedProject.projectId}/renders`)
    ).json()) as { renders: Array<{ id: string; status: string; state: string; workerActive?: boolean }> };
    assert.equal(noWorkerQueuedList.renders[0]?.status, 'rendering');
    assert.equal(noWorkerQueuedList.renders[0]?.state, 'queued');
    assert.equal(noWorkerQueuedList.renders[0]?.workerActive, undefined);

    // Queued export still holds the active-export slot consistently and keeps its progress stream open until cancelled/completed.
    const queuedBusyRes = await env.studioApp.request(`/api/projects/${queuedProject.projectId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'mp4', fps: 30, quality: 'standard' }),
    });
    assert.equal(queuedBusyRes.status, 409);

    const queuedStreamRes = await env.studioApp.request(`/api/render/${queuedJobId}/progress`);
    assert.equal(queuedStreamRes.status, 200);
    assert.ok(queuedStreamRes.body);
    const queuedReader = queuedStreamRes.body.getReader();
    const queuedDecoder = new TextDecoder();
    try {
      const firstChunk = await queuedReader.read();
      assert.equal(firstChunk.done, false);
      const firstText = queuedDecoder.decode(firstChunk.value, { stream: true });
      assert.ok(firstText.includes('"status":"rendering"'));
      assert.ok(firstText.includes('"state":"queued"'));
      assert.equal(firstText.includes('"status":"unknown"'), false);

      // Cancelling the queued job publishes 'cancelled' and closes the open stream cleanly.
      const cancelQueuedRes = await env.studioApp.request(`/api/render/${queuedJobId}/cancel`, { method: 'POST' });
      assert.equal(cancelQueuedRes.status, 200);
      let rest = '';
      for (;;) {
        const chunk = await queuedReader.read();
        if (chunk.value) rest += queuedDecoder.decode(chunk.value, { stream: true });
        if (chunk.done) break;
      }
      assert.ok(rest.includes('"status":"cancelled"'));
    } finally {
      await queuedReader.cancel().catch(() => {});
    }
  });

  it('re-evaluates worker liveness on an open /progress SSE stream and closes with status: unknown when the worker disappears', async () => {
    const env = createStudioTestEnv({ renderProgressKeepaliveMs: 25 });
    const created = await env.workspace.createProject(env.auth, {
      title: 'Open Progress Stream Liveness Project',
      initialFiles: [{ path: 'index.html', content: '<html><body>hi</body></html>' }],
    });

    const jobId = randomUUID();
    env.pgClient.seed('jobs', {
      id: jobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'export_render',
      state: 'running',
      stage: 'rendering',
      progress: 33,
      worker_id: 'render-1',
      input_payload: { outputName: 'live-stream.mp4' },
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = await env.studioApp.request(`/api/render/${jobId}/progress`);
    assert.equal(res.status, 200);
    assert.ok(res.body);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const readChunkWithTimeout = async (timeoutMs = 3_000) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for SSE chunk')), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      // 1. Initial replay reports active rendering.
      let received = '';
      while (!received.includes('"status":"rendering"')) {
        const chunk = await readChunkWithTimeout();
        assert.equal(chunk.done, false, 'SSE stream closed prematurely before initial progress event');
        received += decoder.decode(chunk.value, { stream: true });
      }
      assert.ok(received.includes('"workerActive":true'));

      // 2. While the owning worker is draining, keepalive ticks keep the stream open.
      env.workerHealth[0] = {
        ...env.workerHealth[0],
        activeJobs: 1,
        draining: true,
        updatedAt: Date.now(),
      };
      while (!received.includes(': keepalive')) {
        const chunk = await readChunkWithTimeout();
        assert.equal(chunk.done, false, 'SSE stream closed unexpectedly while draining worker was still alive');
        received += decoder.decode(chunk.value, { stream: true });
      }
      assert.equal(received.includes('"status":"unknown"'), false);

      // 3. Owning worker disappears (OOM kill / hard crash) without publishing any job event or updating PG.
      env.workerHealth.length = 0;
      let closed = false;
      const deadline = Date.now() + 3_000;
      while (!closed) {
        const remaining = deadline - Date.now();
        assert.ok(remaining > 0, `SSE stream did not close after worker disappeared (received: ${received})`);
        const chunk = await readChunkWithTimeout(remaining);
        if (chunk.value) {
          received += decoder.decode(chunk.value, { stream: true });
        }
        closed = chunk.done;
      }
      received += decoder.decode();
      assert.ok(received.includes('"status":"unknown"'), `Expected unknown event before close, got: ${received}`);
      assert.ok(received.includes('"workerActive":false'), `Expected workerActive:false before close, got: ${received}`);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it('preserves web_upload source and filters stale media_ingest jobs from pendingImports', async () => {
    const env = createStudioTestEnv();
    const created = await env.workspace.createProject(env.auth, {
      title: 'Pending Imports Hygiene Project',
      initialFiles: [{ path: 'index.html', content: '<html><body>hi</body></html>' }],
    });

    const freshWebJobId = randomUUID();
    const staleWebJobId = randomUUID();
    env.pgClient.seed('jobs', {
      id: freshWebJobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'media_ingest',
      state: 'running',
      stage: 'probing',
      progress: 35,
      input_payload: {
        operation: 'upload_commit',
        source: 'web_upload',
        name: 'fresh.mp4',
        targetPath: 'assets/fresh.mp4',
      },
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const staleIso = new Date(Date.now() - 20 * 60_000).toISOString();
    env.pgClient.seed('jobs', {
      id: staleWebJobId,
      workspace_id: env.auth.workspaceId,
      project_id: created.projectId,
      kind: 'media_ingest',
      state: 'running',
      stage: 'probing',
      progress: 10,
      input_payload: {
        operation: 'upload_commit',
        source: 'web_upload',
        name: 'abandoned.mp4',
        targetPath: 'assets/abandoned.mp4',
      },
      deleted_at: null,
      created_at: staleIso,
      updated_at: staleIso,
    });

    const projRes = await env.studioApp.request(`/api/projects/${created.projectId}`);
    assert.equal(projRes.status, 200);
    const projBody = (await projRes.json()) as {
      pendingImports?: Array<{ id: string; source: string; filename: string }>;
    };
    const pending = projBody.pendingImports ?? [];
    assert.equal(pending.find((item) => item.id === freshWebJobId)?.source, 'web_upload');
    assert.equal(pending.find((item) => item.id === staleWebJobId), undefined);
  });
});
