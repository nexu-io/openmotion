import { applyProjectEdit } from '../../packages/edit-core/commands.ts';
import { TEXT_PATCH_BASE_HEADER } from '../../shared/text-patch.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { phase1Tools } from '../../shared/phase1-tools.ts';
import {
  InMemoryAuthCache,
  InMemoryAuthStore,
  SESSION_COOKIE_NAME,
  createBrowserSession,
  createPat,
} from '../../src/auth/index.ts';
import {
  resolvePreviewTokenSecret,
  signPreviewToken,
  verifyPreviewToken,
} from '../../src/auth/preview-token.ts';
import { DEFAULT_PAT_SCOPES, type AuthContext } from '../../src/contracts/auth.ts';
import { CloudError } from '../../src/contracts/errors.ts';
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
import {
  createApiApp,
  resolveApiCorsAllowedOrigins,
  type ApiEventBusPort,
  type ApiQueuesPort,
  type CreateApiAppDeps,
} from '../../src/entrypoints/api.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import { createLogger } from '../../src/infra/logger.ts';
import { InMemoryMcpSessionStore } from '../../src/mcp/index.ts';
import { MockModelGateway } from '../../src/services/mock-model-adapter.ts';
import { ProjectArchiveService } from '../../src/services/project-archive-service.ts';
import type { WelcomeBootstrapService } from '../../src/services/welcome-bootstrap.ts';
import { processMediaGenerateJob } from '../../src/workers/media-generate.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SILENT_LOGGER = createLogger({ level: 'error' });

// ---------------------------------------------------------------------------
// Deterministic In-Memory Drizzle PG + S3 + Redis + BullMQ Test Harness
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const UUID_TABLES = new Set([
  'workspaces',
  'sessions',
  'projects',
  'work_rounds',
  'project_versions',
  'project_history_entries',
  'assets',
  'asset_versions',
  'upload_tickets',
  'jobs',
]);

class ApiTestPgClient {
  readonly tables = new Map<string, Row[]>();
  private snap: Map<string, Row[]> | null = null;

  constructor() {
    for (const table of [
      'workspaces',
      'sessions',
      'session_messages',
      'projects',
      'project_grants',
      'work_rounds',
      'project_files',
      'project_versions',
      'project_version_files',
      'project_history_entries',
      'workspace_blobs',
      'catalog_templates',
      'catalog_template_files',
      'assets',
      'asset_versions',
      'upload_tickets',
      'jobs',
      'idempotency_receipts',
    ]) {
      this.tables.set(table, []);
    }
  }

  seed(table: string, row: Row): void {
    this.tables.get(table)!.push({ ...row });
  }

  rows(table: string): Row[] {
    return this.tables.get(table)!;
  }

  async query(
    config: string | { text: string; rowMode?: string },
    params: unknown[] = [],
  ): Promise<{ rows: unknown[] }> {
    const sqlText = (typeof config === 'string' ? config : config.text).trim();
    const rowMode = typeof config === 'string' ? undefined : config.rowMode;
    const upper = sqlText.toUpperCase();

    if (upper === 'SELECT 1') {
      return { rows: [rowMode === 'array' ? [1] : { '?column?': 1 }] };
    }
    if (upper === 'BEGIN' || upper.startsWith('BEGIN ')) {
      this.snap = new Map(
        [...this.tables.entries()].map(([k, v]) => [k, v.map((r) => structuredClone(r))]),
      );
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
    throw new Error(`Unsupported SQL in ApiTestPgClient: ${sqlText}`);
  }

  private select(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const cleaned = sqlText.replace(/\s+for\s+update\s*$/i, '').trim();
    const m = /^select\s+([\s\S]+?)\s+from\s+"([^"]+)"([\s\S]*)$/i.exec(cleaned);
    if (!m) throw new Error(`Unsupported SELECT: ${sqlText}`);
    const selectList = m[1].trim();
    const table = m[2];
    let rem = m[3].trim();
    let limit: number | null = null;
    let offset = 0;
    let order = '';
    let where = '';

    const offM = /\s+offset\s+(\$\d+|\d+)\s*$/i.exec(rem);
    if (offM) {
      offset = offM[1].startsWith('$') ? Number(params[Number(offM[1].slice(1)) - 1]) : Number(offM[1]);
      rem = rem.slice(0, offM.index).trim();
    }
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
      if (offset > 0) combined = combined.slice(offset);
      if (limit !== null) combined = combined.slice(0, limit);
      const specs = splitTop(selectList, ',').map(qualifiedCol);
      const out = combined.map((rowMap) =>
        rowMode === 'array'
          ? specs.map((s) => (s.table ? rowMap.get(s.table)?.[s.col] : rowMap.get(table)?.[s.col]) ?? null)
          : Object.fromEntries(
              specs.map((s) => [s.col, (s.table ? rowMap.get(s.table)?.[s.col] : rowMap.get(table)?.[s.col]) ?? null]),
            ),
      );
      return { rows: out };
    }

    let matched = this.rows(table).filter((r) => (where ? evalW(r, where, params) : true));
    if (/^COALESCE\s*\(\s*MAX\s*\(/i.test(selectList)) {
      const col = /MAX\s*\(\s*"([^"]+)"\s*\)/i.exec(selectList)![1];
      const maxVal = matched.reduce((acc, r) => Math.max(acc, Number(r[col] ?? 0)), 0);
      return { rows: [rowMode === 'array' ? [maxVal] : { maxVal }] };
    }
    if (/^count\s*\(/i.test(selectList)) {
      return { rows: [rowMode === 'array' ? [matched.length] : { count: matched.length }] };
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
    if (offset > 0) matched = matched.slice(offset);
    if (limit !== null) matched = matched.slice(0, limit);
    const cols = splitTop(selectList, ',').map(colName);
    return { rows: fmtRows(matched, cols, rowMode) };
  }

  private insert(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const confM = /\s+on\s+conflict\s*\(([^)]+)\)\s+do\s+(nothing|update\s+set\s+([\s\S]+))$/i.exec(noRet);
    const target = confM ? splitTop(confM[1], ',').map(colName) : null;
    const doNothing = Boolean(confM && confM[2].toLowerCase() === 'nothing');
    let setC = '';
    let whereC = '';
    if (confM && confM[3]) {
      const idx = findKw(confM[3].trim(), 'where');
      setC = idx >= 0 ? confM[3].trim().slice(0, idx).trim() : confM[3].trim();
      whereC = idx >= 0 ? confM[3].trim().slice(idx + 5).trim() : '';
    }
    const base = confM ? noRet.slice(0, confM.index).trim() : noRet;
    const hM = /^insert\s+into\s+"([^"]+)"\s*\(([^)]+)\)\s+values\s+([\s\S]+)$/i.exec(base);
    if (!hM) throw new Error(`Unsupported INSERT: ${sqlText}`);
    const table = hM[1];
    const cols = splitTop(hM[2], ',').map(colName);
    const tuples = splitTuples(hM[3].trim());
    const rows = this.rows(table);
    const out: Row[] = [];

    for (const tuple of tuples) {
      const exprs = splitTop(tuple, ',');
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
          if (doNothing) continue;
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
    const m = /^update\s+"([^"]+)"\s+set\s+([\s\S]+)$/i.exec(noRet);
    if (!m) throw new Error(`Unsupported UPDATE: ${sqlText}`);
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
    const m = /^delete\s+from\s+"([^"]+)"(?:\s+where\s+([\s\S]+))?$/i.exec(noRet);
    if (!m) throw new Error(`Unsupported DELETE: ${sqlText}`);
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
      else if (
        d === 0 &&
        lo.slice(i, i + kw.length) === kw &&
        (i === 0 || /\s/.test(input[i - 1])) &&
        (i + kw.length === input.length || /\s/.test(input[i + kw.length]))
      ) return i;
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
      else if (
        d === 0 &&
        lo.slice(i, i + 3) === 'and' &&
        i > 0 && /\s/.test(expr[i - 1]) &&
        i + 3 < expr.length && /\s/.test(expr[i + 3])
      ) {
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
  if ((m = /^([\s\S]+?)\s*>=\s*([\s\S]+)$/.exec(term))) return sortVal(row[colName(m[1])]) >= sortVal(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*>\s*([\s\S]+)$/.exec(term))) return sortVal(row[colName(m[1])]) > sortVal(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*<\s*([\s\S]+)$/.exec(term))) return sortVal(row[colName(m[1])]) < sortVal(evalSc(m[2], params));
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
function sortVal(v: unknown): string | number {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
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

class InMemoryStorage implements StoragePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async putObject(key: string, body: Buffer | Uint8Array | Readable | string, contentType: string): Promise<void> {
    let buf: Buffer;
    if (Buffer.isBuffer(body)) {
      buf = Buffer.from(body);
    } else if (typeof body === 'string') {
      buf = Buffer.from(body, 'utf8');
    } else if (body instanceof Uint8Array) {
      buf = Buffer.from(body);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      buf = Buffer.concat(chunks);
    }
    this.objects.set(key, { body: buf, contentType });
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    if (this.objects.has(key)) return { uploaded: false };
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(found.body);
  }

  async getObjectStream(key: string): Promise<ObjectStreamResult> {
    const buf = await this.getObjectBuffer(key);
    return { stream: Readable.from([buf]), contentLength: buf.byteLength };
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    const sha = createHash('sha256').update(found.body).digest('hex');
    return {
      contentLength: found.body.byteLength,
      contentType: found.contentType,
      etag: `"${sha}"`,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        count++;
      }
    }
    return count;
  }

  async presignPut(key: string, _opts: PresignPutOptions): Promise<string> {
    return `https://s3.local.test/${encodeURIComponent(key)}?sig=put`;
  }

  async presignGet(key: string, opts?: PresignGetOptions): Promise<string> {
    const query = opts?.responseContentType
      ? `&ct=${encodeURIComponent(opts.responseContentType)}`
      : '';
    return `https://s3.local.test/${encodeURIComponent(key)}?sig=get${query}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

class InMemoryEventBus implements ApiEventBusPort {
  readonly published: Array<{ channel: string; payload: unknown }> = [];
  workersHealth: RenderWorkerHealth[] = [
    {
      workerId: 'render-worker-1',
      ffmpeg: true,
      ffprobe: true,
      chromium: true,
      concurrency: 2,
      activeJobs: 0,
      updatedAt: Date.now(),
    },
  ];
  healthy = true;
  private readonly channels = new Map<string, Set<(payload: unknown, ch: string) => void>>();

  async publish(channel: string, payload: unknown): Promise<number> {
    this.published.push({ channel, payload });
    const listeners = this.channels.get(channel);
    if (!listeners) return 0;
    for (const listener of listeners) listener(payload, channel);
    return listeners.size;
  }

  async subscribe(
    channel: string,
    listener: (payload: unknown, channel: string) => void,
  ): Promise<() => Promise<void>> {
    let bucket = this.channels.get(channel);
    if (!bucket) {
      bucket = new Set();
      this.channels.set(channel, bucket);
    }
    bucket.add(listener);
    return async () => {
      bucket?.delete(listener);
    };
  }

  async getRenderWorkersHealth(): Promise<RenderWorkerHealth[]> {
    return this.workersHealth;
  }

  async checkHealth(): Promise<boolean> {
    return this.healthy;
  }
}

function createFakeQueues(): { queues: ApiQueuesPort; enqueued: Array<{ queue: string; payload: unknown }> } {
  const enqueued: Array<{ queue: string; payload: unknown }> = [];
  const fakeQueue = {
    async getJob() {
      return null;
    },
  };
  const queues = {
    renderExport: fakeQueue as unknown as ApiQueuesPort['renderExport'],
    async enqueueMediaIngest(payload: unknown) {
      enqueued.push({ queue: 'media-ingest', payload });
      return { id: randomUUID() } as never;
    },
    async enqueueMediaGenerate(_name: string, payload: unknown) {
      enqueued.push({ queue: 'media-generate', payload });
      return { id: randomUUID() } as never;
    },
    async enqueueRenderExport(payload: unknown) {
      enqueued.push({ queue: 'render-export', payload });
      return { id: randomUUID() } as never;
    },
  } as unknown as ApiQueuesPort;
  return { queues, enqueued };
}

function makeConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'dev',
    DEV_PAT: 'om_pat_devlocal_123456789012345678901234',
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud-client',
    OIDC_CLIENT_SECRET: 'ephemeral-test-client-secret',
    SESSION_SECRET: '0'.repeat(32),
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  });
}

function createApiFixture(overrides: {
  config?: Record<string, string | undefined>;
  deps?: Partial<CreateApiAppDeps>;
} = {}) {
  const config = makeConfig(overrides.config);
  const pgClient = new ApiTestPgClient();
  const db = drizzle({ client: pgClient as never, schema }) as unknown as Database;
  const storage = new InMemoryStorage();
  const eventBus = new InMemoryEventBus();
  const { queues, enqueued } = createFakeQueues();
  const authStore = new InMemoryAuthStore();
  const authCache = new InMemoryAuthCache();
  const gateway = new MockModelGateway();
  const mcpSessionStore = new InMemoryMcpSessionStore();

  // Seed default workspace row in PG for services that query `workspaces` directly.
  pgClient.seed('workspaces', {
    id: config.DEV_WORKSPACE_ID,
    slug: 'dev-workspace',
    name: 'Local Dev Workspace',
    owner_user_id: config.DEV_USER_ID,
    active_project_id: null,
    default_models: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const welcomeCalls: string[] = [];
  let welcomeThrowNotFound = false;
  const fakeWelcomeBootstrap = {
    async ensureWelcomeProject(auth: AuthContext) {
      welcomeCalls.push(auth.workspaceId);
      if (welcomeThrowNotFound) {
        throw new CloudError('NOT_FOUND', 'Welcome template not synced', { status: 404, applied: false });
      }
      return { created: false, projectId: '00000000-0000-4000-8000-000000000099' };
    },
  } as unknown as WelcomeBootstrapService;

  const { app, services } = createApiApp({
    config,
    db,
    storage,
    queues,
    eventBus,
    authStore,
    authCache,
    gateway,
    mcpSessionStore,
    welcomeBootstrap: fakeWelcomeBootstrap,
    logger: SILENT_LOGGER,
    runtimeRoot: REPO_ROOT,
    ...overrides.deps,
  });

  return {
    app,
    services,
    db,
    queues,
    gateway,
    config,
    pgClient,
    storage,
    eventBus,
    enqueued,
    authStore,
    authCache,
    welcomeCalls,
    setWelcomeThrowNotFound(value: boolean) {
      welcomeThrowNotFound = value;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated Health Probes
// ---------------------------------------------------------------------------

describe('Cloud media generation and library save', () => {
  for (const failFirstSave of [false, true]) {
    it(failFirstSave ? 'OPEND-5749 retries a failed CAS save without resubmitting or duplicating assets' : 'commits one asset for one successful model submission', async (t) => {
      const { app, db, queues, gateway, config, pgClient, storage, eventBus } = createApiFixture();
      const enqueue = t.mock.method(queues, 'enqueueMediaGenerate');
      const submitTask = t.mock.method(gateway, 'submitTask');
      const pollTask = t.mock.method(gateway, 'pollTask');
      if (failFirstSave) {
        t.mock.method(storage, 'putBlobIfAbsent', async () => {
          throw new Error('Injected CAS write failure');
        }, { times: 1 });
      }
      const worker = {
        db, storage, eventBus, gateway, logger: SILENT_LOGGER, workerId: 'media-test',
        generateThumbnailBuffer: async () => null,
      };
      const submitted = await app.request('/motion-api/models/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modality: 'image', model: 'opendesign:mock-image-1', prompt: 'Yellow flower',
          requestId: 'generate-image-1',
        }),
      });
      assert.equal(submitted.status, 202);
      const { job: { id: jobId } } = await submitted.json();
      const payload = { jobId, workspaceId: config.DEV_WORKSPACE_ID };
      assert.deepEqual(enqueue.mock.calls[0].arguments.slice(0, 2), ['generate_media', payload]);
      const initial = processMediaGenerateJob(worker, 'generate_media', payload);

      if (failFirstSave) {
        await assert.rejects(initial, /Injected CAS write failure/);
        const status = await app.request(`/motion-api/models/jobs/${jobId}`);
        assert.equal(status.status, 200);
        const { job } = await status.json();
        assert.equal(job.state, 'failed');
        assert.equal(job.savePending, true);
        assert.equal(job.failureStage, 'saving');
        assert.equal(job.remoteId, pollTask.mock.calls[0].arguments[1].remoteTaskId);
        assert.equal(pgClient.rows('assets').length, 0);
        assert.equal(pgClient.rows('asset_versions').length, 0);

        const initialClaimToken = String(pgClient.rows('jobs').find((row) => row.id === jobId)?.claim_token ?? 'init');
        const firstRetry = await app.request('/motion-api/phase1/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openmotion_assets_use',
            arguments: { action: 'retry_save', jobId, requestId: 'retry-image-save-1' },
          }),
        });
        const firstRetryBody = await firstRetry.text();
        assert.equal(firstRetry.status, 200, firstRetryBody);
        const { job: queuedRetry } = JSON.parse(firstRetryBody);
        assert.equal(queuedRetry.state, 'queued');
        assert.equal(queuedRetry.phase, 'saving');
        assert.equal(queuedRetry.savePending, true);

        // Replaying the exact same requestId while queued is idempotent and uses the same BullMQ jobId
        // (also recovers if an API process crashed between PG update and Redis enqueue).
        const replaySameRequest = await app.request('/motion-api/phase1/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openmotion_assets_use',
            arguments: { action: 'retry_save', jobId, requestId: 'retry-image-save-1' },
          }),
        });
        assert.equal(replaySameRequest.status, 200);
        assert.deepEqual(enqueue.mock.calls[1].arguments, [
          'retry_save_generation',
          payload,
          { jobId: `${jobId}__retry_save__${initialClaimToken}__retry-image-save-1` },
        ]);
        assert.deepEqual(enqueue.mock.calls[2].arguments, enqueue.mock.calls[1].arguments);

        // Concurrent retry with a different requestId while already queued must reject with 409 and not enqueue.
        const secondRetry = await app.request('/motion-api/phase1/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openmotion_assets_use',
            arguments: { action: 'retry_save', jobId, requestId: 'retry-image-save-2' },
          }),
        });
        assert.equal(secondRetry.status, 409);
        assert.equal(enqueue.mock.callCount(), 3);

        // Even if two workers race on the same queued retry, atomic claim fencing commits exactly once.
        const results = await Promise.all([
          processMediaGenerateJob(worker, 'retry_save_generation', payload),
          processMediaGenerateJob(worker, 'retry_save_generation', payload),
        ]);
        assert.equal(results.filter((result) => result.state === 'completed').length, 1);
        assert.equal(results.filter((result) => result.skipped).length, 1);
        assert.equal(pollTask.mock.calls[1].arguments[1].remoteTaskId, job.remoteId);
      } else {
        assert.equal((await initial).state, 'completed');
      }

      assert.equal(submitTask.mock.callCount(), 1);
      assert.equal(pollTask.mock.callCount(), failFirstSave ? 2 : 1);
      const completed = await app.request(`/motion-api/models/jobs/${jobId}`);
      assert.equal(completed.status, 200);
      const { job } = await completed.json();
      assert.equal(job.state, 'completed');
      assert.equal(job.savePending, false);
      assert.equal(job.failureStage, undefined);
      assert.equal(job.errorCode, undefined);
      assert.equal(job.libraryAssets.length, 1);
      assert.deepEqual(pgClient.rows('assets').map((asset) => asset.id), [job.libraryAssets[0].assetId]);
      assert.deepEqual(pgClient.rows('asset_versions').map((version) => version.id), [job.libraryAssets[0].versionId]);
      const [blob] = pgClient.rows('workspace_blobs');
      assert.equal(blob.ref_count, 1);
      assert.equal(storage.objects.has(String(blob.s3_key)), true);
    });
  }

  it('cancelling a queued retry_save marks it cancelled and prevents worker pickup from saving an asset', async (t) => {
    const { app, db, queues, gateway, config, pgClient, storage, eventBus } = createApiFixture();
    const enqueue = t.mock.method(queues, 'enqueueMediaGenerate');
    t.mock.method(storage, 'putBlobIfAbsent', async () => {
      throw new Error('Injected CAS write failure');
    }, { times: 1 });
    const worker = {
      db, storage, eventBus, gateway, logger: SILENT_LOGGER, workerId: 'media-test',
      generateThumbnailBuffer: async () => null,
    };

    const submitted = await app.request('/motion-api/models/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modality: 'image', model: 'opendesign:mock-image-1', prompt: 'Blue iris',
        requestId: 'generate-cancel-queued-retry',
      }),
    });
    assert.equal(submitted.status, 202);
    const { job: { id: jobId } } = await submitted.json();
    const payload = { jobId, workspaceId: config.DEV_WORKSPACE_ID };
    await assert.rejects(processMediaGenerateJob(worker, 'generate_media', payload), /Injected CAS write failure/);

    const retried = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: 'retry-before-cancel' },
      }),
    });
    assert.equal(retried.status, 200);
    const claimToken = String(pgClient.rows('jobs').find((row) => row.id === jobId)?.claim_token ?? 'init');
    assert.equal(enqueue.mock.calls[1].arguments[2]?.jobId, `${jobId}__retry_save__${claimToken}__retry-before-cancel`);

    const cancelled = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'cancel', jobId },
      }),
    });
    assert.equal(cancelled.status, 200);
    const { job: cancelledJob } = await cancelled.json();
    assert.equal(cancelledJob.state, 'cancelled');
    assert.equal(cancelledJob.savePending, false);

    const workerResult = await processMediaGenerateJob(worker, 'retry_save_generation', payload);
    assert.equal(workerResult.skipped, true);
    assert.equal(pgClient.rows('assets').length, 0);
    assert.equal(pgClient.rows('asset_versions').length, 0);
  });

  it('finalizes cancelling retry_save cleanly to cancelled if Redis cancel notification is missed and CAS fails', async (t) => {
    const { app, db, gateway, config, pgClient, storage, eventBus } = createApiFixture();
    const publishedEvents: Array<Record<string, unknown>> = [];
    const origPublish = eventBus.publish.bind(eventBus);
    let dropCancelPub = false;
    t.mock.method(eventBus, 'publish', async (channel: string, payload: unknown) => {
      if (dropCancelPub && channel.startsWith('om:cancel:')) {
        return 0;
      }
      if (channel.startsWith('om:job:') && payload && typeof payload === 'object') {
        publishedEvents.push(payload as Record<string, unknown>);
      }
      return origPublish(channel, payload);
    });

    let casAttempts = 0;
    t.mock.method(storage, 'putBlobIfAbsent', async () => {
      casAttempts += 1;
      if (casAttempts === 1) {
        throw new Error('First CAS write failure');
      }
      // Simulate API transitioning the running retry to cancelling while Redis notification is dropped.
      dropCancelPub = true;
      const cancelRes = await app.request('/motion-api/phase1/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'openmotion_assets_use',
          arguments: { action: 'cancel', jobId },
        }),
      });
      assert.equal(cancelRes.status, 200);
      const { job: cancellingJob } = await cancelRes.json();
      assert.equal(cancellingJob.state, 'cancelling');
      throw new Error('Second CAS write failure after cancel');
    });

    const worker = {
      db, storage, eventBus, gateway, logger: SILENT_LOGGER, workerId: 'media-test',
      generateThumbnailBuffer: async () => null,
    };

    const submitted = await app.request('/motion-api/models/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modality: 'image', model: 'opendesign:mock-image-1', prompt: 'Silver fern',
        requestId: 'generate-cancel-missed-redis',
      }),
    });
    assert.equal(submitted.status, 202);
    const { job: { id: jobId } } = await submitted.json();
    const payload = { jobId, workspaceId: config.DEV_WORKSPACE_ID };
    await assert.rejects(processMediaGenerateJob(worker, 'generate_media', payload), /First CAS write failure/);

    const retried = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: 'retry-cancelling-cas' },
      }),
    });
    assert.equal(retried.status, 200);
    publishedEvents.length = 0;

    const retryResult = await processMediaGenerateJob(worker, 'retry_save_generation', payload);
    assert.equal(retryResult.state, 'cancelled');

    const status = await app.request(`/motion-api/models/jobs/${jobId}`);
    assert.equal(status.status, 200);
    const { job: finalJob } = await status.json();
    assert.equal(finalJob.state, 'cancelled');
    assert.equal(finalJob.savePending, false);
    assert.equal(publishedEvents.some((evt) => evt.state === 'failed'), false);
    assert.equal(publishedEvents.some((evt) => evt.state === 'cancelled'), true);
    assert.equal(pgClient.rows('assets').length, 0);

    const retryAfterCancel = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: 'retry-after-cancel' },
      }),
    });
    assert.equal(retryAfterCancel.status, 409);
  });

  it('uses distinct caller requestIds for sequential retry_save attempts without millisecond collisions', async (t) => {
    const { app, db, queues, gateway, config, pgClient, storage, eventBus } = createApiFixture();
    const enqueue = t.mock.method(queues, 'enqueueMediaGenerate');
    const submitTask = t.mock.method(gateway, 'submitTask');
    let casFailures = 0;
    const origPut = storage.putBlobIfAbsent.bind(storage);
    t.mock.method(storage, 'putBlobIfAbsent', async (...args: Parameters<typeof origPut>) => {
      if (casFailures < 2) {
        casFailures += 1;
        throw new Error(`CAS failure #${casFailures}`);
      }
      return origPut(...args);
    });
    const worker = {
      db, storage, eventBus, gateway, logger: SILENT_LOGGER, workerId: 'media-test',
      generateThumbnailBuffer: async () => null,
    };

    const submitted = await app.request('/motion-api/models/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modality: 'image', model: 'opendesign:mock-image-1', prompt: 'Red maple',
        requestId: 'generate-two-retries',
      }),
    });
    const { job: { id: jobId } } = await submitted.json();
    const payload = { jobId, workspaceId: config.DEV_WORKSPACE_ID };
    await assert.rejects(processMediaGenerateJob(worker, 'generate_media', payload), /CAS failure #1/);

    const claim1 = String(pgClient.rows('jobs').find((row) => row.id === jobId)?.claim_token ?? 'init');
    const retry1 = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: `save-${jobId}` },
      }),
    });
    assert.equal(retry1.status, 200);
    await assert.rejects(processMediaGenerateJob(worker, 'retry_save_generation', payload), /CAS failure #2/);

    // Reusing the same Studio requestId (`save-${jobId}`) after a second failure gets a fresh BullMQ jobId
    // via the new claimToken epoch, so it cannot be silently dropped while the previous BullMQ job finishes.
    const claim2 = String(pgClient.rows('jobs').find((row) => row.id === jobId)?.claim_token ?? 'init');
    assert.notEqual(claim2, claim1);
    const retry2 = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: `save-${jobId}` },
      }),
    });
    assert.equal(retry2.status, 200);
    assert.equal(enqueue.mock.calls[1].arguments[2]?.jobId, `${jobId}__retry_save__${claim1}__save-${jobId}`);
    assert.equal(enqueue.mock.calls[2].arguments[2]?.jobId, `${jobId}__retry_save__${claim2}__save-${jobId}`);

    const finalRes = await processMediaGenerateJob(worker, 'retry_save_generation', payload);
    assert.equal(finalRes.state, 'completed');
    assert.equal(submitTask.mock.callCount(), 1);
    assert.equal(pgClient.rows('assets').length, 1);
  });

  it('does not overwrite a pending cancellation when an upstream poll returns failed', async (t) => {
    const { app, db, gateway, config, pgClient, storage, eventBus } = createApiFixture();
    const publishedEvents: Array<Record<string, unknown>> = [];
    const origPublish = eventBus.publish.bind(eventBus);
    let dropCancelPub = false;
    t.mock.method(eventBus, 'publish', async (channel: string, payload: unknown) => {
      if (dropCancelPub && channel.startsWith('om:cancel:')) {
        return 0;
      }
      if (channel.startsWith('om:job:') && payload && typeof payload === 'object') {
        publishedEvents.push(payload as Record<string, unknown>);
      }
      return origPublish(channel, payload);
    });
    const origPoll = gateway.pollTask.bind(gateway);
    let pollCalls = 0;
    t.mock.method(gateway, 'pollTask', async (...args: Parameters<typeof origPoll>) => {
      pollCalls += 1;
      if (pollCalls === 1) return origPoll(...args);
      dropCancelPub = true;
      const cancelRes = await app.request('/motion-api/phase1/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'openmotion_assets_use',
          arguments: { action: 'cancel', jobId },
        }),
      });
      assert.equal(cancelRes.status, 200);
      return {
        remoteTaskId: args[1].remoteTaskId,
        status: 'failed' as const,
        error: { code: 'UPSTREAM_ERR', message: 'Upstream failed after cancel' },
      };
    });
    t.mock.method(storage, 'putBlobIfAbsent', async () => {
      throw new Error('First CAS write failure');
    }, { times: 1 });
    const worker = {
      db, storage, eventBus, gateway, logger: SILENT_LOGGER, workerId: 'media-test',
      generateThumbnailBuffer: async () => null,
    };

    const submitted = await app.request('/motion-api/models/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modality: 'image', model: 'opendesign:mock-image-1', prompt: 'Snow pine',
        requestId: 'generate-poll-fail-cancel-race',
      }),
    });
    const { job: { id: jobId } } = await submitted.json();
    const payload = { jobId, workspaceId: config.DEV_WORKSPACE_ID };
    await assert.rejects(processMediaGenerateJob(worker, 'generate_media', payload), /First CAS write failure/);

    const retried = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: 'retry-poll-cancel' },
      }),
    });
    assert.equal(retried.status, 200);
    publishedEvents.length = 0;

    const result = await processMediaGenerateJob(worker, 'retry_save_generation', payload);
    assert.equal(result.state, 'cancelled');
    const status = await app.request(`/motion-api/models/jobs/${jobId}`);
    const { job: finalJob } = await status.json();
    assert.equal(finalJob.state, 'cancelled');
    assert.equal(finalJob.savePending, false);
    assert.equal(publishedEvents.some((evt) => evt.state === 'failed'), false);
    assert.equal(publishedEvents.some((evt) => evt.state === 'cancelled'), true);
    assert.equal(pgClient.rows('assets').length, 0);
  });

  it('rolls back retry_save to failed with savePending=true when enqueueMediaGenerate rejects once', async (t) => {
    const { app, db, gateway, config, storage, eventBus, queues } = createApiFixture();
    t.mock.method(storage, 'putBlobIfAbsent', async () => {
      throw new Error('Transient CAS failure');
    }, { times: 1 });
    const worker = {
      db, storage, eventBus, gateway, logger: SILENT_LOGGER, workerId: 'media-test',
      generateThumbnailBuffer: async () => null,
    };

    const submitted = await app.request('/motion-api/models/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modality: 'image', model: 'opendesign:mock-image-1', prompt: 'Cedar lantern',
        requestId: 'generate-enqueue-rollback',
      }),
    });
    assert.equal(submitted.status, 202);
    const { job: { id: jobId } } = await submitted.json();
    const payload = { jobId, workspaceId: config.DEV_WORKSPACE_ID };
    await assert.rejects(processMediaGenerateJob(worker, 'generate_media', payload), /Transient CAS failure/);

    const origEnqueue = queues.enqueueMediaGenerate.bind(queues);
    t.mock.method(queues, 'enqueueMediaGenerate', async (...args: Parameters<typeof origEnqueue>) => {
      throw new Error('Redis queue down');
    }, { times: 1 });

    const failedEnqueue = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: 'retry-enqueue-fails' },
      }),
    });
    assert.equal(failedEnqueue.status, 500);

    const statusAfterRollback = await app.request(`/motion-api/models/jobs/${jobId}`);
    assert.equal(statusAfterRollback.status, 200);
    const { job: rolledBack } = (await statusAfterRollback.json()) as {
      job: { state: string; savePending: boolean; failureStage?: string };
    };
    assert.equal(rolledBack.state, 'failed');
    assert.equal(rolledBack.savePending, true);
    assert.equal(rolledBack.failureStage, 'saving');

    // A subsequent retry_save with a fresh requestId must succeed cleanly instead of hitting 409.
    const nextRetry = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: 'retry-enqueue-recovers' },
      }),
    });
    assert.equal(nextRetry.status, 200);
    const { job: recovered } = (await nextRetry.json()) as {
      job: { state: string; stage: string; failureStage?: string };
    };
    assert.equal(recovered.state, 'queued');
    assert.equal(recovered.stage, 'saving');
    assert.equal(recovered.failureStage, undefined);
  });

  it('returns 400 INVALID_ARGUMENT with applied=false when openmotion_media_use retry_save omits requestId', async () => {
    const { app } = createApiFixture();
    const res = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_media_use',
        arguments: { action: 'retry_save', jobId: randomUUID() },
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      code?: string;
      message?: string;
      applied?: unknown;
    };
    assert.equal(body.code, 'INVALID_ARGUMENT');
    assert.equal(body.applied, false);
    assert.match(body.message ?? '', /requestId is required for retry_save/i);
  });

  it('emits a retry_save-specific timeout hint when retry_save_generation exhausts its poll window', async (t) => {
    const { app, db, gateway, config, storage, eventBus, pgClient } = createApiFixture();
    t.mock.method(storage, 'putBlobIfAbsent', async () => {
      throw new Error('Initial CAS save failure');
    }, { times: 1 });
    const worker = {
      db, storage, eventBus, gateway, logger: SILENT_LOGGER, workerId: 'media-test',
      generateThumbnailBuffer: async () => null,
    };

    const submitted = await app.request('/motion-api/models/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modality: 'image', model: 'opendesign:mock-image-1', prompt: 'Silver lake',
        requestId: 'generate-retry-save-timeout',
      }),
    });
    assert.equal(submitted.status, 202);
    const { job: { id: jobId } } = await submitted.json();
    const payload = { jobId, workspaceId: config.DEV_WORKSPACE_ID };
    await assert.rejects(processMediaGenerateJob(worker, 'generate_media', payload), /Initial CAS save failure/);

    const retry1 = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: 'retry-save-poll-timeout-1' },
      }),
    });
    assert.equal(retry1.status, 200);

    t.mock.method(gateway, 'pollTask', async (_ctx: unknown, input: { remoteTaskId: string }) => ({
      remoteTaskId: input.remoteTaskId,
      status: 'running' as const,
    }));

    await assert.rejects(
      processMediaGenerateJob({ ...worker, pollIntervalMs: 5, maxPollMs: 15 }, 'retry_save_generation', payload),
      /use retry_save/i,
    );

    const status = await app.request(`/motion-api/models/jobs/${jobId}`);
    assert.equal(status.status, 200);
    const { job: timedOut } = (await status.json()) as {
      job: { state: string; savePending: boolean; failureStage?: string; error?: string };
    };
    const dbRow = pgClient.rows('jobs').find((row) => row.id === jobId)!;
    assert.equal(timedOut.state, 'failed');
    assert.equal(timedOut.savePending, true);
    assert.equal(timedOut.failureStage, 'saving');
    assert.match(String(timedOut.error ?? dbRow.error_message ?? ''), /retry_save/i);
    assert.doesNotMatch(String(timedOut.error ?? dbRow.error_message ?? ''), /use resume/i);

    const resumeAttempt = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'resume', jobId, requestId: 'resume-after-retry-save-timeout' },
      }),
    });
    assert.equal(resumeAttempt.status, 409);

    const retry2 = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'retry_save', jobId, requestId: 'retry-save-poll-timeout-2' },
      }),
    });
    assert.equal(retry2.status, 200);
  });
});

it('logs registered project read/write routes without recording request paths or query strings', async () => {
  const lines: string[] = [];
  const logger = createLogger({ sink: (_, line) => lines.push(line) });
  const { app } = createApiFixture({ deps: { logger } });
  const prefix = '/api/projects/00000000-0000-4000-8000-000000000099/';
  for (const [method, suffix, expected] of [
    ['GET', 'file-source?path=private-name.html', 'file-source'],
    ['GET', 'files/private-name.html', 'files/*'],
    ['POST', 'text-edits', 'text-edits'],
    ['POST', 'text-edits/batch', 'text-edits/batch'],
    ['GET', 'preview/private-name.html', null],
  ] as const) {
    const res = await app.request(prefix + suffix, { method });
    const record = lines.map(line => JSON.parse(line)).filter(log => log.msg === 'HTTP request completed').at(-1);
    assert.equal(record.path, expected ? '/api/projects/:id/' + expected : '[REDACTED]');
    assert.equal(record.status, res.status);
    assert.equal(record.method, method);
    assert.equal(typeof record.durationMs, 'number');
    assert.ok(!JSON.stringify(record).includes('private-name'));
  }
});

describe('Cloud API Entrypoint — Health Probes', () => {
  it('serves /api/health/live (200), /api/health/ready (200 healthy, 503 degraded), and /api/health', async () => {
    let pgOk = true;
    let redisOk = true;
    let s3Ok = true;

    const { app } = createApiFixture({
      config: { AUTH_MODE: 'oidc' },
      deps: {
        checkDbHealth: async () => pgOk,
        checkRedisHealth: async () => redisOk,
        checkStorageHealth: async () => s3Ok,
      },
    });

    const liveRes = await app.request('/api/health/live');
    assert.equal(liveRes.status, 200);
    const live = (await liveRes.json()) as { ok: boolean; status: string; service: string };
    assert.equal(live.ok, true);
    assert.equal(live.status, 'live');
    assert.equal(live.service, 'api');

    const readyRes = await app.request('/api/health/ready');
    assert.equal(readyRes.status, 200);
    const ready = (await readyRes.json()) as {
      ok: boolean;
      status: string;
      checks: { postgres: boolean; redis: boolean; storage: boolean };
    };
    assert.equal(ready.ok, true);
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.checks, { postgres: true, redis: true, storage: true });

    const healthRes = await app.request('/api/health');
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      mcp: { protocol: number; tools: string[] };
    };
    assert.equal(health.ok, true);
    assert.equal(health.mcp.protocol, 1);
    assert.equal(health.mcp.tools.length, 22);

    // Degrade Redis -> /api/health/ready must return 503 while /api/health/live stays 200.
    redisOk = false;
    const degradedRes = await app.request('/api/health/ready');
    assert.equal(degradedRes.status, 503);
    const degraded = (await degradedRes.json()) as {
      ok: boolean;
      status: string;
      checks: { postgres: boolean; redis: boolean; storage: boolean };
    };
    assert.equal(degraded.ok, false);
    assert.equal(degraded.status, 'not_ready');
    assert.deepEqual(degraded.checks, { postgres: true, redis: false, storage: true });

    const stillLive = await app.request('/api/health/live');
    assert.equal(stillLive.status, 200);

    // Degrade Postgres and S3 as well.
    pgOk = false;
    s3Ok = false;
    const allDown = await app.request('/api/health/ready');
    assert.equal(allDown.status, 503);
  });

  it('keeps dependency error details out of the public readiness body', async () => {
    const { app } = createApiFixture({
      config: { AUTH_MODE: 'oidc' },
      deps: {
        checkDbHealth: async () => {
          throw new Error('connect ECONNREFUSED 10.1.2.3:5432 (user=openmotion password=hunter2)');
        },
        checkRedisHealth: async () => {
          throw new Error('connect ECONNREFUSED redis.internal:6379');
        },
        checkStorageHealth: async () => false,
      },
    });

    for (const path of ['/api/health/ready', '/api/health', '/motion-api/health']) {
      const response = await app.request(path);
      assert.equal(response.status, 503, `${path} must still report the degraded state`);
      const body = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(body.checks, { postgres: false, redis: false, storage: false });
      assert.equal('errors' in body, false, `${path} must not expose a dependency error list`);
      const serialized = JSON.stringify(body);
      assert.doesNotMatch(serialized, /10\.1\.2\.3|redis\.internal|hunter2|ECONNREFUSED/, path);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Dual-Mode Auth, OAuth 2.1 Discovery, Bearer-Only /mcp & Welcome Bootstrap
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Auth Isolation & First-Access Welcome Bootstrap', () => {
  it('enforces AUTH_MODE=oidc on protected APIs, rejects browser cookie on /mcp, and accepts PAT Bearer', async () => {
    const fixture = createApiFixture({ config: { AUTH_MODE: 'oidc' } });
    const { app, authStore, pgClient } = fixture;

    // Unauthenticated API requests -> 401
    for (const url of [
      '/motion-api/projects',
      '/api/projects',
      `/api/media-jobs/${randomUUID()}/progress`,
      '/motion-api/models',
      '/motion-api/models/defaults',
      '/motion-api/account/summary',
      '/motion-api/integration',
      `/motion-api/project-archives/${randomUUID()}/file`,
    ]) {
      const res = await app.request(url);
      assert.equal(res.status, 401, `expected 401 for unauthenticated ${url}`);
    }

    // Public read-only model catalog & status for guest parameter preview (no defaults or billing leaked)
    const publicCatalogRes = await app.request('/motion-api/models/catalog');
    assert.equal(publicCatalogRes.status, 200);
    const publicCatalog = (await publicCatalogRes.json()) as {
      defaults?: Record<string, unknown>;
      models?: Array<{ modality?: string }>;
    };
    assert.deepEqual(publicCatalog.defaults, {});
    assert.ok(Array.isArray(publicCatalog.models) && publicCatalog.models.length > 0);
    assert.ok(publicCatalog.models.some((m) => m.modality === 'image'));
    assert.ok(publicCatalog.models.some((m) => m.modality === 'video'));
    assert.ok(publicCatalog.models.some((m) => m.modality === 'audio'));

    const publicStatusRes = await app.request('/motion-api/models/status');
    assert.equal(publicStatusRes.status, 200);
    const publicStatus = (await publicStatusRes.json()) as {
      providers?: Array<Record<string, unknown>>;
    };
    assert.ok(Array.isArray(publicStatus.providers) && publicStatus.providers.length >= 1);
    assert.equal('plan' in publicStatus.providers[0]!, false);
    assert.equal('hasBalance' in publicStatus.providers[0]!, false);

    // Public read-only cloud MCP discovery, install guide & connect routes work without authentication (no workspaceId leaked)
    const publicIntegrationRes = await app.request('/connect/integration');
    assert.equal(publicIntegrationRes.status, 200);
    const publicIntegration = (await publicIntegrationRes.json()) as {
      workspaceId?: string;
      dataDirectory?: string;
      transport?: { type?: string; url?: string };
    };
    assert.equal(publicIntegration.workspaceId, undefined);
    assert.equal(publicIntegration.dataDirectory, '');
    assert.equal(publicIntegration.transport?.type, 'streamable-http');
    assert.equal(publicIntegration.transport?.url, 'https://motion.example.test/mcp');

    const publicGuideAgentRes = await app.request('/connect/guide?host=mcp');
    assert.equal(publicGuideAgentRes.status, 200);
    assert.match(publicGuideAgentRes.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.match(publicGuideAgentRes.headers.get('vary') ?? '', /\bAccept\b/i);
    const publicGuideAgentBody = await publicGuideAgentRes.text();
    assert.ok(publicGuideAgentBody.includes('https://motion.example.test/mcp'));
    assert.ok(publicGuideAgentBody.includes('Mode B (task-driven handoff)'));

    const publicGuideBrowserRes = await app.request('/connect/guide?host=codex', {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(publicGuideBrowserRes.status, 302);
    assert.equal(publicGuideBrowserRes.headers.get('location'), '/mcp-setup?host=codex');
    assert.match(publicGuideBrowserRes.headers.get('vary') ?? '', /\bAccept\b/i);
    assert.equal(publicGuideBrowserRes.headers.get('cache-control'), 'no-store');

    const publicConfigRes = await app.request('/connect/config?host=codex');
    assert.equal(publicConfigRes.status, 200);
    assert.match(await publicConfigRes.text(), /https:\/\/motion\.example\.test\/mcp/);

    // Unauthenticated /mcp distinguishes Agent instructions from human setup help.
    const unauthMcpRes = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(unauthMcpRes.status, 401);
    const unauthMcpBody = (await unauthMcpRes.json()) as {
      authGuidance?: {
        preferred?: string; installGuideUrl?: string; installGuideAudience?: string;
        connectPageUrl?: string; postAuthorizationInstructions?: string;
      };
    };
    assert.equal(unauthMcpBody.authGuidance?.preferred, 'oauth2.1');
    assert.equal(unauthMcpBody.authGuidance?.installGuideUrl, 'https://motion.example.test/install.md');
    assert.equal(unauthMcpBody.authGuidance?.installGuideAudience, 'agent');
    assert.equal(unauthMcpBody.authGuidance?.connectPageUrl, 'https://motion.example.test/mcp-setup');
    assert.match(unauthMcpBody.authGuidance?.postAuthorizationInstructions ?? '', /a new chat in this client/);
    assert.doesNotMatch(unauthMcpBody.authGuidance?.postAuthorizationInstructions ?? '', /\bCodex\b/);

    // OAuth 2.1 discovery endpoints are public
    const prmRes = await app.request('/.well-known/oauth-protected-resource');
    assert.equal(prmRes.status, 200);
    const prm = (await prmRes.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, 'https://motion.example.test/mcp');
    assert.ok(prm.authorization_servers.length >= 1);

    const asMetaRes = await app.request('/.well-known/oauth-authorization-server');
    assert.equal(asMetaRes.status, 200);

    // Provision an OIDC user + workspace
    const userId = randomUUID();
    const workspaceId = randomUUID();
    authStore.seedWorkspace({
      workspaceId,
      userId,
      oidcSub: 'oidc-sub-integration-1',
      email: 'creator@example.test',
      displayName: 'Creator One',
      role: 'owner',
      slug: 'creator-ws',
      name: 'Creator Workspace',
    });
    pgClient.seed('workspaces', {
      id: workspaceId,
      slug: 'creator-ws',
      name: 'Creator Workspace',
      owner_user_id: userId,
      active_project_id: null,
      default_models: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Browser session cookie works on product & Studio APIs
    const browserSession = await createBrowserSession(authStore, { userId, workspaceId });
    const projectsRes = await app.request('/motion-api/projects', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` },
    });
    assert.equal(projectsRes.status, 200);

    // First-access welcome bootstrap ran exactly once for workspaceId and cached for subsequent requests
    assert.deepEqual(fixture.welcomeCalls, [workspaceId]);
    const secondRes = await app.request('/motion-api/account/summary', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` },
    });
    assert.equal(secondRes.status, 200);
    assert.deepEqual(fixture.welcomeCalls, [workspaceId]);

    // Browser cookie is STRICTLY REJECTED on /mcp (RFC 9728 Bearer challenge)
    const mcpCookieRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(mcpCookieRes.status, 401);
    assert.match(
      mcpCookieRes.headers.get('www-authenticate') ?? '',
      /Bearer\s+resource_metadata="https:\/\/motion\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
    );

    // PAT Bearer token succeeds on /mcp AND /motion-api/projects
    const ownerAuth: AuthContext = {
      workspaceId,
      userId,
      role: 'owner',
      scopes: [...DEFAULT_PAT_SCOPES],
      authMode: 'oidc',
      authMethod: 'session_cookie',
    };
    const writeOnly = await createPat(authStore, ownerAuth, { name: 'Write only', scopes: ['projects:write'] });
    for (const resource of ['projects', 'sessions']) {
      const restricted = await app.request(`/motion-api/${resource}/${randomUUID()}/open?view=editor`, {
        method: 'POST', headers: { Authorization: `Bearer ${writeOnly.token}` },
      });
      assert.equal(restricted.status, 403);
      assert.equal((await restricted.json()).code, 'INSUFFICIENT_SCOPE');
    }
    const createdPat = await createPat(authStore, ownerAuth, {
      name: 'Integration Test PAT',
      scopes: [...DEFAULT_PAT_SCOPES],
    });

    const mcpPatRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createdPat.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(mcpPatRes.status, 200);
    assert.ok(mcpPatRes.headers.get('mcp-session-id'));
  });

  it('survives unsynced welcome template (NOT_FOUND) gracefully during AUTH_MODE=dev workspace access', async () => {
    const fixture = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    fixture.setWelcomeThrowNotFound(true);

    const res = await fixture.app.request('/motion-api/projects');
    assert.equal(res.status, 200);
    assert.equal(fixture.welcomeCalls.length, 1);

    // Since welcome template was not synced, it was NOT cached as bootstrapped.
    fixture.setWelcomeThrowNotFound(false);
    const res2 = await fixture.app.request('/motion-api/projects');
    assert.equal(res2.status, 200);
    assert.equal(fixture.welcomeCalls.length, 2);

    // Once bootstrapped, subsequent requests hit the in-memory cache.
    const res3 = await fixture.app.request('/motion-api/projects');
    assert.equal(res3.status, 200);
    assert.equal(fixture.welcomeCalls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-End Wired Product + Diskless Studio + Streamable HTTP /mcp
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — End-to-End Product, Studio & Streamable HTTP /mcp', () => {
  it('creates a project, edits via /mcp, reads via Diskless Studio, and enforces MCP limits & P2 codes', async () => {
    const { app, config, pgClient } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const mcpHeaders = {
      Authorization: `Bearer ${config.DEV_PAT}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    // 1. Create a project via /motion-api/projects
    const createRes = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cloud API E2E Video' }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      projectId: string;
      title: string;
      revision: string;
      versionId: string;
    };
    const projectId = created.projectId;
    assert.ok(projectId);
    assert.equal(created.title, 'Cloud API E2E Video');
    assert.ok(created.revision);
    assert.ok(created.versionId);

    // 2. Verify Diskless Studio sees the project and serves index.html with ETag
    const studioListRes = await app.request('/api/projects');
    assert.equal(studioListRes.status, 200);
    const studioList = (await studioListRes.json()) as { projects: Array<{ id: string }> };
    assert.ok(studioList.projects.some((p) => p.id === projectId));

    const indexRes = await app.request(`/api/projects/${projectId}/files/index.html`);
    assert.equal(indexRes.status, 200);
    assert.ok(indexRes.headers.get('etag'));
    const indexHtml = await indexRes.text();
    assert.match(indexHtml, /<html/i);

    // 3. Initialize Streamable HTTP MCP session
    const initRes = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'api-e2e-client', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Mcp-Session-Id header must be issued on initialize');

    const callMcp = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { ...mcpHeaders, 'Mcp-Session-Id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      assert.equal(res.status, 200, `MCP ${method} expected 200, got ${res.status}`);
      return (await res.json()) as {
        jsonrpc: string;
        id: number;
        result?: Record<string, unknown>;
        error?: { code: number; message: string };
      };
    };

    // 4. tools/list must advertise all 22 registered domain openmotion_* tools
    const listPayload = await callMcp(2, 'tools/list');
    const tools = (listPayload.result?.tools ?? []) as Array<{
      name: string;
      description: string;
      inputSchema: { properties: { action?: { enum: string[] }; sourcePath?: unknown } };
    }>;
    assert.equal(tools.length, phase1Tools.length);
    assert.equal(tools.length, 22);
    const archiveTool = tools.find(tool => tool.name === 'openmotion_project_archive');
    assert.ok(archiveTool);
    assert.deepEqual(archiveTool.inputSchema.properties.action?.enum, ['export']);
    assert.equal(archiveTool.inputSchema.properties.sourcePath, undefined);
    assert.doesNotMatch(archiveTool.description, /sourcePath|local ZIP path/);
    assert.ok(archiveTool.description.includes(`POST ${config.APP_PUBLIC_ORIGIN}/motion-api/project-archives/import`));
    assert.match(archiveTool.description, /projects:write/);
    assert.match(archiveTool.description, /projects:read/);

    const legacyArchive = await callMcp(21, 'tools/call', {
      name: 'openmotion_project_archive',
      arguments: { action: 'import', requestId: 'archive-legacy', sourcePath: '/tmp/project.zip' },
    });
    assert.equal(legacyArchive.result?.isError, true);
    const legacyError = (legacyArchive.result?.structuredContent as {
      error: { status: number; details: { legacyCode: string } };
    }).error;
    assert.equal(legacyError.status, 400);
    assert.equal(legacyError.details.legacyCode, 'LOCAL_PATH_UNSUPPORTED_IN_CLOUD');
    assert.ok(JSON.stringify(legacyArchive.result).includes(`POST ${config.APP_PUBLIC_ORIGIN}/motion-api/project-archives/import`));
    const transcriptGuide = tools.find(tool => tool.name === 'openmotion_assets_use')?.description;
    assert.ok(transcriptGuide);
    assert.match(transcriptGuide, /Cloud ASR submit\/status is unavailable/);
    assert.match(transcriptGuide, /your own execution environment[\s\S]+ffmpeg[\s\S]+speech-to-text[\s\S]+caption_add/);

    // MCP discovery returns the whole index, including entries beyond Studio's page limit.
    const templateIds = Array.from({ length: 501 }, (_, i) => `mcp-template-${i}`);
    for (const [sortOrder, id] of templateIds.entries()) {
      pgClient.seed('catalog_templates', {
        id, kind: 'builtin', sort_order: sortOrder, catalog_version: 'mcp-e2e',
        metadata: { title: id }, updated_at: new Date().toISOString(),
      });
    }
    const catalog = await callMcp(20, 'tools/call', { name: 'openmotion_list_templates', arguments: {} });
    assert.equal(catalog.result?.isError, undefined);
    const index = catalog.result?.structuredContent as {
      catalogVersion: string; total: number; templates: Array<{ id: string }>;
    };
    assert.equal(index.catalogVersion, 'mcp-e2e');
    assert.equal(index.total, templateIds.length);
    assert.deepEqual(index.templates.map(template => template.id), templateIds);

    // 5. openmotion_get_project (without projectId) lists workspace projects including our created one
    const listProjectsRes = await callMcp(3, 'tools/call', {
      name: 'openmotion_get_project',
      arguments: {},
    });
    assert.equal(listProjectsRes.result?.isError, undefined);
    const listStructured = listProjectsRes.result?.structuredContent as {
      projects: Array<{ projectId?: string; id?: string }>;
    };
    assert.ok(listStructured.projects.some((p) => (p.projectId ?? p.id) === projectId));

    // 6. openmotion_edit_project writes notes.txt and advances revision
    const editRes = await callMcp(4, 'tools/call', {
      name: 'openmotion_edit_project',
      arguments: {
        projectId,
        requestId: 'req-e2e-edit-1',
        expectedRevision: created.revision,
        expectedVersionId: created.versionId,
        summary: 'Add integration test notes',
        files: [{ path: 'notes.txt', content: 'Hello from cloud MCP' }],
      },
    });
    assert.equal(editRes.result?.isError, undefined);
    const editStructured = editRes.result?.structuredContent as {
      revision: string;
      version: { versionId: string; versionNumber: number };
    };
    assert.notEqual(editStructured.revision, created.revision);
    assert.ok(editStructured.version.versionNumber >= 2);

    // 6b. Regression: openmotion_edit_project MUST enforce optimistic locking on assetNames-only edits
    const staleRevAssetNames = await callMcp(41, 'tools/call', {
      name: 'openmotion_edit_project',
      arguments: {
        projectId,
        requestId: 'req-e2e-asset-names-stale-rev',
        expectedRevision: '0'.repeat(64),
        expectedVersionId: editStructured.version.versionId,
        assetNames: [{ path: 'assets/hero.png', name: 'Hero Frame' }],
      },
    });
    assert.equal(staleRevAssetNames.result?.isError, true);
    assert.equal(
      (staleRevAssetNames.result?.structuredContent as { error: { code: string } }).error.code,
      'VERSION_CONFLICT',
    );

    const staleVerAssetNames = await callMcp(42, 'tools/call', {
      name: 'openmotion_edit_project',
      arguments: {
        projectId,
        requestId: 'req-e2e-asset-names-stale-ver',
        expectedRevision: editStructured.revision,
        expectedVersionId: randomUUID(),
        assetNames: [{ path: 'assets/hero.png', name: 'Hero Frame' }],
      },
    });
    assert.equal(staleVerAssetNames.result?.isError, true);
    assert.equal(
      (staleVerAssetNames.result?.structuredContent as { error: { code: string } }).error.code,
      'VERSION_CONFLICT',
    );

    const validAssetNames = await callMcp(43, 'tools/call', {
      name: 'openmotion_edit_project',
      arguments: {
        projectId,
        requestId: 'req-e2e-asset-names-ok',
        expectedRevision: editStructured.revision,
        expectedVersionId: editStructured.version.versionId,
        assetNames: [{ path: 'assets/hero.png', name: 'Hero Frame' }],
      },
    });
    assert.equal(validAssetNames.result?.isError, undefined);
    const assetNamesStructured = validAssetNames.result?.structuredContent as { revision: string };
    assert.notEqual(assetNamesStructured.revision, editStructured.revision);

    // 7. openmotion_get_project reads back notes.txt written via MCP
    const readRes = await callMcp(5, 'tools/call', {
      name: 'openmotion_get_project',
      arguments: { projectId, file: { path: 'notes.txt' } },
    });
    assert.equal(readRes.result?.isError, undefined);
    const readStructured = readRes.result?.structuredContent as {
      file?: { content?: string };
      content?: string;
    };
    assert.equal(readStructured.file?.content ?? readStructured.content, 'Hello from cloud MCP');

    // 8. openmotion_media_use(models) returns MockModelGateway models
    const mediaModels = await callMcp(6, 'tools/call', {
      name: 'openmotion_media_use',
      arguments: { action: 'models' },
    });
    assert.equal(mediaModels.result?.isError, undefined);
    const mediaStructured = mediaModels.result?.structuredContent as {
      provider: string;
      models: unknown[];
    };
    assert.equal(mediaStructured.provider, 'opendesign');
    assert.ok(Array.isArray(mediaStructured.models) && mediaStructured.models.length > 0);

    // 9. openmotion_list_skills & openmotion_open_preview(templates)
    const skillsRes = await callMcp(7, 'tools/call', {
      name: 'openmotion_list_skills',
      arguments: {},
    });
    assert.equal(skillsRes.result?.isError, undefined);

    const previewRes = await callMcp(8, 'tools/call', {
      name: 'openmotion_open_preview',
      arguments: { target: 'templates' },
    });
    assert.equal(previewRes.result?.isError, undefined);
    const previewStructured = previewRes.result?.structuredContent as {
      url?: string;
      previewUrl?: string;
    };
    assert.ok(
      (previewStructured.url ?? previewStructured.previewUrl ?? '').startsWith(
        'https://motion.example.test/',
      ),
    );

    // 9b. openmotion_open_preview(providers) aligns with CLOUD_P1_FEATURES.modelProviders gate
    const providersPreviewRes = await callMcp(801, 'tools/call', {
      name: 'openmotion_open_preview',
      arguments: { target: 'providers', entry: 'agent_media_upgrade_free' },
    });
    assert.equal(providersPreviewRes.result?.isError, undefined);
    const providersPreview = providersPreviewRes.result?.structuredContent as {
      previewUrl: string;
      previewHandoff: { previewUrl: string; instructions: string };
    };
    const providersPreviewUrl = new URL(providersPreview.previewUrl);
    assert.equal(providersPreview.previewHandoff.previewUrl, providersPreview.previewUrl);
    assert.equal(providersPreviewUrl.pathname, '/settings/models');
    assert.equal(providersPreviewUrl.searchParams.get('entry_from'), 'agent_media_upgrade_free');
    assert.equal(providersPreviewUrl.searchParams.get('embed'), '1');
    assert.equal(providersPreviewUrl.searchParams.get('provider'), null);
    assert.match(providersPreview.previewHandoff.instructions, /Verify that Default models is visible/);
    assert.match(providersPreview.previewHandoff.instructions, /Settings > Account/);
    assert.match(providersPreview.previewHandoff.instructions, /Subscription & usage/);
    assert.doesNotMatch(providersPreview.previewHandoff.instructions, /Model providers is visible/);
    assert.doesNotMatch(providersPreview.previewHandoff.instructions, /save or replace their OpenDesign Cloud/);

    // 10. Legacy sourcePath on openmotion_import_assets -> LOCAL_PATH_UNSUPPORTED_IN_CLOUD
    const legacyImport = await callMcp(9, 'tools/call', {
      name: 'openmotion_import_assets',
      arguments: {
        projectId,
        requestId: 'req-e2e-legacy-import',
        items: [{ itemId: 'item-1', sourcePath: '/tmp/local-file.png' }],
      },
    });
    assert.equal(legacyImport.result?.isError, true);
    const legacyStructured = legacyImport.result?.structuredContent as { error: { code: string } };
    assert.equal(legacyStructured.error.code, 'LOCAL_PATH_UNSUPPORTED_IN_CLOUD');

    // 11. P2 deferred MCP tools return structured FEATURE_DEFERRED_P2
    const designRes = await callMcp(10, 'tools/call', {
      name: 'openmotion_design_project',
      arguments: { action: 'list' },
    });
    assert.equal(designRes.result?.isError, true);
    assert.equal(
      (designRes.result?.structuredContent as { error: { code: string } }).error.code,
      'FEATURE_DEFERRED_P2',
    );

    const commentsRes = await callMcp(11, 'tools/call', {
      name: 'openmotion_manage_project',
      arguments: { action: 'comments', projectId },
    });
    assert.equal(commentsRes.result?.isError, true);
    assert.equal(
      (commentsRes.result?.structuredContent as { error: { code: string } }).error.code,
      'FEATURE_DEFERRED_P2',
    );

    // 12. MCP_MAX_BODY_BYTES limit enforcement (413)
    const smallLimitFixture = createApiFixture({
      config: { AUTH_MODE: 'dev', MCP_MAX_BODY_BYTES: '1048576' },
    });
    const oversizedRes = await smallLimitFixture.app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${smallLimitFixture.config.DEV_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1_050_000) }),
    });
    assert.equal(oversizedRes.status, 413);

    // 13. DELETE /mcp tears down session cleanly
    const deleteRes = await app.request('/mcp', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${config.DEV_PAT}`,
        'Mcp-Session-Id': sessionId,
      },
    });
    assert.equal(deleteRes.status, 204);
  });
});

// ---------------------------------------------------------------------------
// 4. Models, Account, Catalog, Integration, Environment & P2 Deferred Routes
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Models, Account, Catalog, Integration & P2 Routes', () => {
  it('wires /motion-api/models, /motion-api/account, /motion-api/integration, catalog & P2 501 routes', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });

    // Models & account
    const modelsRes = await app.request('/motion-api/models');
    assert.equal(modelsRes.status, 200);
    const modelsBody = (await modelsRes.json()) as { provider: string; mode: string; models: unknown[] };
    assert.equal(modelsBody.provider, 'opendesign');
    assert.equal(modelsBody.mode, 'mock');
    assert.ok(modelsBody.models.length > 0);

    const accountRes = await app.request('/motion-api/account/summary');
    assert.equal(accountRes.status, 200);
    const account = (await accountRes.json()) as {
      authenticated: boolean;
      modelGateway: { provider: string; mode: string };
    };
    assert.equal(account.authenticated, true);
    assert.equal(account.modelGateway.provider, 'opendesign');

    // Integration & connect endpoints
    const integrationRes = await app.request('/motion-api/integration');
    assert.equal(integrationRes.status, 200);
    const integration = (await integrationRes.json()) as {
      transport?: { type?: string; url?: string };
      tools?: unknown[];
    };
    assert.equal(integration.transport?.type, 'streamable-http');
    assert.equal(integration.transport?.url, 'https://motion.example.test/mcp');
    assert.equal(integration.tools?.length, 22);

    const cfgRes = await app.request('/connect/config?host=codex');
    assert.equal(cfgRes.status, 200);
    assert.match(await cfgRes.text(), /https:\/\/motion\.example\.test\/mcp/);

    const guideRes = await app.request('/connect/guide?host=codex');
    assert.equal(guideRes.status, 200);
    assert.match(guideRes.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.match(await guideRes.text(), /https:\/\/motion\.example\.test\/mcp/);

    // Public catalog listing on BOTH /api/templates and /motion-api/templates
    const apiTemplatesRes = await app.request('/api/templates');
    assert.equal(apiTemplatesRes.status, 200);
    const motionTemplatesRes = await app.request('/motion-api/templates');
    assert.equal(motionTemplatesRes.status, 200);

    // Runtime & Diskless environment probes
    const runtimeRes = await app.request('/motion-api/runtime');
    assert.equal(runtimeRes.status, 200);
    assert.equal(((await runtimeRes.json()) as { mode: string }).mode, 'cloud-container');

    const ffmpegRes = await app.request('/api/environment/ffmpeg');
    assert.equal(ffmpegRes.status, 200);
    const ffmpeg = (await ffmpegRes.json()) as { available: boolean; workerCount?: number };
    assert.equal(ffmpeg.available, true);

    // Regression: /api/media-jobs/:jobId/progress has auth middleware wired (reaches handler -> 404, never 401)
    const mediaJobProgress = await app.request(`/api/media-jobs/${randomUUID()}/progress`);
    assert.equal(mediaJobProgress.status, 404);

    // Regression: createApiApp wires authCache into OpenDesignModelGateway when MODEL_GATEWAY_MODE=opendesign
    const cachedAuthCache = new InMemoryAuthCache();
    await cachedAuthCache.set(
      'om:gateway:models:global:anon',
      JSON.stringify([
        {
          id: 'opendesign:cached-image-1',
          provider: 'opendesign',
          modelId: 'cached-image-1',
          label: 'Cached Test Image',
          modality: 'image',
          mode: 'text-to-image',
          modes: ['text-to-image'],
          supportsImageReference: false,
          options: [],
        },
      ]),
      300,
    );
    const liveGwFixture = createApiFixture({
      config: {
        AUTH_MODE: 'dev',
        MODEL_GATEWAY_MODE: 'opendesign',
        OPENDESIGN_API_URL: 'https://api.opendesign.invalid',
        OPENDESIGN_S2S_API_KEY: 'ephemeral-test-s2s-key',
      },
      deps: {
        gateway: undefined,
        authCache: cachedAuthCache,
      },
    });
    const cachedModelsRes = await liveGwFixture.app.request('/motion-api/models');
    assert.equal(cachedModelsRes.status, 200);
    const cachedModelsBody = (await cachedModelsRes.json()) as {
      mode: string;
      models: Array<{ id: string }>;
    };
    assert.equal(cachedModelsBody.mode, 'opendesign');
    assert.deepEqual(
      cachedModelsBody.models.map((m) => m.id),
      ['opendesign:cached-image-1'],
    );

    const desktopGet = await app.request('/api/open-in-desktop');
    assert.equal(desktopGet.status, 200);
    assert.equal(((await desktopGet.json()) as { available: boolean }).available, false);

    const desktopPost = await app.request('/api/open-in-desktop', { method: 'POST' });
    assert.equal(desktopPost.status, 501);

    // Explicit P2 501 FEATURE_DEFERRED_P2 HTTP routes
    for (const [method, url] of [
      ['GET', '/motion-api/design/projects'],
      ['GET', '/motion-api/games'],
      ['GET', '/motion-api/scenarios/bundles/test/file'],
      ['POST', '/motion-api/brand-kits'],
      ['GET', '/motion-api/transcripts'],
      ['GET', '/motion-api/review-comments'],
    ] as const) {
      const res = await app.request(url, { method });
      assert.equal(res.status, 501, `expected 501 for ${method} ${url}`);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'FEATURE_DEFERRED_P2');
    }

    // Static read-only Brand Kit catalog JSON remains available (200)
    const brandCatalogRes = await app.request('/motion-api/brand-kits/catalog');
    assert.equal(brandCatalogRes.status, 200);
    const brandCatalog = (await brandCatalogRes.json()) as { entries: unknown[] };
    assert.ok(Array.isArray(brandCatalog.entries));
  });
});

// ---------------------------------------------------------------------------
// 5. Static Design System, Read-Only GSAP Vendor, Studio Runtime & SPA Fallback
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Static Assets, Read-Only GSAP & API 404 vs SPA Fallback', () => {
  it('serves design-system assets, GSAP vendor bundle, runtime.js, inline-video.html, and separates API 404 from SPA fallback', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });

    const tokensRes = await app.request('/design-system/tokens.css');
    assert.equal(tokensRes.status, 200);
    assert.match(tokensRes.headers.get('content-type') ?? '', /^text\/css/);

    const fontRes = await app.request('/web/design-system/fonts/AlbertSans-VariableFont_wght.ttf');
    assert.equal(fontRes.status, 200);
    assert.equal(fontRes.headers.get('access-control-allow-origin'), '*');

    const woff2Res = await app.request('/web/design-system/fonts/AlbertSans-VariableFont_wght.woff2');
    assert.equal(woff2Res.status, 200);
    assert.equal(woff2Res.headers.get('access-control-allow-origin'), '*');

    const runtimeJsRes = await app.request('/api/runtime.js');
    assert.equal(runtimeJsRes.status, 200);
    assert.match(runtimeJsRes.headers.get('content-type') ?? '', /javascript/);

    const gsapRes = await app.request('/api/vendor/gsap/gsap.min.js');
    assert.equal(gsapRes.status, 200);
    assert.match(gsapRes.headers.get('content-type') ?? '', /javascript/);

    const gsapVersionedPluginRes = await app.request(
      '/api/vendor/gsap/gsap@3.15.0/dist/MotionPathPlugin.min.js',
    );
    assert.equal(gsapVersionedPluginRes.status, 200);
    assert.match(gsapVersionedPluginRes.headers.get('content-type') ?? '', /javascript/);

    const gsapTraversal = await app.request('/api/vendor/gsap/%2e%2e/%2e%2e/package.json');
    assert.ok(gsapTraversal.status === 400 || gsapTraversal.status === 404);

    const gsapVersionedTraversal = await app.request(
      '/api/vendor/gsap/gsap@3.15.0/dist/%2e%2e/%2e%2e/package.json',
    );
    assert.ok(gsapVersionedTraversal.status === 400 || gsapVersionedTraversal.status === 404);

    const hfConfigRes = await app.request('/__hyperframes_config');
    assert.equal(hfConfigRes.status, 200);
    const hfConfig = (await hfConfigRes.json()) as { diskless?: boolean };
    assert.equal(hfConfig.diskless, true);

    const inlineVideoJs = await app.request('/web/inline-video.js');
    assert.equal(inlineVideoJs.status, 200);
    assert.match(inlineVideoJs.headers.get('content-type') ?? '', /javascript/);

    const finalVideoComp = await app.request('/web/final-video-component.js');
    assert.equal(finalVideoComp.status, 200);
    assert.match(finalVideoComp.headers.get('content-type') ?? '', /javascript/);

    const mcpUiFragment = await app.request('/mcp-ui/template-recommendations/inline.fragment.html');
    assert.equal(mcpUiFragment.status, 200);
    assert.match(mcpUiFragment.headers.get('content-type') ?? '', /^text\/html/);

    // Unknown API paths MUST return JSON 404 (never SPA HTML)
    for (const apiPath of ['/api/does-not-exist', '/motion-api/does-not-exist']) {
      const res = await app.request(apiPath);
      assert.equal(res.status, 404, `expected 404 for ${apiPath}`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'NOT_FOUND');
    }

    // Valid SPA client-side route serves studio/build/index.html (200) or clean 503 if unbuilt
    const spaRes = await app.request('/editor/client-route');
    const studioBuilt = existsSync(path.join(REPO_ROOT, 'studio/build/index.html'));
    assert.equal(spaRes.status, studioBuilt ? 200 : 503);
    if (studioBuilt) {
      const spaHtml = await spaRes.text();
      assert.match(spaHtml, /<link rel="preconnect" href="https:\/\/r\.open-design\.ai" crossorigin>/);
      const spaEtag = spaRes.headers.get('etag') ?? '';
      assert.match(spaEtag, /^"sha256:[a-f0-9]{64}"$/);
      const spaNotModified = await app.request('/editor/client-route', {
        headers: { 'If-None-Match': spaEtag },
      });
      assert.equal(spaNotModified.status, 304);
      assert.equal(spaNotModified.headers.get('etag'), spaEtag);

      // Unknown SPA paths and /404 return HTTP 404 with the Studio HTML shell (never 200 or 304)
      for (const unknownPath of ['/brand-kits', '/projects/client-route', '/404']) {
        const missingRes = await app.request(unknownPath, {
          headers: { 'If-None-Match': spaEtag },
        });
        assert.equal(missingRes.status, 404, `expected 404 for ${unknownPath}`);
        assert.match(missingRes.headers.get('content-type') ?? '', /^text\/html/);
        assert.equal(missingRes.headers.get('cache-control'), 'no-store');
        const missingHtml = await missingRes.text();
        assert.match(missingHtml, /<meta name="openmotion-runtime" content="cloud-diskless"/);
      }

      const isolated = createApiFixture({
        config: {
          AUTH_MODE: 'dev',
          PREVIEW_PUBLIC_ORIGIN: 'https://preview.example.test',
          PREVIEW_TOKEN_SECRET: 'test-preview-secret-0123456789abcdef',
        },
      });
      const isolatedSpa = await isolated.app.request('/explore');
      assert.equal(isolatedSpa.status, 200);
      const isolatedHtml = await isolatedSpa.text();
      assert.match(
        isolatedHtml,
        /<link rel="preconnect" href="https:\/\/preview\.example\.test" crossorigin>/,
      );
      assert.match(
        isolatedHtml,
        /<link rel="preconnect" href="https:\/\/r\.open-design\.ai" crossorigin>/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Studio UI ↔ Cloud Backend Wiring Parity Regressions (#74 / #75)
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Studio UI Wiring Parity (/preview/open, WorkspaceStatus, /phase1/call, /generations, /tracking/preferences)', () => {
  it('names writes at commit and steps one project history across Studio and the agent', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = async (url: string, body: unknown) => {
      const response = await app.request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const { projectId } = await post('/motion-api/projects', { title: 'Shared undo' });
    const base = `/api/projects/${projectId}`;
    const file = base + '/files/title.txt';
    const history = async () => (await app.request(base + '/history')).json();
    const write = async (title: string, headers: Record<string, string>) => {
      const saved = await app.request(file, { method: 'PUT', headers, body: title });
      assert.equal(saved.status, 200);
      return saved.json();
    };

    const first = await write('First title', { 'If-None-Match': '*' });
    const second = await write('New title', { 'If-Match': first.version });
    const beforeAgent = await history();
    assert.equal(beforeAgent.currentSeq, 3);
    const args = { projectId, requestId: 'save-caption', expectedRevision: second.revision,
      expectedVersionId: second.versionId, files: [{ path: 'captions.srt', content: 'Hello' }] };
    const agentEdit = () => post('/motion-api/phase1/call', { name: 'openmotion_edit_project', arguments: args });
    await agentEdit();
    assert.equal((await agentEdit()).replayed, true);
    await post(base + '/history/claim', { label: 'Late title label' });
    const afterAgent = await history();
    assert.equal(afterAgent.currentSeq, 4);
    assert.equal(afterAgent.back.label, 'Edited captions.srt');
    assert.equal(afterAgent.entries[0].who.kind, 'agent');

    const undo = await post(base + '/history/undo', { entryId: beforeAgent.back.id });
    assert.equal(undo.stepLabel, 'Edited captions.srt');
    assert.equal(undo.seq, 3);
    assert.equal((await (await app.request(file)).json()).content, 'New title');
    assert.equal((await app.request(base + '/files/captions.srt')).status, 404);
    const step = (direction: string) => post(base + '/history/step', { direction });
    assert.equal((await step('back')).seq, 2);
    assert.equal((await (await app.request(file)).json()).content, 'First title');
    assert.equal((await step('forward')).seq, 3);
    assert.equal((await step('forward')).stepLabel, 'Edited captions.srt');
    assert.equal((await (await app.request(base + '/files/captions.srt')).json()).content, 'Hello');
  });

  it('names and coalesces saves from the same Studio edit window while retaining separate gestures', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const created = await app.request('/motion-api/projects', {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({title: 'Edit windows'})});
    const {projectId} = await created.json();
    const base = '/api/projects/' + projectId;
    const save = async (text: string, window: string, label: string, version?: string) => {
      const res = await app.request(base + '/files/notes.txt', {method: 'PUT', body: text, headers: {
        'X-OpenMotion-Edit-Window': window, 'X-OpenMotion-Edit-Label': encodeURIComponent(label),
        ...(version ? {'If-Match': version} : {'If-None-Match': '*'}),
      }});
      assert.equal(res.status, 200, await res.clone().text());
      return res.json();
    };
    const window = randomUUID();
    const first = await save('one', window, 'Edit source');
    const second = await save('two', window, 'Edit source', first.version);
    assert.equal(second.versionId, first.versionId);
    const third = await save('three', randomUUID(), '移动标题', second.version);
    assert.notEqual(third.versionId, second.versionId);
    const history = await (await app.request(base + '/history')).json();
    assert.equal(history.currentSeq, 3);
    assert.equal(history.back.label, '移动标题');
    assert.equal(history.back.targetVersionId, second.versionId);
    assert.equal(history.back.targetRevision, second.revision);
    assert.equal(history.entries[1].label, 'Edit source');

    const step = (body: object, guarded = true) => app.request(base + (guarded ? '/history/step-guarded' : '/history/step'), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const guard = { expectedVersionId: third.versionId, expectedRevision: third.revision,
      expectedTargetVersionId: second.versionId, expectedTargetRevision: second.revision };
    assert.equal((await step({ direction: 'back' })).status, 400);
    assert.equal((await step({ direction: 'back', expectedRevision: third.revision })).status, 400);
    // The first two saves share an ID, but only the second revision is a valid destination.
    assert.equal((await step({ direction: 'back', ...guard, expectedTargetRevision: first.revision })).status, 409);
    assert.equal((await step({ direction: 'back', ...guard, expectedVersionId: first.versionId })).status, 409);
    const unchanged = await (await app.request(base + '/history')).json();
    assert.equal(unchanged.currentVersionId, third.versionId);
    assert.equal(unchanged.forward, null);
    const undone = await step({ direction: 'back', ...guard });
    assert.equal(undone.status, 200);
    const { navigation } = await undone.json();
    assert.equal(navigation.revision, second.revision);
    assert.equal(navigation.currentVersionId, second.versionId);
    assert.equal(navigation.forward.targetVersionId, third.versionId);
    assert.equal(navigation.forward.targetRevision, third.revision);
    const redo = { expectedVersionId: second.versionId, expectedRevision: second.revision,
      expectedTargetVersionId: third.versionId, expectedTargetRevision: third.revision };
    // A collaborator creates a different redo branch from the same starting snapshot.
    const branch = await save('peer branch', randomUUID(), 'Peer edit', second.version);
    assert.equal((await step({ direction: 'back' }, false)).status, 200);
    assert.equal((await step({ direction: 'forward', ...redo })).status, 409);
    const available = await (await app.request(base + '/history')).json();
    assert.equal(available.currentVersionId, second.versionId);
    assert.equal(available.forward.versionId, branch.versionId);
  });

  it('undoes a timeline deletion and its follow-up ripple as one named action', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const json = async (url: string, init?: RequestInit) => {
      const response = await app.request(url, init);
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const { projectId } = await json('/motion-api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Delete history' }),
    });
    const base = `/api/projects/${projectId}`;
    const file = base + '/files/scene.html';
    await json(file, { method: 'PUT', headers: { 'If-None-Match': '*' }, body:
      '<html><body><main data-composition-id="main" data-duration="6"><div id="first" data-track-index="0" data-start="0" data-duration="2"></div><div id="middle" data-track-index="0" data-start="2" data-duration="2"></div><div id="tail" data-track-index="0" data-start="4" data-duration="2"></div></main></body></html>' });
    const before = await json(file);
    const { currentSeq, revision, currentVersionId } = await json(base + '/history');
    const label = 'Delete timeline clip';
    const middle = before.content.match(/<div [^>]*id="middle"[^>]*>/)?.[0].match(/data-hf-id="([^"]+)"/)?.[1];
    assert.ok(middle);
    const deleted = await applyProjectEdit(before.content, {
      kind: 'deleteClips', hfIds: [middle], rippleTrack: 0, compositionPath: 'scene.html',
    }, new Map());
    const saved = await json(base + '/text-edits/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({operations: [{id: 'delete-and-ripple', label,
        files: [{path: 'scene.html', baseVersion: before.version, content: deleted.content}]}]}),
    });
    assert.equal(saved.committed.length, 1);
    assert.equal(saved.committed[0].parentRevision, revision);
    assert.equal(saved.committed[0].parentVersionId, currentVersionId);
    assert.equal(saved.committed[0].historySeq, currentSeq + 1);
    assert.equal(saved.committed[0].coalesced, false);
    const shrunk = (await json(file)).content;
    assert.doesNotMatch(shrunk, /id="middle"|data-start="4"/);
    assert.match(shrunk, /id="tail"/);
    const after = await json(base + '/history');
    assert.equal(after.currentSeq, currentSeq + 1);
    assert.equal(after.back.label, label);
    const step = (direction: 'back' | 'forward') => json(base + '/history/step', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }),
    });
    assert.equal((await step('back')).seq, currentSeq);
    assert.equal((await json(file)).content, before.content);
    await step('forward');
    assert.equal((await json(file)).content, shrunk);
  });

  it('reads only one MCP file, pins pages and downloads, and scopes historical bytes to that project and path', async () => {
    const { app, services, config } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = async (url: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const { projectId } = await (await post('/motion-api/projects', { title: 'Single file' })).json();
    const { projectId: other } = await (await post('/motion-api/projects', { title: 'Other files' })).json();
    const auth: AuthContext = { workspaceId: config.DEV_WORKSPACE_ID, userId: config.DEV_USER_ID, role: 'owner',
      scopes: [...DEFAULT_PAT_SCOPES], authMode: 'dev', authMethod: 'dev_bypass' };
    const path = 'notes.txt';
    const before = 'Hello 🌙\r\n原文';
    const origin = await services.files.commitChanges(auth, { projectId, source: 'agent', ops: [
      { op: 'upsert_text', path, content: before },
      { op: 'upsert_binary', path: 'assets/song.mp3', data: Buffer.from([0, 255, 111]) },
    ] });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.DEV_PAT}`, Accept: 'application/json, text/event-stream',
    };
    let rpcId = 1;
    const rpc = async (method: string, params: unknown) => post('/mcp', { jsonrpc: '2.0', id: rpcId++, method, params }, headers);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'single-file', version: '1' } });
    headers['Mcp-Session-Id'] = init.headers.get('mcp-session-id')!;
    const read = async (file: Record<string, unknown>, id = projectId) => (await (await rpc('tools/call', {
      name: 'openmotion_get_project', arguments: { projectId: id, file },
    })).json()).result;
    services.files.loadVirtualProject = async () => { throw new Error('Single file must not load the project'); };
    services.files.listFiles = async () => { throw new Error('Single file must not list the project'); };

    const first = (await read({ path, length: 5 })).structuredContent.file;
    assert.equal(first.content, 'Hello');
    assert.equal(first.nextOffset, 5);
    const snapshot = (await read({ path, mode: 'download' })).structuredContent.file;
    assert.equal(snapshot.fileVersion, first.fileVersion);
    assert.match(snapshot.downloadUrl, /^https:/);
    assert.ok(Date.parse(snapshot.expiresAt) > Date.now());

    const changed = await services.files.commitChanges(auth, { projectId, source: 'agent', ops: [
      { op: 'upsert_text', path, content: 'Changed' },
    ] });
    const second = (await read({ path, offset: first.nextOffset, atFileVersion: first.fileVersion })).structuredContent.file;
    assert.equal(first.content + second.content, before);
    assert.equal((await read({ path, atProjectVersion: origin.versionId })).structuredContent.file.content, before);
    assert.equal((await read({ path, atProjectVersion: changed.versionId })).structuredContent.file.content, 'Changed');
    assert.equal((await read({ path, atProjectVersion: changed.versionId, atFileVersion: first.fileVersion })).isError, true);
    assert.equal((await read({ path, atProjectVersion: origin.versionId }, other)).isError, true);
    assert.equal((await read({ path: 'other.txt', atFileVersion: first.fileVersion })).isError, true);

    const baseline = (await read({ path, mode: 'sync', atFileVersion: first.fileVersion })).structuredContent.file;
    assert.equal(baseline.baseline.downloadUrl, snapshot.downloadUrl);
    assert.deepEqual(baseline.patches, []);
    const unchanged = (await read({ path, mode: 'sync', fromFileVersion: baseline.fileVersion, atFileVersion: first.fileVersion })).structuredContent.file;
    assert.equal(unchanged.baseline, undefined);
    assert.deepEqual(unchanged.patches, []);
    assert.equal((await read({ path: 'assets/song.mp3' })).isError, true);
    const audio = (await read({ path: 'assets/song.mp3', mode: 'download' })).structuredContent.file;
    assert.equal(audio.bytes, 3);
    assert.match(audio.downloadUrl, /^https:/);
    assert.equal((await read({ path, mode: 'download', offset: 1 })).isError, true);
  });

  it('persists the same clip and animation through programmatic HTTP and remote MCP, once per request', async () => {
    const { app, config, services } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const { projectId } = await (await post('/motion-api/projects', { title: 'Clip move parity' })).json();
    const file = (path: string) => `/api/projects/${projectId}/files/${path}`;
    const source = '<html><body><div data-composition-id="scene" data-duration="12"><div id="title" data-hf-id="hf-title" data-start="2" data-duration="3"><span class="word"></span></div><script>const tl=gsap.timeline();tl.to("#title",{opacity:1,duration:0.5},2.25);tl.to(".word",{duration:1,keyframes:{"0%":{x:20},"100%":{x:80}}},2.5);tl.to("#other",{x:10},7);</script></div></body></html>';
    for (const path of ['ui.html', 'agent.html']) {
      const seed = await app.request(file(path), { method: 'PUT', headers: { 'If-None-Match': '*' }, body: source });
      assert.equal(seed.status, 200);
    }

    const original = await (await app.request(file('ui.html'))).json();
    const base = original.version;
    const command = { kind: 'moveClip', hfId: 'hf-title', start: 5 };
    const studio = (key: string) => post(`/api/projects/${projectId}/edits/ui.html`, command,
      { 'If-Match': base, 'Idempotency-Key': key, Authorization: 'Bearer ' + config.DEV_PAT });
    const first = await studio('drag');
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal((await (await studio('drag')).json()).version, (await first.json()).version);
    const noop = await (await studio('stale-drag')).json();
    assert.equal(noop.rebased, true);
    assert.deepEqual(noop.changedPaths, []);
    assert.equal(noop.version, (await app.request(file('ui.html'))).headers.get('etag'));
    const { content } = await (await app.request(file('ui.html'))).json();
    const synced = await app.request(file('ui.html'), { headers: { [TEXT_PATCH_BASE_HEADER]: base } });
    assert.equal(synced.headers.get('X-OpenMotion-Representation'), null);
    assert.equal((await synced.json()).content, content);
    const missed = await app.request(file('ui.html'), { headers: { [TEXT_PATCH_BASE_HEADER]: '"sha256:' + '0'.repeat(64) + '"' } });
    assert.equal((await missed.json()).content, content);
    assert.match(content, /data-start="5"/);
    assert.match(content, /duration:0.5},5.25\)/);
    assert.match(content, /"100%":\{x:80\}\}\},5\.5\)/);
    assert.match(content, /hf-hold/);
    assert.match(content, /"#other",\{x:10\},7\)/);

    const headers: Record<string, string> = { Authorization: `Bearer ${config.DEV_PAT}`, Accept: 'application/json, text/event-stream' };
    const rpc = (method: string, params: unknown) => post('/mcp', { jsonrpc: '2.0', id: 1, method, params }, headers);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'move-parity', version: '1' } });
    headers['Mcp-Session-Id'] = init.headers.get('mcp-session-id')!;
    const tool = async (name: string, args: unknown) => (await (await rpc('tools/call', { name, arguments: args })).json()).result;
    const project = (await tool('openmotion_get_project', { projectId })).structuredContent;
    const args = { projectId, requestId: 'agent-move', expectedRevision: project.revision, expectedVersionId: project.currentVersionId,
      edit: { ...command, compositionPath: 'agent.html' } };
    for (const edit of [{ ...args.edit, start: 10 }, { ...args.edit, hfId: 'missing' }]) {
      assert.equal((await tool('openmotion_edit_project', { ...args, edit })).isError, true);
    }
    const moved = await tool('openmotion_edit_project', args);
    assert.equal(moved.isError, undefined, JSON.stringify(moved));
    assert.equal((await (await app.request(file('agent.html'))).json()).content, content);
    const replay = (await tool('openmotion_edit_project', args)).structuredContent;
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.version, moved.structuredContent.version);
    assert.equal((await tool('openmotion_edit_project', { ...args, requestId: 'stale-agent' })).isError, undefined);

    // Template imports can preserve the raw HTML, while the preview stamps the
    // headline as hf-933r. Another MCP write moves the project base only.
    const introPath = 'compositions/intro.html';
    const intro = readFileSync(new URL('../../template-library/openmotion-welcome/compositions/intro.html', import.meta.url), 'utf8');
    assert.doesNotMatch(intro, /data-hf-id="hf-933r"/);
    const auth: AuthContext = { workspaceId: config.DEV_WORKSPACE_ID, userId: config.DEV_USER_ID, role: 'owner',
      scopes: [...DEFAULT_PAT_SCOPES], authMode: 'dev', authMethod: 'dev_bypass' };
    const imported = await services.files.commitChanges(auth, { projectId, source: 'studio',
      ops: [{ op: 'upsert_text', path: introPath, content: intro }] });
    const observedBase = { projectId, expectedRevision: imported.revision, expectedVersionId: imported.versionId };
    const note = await tool('openmotion_edit_project', { ...observedBase, requestId: 'separate-note',
      files: [{ path: 'qa-note.txt', content: 'Another editor wrote here' }] });
    assert.equal(note.isError, undefined);
    const headline = await tool('openmotion_edit_project', { ...observedBase, requestId: 'welcome-headline',
      edit: { kind: 'editElements', compositionPath: introPath, patches: [
        { target: { id: 'intro-headline', hfId: 'hf-933r' }, operations: [{ type: 'inline-style', property: 'color', value: 'red' }] },
      ] } });
    assert.equal(headline.isError, undefined, JSON.stringify(headline));
    assert.equal(headline.structuredContent.rebased, true);
    const updated = (await (await app.request(file(introPath))).json()).content;
    assert.match(updated.match(/<div[^>]*id="intro-headline"[^>]*>/)?.[0] ?? '', /color:\s*red/);
  });

  it('reapplies a competing audio trim to the current file and replays the original acknowledgements', async () => {
    const { app, config, services } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.DEV_PAT, ...headers }, body: JSON.stringify(body) });
    const { projectId } = await (await post('/motion-api/projects', { title: 'Concurrent audio trims' })).json();
    const base = '/api/projects/' + projectId;
    const path = 'scene.html';
    const file = base + '/files/' + path;
    const html = '<html><body><main data-composition-id="scene" data-duration="10"><span id="other"></span><span id="other"></span><audio id="singer" data-hf-id="song" src="music.mp3" data-start="0" data-duration="10"></audio></main></body></html>';
    assert.equal((await app.request(file, { method: 'PUT', headers: { 'If-None-Match': '*' }, body: html })).status, 200);
    const etag = (await app.request(file)).headers.get('etag')!;
    const edit = (requestId: string, command: unknown) => post(base + '/edits/' + path, command,
      { 'If-Match': etag, 'Idempotency-Key': requestId });
    const trim = (seconds: number) => ({ kind: 'trimClips', changes: [{ hfId: 'song', start: 0, duration: seconds }] });
    const starting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const commit = services.files.commitChanges.bind(services.files);
    let attempts = 0;
    services.files.commitChanges = async (ctx, input) => {
      if (input.requestId === 'six' && ++attempts === 1) {
        starting.resolve();
        await release.promise;
      }
      return commit(ctx, input);
    };
    const later = edit('six', trim(6));
    await starting.promise;
    let eight;
    try {
      eight = await edit('eight', trim(8));
      assert.equal(eight.status, 200);
      const color = await edit('color', { kind: 'editElements', patches: [
        { target: { hfId: 'song' }, operations: [{ type: 'inline-style', property: 'color', value: 'red' }] },
      ] });
      assert.equal(color.status, 200, await color.clone().text());
      assert.equal((await color.json()).rebased, true);
    } finally { release.resolve(); }
    const six = await later;
    assert.equal(six.status, 200, await six.clone().text());
    const ack = await six.json();
    assert.equal(attempts, 2);
    assert.equal(ack.rebased, true);
    assert.deepEqual(ack.changedPaths, [path]);
    assert.deepEqual(await (await edit('eight', trim(8))).json(), await eight.json());
    assert.deepEqual(await (await edit('six', trim(6))).json(), ack);
    assert.equal((await edit('six', trim(4))).status, 409);
    const oldSelector = await edit('selector-only', { kind: 'editElements', patches: [{
      target: { selector: 'audio', selectorIndex: 0 },
      operations: [{ type: 'inline-style', property: 'color', value: 'blue' }],
    }] });
    assert.equal(oldSelector.status, 409);
    const oldRanks = await edit('stale-ranks', { kind: 'moveClips', changes: [{ hfId: 'song', start: 0 }],
      stacking: { ranks: [{ hfId: 'song', zIndex: 3 }] } });
    assert.equal(oldRanks.status, 409);
    const ambiguous = await edit('ambiguous-id', { kind: 'editElements', patches: [{
      target: { id: 'other' }, operations: [{ type: 'inline-style', property: 'color', value: 'blue' }],
    }] });
    assert.equal(ambiguous.status, 409);
    const previousId = await edit('reused-id', { kind: 'editElements', patches: [{
      target: { hfId: 'song', id: 'other' },
      operations: [{ type: 'inline-style', property: 'color', value: 'blue' }],
    }] });
    assert.equal(previousId.status, 409);
    const final = await (await app.request(file)).json();
    const audio = final.content.match(/<audio[^>]*>/)?.[0] ?? '';
    assert.match(audio, /data-duration="6"/);
    assert.match(audio, /color:\s*red/);
    assert.equal(final.version, ack.version);
    assert.equal((await app.request(file, { method: 'PUT', headers: { 'If-Match': etag }, body: html })).status, 409);
  });

  it('creates, replays and updates beat grids over HTTP while rejecting invalid project media', async () => {
    const { app, config, pgClient } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) => app.request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.DEV_PAT, ...headers }, body: JSON.stringify(body),
    });
    const { projectId } = await (await post('/motion-api/projects', { title: 'Beat markers' })).json();
    const base = '/api/projects/' + projectId;
    const assetPath = 'media/music.mp3';
    const path = 'beats/' + assetPath + '.json';
    const file = (name: string) => base + '/files/' + encodeURIComponent(name);
    const upload = new FormData();
    upload.set('file', new File([new Uint8Array([0x49, 0x44, 0x33, 0])], 'music.mp3', { type: 'audio/mpeg' }));
    upload.set('path', assetPath);
    const uploaded = await app.request(base + '/upload', { method: 'POST', body: upload });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    assert.equal((await app.request(file('notes.html'), {method: 'PUT', headers: {'If-None-Match':'*'}, body:'<p>Notes</p>'})).status, 200);
    const countHistory = () => pgClient.rows('project_history_entries').length;
    const initial = countHistory();
    const beats = [{ time: 2, strength: 0.25 }, { time: 1, strength: 0.8 }];
    const grid = (audio: string, markers = beats) => ({ kind: 'setBeatGrid', assetPath: audio, beats: markers });
    const save = (markers: typeof beats, requestId: string, version?: string) => post(base + '/edits/' + encodeURIComponent(path),
      grid(assetPath, markers), { 'Idempotency-Key': requestId, ...(version ? { 'If-Match': version } : { 'If-None-Match': '*' }) });

    const created = await save(beats, 'create-grid');
    assert.equal(created.status, 200, await created.clone().text());
    const first = await created.json();
    const replayed = await save(beats, 'create-grid');
    assert.equal(replayed.status, 200);
    assert.deepEqual(await replayed.json(), first);
    assert.equal(countHistory(), initial + 1);
    const read = async () => JSON.parse((await (await app.request(file(path))).json()).content);
    assert.deepEqual(await read(), { version: 1, audio: assetPath, beats: [beats[1], beats[0]] });
    assert.equal((await save(beats, 'stale-create')).status, 409);
    const changed = [{ time: 0.5, strength: 1 }];
    const update = await save(changed, 'update-grid', first.version);
    assert.equal(update.status, 200, await update.clone().text());
    assert.deepEqual((await read()).beats, changed);
    assert.equal((await save(beats, 'stale-update', first.version)).status, 409);

    for (const [audio, status] of [['notes.html', 400], ['media/missing.mp3', 404], ['../music.mp3', 400]] as const) {
      const invalid = await post(base + '/edits', { edit: grid(audio), versions: { ['beats/' + audio + '.json']: null } }, { 'Idempotency-Key': 'invalid-' + status + audio.length });
      assert.equal(invalid.status, status, await invalid.clone().text());
    }
    const unrelated = await post(base + '/edits/' + encodeURIComponent('beats/other.json'), grid(assetPath),
      { 'If-None-Match': '*', 'Idempotency-Key': 'wrong-sidecar' });
    assert.equal(unrelated.status, 400);
    assert.equal(countHistory(), initial + 2);
    assert.deepEqual((await read()).beats, changed);
  });

  it('commits locally prepared MCP edits with Agent attribution and guarded, atomic history', {
    skip: !process.env.OPENMOTION_TEST_DATABASE_URL,
  }, async () => {
    const { createDbHandle } = await import('../../src/db/client.ts');
    const { runMigrations } = await import('../../src/db/migrate.ts');
    const connectionString = process.env.OPENMOTION_TEST_DATABASE_URL!;
    await runMigrations({ connectionString });
    const handle = createDbHandle({ connectionString });
    const userId = randomUUID(), workspaceId = randomUUID();
    try {
      await handle.pool.query('INSERT INTO users(id,oidc_sub,display_name) VALUES ($1,$2,$2)', [userId, userId]);
      await handle.pool.query('INSERT INTO workspaces(id,slug,name,owner_user_id) VALUES ($1,$2,$2,$3)', [workspaceId, workspaceId, userId]);
      const storage = new InMemoryStorage();
      const { TextRevisionStorage } = await import('../../src/infra/text-revisions.ts');
      const revisions = new TextRevisionStorage(handle.db, storage);
      const readPhysical = storage.getObjectBuffer.bind(storage);
      storage.getObjectBuffer = key => key.startsWith('workspaces/' + workspaceId + '/text-revisions/')
        ? revisions.read(workspaceId, key.split('/').at(-1)!) : readPhysical(key);
      const { app, config, services } = createApiFixture({ deps: { db: handle.db, storage }, config: {
        DEV_WORKSPACE_ID: workspaceId, DEV_USER_ID: userId, TEXT_PATCH_WRITES: 'true',
      } });
      const post = (url: string, body: unknown, headers: Record<string, string> = {}) => app.request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
      const { projectId } = await (await post('/motion-api/projects', { title: 'CLI edits' })).json();
      const base = '/api/projects/' + projectId;
      const headers: Record<string,string> = {Authorization: 'Bearer ' + config.DEV_PAT, Accept: 'application/json, text/event-stream'};
      const rpc = (method: string, params: unknown) => post('/mcp', {jsonrpc:'2.0', id:1, method, params}, headers);
      headers['Mcp-Session-Id'] = (await rpc('initialize', {protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'edit-cli',version:'1'}})).headers.get('mcp-session-id')!;
      const tool = async (name: string, args: unknown) => (await (await rpc('tools/call', {name, arguments:args})).json()).result;
      const asset = 'media/music.mp3', grid = 'beats/' + asset + '.json';
      const upload = new FormData();
      upload.set('file', new File([new Uint8Array([73,68,51,0])], 'music.mp3', {type:'audio/mpeg'}));
      upload.set('path', asset);
      assert.equal((await app.request(base + '/upload', { method:'POST', body:upload })).status, 201);
      const path = 'graded.html';
      const seed = '<main data-hf-id="stage"><img data-hf-id="photo" src="pic.png"></main>';
      assert.equal((await app.request(base + '/files/' + path,{method:'PUT',headers:{'If-None-Match':'*'},body:seed})).status, 200);
      const inventory = (await tool('openmotion_get_project', {projectId})).structuredContent;
      if (existsSync(new URL('../../studio/build/edit-core-sha256', import.meta.url))) {
        const response = await app.request(new URL(inventory.localEditCli.url).pathname);
        assert.equal(response.status, 200);
        assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), inventory.localEditCli.sha256);
      }
      const audio = inventory.files.find((f: {path:string}) => f.path === asset);
      const source = (await tool('openmotion_get_project', {projectId, file:{path, atProjectVersion:inventory.currentVersionId}})).structuredContent.file;
      const { prepareFileEdits } = await import('../../packages/edit-core/prepare-file-edits.ts');
      const textEdits = await prepareFileEdits({kind:'batch', commands:[
        {kind:'gradeMedia', compositionPath:path, value:'warm'},
        {kind:'setBeatGrid', assetPath:asset, beats:[{time:0.5,strength:1}]},
      ]}, [source, audio, {path:grid, fileVersion:null}]);
      assert.ok(textEdits.files.some(f => 'patch' in f), 'small grade changes travel as a patch');
      const args = {projectId, requestId:'prepared-grade-and-grid', expectedRevision:inventory.revision, expectedVersionId:inventory.currentVersionId, textEdits};
      await app.request(base + '/files/unrelated.txt',{method:'PUT',headers:{'If-None-Match':'*'},body:'peer edit'});
      const count = async () => Number((await handle.pool.query('SELECT count(*) FROM project_history_entries WHERE project_id=$1',[projectId])).rows[0].count);
      const initial = await count();
      const semantic = services.files.readEditInputs;
      services.files.readEditInputs = () => { throw Error('Prepared edits must not run a server command'); };
      const saved = await tool('openmotion_edit_project', args);
      assert.equal(saved.isError, undefined, JSON.stringify(saved));
      assert.deepEqual(new Set(saved.structuredContent.changedFiles), new Set([path,grid]));
      const replay = await tool('openmotion_edit_project', args);
      assert.equal(replay.structuredContent.replayed, true);
      assert.deepEqual(replay.structuredContent.version, saved.structuredContent.version);
      assert.equal((await tool('openmotion_edit_project', {...args, requestId:'stale-grid'})).isError, true);
      assert.equal(await count(), initial + 1);
      const entry = await handle.pool.query('SELECT actor_kind FROM project_history_entries WHERE project_id=$1 ORDER BY seq DESC LIMIT 1',[projectId]);
      assert.equal(entry.rows[0].actor_kind,'agent');
      const read = async (p: string) => (await (await app.request(base + '/files/' + encodeURIComponent(p))).json()).content;
      assert.match(await read(path), /data-color-grading="warm"/);
      assert.equal(JSON.parse(await read(grid)).beats[0].time, 0.5);
      assert.equal(await read('unrelated.txt'), 'peer edit');
      assert.equal((await post(base + '/history/step', {direction:'back'})).status, 200);
      assert.equal(await read(path), source.content);
      assert.equal((await app.request(base + '/files/' + encodeURIComponent(grid))).status, 404);
      assert.equal(await read('unrelated.txt'), 'peer edit');
      assert.equal((await post(base + '/history/step', {direction:'forward'})).status, 200);
      assert.equal(JSON.parse(await read(grid)).beats[0].time, 0.5);
      services.files.readEditInputs = semantic;
    } finally {
      await handle.pool.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
      await handle.pool.query('DELETE FROM users WHERE id=$1', [userId]);
      await handle.close();
    }
  });

  it('commits canvas properties and timeline edits as one undoable gesture through programmatic HTTP or remote MCP', async () => {
    const { app, config, pgClient } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const { projectId } = await (await post('/motion-api/projects', { title: 'Composite edit' })).json();
    const base = '/api/projects/' + projectId;
    const original = '<html><body><div data-composition-id="scene" data-duration="10"><div id="title" data-hf-id="hf-title" data-start="1" data-duration="3">Title</div></div></body></html>';
    const read = async (path: string) => (await app.request(base + '/files/' + path)).json();
    const paths = ['ui.html', 'ui-track.html', 'agent.html', 'agent-track.html'];
    for (const path of paths) {
      assert.equal((await app.request(base + '/files/' + path, { method: 'PUT', headers: { 'If-None-Match': '*' }, body: original })).status, 200);
    }
    const edit = (comp: string, track: string) => ({ kind: 'batch', commands: [
      { compositionPath: comp, kind: 'editElements', patches: [{ target: { hfId: 'hf-title' }, operations: [
        { type: 'text-content', property: 'textContent', value: 'Hello' },
        { type: 'inline-style', property: 'font-size', value: '32px' },
        { type: 'inline-style', property: 'color', value: 'red' },
      ] }] },
      { compositionPath: comp, kind: 'moveCanvasElement', target: { hfId: 'hf-title' }, x: 30, y: 12 },
      { compositionPath: track, kind: 'splitClips', hfIds: ['hf-title'], at: 2.5 },
    ] });
    const version = (await read(paths[0]!)).version;
    const before = (await read(paths[0]!)).content;
    const versions = { 'ui.html': version, 'ui-track.html': version };
    const historyCount = () => pgClient.tables.get('project_history_entries')!.length;
    const count = historyCount();
    const studio = (body: unknown, key: string) => post(base + '/edits', body, { 'Idempotency-Key': key, Authorization: 'Bearer ' + config.DEV_PAT });
    const bad = edit(paths[0]!, paths[1]!);
    Object.assign(bad.commands[2]!, { hfIds: ['missing'] });
    assert.equal((await studio({ edit: bad, versions }, 'invalid-batch')).status, 400);
    assert.equal((await read(paths[0]!)).content, before);
    assert.equal(historyCount(), count);
    const input = { edit: edit(paths[0]!, paths[1]!), versions };
    const first = await studio(input, 'gesture');
    assert.equal(first.status, 200, await first.clone().text());
    const replay = await studio(input, 'gesture');
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).versions, (await first.json()).versions);
    assert.equal(historyCount(), count + 1);
    assert.equal((await studio(input, 'stale-gesture')).status, 409);
    const ui = await read(paths[0]!);
    const split = await read(paths[1]!);
    assert.match(ui.content, /Hello/);
    assert.match(ui.content, /font-size:\s*32px/);
    assert.match(ui.content, /color:\s*red/);
    assert.match(ui.content, /translate:\s*30px 12px/);
    assert.match(split.content, /title-split/);
    assert.equal((await post(base + '/history/step', { direction: 'back' })).status, 200);
    for (const path of paths.slice(0, 2)) assert.equal((await read(path)).content, before);

    const headers: Record<string, string> = { Authorization: 'Bearer ' + config.DEV_PAT, Accept: 'application/json, text/event-stream' };
    const rpc = (method: string, params: unknown) => post('/mcp', { jsonrpc: '2.0', id: 1, method, params }, headers);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'project-edits', version: '1' } });
    headers['Mcp-Session-Id'] = init.headers.get('mcp-session-id')!;
    const call = async (name: string, args: unknown) => (await (await rpc('tools/call', { name, arguments: args })).json()).result;
    const project = (await call('openmotion_get_project', { projectId, inspect: { compositionPath: paths[2], limit: 100 } })).structuredContent;
    const target = project.elements.find((element: { id?: string; text?: string }) => element.id === 'title' && element.text === 'Title');
    assert.equal(target.sourceFile, paths[2]);
    assert.equal(target.hfId, 'hf-title');
    assert.equal(target.start, 1);
    const agent = await call('openmotion_edit_project', { projectId, requestId: 'agent-gesture', expectedRevision: project.revision,
      expectedVersionId: project.currentVersionId, edit: edit(paths[2]!, paths[3]!) });
    assert.equal(agent.isError, undefined, JSON.stringify(agent));
    assert.equal((await read(paths[2]!)).content, ui.content);
    assert.equal((await read(paths[3]!)).content, split.content);
  });

  it('persists the same authored keyframe values in Studio and a remote MCP session', async () => {
    const { app, config } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(url, { method:'POST', headers:{'Content-Type':'application/json', ...headers}, body:JSON.stringify(body) });
    const {projectId} = await (await post('/motion-api/projects', {title:'Animated drag'})).json();
    const base = '/api/projects/' + projectId;
    const source = '<div data-composition-id="stage" data-duration="6"><div id="title">Title</div><script>const tl=gsap.timeline();tl.fromTo("#title",{x:0,y:0},{x:100,y:80,ease:"none",duration:4},0);</script></div>';
    for (const path of ['studio.html','agent.html']) {
      assert.equal((await app.request(base+'/files/'+path,{method:'PUT',headers:{'If-None-Match':'*'},body:source})).status,200);
    }
    const before = await (await app.request(base+'/gsap-animations/studio.html')).json();
    const animationId = before.animations[0].id;
    const at = {time:2};
    const values = {x:44,y:28};
    const ui = await (await app.request(base + '/files/studio.html')).json();
    const local = await applyProjectEdit(ui.content, {kind:'editAnimation', compositionPath:'studio.html',
      mutations:[{type:'set-animated-values', animationId, at, values}]}, new Map());
    const studio = await post(base + '/text-edits/batch', {operations:[{
      id:'local-keyframe', label:local.label, files:[{path:'studio.html', baseVersion:ui.version, content:local.content}],
    }]});
    assert.equal(studio.status,200,await studio.clone().text());
    assert.equal((await studio.json()).committed.length, 1);
    const headers: Record<string,string> = {Authorization:'Bearer '+config.DEV_PAT,Accept:'application/json, text/event-stream'};
    const rpc = (method:string,params:unknown) => post('/mcp',{jsonrpc:'2.0',id:1,method,params},headers);
    const init = await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'canvas',version:'1'}});
    headers['Mcp-Session-Id'] = init.headers.get('mcp-session-id')!;
    const call = async(name:string,args:unknown) => (await (await rpc('tools/call',{name,arguments:args})).json()).result;
    const edit = async (requestId:string,command:unknown) => {
      const current = (await call('openmotion_get_project',{projectId})).structuredContent;
      const result = await call('openmotion_edit_project',{projectId,requestId,expectedRevision:current.revision,expectedVersionId:current.currentVersionId,edit:command});
      assert.equal(result.isError,undefined,JSON.stringify(result));
    };
    await edit('animated-position',{kind:'moveCanvasElement',compositionPath:'agent.html',target:{id:'title'},time:2,x:44,y:28});
    const read = async(path:string) => (await (await app.request(base+'/files/'+path)).json()).content;
    assert.equal(await read('studio.html'),await read('agent.html'));
    const tween = (await (await app.request(base+'/gsap-animations/agent.html')).json()).animations.find((a:{keyframes?:unknown})=>a.keyframes);
    assert.deepEqual(tween.keyframes.keyframes.find((k:{percentage:number})=>k.percentage===50).properties,values);
    await edit('add-another-stop',{kind:'editAnimation',compositionPath:'agent.html',mutations:[{type:'add-keyframe',animationId:tween.id,percentage:75,properties:{x:82,y:61}}]});
    assert.match(await read('agent.html'),/75%/);
  });

  it('replays caption commands with the original track and guards both project versions', async () => {
    const { app, config } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = (path: string, data: unknown) => app.request('/motion-api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.DEV_PAT }, body: JSON.stringify(data),
    });
    const { projectId } = await (await post('projects', { title: 'Caption retries' })).json();
    const call = (name: string, args: unknown) => post('phase1/call', { name, arguments: args });
    const project = async () => (await call('openmotion_get_project', { projectId })).json();
    const caption = (command: string, params: Record<string, unknown> = {}) => call('openmotion_assets_use', {
      action: 'transcript', transcript: { projectId, compositionPath: 'index.html', command, ...params },
    });
    const { revision, currentVersionId } = await project();
    const original = { expectedRevision: revision, expectedVersionId: currentVersionId,
      requestId: 'add-cue', segments: [{ id: 'c1', text: 'Hello', start: 0, end: 1 }] };
    const invalid = await caption('caption_add', { ...original, expectedVersionId: randomUUID() });
    assert.equal(invalid.status, 409);
    const added = await caption('caption_add', original);
    assert.equal(added.status, 200, JSON.stringify(await added.clone().json()));
    const first = await added.json();
    assert.ok(first.trackId);
    assert.equal(first.count, 1);
    const current = await project();
    const hide = { expectedVersionId: current.currentVersionId, expectedRevision: current.revision,
      requestId: 'hide-captions', visible: false };
    const hidden = await caption('caption_toggle', hide);
    assert.equal(hidden.status, 200);
    assert.equal((await hidden.json()).trackId, first.trackId);
    const tracks = await (await caption('caption_tracks')).json();
    assert.equal(tracks.tracks.length, 1);
    assert.equal(tracks.tracks[0].settings.visible, false);

    const hiddenVersion = (await project()).currentVersionId;
    const reordered = { ...original, segments: [{ end: 1, start: 0, text: 'Hello', id: 'c1' }] };
    assert.deepEqual(await (await caption('caption_add', reordered)).json(), first);
    const afterRetry = await project();
    assert.equal(afterRetry.currentVersionId, hiddenVersion);
    const mismatch = await caption('caption_add', { ...original, segments: [{ id: 'c1', text: 'Changed', start: 0, end: 1 }] });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).code, 'REQUEST_ID_CONFLICT');
  });

  it('reports deferred transcript discovery before requiring a composition', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    for (const transcript of [{ command: 'models' }, { command: 'sources', projectId: randomUUID() }]) {
      const response = await app.request('/motion-api/phase1/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'openmotion_assets_use', arguments: { action: 'transcript', transcript } }),
      });
      assert.equal(response.status, 501);
      assert.equal((await response.json()).code, 'FEATURE_DEFERRED_P2');
    }
  });

  it('switches editor routes without loading messages, export jobs or a second copy of the target', async t => {
    const { app, services, pgClient, config } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = (path: string, body?: Record<string, string>) => app.request('/motion-api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    const source = await (await post('projects', { title: 'Source' })).json();
    const target = await (await post('projects', { title: 'Target' })).json();
    const empty = await (await post('sessions', { title: 'Draft' })).json();
    const detailRead = t.mock.method(services.workspace, 'getSession');
    const projectRead = t.mock.method(services.workspace, 'getProject');
    const exportsRead = t.mock.method(services.exports, 'listProjectExports');
    const editorView = '?view=editor&projectId=' + source.projectId;
    const expected = {
      projectId: target.projectId, sessionId: target.sessionId,
      artifact: { id: target.artifactId, kind: 'motion-project', projectId: target.projectId, title: 'Target' },
    };

    for (const [path, body] of [
      [`projects/${target.projectId}/open`, undefined],
      [`sessions/${target.sessionId}/open`, { projectId: target.projectId }],
      [`sessions/${target.sessionId}/open`, undefined],
    ] as const) {
      const res = await post(path + editorView, body);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), expected);
    }
    const draft = await post(`sessions/${empty.sessionId}/open` + editorView);
    assert.equal(draft.status, 200);
    assert.deepEqual(await draft.json(), { projectId: '', sessionId: empty.sessionId, artifact: null });
    assert.equal(detailRead.mock.callCount(), 0);
    assert.equal(projectRead.mock.callCount(), 0);
    assert.equal(exportsRead.mock.callCount(), 0);

    const activeSession = () => pgClient.rows('workspaces').find(row => row.id === config.DEV_WORKSPACE_ID)?.active_session_id;
    assert.equal(activeSession(), empty.sessionId);
    const crossSession = await post(`sessions/${target.sessionId}/open` + editorView, { projectId: source.projectId });
    assert.equal(crossSession.status, 404);
    for (const path of [`projects/${target.projectId}/open`, `sessions/${target.sessionId}/open`]) {
      assert.equal((await post(path + '?view=editor&projectId=' + randomUUID())).status, 404);
    }
    assert.equal(activeSession(), empty.sessionId);
    await post(`projects/${target.projectId}/trash`);
    assert.equal((await post(`projects/${target.projectId}/open` + editorView)).status, 400);
    assert.equal((await post(`sessions/${target.sessionId}/open` + editorView, { projectId: target.projectId })).status, 404);
    // A project trashed in another tab must still allow leaving for an accessible target.
    for (const path of [`projects/${source.projectId}/open`, `sessions/${source.sessionId}/open`]) {
      assert.equal((await post(path + '?view=editor&projectId=' + target.projectId)).status, 200);
    }
  });

  it('supports Studio project/session/template navigation, /motion-api/preview/open, /motion-api/phase1/call, /generations, and /tracking/preferences', async (t) => {
    const { app, pgClient, storage, services } = createApiFixture({ config: { AUTH_MODE: 'dev' } });

    // Seed one catalog template so POST /motion-api/templates/:id/open can clone with expectedRevision/expectedProjectId.
    const tplHtml = Buffer.from('<div data-composition-id="main">Template</div>', 'utf8');
    const tplSha = createHash('sha256').update(tplHtml).digest('hex');
    await storage.putBlobIfAbsent(`catalog/blobs/${tplSha}`, tplHtml, 'text/html');
    pgClient.seed('catalog_templates', {
      id: 'studio-smoke-tpl',
      kind: 'builtin',
      catalog_version: 'v1',
      sort_order: 1,
      featured_order: 1,
      has_html_project: true,
      metadata: { title: 'Smoke Template', category: 'featured', durationSec: 3, width: 1280, height: 720, fps: 30 },
      instructions_md: null,
      motion_md: null,
      updated_at: new Date().toISOString(),
    });
    pgClient.seed('catalog_template_files', {
      template_id: 'studio-smoke-tpl',
      path: 'index.html',
      sha256: tplSha,
      size_bytes: tplHtml.byteLength,
      mime_type: 'text/html',
      metadata: null,
      is_project_file: true,
      is_available: true,
    });

    // 1. POST /motion-api/projects (accepts instruction + returns WorkspaceStatus fields)
    const createProjRes = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Studio Parity Film', instruction: 'Opening prompt' }),
    });
    assert.equal(createProjRes.status, 201);
    const createdProj = (await createProjRes.json()) as {
      projectId: string;
      artifactId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.ok(createdProj.projectId);
    assert.equal(createdProj.projectTitle, 'Studio Parity Film');
    assert.equal(createdProj.revision.length, 64);
    assert.ok(createdProj.sessionId);
    assert.equal(createdProj.exportJob, null);

    // 2. POST /motion-api/preview/open?projectId=<id> (MotionApp.tsx resolveWorkspaceProject)
    const previewOpenRes = await app.request(`/motion-api/preview/open?projectId=${createdProj.projectId}`, {
      method: 'POST',
    });
    assert.equal(previewOpenRes.status, 200);
    const previewOpen = (await previewOpenRes.json()) as {
      ok: boolean;
      activeId: string;
      artifact: { id: string; kind: string; projectId: string; title: string };
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.equal(previewOpen.ok, true);
    assert.equal(previewOpen.activeId, createdProj.projectId);
    assert.equal(previewOpen.projectId, createdProj.projectId);
    assert.equal(previewOpen.projectTitle, 'Studio Parity Film');
    assert.equal(previewOpen.revision, createdProj.revision);
    assert.equal(previewOpen.sessionId, createdProj.sessionId);
    assert.equal(previewOpen.exportJob, null);
    assert.notEqual(createdProj.artifactId, createdProj.projectId);
    assert.deepEqual(previewOpen.artifact, { id: createdProj.artifactId, kind: 'motion-project',
      projectId: createdProj.projectId, title: 'Studio Parity Film' });

    // 3. GET /motion-api/project/status & POST /motion-api/projects/:id/open top-level WorkspaceStatus
    const statusRes = await app.request(`/motion-api/project/status?projectId=${createdProj.projectId}`);
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as {
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.equal(statusBody.projectId, createdProj.projectId);
    assert.equal(statusBody.projectTitle, 'Studio Parity Film');
    assert.equal(statusBody.revision, createdProj.revision);
    assert.equal(statusBody.sessionId, createdProj.sessionId);
    assert.equal(statusBody.exportJob, null);

    const load = t.mock.method(services.files, 'loadVirtualProject');
    const list = t.mock.method(services.workspace, 'getCatalog');
    const summary = await app.request(`/motion-api/project/status?view=summary&projectId=${createdProj.projectId}`);
    assert.equal(summary.status, 200);
    assert.deepEqual(await summary.json(), {
      projectId: statusBody.projectId, projectTitle: statusBody.projectTitle,
      sessionId: statusBody.sessionId, revision: statusBody.revision, exportJob: null,
    });
    assert.equal(load.mock.callCount(), 0);
    assert.equal(list.mock.callCount(), 0);

    const openProjRes = await app.request(`/motion-api/projects/${createdProj.projectId}/open`, { method: 'POST' });
    assert.equal(openProjRes.status, 200);
    const openProjBody = (await openProjRes.json()) as {
      ok: boolean;
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.equal(openProjBody.ok, true);
    assert.equal(openProjBody.projectId, createdProj.projectId);
    assert.equal(openProjBody.projectTitle, 'Studio Parity Film');
    assert.equal(openProjBody.revision, createdProj.revision);
    assert.equal(openProjBody.sessionId, createdProj.sessionId);
    assert.equal(openProjBody.exportJob, null);

    // 4. PATCH /motion-api/projects/:id returns full ProjectCatalog alongside mutation fields
    const renameProjRes = await app.request(`/motion-api/projects/${createdProj.projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed Studio Film' }),
    });
    assert.equal(renameProjRes.status, 200);
    const renameProjBody = (await renameProjRes.json()) as {
      projectId: string;
      title: string;
      activeId: string;
      projects: Array<{ id: string; title: string }>;
      sessions: Array<{ id: string }>;
    };
    assert.equal(renameProjBody.projectId, createdProj.projectId);
    assert.equal(renameProjBody.title, 'Renamed Studio Film');
    assert.ok(Array.isArray(renameProjBody.projects));
    assert.ok(renameProjBody.projects.some((p) => p.id === createdProj.projectId && p.title === 'Renamed Studio Film'));
    assert.ok(Array.isArray(renameProjBody.sessions));

    // 5. POST /motion-api/sessions (instruction + caller id), /artifacts, /open, /messages, PATCH session
    const callerSessionId = randomUUID();
    const createSessRes = await app.request('/motion-api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: callerSessionId, title: 'Pitch Deck', instruction: 'Make a 10s teaser' }),
    });
    assert.equal(createSessRes.status, 201);
    const createdSess = (await createSessRes.json()) as {
      sessionId: string;
      session: { id: string; messages: Array<{ content: string }> };
    };
    assert.equal(createdSess.sessionId, callerSessionId);
    assert.equal(createdSess.session.id, callerSessionId);
    assert.equal(createdSess.session.messages[0]?.content, 'Make a 10s teaser');

    const artifactRes = await app.request(`/motion-api/sessions/${callerSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Teaser Cut 1' }),
    });
    assert.equal(artifactRes.status, 201);
    const artifactBody = (await artifactRes.json()) as {
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.ok(artifactBody.projectId);
    assert.equal(artifactBody.projectTitle, 'Teaser Cut 1');
    assert.equal(artifactBody.sessionId, callerSessionId);
    assert.equal(artifactBody.exportJob, null);

    const openSessRes = await app.request(`/motion-api/sessions/${callerSessionId}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: artifactBody.projectId }),
    });
    assert.equal(openSessRes.status, 200);
    const openSessBody = (await openSessRes.json()) as {
      ok: boolean;
      sessionId: string;
      projectId: string;
      projectTitle: string;
      revision: string;
      exportJob: unknown;
    };
    assert.equal(openSessBody.ok, true);
    assert.equal(openSessBody.sessionId, callerSessionId);
    assert.equal(openSessBody.projectId, artifactBody.projectId);
    assert.equal(openSessBody.projectTitle, 'Teaser Cut 1');
    assert.equal(openSessBody.revision, artifactBody.revision);
    assert.equal(openSessBody.exportJob, null);

    const renameSessRes = await app.request(`/motion-api/sessions/${callerSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pitch Deck Final' }),
    });
    assert.equal(renameSessRes.status, 200);
    const renameSessBody = (await renameSessRes.json()) as {
      id: string;
      projects: unknown[];
      sessions: Array<{ id: string; title: string }>;
    };
    assert.equal(renameSessBody.id, callerSessionId);
    assert.ok(Array.isArray(renameSessBody.projects));
    assert.ok(renameSessBody.sessions.some((s) => s.id === callerSessionId && s.title === 'Pitch Deck Final'));

    const msgRes = await app.request(`/motion-api/sessions/${callerSessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), content: 'Tighten pacing' }),
    });
    assert.equal(msgRes.status, 201);
    const msgBody = (await msgRes.json()) as { id: string; artifacts: unknown[]; messages: unknown[] };
    assert.equal(msgBody.id, callerSessionId);
    assert.ok(Array.isArray(msgBody.artifacts));
    assert.equal(msgBody.messages.length, 2);

    // 6. POST /motion-api/templates/:id/open accepts expectedRevision & expectedProjectId without 400
    const tplOpenRes = await app.request('/motion-api/templates/studio-smoke-tpl/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: createdProj.revision,
        expectedProjectId: createdProj.projectId,
      }),
    });
    assert.equal(tplOpenRes.status, 201);
    const tplOpenBody = (await tplOpenRes.json()) as {
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.ok(tplOpenBody.projectId);
    assert.equal(tplOpenBody.projectTitle, 'Smoke Template');
    assert.equal(tplOpenBody.revision.length, 64);
    assert.ok(tplOpenBody.sessionId);
    assert.equal(tplOpenBody.exportJob, null);

    // 6b. Studio startSession + /sessions/:id/artifacts clones editable templates zero-copy
    //     (both via inherited session.templateId and explicit body.templateId) and falls back
    //     to a blank project for reference-only templates without index.html.
    pgClient.seed('catalog_templates', {
      id: 'studio-ref-only-tpl',
      kind: 'prism',
      catalog_version: 'v1',
      sort_order: 2,
      featured_order: null,
      has_html_project: false,
      metadata: { title: 'Reference Only Template', category: 'featured', durationSec: 5 },
      instructions_md: null,
      motion_md: null,
      updated_at: new Date().toISOString(),
    });

    const tplSessionId = randomUUID();
    const tplSessRes = await app.request('/motion-api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tplSessionId, mode: 'motion', templateId: 'studio-smoke-tpl' }),
    });
    assert.equal(tplSessRes.status, 201);
    const tplSessBody = (await tplSessRes.json()) as { sessionId: string; title: string };
    assert.equal(tplSessBody.sessionId, tplSessionId);
    assert.equal(tplSessBody.title, 'Smoke Template');

    // First artifact without repeating templateId inherits session.templateId and clones zero-copy.
    const inheritedArtifactRes = await app.request(`/motion-api/sessions/${tplSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: createdProj.revision, expectedProjectId: createdProj.projectId }),
    });
    assert.equal(inheritedArtifactRes.status, 201);
    const inheritedArtifact = (await inheritedArtifactRes.json()) as {
      projectId: string;
      projectTitle: string;
      templateId: string;
      fileCount: number;
    };
    assert.equal(inheritedArtifact.templateId, 'studio-smoke-tpl');
    assert.equal(inheritedArtifact.projectTitle, 'Smoke Template');
    assert.equal(inheritedArtifact.fileCount, 1);
    const inheritedIndexRes = await app.request(`/api/projects/${inheritedArtifact.projectId}/files/index.html`);
    assert.equal(inheritedIndexRes.status, 200);
    assert.equal(
      ((await inheritedIndexRes.json()) as { content: string }).content,
      '<div data-composition-id="main">Template</div>',
    );

    // Subsequent artifact with explicit templateId (Studio createArtifact / templateHandoff flow).
    const cloneRequestId = randomUUID();
    const createExplicitArtifact = () => app.request(`/motion-api/sessions/${tplSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'studio-smoke-tpl', projectType: 'template', requestId: cloneRequestId, title: 'Custom Template Copy' }),
    });
    const explicitArtifactRes = await createExplicitArtifact();
    assert.equal(explicitArtifactRes.status, 201);
    const explicitArtifact = (await explicitArtifactRes.json()) as {
      projectId: string;
      projectTitle: string;
      templateId: string;
    };
    assert.equal(explicitArtifact.templateId, 'studio-smoke-tpl');
    assert.equal(explicitArtifact.projectTitle, 'Custom Template Copy');
    const repeated = await createExplicitArtifact();
    assert.equal(repeated.status, 200);
    const replay = await repeated.json();
    assert.equal(replay.projectId, explicitArtifact.projectId);
    assert.equal(replay.replayed, true);
    const explicitIndexRes = await app.request(`/api/projects/${explicitArtifact.projectId}/files/index.html`);
    assert.equal(explicitIndexRes.status, 200);
    assert.equal(
      ((await explicitIndexRes.json()) as { content: string }).content,
      '<div data-composition-id="main">Template</div>',
    );

    // An editor asking to open an editable project must never receive a blank copy.
    const projectsBeforeRefusal = pgClient.tables.get('projects')!.length;
    const refused = await app.request(`/motion-api/sessions/${tplSessionId}/artifacts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'studio-ref-only-tpl', projectType: 'template', requestId: randomUUID() }),
    });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).code, 'TEMPLATE_NOT_COPYABLE');
    assert.equal(pgClient.tables.get('projects')!.length, projectsBeforeRefusal);

    // Reference-only template falls back cleanly to a blank project inside the session.
    const refArtifactRes = await app.request(`/motion-api/sessions/${tplSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'studio-ref-only-tpl', title: 'Ref Recreation' }),
    });
    assert.equal(refArtifactRes.status, 201);
    const refArtifact = (await refArtifactRes.json()) as { projectId: string; projectTitle: string };
    assert.ok(refArtifact.projectId);
    assert.equal(refArtifact.projectTitle, 'Ref Recreation');

    // POST /motion-api/projects with editable templateId also clones zero-copy.
    const projFromTplRes = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'studio-smoke-tpl', title: 'Direct Project Clone' }),
    });
    assert.equal(projFromTplRes.status, 201);
    const projFromTpl = (await projFromTplRes.json()) as {
      projectId: string;
      projectTitle: string;
      templateId: string;
    };
    assert.equal(projFromTpl.templateId, 'studio-smoke-tpl');
    assert.equal(projFromTpl.projectTitle, 'Direct Project Clone');
    const projFromTplIndex = await app.request(`/api/projects/${projFromTpl.projectId}/files/index.html`);
    assert.equal(projFromTplIndex.status, 200);
    assert.equal(
      ((await projFromTplIndex.json()) as { content: string }).content,
      '<div data-composition-id="main">Template</div>',
    );

    // Zero-artifact session with a removed/missing inherited templateId falls back cleanly to a blank project,
    // while an explicit missing templateId on the request still fails with 404.
    const goneSessionId = randomUUID();
    const goneSessRes = await app.request('/motion-api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: goneSessionId, mode: 'motion', templateId: 'removed-catalog-tpl' }),
    });
    assert.equal(goneSessRes.status, 201);
    const goneInheritedRes = await app.request(`/motion-api/sessions/${goneSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(goneInheritedRes.status, 201);
    const goneInherited = (await goneInheritedRes.json()) as { projectId: string };
    assert.ok(goneInherited.projectId);

    const explicitMissingRes = await app.request(`/motion-api/sessions/${goneSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'removed-catalog-tpl' }),
    });
    assert.equal(explicitMissingRes.status, 404);

    // Shared capability parity: MCP openmotion_create_project with { templateId } (even with projectType=natural_language)
    // also clones zero-copy via the same createOrCloneProject service, and falls back for reference-only templates.
    const mcpCloneCall = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_create_project',
        arguments: {
          projectType: 'natural_language',
          title: 'MCP Shared Clone',
          requirements: 'Use the smoke template as a starting point',
          templateId: 'studio-smoke-tpl',
          requestId: 'req-mcp-shared-clone',
        },
      }),
    });
    assert.equal(mcpCloneCall.status, 200);
    const mcpCloneBody = (await mcpCloneCall.json()) as { projectId: string; templateId: string };
    assert.equal(mcpCloneBody.templateId, 'studio-smoke-tpl');
    const mcpCloneIndex = await app.request(`/api/projects/${mcpCloneBody.projectId}/files/index.html`);
    assert.equal(mcpCloneIndex.status, 200);
    assert.equal(
      ((await mcpCloneIndex.json()) as { content: string }).content,
      '<div data-composition-id="main">Template</div>',
    );

    const mcpRefFallbackCall = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_create_project',
        arguments: {
          projectType: 'natural_language',
          title: 'MCP Ref Fallback',
          requirements: 'Recreate from reference template',
          templateId: 'studio-ref-only-tpl',
          requestId: 'req-mcp-ref-fallback',
        },
      }),
    });
    assert.equal(mcpRefFallbackCall.status, 200);
    const mcpRefFallbackBody = (await mcpRefFallbackCall.json()) as { projectId: string };
    assert.ok(mcpRefFallbackBody.projectId);

    // 7. POST /motion-api/phase1/call (openmotion_get_project currentVersionId, openmotion_assets_use, P2 501)
    const getProjCall = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_get_project',
        arguments: { projectId: createdProj.projectId },
      }),
    });
    assert.equal(getProjCall.status, 200);
    const getProjBody = (await getProjCall.json()) as {
      projectId: string;
      revision: string;
      currentVersionId: string;
      version: { versionId: string };
    };
    assert.equal(getProjBody.projectId, createdProj.projectId);
    assert.equal(getProjBody.revision, createdProj.revision);
    assert.ok(getProjBody.currentVersionId);
    assert.equal(getProjBody.currentVersionId, getProjBody.version.versionId);

    const assetsListCall = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'list', sort: 'newest', offset: 0, limit: 40 },
      }),
    });
    assert.equal(assetsListCall.status, 200);
    const assetsListBody = (await assetsListCall.json()) as { assets: unknown[]; total: number };
    assert.deepEqual(assetsListBody.assets, []);
    assert.equal(assetsListBody.total, 0);

    const p2Call = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_manage_project',
        arguments: { action: 'comments', projectId: createdProj.projectId },
      }),
    });
    assert.equal(p2Call.status, 501);
    const p2Body = (await p2Call.json()) as { code: string; error: string };
    assert.equal(p2Body.code, 'FEATURE_DEFERRED_P2');
    assert.equal(typeof p2Body.error, 'string');

    // 8. GET /motion-api/generations + POST /motion-api/generations/:id/cancel (GenerationJob shape)
    const submitGenRes = await app.request('/motion-api/models/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modality: 'image',
        model: 'opendesign:mock-image-1',
        prompt: 'Golden hour mountain silhouette',
        projectId: createdProj.projectId,
        requestId: 'req-gen-studio-1',
      }),
    });
    assert.equal(submitGenRes.status, 202);
    const submittedGen = (await submitGenRes.json()) as {
      job: { id: string; model: { label: string }; createdAt: number; updatedAt: number; assets: unknown[]; saveToLibrary: boolean };
    };
    assert.equal(typeof submittedGen.job.createdAt, 'number');
    assert.equal(typeof submittedGen.job.updatedAt, 'number');
    assert.equal(typeof submittedGen.job.model.label, 'string');
    assert.ok(Array.isArray(submittedGen.job.assets));
    assert.equal(submittedGen.job.saveToLibrary, true);

    const gensRes = await app.request(`/motion-api/generations?projectId=${createdProj.projectId}`);
    assert.equal(gensRes.status, 200);
    const gensBody = (await gensRes.json()) as { jobs: Array<{ id: string }> };
    assert.equal(gensBody.jobs.length, 1);
    assert.equal(gensBody.jobs[0].id, submittedGen.job.id);

    const cancelGenRes = await app.request(`/motion-api/generations/${submittedGen.job.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(cancelGenRes.status, 200);
    const cancelGenBody = (await cancelGenRes.json()) as { job: { id: string; state: string } };
    assert.equal(cancelGenBody.job.id, submittedGen.job.id);
    assert.equal(cancelGenBody.job.state, 'cancelled');

    // 9. GET/PUT/POST /motion-api/tracking/preferences & GET /motion-api/health
    for (const method of ['GET', 'PUT', 'POST'] as const) {
      const prefRes = await app.request('/motion-api/tracking/preferences', {
        method,
        ...(method !== 'GET'
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }
          : {}),
      });
      assert.equal(prefRes.status, 200, `expected 200 for ${method} /motion-api/tracking/preferences`);
      const prefBody = (await prefRes.json()) as { enabled: boolean; preference: boolean; locked: boolean };
      assert.equal(prefBody.enabled, false);
      assert.equal(prefBody.preference, false);
      assert.equal(prefBody.locked, true);
    }

    const motionHealthRes = await app.request('/motion-api/health');
    assert.equal(motionHealthRes.status, 200);
    assert.ok(((await motionHealthRes.json()) as { version?: string }).version);
  });
});

// ---------------------------------------------------------------------------
// 7. Comment c5 — Cookie-less Preview Subdomain Isolation & Unified Config
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Unified Config & Cookie-less Preview Subdomain Isolation (c5)', () => {
  it('validates c1/c2/c3/c4/c5 config defaults, trimming, bounds, and S3 CORS origin inclusion', () => {
    const defaults = makeConfig();
    assert.equal(defaults.BLOB_GC_GRACE_SECONDS, 604_800);
    assert.equal(defaults.S3_PRESIGN_CACHE_WINDOW_SEC, 3600);
    assert.equal(defaults.PREVIEW_PUBLIC_ORIGIN, undefined);
    assert.equal(defaults.PREVIEW_TOKEN_TTL_SEC, 900);
    assert.equal(defaults.HISTORY_COALESCE_WINDOW_MS, 4000);
    assert.deepEqual(resolveApiCorsAllowedOrigins(defaults), ['https://motion.example.test']);

    const configured = makeConfig({
      PREVIEW_PUBLIC_ORIGIN: '  https://preview.openmotion.test  ',
      PREVIEW_TOKEN_TTL_SEC: '600',
      S3_PRESIGN_CACHE_WINDOW_SEC: '1800',
      HISTORY_COALESCE_WINDOW_MS: '0',
    });
    assert.equal(configured.PREVIEW_PUBLIC_ORIGIN, 'https://preview.openmotion.test');
    assert.equal(configured.PREVIEW_TOKEN_TTL_SEC, 600);
    assert.equal(configured.S3_PRESIGN_CACHE_WINDOW_SEC, 1800);
    assert.equal(configured.HISTORY_COALESCE_WINDOW_MS, 0);
    assert.deepEqual(resolveApiCorsAllowedOrigins(configured), [
      'https://motion.example.test',
      'https://preview.openmotion.test',
    ]);

    assert.throws(() => makeConfig({ S3_PRESIGN_CACHE_WINDOW_SEC: '0' }), /INVALID_CONFIG/);
    assert.throws(() => makeConfig({ PREVIEW_TOKEN_TTL_SEC: '0' }), /INVALID_CONFIG/);
    assert.throws(() => makeConfig({ PREVIEW_PUBLIC_ORIGIN: 'not-a-url' }), /INVALID_CONFIG/);
    assert.throws(() => makeConfig({ HISTORY_COALESCE_WINDOW_MS: '-1' }), /INVALID_CONFIG/);
  });

  it('enforces strict preview host isolation (403 PREVIEW_ORIGIN_ISOLATED), ignores cookies, and validates scoped preview tokens', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const fixture = createApiFixture({
      config: {
        AUTH_MODE: 'oidc',
        APP_PUBLIC_ORIGIN: 'https://motion.example.test',
        PREVIEW_PUBLIC_ORIGIN: 'https://preview.openmotion.test',
        PREVIEW_TOKEN_TTL_SEC: '900',
        TRUST_PROXY_HOPS: '1',
      },
    });
    const { app, config, authStore, pgClient } = fixture;

    const userId = randomUUID();
    const workspaceId = randomUUID();
    authStore.seedWorkspace({
      workspaceId,
      userId,
      oidcSub: 'oidc-preview-isolation-1',
      email: 'preview@example.test',
      displayName: 'Preview Creator',
      role: 'owner',
      slug: 'preview-ws',
      name: 'Preview Workspace',
    });
    pgClient.seed('workspaces', {
      id: workspaceId,
      slug: 'preview-ws',
      name: 'Preview Workspace',
      owner_user_id: userId,
      active_project_id: null,
      default_models: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const browserSession = await createBrowserSession(authStore, { userId, workspaceId });
    const cookieHeader = `${SESSION_COOKIE_NAME}=${browserSession.token}`;
    const mainMutateHeaders = {
      Cookie: cookieHeader,
      Origin: 'https://motion.example.test',
      'Content-Type': 'application/json',
    };

    // /__hyperframes_config exposes previewOrigin on main host
    const cfgRes = await app.request('/__hyperframes_config');
    assert.equal(cfgRes.status, 200);
    const cfgBody = (await cfgRes.json()) as { previewOrigin: string | null };
    assert.equal(cfgBody.previewOrigin, 'https://preview.openmotion.test');

    // Create two projects on the main origin
    const createA = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: mainMutateHeaders,
      body: JSON.stringify({ title: 'Project Alpha' }),
    });
    assert.equal(createA.status, 201);
    const projectA = ((await createA.json()) as { projectId: string }).projectId;

    const createB = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: mainMutateHeaders,
      body: JSON.stringify({ title: 'Project Beta' }),
    });
    assert.equal(createB.status, 201);
    const projectB = ((await createB.json()) as { projectId: string }).projectId;

    // Mint a project-scoped preview token on the main origin
    const tokenRes = await app.request(`/api/projects/${projectA}/preview-token`, {
      method: 'POST',
      headers: mainMutateHeaders,
    });
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.headers.get('cache-control'), 'no-store');
    const minted = (await tokenRes.json()) as {
      token: string;
      expiresAt: string;
      previewOrigin: string | null;
      previewUrl: string;
    };
    assert.equal(minted.previewOrigin, 'https://preview.openmotion.test');
    assert.ok(minted.previewUrl.startsWith(`https://preview.openmotion.test/api/projects/${projectA}/preview?pt=`));
    assert.ok(Date.parse(minted.expiresAt) > Date.now());

    // Unit-check token payload verification directly
    const secret = resolvePreviewTokenSecret(config);
    const decoded = verifyPreviewToken(minted.token, secret, { expectedProjectId: projectA });
    assert.ok(decoded);
    assert.equal(decoded.typ, 'om_preview');
    assert.equal(decoded.wid, workspaceId);
    assert.equal(decoded.pid, projectA);
    assert.equal(verifyPreviewToken(minted.token, secret, { expectedProjectId: projectB }), null);

    // 1. Preview host IMMEDIATELY REJECTS /motion-api/*, /auth/*, /oauth/*, /mcp, files, preview-token & mutations with 403 PREVIEW_ORIGIN_ISOLATED
    const blockedRequests: Array<{ method: string; path: string; hostHeader: Record<string, string> }> = [
      { method: 'GET', path: '/motion-api/projects', hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'GET', path: '/auth/me', hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'POST', path: '/oauth/token', hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'POST', path: '/mcp', hostHeader: { 'X-Forwarded-Host': 'preview.openmotion.test' } },
      { method: 'GET', path: `/api/projects/${projectA}/files/index.html`, hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'POST', path: `/api/projects/${projectA}/preview-token`, hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'DELETE', path: `/api/projects/${projectA}/preview`, hostHeader: { Host: 'preview.openmotion.test' } },
    ];
    for (const entry of blockedRequests) {
      const res = await app.request(entry.path, {
        method: entry.method,
        headers: {
          ...entry.hostHeader,
          Cookie: cookieHeader,
        },
      });
      assert.equal(res.status, 403, `expected 403 on preview host for ${entry.method} ${entry.path}`);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'PREVIEW_ORIGIN_ISOLATED');
      assert.equal(
        res.headers.get('content-security-policy'),
        "frame-ancestors 'self' https://motion.example.test;",
      );
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('origin-agent-cluster'), '?1');
      assert.equal(res.headers.get('set-cookie'), null);
    }

    // 2. Preview host IGNORES browser session cookies on /api/projects/:id/preview (requires scoped preview token!)
    const cookieOnlyPreview = await app.request(`/api/projects/${projectA}/preview`, {
      headers: {
        Host: 'preview.openmotion.test',
        Cookie: cookieHeader,
      },
    });
    assert.equal(cookieOnlyPreview.status, 401);

    // 3. Valid scoped preview token via ?pt=... AND X-OpenMotion-Preview-Token succeeds on preview host with security headers
    const viaQuery = await app.request(
      `/api/projects/${projectA}/preview?pt=${encodeURIComponent(minted.token)}`,
      { headers: { Host: 'preview.openmotion.test' } },
    );
    assert.equal(viaQuery.status, 200);
    assert.equal(
      viaQuery.headers.get('content-security-policy'),
      "frame-ancestors 'self' https://motion.example.test;",
    );
    assert.equal(viaQuery.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(viaQuery.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(viaQuery.headers.get('origin-agent-cluster'), '?1');
    assert.equal(viaQuery.headers.get('set-cookie'), null);
    const studioDoc = await app.request('/', { headers: { Host: 'motion.example.test' } });
    if (studioDoc.status === 200) {
      assert.equal(studioDoc.headers.get('origin-agent-cluster'), '?1');
    }
    const previewHtml = await viaQuery.text();
    assert.match(previewHtml, /Project Alpha/);
    const base = previewHtml.match(/<base href="([^"]+)"/)?.[1];
    assert.ok(base);
    const assetUrl = new URL('index.html', base);
    assert.equal(assetUrl.origin, minted.previewOrigin);
    const previewHeaders = { Host: assetUrl.host };
    const bridgeSrc = previewHtml.match(/<script src="([^"]+)" data-openmotion-preview=/)?.[1];
    assert.ok(bridgeSrc);
    const bridgeUrl = new URL(bridgeSrc);
    assert.equal(bridgeUrl.origin, minted.previewOrigin);
    assert.equal(bridgeUrl.search, '');
    const expectedSha = /^\/api\/preview-bridge\/([a-f0-9]{64})\.js$/.exec(bridgeUrl.pathname)?.[1];
    assert.ok(expectedSha);
    const bridgeAsset = await app.request(bridgeSrc, { headers: previewHeaders });
    assert.equal(bridgeAsset.status, 200);
    assert.match(bridgeAsset.headers.get('cache-control') ?? '', /immutable/);
    const snapdomAsset = await app.request('/api/vendor/snapdom.js', { headers: previewHeaders });
    assert.equal(snapdomAsset.status, 200);
    assert.match(snapdomAsset.headers.get('content-type') ?? '', /javascript/);
    assert.equal(snapdomAsset.headers.get('set-cookie'), null);
    assert.match(await snapdomAsset.text(), /window\.snapdom/);
    const browserExportAsset = await app.request('/api/vendor/browser-export.js', { headers: previewHeaders });
    assert.equal(browserExportAsset.status, 200);
    assert.match(browserExportAsset.headers.get('content-type') ?? '', /javascript/);
    assert.equal(browserExportAsset.headers.get('cache-control'), 'no-cache');
    assert.equal(browserExportAsset.headers.get('set-cookie'), null);
    assert.match(await browserExportAsset.text(), /__openmotionBrowserExport/);
    const browserExportPost = await app.request('/api/vendor/browser-export.js', {
      method: 'POST',
      headers: previewHeaders,
    });
    assert.equal(browserExportPost.status, 403);
    const script = await bridgeAsset.text();
    assert.equal(createHash('sha256').update(script).digest('hex'), expectedSha);
    assert.ok(previewHtml.includes('integrity="sha256-' + Buffer.from(expectedSha, 'hex').toString('base64') + '"'));
    assert.equal((await fixture.storage.getObjectBuffer('system/preview-bridge/' + expectedSha + '.js')).toString(), script);
    assert.ok(!script.includes(minted.token) && !script.includes(projectA));
    const legacy = await app.request('/api/preview-bridge.js?v=retired', { headers: previewHeaders });
    assert.equal(legacy.headers.get('cache-control'), 'no-store');
    assert.equal(await legacy.text(), script);

    const foreignScript = Buffer.from('// another deployed bridge build');
    const foreignHash = createHash('sha256').update(foreignScript).digest('hex');
    const foreignUrl = '/api/preview-bridge/' + foreignHash + '.js';
    const foreignKey = 'system/preview-bridge/' + foreignHash + '.js';
    const missing = await app.request(foreignUrl, { headers: previewHeaders });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cdn-cache-control'), 'no-store');
    await fixture.storage.putObject(foreignKey, 'different bytes', 'application/javascript');
    const corrupt = await app.request(foreignUrl, { headers: previewHeaders });
    assert.equal(corrupt.status, 503);
    assert.equal(corrupt.headers.get('cache-control'), 'no-store');
    await fixture.storage.putObject(foreignKey, foreignScript, 'application/javascript');
    const archived = await app.request(foreignUrl, { headers: previewHeaders });
    assert.equal(archived.status, 200);
    assert.match(archived.headers.get('cache-control') ?? '', /immutable/);
    assert.deepEqual(Buffer.from(await archived.arrayBuffer()), foreignScript);

    const assetResponse = await app.request(assetUrl.href, { headers: previewHeaders });
    assert.equal(assetResponse.status, 200);
    assert.match(await assetResponse.text(), /Project Alpha/);
    const assetHead = await app.request(assetUrl.href, { method: 'HEAD', headers: previewHeaders });
    assert.equal(assetHead.status, 200);
    assert.equal(await assetHead.text(), '');
    const foreignAsset = await app.request(assetUrl.href.replace(projectA, projectB), { headers: previewHeaders });
    assert.equal(foreignAsset.status, 401);
    const sameOriginHtml = await app.request(`/api/projects/${projectA}/preview`, {
      headers: { Cookie: cookieHeader },
    });
    assert.doesNotMatch(await sameOriginHtml.text(), /~assets\/|data-openmotion-preview|openmotion-preview-bridge/);
    assert.match(sameOriginHtml.headers.get('content-security-policy') ?? '', /sandbox/);
    const mainAsset = await app.request(`/api/projects/${projectA}/preview/index.html`, {
      headers: { Cookie: cookieHeader },
    });
    assert.match(mainAsset.headers.get('content-security-policy') ?? '', /script-src 'none'/);
    const nav = (path: string, site: string) => app.request(path, {
      headers: { Cookie: cookieHeader, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': site },
    });
    const documentPath = `/api/projects/${projectA}/preview/comp/index.html?capture=1`;
    const mainNavigation = await nav(documentPath, 'same-origin');
    assert.equal(mainNavigation.status, 302);
    const isolatedLocation = new URL(mainNavigation.headers.get('location')!);
    assert.equal(isolatedLocation.origin, minted.previewOrigin);
    assert.equal(isolatedLocation.searchParams.get('capture'), '1');
    assert.ok(verifyPreviewToken(isolatedLocation.searchParams.get('pt'), secret, { expectedProjectId: projectA }));
    assert.equal((await nav(documentPath, 'same-site')).status, 403);
    assert.equal((await nav(documentPath, 'cross-site')).status, 403);

    const viaHeader = await app.request(`/api/projects/${projectA}/preview`, {
      headers: {
        'X-Forwarded-Host': 'preview.openmotion.test',
        'X-OpenMotion-Preview-Token': minted.token,
      },
    });
    assert.equal(viaHeader.status, 200);

    // 4. Cross-project preview token is rejected (401)
    const crossProject = await app.request(
      `/api/projects/${projectB}/preview?pt=${encodeURIComponent(minted.token)}`,
      { headers: { Host: 'preview.openmotion.test' } },
    );
    assert.equal(crossProject.status, 401);

    // 5. Expired preview token is rejected (401)
    const expired = signPreviewToken(
      { workspaceId, projectId: projectA, ttlSec: 60, nowMs: Date.now() - 120_000 },
      secret,
    );
    const expiredRes = await app.request(
      `/api/projects/${projectA}/preview?pt=${encodeURIComponent(expired.token)}`,
      { headers: { Host: 'preview.openmotion.test' } },
    );
    assert.equal(expiredRes.status, 401);
    const expiredAsset = await app.request(assetUrl.href.replace(minted.token, expired.token), { headers: previewHeaders });
    assert.equal(expiredAsset.status, 401);

    // A live Studio session renews asset URLs without replacing the loaded document.
    const leaseRequest = async (id: string, assetLease: true | string) => {
      const response = await app.request(`/api/projects/${id}/preview-token`, {
        method: 'POST', headers: mainMutateHeaders, body: JSON.stringify({ assetLease }),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ token: string; assetLease: string; previewUrl: string }>;
    };
    const initial = await leaseRequest(projectA, true);
    const leaseDocument = await app.request(initial.previewUrl, { headers: previewHeaders });
    const leaseBase = (await leaseDocument.text()).match(/<base href="([^"]+)"/)?.[1];
    assert.ok(leaseBase?.includes(initial.assetLease));
    const secondLease = await leaseRequest(projectA, true);
    const otherDocument = await app.request(secondLease.previewUrl, {
      headers: { ...previewHeaders, 'If-None-Match': leaseDocument.headers.get('etag')! },
    });
    assert.equal(otherDocument.status, 200);
    const otherHtml = await otherDocument.text();
    assert.ok(otherHtml.includes(secondLease.assetLease));
    assert.ok(!otherHtml.includes(initial.assetLease));
    assert.notEqual(otherDocument.headers.get('etag'), leaseDocument.headers.get('etag'));
    const leaseAssetUrl = new URL('index.html', leaseBase);
    assert.equal((await app.request(leaseAssetUrl.href, { headers: previewHeaders })).status, 200);
    const foreignLease = await leaseRequest(projectB, initial.assetLease);
    assert.notEqual(foreignLease.assetLease, initial.assetLease);
    assert.equal((await app.request(leaseAssetUrl.href.replace(projectA, projectB), { headers: previewHeaders })).status, 401);
    assert.equal((await app.request(initial.previewUrl.replace(initial.token, initial.assetLease), { headers: previewHeaders })).status, 401);
    t.mock.timers.tick(600_000);
    const renewed = await leaseRequest(projectA, initial.assetLease);
    assert.equal(renewed.assetLease, initial.assetLease);
    t.mock.timers.tick(301_000);
    assert.equal((await app.request(initial.previewUrl, { headers: previewHeaders })).status, 401);
    assert.equal((await app.request(leaseAssetUrl.href, { headers: previewHeaders })).status, 200);
    t.mock.timers.tick(600_000);
    assert.equal((await app.request(leaseAssetUrl.href, { headers: previewHeaders })).status, 401);
    assert.notEqual((await leaseRequest(projectA, initial.assetLease)).assetLease, initial.assetLease);

    // 6. Preview token is NEVER accepted as a Bearer token on main-origin /motion-api/* or /mcp
    const mainApiWithPreviewToken = await app.request('/motion-api/projects', {
      headers: { Authorization: `Bearer ${minted.token}` },
    });
    assert.equal(mainApiWithPreviewToken.status, 401);

    const mcpWithPreviewToken = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(mcpWithPreviewToken.status, 401);

    // 7. Read-only runtime/vendor/fonts/health/OPTIONS routes remain reachable on the preview host
    for (const allowedPath of [
      '/api/runtime.js',
      '/api/vendor/gsap/gsap.min.js',
      '/api/vendor/gsap/gsap@3.15.0/dist/MotionPathPlugin.min.js',
      '/api/fonts',
      '/api/health/live',
    ]) {
      const res = await app.request(allowedPath, {
        headers: { Host: 'preview.openmotion.test' },
      });
      assert.equal(res.status, 200, `expected 200 on preview host for ${allowedPath}`);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }

    const optRes = await app.request(`/api/projects/${projectA}/preview`, {
      method: 'OPTIONS',
      headers: {
        Host: 'preview.openmotion.test',
        Origin: 'https://motion.example.test',
      },
    });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), 'https://motion.example.test');
    assert.equal(optRes.headers.get('access-control-allow-credentials'), null);

    // 8. Even in AUTH_MODE=dev, preview host never falls back to dev_bypass without a valid preview token
    const devIsolated = createApiFixture({
      config: {
        AUTH_MODE: 'dev',
        APP_PUBLIC_ORIGIN: 'https://motion.example.test',
        PREVIEW_PUBLIC_ORIGIN: 'https://preview.openmotion.test',
      },
    });
    const devProjRes = await devIsolated.app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Dev Isolated' }),
    });
    const devProjId = ((await devProjRes.json()) as { projectId: string }).projectId;
    const devUnauthPreview = await devIsolated.app.request(`/api/projects/${devProjId}/preview`, {
      headers: { Host: 'preview.openmotion.test' },
    });
    assert.equal(devUnauthPreview.status, 401);

    // 9. When PREVIEW_PUBLIC_ORIGIN is unset (local Compose dev), /__hyperframes_config reports previewOrigin: null and single-host preview works seamlessly
    const localDev = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const localCfg = (await (await localDev.app.request('/__hyperframes_config')).json()) as {
      previewOrigin: string | null;
    };
    assert.equal(localCfg.previewOrigin, null);
    const localProjId = (
      (await (
        await localDev.app.request('/motion-api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Single Host Local' }),
        })
      ).json()) as { projectId: string }
    ).projectId;
    const localPreview = await localDev.app.request(`/api/projects/${localProjId}/preview`);
    assert.equal(localPreview.status, 200);
  });
});

// ---------------------------------------------------------------------------
// 8. OAuth Agent Workspace-Level Project Access & Cross-User Owner Isolation
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — OAuth Agent Workspace Access & Cross-User Isolation', () => {
  it('grants an OAuth agent full access to its own user projects without per-project grants while isolating other users', async () => {
    const fixture = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const { app, config, pgClient, authStore } = fixture;

    const userId = config.DEV_USER_ID;
    const otherUserId = randomUUID();
    const workspaceId = config.DEV_WORKSPACE_ID;
    const clientId = 'oauth-client-codex';
    authStore.seedWorkspace({
      userId: otherUserId,
      workspaceId,
      email: 'colleague@example.test',
      displayName: 'Colleague',
      role: 'editor',
    });
    authStore.seedWorkspace({
      userId,
      workspaceId,
      email: 'owner@example.test',
      displayName: 'Owner',
    });
    const rawAccessToken = `om_oat_${'a'.repeat(40)}`;
    const tokenHash = createHash('sha256').update(rawAccessToken).digest('hex');
    await authStore.createOAuthToken({
      clientId,
      userId,
      workspaceId,
      accessTokenHash: tokenHash,
      refreshTokenHash: null,
      scope: DEFAULT_PAT_SCOPES.join(' '),
      resource: `${config.APP_PUBLIC_ORIGIN}/mcp`,
      accessExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: null,
    });

    // Create two web projects owned by the user (no project_grants rows!) and one owned by another user in the same workspace
    const createProj = async (title: string): Promise<string> => {
      const res = await app.request('/motion-api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      assert.equal(res.status, 201);
      return ((await res.json()) as { projectId: string }).projectId;
    };
    const projectA = await createProj('Web Project A');
    const projectB = await createProj('Web Project B');
    const otherUserProject = await createProj('Other User Private Project');
    const otherRow = pgClient.rows('projects').find(row => row.id === otherUserProject)!;
    otherRow.owner_user_id = otherUserId;

    const agent: AuthContext = {
      authMode: 'oidc', authMethod: 'oauth_bearer', role: 'editor', scopes: DEFAULT_PAT_SCOPES,
      clientId, userId, workspaceId,
    };
    const sessionA = pgClient.rows('projects').find(row => row.id === projectA)!.session_id as string;
    const sessionB = pgClient.rows('projects').find(row => row.id === projectB)!.session_id as string;
    const otherSession = otherRow.session_id as string;
    const workspace = fixture.services.workspace;

    // Same-user web projects are immediately accessible without manual per-project grants
    assert.equal((await workspace.openSessionForEditor(agent, sessionA, projectA, projectA)).projectId, projectA);
    assert.equal((await workspace.openSessionForEditor(agent, sessionB, projectB, projectB)).projectId, projectB);

    // Another user's project/session remains strictly isolated as NOT_FOUND
    await assert.rejects(workspace.selectProject(agent, projectA, otherUserProject), { code: 'PROJECT_NOT_FOUND' });
    await assert.rejects(workspace.openSessionForEditor(agent, otherSession, otherUserProject), { code: 'PROJECT_NOT_FOUND' });
    await assert.rejects(workspace.openSessionForEditor(agent, otherSession), { code: 'SESSION_NOT_FOUND' });

    // Initialize an MCP session authenticated as `oauth_bearer`
    const mcpHeaders = {
      Authorization: `Bearer ${rawAccessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const initRes = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'codex-workspace-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const initJson = (await initRes.json()) as { result?: { instructions?: string } };
    assert.match(initJson.result?.instructions ?? '', /https:\/\/motion\.example\.test/);
    assert.match(initJson.result?.instructions ?? '', /After authorization, keep \/install\.md internal/);
    assert.match(initJson.result?.instructions ?? '', /a new chat in this client.*creative request/);
    assert.doesNotMatch(initJson.result?.instructions ?? '', /open a new Codex chat/);
    assert.ok(initJson.result?.instructions?.includes(`${config.APP_PUBLIC_ORIGIN}/mcp-setup`));
    const mcpSessionId = initRes.headers.get('mcp-session-id');
    assert.ok(mcpSessionId);

    const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { ...mcpHeaders, 'Mcp-Session-Id': mcpSessionId },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
          content?: Array<{ type: string; text?: string }>;
        };
      };
    };

    // 1. OAuth agent can immediately read & prepare_upload on web-created projectB without per-project grants
    const readProjectB = await callTool(2, 'openmotion_get_project', { projectId: projectB });
    assert.equal(readProjectB.result?.isError, undefined, JSON.stringify(readProjectB.result));
    const prepProjectB = await callTool(3, 'openmotion_import_assets', {
      action: 'prepare_upload',
      projectId: projectB,
      requestId: 'req_prep_b_1',
      files: [{ itemId: 'file-1', filename: 'hero.png', bytes: 1024, mimeType: 'image/png' }],
    });
    assert.equal(prepProjectB.result?.isError, undefined, JSON.stringify(prepProjectB.result));

    // A cloud archive has an absolute, authenticated download URL and can be uploaded through HTTP.
    const exportArgs = { action: 'export', projectIds: [projectB], requestId: 'archive-export-e2e' };
    const exported = await callTool(20, 'openmotion_project_archive', exportArgs);
    assert.equal(exported.result?.isError, undefined, JSON.stringify(exported.result));
    const archive = exported.result?.structuredContent as {
      archiveId: string; downloadUrl: string; downloadInstructions: string; bytes: number; sha256: string;
    };
    const archiveFile = `/motion-api/project-archives/${archive.archiveId}/file`;
    assert.equal(archive.downloadUrl, `${config.APP_PUBLIC_ORIGIN}${archiveFile}`);
    assert.match(archive.downloadInstructions, /OAuth.*PAT.*projects:read/);

    const receipt = pgClient.rows('idempotency_receipts').find(row => row.request_id === exportArgs.requestId)!;
    receipt.response_payload = { ...(receipt.response_payload as object), downloadUrl: archiveFile };
    const retried = await callTool(21, 'openmotion_project_archive', exportArgs);
    assert.deepEqual(retried.result?.structuredContent, { ...archive, replayed: true });

    const archiveHeadResponse = await app.request(archive.downloadUrl, {
      method: 'HEAD',
      headers: { Authorization: mcpHeaders.Authorization },
    });
    assert.equal(archiveHeadResponse.status, 200);
    assert.equal(archiveHeadResponse.headers.get('content-length'), String(archive.bytes));

    const archiveResponse = await app.request(archive.downloadUrl, {
      headers: { Authorization: mcpHeaders.Authorization },
    });
    assert.equal(archiveResponse.status, 302);
    const storageUrl = new URL(archiveResponse.headers.get('location')!);
    const zip = await fixture.storage.getObjectBuffer(decodeURIComponent(storageUrl.pathname.slice(1)));
    assert.equal(zip.byteLength, archive.bytes);
    assert.equal(createHash('sha256').update(zip).digest('hex'), archive.sha256);

    // Another OAuth user in the SAME workspace cannot download (GET/HEAD) or replay User A's archive.
    const sameWorkspaceOtherToken = `om_oat_${'b'.repeat(40)}`;
    await authStore.createOAuthToken({
      clientId: 'oauth-client-other-user',
      userId: otherUserId,
      workspaceId,
      accessTokenHash: createHash('sha256').update(sameWorkspaceOtherToken).digest('hex'),
      refreshTokenHash: null,
      scope: DEFAULT_PAT_SCOPES.join(' '),
      resource: `${config.APP_PUBLIC_ORIGIN}/mcp`,
      accessExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: null,
    });
    const otherOAuthHeaders = {
      Authorization: `Bearer ${sameWorkspaceOtherToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    assert.equal(
      (await app.request(archive.downloadUrl, { headers: { Authorization: otherOAuthHeaders.Authorization } })).status,
      404,
    );
    assert.equal(
      (
        await app.request(archive.downloadUrl, {
          method: 'HEAD',
          headers: { Authorization: otherOAuthHeaders.Authorization },
        })
      ).status,
      404,
    );
    const otherInitRes = await app.request('/mcp', {
      method: 'POST',
      headers: otherOAuthHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'codex-other-user-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(otherInitRes.status, 200);
    const otherMcpSessionId = otherInitRes.headers.get('mcp-session-id');
    assert.ok(otherMcpSessionId);
    const otherReplayRes = await app.request('/mcp', {
      method: 'POST',
      headers: { ...otherOAuthHeaders, 'Mcp-Session-Id': otherMcpSessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'openmotion_project_archive', arguments: exportArgs },
      }),
    });
    assert.equal(otherReplayRes.status, 200);
    const otherReplayJson = (await otherReplayRes.json()) as {
      result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } };
    };
    assert.equal(otherReplayJson.result?.isError, true);
    assert.equal(otherReplayJson.result?.structuredContent?.error?.code, 'PROJECT_NOT_FOUND');

    // Confirm the same-workspace colleague OAuth token can export and download its own project archive.
    const otherExportRes = await app.request('/mcp', {
      method: 'POST',
      headers: { ...otherOAuthHeaders, 'Mcp-Session-Id': otherMcpSessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'openmotion_project_archive',
          arguments: { action: 'export', projectIds: [otherUserProject], requestId: 'archive-export-other-user' },
        },
      }),
    });
    assert.equal(otherExportRes.status, 200);
    const otherExportJson = (await otherExportRes.json()) as {
      result?: { isError?: boolean; structuredContent?: { downloadUrl?: string } };
    };
    assert.equal(otherExportJson.result?.isError, undefined, JSON.stringify(otherExportJson.result));
    const otherDownloadUrl = otherExportJson.result?.structuredContent?.downloadUrl!;
    assert.equal(
      (await app.request(otherDownloadUrl, { headers: { Authorization: otherOAuthHeaders.Authorization } })).status,
      302,
    );
    assert.equal(
      (await app.request(otherDownloadUrl, { headers: { Authorization: mcpHeaders.Authorization } })).status,
      404,
    );

    // Permanently deleting an exported project must keep the archive readable and replayable by its exporter,
    // while keeping it inaccessible to other OAuth users in the same workspace.
    const disposableProj = await createProj('Disposable Export Project');
    const disposableExportArgs = {
      action: 'export',
      projectIds: [disposableProj],
      requestId: 'archive-export-survives-delete',
    };
    const disposableExportRes = await callTool(22, 'openmotion_project_archive', disposableExportArgs);
    assert.equal(disposableExportRes.result?.isError, undefined, JSON.stringify(disposableExportRes.result));
    const disposableArchive = disposableExportRes.result?.structuredContent as {
      archiveId: string; downloadUrl: string;
    };
    const disposableRowIdx = pgClient.rows('projects').findIndex((row) => row.id === disposableProj);
    assert.ok(disposableRowIdx >= 0);
    pgClient.rows('projects').splice(disposableRowIdx, 1);

    assert.equal(
      (await app.request(disposableArchive.downloadUrl, { method: 'HEAD', headers: { Authorization: mcpHeaders.Authorization } })).status,
      200,
    );
    assert.equal(
      (await app.request(disposableArchive.downloadUrl, { headers: { Authorization: mcpHeaders.Authorization } })).status,
      302,
    );
    const disposableReplay = await callTool(23, 'openmotion_project_archive', disposableExportArgs);
    assert.equal(disposableReplay.result?.isError, undefined, JSON.stringify(disposableReplay.result));
    assert.equal((disposableReplay.result?.structuredContent as { replayed?: boolean })?.replayed, true);
    assert.equal(
      'ownerUserId' in ((disposableReplay.result?.structuredContent as Record<string, unknown>) ?? {}),
      false,
    );
    assert.equal(
      (await app.request(disposableArchive.downloadUrl, { headers: { Authorization: otherOAuthHeaders.Authorization } })).status,
      404,
    );

    // Sweeping expired archive:export receipts after 30 days must not revoke OAuth download access
    // for the exporter (nor widen access to other OAuth users in the same workspace).
    const receiptIdx = pgClient
      .rows('idempotency_receipts')
      .findIndex((row) => row.scope === 'archive:export' && row.resource_id === disposableArchive.archiveId);
    assert.ok(receiptIdx >= 0);
    pgClient.rows('idempotency_receipts').splice(receiptIdx, 1);
    assert.equal(
      (await app.request(disposableArchive.downloadUrl, { method: 'HEAD', headers: { Authorization: mcpHeaders.Authorization } })).status,
      200,
    );
    assert.equal(
      (await app.request(disposableArchive.downloadUrl, { headers: { Authorization: mcpHeaders.Authorization } })).status,
      302,
    );
    assert.equal(
      (await app.request(disposableArchive.downloadUrl, { method: 'HEAD', headers: { Authorization: otherOAuthHeaders.Authorization } })).status,
      404,
    );
    assert.equal(
      (await app.request(disposableArchive.downloadUrl, { headers: { Authorization: otherOAuthHeaders.Authorization } })).status,
      404,
    );

    const owner = { ...agent, role: 'owner' as const, authMethod: 'session_cookie' as const };
    const pat = await createPat(authStore, owner, { name: 'Archive download', scopes: ['projects:read'] });
    const patHeaders = { Authorization: `Bearer ${pat.token}` };
    assert.equal((await app.request(archive.downloadUrl, { headers: patHeaders })).status, 302);

    const otherWorkspaceId = randomUUID();
    authStore.seedWorkspace({ userId: otherUserId, workspaceId: otherWorkspaceId, email: 'other@example.test' });
    const otherPat = await createPat(authStore, { ...owner, userId: otherUserId, workspaceId: otherWorkspaceId }, {
      name: 'Another workspace download', scopes: ['projects:read'],
    });
    assert.equal((await app.request(archive.downloadUrl, {
      headers: { Authorization: `Bearer ${otherPat.token}` },
    })).status, 404);

    const uploadUrl = `${config.APP_PUBLIC_ORIGIN}/motion-api/project-archives/import?requestId=archive-upload-e2e`;
    const uploadOptions = {
      method: 'POST', body: new Uint8Array(zip),
      headers: { Authorization: mcpHeaders.Authorization, 'Content-Type': 'application/zip' },
    };
    assert.equal((await app.request(uploadUrl, { ...uploadOptions, headers: patHeaders })).status, 403);
    const uploaded = await app.request(uploadUrl, uploadOptions);
    assert.equal(uploaded.status, 201);
    const imported = (await uploaded.json()) as { imported: Array<{ projectId: string }> };
    assert.equal(imported.imported.length, 1);
    assert.notEqual(imported.imported[0].projectId, projectB);
    const uploadRetry = await app.request(uploadUrl, uploadOptions);
    assert.equal(uploadRetry.status, 200);
    assert.deepEqual((await uploadRetry.json() as typeof imported).imported, imported.imported);
    const otherImportReplay = await app.request(uploadUrl, {
      ...uploadOptions,
      headers: { Authorization: otherOAuthHeaders.Authorization, 'Content-Type': 'application/zip' },
    });
    assert.equal(otherImportReplay.status, 404);

    // Overlapping ZIP upload retries with the same requestId must claim the receipt atomically and never create duplicate projects.
    const projectsBeforeRace = pgClient.rows('projects').length;
    const raceUploadUrl = `${config.APP_PUBLIC_ORIGIN}/motion-api/project-archives/import?requestId=archive-upload-race`;
    const originalCreateProject = workspace.createProject.bind(workspace);
    let releaseCreateProject!: () => void;
    let markCreateProjectEntered!: () => void;
    const createProjectEntered = new Promise<void>((resolve) => {
      markCreateProjectEntered = resolve;
    });
    const createProjectGate = new Promise<void>((resolve) => {
      releaseCreateProject = resolve;
    });
    let intercepted = false;
    workspace.createProject = (async (...args: Parameters<typeof workspace.createProject>) => {
      if (!intercepted) {
        intercepted = true;
        markCreateProjectEntered();
        await createProjectGate;
      }
      return originalCreateProject(...args);
    }) as typeof workspace.createProject;
    try {
      const firstUploadPromise = app.request(raceUploadUrl, uploadOptions);
      await createProjectEntered;
      const overlappingRetry = await app.request(raceUploadUrl, uploadOptions);
      assert.equal(overlappingRetry.status, 409);
      const conflictBody = (await overlappingRetry.json()) as { code?: string };
      assert.equal(conflictBody.code, 'REQUEST_ID_CONFLICT');
      releaseCreateProject();
      const firstUploadRes = await firstUploadPromise;
      assert.equal(firstUploadRes.status, 201);
      const firstImported = (await firstUploadRes.json()) as { imported: Array<{ projectId: string }>; replayed: boolean };
      assert.equal(firstImported.replayed, false);
      assert.equal(firstImported.imported.length, 1);
      assert.equal(pgClient.rows('projects').length, projectsBeforeRace + 1);
      const settledRetry = await app.request(raceUploadUrl, uploadOptions);
      assert.equal(settledRetry.status, 200);
      const settledBody = (await settledRetry.json()) as { imported: Array<{ projectId: string }>; replayed: boolean };
      assert.equal(settledBody.replayed, true);
      assert.deepEqual(settledBody.imported, firstImported.imported);
    } finally {
      workspace.createProject = originalCreateProject;
    }

    // A stale pending import receipt (e.g. left behind after a worker crash/OOM) can be reclaimed on retry with the same requestId.
    const completedRaceReceipt = pgClient
      .rows('idempotency_receipts')
      .find((row) => row.scope === 'archive:import' && row.request_id === 'archive-upload-race')!;
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    pgClient.seed('idempotency_receipts', {
      workspace_id: workspaceId,
      scope: 'archive:import',
      request_id: 'archive-upload-stale',
      input_hash: completedRaceReceipt.input_hash,
      state: 'pending',
      resource_id: null,
      response_payload: null,
      created_at: staleTimestamp,
      updated_at: staleTimestamp,
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const projectsBeforeStale = pgClient.rows('projects').length;
    const staleUploadUrl = `${config.APP_PUBLIC_ORIGIN}/motion-api/project-archives/import?requestId=archive-upload-stale`;
    const reclaimedRes = await app.request(staleUploadUrl, uploadOptions);
    assert.equal(reclaimedRes.status, 201);
    const reclaimedBody = (await reclaimedRes.json()) as { imported: Array<{ projectId: string }>; replayed: boolean };
    assert.equal(reclaimedBody.replayed, false);
    assert.equal(reclaimedBody.imported.length, 1);
    assert.equal(pgClient.rows('projects').length, projectsBeforeStale + 1);
    const reclaimedRetry = await app.request(staleUploadUrl, uploadOptions);
    assert.equal(reclaimedRetry.status, 200);
    const reclaimedRetryBody = (await reclaimedRetry.json()) as { imported: Array<{ projectId: string }>; replayed: boolean };
    assert.equal(reclaimedRetryBody.replayed, true);
    assert.deepEqual(reclaimedRetryBody.imported, reclaimedBody.imported);

    // An active slow import exceeding the lease duration refreshes its lease via heartbeat so
    // an overlapping retry with the same requestId still gets 409 REQUEST_ID_CONFLICT instead of duplicating projects.
    const shortLeaseArchive = new ProjectArchiveService({
      db: drizzle({ client: pgClient as never, schema }) as unknown as Database,
      storage: fixture.storage,
      workspace,
      files: fixture.services.files,
      publicOrigin: config.APP_PUBLIC_ORIGIN,
      pendingImportLeaseMs: 80,
      pendingImportHeartbeatMs: 20,
    });
    const projectsBeforeSlow = pgClient.rows('projects').length;
    const origCreateForSlow = workspace.createProject.bind(workspace);
    let releaseSlowCreate!: () => void;
    let markSlowEntered!: () => void;
    const slowEntered = new Promise<void>((resolve) => {
      markSlowEntered = resolve;
    });
    const slowGate = new Promise<void>((resolve) => {
      releaseSlowCreate = resolve;
    });
    let slowIntercepted = false;
    workspace.createProject = (async (...args: Parameters<typeof workspace.createProject>) => {
      if (!slowIntercepted) {
        slowIntercepted = true;
        markSlowEntered();
        await slowGate;
      }
      return origCreateForSlow(...args);
    }) as typeof workspace.createProject;
    try {
      const slowRequestId = 'archive-upload-lease-refresh';
      const slowImportPromise = shortLeaseArchive.importProjects(agent, {
        requestId: slowRequestId,
        zipBytes: zip,
      });
      await slowEntered;
      const initialReceipt = pgClient
        .rows('idempotency_receipts')
        .find((row) => row.scope === 'archive:import' && row.request_id === slowRequestId)!;
      const initialUpdatedMs =
        initialReceipt.updated_at instanceof Date
          ? initialReceipt.updated_at.getTime()
          : Date.parse(String(initialReceipt.updated_at));
      // Wait longer than the 80ms lease so the 20ms heartbeat must refresh updated_at to prevent reclaim.
      await new Promise((resolve) => setTimeout(resolve, 140));
      const refreshedReceipt = pgClient
        .rows('idempotency_receipts')
        .find((row) => row.scope === 'archive:import' && row.request_id === slowRequestId)!;
      const refreshedUpdatedMs =
        refreshedReceipt.updated_at instanceof Date
          ? refreshedReceipt.updated_at.getTime()
          : Date.parse(String(refreshedReceipt.updated_at));
      assert.ok(refreshedUpdatedMs > initialUpdatedMs, 'heartbeat must refresh pending receipt updated_at');

      await assert.rejects(
        shortLeaseArchive.importProjects(agent, { requestId: slowRequestId, zipBytes: zip }),
        (err: unknown) => err instanceof CloudError && err.code === 'REQUEST_ID_CONFLICT' && err.status === 409,
      );

      releaseSlowCreate();
      const slowResult = await slowImportPromise;
      assert.equal(slowResult.replayed, false);
      assert.equal(slowResult.imported.length, 1);
      assert.equal(pgClient.rows('projects').length, projectsBeforeSlow + 1);

      const slowReplay = await shortLeaseArchive.importProjects(agent, {
        requestId: slowRequestId,
        zipBytes: zip,
      });
      assert.equal(slowReplay.replayed, true);
      assert.deepEqual(slowReplay.imported, slowResult.imported);
    } finally {
      workspace.createProject = origCreateForSlow;
    }

    // 2. Accessing another user's project returns PROJECT_NOT_FOUND with environment diagnostics
    const readOther = await callTool(4, 'openmotion_get_project', { projectId: otherUserProject });
    assert.equal(readOther.result?.isError, true);
    const errObj = readOther.result?.structuredContent?.error as {
      code?: string;
      details?: { serverOrigin?: string; installGuideUrl?: string; connectPageUrl?: string; hint?: string };
    };
    assert.equal(errObj?.code, 'PROJECT_NOT_FOUND');
    assert.equal(errObj?.details?.serverOrigin, 'https://motion.example.test');
    assert.equal(errObj?.details?.installGuideUrl, 'https://motion.example.test/install.md');
    assert.equal(errObj?.details?.connectPageUrl, 'https://motion.example.test/mcp-setup');
    assert.match(errObj?.details?.hint ?? '', /motion\.example\.test\/mcp-setup/);
    assert.doesNotMatch(errObj?.details?.hint ?? '', /\/install\.md/);

    const prepOther = await callTool(5, 'openmotion_import_assets', {
      action: 'prepare_upload',
      projectId: otherUserProject,
      requestId: 'req_prep_other_1',
      files: [{ itemId: 'file-1', filename: 'hero.png', bytes: 1024, mimeType: 'image/png' }],
    });
    assert.equal(prepOther.result?.isError, true);
    assert.match(JSON.stringify(prepOther.result), /PROJECT_NOT_FOUND/);

    // 3. Media jobs on own projects are visible (with remoteTerminal); another user's jobs remain hidden
    const jobAId = randomUUID();
    const jobASavePendingId = randomUUID();
    const jobOtherId = randomUUID();
    const nowIso = new Date().toISOString();
    pgClient.seed('jobs', {
      id: jobAId,
      workspace_id: workspaceId,
      project_id: projectA,
      kind: 'media_generate',
      state: 'failed',
      stage: 'failed',
      remote_id: 'upstream-remote-a',
      remote_terminal: false,
      save_pending: false,
      request_id: 'req_job_a',
      idempotency_key: 'req_job_a',
      input_payload: { modality: 'image', mode: 'text-to-image', modelId: 'mock', prompt: 'Owner prompt A' },
      created_at: nowIso,
      updated_at: nowIso,
    });
    pgClient.seed('jobs', {
      id: jobASavePendingId,
      workspace_id: workspaceId,
      project_id: projectA,
      kind: 'media_generate',
      state: 'failed',
      stage: 'failed',
      remote_id: 'upstream-remote-a-save',
      remote_terminal: true,
      save_pending: true,
      request_id: 'req_job_a_save',
      idempotency_key: 'req_job_a_save',
      input_payload: { modality: 'image', mode: 'text-to-image', modelId: 'mock', prompt: 'Owner save A' },
      created_at: nowIso,
      updated_at: nowIso,
    });
    pgClient.seed('jobs', {
      id: jobOtherId,
      workspace_id: workspaceId,
      project_id: otherUserProject,
      kind: 'media_generate',
      state: 'failed',
      stage: 'failed',
      remote_id: 'upstream-remote-other',
      remote_terminal: false,
      save_pending: false,
      request_id: 'req_job_other',
      idempotency_key: 'req_job_other',
      input_payload: { modality: 'image', mode: 'text-to-image', modelId: 'mock', prompt: 'Secret prompt Other' },
      created_at: nowIso,
      updated_at: nowIso,
    });

    const listAllRes = await callTool(6, 'openmotion_assets_use', { action: 'jobs' });
    assert.equal(listAllRes.result?.isError, undefined, JSON.stringify(listAllRes.result));
    const listedAll = (listAllRes.result?.structuredContent?.jobs ?? []) as Array<{ id: string; projectId: string; remoteTerminal?: boolean }>;
    assert.equal(listedAll.length, 2);
    assert.ok(listedAll.every((j) => j.projectId === projectA));
    assert.equal(listedAll.find((j) => j.id === jobAId)?.remoteTerminal, false);
    assert.equal(listedAll.find((j) => j.id === jobASavePendingId)?.remoteTerminal, true);
    assert.doesNotMatch(JSON.stringify(listAllRes.result), /Secret prompt Other/);

    const restListAll = await app.request('/motion-api/models/jobs', {
      headers: { Authorization: `Bearer ${rawAccessToken}` },
    });
    assert.equal(restListAll.status, 200);
    const restListAllBody = (await restListAll.json()) as { jobs: Array<{ id: string; projectId: string; remoteTerminal?: boolean }> };
    assert.equal(restListAllBody.jobs.length, 2);
    assert.ok(restListAllBody.jobs.every((j) => j.projectId === projectA));
    assert.equal(restListAllBody.jobs.find((j) => j.id === jobAId)?.remoteTerminal, false);
    assert.equal(restListAllBody.jobs.find((j) => j.id === jobASavePendingId)?.remoteTerminal, true);

    // 3b. listJobs with non-UUID projectId must return empty (never fall back to workspace-wide list)
    const restListBadId = await app.request('/motion-api/models/jobs?projectId=not-a-uuid', {
      headers: { Authorization: `Bearer ${rawAccessToken}` },
    });
    assert.equal(restListBadId.status, 200);
    assert.equal(((await restListBadId.json()) as { jobs: unknown[] }).jobs.length, 0);

    const restListOther = await app.request(`/motion-api/models/jobs?projectId=${otherUserProject}`, {
      headers: { Authorization: `Bearer ${rawAccessToken}` },
    });
    assert.equal(restListOther.status, 404);

    const resumeOwn = await callTool(7, 'openmotion_media_use', {
      action: 'resume',
      jobId: jobAId,
      requestId: 'req_resume_a_1',
    });
    assert.equal(resumeOwn.result?.isError, undefined);

    const resumeOther = await callTool(8, 'openmotion_media_use', {
      action: 'resume',
      jobId: jobOtherId,
      requestId: 'req_resume_other_1',
    });
    assert.equal(resumeOther.result?.isError, true);
    assert.match(JSON.stringify(resumeOther.result), /PROJECT_NOT_FOUND/);
  });
});

describe('Cloud API Entrypoint — OAuth Agent Project Visibility', () => {
  it('shows an OAuth agent all projects owned by its user while hiding other users projects across catalog, REST and MCP', async () => {
    const fixture = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const { app, config, pgClient, authStore } = fixture;
    const userId = config.DEV_USER_ID;
    const otherUserId = randomUUID();
    const workspaceId = config.DEV_WORKSPACE_ID;
    const clientId = 'oauth-client-visibility';
    authStore.seedWorkspace({ userId, workspaceId, email: 'owner@example.test', displayName: 'Owner' });
    const rawAccessToken = `om_oat_${'v'.repeat(40)}`;
    await authStore.createOAuthToken({
      clientId,
      userId,
      workspaceId,
      accessTokenHash: createHash('sha256').update(rawAccessToken).digest('hex'),
      refreshTokenHash: null,
      scope: DEFAULT_PAT_SCOPES.join(' '),
      resource: `${config.APP_PUBLIC_ORIGIN}/mcp`,
      accessExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: null,
    });

    const createProj = async (title: string): Promise<string> => {
      const res = await app.request('/motion-api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      assert.equal(res.status, 201);
      return ((await res.json()) as { projectId: string }).projectId;
    };
    const projectA = await createProj('Owner Web Project A');
    const projectB = await createProj('Owner Web Project B');
    const otherUserProject = await createProj('Other User Project C');
    const otherRow = pgClient.rows('projects').find(row => row.id === otherUserProject)!;
    otherRow.owner_user_id = otherUserId;
    const sessionA = pgClient.rows('projects').find(row => row.id === projectA)!.session_id as string;
    const otherSession = otherRow.session_id as string;

    const workspace = fixture.services.workspace;
    const agent: AuthContext = {
      authMode: 'oidc', authMethod: 'oauth_bearer', role: 'editor', scopes: DEFAULT_PAT_SCOPES,
      clientId, userId, workspaceId,
    };

    const agentCatalog = await workspace.getCatalog(agent);
    assert.deepEqual(new Set(agentCatalog.projects.map(p => p.id)), new Set([projectA, projectB]));
    assert.equal((await workspace.getSession(agent, sessionA)).artifacts[0]?.projectId, projectA);
    await assert.rejects(workspace.getSession(agent, otherSession), { code: 'SESSION_NOT_FOUND' });
    await assert.rejects(workspace.renameSession(agent, otherSession, 'Renamed'), { code: 'SESSION_NOT_FOUND' });
    await assert.rejects(workspace.appendMessage(agent, otherSession, { content: 'hello' }), { code: 'SESSION_NOT_FOUND' });
    await assert.rejects(workspace.openSession(agent, otherSession), { code: 'SESSION_NOT_FOUND' });

    const restList = await app.request('/motion-api/projects', {
      headers: { Authorization: `Bearer ${rawAccessToken}` },
    });
    assert.equal(restList.status, 200);
    assert.deepEqual(
      new Set(((await restList.json()) as { projects: Array<{ id: string }> }).projects.map(p => p.id)),
      new Set([projectA, projectB]),
    );

    const mcpHeaders = {
      Authorization: `Bearer ${rawAccessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const initRes = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'visibility-test', version: '1.0.0' } },
      }),
    });
    assert.equal(initRes.status, 200);
    const mcpSessionId = initRes.headers.get('mcp-session-id');
    assert.ok(mcpSessionId);
    const listRes = await app.request('/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, 'Mcp-Session-Id': mcpSessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'openmotion_get_project', arguments: {} },
      }),
    });
    assert.equal(listRes.status, 200);
    const listed = ((await listRes.json()) as {
      result?: { structuredContent?: { total?: number; activeId?: string; projects?: Array<{ id: string }> } };
    }).result?.structuredContent;
    assert.equal(listed?.total, 2);
    assert.deepEqual(new Set(listed?.projects?.map(p => p.id)), new Set([projectA, projectB]));

    // A session the agent creates has no project yet and stays usable by ID.
    const agentSession = await workspace.createSession(agent, { title: 'Agent session' });
    assert.equal((await workspace.getSession(agent, agentSession.id)).id, agentSession.id);
    const agentProject = await workspace.createProject(agent, { sessionId: agentSession.id, title: 'Agent project' });
    assert.deepEqual(
      (await workspace.getSession(agent, agentSession.id)).artifacts.map(a => a.projectId),
      [agentProject.projectId],
    );
  });
});

describe('Cloud API Entrypoint — OpenDesign Console URL', () => {
  it('serves the configured OpenDesign console URL from /motion-api/account/summary', async () => {
    const readConsoleUrl = async (overrides: Record<string, string>) => {
      const { app } = createApiFixture({ config: { AUTH_MODE: 'dev', ...overrides } });
      const res = await app.request('/motion-api/account/summary');
      assert.equal(res.status, 200);
      return ((await res.json()) as { consoleUrl: string }).consoleUrl;
    };
    assert.equal(await readConsoleUrl({}), 'https://open-design.ai/cloud');
    assert.equal(
      await readConsoleUrl({ OPENDESIGN_CONSOLE_URL: 'https://console.example.test/cloud' }),
      'https://console.example.test/cloud',
    );
  });

  it('serializes remoteTerminal on media jobs so terminal failures are distinguishable from resumable jobs', async () => {
    const { app, config, pgClient } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const workspaceId = config.DEV_WORKSPACE_ID;
    const nowIso = new Date().toISOString();
    const terminalJobId = randomUUID();
    const resumableJobId = randomUUID();

    pgClient.seed('jobs', {
      id: terminalJobId,
      workspace_id: workspaceId,
      project_id: null,
      kind: 'media_generate',
      state: 'failed',
      stage: 'failed',
      remote_id: 'mit_terminal_balance',
      remote_terminal: true,
      save_pending: false,
      error_code: 'insufficient_balance',
      error_message: 'Your OpenDesign balance is too low for this request. Top up in OpenDesign Console, then try again.',
      result_json: { error: { code: 'insufficient_balance', outcomeUnknown: false } },
      request_id: 'req_terminal_1',
      idempotency_key: 'req_terminal_1',
      input_payload: { modality: 'image', mode: 'text-to-image', modelId: 'seedream-5.5', prompt: 'Amber glass bottle' },
      created_at: nowIso,
      updated_at: nowIso,
    });
    pgClient.seed('jobs', {
      id: resumableJobId,
      workspace_id: workspaceId,
      project_id: null,
      kind: 'media_generate',
      state: 'failed',
      stage: 'failed',
      remote_id: 'mit_unknown_timeout',
      remote_terminal: false,
      save_pending: false,
      failure_stage: 'generate',
      error_code: 'request_state_unknown',
      error_message: 'OpenDesign could not confirm whether this request ran, so it was not resubmitted. Inspect the original task before retrying.',
      result_json: { error: { code: 'request_state_unknown', outcomeUnknown: true } },
      request_id: 'req_resumable_1',
      idempotency_key: 'req_resumable_1',
      input_payload: { modality: 'image', mode: 'text-to-image', modelId: 'seedream-5.5', prompt: 'Amber glass bottle' },
      created_at: nowIso,
      updated_at: nowIso,
    });

    const terminalRes = await app.request(`/motion-api/models/jobs/${terminalJobId}`);
    assert.equal(terminalRes.status, 200);
    const terminalBody = (await terminalRes.json()) as { job: { remoteTerminal?: boolean; errorCode?: string } };
    assert.equal(terminalBody.job.remoteTerminal, true);
    assert.equal(terminalBody.job.errorCode, 'insufficient_balance');

    const resumableRes = await app.request(`/motion-api/models/jobs/${resumableJobId}`);
    assert.equal(resumableRes.status, 200);
    const resumableBody = (await resumableRes.json()) as {
      job: { remoteTerminal?: boolean; errorCode?: string; failureStage?: string };
    };
    assert.equal(resumableBody.job.remoteTerminal, false);
    assert.equal(resumableBody.job.errorCode, 'request_state_unknown');
    assert.equal(resumableBody.job.failureStage, 'generate');

    const phase1ListRes = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'openmotion_assets_use', arguments: { action: 'jobs' } }),
    });
    assert.equal(phase1ListRes.status, 200);
    const phase1Jobs = ((await phase1ListRes.json()) as { jobs: Array<{ id: string; remoteTerminal?: boolean }> }).jobs;
    assert.equal(phase1Jobs.find((j) => j.id === terminalJobId)?.remoteTerminal, true);
    assert.equal(phase1Jobs.find((j) => j.id === resumableJobId)?.remoteTerminal, false);

    const resumeTerminalRes = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'resume', jobId: terminalJobId, requestId: `resume-${terminalJobId}` },
      }),
    });
    assert.equal(resumeTerminalRes.status, 409);

    const resumeActiveRes = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'resume', jobId: resumableJobId, requestId: `resume-${resumableJobId}` },
      }),
    });
    assert.equal(resumeActiveRes.status, 200);
    const resumed = (await resumeActiveRes.json()) as { job: { state: string; failureStage?: string } };
    assert.equal(resumed.job.state, 'queued');
    assert.equal(resumed.job.failureStage, undefined);

    const statusAfterResume = await app.request(`/motion-api/models/jobs/${resumableJobId}`);
    assert.equal(statusAfterResume.status, 200);
    const resumedStatus = (await statusAfterResume.json()) as { job: { state: string; failureStage?: string } };
    assert.equal(resumedStatus.job.state, 'queued');
    assert.equal(resumedStatus.job.failureStage, undefined);
  });

  it('imports a library PNG via openmotion_assets_use(action=import_to_project) after Undo without version collision', async () => {
    const { app, config, pgClient, storage } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const workspaceId = config.DEV_WORKSPACE_ID;
    const nowIso = new Date().toISOString();

    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const pngSha = createHash('sha256').update(pngBytes).digest('hex');
    const s3Key = `workspaces/${workspaceId}/blobs/${pngSha}`;
    await storage.putObject(s3Key, pngBytes, 'image/png');

    const assetId = randomUUID();
    const versionId = randomUUID();
    pgClient.seed('workspace_blobs', {
      workspace_id: workspaceId,
      sha256: pngSha,
      size_bytes: pngBytes.length,
      mime_type: 'image/png',
      s3_key: s3Key,
      metadata: { modality: 'image', width: 1, height: 1, mimeType: 'image/png' },
      ref_count: 1,
      zero_ref_since: null,
      gc_state: 'active',
      created_at: nowIso,
    });
    pgClient.seed('assets', {
      id: assetId,
      workspace_id: workspaceId,
      name: 'openmotion-s06-qa.png',
      modality: 'image',
      current_version_id: versionId,
      trashed: false,
      trashed_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    });
    pgClient.seed('asset_versions', {
      id: versionId,
      workspace_id: workspaceId,
      asset_id: assetId,
      source: 'upload',
      filename: 'openmotion-s06-qa.png',
      display_name: null,
      sha256: pngSha,
      size_bytes: pngBytes.length,
      mime_type: 'image/png',
      width: 1,
      height: 1,
      duration_sec: null,
      prompt: null,
      model: null,
      parameters: null,
      references: [],
      parent_version_id: null,
      job_id: null,
      request_id: null,
      request_hash: null,
      provider_result: null,
      created_at: nowIso,
    });

    // 1. Create a project, make an edit, then Undo (rewinding current_version_number from 2 -> 1).
    const createRes = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'QA Rerun 90', requestId: randomUUID() }),
    });
    assert.equal(createRes.status, 201);
    const projectId = ((await createRes.json()) as { projectId: string }).projectId;

    const readRes = await app.request(`/api/projects/${projectId}/files/index.html`);
    assert.equal(readRes.status, 200);
    const html = await readRes.text();
    const etag = readRes.headers.get('etag');

    const editRes = await app.request(`/api/projects/${projectId}/files/index.html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
      body: JSON.stringify({ content: `${html}\n<!-- right-trim edit -->\n`, requestId: randomUUID() }),
    });
    assert.equal(editRes.status, 200);

    const undoRes = await app.request(`/api/projects/${projectId}/history/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(undoRes.status, 200);
    const undoBody = (await undoRes.json()) as { versionNumber: number; seq: number; canRedo: boolean };
    assert.equal(undoBody.versionNumber, 1);
    assert.equal(undoBody.canRedo, true);

    // 2. Import the library PNG version via POST /motion-api/phase1/call (exact Studio path).
    const importRes = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: {
          action: 'import_to_project',
          projectId,
          requestId: randomUUID(),
          assetId,
          versionId,
        },
      }),
    });
    assert.equal(importRes.status, 200);
    const imported = (await importRes.json()) as {
      projectId: string;
      status: string;
      items: Array<{ itemId: string; status: string; path?: string; assetId?: string; versionId?: string; zeroCopy?: boolean }>;
    };
    const expectedPath = `assets/imported/${assetId}.png`;
    assert.equal(imported.projectId, projectId);
    assert.equal(imported.status, 'completed');
    assert.equal(imported.items.length, 1);
    assert.equal(imported.items[0].itemId, `library-${assetId}-${versionId}`);
    assert.equal(imported.items[0].status, 'imported');
    assert.equal(imported.items[0].path, expectedPath);
    assert.equal(imported.items[0].zeroCopy, true);

    // 3. Verify the editor project listing includes the imported PNG and advanced past the undone version.
    const listingRes = await app.request(`/api/projects/${projectId}?view=editor`);
    assert.equal(listingRes.status, 200);
    const listing = (await listingRes.json()) as { files: string[]; versionNumber: number; historySeq: number };
    assert.ok(listing.files.includes(expectedPath), `expected ${expectedPath} in ${JSON.stringify(listing.files)}`);
    assert.equal(listing.versionNumber, 3);
    assert.equal(listing.historySeq, 3);

    // 4. Verify Undo removes the imported asset cleanly and Redo brings it back.
    const undoImportRes = await app.request(`/api/projects/${projectId}/history/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(undoImportRes.status, 200);
    const afterUndoListing = (await (await app.request(`/api/projects/${projectId}?view=editor`)).json()) as {
      files: string[];
    };
    assert.ok(!afterUndoListing.files.includes(expectedPath));

    const redoImportRes = await app.request(`/api/projects/${projectId}/history/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction: 'redo' }),
    });
    assert.equal(redoImportRes.status, 200);
    const afterRedoListing = (await (await app.request(`/api/projects/${projectId}?view=editor`)).json()) as {
      files: string[];
    };
    assert.ok(afterRedoListing.files.includes(expectedPath));
  });
});
