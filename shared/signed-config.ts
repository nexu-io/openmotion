/**
 * Q1 Frozen Contract — Two-Tier Signed Configuration Schema & Bounds Validation.
 *
 * Security model (Design Doc §5.6):
 * - Root Ed25519 public key is embedded in the shell (root private key stays offline).
 * - Daily signing certificate is signed by root key with validity window (notBefore / notAfter).
 * - Monotonic sequence number prevents rollback attacks.
 * - Payload cannot exceed built-in shell rules (domain scope, publisher list, field types,
 *   third-party program templates).
 * - Unknown payload fields are ignored for forward compatibility; unsupported formatVersion
 *   causes fallback to last-known-good or bundled default.
 */

import {
  BUILTIN_TEMPLATE_MAP,
  isBuiltinConfigFieldType,
  isBuiltinPublisherId,
  isUrlInAllowedDomainScope,
  validateFirstPartyCommandArgvBounds,
  type TemplatePlaceholderType,
} from './desktop-builtin-rules.ts';
import type { BuiltinConfigFieldType, HostReleaseChannel } from './desktop-contract.ts';

export const SIGNED_CONFIG_FORMAT_VERSION = 1 as const;

export type DailySigningCertificate = {
  keyId: string;
  /** Base64-encoded Ed25519 SPKI DER public key. */
  publicKeySpkiBase64: string;
  notBefore: string;
  notAfter: string;
  /** Base64 Ed25519 signature by the offline root private key over canonical cert body. */
  rootSignature: string;
};

export type SignedRevocationList = {
  issuedAt: string;
  revokedKeyIds: string[];
  /** Base64 Ed25519 signature by the offline root private key over canonical revocation body. */
  rootSignature: string;
};

export type SignedAgentConfigRule = {
  ruleId: string;
  agentId: string;
  displayName: string;
  /** Format of target config file. */
  fileFormat: 'json' | 'toml';
  /** Relative path from user home directory (e.g. ".claude.json", ".codex/config.toml"). */
  homeRelativePath: string;
  /** Built-in field type (v1: 'remote_mcp_entry' only). */
  fieldType: BuiltinConfigFieldType;
  /** Key path inside the file (e.g. "mcpServers" or "mcp_servers"). */
  sectionPath: string;
  /** Optional entry shape for remote MCP entries (default 'standard' -> { type: 'http', url }; 'opencode_remote' -> { type: 'remote', url }). */
  entryFormat?: 'standard' | 'opencode_remote';
};

export type SignedAgentProbeRule = {
  agentId: string;
  displayName: string;
  binaryName: string;
  /** Optional home-relative directory indicating a GUI/config-first Agent is installed even without a PATH CLI binary (e.g. ".cursor"). */
  detectHomeDir?: string;
  versionTemplateId?: string;
  mcpAddTemplateId?: string;
  mcpRemoveTemplateId?: string;
  configRuleId?: string;
};

export type SignedComponentPlatformArtifact = {
  url: string;
  sha256: string;
  publisherId: string;
  installerArgs?: string[];
};

export type SignedComponentManifest = {
  componentId: string;
  displayName: string;
  minVersion: string;
  platforms: Partial<Record<'darwin-arm64' | 'darwin-x64' | 'win32-x64', SignedComponentPlatformArtifact>>;
};

export type SignedFirstPartyCommandTemplate = {
  templateId: string;
  componentId: string;
  mutating: boolean;
  stdinSecret?: boolean;
  /** Argv array with `{placeholder}` tokens; never passed to a shell. */
  argv: string[];
  params: Record<string, { type: TemplatePlaceholderType; required?: boolean; defaultValue?: string }>;
  description: string;
};

export type SignedCredentialRule = {
  credentialId: string;
  issuerUrl: string;
  deviceAuthPath: string;
  tokenPath: string;
  revokePath?: string;
  targetComponentId: string;
};

export type SignedFeatureDefinition = {
  featureId: string;
  version: string;
  title: string;
  summary: string;
  minShellVersion?: string;
  commandTemplateIds?: string[];
  componentIds?: string[];
  configRuleIds?: string[];
  credentialIds?: string[];
};

export type SignedConfigPayload = {
  studioUrl?: string;
  allowedOrigins?: string[];
  windowPolicy?: {
    allowedPopupOrigins?: string[];
    allowedAuthOrigins?: string[];
    allowBlankPopups?: boolean;
  };
  minShellVersion?: string;
  minShellVersionReason?: string;
  updateDownloadUrl?: string;
  featureFlags?: Record<string, boolean>;
  agents?: Record<string, SignedAgentProbeRule>;
  configRules?: Record<string, SignedAgentConfigRule>;
  components?: Record<string, SignedComponentManifest>;
  firstPartyCommands?: Record<string, SignedFirstPartyCommandTemplate>;
  credentials?: Record<string, SignedCredentialRule>;
  features?: Record<string, SignedFeatureDefinition>;
};

export type SignedConfigEnvelope = {
  formatVersion: number;
  sequence: number;
  issuedAt: string;
  expiresAt?: string;
  certificate: DailySigningCertificate;
  revocations?: SignedRevocationList;
  payload: SignedConfigPayload;
  /** Base64 Ed25519 signature by the daily signing key over canonical payload envelope. */
  signature: string;
};

export type SignedConfigValidationIssue = {
  path: string;
  message: string;
};

const FORBIDDEN_SENSITIVE_HOME_ROOTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.git',
  '.npmrc',
  '.netrc',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.env',
  '.gitconfig',
]);

function isSafeHomeRelativeSubpath(rawPath: string): boolean {
  if (!rawPath || typeof rawPath !== 'string') return false;
  if (
    rawPath.startsWith('/') ||
    rawPath.startsWith('\\') ||
    rawPath.includes('..') ||
    rawPath.includes('\0') ||
    /^[a-zA-Z]:/.test(rawPath)
  ) {
    return false;
  }
  const segments = rawPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some(seg => seg === '.' || seg === '..')) return false;
  const firstSegment = segments[0]!.toLowerCase();
  if (FORBIDDEN_SENSITIVE_HOME_ROOTS.has(firstSegment)) return false;
  return true;
}

/**
 * Built-in shell bound ensuring declarative MCP config rules can only write
 * `.json` or `.toml` files under non-sensitive home-relative paths.
 */
export function isAllowedMcpConfigRelativePath(
  relativePath: string,
  fileFormat?: 'json' | 'toml',
): boolean {
  if (!isSafeHomeRelativeSubpath(relativePath)) return false;
  const lower = relativePath.toLowerCase();
  if (fileFormat === 'json') return lower.endsWith('.json');
  if (fileFormat === 'toml') return lower.endsWith('.toml');
  return lower.endsWith('.json') || lower.endsWith('.toml');
}

/**
 * Validates that a SignedConfigPayload strictly stays within the shell's
 * built-in security rules (domain scope, publisher list, field types,
 * third-party templates, no path traversal).
 */
export function validateSignedConfigPayloadBounds(
  payload: SignedConfigPayload,
  options?: { channel?: HostReleaseChannel; allowLocalDevLoopback?: boolean },
): SignedConfigValidationIssue[] {
  const issues: SignedConfigValidationIssue[] = [];
  const channel = options?.channel ?? 'stable';
  const urlOpts = { channel, allowLocalDevLoopback: options?.allowLocalDevLoopback };

  if (payload.studioUrl !== undefined && !isUrlInAllowedDomainScope(payload.studioUrl, urlOpts)) {
    issues.push({ path: 'studioUrl', message: `studioUrl outside allowed domain scope: ${payload.studioUrl}` });
  }

  if (payload.minShellVersion !== undefined) {
    if (
      typeof payload.minShellVersion !== 'string' ||
      payload.minShellVersion.length > 64 ||
      !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(payload.minShellVersion.trim())
    ) {
      issues.push({
        path: 'minShellVersion',
        message: `minShellVersion must be a valid semver string: ${String(payload.minShellVersion)}`,
      });
    }
  }

  if (payload.minShellVersionReason !== undefined) {
    if (
      typeof payload.minShellVersionReason !== 'string' ||
      payload.minShellVersionReason.length > 500 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(payload.minShellVersionReason)
    ) {
      issues.push({
        path: 'minShellVersionReason',
        message: 'minShellVersionReason must be plain text up to 500 characters',
      });
    }
  }

  if (
    payload.updateDownloadUrl !== undefined &&
    !isUrlInAllowedDomainScope(payload.updateDownloadUrl, urlOpts)
  ) {
    issues.push({
      path: 'updateDownloadUrl',
      message: `updateDownloadUrl outside allowed domain scope: ${payload.updateDownloadUrl}`,
    });
  }

  for (const [idx, origin] of (payload.allowedOrigins ?? []).entries()) {
    if (!isUrlInAllowedDomainScope(origin, urlOpts)) {
      issues.push({ path: `allowedOrigins[${idx}]`, message: `Origin outside allowed domain scope: ${origin}` });
    }
  }

  for (const [idx, origin] of (payload.windowPolicy?.allowedPopupOrigins ?? []).entries()) {
    if (!isUrlInAllowedDomainScope(origin, urlOpts)) {
      issues.push({
        path: `windowPolicy.allowedPopupOrigins[${idx}]`,
        message: `Popup origin outside allowed domain scope: ${origin}`,
      });
    }
  }

  for (const [idx, origin] of (payload.windowPolicy?.allowedAuthOrigins ?? []).entries()) {
    if (!isUrlInAllowedDomainScope(origin, urlOpts)) {
      issues.push({
        path: `windowPolicy.allowedAuthOrigins[${idx}]`,
        message: `Auth origin outside allowed domain scope: ${origin}`,
      });
    }
  }

  for (const [key, agent] of Object.entries(payload.agents ?? {})) {
    if (agent.detectHomeDir !== undefined && !isSafeHomeRelativeSubpath(agent.detectHomeDir)) {
      issues.push({
        path: `agents.${key}.detectHomeDir`,
        message: `Agent detectHomeDir must be a safe home-relative path: ${agent.detectHomeDir}`,
      });
    }
    for (const field of ['versionTemplateId', 'mcpAddTemplateId', 'mcpRemoveTemplateId'] as const) {
      const tplId = agent[field];
      if (tplId !== undefined && !BUILTIN_TEMPLATE_MAP.has(tplId)) {
        issues.push({
          path: `agents.${key}.${field}`,
          message: `Unknown built-in third-party template: ${tplId}`,
        });
      }
    }
  }

  for (const [key, rule] of Object.entries(payload.configRules ?? {})) {
    if (!isBuiltinConfigFieldType(rule.fieldType)) {
      issues.push({
        path: `configRules.${key}.fieldType`,
        message: `Unsupported config field type: ${String(rule.fieldType)}`,
      });
    }
    if (!isAllowedMcpConfigRelativePath(rule.homeRelativePath, rule.fileFormat)) {
      issues.push({
        path: `configRules.${key}.homeRelativePath`,
        message: `Config path must be a safe home-relative .json/.toml path: ${rule.homeRelativePath}`,
      });
    }
  }

  const SAFE_COMPONENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
  for (const [key, component] of Object.entries(payload.components ?? {})) {
    if (!SAFE_COMPONENT_ID_RE.test(key)) {
      issues.push({
        path: `components.${key}`,
        message: `Component key must be a safe identifier: ${key}`,
      });
    }
    if (
      typeof component.componentId !== 'string' ||
      !SAFE_COMPONENT_ID_RE.test(component.componentId) ||
      component.componentId !== key
    ) {
      issues.push({
        path: `components.${key}.componentId`,
        message: `Component manifest componentId must be a safe identifier matching key "${key}": ${String(component.componentId)}`,
      });
    }
    for (const [platformKey, artifact] of Object.entries(component.platforms ?? {})) {
      if (!artifact) continue;
      if (!isUrlInAllowedDomainScope(artifact.url, urlOpts)) {
        issues.push({
          path: `components.${key}.platforms.${platformKey}.url`,
          message: `Component download URL outside allowed domain scope: ${artifact.url}`,
        });
      }
      if (!/^[a-fA-F0-9]{64}$/.test(artifact.sha256)) {
        issues.push({
          path: `components.${key}.platforms.${platformKey}.sha256`,
          message: 'Component sha256 must be a 64-char hex digest',
        });
      }
      if (!isBuiltinPublisherId(artifact.publisherId)) {
        issues.push({
          path: `components.${key}.platforms.${platformKey}.publisherId`,
          message: `Publisher not in built-in allowlist: ${artifact.publisherId}`,
        });
      }
    }
  }

  for (const [key, cmd] of Object.entries(payload.firstPartyCommands ?? {})) {
    if (!payload.components?.[cmd.componentId]) {
      issues.push({
        path: `firstPartyCommands.${key}.componentId`,
        message: `First-party command references unknown component: ${cmd.componentId}`,
      });
    }
    const argvCheck = validateFirstPartyCommandArgvBounds(cmd.componentId, cmd.argv, urlOpts);
    if ('reason' in argvCheck) {
      issues.push({
        path: `firstPartyCommands.${key}.argv`,
        message: argvCheck.reason,
      });
    }
  }

  for (const [key, cred] of Object.entries(payload.credentials ?? {})) {
    if (!isUrlInAllowedDomainScope(cred.issuerUrl, urlOpts)) {
      issues.push({
        path: `credentials.${key}.issuerUrl`,
        message: `Credential issuerUrl outside allowed domain scope: ${cred.issuerUrl}`,
      });
    }
  }

  return issues;
}
