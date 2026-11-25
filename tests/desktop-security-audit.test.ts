/**
 * Red-Team Security Audit & Mid-Flow Recovery Verification Suite
 * (Design Doc rev 242 — Risk #14 & Risk #15).
 *
 * End-to-end deterministic verification across the real shell & local-atom
 * security boundaries:
 * - Scenario 1: Compromised Renderer / Injected Script (XSS)
 * - Scenario 2: Compromised Daily Signing Key + Hosted Config Takeover
 * - Scenario 3: Interrupted Mid-Flow Recovery ("中途关闭页面再进入")
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  CapabilityRegistry,
  type CapabilityMethodDefinition,
  type CapabilityModule,
} from '../desktop/src/capability-registry.ts';
import {
  authorizePrivilegedIpcSender,
  authorizeSplashSender,
  type IpcEventLike,
  type IpcSenderFrameLike,
  type IpcWindowLike,
  type PrivilegedIpcAuthResult,
  type SplashIpcAuthResult,
} from '../desktop/src/ipc-guard.ts';
import {
  POPUP_HARDENED_WEB_PREFERENCES,
  evaluateNavigationPolicy,
  evaluateWindowOpenPolicy,
  toElectronWindowOpenResult,
  type WindowPolicyConfig,
} from '../desktop/src/window-policy.ts';
import { startConnectScriptServer } from '../packages/connect-script/server.ts';
import {
  createLocalAtomsRuntime,
  createMemorySecretStore,
  type AtomCredentialPollResult,
  type CommandRunner,
  type CommandRunnerInput,
  type CredentialHttpClient,
  type LocalAtomsRuntime,
} from '../packages/local-atoms/index.ts';
import {
  SignedConfigManager,
  createBundledDefaultConfigPayload,
  generateEd25519KeyPair,
  signConfigEnvelope,
  signDailyCertificate,
  signRevocationList,
  verifySignedConfigEnvelope,
  type SignedConfigApplyFailure,
  type SignedConfigApplyResult,
  type SignedConfigApplySuccess,
  type VerifySignedConfigFailure,
  type VerifySignedConfigResult,
} from '../packages/signed-config/index.ts';
import {
  CONNECT_SCRIPT_ENDPOINTS,
  CONNECT_SCRIPT_TOKEN_HEADER,
} from '../shared/connect-script-protocol.ts';
import {
  BUILTIN_PUBLISHERS,
  BUILTIN_TEMPLATE_MAP,
  isUrlInAllowedDomainScope,
} from '../shared/desktop-builtin-rules.ts';
import {
  HOST_CAPABILITIES,
  HOST_CONTRACT_VERSION,
  type AtomConfigWriteResult,
  type AtomCredentialStartResult,
  type AtomCredentialStatusResult,
  type AtomDetectResult,
  type AtomExecResult,
  type AtomInstallComponentResult,
  type BuiltinConfigFieldType,
  type HostConfirmationRequest,
  type HostError,
  type HostInvokeResult,
  type HostRuntimeInfo,
  type UniversalHostBridge,
} from '../shared/desktop-contract.ts';
import { MURMUR_COMPONENT_ID } from '../shared/engine-command-contract.ts';
import {
  validateSignedConfigPayloadBounds,
  type SignedConfigPayload,
} from '../shared/signed-config.ts';

const BASE_TIME_MS = Date.parse('2026-11-23T12:00:00.000Z');
const HOUR_MS = 3600 * 1000;
const STUDIO_ORIGIN = 'https://motion.open-design.ai';
const EXPECTED_MCP_URL = 'https://motion.open-design.ai/mcp';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function isoAt(offsetHours: number): string {
  return new Date(BASE_TIME_MS + offsetHours * HOUR_MS).toISOString();
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/* -------------------------------------------------------------------------- */
/*  Strict Discriminated-Union Assertion Helpers                              */
/* -------------------------------------------------------------------------- */

function expectHostOk<T>(result: HostInvokeResult<T>, context?: string): T {
  if (!result.ok) {
    assert.fail(
      `${context ? `[${context}] ` : ''}Expected ok result, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.data;
}

function expectHostErr(result: HostInvokeResult<unknown>, context?: string): HostError {
  if (result.ok) {
    assert.fail(
      `${context ? `[${context}] ` : ''}Expected error result, got ok: ${JSON.stringify(result.data)}`,
    );
  }
  return result.error;
}

function expectAuthDenied(
  result: PrivilegedIpcAuthResult | SplashIpcAuthResult,
  context?: string,
): HostError {
  if (result.ok) {
    assert.fail(`${context ? `[${context}] ` : ''}Expected IPC authorization denial, got ok`);
  }
  return result.error;
}

function expectVerifyFailed(
  result: VerifySignedConfigResult,
  context?: string,
): VerifySignedConfigFailure {
  if (result.ok) {
    assert.fail(`${context ? `[${context}] ` : ''}Expected signed config verification failure, got ok`);
  }
  return result;
}

function expectApplyOk(
  result: SignedConfigApplyResult,
  context?: string,
): SignedConfigApplySuccess {
  if (!result.applied) {
    assert.fail(
      `${context ? `[${context}] ` : ''}Expected applyEnvelope success, got ${result.code}: ${result.message}`,
    );
  }
  return result;
}

function expectApplyFailed(
  result: SignedConfigApplyResult,
  context?: string,
): SignedConfigApplyFailure {
  if (result.applied) {
    assert.fail(
      `${context ? `[${context}] ` : ''}Expected applyEnvelope failure, got applied sequence ${result.sequence}`,
    );
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Shared Audit Fixtures                                                     */
/* -------------------------------------------------------------------------- */

function createAuditSignedConfig(artifactBytes: Buffer): SignedConfigPayload {
  const base = createBundledDefaultConfigPayload('stable');
  const digest = sha256Hex(artifactBytes);
  const otherDigest = sha256Hex('other-first-party-binary');
  const publisherId = BUILTIN_PUBLISHERS[0]!.id;

  const config: SignedConfigPayload = {
    ...base,
    components: {
      [MURMUR_COMPONENT_ID]: {
        componentId: MURMUR_COMPONENT_ID,
        displayName: 'Murmur Personal Engine',
        minVersion: '1.2.0',
        platforms: {
          'darwin-arm64': {
            url: 'https://releases.open-design.ai/murmur/1.2.0/murmur',
            sha256: digest,
            publisherId,
          },
          'darwin-x64': {
            url: 'https://releases.open-design.ai/murmur/1.2.0/murmur',
            sha256: digest,
            publisherId,
          },
          'win32-x64': {
            url: 'https://releases.open-design.ai/murmur/1.2.0/murmur.exe',
            sha256: digest,
            publisherId,
          },
        },
      },
      'other-first-party': {
        componentId: 'other-first-party',
        displayName: 'Other First-Party Helper',
        minVersion: '1.0.0',
        platforms: {
          'darwin-arm64': {
            url: 'https://releases.open-design.ai/helper/1.0.0/helper',
            sha256: otherDigest,
            publisherId,
          },
        },
      },
    },
    firstPartyCommands: {
      'murmur.provider.upsert': {
        templateId: 'murmur.provider.upsert',
        componentId: MURMUR_COMPONENT_ID,
        mutating: true,
        stdinSecret: true,
        argv: ['magpie', 'provider', 'upsert', '--id', '{providerId}', '--api-key-stdin'],
        params: {
          providerId: { type: 'identifier', required: true },
        },
        description: 'Deliver OpenDesign runtime key to Murmur via stdin',
      },
      'other.provider.upsert': {
        templateId: 'other.provider.upsert',
        componentId: 'other-first-party',
        mutating: true,
        stdinSecret: true,
        argv: ['auth', 'set', '--key-stdin'],
        params: {},
        description: 'Stdin secret template targeting a different component',
      },
    },
    credentials: {
      murmur_runtime: {
        credentialId: 'murmur_runtime',
        issuerUrl: 'https://auth.open-design.ai',
        deviceAuthPath: '/oauth/device/code',
        tokenPath: '/oauth/token',
        revokePath: '/oauth/revoke',
        targetComponentId: MURMUR_COMPONENT_ID,
      },
    },
    features: {
      ...base.features,
      local_engine: {
        featureId: 'local_engine',
        version: '1.0.0',
        title: 'Local Engine Setup & Authorization',
        summary: 'Install Murmur personal engine and authorize runtime credentials.',
        minShellVersion: '0.1.0',
        componentIds: [MURMUR_COMPONENT_ID, 'other-first-party'],
        commandTemplateIds: ['murmur.provider.upsert', 'other.provider.upsert'],
        credentialIds: ['murmur_runtime'],
      },
    },
  };

  assert.deepEqual(validateSignedConfigPayloadBounds(config, { channel: 'stable' }), []);
  return config;
}

function registerLocalAtomsInRegistry(runtime: LocalAtomsRuntime): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const handler of Object.values(runtime.capabilities)) {
    const methods: Record<string, CapabilityMethodDefinition<Record<string, unknown>, unknown>> = {};
    for (const methodName of handler.descriptor.methods ?? []) {
      methods[methodName] = {
        handler: params => handler.invoke(methodName, params),
      };
    }
    const mod: CapabilityModule = {
      name: handler.descriptor.name,
      version: handler.descriptor.version,
      status: handler.descriptor.status,
      methods,
    };
    registry.register(mod);
  }
  return registry;
}

function createBridgeFromRuntime(runtime: LocalAtomsRuntime): UniversalHostBridge {
  const info: HostRuntimeInfo = {
    hostKind: 'connect-script',
    shellVersion: '1.0.0',
    contractVersion: HOST_CONTRACT_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    releaseChannel: 'stable',
    isPackaged: false,
    nodeVersion: process.version,
  };
  return {
    info: async () => info,
    capabilities: async () => runtime.descriptors(),
    invoke: async <T = unknown>(
      capability: string,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<HostInvokeResult<T>> => {
      return (await runtime.invoke(capability, method, params)) as HostInvokeResult<T>;
    },
    subscribe: () => () => {},
  };
}

function createMockPathResolverDeps(installedBinaries: readonly string[]) {
  const binarySet = new Set(installedBinaries.map(name => `/mock/bin/${name}`));
  return {
    env: { PATH: '/mock/bin', SHELL: '/bin/zsh' } as NodeJS.ProcessEnv,
    loginShellRunner: async () => ({ stdout: '', exitCode: 0 }),
    pathResolverFs: {
      existsSync: (targetPath: string) => targetPath === '/mock/bin' || binarySet.has(targetPath),
      readdirSync: (): string[] => [],
      isExecutableFile: (filePath: string) => binarySet.has(filePath),
    },
  };
}

function createAuditPki(keyId = 'daily-audit-2026-11-23') {
  const root = generateEd25519KeyPair();
  const daily = generateEd25519KeyPair();
  const cert = signDailyCertificate({
    keyId,
    publicKeySpkiBase64: daily.publicKeySpkiBase64,
    notBefore: isoAt(-2),
    notAfter: isoAt(48),
    rootPrivateKey: root.privateKey,
  });
  return { root, daily, cert };
}

/* ========================================================================== */
/*  Scenario 1 — Compromised Renderer / Injected Script (XSS)                 */
/* ========================================================================== */

describe('Scenario 1: Compromised Renderer / Injected Script (XSS)', () => {
  it('blocks arbitrary OS binaries, unknown templates, and unknown capabilities via CapabilityRegistry + atom.exec', async () => {
    const dataDir = makeTempDir('audit-s1-exec-data-');
    const homeDir = makeTempDir('audit-s1-exec-home-');
    const artifactBytes = Buffer.from('#!/bin/sh\necho murmur\n', 'utf8');
    const signedConfig = createAuditSignedConfig(artifactBytes);

    const invokedCommands: CommandRunnerInput[] = [];
    const runtime = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      ...createMockPathResolverDeps(['codex', 'claude', 'sh', 'bash', 'curl', 'python3']),
      commandRunner: async input => {
        invokedCommands.push(input);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      engineHttpProbe: async () => ({ reachable: false }),
    });
    const registry = registerLocalAtomsInRegistry(runtime);

    // 1. Arbitrary OS binaries & unknown templates through atom.exec.run
    const forbiddenTemplates = [
      'sh',
      'bash',
      'curl',
      'python3',
      '/bin/sh',
      'sh.exec',
      'codex.arbitrary_task',
      'claude.run_shell',
    ];
    for (const templateId of forbiddenTemplates) {
      const res = await registry.invoke<AtomExecResult>(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
        featureId: 'mcp_connect',
        templateId,
      });
      const err = expectHostErr(res, `template "${templateId}"`);
      assert.ok(
        err.code === 'POLICY_DENIED' || err.code === 'UNSUPPORTED',
        `Expected POLICY_DENIED or UNSUPPORTED for "${templateId}", got ${err.code}`,
      );
    }

    // 2. Unknown capability / method names through CapabilityRegistry
    const unknownCapErr = expectHostErr(
      await registry.invoke('os.shell', 'exec', { cmd: 'id' }),
      'unknown capability',
    );
    assert.equal(unknownCapErr.code, 'UNSUPPORTED');

    const unknownMethodErr = expectHostErr(
      await registry.invoke(HOST_CAPABILITIES.ATOM_EXEC, 'spawn', {
        binary: '/bin/sh',
        argv: ['-c', 'id'],
      }),
      'unknown method',
    );
    assert.equal(unknownMethodErr.code, 'UNSUPPORTED');

    // 3. No command may ever reach commandRunner
    assert.equal(invokedCommands.length, 0);
  });

  it('blocks shell metacharacter and newline injection in serverName across atom.exec and atom.config.write', async () => {
    const dataDir = makeTempDir('audit-s1-inject-data-');
    const homeDir = makeTempDir('audit-s1-inject-home-');
    const signedConfig = createAuditSignedConfig(Buffer.from('murmur', 'utf8'));

    const invokedCommands: CommandRunnerInput[] = [];
    const runtime = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      ...createMockPathResolverDeps(['codex', 'claude']),
      commandRunner: async input => {
        invokedCommands.push(input);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      engineHttpProbe: async () => ({ reachable: false }),
    });
    const registry = registerLocalAtomsInRegistry(runtime);

    const maliciousServerNames = [
      'openmotion; rm -rf /',
      '$(whoami)',
      'openmotion`id`',
      'openmotion\nrm -rf /',
      'openmotion\r\nid',
      'openmotion | cat /etc/passwd',
      'openmotion && curl https://evil.example.com',
      '../openmotion',
    ];

    for (const serverName of maliciousServerNames) {
      for (const templateId of ['codex.mcp.add_remote', 'claude.mcp.add_remote'] as const) {
        const execErr = expectHostErr(
          await registry.invoke<AtomExecResult>(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
            featureId: 'mcp_connect',
            templateId,
            args: { serverName, mcpUrl: EXPECTED_MCP_URL },
          }),
          `${templateId} serverName=${JSON.stringify(serverName)}`,
        );
        assert.equal(execErr.code, 'INVALID_PARAMS');
      }

      for (const ruleId of ['codex_mcp', 'claude_mcp'] as const) {
        const cfgErr = expectHostErr(
          await registry.invoke<AtomConfigWriteResult>(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
            featureId: 'mcp_connect',
            ruleId,
            fieldType: 'remote_mcp_entry',
            value: { serverName, url: EXPECTED_MCP_URL },
          }),
          `atom.config.write(${ruleId}) serverName=${JSON.stringify(serverName)}`,
        );
        assert.equal(cfgErr.code, 'INVALID_PARAMS');
      }
    }

    assert.equal(invokedCommands.length, 0);
    assert.equal(existsSync(path.join(homeDir, '.claude.json')), false);
    assert.equal(existsSync(path.join(homeDir, '.codex', 'config.toml')), false);
  });

  it('blocks attacker, lookalike-subdomain, HTTP downgrade, and userinfo URLs in atom.exec and atom.config.write', async () => {
    const dataDir = makeTempDir('audit-s1-url-data-');
    const homeDir = makeTempDir('audit-s1-url-home-');
    const signedConfig = createAuditSignedConfig(Buffer.from('murmur', 'utf8'));

    const invokedCommands: CommandRunnerInput[] = [];
    const runtime = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      ...createMockPathResolverDeps(['codex', 'claude']),
      commandRunner: async input => {
        invokedCommands.push(input);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      engineHttpProbe: async () => ({ reachable: false }),
    });
    const registry = registerLocalAtomsInRegistry(runtime);

    const attackerUrls = [
      'https://evil.example.com/mcp',
      'https://open-design.ai.evil.com/mcp',
      'https://notopen-design.ai/mcp',
      'http://motion.open-design.ai/mcp',
      'https://motion.open-design.ai@evil.example.com/mcp',
      'https://user:pass@motion.open-design.ai/mcp',
      'javascript:alert(1)',
      'file:///etc/passwd',
    ];

    for (const badUrl of attackerUrls) {
      assert.equal(isUrlInAllowedDomainScope(badUrl, { channel: 'stable' }), false);

      for (const templateId of ['codex.mcp.add_remote', 'claude.mcp.add_remote'] as const) {
        const execErr = expectHostErr(
          await registry.invoke<AtomExecResult>(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
            featureId: 'mcp_connect',
            templateId,
            args: { serverName: 'openmotion', mcpUrl: badUrl },
          }),
          `${templateId} url=${badUrl}`,
        );
        assert.ok(
          execErr.code === 'POLICY_DENIED' || execErr.code === 'INVALID_PARAMS',
          `Unexpected error code for ${badUrl}: ${execErr.code}`,
        );
      }

      for (const ruleId of ['codex_mcp', 'claude_mcp'] as const) {
        const cfgErr = expectHostErr(
          await registry.invoke<AtomConfigWriteResult>(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
            featureId: 'mcp_connect',
            ruleId,
            fieldType: 'remote_mcp_entry',
            value: { serverName: 'openmotion', url: badUrl },
          }),
          `atom.config.write(${ruleId}) url=${badUrl}`,
        );
        assert.ok(
          cfgErr.code === 'POLICY_DENIED' || cfgErr.code === 'INVALID_PARAMS',
          `Unexpected error code for ${badUrl}: ${cfgErr.code}`,
        );
      }
    }

    assert.equal(invokedCommands.length, 0);
  });

  it('blocks direct atom.exec calls on stdinSecret first-party templates and prevents secret exfiltration through atom.credential', async () => {
    const dataDir = makeTempDir('audit-s1-cred-data-');
    const homeDir = makeTempDir('audit-s1-cred-home-');
    const artifactBytes = Buffer.from('#!/bin/sh\necho murmur\n', 'utf8');
    const otherBytes = Buffer.from('other-first-party-binary', 'utf8');
    const signedConfig = createAuditSignedConfig(artifactBytes);

    const SENTINEL_DEVICE_CODE = 'dev_code_PRIVATE_AUDIT_77441122';
    const SENTINEL_SECRET = 'om_rk_live_TOPSECRET_AUDIT_9f8e7d6c5b4a';

    const capturedRuns: CommandRunnerInput[] = [];
    let simulateChildFailure = false;

    const httpClient: CredentialHttpClient = async url => {
      if (url.endsWith('/oauth/device/code')) {
        return {
          status: 200,
          body: {
            device_code: SENTINEL_DEVICE_CODE,
            verification_uri: 'https://auth.open-design.ai/device?code=WXYZ-1234',
            user_code: 'WXYZ-1234',
            expires_in: 600,
            interval: 1,
          },
        };
      }
      if (url.endsWith('/oauth/token')) {
        return {
          status: 200,
          body: {
            access_token: SENTINEL_SECRET,
            account_id: 'acct_redteam_01',
            installation_id: 'inst_redteam_01',
          },
        };
      }
      return { status: 404, body: {} };
    };

    const commandRunner: CommandRunner = async input => {
      capturedRuns.push(input);
      // Simulate an adversarial/buggy child echoing stdin secret into BOTH stdout and stderr.
      const leaked = input.stdin ?? '';
      return {
        exitCode: simulateChildFailure ? 1 : 0,
        stdout: `provider upserted token=${leaked} done`,
        stderr: `debug trace secret=${leaked} end`,
      };
    };

    const runtime = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      secretStore: createMemorySecretStore(),
      credentialHttpClient: httpClient,
      downloader: async (url, destinationPath, opts) => {
        assert.equal(opts.validateUrl(url), true);
        const bytes = url.includes('/murmur/') ? artifactBytes : otherBytes;
        writeFileSync(destinationPath, bytes);
        return { bytesWritten: bytes.length };
      },
      codeSignatureVerifier: async (_filePath, expectedTeamId) => ({
        ok: true,
        teamId: expectedTeamId,
      }),
      commandRunner,
      engineHttpProbe: async () => ({ reachable: false }),
      ...createMockPathResolverDeps(['codex', 'claude']),
    });
    const registry = registerLocalAtomsInRegistry(runtime);

    // Install both first-party components so templates are fully resolved.
    expectHostOk(
      await registry.invoke<AtomInstallComponentResult>(
        HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT,
        'install',
        { featureId: 'local_engine', componentId: MURMUR_COMPONENT_ID },
      ),
      'install murmur',
    );
    expectHostOk(
      await registry.invoke<AtomInstallComponentResult>(
        HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT,
        'install',
        { featureId: 'local_engine', componentId: 'other-first-party' },
      ),
      'install other-first-party',
    );

    // 1. Direct atom.exec.run and atom.exec.preview on stdinSecret: true template MUST be blocked.
    const directExecErr = expectHostErr(
      await registry.invoke<AtomExecResult>(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
        featureId: 'local_engine',
        templateId: 'murmur.provider.upsert',
        args: { providerId: 'opendesign' },
      }),
      'direct atom.exec.run on stdinSecret template',
    );
    assert.equal(directExecErr.code, 'POLICY_DENIED');

    const directPreviewErr = expectHostErr(
      await registry.invoke(HOST_CAPABILITIES.ATOM_EXEC, 'preview', {
        featureId: 'local_engine',
        templateId: 'murmur.provider.upsert',
        args: { providerId: 'opendesign' },
      }),
      'direct atom.exec.preview on stdinSecret template',
    );
    assert.equal(directPreviewErr.code, 'POLICY_DENIED');
    assert.equal(capturedRuns.length, 0);

    // 2. atom.credential.start — must never expose device_code or secret
    const startRes = await registry.invoke<AtomCredentialStartResult>(
      HOST_CAPABILITIES.ATOM_CREDENTIAL,
      'start',
      { featureId: 'local_engine', credentialId: 'murmur_runtime' },
    );
    const startData = expectHostOk(startRes, 'credential.start');
    assert.equal(JSON.stringify(startRes).includes(SENTINEL_DEVICE_CODE), false);
    assert.equal(JSON.stringify(startRes).includes(SENTINEL_SECRET), false);

    // 3. atom.credential.poll — stores secret directly in SecretStore, never returns it
    const pollRes = await registry.invoke<AtomCredentialPollResult>(
      HOST_CAPABILITIES.ATOM_CREDENTIAL,
      'poll',
      {
        featureId: 'local_engine',
        credentialId: 'murmur_runtime',
        sessionId: startData.sessionId,
      },
    );
    const pollData = expectHostOk(pollRes, 'credential.poll');
    assert.equal(pollData.status, 'authorized');
    if (pollData.status === 'authorized') {
      assert.equal(pollData.stored, true);
    }
    assert.equal(JSON.stringify(pollRes).includes(SENTINEL_SECRET), false);
    assert.equal(JSON.stringify(pollRes).includes(SENTINEL_DEVICE_CODE), false);

    // 4. atom.credential.status — metadata only, never returns secret
    const statusRes = await registry.invoke<AtomCredentialStatusResult>(
      HOST_CAPABILITIES.ATOM_CREDENTIAL,
      'status',
      { credentialId: 'murmur_runtime' },
    );
    const statusData = expectHostOk(statusRes, 'credential.status');
    assert.equal(statusData.stored, true);
    assert.equal(JSON.stringify(statusRes).includes(SENTINEL_SECRET), false);

    // Disk metadata file must not contain plaintext secret either
    const metaFile = readFileSync(path.join(dataDir, 'credentials-meta.json'), 'utf8');
    assert.equal(metaFile.includes(SENTINEL_SECRET), false);

    // 5. Cross-component secret injection attempt MUST be blocked with POLICY_DENIED
    const crossInjectErr = expectHostErr(
      await registry.invoke<AtomExecResult>(HOST_CAPABILITIES.ATOM_CREDENTIAL, 'inject', {
        featureId: 'local_engine',
        credentialId: 'murmur_runtime',
        templateId: 'other.provider.upsert',
      }),
      'cross-component inject',
    );
    assert.equal(crossInjectErr.code, 'POLICY_DENIED');
    assert.equal(capturedRuns.length, 0);

    // 6. Legitimate inject on exitCode=0: secret strictly on stdin, never in argv, scrubbed from stdout/stderr
    const injectOkRes = await registry.invoke<AtomExecResult>(
      HOST_CAPABILITIES.ATOM_CREDENTIAL,
      'inject',
      {
        featureId: 'local_engine',
        credentialId: 'murmur_runtime',
        templateId: 'murmur.provider.upsert',
        args: { providerId: 'opendesign' },
      },
    );
    const injectOkData = expectHostOk(injectOkRes, 'credential.inject (exit 0)');
    assert.equal(capturedRuns.length, 1);
    assert.equal(capturedRuns[0]!.stdin, SENTINEL_SECRET);
    assert.equal(capturedRuns[0]!.argv.join(' ').includes(SENTINEL_SECRET), false);
    assert.equal(JSON.stringify(injectOkRes).includes(SENTINEL_SECRET), false);
    assert.ok(injectOkData.stdout.includes('[REDACTED]'));
    assert.ok(injectOkData.stderr.includes('[REDACTED]'));

    // 7. Even when the child fails (exitCode=1) and echoes secret to stdout/stderr, error details stay scrubbed!
    simulateChildFailure = true;
    const injectFailRes = await registry.invoke<AtomExecResult>(
      HOST_CAPABILITIES.ATOM_CREDENTIAL,
      'inject',
      {
        featureId: 'local_engine',
        credentialId: 'murmur_runtime',
        templateId: 'murmur.provider.upsert',
        args: { providerId: 'opendesign' },
      },
    );
    const injectFailErr = expectHostErr(injectFailRes, 'credential.inject (exit 1)');
    assert.equal(injectFailErr.code, 'EXEC_FAILED');
    assert.equal(JSON.stringify(injectFailRes).includes(SENTINEL_SECRET), false);
    assert.equal(String(injectFailErr.details?.stdout ?? '').includes('[REDACTED]'), true);
    assert.equal(String(injectFailErr.details?.stderr ?? '').includes('[REDACTED]'), true);
  });

  it('denies privileged IPC from subframes, about:blank popups, preview windows, external IdP pages, and file:// pages', () => {
    const mainFrame: IpcSenderFrameLike = {
      url: `${STUDIO_ORIGIN}/projects/123`,
      parent: null,
    };
    mainFrame.top = mainFrame;

    const mainWindow: IpcWindowLike = {
      isDestroyed: () => false,
      webContents: {
        id: 100,
        mainFrame,
        isDestroyed: () => false,
      },
    };

    const guardOptions = {
      mainWindow,
      channel: 'stable' as const,
      studioUrl: STUDIO_ORIGIN,
      allowedOrigins: [STUDIO_ORIGIN],
    };

    // Baseline: legitimate top-level Studio mainWindow passes
    const legitEvent: IpcEventLike = {
      sender: { id: 100, mainFrame, isDestroyed: () => false },
      senderFrame: mainFrame,
    };
    const legitAuth = authorizePrivilegedIpcSender(legitEvent, guardOptions);
    assert.equal(legitAuth.ok, true);

    // 1. Subframe / iframe inside mainWindow (even on same Studio origin)
    const subframe: IpcSenderFrameLike = {
      url: `${STUDIO_ORIGIN}/embed/preview`,
      parent: mainFrame,
      top: mainFrame,
    };
    const subframeErr = expectAuthDenied(
      authorizePrivilegedIpcSender(
        { sender: { id: 100, mainFrame, isDestroyed: () => false }, senderFrame: subframe },
        guardOptions,
      ),
      'subframe',
    );
    assert.equal(subframeErr.code, 'UNAUTHORIZED');

    // 2. about:blank popup (separate webContents)
    const blankPopupFrame: IpcSenderFrameLike = { url: 'about:blank', parent: null };
    blankPopupFrame.top = blankPopupFrame;
    const blankPopupErr = expectAuthDenied(
      authorizePrivilegedIpcSender(
        { sender: { id: 201, mainFrame: blankPopupFrame, isDestroyed: () => false }, senderFrame: blankPopupFrame },
        guardOptions,
      ),
      'about:blank popup',
    );
    assert.equal(blankPopupErr.code, 'UNAUTHORIZED');

    // 2b. about:blank even if somehow loaded in mainWindow webContents
    const blankMainWindow: IpcWindowLike = {
      isDestroyed: () => false,
      webContents: { id: 100, mainFrame: blankPopupFrame, isDestroyed: () => false },
    };
    const blankMainErr = expectAuthDenied(
      authorizePrivilegedIpcSender(
        { sender: { id: 100, mainFrame: blankPopupFrame, isDestroyed: () => false }, senderFrame: blankPopupFrame },
        { ...guardOptions, mainWindow: blankMainWindow },
      ),
      'about:blank in mainWindow',
    );
    assert.equal(blankMainErr.code, 'ORIGIN_DENIED');

    // 3. Project preview secondary window (same Studio origin, different webContents id)
    const previewFrame: IpcSenderFrameLike = { url: `${STUDIO_ORIGIN}/render-preview`, parent: null };
    previewFrame.top = previewFrame;
    const previewErr = expectAuthDenied(
      authorizePrivilegedIpcSender(
        { sender: { id: 202, mainFrame: previewFrame, isDestroyed: () => false }, senderFrame: previewFrame },
        guardOptions,
      ),
      'preview window',
    );
    assert.equal(previewErr.code, 'UNAUTHORIZED');

    // 4. External login / IdP page navigated inside mainWindow during in-window login fallback
    for (const idpUrl of [
      'https://sso.external-idp.example.com/oauth/authorize',
      'https://accounts.google.com/o/oauth2/v2/auth',
      'https://evil.open-design.ai.attacker.com/login',
      'http://motion.open-design.ai/projects',
    ]) {
      const idpFrame: IpcSenderFrameLike = { url: idpUrl, parent: null };
      idpFrame.top = idpFrame;
      const idpMainWindow: IpcWindowLike = {
        isDestroyed: () => false,
        webContents: { id: 100, mainFrame: idpFrame, isDestroyed: () => false },
      };
      const idpErr = expectAuthDenied(
        authorizePrivilegedIpcSender(
          { sender: { id: 100, mainFrame: idpFrame, isDestroyed: () => false }, senderFrame: idpFrame },
          { ...guardOptions, mainWindow: idpMainWindow },
        ),
        `external/IdP URL "${idpUrl}"`,
      );
      assert.equal(idpErr.code, 'ORIGIN_DENIED');
    }

    // 5. file:// and data: pages (including bundled splash.html and arbitrary local files)
    for (const fileUrl of [
      'file:///Applications/OpenDesign.app/Contents/Resources/splash.html',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      const fileFrame: IpcSenderFrameLike = { url: fileUrl, parent: null };
      fileFrame.top = fileFrame;
      const fileMainWindow: IpcWindowLike = {
        isDestroyed: () => false,
        webContents: { id: 100, mainFrame: fileFrame, isDestroyed: () => false },
      };
      const fileErr = expectAuthDenied(
        authorizePrivilegedIpcSender(
          { sender: { id: 100, mainFrame: fileFrame, isDestroyed: () => false }, senderFrame: fileFrame },
          { ...guardOptions, mainWindow: fileMainWindow },
        ),
        `file/data URL "${fileUrl}"`,
      );
      assert.equal(fileErr.code, 'ORIGIN_DENIED');
    }

    // 6. Splash guard only permits retryStartup from bundled splash.html/retry.html
    const splashFrame: IpcSenderFrameLike = {
      url: 'file:///Applications/OpenDesign.app/Contents/Resources/splash.html',
      parent: null,
    };
    splashFrame.top = splashFrame;
    const splashWindow: IpcWindowLike = {
      isDestroyed: () => false,
      webContents: { id: 300, mainFrame: splashFrame, isDestroyed: () => false },
    };
    const splashEscalateErr = expectAuthDenied(
      authorizeSplashSender(
        { sender: { id: 300, mainFrame: splashFrame, isDestroyed: () => false }, senderFrame: splashFrame },
        'atom.exec',
        { splashWindow },
      ),
      'splash action escalation',
    );
    assert.equal(splashEscalateErr.code, 'POLICY_DENIED');
  });

  it('strips preload and enforces sandbox/contextIsolation/nodeIntegration=false on every allowed popup', () => {
    const policyConfig: WindowPolicyConfig = {
      studioOrigin: STUDIO_ORIGIN,
      channel: 'stable',
      windowPolicy: {
        allowBlankPopups: true,
        allowedPopupOrigins: ['https://preview.open-design.ai', 'https://evil.example.com'],
      },
    };

    const allowedPopupCases = [
      { url: 'about:blank', expectedReason: 'blank-popup' as const },
      { url: `${STUDIO_ORIGIN}/presenter/session-1`, expectedReason: 'same-origin-popup' as const },
      { url: 'https://preview.open-design.ai/render/job-1', expectedReason: 'allowed-popup-origin' as const },
    ];

    for (const testCase of allowedPopupCases) {
      const decision = evaluateWindowOpenPolicy(testCase.url, policyConfig);
      if (decision.action !== 'allow') {
        assert.fail(`Expected popup "${testCase.url}" to be allowed, got deny (${decision.reason})`);
      }
      assert.equal(decision.reason, testCase.expectedReason);

      const prefs = decision.overrideBrowserWindowOptions.webPreferences;
      assert.equal('preload' in prefs, true);
      assert.equal(prefs.preload, undefined);
      assert.equal(prefs.sandbox, true);
      assert.equal(prefs.contextIsolation, true);
      assert.equal(prefs.nodeIntegration, false);
      assert.deepEqual(prefs, POPUP_HARDENED_WEB_PREFERENCES);

      const electronResult = toElectronWindowOpenResult(decision);
      if (electronResult.action !== 'allow') {
        assert.fail(`Expected Electron window open result to allow "${testCase.url}"`);
      }
      assert.deepEqual(
        electronResult.overrideBrowserWindowOptions?.webPreferences,
        POPUP_HARDENED_WEB_PREFERENCES,
      );
    }

    // Out-of-scope popup origin (even if smuggled in windowPolicy) and dangerous schemes MUST be denied
    const deniedPopups = [
      'https://evil.example.com/phish',
      'https://open-design.ai.evil.com/popup',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
    ];
    for (const badPopup of deniedPopups) {
      const decision = evaluateWindowOpenPolicy(badPopup, policyConfig);
      assert.equal(decision.action, 'deny', `Expected popup "${badPopup}" to be denied`);
      assert.equal(toElectronWindowOpenResult(decision).action, 'deny');
    }

    // Main-window navigation also blocks dangerous schemes and routes external URLs out of app
    assert.equal(evaluateNavigationPolicy('javascript:alert(1)', policyConfig).action, 'deny');
    assert.equal(evaluateNavigationPolicy('file:///etc/passwd', policyConfig).action, 'deny');
    const extNav = evaluateNavigationPolicy('https://evil.example.com/takeover', policyConfig);
    assert.equal(extNav.action, 'deny');
    assert.equal(extNav.openExternal, true);
  });

  it('blocks silent overwrite of an existing openmotion MCP entry pointing elsewhere without conflictPolicy: replace', async () => {
    const dataDir = makeTempDir('audit-s1-conflict-data-');
    const homeDir = makeTempDir('audit-s1-conflict-home-');
    const signedConfig = createAuditSignedConfig(Buffer.from('murmur', 'utf8'));

    const existingUrl = 'https://legacy.open-design.ai/mcp';
    const codexDir = path.join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexTomlPath = path.join(codexDir, 'config.toml');
    const initialToml = [
      '# Preserve user comments',
      '[mcp_servers.murmur]',
      'url = "http://127.0.0.1:3425/mcp"',
      '',
      '[mcp_servers.openmotion]',
      `url = "${existingUrl}"`,
      '',
    ].join('\n');
    writeFileSync(codexTomlPath, initialToml, 'utf8');

    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const initialJson = `${JSON.stringify(
      {
        mcpServers: {
          murmur: { type: 'http', url: 'http://127.0.0.1:3425/mcp' },
          openmotion: { type: 'http', url: existingUrl },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(claudeJsonPath, initialJson, 'utf8');

    const invokedCommands: CommandRunnerInput[] = [];
    const runtime = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      ...createMockPathResolverDeps(['codex', 'claude']),
      commandRunner: async input => {
        invokedCommands.push(input);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      engineHttpProbe: async () => ({ reachable: false }),
    });
    const registry = registerLocalAtomsInRegistry(runtime);

    // 1. atom.exec without conflictPolicy: 'replace' -> CONFLICT, CLI never executed
    for (const templateId of ['codex.mcp.add_remote', 'claude.mcp.add_remote'] as const) {
      const err = expectHostErr(
        await registry.invoke<AtomExecResult>(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
          featureId: 'mcp_connect',
          templateId,
          args: { serverName: 'openmotion', mcpUrl: EXPECTED_MCP_URL },
        }),
        `conflict on ${templateId}`,
      );
      assert.equal(err.code, 'CONFLICT');
      assert.equal(err.details?.existingUrl, existingUrl);
    }
    assert.equal(invokedCommands.length, 0);

    // 2. atom.config.write without conflictPolicy: 'replace' -> CONFLICT, files untouched
    for (const ruleId of ['codex_mcp', 'claude_mcp'] as const) {
      const err = expectHostErr(
        await registry.invoke<AtomConfigWriteResult>(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
          featureId: 'mcp_connect',
          ruleId,
          fieldType: 'remote_mcp_entry',
          value: { serverName: 'openmotion', url: EXPECTED_MCP_URL },
        }),
        `conflict on atom.config.write(${ruleId})`,
      );
      assert.equal(err.code, 'CONFLICT');
      assert.equal(err.details?.existingUrl, existingUrl);
    }

    assert.equal(readFileSync(codexTomlPath, 'utf8'), initialToml);
    assert.equal(readFileSync(claudeJsonPath, 'utf8'), initialJson);
  });

  it('blocks cross-origin CSRF, missing Origin, and invalid/missing/query tokens against Web Connect Script server', async () => {
    const dataDir = makeTempDir('audit-s1-csrf-data-');
    const homeDir = makeTempDir('audit-s1-csrf-home-');
    const signedConfig = createAuditSignedConfig(Buffer.from('murmur', 'utf8'));

    const runtime = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      ...createMockPathResolverDeps(['codex']),
      commandRunner: async () => ({ exitCode: 0, stdout: '0.28.0\n', stderr: '' }),
      engineHttpProbe: async () => ({ reachable: false }),
    });
    const bridge = createBridgeFromRuntime(runtime);

    const server = await startConnectScriptServer({
      bridge,
      port: 0,
      channel: 'stable',
    });

    try {
      const invokeUrl = `${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`;
      const detectBody = JSON.stringify({
        capability: HOST_CAPABILITIES.ATOM_DETECT,
        method: 'scan',
        params: {},
      });

      // 1. Evil Origin even with valid token -> 403 ORIGIN_DENIED, no ACAO header
      for (const badOrigin of [
        'https://evil.example.com',
        'https://open-design.ai.evil.com',
        'http://motion.open-design.ai',
      ]) {
        const res = await fetch(invokeUrl, {
          method: 'POST',
          headers: {
            Origin: badOrigin,
            'Content-Type': 'application/json',
            [CONNECT_SCRIPT_TOKEN_HEADER]: server.token,
          },
          body: detectBody,
        });
        assert.equal(res.status, 403, `Expected 403 for Origin ${badOrigin}`);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        const err = expectHostErr((await res.json()) as HostInvokeResult, `CSRF origin ${badOrigin}`);
        assert.equal(err.code, 'ORIGIN_DENIED');
      }

      // 2. Missing Origin header even with valid token -> 403 ORIGIN_DENIED
      const missingOrigin = await fetch(invokeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CONNECT_SCRIPT_TOKEN_HEADER]: server.token,
        },
        body: detectBody,
      });
      assert.equal(missingOrigin.status, 403);
      assert.equal(
        expectHostErr((await missingOrigin.json()) as HostInvokeResult, 'missing Origin').code,
        'ORIGIN_DENIED',
      );

      // 3. Valid Origin + missing token -> 401 UNAUTHORIZED
      const missingToken = await fetch(invokeUrl, {
        method: 'POST',
        headers: {
          Origin: STUDIO_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: detectBody,
      });
      assert.equal(missingToken.status, 401);
      assert.equal(
        expectHostErr((await missingToken.json()) as HostInvokeResult, 'missing token').code,
        'UNAUTHORIZED',
      );

      // 4. Valid Origin + wrong token -> 401 UNAUTHORIZED
      const wrongToken = await fetch(invokeUrl, {
        method: 'POST',
        headers: {
          Origin: STUDIO_ORIGIN,
          'Content-Type': 'application/json',
          [CONNECT_SCRIPT_TOKEN_HEADER]: 'forged-session-token-invalid',
        },
        body: detectBody,
      });
      assert.equal(wrongToken.status, 401);

      // 5. Valid Origin + token smuggled in query string on /v1/invoke -> 401 UNAUTHORIZED
      const queryToken = await fetch(`${invokeUrl}?token=${encodeURIComponent(server.token)}`, {
        method: 'POST',
        headers: {
          Origin: STUDIO_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: detectBody,
      });
      assert.equal(queryToken.status, 401);

      // 6. Positive control: valid Origin + valid token reaches local-atoms, which still enforces allowlist
      const legitDetect = await fetch(invokeUrl, {
        method: 'POST',
        headers: {
          Origin: STUDIO_ORIGIN,
          'Content-Type': 'application/json',
          [CONNECT_SCRIPT_TOKEN_HEADER]: server.token,
        },
        body: detectBody,
      });
      assert.equal(legitDetect.status, 200);
      assert.equal(legitDetect.headers.get('access-control-allow-origin'), STUDIO_ORIGIN);
      expectHostOk((await legitDetect.json()) as HostInvokeResult<AtomDetectResult>, 'legit detect');

      const authenticatedAttack = await fetch(invokeUrl, {
        method: 'POST',
        headers: {
          Origin: STUDIO_ORIGIN,
          'Content-Type': 'application/json',
          [CONNECT_SCRIPT_TOKEN_HEADER]: server.token,
        },
        body: JSON.stringify({
          capability: HOST_CAPABILITIES.ATOM_EXEC,
          method: 'run',
          params: { featureId: 'mcp_connect', templateId: 'sh' },
        }),
      });
      assert.equal(authenticatedAttack.status, 200);
      const attackErr = expectHostErr(
        (await authenticatedAttack.json()) as HostInvokeResult,
        'authenticated sh exec',
      );
      assert.equal(attackErr.code, 'POLICY_DENIED');
    } finally {
      await server.close();
    }
  });
});

/* ========================================================================== */
/*  Scenario 2 — Compromised Daily Signing Key + Hosted Config Takeover       */
/* ========================================================================== */

describe('Scenario 2: Compromised Daily Signing Key + Hosted Config Takeover', () => {
  it('rejects validly-signed malicious configs attempting to exceed built-in shell security bounds', () => {
    const { root, daily, cert } = createAuditPki('daily-compromised-bounds');
    const dataDir = makeTempDir('audit-s2-bounds-');
    const manager = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => BASE_TIME_MS,
    });

    const signMalicious = (sequence: number, payload: SignedConfigPayload) =>
      signConfigEnvelope({
        sequence,
        issuedAt: isoAt(0),
        expiresAt: isoAt(24),
        certificate: cert,
        payload,
        dailyPrivateKey: daily.privateKey,
      });

    const assertRejectedOutOfBounds = (
      label: string,
      sequence: number,
      payload: SignedConfigPayload,
      expectedPathFragment: string,
    ) => {
      const envelope = signMalicious(sequence, payload);

      const verifyErr = expectVerifyFailed(
        verifySignedConfigEnvelope(envelope, {
          rootPublicKey: root.publicKeySpkiBase64,
          channel: 'stable',
          now: BASE_TIME_MS,
        }),
        label,
      );
      assert.equal(verifyErr.code, 'PAYLOAD_OUT_OF_BOUNDS', `[${label}] unexpected code ${verifyErr.code}`);
      assert.ok(
        verifyErr.issues?.some(issue => issue.path.includes(expectedPathFragment)),
        `[${label}] expected issue path containing "${expectedPathFragment}", got ${JSON.stringify(verifyErr.issues)}`,
      );

      const applyErr = expectApplyFailed(manager.applyEnvelope(envelope), label);
      assert.equal(applyErr.code, 'PAYLOAD_OUT_OF_BOUNDS');
      assert.equal(manager.getStatus().source, 'bundled-default');
    };

    // 1. Adding a third-party template not in BUILTIN_TEMPLATE_MAP
    assert.equal(BUILTIN_TEMPLATE_MAP.has('codex.arbitrary_task'), false);
    const badTemplatePayload = createBundledDefaultConfigPayload('stable');
    badTemplatePayload.agents = {
      ...badTemplatePayload.agents,
      codex: {
        ...badTemplatePayload.agents!.codex!,
        mcpAddTemplateId: 'codex.arbitrary_task',
      },
    };
    assertRejectedOutOfBounds('unlisted third-party template', 1, badTemplatePayload, 'agents.codex.mcpAddTemplateId');

    // 2. Unsupported config field type ('command' / 'stdio_server')
    for (const badFieldType of ['command', 'stdio_server'] as const) {
      const badFieldPayload = createBundledDefaultConfigPayload('stable');
      badFieldPayload.configRules = {
        ...badFieldPayload.configRules,
        evil_rule: {
          ruleId: 'evil_rule',
          agentId: 'claude',
          displayName: 'Stdio Injection',
          fileFormat: 'json',
          homeRelativePath: '.claude.json',
          fieldType: badFieldType as unknown as BuiltinConfigFieldType,
          sectionPath: 'mcpServers',
        },
      };
      assertRejectedOutOfBounds(`unsupported fieldType=${badFieldType}`, 2, badFieldPayload, 'configRules.evil_rule.fieldType');
    }

    // 3. Home directory escape ('../../.ssh/authorized_keys', '/etc/hosts', drive-letter path)
    for (const escapePath of ['../../.ssh/authorized_keys', '/etc/hosts', 'C:\\Windows\\System32\\hosts']) {
      const escapePayload = createBundledDefaultConfigPayload('stable');
      escapePayload.configRules = {
        ...escapePayload.configRules,
        escape_rule: {
          ruleId: 'escape_rule',
          agentId: 'codex',
          displayName: 'Path Escape',
          fileFormat: 'toml',
          homeRelativePath: escapePath,
          fieldType: 'remote_mcp_entry',
          sectionPath: 'mcp_servers',
        },
      };
      assertRejectedOutOfBounds(`home escape "${escapePath}"`, 3, escapePayload, 'configRules.escape_rule.homeRelativePath');
    }

    // 4. Redirecting studioUrl, allowedOrigins, windowPolicy origins, or credentials.issuerUrl outside open-design.ai
    const badStudioUrl = createBundledDefaultConfigPayload('stable');
    badStudioUrl.studioUrl = 'https://evil.example.com';
    assertRejectedOutOfBounds('studioUrl hijack', 4, badStudioUrl, 'studioUrl');

    const badAllowedOrigin = createBundledDefaultConfigPayload('stable');
    badAllowedOrigin.allowedOrigins = [STUDIO_ORIGIN, 'https://evil.example.com'];
    assertRejectedOutOfBounds('allowedOrigins hijack', 5, badAllowedOrigin, 'allowedOrigins[1]');

    const badPopupOrigin = createBundledDefaultConfigPayload('stable');
    badPopupOrigin.windowPolicy = {
      ...badPopupOrigin.windowPolicy,
      allowedPopupOrigins: ['https://open-design.ai.evil.com'],
    };
    assertRejectedOutOfBounds('allowedPopupOrigins hijack', 6, badPopupOrigin, 'windowPolicy.allowedPopupOrigins[0]');

    const badCredIssuer = createBundledDefaultConfigPayload('stable');
    badCredIssuer.credentials = {
      murmur_runtime: {
        credentialId: 'murmur_runtime',
        issuerUrl: 'https://evil.example.com',
        deviceAuthPath: '/device',
        tokenPath: '/token',
        targetComponentId: MURMUR_COMPONENT_ID,
      },
    };
    assertRejectedOutOfBounds('credentials.issuerUrl hijack', 7, badCredIssuer, 'credentials.murmur_runtime.issuerUrl');

    // 5. Installing a component from an unlisted publisher or outside allowed domain
    const validSha = sha256Hex('malicious-payload');
    const badPublisherPayload = createBundledDefaultConfigPayload('stable');
    badPublisherPayload.components = {
      [MURMUR_COMPONENT_ID]: {
        componentId: MURMUR_COMPONENT_ID,
        displayName: 'Trojan Murmur',
        minVersion: '1.2.0',
        platforms: {
          'darwin-arm64': {
            url: 'https://releases.open-design.ai/murmur/1.2.0/murmur',
            sha256: validSha,
            publisherId: 'unlisted-attacker-team',
          },
        },
      },
    };
    assertRejectedOutOfBounds('unlisted publisher', 8, badPublisherPayload, 'publisherId');

    const badComponentUrlPayload = createBundledDefaultConfigPayload('stable');
    badComponentUrlPayload.components = {
      [MURMUR_COMPONENT_ID]: {
        componentId: MURMUR_COMPONENT_ID,
        displayName: 'Remote Trojan Murmur',
        minVersion: '1.2.0',
        platforms: {
          'darwin-arm64': {
            url: 'https://evil.example.com/murmur/1.2.0/murmur',
            sha256: validSha,
            publisherId: BUILTIN_PUBLISHERS[0]!.id,
          },
        },
      },
    };
    assertRejectedOutOfBounds('component URL outside domain scope', 9, badComponentUrlPayload, '.url');
  });

  it('blocks symlink escape outside homeDir inside atom.config as defense-in-depth', async () => {
    const dataDir = makeTempDir('audit-s2-symlink-data-');
    const homeDir = makeTempDir('audit-s2-symlink-home-');
    const outsideDir = makeTempDir('audit-s2-symlink-outside-');
    const victimFile = path.join(outsideDir, 'victim.json');
    writeFileSync(victimFile, '{"untouched":true}\n', 'utf8');

    // Symlink <homeDir>/.claude.json -> <outsideDir>/victim.json
    symlinkSync(victimFile, path.join(homeDir, '.claude.json'));

    const signedConfig = createBundledDefaultConfigPayload('stable');
    const runtime = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      engineHttpProbe: async () => ({ reachable: false }),
      ...createMockPathResolverDeps(['claude']),
    });

    const writeErr = expectHostErr(
      await runtime.invoke(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
        featureId: 'mcp_connect',
        ruleId: 'claude_mcp',
        fieldType: 'remote_mcp_entry',
        value: { serverName: 'openmotion', url: EXPECTED_MCP_URL },
      }),
      'symlink escape',
    );
    assert.equal(writeErr.code, 'POLICY_DENIED');
    assert.equal(readFileSync(victimFile, 'utf8'), '{"untouched":true}\n');
  });

  it('blocks rollback replay of lower-sequence validly-signed configs across restarts', () => {
    const { root, daily, cert } = createAuditPki('daily-rollback-test');
    const dataDir = makeTempDir('audit-s2-rollback-');

    const payloadSeq9 = createBundledDefaultConfigPayload('stable');
    payloadSeq9.featureFlags = { mcpConnect: true, legacyFlag: true };

    const payloadSeq10 = createBundledDefaultConfigPayload('stable');
    payloadSeq10.featureFlags = { mcpConnect: true, legacyFlag: false };

    const payloadSeq10Equivocation = createBundledDefaultConfigPayload('stable');
    payloadSeq10Equivocation.featureFlags = { mcpConnect: false };

    const envSeq9 = signConfigEnvelope({
      sequence: 9,
      issuedAt: isoAt(-1),
      expiresAt: isoAt(24),
      certificate: cert,
      payload: payloadSeq9,
      dailyPrivateKey: daily.privateKey,
    });
    const envSeq10 = signConfigEnvelope({
      sequence: 10,
      issuedAt: isoAt(0),
      expiresAt: isoAt(24),
      certificate: cert,
      payload: payloadSeq10,
      dailyPrivateKey: daily.privateKey,
    });
    const envSeq10Conflicting = signConfigEnvelope({
      sequence: 10,
      issuedAt: isoAt(0),
      expiresAt: isoAt(24),
      certificate: cert,
      payload: payloadSeq10Equivocation,
      dailyPrivateKey: daily.privateKey,
    });

    const manager1 = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => BASE_TIME_MS,
    });

    const applied10 = expectApplyOk(manager1.applyEnvelope(envSeq10), 'apply seq 10');
    assert.equal(applied10.sequence, 10);

    // Replay lower sequence 9 -> SEQUENCE_ROLLBACK
    const rollbackRes = expectApplyFailed(manager1.applyEnvelope(envSeq9), 'replay seq 9');
    assert.equal(rollbackRes.code, 'SEQUENCE_ROLLBACK');
    assert.equal(rollbackRes.activeSequence, 10);
    assert.equal(manager1.getActiveConfig().featureFlags?.legacyFlag, false);

    // Equivocation at same sequence 10 with different payload -> SEQUENCE_ROLLBACK
    const equivRes = expectApplyFailed(manager1.applyEnvelope(envSeq10Conflicting), 'equivocation seq 10');
    assert.equal(equivRes.code, 'SEQUENCE_ROLLBACK');
    assert.equal(manager1.getActiveConfig().featureFlags?.mcpConnect, true);

    // Fresh manager instance on same dataDir preserves monotonic sequence watermark
    const manager2 = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => BASE_TIME_MS,
    });
    assert.equal(manager2.getStatus().source, 'last-known-good');
    assert.equal(manager2.getStatus().highestAcceptedSequence, 10);

    const replayAfterRestart = expectApplyFailed(manager2.applyEnvelope(envSeq9), 'replay after restart');
    assert.equal(replayAfterRestart.code, 'SEQUENCE_ROLLBACK');
    assert.equal(manager2.getStatus().activeSequence, 10);
  });

  it('immediately evicts active config signed by a compromised daily key upon root-signed revocation and falls back to bundled default', () => {
    const compromisedKeyId = 'daily-compromised-2026-11-23';
    const { root, daily: compromisedDaily, cert: compromisedCert } = createAuditPki(compromisedKeyId);
    const dataDir = makeTempDir('audit-s2-revoke-');

    const manager = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => BASE_TIME_MS,
    });

    // Step 1: Apply a validly-signed config from the soon-to-be-compromised daily key
    const activePayload = createBundledDefaultConfigPayload('stable');
    activePayload.featureFlags = { mcpConnect: true, compromisedMarker: true };
    const activeEnvelope = signConfigEnvelope({
      sequence: 10,
      issuedAt: isoAt(0),
      expiresAt: isoAt(24),
      certificate: compromisedCert,
      payload: activePayload,
      dailyPrivateKey: compromisedDaily.privateKey,
    });
    expectApplyOk(manager.applyEnvelope(activeEnvelope), 'initial seq 10');
    assert.equal(manager.getStatus().source, 'verified');
    assert.equal(manager.getActiveConfig().featureFlags?.compromisedMarker, true);

    // Step 2: Forged revocation list signed by the daily key (NOT root) MUST fail and NOT alter revocation state
    const forgedRevocation = signRevocationList({
      issuedAt: isoAt(1),
      revokedKeyIds: ['some-other-key'],
      rootPrivateKey: compromisedDaily.privateKey,
    });
    const forgedEnv = signConfigEnvelope({
      sequence: 11,
      issuedAt: isoAt(1),
      expiresAt: isoAt(24),
      certificate: compromisedCert,
      revocations: forgedRevocation,
      payload: createBundledDefaultConfigPayload('stable'),
      dailyPrivateKey: compromisedDaily.privateKey,
    });
    const forgedRes = expectApplyFailed(manager.applyEnvelope(forgedEnv), 'forged revocation list');
    assert.equal(forgedRes.code, 'INVALID_REVOCATION_LIST');
    assert.deepEqual(manager.getStatus().revokedKeyIds, []);

    // Step 3: Offline root issues emergency SignedRevocationList revoking the compromised daily key
    const rootRevocations = signRevocationList({
      issuedAt: isoAt(2),
      revokedKeyIds: [compromisedKeyId],
      rootPrivateKey: root.privateKey,
    });
    const revocationDeliveryEnvelope = signConfigEnvelope({
      sequence: 11,
      issuedAt: isoAt(2),
      expiresAt: isoAt(24),
      certificate: compromisedCert,
      revocations: rootRevocations,
      payload: createBundledDefaultConfigPayload('stable'),
      dailyPrivateKey: compromisedDaily.privateKey,
    });

    const revokeRes = expectApplyFailed(
      manager.applyEnvelope(revocationDeliveryEnvelope),
      'emergency revocation delivery',
    );
    assert.equal(revokeRes.code, 'CERTIFICATE_REVOKED');
    assert.equal(revokeRes.source, 'bundled-default');
    assert.equal(revokeRes.activeSequence, null);

    // Active config is immediately evicted back to bundled default
    const statusAfterEvict = manager.getStatus();
    assert.equal(statusAfterEvict.source, 'bundled-default');
    assert.equal(statusAfterEvict.activeSequence, null);
    assert.equal(statusAfterEvict.certificateKeyId, null);
    assert.ok(statusAfterEvict.revokedKeyIds.includes(compromisedKeyId));
    assert.equal(manager.getActiveConfig().featureFlags?.compromisedMarker, undefined);

    // Step 4: Restarting the shell keeps the revocation persisted and stays on bundled default
    const restartedManager = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => BASE_TIME_MS + 2 * HOUR_MS,
    });
    assert.equal(restartedManager.getStatus().source, 'bundled-default');
    assert.ok(restartedManager.getStatus().revokedKeyIds.includes(compromisedKeyId));

    const replayedCompromised = expectApplyFailed(
      restartedManager.applyEnvelope(activeEnvelope),
      'replay compromised key after restart',
    );
    assert.equal(replayedCompromised.code, 'CERTIFICATE_REVOKED');

    // Step 5: Rotating to a freshly root-signed replacement daily key restores verified config
    const replacementDaily = generateEd25519KeyPair();
    const replacementCert = signDailyCertificate({
      keyId: 'daily-replacement-2026-11-23',
      publicKeySpkiBase64: replacementDaily.publicKeySpkiBase64,
      notBefore: isoAt(0),
      notAfter: isoAt(48),
      rootPrivateKey: root.privateKey,
    });
    const cleanPayload = createBundledDefaultConfigPayload('stable');
    cleanPayload.featureFlags = { mcpConnect: true, recovered: true };
    const replacementEnvelope = signConfigEnvelope({
      sequence: 12,
      issuedAt: isoAt(2),
      expiresAt: isoAt(24),
      certificate: replacementCert,
      revocations: rootRevocations,
      payload: cleanPayload,
      dailyPrivateKey: replacementDaily.privateKey,
    });

    const recovered = expectApplyOk(restartedManager.applyEnvelope(replacementEnvelope), 'replacement key recovery');
    assert.equal(recovered.source, 'verified');
    assert.equal(recovered.sequence, 12);
    assert.equal(restartedManager.getActiveConfig().featureFlags?.recovered, true);
    assert.ok(restartedManager.getStatus().revokedKeyIds.includes(compromisedKeyId));
  });
});

/* ========================================================================== */
/*  Scenario 3 — Interrupted Mid-Flow Recovery ("中途关闭页面再进入")           */
/* ========================================================================== */

describe('Scenario 3: Interrupted Mid-Flow Recovery (Close Page & Re-enter)', () => {
  it('re-detects actual host disk state, retains persisted approval for unchanged feature, and finishes idempotently after mid-flow interruption', async () => {
    const dataDir = makeTempDir('audit-s3-recover-data-');
    const homeDir = makeTempDir('audit-s3-recover-home-');
    const signedConfig = createBundledDefaultConfigPayload('stable');
    const staleMcpUrl = 'https://old-staging.open-design.ai/mcp';

    // Pre-seed disk: Codex has a conflicting openmotion entry + sibling murmur entry;
    // Claude has only a sibling murmur entry (no openmotion yet).
    const codexDir = path.join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexConfigPath = path.join(codexDir, 'config.toml');
    writeFileSync(
      codexConfigPath,
      [
        '# User Codex settings',
        'model = "o3"',
        '',
        '[mcp_servers.murmur]',
        'url = "http://127.0.0.1:3425/mcp"',
        '',
        '[mcp_servers.openmotion]',
        `url = "${staleMcpUrl}"`,
        '',
      ].join('\n'),
      'utf8',
    );

    const claudeConfigPath = path.join(homeDir, '.claude.json');
    writeFileSync(
      claudeConfigPath,
      `${JSON.stringify(
        {
          mcpServers: {
            murmur: { type: 'http', url: 'http://127.0.0.1:3425/mcp' },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    // -------------------- Session 1: User starts flow & closes mid-way --------------------
    const confirmRequestsSession1: HostConfirmationRequest[] = [];
    const runtime1 = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      expectedMcpUrl: EXPECTED_MCP_URL,
      getSignedConfig: () => signedConfig,
      confirmCallback: async req => {
        confirmRequestsSession1.push(req);
        return true;
      },
      ...createMockPathResolverDeps(['codex', 'claude']),
      commandRunner: async input => {
        if (input.argv[0] === '--version') {
          return { exitCode: 0, stdout: '1.0.0\n', stderr: '' };
        }
        // Simulate transient CLI failure when trying codex replace mid-flow
        return { exitCode: 1, stdout: '', stderr: 'connection interrupted' };
      },
      engineHttpProbe: async () => ({ reachable: false }),
    });
    const registry1 = registerLocalAtomsInRegistry(runtime1);

    // 1.1 Initial detect
    const detect1 = expectHostOk(
      await registry1.invoke<AtomDetectResult>(HOST_CAPABILITIES.ATOM_DETECT, 'scan'),
      'session 1 detect',
    );
    const codex1 = detect1.agents.find(a => a.agentId === 'codex');
    const claude1 = detect1.agents.find(a => a.agentId === 'claude');
    assert.equal(codex1?.installed, true);
    assert.equal(codex1?.mcpConfigured, true);
    assert.equal(codex1?.mcpUrl, staleMcpUrl);
    assert.equal(codex1?.mcpConflict, true);
    assert.equal(claude1?.installed, true);
    assert.equal(claude1?.mcpConfigured, false);

    // 1.2 Partial progress: Claude succeeds (triggers first-time user confirmation)
    const claudeWrite1 = expectHostOk(
      await registry1.invoke<AtomConfigWriteResult>(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
        featureId: 'mcp_connect',
        ruleId: 'claude_mcp',
        fieldType: 'remote_mcp_entry',
        value: { serverName: 'openmotion', url: EXPECTED_MCP_URL },
      }),
      'session 1 claude write',
    );
    assert.equal(claudeWrite1.changed, true);
    assert.ok(claudeWrite1.backupPath);
    assert.equal(confirmRequestsSession1.length, 1);

    // 1.3 Codex hits CONFLICT (without conflictPolicy: 'replace')
    const codexConflict1 = expectHostErr(
      await registry1.invoke<AtomConfigWriteResult>(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
        featureId: 'mcp_connect',
        ruleId: 'codex_mcp',
        fieldType: 'remote_mcp_entry',
        value: { serverName: 'openmotion', url: EXPECTED_MCP_URL },
      }),
      'session 1 codex conflict',
    );
    assert.equal(codexConflict1.code, 'CONFLICT');
    assert.equal(codexConflict1.details?.existingUrl, staleMcpUrl);

    // 1.4 Simulated partial CLI failure before user closes the page
    const codexExecInterrupted = expectHostErr(
      await registry1.invoke<AtomExecResult>(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
        featureId: 'mcp_connect',
        templateId: 'codex.mcp.add_remote',
        args: { serverName: 'openmotion', mcpUrl: EXPECTED_MCP_URL },
        conflictPolicy: 'replace',
      }),
      'session 1 codex exec interrupted',
    );
    assert.equal(codexExecInterrupted.code, 'EXEC_FAILED');

    // -------------------- User closes page & re-enters fresh runtime ----------------------
    // Create a completely fresh LocalAtomsRuntime pointing at the SAME dataDir & homeDir
    // (zero shared in-memory state with runtime1).
    const confirmRequestsSession2: HostConfirmationRequest[] = [];
    const runtime2 = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      expectedMcpUrl: EXPECTED_MCP_URL,
      getSignedConfig: () => signedConfig,
      confirmCallback: async req => {
        confirmRequestsSession2.push(req);
        return true;
      },
      ...createMockPathResolverDeps(['codex', 'claude']),
      commandRunner: async input => {
        if (input.argv[0] === '--version') {
          return { exitCode: 0, stdout: '1.0.0\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'ok\n', stderr: '' };
      },
      engineHttpProbe: async () => ({ reachable: false }),
    });
    const registry2 = registerLocalAtomsInRegistry(runtime2);

    // 2.1 Re-detect MUST reflect real disk state (Claude already configured, Codex still conflicting)
    const detect2 = expectHostOk(
      await registry2.invoke<AtomDetectResult>(HOST_CAPABILITIES.ATOM_DETECT, 'scan'),
      'session 2 re-detect',
    );
    const claude2 = detect2.agents.find(a => a.agentId === 'claude');
    const codex2 = detect2.agents.find(a => a.agentId === 'codex');
    assert.equal(claude2?.mcpConfigured, true);
    assert.equal(claude2?.mcpUrl, EXPECTED_MCP_URL);
    assert.equal(claude2?.mcpConflict, false);
    assert.equal(codex2?.mcpConfigured, true);
    assert.equal(codex2?.mcpUrl, staleMcpUrl);
    assert.equal(codex2?.mcpConflict, true);

    // 2.2 Resolve Codex conflict cleanly — approval persisted on disk, NO redundant prompt!
    const codexResolve = expectHostOk(
      await registry2.invoke<AtomConfigWriteResult>(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
        featureId: 'mcp_connect',
        ruleId: 'codex_mcp',
        fieldType: 'remote_mcp_entry',
        value: { serverName: 'openmotion', url: EXPECTED_MCP_URL },
        conflictPolicy: 'replace',
      }),
      'session 2 codex resolve',
    );
    assert.equal(codexResolve.changed, true);
    assert.ok(codexResolve.backupPath);
    assert.equal(confirmRequestsSession2.length, 0);

    // Verify surgical merge preserved unrelated settings, comments, and sibling Murmur entries
    const finalToml = readFileSync(codexConfigPath, 'utf8');
    assert.ok(finalToml.includes('# User Codex settings'));
    assert.ok(finalToml.includes('model = "o3"'));
    assert.ok(finalToml.includes('[mcp_servers.murmur]'));
    assert.ok(finalToml.includes('http://127.0.0.1:3425/mcp'));
    assert.ok(finalToml.includes(EXPECTED_MCP_URL));

    const finalJson = JSON.parse(readFileSync(claudeConfigPath, 'utf8')) as {
      mcpServers: Record<string, { url: string }>;
    };
    assert.equal(finalJson.mcpServers.murmur?.url, 'http://127.0.0.1:3425/mcp');
    assert.equal(finalJson.mcpServers.openmotion?.url, EXPECTED_MCP_URL);

    // 2.3 Re-running both writes is cleanly idempotent (changed=false, no new backups, no prompts)
    const claudeIdempotent = expectHostOk(
      await registry2.invoke<AtomConfigWriteResult>(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
        featureId: 'mcp_connect',
        ruleId: 'claude_mcp',
        fieldType: 'remote_mcp_entry',
        value: { serverName: 'openmotion', url: EXPECTED_MCP_URL },
      }),
      'session 2 claude idempotent',
    );
    assert.equal(claudeIdempotent.changed, false);
    assert.equal(claudeIdempotent.backupPath, undefined);

    const codexIdempotent = expectHostOk(
      await registry2.invoke<AtomConfigWriteResult>(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
        featureId: 'mcp_connect',
        ruleId: 'codex_mcp',
        fieldType: 'remote_mcp_entry',
        value: { serverName: 'openmotion', url: EXPECTED_MCP_URL },
      }),
      'session 2 codex idempotent',
    );
    assert.equal(codexIdempotent.changed, false);
    assert.equal(codexIdempotent.backupPath, undefined);
    assert.equal(confirmRequestsSession2.length, 0);

    // 2.4 Final detect confirms clean converged state across both agents
    const detectFinal = expectHostOk(
      await registry2.invoke<AtomDetectResult>(HOST_CAPABILITIES.ATOM_DETECT, 'scan'),
      'session 2 final detect',
    );
    for (const agentId of ['codex', 'claude'] as const) {
      const agent = detectFinal.agents.find(a => a.agentId === agentId);
      assert.equal(agent?.mcpConfigured, true);
      assert.equal(agent?.mcpUrl, EXPECTED_MCP_URL);
      assert.equal(agent?.mcpConflict, false);
    }
  });

  it('re-prompts after reconnect when the signed feature definition version changes and rotates loopback session token on reconnect', async () => {
    const dataDir = makeTempDir('audit-s3-reprompt-data-');
    const homeDir = makeTempDir('audit-s3-reprompt-home-');

    const configV1 = createBundledDefaultConfigPayload('stable');
    const configV2 = createBundledDefaultConfigPayload('stable');
    configV2.features = {
      ...configV2.features,
      mcp_connect: {
        ...configV2.features!.mcp_connect!,
        version: '1.1.0',
      },
    };

    // Session 1 approves mcp_connect v1.0.0 and configures Claude
    const prompts1: HostConfirmationRequest[] = [];
    const runtime1 = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      getSignedConfig: () => configV1,
      confirmCallback: async req => {
        prompts1.push(req);
        return true;
      },
      ...createMockPathResolverDeps(['claude']),
      commandRunner: async () => ({ exitCode: 0, stdout: '1.0.0\n', stderr: '' }),
      engineHttpProbe: async () => ({ reachable: false }),
    });

    expectHostOk(
      await runtime1.invoke(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
        featureId: 'mcp_connect',
        ruleId: 'claude_mcp',
        fieldType: 'remote_mcp_entry',
        value: { serverName: 'openmotion', url: EXPECTED_MCP_URL },
      }),
      'session 1 claude write',
    );
    assert.equal(prompts1.length, 1);

    // Start first Connect Script loopback session, then shut it down (simulating page/CLI close)
    const server1 = await startConnectScriptServer({
      bridge: createBridgeFromRuntime(runtime1),
      port: 0,
      channel: 'stable',
    });
    const staleToken = server1.token;
    await server1.close();

    // Session 2 reconnects with a fresh runtime & updated feature version v1.1.0 -> MUST re-prompt!
    const prompts2: HostConfirmationRequest[] = [];
    const runtime2 = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '1.0.0',
      getSignedConfig: () => configV2,
      confirmCallback: async req => {
        prompts2.push(req);
        return true;
      },
      ...createMockPathResolverDeps(['claude']),
      commandRunner: async () => ({ exitCode: 0, stdout: '1.0.0\n', stderr: '' }),
      engineHttpProbe: async () => ({ reachable: false }),
    });

    expectHostOk(
      await runtime2.invoke(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
        featureId: 'mcp_connect',
        ruleId: 'codex_mcp',
        fieldType: 'remote_mcp_entry',
        value: { serverName: 'openmotion', url: EXPECTED_MCP_URL },
      }),
      'session 2 codex write under v1.1.0',
    );
    assert.equal(prompts2.length, 1);
    assert.equal(prompts2[0]!.featureVersion, '1.1.0');

    // Fresh Connect Script loopback server rotates token and rejects stale token from Session 1
    const server2 = await startConnectScriptServer({
      bridge: createBridgeFromRuntime(runtime2),
      port: 0,
      channel: 'stable',
    });
    try {
      assert.notEqual(server2.token, staleToken);

      const staleAttempt = await fetch(`${server2.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers: {
          Origin: STUDIO_ORIGIN,
          'Content-Type': 'application/json',
          [CONNECT_SCRIPT_TOKEN_HEADER]: staleToken,
        },
        body: JSON.stringify({ capability: HOST_CAPABILITIES.ATOM_DETECT, method: 'scan', params: {} }),
      });
      assert.equal(staleAttempt.status, 401);

      const freshDetect = await fetch(`${server2.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers: {
          Origin: STUDIO_ORIGIN,
          'Content-Type': 'application/json',
          [CONNECT_SCRIPT_TOKEN_HEADER]: server2.token,
        },
        body: JSON.stringify({ capability: HOST_CAPABILITIES.ATOM_DETECT, method: 'scan', params: {} }),
      });
      assert.equal(freshDetect.status, 200);
      const detectData = expectHostOk(
        (await freshDetect.json()) as HostInvokeResult<AtomDetectResult>,
        'session 2 loopback detect',
      );
      const claude = detectData.agents.find(a => a.agentId === 'claude');
      assert.equal(claude?.mcpConfigured, true);
      assert.equal(claude?.mcpUrl, EXPECTED_MCP_URL);
      assert.equal(claude?.mcpConflict, false);
    } finally {
      await server2.close();
    }
  });
});
