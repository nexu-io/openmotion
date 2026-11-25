import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CONNECT_SCRIPT_ENDPOINTS, CONNECT_SCRIPT_TOKEN_HEADER } from '../shared/connect-script-protocol.ts';
import { startConnectScriptServer } from '../packages/connect-script/server.ts';
import { createPathResolver } from '../packages/local-atoms/index.ts';
import { resolveConnectBridge } from '../scripts/connect-local-agent.mjs';

test('Web Connect Script end-to-end: loopback server + local-atoms + signed-config detect and register MCP', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'om-connect-e2e-'));
  const homeDir = path.join(tempRoot, 'home');
  const dataDir = path.join(tempRoot, 'data');
  const binDir = path.join(tempRoot, 'bin');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Create fake codex binary on disk so PathResolver finds it
  const fakeCodex = path.join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  writeFileSync(fakeCodex, '#!/bin/sh\necho "codex-cli 0.169.1"\n', 'utf8');
  if (process.platform !== 'win32') chmodSync(fakeCodex, 0o755);

  const executedCommands: Array<{ file: string; args: string[] }> = [];
  const confirmations: string[] = [];

  try {
    const bridge = await resolveConnectBridge({
      channel: 'stable',
      dataDir,
      homeDir,
      confirm: async req => {
        confirmations.push(req.featureId);
        return true;
      },
      pathResolver: createPathResolver({
        homeDir,
        env: { PATH: binDir },
        loginShellRunner: async () => '',
      }),
      commandRunner: async ({ binaryPath, argv }: { binaryPath: string; argv: readonly string[] }) => {
        executedCommands.push({ file: binaryPath, args: [...argv] });
        if (argv[0] === '--version') {
          return { exitCode: 0, stdout: 'codex-cli 0.169.1\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'Added MCP server openmotion\n', stderr: '' };
      },
      engineHttpProbe: async () => ({ reachable: false }),
    });

    const server = await startConnectScriptServer({
      bridge,
      port: 0,
      channel: 'stable',
    });

    try {
      const origin = 'https://motion.open-design.ai';
      const headers = {
        Origin: origin,
        [CONNECT_SCRIPT_TOKEN_HEADER]: server.token,
        'Content-Type': 'application/json',
      };

      const baseUrl = `http://127.0.0.1:${server.port}`;
      const infoRes = await fetch(`${baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INFO}`, { headers });
      assert.equal(infoRes.status, 200);
      const info = (await infoRes.json()) as { hostKind: string; contractVersion: string };
      assert.equal(info.hostKind, 'connect-script');
      assert.equal(info.contractVersion, '1.0.0');

      const capsRes = await fetch(`${baseUrl}${CONNECT_SCRIPT_ENDPOINTS.CAPABILITIES}`, { headers });
      assert.equal(capsRes.status, 200);
      const caps = (await capsRes.json()) as Array<{ name: string }>;
      const capNames = caps.map(c => c.name);
      assert.ok(capNames.includes('atom.detect'));
      assert.ok(capNames.includes('atom.exec'));
      assert.ok(capNames.includes('signedConfig'));

      // 1. Detect local agents via real atom.detect
      const detectRes = await fetch(`${baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ capability: 'atom.detect', method: 'scan', params: {} }),
      });
      assert.equal(detectRes.status, 200);
      const detectPayload = (await detectRes.json()) as {
        ok: boolean;
        data: { agents: Array<{ agentId: string; installed: boolean; version?: string }> };
      };
      assert.equal(detectPayload.ok, true);
      const codex = detectPayload.data.agents.find(a => a.agentId === 'codex');
      assert.equal(codex?.installed, true);
      assert.equal(codex?.version, 'codex-cli 0.169.1');

      // 2. Register MCP via real atom.exec (triggers host confirmation + domain scope validation)
      const execRes = await fetch(`${baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          capability: 'atom.exec',
          method: 'run',
          params: {
            featureId: 'mcp_connect',
            templateId: 'codex.mcp.add_remote',
            args: {
              serverName: 'openmotion',
              mcpUrl: 'https://motion.open-design.ai/mcp',
            },
          },
        }),
      });
      assert.equal(execRes.status, 200);
      const execPayload = (await execRes.json()) as { ok: boolean; data?: { exitCode: number } };
      assert.equal(execPayload.ok, true);
      assert.equal(execPayload.data?.exitCode, 0);
      assert.deepEqual(confirmations, ['mcp_connect']);
      assert.ok(
        executedCommands.some(
          c =>
            c.file === fakeCodex &&
            c.args.join(' ') === 'mcp add openmotion --url https://motion.open-design.ai/mcp',
        ),
      );

      // 3. Out-of-scope URL must still be rejected end-to-end
      const badExecRes = await fetch(`${baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          capability: 'atom.exec',
          method: 'run',
          params: {
            featureId: 'mcp_connect',
            templateId: 'codex.mcp.add_remote',
            args: {
              serverName: 'openmotion',
              mcpUrl: 'https://evil.example.com/mcp',
            },
          },
        }),
      });
      const badPayload = (await badExecRes.json()) as { ok: boolean; error?: { code: string } };
      assert.equal(badPayload.ok, false);
      assert.equal(badPayload.error?.code, 'POLICY_DENIED');
    } finally {
      await server.close();
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
