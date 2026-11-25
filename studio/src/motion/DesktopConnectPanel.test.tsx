// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_CAPABILITIES,
  hostErr,
  hostOk,
  type AtomDetectResult,
  type HostInvokeResult,
  type UniversalHostBridge,
} from '../../../shared/desktop-contract';
import {
  CONNECT_SCRIPT_ENDPOINTS,
  CONNECT_SCRIPT_TOKEN_HEADER,
} from '../../../shared/connect-script-protocol';
import { I18nProvider } from '../i18n/I18n';
import { createLocalConnectBridge, disconnectLocalConnectBridge } from '../utils/localConnectBridge';
import {
  DesktopConnectPanel,
  resolveAgentConnectionState,
  type DesktopConnectPanelProps,
} from './DesktopConnectPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    node => (node.getAttribute('aria-label') || node.textContent?.trim()) === label,
  );
}

function createDesktopBridgeMock(options: {
  detectResult: () => AtomDetectResult;
  onExec?: (params?: Record<string, unknown>) => HostInvokeResult<unknown>;
}): { bridge: UniversalHostBridge; invokeMock: ReturnType<typeof vi.fn> } {
  const invokeMock = vi.fn(
    async <T = unknown>(
      capability: string,
      _method: string,
      params?: Record<string, unknown>,
    ): Promise<HostInvokeResult<T>> => {
      if (capability === HOST_CAPABILITIES.ATOM_DETECT) {
        return hostOk(options.detectResult()) as HostInvokeResult<T>;
      }
      if (capability === HOST_CAPABILITIES.ATOM_EXEC) {
        if (options.onExec) {
          return options.onExec(params) as HostInvokeResult<T>;
        }
        return hostOk({
          templateId: String(params?.templateId ?? ''),
          program: String(params?.templateId ?? '').startsWith('claude') ? 'claude' : 'codex',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 12,
        }) as HostInvokeResult<T>;
      }
      return hostErr('UNSUPPORTED', 'Unsupported');
    },
  );

  const bridge: UniversalHostBridge = {
    info: vi.fn(async () => ({
      hostKind: 'desktop' as const,
      shellVersion: '1.0.0',
      contractVersion: '1.0.0',
      platform: 'darwin' as const,
      arch: 'arm64',
      releaseChannel: 'stable' as const,
      isPackaged: true,
    })),
    capabilities: vi.fn(async () => [
      { name: HOST_CAPABILITIES.ATOM_DETECT, version: '1.0.0', status: 'available' as const, methods: ['run'] },
      { name: HOST_CAPABILITIES.ATOM_EXEC, version: '1.0.0', status: 'available' as const, methods: ['run'] },
    ]),
    invoke: invokeMock as UniversalHostBridge['invoke'],
    subscribe: () => () => {},
  };

  return { bridge, invokeMock };
}

async function mount(props: DesktopConnectPanelProps = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="en">
        <DesktopConnectPanel {...props} />
      </I18nProvider>,
    ),
  );
  await flushMicrotasks();
}

async function rerender(props: DesktopConnectPanelProps) {
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="en">
        <DesktopConnectPanel {...props} />
      </I18nProvider>,
    ),
  );
  await flushMicrotasks();
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  delete window.__OPENMOTION_HOST__;
  disconnectLocalConnectBridge();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveAgentConnectionState', () => {
  it('strictly distinguishes Config written from Authorized & ready', () => {
    expect(resolveAgentConnectionState(undefined, {})).toBe('not-installed');
    expect(
      resolveAgentConnectionState(
        { agentId: 'codex', installed: true, mcpConfigured: false },
        {},
      ),
    ).toBe('not-configured');
    expect(
      resolveAgentConnectionState(
        { agentId: 'codex', installed: true, mcpConfigured: true },
        { hasAuthorizedConnection: false },
      ),
    ).toBe('configured');
    expect(
      resolveAgentConnectionState(
        { agentId: 'codex', installed: true, mcpConfigured: true },
        { hasAuthorizedConnection: true },
      ),
    ).toBe('authorized');
    expect(
      resolveAgentConnectionState(
        { agentId: 'codex', installed: true, mcpConfigured: true, mcpConflict: true },
        { hasAuthorizedConnection: true },
      ),
    ).toBe('conflict');
  });
});

describe('DesktopConnectPanel', () => {
  it('detects Codex & Claude Code, writes MCP config as Config written, and only shows Authorized & ready with external evidence', async () => {
    let codexConfigured = false;
    const { bridge, invokeMock } = createDesktopBridgeMock({
      detectResult: () => ({
        platform: 'darwin',
        arch: 'arm64',
        agents: [
          {
            agentId: 'codex',
            installed: true,
            version: 'v0.25.0',
            mcpConfigured: codexConfigured,
          },
          {
            agentId: 'claude',
            installed: false,
            mcpConfigured: false,
          },
        ],
        engine: { installed: false, running: false, port: 0, providerKind: 'none' },
        detectedAt: '2026-01-01T00:00:00Z',
      }),
      onExec: () => {
        codexConfigured = true;
        return hostOk({
          templateId: 'codex.mcp.add_remote',
          program: 'codex',
          exitCode: 0,
          stdout: 'added',
          stderr: '',
          durationMs: 25,
        });
      },
    });
    window.__OPENMOTION_HOST__ = bridge;

    const onConfigured = vi.fn();
    await mount({
      mcpUrl: 'https://motion.open-design.ai/mcp',
      hasAuthorizedConnection: false,
      onConfigured,
    });

    const codexRow = document.querySelector('[data-agent-id="codex"]')!;
    const claudeRow = document.querySelector('[data-agent-id="claude"]')!;
    expect(codexRow.getAttribute('data-connection-state')).toBe('not-configured');
    expect(codexRow.textContent).toContain('v0.25.0');
    expect(claudeRow.getAttribute('data-connection-state')).toBe('not-installed');
    expect(document.body.textContent?.toLowerCase()).not.toContain('murmur');

    const connectCodex = findButton('Connect Codex')!;
    expect(connectCodex).toBeDefined();
    await act(async () => connectCodex.click());
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledWith(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
      featureId: 'mcp_connect',
      templateId: 'codex.mcp.add_remote',
      args: {
        serverName: 'openmotion',
      },
      conflictPolicy: 'abort',
    });
    expect(onConfigured).toHaveBeenCalledWith('codex');

    // Must show "Config written" and NOT "Authorized & ready" without external evidence.
    expect(codexRow.getAttribute('data-connection-state')).toBe('configured');
    expect(codexRow.textContent).toContain('Config written');
    expect(codexRow.textContent).not.toContain('Authorized & ready');

    // Once external authorization evidence arrives, badge upgrades to "Authorized & ready".
    await rerender({
      mcpUrl: 'https://motion.open-design.ai/mcp',
      hasAuthorizedConnection: { codex: true },
      onConfigured,
    });
    expect(codexRow.getAttribute('data-connection-state')).toBe('authorized');
    expect(codexRow.textContent).toContain('Authorized & ready');
  });

  it('handles CONFLICT explicitly with non-destructive Keep or Replace choices', async () => {
    const execCalls: Array<Record<string, unknown> | undefined> = [];
    let claudeConfigured = false;

    const { bridge } = createDesktopBridgeMock({
      detectResult: () => ({
        platform: 'darwin',
        arch: 'arm64',
        agents: [
          { agentId: 'codex', installed: false, mcpConfigured: false },
          {
            agentId: 'claude',
            installed: true,
            version: 'v1.4.2',
            mcpConfigured: claudeConfigured,
            mcpUrl: claudeConfigured ? 'https://motion.open-design.ai/mcp' : 'https://old.example/mcp',
          },
        ],
        engine: { installed: false, running: false, port: 0, providerKind: 'none' },
        detectedAt: '2026-01-01T00:00:00Z',
      }),
      onExec: params => {
        execCalls.push(params);
        if (params?.conflictPolicy !== 'replace') {
          return hostErr('CONFLICT', 'openmotion already points to https://old.example/mcp', {
            existingUrl: 'https://old.example/mcp',
          });
        }
        claudeConfigured = true;
        return hostOk({
          templateId: 'claude.mcp.add_remote',
          program: 'claude',
          exitCode: 0,
          stdout: 'replaced',
          stderr: '',
          durationMs: 18,
        });
      },
    });
    window.__OPENMOTION_HOST__ = bridge;

    await mount({ mcpUrl: 'https://motion.open-design.ai/mcp' });

    await act(async () => findButton('Connect Claude Code')!.click());
    await flushMicrotasks();

    const conflictPanel = document.querySelector('[data-conflict-panel="claude"]')!;
    expect(conflictPanel).not.toBeNull();
    expect(conflictPanel.textContent).toContain('https://old.example/mcp');
    expect(conflictPanel.textContent).toContain('https://motion.open-design.ai/mcp');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.conflictPolicy).toBe('abort');

    // Keeping current config must NOT mutate or call atom.exec again.
    await act(async () => findButton('Keep current config')!.click());
    await flushMicrotasks();
    expect(document.querySelector('[data-conflict-panel="claude"]')).toBeNull();
    expect(execCalls).toHaveLength(1);

    // Re-trigger conflict, then explicitly approve replacing the URL.
    await act(async () => findButton('Connect Claude Code')!.click());
    await flushMicrotasks();
    expect(document.querySelector('[data-conflict-panel="claude"]')).not.toBeNull();

    await act(async () => findButton('Replace existing URL')!.click());
    await flushMicrotasks();

    expect(execCalls).toHaveLength(3);
    expect(execCalls[2]?.conflictPolicy).toBe('replace');
    expect(document.querySelector('[data-conflict-panel="claude"]')).toBeNull();
    expect(document.querySelector('[data-agent-id="claude"]')?.getAttribute('data-connection-state')).toBe(
      'configured',
    );
  });

  it('shows Connect Script pairing and copyable CLI commands in regular browser, then switches to one-click UI on pair', async () => {
    const copySpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(CONNECT_SCRIPT_ENDPOINTS.HEALTH)) {
        return Response.json({
          ok: true,
          protocolVersion: '1.0.0',
          hostKind: 'connect-script',
          requiresToken: true,
        });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get(CONNECT_SCRIPT_TOKEN_HEADER)).toBe('pair-token-xyz');
      if (url.endsWith(CONNECT_SCRIPT_ENDPOINTS.INFO)) {
        return Response.json({
          hostKind: 'connect-script',
          shellVersion: '1.0.0',
          contractVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64',
          releaseChannel: 'stable',
          isPackaged: false,
        });
      }
      if (url.endsWith(CONNECT_SCRIPT_ENDPOINTS.CAPABILITIES)) {
        return Response.json([
          { name: HOST_CAPABILITIES.ATOM_DETECT, version: '1.0.0', status: 'available', methods: ['run'] },
          { name: HOST_CAPABILITIES.ATOM_EXEC, version: '1.0.0', status: 'available', methods: ['run'] },
        ]);
      }
      if (url.endsWith(CONNECT_SCRIPT_ENDPOINTS.INVOKE)) {
        return Response.json(
          hostOk({
            platform: 'darwin',
            arch: 'arm64',
            agents: [
              { agentId: 'codex', installed: true, version: 'v0.30.0', mcpConfigured: false },
              { agentId: 'claude', installed: true, version: 'v1.5.0', mcpConfigured: false },
            ],
            engine: { installed: false, running: false, port: 0, providerKind: 'none' },
            detectedAt: '2026-01-01T00:00:00Z',
          }),
        );
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await mount({ mcpUrl: 'https://motion.open-design.ai/mcp' });

    // Browser mode renders Connect Script pairing form and copyable CLI commands.
    expect(document.querySelector('[data-connect-script-form]')).not.toBeNull();
    const codexFallback = document.querySelector('[data-fallback-command="codex"]')!;
    expect(codexFallback.textContent).toContain(
      'codex mcp add openmotion --url https://motion.open-design.ai/mcp',
    );
    expect(document.body.textContent?.toLowerCase()).not.toContain('murmur');

    // Copying CLI fallback uses clipboard + floating toast.
    await act(async () => codexFallback.querySelector('button')!.click());
    expect(copySpy).toHaveBeenCalledWith(
      'codex mcp add openmotion --url https://motion.open-design.ai/mcp',
    );
    expect(document.querySelector('.motion-feedback-layer [role=status]')?.textContent).toContain(
      'Copied to clipboard',
    );

    // Pair local helper using port + token.
    const tokenField = document.querySelector<HTMLInputElement>('input[aria-label="Pairing token"]')!;
    await act(async () => setInputValue(tokenField, 'pair-token-xyz'));
    await act(async () => findButton('Pair local helper')!.click());
    await flushMicrotasks();

    // Seamlessly transitions to the exact same local Agent detection & one-click UI.
    expect(document.querySelector('[data-desktop-connect-panel]')?.getAttribute('data-host-kind')).toBe(
      'connect-script',
    );
    expect(document.querySelector('[data-agent-id="codex"]')?.textContent).toContain('v0.30.0');
    expect(findButton('Connect Codex')).toBeDefined();
    expect(findButton('Connect Claude Code')).toBeDefined();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    // Disconnecting returns cleanly to browser fallback mode.
    await act(async () => findButton('Disconnect')!.click());
    await flushMicrotasks();
    expect(document.querySelector('[data-connect-script-form]')).not.toBeNull();
  });

  it('auto-pairs from #connect_port & #connect_token hash fragment under StrictMode and scrubs the URL immediately', async () => {
    window.history.replaceState(
      null,
      '',
      '/mcp-setup?host=codex#connect_port=43125&connect_token=hash-secret-999&tab=setup',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.endsWith('/v1/health')) {
        return Response.json({
          ok: true,
          protocolVersion: '1.0',
          hostKind: 'connect-script',
          requiresToken: true,
        });
      }
      if (headers['x-openmotion-connect-token'] !== 'hash-secret-999') {
        return Response.json(hostErr('UNAUTHORIZED', 'bad token'), { status: 401 });
      }
      if (url.endsWith('/v1/info')) {
        return Response.json({
          hostKind: 'connect-script',
          shellVersion: '0.2.1',
          contractVersion: '1.0',
          platform: 'darwin',
          arch: 'arm64',
          releaseChannel: 'stable',
          isPackaged: false,
        });
      }
      if (url.endsWith('/v1/capabilities')) {
        return Response.json([
          { name: HOST_CAPABILITIES.ATOM_DETECT, version: '1.0.0', status: 'available', methods: ['scan'] },
          { name: HOST_CAPABILITIES.ATOM_EXEC, version: '1.0.0', status: 'available', methods: ['run'] },
        ]);
      }
      if (url.endsWith('/v1/invoke')) {
        return Response.json(
          hostOk({
            platform: 'darwin',
            arch: 'arm64',
            agents: [
              { agentId: 'codex', installed: true, version: 'v0.31.0', mcpConfigured: false },
              { agentId: 'claude', installed: false, mcpConfigured: false },
            ],
            engine: { installed: false, running: false, port: 0, providerKind: 'none' },
            detectedAt: '2026-11-23T08:00:00Z',
          }),
        );
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <StrictMode>
          <I18nProvider>
            <DesktopConnectPanel mcpUrl="https://motion.open-design.ai/mcp" />
          </I18nProvider>
        </StrictMode>,
      );
    });
    await flushMicrotasks();

    // Token and port MUST be scrubbed from location.hash while preserving unrelated hash/search params.
    expect(window.location.hash).toBe('#tab=setup');
    expect(window.location.href).not.toContain('hash-secret-999');
    expect(window.location.search).toBe('?host=codex');
    expect(document.querySelector('[data-desktop-connect-panel]')?.getAttribute('data-host-kind')).toBe(
      'connect-script',
    );
    expect(document.querySelector('[data-agent-id="codex"]')?.textContent).toContain('v0.31.0');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('disables connect actions and shows upgrade notice when shellVersion is below minShellVersion', async () => {
    const checkUpdatesMock = vi.fn(async () =>
      hostOk({ status: 'checking', currentVersion: '0.2.1' }),
    );
    const { bridge } = createDesktopBridgeMock({
      detectResult: () => ({
        platform: 'darwin',
        arch: 'arm64',
        agents: [
          { agentId: 'codex', installed: true, version: 'v0.25.0', mcpConfigured: false },
          { agentId: 'claude', installed: false, mcpConfigured: false },
        ],
        engine: { installed: false, running: false, port: 0, providerKind: 'none' },
        detectedAt: '2026-11-23T08:00:00Z',
      }),
    });
    const origInfo = bridge.info.bind(bridge);
    bridge.info = async () => ({
      ...(await origInfo()),
      shellVersion: '0.2.1',
    });
    const origCapabilities = bridge.capabilities.bind(bridge);
    bridge.capabilities = async () => [
      ...(await origCapabilities()),
      { name: HOST_CAPABILITIES.UPDATER, version: '1.0.0', status: 'available', methods: ['getState', 'checkForUpdates'] },
    ];
    const origInvoke = bridge.invoke.bind(bridge);
    bridge.invoke = (async (capability: string, method: string, params?: Record<string, unknown>) => {
      if (capability === HOST_CAPABILITIES.UPDATER && method === 'checkForUpdates') {
        return checkUpdatesMock();
      }
      if (capability === HOST_CAPABILITIES.UPDATER && method === 'getState') {
        return hostOk({ status: 'idle', currentVersion: '0.2.1' });
      }
      return origInvoke(capability, method, params);
    }) as typeof bridge.invoke;
    window.__OPENMOTION_HOST__ = bridge;

    await mount({
      mcpUrl: 'https://motion.open-design.ai/mcp',
      minShellVersion: '0.9.0',
    });

    const notice = document.querySelector('[data-shell-upgrade-notice="true"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('v0.9.0');
    expect(notice?.textContent).toContain('v0.2.1');
    const connectCodex = findButton('Connect Codex')!;
    expect(connectCodex.disabled).toBe(true);

    const checkUpdatesBtn = findButton('Check for updates')!;
    expect(checkUpdatesBtn).toBeDefined();
    await act(async () => checkUpdatesBtn.click());
    expect(checkUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it('reads proactive minShellVersion from signedConfig.getStatus and preserves reactive SHELL_VERSION_TOO_OLD across Rescan', async () => {
    let signedConfigMinShell: string | undefined = undefined;
    const { bridge } = createDesktopBridgeMock({
      detectResult: () => ({
        platform: 'darwin',
        arch: 'arm64',
        agents: [
          { agentId: 'codex', installed: true, version: 'v0.25.0', mcpConfigured: false },
          { agentId: 'claude', installed: false, mcpConfigured: false },
        ],
        engine: { installed: false, running: false, port: 0, providerKind: 'none' },
        detectedAt: '2026-11-23T08:00:00Z',
      }),
      onExec: () =>
        hostErr('UNSUPPORTED', 'Feature requires a newer desktop shell', {
          reason: 'SHELL_VERSION_TOO_OLD',
          requiredShellVersion: '0.8.0',
          currentShellVersion: '0.2.1',
        }),
    });
    const origInfo = bridge.info.bind(bridge);
    bridge.info = async () => ({ ...(await origInfo()), shellVersion: '0.2.1' });
    const origCapabilities = bridge.capabilities.bind(bridge);
    bridge.capabilities = async () => [
      ...(await origCapabilities()),
      { name: 'signedConfig', version: '1.0.0', status: 'available', methods: ['getStatus'] },
    ];
    const origInvoke = bridge.invoke.bind(bridge);
    bridge.invoke = (async (capability: string, method: string, params?: Record<string, unknown>) => {
      if (capability === 'signedConfig' && method === 'getStatus') {
        return hostOk({
          minShellVersion: signedConfigMinShell,
          featureMinShellVersions: signedConfigMinShell ? { mcp_connect: signedConfigMinShell } : {},
        });
      }
      return origInvoke(capability, method, params);
    }) as typeof bridge.invoke;
    window.__OPENMOTION_HOST__ = bridge;

    await mount({ mcpUrl: 'https://motion.open-design.ai/mcp' });
    expect(document.querySelector('[data-shell-upgrade-notice="true"]')).toBeNull();

    // Clicking Connect triggers reactive SHELL_VERSION_TOO_OLD
    await act(async () => findButton('Connect Codex')!.click());
    await flushMicrotasks();
    expect(document.querySelector('[data-shell-upgrade-notice="true"]')?.textContent).toContain('v0.8.0');

    // Rescan must NOT clear the reactive upgrade notice while shellVersion is still 0.2.1!
    signedConfigMinShell = '0.8.0';
    await act(async () => findButton('Rescan local Agents')!.click());
    await flushMicrotasks();
    expect(document.querySelector('[data-shell-upgrade-notice="true"]')?.textContent).toContain('v0.8.0');
    expect(findButton('Connect Codex')!.disabled).toBe(true);
  });

  it('proactively disables connect via signedConfig.getStatus minShellVersion and wires Download / Restart updater buttons', async () => {
    const downloadMock = vi.fn(async () =>
      hostOk({ status: 'downloaded', currentVersion: '0.2.1', availableVersion: '0.9.0' }),
    );
    const installMock = vi.fn(async () => hostOk({ ok: true }));
    const { bridge } = createDesktopBridgeMock({
      detectResult: () => ({
        platform: 'darwin',
        arch: 'arm64',
        agents: [
          { agentId: 'codex', installed: true, version: 'v0.25.0', mcpConfigured: false },
          { agentId: 'claude', installed: false, mcpConfigured: false },
        ],
        engine: { installed: false, running: false, port: 0, providerKind: 'none' },
        detectedAt: '2026-11-23T08:00:00Z',
      }),
    });
    const origInfo = bridge.info.bind(bridge);
    bridge.info = async () => ({ ...(await origInfo()), shellVersion: '0.2.1' });
    const origCapabilities = bridge.capabilities.bind(bridge);
    bridge.capabilities = async () => [
      ...(await origCapabilities()),
      { name: 'signedConfig', version: '1.0.0', status: 'available', methods: ['getStatus'] },
      {
        name: HOST_CAPABILITIES.UPDATER,
        version: '1.0.0',
        status: 'available',
        methods: ['getState', 'checkForUpdates', 'downloadUpdate', 'installNow'],
      },
    ];
    const origInvoke = bridge.invoke.bind(bridge);
    bridge.invoke = (async (capability: string, method: string, params?: Record<string, unknown>) => {
      if (capability === 'signedConfig' && method === 'getStatus') {
        return hostOk({
          minShellVersion: '0.9.0',
          featureMinShellVersions: { mcp_connect: '0.9.0' },
        });
      }
      if (capability === HOST_CAPABILITIES.UPDATER && method === 'getState') {
        return hostOk({ status: 'available', currentVersion: '0.2.1', availableVersion: '0.9.0' });
      }
      if (capability === HOST_CAPABILITIES.UPDATER && method === 'downloadUpdate') {
        return downloadMock();
      }
      if (capability === HOST_CAPABILITIES.UPDATER && method === 'installNow') {
        return installMock();
      }
      return origInvoke(capability, method, params);
    }) as typeof bridge.invoke;
    window.__OPENMOTION_HOST__ = bridge;

    // Mount WITHOUT minShellVersion prop — proactive signedConfig.getStatus() must gate Connect!
    await mount({ mcpUrl: 'https://motion.open-design.ai/mcp' });
    await flushMicrotasks();

    const notice = document.querySelector('[data-shell-upgrade-notice="true"]');
    expect(notice?.textContent).toContain('v0.9.0');
    expect(findButton('Connect Codex')!.disabled).toBe(true);

    // Updater 'available' shows Download update -> transitions to Restart to install update!
    const downloadBtn = findButton('Download update')!;
    expect(downloadBtn).toBeDefined();
    await act(async () => downloadBtn.click());
    await flushMicrotasks();
    expect(downloadMock).toHaveBeenCalledTimes(1);

    const restartBtn = findButton('Restart to install update')!;
    expect(restartBtn).toBeDefined();
    await act(async () => restartBtn.click());
    await flushMicrotasks();
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('renders detected declarative Agents (Cursor / OpenCode) and connects them via atom.config.write + telemetry', async () => {
    let cursorConfigured = false;
    const configWriteCalls: Array<Record<string, unknown>> = [];
    const telemetryCalls: Array<Record<string, unknown>> = [];
    const { bridge } = createDesktopBridgeMock({
      detectResult: () => ({
        platform: 'darwin',
        arch: 'arm64',
        agents: [
          { agentId: 'codex', installed: false, mcpConfigured: false, connectMode: 'cli' },
          { agentId: 'claude', installed: false, mcpConfigured: false, connectMode: 'cli' },
          {
            agentId: 'cursor',
            displayName: 'Cursor',
            installed: true,
            mcpConfigured: cursorConfigured,
            mcpUrl: cursorConfigured ? 'https://motion.open-design.ai/mcp' : undefined,
            connectMode: 'config',
            configRuleId: 'cursor_mcp',
          },
          {
            agentId: 'windsurf',
            displayName: 'Windsurf',
            installed: false,
            mcpConfigured: false,
            connectMode: 'config',
            configRuleId: 'windsurf_mcp',
          },
        ],
        engine: { installed: false, running: false, port: 0, providerKind: 'none' },
        detectedAt: '2026-11-23T08:00:00Z',
      }),
    });
    const origCapabilities = bridge.capabilities.bind(bridge);
    bridge.capabilities = async () => [
      ...(await origCapabilities()),
      { name: HOST_CAPABILITIES.ATOM_CONFIG, version: '1.0.0', status: 'available', methods: ['read', 'write'] },
      { name: HOST_CAPABILITIES.TELEMETRY, version: '1.0.0', status: 'available', methods: ['recordEvent'] },
    ];
    const origInvoke = bridge.invoke.bind(bridge);
    bridge.invoke = (async (capability: string, method: string, params?: Record<string, unknown>) => {
      if (capability === HOST_CAPABILITIES.ATOM_CONFIG && method === 'write') {
        configWriteCalls.push(params ?? {});
        cursorConfigured = true;
        return hostOk({
          ruleId: 'cursor_mcp',
          configPath: '/opt/workspace/.cursor/mcp.json',
          changed: true,
        });
      }
      if (capability === HOST_CAPABILITIES.TELEMETRY && method === 'recordEvent') {
        telemetryCalls.push(params ?? {});
        return hostOk({ recorded: true });
      }
      return origInvoke(capability, method, params);
    }) as typeof bridge.invoke;
    window.__OPENMOTION_HOST__ = bridge;

    await mount({ mcpUrl: 'https://motion.open-design.ai/mcp' });
    await flushMicrotasks();

    // Installed Cursor is rendered; uninstalled Windsurf stays hidden to avoid clutter
    expect(document.querySelector('[data-agent-id="cursor"]')).not.toBeNull();
    expect(document.querySelector('[data-agent-id="windsurf"]')).toBeNull();

    const connectCursorBtn = findButton('Connect Cursor')!;
    expect(connectCursorBtn).toBeDefined();
    await act(async () => connectCursorBtn.click());
    await flushMicrotasks();

    expect(configWriteCalls).toHaveLength(1);
    expect(configWriteCalls[0]).toMatchObject({
      featureId: 'mcp_connect',
      ruleId: 'cursor_mcp',
      fieldType: 'remote_mcp_entry',
      conflictPolicy: 'abort',
    });
    expect(document.querySelector('[data-agent-id="cursor"]')?.getAttribute('data-connection-state')).toBe(
      'configured',
    );
    expect(telemetryCalls).toHaveLength(1);
    expect(telemetryCalls[0]).toMatchObject({
      category: 'agent.connect',
      outcome: 'ok',
      agentId: 'cursor',
      connectMode: 'config',
    });
  });

  it('keeps interactive helper invoke calls alive past the short probe timeout while timing out slow probes', async () => {
    const delayedFetch: typeof fetch = async (_input, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(JSON.stringify(hostOk({ exitCode: 0 })), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }, 80);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const bridge = createLocalConnectBridge({
      port: 49123,
      token: 'test-token',
      timeoutMs: 30,
      interactiveTimeoutMs: 400,
      fetchImpl: delayedFetch,
    });

    const probeResult = await bridge.invoke(HOST_CAPABILITIES.ATOM_DETECT, 'detect', {});
    expect(probeResult.ok).toBe(false);
    if (!probeResult.ok) {
      expect(probeResult.error.code).toBe('TIMEOUT');
    }

    const interactiveResult = await bridge.invoke(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
      featureId: 'mcp_connect',
      templateId: 'codex.mcp.add_remote',
    });
    expect(interactiveResult.ok).toBe(true);
    bridge.dispose();
  });
});
