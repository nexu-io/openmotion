import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_STUDIO_URLS,
  isUrlInAllowedDomainScope,
} from '../../shared/desktop-builtin-rules.ts';
import type { HostReleaseChannel } from '../../shared/desktop-contract.ts';

export const MAX_RECENT_ENVIRONMENTS = 6;
export const DEFAULT_LOCAL_DEV_STUDIO_URL = DEFAULT_STUDIO_URLS.dev;

export type DesktopEnvironmentRecord = {
  url: string;
  lastUsedAt: string;
};

export type DesktopEnvironmentState = {
  overrideUrl: string | null;
  recent: DesktopEnvironmentRecord[];
};

export type ValidatedEnvironmentUrl =
  | {
      ok: true;
      normalizedUrl: string;
      origin: string;
      isLoopback: boolean;
    }
  | {
      ok: false;
      reason: string;
    };

export type DesktopEnvironmentDescription = {
  url: string;
  origin: string;
  badge: string;
  label: string;
  isCustomOverride: boolean;
  isLoopback: boolean;
};

export type TestEnvironmentValidationOptions = {
  channel: HostReleaseChannel;
  /** Optional extra HTTPS base domains (e.g. future Orbit lane domains). */
  extraAllowedDomains?: readonly string[];
  /** Optional extra HTTPS hostname patterns (e.g. future Orbit lane host regexes). */
  extraAllowedHostPatterns?: readonly RegExp[];
};

export function isEnvironmentSwitcherEnabled(channel: HostReleaseChannel): boolean {
  return channel === 'test' || channel === 'dev';
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  return normalized === '127.0.0.1' || normalized === 'localhost';
}

export function parseExplicitLoopbackOrigin(rawUrl: string): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  if (/[\x00-\x1f\x7f]/.test(rawUrl)) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (!isLoopbackHostname(parsed.hostname)) return null;
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  return parsed.origin;
}

function matchesExtraHttpsAllowlist(
  hostname: string,
  options: TestEnvironmentValidationOptions,
): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return false;
  for (const domain of options.extraAllowedDomains ?? []) {
    const clean = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (clean && (normalized === clean || normalized.endsWith(`.${clean}`))) {
      return true;
    }
  }
  for (const pattern of options.extraAllowedHostPatterns ?? []) {
    if (pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates a target Studio URL for test/dev environment switching.
 *
 * Security invariants:
 * - Always fails closed on `stable` builds (zero override surface).
 * - Rejects credentials, control characters, and non-http(s) protocols.
 * - Accepts `https:` origins within `BUILTIN_ALLOWED_DOMAINS_TEST` (plus any
 *   explicitly configured Orbit lane domain patterns) and local loopback
 *   `http://127.0.0.1:<port>` / `http://localhost:<port>` for local Studio dev.
 */
export function validateTestEnvironmentUrl(
  rawUrl: string,
  options: TestEnvironmentValidationOptions,
): ValidatedEnvironmentUrl {
  if (!isEnvironmentSwitcherEnabled(options.channel)) {
    return { ok: false, reason: 'Environment switching is disabled in stable releases.' };
  }
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, reason: 'Environment URL must be a non-empty URL.' };
  }
  const trimmed = rawUrl.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { ok: false, reason: 'Environment URL contains invalid control characters.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Enter a valid URL (for example https://motion.open-design.ai or http://127.0.0.1:4173).' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Environment URL must not contain embedded credentials.' };
  }

  if (parsed.protocol === 'http:') {
    const loopbackOrigin = parseExplicitLoopbackOrigin(trimmed);
    if (!loopbackOrigin) {
      return {
        ok: false,
        reason: 'HTTP is only allowed for local loopback (http://127.0.0.1:<port> or http://localhost:<port>).',
      };
    }
    return {
      ok: true,
      normalizedUrl: loopbackOrigin,
      origin: loopbackOrigin,
      isLoopback: true,
    };
  }

  if (parsed.protocol === 'https:') {
    const inBuiltinScope = isUrlInAllowedDomainScope(parsed.origin, {
      channel: options.channel,
      allowLocalDevLoopback: false,
    });
    const inExtraScope = matchesExtraHttpsAllowlist(parsed.hostname, options);
    if (!inBuiltinScope && !inExtraScope) {
      return {
        ok: false,
        reason: `Host "${parsed.hostname}" is outside the allowed test environment domains.`,
      };
    }
    return {
      ok: true,
      normalizedUrl: parsed.origin,
      origin: parsed.origin,
      isLoopback: false,
    };
  }

  return { ok: false, reason: 'Only https:// test origins and local http://127.0.0.1 URLs are allowed.' };
}

/**
 * Resolves the Electron `webPreferences.partition` for a given Studio URL.
 *
 * - Default channel origin -> `undefined` (keeps Electron default session).
 * - Any custom override / Orbit lane / local dev origin -> isolated persistent
 *   partition keyed by SHA-256 of the origin so cookies, LocalStorage, and
 *   ServiceWorkers never bleed across environments.
 */
export function resolveEnvironmentSessionPartition(
  activeUrl: string,
  defaultUrl: string,
): string | undefined {
  try {
    const activeOrigin = new URL(activeUrl).origin;
    const defaultOrigin = new URL(defaultUrl).origin;
    if (activeOrigin === defaultOrigin) {
      return undefined;
    }
    const digest = createHash('sha256').update(activeOrigin).digest('hex').slice(0, 12);
    return `persist:om-env-${digest}`;
  } catch {
    return undefined;
  }
}

export function describeDesktopEnvironment(
  activeUrl: string,
  options: { channel: HostReleaseChannel; defaultUrl: string },
): DesktopEnvironmentDescription {
  let parsedActive: URL | null = null;
  let parsedDefault: URL | null = null;
  try {
    parsedActive = new URL(activeUrl);
  } catch {
    parsedActive = null;
  }
  try {
    parsedDefault = new URL(options.defaultUrl);
  } catch {
    parsedDefault = null;
  }

  const origin = parsedActive?.origin ?? activeUrl;
  const defaultOrigin = parsedDefault?.origin ?? options.defaultUrl;
  const isCustomOverride = origin !== defaultOrigin;
  const hostname = parsedActive?.hostname.toLowerCase() ?? '';
  const isLoopback = isLoopbackHostname(hostname);

  if (isLoopback) {
    const portSuffix = parsedActive?.port ? `:${parsedActive.port}` : '';
    return {
      url: origin,
      origin,
      badge: `LOCAL ${portSuffix || ':80'}`.trim(),
      label: `Local (${hostname}${portSuffix})`,
      isCustomOverride,
      isLoopback: true,
    };
  }

  if (!isCustomOverride && options.channel === 'test') {
    return {
      url: origin,
      origin,
      badge: 'TEST',
      label: `Test (${hostname})`,
      isCustomOverride: false,
      isLoopback: false,
    };
  }

  if (!isCustomOverride && options.channel === 'stable') {
    return {
      url: origin,
      origin,
      badge: '',
      label: hostname || origin,
      isCustomOverride: false,
      isLoopback: false,
    };
  }

  // Extract concise lane/subdomain label (e.g. `pr-482.openmotion.powerformer.net` -> `PR-482`).
  const firstSegment = hostname.split('.')[0] || hostname;
  const badge =
    hostname.endsWith('.openmotion.powerformer.net') || hostname.endsWith('.open-design.ai')
      ? firstSegment.toUpperCase()
      : hostname.toUpperCase();

  return {
    url: origin,
    origin,
    badge: badge.slice(0, 24),
    label: hostname || origin,
    isCustomOverride,
    isLoopback: false,
  };
}

/**
 * Extracts `--studio-url=<url>` or `--studio-url <url>` from process argv.
 * Always returns `undefined` on `stable` releases.
 */
export function extractStudioUrlFromArgv(
  argv: readonly string[],
  options: TestEnvironmentValidationOptions,
): string | undefined {
  if (!isEnvironmentSwitcherEnabled(options.channel)) return undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    let candidate: string | undefined;
    if (token.startsWith('--studio-url=')) {
      candidate = token.slice('--studio-url='.length);
    } else if (token === '--studio-url' && typeof argv[i + 1] === 'string') {
      candidate = argv[i + 1];
    }
    if (candidate) {
      const checked = validateTestEnvironmentUrl(candidate, options);
      if (checked.ok) {
        return checked.normalizedUrl;
      }
    }
  }
  return undefined;
}

/**
 * Parses comma-separated extra allowed HTTPS domains from env (non-stable only)
 * so new Orbit lane root domains can be tested before being baked into rules.
 */
export function parseExtraAllowedEnvDomains(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const result: string[] = [];
  for (const part of raw.split(',')) {
    const clean = part.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (clean && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean) && !clean.includes('..')) {
      result.push(clean);
    }
  }
  return result;
}

function sanitizeEnvironmentState(
  raw: unknown,
  options: TestEnvironmentValidationOptions,
): DesktopEnvironmentState {
  if (!isEnvironmentSwitcherEnabled(options.channel) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { overrideUrl: null, recent: [] };
  }
  const record = raw as Record<string, unknown>;
  let overrideUrl: string | null = null;
  if (typeof record.overrideUrl === 'string' && record.overrideUrl.trim()) {
    const checked = validateTestEnvironmentUrl(record.overrideUrl, options);
    if (checked.ok) {
      overrideUrl = checked.normalizedUrl;
    }
  }

  const recent: DesktopEnvironmentRecord[] = [];
  const seenOrigins = new Set<string>();
  if (Array.isArray(record.recent)) {
    for (const item of record.recent) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.url !== 'string') continue;
      const checked = validateTestEnvironmentUrl(entry.url, options);
      if (!checked.ok || seenOrigins.has(checked.origin)) continue;
      seenOrigins.add(checked.origin);
      recent.push({
        url: checked.normalizedUrl,
        lastUsedAt:
          typeof entry.lastUsedAt === 'string' && entry.lastUsedAt.trim()
            ? entry.lastUsedAt.trim()
            : new Date(0).toISOString(),
      });
      if (recent.length >= MAX_RECENT_ENVIRONMENTS) break;
    }
  }

  return { overrideUrl, recent };
}

export function readDesktopEnvironmentState(
  filePath: string,
  options: TestEnvironmentValidationOptions,
): DesktopEnvironmentState {
  if (!isEnvironmentSwitcherEnabled(options.channel)) {
    return { overrideUrl: null, recent: [] };
  }
  try {
    if (!existsSync(filePath)) return { overrideUrl: null, recent: [] };
    if (lstatSync(filePath).isSymbolicLink()) return { overrideUrl: null, recent: [] };
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return sanitizeEnvironmentState(parsed, options);
  } catch {
    return { overrideUrl: null, recent: [] };
  }
}

export function writeDesktopEnvironmentState(
  filePath: string,
  state: DesktopEnvironmentState,
  options: TestEnvironmentValidationOptions,
): boolean {
  if (!isEnvironmentSwitcherEnabled(options.channel)) {
    return false;
  }
  try {
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
      return false;
    }
    const sanitized = sanitizeEnvironmentState(state, options);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

export class DesktopEnvironmentStore {
  private readonly filePath: string;
  private readonly validationOptions: TestEnvironmentValidationOptions;
  private cached: DesktopEnvironmentState;

  constructor(filePath: string, validationOptions: TestEnvironmentValidationOptions) {
    this.filePath = filePath;
    this.validationOptions = validationOptions;
    this.cached = readDesktopEnvironmentState(filePath, validationOptions);
  }

  get(): DesktopEnvironmentState {
    return {
      overrideUrl: this.cached.overrideUrl,
      recent: this.cached.recent.map(item => ({ ...item })),
    };
  }

  setOverride(rawUrl: string | null, nowIso = new Date().toISOString()): ValidatedEnvironmentUrl | { ok: true; normalizedUrl: null; origin: null; isLoopback: false } {
    if (!isEnvironmentSwitcherEnabled(this.validationOptions.channel)) {
      return { ok: false, reason: 'Environment switching is disabled in stable releases.' };
    }
    if (rawUrl === null) {
      this.cached = {
        overrideUrl: null,
        recent: this.cached.recent,
      };
      writeDesktopEnvironmentState(this.filePath, this.cached, this.validationOptions);
      return { ok: true, normalizedUrl: null, origin: null, isLoopback: false };
    }

    const checked = validateTestEnvironmentUrl(rawUrl, this.validationOptions);
    if (!checked.ok) {
      return checked;
    }

    const nextRecent: DesktopEnvironmentRecord[] = [
      { url: checked.normalizedUrl, lastUsedAt: nowIso },
      ...this.cached.recent.filter(item => item.url !== checked.normalizedUrl),
    ].slice(0, MAX_RECENT_ENVIRONMENTS);

    this.cached = {
      overrideUrl: checked.normalizedUrl,
      recent: nextRecent,
    };
    writeDesktopEnvironmentState(this.filePath, this.cached, this.validationOptions);
    return checked;
  }

  reset(): void {
    if (!isEnvironmentSwitcherEnabled(this.validationOptions.channel)) return;
    this.cached = {
      overrideUrl: null,
      recent: this.cached.recent,
    };
    writeDesktopEnvironmentState(this.filePath, this.cached, this.validationOptions);
  }
}
