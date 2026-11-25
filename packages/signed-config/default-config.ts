/**
 * Bundled default v1 configuration and embedded root key metadata.
 *
 * Used as the final fallback when neither a freshly verified signed config
 * nor a persisted last-known-good signed config is available.
 */

import { DEFAULT_STUDIO_URLS } from '../../shared/desktop-builtin-rules.ts';
import type { HostReleaseChannel } from '../../shared/desktop-contract.ts';
import type { SignedConfigPayload } from '../../shared/signed-config.ts';

/**
 * Placeholder for the offline Root Ed25519 public key (SPKI DER, base64).
 *
 * Production desktop builds inject the real SPKI public key at bundle time via
 * `OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI` in `desktop/scripts/build.mjs`
 * (esbuild `define` for `__OPENMOTION_EMBEDDED_ROOT_PUBLIC_KEY_SPKI__`), or
 * this constant can be replaced directly after the offline root key ceremony.
 * Never embed or commit any private key material.
 */
declare const __OPENMOTION_EMBEDDED_ROOT_PUBLIC_KEY_SPKI__: string | undefined;

export const EMBEDDED_ROOT_PUBLIC_KEY_SPKI_BASE64 =
  'PENDING_PRODUCTION_ROOT_KEY_CEREMONY_ED25519_SPKI_BASE64' as const;

export function resolveEmbeddedRootPublicKeySpki(): string {
  const buildInjected =
    typeof __OPENMOTION_EMBEDDED_ROOT_PUBLIC_KEY_SPKI__ === 'string'
      ? __OPENMOTION_EMBEDDED_ROOT_PUBLIC_KEY_SPKI__.trim()
      : '';
  return buildInjected || EMBEDDED_ROOT_PUBLIC_KEY_SPKI_BASE64;
}

/**
 * Built-in revoked daily signing key IDs shipped with the shell binary.
 */
export const BUILTIN_REVOKED_KEY_IDS: readonly string[] = [] as const;

export function isEmbeddedRootPublicKeyPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || trimmed === EMBEDDED_ROOT_PUBLIC_KEY_SPKI_BASE64;
}

/**
 * Returns the initial v1 bundled default SignedConfigPayload for the given
 * release channel. Strictly conforms to built-in shell security bounds.
 */
export function createBundledDefaultConfigPayload(
  channel: HostReleaseChannel = 'stable',
): SignedConfigPayload {
  const studioUrl = DEFAULT_STUDIO_URLS[channel];
  const studioOrigin = new URL(studioUrl).origin;

  return {
    studioUrl,
    allowedOrigins: [studioOrigin],
    windowPolicy: {
      allowedPopupOrigins: [studioOrigin],
      allowedAuthOrigins: [studioOrigin],
      allowBlankPopups: true,
    },
    featureFlags: {
      mcpConnect: true,
    },
    agents: {
      codex: {
        agentId: 'codex',
        displayName: 'Codex CLI',
        binaryName: 'codex',
        versionTemplateId: 'codex.version',
        mcpAddTemplateId: 'codex.mcp.add_remote',
        mcpRemoveTemplateId: 'codex.mcp.remove',
        configRuleId: 'codex_mcp',
      },
      claude: {
        agentId: 'claude',
        displayName: 'Claude Code',
        binaryName: 'claude',
        versionTemplateId: 'claude.version',
        mcpAddTemplateId: 'claude.mcp.add_remote',
        mcpRemoveTemplateId: 'claude.mcp.remove',
        configRuleId: 'claude_mcp',
      },
      cursor: {
        agentId: 'cursor',
        displayName: 'Cursor',
        binaryName: 'cursor',
        detectHomeDir: '.cursor',
        configRuleId: 'cursor_mcp',
      },
      windsurf: {
        agentId: 'windsurf',
        displayName: 'Windsurf',
        binaryName: 'windsurf',
        detectHomeDir: '.codeium/windsurf',
        configRuleId: 'windsurf_mcp',
      },
      opencode: {
        agentId: 'opencode',
        displayName: 'OpenCode',
        binaryName: 'opencode',
        detectHomeDir: '.config/opencode',
        configRuleId: 'opencode_mcp',
      },
      antigravity: {
        agentId: 'antigravity',
        displayName: 'Antigravity',
        binaryName: 'agy',
        detectHomeDir: '.gemini/antigravity',
        configRuleId: 'antigravity_mcp',
      },
    },
    configRules: {
      codex_mcp: {
        ruleId: 'codex_mcp',
        agentId: 'codex',
        displayName: 'Codex MCP Configuration',
        fileFormat: 'toml',
        homeRelativePath: '.codex/config.toml',
        fieldType: 'remote_mcp_entry',
        sectionPath: 'mcp_servers',
      },
      claude_mcp: {
        ruleId: 'claude_mcp',
        agentId: 'claude',
        displayName: 'Claude Code MCP Configuration',
        fileFormat: 'json',
        homeRelativePath: '.claude.json',
        fieldType: 'remote_mcp_entry',
        sectionPath: 'mcpServers',
      },
      cursor_mcp: {
        ruleId: 'cursor_mcp',
        agentId: 'cursor',
        displayName: 'Cursor MCP Configuration',
        fileFormat: 'json',
        homeRelativePath: '.cursor/mcp.json',
        fieldType: 'remote_mcp_entry',
        sectionPath: 'mcpServers',
      },
      windsurf_mcp: {
        ruleId: 'windsurf_mcp',
        agentId: 'windsurf',
        displayName: 'Windsurf MCP Configuration',
        fileFormat: 'json',
        homeRelativePath: '.codeium/windsurf/mcp_config.json',
        fieldType: 'remote_mcp_entry',
        sectionPath: 'mcpServers',
      },
      opencode_mcp: {
        ruleId: 'opencode_mcp',
        agentId: 'opencode',
        displayName: 'OpenCode MCP Configuration',
        fileFormat: 'json',
        homeRelativePath: '.config/opencode/opencode.json',
        fieldType: 'remote_mcp_entry',
        sectionPath: 'mcp',
        entryFormat: 'opencode_remote',
      },
      antigravity_mcp: {
        ruleId: 'antigravity_mcp',
        agentId: 'antigravity',
        displayName: 'Antigravity MCP Configuration',
        fileFormat: 'json',
        homeRelativePath: '.gemini/antigravity/mcp_config.json',
        fieldType: 'remote_mcp_entry',
        sectionPath: 'mcpServers',
      },
    },
    features: {
      mcp_connect: {
        featureId: 'mcp_connect',
        version: '1.0.0',
        title: 'Connect Local Coding Agents (MCP)',
        summary:
          'Detect local coding Agents (Codex, Claude Code, Cursor, Windsurf, OpenCode, Antigravity) and register the remote OpenMotion MCP server.',
        minShellVersion: '0.1.0',
        commandTemplateIds: [
          'codex.version',
          'codex.mcp.add_remote',
          'codex.mcp.remove',
          'claude.version',
          'claude.mcp.add_remote',
          'claude.mcp.remove',
        ],
        configRuleIds: [
          'codex_mcp',
          'claude_mcp',
          'cursor_mcp',
          'windsurf_mcp',
          'opencode_mcp',
          'antigravity_mcp',
        ],
      },
    },
  };
}
