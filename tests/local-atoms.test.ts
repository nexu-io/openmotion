import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { BUILTIN_PUBLISHERS } from '../shared/desktop-builtin-rules.ts';
import {
  HOST_CAPABILITIES,
  type HostConfirmationRequest,
} from '../shared/desktop-contract.ts';
import { MURMUR_COMPONENT_ID } from '../shared/engine-command-contract.ts';
import { validateSignedConfigPayloadBounds, type SignedConfigPayload } from '../shared/signed-config.ts';
import {
  ComponentInstallRegistry,
  createConfigAtom,
  createCredentialAtom,
  createEncryptedFileSecretStore,
  createExecAtom,
  createFeatureConfirmationGate,
  createInstallComponentAtom,
  createLocalAtomsRuntime,
  createMemorySecretStore,
  createPathResolver,
  createSerialMutationQueue,
  defaultCodeSignatureVerifier,
  evaluateWindowsAuthenticodeResult,
  parseMacOsCodesignTeamId,
  parseTomlMcpEntry,
  resolveWindowsCmdShimInvocation,
  upsertTomlMcpEntry,
  type CommandRunnerInput,
} from '../packages/local-atoms/index.ts';

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

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function createSampleSignedConfig(artifactBytes: Buffer): SignedConfigPayload {
  const digest = sha256Hex(artifactBytes);
  return {
    studioUrl: 'https://app.open-design.ai',
    agents: {
      codex: {
        agentId: 'codex',
        displayName: 'Codex CLI',
        binaryName: 'codex',
        versionTemplateId: 'codex.version',
        mcpAddTemplateId: 'codex.mcp.add_remote',
        mcpRemoveTemplateId: 'codex.mcp.remove',
        configRuleId: 'codex-mcp',
      },
      claude: {
        agentId: 'claude',
        displayName: 'Claude Code',
        binaryName: 'claude',
        versionTemplateId: 'claude.version',
        mcpAddTemplateId: 'claude.mcp.add_remote',
        mcpRemoveTemplateId: 'claude.mcp.remove',
        configRuleId: 'claude-mcp',
      },
    },
    configRules: {
      'codex-mcp': {
        ruleId: 'codex-mcp',
        agentId: 'codex',
        displayName: 'Codex CLI',
        fileFormat: 'toml',
        homeRelativePath: '.codex/config.toml',
        fieldType: 'remote_mcp_entry',
        sectionPath: 'mcp_servers',
      },
      'claude-mcp': {
        ruleId: 'claude-mcp',
        agentId: 'claude',
        displayName: 'Claude Code',
        fileFormat: 'json',
        homeRelativePath: '.claude.json',
        fieldType: 'remote_mcp_entry',
        sectionPath: 'mcpServers',
      },
    },
    components: {
      [MURMUR_COMPONENT_ID]: {
        componentId: MURMUR_COMPONENT_ID,
        displayName: 'Murmur Personal Engine',
        minVersion: '1.2.0',
        platforms: {
          'darwin-arm64': {
            url: 'https://releases.open-design.ai/murmur/1.2.0/murmur',
            sha256: digest,
            publisherId: BUILTIN_PUBLISHERS[0]!.id,
          },
          'darwin-x64': {
            url: 'https://releases.open-design.ai/murmur/1.2.0/murmur',
            sha256: digest,
            publisherId: BUILTIN_PUBLISHERS[0]!.id,
          },
          'win32-x64': {
            url: 'https://releases.open-design.ai/murmur/1.2.0/murmur.exe',
            sha256: digest,
            publisherId: BUILTIN_PUBLISHERS[0]!.id,
          },
        },
      },
    },
    firstPartyCommands: {
      'murmur.status': {
        templateId: 'murmur.status',
        componentId: MURMUR_COMPONENT_ID,
        mutating: false,
        argv: ['status', '--json'],
        params: {},
        description: 'Read Murmur status',
      },
      'murmur.agent.enable': {
        templateId: 'murmur.agent.enable',
        componentId: MURMUR_COMPONENT_ID,
        mutating: true,
        argv: ['magpie', '{agentId}', '{modelId}'],
        params: {
          agentId: { type: 'agent_id', required: true },
          modelId: { type: 'model_id', required: true },
        },
        description: 'Enable agent model in Murmur',
      },
      'murmur.provider.upsert': {
        templateId: 'murmur.provider.upsert',
        componentId: MURMUR_COMPONENT_ID,
        mutating: true,
        stdinSecret: true,
        argv: ['magpie', 'provider', 'upsert', '--id', '{providerId}', '--api-key-stdin'],
        params: {
          providerId: { type: 'identifier', required: true },
        },
        description: 'Upsert OpenDesign provider key via stdin',
      },
    },
    credentials: {
      'opendesign-runtime': {
        credentialId: 'opendesign-runtime',
        issuerUrl: 'https://auth.open-design.ai',
        deviceAuthPath: '/oauth/device/code',
        tokenPath: '/oauth/token',
        revokePath: '/oauth/revoke',
        targetComponentId: MURMUR_COMPONENT_ID,
      },
    },
    features: {
      'connect-agents': {
        featureId: 'connect-agents',
        version: '1.0.0',
        title: 'Connect AI Agents to OpenMotion',
        summary: 'Configure OpenMotion remote MCP server for Codex and Claude Code',
        commandTemplateIds: [
          'codex.mcp.add_remote',
          'codex.mcp.remove',
          'claude.mcp.add_remote',
          'claude.mcp.remove',
        ],
        configRuleIds: ['codex-mcp', 'claude-mcp'],
      },
      'enable-murmur': {
        featureId: 'enable-murmur',
        version: '1.0.0',
        title: 'Enable Local Murmur Engine',
        summary: 'Install and authorize Murmur engine outside app bundle',
        componentIds: [MURMUR_COMPONENT_ID],
        commandTemplateIds: ['murmur.status', 'murmur.agent.enable', 'murmur.provider.upsert'],
        credentialIds: ['opendesign-runtime'],
      },
    },
  };
}

describe('PathResolver', () => {
  it('merges login-shell PATH with noisy shell output and caches the result', async () => {
    let shellCalls = 0;
    const existingDirs = new Set([
      '/bin/zsh',
      '/opt/homebrew/bin',
      '/opt/tester/.nvm/versions/node',
      '/opt/tester/.nvm/versions/node/v22.18.0/bin',
      '/opt/tester/.local/bin',
    ]);
    const executables = new Set(['/opt/tester/.volta/bin/codex', '/opt/homebrew/bin/claude']);

    const resolver = createPathResolver({
      platform: 'darwin',
      homeDir: '/opt/tester',
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
      loginShellRunner: async (shell, args) => {
        shellCalls += 1;
        assert.equal(shell, '/bin/zsh');
        assert.equal(args[0], '-lc');
        return {
          exitCode: 0,
          stdout: 'Welcome to zsh!\n__OPENMOTION_PATH_START__/opt/tester/.volta/bin:/usr/bin__OPENMOTION_PATH_END__\n',
        };
      },
      fs: {
        existsSync: p => existingDirs.has(p),
        readdirSync: p => (p === '/opt/tester/.nvm/versions/node' ? ['v20.10.0', 'v22.18.0'] : []),
        isExecutableFile: p => executables.has(p),
      },
    });

    const codexPath = await resolver.resolveBinary('codex');
    const claudePath = await resolver.resolveBinary('claude');
    assert.equal(codexPath, '/opt/tester/.volta/bin/codex');
    assert.equal(claudePath, '/opt/homebrew/bin/claude');
    assert.equal(shellCalls, 1, 'login shell result should be cached');

    // Reject path traversal and shell injection in binary name
    assert.equal(await resolver.resolveBinary('../codex'), null);
    assert.equal(await resolver.resolveBinary('/bin/sh'), null);
    assert.equal(await resolver.resolveBinary('codex; rm -rf /'), null);

    resolver.clearCache();
    await resolver.getExecutablePath();
    assert.equal(shellCalls, 2, 'clearing cache should re-query login shell');
  });

  it('resolves Windows APPDATA/npm binaries with PATHEXT extensions', async () => {
    const existingDirs = new Set(['C:\\Users\\dev\\AppData\\Roaming\\npm']);
    const executables = new Set(['C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd']);

    const resolver = createPathResolver({
      platform: 'win32',
      homeDir: 'C:\\Users\\dev',
      env: {
        PATH: 'C:\\Windows\\System32',
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        PATHEXT: '.EXE;.CMD;.BAT',
      },
      fs: {
        existsSync: p => existingDirs.has(p),
        readdirSync: () => [],
        isExecutableFile: p => executables.has(p),
      },
    });

    const resolved = await resolver.resolveBinary('codex');
    assert.equal(resolved, 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd');
  });
});

describe('SerialMutationQueue', () => {
  it('executes host mutations strictly FIFO one at a time and recovers after errors', async () => {
    const queue = createSerialMutationQueue();
    const events: string[] = [];
    let activeCount = 0;
    let maxConcurrent = 0;

    const task = (name: string, delayMs: number, shouldFail = false) =>
      queue.enqueue(async () => {
        activeCount += 1;
        maxConcurrent = Math.max(maxConcurrent, activeCount);
        events.push(`start:${name}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        events.push(`end:${name}`);
        activeCount -= 1;
        if (shouldFail) throw new Error(`boom:${name}`);
        return name;
      }, name);

    const p1 = task('first', 25);
    const p2 = task('second', 10, true);
    const p3 = task('third', 5);

    assert.equal(await p1, 'first');
    await assert.rejects(p2, /boom:second/);
    assert.equal(await p3, 'third');

    assert.equal(maxConcurrent, 1);
    assert.deepEqual(events, [
      'start:first',
      'end:first',
      'start:second',
      'end:second',
      'start:third',
      'end:third',
    ]);
    assert.equal(queue.isBusy(), false);
    assert.equal(queue.pendingCount(), 0);
  });
});

describe('FeatureConfirmationGate', () => {
  it('caches approvals by (featureId, version, definitionHash) and re-prompts when definition changes', async () => {
    const dataDir = makeTempDir('om-confirm-');
    const artifact = Buffer.from('binary-v1');
    const signedConfig = createSampleSignedConfig(artifact);
    const prompts: HostConfirmationRequest[] = [];
    let allow = true;

    const gate = createFeatureConfirmationGate({
      dataDir,
      confirmCallback: async req => {
        prompts.push(req);
        return allow;
      },
    });

    const first = await gate.ensureApproved({
      featureId: 'connect-agents',
      signedConfig,
      facts: [{ kind: 'modify_file', label: 'Config', value: '/tmp/.claude.json' }],
    });
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.data.prompted, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]!.featureTitle, 'Connect AI Agents to OpenMotion');

    // Second call with identical feature definition does NOT re-prompt
    const second = await gate.ensureApproved({
      featureId: 'connect-agents',
      signedConfig,
      facts: [{ kind: 'modify_file', label: 'Config', value: '/tmp/.claude.json' }],
    });
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.data.prompted, false);
    assert.equal(prompts.length, 1);

    // Changing signed feature version invalidates approval and triggers re-prompt
    const updatedConfig: SignedConfigPayload = {
      ...signedConfig,
      features: {
        ...signedConfig.features,
        'connect-agents': {
          ...signedConfig.features!['connect-agents']!,
          version: '1.1.0',
        },
      },
    };
    const third = await gate.ensureApproved({
      featureId: 'connect-agents',
      signedConfig: updatedConfig,
      facts: [{ kind: 'modify_file', label: 'Config', value: '/tmp/.claude.json' }],
    });
    assert.equal(third.ok, true);
    if (third.ok) assert.equal(third.data.prompted, true);
    assert.equal(prompts.length, 2);

    // Mutating referenced config rule (same version, different definitionHash) ALSO re-prompts!
    const mutatedRuleConfig: SignedConfigPayload = {
      ...updatedConfig,
      configRules: {
        ...updatedConfig.configRules,
        'claude-mcp': {
          ...updatedConfig.configRules!['claude-mcp']!,
          homeRelativePath: '.claude-alt.json',
        },
      },
    };
    allow = false;
    const denied = await gate.ensureApproved({
      featureId: 'connect-agents',
      signedConfig: mutatedRuleConfig,
      facts: [{ kind: 'modify_file', label: 'Config', value: '/tmp/.claude-alt.json' }],
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'USER_DENIED');
    assert.equal(prompts.length, 3);
  });
});

describe('atom.config (JSON & TOML surgical merge, conflict detection, backup & restore)', () => {
  it('surgically merges TOML preserving comments and sibling Murmur config, detects conflicts, and restores backup', async () => {
    const dataDir = makeTempDir('om-cfg-data-');
    const homeDir = makeTempDir('om-cfg-home-');
    const codexDir = path.join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexTomlPath = path.join(codexDir, 'config.toml');

    const initialToml = [
      '# User Codex configuration',
      'model = "gpt-5"',
      '',
      '[mcp_servers.murmur]',
      'url = "http://127.0.0.1:3425/mcp"',
      '',
    ].join('\n');
    writeFileSync(codexTomlPath, initialToml, 'utf8');

    let activeSignedConfig = createSampleSignedConfig(Buffer.from('bin'));
    const gate = createFeatureConfirmationGate({ dataDir, shellVersion: '1.0.0', confirmCallback: async () => true });
    const queue = createSerialMutationQueue();
    const configAtom = createConfigAtom({
      dataDir,
      homeDir,
      channel: 'stable',
      getSignedConfig: () => activeSignedConfig,
      confirmationGate: gate,
      mutationQueue: queue,
    });

    // 1. Add openmotion without clobbering comments, model, or murmur
    const addRes = await configAtom.write({
      featureId: 'connect-agents',
      ruleId: 'codex-mcp',
      fieldType: 'remote_mcp_entry',
      value: {
        serverName: 'openmotion',
        url: 'https://app.open-design.ai/mcp',
      },
    });
    assert.equal(addRes.ok, true);
    if (!addRes.ok) return;
    assert.equal(addRes.data.changed, true);
    assert.ok(addRes.data.backupPath && existsSync(addRes.data.backupPath));

    const updatedToml = readFileSync(codexTomlPath, 'utf8');
    assert.ok(updatedToml.includes('# User Codex configuration'));
    assert.ok(updatedToml.includes('model = "gpt-5"'));
    assert.ok(updatedToml.includes('[mcp_servers.murmur]\nurl = "http://127.0.0.1:3425/mcp"'));
    assert.ok(updatedToml.includes('[mcp_servers.openmotion]\nurl = "https://app.open-design.ai/mcp"'));

    // 1b. Writing a different *.open-design.ai URL that disagrees with shell studioUrl is ORIGIN_DENIED
    const mismatchedOriginRes = await configAtom.write({
      featureId: 'connect-agents',
      ruleId: 'codex-mcp',
      fieldType: 'remote_mcp_entry',
      value: {
        serverName: 'openmotion',
        url: 'https://staging.open-design.ai/mcp',
      },
    });
    assert.equal(mismatchedOriginRes.ok, false);
    if (!mismatchedOriginRes.ok) {
      assert.equal(mismatchedOriginRes.error.code, 'ORIGIN_DENIED');
    }

    // 2. After shell signedConfig migrates studioUrl, writing the new URL without conflictPolicy='replace' returns CONFLICT
    activeSignedConfig = {
      ...activeSignedConfig,
      studioUrl: 'https://staging.open-design.ai',
    };
    const conflictRes = await configAtom.write({
      featureId: 'connect-agents',
      ruleId: 'codex-mcp',
      fieldType: 'remote_mcp_entry',
      value: {
        serverName: 'openmotion',
        url: 'https://staging.open-design.ai/mcp',
      },
    });
    assert.equal(conflictRes.ok, false);
    if (!conflictRes.ok) {
      assert.equal(conflictRes.error.code, 'CONFLICT');
      assert.equal(conflictRes.error.details?.existingUrl, 'https://app.open-design.ai/mcp');
    }

    // 3. Explicit conflictPolicy='replace' updates URL in place and creates a new backup
    const replaceRes = await configAtom.write({
      featureId: 'connect-agents',
      ruleId: 'codex-mcp',
      fieldType: 'remote_mcp_entry',
      value: {
        serverName: 'openmotion',
        url: 'https://staging.open-design.ai/mcp',
      },
      conflictPolicy: 'replace',
    });
    assert.equal(replaceRes.ok, true);
    const readAfterReplace = await configAtom.read({ ruleId: 'codex-mcp', serverName: 'openmotion' });
    assert.equal(readAfterReplace.ok, true);
    if (readAfterReplace.ok) {
      assert.equal(readAfterReplace.data.entry?.url, 'https://staging.open-design.ai/mcp');
    }

    // 4. Restore backup requires valid featureId and recovers original file verbatim
    const unauthRestore = await configAtom.restoreBackup({ backupPath: addRes.data.backupPath! });
    assert.equal(unauthRestore.ok, false);
    if (!unauthRestore.ok) assert.equal(unauthRestore.error.code, 'INVALID_PARAMS');

    const restoreRes = await configAtom.restoreBackup({
      featureId: 'connect-agents',
      backupPath: addRes.data.backupPath!,
    });
    assert.equal(restoreRes.ok, true);
    assert.equal(readFileSync(codexTomlPath, 'utf8'), initialToml);

    // 4b. Legacy stdio entry (command without url) also triggers CONFLICT unless conflictPolicy='replace'
    writeFileSync(
      codexTomlPath,
      '[mcp_servers.openmotion]\ncommand = "npx"\nargs = ["-y", "openmotion-mcp"]\n',
      'utf8',
    );
    const stdioConflictRes = await configAtom.write({
      featureId: 'connect-agents',
      ruleId: 'codex-mcp',
      fieldType: 'remote_mcp_entry',
      value: {
        serverName: 'openmotion',
        url: 'https://staging.open-design.ai/mcp',
      },
    });
    assert.equal(stdioConflictRes.ok, false);
    if (!stdioConflictRes.ok) {
      assert.equal(stdioConflictRes.error.code, 'CONFLICT');
    }

    // 5. Security: reject out-of-scope URL and arbitrary backup paths
    const evilUrlRes = await configAtom.write({
      featureId: 'connect-agents',
      ruleId: 'codex-mcp',
      fieldType: 'remote_mcp_entry',
      value: { serverName: 'openmotion', url: 'https://evil.example.com/mcp' },
    });
    assert.equal(evilUrlRes.ok, false);
    if (!evilUrlRes.ok) assert.equal(evilUrlRes.error.code, 'POLICY_DENIED');

    const badRestore = await configAtom.restoreBackup({
      featureId: 'connect-agents',
      backupPath: '/etc/passwd',
    });
    assert.equal(badRestore.ok, false);
    if (!badRestore.ok) assert.equal(badRestore.error.code, 'POLICY_DENIED');
  });

  it('surgically merges Claude JSON config preserving sibling servers and unrelated keys', async () => {
    const dataDir = makeTempDir('om-json-data-');
    const homeDir = makeTempDir('om-json-home-');
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    writeFileSync(
      claudeJsonPath,
      JSON.stringify(
        {
          theme: 'dark',
          mcpServers: {
            murmur: { type: 'http', url: 'http://127.0.0.1:3425/mcp' },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const signedConfig = createSampleSignedConfig(Buffer.from('bin'));
    const configAtom = createConfigAtom({
      dataDir,
      homeDir,
      channel: 'stable',
      getSignedConfig: () => signedConfig,
      confirmationGate: createFeatureConfirmationGate({ dataDir, confirmCallback: async () => true }),
      mutationQueue: createSerialMutationQueue(),
    });

    const writeRes = await configAtom.write({
      featureId: 'connect-agents',
      ruleId: 'claude-mcp',
      fieldType: 'remote_mcp_entry',
      value: {
        serverName: 'openmotion',
        url: 'https://app.open-design.ai/mcp',
        transport: 'http',
      },
    });
    assert.equal(writeRes.ok, true);

    const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as {
      theme: string;
      mcpServers: Record<string, { type: string; url: string }>;
    };
    assert.equal(parsed.theme, 'dark');
    assert.deepEqual(parsed.mcpServers.murmur, { type: 'http', url: 'http://127.0.0.1:3425/mcp' });
    assert.deepEqual(parsed.mcpServers.openmotion, { type: 'http', url: 'https://app.open-design.ai/mcp' });
  });
});

describe('atom.exec security boundaries & MCP conflict protection', () => {
  it('blocks command injection, unknown templates, out-of-scope URLs, and MCP conflicts', async () => {
    const dataDir = makeTempDir('om-exec-data-');
    const homeDir = makeTempDir('om-exec-home-');
    mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
    writeFileSync(
      path.join(homeDir, '.codex', 'config.toml'),
      '[mcp_servers.openmotion]\nurl = "https://old.open-design.ai/mcp"\n',
      'utf8',
    );

    const signedConfig = createSampleSignedConfig(Buffer.from('bin'));
    const executed: CommandRunnerInput[] = [];
    const pathResolver = createPathResolver({
      platform: 'darwin',
      homeDir,
      env: { PATH: '/usr/local/bin' },
      loginShellRunner: async () => ({ exitCode: 0, stdout: '' }),
      fs: {
        existsSync: p => p === '/usr/local/bin',
        readdirSync: () => [],
        isExecutableFile: p => p === '/usr/local/bin/codex' || p === '/usr/local/bin/claude',
      },
    });

    const execAtom = createExecAtom({
      homeDir,
      channel: 'stable',
      getSignedConfig: () => signedConfig,
      pathResolver,
      componentRegistry: new ComponentInstallRegistry(dataDir),
      confirmationGate: createFeatureConfirmationGate({ dataDir, confirmCallback: async () => true }),
      mutationQueue: createSerialMutationQueue(),
      commandRunner: async input => {
        executed.push(input);
        return { exitCode: 0, stdout: 'ok\n', stderr: '' };
      },
    });

    // 1. Unknown template rejected
    const unknownTpl = await execAtom.run({
      featureId: 'connect-agents',
      templateId: 'bash.eval',
      args: {},
    });
    assert.equal(unknownTpl.ok, false);
    if (!unknownTpl.ok) assert.equal(unknownTpl.error.code, 'POLICY_DENIED');

    // 2. Command injection in placeholder rejected
    const injection = await execAtom.run({
      featureId: 'connect-agents',
      templateId: 'codex.mcp.add_remote',
      args: {
        serverName: 'openmotion; rm -rf /',
        mcpUrl: 'https://app.open-design.ai/mcp',
      },
    });
    assert.equal(injection.ok, false);
    if (!injection.ok) assert.equal(injection.error.code, 'INVALID_PARAMS');

    // 3. Out-of-scope domain URL rejected
    const outOfScope = await execAtom.run({
      featureId: 'connect-agents',
      templateId: 'codex.mcp.add_remote',
      args: {
        serverName: 'openmotion',
        mcpUrl: 'https://attacker.evil.org/mcp',
      },
    });
    assert.equal(outOfScope.ok, false);
    if (!outOfScope.ok) assert.equal(outOfScope.error.code, 'POLICY_DENIED');

    // 4. Existing different URL triggers CONFLICT when conflictPolicy !== 'replace'
    const conflict = await execAtom.run({
      featureId: 'connect-agents',
      templateId: 'codex.mcp.add_remote',
      args: {
        serverName: 'openmotion',
        mcpUrl: 'https://app.open-design.ai/mcp',
      },
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.error.code, 'CONFLICT');
      assert.equal(conflict.error.details?.existingUrl, 'https://old.open-design.ai/mcp');
    }

    // 5. Preview returns shell-computed facts without executing
    const preview = execAtom.preview({
      featureId: 'connect-agents',
      templateId: 'codex.mcp.add_remote',
      args: {
        serverName: 'openmotion',
        mcpUrl: 'https://app.open-design.ai/mcp',
      },
    });
    assert.equal(preview.ok, true);
    if (preview.ok) {
      assert.equal(preview.data.program, 'codex');
      assert.deepEqual(preview.data.argv, ['mcp', 'add', 'openmotion', '--url', 'https://app.open-design.ai/mcp']);
      assert.ok(preview.data.facts.some(f => f.kind === 'exec_program'));
      assert.ok(preview.data.facts.some(f => f.kind === 'connect_url'));
      assert.ok(preview.data.facts.some(f => f.kind === 'modify_file'));
    }
    assert.equal(executed.length, 0);

    // 6. Explicit conflictPolicy='replace' succeeds via shell-free argv array
    const replaced = await execAtom.run({
      featureId: 'connect-agents',
      templateId: 'codex.mcp.add_remote',
      args: {
        serverName: 'openmotion',
        mcpUrl: 'https://app.open-design.ai/mcp',
      },
      conflictPolicy: 'replace',
    });
    assert.equal(replaced.ok, true);
    assert.equal(executed.length, 1);
    assert.equal(executed[0]!.binaryPath, '/usr/local/bin/codex');
    assert.deepEqual(executed[0]!.argv, ['mcp', 'add', 'openmotion', '--url', 'https://app.open-design.ai/mcp']);

    // 7. Uninstalled first-party component command is rejected
    const uninstalled = await execAtom.run({
      featureId: 'enable-murmur',
      templateId: 'murmur.agent.enable',
      args: { agentId: 'codex', modelId: 'gpt-5' },
    });
    assert.equal(uninstalled.ok, false);
    if (!uninstalled.ok) assert.equal(uninstalled.error.code, 'NOT_FOUND');

    // 8. Claude Code conflictPolicy='replace' when ~/.claude.json exists WITHOUT openmotion does NOT invoke `claude mcp remove`
    writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({ mcpServers: { sibling: { type: 'http', url: 'https://other.example/mcp' } } }),
      'utf8',
    );
    const beforeClaudeRuns = executed.length;
    const claudeCleanAdd = await execAtom.run({
      featureId: 'connect-agents',
      templateId: 'claude.mcp.add_remote',
      args: { serverName: 'openmotion', mcpUrl: 'https://app.open-design.ai/mcp' },
      conflictPolicy: 'replace',
    });
    assert.equal(claudeCleanAdd.ok, true);
    const claudeRuns = executed.slice(beforeClaudeRuns);
    assert.equal(claudeRuns.length, 1);
    assert.deepEqual(claudeRuns[0]!.argv, [
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'openmotion',
      'https://app.open-design.ai/mcp',
    ]);
  });
});

describe('atom.installComponent verification & out-of-bundle isolation', () => {
  it('rejects tampered SHA-256 and publisher Team ID mismatch, then installs valid component outside app bundle', async () => {
    const dataDir = makeTempDir('om-inst-data-');
    const appBundlePath = makeTempDir('om-app-bundle-');
    const validBytes = Buffer.from('#!/bin/sh\necho murmur-v1.2.0\n');
    const signedConfig = createSampleSignedConfig(validBytes);
    const expectedTeamId = BUILTIN_PUBLISHERS[0]!.appleTeamId;

    let downloadBytes = Buffer.from('TAMPERED-BYTES');
    let actualTeamId = expectedTeamId;

    const installer = createInstallComponentAtom({
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      appBundlePath,
      getSignedConfig: () => signedConfig,
      confirmationGate: createFeatureConfirmationGate({ dataDir, confirmCallback: async () => true }),
      mutationQueue: createSerialMutationQueue(),
      downloader: async (_url, dest) => {
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, downloadBytes);
        return { bytesWritten: downloadBytes.length };
      },
      codeSignatureVerifier: async (_filePath, teamId) => {
        if (actualTeamId !== teamId) {
          return { ok: false, reason: 'Team ID mismatch', actualTeamId };
        }
        return { ok: true, teamId: actualTeamId };
      },
    });

    // 1. Tampered SHA-256 fails with VERIFICATION_FAILED
    const badHash = await installer.install({ featureId: 'enable-murmur', componentId: MURMUR_COMPONENT_ID });
    assert.equal(badHash.ok, false);
    if (!badHash.ok) assert.equal(badHash.error.code, 'VERIFICATION_FAILED');

    // 2. Valid SHA-256 but mismatched Apple Team ID fails with VERIFICATION_FAILED
    downloadBytes = validBytes;
    actualTeamId = 'EVIL_TEAM_999';
    const badSig = await installer.install({ featureId: 'enable-murmur', componentId: MURMUR_COMPONENT_ID });
    assert.equal(badSig.ok, false);
    if (!badSig.ok) assert.equal(badSig.error.code, 'VERIFICATION_FAILED');

    // 3. Valid SHA-256 + matching publisher Team ID succeeds outside app bundle
    actualTeamId = expectedTeamId;
    const okInstall = await installer.install({ featureId: 'enable-murmur', componentId: MURMUR_COMPONENT_ID });
    assert.equal(okInstall.ok, true);
    if (!okInstall.ok) return;
    assert.equal(okInstall.data.alreadyInstalled, false);
    assert.equal(okInstall.data.sha256, sha256Hex(validBytes));
    assert.ok(existsSync(okInstall.data.installPath));
    assert.equal(okInstall.data.installPath.startsWith(appBundlePath), false);

    // 4. Repeat install is idempotent
    const repeat = await installer.install({ featureId: 'enable-murmur', componentId: MURMUR_COMPONENT_ID });
    assert.equal(repeat.ok, true);
    if (repeat.ok) assert.equal(repeat.data.alreadyInstalled, true);

    // 5. Uninstall removes host-installed component cleanly
    const removed = await installer.uninstall({ featureId: 'enable-murmur', componentId: MURMUR_COMPONENT_ID });
    assert.equal(removed.ok, true);
    assert.equal(existsSync(okInstall.data.installPath), false);

    // 6. Helper check for macOS codesign output parsing
    assert.equal(parseMacOsCodesignTeamId('Identifier=murmur\nTeamIdentifier=ABC123XYZ9\n'), 'ABC123XYZ9');
    assert.equal(parseMacOsCodesignTeamId('TeamIdentifier=not set\n'), null);
  });
});

describe('atom.credential secret isolation & stdin-only injection', () => {
  it('completes device auth without leaking secrets, injects strictly via stdin, scrubs echo, and revokes', async () => {
    const dataDir = makeTempDir('om-cred-data-');
    const homeDir = makeTempDir('om-cred-home-');
    const binaryBytes = Buffer.from('#!/bin/sh\necho ok\n');
    const signedConfig = createSampleSignedConfig(binaryBytes);

    const secretToken = 'sk_live_super_secret_runtime_key_987654321';
    const deviceCode = 'dev_code_private_xyz';
    let pollAttempts = 0;
    const revokedInstallations: string[] = [];
    const capturedCommands: CommandRunnerInput[] = [];

    const secretStore = createMemorySecretStore();
    const mutationQueue = createSerialMutationQueue();
    const confirmationGate = createFeatureConfirmationGate({ dataDir, confirmCallback: async () => true });
    const registry = new ComponentInstallRegistry(dataDir);

    // Pre-install murmur via InstallComponentAtom so provenance is genuine
    const installer = createInstallComponentAtom({
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      getSignedConfig: () => signedConfig,
      confirmationGate,
      mutationQueue,
      registry,
      downloader: async (_url, dest) => {
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, binaryBytes);
        return { bytesWritten: binaryBytes.length };
      },
      codeSignatureVerifier: async (_p, teamId) => ({ ok: true, teamId }),
    });
    const inst = await installer.install({ featureId: 'enable-murmur', componentId: MURMUR_COMPONENT_ID });
    assert.equal(inst.ok, true);

    const execAtom = createExecAtom({
      homeDir,
      platform: 'darwin',
      channel: 'stable',
      getSignedConfig: () => signedConfig,
      pathResolver: createPathResolver({
        platform: 'darwin',
        homeDir,
        env: { PATH: '' },
        loginShellRunner: async () => ({ exitCode: 0, stdout: '' }),
        fs: { existsSync: () => false, readdirSync: () => [], isExecutableFile: () => false },
      }),
      componentRegistry: registry,
      confirmationGate,
      mutationQueue,
      codeSignatureVerifier: async (_p, teamId) => ({ ok: true, teamId }),
      commandRunner: async input => {
        capturedCommands.push(input);
        // Simulate buggy binary echoing stdin back to stdout — host must scrub it!
        return { exitCode: 0, stdout: `configured with ${input.stdin ?? ''}\n`, stderr: '' };
      },
    });

    // Direct atom.exec.run on a stdinSecret template must be denied!
    const directRun = await execAtom.run({
      featureId: 'enable-murmur',
      templateId: 'murmur.provider.upsert',
      args: { providerId: 'opendesign' },
    });
    assert.equal(directRun.ok, false);
    if (!directRun.ok) assert.equal(directRun.error.code, 'POLICY_DENIED');

    const credentialAtom = createCredentialAtom({
      dataDir,
      platform: 'darwin',
      channel: 'stable',
      getSignedConfig: () => signedConfig,
      confirmationGate,
      mutationQueue,
      execAtom,
      secretStore,
      httpClient: async (url, req) => {
        if (url.endsWith('/oauth/device/code')) {
          return {
            status: 200,
            body: {
              device_code: deviceCode,
              user_code: 'ABCD-1234',
              verification_uri: 'https://auth.open-design.ai/device',
              expires_in: 300,
              interval: 2,
            },
          };
        }
        if (url.endsWith('/oauth/token')) {
          pollAttempts += 1;
          if (pollAttempts === 1) {
            return { status: 400, body: { error: 'authorization_pending' } };
          }
          return {
            status: 200,
            body: {
              access_token: secretToken,
              account_id: 'acct_42',
              installation_id: 'inst_mac_001',
            },
          };
        }
        if (url.endsWith('/oauth/revoke')) {
          revokedInstallations.push(String(req.body.installation_id ?? ''));
          return { status: 200, body: { ok: true } };
        }
        return { status: 404, body: {} };
      },
    });

    // 1. Start device auth (must not leak deviceCode)
    const startRes = await credentialAtom.start({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
    });
    assert.equal(startRes.ok, true);
    if (!startRes.ok) return;
    assert.equal(JSON.stringify(startRes).includes(deviceCode), false);

    // 2. Poll pending then authorized (must never leak secretToken)
    const pendingRes = await credentialAtom.poll({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
      sessionId: startRes.data.sessionId,
    });
    assert.equal(pendingRes.ok, true);
    if (pendingRes.ok) assert.equal(pendingRes.data.status, 'pending');

    const authRes = await credentialAtom.poll({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
      sessionId: startRes.data.sessionId,
    });
    assert.equal(authRes.ok, true);
    assert.equal(JSON.stringify(authRes).includes(secretToken), false);

    // Metadata file on disk must never contain the secret
    const metaRaw = readFileSync(path.join(dataDir, 'credentials-meta.json'), 'utf8');
    assert.equal(metaRaw.includes(secretToken), false);

    // Status reports stored=true without secret
    const statusRes = await credentialAtom.status({ credentialId: 'opendesign-runtime' });
    assert.equal(statusRes.ok, true);
    if (statusRes.ok) {
      assert.equal(statusRes.data.stored, true);
      assert.equal(statusRes.data.installationId, 'inst_mac_001');
    }
    assert.equal(JSON.stringify(statusRes).includes(secretToken), false);

    // 3. Inject strictly via stdin (never in argv), and scrubbed from returned stdout!
    const injectRes = await credentialAtom.inject({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
      templateId: 'murmur.provider.upsert',
      args: { providerId: 'opendesign' },
    });
    assert.equal(injectRes.ok, true);
    assert.equal(capturedCommands.length, 1);
    assert.equal(capturedCommands[0]!.stdin, secretToken);
    assert.equal(capturedCommands[0]!.argv.join(' ').includes(secretToken), false);
    assert.equal(JSON.stringify(injectRes).includes(secretToken), false);
    if (injectRes.ok) {
      assert.ok(injectRes.data.stdout.includes('[REDACTED]'));
    }

    // 4. Revoke enforces accountId match (denies omitted or wrong accountId), then deletes secret & prevents subsequent inject
    const omittedAcctRevoke = await credentialAtom.revoke({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
    });
    assert.equal(omittedAcctRevoke.ok, false);
    if (!omittedAcctRevoke.ok) assert.equal(omittedAcctRevoke.error.code, 'UNAUTHORIZED');

    const revokeRes = await credentialAtom.revoke({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
      accountId: 'acct_42',
    });
    assert.equal(revokeRes.ok, true);
    assert.deepEqual(revokedInstallations, ['inst_mac_001']);

    const injectAfterRevoke = await credentialAtom.inject({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
      templateId: 'murmur.provider.upsert',
      args: { providerId: 'opendesign' },
    });
    assert.equal(injectAfterRevoke.ok, false);
    if (!injectAfterRevoke.ok) assert.equal(injectAfterRevoke.error.code, 'UNAUTHORIZED');
  });

  it('repeated revoke() on pending_revoke uses quarantined Bearer token and cleans up quarantined keychain entry on success', async () => {
    const dataDir = makeTempDir('om-cred-repeat-revoke-');
    const binaryBytes = Buffer.from('#!/bin/sh\necho ok\n');
    const signedConfig = createSampleSignedConfig(binaryBytes);
    const secretStore = createMemorySecretStore();
    const mutationQueue = createSerialMutationQueue();
    const confirmationGate = createFeatureConfirmationGate({ dataDir, shellVersion: '1.0.0', confirmCallback: async () => true });
    const execAtom = createExecAtom({
      homeDir: dataDir,
      platform: 'darwin',
      channel: 'stable',
      getSignedConfig: () => signedConfig,
      pathResolver: createPathResolver({
        platform: 'darwin',
        homeDir: dataDir,
        env: { PATH: '' },
        loginShellRunner: async () => ({ exitCode: 0, stdout: '' }),
        fs: { existsSync: () => false, readdirSync: () => [], isExecutableFile: () => false },
      }),
      componentRegistry: new ComponentInstallRegistry(dataDir),
      confirmationGate,
      mutationQueue,
    });

    let failRevoke = true;
    const revokeAuthHeaders: Array<string | undefined> = [];
    const credentialAtom = createCredentialAtom({
      dataDir,
      platform: 'darwin',
      channel: 'stable',
      getSignedConfig: () => signedConfig,
      confirmationGate,
      mutationQueue,
      execAtom,
      secretStore,
      httpClient: async (url, req) => {
        if (url.endsWith('/oauth/device/code')) {
          return {
            status: 200,
            body: {
              device_code: 'dev-code-repeat',
              user_code: 'RPT-1234',
              verification_uri: 'https://auth.open-design.ai/device',
              expires_in: 300,
              interval: 1,
            },
          };
        }
        if (url.endsWith('/oauth/token')) {
          return {
            status: 200,
            body: {
              access_token: 'sk_live_repeat_revoke_secret',
              account_id: 'acct_repeat',
              installation_id: 'inst_repeat_001',
            },
          };
        }
        if (url.endsWith('/oauth/revoke')) {
          revokeAuthHeaders.push(req.headers?.authorization ?? req.headers?.Authorization);
          if (failRevoke) return { status: 503, body: { error: 'unavailable' } };
          return { status: 200, body: { ok: true } };
        }
        return { status: 404, body: {} };
      },
    });

    const startRes = await credentialAtom.start({ featureId: 'enable-murmur', credentialId: 'opendesign-runtime' });
    assert.equal(startRes.ok, true);
    if (!startRes.ok) return;
    const pollRes = await credentialAtom.poll({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
      sessionId: startRes.data.sessionId,
    });
    assert.equal(pollRes.ok, true);

    // First revoke fails remotely -> secret quarantined under openmotion:pending-revoke:...
    const firstRevoke = await credentialAtom.revoke({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
      accountId: 'acct_repeat',
    });
    assert.equal(firstRevoke.ok, true);
    if (firstRevoke.ok) assert.equal(firstRevoke.data.pendingRevoke, true);
    const quarantineKey = 'openmotion:pending-revoke:opendesign-runtime:inst_repeat_001';
    assert.equal(await secretStore.get(quarantineKey), 'sk_live_repeat_revoke_secret');

    // Second direct revoke() succeeds -> MUST send quarantined Bearer token AND delete quarantineKey!
    failRevoke = false;
    const secondRevoke = await credentialAtom.revoke({
      featureId: 'enable-murmur',
      credentialId: 'opendesign-runtime',
      accountId: 'acct_repeat',
    });
    assert.equal(secondRevoke.ok, true);
    if (secondRevoke.ok) {
      assert.equal(secondRevoke.data.revoked, true);
      assert.equal(secondRevoke.data.pendingRevoke, false);
    }
    assert.deepEqual(revokeAuthHeaders, [
      'Bearer sk_live_repeat_revoke_secret',
      'Bearer sk_live_repeat_revoke_secret',
    ]);
    assert.equal(await secretStore.get(quarantineKey), null);
    assert.equal(credentialAtom.listPendingRevokes().length, 0);
  });

  it('encrypts secrets at rest in EncryptedFileSecretStore', async () => {
    const dir = makeTempDir('om-enc-store-');
    const storeFile = path.join(dir, 'secrets.enc');
    const store = createEncryptedFileSecretStore(storeFile, 'unit-test-seed');

    await store.set('acct-1', 'my-top-secret-value');
    assert.equal(readFileSync(storeFile, 'utf8').includes('my-top-secret-value'), false);
    assert.equal(await store.get('acct-1'), 'my-top-secret-value');
    assert.equal(await store.delete('acct-1'), true);
    assert.equal(await store.get('acct-1'), null);
  });
});

describe('atom.detect & createLocalAtomsRuntime unified dispatch', () => {
  it('detects agents, MCP URL conflicts, engine provider kinds, and runs read-only calls without blocking on mutations', async () => {
    const dataDir = makeTempDir('om-rt-data-');
    const homeDir = makeTempDir('om-rt-home-');
    mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
    writeFileSync(
      path.join(homeDir, '.codex', 'config.toml'),
      '[mcp_servers.openmotion]\nurl = "https://legacy.open-design.ai/mcp"\n',
      'utf8',
    );
    writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          openmotion: { type: 'http', url: 'https://app.open-design.ai/mcp' },
        },
      }),
      'utf8',
    );

    const signedConfig = createSampleSignedConfig(Buffer.from('bin'));
    const runtime = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '/opt/homebrew/bin' },
      channel: 'stable',
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      loginShellRunner: async () => ({ exitCode: 0, stdout: '' }),
      pathResolverFs: {
        existsSync: p => p === '/opt/homebrew/bin',
        readdirSync: () => [],
        isExecutableFile: p =>
          p === '/opt/homebrew/bin/codex' ||
          p === '/opt/homebrew/bin/claude' ||
          p === '/opt/homebrew/bin/murmur',
      },
      commandRunner: async input => {
        if (input.binaryPath.endsWith('codex')) return { exitCode: 0, stdout: 'codex-cli 0.42.0\n', stderr: '' };
        if (input.binaryPath.endsWith('claude')) return { exitCode: 0, stdout: '2.1.5 (Claude Code)\n', stderr: '' };
        if (input.binaryPath.endsWith('murmur')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              schemaVersion: 1,
              version: '1.2.0',
              mode: 'personal',
              daemonRunning: true,
            }),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: 'not found' };
      },
      engineHttpProbe: async () => ({
        reachable: true,
        statusCode: 200,
        headers: { server: 'murmurant-personal-1.2.0' },
        body: '{"ok":true}',
      }),
    });

    // Verify all 5 capabilities are exposed for K6 & K9 registration
    const names = runtime.descriptors().map(d => d.name).sort();
    assert.deepEqual(
      names,
      [
        HOST_CAPABILITIES.ATOM_CONFIG,
        HOST_CAPABILITIES.ATOM_CREDENTIAL,
        HOST_CAPABILITIES.ATOM_DETECT,
        HOST_CAPABILITIES.ATOM_EXEC,
        HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT,
      ].sort(),
    );

    // Hold a mutation in the serial queue and verify read-only detect & config.read do NOT block!
    let releaseMutation!: () => void;
    const mutationStarted = new Promise<void>(resolve => {
      void runtime.mutationQueue.enqueue(async () => {
        resolve();
        await new Promise<void>(r => {
          releaseMutation = r;
        });
      }, 'long-running-mutation');
    });
    await mutationStarted;
    assert.equal(runtime.mutationQueue.isBusy(), true);

    const [detectRes, configReadRes] = await Promise.all([
      runtime.invoke(HOST_CAPABILITIES.ATOM_DETECT, 'scan'),
      runtime.invoke(HOST_CAPABILITIES.ATOM_CONFIG, 'read', { ruleId: 'claude-mcp' }),
    ]);

    releaseMutation();

    assert.equal(detectRes.ok, true);
    if (detectRes.ok) {
      const data = detectRes.data as {
        agents: Array<{ agentId: string; installed: boolean; version?: string; mcpConfigured: boolean; mcpConflict?: boolean }>;
        engine: { installed: boolean; running: boolean; providerKind: string; mode?: string; version?: string };
      };
      const codex = data.agents.find(a => a.agentId === 'codex')!;
      const claude = data.agents.find(a => a.agentId === 'claude')!;
      assert.equal(codex.installed, true);
      assert.equal(codex.version, 'codex-cli 0.42.0');
      assert.equal(codex.mcpConfigured, true);
      assert.equal(codex.mcpConflict, true);

      assert.equal(claude.installed, true);
      assert.equal(claude.mcpConfigured, true);
      assert.equal(claude.mcpConflict, false);

      assert.equal(data.engine.installed, true);
      assert.equal(data.engine.running, true);
      assert.equal(data.engine.providerKind, 'murmur-personal');
      assert.equal(data.engine.mode, 'personal');
      assert.equal(data.engine.version, '1.2.0');
    }

    assert.equal(configReadRes.ok, true);
  });

  it('classifies magpie-desktop, unknown port occupiers, and degrades gracefully on future murmur status schemaVersion', async () => {
    const dataDir = makeTempDir('om-det-data-');
    const homeDir = makeTempDir('om-det-home-');
    const signedConfig = createSampleSignedConfig(Buffer.from('bin'));

    const runtimeMagpie = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '/opt/homebrew/bin' },
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      loginShellRunner: async () => ({ exitCode: 0, stdout: '' }),
      pathResolverFs: {
        existsSync: p => p === '/opt/homebrew/bin',
        readdirSync: () => [],
        isExecutableFile: p => p === '/opt/homebrew/bin/murmur',
      },
      commandRunner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 99,
          version: '9.0.0',
          mode: 'personal',
          daemonRunning: true,
        }),
        stderr: '',
      }),
      engineHttpProbe: async () => ({
        reachable: true,
        statusCode: 200,
        headers: { server: 'magpie-desktop/2.0' },
        body: '{}',
      }),
    });

    const magpieRes = await runtimeMagpie.atoms.detect.scan();
    assert.equal(magpieRes.ok, true);
    if (magpieRes.ok) {
      assert.equal(magpieRes.data.engine.providerKind, 'magpie-desktop');
      assert.equal(magpieRes.data.engine.mode, 'unknown');
      assert.equal(magpieRes.data.engine.version, '9.0.0');
    }

    const runtimeOther = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '' },
      getSignedConfig: () => signedConfig,
      confirmCallback: async () => true,
      loginShellRunner: async () => ({ exitCode: 0, stdout: '' }),
      pathResolverFs: { existsSync: () => false, readdirSync: () => [], isExecutableFile: () => false },
      engineHttpProbe: async () => ({
        reachable: true,
        statusCode: 404,
        headers: { server: 'nginx/1.25' },
        body: 'not found',
      }),
    });

    const otherRes = await runtimeOther.atoms.detect.scan();
    assert.equal(otherRes.ok, true);
    if (otherRes.ok) {
      assert.equal(otherRes.data.engine.providerKind, 'other-process');
      assert.equal(otherRes.data.engine.occupiedBy, 'nginx/1.25');
      assert.equal(otherRes.data.engine.installed, false);
    }
  });
});

describe('Windows Authenticode code signature verification', () => {
  it('validates Status === Valid and constant-time SHA-256 / SHA-1 publisher thumbprint pinning', async () => {
    const pinnedSha256 = 'A'.repeat(64);
    const pinnedSha1 = 'B'.repeat(40);
    const wrongSha256 = 'C'.repeat(64);

    // Valid SHA-256 match (case-insensitive)
    const okSha256 = evaluateWindowsAuthenticodeResult(
      {
        Status: 'Valid',
        Thumbprint: '0'.repeat(40),
        Sha256Thumbprint: pinnedSha256.toLowerCase(),
        Subject: 'CN=Powerformer Inc.',
      },
      [pinnedSha256],
    );
    assert.equal(okSha256.ok, true);
    if (okSha256.ok) assert.equal(okSha256.teamId, pinnedSha256);

    // Valid SHA-1 match
    const okSha1 = evaluateWindowsAuthenticodeResult(
      {
        Status: 'Valid',
        Thumbprint: pinnedSha1.toLowerCase(),
        Sha256Thumbprint: wrongSha256,
      },
      [pinnedSha1],
    );
    assert.equal(okSha1.ok, true);

    // Rejects untrusted / tampered status even if thumbprint matches
    const badStatus = evaluateWindowsAuthenticodeResult(
      {
        Status: 'HashMismatch',
        StatusMessage: 'File hash does not match signature',
        Sha256Thumbprint: pinnedSha256,
      },
      [pinnedSha256],
    );
    assert.equal(badStatus.ok, false);
    if (!badStatus.ok) assert.match(badStatus.reason, /HashMismatch/);

    // Rejects wrong signer thumbprint
    const mismatch = evaluateWindowsAuthenticodeResult(
      {
        Status: 'Valid',
        Sha256Thumbprint: wrongSha256,
      },
      [pinnedSha256],
    );
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.actualTeamId, wrongSha256);

    // Fails closed when publisher has no Windows thumbprints configured
    const unconfigured = await defaultCodeSignatureVerifier(
      'C:\\Program Files\\OpenDesign\\murmur.exe',
      'POWERFORMER_MURMUR_TEAM_ID_PENDING',
      'win32',
      { id: 'powerformer-murmur', label: 'Test', appleTeamId: 'POWERFORMER_MURMUR_TEAM_ID_PENDING' },
    );
    assert.equal(unconfigured.ok, false);
    if (!unconfigured.ok) assert.match(unconfigured.reason, /thumbprint is not configured/i);
  });
});

describe('Security & robustness regressions (PR #1001 review)', () => {
  it('preserves 0600 file permissions when rewriting and restoring agent config files', async () => {
    const homeDir = makeTempDir('om-perm-home-');
    const dataDir = makeTempDir('om-perm-data-');
    const claudePath = path.join(homeDir, '.claude.json');
    writeFileSync(claudePath, JSON.stringify({ secretToken: 'keep-private', mcpServers: {} }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(claudePath, 0o600);

    const signedConfig: SignedConfigPayload = {
      configRules: {
        claude_mcp: {
          ruleId: 'claude_mcp',
          agentId: 'claude',
          displayName: 'Claude Code',
          fileFormat: 'json',
          homeRelativePath: '.claude.json',
          fieldType: 'remote_mcp_entry',
          sectionPath: 'mcpServers',
        },
      },
      features: {
        mcp_connect: {
          featureId: 'mcp_connect',
          version: '1.0.0',
          title: 'Connect MCP',
          summary: 'Write MCP config',
          configRuleIds: ['claude_mcp'],
        },
      },
    };

    const configAtom = createConfigAtom({
      homeDir,
      dataDir,
      channel: 'stable',
      getSignedConfig: () => signedConfig,
      confirmationGate: createFeatureConfirmationGate({ dataDir, confirmCallback: async () => true }),
      mutationQueue: createSerialMutationQueue(),
    });

    const written = await configAtom.write({
      featureId: 'mcp_connect',
      ruleId: 'claude_mcp',
      fieldType: 'remote_mcp_entry',
      value: { serverName: 'openmotion', url: 'https://app.open-design.ai/mcp' },
    });
    assert.equal(written.ok, true);
    if (process.platform !== 'win32') {
      assert.equal(statSync(claudePath).mode & 0o777, 0o600);
    }
    if (written.ok && written.data.backupPath) {
      const restored = await configAtom.restoreBackup({
        featureId: 'mcp_connect',
        backupPath: written.data.backupPath,
      });
      assert.equal(restored.ok, true);
      if (process.platform !== 'win32') {
        assert.equal(statSync(claudePath).mode & 0o777, 0o600);
      }
    }
  });

  it('removes complete multiline TOML args arrays when replacing legacy stdio entries', () => {
    const legacyToml = [
      '[mcp_servers.openmotion]',
      'command = "node"',
      'args = [',
      '  "server.js",',
      '  "--stdio"',
      ']',
      'startup_timeout_sec = 30',
      '',
      '[mcp_servers.other]',
      'url = "https://other.open-design.ai/mcp"',
      '',
    ].join('\n');

    const replaced = upsertTomlMcpEntry(
      legacyToml,
      'mcp_servers',
      { serverName: 'openmotion', url: 'https://app.open-design.ai/mcp' },
      'replace',
    );
    assert.equal(replaced.ok, true);
    if (replaced.ok) {
      assert.equal(replaced.content.includes('server.js'), false);
      assert.equal(replaced.content.includes('--stdio'), false);
      assert.equal(replaced.content.includes(']'), true); // section header brackets still present
      assert.match(replaced.content, /url = "https:\/\/app\.open-design\.ai\/mcp"/);
      assert.match(replaced.content, /startup_timeout_sec = 30/);
      assert.match(replaced.content, /\[mcp_servers\.other\]/);
    }
  });

  it('preserves valid TOML [[array-of-tables]] sections when adding or replacing MCP entries', () => {
    const withArrayTables = [
      'model = "gpt-5"',
      '',
      '[[profiles]]',
      'name = "default"',
      'url = "https://example.invalid/profile"',
      '',
      '[[history.entries]]',
      'id = "1"',
      '',
    ].join('\n');

    const added = upsertTomlMcpEntry(
      withArrayTables,
      'mcp_servers',
      { serverName: 'openmotion', url: 'https://app.open-design.ai/mcp' },
      'abort',
    );
    assert.equal(added.ok, true);
    if (added.ok) {
      assert.match(added.content, /\[\[profiles\]\]/);
      assert.match(added.content, /\[\[history\.entries\]\]/);
      assert.match(added.content, /\[mcp_servers\.openmotion\]\nurl = "https:\/\/app\.open-design\.ai\/mcp"/);
    }

    // Replacing a legacy stdio section immediately followed by [[profiles]] must stop at [[profiles]]
    // and never misattribute keys from [[profiles]] to [mcp_servers.openmotion].
    const stdioFollowedByArrayTable = [
      '[mcp_servers.openmotion]',
      'command = "node"',
      'args = ["server.js"]',
      '',
      '[[profiles]]',
      'url = "https://example.invalid/profile"',
      '',
    ].join('\n');

    const parsedBefore = parseTomlMcpEntry(stdioFollowedByArrayTable, 'mcp_servers', 'openmotion');
    assert.equal(parsedBefore.ok, true);
    if (parsedBefore.ok) {
      assert.equal(parsedBefore.entry?.url, undefined);
    }

    const replaced = upsertTomlMcpEntry(
      stdioFollowedByArrayTable,
      'mcp_servers',
      { serverName: 'openmotion', url: 'https://app.open-design.ai/mcp' },
      'replace',
    );
    assert.equal(replaced.ok, true);
    if (replaced.ok) {
      assert.match(replaced.content, /\[mcp_servers\.openmotion\]\nurl = "https:\/\/app\.open-design\.ai\/mcp"/);
      assert.match(replaced.content, /\[\[profiles\]\]\nurl = "https:\/\/example\.invalid\/profile"/);
      assert.equal(replaced.content.includes('command ='), false);
    }
  });

  it('rejects traversal or mismatched manifest.componentId in both bounds validation and installComponent', async () => {
    const badConfig: SignedConfigPayload = {
      components: {
        murmur: {
          componentId: '../escape',
          displayName: 'Bad',
          minVersion: '1.0.0',
          platforms: {
            'darwin-arm64': {
              url: 'https://releases.open-design.ai/murmur.tar.gz',
              sha256: 'a'.repeat(64),
              publisherId: BUILTIN_PUBLISHERS[0]!.id,
            },
          },
        },
      },
      features: {
        install_murmur: {
          featureId: 'install_murmur',
          version: '1.0.0',
          title: 'Install',
          summary: 'Install',
          componentIds: ['murmur'],
        },
      },
    };

    const issues = validateSignedConfigPayloadBounds(badConfig);
    assert.ok(issues.some(i => i.path === 'components.murmur.componentId'));

    const dataDir = makeTempDir('om-comp-data-');
    const registry = new ComponentInstallRegistry(dataDir);
    const installer = createInstallComponentAtom({
      registry,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      getSignedConfig: () => badConfig,
      confirmationGate: createFeatureConfirmationGate({ dataDir, confirmCallback: async () => true }),
      mutationQueue: createSerialMutationQueue(),
    });
    const res = await installer.install({ featureId: 'install_murmur', componentId: 'murmur' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'POLICY_DENIED');
  });

  it('resolves Windows .cmd npm shims to direct shell-free node invocations and ignores extensionless shims on win32', async () => {
    const shimDir = makeTempDir('om-win-shim-');
    const scriptDir = path.join(shimDir, 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'codex.js');
    writeFileSync(scriptPath, 'console.log("ok");\n', 'utf8');
    const shimPath = path.join(shimDir, 'codex.cmd');
    writeFileSync(
      shimPath,
      '@ECHO off\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      'utf8',
    );
    const fakeNode = path.join(shimDir, 'node.exe');
    writeFileSync(fakeNode, '', 'utf8');

    const resolved = await resolveWindowsCmdShimInvocation(shimPath, ['--version'], {
      pathOps: path.posix,
    });
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.binaryPath, fakeNode);
      assert.deepEqual(resolved.argv, [scriptPath, '--version']);
    }

    // PathResolver on win32 skips bare POSIX shims in favor of .cmd / .exe.
    const winResolver = createPathResolver({
      platform: 'win32',
      env: { PATH: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      fs: {
        existsSync: p => p === 'C:\\npm',
        readdirSync: () => [],
        isExecutableFile: p => p === 'C:\\npm\\codex' || p === 'C:\\npm\\codex.cmd',
      },
    });
    assert.equal(await winResolver.resolveBinary('codex'), 'C:\\npm\\codex.cmd');
  });

  it('treats Claude MCP reapplication with an identical URL as idempotent success', async () => {
    const homeDir = makeTempDir('om-claude-home-');
    const dataDir = makeTempDir('om-claude-data-');
    writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          openmotion: { type: 'http', url: 'https://app.open-design.ai/mcp' },
        },
      }),
      'utf8',
    );

    const signedConfig: SignedConfigPayload = {
      features: {
        mcp_connect: {
          featureId: 'mcp_connect',
          version: '1.0.0',
          title: 'Connect',
          summary: 'Connect',
          commandTemplateIds: ['claude.mcp.add_remote'],
        },
      },
    };

    let runnerCalls = 0;
    const execAtom = createExecAtom({
      homeDir,
      channel: 'stable',
      getExpectedMcpUrl: () => 'https://app.open-design.ai/mcp',
      getSignedConfig: () => signedConfig,
      pathResolver: createPathResolver({
        platform: 'darwin',
        fs: { existsSync: () => false, readdirSync: () => [], isExecutableFile: p => p.endsWith('/claude') },
      }),
      componentRegistry: new ComponentInstallRegistry(dataDir),
      confirmationGate: createFeatureConfirmationGate({ dataDir, confirmCallback: async () => true }),
      mutationQueue: createSerialMutationQueue(),
      commandRunner: async (_input: CommandRunnerInput) => {
        runnerCalls += 1;
        return { exitCode: 1, stdout: '', stderr: 'already exists', timedOut: false };
      },
    });

    const result = await execAtom.run({
      featureId: 'mcp_connect',
      templateId: 'claude.mcp.add_remote',
      args: { serverName: 'openmotion', mcpUrl: 'https://app.open-design.ai/mcp' },
      conflictPolicy: 'abort',
    });
    assert.equal(result.ok, true);
    assert.equal(runnerCalls, 0);
  });
});
