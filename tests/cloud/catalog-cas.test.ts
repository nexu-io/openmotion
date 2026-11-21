import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { DEFAULT_PAT_SCOPES, type AuthContext } from '../../src/contracts/auth.ts';
import type {
  HeadObjectResult,
  ObjectStreamResult,
  PresignGetOptions,
  PresignPutOptions,
  StoragePort,
} from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import * as schema from '../../src/db/schema/index.ts';
import { catalogBlobKey } from '../../src/infra/storage.ts';
import type { HotTextCache } from '../../src/infra/redis.ts';
import { createCatalogRoutes, type CatalogRouteEnv } from '../../src/routes/catalog.ts';
import {
  BUILTIN_TEMPLATES,
  CatalogService,
  GSAP_CDN_URL,
  WELCOME_PROJECT_TITLE,
  WELCOME_PROJECT_TITLE_KEY,
  WELCOME_SHARED_ASSETS,
  WELCOME_TEMPLATE_ID,
} from '../../src/services/catalog-service.ts';
import {
  WelcomeBootstrapService,
  ensureWelcomeProject,
} from '../../src/services/welcome-bootstrap.ts';
import {
  assembleBuiltinTemplate,
  extractCatalogFileMetadata,
  parseSyncCatalogArgs,
  syncCatalogCas,
} from '../../scripts/sync-catalog-cas.ts';
import { computeProjectRevision } from '../../shared/project-validation.ts';

const WID_A = '11111111-1111-4111-8111-111111111111';
const WID_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    workspaceId: WID_A,
    userId: USER_A,
    role: 'owner',
    scopes: [...DEFAULT_PAT_SCOPES],
    authMode: 'dev',
    authMethod: 'dev_bypass',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Deterministic In-Memory S3 Storage Mock
// ---------------------------------------------------------------------------

interface MockStorageObject {
  body: Buffer;
  contentType: string;
  etag: string;
}

class MockStorage implements StoragePort {
  readonly objects = new Map<string, MockStorageObject>();
  putCalls = 0;
  headCalls = 0;
  getCalls = 0;
  presignGetCalls = 0;
  readonly presignHistory: Array<{ key: string; options?: PresignGetOptions }> = [];

  async putObject(
    key: string,
    body: Buffer | Uint8Array | Readable | string,
    contentType: string,
    _contentLength?: number,
  ): Promise<void> {
    this.putCalls++;
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
    const sha = createHash('sha256').update(buf).digest('hex');
    this.objects.set(key, { body: buf, contentType, etag: `"${sha}"` });
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    const existing = await this.headObject(key);
    if (existing && existing.contentLength === body.byteLength) {
      return { uploaded: false };
    }
    await this.putObject(key, body, contentType, body.byteLength);
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    this.getCalls++;
    const found = this.objects.get(key);
    if (!found) {
      throw new Error(`NoSuchKey: ${key}`);
    }
    return Buffer.from(found.body);
  }

  async getObjectStream(key: string): Promise<ObjectStreamResult> {
    const buf = await this.getObjectBuffer(key);
    const meta = this.objects.get(key)!;
    return {
      stream: Readable.from([buf]),
      contentLength: buf.byteLength,
      contentType: meta.contentType,
      etag: meta.etag,
    };
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    this.headCalls++;
    const found = this.objects.get(key);
    if (!found) return null;
    return {
      contentLength: found.body.byteLength,
      contentType: found.contentType,
      etag: found.etag,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  async presignPut(key: string, options: PresignPutOptions): Promise<string> {
    return `https://s3.example.test/openmotion/${key}?X-Amz-Signature=put&ttl=${options.expiresInSec ?? 900}`;
  }

  async presignGet(key: string, options?: PresignGetOptions): Promise<string> {
    this.presignGetCalls++;
    this.presignHistory.push({ key, options });
    const params = new URLSearchParams({
      'X-Amz-Signature': 'mock-sig',
      'X-Amz-Expires': String(options?.expiresInSec ?? 300),
    });
    if (options?.responseContentType) {
      params.set('response-content-type', options.responseContentType);
    }
    if (options?.responseContentDisposition) {
      params.set('response-content-disposition', options.responseContentDisposition);
    }
    return `https://s3.example.test/openmotion/${key}?${params.toString()}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Deterministic In-Memory HotTextCache Mock
// ---------------------------------------------------------------------------

class MockHotTextCache {
  readonly entries = new Map<string, string>();
  getCalls = 0;
  setCalls = 0;

  async getText(sha256: string): Promise<string | null> {
    this.getCalls++;
    return this.entries.get(sha256) ?? null;
  }

  async setText(sha256: string, content: string): Promise<boolean> {
    this.setCalls++;
    this.entries.set(sha256, content);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Deterministic In-Memory PostgreSQL Driver for Real Drizzle ORM Execution
// Supports transactions, rollback, row-level FOR UPDATE locks on workspaces,
// JSONB, UPSERT (ON CONFLICT DO UPDATE), DELETE, UPDATE ... RETURNING, and
// query audit logs so tests run real Drizzle SQL with zero external services.
// ---------------------------------------------------------------------------

type RowRecord = Record<string, unknown>;

interface TableStore {
  workspaces: RowRecord[];
  catalog_templates: RowRecord[];
  catalog_template_files: RowRecord[];
  sessions: RowRecord[];
  projects: RowRecord[];
  project_files: RowRecord[];
  project_versions: RowRecord[];
  project_version_files: RowRecord[];
  project_history_entries: RowRecord[];
  workspace_blobs: RowRecord[];
}

type TableName = keyof TableStore;

const JSONB_COLUMNS = new Set([
  'metadata',
  'default_models',
  'source_meta',
  'asset_name_allocations',
  'preview_display',
  'reviews',
]);

function normalizeValueForStorage(col: string, raw: unknown): unknown {
  if (raw === undefined) return null;
  if (JSONB_COLUMNS.has(col) && typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function splitTopLevelCommas(input: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        result.push(input.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  const tail = input.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function parseSqlLiteralOrParam(expr: string, params: readonly unknown[]): unknown {
  const trimmed = expr.trim();
  if (/^\$\d+$/.test(trimmed)) {
    const index = Number(trimmed.slice(1)) - 1;
    return params[index];
  }
  if (trimmed.toLowerCase() === 'default') return undefined;
  if (trimmed.toLowerCase() === 'null') return null;
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function evaluateWhere(
  row: RowRecord,
  whereClause: string | undefined,
  params: readonly unknown[],
): boolean {
  if (!whereClause || !whereClause.trim()) return true;
  let cleaned = whereClause.trim();
  while (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    // Strip wrapping parens only if balanced across the whole expression
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '(') depth++;
      else if (cleaned[i] === ')') depth--;
      if (depth === 0 && i < cleaned.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Split by top-level ` and `
  const parts: string[] = [];
  let depth = 0;
  let cursor = 0;
  const lower = cleaned.toLowerCase();
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '(') depth++;
    else if (cleaned[i] === ')') depth--;
    else if (depth === 0 && lower.slice(i, i + 5) === ' and ') {
      parts.push(cleaned.slice(cursor, i).trim());
      cursor = i + 5;
      i += 4;
    }
  }
  parts.push(cleaned.slice(cursor).trim());

  for (const clause of parts) {
    const isNullMatch = clause.match(/^(?:"[^"]+"\.)?"([^"]+)"\s+is\s+null$/i);
    if (isNullMatch) {
      const col = isNullMatch[1];
      if (row[col] !== null && row[col] !== undefined) return false;
      continue;
    }
    const isNotNullMatch = clause.match(/^(?:"[^"]+"\.)?"([^"]+)"\s+is\s+not\s+null$/i);
    if (isNotNullMatch) {
      const col = isNotNullMatch[1];
      if (row[col] === null || row[col] === undefined) return false;
      continue;
    }
    const eqMatch = clause.match(/^(?:"[^"]+"\.)?"([^"]+)"\s*=\s*(.+)$/i);
    if (eqMatch) {
      const col = eqMatch[1];
      const expected = parseSqlLiteralOrParam(eqMatch[2], params);
      if (row[col] !== expected) return false;
      continue;
    }
    throw new Error(`MockPg unsupported WHERE clause: ${clause}`);
  }
  return true;
}

class AsyncRowLockManager {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly resolvers = new Map<string, () => void>();

  async acquire(key: string): Promise<void> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, promise);
    this.resolvers.set(key, release);
  }

  release(key: string): void {
    const resolver = this.resolvers.get(key);
    this.resolvers.delete(key);
    this.locks.delete(key);
    resolver?.();
  }
}

class MockPgHarness {
  readonly tables: TableStore = {
    workspaces: [],
    catalog_templates: [],
    catalog_template_files: [],
    sessions: [],
    projects: [],
    project_files: [],
    project_versions: [],
    project_version_files: [],
    project_history_entries: [],
    workspace_blobs: [],
  };

  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  readonly lockManager = new AsyncRowLockManager();
  readonly db: Database;
  forUpdateWaitCount = 0;

  constructor() {
    const self = this;
    const createClient = () => {
      let inTx = false;
      let snapshot: TableStore | null = null;
      const heldLocks = new Set<string>();

      const releaseHeldLocks = () => {
        for (const lockKey of heldLocks) {
          self.lockManager.release(lockKey);
        }
        heldLocks.clear();
      };

      const query = async (
        queryArg: string | { text: string; values?: unknown[]; rowMode?: string },
        maybeValues?: unknown[],
      ) => {
        const text = typeof queryArg === 'string' ? queryArg : queryArg.text;
        const values =
          (typeof queryArg === 'string' ? maybeValues : (queryArg.values ?? maybeValues)) ?? [];
        const rowMode = typeof queryArg === 'string' ? undefined : queryArg.rowMode;
        const normalizedSql = text.replace(/\s+/g, ' ').trim();
        self.queries.push({ text: normalizedSql, values: [...values] });

        const lower = normalizedSql.toLowerCase();
        if (lower === 'begin') {
          inTx = true;
          snapshot = structuredClone(self.tables);
          return { rows: [], rowCount: 0, fields: [] };
        }
        if (lower === 'commit') {
          inTx = false;
          snapshot = null;
          releaseHeldLocks();
          return { rows: [], rowCount: 0, fields: [] };
        }
        if (lower === 'rollback') {
          if (inTx && snapshot) {
            (Object.keys(self.tables) as TableName[]).forEach((name) => {
              self.tables[name] = snapshot![name];
            });
          }
          inTx = false;
          snapshot = null;
          releaseHeldLocks();
          return { rows: [], rowCount: 0, fields: [] };
        }

        // Yield microtask to let concurrent transactions contend realistically.
        await Promise.resolve();

        // SELECT
        if (lower.startsWith('select ')) {
          const selectMatch = normalizedSql.match(
            /^select\s+(.+?)\s+from\s+"([^"]+)"(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+(.+?))?(?:\s+for\s+update)?$/i,
          );
          if (!selectMatch) {
            throw new Error(`MockPg unsupported SELECT: ${normalizedSql}`);
          }
          const [, colsRaw, tableNameRaw, whereRaw, orderByRaw] = selectMatch;
          const isForUpdate = /\s+for\s+update$/i.test(normalizedSql);
          const tableName = tableNameRaw as TableName;

          if (isForUpdate && tableName === 'workspaces') {
            const targetId = values[0] ? String(values[0]) : '*';
            const lockKey = `workspaces:${targetId}`;
            if (!heldLocks.has(lockKey)) {
              this.forUpdateWaitCount++;
              await self.lockManager.acquire(lockKey);
              heldLocks.add(lockKey);
              // Small async yield inside lock to guarantee overlap with concurrent callers
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          const selectedCols = splitTopLevelCommas(colsRaw).map((colExpr) => {
            const m = colExpr.match(/"([^"]+)"$/);
            return m ? m[1] : colExpr.replace(/"/g, '');
          });

          const rows = [...(self.tables[tableName] ?? [])].filter((row) =>
            evaluateWhere(row, whereRaw, values),
          );

          if (orderByRaw) {
            const orderSpecs = splitTopLevelCommas(orderByRaw).map((part) => {
              const m = part.match(/(?:"[^"]+"\.)?"([^"]+)"(?:\s+(asc|desc))?/i);
              return {
                col: m ? m[1] : part.replace(/"/g, ''),
                dir: m?.[2]?.toLowerCase() === 'desc' ? -1 : 1,
              };
            });
            rows.sort((a, b) => {
              for (const spec of orderSpecs) {
                const av = a[spec.col];
                const bv = b[spec.col];
                if (av === bv) continue;
                if (av === null || av === undefined) return -1 * spec.dir;
                if (bv === null || bv === undefined) return 1 * spec.dir;
                if (typeof av === 'number' && typeof bv === 'number') {
                  return (av - bv) * spec.dir;
                }
                return String(av).localeCompare(String(bv)) * spec.dir;
              }
              return 0;
            });
          }

          const mapped = rows.map((row) =>
            rowMode === 'array'
              ? selectedCols.map((col) => row[col] ?? null)
              : Object.fromEntries(selectedCols.map((col) => [col, row[col] ?? null])),
          );
          return { rows: mapped, rowCount: mapped.length, fields: [] };
        }

        // INSERT
        if (lower.startsWith('insert into ')) {
          const insertMatch = normalizedSql.match(
            /^insert\s+into\s+"([^"]+)"\s*\(([^)]+)\)\s*values\s+(.+?)(?:\s+on\s+conflict\s+\(([^)]+)\)\s+do\s+update\s+set\s+(.+))?$/i,
          );
          if (!insertMatch) {
            throw new Error(`MockPg unsupported INSERT: ${normalizedSql}`);
          }
          const [, tableNameRaw, colsRaw, valuesGroupsRaw, conflictColsRaw, conflictSetRaw] = insertMatch;
          const tableName = tableNameRaw as TableName;
          const cols = splitTopLevelCommas(colsRaw).map((c) => c.replace(/"/g, ''));

          const groups: string[] = [];
          let depth = 0;
          let start = -1;
          for (let i = 0; i < valuesGroupsRaw.length; i++) {
            const ch = valuesGroupsRaw[i];
            if (ch === '(') {
              if (depth === 0) start = i + 1;
              depth++;
            } else if (ch === ')') {
              depth--;
              if (depth === 0 && start >= 0) {
                groups.push(valuesGroupsRaw.slice(start, i));
                start = -1;
              }
            }
          }

          const conflictCols = conflictColsRaw
            ? splitTopLevelCommas(conflictColsRaw).map((c) => c.replace(/"/g, ''))
            : null;
          const table = self.tables[tableName];

          for (const group of groups) {
            const exprs = splitTopLevelCommas(group);
            const record: RowRecord = {};
            for (let i = 0; i < cols.length; i++) {
              const col = cols[i];
              const val = parseSqlLiteralOrParam(exprs[i], values);
              if (val === undefined) {
                if (col === 'id') record[col] = randomUUID();
                else if (col === 'created_at' || col === 'updated_at' || col === 'opened_at') {
                  record[col] = new Date();
                } else {
                  record[col] = null;
                }
              } else {
                record[col] = normalizeValueForStorage(col, val);
              }
            }

            if (conflictCols && conflictSetRaw) {
              const existing = table.find((row) =>
                conflictCols.every((c) => row[c] === record[c]),
              );
              if (existing) {
                const assignments = splitTopLevelCommas(conflictSetRaw);
                for (const assign of assignments) {
                  const m = assign.match(/^"([^"]+)"\s*=\s*(.+)$/);
                  if (!m) continue;
                  const [, targetCol, rhs] = m;
                  const val = parseSqlLiteralOrParam(rhs, values);
                  existing[targetCol] = normalizeValueForStorage(targetCol, val);
                }
                continue;
              }
            }

            table.push(record);
          }

          return { rows: [], rowCount: groups.length, fields: [] };
        }

        // DELETE
        if (lower.startsWith('delete from ')) {
          const deleteMatch = normalizedSql.match(/^delete\s+from\s+"([^"]+)"(?:\s+where\s+(.+))?$/i);
          if (!deleteMatch) {
            throw new Error(`MockPg unsupported DELETE: ${normalizedSql}`);
          }
          const [, tableNameRaw, whereRaw] = deleteMatch;
          const tableName = tableNameRaw as TableName;
          const before = self.tables[tableName].length;
          self.tables[tableName] = self.tables[tableName].filter(
            (row) => !evaluateWhere(row, whereRaw, values),
          );
          return { rows: [], rowCount: before - self.tables[tableName].length, fields: [] };
        }

        // UPDATE
        if (lower.startsWith('update ')) {
          const updateMatch = normalizedSql.match(
            /^update\s+"([^"]+)"\s+set\s+(.+?)(?:\s+where\s+(.+?))?(?:\s+returning\s+(.+))?$/i,
          );
          if (!updateMatch) {
            throw new Error(`MockPg unsupported UPDATE: ${normalizedSql}`);
          }
          const [, tableNameRaw, setRaw, whereRaw, returningRaw] = updateMatch;
          const tableName = tableNameRaw as TableName;
          const assignments = splitTopLevelCommas(setRaw).map((item) => {
            const m = item.match(/^"([^"]+)"\s*=\s*(.+)$/);
            if (!m) throw new Error(`MockPg unsupported SET assignment: ${item}`);
            return { col: m[1], expr: m[2] };
          });
          const returningCols = returningRaw
            ? splitTopLevelCommas(returningRaw).map((c) => {
                const m = c.match(/"([^"]+)"$/);
                return m ? m[1] : c.replace(/"/g, '');
              })
            : null;

          const updatedRows: RowRecord[] = [];
          for (const row of self.tables[tableName]) {
            if (!evaluateWhere(row, whereRaw, values)) continue;
            for (const assign of assignments) {
              const val = parseSqlLiteralOrParam(assign.expr, values);
              row[assign.col] = normalizeValueForStorage(assign.col, val);
            }
            updatedRows.push(row);
          }

          if (returningCols) {
            const mapped = updatedRows.map((row) =>
              rowMode === 'array'
                ? returningCols.map((col) => row[col] ?? null)
                : Object.fromEntries(returningCols.map((col) => [col, row[col] ?? null])),
            );
            return { rows: mapped, rowCount: mapped.length, fields: [] };
          }
          return { rows: [], rowCount: updatedRows.length, fields: [] };
        }

        throw new Error(`MockPg unsupported SQL statement: ${normalizedSql}`);
      };

      return {
        query,
        release: () => {
          releaseHeldLocks();
        },
      };
    };

    const pool = Object.assign(Object.create(pg.Pool.prototype) as pg.Pool, {
      connect: async () => createClient(),
      query: (
        q: string | { text: string; values?: unknown[]; rowMode?: string },
        params?: unknown[],
      ) => createClient().query(q, params),
    });

    this.db = drizzle(pool, { schema });
  }

  seedWorkspace(id: string, ownerUserId: string): void {
    this.tables.workspaces.push({
      id,
      slug: `ws-${id.slice(0, 8)}`,
      external_workspace_id: null,
      name: `Workspace ${id.slice(0, 6)}`,
      owner_user_id: ownerUserId,
      active_project_id: null,
      active_session_id: null,
      default_models: {},
      tracking_enabled: true,
      welcome_bootstrapped_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  assertZeroWorkspaceBlobWrites(): void {
    assert.equal(this.tables.workspace_blobs.length, 0, 'Expected 0 rows in workspace_blobs');
    const touched = this.queries.filter((q) => q.text.toLowerCase().includes('workspace_blobs'));
    assert.equal(touched.length, 0, `Expected 0 SQL queries touching workspace_blobs, got ${touched.length}`);
  }
}

// ---------------------------------------------------------------------------
// 1. CLI Argument Parsing & Metadata Extraction
// ---------------------------------------------------------------------------

describe('Catalog Sync CLI Args & Media Metadata Sniffing', () => {
  it('parses --dry-run, --limit, --builtin-only, --repo-only, --template, and rejects invalid flags', () => {
    const parsed = parseSyncCatalogArgs([
      '--dry-run',
      '--limit',
      '5',
      '--concurrency=4',
      '--template',
      'openmotion-welcome,product-promo',
    ]);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.concurrency, 4);
    assert.deepEqual(parsed.templateIds, ['openmotion-welcome', 'product-promo']);

    assert.throws(() => parseSyncCatalogArgs(['--builtin-only', '--repo-only']), /Cannot combine/);
    assert.throws(() => parseSyncCatalogArgs(['--limit', '0']), /Invalid --limit/);
    assert.throws(() => parseSyncCatalogArgs(['--bogus']), /Unknown CLI argument/);
  });

  it('extracts PNG dimensions and audio/video metadata without external binaries', () => {
    // Minimal 1x1 PNG header bytes (signature + IHDR with width=640, height=360)
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(360, 20);

    const pngMeta = extractCatalogFileMetadata('poster.png', png, 'image/png');
    assert.deepEqual(pngMeta, { modality: 'image', mimeType: 'image/png', width: 640, height: 360 });

    const videoMeta = extractCatalogFileMetadata('assets/preview.webm', null, 'video/webm', {
      width: 960,
      height: 540,
      fps: 30,
      durationSec: 6,
    });
    assert.deepEqual(videoMeta, {
      modality: 'video',
      mimeType: 'video/webm',
      hasVideo: true,
      width: 960,
      height: 540,
      fps: 30,
      durationSec: 6,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotent Catalog CAS Sync (Real Built-in + Real Repo Catalog Fixtures)
// ---------------------------------------------------------------------------

describe('Idempotent Catalog CAS Sync (syncCatalogCas)', () => {
  it('supports --dry-run with 0 S3 puts and 0 Postgres writes, and enforces --limit', async () => {
    const pg = new MockPgHarness();
    const storage = new MockStorage();

    const drySummary = await syncCatalogCas({ db: pg.db, storage }, { dryRun: true, limit: 2 });
    assert.equal(drySummary.dryRun, true);
    assert.equal(drySummary.templatesProcessed, 2);
    assert.deepEqual(drySummary.templateIds, [WELCOME_TEMPLATE_ID, 'product-promo']);
    assert.equal(storage.putCalls, 0);
    assert.equal(drySummary.blobsUploaded, 0);
    assert.equal(pg.tables.catalog_templates.length, 0);
    assert.equal(pg.tables.catalog_template_files.length, 0);

    // Syncing all 4 built-in templates via builtinOnly succeeds cleanly and deduplicates shared blobs
    const allBuiltins = await syncCatalogCas({ db: pg.db, storage }, { builtinOnly: true });
    assert.equal(allBuiltins.builtinTemplatesProcessed, BUILTIN_TEMPLATES.length);
    assert.equal(allBuiltins.repositoryTemplatesProcessed, 0);
    assert.equal(allBuiltins.unavailableFiles, 0);
    assert.ok(allBuiltins.blobsDeduplicated > 0, 'Shared built-in files (gsap, LICENSE, fonts) should deduplicate');
  });

  it('syncs built-in templates (with GSAP rewrite + welcomeSharedAssets) and real repo fixtures idempotently', async () => {
    const pg = new MockPgHarness();
    const storage = new MockStorage();

    // Sync openmotion-welcome + product-promo + 3 diverse real repository templates:
    // - motion-1e48dea5-903d-48f6-b10e-99a70f1c183d (editable HTML template with LFS audio pointer)
    // - motion-orbit-launch (localMedia poster + remoteAssets preview.webm)
    // - motion-c74e1725-6fd2-4885-be7f-f1f705e9af66 (non-HTML motion guide template)
    const targetIds = [
      WELCOME_TEMPLATE_ID,
      'product-promo',
      'motion-1e48dea5-903d-48f6-b10e-99a70f1c183d',
      'motion-orbit-launch',
      'motion-c74e1725-6fd2-4885-be7f-f1f705e9af66',
    ];

    const first = await syncCatalogCas({ db: pg.db, storage }, { templateIds: targetIds });
    assert.equal(first.templatesProcessed, 5);
    assert.equal(first.builtinTemplatesProcessed, 2);
    assert.equal(first.repositoryTemplatesProcessed, 3);
    assert.ok(first.blobsUploaded > 40, `Expected >40 uploaded blobs, got ${first.blobsUploaded}`);
    assert.ok(first.unavailableFiles >= 2, 'Expected unfetched LFS + remoteAsset files marked unavailable');

    // Verify all uploaded S3 keys live strictly under catalog/blobs/{sha256}
    for (const key of storage.objects.keys()) {
      assert.match(key, /^catalog\/blobs\/[a-f0-9]{64}$/);
    }

    // Verify openmotion-welcome contains all 8 welcomeSharedAssets, GSAP, LICENSE, hyperframes.json, and non-project poster.jpg
    const welcomeFiles = pg.tables.catalog_template_files.filter(
      (row) => row.template_id === WELCOME_TEMPLATE_ID,
    );
    const welcomeByPath = new Map(welcomeFiles.map((row) => [String(row.path), row]));
    for (const [, targetPath] of WELCOME_SHARED_ASSETS) {
      const entry = welcomeByPath.get(targetPath);
      assert.ok(entry, `Missing welcomeSharedAsset: ${targetPath}`);
      assert.equal(entry.is_project_file, true);
      assert.equal(entry.is_available, true);
    }
    assert.equal(welcomeByPath.get('assets/gsap.min.js')?.is_project_file, true);
    assert.equal(welcomeByPath.get('LICENSE')?.is_project_file, true);
    assert.equal(welcomeByPath.get('hyperframes.json')?.is_project_file, true);
    assert.equal(welcomeByPath.get('poster.jpg')?.is_project_file, false);
    const posterMeta = welcomeByPath.get('poster.jpg')?.metadata as {
      modality?: string;
      width?: number;
      height?: number;
    } | null;
    assert.equal(posterMeta?.modality, 'image');
    assert.ok(typeof posterMeta?.width === 'number' && posterMeta.width > 0);
    assert.ok(typeof posterMeta?.height === 'number' && posterMeta.height > 0);

    // Verify welcome index.html uses local assets/gsap.min.js (never external CDN URL)
    const indexFile = welcomeByPath.get('index.html');
    assert.ok(indexFile);
    const indexHtml = (await storage.getObjectBuffer(catalogBlobKey(String(indexFile.sha256)))).toString('utf8');
    assert.equal(indexHtml.includes(GSAP_CDN_URL), false, 'GSAP CDN URL must never remain in catalog HTML');
    assert.ok(indexHtml.includes('assets/gsap.min.js'), 'Welcome index.html must reference assets/gsap.min.js');

    // Verify assembleBuiltinTemplate rewrites GSAP CDN URLs in both root and nested HTML files
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-catalog-gsap-'));
    try {
      const tplDir = path.join(tmpRoot, 'template-library', 'cdn-demo');
      await mkdir(path.join(tplDir, 'compositions'), { recursive: true });
      await mkdir(path.join(tmpRoot, 'node_modules/gsap/dist'), { recursive: true });
      await writeFile(
        path.join(tplDir, 'registry-item.json'),
        JSON.stringify({
          files: [
            { path: 'index.html', target: 'index.html' },
            { path: 'compositions/scene.html', target: 'compositions/scene.html' },
          ],
        }),
      );
      await writeFile(path.join(tplDir, 'index.html'), `<script src="${GSAP_CDN_URL}"></script>`);
      await writeFile(path.join(tplDir, 'compositions/scene.html'), `<script src="${GSAP_CDN_URL}"></script>`);
      await writeFile(path.join(tplDir, 'poster.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      await writeFile(path.join(tmpRoot, 'template-library/LICENSE'), 'Apache-2.0');
      await writeFile(path.join(tmpRoot, 'template-library/NOTICE.md'), 'Notice');
      await writeFile(path.join(tmpRoot, 'node_modules/gsap/dist/gsap.min.js'), '/* gsap */');

      const assembled = await assembleBuiltinTemplate(
        {
          id: 'cdn-demo',
          sortOrder: 99,
          title: 'CDN Demo',
          label: 'Demo',
          description: 'GSAP rewrite verification',
          duration: 5,
          width: 1920,
          height: 1080,
          posterTime: 1,
          author: 'OpenMotion',
          sourceUrl: 'https://example.test/cdn-demo',
        },
        tmpRoot,
        tmpRoot,
      );
      const rewrittenIndex = assembled.files.find((f) => f.path === 'index.html')?.bytes?.toString('utf8') ?? '';
      const rewrittenScene =
        assembled.files.find((f) => f.path === 'compositions/scene.html')?.bytes?.toString('utf8') ?? '';
      assert.equal(rewrittenIndex, '<script src="assets/gsap.min.js"></script>');
      assert.equal(rewrittenScene, '<script src="../assets/gsap.min.js"></script>');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }

    // Verify LFS pointer file in motion-1e48dea5... was NOT uploaded to S3 and is flagged is_available=false
    const lfsRow = pg.tables.catalog_template_files.find(
      (row) =>
        row.template_id === 'motion-1e48dea5-903d-48f6-b10e-99a70f1c183d' &&
        row.path === 'assets/lfs/original-audio.m4a',
    );
    assert.ok(lfsRow);
    assert.equal(lfsRow.is_available, false);
    assert.equal(storage.objects.has(catalogBlobKey(String(lfsRow.sha256))), false);

    // Re-run sync identically -> MUST be 100% idempotent with 0 new S3 putObject calls!
    const putsBeforeRerun = storage.putCalls;
    const rowsBeforeRerun = pg.tables.catalog_template_files.length;
    const second = await syncCatalogCas({ db: pg.db, storage }, { templateIds: targetIds });
    assert.equal(second.templatesProcessed, 5);
    assert.equal(second.blobsUploaded, 0, 'Re-running sync must skip all existing blobs');
    assert.equal(storage.putCalls, putsBeforeRerun, '0 S3 putObject calls on idempotent re-run');
    assert.ok(second.blobsSkipped > 0);
    assert.equal(pg.tables.catalog_templates.length, 5);
    assert.equal(pg.tables.catalog_template_files.length, rowsBeforeRerun);
  });

  it('hydrates missing LFS blobs when fetchRemote=true and skips remote downloads once present in S3', async () => {
    const pg = new MockPgHarness();
    const storage = new MockStorage();
    const templateId = 'motion-1e48dea5-903d-48f6-b10e-99a70f1c183d';

    // Run offline first to capture the exact LFS sha256/size from the catalog entry.
    await syncCatalogCas({ db: pg.db, storage }, { templateIds: [templateId] });
    const lfsRow = pg.tables.catalog_template_files.find(
      (row) => row.template_id === templateId && row.path === 'assets/lfs/original-audio.m4a',
    );
    assert.ok(lfsRow);
    assert.equal(lfsRow.is_available, false);

    // Pre-populate the exact blob in S3 (simulating a previous sync or pre-seeded bucket)
    // and verify fetchRemote=true marks it available with ZERO HTTP fetches.
    const fakeBlob = Buffer.alloc(Number(lfsRow.size_bytes), 0x41);
    await storage.putObject(catalogBlobKey(String(lfsRow.sha256)), fakeBlob, 'audio/mp4', fakeBlob.byteLength);

    let fetchCalls = 0;
    const countingFetch: typeof fetch = async (input) => {
      fetchCalls++;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      throw new Error(`Unexpected remote fetch for ${url}`);
    };

    // Only hydrate blobs whose sha256 is already in S3 for all non-project remoteAssets too,
    // so we isolate testing the S3-hit skip on every missing file for this template.
    for (const row of pg.tables.catalog_template_files) {
      if (row.template_id === templateId && row.is_available === false) {
        const buf = Buffer.alloc(Number(row.size_bytes), 0x42);
        await storage.putObject(catalogBlobKey(String(row.sha256)), buf, String(row.mime_type), buf.byteLength);
      }
    }

    const hydrated = await syncCatalogCas(
      { db: pg.db, storage },
      { templateIds: [templateId], fetchRemote: true, fetchImpl: countingFetch },
    );
    assert.equal(fetchCalls, 0, 'Must not re-download blobs already present in S3 CAS');
    assert.equal(hydrated.unavailableFiles, 0);

    const updatedLfsRow = pg.tables.catalog_template_files.find(
      (row) => row.template_id === templateId && row.path === 'assets/lfs/original-audio.m4a',
    );
    assert.ok(updatedLfsRow);
    assert.equal(updatedLfsRow.is_available, true);
  });

  it('hydrates absent remote LFS blobs via fetchImpl, preserves image dimensions on S3-hit re-runs, rejects integrity mismatches, and tolerates transient network failures', async () => {
    const tmpCatalog = await mkdtemp(path.join(os.tmpdir(), 'om-catalog-remote-'));
    try {
      const templateId = 'remote-hydrate-demo';
      const tplRoot = path.join(tmpCatalog, templateId);
      await mkdir(path.join(tplRoot, 'source/assets/lfs'), { recursive: true });

      // Valid minimal PNG signature + IHDR header encoding 640x360 dimensions.
      const pngBytes = Buffer.alloc(32, 0);
      pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      pngBytes.writeUInt32BE(13, 8);
      pngBytes.write('IHDR', 12, 'ascii');
      pngBytes.writeUInt32BE(640, 16);
      pngBytes.writeUInt32BE(360, 20);
      const pngSha = createHash('sha256').update(pngBytes).digest('hex');
      const pngUrl = `https://releases.open-design.ai/open-motion/media/sha256/${pngSha}.png`;

      const indexBytes = Buffer.from('<div data-composition-id="root"><img src="assets/lfs/hero.png"></div>', 'utf8');
      const indexSha = createHash('sha256').update(indexBytes).digest('hex');

      await writeFile(
        path.join(tmpCatalog, 'catalog.json'),
        JSON.stringify({
          schemaVersion: 1,
          templateIds: [templateId],
          publication: {
            resourceId: 'test-catalog',
            environment: 'test',
            channel: 'test',
            publicationId: 'pub-1',
            defaultLocale: 'en',
            locales: ['en'],
          },
          localeContent: { en: { brands: [] } },
        }),
      );
      await writeFile(
        path.join(tplRoot, 'template.json'),
        JSON.stringify({
          templateId,
          entry: {
            templateId,
            sortOrder: 1,
            files: [
              { path: 'index.html', bytes: indexBytes.byteLength, sha256: indexSha, mimeType: 'text/html; charset=utf-8' },
              { path: 'assets/lfs/hero.png', bytes: pngBytes.byteLength, sha256: pngSha, mimeType: 'image/png', url: pngUrl },
            ],
          },
          locales: { en: { original: { templateName: 'Remote Hydrate Demo' } } },
          remoteAssets: [
            {
              url: pngUrl,
              bytes: pngBytes.byteLength,
              sha256: pngSha,
              source: { path: 'assets/lfs/hero.png', bytes: pngBytes.byteLength, sha256: pngSha },
            },
          ],
        }),
      );
      await writeFile(
        path.join(tplRoot, 'source/manifest.json'),
        JSON.stringify({
          canvas: { width: 1920, height: 1080 },
          fps: 30,
          durationSeconds: 5,
          files: [
            { path: 'index.html', bytes: indexBytes.byteLength, sha256: indexSha },
            { path: 'assets/lfs/hero.png', bytes: pngBytes.byteLength, sha256: pngSha },
          ],
        }),
      );
      await writeFile(path.join(tplRoot, 'source/index.html'), indexBytes);
      await writeFile(
        path.join(tplRoot, 'source/assets/lfs/hero.png'),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${pngSha}\nsize ${pngBytes.byteLength}\n`,
      );

      // 1. Absent S3 object + stubbed fetchImpl -> downloads, verifies, uploads, and extracts image dimensions.
      const pg = new MockPgHarness();
      const storage = new MockStorage();
      let fetchCalls = 0;
      const okFetch: typeof fetch = async () => {
        fetchCalls++;
        return new Response(new Uint8Array(pngBytes), { status: 200 });
      };

      const first = await syncCatalogCas(
        { db: pg.db, storage },
        { catalogRoot: tmpCatalog, repoOnly: true, fetchRemote: true, fetchImpl: okFetch },
      );
      assert.equal(fetchCalls, 1);
      assert.equal(first.unavailableFiles, 0);
      assert.equal(storage.objects.has(catalogBlobKey(pngSha)), true);
      const firstRow = pg.tables.catalog_template_files.find(
        (row) => row.template_id === templateId && row.path === 'assets/lfs/hero.png',
      );
      assert.ok(firstRow);
      assert.equal(firstRow.is_available, true);
      assert.deepEqual(
        { width: (firstRow.metadata as { width?: number })?.width, height: (firstRow.metadata as { height?: number })?.height },
        { width: 640, height: 360 },
      );

      // 2. Idempotent S3-hit re-run -> 0 remote fetches, 0 S3 gets, AND image dimensions are preserved.
      fetchCalls = 0;
      const getsBeforeRerun = storage.getCalls;
      const second = await syncCatalogCas(
        { db: pg.db, storage },
        { catalogRoot: tmpCatalog, repoOnly: true, fetchRemote: true, fetchImpl: okFetch },
      );
      assert.equal(fetchCalls, 0);
      assert.equal(storage.getCalls, getsBeforeRerun);
      assert.equal(second.unavailableFiles, 0);
      assert.ok(second.blobsSkipped >= 1);
      const secondRow = pg.tables.catalog_template_files.find(
        (row) => row.template_id === templateId && row.path === 'assets/lfs/hero.png',
      );
      assert.ok(secondRow);
      assert.equal(secondRow.is_available, true);
      assert.deepEqual(
        { width: (secondRow.metadata as { width?: number })?.width, height: (secondRow.metadata as { height?: number })?.height },
        { width: 640, height: 360 },
      );

      // 3. Pre-seeded S3 image blob with empty PG -> 0 remote fetches, extracts dimensions from S3 CAS.
      const freshPg = new MockPgHarness();
      const seededRun = await syncCatalogCas(
        { db: freshPg.db, storage },
        { catalogRoot: tmpCatalog, repoOnly: true, fetchRemote: true, fetchImpl: okFetch },
      );
      assert.equal(fetchCalls, 0);
      assert.equal(seededRun.unavailableFiles, 0);
      const seededRow = freshPg.tables.catalog_template_files.find(
        (row) => row.template_id === templateId && row.path === 'assets/lfs/hero.png',
      );
      assert.deepEqual(
        { width: (seededRow?.metadata as { width?: number })?.width, height: (seededRow?.metadata as { height?: number })?.height },
        { width: 640, height: 360 },
      );

      // 4. Hash / byte-length mismatch MUST reject the sync (fail closed on corruption/tampering).
      const badBytes = Buffer.from(pngBytes);
      badBytes[badBytes.byteLength - 1] ^= 0xff;
      await assert.rejects(
        () =>
          syncCatalogCas(
            { db: new MockPgHarness().db, storage: new MockStorage() },
            {
              catalogRoot: tmpCatalog,
              repoOnly: true,
              fetchRemote: true,
              fetchImpl: async () => new Response(new Uint8Array(badBytes), { status: 200 }),
            },
          ),
        /SHA-256 mismatch|hash\/length mismatch/i,
      );
      await assert.rejects(
        () =>
          syncCatalogCas(
            { db: new MockPgHarness().db, storage: new MockStorage() },
            {
              catalogRoot: tmpCatalog,
              repoOnly: true,
              fetchRemote: true,
              fetchImpl: async () => new Response(new Uint8Array(pngBytes.subarray(0, 12)), { status: 200 }),
            },
          ),
        /size mismatch|hash\/length mismatch/i,
      );

      // 5. Transient remote HTTP error is tolerated by default (local Compose stays up),
      //    and rejected when strictRemote=true.
      const offlinePg = new MockPgHarness();
      const offlineFetch: typeof fetch = async () => new Response('upstream down', { status: 503 });
      const offlineSummary = await syncCatalogCas(
        { db: offlinePg.db, storage: new MockStorage() },
        { catalogRoot: tmpCatalog, repoOnly: true, fetchRemote: true, fetchImpl: offlineFetch },
      );
      assert.equal(offlineSummary.unavailableFiles, 1);
      const offlineRow = offlinePg.tables.catalog_template_files.find(
        (row) => row.template_id === templateId && row.path === 'assets/lfs/hero.png',
      );
      assert.equal(offlineRow?.is_available, false);

      await assert.rejects(
        () =>
          syncCatalogCas(
            { db: new MockPgHarness().db, storage: new MockStorage() },
            {
              catalogRoot: tmpCatalog,
              repoOnly: true,
              fetchRemote: true,
              strictRemote: true,
              fetchImpl: offlineFetch,
            },
          ),
        /HTTP 503/i,
      );
    } finally {
      await rm(tmpCatalog, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. CatalogService: Listing, Search, Detail, Zero-Copy Clone & Guards
// ---------------------------------------------------------------------------

describe('CatalogService Zero-Copy Cloning & Tenant Isolation', () => {
  it('lists, searches, localizes, and clones templates O(1) with blob_scope=catalog and 0 workspace_blobs writes', async () => {
    const pg = new MockPgHarness();
    const storage = new MockStorage();
    pg.seedWorkspace(WID_A, USER_A);
    pg.seedWorkspace(WID_B, USER_B);

    await syncCatalogCas(
      { db: pg.db, storage },
      {
        templateIds: [
          WELCOME_TEMPLATE_ID,
          'product-promo',
          'motion-1e48dea5-903d-48f6-b10e-99a70f1c183d',
          'motion-c74e1725-6fd2-4885-be7f-f1f705e9af66',
        ],
      },
    );

    const catalog = new CatalogService({ db: pg.db, storage });

    // List & localize
    const enList = await catalog.listTemplates({ category: 'all', locale: 'en', limit: 20 });
    assert.equal(enList.source, 'catalog-cas');
    assert.equal(enList.catalogTotal, 4);
    const notionEn = enList.items.find((item) => item.id === 'motion-c74e1725-6fd2-4885-be7f-f1f705e9af66');
    assert.equal(notionEn?.title, 'Notion — Custom Agents');

    const zhList = await catalog.listTemplates({ category: 'all', locale: 'zh-CN', limit: 20 });
    const notionZh = zhList.items.find((item) => item.id === 'motion-c74e1725-6fd2-4885-be7f-f1f705e9af66');
    assert.equal(notionZh?.title, 'Custom Agents.');

    // Detail includes instructions, workflowGuide, and file manifest
    const detail = await catalog.getTemplate(WELCOME_TEMPLATE_ID);
    assert.equal(detail.id, WELCOME_TEMPLATE_ID);
    assert.equal(detail.workflowGuide.workflow, 'template');
    assert.ok(detail.instructions.length > 50);
    assert.ok(detail.files.some((f) => f.path === 'index.html' && f.isProjectFile));
    assert.ok(detail.files.some((f) => f.path === 'poster.jpg' && !f.isProjectFile));

    // Zero-copy clone openmotion-welcome
    const putsBeforeClone = storage.putCalls;
    const ctxA = makeAuthContext({ workspaceId: WID_A, userId: USER_A });
    const cloned = await catalog.cloneTemplateToProject(ctxA, {
      templateId: WELCOME_TEMPLATE_ID,
      title: 'My Welcome Clone',
      requestId: 'req_clone_1',
    });

    assert.equal(cloned.templateId, WELCOME_TEMPLATE_ID);
    assert.equal(cloned.projectType, 'template');
    assert.equal(cloned.versionNumber, 1);
    assert.equal(cloned.historySeq, 1);
    assert.ok(cloned.fileCount >= 20);
    assert.ok(cloned.files.every((f) => f.blobScope === 'catalog'));
    assert.equal(cloned.files.some((f) => f.path === 'poster.jpg'), false, 'Non-project poster must not be cloned');

    // Verify deterministic revision matches computeProjectRevision
    const expectedRevision = computeProjectRevision(
      cloned.files.map((f) => ({ path: f.path, size: f.sizeBytes, hash: f.sha256 })),
    );
    assert.equal(cloned.revision, expectedRevision);

    // Assert ZERO bytes copied to S3 and ZERO workspace_blobs writes
    assert.equal(storage.putCalls, putsBeforeClone, 'Zero-copy clone must never put bytes to S3');
    pg.assertZeroWorkspaceBlobWrites();

    // Verify PG rows created cleanly across projects, project_files, project_versions, project_version_files, project_history_entries
    assert.equal(pg.tables.projects.length, 1);
    assert.equal(pg.tables.projects[0].workspace_id, WID_A);
    assert.equal(pg.tables.project_files.length, cloned.fileCount);
    assert.ok(pg.tables.project_files.every((row) => row.blob_scope === 'catalog' && row.workspace_id === WID_A));
    assert.equal(pg.tables.project_versions.length, 1);
    assert.equal(pg.tables.project_versions[0].source, 'baseline');
    assert.equal(pg.tables.project_version_files.length, cloned.fileCount);
    assert.ok(pg.tables.project_version_files.every((row) => row.blob_scope === 'catalog'));
    assert.equal(pg.tables.project_history_entries.length, 1);
    assert.equal(pg.tables.project_history_entries[0].seq, 1);

    // Product Promo (contains vendor/gsap-3.14.2/dist/gsap.min.js) also clones cleanly zero-copy
    const promoClone = await catalog.cloneTemplateToProject(ctxA, { templateId: 'product-promo' });
    assert.ok(promoClone.files.some((f) => f.path === 'vendor/gsap-3.14.2/dist/gsap.min.js'));
    pg.assertZeroWorkspaceBlobWrites();

    // Non-HTML template fails with TEMPLATE_NOT_COPYABLE
    await assert.rejects(
      () => catalog.cloneTemplateToProject(ctxA, { templateId: 'motion-c74e1725-6fd2-4885-be7f-f1f705e9af66' }),
      { code: 'TEMPLATE_NOT_COPYABLE' },
    );

    // HTML template with unavailable LFS project file fails with TEMPLATE_MEDIA_UNAVAILABLE
    await assert.rejects(
      () => catalog.cloneTemplateToProject(ctxA, { templateId: 'motion-1e48dea5-903d-48f6-b10e-99a70f1c183d' }),
      { code: 'TEMPLATE_MEDIA_UNAVAILABLE' },
    );

    // Cross-workspace session isolation: WID_B cannot clone into WID_A's session
    const ctxB = makeAuthContext({ workspaceId: WID_B, userId: USER_B });
    await assert.rejects(
      () =>
        catalog.cloneTemplateToProject(ctxB, {
          templateId: WELCOME_TEMPLATE_ID,
          sessionId: cloned.sessionId,
        }),
      { code: 'SESSION_NOT_FOUND' },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. WelcomeBootstrapService Concurrent Idempotency
// ---------------------------------------------------------------------------

describe('WelcomeBootstrapService (ensureWelcomeProject)', () => {
  it('bootstraps openmotion-welcome exactly once under concurrent first workspace requests with 0 workspace_blobs writes', async () => {
    const pg = new MockPgHarness();
    const storage = new MockStorage();
    pg.seedWorkspace(WID_A, USER_A);
    pg.seedWorkspace(WID_B, USER_B);

    await syncCatalogCas({ db: pg.db, storage }, { templateIds: [WELCOME_TEMPLATE_ID] });
    const catalog = new CatalogService({ db: pg.db, storage });
    const bootstrap = new WelcomeBootstrapService({ db: pg.db, catalog });

    const ctxA = makeAuthContext({ workspaceId: WID_A, userId: USER_A });
    const putsBeforeBootstrap = storage.putCalls;

    // Fire 3 concurrent first-access bootstrap requests for WID_A
    const results = await Promise.all([
      bootstrap.ensureWelcomeProject(ctxA),
      bootstrap.ensureWelcomeProject(ctxA),
      bootstrap.ensureWelcomeProject(ctxA),
    ]);

    const bootstrapped = results.filter((r) => r.bootstrapped);
    const already = results.filter((r) => r.alreadyBootstrapped);
    assert.equal(bootstrapped.length, 1, 'Exactly one concurrent request must perform the clone');
    assert.equal(already.length, 2, 'Remaining concurrent requests must observe welcome_bootstrapped_at');

    const welcomeProjectId = bootstrapped[0].projectId;
    const welcomeSessionId = bootstrapped[0].sessionId;
    assert.ok(welcomeProjectId);
    assert.ok(welcomeSessionId);
    for (const res of results) {
      assert.equal(res.projectId, welcomeProjectId);
      assert.equal(res.sessionId, welcomeSessionId);
      assert.ok(res.welcomeBootstrappedAt instanceof Date);
    }

    // Verify FOR UPDATE row lock was actually executed and only 1 project exists for WID_A
    assert.ok(pg.forUpdateWaitCount >= 3);
    assert.ok(pg.queries.some((q) => /select .+ from "workspaces".+for update/i.test(q.text)));
    const projectsA = pg.tables.projects.filter((row) => row.workspace_id === WID_A);
    assert.equal(projectsA.length, 1);
    assert.equal(projectsA[0].title, WELCOME_PROJECT_TITLE);
    assert.equal(projectsA[0].title_key, WELCOME_PROJECT_TITLE_KEY);
    assert.equal(projectsA[0].template_id, WELCOME_TEMPLATE_ID);

    // Verify 0 S3 writes and 0 workspace_blobs writes
    assert.equal(storage.putCalls, putsBeforeBootstrap);
    pg.assertZeroWorkspaceBlobWrites();

    // Subsequent sequential call is a fast no-op
    const fourth = await ensureWelcomeProject({ db: pg.db, catalog }, ctxA);
    assert.equal(fourth.bootstrapped, false);
    assert.equal(fourth.alreadyBootstrapped, true);
    assert.equal(fourth.projectId, welcomeProjectId);

    // Second workspace WID_B bootstraps independently without interfering with WID_A
    const ctxB = makeAuthContext({ workspaceId: WID_B, userId: USER_B });
    const resB = await bootstrap.ensureWelcomeProject(ctxB);
    assert.equal(resB.bootstrapped, true);
    assert.notEqual(resB.projectId, welcomeProjectId);
    assert.equal(pg.tables.projects.filter((row) => row.workspace_id === WID_B).length, 1);
    pg.assertZeroWorkspaceBlobWrites();
  });
});

// ---------------------------------------------------------------------------
// 5. Hono Routes: 302 Presigned GET, PG-Only HEAD, Inline Guide, Auth/RBAC Clone
// ---------------------------------------------------------------------------

describe('Catalog Hono Routes (src/routes/catalog.ts)', () => {
  it('serves template list/detail, 302 presigned GET, PG-only HEAD (0 S3 calls), inline HTML guide, and auth-isolated clone', async () => {
    const pg = new MockPgHarness();
    const storage = new MockStorage();
    const textCache = new MockHotTextCache();
    pg.seedWorkspace(WID_A, USER_A);

    await syncCatalogCas(
      { db: pg.db, storage },
      {
        templateIds: [
          WELCOME_TEMPLATE_ID,
          'motion-orbit-launch',
          'motion-c74e1725-6fd2-4885-be7f-f1f705e9af66',
        ],
      },
    );

    const catalog = new CatalogService({
      db: pg.db,
      storage,
      textCache: textCache as unknown as HotTextCache,
    });

    let activeAuth: AuthContext | undefined = undefined;
    const app = new Hono<CatalogRouteEnv>();
    app.use('*', async (c, next) => {
      if (activeAuth) {
        c.set('auth', activeAuth);
      }
      await next();
    });
    app.route('/', createCatalogRoutes({ catalog }));

    // 1. Listing & Search
    const listRes = await app.request('/api/templates');
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { templates: Array<{ id: string }>; catalogTotal: number };
    assert.equal(listBody.catalogTotal, 3);
    assert.ok(listBody.templates.some((t) => t.id === WELCOME_TEMPLATE_ID));

    const searchRes = await app.request('/api/template-catalog?category=all&query=Orbit&locale=en');
    assert.equal(searchRes.status, 200);
    const searchBody = (await searchRes.json()) as { items: Array<{ id: string }> };
    assert.deepEqual(
      searchBody.items.map((item) => item.id),
      ['motion-orbit-launch'],
    );

    // 2. Detail + 404
    const detailRes = await app.request(`/api/templates/${WELCOME_TEMPLATE_ID}`);
    assert.equal(detailRes.status, 200);
    const detailBody = (await detailRes.json()) as { id: string; files: Array<{ path: string }> };
    assert.equal(detailBody.id, WELCOME_TEMPLATE_ID);
    assert.ok(detailBody.files.length > 10);

    const missingRes = await app.request('/api/templates/nonexistent-template-id');
    assert.equal(missingRes.status, 404);

    // 3. HEAD on poster & source assets -> answered strictly from PG metadata (ZERO S3 presign/head calls!)
    const presignBeforeHead = storage.presignGetCalls;
    const headBeforeHead = storage.headCalls;

    const headPoster = await app.request(`/api/templates/${WELCOME_TEMPLATE_ID}/poster`, { method: 'HEAD' });
    assert.equal(headPoster.status, 200);
    assert.equal(headPoster.headers.get('content-type'), 'image/jpeg');
    assert.ok(Number(headPoster.headers.get('content-length')) > 1000);
    assert.match(headPoster.headers.get('etag') ?? '', /^"sha256:[a-f0-9]{64}"$/);
    assert.equal(headPoster.headers.get('accept-ranges'), 'bytes');
    assert.equal(await headPoster.text(), '');

    const headSource = await app.request(`/api/template-source/${WELCOME_TEMPLATE_ID}/assets/horizon.webp`, {
      method: 'HEAD',
    });
    assert.equal(headSource.status, 200);
    assert.equal(headSource.headers.get('content-type'), 'image/webp');
    assert.ok(Number(headSource.headers.get('content-length')) > 0);
    assert.equal(await headSource.text(), '');

    assert.equal(storage.presignGetCalls, presignBeforeHead, 'HEAD must NEVER call S3 presignGet');
    assert.equal(storage.headCalls, headBeforeHead, 'HEAD must answer directly from PG, never S3 headObject');

    // 4. GET poster & binary source asset -> 302 presigned GET with required Cache-Control & Vary headers
    const getPoster = await app.request(`/api/templates/${WELCOME_TEMPLATE_ID}/poster`);
    assert.equal(getPoster.status, 302);
    const posterLocation = getPoster.headers.get('location') ?? '';
    assert.match(posterLocation, /^https:\/\/s3\.example\.test\/openmotion\/catalog\/blobs\/[a-f0-9]{64}\?/);
    assert.equal(getPoster.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(getPoster.headers.get('vary'), 'Origin, Cookie');

    const getBinarySource = await app.request(`/api/templates/${WELCOME_TEMPLATE_ID}/source/assets/horizon.webp`);
    assert.equal(getBinarySource.status, 302);
    assert.match(
      getBinarySource.headers.get('location') ?? '',
      /^https:\/\/s3\.example\.test\/openmotion\/catalog\/blobs\/[a-f0-9]{64}\?/,
    );

    // Preview on motion-orbit-launch falls back cleanly to verified remoteAsset HTTPS URL when not fetched
    const getPreview = await app.request('/api/templates/motion-orbit-launch/preview');
    assert.equal(getPreview.status, 302);
    assert.match(
      getPreview.headers.get('location') ?? '',
      /^https:\/\/releases\.open-design\.ai\/open-motion\/media\/sha256\/[a-f0-9]{64}\.webm$/,
    );

    // When preview media IS available in catalog CAS, HEAD answers from PG (0 S3 calls) and GET 302-presigns catalog/blobs/{sha256}
    const orbitPreviewRow = pg.tables.catalog_template_files.find(
      (row) => row.template_id === 'motion-orbit-launch' && row.path === 'assets/preview.webm',
    );
    assert.ok(orbitPreviewRow);
    orbitPreviewRow.is_available = true;
    const presignBeforePreviewHead = storage.presignGetCalls;
    const headPreview = await app.request('/api/templates/motion-orbit-launch/preview', { method: 'HEAD' });
    assert.equal(headPreview.status, 200);
    assert.equal(headPreview.headers.get('content-type'), 'video/webm');
    assert.equal(headPreview.headers.get('content-length'), String(orbitPreviewRow.size_bytes));
    assert.equal(headPreview.headers.get('accept-ranges'), 'bytes');
    assert.equal(storage.presignGetCalls, presignBeforePreviewHead, 'HEAD /preview must NEVER call presignGet');

    const getCasPreview = await app.request('/api/templates/motion-orbit-launch/preview');
    assert.equal(getCasPreview.status, 302);
    assert.match(
      getCasPreview.headers.get('location') ?? '',
      new RegExp(`^https://s3\\.example\\.test/openmotion/catalog/blobs/${String(orbitPreviewRow.sha256)}\\?`),
    );
    assert.equal(getCasPreview.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(getCasPreview.headers.get('vary'), 'Origin, Cookie');

    // motion.md?download=1 serves inline text with attachment disposition
    const motionDownload = await app.request('/api/template-source/motion-orbit-launch/motion.md?download=1');
    assert.equal(motionDownload.status, 200);
    assert.equal(motionDownload.headers.get('content-disposition'), 'attachment; filename="motion.md"');
    assert.ok((await motionDownload.text()).length > 20);

    // 5. GET preview.html serves upgraded HTML inline via HotTextCache/S3; ?redirect=1 returns 302 presign
    const getBeforeGuide = storage.getCalls;
    const guideRes = await app.request('/api/template-source/motion-orbit-launch/preview.html');
    assert.equal(guideRes.status, 200);
    const guideHtml = await guideRes.text();
    assert.ok(guideHtml.includes('id="openmotion-guide-page"'));
    assert.equal(storage.getCalls, getBeforeGuide + 1);

    // Second request hits HotTextCache (0 extra S3 getObjectBuffer calls)
    const guideRes2 = await app.request('/api/template-source/motion-orbit-launch/preview.html');
    assert.equal(guideRes2.status, 200);
    assert.equal(storage.getCalls, getBeforeGuide + 1, 'HotTextCache must serve repeated catalog text reads');

    const guideRedirect = await app.request('/api/template-source/motion-orbit-launch/preview.html?redirect=1');
    assert.equal(guideRedirect.status, 302);

    // 6. Path traversal blocked with 400 INVALID_PATH
    const traversal = await app.request(`/api/template-source/${WELCOME_TEMPLATE_ID}/..%2Fsecret.txt`);
    assert.equal(traversal.status, 400);
    const traversalBody = (await traversal.json()) as { code: string };
    assert.equal(traversalBody.code, 'INVALID_PATH');

    // 7. Clone endpoint AuthContext + RBAC + workspace isolation enforcement
    activeAuth = undefined;
    const unauthClone = await app.request(`/api/templates/${WELCOME_TEMPLATE_ID}/clone`, { method: 'POST' });
    assert.equal(unauthClone.status, 401);

    activeAuth = makeAuthContext({ role: 'viewer' });
    const viewerClone = await app.request(`/api/templates/${WELCOME_TEMPLATE_ID}/clone`, { method: 'POST' });
    assert.equal(viewerClone.status, 403);

    activeAuth = makeAuthContext({ role: 'owner', scopes: ['projects:read'] });
    const noScopeClone = await app.request(`/api/templates/${WELCOME_TEMPLATE_ID}/clone`, { method: 'POST' });
    assert.equal(noScopeClone.status, 403);

    activeAuth = makeAuthContext({ workspaceId: WID_A, role: 'editor' });
    const crossTenantClone = await app.request(`/api/templates/${WELCOME_TEMPLATE_ID}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: WID_B }),
    });
    assert.equal(crossTenantClone.status, 403);
    assert.equal(((await crossTenantClone.json()) as { code: string }).code, 'WORKSPACE_FORBIDDEN');

    const okClone = await app.request(`/api/templates/${WELCOME_TEMPLATE_ID}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Cloned via Route', requestId: 'route_clone_1' }),
    });
    assert.equal(okClone.status, 201);
    const okCloneBody = (await okClone.json()) as {
      projectId: string;
      title: string;
      templateId: string;
      fileCount: number;
    };
    assert.equal(okCloneBody.title, 'Cloned via Route');
    assert.equal(okCloneBody.templateId, WELCOME_TEMPLATE_ID);
    assert.ok(okCloneBody.fileCount >= 20);
    assert.equal(BUILTIN_TEMPLATES[0].id, WELCOME_TEMPLATE_ID);
    pg.assertZeroWorkspaceBlobWrites();
  });

  it('supports sub-router mounting with basePath="" under /api and /motion-api for wildcard source routes and traversal defense', async () => {
    const pg = new MockPgHarness();
    const storage = new MockStorage();
    pg.seedWorkspace(WID_A, USER_A);

    await syncCatalogCas({ db: pg.db, storage }, { templateIds: [WELCOME_TEMPLATE_ID] });
    const catalog = new CatalogService({ db: pg.db, storage });

    const mounted = new Hono<CatalogRouteEnv>();
    mounted.route('/api', createCatalogRoutes({ catalog, basePath: '' }));
    mounted.route('/motion-api', createCatalogRoutes({ catalog, basePath: '' }));

    for (const prefix of ['/api', '/motion-api']) {
      // Poster 302
      const poster = await mounted.request(`${prefix}/templates/${WELCOME_TEMPLATE_ID}/poster`);
      assert.equal(poster.status, 302);

      // /templates/:id/source/* (HEAD from PG + GET 302 presigned)
      const presignBefore = storage.presignGetCalls;
      const headSource = await mounted.request(
        `${prefix}/templates/${WELCOME_TEMPLATE_ID}/source/assets/horizon.webp`,
        { method: 'HEAD' },
      );
      assert.equal(headSource.status, 200);
      assert.equal(headSource.headers.get('content-type'), 'image/webp');
      assert.equal(storage.presignGetCalls, presignBefore);

      const getSource = await mounted.request(
        `${prefix}/templates/${WELCOME_TEMPLATE_ID}/source/assets/horizon.webp`,
      );
      assert.equal(getSource.status, 302);
      assert.match(
        getSource.headers.get('location') ?? '',
        /^https:\/\/s3\.example\.test\/openmotion\/catalog\/blobs\/[a-f0-9]{64}\?/,
      );

      // /template-source/:id/* (HEAD from PG + GET 302 presigned)
      const presignBeforeLegacy = storage.presignGetCalls;
      const headLegacy = await mounted.request(
        `${prefix}/template-source/${WELCOME_TEMPLATE_ID}/assets/horizon.webp`,
        { method: 'HEAD' },
      );
      assert.equal(headLegacy.status, 200);
      assert.equal(headLegacy.headers.get('content-type'), 'image/webp');
      assert.equal(storage.presignGetCalls, presignBeforeLegacy);

      const getLegacy = await mounted.request(
        `${prefix}/template-source/${WELCOME_TEMPLATE_ID}/assets/horizon.webp`,
      );
      assert.equal(getLegacy.status, 302);
      assert.match(
        getLegacy.headers.get('location') ?? '',
        /^https:\/\/s3\.example\.test\/openmotion\/catalog\/blobs\/[a-f0-9]{64}\?/,
      );

      // Traversal rejection on both wildcard patterns
      const badSource = await mounted.request(
        `${prefix}/templates/${WELCOME_TEMPLATE_ID}/source/..%2Fsecret.txt`,
      );
      assert.equal(badSource.status, 400);
      assert.equal(((await badSource.json()) as { code: string }).code, 'INVALID_PATH');

      const badLegacy = await mounted.request(
        `${prefix}/template-source/${WELCOME_TEMPLATE_ID}/..%2Fsecret.txt`,
      );
      assert.equal(badLegacy.status, 400);
      assert.equal(((await badLegacy.json()) as { code: string }).code, 'INVALID_PATH');
    }
  });
});
