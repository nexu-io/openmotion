/**
 * Atom 5: `atom.config` — Field-level surgical config merge with pre-edit backup (K7).
 *
 * Security & Coexistence Rules:
 * - Only allows `fieldType === 'remote_mcp_entry'` (`isBuiltinConfigFieldType`).
 * - Only operates on safe home-relative paths defined in verified `SignedConfigPayload.configRules`.
 * - Strictly validates `url` against built-in domain scope (`isUrlInAllowedDomainScope`)
 *   and `serverName` as a safe identifier.
 * - Reads/writes JSON (`mcpServers.<name>`) and TOML (`[mcp_servers.<name>]`) at field/section
 *   level WITHOUT clobbering unrelated keys, comments, or sibling MCP servers (e.g. Murmur).
 * - Creates a timestamped pre-edit backup before every write and supports `restoreBackup`.
 * - Returns `CONFLICT` if an entry already exists with a different URL and `conflictPolicy !== 'replace'`.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalizeUrlForComparison,
  DEFAULT_MCP_SERVER_NAME,
  isBuiltinConfigFieldType,
  validateTypedPlaceholderValue,
} from '../../shared/desktop-builtin-rules.ts';
import {
  hostErr,
  hostOk,
  type AtomConfigReadParams,
  type AtomConfigReadResult,
  type AtomConfigWriteParams,
  type AtomConfigWriteResult,
  type ConfirmationFact,
  type HostInvokeResult,
  type HostReleaseChannel,
} from '../../shared/desktop-contract.ts';
import {
  isAllowedMcpConfigRelativePath,
  type SignedAgentConfigRule,
  type SignedConfigPayload,
} from '../../shared/signed-config.ts';
import { assertFeatureAllowsResource, type FeatureConfirmationGate } from './confirmation.ts';
import type { SerialMutationQueue } from './serial-queue.ts';

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BACKUPS_DIR_NAME = 'backups';
const BACKUPS_INDEX_FILE = 'index.json';
const SAFE_SECTION_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export type ParsedMcpEntry = {
  serverName: string;
  url?: string;
  transport?: string;
};

export type BackupRecord = {
  backupPath: string;
  targetPath: string;
  ruleId: string;
  createdAt: string;
};

type BackupIndexFile = {
  schemaVersion: number;
  backups: BackupRecord[];
};

export type AtomConfigRestoreParams = {
  backupPath: string;
  featureId: string;
};

export type AtomConfigRestoreResult = {
  backupPath: string;
  restoredPath: string;
  ruleId: string;
};

export type ConfigAtomDeps = {
  dataDir: string;
  homeDir?: string;
  channel?: HostReleaseChannel;
  allowLocalDevLoopback?: boolean;
  expectedMcpUrl?: string;
  getExpectedMcpUrl?: () => string | undefined;
  getSignedConfig: () => SignedConfigPayload;
  confirmationGate: FeatureConfirmationGate;
  mutationQueue: SerialMutationQueue;
  now?: () => Date;
};

/**
 * Resolves a home-relative path safely, preventing absolute paths, drive letters,
 * `..` traversal, null bytes, and symlink escapes outside `homeDir`.
 */
export function resolveSafeHomePath(
  homeDir: string,
  homeRelativePath: string,
): { ok: true; resolvedPath: string } | { ok: false; reason: string } {
  if (
    !homeRelativePath ||
    typeof homeRelativePath !== 'string' ||
    homeRelativePath.includes('\0') ||
    homeRelativePath.startsWith('/') ||
    homeRelativePath.startsWith('\\') ||
    /^[a-zA-Z]:/.test(homeRelativePath)
  ) {
    return { ok: false, reason: `Unsafe home-relative path: "${String(homeRelativePath)}"` };
  }

  const normalizedSegments = homeRelativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (normalizedSegments.length === 0 || normalizedSegments.some(seg => seg === '..' || seg === '.')) {
    return { ok: false, reason: `Path traversal segment rejected: "${homeRelativePath}"` };
  }

  const resolvedHome = path.resolve(homeDir);
  const resolvedTarget = path.resolve(resolvedHome, ...normalizedSegments);
  const relative = path.relative(resolvedHome, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: `Resolved path escapes home directory: "${homeRelativePath}"` };
  }

  // Symlink escape check against existing ancestor/target.
  if (existsSync(resolvedHome)) {
    const realHome = realpathSync(resolvedHome);
    let probe = resolvedTarget;
    while (!existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (existsSync(probe)) {
      const realProbe = realpathSync(probe);
      const realRel = path.relative(realHome, realProbe);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return { ok: false, reason: `Symlink path escapes home directory: "${homeRelativePath}"` };
      }
    }
  }

  return { ok: true, resolvedPath: resolvedTarget };
}

function parseSectionPath(sectionPath: string): string[] | null {
  const segments = sectionPath.split('.').map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (FORBIDDEN_OBJECT_KEYS.has(seg) || !SAFE_SECTION_SEGMENT_RE.test(seg)) {
      return null;
    }
  }
  return segments;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function writeAtomicFile(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  let targetMode = 0o600;
  try {
    if (existsSync(targetPath)) {
      targetMode = statSync(targetPath).mode & 0o777;
    }
  } catch {
    targetMode = 0o600;
  }
  const tmpPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmpPath, targetMode);
  } catch {
    // Ignore chmod failures on filesystems/platforms that do not support POSIX modes.
  }
  renameSync(tmpPath, targetPath);
}

/* -------------------------------------------------------------------------- */
/*  JSON surgical read & upsert                                               */
/* -------------------------------------------------------------------------- */

export function parseJsonMcpEntry(
  rawText: string,
  sectionPath: string,
  serverName: string,
): { ok: true; entry?: ParsedMcpEntry } | { ok: false; reason: string } {
  const segments = parseSectionPath(sectionPath);
  if (!segments) return { ok: false, reason: `Invalid sectionPath: "${sectionPath}"` };

  const trimmed = rawText.trim();
  if (!trimmed) return { ok: true, entry: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      reason: `Malformed JSON config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, reason: 'JSON config root must be an object' };
  }

  let cursor: unknown = parsed;
  for (const seg of segments) {
    if (!isPlainRecord(cursor)) return { ok: true, entry: undefined };
    cursor = cursor[seg];
  }
  if (!isPlainRecord(cursor)) {
    return { ok: true, entry: undefined };
  }

  const rawEntry = cursor[serverName];
  if (!isPlainRecord(rawEntry)) {
    return { ok: true, entry: undefined };
  }

  const url = typeof rawEntry.url === 'string' ? rawEntry.url : undefined;
  const transport =
    typeof rawEntry.type === 'string'
      ? rawEntry.type
      : typeof rawEntry.transport === 'string'
        ? rawEntry.transport
        : undefined;

  return {
    ok: true,
    entry: {
      serverName,
      url,
      transport,
    },
  };
}

export function upsertJsonMcpEntry(
  rawText: string | null,
  sectionPath: string,
  value: { serverName: string; url: string; transport?: 'http' | 'streamable-http' | 'remote' },
  conflictPolicy: 'abort' | 'replace',
):
  | { ok: true; content: string; changed: boolean }
  | { ok: false; code: 'CONFLICT' | 'EXEC_FAILED'; reason: string; existingUrl?: string } {
  const segments = parseSectionPath(sectionPath);
  if (!segments) {
    return { ok: false, code: 'EXEC_FAILED', reason: `Invalid sectionPath: "${sectionPath}"` };
  }

  let root: Record<string, unknown> = {};
  if (rawText !== null && rawText.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!isPlainRecord(parsed)) {
        return { ok: false, code: 'EXEC_FAILED', reason: 'JSON config root must be an object' };
      }
      root = parsed;
    } catch (error) {
      return {
        ok: false,
        code: 'EXEC_FAILED',
        reason: `Malformed JSON config: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  let cursor: Record<string, unknown> = root;
  for (const seg of segments) {
    const next = cursor[seg];
    if (next === undefined) {
      const fresh: Record<string, unknown> = {};
      cursor[seg] = fresh;
      cursor = fresh;
    } else if (isPlainRecord(next)) {
      cursor = next;
    } else {
      return {
        ok: false,
        code: 'EXEC_FAILED',
        reason: `JSON config path "${sectionPath}" is not an object`,
      };
    }
  }

  const desiredTransport = value.transport ?? 'http';
  const existing = cursor[value.serverName];
  if (isPlainRecord(existing)) {
    const existingUrl = typeof existing.url === 'string' ? existing.url : undefined;
    const existingTransport =
      typeof existing.type === 'string'
        ? existing.type
        : typeof existing.transport === 'string'
          ? existing.transport
          : undefined;

    const urlsMatch =
      existingUrl !== undefined &&
      canonicalizeUrlForComparison(existingUrl) === canonicalizeUrlForComparison(value.url);

    if (!urlsMatch && conflictPolicy !== 'replace') {
      return {
        ok: false,
        code: 'CONFLICT',
        reason: existingUrl
          ? `MCP server "${value.serverName}" is already configured with a different URL`
          : `MCP server "${value.serverName}" is already configured as a local stdio entry`,
        ...(existingUrl ? { existingUrl } : {}),
      };
    }

    if (urlsMatch && (existingTransport === desiredTransport || (!value.transport && existingTransport))) {
      return { ok: true, content: rawText ?? `${JSON.stringify(root, null, 2)}\n`, changed: false };
    }

    if (existingUrl === undefined) {
      // Replacing a legacy local stdio entry: drop stale command/args fields cleanly.
      cursor[value.serverName] = {
        type: desiredTransport,
        url: value.url,
      };
    } else {
      cursor[value.serverName] = {
        ...existing,
        type: desiredTransport,
        url: value.url,
      };
    }
  } else {
    cursor[value.serverName] = {
      type: desiredTransport,
      url: value.url,
    };
  }

  return {
    ok: true,
    content: `${JSON.stringify(root, null, 2)}\n`,
    changed: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  TOML surgical read & upsert (preserves comments & unrelated sections)     */
/* -------------------------------------------------------------------------- */

function stripTomlComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function unescapeTomlBasicString(raw: string): string {
  return raw.replace(/\\(["\\ntr])/g, (_, ch: string) => {
    switch (ch) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      default:
        return ch;
    }
  });
}

function escapeTomlBasicString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function parseTomlStringValue(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeTomlBasicString(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

function parseTomlKeySegments(headerInner: string): string[] | null {
  const segments: string[] = [];
  let i = 0;
  const len = headerInner.length;
  while (i < len) {
    while (i < len && /\s/.test(headerInner[i]!)) i += 1;
    if (i >= len) break;

    const ch = headerInner[i]!;
    if (ch === '"') {
      i += 1;
      let buf = '';
      let closed = false;
      while (i < len) {
        const cur = headerInner[i]!;
        if (cur === '\\' && i + 1 < len) {
          buf += headerInner.slice(i, i + 2);
          i += 2;
        } else if (cur === '"') {
          i += 1;
          closed = true;
          break;
        } else {
          buf += cur;
          i += 1;
        }
      }
      if (!closed) return null;
      segments.push(unescapeTomlBasicString(buf));
    } else if (ch === "'") {
      i += 1;
      const start = i;
      const end = headerInner.indexOf("'", start);
      if (end === -1) return null;
      segments.push(headerInner.slice(start, end));
      i = end + 1;
    } else {
      const start = i;
      while (i < len && headerInner[i] !== '.' && !/\s/.test(headerInner[i]!)) {
        i += 1;
      }
      const token = headerInner.slice(start, i);
      if (!token) return null;
      segments.push(token);
    }

    while (i < len && /\s/.test(headerInner[i]!)) i += 1;
    if (i < len) {
      if (headerInner[i] !== '.') return null;
      i += 1;
    }
  }
  return segments.length > 0 ? segments : null;
}

function parseTomlSectionHeader(line: string): string[] | null {
  const stripped = stripTomlComment(line).trim();
  if (!stripped.startsWith('[') || stripped.startsWith('[[')) return null;
  if (!stripped.endsWith(']')) return null;
  const inner = stripped.slice(1, -1).trim();
  if (!inner) return null;
  return parseTomlKeySegments(inner);
}

function parseTomlArrayTableHeader(line: string): string[] | null {
  const stripped = stripTomlComment(line).trim();
  if (!stripped.startsWith('[[') || !stripped.endsWith(']]')) return null;
  const inner = stripped.slice(2, -2).trim();
  if (!inner || inner.startsWith('[') || inner.endsWith(']')) return null;
  return parseTomlKeySegments(inner);
}

function parseTomlKeyValueLine(line: string): { key: string; rawValue: string } | null {
  const stripped = stripTomlComment(line).trim();
  if (!stripped || stripped.startsWith('[')) return null;
  const eqIdx = stripped.indexOf('=');
  if (eqIdx === -1) return null;
  const rawKey = stripped.slice(0, eqIdx).trim();
  const rawValue = stripped.slice(eqIdx + 1).trim();
  if (!rawKey) return null;
  const parsedKey = parseTomlStringValue(rawKey) ?? rawKey;
  return { key: parsedKey, rawValue };
}

function parseInlineTomlTable(rawValue: string): Record<string, string> | null {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const inner = trimmed.slice(1, -1).trim();
  const result: Record<string, string> = {};
  if (!inner) return result;

  // Split by top-level commas outside quotes
  const parts: string[] = [];
  let start = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === ',') {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));

  for (const part of parts) {
    const kv = parseTomlKeyValueLine(part);
    if (!kv) continue;
    const strVal = parseTomlStringValue(kv.rawValue);
    if (strVal !== undefined) {
      result[kv.key] = strVal;
    }
  }
  return result;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function formatTomlKeySegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : `"${escapeTomlBasicString(segment)}"`;
}

export function parseTomlMcpEntry(
  rawText: string,
  sectionPath: string,
  serverName: string,
): { ok: true; entry?: ParsedMcpEntry } | { ok: false; reason: string } {
  const sectionSegments = parseSectionPath(sectionPath);
  if (!sectionSegments) {
    return { ok: false, reason: `Invalid sectionPath: "${sectionPath}"` };
  }
  const targetSection = [...sectionSegments, serverName];
  const lines = rawText.split(/\r?\n/);

  let currentSection: string[] = [];
  let foundTargetSection = false;
  let url: string | undefined;
  let transport: string | undefined;

  for (const line of lines) {
    const header = parseTomlSectionHeader(line);
    if (header) {
      currentSection = header;
      if (arraysEqual(currentSection, targetSection)) {
        foundTargetSection = true;
      }
      continue;
    }
    if (parseTomlArrayTableHeader(line)) {
      currentSection = [];
      continue;
    }

    const kv = parseTomlKeyValueLine(line);
    if (!kv) continue;

    if (arraysEqual(currentSection, targetSection)) {
      if (kv.key === 'url') {
        url = parseTomlStringValue(kv.rawValue);
      } else if (kv.key === 'transport' || kv.key === 'type') {
        transport = parseTomlStringValue(kv.rawValue);
      }
    } else if (arraysEqual(currentSection, sectionSegments) && kv.key === serverName) {
      const inline = parseInlineTomlTable(kv.rawValue);
      if (inline) {
        foundTargetSection = true;
        if (inline.url !== undefined) url = inline.url;
        if (inline.transport !== undefined) transport = inline.transport;
        else if (inline.type !== undefined) transport = inline.type;
      }
    }
  }

  if (!foundTargetSection) {
    return { ok: true, entry: undefined };
  }
  return {
    ok: true,
    entry: {
      serverName,
      url,
      transport,
    },
  };
}

function findTomlValueEndLine(lines: readonly string[], startIdx: number, rawValue: string): number {
  let bracketDepth = 0;
  let braceDepth = 0;
  let multilineQuote: '"""' | "'''" | null = null;

  const scanSegment = (segment: string) => {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < segment.length; i += 1) {
      const ch = segment[i]!;
      if (multilineQuote) {
        if (multilineQuote === '"""' && ch === '\\') {
          i += 1;
          continue;
        }
        if (segment.startsWith(multilineQuote, i)) {
          multilineQuote = null;
          i += 2;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '\\') {
          i += 1;
        } else if (ch === '"') {
          inDouble = false;
        }
        continue;
      }
      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
        }
        continue;
      }
      if (ch === '#') {
        break;
      }
      if (segment.startsWith('"""', i)) {
        multilineQuote = '"""';
        i += 2;
        continue;
      }
      if (segment.startsWith("'''", i)) {
        multilineQuote = "'''";
        i += 2;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '[') bracketDepth += 1;
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === '{') braceDepth += 1;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    }
  };

  scanSegment(rawValue);
  let idx = startIdx;
  while (idx + 1 < lines.length && (multilineQuote !== null || bracketDepth > 0 || braceDepth > 0)) {
    idx += 1;
    scanSegment(lines[idx]!);
  }
  return idx;
}

function validateMergedTomlBasicStructure(text: string): { ok: true } | { ok: false; reason: string } {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    if (parseTomlSectionHeader(line) || parseTomlArrayTableHeader(line)) {
      i += 1;
      continue;
    }
    const kv = parseTomlKeyValueLine(line);
    if (!kv) {
      return { ok: false, reason: `Malformed TOML line ${i + 1}: ${trimmed.slice(0, 80)}` };
    }
    i = findTomlValueEndLine(lines, i, kv.rawValue) + 1;
  }
  return { ok: true };
}

export function upsertTomlMcpEntry(
  rawText: string | null,
  sectionPath: string,
  value: { serverName: string; url: string; transport?: 'http' | 'streamable-http' | 'remote' },
  conflictPolicy: 'abort' | 'replace',
):
  | { ok: true; content: string; changed: boolean }
  | { ok: false; code: 'CONFLICT' | 'EXEC_FAILED'; reason: string; existingUrl?: string } {
  const sectionSegments = parseSectionPath(sectionPath);
  if (!sectionSegments) {
    return { ok: false, code: 'EXEC_FAILED', reason: `Invalid sectionPath: "${sectionPath}"` };
  }

  const targetSection = [...sectionSegments, value.serverName];
  const eol = rawText && rawText.includes('\r\n') ? '\r\n' : '\n';
  const source = rawText ?? '';
  const hadTrailingNewline = source.endsWith('\n') || source.length === 0;
  const lines = source.length === 0 ? [] : source.replace(/\r?\n$/, '').split(/\r?\n/);

  let currentSection: string[] = [];
  let targetHeaderLineIdx = -1;
  let targetUrlLineIdx = -1;
  let inlineLineIdx = -1;
  let existingUrl: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const header = parseTomlSectionHeader(line);
    if (header) {
      currentSection = header;
      if (arraysEqual(currentSection, targetSection) && targetHeaderLineIdx === -1) {
        targetHeaderLineIdx = i;
      }
      continue;
    }
    if (parseTomlArrayTableHeader(line)) {
      currentSection = [];
      continue;
    }

    const kv = parseTomlKeyValueLine(line);
    if (!kv) continue;

    if (arraysEqual(currentSection, targetSection) && kv.key === 'url') {
      targetUrlLineIdx = i;
      existingUrl = parseTomlStringValue(kv.rawValue);
    } else if (arraysEqual(currentSection, sectionSegments) && kv.key === value.serverName) {
      const inline = parseInlineTomlTable(kv.rawValue);
      if (inline) {
        inlineLineIdx = i;
        existingUrl = inline.url;
      }
    }
  }

  const entryExists = targetHeaderLineIdx !== -1 || inlineLineIdx !== -1;
  const urlsMatch =
    existingUrl !== undefined &&
    canonicalizeUrlForComparison(existingUrl) === canonicalizeUrlForComparison(value.url);

  if (entryExists && !urlsMatch && conflictPolicy !== 'replace') {
    return {
      ok: false,
      code: 'CONFLICT',
      reason: existingUrl
        ? `MCP server "${value.serverName}" is already configured with a different URL`
        : `MCP server "${value.serverName}" is already configured as a local stdio entry`,
      ...(existingUrl ? { existingUrl } : {}),
    };
  }

  if (urlsMatch) {
    return {
      ok: true,
      content: source,
      changed: false,
    };
  }

  const escapedUrl = escapeTomlBasicString(value.url);

  if (targetHeaderLineIdx !== -1) {
    if (targetUrlLineIdx !== -1) {
      const originalLine = lines[targetUrlLineIdx]!;
      const indentMatch = /^(\s*)/.exec(originalLine);
      const indent = indentMatch ? indentMatch[1]! : '';
      lines[targetUrlLineIdx] = `${indent}url = "${escapedUrl}"`;
    } else {
      // Replacing a legacy local stdio section: strip complete command/args value spans
      // (including multiline arrays and multiline strings) before adding url.
      let sectionEnd = targetHeaderLineIdx + 1;
      while (sectionEnd < lines.length) {
        const line = lines[sectionEnd]!;
        if (parseTomlSectionHeader(line) || parseTomlArrayTableHeader(line)) break;
        const kv = parseTomlKeyValueLine(line);
        if (kv) {
          sectionEnd = findTomlValueEndLine(lines, sectionEnd, kv.rawValue) + 1;
        } else {
          sectionEnd += 1;
        }
      }

      const preservedLines: string[] = [];
      let cursor = targetHeaderLineIdx + 1;
      while (cursor < sectionEnd) {
        const line = lines[cursor]!;
        const kv = parseTomlKeyValueLine(line);
        if (kv) {
          const endIdx = Math.min(sectionEnd - 1, findTomlValueEndLine(lines, cursor, kv.rawValue));
          if (kv.key !== 'command' && kv.key !== 'args') {
            preservedLines.push(...lines.slice(cursor, endIdx + 1));
          }
          cursor = endIdx + 1;
        } else {
          preservedLines.push(line);
          cursor += 1;
        }
      }

      lines.splice(
        targetHeaderLineIdx + 1,
        sectionEnd - (targetHeaderLineIdx + 1),
        `url = "${escapedUrl}"`,
        ...preservedLines,
      );
    }
  } else if (inlineLineIdx !== -1) {
    const originalLine = lines[inlineLineIdx]!;
    const indentMatch = /^(\s*)/.exec(originalLine);
    const indent = indentMatch ? indentMatch[1]! : '';
    const keyToken = formatTomlKeySegment(value.serverName);
    lines[inlineLineIdx] = `${indent}${keyToken} = { url = "${escapedUrl}" }`;
  } else {
    const headerText = `[${targetSection.map(formatTomlKeySegment).join('.')}]`;
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') {
      lines.push('');
    }
    lines.push(headerText);
    lines.push(`url = "${escapedUrl}"`);
  }

  const joined = lines.join(eol) + (hadTrailingNewline ? eol : '');
  const structureCheck = validateMergedTomlBasicStructure(joined);
  if (!structureCheck.ok) {
    return {
      ok: false,
      code: 'EXEC_FAILED',
      reason: `Refusing to write malformed TOML: ${structureCheck.reason}`,
    };
  }
  return {
    ok: true,
    content: joined,
    changed: true,
  };
}

/**
 * Shared read-only helper used by both `atom.config.read`, `atom.detect`, and `atom.exec`.
 */
export function readMcpEntryFromFile(params: {
  filePath: string;
  fileFormat: 'json' | 'toml';
  sectionPath: string;
  serverName: string;
}): { ok: true; exists: boolean; entry?: ParsedMcpEntry } | { ok: false; reason: string } {
  if (!existsSync(params.filePath)) {
    return { ok: true, exists: false, entry: undefined };
  }
  let rawText: string;
  try {
    rawText = readFileSync(params.filePath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: `Failed to read config file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed =
    params.fileFormat === 'json'
      ? parseJsonMcpEntry(rawText, params.sectionPath, params.serverName)
      : parseTomlMcpEntry(rawText, params.sectionPath, params.serverName);
  if (!parsed.ok) return parsed;
  return { ok: true, exists: true, entry: parsed.entry };
}

/* -------------------------------------------------------------------------- */
/*  ConfigAtom implementation                                                 */
/* -------------------------------------------------------------------------- */

export class ConfigAtom {
  private readonly dataDir: string;
  private readonly homeDir: string;
  private readonly channel: HostReleaseChannel;
  private readonly allowLocalDevLoopback: boolean;
  private readonly expectedMcpUrl?: string;
  private readonly getExpectedMcpUrl?: () => string | undefined;
  private readonly getSignedConfig: () => SignedConfigPayload;
  private readonly confirmationGate: FeatureConfirmationGate;
  private readonly mutationQueue: SerialMutationQueue;
  private readonly now: () => Date;

  constructor(deps: ConfigAtomDeps) {
    this.dataDir = deps.dataDir;
    this.homeDir = deps.homeDir ?? os.homedir();
    this.channel = deps.channel ?? 'stable';
    this.allowLocalDevLoopback = deps.allowLocalDevLoopback ?? false;
    this.expectedMcpUrl = deps.expectedMcpUrl;
    this.getExpectedMcpUrl = deps.getExpectedMcpUrl;
    this.getSignedConfig = deps.getSignedConfig;
    this.confirmationGate = deps.confirmationGate;
    this.mutationQueue = deps.mutationQueue;
    this.now = deps.now ?? (() => new Date());
  }

  private resolveAuthoritativeMcpUrl(signedConfig: SignedConfigPayload): string | undefined {
    const candidate =
      this.getExpectedMcpUrl?.()?.trim() ||
      this.expectedMcpUrl?.trim() ||
      (signedConfig.studioUrl?.trim()
        ? `${signedConfig.studioUrl.trim().replace(/\/+$/, '')}/mcp`
        : undefined);
    return candidate ? canonicalizeUrlForComparison(candidate) : undefined;
  }

  /**
   * Read-only config inspection. Never acquires `SerialMutationQueue` or prompts user.
   */
  async read(params: AtomConfigReadParams): Promise<HostInvokeResult<AtomConfigReadResult>> {
    if (!params || typeof params.ruleId !== 'string' || !params.ruleId.trim()) {
      return hostErr('INVALID_PARAMS', 'ruleId is required');
    }
    const serverName = params.serverName ?? DEFAULT_MCP_SERVER_NAME;
    const serverCheck = validateTypedPlaceholderValue('identifier', serverName);
    if (!serverCheck.ok) {
      return hostErr('INVALID_PARAMS', serverCheck.reason);
    }

    const ruleResult = this.resolveRule(params.ruleId);
    if (!ruleResult.ok) return ruleResult;
    const { rule, configPath } = ruleResult.data;

    const readResult = readMcpEntryFromFile({
      filePath: configPath,
      fileFormat: rule.fileFormat,
      sectionPath: rule.sectionPath,
      serverName: serverCheck.value,
    });
    if (!readResult.ok) {
      return hostErr('EXEC_FAILED', readResult.reason, { ruleId: rule.ruleId, configPath });
    }

    return hostOk({
      ruleId: rule.ruleId,
      configPath,
      exists: readResult.exists,
      entry: readResult.entry,
    });
  }

  /**
   * Returns shell-computed confirmation facts for a config write without modifying disk.
   */
  previewWrite(params: AtomConfigWriteParams): HostInvokeResult<{
    ruleId: string;
    configPath: string;
    facts: ConfirmationFact[];
  }> {
    const validated = this.validateWriteParams(params);
    if (!validated.ok) return validated;
    const { rule, configPath, serverName, url } = validated.data;
    return hostOk({
      ruleId: rule.ruleId,
      configPath,
      facts: this.buildWriteFacts(rule, configPath, serverName, url),
    });
  }

  async write(params: AtomConfigWriteParams): Promise<HostInvokeResult<AtomConfigWriteResult>> {
    const validated = this.validateWriteParams(params);
    if (!validated.ok) return validated;

    const { signedConfig, rule, configPath, serverName, url, transport, conflictPolicy } = validated.data;

    const authCheck = assertFeatureAllowsResource(params.featureId, signedConfig, {
      kind: 'configRule',
      id: rule.ruleId,
    });
    if (!authCheck.ok) return authCheck;

    const facts = this.buildWriteFacts(rule, configPath, serverName, url);
    const approval = await this.confirmationGate.ensureApproved({
      featureId: params.featureId,
      signedConfig,
      facts,
    });
    if (!approval.ok) return approval;

    return this.mutationQueue.enqueue(async () => {
      const fileExists = existsSync(configPath);
      const rawText = fileExists ? readFileSync(configPath, 'utf8') : null;

      const merged =
        rule.fileFormat === 'json'
          ? upsertJsonMcpEntry(rawText, rule.sectionPath, { serverName, url, transport }, conflictPolicy)
          : upsertTomlMcpEntry(rawText, rule.sectionPath, { serverName, url, transport }, conflictPolicy);

      if (!merged.ok) {
        if (merged.code === 'CONFLICT') {
          return hostErr('CONFLICT', merged.reason, {
            ruleId: rule.ruleId,
            configPath,
            serverName,
            existingUrl: merged.existingUrl,
            requestedUrl: url,
          });
        }
        return hostErr('EXEC_FAILED', merged.reason, { ruleId: rule.ruleId, configPath });
      }

      if (!merged.changed) {
        return hostOk({
          ruleId: rule.ruleId,
          configPath,
          changed: false,
        });
      }

      let backupPath: string | undefined;
      if (fileExists) {
        backupPath = this.createBackup(rule.ruleId, configPath);
      }

      try {
        writeAtomicFile(configPath, merged.content);
      } catch (error) {
        return hostErr(
          'EXEC_FAILED',
          `Failed to write config file: ${error instanceof Error ? error.message : String(error)}`,
          { ruleId: rule.ruleId, configPath, backupPath },
        );
      }

      return hostOk({
        ruleId: rule.ruleId,
        configPath,
        backupPath,
        changed: true,
      });
    }, `atom.config.write:${rule.ruleId}`);
  }

  async restoreBackup(params: AtomConfigRestoreParams): Promise<HostInvokeResult<AtomConfigRestoreResult>> {
    if (!params || typeof params.backupPath !== 'string' || !params.backupPath.trim()) {
      return hostErr('INVALID_PARAMS', 'backupPath is required');
    }

    const backupsDir = path.resolve(this.dataDir, BACKUPS_DIR_NAME);
    const resolvedBackup = path.resolve(params.backupPath);
    const rel = path.relative(backupsDir, resolvedBackup);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return hostErr('POLICY_DENIED', 'Backup path must reside inside host backups directory', {
        backupPath: params.backupPath,
      });
    }

    const record = this.readBackupIndex().find(entry => path.resolve(entry.backupPath) === resolvedBackup);
    if (!record) {
      return hostErr('NOT_FOUND', 'Backup record not found in host backup provenance index', {
        backupPath: params.backupPath,
      });
    }
    if (!existsSync(resolvedBackup)) {
      return hostErr('NOT_FOUND', 'Backup file no longer exists on disk', {
        backupPath: params.backupPath,
      });
    }

    if (!params.featureId || typeof params.featureId !== 'string') {
      return hostErr('INVALID_PARAMS', 'featureId is required to restore a config backup');
    }
    const signedConfig = this.getSignedConfig();
    const authCheck = assertFeatureAllowsResource(params.featureId, signedConfig, {
      kind: 'configRule',
      id: record.ruleId,
    });
    if (!authCheck.ok) return authCheck;

    const approval = await this.confirmationGate.ensureApproved({
      featureId: params.featureId,
      signedConfig,
      facts: [
        {
          kind: 'modify_file',
          label: 'Restore config backup',
          value: record.targetPath,
        },
      ],
    });
    if (!approval.ok) return approval;

    return this.mutationQueue.enqueue(async () => {
      try {
        const content = readFileSync(resolvedBackup, 'utf8');
        writeAtomicFile(record.targetPath, content);
        return hostOk({
          backupPath: resolvedBackup,
          restoredPath: record.targetPath,
          ruleId: record.ruleId,
        });
      } catch (error) {
        return hostErr(
          'EXEC_FAILED',
          `Failed to restore backup: ${error instanceof Error ? error.message : String(error)}`,
          { backupPath: resolvedBackup, targetPath: record.targetPath },
        );
      }
    }, `atom.config.restoreBackup:${record.ruleId}`);
  }

  listBackups(): BackupRecord[] {
    return [...this.readBackupIndex()];
  }

  private resolveRule(
    ruleId: string,
  ): HostInvokeResult<{ signedConfig: SignedConfigPayload; rule: SignedAgentConfigRule; configPath: string }> {
    const signedConfig = this.getSignedConfig();
    const rule = signedConfig.configRules?.[ruleId];
    if (!rule) {
      return hostErr('POLICY_DENIED', `Unknown config ruleId: "${ruleId}"`, { ruleId });
    }
    if (!isBuiltinConfigFieldType(rule.fieldType)) {
      return hostErr('POLICY_DENIED', `Unsupported config field type: "${String(rule.fieldType)}"`, {
        ruleId,
        fieldType: rule.fieldType,
      });
    }
    if (rule.fileFormat !== 'json' && rule.fileFormat !== 'toml') {
      return hostErr('POLICY_DENIED', `Unsupported config file format: "${String(rule.fileFormat)}"`, { ruleId });
    }
    if (!isAllowedMcpConfigRelativePath(rule.homeRelativePath, rule.fileFormat)) {
      return hostErr('POLICY_DENIED', `Disallowed config file path: "${rule.homeRelativePath}"`, {
        ruleId,
        homeRelativePath: rule.homeRelativePath,
      });
    }
    const pathCheck = resolveSafeHomePath(this.homeDir, rule.homeRelativePath);
    if (!pathCheck.ok) {
      return hostErr('POLICY_DENIED', pathCheck.reason, { ruleId, homeRelativePath: rule.homeRelativePath });
    }
    return hostOk({ signedConfig, rule, configPath: pathCheck.resolvedPath });
  }

  private validateWriteParams(params: AtomConfigWriteParams): HostInvokeResult<{
    signedConfig: SignedConfigPayload;
    rule: SignedAgentConfigRule;
    configPath: string;
    serverName: string;
    url: string;
    transport?: 'http' | 'streamable-http' | 'remote';
    conflictPolicy: 'abort' | 'replace';
  }> {
    if (!params || typeof params !== 'object') {
      return hostErr('INVALID_PARAMS', 'Config write params are required');
    }
    if (!params.featureId || typeof params.featureId !== 'string') {
      return hostErr('INVALID_PARAMS', 'featureId is required');
    }
    if (!params.ruleId || typeof params.ruleId !== 'string') {
      return hostErr('INVALID_PARAMS', 'ruleId is required');
    }
    if (!isBuiltinConfigFieldType(params.fieldType)) {
      return hostErr('POLICY_DENIED', `Disallowed config fieldType: "${String(params.fieldType)}"`, {
        fieldType: params.fieldType,
      });
    }
    if (!params.value || typeof params.value !== 'object') {
      return hostErr('INVALID_PARAMS', 'value object is required');
    }

    const ruleResult = this.resolveRule(params.ruleId);
    if (!ruleResult.ok) return ruleResult;
    const { signedConfig, rule, configPath } = ruleResult.data;

    if (rule.fieldType !== params.fieldType) {
      return hostErr('POLICY_DENIED', `Field type mismatch for rule "${rule.ruleId}"`, {
        ruleId: rule.ruleId,
        expected: rule.fieldType,
        received: params.fieldType,
      });
    }

    const serverCheck = validateTypedPlaceholderValue('identifier', params.value.serverName);
    if (!serverCheck.ok) {
      return hostErr('INVALID_PARAMS', serverCheck.reason, { field: 'value.serverName' });
    }

    const urlCheck = validateTypedPlaceholderValue('url_in_domain_scope', params.value.url, {
      channel: this.channel,
      allowLocalDevLoopback: this.allowLocalDevLoopback,
    });
    if (!urlCheck.ok) {
      return hostErr('POLICY_DENIED', urlCheck.reason, { field: 'value.url', url: params.value.url });
    }

    const authoritativeMcpUrl = this.resolveAuthoritativeMcpUrl(signedConfig);
    if (
      params.fieldType === 'remote_mcp_entry' &&
      authoritativeMcpUrl &&
      canonicalizeUrlForComparison(urlCheck.value) !== authoritativeMcpUrl
    ) {
      return hostErr(
        'ORIGIN_DENIED',
        `MCP URL must match the shell-configured endpoint (${authoritativeMcpUrl})`,
        {
          field: 'value.url',
          requestedUrl: urlCheck.value,
          expectedMcpUrl: authoritativeMcpUrl,
        },
      );
    }

    if (
      params.value.transport !== undefined &&
      params.value.transport !== 'http' &&
      params.value.transport !== 'streamable-http' &&
      params.value.transport !== 'remote'
    ) {
      return hostErr('INVALID_PARAMS', `Unsupported MCP transport: "${String(params.value.transport)}"`);
    }

    const effectiveTransport =
      params.value.transport ?? (rule.entryFormat === 'opencode_remote' ? 'remote' : undefined);

    const conflictPolicy = params.conflictPolicy ?? 'abort';
    if (conflictPolicy !== 'abort' && conflictPolicy !== 'replace') {
      return hostErr('INVALID_PARAMS', `Invalid conflictPolicy: "${String(conflictPolicy)}"`);
    }

    return hostOk({
      signedConfig,
      rule,
      configPath,
      serverName: serverCheck.value,
      url: urlCheck.value,
      transport: effectiveTransport,
      conflictPolicy,
    });
  }

  private buildWriteFacts(
    rule: SignedAgentConfigRule,
    configPath: string,
    serverName: string,
    url: string,
  ): ConfirmationFact[] {
    return [
      {
        kind: 'modify_file',
        label: `Update ${rule.displayName} config (${serverName})`,
        value: configPath,
      },
      {
        kind: 'connect_url',
        label: `Configure MCP endpoint (${serverName})`,
        value: url,
      },
    ];
  }

  private createBackup(ruleId: string, targetPath: string): string {
    const backupsDir = path.join(this.dataDir, BACKUPS_DIR_NAME);
    mkdirSync(backupsDir, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const safeRule = ruleId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const nonce = randomBytes(4).toString('hex');
    const backupPath = path.join(backupsDir, `${safeRule}-${stamp}-${nonce}.bak`);
    copyFileSync(targetPath, backupPath);

    const records = this.readBackupIndex();
    records.push({
      backupPath,
      targetPath,
      ruleId,
      createdAt: this.now().toISOString(),
    });
    this.writeBackupIndex(records);
    return backupPath;
  }

  private readBackupIndex(): BackupRecord[] {
    const indexPath = path.join(this.dataDir, BACKUPS_DIR_NAME, BACKUPS_INDEX_FILE);
    if (!existsSync(indexPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<BackupIndexFile>;
      if (!parsed || !Array.isArray(parsed.backups)) return [];
      return parsed.backups.filter(
        (item): item is BackupRecord =>
          Boolean(item) &&
          typeof item.backupPath === 'string' &&
          typeof item.targetPath === 'string' &&
          typeof item.ruleId === 'string' &&
          typeof item.createdAt === 'string',
      );
    } catch {
      return [];
    }
  }

  private writeBackupIndex(records: BackupRecord[]): void {
    const indexPath = path.join(this.dataDir, BACKUPS_DIR_NAME, BACKUPS_INDEX_FILE);
    const payload: BackupIndexFile = {
      schemaVersion: 1,
      backups: records,
    };
    writeAtomicFile(indexPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

export function createConfigAtom(deps: ConfigAtomDeps): ConfigAtom {
  return new ConfigAtom(deps);
}
