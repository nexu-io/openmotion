// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_CAPABILITIES,
  hostErr,
  hostOk,
  type HostCapabilityDescriptor,
  type HostInvokeResult,
  type HostRuntimeInfo,
  type UniversalHostBridge,
} from '../../../shared/desktop-contract';
import {
  CONNECT_SCRIPT_ENDPOINTS,
  CONNECT_SCRIPT_TOKEN_HEADER,
} from '../../../shared/connect-script-protocol';
import type { DesktopChromeInsets, DesktopUpdateState } from '../../../shared/platform-host';
import {
  connectLocalConnectBridge,
  createLocalConnectBridge,
  disconnectLocalConnectBridge,
  getLocalConnectBridge,
  getLocalConnectStatus,
  probeLocalConnectHealth,
  subscribeLocalConnectBridge,
} from './localConnectBridge';
import {
  applyDesktopDocumentAttributes,
  bindDesktopHost,
  compareSemver,
  exportDesktopDiagnosticBundle,
  getActiveHostBridge,
  hasCapabilityEventInList,
  hasCapabilityInList,
  hasCapabilityMethodInList,
  hasHostCapability,
  hasHostCapabilityEvent,
  hasHostCapabilityMethod,
  invokeHostAtom,
  isDesktopApp,
  notifyDesktopRendererReady,
  openBillingAndRefreshOnFocus,
  openExternalUrl,
  startDesktopBrowserLogin,
  syncDesktopTheme,
  useDesktopChrome,
  useDesktopUpdateState,
  useHostCapabilities,
} from './platformHost';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type MockBridgeControls = {
  bridge: UniversalHostBridge;
  invokeMock: ReturnType<typeof vi.fn>;
  infoMock: ReturnType<typeof vi.fn>;
  capabilitiesMock: ReturnType<typeof vi.fn>;
  emit: (capability: string, event: string, payload: unknown) => void;
};

function createMockBridge(options?: {
  info?: Partial<HostRuntimeInfo>;
  capabilities?: HostCapabilityDescriptor[];
  onInvoke?: (
    capability: string,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<HostInvokeResult<unknown>> | HostInvokeResult<unknown>;
}): MockBridgeControls {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const runtimeInfo: HostRuntimeInfo = {
    hostKind: 'desktop',
    shellVersion: '1.0.0',
    contractVersion: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    releaseChannel: 'stable',
    isPackaged: true,
    ...options?.info,
  };
  const caps: HostCapabilityDescriptor[] = options?.capabilities ?? [
    { name: HOST_CAPABILITIES.WINDOW, version: '1.0.0', status: 'available' },
    { name: HOST_CAPABILITIES.UPDATER, version: '1.0.0', status: 'available' },
    { name: HOST_CAPABILITIES.DIAGNOSTICS, version: '1.0.0', status: 'available' },
    { name: HOST_CAPABILITIES.ACCOUNT, version: '1.0.0', status: 'available' },
    { name: HOST_CAPABILITIES.ATOM_DETECT, version: '1.0.0', status: 'available' },
    { name: HOST_CAPABILITIES.ATOM_EXEC, version: '1.0.0', status: 'available' },
  ];

  const infoMock = vi.fn(async () => runtimeInfo);
  const capabilitiesMock = vi.fn(async () => caps);
  const invokeMock = vi.fn(
    async <T = unknown>(
      capability: string,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<HostInvokeResult<T>> => {
      if (options?.onInvoke) {
        return (await options.onInvoke(capability, method, params)) as HostInvokeResult<T>;
      }
      return hostOk({} as T);
    },
  );

  const bridge: UniversalHostBridge = {
    info: infoMock,
    capabilities: capabilitiesMock,
    invoke: invokeMock as UniversalHostBridge['invoke'],
    subscribe: (capability, event, callback) => {
      const key = `${capability}:${event}`;
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(callback);
      return () => {
        set?.delete(callback);
      };
    },
  };

  return {
    bridge,
    invokeMock,
    infoMock,
    capabilitiesMock,
    emit: (capability, event, payload) => {
      const set = listeners.get(`${capability}:${event}`);
      if (!set) return;
      for (const cb of set) cb(payload);
    },
  };
}

let root: Root | undefined;

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  delete window.__OPENMOTION_HOST__;
  disconnectLocalConnectBridge();
  applyDesktopDocumentAttributes(null);
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('platformHost universal bridge', () => {
  it('compares semver strings and checks capability availability and minimum versions', async () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareSemver('0.9.5', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);

    const mock = createMockBridge({
      capabilities: [
        { name: HOST_CAPABILITIES.WINDOW, version: '1.2.0', status: 'available' },
        { name: HOST_CAPABILITIES.UPDATER, version: '1.0.0', status: 'unavailable', reason: 'unsigned' },
        { name: HOST_CAPABILITIES.ATOM_DETECT, version: '1.1.0', status: 'available' },
      ],
    });
    window.__OPENMOTION_HOST__ = mock.bridge;

    expect(isDesktopApp()).toBe(true);
    expect(getActiveHostBridge()).toBe(mock.bridge);
    expect(await hasHostCapability(HOST_CAPABILITIES.WINDOW, '1.0.0')).toBe(true);
    expect(await hasHostCapability(HOST_CAPABILITIES.WINDOW, '1.2.0')).toBe(true);
    expect(await hasHostCapability(HOST_CAPABILITIES.WINDOW, '1.3.0')).toBe(false);
    expect(await hasHostCapability(HOST_CAPABILITIES.UPDATER, '1.0.0')).toBe(false);
    expect(await hasHostCapability(HOST_CAPABILITIES.DIAGNOSTICS)).toBe(false);
    expect(mock.capabilitiesMock).toHaveBeenCalledTimes(1);
  });

  it('requires matching major version and probes advertised capability methods and events', async () => {
    const caps: HostCapabilityDescriptor[] = [
      {
        name: HOST_CAPABILITIES.WINDOW,
        version: '2.1.0',
        status: 'available',
        methods: ['getChromeState', 'notify'],
        events: ['chromeState', 'deepLink'],
      },
      {
        name: HOST_CAPABILITIES.UPDATER,
        version: '1.0.0',
        status: 'unavailable',
        methods: ['getState'],
        events: ['state'],
      },
      {
        name: HOST_CAPABILITIES.DIAGNOSTICS,
        version: 'invalid',
        status: 'available',
        methods: ['getAppInfo'],
      },
    ];

    // Major version mismatch must fail closed so breaking v2 capabilities are not treated as v1-compatible.
    expect(hasCapabilityInList(caps, HOST_CAPABILITIES.WINDOW, '1.0.0')).toBe(false);
    expect(hasCapabilityInList(caps, HOST_CAPABILITIES.WINDOW, '2.0.0')).toBe(true);
    expect(hasCapabilityInList(caps, HOST_CAPABILITIES.WINDOW, '2.1.0')).toBe(true);
    expect(hasCapabilityInList(caps, HOST_CAPABILITIES.WINDOW, '2.2.0')).toBe(false);
    expect(hasCapabilityInList(caps, HOST_CAPABILITIES.WINDOW)).toBe(true);
    expect(hasCapabilityInList(caps, HOST_CAPABILITIES.DIAGNOSTICS, '1.0.0')).toBe(false);
    expect(hasCapabilityInList(caps, HOST_CAPABILITIES.WINDOW, 'not-a-semver')).toBe(false);

    // Method and event probing checks advertised lists and respects availability/major rules.
    expect(hasCapabilityMethodInList(caps, HOST_CAPABILITIES.WINDOW, 'notify', '2.0.0')).toBe(true);
    expect(hasCapabilityMethodInList(caps, HOST_CAPABILITIES.WINDOW, 'notify', '1.0.0')).toBe(false);
    expect(hasCapabilityMethodInList(caps, HOST_CAPABILITIES.WINDOW, 'removedMethod', '2.0.0')).toBe(false);
    expect(hasCapabilityEventInList(caps, HOST_CAPABILITIES.WINDOW, 'deepLink', '2.0.0')).toBe(true);
    expect(hasCapabilityEventInList(caps, HOST_CAPABILITIES.WINDOW, 'deepLink', '1.0.0')).toBe(false);
    expect(hasCapabilityEventInList(caps, HOST_CAPABILITIES.WINDOW, 'removedEvent', '2.0.0')).toBe(false);
    expect(hasCapabilityEventInList(caps, HOST_CAPABILITIES.UPDATER, 'state', '1.0.0')).toBe(false);
    expect(hasCapabilityEventInList(caps, HOST_CAPABILITIES.DIAGNOSTICS, 'anything')).toBe(false);

    const mock = createMockBridge({ capabilities: caps });
    window.__OPENMOTION_HOST__ = mock.bridge;
    expect(await hasHostCapabilityMethod(HOST_CAPABILITIES.WINDOW, 'getChromeState', '2.0.0')).toBe(true);
    expect(await hasHostCapabilityEvent(HOST_CAPABILITIES.WINDOW, 'chromeState', '2.0.0')).toBe(true);
    expect(await hasHostCapabilityEvent(HOST_CAPABILITIES.WINDOW, 'chromeState', '1.0.0')).toBe(false);
    expect(await hasHostCapabilityEvent(HOST_CAPABILITIES.WINDOW, 'unknownEvent', '2.0.0')).toBe(false);
  });

  it('binds desktop chrome, applies document attributes, syncs theme, and notifies renderer ready once', async () => {
    const initialChrome: DesktopChromeInsets = {
      platform: 'darwin',
      titleBarStyle: 'hiddenInset',
      insetLeft: 78,
      insetRight: 0,
      titleBarHeight: 46,
      customWindowControls: false,
      fullscreen: false,
      maximized: false,
    };
    const mock = createMockBridge({
      onInvoke: (capability, method) => {
        if (capability === HOST_CAPABILITIES.WINDOW && method === 'getChromeState') {
          return hostOk(initialChrome);
        }
        return hostOk({});
      },
    });
    window.__OPENMOTION_HOST__ = mock.bridge;

    const unbind = bindDesktopHost();
    await flushMicrotasks();

    expect(document.documentElement.dataset.desktop).toBe('true');
    expect(document.documentElement.dataset.desktopPlatform).toBe('darwin');
    expect(document.documentElement.style.getPropertyValue('--om-desktop-inset-left')).toBe('78px');

    notifyDesktopRendererReady();
    syncDesktopTheme('light');
    await flushMicrotasks();

    const readyCalls = mock.invokeMock.mock.calls.filter(
      ([cap, method]) => cap === HOST_CAPABILITIES.WINDOW && method === 'rendererReady',
    );
    expect(readyCalls).toHaveLength(1);
    expect(mock.invokeMock).toHaveBeenCalledWith(HOST_CAPABILITIES.WINDOW, 'setTheme', { theme: 'light' });

    mock.emit(HOST_CAPABILITIES.WINDOW, 'chromeState', { ...initialChrome, fullscreen: true, insetLeft: 0 });
    expect(document.documentElement.dataset.desktopFullscreen).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--om-desktop-inset-left')).toBe('0px');

    unbind();
  });

  it('gracefully falls back to web behavior when capabilities are missing or lower version', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const mock = createMockBridge({
      capabilities: [
        { name: HOST_CAPABILITIES.WINDOW, version: '0.9.0', status: 'available' },
      ],
    });
    window.__OPENMOTION_HOST__ = mock.bridge;

    await openExternalUrl('https://open-design.ai/docs');
    expect(mock.invokeMock).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('https://open-design.ai/docs', '_blank', 'noopener,noreferrer');

    const diag = await exportDesktopDiagnosticBundle();
    expect(diag.ok).toBe(false);

    const atom = await invokeHostAtom(HOST_CAPABILITIES.ATOM_DETECT, 'run');
    expect(atom.ok).toBe(false);
    if (!atom.ok) expect(atom.error.code).toBe('UNSUPPORTED');
  });

  it('supports useDesktopChrome and useDesktopUpdateState purely through invoke and subscribe', async () => {
    const chromeState: DesktopChromeInsets = {
      platform: 'win32',
      titleBarStyle: 'hiddenOverlay',
      insetLeft: 0,
      insetRight: 138,
      titleBarHeight: 46,
      customWindowControls: false,
      fullscreen: false,
      maximized: false,
    };
    const updateState: DesktopUpdateState = {
      status: 'up-to-date',
      currentVersion: '1.0.0',
    };
    const mock = createMockBridge({
      onInvoke: (capability, method) => {
        if (capability === HOST_CAPABILITIES.WINDOW && method === 'getChromeState') {
          return hostOk(chromeState);
        }
        if (capability === HOST_CAPABILITIES.UPDATER && method === 'getState') {
          return hostOk(updateState);
        }
        if (capability === HOST_CAPABILITIES.UPDATER && method === 'checkForUpdates') {
          return hostOk({ status: 'available', currentVersion: '1.0.0', availableVersion: '1.1.0' });
        }
        if (capability === HOST_CAPABILITIES.UPDATER && method === 'installNow') {
          return hostOk({ ok: true });
        }
        return hostOk({});
      },
    });
    window.__OPENMOTION_HOST__ = mock.bridge;

    let latestChrome: DesktopChromeInsets | null = null;
    let updaterApi: ReturnType<typeof useDesktopUpdateState> | null = null;

    function Probe() {
      latestChrome = useDesktopChrome();
      updaterApi = useDesktopUpdateState();
      return null;
    }

    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await flushMicrotasks();

    expect(latestChrome).toEqual(chromeState);
    expect(updaterApi!.state).toEqual(updateState);

    await act(async () => {
      await updaterApi!.checkForUpdates();
    });
    expect(updaterApi!.state?.status).toBe('available');
    expect(updaterApi!.state?.availableVersion).toBe('1.1.0');

    await act(async () => {
      mock.emit(HOST_CAPABILITIES.UPDATER, 'state', {
        status: 'downloaded',
        currentVersion: '1.0.0',
        availableVersion: '1.1.0',
      });
    });
    expect(updaterApi!.state?.status).toBe('downloaded');

    const installRes = await act(async () => updaterApi!.installUpdateNow());
    expect(installRes).toEqual({ ok: true, error: undefined });
  });

  it('starts desktop browser login via account capability and refreshes billing once on window focus', async () => {
    const mock = createMockBridge({
      onInvoke: (capability, method) => {
        if (capability === HOST_CAPABILITIES.ACCOUNT && method === 'startBrowserLogin') {
          return hostOk({ url: 'https://open-design.ai/auth/desktop' });
        }
        return hostOk({});
      },
    });
    window.__OPENMOTION_HOST__ = mock.bridge;

    const loginRes = await startDesktopBrowserLogin({ returnTo: '/explore' });
    expect(loginRes).toEqual({
      ok: true,
      mode: 'desktop-account',
      url: 'https://open-design.ai/auth/desktop',
    });
    expect(mock.invokeMock).toHaveBeenCalledWith(HOST_CAPABILITIES.ACCOUNT, 'startBrowserLogin', {
      returnTo: '/explore',
    });

    const onRefresh = vi.fn();
    const accountEventSpy = vi.fn();
    window.addEventListener('motion:account-changed', accountEventSpy);

    const handle = await openBillingAndRefreshOnFocus('https://open-design.ai/dashboard?billing=plan', onRefresh);
    expect(handle.opened).toBe(true);
    expect(mock.invokeMock).toHaveBeenCalledWith(HOST_CAPABILITIES.WINDOW, 'openExternal', {
      url: 'https://open-design.ai/dashboard?billing=plan',
    });

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await flushMicrotasks();

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(accountEventSpy).toHaveBeenCalledTimes(1);

    window.removeEventListener('motion:account-changed', accountEventSpy);
  });
});

describe('localConnectBridge HTTP + SSE adapter', () => {
  it('probes health, connects in memory without persisting secret token to web storage, and notifies subscribers', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith(CONNECT_SCRIPT_ENDPOINTS.HEALTH)) {
        return Response.json({
          ok: true,
          protocolVersion: '1.0.0',
          hostKind: 'connect-script',
          requiresToken: true,
        });
      }
      expect(headers.get(CONNECT_SCRIPT_TOKEN_HEADER)).toBe('secret-token-123');
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
          { name: HOST_CAPABILITIES.ATOM_DETECT, version: '1.0.0', status: 'available' },
          { name: HOST_CAPABILITIES.ATOM_EXEC, version: '1.0.0', status: 'available' },
        ]);
      }
      if (url.endsWith(CONNECT_SCRIPT_ENDPOINTS.INVOKE)) {
        const body = JSON.parse(String(init?.body)) as { capability: string; method: string };
        if (body.capability === HOST_CAPABILITIES.ATOM_DETECT) {
          return Response.json(hostOk({ platform: 'darwin', arch: 'arm64', agents: [], detectedAt: '2026-01-01T00:00:00Z' }));
        }
        return Response.json(hostErr('CONFLICT', 'Existing openmotion entry'));
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const listener = vi.fn();
    const unsubscribe = subscribeLocalConnectBridge(listener);

    const health = await probeLocalConnectHealth(43118);
    expect(health?.hostKind).toBe('connect-script');

    const connected = await connectLocalConnectBridge({ port: 43118, token: 'secret-token-123' });
    expect(connected.ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isDesktopApp()).toBe(false);
    expect(getActiveHostBridge()).toBe(getLocalConnectBridge());
    expect(getLocalConnectStatus()).toMatchObject({ connected: true, port: 43118 });

    // Token must NEVER touch localStorage or sessionStorage.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    const atomRes = await invokeHostAtom(HOST_CAPABILITIES.ATOM_DETECT, 'run');
    expect(atomRes.ok).toBe(true);

    const conflictRes = await invokeHostAtom(HOST_CAPABILITIES.ATOM_EXEC, 'run', {
      featureId: 'mcp_connect',
      templateId: 'codex.mcp.add_remote',
    });
    expect(conflictRes.ok).toBe(false);
    if (!conflictRes.ok) expect(conflictRes.error.code).toBe('CONFLICT');

    disconnectLocalConnectBridge();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getActiveHostBridge()).toBeUndefined();
    unsubscribe();
  });

  it('streams SSE events via fetch with auth header and reacts inside useHostCapabilities', async () => {
    const encoder = new TextEncoder();
    const ssePayloads = [
      'data: {"capability":"atom.exec","event":"progress",',
      '"payload":{"step":"writing"}}\n\n',
    ];
    let aborted = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(CONNECT_SCRIPT_ENDPOINTS.EVENTS)) {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of ssePayloads) {
              controller.enqueue(encoder.encode(chunk));
            }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (url.endsWith(CONNECT_SCRIPT_ENDPOINTS.HEALTH)) {
        return Response.json({
          ok: true,
          protocolVersion: '1.0.0',
          hostKind: 'connect-script',
          requiresToken: true,
        });
      }
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
          { name: HOST_CAPABILITIES.ATOM_DETECT, version: '1.0.0', status: 'available' },
        ]);
      }
      return new Response('', { status: 404 });
    });

    const bridge = createLocalConnectBridge({
      port: 43118,
      token: 'sse-token',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const received: unknown[] = [];
    const unsub = bridge.subscribe('atom.exec', 'progress', payload => received.push(payload));
    await flushMicrotasks();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(received).toEqual([{ step: 'writing' }]);
    unsub();
    expect(aborted).toBe(true);
    bridge.dispose();

    // Verify useHostCapabilities reacts to connect/disconnect transitions.
    vi.stubGlobal('fetch', fetchMock);
    let latestKind: string | null = null;
    let canDetect = false;

    function CapabilitiesProbe() {
      const host = useHostCapabilities();
      latestKind = host.hostKind;
      canDetect = host.has(HOST_CAPABILITIES.ATOM_DETECT, '1.0.0');
      return null;
    }

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<CapabilitiesProbe />));
    expect(latestKind).toBeNull();
    expect(canDetect).toBe(false);

    await act(async () => {
      await connectLocalConnectBridge({ port: 43118, token: 'sse-token' });
    });
    await flushMicrotasks();
    expect(latestKind).toBe('connect-script');
    expect(canDetect).toBe(true);

    await act(async () => {
      disconnectLocalConnectBridge();
    });
    expect(latestKind).toBeNull();
    expect(canDetect).toBe(false);
  });
});
