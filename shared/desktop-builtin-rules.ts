/**
 * Q1 Frozen Built-in Shell Rules (Security Boundary).
 *
 * Principle (Design Doc §5.6):
 * The shell defines WHAT kinds of operations exist; signed config only
 * chooses WHO to target and WHAT parameter values to supply within these
 * built-in boundaries.
 */

import type { BuiltinConfigFieldType, HostReleaseChannel } from './desktop-contract.ts';

export const DESKTOP_APP_ID = 'io.nexu.openmotion.desktop' as const;
export const DESKTOP_PRODUCT_NAME = 'OpenDesign' as const;
export const DESKTOP_PROTOCOL_SCHEME = 'openmotion' as const;
export const DESKTOP_DATA_LAYOUT_VERSION = 1 as const;
export const DEFAULT_MCP_SERVER_NAME = 'openmotion' as const;

const STAGING_STUDIO_HOST = 'openmotion.powerformer.net';

export const DEFAULT_STUDIO_URLS: Record<HostReleaseChannel, string> = {
  stable: 'https://motion.open-design.ai',
  test: `https://${STAGING_STUDIO_HOST}`,
  dev: 'http://127.0.0.1:4173',
};

export const DEFAULT_UPDATE_BASE_URL = 'https://releases.open-design.ai/open-motion/desktop' as const;
export const DEFAULT_SIGNED_CONFIG_BASE_URL = 'https://releases.open-design.ai/open-motion/desktop/config' as const;
export const DEFAULT_DESKTOP_DOWNLOAD_URL = 'https://open-design.ai' as const;

/**
 * Allowed domains baked into the shell.
 * Production ('stable') is strictly locked to open-design.ai and its subdomains.
 * Test/dev builds additionally allow openmotion.powerformer.net (staging).
 */
export const BUILTIN_ALLOWED_DOMAINS_STABLE: readonly string[] = ['open-design.ai'] as const;
export const BUILTIN_ALLOWED_DOMAINS_TEST: readonly string[] = [
  'open-design.ai',
  'openmotion.powerformer.net',
] as const;

/**
 * Built-in config field types allowed for atom.config in v1.
 */
export const BUILTIN_CONFIG_FIELD_TYPES: readonly BuiltinConfigFieldType[] = ['remote_mcp_entry'] as const;

/**
 * Built-in signed binary publisher allowlist (v1).
 * Contains the Apple Developer Team ID(s) and Windows Authenticode certificate
 * thumbprints authorized to sign first-party components (such as the Murmur
 * engine and future Local Bridge Daemon).
 *
 * Production desktop builds inject the real publisher Team ID and Windows
 * Authenticode thumbprints at bundle time via `desktop/scripts/build.mjs`.
 */
declare const __OPENMOTION_MURMUR_APPLE_TEAM_ID__: string | undefined;
declare const __OPENMOTION_MURMUR_WIN_THUMBPRINTS__: string | undefined;

export type BuiltinPublisherEntry = {
  id: string;
  label: string;
  appleTeamId: string;
  /** Optional pinned Windows Authenticode signer cert thumbprints (SHA-1 40-hex or SHA-256 64-hex, uppercase). */
  windowsThumbprints?: readonly string[];
};

function resolveInjectedMurmurTeamId(): string {
  const injected =
    typeof __OPENMOTION_MURMUR_APPLE_TEAM_ID__ === 'string'
      ? __OPENMOTION_MURMUR_APPLE_TEAM_ID__.trim()
      : '';
  return injected || 'POWERFORMER_MURMUR_TEAM_ID_PENDING';
}

function resolveInjectedMurmurWinThumbprints(): readonly string[] {
  const raw =
    typeof __OPENMOTION_MURMUR_WIN_THUMBPRINTS__ === 'string'
      ? __OPENMOTION_MURMUR_WIN_THUMBPRINTS__.trim()
      : '';
  if (!raw) return [];
  return raw
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(item => /^[0-9A-F]{40}$|^[0-9A-F]{64}$/.test(item));
}

const injectedMurmurWinThumbprints = resolveInjectedMurmurWinThumbprints();

export const BUILTIN_PUBLISHERS: readonly BuiltinPublisherEntry[] = [
  {
    id: 'powerformer-murmur',
    label: 'Powerformer / Murmur Signing Team',
    appleTeamId: resolveInjectedMurmurTeamId(),
    ...(injectedMurmurWinThumbprints.length > 0
      ? { windowsThumbprints: injectedMurmurWinThumbprints }
      : {}),
  },
] as const;

export type TemplatePlaceholderType =
  | 'identifier'
  | 'url_in_domain_scope'
  | 'agent_id'
  | 'model_id'
  | 'semver'
  | 'boolean';

export type BuiltinThirdPartyTemplate = {
  templateId: string;
  program: 'codex' | 'claude';
  mutating: boolean;
  /** Argv tokens; `{paramName}` denotes a typed placeholder. Never passed to a shell. */
  argv: readonly string[];
  params: Record<string, { type: TemplatePlaceholderType; required?: boolean; defaultValue?: string }>;
  description: string;
};

/**
 * Built-in third-party CLI allowlist (v1): codex and claude only,
 * each with version, remote MCP register, and MCP remove templates.
 */
export const BUILTIN_THIRD_PARTY_PROGRAMS = ['codex', 'claude'] as const;
export type BuiltinThirdPartyProgram = (typeof BUILTIN_THIRD_PARTY_PROGRAMS)[number];

export const BUILTIN_THIRD_PARTY_TEMPLATES: readonly BuiltinThirdPartyTemplate[] = [
  {
    templateId: 'codex.version',
    program: 'codex',
    mutating: false,
    argv: ['--version'],
    params: {},
    description: 'Read installed Codex CLI version',
  },
  {
    templateId: 'codex.mcp.add_remote',
    program: 'codex',
    mutating: true,
    argv: ['mcp', 'add', '{serverName}', '--url', '{mcpUrl}'],
    params: {
      serverName: { type: 'identifier', required: false, defaultValue: DEFAULT_MCP_SERVER_NAME },
      mcpUrl: { type: 'url_in_domain_scope', required: false },
    },
    description: 'Register remote OpenMotion MCP server in Codex CLI',
  },
  {
    templateId: 'codex.mcp.remove',
    program: 'codex',
    mutating: true,
    argv: ['mcp', 'remove', '{serverName}'],
    params: {
      serverName: { type: 'identifier', required: false, defaultValue: DEFAULT_MCP_SERVER_NAME },
    },
    description: 'Remove OpenMotion MCP server from Codex CLI',
  },
  {
    templateId: 'claude.version',
    program: 'claude',
    mutating: false,
    argv: ['--version'],
    params: {},
    description: 'Read installed Claude Code CLI version',
  },
  {
    templateId: 'claude.mcp.add_remote',
    program: 'claude',
    mutating: true,
    argv: ['mcp', 'add', '--scope', 'user', '--transport', 'http', '{serverName}', '{mcpUrl}'],
    params: {
      serverName: { type: 'identifier', required: false, defaultValue: DEFAULT_MCP_SERVER_NAME },
      mcpUrl: { type: 'url_in_domain_scope', required: false },
    },
    description: 'Register remote OpenMotion MCP server in Claude Code CLI (user scope)',
  },
  {
    templateId: 'claude.mcp.remove',
    program: 'claude',
    mutating: true,
    argv: ['mcp', 'remove', '--scope', 'user', '{serverName}'],
    params: {
      serverName: { type: 'identifier', required: false, defaultValue: DEFAULT_MCP_SERVER_NAME },
    },
    description: 'Remove OpenMotion MCP server from Claude Code CLI (user scope)',
  },
] as const;

export const BUILTIN_TEMPLATE_MAP: ReadonlyMap<string, BuiltinThirdPartyTemplate> = new Map(
  BUILTIN_THIRD_PARTY_TEMPLATES.map(template => [template.templateId, template]),
);

const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const SEMVER_PARTS_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+[a-zA-Z0-9.-]+)?$/;

export function compareSemver(a: string, b: string): number {
  const matchA = SEMVER_PARTS_RE.exec(a.trim());
  const matchB = SEMVER_PARTS_RE.exec(b.trim());
  if (!matchA || !matchB) {
    throw new Error(`Invalid semver comparison: "${a}" vs "${b}"`);
  }
  const coreA = [Number(matchA[1]), Number(matchA[2]), Number(matchA[3])];
  const coreB = [Number(matchB[1]), Number(matchB[2]), Number(matchB[3])];
  for (let i = 0; i < 3; i++) {
    const diff = coreA[i]! - coreB[i]!;
    if (diff !== 0) return diff;
  }
  const preA = matchA[4];
  const preB = matchB[4];
  if (!preA && !preB) return 0;
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  const partsA = preA!.split('.');
  const partsB = preB!.split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const segA = partsA[i];
    const segB = partsB[i];
    if (segA === undefined) return -1;
    if (segB === undefined) return 1;
    if (segA === segB) continue;
    const numA = /^\d+$/.test(segA) ? Number(segA) : null;
    const numB = /^\d+$/.test(segB) ? Number(segB) : null;
    if (numA !== null && numB !== null) return numA - numB;
    if (numA !== null) return -1;
    if (numB !== null) return 1;
    return segA < segB ? -1 : 1;
  }
  return 0;
}

export function isShellVersionSatisfied(
  currentVersion: string | undefined,
  minVersion: string | undefined,
): boolean {
  if (!minVersion || !minVersion.trim()) return true;
  if (!currentVersion || !currentVersion.trim()) return false;
  try {
    return compareSemver(currentVersion, minVersion) >= 0;
  } catch {
    return false;
  }
}

/**
 * Canonicalizes an HTTP(S) URL for equality comparisons (lowercased scheme/host,
 * default port elided via `new URL()`, trailing slash stripped on pathname).
 */
export function canonicalizeUrlForComparison(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '';
    return `${parsed.origin}${normalizedPath}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function getAllowedDomains(channel: HostReleaseChannel): readonly string[] {
  return channel === 'stable' ? BUILTIN_ALLOWED_DOMAINS_STABLE : BUILTIN_ALLOWED_DOMAINS_TEST;
}

export function isHostInAllowedDomains(
  hostname: string,
  channel: HostReleaseChannel = 'stable',
  allowLocalDevLoopback = false,
): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return false;
  if (allowLocalDevLoopback && channel === 'dev' && (normalized === '127.0.0.1' || normalized === 'localhost')) {
    return true;
  }
  const domains = getAllowedDomains(channel);
  return domains.some(domain => normalized === domain || normalized.endsWith(`.${domain}`));
}

export function isUrlInAllowedDomainScope(
  rawUrl: string,
  options?: { channel?: HostReleaseChannel; allowLocalDevLoopback?: boolean },
): boolean {
  const channel = options?.channel ?? 'stable';
  const allowLocalDev = Boolean(options?.allowLocalDevLoopback && channel === 'dev');
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === 'https:') {
      return isHostInAllowedDomains(parsed.hostname, channel, false);
    }
    if (allowLocalDev && parsed.protocol === 'http:') {
      return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    }
    return false;
  } catch {
    return false;
  }
}

export function isBuiltinPublisherId(publisherId: string): boolean {
  return BUILTIN_PUBLISHERS.some(entry => entry.id === publisherId);
}

export function isBuiltinConfigFieldType(value: string): value is BuiltinConfigFieldType {
  return (BUILTIN_CONFIG_FIELD_TYPES as readonly string[]).includes(value);
}

const MURMUR_FORBIDDEN_VERBS = new Set([
  'run',
  'exec',
  'launch',
  'claude-code',
  'claude-desktop',
  'claude-mcp-helper',
  'claude-tui-helper',
  'plugin',
  'plugins',
  'shell',
]);

const MURMUR_SAFE_DAEMON_VERBS = new Set([
  'install',
  'uninstall',
  'start',
  'stop',
  'restart',
  'status',
]);

/**
 * Built-in shell bound for first-party component command templates (M9 security audit).
 *
 * Audit of murmurant (`pool/internal/cli/start_cli.go`) confirmed that
 * `murmur magpie <agent> run [args...]` executes external agent binaries via
 * `syscall.Exec`. To preserve the two-tier compromise boundary (a leaked daily
 * signing key must never execute arbitrary agent tasks), the shell rejects any
 * launcher/exec subcommand for `murmur-engine` and restricts it to management
 * subcommands only.
 */
const MURMUR_SAFE_PROVIDER_VERBS = new Set([
  'add',
  'set',
  'key',
  'rm',
  'remove',
  'upsert',
]);

const SINGLE_PLACEHOLDER_RE = /^\{[a-zA-Z0-9_]+\}$/;

export function validateFirstPartyCommandArgvBounds(
  componentId: string,
  argv: readonly string[],
  options?: { channel?: HostReleaseChannel; allowLocalDevLoopback?: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, reason: 'First-party command argv must be a non-empty array' };
  }
  for (const token of argv) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n\0]/.test(token)) {
      return { ok: false, reason: 'First-party command argv contains invalid token' };
    }
  }
  if (componentId !== 'murmur-engine') {
    return { ok: true };
  }

  for (const token of argv) {
    if (MURMUR_FORBIDDEN_VERBS.has(token.toLowerCase())) {
      return {
        ok: false,
        reason: `Forbidden launcher/exec subcommand "${token}" in murmur-engine template`,
      };
    }
  }

  const [first, second, third] = argv;
  if (first === '--version' || first === 'version') {
    return argv.length === 1
      ? { ok: true }
      : { ok: false, reason: 'murmur version command must not take extra arguments' };
  }
  if (first === 'status') {
    return argv.every(tok => tok === 'status' || tok === '--json')
      ? { ok: true }
      : { ok: false, reason: 'murmur status command only allows --json' };
  }
  if (first === 'magpie') {
    if (second === 'daemon') {
      return argv.length === 3 && third !== undefined && MURMUR_SAFE_DAEMON_VERBS.has(third)
        ? { ok: true }
        : { ok: false, reason: 'murmur magpie daemon only allows install|uninstall|start|stop|restart|status' };
    }
    if (second === 'provider') {
      if (argv.length < 4 || !third || !MURMUR_SAFE_PROVIDER_VERBS.has(third.toLowerCase())) {
        return {
          ok: false,
          reason: 'murmur magpie provider only allows add|set|key|rm|remove with a provider target',
        };
      }
      for (const tok of argv.slice(3)) {
        const lower = tok.toLowerCase();
        let urlCandidate: string | null = null;
        const eqIndex = tok.indexOf('=');
        if (eqIndex > 0) {
          const key = lower.slice(0, eqIndex);
          const value = tok.slice(eqIndex + 1);
          if (
            value.includes('://') ||
            key === 'url' ||
            key === '--url' ||
            key === 'base_url' ||
            key === '--base-url' ||
            key === 'endpoint' ||
            key === '--endpoint'
          ) {
            urlCandidate = value;
          }
        } else if (tok.includes('://')) {
          urlCandidate = tok;
        }
        if (urlCandidate !== null && !SINGLE_PLACEHOLDER_RE.test(urlCandidate)) {
          if (!isUrlInAllowedDomainScope(urlCandidate, options)) {
            return {
              ok: false,
              reason: `murmur magpie provider URL is outside allowed domain scope: "${urlCandidate}"`,
            };
          }
        }
      }
      return { ok: true };
    }
    // Agent toggle / restore: `magpie <agentId> <modelId|default>` (exactly 3 tokens, no `run`/`env`)
    if (
      argv.length === 3 &&
      second !== undefined &&
      third !== undefined &&
      second !== 'serve' &&
      second !== 'mcp' &&
      second !== 'import' &&
      third !== 'env'
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `Disallowed murmur magpie subcommand shape: ${argv.join(' ')}`,
    };
  }

  return {
    ok: false,
    reason: `Disallowed murmur-engine root subcommand: "${first}"`,
  };
}

export function validateTypedPlaceholderValue(
  type: TemplatePlaceholderType,
  rawValue: unknown,
  options?: { channel?: HostReleaseChannel; allowLocalDevLoopback?: boolean },
): { ok: true; value: string } | { ok: false; reason: string } {
  if (type === 'boolean') {
    if (typeof rawValue === 'boolean') return { ok: true, value: rawValue ? 'true' : 'false' };
    if (rawValue === 'true' || rawValue === 'false') return { ok: true, value: rawValue };
    return { ok: false, reason: 'Expected boolean value' };
  }
  if (typeof rawValue !== 'string') {
    return { ok: false, reason: `Expected string for placeholder type "${type}"` };
  }
  const trimmed = rawValue.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) {
    return { ok: false, reason: 'Value must be non-empty single-line text' };
  }
  switch (type) {
    case 'identifier':
    case 'agent_id':
      return IDENTIFIER_RE.test(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, reason: `Invalid ${type}: "${trimmed}"` };
    case 'model_id':
      return MODEL_ID_RE.test(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, reason: `Invalid model_id: "${trimmed}"` };
    case 'semver':
      return SEMVER_RE.test(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, reason: `Invalid semver: "${trimmed}"` };
    case 'url_in_domain_scope':
      return isUrlInAllowedDomainScope(trimmed, options)
        ? { ok: true, value: trimmed }
        : { ok: false, reason: `URL is outside allowed domain scope: "${trimmed}"` };
  }
}
