import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startAgentBridge } from '../gateway/agent-bridge.ts';
import { renderBridgeInstallShellScript, renderStandaloneBridgeScript } from '../gateway/agent-bridge-script.ts';
import {
  agentRuntimesFor,
  allowedHosts,
  deploymentMode,
  isHostAllowed,
  isLocalDirectEnabled,
  resolvePublicOrigin,
} from '../gateway/agent-runtimes.ts';
import type { AssetAgentRpc } from '../gateway/asset-chat.ts';
import { startServer } from '../server.ts';
import { AGENT_RUNTIMES_API, AGENT_SERVICE_PROTOCOL } from '../shared/agent-runtimes.ts';
import { localAgents } from '../shared/local-agents.ts';
import { SUPER_AGENT_API } from '../shared/super-agent.ts';
import { fixture } from './fixtures.ts';

const execFileAsync = promisify(execFile);

test('deployment policy & host helpers control local-direct availability and public hosts', () => {
  assert.equal(deploymentMode({}), 'local');
  assert.equal(isLocalDirectEnabled({}), true);
  assert.equal(deploymentMode({ MOTION_DEPLOYMENT_MODE: 'cloud' }), 'cloud');
  assert.equal(isLocalDirectEnabled({ MOTION_DEPLOYMENT_MODE: 'cloud' }), false);
  assert.equal(isLocalDirectEnabled({ MOTION_DEPLOYMENT_MODE: 'hybrid', MOTION_DISABLE_LOCAL_DIRECT: '1' }), false);

  assert.equal(resolvePublicOrigin('http://127.0.0.1:4173', {}), 'http://127.0.0.1:4173');
  assert.equal(
    resolvePublicOrigin('http://127.0.0.1:4173', { MOTION_PUBLIC_ORIGIN: 'https://studio.example.com/path' }),
    'https://studio.example.com',
  );

  const hosts = allowedHosts({
    MOTION_ALLOWED_HOSTS: 'cloud.example.com, internal.example.com:8443',
    MOTION_PUBLIC_ORIGIN: 'https://app.example.com',
  });
  assert.ok(hosts.has('localhost'));
  assert.ok(hosts.has('127.0.0.1'));
  assert.ok(hosts.has('cloud.example.com'));
  assert.ok(hosts.has('internal.example.com'));
  assert.ok(hosts.has('app.example.com'));

  assert.equal(isHostAllowed('127.0.0.1:4173', {}), true);
  assert.equal(isHostAllowed('evil.example.com', {}), false);
  assert.equal(isHostAllowed('cloud.example.com:443', { MOTION_ALLOWED_HOSTS: 'cloud.example.com' }), true);
});

test('standalone bridge script passes node --check, embeds all 29 Agents, and install.sh validates inputs', async () => {
  const script = renderStandaloneBridgeScript({ defaultServerUrl: 'https://app.example.com', version: '1.0.0' });
  for (const agent of localAgents) {
    assert.ok(script.includes(JSON.stringify(agent.id)), `Missing agent ID in bridge script: ${agent.id}`);
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'openmotion-bridge-syntax-'));
  try {
    const file = path.join(tmpDir, 'openmotion-agent-bridge.mjs');
    await writeFile(file, script, 'utf8');
    await execFileAsync(process.execPath, ['--check', file], { timeout: 10_000 });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const installScript = renderBridgeInstallShellScript({
    serverUrl: 'https://app.example.com',
    token: 'om_brg_0123456789abcdef0123456789abcdef',
  });
  assert.match(installScript, /^#!\/usr\/bin\/env bash/);
  assert.match(installScript, /https:\/\/app\.example\.com\/motion-api\/agent-runtimes\/bridge\/script/);

  assert.throws(() => renderBridgeInstallShellScript({
    serverUrl: 'https://app.example.com',
    token: 'bad;rm -rf /',
  }));
  assert.throws(() => renderBridgeInstallShellScript({
    serverUrl: 'javascript:alert(1)',
    token: 'om_brg_0123456789abcdef',
  }));
});

test('local bridge tokens hash securely on disk, execute Super Agent turns over SSE + tool-call, and revoke cleanly', () => fixture(async store => {
  const running = await startServer(store, 0, { editor: false });
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  let bridgeHandle: Awaited<ReturnType<typeof startAgentBridge>> | null = null;

  try {
    const tokenRes = await fetch(`${origin}${AGENT_RUNTIMES_API}/bridge/tokens`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Workstation Mac' }),
    });
    assert.equal(tokenRes.status, 200);
    const bundle = await tokenRes.json() as any;
    assert.match(bundle.token, /^om_brg_/);
    assert.match(bundle.curlCommand, /install\.sh\?token=/);

    // Raw token must never appear in runtimes.json or directory responses
    const storedRaw = await readFile(path.join(store.directory, 'agents/runtimes.json'), 'utf8');
    assert.equal(storedRaw.includes(bundle.token), false);

    // install.sh rejects unauthenticated/invalid tokens
    const badInstall = await fetch(`${origin}${AGENT_RUNTIMES_API}/bridge/install.sh?token=om_brg_0000000000000000`);
    assert.equal(badInstall.status, 401);
    const goodInstall = await fetch(`${origin}${AGENT_RUNTIMES_API}/bridge/install.sh?token=${bundle.token}`);
    assert.equal(goodInstall.status, 200);

    class FakeBridgeCodexRpc {
      onMessage: (msg: any) => Promise<void> | void;
      onClose: (err: Error) => void;
      closed = false;

      constructor(_bin: string, _cwd: string, onMessage: (msg: any) => void, onClose: (err: Error) => void) {
        this.onMessage = onMessage;
        this.onClose = onClose;
      }

      async request(method: string) {
        if (method === 'initialize') return {};
        if (method === 'thread/start') return { thread: { id: 'bridge-thread-1' } };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            void this.onMessage({
              id: 501,
              method: 'item/tool/call',
              params: {
                callId: 'bridge-call-1',
                tool: 'openmotion_present_artifact',
                arguments: { kind: 'web', title: 'Bridge Demo Site', url: 'https://example.com' },
              },
            });
          });
          return { turn: { id: 'bridge-turn-1' } };
        }
        return {};
      }

      send(payload: any) {
        if (payload.id === 501) {
          assert.equal(payload.result?.success, true);
          queueMicrotask(() => {
            void this.onMessage({
              method: 'item/agentMessage/delta',
              params: { itemId: 'b-msg-1', delta: 'Executed via local bridge.' },
            });
            void this.onMessage({
              method: 'item/completed',
              params: { item: { id: 'b-msg-1', type: 'agentMessage', text: 'Executed via local bridge.' } },
            });
            void this.onMessage({
              method: 'turn/completed',
              params: { turn: { id: 'bridge-turn-1', status: 'completed' } },
            });
          });
        }
      }

      close() {
        this.closed = true;
      }
    }

    bridgeHandle = await startAgentBridge({
      serverUrl: origin,
      token: bundle.token,
      name: 'Workstation Mac',
      heartbeatMs: 10_000,
      resolveBin: async bin => (bin === 'codex' ? '/usr/local/bin/codex' : null),
      inspectAgent: async id => ({
        id,
        label: id === 'codex' ? 'Codex' : id,
        bin: id,
        icon: id,
        website: '',
        installed: id === 'codex',
        auth: id === 'codex' ? 'signed-in' : 'unknown',
        checkedAt: new Date().toISOString(),
        models: id === 'codex' ? [{ id: 'gpt-5-bridge', label: 'GPT-5 Bridge', source: 'cli', reasoning: ['medium', 'high'] }] : [],
      }),
      rpcFactory: FakeBridgeCodexRpc as unknown as typeof AssetAgentRpc,
    });

    const dirRes = await fetch(`${origin}${AGENT_RUNTIMES_API}`);
    assert.equal(dirRes.status, 200);
    const dir = await dirRes.json() as any;
    const bridgeEntry = dir.runtimes.find((rt: any) => rt.id === bridgeHandle!.runtimeId);
    assert.ok(bridgeEntry);
    assert.equal(bridgeEntry.kind, 'local-bridge');
    assert.equal(bridgeEntry.status, 'online');
    assert.ok(bridgeEntry.runnableAgentIds.includes('codex'));

    // Inspect over SSE refreshes bridge agent info
    const shortId = bridgeHandle.runtimeId.slice('bridge:'.length);
    const inspectRes = await fetch(`${origin}${AGENT_RUNTIMES_API}/bridge/${encodeURIComponent(shortId)}/inspect/codex`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(inspectRes.status, 200);
    const inspectedAgent = await inspectRes.json() as any;
    assert.equal(inspectedAgent.models[0].id, 'gpt-5-bridge');

    // Run Super Agent conversation on the bridge runtime
    const createChat = await fetch(`${origin}${SUPER_AGENT_API}/chats`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeId: bridgeHandle.runtimeId, engine: 'codex' }),
    });
    assert.equal(createChat.status, 200);
    const { conversation: createdChat } = await createChat.json() as any;

    const startTurn = await fetch(`${origin}${SUPER_AGENT_API}/chats/${createdChat.id}/turn`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'bridge-turn-req-1',
        runtimeId: bridgeHandle.runtimeId,
        engine: 'codex',
        model: 'gpt-5-bridge',
        text: 'Open example.com in the Viewer',
      }),
    });
    assert.equal(startTurn.status, 200);

    let finalChat: any;
    for (let i = 0; i < 80; i++) {
      const poll = await fetch(`${origin}${SUPER_AGENT_API}/chats/${createdChat.id}`);
      const body = await poll.json() as any;
      finalChat = body.conversation;
      if (finalChat.state === 'idle' || finalChat.state === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    assert.equal(finalChat.state, 'idle');
    assert.equal(finalChat.runtimeId, bridgeHandle.runtimeId);
    assert.ok(finalChat.messages.some((m: any) => m.role === 'assistant' && m.text.includes('Executed via local bridge.')));
    assert.ok(finalChat.artifacts.some((a: any) => a.kind === 'web' && a.url === 'https://example.com/'));

    // Revoking token disconnects and rejects subsequent bridge auth
    const revokeRes = await fetch(`${origin}${AGENT_RUNTIMES_API}/bridge/tokens/${bundle.tokenId}`, {
      method: 'DELETE',
      headers: { Origin: origin },
    });
    assert.equal(revokeRes.status, 200);

    const rejectedHb = await fetch(`${origin}${AGENT_RUNTIMES_API}/bridge/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bundle.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeId: bridgeHandle.runtimeId }),
    });
    assert.equal(rejectedHb.status, 401);
  } finally {
    await bridgeHandle?.stop();
    await running.close();
  }
}));

test('remote custom agent service (openmotion-agent-v1) probes, keeps secrets private, and executes tool callbacks', () => fixture(async store => {
  const pendingToolResults = new Map<string, (value: any) => void>();
  const seenAuthHeaders: string[] = [];

  const mockAgentServer = createServer((req, res) => {
    seenAuthHeaders.push(String(req.headers.authorization || ''));
    if (req.headers.authorization !== 'Bearer top-secret-service-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol: AGENT_SERVICE_PROTOCOL, version: '2.0.0' }));
      return;
    }

    if (req.url === '/v1/agents' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agents: [
          {
            id: 'custom-orchestrator',
            label: 'Custom Orchestrator',
            auth: 'signed-in',
            models: [{ id: 'custom-v2', label: 'Custom V2', reasoning: ['high'] }],
          },
        ],
      }));
      return;
    }

    const toolResultMatch = req.url?.match(/^\/v1\/runs\/([^/]+)\/tool-results$/);
    if (toolResultMatch && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const resolve = pendingToolResults.get(`${toolResultMatch[1]}:${payload.callId}`);
        resolve?.(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
      });
      return;
    }

    if (req.url === '/v1/runs' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const dispatch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.write(`event: thread.started\ndata: ${JSON.stringify({ type: 'thread.started', threadId: 'remote-thread-9' })}\n\n`);

        const toolWait = new Promise<any>(resolve => {
          pendingToolResults.set(`${dispatch.runId}:svc-call-1`, resolve);
        });
        res.write(`event: tool.call\ndata: ${JSON.stringify({
          type: 'tool.call',
          callId: 'svc-call-1',
          tool: 'openmotion_workspace_resources',
          arguments: { kind: 'all' },
        })}\n\n`);

        const toolOutcome = await toolWait;
        assert.equal(toolOutcome.ok, true);
        assert.ok(toolOutcome.structuredContent?.counts);

        res.write(`event: message.delta\ndata: ${JSON.stringify({
          type: 'message.delta',
          messageId: 'svc-msg-1',
          delta: 'Remote service inspected resources cleanly.',
        })}\n\n`);
        res.write(`event: turn.completed\ndata: ${JSON.stringify({ type: 'turn.completed' })}\n\n`);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => mockAgentServer.listen(0, '127.0.0.1', resolve));
  const svcPort = (mockAgentServer.address() as { port: number }).port;
  const serviceEndpoint = `http://127.0.0.1:${svcPort}`;

  const running = await startServer(store, 0, { editor: false });
  const appPort = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${appPort}`;

  try {
    const createSvc = await fetch(`${origin}${AGENT_RUNTIMES_API}/services`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Team Cloud Agent',
        endpoint: serviceEndpoint,
        authType: 'bearer',
        apiKey: 'top-secret-service-key',
      }),
    });
    assert.equal(createSvc.status, 200);
    const service = await createSvc.json() as any;
    assert.equal(service.kind, 'remote-service');
    assert.equal(service.status, 'online');
    assert.equal(service.hasCredentials, true);
    assert.equal(service.agents[0].id, 'custom-orchestrator');

    // Secret must never appear in GET directory responses
    const dirRes = await fetch(`${origin}${AGENT_RUNTIMES_API}`);
    const dirText = await dirRes.text();
    assert.equal(dirText.includes('top-secret-service-key'), false);

    // Verify re-test works
    const shortSvcId = service.id.slice('service:'.length);
    const testRes = await fetch(`${origin}${AGENT_RUNTIMES_API}/services/${encodeURIComponent(shortSvcId)}/test`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(testRes.status, 200);
    const probe = await testRes.json() as any;
    assert.equal(probe.ok, true);

    const createChat = await fetch(`${origin}${SUPER_AGENT_API}/chats`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeId: service.id, engine: 'custom-orchestrator' }),
    });
    const { conversation: chat } = await createChat.json() as any;

    const startTurn = await fetch(`${origin}${SUPER_AGENT_API}/chats/${chat.id}/turn`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'svc-turn-1',
        runtimeId: service.id,
        engine: 'custom-orchestrator',
        model: 'custom-v2',
        text: 'Inspect workspace resources via self-hosted agent',
      }),
    });
    assert.equal(startTurn.status, 200);

    let finalChat: any;
    for (let i = 0; i < 80; i++) {
      const poll = await fetch(`${origin}${SUPER_AGENT_API}/chats/${chat.id}`);
      const body = await poll.json() as any;
      finalChat = body.conversation;
      if (finalChat.state === 'idle' || finalChat.state === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    assert.equal(finalChat.state, 'idle');
    assert.equal(finalChat.threadId, 'remote-thread-9');
    assert.ok(finalChat.messages.some((m: any) => m.role === 'tool' && m.toolEvent?.tool === 'openmotion_workspace_resources'));
    assert.ok(finalChat.messages.some((m: any) => m.role === 'assistant' && m.text.includes('Remote service inspected resources cleanly.')));
    assert.ok(seenAuthHeaders.every(h => h === 'Bearer top-secret-service-key'));
  } finally {
    await agentRuntimesFor(store.directory).close();
    await running.close();
    await new Promise<void>(resolve => mockAgentServer.close(() => resolve()));
  }
}));
