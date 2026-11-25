import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
  CONNECT_SCRIPT_ENDPOINTS,
  CONNECT_SCRIPT_HOST,
  CONNECT_SCRIPT_PROTOCOL_VERSION,
  CONNECT_SCRIPT_TOKEN_HEADER,
  type ConnectScriptEventMessage,
  type ConnectScriptHealthResponse,
} from '../shared/connect-script-protocol.ts';
import { DEFAULT_STUDIO_URLS } from '../shared/desktop-builtin-rules.ts';
import {
  HOST_CAPABILITIES,
  HOST_CONTRACT_VERSION,
  hostErr,
  hostOk,
  type AtomDetectResult,
  type AtomExecParams,
  type AtomExecResult,
  type DetectedAgentCli,
  type HostCapabilityDescriptor,
  type HostConfirmationRequest,
  type HostInvokeResult,
  type HostRuntimeInfo,
  type UniversalHostBridge,
} from '../shared/desktop-contract.ts';
import {
  CONNECT_SCRIPT_MAX_BODY_BYTES,
  buildStudioPairingUrl,
  confirmInTerminal,
  createStubConnectBridge,
  createTerminalConfirm,
  formatConfirmationRequest,
  parseConnectCliArgs,
  runConnectCli,
  runConnectFlow,
  startConnectScriptServer,
  type ConfirmFn,
} from '../packages/connect-script/index.ts';

const ALLOWED_ORIGIN = 'https://motion.open-design.ai';
const EVIL_ORIGIN = 'https://evil.example.com';

type MockBridgeController = {
  bridge: UniversalHostBridge;
  invokeCalls: Array<{ capability: string; method: string; params?: Record<string, unknown> }>;
  subscriptions: Array<{
    capability: string;
    event: string;
    callback: (payload: unknown) => void;
    unsubscribed: boolean;
  }>;
  emit: (capability: string, event: string, payload: unknown) => void;
};

function createMockBridge(options?: {
  agents?: DetectedAgentCli[];
  execHandler?: (params: AtomExecParams) => HostInvokeResult<AtomExecResult>;
}): MockBridgeController {
  const invokeCalls: MockBridgeController['invokeCalls'] = [];
  const subscriptions: MockBridgeController['subscriptions'] = [];

  const runtimeInfo: HostRuntimeInfo = {
    hostKind: 'connect-script',
    shellVersion: '1.0.0',
    contractVersion: HOST_CONTRACT_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    releaseChannel: 'stable',
    isPackaged: false,
    nodeVersion: process.version,
  };

  const capabilitiesList: HostCapabilityDescriptor[] = [
    {
      name: HOST_CAPABILITIES.ATOM_DETECT,
      version: '1.0.0',
      status: 'available',
      methods: ['detect'],
    },
    {
      name: HOST_CAPABILITIES.ATOM_EXEC,
      version: '1.0.0',
      status: 'available',
      methods: ['run'],
    },
  ];

  const defaultAgents: DetectedAgentCli[] = options?.agents ?? [
    {
      agentId: 'codex',
      installed: true,
      binaryPath: '/usr/local/bin/codex',
      version: '0.28.0',
      mcpConfigured: false,
      configPath: '~/.codex/config.toml',
    },
    {
      agentId: 'claude',
      installed: true,
      binaryPath: '/usr/local/bin/claude',
      version: '1.0.40',
      mcpConfigured: false,
      configPath: '~/.claude.json',
    },
  ];

  const bridge: UniversalHostBridge = {
    info: async () => runtimeInfo,
    capabilities: async () => capabilitiesList,
    invoke: async <T = unknown>(
      capability: string,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<HostInvokeResult<T>> => {
      invokeCalls.push({ capability, method, params });

      if (capability === HOST_CAPABILITIES.ATOM_DETECT && method === 'detect') {
        const payload: AtomDetectResult = {
          platform: 'darwin',
          arch: 'arm64',
          agents: defaultAgents,
          engine: {
            installed: false,
            running: false,
            port: 3425,
            providerKind: 'none',
          },
          detectedAt: '2026-11-23T12:00:00.000Z',
        };
        return hostOk(payload as T);
      }

      if (capability === HOST_CAPABILITIES.ATOM_EXEC && method === 'run') {
        const execParams = (params ?? {}) as AtomExecParams;
        if (options?.execHandler) {
          return options.execHandler(execParams) as HostInvokeResult<T>;
        }
        const program = execParams.templateId.startsWith('claude') ? 'claude' : 'codex';
        const result: AtomExecResult = {
          templateId: execParams.templateId,
          program,
          exitCode: 0,
          stdout: `registered ${String(execParams.args?.serverName ?? 'openmotion')}`,
          stderr: '',
          durationMs: 12,
        };
        return hostOk(result as T);
      }

      return hostErr('UNSUPPORTED', `Unsupported capability ${capability}.${method}`);
    },
    subscribe: (capability, event, callback) => {
      const entry = { capability, event, callback, unsubscribed: false };
      subscriptions.push(entry);
      return () => {
        entry.unsubscribed = true;
      };
    },
  };

  const emit = (capability: string, event: string, payload: unknown) => {
    for (const sub of subscriptions) {
      if (sub.unsubscribed) continue;
      if (sub.capability === '*' && sub.event === '*') {
        sub.callback({ capability, event, payload });
      } else if (
        (sub.capability === '*' || sub.capability === capability) &&
        (sub.event === '*' || sub.event === event)
      ) {
        sub.callback(payload);
      }
    }
  };

  return { bridge, invokeCalls, subscriptions, emit };
}

function createTextSink(): { stream: PassThrough; readAll: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  });
  return {
    stream,
    readAll: () => Buffer.concat(chunks).toString('utf8'),
  };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 15,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  assert.fail(`Condition was not satisfied within ${timeoutMs}ms`);
}

describe('Web Connect Script Loopback Server', () => {
  it('enforces Origin allowlist on all requests including health, preflight, and SSE', async () => {
    const mock = createMockBridge();
    const server = await startConnectScriptServer({
      bridge: mock.bridge,
      port: 0,
      channel: 'stable',
    });

    try {
      assert.equal(server.host, CONNECT_SCRIPT_HOST);
      assert.ok(server.port > 0);
      assert.ok(server.token.length >= 32);

      // Missing Origin -> 403 on health
      const missingOriginHealth = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.HEALTH}`);
      assert.equal(missingOriginHealth.status, 403);
      const missingOriginBody = (await missingOriginHealth.json()) as {
        ok: false;
        error: { code: string };
      };
      assert.equal(missingOriginBody.ok, false);
      assert.equal(missingOriginBody.error.code, 'ORIGIN_DENIED');

      // Missing Origin -> 403 on info even with valid token
      const missingOriginInfo = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INFO}`, {
        headers: { [CONNECT_SCRIPT_TOKEN_HEADER]: server.token },
      });
      assert.equal(missingOriginInfo.status, 403);

      // Evil Origin -> 403 on GET and OPTIONS preflight
      const evilHealth = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.HEALTH}`, {
        headers: { Origin: EVIL_ORIGIN },
      });
      assert.equal(evilHealth.status, 403);
      assert.equal(evilHealth.headers.get('access-control-allow-origin'), null);

      const evilPreflight = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'OPTIONS',
        headers: {
          Origin: EVIL_ORIGIN,
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      assert.equal(evilPreflight.status, 403);
      assert.equal(evilPreflight.headers.get('access-control-allow-private-network'), null);

      // Staging origin rejected on stable channel
      const stagingOnStable = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.HEALTH}`, {
        headers: { Origin: DEFAULT_STUDIO_URLS.test },
      });
      assert.equal(stagingOnStable.status, 403);

      // Allowed Origin -> 204 on OPTIONS preflight with CORS + PNA headers when requested
      const allowedPreflight = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      assert.equal(allowedPreflight.status, 204);
      assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      assert.equal(allowedPreflight.headers.get('access-control-allow-private-network'), 'true');
      assert.match(allowedPreflight.headers.get('vary') ?? '', /Access-Control-Request-Private-Network/i);
      assert.match(
        allowedPreflight.headers.get('access-control-allow-headers') ?? '',
        new RegExp(CONNECT_SCRIPT_TOKEN_HEADER, 'i'),
      );

      // Allowed Origin -> 200 on /v1/health without leaking token or host internals
      const allowedHealth = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.HEALTH}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(allowedHealth.status, 200);
      assert.equal(allowedHealth.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      const healthBody = (await allowedHealth.json()) as ConnectScriptHealthResponse;
      assert.deepEqual(healthBody, {
        ok: true,
        protocolVersion: CONNECT_SCRIPT_PROTOCOL_VERSION,
        hostKind: 'connect-script',
        requiresToken: true,
      });
      assert.equal(JSON.stringify(healthBody).includes(server.token), false);
    } finally {
      await server.close();
    }
  });

  it('allows localhost origin only on dev channel with allowLocalDevLoopback', async () => {
    const mock = createMockBridge();
    const stableServer = await startConnectScriptServer({
      bridge: mock.bridge,
      port: 0,
      channel: 'stable',
      allowLocalDevLoopback: true,
    });
    const devServer = await startConnectScriptServer({
      bridge: mock.bridge,
      port: 0,
      channel: 'dev',
      allowLocalDevLoopback: true,
    });

    try {
      const localOrigin = 'http://127.0.0.1:4173';
      const rejectedOnStable = await fetch(`${stableServer.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.HEALTH}`, {
        headers: { Origin: localOrigin },
      });
      assert.equal(rejectedOnStable.status, 403);

      const acceptedOnDev = await fetch(`${devServer.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.HEALTH}`, {
        headers: { Origin: localOrigin },
      });
      assert.equal(acceptedOnDev.status, 200);
    } finally {
      await stableServer.close();
      await devServer.close();
    }
  });

  it('enforces timing-safe token auth across header, Bearer, and SSE query param', async () => {
    const mock = createMockBridge();
    const server = await startConnectScriptServer({
      bridge: mock.bridge,
      port: 0,
      channel: 'stable',
    });

    try {
      // Missing token -> 401
      const missingToken = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INFO}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(missingToken.status, 401);

      // Wrong token -> 401
      const wrongToken = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.CAPABILITIES}`, {
        headers: {
          Origin: ALLOWED_ORIGIN,
          [CONNECT_SCRIPT_TOKEN_HEADER]: 'wrong-token-value',
        },
      });
      assert.equal(wrongToken.status, 401);

      // Query param token rejected on non-SSE /v1/info endpoint
      const queryOnInfo = await fetch(
        `${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INFO}?token=${encodeURIComponent(server.token)}`,
        { headers: { Origin: ALLOWED_ORIGIN } },
      );
      assert.equal(queryOnInfo.status, 401);

      // Valid custom header -> 200
      const headerAuth = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INFO}`, {
        headers: {
          Origin: ALLOWED_ORIGIN,
          [CONNECT_SCRIPT_TOKEN_HEADER]: server.token,
        },
      });
      assert.equal(headerAuth.status, 200);

      // Valid Authorization: Bearer -> 200
      const bearerAuth = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.CAPABILITIES}`, {
        headers: {
          Origin: ALLOWED_ORIGIN,
          Authorization: `Bearer ${server.token}`,
        },
      });
      assert.equal(bearerAuth.status, 200);

      // Missing token on /v1/events -> 401
      const noTokenEvents = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.EVENTS}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(noTokenEvents.status, 401);
    } finally {
      await server.close();
    }
  });

  it('serves full HTTP round-trips for info, capabilities, and invoke (including errors and limits)', async () => {
    const mock = createMockBridge();
    const server = await startConnectScriptServer({
      bridge: mock.bridge,
      port: 0,
      channel: 'stable',
    });

    const authHeaders = {
      Origin: ALLOWED_ORIGIN,
      [CONNECT_SCRIPT_TOKEN_HEADER]: server.token,
    };

    try {
      // GET /v1/info
      const infoRes = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INFO}`, {
        headers: authHeaders,
      });
      assert.equal(infoRes.status, 200);
      const info = (await infoRes.json()) as HostRuntimeInfo;
      assert.equal(info.hostKind, 'connect-script');
      assert.equal(info.contractVersion, HOST_CONTRACT_VERSION);

      // GET /v1/capabilities
      const capRes = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.CAPABILITIES}`, {
        headers: authHeaders,
      });
      assert.equal(capRes.status, 200);
      const caps = (await capRes.json()) as HostCapabilityDescriptor[];
      assert.equal(caps.length, 2);
      assert.equal(caps[0]?.name, HOST_CAPABILITIES.ATOM_DETECT);

      // POST /v1/invoke success
      const invokeOkRes = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability: HOST_CAPABILITIES.ATOM_DETECT,
          method: 'detect',
          params: {},
        }),
      });
      assert.equal(invokeOkRes.status, 200);
      const invokeOk = (await invokeOkRes.json()) as HostInvokeResult<AtomDetectResult>;
      assert.equal(invokeOk.ok, true);
      if (invokeOk.ok) {
        assert.equal(invokeOk.data.agents.length, 2);
      }

      // POST /v1/invoke UNSUPPORTED capability
      const invokeUnsupportedRes = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability: 'window',
          method: 'focus',
        }),
      });
      assert.equal(invokeUnsupportedRes.status, 200);
      const invokeUnsupported = (await invokeUnsupportedRes.json()) as HostInvokeResult;
      assert.equal(invokeUnsupported.ok, false);
      if (!invokeUnsupported.ok) {
        assert.equal(invokeUnsupported.error.code, 'UNSUPPORTED');
      }

      // POST /v1/invoke malformed JSON -> 400
      const malformedRes = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: '{not-valid-json',
      });
      assert.equal(malformedRes.status, 400);

      // POST /v1/invoke missing method -> 400
      const missingMethodRes = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability: HOST_CAPABILITIES.ATOM_DETECT }),
      });
      assert.equal(missingMethodRes.status, 400);

      // POST /v1/invoke oversized (> 64 KB) body -> 413
      const oversizedPayload = JSON.stringify({
        capability: HOST_CAPABILITIES.ATOM_EXEC,
        method: 'run',
        params: { blob: 'x'.repeat(CONNECT_SCRIPT_MAX_BODY_BYTES + 1024) },
      });
      const oversizedRes = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: oversizedPayload,
      });
      assert.equal(oversizedRes.status, 413);

      // Unknown route -> 404, wrong method -> 405
      const notFoundRes = await fetch(`${server.baseUrl}/v1/does-not-exist`, {
        headers: authHeaders,
      });
      assert.equal(notFoundRes.status, 404);

      const wrongMethodRes = await fetch(`${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`, {
        method: 'GET',
        headers: authHeaders,
      });
      assert.equal(wrongMethodRes.status, 405);
    } finally {
      await server.close();
    }
  });

  it('streams SSE events on /v1/events with heartbeats and unsubscribes cleanly on disconnect', async () => {
    const mock = createMockBridge();
    const server = await startConnectScriptServer({
      bridge: mock.bridge,
      port: 0,
      channel: 'stable',
      heartbeatIntervalMs: 40,
    });

    try {
      const controller = new AbortController();
      const eventsUrl = `${server.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.EVENTS}?token=${encodeURIComponent(server.token)}`;
      const response = await fetch(eventsUrl, {
        headers: { Origin: ALLOWED_ORIGIN },
        signal: controller.signal,
      });

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.ok(response.body);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      await waitForCondition(() => mock.subscriptions.length === 1 && server.activeEventClients() === 1);

      // Emit a real bridge event and collect chunks until both event and heartbeat arrive
      mock.emit(HOST_CAPABILITIES.ATOM_EXEC, 'progress', { step: 'registering', percent: 50 });

      let accumulated = '';
      const deadline = Date.now() + 2000;
      while (
        Date.now() < deadline &&
        (!accumulated.includes('"registering"') || !accumulated.includes(': heartbeat'))
      ) {
        const chunk = await reader.read();
        if (chunk.done) break;
        accumulated += decoder.decode(chunk.value, { stream: true });
      }

      assert.match(accumulated, /: connected/);
      assert.match(accumulated, /: heartbeat/);

      const dataLines = accumulated
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice('data: '.length)) as ConnectScriptEventMessage);

      assert.equal(dataLines.length, 1);
      assert.deepEqual(dataLines[0], {
        capability: HOST_CAPABILITIES.ATOM_EXEC,
        event: 'progress',
        payload: { step: 'registering', percent: 50 },
      });

      // Disconnect client and verify bridge unsubscribe + active client count drop to 0
      controller.abort();
      await reader.cancel().catch(() => {});

      await waitForCondition(
        () => mock.subscriptions[0]?.unsubscribed === true && server.activeEventClients() === 0,
      );
      assert.equal(mock.subscriptions[0]?.unsubscribed, true);
      assert.equal(server.activeEventClients(), 0);
    } finally {
      await server.close();
    }
  });
});

describe('Terminal Confirmation Prompt', () => {
  const sampleRequest: HostConfirmationRequest = {
    featureId: 'connect-local-agent',
    featureVersion: '1.0.0',
    featureTitle: 'Connect Local Agent CLI',
    facts: [
      { kind: 'exec_program', label: 'codex CLI', value: 'codex mcp add openmotion --url https://motion.open-design.ai/mcp' },
      { kind: 'modify_file', label: 'codex config', value: '~/.codex/config.toml' },
      { kind: 'connect_url', label: 'OpenMotion Cloud MCP', value: 'https://motion.open-design.ai/mcp' },
      { kind: 'install_component', label: 'Murmur engine', value: 'murmur-engine@1.2.0' },
      { kind: 'store_credential', label: 'API token', value: 'keychain:openmotion' },
    ],
  };

  it('formats every shell-computed fact kind clearly', () => {
    const text = formatConfirmationRequest(sampleRequest);
    assert.match(text, /Connect Local Agent CLI \(connect-local-agent@1\.0\.0\)/);
    assert.match(text, /Program \(codex CLI\): codex mcp add openmotion/);
    assert.match(text, /File \(codex config\): ~\/\.codex\/config\.toml/);
    assert.match(text, /URL \(OpenMotion Cloud MCP\): https:\/\/motion\.open-design\.ai\/mcp/);
    assert.match(text, /Component \(Murmur engine\): murmur-engine@1\.2\.0/);
    assert.match(text, /Credential \(API token\): keychain:openmotion/);
  });

  it('accepts y/yes and rejects n/empty/other answers', async () => {
    const yesSink = createTextSink();
    const accepted = await confirmInTerminal(sampleRequest, {
      output: yesSink.stream,
      ask: async prompt => {
        assert.equal(prompt, 'Proceed? [y/N] ');
        return 'y';
      },
    });
    assert.equal(accepted, true);
    assert.match(yesSink.readAll(), /Program \(codex CLI\)/);

    const yesWord = await confirmInTerminal(sampleRequest, {
      output: createTextSink().stream,
      ask: async () => 'YES',
    });
    assert.equal(yesWord, true);

    const declined = await confirmInTerminal(sampleRequest, {
      output: createTextSink().stream,
      ask: async () => 'n',
    });
    assert.equal(declined, false);

    const emptyDefault = await confirmInTerminal(sampleRequest, {
      output: createTextSink().stream,
      ask: async () => '',
    });
    assert.equal(emptyDefault, false);
  });

  it('reads interactive answers from an injected readable stream and supports --yes', async () => {
    const input = new PassThrough();
    const output = createTextSink();
    const confirm = createTerminalConfirm({ input, output: output.stream });

    const pending = confirm(sampleRequest);
    input.end('yes\n');
    assert.equal(await pending, true);

    const autoSink = createTextSink();
    let askCalled = false;
    const autoApproved = await confirmInTerminal(sampleRequest, {
      yes: true,
      output: autoSink.stream,
      ask: async () => {
        askCalled = true;
        return 'n';
      },
    });
    assert.equal(autoApproved, true);
    assert.equal(askCalled, false);
    assert.match(autoSink.readAll(), /Auto-confirmed \(--yes\)/);
  });
});

describe('CLI Argument Parsing & Orchestration', () => {
  it('parses connect, serve, help, and rejects invalid arguments or out-of-scope URLs', () => {
    const defaultParsed = parseConnectCliArgs([]);
    assert.equal(defaultParsed.ok, true);
    if (defaultParsed.ok) {
      assert.equal(defaultParsed.args.mode, 'connect');
      assert.equal(defaultParsed.args.target, 'all');
      assert.equal(defaultParsed.args.channel, 'stable');
      assert.equal(defaultParsed.args.studioUrl, 'https://motion.open-design.ai');
      assert.equal(defaultParsed.args.mcpUrl, 'https://motion.open-design.ai/mcp');
      assert.equal(defaultParsed.args.yes, false);
    }

    const codexParsed = parseConnectCliArgs(['--connect', 'codex', '--yes', '--replace-conflict']);
    assert.equal(codexParsed.ok, true);
    if (codexParsed.ok) {
      assert.equal(codexParsed.args.mode, 'connect');
      assert.equal(codexParsed.args.target, 'codex');
      assert.equal(codexParsed.args.yes, true);
      assert.equal(codexParsed.args.replaceConflict, true);
    }

    const serveParsed = parseConnectCliArgs([
      '--serve',
      '--port=0',
      '--channel',
      'dev',
      '--allow-dev-loopback',
    ]);
    assert.equal(serveParsed.ok, true);
    if (serveParsed.ok) {
      assert.equal(serveParsed.args.mode, 'serve');
      assert.equal(serveParsed.args.port, 0);
      assert.equal(serveParsed.args.channel, 'dev');
      assert.equal(serveParsed.args.allowDevLoopback, true);
    }

    const conflictModes = parseConnectCliArgs(['--serve', '--connect', 'claude']);
    assert.equal(conflictModes.ok, false);

    const badTarget = parseConnectCliArgs(['--connect', 'unknown-cli']);
    assert.equal(badTarget.ok, false);

    const evilUrl = parseConnectCliArgs(['--mcp-url', 'https://evil.example.com/mcp']);
    assert.equal(evilUrl.ok, false);

    const badPort = parseConnectCliArgs(['--serve', '--port', '99999']);
    assert.equal(badPort.ok, false);
  });

  it('orchestrates one-shot --connect all: detects, confirms facts, runs atom.exec, and prints OAuth next steps', async () => {
    const mock = createMockBridge();
    const out = createTextSink();
    const errOut = createTextSink();
    const parsed = parseConnectCliArgs(['--connect', 'all']);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const seenRequests: HostConfirmationRequest[] = [];
    const confirm: ConfirmFn = async req => {
      seenRequests.push(req);
      return true;
    };

    const result = await runConnectFlow({
      args: parsed.args,
      bridge: mock.bridge,
      confirm,
      output: out.stream,
      errorOutput: errOut.stream,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.cancelled, false);
    assert.equal(seenRequests.length, 1);
    assert.equal(
      seenRequests[0]?.facts.some(f => f.kind === 'exec_program' && f.value.includes('codex mcp add')),
      true,
    );
    assert.equal(
      seenRequests[0]?.facts.some(f => f.kind === 'exec_program' && f.value.includes('claude mcp add')),
      true,
    );
    assert.equal(
      seenRequests[0]?.facts.some(f => f.kind === 'connect_url' && f.value === 'https://motion.open-design.ai/mcp'),
      true,
    );

    // 1 atom.detect + 2 atom.exec invocations
    assert.equal(mock.invokeCalls.length, 3);
    assert.equal(mock.invokeCalls[0]?.capability, HOST_CAPABILITIES.ATOM_DETECT);
    assert.equal(mock.invokeCalls[1]?.capability, HOST_CAPABILITIES.ATOM_EXEC);
    assert.equal(mock.invokeCalls[1]?.params?.templateId, 'codex.mcp.add_remote');
    assert.equal(mock.invokeCalls[2]?.capability, HOST_CAPABILITIES.ATOM_EXEC);
    assert.equal(mock.invokeCalls[2]?.params?.templateId, 'claude.mcp.add_remote');

    const stdoutText = out.readAll();
    assert.match(stdoutText, /Next OAuth step:/);
    assert.match(stdoutText, /codex mcp login openmotion/);
    assert.match(stdoutText, /\/mcp/);
  });

  it('aborts without executing atom.exec when terminal confirmation is declined', async () => {
    const mock = createMockBridge();
    const out = createTextSink();
    const parsed = parseConnectCliArgs(['--connect', 'codex']);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const result = await runConnectFlow({
      args: parsed.args,
      bridge: mock.bridge,
      confirm: async () => false,
      output: out.stream,
      errorOutput: createTextSink().stream,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.cancelled, true);
    assert.equal(mock.invokeCalls.length, 1); // only atom.detect, never atom.exec
    assert.match(out.readAll(), /Cancelled/);
  });

  it('detects MCP conflicts and requires --replace-conflict before overwriting', async () => {
    const conflictingAgents: DetectedAgentCli[] = [
      {
        agentId: 'codex',
        installed: true,
        version: '0.28.0',
        mcpConfigured: true,
        mcpUrl: 'https://old.example.com/mcp',
        mcpConflict: true,
        configPath: '~/.codex/config.toml',
      },
    ];

    // Without --replace-conflict -> skipped with exitCode 1 and no atom.exec
    const mockAbort = createMockBridge({ agents: conflictingAgents });
    const parsedAbort = parseConnectCliArgs(['--connect', 'codex']);
    assert.equal(parsedAbort.ok, true);
    if (!parsedAbort.ok) return;

    const errSink = createTextSink();
    const abortRes = await runConnectFlow({
      args: parsedAbort.args,
      bridge: mockAbort.bridge,
      confirm: async () => true,
      output: createTextSink().stream,
      errorOutput: errSink.stream,
    });
    assert.equal(abortRes.exitCode, 1);
    assert.equal(abortRes.outcomes[0]?.status, 'conflict_skipped');
    assert.equal(mockAbort.invokeCalls.length, 1);
    assert.match(errSink.readAll(), /--replace-conflict/);

    // With --replace-conflict -> executes with conflictPolicy: 'replace'
    const mockReplace = createMockBridge({ agents: conflictingAgents });
    const parsedReplace = parseConnectCliArgs(['--connect', 'codex', '--replace-conflict']);
    assert.equal(parsedReplace.ok, true);
    if (!parsedReplace.ok) return;

    const replaceRes = await runConnectFlow({
      args: parsedReplace.args,
      bridge: mockReplace.bridge,
      confirm: async () => true,
      output: createTextSink().stream,
      errorOutput: createTextSink().stream,
    });
    assert.equal(replaceRes.exitCode, 0);
    assert.equal(replaceRes.outcomes[0]?.status, 'connected');
    assert.equal(mockReplace.invokeCalls[1]?.params?.conflictPolicy, 'replace');
  });

  it('runs --serve via runConnectCli, prints pairing URL with hash fragment, and shuts down cleanly', async () => {
    const mock = createMockBridge();
    const out = createTextSink();
    const errOut = createTextSink();

    let observedBaseUrl = '';
    let observedToken = '';
    let observedPort = 0;

    const exitCode = await runConnectCli(['--serve', '--port', '0', '--channel', 'stable'], {
      createBridge: () => mock.bridge,
      output: out.stream,
      errorOutput: errOut.stream,
      onServerStarted: async handle => {
        observedBaseUrl = handle.baseUrl;
        observedToken = handle.token;
        observedPort = handle.port;
        const res = await fetch(`${handle.baseUrl}${CONNECT_SCRIPT_ENDPOINTS.HEALTH}`, {
          headers: { Origin: ALLOWED_ORIGIN },
        });
        assert.equal(res.status, 200);
      },
      waitForShutdown: async () => {
        // Trigger immediate clean shutdown after verifying live server
      },
    });

    assert.equal(exitCode, 0);
    const stdout = out.readAll();
    const expectedPairingUrl = buildStudioPairingUrl({
      studioUrl: 'https://motion.open-design.ai',
      port: observedPort,
      token: observedToken,
    });
    assert.ok(observedBaseUrl.startsWith('http://127.0.0.1:'));
    assert.ok(stdout.includes(expectedPairingUrl));
    assert.match(expectedPairingUrl, /#connect_port=\d+&connect_token=/);
    assert.match(stdout, /OpenMotion Local Bridge stopped/);
  });

  it('provides a safe stub bridge fallback before local-atoms is wired', async () => {
    const stub = createStubConnectBridge({ channel: 'test' });
    const info = await stub.info();
    assert.equal(info.hostKind, 'connect-script');
    assert.equal(info.releaseChannel, 'test');

    const caps = await stub.capabilities();
    assert.equal(caps.length, 5);
    assert.equal(caps.every(c => c.status === 'unavailable'), true);

    const res = await stub.invoke(HOST_CAPABILITIES.ATOM_DETECT, 'detect', {});
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, 'UNSUPPORTED');
    }
  });

  it('does not auto-approve changed feature definitions in --serve mode', async () => {
    const out = createTextSink();
    const errOut = createTextSink();
    const promptCalls: Array<{ featureId: string; featureVersion: string }> = [];
    let capturedConfirm: ((req: HostConfirmationRequest) => Promise<boolean>) | undefined;

    const exitCode = await runConnectCli(['--serve', '--port', '0', '--channel', 'stable'], {
      createBridge: async opts => {
        capturedConfirm = opts.confirm;
        return createStubConnectBridge({ channel: 'stable' });
      },
      confirm: async req => {
        promptCalls.push({ featureId: req.featureId, featureVersion: req.featureVersion });
        return true;
      },
      output: out.stream,
      errorOutput: errOut.stream,
      onServerStarted: async () => {
        assert.ok(capturedConfirm);
        await capturedConfirm!({
          featureId: 'mcp_connect',
          featureTitle: 'Connect MCP',
          featureVersion: '1.0.0',
          facts: [{ kind: 'connect_url', label: 'Endpoint', value: 'https://motion.open-design.ai/mcp' }],
        });
        await capturedConfirm!({
          featureId: 'mcp_connect',
          featureTitle: 'Connect MCP',
          featureVersion: '2.0.0',
          facts: [{ kind: 'connect_url', label: 'Endpoint', value: 'https://motion.open-design.ai/mcp' }],
        });
      },
      waitForShutdown: async () => {},
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(promptCalls, [
      { featureId: 'mcp_connect', featureVersion: '1.0.0' },
      { featureId: 'mcp_connect', featureVersion: '2.0.0' },
    ]);
  });
});
