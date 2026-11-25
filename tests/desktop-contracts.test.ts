import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_PUBLISHERS,
  BUILTIN_TEMPLATE_MAP,
  BUILTIN_THIRD_PARTY_PROGRAMS,
  DEFAULT_STUDIO_URLS,
  isUrlInAllowedDomainScope,
  validateFirstPartyCommandArgvBounds,
  validateTypedPlaceholderValue,
} from '../shared/desktop-builtin-rules.ts';
import { isValidDesktopLoopbackRedirectUri } from '../shared/desktop-auth-handoff.ts';
import { HOST_CAPABILITIES, HOST_CONTRACT_VERSION, hostErr, hostOk } from '../shared/desktop-contract.ts';
import { MURMUR_COMMAND_TEMPLATES, MURMUR_ENGINE_PORT } from '../shared/engine-command-contract.ts';
import {
  isAllowedMcpConfigRelativePath,
  validateSignedConfigPayloadBounds,
} from '../shared/signed-config.ts';
import { validateHostMethodParams } from '../shared/desktop-schemas.ts';

test('Q1 built-in third-party allowlist contains codex and claude with 3 templates each', () => {
  assert.deepEqual([...BUILTIN_THIRD_PARTY_PROGRAMS], ['codex', 'claude']);
  for (const id of [
    'codex.version',
    'codex.mcp.add_remote',
    'codex.mcp.remove',
    'claude.version',
    'claude.mcp.add_remote',
    'claude.mcp.remove',
  ]) {
    assert.ok(BUILTIN_TEMPLATE_MAP.has(id), `missing built-in template ${id}`);
  }
  const claudeAdd = BUILTIN_TEMPLATE_MAP.get('claude.mcp.add_remote')!;
  assert.ok(claudeAdd.argv.includes('--scope') && claudeAdd.argv.includes('user'));
});

test('Q1 domain scope strictly confines stable builds to open-design.ai subdomains', () => {
  assert.equal(isUrlInAllowedDomainScope('https://motion.open-design.ai/mcp', { channel: 'stable' }), true);
  assert.equal(isUrlInAllowedDomainScope('https://open-design.ai', { channel: 'stable' }), true);
  assert.equal(isUrlInAllowedDomainScope(DEFAULT_STUDIO_URLS.test, { channel: 'stable' }), false);
  assert.equal(isUrlInAllowedDomainScope(DEFAULT_STUDIO_URLS.test, { channel: 'test' }), true);
  assert.equal(isUrlInAllowedDomainScope('https://evil-open-design.ai', { channel: 'stable' }), false);
  assert.equal(isUrlInAllowedDomainScope('http://motion.open-design.ai', { channel: 'stable' }), false);
  assert.equal(
    isUrlInAllowedDomainScope('http://127.0.0.1:4173', { channel: 'dev', allowLocalDevLoopback: true }),
    true,
  );
  assert.equal(
    isUrlInAllowedDomainScope('http://127.0.0.1:4173', { channel: 'stable', allowLocalDevLoopback: true }),
    false,
  );
});

test('Q1 signed config payload validation rejects out-of-bounds templates, domains, publishers, and paths', () => {
  const validIssues = validateSignedConfigPayloadBounds(
    {
      studioUrl: 'https://motion.open-design.ai',
      agents: {
        codex: {
          agentId: 'codex',
          displayName: 'Codex',
          binaryName: 'codex',
          versionTemplateId: 'codex.version',
          mcpAddTemplateId: 'codex.mcp.add_remote',
          mcpRemoveTemplateId: 'codex.mcp.remove',
        },
      },
      configRules: {
        codexMcp: {
          ruleId: 'codexMcp',
          agentId: 'codex',
          displayName: 'Codex MCP',
          fileFormat: 'toml',
          homeRelativePath: '.codex/config.toml',
          fieldType: 'remote_mcp_entry',
          sectionPath: 'mcp_servers',
        },
      },
      components: {
        'murmur-engine': {
          componentId: 'murmur-engine',
          displayName: 'Engine',
          minVersion: '0.1.0',
          platforms: {
            'darwin-arm64': {
              url: 'https://releases.open-design.ai/engine/murmur-darwin-arm64',
              sha256: 'a'.repeat(64),
              publisherId: BUILTIN_PUBLISHERS[0]!.id,
            },
          },
        },
      },
    },
    { channel: 'stable' },
  );
  assert.deepEqual(validIssues, []);

  const badIssues = validateSignedConfigPayloadBounds(
    {
      studioUrl: 'https://attacker.example.com',
      agents: {
        codex: {
          agentId: 'codex',
          displayName: 'Codex',
          binaryName: 'codex',
          mcpAddTemplateId: 'codex.exec_arbitrary',
        },
      },
      configRules: {
        escape: {
          ruleId: 'escape',
          agentId: 'codex',
          displayName: 'Escape',
          fileFormat: 'json',
          homeRelativePath: '../etc/passwd',
          fieldType: 'remote_mcp_entry',
          sectionPath: 'mcpServers',
        },
      },
      components: {
        evil: {
          componentId: 'evil',
          displayName: 'Evil',
          minVersion: '1.0.0',
          platforms: {
            'darwin-arm64': {
              url: 'https://evil.example.com/bin',
              sha256: 'not-a-hash',
              publisherId: 'unknown-team',
            },
          },
        },
      },
    },
    { channel: 'stable' },
  );
  assert.ok(badIssues.length >= 6);
});

test('Q1 loopback redirect URI, placeholders, and engine contract checks', () => {
  assert.equal(isValidDesktopLoopbackRedirectUri('http://127.0.0.1:48123/callback'), true);
  assert.equal(isValidDesktopLoopbackRedirectUri('http://localhost:48123/callback'), true);
  assert.equal(isValidDesktopLoopbackRedirectUri('https://127.0.0.1:48123/callback'), false);
  assert.equal(isValidDesktopLoopbackRedirectUri('http://127.0.0.1:80/callback'), false);
  assert.equal(isValidDesktopLoopbackRedirectUri('http://evil.com:48123/callback'), false);

  assert.equal(validateTypedPlaceholderValue('identifier', 'openmotion').ok, true);
  assert.equal(validateTypedPlaceholderValue('identifier', 'openmotion; rm -rf /').ok, false);
  assert.equal(
    validateTypedPlaceholderValue('url_in_domain_scope', 'https://motion.open-design.ai/mcp').ok,
    true,
  );
  assert.equal(validateTypedPlaceholderValue('url_in_domain_scope', 'https://evil.com/mcp').ok, false);

  assert.equal(HOST_CONTRACT_VERSION, '1.0.0');
  assert.equal(HOST_CAPABILITIES.ATOM_DETECT, 'atom.detect');
  assert.equal(MURMUR_ENGINE_PORT, 3425);
  assert.equal(MURMUR_COMMAND_TEMPLATES.PROVIDER_UPSERT.stdinSecret, true);
  assert.deepEqual(hostOk({ x: 1 }), { ok: true, data: { x: 1 } });
  assert.equal(hostErr('UNSUPPORTED', 'missing').ok, false);
});

test('Q1/M9 built-in bounds allow safe murmur management commands and block launcher/exec subcommands', () => {
  for (const tpl of Object.values(MURMUR_COMMAND_TEMPLATES)) {
    assert.equal(
      validateFirstPartyCommandArgvBounds(tpl.componentId, tpl.argv).ok,
      true,
      `Expected safe murmur contract template ${tpl.templateId} to pass`,
    );
  }

  for (const dangerous of [
    ['magpie', 'agy', 'run', '--prompt', 'exfiltrate'],
    ['magpie', 'claude-code', '-p', 'rm -rf ~'],
    ['magpie', 'claude-desktop'],
    ['magpie', 'plugin', 'install', 'evil'],
    ['magpie', 'daemon', 'exec'],
    ['claude-mcp-helper'],
    ['magpie', 'provider', 'add', 'opendesign', 'url=https://attacker.example/v1', 'list=off', '--api-key-stdin'],
    ['magpie', 'provider', 'add', 'opendesign', '--url=https://attacker.example/v1', '--api-key-stdin'],
    ['magpie', 'provider', 'add', 'opendesign', 'base_url=https://attacker.example/v1', '--api-key-stdin'],
    ['magpie', 'provider', 'add', 'opendesign', '--url', 'https://attacker.example/v1', '--api-key-stdin'],
    ['magpie', 'provider', 'add', 'opendesign', 'url=http://motion.open-design.ai/v1', '--api-key-stdin'],
  ]) {
    assert.equal(
      validateFirstPartyCommandArgvBounds('murmur-engine', dangerous).ok,
      false,
      `Expected dangerous murmur argv "${dangerous.join(' ')}" to be blocked`,
    );
  }

  // Literal first-party HTTPS URL within *.open-design.ai remains allowed
  assert.equal(
    validateFirstPartyCommandArgvBounds('murmur-engine', [
      'magpie',
      'provider',
      'add',
      'opendesign',
      'url=https://motion.open-design.ai/v1',
      'list=off',
      '--api-key-stdin',
    ]).ok,
    true,
  );
});

test('Declarative MCP config path bounds allow mainstream agent configs and block sensitive dotfiles', () => {
  for (const safe of [
    ['.cursor/mcp.json', 'json'],
    ['.codeium/windsurf/mcp_config.json', 'json'],
    ['.config/opencode/opencode.json', 'json'],
    ['.gemini/antigravity/mcp_config.json', 'json'],
    ['.codex/config.toml', 'toml'],
  ] as const) {
    assert.equal(isAllowedMcpConfigRelativePath(safe[0], safe[1]), true, `Expected safe path: ${safe[0]}`);
  }

  for (const dangerous of [
    '.ssh/config.json',
    '.aws/credentials.toml',
    '.bashrc',
    '.zshrc',
    '.env',
    '.git/config.toml',
    '.cursor/mcp.sh',
    '../outside/mcp.json',
    '/etc/mcp.json',
  ]) {
    assert.equal(isAllowedMcpConfigRelativePath(dangerous), false, `Expected blocked path: ${dangerous}`);
  }
});

test('Unified Zod schema layer validates host capability method params and rejects unknown fields', () => {
  const okExec = validateHostMethodParams(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
    featureId: 'mcp_connect',
    templateId: 'codex.mcp.add_remote',
    args: { serverName: 'openmotion' },
  });
  assert.equal(okExec.ok, true);

  const extraFieldExec = validateHostMethodParams(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
    featureId: 'mcp_connect',
    templateId: 'codex.mcp.add_remote',
    injectedShellFlag: true,
  });
  assert.equal(extraFieldExec.ok, false);
  if (!extraFieldExec.ok) assert.equal(extraFieldExec.error.code, 'INVALID_PARAMS');

  const okTelemetry = validateHostMethodParams(HOST_CAPABILITIES.TELEMETRY, 'recordEvent', {
    category: 'agent.connect',
    outcome: 'ok',
    agentId: 'cursor',
    connectMode: 'config',
    durationMs: 42,
  });
  assert.equal(okTelemetry.ok, true);

  const badTelemetry = validateHostMethodParams(HOST_CAPABILITIES.TELEMETRY, 'recordEvent', {
    category: 'agent.connect',
    outcome: 'ok',
    email: 'leak@example.com',
  });
  assert.equal(badTelemetry.ok, false);
  if (!badTelemetry.ok) assert.equal(badTelemetry.error.code, 'INVALID_PARAMS');
});
